#!/usr/bin/env node
/**
 * Maritime NZ / LINZ NAVAREA XIV scraper
 *
 * Why this exists
 * ---------------
 * https://www.maritimenz.govt.nz/navigational-warnings/ sits behind
 * Cloudflare's JS challenge. A plain `fetch` from Supabase edge
 * functions (Deno) hits the "Just a moment…" interstitial and gets
 * 403. The fix is a real browser: Playwright launches headless
 * Chromium on the GitHub Actions runner, Cloudflare lets it through
 * after a couple of seconds of fingerprinting checks, we scrape the
 * warnings list, normalise each entry into the same `RawBroadcastWarn`
 * shape the iOS client already consumes for NGA / AMSA / UKHO, and
 * upsert them into the `linz_warnings` Supabase table.
 *
 * The `proxy-linz-msi` edge function then serves those rows in the
 * NGA-compatible shape — no special-casing on the client.
 *
 * Run
 * ---
 *   SUPABASE_URL=https://… SUPABASE_SERVICE_ROLE_KEY=… node scrape.mjs
 *
 * GitHub Actions sets both env vars from repo secrets. Local dry-run:
 *   DRY_RUN=1 node scrape.mjs   # prints parsed warnings, no DB writes
 */

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LINZ_URL = 'https://www.maritimenz.govt.nz/navigational-warnings/';

// Cloudflare's challenge usually clears within ~5 seconds. 60s upper
// bound accounts for occasional CF tightening + the CMS rendering the
// warning list via async XHR after domcontentloaded fires.
const CHALLENGE_TIMEOUT_MS = 60_000;

// On failure, dump page state here so the GH Actions step can upload
// it as an artifact for diagnosis (screenshot + raw HTML + body text).
let debugDirPromise;

async function debugDir() {
    if (!debugDirPromise) debugDirPromise = mkdtemp(join(tmpdir(), 'thalassa-linz-debug-'));
    return debugDirPromise;
}

export const SCRAPE_SAFETY_LIMITS = Object.freeze({
    minWarnings: 2,
    maxWarnings: 500,
    maxPageBytes: 2_000_000,
    maxWarningTextChars: 20_000,
    maxTotalWarningTextChars: 2_000_000,
    maxInforceAgeMs: 72 * 60 * 60 * 1000,
    maxFutureSkewMs: 6 * 60 * 60 * 1000,
    maxCountDropFraction: 0.5,
});

const BROWSER_ENV_ALLOWLIST = Object.freeze([
    'CI',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
]);

export function buildBrowserEnvironment(env = process.env) {
    const browserEnv = {};
    for (const key of BROWSER_ENV_ALLOWLIST) {
        if (typeof env[key] === 'string' && env[key]) browserEnv[key] = env[key];
    }
    return browserEnv;
}

function decodeJwtPayload(value) {
    if (!value.startsWith('eyJ')) return null;
    try {
        const payload = value.split('.')[1];
        if (!payload) return null;
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export function validateWriteEnvironment(env = process.env) {
    const supabaseUrl = env.SUPABASE_URL?.trim();
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(supabaseUrl);
    } catch {
        throw new Error('SUPABASE_URL must be a valid HTTPS URL');
    }
    if (parsedUrl.protocol !== 'https:') {
        throw new Error('SUPABASE_URL must be a valid HTTPS URL');
    }

    const jwtPayload = decodeJwtPayload(serviceKey);
    const isModernSecret = serviceKey.startsWith('sb_secret_');
    if ((!isModernSecret && jwtPayload?.role !== 'service_role') || serviceKey.startsWith('sb_publishable_')) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a service-role credential');
    }

    return { supabaseUrl: parsedUrl.toString().replace(/\/$/, ''), serviceKey };
}

function dryRunEnabled(env) {
    const value = env.DRY_RUN;
    if (value === undefined || value === '') return false;
    if (value === '1') return true;
    throw new Error('DRY_RUN must be exactly "1" when set');
}

// ── Date / reference parsing ───────────────────────────────────────────
//
// Maritime NZ doesn't surface per-warning issue dates in the body — the
// page has a single "Warnings In-Force at: NNNNNN UTC MON YY" timestamp
// at the top that applies to every warning currently displayed. We use
// that as the issueDate for every row so the iOS-side parseIssueDate
// (which expects "DDHHMMZ MON YYYY") has something to chew on.

const MONTHS = {
    jan: 'JAN',
    feb: 'FEB',
    mar: 'MAR',
    apr: 'APR',
    may: 'MAY',
    jun: 'JUN',
    jul: 'JUL',
    aug: 'AUG',
    sep: 'SEP',
    oct: 'OCT',
    nov: 'NOV',
    dec: 'DEC',
};

