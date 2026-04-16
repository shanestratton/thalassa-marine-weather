/**
 * Tide Routes — Proxies tide prediction and sea level data through the Pi cache.
 *
 * Sources:
 *   - WorldTides API (via Supabase edge function — API key stays server-side)
 *   - NOAA CO-OPS (free tide predictions for US stations)
 *   - LINZ tidal data (NZ stations — free)
 *
 * Tides are very predictable so they get long TTLs (12 hours).
 * Sea level observations update more frequently (1 hour).
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { ProxyConfig, cachedJsonFetch, supabaseEdgeUrl, supabaseHeaders } from '../proxy.js';
import { TTL } from '../scheduler.js';

export function createTideRoutes(cache: Cache, config: ProxyConfig): Router {
    const router = Router();

    /**
     * GET /api/tides/predictions?lat=X&lon=Y
     * Tide predictions for the nearest station via WorldTides (Supabase).
     */
    router.get('/predictions', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '7' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `tides:predictions:${lat}:${lon}:${days}d`;
            const url = supabaseEdgeUrl(config, 'proxy-tides', {
                lat: String(lat),
                lon: String(lon),
                days: String(days),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.TIDES,
                source: 'worldtides',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Tide predictions failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tides/stations?lat=X&lon=Y&radius=100
     * Find nearby tide stations.
     */
    router.get('/stations', async (req: Request, res: Response) => {
        try {
            const { lat, lon, radius = '100' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `tides:stations:${lat}:${lon}:r${radius}`;
            const url = supabaseEdgeUrl(config, 'tide-stations', {
                lat: String(lat),
                lon: String(lon),
                radius: String(radius),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: 24 * 60 * 60 * 1000, // 24h — stations don't move
                source: 'tide-stations',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Tide stations failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tides/noaa?station=XXXXXXX
     * NOAA CO-OPS tide predictions (US stations — free, no key needed).
     */
    router.get('/noaa', async (req: Request, res: Response) => {
        try {
            const { station } = req.query;
            if (!station) return res.status(400).json({ error: 'station ID required' });

            const key = `tides:noaa:${station}`;

            // NOAA CO-OPS API — get 48 hours of predictions
            const now = new Date();
            const begin = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
            const end = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 8);

            const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${begin}&end_date=${end}&station=${station}&product=predictions&datum=MLLW&time_zone=gmt&units=metric&application=thalassa&format=json`;

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.TIDES,
                source: 'noaa-coops',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'NOAA tides failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tides/sealevel?lat=X&lon=Y
     * Real-time sea level observations (faster refresh than predictions).
     */
    router.get('/sealevel', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `tides:sealevel:${lat}:${lon}`;
            const url = supabaseEdgeUrl(config, 'sealevel', {
                lat: String(lat),
                lon: String(lon),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.SEALEVEL,
                source: 'sealevel',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Sea level fetch failed', message: (err as Error).message });
        }
    });

    return router;
}
