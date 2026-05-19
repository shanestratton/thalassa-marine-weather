/**
 * OSM route-overlay HTTP routes.
 *
 * Single endpoint:
 *   GET /api/osm/overlay?bbox=W,S,E,N
 *     → returns OsmRouteOverlay (water, reef, coastline, marina, breakwater)
 *
 * The iOS app calls this whenever it computes an inshore route. The
 * router uses the returned features to supplement the chart's S-57 layers
 * (filling river / marina basin / reef-extent gaps).
 */

import { Router, type Request, type Response } from 'express';
import { getOsmOverlay } from '../services/osm.js';

export function createOsmRoutes(): Router {
    const router = Router();

    router.get('/overlay', async (req: Request, res: Response) => {
        const bboxStr = req.query.bbox;
        if (typeof bboxStr !== 'string') {
            return res.status(400).json({ error: 'Missing bbox query parameter (format: W,S,E,N)' });
        }
        const parts = bboxStr.split(',').map((p) => Number(p.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            return res.status(400).json({ error: 'Invalid bbox format (expected 4 comma-separated floats W,S,E,N)' });
        }
        const [w, s, e, n] = parts;
        if (w >= e || s >= n) {
            return res.status(400).json({ error: 'Invalid bbox — W must be < E and S must be < N' });
        }
        // Cap bbox area so a malicious query can't hammer Overpass. 5° square
        // (~550 × 550 km) is generous for any inshore route.
        if (e - w > 5 || n - s > 5) {
            return res.status(400).json({ error: 'Bbox too large — max 5° per side' });
        }

        try {
            const overlay = await getOsmOverlay([w, s, e, n]);
            res.json(overlay);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
        }
    });

    return router;
}
