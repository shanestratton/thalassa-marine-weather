import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CABIN_VIEWER_HEADER, type CabinAccess } from './access.js';
import { cabinSnapshot } from './snapshot.js';
import type { LanTelemetryPayload } from '../lanTelemetry.js';

/** Main API recognises only this NEW credential domain, never unrelated client headers. */
export const refuseCabinViewerOnMainApi: RequestHandler = (req, res, next) => {
    if (req.headers[CABIN_VIEWER_HEADER] !== undefined)
        return res.status(403).json({ error: 'The cabin display credential can only read the cabin display.' });
    return next();
};

export function createCabinApp(options: {
    access: CabinAccess;
    assets: string;
    /** Same shared read as the existing /api/telemetry; no caller-selected destination. */
    read(): Promise<LanTelemetryPayload>;
    anchor?(): { running: boolean; dragging: boolean } | null;
    peerAllowed(address: string | undefined): boolean;
    now?: () => number;
}) {
    const app = express(),
        now = options.now ?? Date.now;
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        if (!options.peerAllowed(req.socket.remoteAddress)) return res.status(403).end();
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return res.status(403).end();
        return next();
    });
    // Nothing on this listener mounts app pairing, chart enrolment, commands,
    // watch arm/ack/stand-down, configuration, arbitrary files or any proxy.
    app.post('/api/cabin/pair', express.json({ limit: 256, strict: true }), (req, res) => {
        if (Object.keys(req.query).length || !req.body || Object.keys(req.body).join(',') !== 'code')
            return res.status(400).end();
        const session = options.access.pair(req.body.code, req.socket.remoteAddress ?? 'unknown');
        return session
            ? res.json(session)
            : res.status(401).json({ error: 'The code is unavailable, expired or not accepted.' });
    });
    app.get('/api/telemetry', async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).end();
        const lease = options.access.lease(req.headers[CABIN_VIEWER_HEADER]);
        if (!lease) return res.status(401).end();
        let retired = false;
        const retire = () => {
            retired = true;
        };
        req.once('aborted', retire);
        res.once('close', retire);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const value = await Promise.race([
                options.read(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(Error('Cabin read timed out')), 3_000);
                }),
            ]);
            const snapshot = cabinSnapshot(value, now(), options.anchor?.() ?? null),
                body = JSON.stringify(snapshot);
            if (retired || !lease.isCurrent()) return res.status(401).end();
            if (Buffer.byteLength(body) > 16_384) return res.status(503).end();
            return res.type('json').send(body);
        } catch {
            if (!retired) return res.status(503).json({ error: 'The Pi instrument mirror is unavailable.' });
        } finally {
            if (timer) clearTimeout(timer);
            req.off('aborted', retire);
            res.off('close', retire);
        }
    });
    app.get('/', (_req, res) => res.redirect('/cabin/'));
    app.get('/cabin/', (_req, res) => {
        const file = path.join(options.assets, 'index.html');
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw Error();
        } catch {
            return res.status(503).send('Cabin display is not built.');
        }
        return res.sendFile(file);
    });
    app.get('/assets/:name', (req, res) => {
        const name = req.params.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,120}\.(?:js|css)$/.test(name)) return res.status(404).end();
        const file = path.join(options.assets, 'assets', name);
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return res.status(404).end();
        } catch {
            return res.status(404).end();
        }
        return res.sendFile(file);
    });
    app.use((_req, res) => res.status(404).end());
    const invalidBody: ErrorRequestHandler = (_error, _req, res, _next) => {
        // Parser errors can contain the pairing body; never pass them to the
        // development error logger or include them in a response.
        res.status(400).json({ error: 'Cabin request not accepted.' });
    };
    app.use(invalidBody);
    return app;
}
