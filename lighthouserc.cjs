/**
 * Lighthouse release audit — measuring THE REAL APP since 2026-07-30.
 *
 * It previously measured the legal disclaimer. index.tsx's RootGate returns
 * <DisclaimerOverlay /> ahead of the <Suspense> that lazy-loads
 * ApplicationShell, and Lighthouse runs a clean profile, so acceptance was
 * always false and the audited document was a few KB of static legal text. The
 * tell was arithmetic sitting in this file: `total-byte-weight <= 524288`
 * PASSED against a dist/assets of ~9.5 MB.
 *
 * scripts/run-lighthouse-audit.mjs invokes scripts/lighthouse-setup.cjs to seed
 * the acceptance key before the run, with disableStorageReset so Lighthouse
 * does not wipe it. Byte weight is now ~597 KB on every run, which is how you
 * can tell it is the app.
 *
 * The project runs Lighthouse directly through
 * scripts/run-lighthouse-audit.mjs. That keeps the browser, Lighthouse, and
 * Puppeteer versions in the audited lockfile, avoids the obsolete LHCI CLI
 * dependency chain, and keeps reports in CI artifacts rather than temporary
 * public storage.
 *
 * The budgets below are the app's honest numbers, not aspirations. Every
 * ratcheted line records the value it must return to. They are set above the
 * observed spread so the gate blocks a real regression rather than flapping —
 * a gate that cries wolf gets ignored, which is how this repo banked 60
 * consecutive red runs nobody read. Do not loosen one to make a build pass;
 * fix the regression, or move the number deliberately and say why here.
 *
 * Accessibility is back to a STRICT 0.96 and is no longer flaky. The old
 * 0.95/0.96 flapping was the disclaimer's score sitting on the boundary; the
 * app measures 1.00 on every run.
 */
module.exports = {
    ci: {
        collect: {
            url: ['http://127.0.0.1:4173/'],
            // ONE RUN, deliberately. The seed is applied to the one browser
            // profile audited by the direct runner. A multi-run implementation
            // would need to reseed each fresh context. Proof from the old runner:
            // two runs of one build returned total-byte-weight 597013 and 8747.
            //
            // That also corrects what I first wrote here. I attributed the wild
            // spread in total-blocking-time (22ms vs 7157ms) to machine load. It
            // was not load — it was alternating between two different documents.
            //
            // BYTE WEIGHT IS THE CANARY: ~597KB means the app was audited,
            // ~8.7KB means it fell back to the splash screen and every other
            // number on the report is meaningless. Check it before trusting a
            // suspiciously good result.
            numberOfRuns: 1,
            // Accepts the legal disclaimer so the audit sees ApplicationShell
            // rather than the splash screen. The direct runner invokes the setup
            // script named in the header.
            // Without this, Lighthouse wipes the seeded acceptance flag.
            settings: { disableStorageReset: true },
        },
        assert: {
            assertions: {
                // Ratcheted to today's honest floor. App-only runs measured
                // 0.45 / 0.80 / 0.81, dominated by main-thread boot work.
                // TARGET 0.96.
                'categories:performance': ['error', { minScore: 0.4 }],
                // STRICT, and stable now that it measures the app: 1.00 on every
                // run. This assertion used to flap 0.95/0.96 — that was the
                // DISCLAIMER's score sitting on the boundary, not the app's.
                'categories:accessibility': ['error', { minScore: 0.96 }],
                'categories:best-practices': ['error', { minScore: 0.95 }],
                'categories:seo': ['error', { minScore: 0.96 }],
                // Observed 1152 / 1609 / 2233.
                'first-contentful-paint': ['error', { maxNumericValue: 3500 }],
                // Observed 5028 / 5341 / 6177. TARGET 2500.
                'largest-contentful-paint': ['error', { maxNumericValue: 9000 }],
                // Observed 5341 / 5383 / 10490. TARGET 3000.
                interactive: ['error', { maxNumericValue: 16000 }],
                // App-only runs measured 68 / 4904 / 7157. The low readings I
                // first recorded here (22ms, 67ms) were DISCLAIMER runs and are
                // struck from the record. Still the widest-swinging metric, so
                // the headroom is for genuine variance. TARGET 200.
                'total-blocking-time': ['error', { maxNumericValue: 10000 }],
                // STRICT: the app measures 0.
                'cumulative-layout-shift': ['error', { maxNumericValue: 0.05 }],
                // Observed ~597KB, rock steady. TARGET 524288.
                'total-byte-weight': ['error', { maxNumericValue: 700000 }],
            },
        },
    },
};
