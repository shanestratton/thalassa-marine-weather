import { Router } from 'express';
import {
    CHART_DEVICE_HEADER,
    classifyPeer,
    readBoatLanView,
    type EncDeviceStore,
    type BoatLanView,
} from '../encDevices.js';
import { readWeatherPositionSource } from '../weatherPosition.js';
import { weatherPositionUuid, weatherPositionRelay, type WeatherPositionIdentity } from '../weatherPositionWire.js';
/** Mount behind requireAppApi. Cache-only fixed read; no caller coordinate/URL/source selection. */
export function createWeatherPositionRoutes(options: {
    devices: Pick<EncDeviceStore, 'verify'>;
    selfDocument: () => unknown;
    identity: () => WeatherPositionIdentity | null;
    lanView?: () => BoatLanView;
    peerOf?: (request: import('express').Request) => string | undefined;
    now?: () => number;
}): Router {
    const router = Router();
    const identityNow = (): WeatherPositionIdentity | null => {
        const value = options.identity();
        return value &&
            weatherPositionUuid(value.ownerId) &&
            weatherPositionUuid(value.piDeviceId) &&
            weatherPositionRelay(value.relayId)
            ? { ownerId: value.ownerId, piDeviceId: value.piDeviceId, relayId: value.relayId }
            : null;
    };
    const sameIdentity = (a: WeatherPositionIdentity | null, b: WeatherPositionIdentity | null) =>
        !!a && !!b && a.ownerId === b.ownerId && a.piDeviceId === b.piDeviceId && a.relayId === b.relayId;
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
            const identity = identityNow(),
                token = req.headers[CHART_DEVICE_HEADER],
                verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (verdict.state !== 'enrolled')
                return res.status(401).json({ error: 'Set up this phone with the code from the boat’s Pi.' });
            if (!identity) return res.status(503).json({ error: 'A current owned Pi relay is required.' });
            if (!sameIdentity(identity, identityNow()))
                return res.status(401).json({ error: 'Relay ownership changed.' });
            const document = await Promise.race([
                Promise.resolve().then(options.selfDocument),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Cache unavailable')), 2000);
                }),
            ]);
            if (!sameIdentity(identity, identityNow()))
                return res.status(401).json({ error: 'Relay ownership changed.' });
            const source = readWeatherPositionSource(document, identity, (options.now ?? Date.now)());
            const after = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (
                after.state !== 'enrolled' ||
                after.device.id !== verdict.device.id ||
                after.device.enrolledAt !== verdict.device.enrolledAt ||
                !sameIdentity(identity, identityNow()) ||
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
