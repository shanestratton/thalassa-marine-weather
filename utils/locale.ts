// Locale detection — maps the device's IANA timezone to a small
// set of marine regions. Used by sampleLocation.ts to pick the
// right "Sample: <city>" demo for un-authed users on first launch,
// and by future featured-passage / locale-rotated demo content.
//
// Why timezone, not IP geo?
//   - Sync on cold boot — no edge-function round trip
//   - Works offline — first paint stays meaningful even on a plane
//   - Free — no Cloudflare Worker quota burn for what is, after
//     all, a "decorative" personalisation
//   - Deterministic — every install in Brisbane gets the same
//     sample, every install in San Francisco gets the same sample
//
// IP geo can land later as a precision overlay (Mountain Time
// users currently fall back to DEFAULT; an IP-geo signal could
// route them to US_WEST). The defer flow does NOT depend on it.

export type Region = 'AU' | 'NZ' | 'UK' | 'US_EAST' | 'US_WEST' | 'DEFAULT';

/** Memoised — timezone never changes during a single app session. */
let cached: Region | null = null;

export function detectRegion(): Region {
    if (cached) return cached;

    let tz = '';
    try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        // Old browsers / weird sandboxes — fall through to DEFAULT.
    }

    cached = mapTimezoneToRegion(tz);
    return cached;
}

/** Pure helper, exported for tests. */
export function mapTimezoneToRegion(tz: string): Region {
    if (!tz) return 'DEFAULT';

    // Australia — covers Sydney, Brisbane, Melbourne, Perth, Hobart, Adelaide
    if (tz.startsWith('Australia/')) return 'AU';

    // New Zealand — Auckland + Chatham
    if (tz === 'Pacific/Auckland' || tz === 'Pacific/Chatham') return 'NZ';

    // UK + Ireland + Crown Dependencies
    if (/^Europe\/(London|Dublin|Belfast|Isle_of_Man|Guernsey|Jersey)$/.test(tz)) return 'UK';

    // US East Coast + Canadian Maritimes + Caribbean Atlantic — Eastern + Atlantic timezones
    // (Central time isn't strictly East Coast, but for marine demo purposes
    // a Chicago user sees Newport which is closer to home than Sydney.)
    if (
        /^America\/(New_York|Detroit|Indiana\/|Kentucky\/|Louisville|Toronto|Montreal|Halifax|Moncton|Boston|Nassau|Bermuda|Cayman|Antigua|St_Lucia|Barbados|Chicago|Indianapolis)/.test(
            tz,
        )
    )
        return 'US_EAST';

    // US West Coast + Canadian Pacific + Mexico Pacific + Alaska
    if (/^America\/(Los_Angeles|Vancouver|Tijuana|Anchorage|Juneau|San_Francisco)/.test(tz)) return 'US_WEST';

    return 'DEFAULT';
}

/** Reset cache — for tests only. */
export function _resetRegionCacheForTests(): void {
    cached = null;
}
