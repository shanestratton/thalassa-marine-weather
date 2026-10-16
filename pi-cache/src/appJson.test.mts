import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createAppJsonParser } from './appJson.js';

for (const unsafeAdmin of [false, true]) {
    test(`mounted JSON admission retains raw watch bodies and explicit admin limit (${unsafeAdmin})`, async (t) => {
        const app = express();
        app.use(createAppJsonParser(unsafeAdmin));
        app.post('*', (req, res) => res.json({ parsed: req.body !== undefined }));
        app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) =>
            res.status((error as { status?: number }).status ?? 500).end(),
        );
        const server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        // UTF8 bytes exceed64KiB while the string's character count does not.
        const large = JSON.stringify({ note: 'é'.repeat(35_000) });
        const post = (path: string, body = large) =>
            fetch(base + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });
        for (const path of ['/ordinary', '/api/radarish', '/api/wake-rules-extra']) {
            const response = await post(path);
            assert.equal(response.status, unsafeAdmin ? 200 : 413, path);
            if (unsafeAdmin) assert.equal((await response.json()).parsed, true);
        }
        const admitted = await post('/ordinary', JSON.stringify({ note: 'é'.repeat(30_000) }));
        assert.equal(admitted.status, 200);
        assert.equal((await admitted.json()).parsed, true);
        for (const path of [
            '/api/radar',
            '/api/radar/watch',
            '/API/RADAR/watch',
            '/api/wake-rules',
            '/api/wake-rules/configuration',
        ]) {
            const response = await post(path);
            assert.equal(response.status, 200, path);
            assert.equal((await response.json()).parsed, false, 'the authenticated family must receive original bytes');
        }
    });
}
