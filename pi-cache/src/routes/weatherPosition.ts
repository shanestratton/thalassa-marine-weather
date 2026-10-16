import { Router } from 'express';
import {
    CHART_DEVICE_HEADER,
    classifyPeer,
    readBoatLanView,
    type EncDeviceStore,
    type BoatLanView,
} from '../encDevices.js';
import { readWeatherPositionSource } from '../weatherPosition.js';
/** Mount behind requireAppApi. Cache-only fixed read; no caller coordinate/URL/source selection. */
export function createWeatherPositionRoutes(options: {
    devices: Pick<EncDeviceStore, 'verify'>;
    selfDocument: () => unknown;
    relayId: () => string | null;
    lanView?: () => BoatLanView;
    peerOf?: (request: import('express').Request) => string | undefined;
    now?: () => number;
}): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.get('/position-source', async (req, res) => {
        if (
            Object.keys(req.query).length ||
            req.headers['transfer-encoding'] ||
            Number(req.headers['content-length'] ?? '0') > 0
        )
            return res.status(400).json({ error: 'This read accepts no parameters or body.' });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (
                !classifyPeer(
                    (options.peerOf ?? ((r) => r.socket.remoteAddress))(req),
                    (options.lanView ?? readBoatLanView)(),
                ).boatLan
            )
                return res.status(403).json({ error: 'Review weather position sharing on the boat’s own Wi-Fi.' });
            const token = req.headers[CHART_DEVICE_HEADER],
                verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (verdict.state !== 'enrolled')
                return res.status(401).json({ error: 'Set up this phone with the code from the boat’s Pi.' });
            const relayId = options.relayId(),
                document = relayId
                    ? await Promise.race([
                          Promise.resolve().then(options.selfDocument),
                          new Promise<never>((_, reject) => {
                              timer = setTimeout(() => reject(new Error('Cache unavailable')), 2000);
                          }),
                      ])
                    : null;
            const source = relayId ? readWeatherPositionSource(document, relayId, (options.now ?? Date.now)()) : null;
            const after = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (
                after.state !== 'enrolled' ||
                after.device.id !== verdict.device.id ||
                after.device.enrolledAt !== verdict.device.enrolledAt ||
                relayId !== options.relayId() ||
                !classifyPeer(
                    (options.peerOf ?? ((r) => r.socket.remoteAddress))(req),
                    (options.lanView ?? readBoatLanView)(),
                ).boatLan
            )
                return res.status(401).json({ error: 'Device enrollment changed.' });
            return source
                ? res.json(source)
                : res.status(503).json({ error: 'A qualified original-clock position and paired relay are required.' });
        } catch {
            return res.status(503).json({ error: 'Weather position source unavailable.' });
        } finally {
            if (timer) clearTimeout(timer);
        }
    });
    return router;
}
