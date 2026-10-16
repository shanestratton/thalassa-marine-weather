import { Router } from 'express';
import type { PiUnderwayWatch } from '../underwayWatch.js';
import { CHART_DEVICE_HEADER, type EncDeviceStore } from '../encDevices.js';
/** State remains readable aboard; every mutation requires a currently enrolled
 * device even while the legacy command lock is in observe mode. */
export function createUnderwayWatchRoutes(watch: PiUnderwayWatch, devices: EncDeviceStore): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.get('/', (_req, res) => res.json(watch.describe()));
    router.use(async (req, res, next) => {
        try {
            const header = req.headers[CHART_DEVICE_HEADER];
            const verdict = await devices.verify(Array.isArray(header) ? header[0] : header);
            if (verdict.state !== 'enrolled')
                return res.status(401).json({
                    code: 'chart-device-not-enrolled',
                    error: 'Set up this phone with the code from the boat’s Pi.',
                });
            next();
        } catch {
            res.status(503).json({ error: 'The Pi could not check this device.' });
        }
    });
    router.post('/', (req, res) => {
        if (req.body?.armed === false) {
            const current = watch.describe();
            if (current.armed && (typeof req.body.routeKey !== 'string' || req.body.routeKey !== current.routeKey))
                return res.status(409).json({ error: 'The Pi is following a different route.', watch: current });
            return res.status(watch.standDown() ? 200 : 503).json(watch.describe());
        }
        if (req.body?.armed !== true || !watch.configure(req.body.configuration))
            return res.status(400).json({ error: 'A valid followed route, draft and clearance are required.' });
        return res.json(watch.describe());
    });
    router.post('/ack', (req, res) => {
        const current = watch.describe();
        if (typeof req.body?.routeKey !== 'string' || req.body.routeKey !== current.routeKey)
            return res.status(409).json({ error: 'The Pi is following a different route.', watch: current });
        return res.json({
            acked: typeof req.body?.key === 'string' && watch.acknowledge(req.body.key),
            watch: watch.describe(),
        });
    });
    return router;
}
