#!/usr/bin/env node
/**
 * Assert that Lighthouse audited THE APP, not the legal splash screen.
 *
 * This exists because a disclaimer-only audit PASSES every budget. index.tsx's
 * RootGate renders <DisclaimerOverlay /> ahead of the <Suspense> that
 * lazy-loads ApplicationShell, so if the acceptance seed in
 * scripts/lighthouse-setup.cjs ever stops working — a renamed storage key, a
 * bumped DISCLAIMER_VERSION, a Puppeteer/Lighthouse runtime change, a stray
 * numberOfRuns > 1 — Lighthouse quietly measures a few KB of static text and
 * reports a perfect score. That is exactly how this gate spent months
 * certifying nothing, and green CI is precisely when nobody looks.
 *
 * Byte weight is the canary, and it is unambiguous:
 *     app        ~597,000 bytes
 *     disclaimer   ~8,700 bytes
 * Two orders of magnitude apart, so the threshold does not need to be precise.
 *
 * A failure here does NOT mean the app got slower. It means the measurement is
 * invalid and every other number in the report should be ignored until the
 * bypass is fixed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.lighthouseci';
/** Well below the app (~597KB) and far above the disclaimer (~8.7KB). */
const MIN_APP_BYTES = 200_000;

let reports;
try {
    reports = readdirSync(DIR).filter((f) => f.startsWith('lhr-') && f.endsWith('.json'));
} catch {
    console.error(`✘ ${DIR}/ not found — Lighthouse did not run, so nothing was verified.`);
    process.exit(1);
}

if (reports.length === 0) {
    console.error(`✘ no lhr-*.json in ${DIR}/ — Lighthouse produced no report.`);
    process.exit(1);
}

let failed = false;
for (const file of reports) {
    const lhr = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    const bytes = lhr.audits?.['total-byte-weight']?.numericValue;
    const url = lhr.finalDisplayedUrl ?? lhr.finalUrl ?? '(unknown url)';

    if (typeof bytes !== 'number') {
        console.error(`✘ ${file}: no total-byte-weight audit — cannot verify what was measured.`);
        failed = true;
        continue;
    }

    const kb = Math.round(bytes / 1024);
    if (bytes < MIN_APP_BYTES) {
        console.error(
            `✘ ${file}: only ${kb} KiB transferred for ${url}.\n` +
                `  Lighthouse audited the DISCLAIMER OVERLAY, not the app, so every score in\n` +
                `  this report is meaningless. Check scripts/lighthouse-setup.cjs, the\n` +
                `  DISCLAIMER_VERSION key in modules/LegalGuard.ts, and that numberOfRuns is 1\n` +
                `  (the seed only survives the first run).`,
        );
        failed = true;
    } else {
        console.log(`✅ ${file}: ${kb} KiB — the app was audited.`);
    }
}

process.exit(failed ? 1 : 0);