// "Warnings In-Force at: 150500 UTC MAY 26"
const INFORCE_RE = /Warnings\s+In-Force\s+at:\s*(\d{6})\s+UTC\s+([A-Za-z]{3,})\s+(\d{2,4})/i;
const WARNING_HEADER_RE = /(?:NAVAREA\s+XIV|NEW\s+ZEALAND\s+COASTAL\s+NAVIGATION)\s+WARNING\s+\d+\/\d{2,4}/i;

export function parseInforceDate(bodyText) {
    const m = bodyText.match(INFORCE_RE);
    if (!m) return '';
    const ddhhmm = m[1];
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) year = 2000 + year;
    const day = Number(ddhhmm.slice(0, 2));
    const hour = Number(ddhhmm.slice(2, 4));
    const minute = Number(ddhhmm.slice(4, 6));
    const monthIndex = Object.values(MONTHS).indexOf(mon);
    const parsedMs = Date.UTC(year, monthIndex, day, hour, minute);
    const parsed = new Date(parsedMs);
    if (
        !mon ||
        year < 2000 ||
        year > 2100 ||
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== monthIndex ||
        parsed.getUTCDate() !== day ||
        parsed.getUTCHours() !== hour ||
        parsed.getUTCMinutes() !== minute
    ) {
        return '';
    }
    // "150500Z MAY 2026" — matches the NGA / AMSA / UKHO shape that
    // services/NoticeToMarinersService.ts::parseIssueDate understands.
    return `${ddhhmm}Z ${mon} ${year}`;
}

// Reference parsing — Maritime NZ uses two header formats:
//   "NAVAREA XIV WARNING 130/26"             — area XIV (S Pacific)
//   "NEW ZEALAND COASTAL NAVIGATION WARNING  — NZ coastal warnings
//                                     136/26"  (broadcast on MF / VHF)
// Each maps to a stable navArea code we can filter on client-side.
export function parseReferenceMatch(match) {
    const kind = match[1].toUpperCase();
    const msgNumber = Number(match[2]);
    let msgYear = Number(match[3]);
    if (msgYear < 100) msgYear = 2000 + msgYear;
    if (
        !Number.isSafeInteger(msgNumber) ||
        msgNumber < 1 ||
        msgNumber > 99_999 ||
        !Number.isSafeInteger(msgYear) ||
        msgYear < 2000 ||
        msgYear > 2100
    ) {
        return null;
    }
    const navArea = kind.includes('COASTAL') ? 'NZC' : 'XIV';
    return { navArea, msgNumber, msgYear };
}

// ── Browser scraping ───────────────────────────────────────────────────
//
// The Maritime NZ page is a static-ish list of warnings — each in a
// card / accordion. The exact selectors change occasionally (it's a
// CMS-rendered page) so we cast a wide net: anything that looks like a
// "NAVAREA XIV NNN/YY" or "NZ COASTAL NNN/YY" header on the page is
// treated as the start of a warning, and the surrounding text block is
// the body. Date is picked up from a sibling element when present.

async function dumpDebug(page, label) {
    try {
        const directory = await debugDir();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await page.screenshot({ path: `${directory}/${label}.png`, fullPage: true }).catch(() => {});
        const html = await page.content().catch(() => '');
        await writeFile(`${directory}/${label}.html`, html, { mode: 0o600 });
        const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        await writeFile(`${directory}/${label}.txt`, bodyText, { mode: 0o600 });
        const url = page.url();
        await writeFile(`${directory}/${label}.url.txt`, url, { mode: 0o600 });
        console.log(`[linz-msi] dumped page state to ${directory}/${label}.* (final url: ${url})`);
    } catch (e) {
        console.warn(`[linz-msi] debug dump failed: ${e.message}`);
    }
}

export async function navigateToWarningPage(page, { url = LINZ_URL, timeoutMs = CHALLENGE_TIMEOUT_MS } = {}) {
    const expectedUrl = new URL(url);

    // The site deliberately keeps analytics, search and Cloudflare
    // telemetry requests alive after its warning content is ready, so
    // network-idle is not a reliable completion signal. DOM readiness
    // lets a Cloudflare interstitial execute, then the semantic wait
    // below admits only the canonical warning page with both its
    // in-force timestamp and at least one real warning header present.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(
        ({ expectedOrigin, expectedPathname, inforcePattern, warningPattern }) => {
            const currentUrl = new URL(window.location.href);
            const bodyText = document.body?.innerText ?? '';
            return (
                currentUrl.origin === expectedOrigin &&
                currentUrl.pathname === expectedPathname &&
                new RegExp(inforcePattern, 'i').test(bodyText) &&
                new RegExp(warningPattern, 'i').test(bodyText)
            );
        },
        {
            expectedOrigin: expectedUrl.origin,
            expectedPathname: expectedUrl.pathname,
            inforcePattern: INFORCE_RE.source,
            warningPattern: WARNING_HEADER_RE.source,
        },
        { timeout: timeoutMs },
    );
}

