/**
 * routeAutoName — "Newport - Scarborough" for a trace, from its first and
 * last pins (Shane 2026-07-16: auto-name as you plot; first pin gives
 * "Newport - Newport", the route end updates it; coords when no sensible
 * place is nearby).
 *
 * Names come from the marine-aware reverse geocoder (POI/locality-ranked,
 * generalisation-guarded — services/weather/api/geocoding). We keep only the
 * locality ("Newport", not "Newport, QLD, AU") — route names read like a
 * passage, not an address. Unreachable/no-name water falls back to compact
 * coords ("27.14S 153.09E"). Results cache on a ~1 km grid so plotting a
 * dozen pins costs two geocodes, not twenty-four.
 */

import { reverseGeocode } from './weather';
import { withTimeout } from '../utils/deadline';

interface LatLon {
    lat: number;
    lon: number;
}

/** Compact, name-friendly coords: "27.14S 153.09E". */
export function coordsLabel(p: LatLon): string {
    const lat = `${Math.abs(p.lat).toFixed(2)}${p.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(p.lon).toFixed(2)}${p.lon >= 0 ? 'E' : 'W'}`;
    return `${lat} ${lon}`;
}

const placeCache = new Map<string, string>();

/** Locality name for a point, or compact coords when the geocoder can't
 *  produce one. Cached on a ~1 km grid; never rejects. */
export async function placeLabelFor(p: LatLon): Promise<string> {
    const key = `${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
    const hit = placeCache.get(key);
    if (hit) return hit;
    let label = coordsLabel(p);
    try {
        // reverseGeocode has its own retries; the outer deadline bounds the
        // whole thing (CapacitorHttp ignores AbortSignal on native).
        const name = await withTimeout(reverseGeocode(p.lat, p.lon), null, 6_000);
        const locality = name?.split(',')[0]?.trim();
        if (locality) label = locality;
    } catch {
        /* offline / rate-limited — coords stand */
    }
    placeCache.set(key, label);
    return label;
}

/** "Newport - Scarborough" (or "Newport - 27.14S 153.09E"). One pin → both
 *  ends the same ("Newport - Newport"), by design — the end updates live as
 *  the route grows. */
export async function autoRouteName(first: LatLon, last: LatLon): Promise<string> {
    const [a, b] = await Promise.all([placeLabelFor(first), placeLabelFor(last)]);
    return `${a} - ${b}`;
}

/**
 * Does this read like a name WE generated, rather than one the skipper typed?
 *
 * Auto-naming stops the moment the box no longer matches the last auto value,
 * so a route opened from storage looked hand-typed and never renamed again:
 * drag the destination from Moreton Bay to Lady Musgrave and the title still
 * said Moreton Bay (Shane 2026-07-28). Re-arming on this shape lets an opened
 * auto-name keep tracking its endpoints.
 *
 * Deliberately shape-only — "A - B" with both halves non-empty. A skipper who
 * hand-types "Brisbane - Gladstone" gets re-armed too, which is the right
 * outcome: if they then move an endpoint, that name is simply wrong. A name
 * with no " - " in it is never touched.
 */
export function looksAutoNamed(name: string): boolean {
    return /^\s*\S.*\s-\s.*\S\s*$/.test(name);
}
