/**
 * OSM route-overlay client.
 *
 * iOS-side fetcher for OSM features needed by the inshore router. The Pi
 * runs the actual Overpass query + cache; we just pull the assembled
 * GeoJSON via HTTP. Results are also cached locally (memory + Capacitor
 * Filesystem) so subsequent routes within the same bbox tile reuse them
 * without round-tripping the Pi.
 *
 * Used by InshoreRouter — when assembling the layer set for a route
 * bbox, after pulling chart cells we also fetch the OSM overlay and
 * merge water polygons (→ supplement DEPARE), reef polygons
 * (→ supplement OBSTRN), and breakwaters (→ supplement LNDARE). That
 * fills the structural gaps in S-57 ENC data: rivers inside coastal
 * landmass polygons, marina exit channels, reef extents.
 */

import type { FeatureCollection } from 'geojson';

import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('OsmRouteOverlay');

const MEM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-process
const FETCH_TIMEOUT_MS = 60_000; // first-time Overpass queries can be slow

export interface OsmRouteOverlay {
    water: FeatureCollection;
    reef: FeatureCollection;
    coastline: FeatureCollection;
    marina: FeatureCollection;
    breakwater: FeatureCollection;
}

function emptyOverlay(): OsmRouteOverlay {
    return {
        water: { type: 'FeatureCollection', features: [] },
        reef: { type: 'FeatureCollection', features: [] },
        coastline: { type: 'FeatureCollection', features: [] },
        marina: { type: 'FeatureCollection', features: [] },
        breakwater: { type: 'FeatureCollection', features: [] },
    };
}

interface MemCacheEntry {
    ts: number;
    data: OsmRouteOverlay;
}
const memCache = new Map<string, MemCacheEntry>();

function bboxKey(bbox: [number, number, number, number]): string {
    const r = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${r(bbox[0])}_${r(bbox[1])}_${r(bbox[2])}_${r(bbox[3])}`;
}

/**
 * Fetch the OSM route overlay for a bbox. Returns an empty overlay on any
 * failure — the router falls back cleanly to chart-only data.
 *
 * @param bbox [W, S, E, N] in degrees
 */
export async function getOsmRouteOverlay(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const key = bboxKey(bbox);
    const cached = memCache.get(key);
    if (cached && Date.now() - cached.ts < MEM_CACHE_TTL_MS) {
        log.info(`mem-cache hit for bbox ${key}`);
        return cached.data;
    }

    if (!piCache.isAvailable()) {
        log.warn('Pi not reachable — OSM overlay empty (router will fall back to chart-only)');
        return emptyOverlay();
    }

    const url = `${piCache.baseUrl}/api/osm/overlay?bbox=${bbox.join(',')}`;
    log.warn(`fetching OSM overlay for bbox ${key} via ${url}`);
    const t0 = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            log.warn(`OSM overlay HTTP ${res.status} — using empty overlay`);
            return emptyOverlay();
        }
        const data = (await res.json()) as OsmRouteOverlay;
        const counts = `water=${data.water?.features?.length ?? 0} reef=${data.reef?.features?.length ?? 0} coast=${data.coastline?.features?.length ?? 0} marina=${data.marina?.features?.length ?? 0} bw=${data.breakwater?.features?.length ?? 0}`;
        log.warn(`OSM overlay fetched in ${Date.now() - t0}ms — ${counts}`);
        memCache.set(key, { ts: Date.now(), data });
        return data;
    } catch (err) {
        log.warn(
            `OSM overlay fetch failed (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
        return emptyOverlay();
    } finally {
        clearTimeout(timer);
    }
}
