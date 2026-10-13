/**
 * The Pi half of the chart-device contract, held to the app half's own words.
 * The 127 app (services/enc/piChartDevice.ts) shipped first and pins the
 * routes it calls, and their shapes, in its header comment; this test reads
 * that header and the app's own patterns, and checks Pi update 3 answers each
 * route exactly so. piChartAccessWords.ts must have words for every code the
 * Pi can refuse with.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import { EncDeviceStore, PI_CHART_ACCESS_CODES } from '../encDevices.js';
import type { VaultClient } from '../vaultClient.js';
import { createEncRoutes } from './enc.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP_DEVICE = readFileSync(path.join(REPO, 'services', 'enc', 'piChartDevice.ts'), 'utf8');
const APP_WORDS = readFileSync(path.join(REPO, 'services', 'enc', 'piChartAccessWords.ts'), 'utf8');

/** The routes in the app's header: [METHOD, /api/enc/... path, shape]. */
function headerRoutes(): [string, string, string][] {
    const header = APP_DEVICE.slice(0, APP_DEVICE.indexOf('*/'));
    const rows: [string, string, string][] = [];
    for (const m of header.matchAll(/^\s*\*\s+(GET|POST|DELETE)\s+(\/api\/enc\/\S+)\s*(.*)$/gm))
        rows.push([m[1], m[2], m[3].trim()]);
    return rows;
}

/** Field names of a `{ a, b?, c: [...] }` shape in the header, first level only. */
function fieldsOf(shape: string): { name: string; optional: boolean }[] {
    const body = shape.slice(shape.indexOf('{') + 1, shape.lastIndexOf('}'));
    let depth = 0;
    let token = '';
    const out: string[] = [];
    for (const ch of body) {
        if ('[{'.includes(ch)) depth++;
        if (']}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
            out.push(token);
            token = '';
        } else token += ch;
    }
    out.push(token);
    return out
        .map((t) => /^\s*(\w+)(\?)?/.exec(t))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ name: m[1], optional: m[2] === '?' }));
}

function appPattern(name: RegExp): RegExp {
    const found = name.exec(APP_DEVICE);
    assert.ok(found, `the app still checks ${name}`);
    return new RegExp(found[1]);
}

const vault: VaultClient = {
    status: async () => ({
        v: 1,
        state: 'ready',
        cells: 2,
        opened: 2,
        toOpen: 0,
        lruBytes: 0,
        lruCells: 0,
        waiting: 0,
        watching: false,
        rescanPending: false,
        decoder: 'up',
        skippedSets: [],
    }),
    index: async () => [],
    openCell: async () => {
        throw new Error('not used');
    },
    rescan: async () => ({ queued: false }),
    remove: async () => false,
    hint: async () => {},
};

async function harness(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-device-contract-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const devices = new EncDeviceStore(path.join(root, 'enc-devices.json'));
    const router = createEncRoutes(undefined, {
        vault,
        devices,
        chartStoreDir: path.join(root, 'enc-charts'),
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
    });
    const app = express();
    app.use(express.json());
    app.use('/api/enc', router);
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, router, devices };
}

