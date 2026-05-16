// Default sample location used when an un-authed user (or an
// onboarded user who has somehow lost their saved home port) opens
// The Glass with no `settings.defaultLocation` set.
//
// The point is to never paint an empty weather page on first launch.
// Sample weather loads via `fetchWeather` (NOT `selectLocation`) so
// it does NOT write to `settings.defaultLocation` — the user knows
// at all times that they haven't claimed this as their port, and the
// "Tap to set yours →" chip on the dashboard invites them to pick
// their own via the map.
//
// Locale rotation (US East → Newport; US West → SF; UK → Cowes; AU
// → Sydney) is a later Week-1 milestone; for now, Sydney Harbour is
// a globally recognisable marine destination that makes the demo
// look intentional. Coords are mid-harbour off Fort Denison.
export const SAMPLE_LOCATION = {
    name: 'Sydney Harbour, NSW, AU',
    coords: { lat: -33.8568, lon: 151.2153 },
    /** Short label shown on the dashboard chip. */
    shortLabel: 'Sydney Harbour',
} as const;
