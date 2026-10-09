/**
 * The night watch's LAN surface (build 126, 126-04a), for the phones aboard.
 *
 *   GET  /api/ais-watch        what the watch is doing (aisWatch.ts describe())
 *   POST /api/ais-watch        { armed: true, prefs, ownMmsi?, device? }
 *                              | { armed: false, device?, everyone? }
 *   POST /api/ais-watch/ack    { kind, mmsi }: silence one alarm, for every phone aboard
 *   POST /api/ais-watch/test   "Send a test from the Pi" (126-04b): one push through the
 *                              whole path to the skipper's phone; answers { push, queued }
 *
 * `device` is the phone's install id: the watch keeps every device that armed
 * it and stands down when the last of them disarms. `everyone: true` is the
 * deliberate stand-down from aboard (a second tap on the phone's watch row).
 *
 * The phone's collision shield drives the first (arming aboard arms the Pi
 * too); its alarm cards drive the second. The thresholds go through the same
 * sanitiseCollisionPrefs the phone uses, so a Pi can never hold a pair the
 * phone would not. Mounted behind requireAppApi on the pinned TLS lane the app
 * pairs with (server.ts), like every other app endpoint.
 */
import { Router, type Request, type Response } from 'express';
import type { AisNightWatch, AisWatchKind, AisWatchPushState } from '../aisWatch.js';
import { isDeviceId, isMmsi } from '../aisWatchStore.js';
import { sanitiseCollisionPrefs } from '../collisionRule/collisionRule.js';

const KINDS: ReadonlySet<string> = new Set<AisWatchKind>(['collision', 'close-quarters', 'distress']);

/** The request body as an object; the native bridge has been known to send JSON as a string. */
function bodyOf(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export interface AisWatchRouteOptions {
    /** The relay's test push (piAlarmRelay.ts test()); absent on a Pi with no relay wired. */
    test?: () => Promise<{ push: AisWatchPushState; queued: boolean }>;
}

export function createAisWatchRoutes(watch: AisNightWatch, options: AisWatchRouteOptions = {}): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        res.json(watch.describe());
    });

    router.post('/', (req: Request, res: Response) => {
        const body = bodyOf(req.body);
        if (!body || typeof body.armed !== 'boolean') {
            return res.status(400).json({ status: 'error', error: 'armed must be true or false' });
        }
        const device = body.device ?? null;
        if (device !== null && !isDeviceId(device)) {
            return res.status(400).json({ status: 'error', error: 'device must be an install id' });
        }
        if (body.armed) {
            const ownMmsi = body.ownMmsi ?? null;
            if (ownMmsi !== null && !isMmsi(ownMmsi)) {
                return res.status(400).json({ status: 'error', error: 'ownMmsi must be an MMSI' });
            }
            watch.arm(sanitiseCollisionPrefs(body.prefs), { ownMmsi, device });
        } else {
            if (body.everyone !== undefined && typeof body.everyone !== 'boolean') {
                return res.status(400).json({ status: 'error', error: 'everyone must be true or false' });
            }
            watch.disarm({ device, everyone: body.everyone === true });
        }
        return res.json({ status: 'ok', watch: watch.describe() });
    });

    router.post('/ack', (req: Request, res: Response) => {
        const body = bodyOf(req.body);
        if (!body || typeof body.kind !== 'string' || !KINDS.has(body.kind) || !isMmsi(body.mmsi)) {
            return res.status(400).json({ status: 'error', error: 'kind and mmsi must name one alarm' });
        }
        // No alarm open here yet is still taken: the watch keeps it for one raised soon after.
        const alarm = watch.ack(body.kind as AisWatchKind, body.mmsi);
        return res.json({ status: 'ok', acked: alarm !== null, alarm, watch: watch.describe() });
    });

    router.post('/test', async (_req: Request, res: Response) => {
        if (!options.test) {
            return res.status(503).json({ status: 'error', error: 'This Pi cannot send a test push' });
        }
        try {
            const result = await options.test();
            return res.json({ status: 'ok', push: result.push, queued: result.queued });
        } catch {
            return res.status(502).json({ status: 'error', error: 'The test could not be sent' });
        }
    });

    return router;
}
