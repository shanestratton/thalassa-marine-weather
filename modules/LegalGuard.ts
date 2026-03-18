/**
 * LegalGuard — Disclaimer Gatekeeper
 *
 * On app launch, checks whether the user has accepted the current version
 * of the "Not for Navigation" disclaimer. If the disclaimer version is bumped,
 * all users must re-accept before using the app.
 *
 * Pure module — no React, no Supabase dependency.
 * To force re-acceptance (e.g. after legal review in Newport), simply
 * increment DISCLAIMER_VERSION.
 */

/** Current disclaimer version — bump to force all users to re-accept */
export const DISCLAIMER_VERSION = '1.0';

const STORAGE_KEY = `thalassa_disclaimer_v${DISCLAIMER_VERSION}`;

/**
 * Check if the user has accepted the current disclaimer version.
 * Returns true if accepted, false otherwise.
 */
export function checkDisclaimerAccepted(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'accepted';
    } catch {
        // localStorage unavailable (SSR, private browsing edge case)
        return false;
    }
}

/**
 * Record that the user has accepted the current disclaimer.
 * Called when the user taps "I Understand" on the overlay.
 */
export function acceptDisclaimer(): void {
    try {
        localStorage.setItem(STORAGE_KEY, 'accepted');
    } catch {
        // Silently fail — worst case they see it again next launch
    }
}

/**
 * Returns the full legal disclaimer text.
 * Centralised here so it can be updated in one place.
 */
export function getDisclaimerText(): string {
    return `This application is provided as a supplementary tool for weather awareness and voyage planning only.

Thalassa is NOT a certified navigation aid and must NOT be used as a primary source for navigation decisions. All weather data, tide predictions, route suggestions, depth information, and AIS data are provided on a best-effort basis and may be inaccurate, delayed, or unavailable.

You are solely responsible for the safe navigation of your vessel. Always rely on official charts, certified navigation equipment, local weather services, and your own seamanship judgment.

By using this application, you acknowledge that:
• Weather forecasts are inherently uncertain and may change rapidly
• GPS positions shown may be inaccurate, especially offshore
• Depth data is approximate and may not reflect current conditions
• AIS data may be incomplete or delayed
• Route suggestions do not account for all hazards
• The developers accept no liability for any loss, damage, or injury arising from the use of this application

Use at your own risk. When in doubt, always err on the side of caution.`;
}
