import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { EncDeviceStore } from '../encDevices.js';
import { createSignalKReadRoutes } from './signalKRead.js';

test('actual HTTP route requires app gate and current enrolment before exposing cache-only notices', async (t) => {
    let reads = 0,
        checks = 0,
        revoked = false,
        fail = false;
    const devices: Pick<EncDeviceStore, 'verify'> = {
        async verify(token) {
            checks++;
            if (fail) throw new Error('synthetic');
            return token === 'synthetic-enrolled' && !revoked
                ? {
                      state: 'enrolled',
                      device: {
                          id: 'synthetic-device',
                          label: 'Test',
                          enrolledAt: '2026-10-16T00:00:00Z',
                          lastSeenAt: '2026-10-16T00:00:00Z',
                      },
                  }
                : { state: 'unknown' };
        },
    };
    const app = express();
    app.use(
        '/api/signalk',
        (req, res, next) => {
            if (req.headers['x-app-test'] !== 'yes') return res.status(403).end();
            next();
        },
        createSignalKReadRoutes(
            {
                notificationSnapshot() {
                    reads++;
                    return {
                        schema: 1,
                        session: 'synthetic-session',
                        startedAt: 100,
                        state: 'reading',
                        servedAt: 101,
                        notices: [],
                        truncated: false,
                    };
                },
            },
            devices,
        ),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/signalk/notifications`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal(checks, 0);
    const headers = { 'x-app-test': 'yes', 'x-thalassa-chart-device': 'synthetic-enrolled' };
    assert.equal((await fetch(url, { headers: { 'x-app-test': 'yes' } })).status, 401);
    assert.equal(reads, 0);
    const good = await fetch(url, { headers });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await good.json(), {
        schema: 1,
        session: 'synthetic-session',
        startedAt: 100,
        state: 'reading',
        servedAt: 101,
        notices: [],
        truncated: false,
    });
    revoked = true;
    assert.equal((await fetch(url, { headers })).status, 401);
    assert.equal(reads, 1);
    fail = true;
    assert.equal((await fetch(url, { headers })).status, 503);
    assert.equal(reads, 1);
    assert.equal((await fetch(url + '?origin=https://example.test', { headers })).status, 400);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url, { method, headers })).status, 404);
    assert.equal(reads, 1);
});
