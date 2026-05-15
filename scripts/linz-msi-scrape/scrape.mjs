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
// Maritime NZ warnings come with a date column rendered as "12 May 2026"
// or sometimes "12/05/2026". We normalise both to the same "DDHHMMZ MON
// YYYY" shape the iOS-side parseIssueDate expects ("000000Z MAY 2026").
// Time-of-day isn't published on the public page so we zero it.

const MONTHS = {
    january: 'JAN',
    february: 'FEB',
    march: 'MAR',
    april: 'APR',
    may: 'MAY',
    june: 'JUN',
    july: 'JUL',
    august: 'AUG',
    september: 'SEP',
    october: 'OCT',
    november: 'NOV',
    december: 'DEC',
    jan: 'JAN',
    feb: 'FEB',
    mar: 'MAR',
    apr: 'APR',
    jun: 'JUN',
    jul: 'JUL',
    aug: 'AUG',
    sep: 'SEP',
    oct: 'OCT',
    nov: 'NOV',
    dec: 'DEC',
};

function normaliseDate(raw) {
    if (!raw) return '';
    const trimmed = raw.trim();
    // "12 May 2026"
    let m = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (m) {
        const day = m[1].padStart(2, '0');
        const mon = MONTHS[m[2].toLowerCase()];
        if (mon) return `${day}0000Z ${mon} ${m[3]}`;
    }
    // "12/05/2026" (DD/MM/YYYY) — NZ convention
    m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
        const day = m[1].padStart(2, '0');
        const monthIdx = Number(m[2]) - 1;
        const monNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const mon = monNames[monthIdx];
        if (mon) return `${day}0000Z ${mon} ${m[3]}`;
    }
    return '';
}

// Reference parsing — Maritime NZ uses several patterns depending on
// the warning class:
//   "NAVAREA XIV 045/26"   — area XIV (South Pacific) warnings
//   "NZ COASTAL 132/26"    — NZ coastal warnings (broadcasts on MF / VHF)
//   "RNZN 12/26"           — naval exercise / sub note (rare)
// Each maps to a stable navArea code we can filter on.
function parseReference(ref) {
    if (!ref) return null;
    const navarea = ref.match(/NAVAREA\s+XIV\s+(\d+)\/(\d+)/i);
    if (navarea) {
        let year = Number(navarea[2]);
        if (year < 100) year = 2000 + year;
        return { navArea: 'XIV', msgNumber: Number(navarea[1]), msgYear: year };
    }
    const coastal = ref.match(/NZ\s+COASTAL\s+(\d+)\/(\d+)/i);
    if (coastal) {
        let year = Number(coastal[2]);
        if (year < 100) year = 2000 + year;
        return { navArea: 'NZC', msgNumber: Number(coastal[1]), msgYear: year };
    }
    return null;
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

        // After network is idle, scan the body for any warning-like
        // reference. We're forgiving on format — Maritime NZ uses
        // several patterns (NAVAREA XIV, NZ COASTAL, sometimes just
        // "warning NNN/YY") so accept anything that looks like a ref
        // number alongside the word "warning" or "navarea" or "coastal".
        const FOUND_RE =
            /(NAVAREA\s+XIV|NZ\s+COASTAL|NAVAREA\s+I|coastal\s+warning|navigational\s+warning)\s*[#:]?\s*\d+/i;
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
// block starts at a "NAVAREA XIV NNN/YY" (or "NZ COASTAL …") line and
// runs until the next reference header or end of text. We then look
// for a date inside the block (first thing matching a known date
// shape) and use the rest as the body.

const REF_RE = /(?:NAVAREA\s+XIV|NZ\s+COASTAL)\s+\d+\/\d+/gi;
const DATE_RE =
    /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/i;

function splitWarnings(bodyText) {
    const blocks = [];
    const matches = [...bodyText.matchAll(REF_RE)];
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : bodyText.length;
        const block = bodyText.slice(start, end).trim();
        const ref = matches[i][0];
        const dateMatch = block.match(DATE_RE);
        const issueDate = dateMatch ? normaliseDate(dateMatch[1]) : '';
        // Body: keep the reference header as the first line so the iOS
        // title-extractor reads the reference number first (matches
        // the AMSA / UKHO proxy convention).
        blocks.push({ ref, issueDate, body: block });
    }
    return blocks;
}

function buildWarning(block) {
    const parsed = parseReference(block.ref);
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
        issue_date: block.issueDate,
        authority: 'MARITIME NZ',
        fetched_at: new Date().toISOString(),
    };
}

// ── Supabase upsert + cleanup ──────────────────────────────────────────
//
// Strategy: upsert the freshly-scraped rows on (id), then delete any
// row whose fetched_at didn't get touched this run — that's how a
// withdrawn / cancelled warning disappears from the served list.

async function persist(warnings) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    }
    const client = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const cutoff = new Date().toISOString();

    const { error: upsertError } = await client
        .from('linz_warnings')
        .upsert(warnings, { onConflict: 'id', ignoreDuplicates: false });
    if (upsertError) {
        throw new Error(`upsert failed: ${upsertError.message}`);
    }

    // Anything not refreshed this run is stale → delete.
    const { error: deleteError, count } = await client
        .from('linz_warnings')
        .delete({ count: 'exact' })
        .lt('fetched_at', cutoff);
    if (deleteError) {
        throw new Error(`stale cleanup failed: ${deleteError.message}`);
    }
    return { upserted: warnings.length, deleted: count ?? 0 };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
    const bodyText = await scrape();
    const blocks = splitWarnings(bodyText);
    console.log(`[linz-msi] parsed ${blocks.length} warning block(s) from page text`);

    const warnings = [];
    const seen = new Set();
    for (const block of blocks) {
        const w = buildWarning(block);
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

    const { upserted, deleted } = await persist(warnings);
    console.log(`[linz-msi] upserted=${upserted} deleted=${deleted}`);
}

main().catch((err) => {
    console.error(`[linz-msi] FAILED: ${err.message}`);
    process.exit(1);
});
