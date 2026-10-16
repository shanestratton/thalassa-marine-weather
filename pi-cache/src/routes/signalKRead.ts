import { Router } from 'express';
import { CHART_DEVICE_HEADER, type EncDeviceStore } from '../encDevices.js';
import type { SignalKReadSession } from '../signalKReadSession.js';

/** Mount behind requireAppApi. Read only, currently enrolled phones only; no source URL/token input. */
export function createSignalKReadRoutes(
    session: Pick<SignalKReadSession, 'notificationSnapshot'>,
    devices: Pick<EncDeviceStore, 'verify'>,
): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.get('/notifications', async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: 'This read accepts no parameters.' });
        try {
            const credential = req.headers[CHART_DEVICE_HEADER];
            if (typeof credential !== 'string' || (await devices.verify(credential)).state !== 'enrolled')
                return res.status(401).json({ error: 'Set up this phone with the code from the boat’s Pi.' });
            return res.json(session.notificationSnapshot());
        } catch {
            return res.status(503).json({ error: 'The Pi could not check this device.' });
        }
    });
    return router;
}
