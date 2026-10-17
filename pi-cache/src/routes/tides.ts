/**
 * Tide Routes — the live WorldTides prediction path through the Pi cache.
 *
 * Sources:
 *   - WorldTides API (via Supabase edge function — API key stays server-side)
 *
 * Tides are very predictable so they get long TTLs (12 hours).
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

    return router;
}