export async function scrape({ browserEnv = buildBrowserEnvironment(process.env) } = {}) {
    const browser = await chromium.launch({
        // GitHub-hosted runners ship with the necessary deps; locally
        // you may need `npx playwright install chromium --with-deps`.
        headless: true,
        chromiumSandbox: true,
        // Keep Chromium sandboxed and pass an explicit allowlist so the
        // upstream-controlled page cannot inherit database credentials.
        env: browserEnv,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    let page;
    try {
        const ctx = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            viewport: { width: 1440, height: 900 },
            locale: 'en-NZ',
            timezoneId: 'Pacific/Auckland',
        });
        page = await ctx.newPage();

        // Block heavy assets — the warnings page is text-only data;
        // images / fonts / videos just slow the run down.
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (type === 'image' || type === 'media' || type === 'font') {
                return route.abort();
            }
            return route.continue();
        });

        console.log(`[linz-msi] navigating to ${LINZ_URL}`);
        await navigateToWarningPage(page).catch(async (err) => {
            await dumpDebug(page, 'readiness-timeout');
            throw err;
        });

        // Always snapshot a "success" dump too — useful when parsing
        // returns zero warnings, we can inspect what the page looked
        // like at that point and adjust the parser regex.
        await dumpDebug(page, 'success');

        // Pull the whole body text — easier than chasing CMS selectors
        // that drift. We split it into warning blocks downstream using
        // the reference headers as anchors.
        const bodyText = await page.evaluate(() => document.body.innerText);
        return bodyText;
    } catch (err) {
        if (page) await dumpDebug(page, 'final-error');
        throw err;
    } finally {
        await browser.close();
    }
}

// ── Text → warning blocks ──────────────────────────────────────────────
//
// Splits the whole-page text on each reference header occurrence. Each
// block starts at a "NAVAREA XIV WARNING NNN/YY" or "NEW ZEALAND
// COASTAL NAVIGATION WARNING NNN/YY" line and runs until the next
// reference header (or end of text). Trailing "NNNN" terminators are
// stripped — that's a broadcast marker, not part of the warning text.

const REF_RE = /(NAVAREA\s+XIV|NEW\s+ZEALAND\s+COASTAL\s+NAVIGATION)\s+WARNING\s+(\d+)\/(\d+)/gi;

export function splitWarnings(bodyText) {
    // First pass: filter out cancel sub-references. A line like
    //   "3. CANCEL NAVAREA XIV WARNING 119/26"
    // appears inside the body of warning 125 and would otherwise
    // be parsed as a separate (empty-bodied) warning 119. The cancel
    // keyword always precedes such references — peek at the 20 chars
    // before each match and drop it if "CANCEL " is the suffix.
    const matches = [...bodyText.matchAll(REF_RE)].filter((m) => {
        const prefix = bodyText.slice(Math.max(0, m.index - 20), m.index);
        return !/CANCEL\s+$/i.test(prefix);
    });

    const blocks = [];
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : bodyText.length;
        let block = bodyText.slice(start, end).trim();
        // Strip the broadcast terminator (and anything after it — the
        // page renders an "accordion-header" number like "129/26" on
        // its own line just before the next warning, which we don't
        // want in this warning's body).
        const nnIdx = block.search(/\bNNNN\b/);
        if (nnIdx >= 0) block = block.slice(0, nnIdx).trim();
        // Keep the reference header as the first line so the iOS
        // title-extractor reads the reference number first (matches
        // the AMSA / UKHO proxy convention).
        blocks.push({ match: matches[i], body: block });
    }
    return blocks;
}

export function buildWarning(block, issueDate, runTimestamp) {
    const parsed = parseReferenceMatch(block.match);
    if (!parsed) return null;
    const id = `${parsed.navArea}-${parsed.msgYear}/${parsed.msgNumber}`;
    return {
        id,
        msg_year: parsed.msgYear,
        msg_number: parsed.msgNumber,
        nav_area: parsed.navArea,
        subregion: '',
        text: block.body,
        status: 'A',
        issue_date: issueDate,
        authority: 'MARITIME NZ',
        // Stamped with the run's canonical timestamp so the post-upsert
        // cleanup can use the same value as its `< cutoff` deletion
        // threshold without race conditions between row-build-time and
        // persist-time. See persist() for the matching cutoff.
        fetched_at: runTimestamp,
    };
}

