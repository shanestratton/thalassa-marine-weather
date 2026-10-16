import { Router, type Request } from 'express';
import {
    CHART_DEVICE_HEADER,
    classifyPeer,
    readBoatLanView,
    type BoatLanView,
    type EncDeviceStore,
} from '../encDevices.js';
import {
    createCourseWriter,
    CourseWriterError,
    type CourseOwnershipStore,
    type CourseWriterTransport,
} from '../courseWriter.js';
import { timestampAt, valueAt } from '../trackSignalk.js';

export type CoursePilotState = 'standby' | 'engaged' | 'unknown';
/** Signal K steering schema state, with its own leaf clock; receipt time is not evidence. */
export function coursePilotState(document: unknown, now = Date.now()): CoursePilotState {
    const path = 'steering.autopilot.state';
    const stamp = timestampAt(document, path, false),
        value = valueAt(document, path);
    if (stamp === null || now - stamp > 13_000 || stamp - now > 2_000) return 'unknown';
    if (value === 'standby') return 'standby';
    return ['auto', 'alarm', 'noDrift', 'wind', 'depthContour', 'route', 'directControl'].includes(String(value))
        ? 'engaged'
        : 'unknown';
}

export function createCourseRoutes(options: {
    devices: Pick<EncDeviceStore, 'verify' | 'list'>;
    transport: CourseWriterTransport;
    store: CourseOwnershipStore;
    enabled: () => boolean;
    pilotState: () => Promise<CoursePilotState>;
    lanView?: () => BoatLanView;
    peerOf?: (request: Request) => string | undefined;
}) {
    const router = Router();
    const writer = createCourseWriter({
        transport: options.transport,
        store: options.store,
        allowed: async (device) => options.enabled() && (await options.devices.list()).some((row) => row.id === device),
        pilotEngaged: async () => (await options.pilotState()) === 'engaged',
    });
    // This door is mandatory even with observe mode or no devices enrolled.
    // Proxy headers never establish physical access to the helm.
    router.use(async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        if (
            !classifyPeer(
                (options.peerOf ?? ((r) => r.socket.remoteAddress))(req),
                (options.lanView ?? readBoatLanView)(),
            ).boatLan
        )
            return res
                .status(403)
                .json({ code: 'course-boat-wifi-only', error: 'Send routes from the boat’s own Wi-Fi at the helm.' });
        try {
            const token = req.headers[CHART_DEVICE_HEADER];
            const verdict = await options.devices.verify(typeof token === 'string' ? token : undefined);
            if (verdict.state !== 'enrolled')
                return res
                    .status(401)
                    .json({
                        code: 'course-device-not-enrolled',
                        error: 'Set up this phone with the code from the boat’s Pi.',
                    });
            res.locals.courseDevice = verdict.device.id;
            next();
        } catch {
            return res
                .status(503)
                .json({ code: 'course-device-check-failed', error: 'The Pi could not check this phone.' });
        }
    });
    router.get('/capability', (_req, res) => res.json({ schema: 1, enabled: options.enabled(), exactRoute: true }));
    router.use((_req, res, next) => {
        if (!options.enabled())
            return res
                .status(403)
                .json({
                    code: 'course-writes-disabled',
                    error: 'Route sending needs approved Signal K write access on the Pi.',
                });
        next();
    });
    const failure = (res: import('express').Response, error: unknown) =>
        res.status(409).json({
            code: 'course-operation-unconfirmed',
            error:
                error instanceof CourseWriterError
                    ? error.message
                    : 'The boat could not confirm this operation. Check the plotter before trying again.',
        });
    router.post('/preview', async (req, res) => {
        try {
            const preview = await writer.preview(res.locals.courseDevice, req.body?.route);
            const pilotState = await options.pilotState();
            return res.json({ schema: 1, ...preview, pilotState });
        } catch (error) {
            return failure(res, error);
        }
    });
    router.post('/activate', async (req, res) => {
        try {
            if (
                !req.body ||
                typeof req.body !== 'object' ||
                Array.isArray(req.body) ||
                typeof req.body.token !== 'string' ||
                req.body.token.length !== 32 ||
                typeof req.body.digest !== 'string' ||
                !/^[a-f0-9]{64}$/.test(req.body.digest)
            )
                return res
                    .status(400)
                    .json({ code: 'course-confirmation-invalid', error: 'Review the followed route again.' });
            return res.json({
                schema: 1,
                ...(await writer.activate(res.locals.courseDevice, {
                    token: req.body.token,
                    digest: req.body.digest,
                    pilotInStandby: req.body.pilotInStandby === true,
                    replaceExisting: req.body.replaceExisting === true,
                })),
            });
        } catch (error) {
            return failure(res, error);
        }
    });
    router.post('/clear', async (req, res) => {
        try {
            return res.json({ schema: 1, ...(await writer.clear(res.locals.courseDevice, req.body?.routeKey)) });
        } catch (error) {
            return failure(res, error);
        }
    });
    return router;
}
