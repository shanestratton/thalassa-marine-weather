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
 *
 * Phase 2b (2026-10-01): every success says how fresh it is —
 * X-Osm-Overlay: fresh | cache | stale and X-Osm-Fetched-At (ISO) — and
 * "no internet on the Pi and nothing saved for this area" is a 503
 * OSM_OVERLAY_UNAVAILABLE. It used to be an empty 200, which the phone took
 * for "no canals here" and saved over its last good copy. A pre-2b phone
 * reads the 503 as the failure it always handled, which never wrote.
 *
 * Fix-up (2026-10-02): a stale copy goes only to a phone that asks for it
 * with &stale=1 (2b on). A pre-2b phone ignores X-Osm-Overlay and would have
 * taken a stale copy of any age as fresh, with no caveat — it gets the 503.
 */

import { Router, type Request, type Response } from 'express';
import {
    getOsmOverlay,
    OsmOverlayUnavailableError,
    type OsmOverlayOptions,
    type OsmOverlayResult,
} from '../services/osm.js';

const UNAVAILABLE_MESSAGE =
    'Canal and marina water is unavailable right now: no internet on the Pi and nothing saved for this area.';

export function createOsmRoutes(
    getOverlay: (
        bbox: [number, number, number, number],
        opts: OsmOverlayOptions,
    ) => Promise<OsmOverlayResult> = getOsmOverlay,
): Router {
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

        // Only a phone that reads X-Osm-Overlay says it accepts a stale copy.
        const acceptStale = req.query.stale === '1';

        // Never cached by a client: a stale or missing answer must be asked
        // again, not replayed.
        res.set('Cache-Control', 'no-store');
        try {
            const { overlay, state, fetchedAt } = await getOverlay([w, s, e, n], { acceptStale });
            if (state === 'stale' && !acceptStale) throw new OsmOverlayUnavailableError('stale copy not asked for');
            res.set('X-Osm-Overlay', state);
            if (Number.isFinite(fetchedAt)) res.set('X-Osm-Fetched-At', new Date(fetchedAt).toISOString());
            res.json(overlay);
        } catch (err) {
            if (err instanceof OsmOverlayUnavailableError) {
                res.set('Retry-After', '30');
                return res.status(503).json({ code: 'OSM_OVERLAY_UNAVAILABLE', error: UNAVAILABLE_MESSAGE });
            }
            res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' });
        }
    });

    return router;
}
