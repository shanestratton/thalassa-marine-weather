/** Display names only: these reference points never move a fix or guide a route. */
import { CapacitorHttp } from '@capacitor/core';
import { withTimeout } from '../utils/deadline';
import { pruneMap } from '../utils/boundedMap';

export interface MarineLocality {
    id: string;
    name: string;
    kind: 'island' | 'bay' | 'cove' | 'harbour' | 'anchorage';
    lat: number;
    lon: number;
}

function distanceM(lat: number, lon: number, point: Pick<MarineLocality, 'lat' | 'lon'>): number {
    const rad = Math.PI / 180;
    const a =
        Math.sin(((point.lat - lat) * rad) / 2) ** 2 +
        Math.cos(lat * rad) * Math.cos(point.lat * rad) * Math.sin(((point.lon - lon) * rad) / 2) ** 2;
    return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/**
 * Prefer a genuinely close harbour/cove to a district. Gazetteer points are
 * representative locations, not boundaries: keep radii conservative and
 * refuse ambiguous neighbouring islands rather than claiming false precision.
 * Large islands/bays whose reference point is far away fall back to geocoding.
 */
export function selectMarineEndpointName(lat: number, lon: number, places: readonly MarineLocality[]): string | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const nearby = places.flatMap((p) => {
        if (!p.name.trim() || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return [];
        const distance = distanceM(lat, lon, p);
        const limit = p.kind === 'island' ? 2_000 : 800;
        return distance <= limit ? [{ ...p, distance }] : [];
    });
    // A named bay/harbour immediately beside the fix is more useful than the
    // island containing it. Otherwise prefer the nearby island itself.
    const specific = nearby.filter((p) => p.kind !== 'island').sort((a, b) => a.distance - b.distance);
    const islands = nearby.filter((p) => p.kind === 'island').sort((a, b) => a.distance - b.distance);
    for (const candidates of [specific, islands]) {
        const first = candidates[0];
        if (!first) continue;
        const other = candidates.find((p) => p.name !== first.name);
        if (other && other.distance - first.distance < 150) continue;
        return first.name;
    }
    return null;
}

/** A nearby reverse result may name a village/island even when Mapbox only
 * names its district. Never use a street, business or protected-area name. */
export function detailedEndpointName(body: unknown, lat: number, lon: number): string | null {
    const data = body as { lat?: string; lon?: string; address?: Record<string, unknown> } | null;
    if (data?.lat == null || data?.lon == null || data.lat === '' || data.lon === '') return null;
    const p = { lat: Number(data?.lat), lon: Number(data?.lon) };
    if (
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lon) ||
        Math.abs(p.lat) > 90 ||
        Math.abs(p.lon) > 180 ||
        distanceM(lat, lon, p) > 2_000
    )
        return null;
    const address = data?.address ?? {};
    for (const field of [
        'marina',
        'harbour',
        'island',
        'neighbourhood',
        'suburb',
        'village',
        'town',
        'hamlet',
        'city',
    ]) {
        const value = address[field];
        if (typeof value === 'string' && value.trim() && value !== address.state && value !== address.county)
            return value.trim();
    }
    return null;
}

// Ambiguous reference points and the Log's final geocoder fallback use this
// lookup. Serialise, deduplicate and pace it; lists must not burst requests.
let lookupQueue = Promise.resolve();
let lastLookupAt = 0;
const detailCache = new Map<string, { at: number; name: string | null }>();
const detailInflight = new Map<string, Promise<string | null>>();
export async function resolveDetailedEndpointName(lat: number, lon: number): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.at < (hit.name ? 86_400_000 : 60_000)) return hit.name;
    const pending = detailInflight.get(key);
    if (pending) return pending;
    const job = lookupQueue.then(async () => {
        const delay = Math.min(1_100, Math.max(0, 1_100 - (Date.now() - lastLookupAt)));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        lastLookupAt = Date.now();
        let name: string | null = null;
        try {
            const res = await withTimeout(
                CapacitorHttp.get({
                    url: `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
                    headers: { 'User-Agent': 'ThalassaMarine/1.0' },
                    connectTimeout: 3_000,
                    readTimeout: 4_000,
                }),
                null,
                5_000,
            );
            if (res?.status === 200)
                name = detailedEndpointName(typeof res.data === 'string' ? JSON.parse(res.data) : res.data, lat, lon);
        } catch {
            /* Offline: keep the broad geocoder/coordinate fallback. */
        }
        detailCache.set(key, { at: Date.now(), name });
        pruneMap(detailCache, 300);
        return name;
    });
    lookupQueue = job.then(
        () => undefined,
        () => undefined,
    );
    detailInflight.set(key, job);
    try {
        return await job;
    } finally {
        detailInflight.delete(key);
    }
}

/** Bundled reference resolves clear matches offline; ambiguous ones use a
 * bounded, cached locality lookup rather than guessing the nearest island. */
export async function marineEndpointName(lat: number, lon: number): Promise<string | null> {
    // Current maintained reference covers Queensland. Elsewhere retain the
    // global locality geocoder; do not pretend this is worldwide coverage.
    if (lat < -29.3 || lat > -9 || lon < 138 || lon > 154) return null;
    const { default: places } = await import('../data/marine-place-names-qld.json');
    const name = selectMarineEndpointName(lat, lon, places as MarineLocality[]);
    if (name) return name;
    if ((places as MarineLocality[]).some((p) => distanceM(lat, lon, p) <= (p.kind === 'island' ? 2_000 : 800))) {
        // Each request has a deadline; queue wait must not consume it.
        // Otherwise several cards can cache a district just before their
        // precise queued result arrives.
        return resolveDetailedEndpointName(lat, lon);
    }
    return null;
}
