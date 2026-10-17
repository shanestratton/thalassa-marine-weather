import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CabinAccess, CABIN_VIEWER_HEADER } from './access.js';
import { createCabinApp, refuseCabinViewerOnMainApi } from './server.js';
import { cabinSnapshot } from './snapshot.js';
import { parseCabinSnapshot } from './wire.js';
import type { LanTelemetryPayload } from '../lanTelemetry.js';
const now = 1_792_000_000_000;
const payload = (): LanTelemetryPayload => ({
    available: true,
    telemetry: {
        reported_at: new Date(now - 2_000).toISOString(),
        heading_deg: 82,
        pressure_hpa: 1012,
        depth_m: 4.8,
        sog_kts: 5.3,
        tws_kts: 17,
        private_secret: 'never',
    },
    ais: [],
    served_at: new Date(now).toISOString(),
});
test('real dedicated HTTP listener exposes only paired read projection; every command/enrol route is absent', async (t) => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-test-'));
    t.after(() => fs.rmSync(assets, { recursive: true, force: true }));
    fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>Cabin</title>');
    let generation = 0,
        reads = 0,
        resolveRead: ((v: LanTelemetryPayload) => void) | null = null;
    const access = new CabinAccess({
        now: () => now,
        context: () => `ownerA:${generation}`,
        code: () => ({
            schema: 1,
            nonce: 'a'.repeat(32),
            codeHash: createHash('sha256').update('12345678').digest('hex'),
            issuedAt: now,
            expiresAt: now + 600_000,
        }),
    });
    const app = createCabinApp({
        access,
        assets,
        now: () => now,
        peerAllowed: () => true,
        read: () => {
            reads++;
            return resolveRead === null
                ? Promise.resolve(payload())
                : new Promise((resolve) => {
                      resolveRead = resolve;
                  });
        },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(base + '/api/telemetry')).status, 401);
    assert.equal(reads, 0);
    assert.equal(
        (
            await fetch(base + '/api/cabin/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
                body: JSON.stringify({ code: '12345678' }),
            })
        ).status,
        403,
    );
    const pair = await fetch(base + '/api/cabin/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '12345678' }),
    });
    assert.equal(pair.status, 200);
    const { token } = (await pair.json()) as { token: string };
    const headers = { [CABIN_VIEWER_HEADER]: token };
    const read = await fetch(base + '/api/telemetry', { headers });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    const text = await read.text();
    assert.ok(!text.includes('private_secret'));
    const value = JSON.parse(text);
    assert.ok(parseCabinSnapshot(value));
    assert.equal(value.reportedAt, now - 2_000);
    assert.equal(value.readings.depth, 4.8);
    for (const route of [
        '/api/pair/challenge',
        '/api/enc/enrol',
        '/api/configure',
        '/api/ais-watch',
        '/api/ais-watch/ack',
        '/api/anchor/watch',
        '/api/pi-lock',
        '/api/cabin/code',
    ])
        for (const method of ['POST', 'PUT', 'DELETE'])
            assert.equal((await fetch(base + route, { method, headers })).status, 404);
    assert.equal((await fetch(base + '/api/telemetry?url=https://evil.example', { headers })).status, 400);
    resolveRead = () => {};
    const pending = fetch(base + '/api/telemetry', { headers });
    for (let n = 0; n < 50 && reads < 2; n++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(reads, 2);
    generation++;
    const finish = resolveRead;
    assert.ok(finish);
    finish(payload());
    assert.equal((await pending).status, 401);
    assert.equal((await fetch(base + '/api/telemetry', { headers })).status, 401);
    const page = await fetch(base + '/cabin/');
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy')?.includes("script-src 'self'"));
});
test('new viewer header is explicitly refused on main API; unrelated headers keep ordinary client behavior', async (t) => {
    let commands = 0;
    const app = express();
    app.use(refuseCabinViewerOnMainApi);
    app.post('/api/ais-watch', (_req, res) => {
        commands++;
        res.json({ ok: true });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ais-watch`;
    assert.equal(
        (await fetch(base, { method: 'POST', headers: { [CABIN_VIEWER_HEADER]: 'cabin-' + 'a'.repeat(64) } })).status,
        403,
    );
    assert.equal(commands, 0);
    assert.equal(
        (
            await fetch(base, {
                method: 'POST',
                headers: { 'x-thalassa-chart-device': 'ordinary-existing-token', 'x-unrelated': 'retained' },
            })
        ).status,
        200,
    );
    assert.equal(commands, 1);
});
test('stale/future/quiet telemetry is unknown rather than redated as current, and projection omits the AIS list', () => {
    for (const at of [now - 20_000, now + 6_000]) {
        const p = payload();
        p.telemetry!.reported_at = new Date(at).toISOString();
        const v = cabinSnapshot(p, now);
        assert.equal(v.reportedAt, at);
        assert.equal(v.available, false);
        assert.ok(Object.values(v.readings).every((x) => x === null));
        assert.ok(!('ais' in v));
    }
    const p = payload();
    p.available = false;
    assert.equal(cabinSnapshot(p, now).readings.heading, null);
    assert.deepEqual(cabinSnapshot(payload(), now, { running: true, dragging: true }).anchor, {
        running: true,
        dragging: true,
        sampleAt: null,
    });
    assert.deepEqual(cabinSnapshot(payload(), now, { running: false, dragging: true }).anchor, {
        running: false,
        dragging: false,
        sampleAt: null,
    });
});