const NORMALIZED_ISSUE_DATE_RE = /^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{4})$/;

function normalizedIssueDateMs(issueDate) {
    const match = issueDate.match(NORMALIZED_ISSUE_DATE_RE);
    if (!match) return Number.NaN;
    const monthIndex = Object.values(MONTHS).indexOf(match[4]);
    if (monthIndex < 0) return Number.NaN;
    const year = Number(match[5]);
    const day = Number(match[1]);
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    const value = Date.UTC(year, monthIndex, day, hour, minute);
    const parsed = new Date(value);
    return parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === monthIndex &&
        parsed.getUTCDate() === day &&
        parsed.getUTCHours() === hour &&
        parsed.getUTCMinutes() === minute
        ? value
        : Number.NaN;
}

export function validateScrapeResult({ warnings, issueDate, runTimestamp, duplicateIds = [] }) {
    const runMs = Date.parse(runTimestamp);
    const issueMs = normalizedIssueDateMs(issueDate);
    if (!Number.isFinite(runMs)) throw new Error('invalid canonical run timestamp');
    if (!Number.isFinite(issueMs)) throw new Error('missing or invalid page in-force timestamp');
    if (runMs - issueMs > SCRAPE_SAFETY_LIMITS.maxInforceAgeMs) {
        throw new Error('page in-force timestamp is stale; refusing database changes');
    }
    if (issueMs - runMs > SCRAPE_SAFETY_LIMITS.maxFutureSkewMs) {
        throw new Error('page in-force timestamp is implausibly in the future');
    }
    if (warnings.length < SCRAPE_SAFETY_LIMITS.minWarnings) {
        throw new Error(
            `parsed ${warnings.length} warnings; minimum safe count is ${SCRAPE_SAFETY_LIMITS.minWarnings}`,
        );
    }
    if (warnings.length > SCRAPE_SAFETY_LIMITS.maxWarnings) {
        throw new Error(
            `parsed ${warnings.length} warnings; maximum safe count is ${SCRAPE_SAFETY_LIMITS.maxWarnings}`,
        );
    }
    if (duplicateIds.length > 0) {
        throw new Error(`duplicate warning IDs found: ${[...new Set(duplicateIds)].slice(0, 5).join(', ')}`);
    }

    let totalTextChars = 0;
    const ids = new Set();
    for (const warning of warnings) {
        const expectedId = `${warning.nav_area}-${warning.msg_year}/${warning.msg_number}`;
        if (warning.id !== expectedId || !/^(?:XIV|NZC)-\d{4}\/\d{1,5}$/.test(warning.id)) {
            throw new Error(`invalid warning identity: ${String(warning.id)}`);
        }
        if (ids.has(warning.id)) throw new Error(`duplicate warning ID found: ${warning.id}`);
        ids.add(warning.id);
        if (warning.issue_date !== issueDate || warning.fetched_at !== runTimestamp) {
            throw new Error(`warning timestamp mismatch: ${warning.id}`);
        }
        if (warning.status !== 'A' || warning.authority !== 'MARITIME NZ') {
            throw new Error(`warning authority/status mismatch: ${warning.id}`);
        }
        if (
            typeof warning.text !== 'string' ||
            warning.text.trim().length < 20 ||
            warning.text.length > SCRAPE_SAFETY_LIMITS.maxWarningTextChars
        ) {
            throw new Error(`warning text outside safe bounds: ${warning.id}`);
        }
        totalTextChars += warning.text.length;
    }
    if (totalTextChars > SCRAPE_SAFETY_LIMITS.maxTotalWarningTextChars) {
        throw new Error('total warning text exceeds safe bound');
    }
}

export function normalizeWarnings(bodyText, runTimestamp) {
    if (typeof bodyText !== 'string' || Buffer.byteLength(bodyText, 'utf8') > SCRAPE_SAFETY_LIMITS.maxPageBytes) {
        throw new Error('page text is missing or exceeds the safe byte bound');
    }
    const issueDate = parseInforceDate(bodyText);
    const blocks = splitWarnings(bodyText);
    const warnings = [];
    const duplicateIds = [];
    const seen = new Set();
    for (const block of blocks) {
        const warning = buildWarning(block, issueDate, runTimestamp);
        if (!warning) continue;
        if (seen.has(warning.id)) {
            duplicateIds.push(warning.id);
            continue;
        }
        seen.add(warning.id);
        warnings.push(warning);
    }
    validateScrapeResult({ warnings, issueDate, runTimestamp, duplicateIds });
    return { warnings, issueDate, blockCount: blocks.length };
}

