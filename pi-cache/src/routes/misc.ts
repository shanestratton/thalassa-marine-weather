/**
 * Misc Routes — Cyclones, sea marks, geocoding, and other data.
 *
 * Catch-all for everything that doesn't fit neatly into
 * weather/tiles/grib/tides categories.
 *
 * Sources:
 *   - NOAA NHC / JTWC (tropical cyclone tracks)
 *   - OSM Overpass (sea marks — anchorages, marinas, fuel)
 *   - Mapbox Geocoding (reverse geocode for location names)
 *   - Rainbow.ai (precipitation nowcasting)
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { fetchOwnedOsmEdge } from '../ownedOsm.js';
import {
    parseOwnedOsmRequest,
    parseOwnedOsmDocument,
    OWN_OSM_MAX_SOURCE_AGE_MS,
    type OwnedOsmDocument,
} from '../ownedOsmContract.js';
import {
    ProxyConfig,
    cachedJsonFetch,
    isSupabaseFunctionName,
    normalizeSupabaseProxyQuery,
    supabaseEdgeUrl,
    supabaseHeaders,
    uncachedJsonFetch,
} from '../proxy.js';
import { CYCLONE_FEED_KEY, TTL } from '../scheduler.js';

/** The kv rows earlier builds kept for reverse geocodes. */
const GEOCODE_KEY_PREFIX = 'geocode:';

/**
 * The one-time start-up delete of cached reverse geocodes (127-C-d decision
 * 13): Mapbox's terms (§2.7.2) allow no storing or caching of temporary
 * geocodes, and until Pi update 3 this Pi kept every answer for 7 days, shared
 * by every device. Removes those rows and nothing else; returns how many.
 */
export function purgeGeocodeCache(cache: Cache): number {
    return cache.deleteKvPrefix(GEOCODE_KEY_PREFIX);
}

