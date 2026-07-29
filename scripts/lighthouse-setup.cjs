/**
 * Lighthouse setup — accept the legal disclaimer before auditing.
 *
 * WITHOUT THIS, EVERY LIGHTHOUSE BUDGET IN CI CERTIFIED A SPLASH SCREEN.
 *
 * index.tsx's RootGate returns <DisclaimerOverlay /> ahead of the <Suspense>
 * that lazy-loads ApplicationShell, and modules/LegalGuard reads acceptance
 * from localStorage. Lighthouse runs a clean profile, so acceptance was always
 * false and the audited document was the disclaimer — a few KB of static text —
 * never the app.
 *
 * The tell was in the assertions themselves: `total-byte-weight <= 524288`
 * passed while dist/assets is ~9.5 MB with a 1.6 MB mapbox chunk. Those two
 * facts cannot both describe the same page. Performance 1.0, accessibility
 * 0.95, and a 512 KB byte budget were all measurements of the legal gate.
 *
 * This seeds the acceptance flag on the origin before the run so the audit
 * loads the real ApplicationShell. It is a CI-only harness file: the
 * production gate is untouched, and nothing here ships.
 */

/** Keep in sync with modules/LegalGuard.ts — DISCLAIMER_VERSION. */
const DISCLAIMER_VERSION = '1.0';
const STORAGE_KEY = `thalassa_disclaimer_v${DISCLAIMER_VERSION}`;

/**
 * @param {import('puppeteer').Browser} browser
 * @param {{url: string}} context
 */
module.exports = async (browser, context) => {
    const page = await browser.newPage();
    // Must be on the origin before localStorage is writable.
    await page.goto(context.url, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => {
        try {
            localStorage.setItem(key, 'accepted');
        } catch {
            /* storage blocked — the audit will measure the gate and the
               byte-weight assertion will fail loudly, which is the honest
               outcome rather than a silent pass. */
        }
    }, STORAGE_KEY);
    await page.close();
};
