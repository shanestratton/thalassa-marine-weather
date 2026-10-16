/** App-only pinned TLS + physical-LAN front door is mandatory at the root mount. */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { RadarWatch, RadarWatchError } from '../radar/watch.js';
import { validRadarController, type RadarController, type RadarWatchStatus } from '../radar/radarWatchContract.js';
export interface RadarWatchRouteDeps {
    watch: RadarWatch;
    /** Reverify the current enrollment; never accept a device/owner identity from the body. */
    enrolled: (req: Request) => RadarController | null | Promise<RadarController | null>;
}
export function createRadarWatchRoutes(deps: RadarWatchRouteDeps): Router {
    const router = Router();
    router.use(express.json({ limit: '8kb', strict: true }));
    const route = (
        method: 'get' | 'post',
        path: string,
        action: (req: Request, caller: RadarController) => Promise<RadarWatchStatus>,
    ) => {
        router[method](path, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (
                    Object.keys(req.query).length ||
                    (method === 'post' && Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8') > 8192)
                )
                    throw new RadarWatchError(400, 'radar_invalid_request');
                const caller = await deps.enrolled(req);
                if (!validRadarController(caller)) throw new RadarWatchError(403, 'radar_enrollment_required');
                const status = await action(req, caller),
                    again = await deps.enrolled(req);
                if (
                    !again ||
                    again.deviceId !== caller.deviceId ||
                    again.enrollmentRevision !== caller.enrollmentRevision ||
                    !deps.watch.statusCurrent(status)
                )
                    throw new RadarWatchError(409, 'radar_context_changed');
                const body = JSON.stringify(status);
                if (Buffer.byteLength(body, 'utf8') > 64 * 1024)
                    throw new RadarWatchError(503, 'radar_status_exceeds_bound');
                return res.type('application/json').send(body);
            } catch (error) {
                return res
                    .status(error instanceof RadarWatchError ? error.status : 503)
                    .json({ error: error instanceof RadarWatchError ? error.code : 'radar_watch_unavailable' });
            }
        });
    };
    route('get', '/watch', () => deps.watch.describe());
    route('post', '/watch', (req, caller) => deps.watch.command(caller, req.body));
    route('post', '/watch/ack', (req, caller) => deps.watch.acknowledge(caller, req.body));
    router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (!error) return next();
        res.setHeader('Cache-Control', 'no-store');
        return res
            .status((error as { status?: number }).status === 413 ? 413 : 400)
            .json({ error: 'radar_invalid_json' });
    });
    return router;
}
