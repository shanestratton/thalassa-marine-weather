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
import { writeFile, mkdir } from 'node:fs/promises';

const LINZ_URL = 'https://www.maritimenz.govt.nz/navigational-warnings/';

// Cloudflare's challenge usually clears within ~5 seconds. 60s upper
// bound accounts for occasional CF tightening + the CMS rendering the
// warning list via async XHR after domcontentloaded fires.
const CHALLENGE_TIMEOUT_MS = 60_000;

// On failure, dump page state here so the GH Actions step can upload
// it as an artifact for diagnosis (screenshot + raw HTML + body text).
const DEBUG_DIR = '/tmp/linz-debug';

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

function parseInforceDate(bodyText) {
    const m = bodyText.match(INFORCE_RE);
    if (!m) return '';
    const ddhhmm = m[1];
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) year = 2000 + year;
    if (!mon) return '';
    // "150500Z MAY 2026" — matches the NGA / AMSA / UKHO shape that
    // services/NoticeToMarinersService.ts::parseIssueDate understands.
    return `${ddhhmm}Z ${mon} ${year}`;
}

// Reference parsing — Maritime NZ uses two header formats:
//   "NAVAREA XIV WARNING 130/26"             — area XIV (S Pacific)
//   "NEW ZEALAND COASTAL NAVIGATION WARNING  — NZ coastal warnings
//                                     136/26"  (broadcast on MF / VHF)
// Each maps to a stable navArea code we can filter on client-side.
function parseReferenceMatch(match) {
    const kind = match[1].toUpperCase();
    const msgNumber = Number(match[2]);
    let msgYear = Number(match[3]);
    if (msgYear < 100) msgYear = 2000 + msgYear;
    if (!Number.isFinite(msgNumber) || !Number.isFinite(msgYear)) return null;
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
        await mkdir(DEBUG_DIR, { recursive: true });
        await page.screenshot({ path: `${DEBUG_DIR}/${label}.png`, fullPage: true }).catch(() => {});
        const html = await page.content().catch(() => '');
        await writeFile(`${DEBUG_DIR}/${label}.html`, html);
        const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        await writeFile(`${DEBUG_DIR}/${label}.txt`, bodyText);
        const url = page.url();
        await writeFile(`${DEBUG_DIR}/${label}.url.txt`, url);
        console.log(`[linz-msi] dumped page state to ${DEBUG_DIR}/${label}.* (final url: ${url})`);
    } catch (e) {
        console.warn(`[linz-msi] debug dump failed: ${e.message}`);
    }
}

async function scrape() {
    const browser = await chromium.launch({
        // GitHub-hosted runners ship with the necessary deps; locally
        // you may need `npx playwright install chromium --with-deps`.
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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
        // networkidle waits until there's been ≤ 2 concurrent requests
        // for 500ms — this catches CMS-rendered pages that hydrate
        // warnings via XHR after domcontentloaded.
        await page.goto(LINZ_URL, { waitUntil: 'networkidle', timeout: CHALLENGE_TIMEOUT_MS });

        // After network is idle, scan the body for any "WARNING NNN/YY"
        // — matches both "NAVAREA XIV WARNING 130/26" and
        // "NEW ZEALAND COASTAL NAVIGATION WARNING 136/26" formats.
        const FOUND_RE = /WARNING\s+\d+\/\d{2,4}/i;
        await page
            .waitForFunction((re) => new RegExp(re, 'i').test(document.body.innerText), FOUND_RE.source, {
                timeout: CHALLENGE_TIMEOUT_MS,
            })
            .catch(async (err) => {
                await dumpDebug(page, 'waitfn-timeout');
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

function splitWarnings(bodyText) {
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

function buildWarning(block, issueDate, runTimestamp) {
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

// ── Supabase upsert + cleanup ──────────────────────────────────────────
//
// Strategy: upsert the freshly-scraped rows on (id), then delete any
// row whose fetched_at didn't get touched this run — that's how a
// withdrawn / cancelled warning disappears from the served list.

async function persist(warnings, runTimestamp) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    }
    const client = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

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

async function main() {
    // Canonical timestamp for this run. Used as both the rows'
    // fetched_at AND the cleanup cutoff — see persist() for why.
    const runTimestamp = new Date().toISOString();

    const bodyText = await scrape();
    const issueDate = parseInforceDate(bodyText);
    console.log(`[linz-msi] page in-force timestamp: ${issueDate || '(not found)'}`);
    const blocks = splitWarnings(bodyText);
    console.log(`[linz-msi] parsed ${blocks.length} warning block(s) from page text`);

    const warnings = [];
    const seen = new Set();
    for (const block of blocks) {
        const w = buildWarning(block, issueDate, runTimestamp);
        if (!w) continue;
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        warnings.push(w);
    }
    console.log(`[linz-msi] normalised ${warnings.length} unique warning(s)`);

    if (process.env.DRY_RUN) {
        console.log(JSON.stringify(warnings.slice(0, 5), null, 2));
        console.log(`[linz-msi] DRY_RUN=1 — skipping DB write`);
        return;
    }

    if (warnings.length === 0) {
        // Don't wipe the table on a parse failure — better to serve
        // stale than empty. The GH Actions step will exit non-zero so
        // we see the failure.
        throw new Error('parsed zero warnings — selector drift or page change?');
    }

    const { upserted, deleted } = await persist(warnings, runTimestamp);
    console.log(`[linz-msi] upserted=${upserted} deleted=${deleted}`);
}

main().catch((err) => {
    console.error(`[linz-msi] FAILED: ${err.message}`);
    process.exit(1);
});
