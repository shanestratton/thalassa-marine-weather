/**
 * Track routes — the boat's own record, for the app that asks for it.
 *
 * Three verbs and nothing else: say what you hold, turn recording on or off,
 * hand back a window of it. There is deliberately no delete-all here. The
 * whole point of the Pi keeping the track is that it survives things the phone
 * does not, and an endpoint that wipes years of it on one request is a worse
 * risk than any convenience it buys. Erasing is a job for someone at a
 * keyboard on the boat, not a tap on a phone that might be in a pocket.
 *
 * PRIVACY. This is everywhere the vessel has been. It sits in the same
 * app-only group as pairing and the diary relay, behind the pinned-TLS
 * transport the app pairs with — never on the open HTTP lane.
 */

import { Request, Response, Router } from 'express';
import type { TrackRecorderRunner } from '../trackRunner.js';
import type { TrackStore } from '../trackStore.js';

/** A day, as the default window: enough to answer "where did we go today". */
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
/** One request cannot drag the whole log across the boat LAN. */
const MAX_POINTS = 50_000;

function finiteParam(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function createTrackRoutes(store: TrackStore, runner: TrackRecorderRunner): Router {
    const router = Router();

    /** GET /api/track/status — what is running, and what is held. */
    router.get('/status', (_req: Request, res: Response) => {
        res.json({ enabled: store.isEnabled(), ...runner.describe() });
    });

    /**
     * POST /api/track/enable  { enabled: boolean }
     *
     * The preference is written BEFORE the runner is touched, so a Pi that
     * dies mid-request comes back in the state the skipper asked for rather
     * than the one it happened to be in.
     */
    router.post('/enable', (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be true or false' });
        }
        store.setEnabled(body.enabled);
        if (body.enabled) runner.start();
        else runner.stop();
        return res.json({ enabled: store.isEnabled(), ...runner.describe() });
    });

    /**
     * GET /api/track/points?from=<epoch ms>&to=<epoch ms>&limit=<n>
     *
     * Defaults to the last day. An open-ended request would otherwise mean
     * "send me everything", and on a log designed to run for years that is not
     * a request anyone makes on purpose.
     */
    router.get('/points', (req: Request, res: Response) => {
        const now = Date.now();
        const to = finiteParam(req.query.to) ?? now;
        const from = finiteParam(req.query.from) ?? to - DEFAULT_WINDOW_MS;
        if (from > to) return res.status(400).json({ error: 'from must not be after to' });

        const requested = finiteParam(req.query.limit);
        const limit = Math.max(1, Math.min(requested ?? MAX_POINTS, MAX_POINTS));
        const points = store.points({ fromMs: from, toMs: to, limit });

        /* Say when the answer was cut short. A silently truncated track looks
           exactly like a boat that stopped, which is the one misreading this
           log must never invite. */
        res.json({ from, to, limit, points, truncated: points.length === limit });
    });

    return router;
}