const served = (router: Router) =>
    (router.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[])
        .filter((l) => l.route)
        .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} /api/enc${l.route!.path}`));

test('every route the app header names is in the Pi router, with its method', async (t) => {
    const h = await harness(t);
    const rows = headerRoutes();
    assert.deepEqual(
        rows.map(([m, p]) => `${m} ${p}`),
        [
            'GET /api/enc/devices/status',
            'POST /api/enc/devices/enrol',
            'GET /api/enc/devices',
            'POST /api/enc/devices/code',
            'DELETE /api/enc/devices/:id',
        ],
        'the header the app ships',
    );
    const pi = served(h.router);
    for (const [method, route] of rows) assert.ok(pi.includes(`${method} ${route}`), `${method} ${route}`);
});

test('each answer has exactly the fields the app header pins, and passes the app’s own checks', async (t) => {
    const h = await harness(t);
    const shape = Object.fromEntries(headerRoutes().map(([m, p, s]) => [`${m} ${p}`, s]));
    const keysAllowed = (key: string, extra: string[] = []) => [...fieldsOf(shape[key]).map((f) => f.name), ...extra];
    const required = (key: string) =>
        fieldsOf(shape[key])
            .filter((f) => !f.optional)
            .map((f) => f.name);

    // Not set up yet: untokened, 200. `seenAs` is the plan's one addition (Risks:
    // "seen as: boat Wi-Fi / router / tailnet"), which the app ignores.
    const before = (await (await fetch(`${h.origin}/api/enc/devices/status`)).json()) as Record<string, unknown>;
    assert.equal(before.enrolled, false);
    for (const k of Object.keys(before))
        assert.ok(keysAllowed('GET /api/enc/devices/status', ['seenAs']).includes(k), k);

    const { code } = await h.devices.mintCode();
    const enrol = await fetch(`${h.origin}/api/enc/devices/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label: 'iPhone' }),
    });
    const enrolled = (await enrol.json()) as Record<string, unknown>;
    // POST /enrol's shape is "{ code, label } -> { deviceId, token }".
    assert.deepEqual(Object.keys(enrolled).sort(), ['deviceId', 'token']);
    assert.match(
        String(enrolled.deviceId),
        appPattern(/typeof deviceId !== 'string' \|\|\s*!\/(.+?)\/\.test\(deviceId\)/),
    );
    assert.match(String(enrolled.token), appPattern(/typeof token !== 'string' \|\|\s*!\/(.+?)\/\.test\(token\)/));
    const auth = { 'X-Thalassa-Chart-Device': String(enrolled.token) };

    const status = (await (await fetch(`${h.origin}/api/enc/devices/status`, { headers: auth })).json()) as Record<
        string,
        unknown
    >;
    for (const k of required('GET /api/enc/devices/status')) assert.ok(k in status, k);
    for (const k of Object.keys(status))
        assert.ok(keysAllowed('GET /api/enc/devices/status', ['seenAs']).includes(k), k);
    assert.equal(status.enrolled, true);
    assert.equal(status.cells, 2);
    assert.match(
        String(status.vault),
        /^(ready|starting|busy|decoder-down)$/,
        'the app reads starting|busy|decoder-down',
    );

    const list = (await (await fetch(`${h.origin}/api/enc/devices`, { headers: auth })).json()) as {
        devices: Record<string, unknown>[];
        maxDevices: number;
    };
    for (const k of Object.keys(list)) assert.ok(keysAllowed('GET /api/enc/devices').includes(k), k);
    const row = /devices: \[\{([^\]]*)\}\]/.exec(shape['GET /api/enc/devices'])![1];
    const rowFields = row.split(',').map((f) => f.trim().replace(/\?$/, ''));
    assert.deepEqual(Object.keys(list.devices[0]).sort(), [...rowFields].sort());
    assert.equal(list.devices[0].id, enrolled.deviceId);
    assert.ok(Number.isInteger(list.maxDevices));

    const minted = (await (
        await fetch(`${h.origin}/api/enc/devices/code`, { method: 'POST', headers: auth })
    ).json()) as Record<string, unknown>;
    for (const k of Object.keys(minted)) assert.ok(keysAllowed('POST /api/enc/devices/code').includes(k), k);
    assert.match(String(minted.code), appPattern(/return \/(\^\[0-9A-HJKMNP-TV-Z\]\{10\}\$)\/\.test\(code\)/));

    const removed = await fetch(`${h.origin}/api/enc/devices/${encodeURIComponent(String(enrolled.deviceId))}`, {
        method: 'DELETE',
        headers: auth,
    });
    assert.ok(removed.status >= 200 && removed.status < 300);
    const gone = await fetch(`${h.origin}/api/enc/devices`, { headers: auth });
    assert.equal(gone.status, 401);
    assert.equal(((await gone.json()) as { code: string }).code, 'chart-device-removed');
    const stranger = await fetch(`${h.origin}/api/enc/devices`, {
        headers: { 'X-Thalassa-Chart-Device': 'B'.repeat(43) },
    });
    assert.equal(((await stranger.json()) as { code: string }).code, 'chart-device-not-enrolled');
    assert.match(APP_DEVICE, /401 chart-device-not-enrolled or chart-device-removed/);
});

test('the app has words for every refusal the Pi can send', () => {
    const list = /CHART_ACCESS_CODES = \[([\s\S]*?)\] as const/.exec(APP_WORDS)?.[1] ?? '';
    const appCodes = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    for (const code of PI_CHART_ACCESS_CODES) assert.ok(appCodes.includes(code), code);
});
