import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';

import { createChartRoutes } from './routes/charts.js';
import { createEncRoutes } from './routes/enc.js';
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

test('HTTP workload overflow is a stable 429 with Retry-After on both lanes', async () => {
    const releaseConversion = await fillLane('conversion');
    const releaseRoute = await fillLane('route');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/charts', createChartRoutes());
    app.use('/api/enc', createEncRoutes());
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
                'x-filename': 'AU530150.000',
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

        const routeResponse = await fetch(`http://127.0.0.1:${port}/api/enc/route-prepped`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                fromLat: -27.2,
                fromLon: 153.05,
                toLat: -27.21,
                toLon: 153.06,
                draftM: 2,
                layers: {},
            }),
        });
        assert.equal(routeResponse.status, 429);
        assert.equal(routeResponse.headers.get('retry-after'), '5');
        assert.deepEqual(await routeResponse.json(), {
            error: 'route work is busy; retry shortly',
            code: PI_WORKLOAD_BUSY_CODE,
            workloadClass: 'route',
        });
    } finally {
        await releaseConversion();
        await releaseRoute();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
