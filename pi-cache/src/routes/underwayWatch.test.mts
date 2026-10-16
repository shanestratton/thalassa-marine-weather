import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { EncDeviceStore } from '../encDevices.js';
import { PiUnderwayWatch } from '../underwayWatch.js';
import { createUnderwayWatchRoutes } from './underwayWatch.js';
import { UNDERWAY_DEFAULTS } from '../lookaheadShared/services/underway/underwayRule.js';

test('route mutations need enrolment even in observe mode; stand-down is conditional on its route', async (t) => {
    const watch = new PiUnderwayWatch({ self: async () => null, atAnchor: () => false, vault: {} });
    t.after(() => watch.close());
    const devices = {
        verify: async (token: unknown) => ({ state: token === 'enrolled' ? 'enrolled' : 'not-enrolled' }),
    } as unknown as EncDeviceStore;
    const app = express();
    app.use(express.json());
    app.use('/watch', createUnderwayWatchRoutes(watch, devices));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/watch`;
    const request = (data: unknown, enrolled = false) =>
        fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(enrolled ? { 'X-Thalassa-Chart-Device': 'enrolled' } : {}),
            },
            body: JSON.stringify(data),
        });
    const configuration = {
        key: 'route-A',
        route: [
            { lat: 30, lon: -150 },
            { lat: 31, lon: -150 },
        ],
        draftM: 2,
        ukcM: 0.5,
        prefs: UNDERWAY_DEFAULTS,
    };
    assert.equal((await request({ armed: true, configuration })).status, 401);
    assert.equal(watch.describe().armed, false);
    assert.equal((await request({ armed: true, configuration }, true)).status, 200);
    assert.equal((await fetch(url)).status, 200, 'watch state stays readable');
    const ack = (routeKey?: string) =>
        fetch(`${url}/ack`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-Thalassa-Chart-Device': 'enrolled' },
            body: JSON.stringify({ key: 'off-route:route-A', routeKey }),
        });
    assert.equal((await ack()).status, 409, 'acknowledgement requires route ownership');
    assert.equal((await ack('route-B')).status, 409, 'a different phone route cannot acknowledge');
    assert.equal((await ack('route-A')).status, 200);
    assert.equal((await request({ armed: false, routeKey: 'route-A' })).status, 401);
    assert.equal(watch.describe().armed, true);
    assert.equal((await request({ armed: false, routeKey: 'route-B' }, true)).status, 409);
    assert.equal(watch.describe().armed, true);
    assert.equal((await request({ armed: false }, true)).status, 409);
    assert.equal(watch.describe().armed, true);
    assert.equal((await request({ armed: false, routeKey: 'route-A' }, true)).status, 200);
    assert.equal(watch.describe().armed, false);
    assert.equal(
        (await request({ armed: false, routeKey: 'route-A' }, true)).status,
        200,
        'conditional retry is idempotent',
    );
});
