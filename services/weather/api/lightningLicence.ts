/**
 * lightningLicence — the ONE switch for the Blitzortung lightning feed.
 *
 * Blitzortung.org's terms (read 2026-10-07, contact.php?PrivacyPolicy=1):
 *   - "It is not allowed to use our lightning data for storm warning systems"
 *   - "All applications that use our data must be freely accessible"
 *   - applications "have to retrieve their data from a separate server and
 *     not from the servers of Blitzortung.org"
 *   - "The source of the data must be clearly identified"; the data stays
 *     under CC BY-SA 4.0
 * Thalassa is a subscription app that opened wss://ws*.blitzortung.org from
 * the phone and counted strikes into the chart's threat banner, so the feed
 * is OFF by default from build 123 (the recommendation, acted on under
 * Shane's standing instruction while his own answer is pending). Everything
 * that touches it — the socket, the map layer,
 * the radial-menu toggle and the banner's strike count — reads this.
 *
 * Turning it back on — only with Blitzortung's written permission (or behind a
 * relay of our own) — is a change to config/public-beta-features.json
 * (featureFlags.VITE_BLITZORTUNG_ENABLED), made together with
 * intendedPublicBetaFeatureFlags in scripts/check-beta-readiness.mjs and
 * tests/PublicBetaFeatureProfile.test.ts. Every `vite build` takes the value
 * from that profile, and a production build stops if an environment variable
 * disagrees with it, so an env var alone cannot switch it on: the
 * VITE_BLITZORTUNG_ENABLED env var reaches only the dev server and tests. The
 * licensed replacement is planned separately (Xweather quote, W4-02).
 */
export const BLITZORTUNG_LICENCE = 'CC BY-SA 4.0';
export const BLITZORTUNG_LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/**
 * Read at call time, so a test can flip it; Vite inlines it in a build. A
 * production build defines the flag as exactly "true" or "false", so this
 * literal comparison folds to a constant, and callers that test it FIRST
 * (`isBlitzortungEnabled() && requested`) let Rollup drop the code behind it.
 */
export function isBlitzortungEnabled(): boolean {
    return import.meta.env.VITE_BLITZORTUNG_ENABLED === 'true';
}
