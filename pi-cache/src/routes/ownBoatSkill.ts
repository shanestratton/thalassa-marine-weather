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
import { OWN_BOAT_SKILL, ownBoatExact, ownBoatRecord } from '../ownBoatSkillWire.js';
import type { OwnBoatSkillKeeper } from '../ownBoatSkill/keeper.js';
/** Chart enrolment grants transport only; independent server owner proof/capability gates every private operation. */
export function createOwnBoatSkillRoutes(options: {
    keeper: Pick<
        OwnBoatSkillKeeper,
        | 'capability'
        | 'prepare'
        | 'confirm'
        | 'enable'
        | 'openRead'
        | 'read'
        | 'assertRead'
        | 'off'
        | 'controllerRetired'
    >;
    devices: Pick<EncDeviceStore, 'verify'>;
    lanView?: () => BoatLanView;
    peerOf?: (req: Request) => string | undefined;
}): Router {
    const router = Router(),
        checked = new WeakSet<Request>();
    const fail = (res: express.Response) =>
        res.status(409).json({
            code: 'own-skill-held',
            error: 'Review private scorecard access; the owner, boat, controller, source, clock or storage could not be confirmed.',
        });
    const retired = (device: ChartDevicePublic) =>
        options.keeper.controllerRetired(device.id, wakeEnrollmentRevision(device));
    const same = async (req: Request, device: ChartDevicePublic) => {
        const token = req.headers[CHART_DEVICE_HEADER],
            v = await options.devices.verify(typeof token === 'string' ? token : undefined);
        return (
            v.state === 'enrolled' &&
            v.device.id === device.id &&
            wakeEnrollmentRevision(v.device) === wakeEnrollmentRevision(device)
        );
    };
    const jwt = (req: Request): string | null => {
        const v = req.headers.authorization;
        return typeof v === 'string' && v.startsWith('Bearer ') && v.length <= 12 * 1024 + 7 ? v.slice(7) : null;
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
                return res.status(403).json({ code: 'own-skill-boat-wifi-only' });
            const token = req.headers[CHART_DEVICE_HEADER],
                v = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (v.state !== 'enrolled') return res.status(401).json({ code: 'own-skill-device-not-enrolled' });
            res.locals.skillDevice = v.device;
            next();
        } catch {
            return fail(res);
        }
    });
    router.use((req, res, next) => {
        if (
            (req.method === 'POST' && (req.body !== undefined || !req.is('application/json'))) ||
            Object.keys(req.query).length
        )
            return fail(res);
        next();
    });
    router.use(
        express.json({
            limit: OWN_BOAT_SKILL.requestBytes,
            inflate: false,
            strict: true,
            verify: (req) => checked.add(req as Request),
        }),
    );
    router.get('/capability', (_req, res) => res.json(options.keeper.capability()));
    router.post('/prepare', async (req, res) => {
        try {
            if (!checked.has(req)) return fail(res);
            const device = res.locals.skillDevice as ChartDevicePublic;
            const result = await options.keeper.prepare(req.body, device.id, jwt(req));
            if (!(await same(req, device))) {
                retired(device);
                return fail(res);
            }
            return res.json(result);
        } catch {
            return fail(res);
        }
    });
    router.post('/confirm', async (req, res) => {
        try {
            if (!checked.has(req)) return fail(res);
            const device = res.locals.skillDevice as ChartDevicePublic;
            const result = await options.keeper.confirm(req.body, device.id, jwt(req));
            if (!(await same(req, device))) {
                retired(device);
                return fail(res);
            }
            return res.json(result);
        } catch {
            return fail(res);
        }
    });
    router.post('/open-read', async (req, res) => {
        try {
            if (
                !checked.has(req) ||
                !ownBoatRecord(req.body) ||
                !ownBoatExact(req.body, ['schema', 'capability']) ||
                req.body.schema !== 1
            )
                return fail(res);
            const device = res.locals.skillDevice as ChartDevicePublic;
            const result = await options.keeper.openRead(req.body.capability, device.id);
            if (!(await same(req, device))) {
                retired(device);
                return fail(res);
            }
            options.keeper.assertRead(req.body.capability, device.id, result.readId);
            return res.json(result);
        } catch {
            return fail(res);
        }
    });
    router.post('/read', async (req, res) => {
        try {
            if (
                !checked.has(req) ||
                !ownBoatRecord(req.body) ||
                !ownBoatExact(req.body, ['schema', 'capability', 'readId']) ||
                req.body.schema !== 1
            )
                return fail(res);
            const device = res.locals.skillDevice as ChartDevicePublic;
            const result = await options.keeper.read(req.body.capability, device.id, req.body.readId);
            if (!(await same(req, device))) {
                retired(device);
                return fail(res);
            }
            options.keeper.assertRead(req.body.capability, device.id, req.body.readId);
            return res.json(result);
        } catch {
            return fail(res);
        }
    });
    for (const path of ['/off', '/clear', '/enable'])
        router.post(path, async (req, res) => {
            try {
                if (
                    !checked.has(req) ||
                    !ownBoatRecord(req.body) ||
                    !ownBoatExact(req.body, ['schema', 'capability']) ||
                    req.body.schema !== 1
                )
                    return fail(res);
                const device = res.locals.skillDevice as ChartDevicePublic;
                if (!(await same(req, device))) {
                    retired(device);
                    return fail(res);
                }
                if (path === '/enable') {
                    const result = await options.keeper.enable(req.body.capability, device.id);
                    if (!(await same(req, device))) {
                        retired(device);
                        return fail(res);
                    }
                    return res.json(result);
                }
                return res.json(options.keeper.off(req.body.capability, device.id, path === '/clear'));
            } catch {
                return fail(res);
            }
        });
    router.use(((error, _req, res, _next) =>
        error?.status === 413
            ? res.status(413).json({ code: 'own-skill-body-too-large' })
            : fail(res)) as ErrorRequestHandler);
    return router;
}
