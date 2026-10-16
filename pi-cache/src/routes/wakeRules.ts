import express, { Router, type Request, type Response, type ErrorRequestHandler } from 'express';
import {
    CHART_DEVICE_HEADER,
    classifyPeer,
    readBoatLanView,
    type EncDeviceStore,
    type BoatLanView,
    type ChartDevicePublic,
} from '../encDevices.js';
import { PiWakeKeeper } from '../wakeKeeper/runner.js';
import { WAKE_CONFIG_BYTES, WakeKeeperError, wakeEnrollmentRevision } from '../wakeKeeper/contract.js';

/** Mount behind requireAppApi; skip the earlier global body parser for this prefix.
 * These independent LAN/enrollment checks also apply with device observe mode. */
export function createWakeRuleRoutes(options: {
    keeper: PiWakeKeeper;
    devices: Pick<EncDeviceStore, 'verify'>;
    lanView?: () => BoatLanView;
    peerOf?: (request: Request) => string | undefined;
}): Router {
    const router = Router(),
        rawChecked = new WeakSet<Request>();
    const failure = (res: Response, error: unknown) => {
        const code = error instanceof WakeKeeperError ? error.code : 'unavailable';
        return res
            .status(({ invalid: 400, conflict: 409, binding: 403, unavailable: 503, busy: 409 } as const)[code])
            .json({
                code: `wake-${code}`,
                error: (
                    {
                        invalid: 'Review the wake-rule configuration.',
                        conflict: 'The saved rules changed. Review them before saving again.',
                        binding: 'The owner, phone or measured source changed. Review the rules again.',
                        unavailable: 'The Pi could not confirm wake-rule storage or evaluation.',
                        busy: 'Another wake-rule change is being saved. Review the current rules.',
                    } as const
                )[code],
            });
    };
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
                return res
                    .status(403)
                    .json({ code: 'wake-boat-wifi-only', error: 'Manage wake rules from the boat’s own Wi-Fi.' });
            const token = req.headers[CHART_DEVICE_HEADER],
                verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (verdict.state !== 'enrolled')
                return res.status(401).json({
                    code: 'wake-device-not-enrolled',
                    error: 'Set up this phone with the code from the boat’s Pi.',
                });
            res.locals.wakeDevice = verdict.device;
            next();
        } catch {
            return failure(res, new WakeKeeperError('unavailable'));
        }
    });
    router.use((req, res, next) => {
        if (!['POST', 'DELETE'].includes(req.method)) return next();
        // If an earlier parser consumed the stream, its larger default limit is
        // not proof of this endpoint's smaller wire cap. Fail closed.
        if (req.body !== undefined || !req.is('application/json')) return failure(res, new WakeKeeperError('invalid'));
        return next();
    });
    router.use(
        express.json({
            limit: WAKE_CONFIG_BYTES,
            inflate: false,
            strict: true,
            verify: (req) => {
                rawChecked.add(req as Request);
            },
        }),
    );
    const sameDevice = async (req: Request, device: ChartDevicePublic): Promise<boolean> => {
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
            if (Object.keys(req.query).length) throw new WakeKeeperError('invalid');
            const device = res.locals.wakeDevice as ChartDevicePublic,
                result = await options.keeper.status(device);
            if (!(await sameDevice(req, device))) throw new WakeKeeperError('binding');
            return res.json(result);
        } catch (error) {
            return failure(res, error);
        }
    });
    router.get('/sensors', async (req, res) => {
        try {
            if (Object.keys(req.query).some((k) => k !== 'draftM')) throw new WakeKeeperError('invalid');
            let draftM: number | undefined;
            if (req.query.draftM !== undefined) {
                if (typeof req.query.draftM !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(req.query.draftM))
                    throw new WakeKeeperError('invalid');
                draftM = Number(req.query.draftM);
                if (!Number.isFinite(draftM) || draftM <= 0 || draftM > 20) throw new WakeKeeperError('invalid');
            }
            const device = res.locals.wakeDevice as ChartDevicePublic,
                result = await options.keeper.sensors(device, draftM);
            if (!(await sameDevice(req, device))) throw new WakeKeeperError('binding');
            return res.json(result);
        } catch (error) {
            return failure(res, error);
        }
    });
    router.post('/configuration', async (req, res) => {
        try {
            if (Object.keys(req.query).length || !rawChecked.has(req)) throw new WakeKeeperError('invalid');
            return res.json({
                schema: 1,
                configuration: await options.keeper.configure(req.body, res.locals.wakeDevice),
            });
        } catch (error) {
            return failure(res, error);
        }
    });
    router.delete('/configuration', async (req, res) => {
        try {
            if (Object.keys(req.query).length || !rawChecked.has(req)) throw new WakeKeeperError('invalid');
            await options.keeper.clear(req.body, res.locals.wakeDevice);
            return res.json({ schema: 1, cleared: true });
        } catch (error) {
            return failure(res, error);
        }
    });
    router.use(((error, _req, res, _next) => {
        const status = (error as { status?: number })?.status;
        if (status === 413)
            return res.status(413).json({ code: 'wake-body-too-large', error: 'Wake rules must fit within 16 KiB.' });
        return failure(res, new WakeKeeperError('invalid'));
    }) as ErrorRequestHandler);
    return router;
}