export function createMiscRoutes(
    cache: Cache,
    config: ProxyConfig,
    deps: { fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown> } = {},
): Router {
    const router = Router();
    const fetchJson =
        deps.fetchJson ?? ((url: string, headers: Record<string, string>) => uncachedJsonFetch(url, headers));

    // ── Tropical Cyclones ──

    /**
     * GET /api/misc/cyclone-feed
     * Active tropical cyclones worldwide, with the warning centres' own tracks:
     * Thalassa's cyclone-feed edge function (129-09b, NOAA/JTWC/NCEP direct;
     * no Esri, no knackwx), kept here for the boat.
     */
    router.get('/cyclone-feed', async (req: Request, res: Response) => {
        try {
            const result = await cachedJsonFetch(cache, {
                cacheKey: CYCLONE_FEED_KEY,
                url: supabaseEdgeUrl(config, 'cyclone-feed'),
                ttlMs: TTL.CYCLONE_FEED,
                source: 'thalassa-cyclone-feed',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Cyclone data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/misc/cyclones/:id
     * Detailed track for a specific cyclone.
     */
    router.get('/cyclones/:id', async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const key = `cyclones:track:${id}`;
            const url = supabaseEdgeUrl(config, 'cyclone-track', { id: String(id) });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.CYCLONE,
                source: 'nhc-jtwc',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Cyclone track failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/misc/seamarks?bbox=minLon,minLat,maxLon,maxLat
     * Sea marks (anchorages, marinas, fuel, moorings) from OpenSeaMap/Overpass.
     */
    router.get('/seamarks', async (req: Request, res: Response) => {
        try {
            const { bbox } = req.query;
            if (typeof bbox !== 'string')
                return res.status(400).json({ error: 'bbox required (minLon,minLat,maxLon,maxLat)' });

            const rawCoordinates = bbox.split(',');
            if (rawCoordinates.length !== 4 || rawCoordinates.some((value) => !value.trim()))
                return res.status(400).json({ error: 'Invalid bbox' });
            const coordinates = rawCoordinates.map(Number);
            const [w, s, e, n] = coordinates;
            const operation = parseOwnedOsmRequest({ schema: 1, kind: 'nodes', bbox: [s, w, n, e] });
            if (!operation) return res.status(400).json({ error: 'Invalid bounded seamark operation' });
            const key = `owned_seamarks_v1:${operation.bbox.join(',')}`;
            const stored = cache.get(key);
            let saved: OwnedOsmDocument | null = null;
            try {
                if (stored) saved = parseOwnedOsmDocument(stored.data, operation);
            } catch {
                /* Source expired/unqualified. */
            }
            if (saved && stored && stored.expiresAt > Date.now()) {
                res.set('X-Cache', 'HIT');
                return res.json(saved);
            }
            try {
                const document = await fetchOwnedOsmEdge(config, operation);
                const remaining = Date.parse(document.thalassaSource.sourceAt) + OWN_OSM_MAX_SOURCE_AGE_MS - Date.now();
                if (remaining > 0) cache.set(key, document, Math.min(TTL.SEAMARK, remaining), 'owned-osm');
                res.set('X-Cache', 'MISS');
                return res.json(document);
            } catch {
                if (saved) {
                    res.set('X-Cache', 'STALE');
                    return res.json(saved);
                }
                return res
                    .status(503)
                    .json({ code: 'OWN_OSM_UNAVAILABLE', error: 'Owned seamark reference unavailable' });
            }
        } catch {
            res.status(503).json({ code: 'OWN_OSM_UNAVAILABLE', error: 'Owned seamark reference unavailable' });
        }
    });

    // ── Geocoding ──

    /**
     * GET /api/misc/geocode?lat=X&lon=Y
     * Reverse geocode — get place name for a coordinate.
     * Used for "Current location: Hauraki Gulf" display.
     *
     * Passed straight through, never cached (127-C-d decision 13, Mapbox
     * Product Terms §2.7.2: no storing or caching of temporary geocodes).
     * Offline, the app shows the position instead of a place name.
     */
    router.get('/geocode', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            // Rounded to 2 decimals (about 1 km): what the edge function is asked, never a stored key.
            const rLat = Math.round(parseFloat(String(lat)) * 100) / 100;
            const rLon = Math.round(parseFloat(String(lon)) * 100) / 100;
            const url = supabaseEdgeUrl(config, 'geocode', { lat: rLat, lon: rLon });
            res.json(await fetchJson(url, supabaseHeaders(config)));
        } catch (err) {
            res.status(502).json({ error: 'Geocode failed', message: (err as Error).message });
        }
    });

    // ── Precipitation Nowcasting ──

    /**
     * GET /api/misc/precipitation?lat=X&lon=Y
     * Short-range precipitation nowcast (next 2 hours).
     */
    router.get('/precipitation', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `precip:nowcast:${lat}:${lon}`;
            const url = supabaseEdgeUrl(config, 'proxy-rainbow', {
                lat: String(lat),
                lon: String(lon),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: 10 * 60 * 1000, // 10 min — nowcasts expire fast
                source: 'rainbow-precip',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Precipitation failed', message: (err as Error).message });
        }
    });

    // ── Catch-all Supabase Proxy ──

    /**
     * GET /api/misc/proxy/:functionName
     * Generic pass-through to any Supabase edge function.
     * Query params are forwarded as-is. Cached with a default 15-min TTL.
     * This handles any future edge functions without needing new Pi routes.
     */
    router.get('/proxy/:functionName', async (req: Request, res: Response) => {
        try {
            const functionName = String(req.params.functionName);
            if (!isSupabaseFunctionName(functionName)) {
                return res.status(400).json({ error: 'Unsupported Supabase function name' });
            }
            const params = normalizeSupabaseProxyQuery(req.query);

            // Build a cache key from the function name + sorted params
            const sortedParams = Object.keys(params)
                .sort()
                .map((k) => `${k}=${params[k]}`)
                .join('&');
            const key = `proxy:${functionName}:${sortedParams}`;

            const url = supabaseEdgeUrl(config, functionName, params);

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_CURRENT, // 15 min default
                source: `supabase-${functionName}`,
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Proxy failed', message: (err as Error).message });
        }
    });

    return router;
}
