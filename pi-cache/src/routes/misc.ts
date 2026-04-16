/**
 * Misc Routes — Cyclones, buoys, sea marks, geocoding, and other data.
 *
 * Catch-all for everything that doesn't fit neatly into
 * weather/tiles/grib/tides categories.
 *
 * Sources:
 *   - NOAA NHC / JTWC (tropical cyclone tracks)
 *   - NOAA NDBC (buoy observations)
 *   - OSM Overpass (sea marks — anchorages, marinas, fuel)
 *   - Mapbox Geocoding (reverse geocode for location names)
 *   - Rainbow.ai (precipitation nowcasting)
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { ProxyConfig, cachedJsonFetch, supabaseEdgeUrl, supabaseHeaders } from '../proxy.js';
import { TTL } from '../scheduler.js';

export function createMiscRoutes(cache: Cache, config: ProxyConfig): Router {
    const router = Router();

    // ── Tropical Cyclones ──

    /**
     * GET /api/misc/cyclones
     * Active tropical cyclones worldwide.
     */
    router.get('/cyclones', async (req: Request, res: Response) => {
        try {
            const key = 'cyclones:active';
            // KnackWx ATCF API — free, CORS-enabled, no key needed
            const url = 'https://api.knackwx.com/atcf/v2';

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.CYCLONE,
                source: 'knackwx-atcf',
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

    // ── Buoy Observations ──

    /**
     * GET /api/misc/buoys?lat=X&lon=Y&radius=5
     * Nearby buoy observations from NDBC and regional networks.
     */
    router.get('/buoys', async (req: Request, res: Response) => {
        try {
            const { lat, lon, radius = '5' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `buoys:${lat}:${lon}:r${radius}`;
            const url = supabaseEdgeUrl(config, 'buoys', {
                lat: String(lat),
                lon: String(lon),
                radius: String(radius),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.BUOY,
                source: 'ndbc',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Buoy data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/misc/buoys/:stationId
     * Detailed observations for a specific buoy station.
     */
    router.get('/buoys/:stationId', async (req: Request, res: Response) => {
        try {
            const { stationId } = req.params;
            const key = `buoys:station:${stationId}`;

            // NDBC direct — no API key needed
            const url = `https://www.ndbc.noaa.gov/data/realtime2/${stationId}.txt`;

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.BUOY,
                source: 'ndbc-station',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Buoy station failed', message: (err as Error).message });
        }
    });

    // ── Sea Marks ──

    /**
     * GET /api/misc/seamarks?bbox=minLon,minLat,maxLon,maxLat
     * Sea marks (anchorages, marinas, fuel, moorings) from OpenSeaMap/Overpass.
     */
    router.get('/seamarks', async (req: Request, res: Response) => {
        try {
            const { bbox } = req.query;
            if (!bbox) return res.status(400).json({ error: 'bbox required (minLon,minLat,maxLon,maxLat)' });

            const key = `seamarks:${bbox}`;

            // Overpass API query for sea marks within bbox
            const [minLon, minLat, maxLon, maxLat] = String(bbox).split(',');
            const overpassQuery = `[out:json][timeout:25];(node["seamark:type"](${minLat},${minLon},${maxLat},${maxLon}););out body;`;
            const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.SEAMARK,
                source: 'overpass-seamark',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Sea marks failed', message: (err as Error).message });
        }
    });

    // ── Geocoding ──

    /**
     * GET /api/misc/geocode?lat=X&lon=Y
     * Reverse geocode — get place name for a coordinate.
     * Used for "Current location: Hauraki Gulf" display.
     */
    router.get('/geocode', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            // Round to 2 decimal places for cache grouping (nearby lookups share a cache entry)
            const rLat = Math.round(parseFloat(String(lat)) * 100) / 100;
            const rLon = Math.round(parseFloat(String(lon)) * 100) / 100;

            const key = `geocode:${rLat}:${rLon}`;
            const url = supabaseEdgeUrl(config, 'geocode', { lat: rLat, lon: rLon });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — place names don't change
                source: 'mapbox-geocode',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
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
            // Flatten query params to strings (Express query params can be string | string[])
            const params: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.query)) {
                params[k] = Array.isArray(v) ? String(v[0]) : String(v);
            }

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