// ── Supabase upsert + cleanup ──────────────────────────────────────────
//
// Strategy: upsert the freshly-scraped rows on (id), then delete any
// row whose fetched_at didn't get touched this run — that's how a
// withdrawn / cancelled warning disappears from the served list.

export async function persist(warnings, runTimestamp, credentials, createClientFn = createClient) {
    if (!credentials?.supabaseUrl || !credentials?.serviceKey) {
        throw new Error('validated service-role credentials are required for persistence');
    }
    const client = createClientFn(credentials.supabaseUrl, credentials.serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify the credential/table path and compare against the currently
    // served set before executing a mutation. A sudden >50% count drop is
    // much more likely to be parser drift than a legitimate withdrawal.
    const { error: preflightError, count: existingCount } = await client
        .from('linz_warnings')
        .select('id', { count: 'exact', head: true });
    if (preflightError) {
        throw new Error(`write preflight failed: ${preflightError.message}`);
    }
    const minimumRelativeCount = Math.ceil((existingCount ?? 0) * (1 - SCRAPE_SAFETY_LIMITS.maxCountDropFraction));
    if ((existingCount ?? 0) > 0 && warnings.length < minimumRelativeCount) {
        throw new Error(
            `parsed count ${warnings.length} is below the safe baseline ${minimumRelativeCount} ` +
                `(existing count ${existingCount}); refusing database changes`,
        );
    }

    const { error: upsertError } = await client
        .from('linz_warnings')
        .upsert(warnings, { onConflict: 'id', ignoreDuplicates: false });
    if (upsertError) {
        throw new Error(`upsert failed: ${upsertError.message}`);
    }

    // Anything with fetched_at strictly less than the run's canonical
    // timestamp belongs to a previous run and wasn't refreshed this
    // pass — that's a cancelled / withdrawn warning, so delete it.
    // The strict `<` means the rows we just upserted (whose fetched_at
    // equals runTimestamp) are safe.
    const { error: deleteError, count } = await client
        .from('linz_warnings')
        .delete({ count: 'exact' })
        .lt('fetched_at', runTimestamp);
    if (deleteError) {
        throw new Error(`stale cleanup failed: ${deleteError.message}`);
    }
    return { upserted: warnings.length, deleted: count ?? 0 };
}

// ── Main ───────────────────────────────────────────────────────────────

export async function runScraper({
    env = process.env,
    now = () => new Date(),
    scrapePage = scrape,
    persistWarnings = persist,
    logger = console,
} = {}) {
    const dryRun = dryRunEnabled(env);
    // Validate the privileged write boundary before launching an
    // upstream-controlled browser. Dry runs never read the secret.
    const writeCredentials = dryRun ? null : validateWriteEnvironment(env);

    // Canonical timestamp for this run. Used as both the rows'
    // fetched_at AND the cleanup cutoff — see persist() for why.
    const runDate = now();
    if (!(runDate instanceof Date) || !Number.isFinite(runDate.getTime())) {
        throw new Error('clock returned an invalid run timestamp');
    }
    const runTimestamp = runDate.toISOString();

    const bodyText = await scrapePage({ browserEnv: buildBrowserEnvironment(env) });
    const { warnings, issueDate, blockCount } = normalizeWarnings(bodyText, runTimestamp);
    logger.log(`[linz-msi] page in-force timestamp: ${issueDate}`);
    logger.log(`[linz-msi] parsed ${blockCount} warning block(s) from page text`);
    logger.log(`[linz-msi] normalised ${warnings.length} unique warning(s)`);

    if (dryRun) {
        logger.log(JSON.stringify(warnings.slice(0, 5), null, 2));
        logger.log(`[linz-msi] DRY_RUN=1 — skipping DB write`);
        return { dryRun: true, warnings, issueDate, upserted: 0, deleted: 0 };
    }

    const { upserted, deleted } = await persistWarnings(warnings, runTimestamp, writeCredentials);
    logger.log(`[linz-msi] upserted=${upserted} deleted=${deleted}`);
    return { dryRun: false, warnings, issueDate, upserted, deleted };
}

const isDirectInvocation = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
    runScraper().catch((err) => {
        console.error(`[linz-msi] FAILED: ${err.message}`);
        process.exitCode = 1;
    });
}
