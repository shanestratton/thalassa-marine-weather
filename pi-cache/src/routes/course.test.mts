import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { EncDeviceStore, type BoatLanView } from '../encDevices.js';
import { CourseOwnershipFile } from '../courseOwnership.js';
import { createSignalKClient } from '../signalKClient.js';
import { coursePilotState, createCourseRoutes } from './course.js';

const view: BoatLanView = {
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
};
const emptyCourse = () => ({
    startTime: null as string | null,
    activeRoute: null as { href: string } | null,
    nextPoint: null,
    previousPoint: null,
});
const route = {
    key: 'fictional-follow-a',
    name: 'Fictional dateline route',
    points: [
        { lat: 30, lon: 179.9 },
        { lat: 30.1, lon: -179.8 },
    ],
};
async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-course-http-'));
    t.after(async () => {
        assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'thalassa-course-http-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const devices = new EncDeviceStore(path.join(root, 'enc-devices.json'));
    const enrol = async () => {
        const code = await devices.mintCode();
        return devices.enrol(code.code, 'Fictional phone', '192.168.1.22');
    };
    const enrolled = await enrol();
    const data = {
        enabled: true,
        current: emptyCourse(),
        resources: new Map<string, unknown>(),
        requests: [] as string[],
        loseReply: false,
        removeOnSave: false,
        pilot: 'standby',
        pilotAt: Date.now(),
    };
    const upstream = express();
    upstream.use(express.json({ limit: '32kb' }));
    upstream.use((req, _res, next) => {
        assert.equal(req.headers.authorization, 'Bearer fictional-approved-token');
        data.requests.push(`${req.method} ${req.path}`);
        next();
    });
    const coursePath = '/signalk/v2/api/vessels/self/navigation/course';
    const routePath = '/signalk/v2/api/resources/routes/:id';
    upstream.get('/signalk/v1/api/vessels/self', (_req, res) =>
        res.json({
            steering: {
                autopilot: {
                    state: { value: data.pilot, timestamp: new Date(data.pilotAt).toISOString() },
                },
            },
        }),
    );
    upstream.get(coursePath, (_req, res) => res.json(data.current));
    upstream.put(routePath, async (req, res) => {
        data.resources.set(req.params.id, req.body);
        if (data.removeOnSave) await devices.remove(enrolled.deviceId);
        res.json({});
    });
    upstream.get(routePath, (req, res) => res.json(data.resources.get(req.params.id)));
    upstream.put(`${coursePath}/activeRoute`, (req, res) => {
        data.current = { ...emptyCourse(), startTime: new Date().toISOString(), activeRoute: req.body };
        if (data.loseReply) {
            req.socket.destroy();
            return;
        }
        res.json({});
    });
    upstream.delete(coursePath, (_req, res) => {
        data.current = emptyCourse();
        res.json({});
    });
    const provider = upstream.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => provider.once('listening', resolve));
    t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
    const client = createSignalKClient({
        origin: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
        accessToken: 'fictional-approved-token',
    });
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use(
        '/api/course',
        createCourseRoutes({
            devices,
            enabled: () => data.enabled,
            store: new CourseOwnershipFile(root, 'fictional-pi'),
            transport: { requestCourse: async (request) => (await client.requestCourse(request)).body },
            pilotState: async () => coursePilotState((await client.getSelf()).body),
            lanView: () => view,
            peerOf: (req) => req.headers['test-peer'] as string | undefined,
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/course`;
    const call = async (
        action: string,
        body?: unknown,
        token: string | null = enrolled.token,
        peer = '192.168.1.22',
    ) => {
        const response = await fetch(`${base}/${action}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                'content-type': 'application/json',
                'test-peer': peer,
                ...(token ? { 'X-Thalassa-Chart-Device': token } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const activate = async () => {
        const preview = await call('preview', { route });
        assert.equal(preview.status, 200);
        return call('activate', { ...preview.body, pilotInStandby: true, replaceExisting: true });
    };
    return { call, activate, data, devices, enrolled, enrol, root };
}

test('course door requires enrolled boat-Wi-Fi peers even with no legacy lock', async (t) => {
    const h = await fixture(t);
    for (const [action, body] of [
        ['capability', undefined],
        ['preview', { route }],
        ['activate', {}],
        ['clear', { routeKey: route.key }],
    ] as const) {
        const missing = await h.call(action, body, null);
        assert.equal(missing.status, 401);
        assert.equal(missing.headers.get('cache-control'), 'no-store');
        for (const peer of ['100.76.1.2', '192.168.1.1', '127.0.0.1'])
            assert.equal((await h.call(action, body, h.enrolled.token, peer)).status, 403);
    }
    assert.deepEqual(h.data.requests, []);
    h.data.enabled = false;
    assert.equal((await h.call('capability')).body.enabled, false);
    assert.equal((await h.call('preview', { route })).status, 403);
    assert.deepEqual(h.data.requests, []);
});

test('real enrolled HTTP lane previews, saves exact geometry, persists ownership and clears that course', async (t) => {
    const h = await fixture(t);
    const preview = await h.call('preview', { route, origin: 'https://ignored.invalid', accessToken: 'ignored' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.pilotState, 'standby');
    assert.equal(
        h.data.requests.some((r) => r.startsWith('PUT')),
        false,
    );
    const sent = await h.call('activate', { ...preview.body, pilotInStandby: true, replaceExisting: false });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.active, true);
    const resource = h.data.resources.get(sent.body.resourceId) as {
        feature: { geometry: { coordinates: number[][] } };
    };
    assert.deepEqual(resource.feature.geometry.coordinates, [
        [179.9, 30],
        [-179.8, 30.1],
    ]);
    assert.equal(new CourseOwnershipFile(h.root, 'fictional-pi').read()[0].phase, 'active');
    const other = await h.enrol();
    assert.equal((await h.call('clear', { routeKey: route.key }, other.token)).body.cleared, false);
    assert.equal((await h.call('clear', { routeKey: route.key })).body.cleared, true);
    assert.equal(h.data.current.activeRoute, null);
    assert.equal(
        h.data.requests.some((r) => /autopilot|configuration/.test(r)),
        false,
    );
});

test('actual lost activation reply retains ownership for a later clear, without a repeated activation', async (t) => {
    const h = await fixture(t);
    h.data.loseReply = true;
    const sent = await h.activate();
    assert.equal(sent.status, 409);
    assert.equal(new CourseOwnershipFile(h.root, 'fictional-pi').read()[0].phase, 'activating');
    assert.equal((await h.call('clear', { routeKey: route.key })).body.cleared, true);
    assert.equal(h.data.requests.filter((r) => r.endsWith('/activeRoute')).length, 1);
});

test('enrollment removed during exact route save blocks course activation at the HTTP boundary', async (t) => {
    const h = await fixture(t);
    h.data.removeOnSave = true;
    assert.equal((await h.activate()).status, 409);
    assert.equal(
        h.data.requests.some((r) => r.endsWith('/activeRoute')),
        false,
    );
    assert.equal((await h.call('capability')).status, 401);
});

test('fresh reported engaged pilot blocks writes despite the phone checkbox', async (t) => {
    const h = await fixture(t);
    h.data.pilot = 'route';
    assert.equal((await h.activate()).status, 409);
    assert.equal(
        h.data.requests.some((r) => r.startsWith('PUT')),
        false,
    );
});

test('pilot state is unknown without its own valid fresh clock; every reported active mode is guarded', () => {
    const now = Date.now();
    const doc = (value: string, age: number) => ({
        steering: {
            autopilot: {
                state: {
                    value,
                    timestamp: new Date(now - age).toISOString(),
                },
            },
        },
    });
    assert.equal(coursePilotState(doc('standby', 0), now), 'standby');
    for (const state of ['auto', 'alarm', 'noDrift', 'wind', 'depthContour', 'route', 'directControl'])
        assert.equal(coursePilotState(doc(state, 0), now), 'engaged');
    for (const age of [13_001, -2_001]) assert.equal(coursePilotState(doc('standby', age), now), 'unknown');
    assert.equal(
        coursePilotState(
            { steering: { timestamp: new Date(now).toISOString(), autopilot: { state: { value: 'standby' } } } },
            now,
        ),
        'unknown',
    );
});
