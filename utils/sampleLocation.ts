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
// Locale rotation
// ----------------
// `getSampleLocation()` dispatches on `detectRegion()` so an
// Australian visitor sees Sydney, a US East Coast visitor sees
// Newport, a UK visitor sees the Solent, etc. Region is derived
// from IANA timezone — sync on cold boot, no network round-trip.
// See utils/locale.ts for the timezone → region mapping.
//
// SAMPLE_LOCATION is a backwards-compat alias resolved once at
// module import — for the entire app session, all consumers see
// the same regional sample. That keeps the boot-time fetch and the
// dashboard chip label in agreement (we fetch Newport, we label
// Newport).

import { detectRegion, type Region } from './locale';

export type SampleLocation = {
    /** Full place name used by fetchWeather → forward geocoding. */
    name: string;
    /** Authoritative coords so the orchestrator skips geocoding entirely. */
    coords: { lat: number; lon: number };
    /** Short label for the dashboard chip ("Sample: <shortLabel> · Tap…"). */
    shortLabel: string;
    /** Which region resolved to this sample — useful for analytics + tests. */
    region: Region;
};

// Mid-harbour / mid-bay coords for each region. Picked to be over
// water (so the marine weather data resolves cleanly) and on a
// globally recognisable cruising ground.
const REGIONAL: Record<Region, Omit<SampleLocation, 'region'>> = {
    AU: {
        name: 'Sydney Harbour, NSW, AU',
        coords: { lat: -33.8568, lon: 151.2153 },
        shortLabel: 'Sydney Harbour',
    },
    NZ: {
        name: 'Auckland Harbour, NZ',
        coords: { lat: -36.8485, lon: 174.7633 },
        shortLabel: 'Auckland Harbour',
    },
    UK: {
        // The Solent, off Cowes — universal UK marine landmark.
        name: 'The Solent, Cowes, UK',
        coords: { lat: 50.7669, lon: -1.2986 },
        shortLabel: 'The Solent',
    },
    US_EAST: {
        // Newport, RI — America's Cup heritage, the natural US
        // East Coast cruising hub.
        name: 'Newport, RI, USA',
        coords: { lat: 41.4901, lon: -71.3128 },
        shortLabel: 'Newport, RI',
    },
    US_WEST: {
        // SF Bay — easily recognised by US West Coast sailors and
        // pulls dramatic marine data (fog, swell, current).
        name: 'San Francisco Bay, CA, USA',
        coords: { lat: 37.8082, lon: -122.4098 },
        shortLabel: 'SF Bay',
    },
    DEFAULT: {
        // Sydney is the historical sample (PR2 baseline) and a
        // good neutral marine destination for unmapped regions.
        name: 'Sydney Harbour, NSW, AU',
        coords: { lat: -33.8568, lon: 151.2153 },
        shortLabel: 'Sydney Harbour',
    },
};

let cached: SampleLocation | null = null;

/**
 * Returns the region-appropriate sample location. Memoised — the
 * timezone (and thus the region) never changes during a session,
 * so the value is computed once and reused.
 */
export function getSampleLocation(): SampleLocation {
    if (cached) return cached;
    const region = detectRegion();
    cached = { ...REGIONAL[region], region };
    return cached;
}

/**
 * Backwards-compat: existing PR2 consumers import SAMPLE_LOCATION
 * directly. This alias is resolved at module-import time so it's
 * a plain object (not a getter), and every consumer in the same
 * session sees the same regional sample.
 */
export const SAMPLE_LOCATION: SampleLocation = getSampleLocation();

/** Test-only — clears the memoisation cache. */
export function _resetSampleLocationCacheForTests(): void {
    cached = null;
}
