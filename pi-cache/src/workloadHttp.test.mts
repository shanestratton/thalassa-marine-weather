import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';

import { createChartRoutes } from './routes/charts.js';
import { createEncRoutes } from './routes/enc.js';
import { EncDeviceStore } from './encDevices.js';
import { PI_WORKLOAD_BUSY_CODE, piWorkloadGovernor, type PiWorkloadClass } from './workloadGovernor.js';

async function fillLane(workloadClass: PiWorkloadClass): Promise<() => Promise<void>> {
    const active = await piWorkloadGovernor.admit(workloadClass).lease;
    const queuedOne = piWorkloadGovernor.admit(workloadClass).lease;
    const queuedTwo = piWorkloadGovernor.admit(workloadClass).lease;
    return async () => {
        active.release();
        (await queuedOne).release();
        (await queuedTwo).release();
    };
}

test('HTTP workload overflow is a stable 429 with Retry-After on the conversion lane', async (t) => {
    // The ENC router sits behind its front door (127-C-d): an enrolled phone on the boat's Wi-Fi.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workload-http-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const devices = new EncDeviceStore(path.join(dir, 'enc-devices.json'));
    const { code } = await devices.mintCode();
    const { token } = await devices.enrol(code, 'iPhone', '192.168.1.23');
    const releaseConversion = await fillLane('conversion');
    const releaseRoute = await fillLane('route');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/charts', createChartRoutes());
    app.use(
        '/api/enc',
        createEncRoutes(undefined, {
            devices,
            chartStoreDir: path.join(dir, 'enc-charts'),
            peerOf: () => '192.168.1.23',
            lanView: () => ({
                interfaces: {
                    eth0: [
                        {
                            address: '192.168.1.180',
                            netmask: '255.255.255.0',
                            family: 'IPv4',
                            internal: false,
                            mac: '',
                            cidr: '192.168.1.180/24',
                        },
                    ],
                },
                gateways: ['192.168.1.1'],
            }),
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    try {
        const chartResponse = await fetch(`http://127.0.0.1:${port}/api/charts/download`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://charts.example.test/region.mbtiles', name: 'region.mbtiles' }),
        });
        assert.equal(chartResponse.status, 429);
        assert.equal(chartResponse.headers.get('retry-after'), '10');
        assert.deepEqual(await chartResponse.json(), {
            error: 'conversion work is busy; retry shortly',
            code: PI_WORKLOAD_BUSY_CODE,
            workloadClass: 'conversion',
        });

        const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/enc/convert`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-filename': 'US5ZZ01M.000',
                'x-thalassa-chart-device': token,
            },
            body: 'request-body-must-not-be-buffered-before-admission',
        });
        assert.equal(uploadResponse.status, 429);
        assert.equal(uploadResponse.headers.get('retry-after'), '10');
        assert.deepEqual(await uploadResponse.json(), {
            error: 'conversion work is busy; retry shortly',
            code: PI_WORKLOAD_BUSY_CODE,
            workloadClass: 'conversion',
        });

        // Routing runs on the phone since Pi update 3 (127-C-d decision 9): the
        // route lane no longer has an HTTP surface, and the answer says so
        // even while the lane is full.
        const routeResponse = await fetch(`http://127.0.0.1:${port}/api/enc/route-prepped`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-thalassa-chart-device': token },
            body: JSON.stringify({
                fromLat: 50.76,
                fromLon: -1.3,
                toLat: 50.77,
                toLon: -1.29,
                draftM: 2,
                layers: {},
            }),
        });
        assert.equal(routeResponse.status, 503);
        assert.deepEqual(await routeResponse.json(), {
            code: 'routing-on-phone',
            error: 'Routing runs on your phone in this build.',
        });
    } finally {
        await releaseConversion();
        await releaseRoute();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
