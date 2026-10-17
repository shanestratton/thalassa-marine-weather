import express, { Router, type Request, type ErrorRequestHandler } from 'express';
import {
    CHART_DEVICE_HEADER,
    classifyPeer,
    readBoatLanView,
    type BoatLanView,
    type EncDeviceStore,
    type ChartDevicePublic,
} from '../encDevices.js';
import { wakeEnrollmentRevision } from '../wakeKeeper/contract.js';
import { FleetFeedKeeper } from '../fleetFeed/keeper.js';
import { FLEET_LOCAL_BYTES } from '../fleetFeed/contract.js';
/** Independently boat-LAN and enrolled-device bound in every lock mode. */
export function createFleetFeedRoutes(options: {
    keeper: FleetFeedKeeper;
    devices: Pick<EncDeviceStore, 'verify'>;
    lanView?: () => BoatLanView;
    peerOf?: (req: Request) => string | undefined;
}): Router {
    const router = Router(),
        rawChecked = new WeakSet<Request>();
    const fail = (res: express.Response) =>
        res.status(409).json({
            code: 'fleet-review-required',
            error: 'Review Pi sharing; the account, vessel, phone or source could not be confirmed.',
        });
    router.use(async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        try {
            if (
                !classifyPeer(
                    (options.peerOf ?? ((r) => r.socket.remoteAddress))(req),
                    (options.lanView ?? readBoatLanView)(),
                ).boatLan
            )
                return res.status(403).json({ code: 'fleet-boat-wifi-only' });
            const token = req.headers[CHART_DEVICE_HEADER],
                verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (verdict.state !== 'enrolled') return res.status(401).json({ code: 'fleet-device-not-enrolled' });
            res.locals.fleetDevice = verdict.device;
            next();
        } catch {
            return fail(res);
        }
    });
    router.use((req, res, next) => {
        if (req.method === 'POST' && (req.body !== undefined || !req.is('application/json'))) return fail(res);
        return next();
    });
    router.use(
        express.json({
            limit: FLEET_LOCAL_BYTES,
            inflate: false,
            strict: true,
            verify: (req) => {
                rawChecked.add(req as Request);
            },
        }),
    );
    const same = async (req: Request, device: ChartDevicePublic) => {
        const token = req.headers[CHART_DEVICE_HEADER],
            verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
        return (
            verdict.state === 'enrolled' &&
            verdict.device.id === device.id &&
            wakeEnrollmentRevision(verdict.device) === wakeEnrollmentRevision(device)
        );
    };
    router.get('/status', async (req, res) => {
        try {
            if (Object.keys(req.query).length) return fail(res);
            return res.json(options.keeper.status());
        } catch {
            return fail(res);
        }
    });
    router.post('/prepare', async (req, res) => {
        try {
            if (!rawChecked.has(req) || Object.keys(req.query).length) return fail(res);
            const device = res.locals.fleetDevice as ChartDevicePublic,
                result = await options.keeper.prepare(req.body, device);
            if (!(await same(req, device))) {
                options.keeper.off();
                return fail(res);
            }
            return res.json(result);
        } catch {
            return fail(res);
        }
    });
    router.post('/confirm', async (req, res) => {
        try {
            if (!rawChecked.has(req) || Object.keys(req.query).length) return fail(res);
            const device = res.locals.fleetDevice as ChartDevicePublic;
            await options.keeper.install(req.body, device);
            if (!(await same(req, device))) {
                options.keeper.off();
                return fail(res);
            }
            return res.json(options.keeper.status());
        } catch {
            return fail(res);
        }
    });
    router.post('/off', (req, res) => {
        try {
            if (
                !rawChecked.has(req) ||
                Object.keys(req.query).length ||
                !req.body ||
                Object.keys(req.body).length !== 1 ||
                req.body.schema !== 1
            )
                return fail(res);
            options.keeper.off();
            return res.json(options.keeper.status());
        } catch {
            return fail(res);
        }
    });
    router.use(((error, _req, res, _next) => {
        if ((error as { status?: number })?.status === 413)
            return res.status(413).json({ code: 'fleet-body-too-large' });
        return fail(res);
    }) as ErrorRequestHandler);
    return router;
}
