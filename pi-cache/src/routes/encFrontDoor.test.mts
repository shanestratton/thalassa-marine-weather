/**
 * The front door to the boat's charts (127-C-d decision 4), over real HTTP
 * through a real express app. The router stack itself is enumerated, never a
 * list of the routes someone remembered: every route answers no-store (4xx
 * and 5xx included), every route but enrol and status answers 401 without a
 * token, and every route answers 403 to a tailnet peer. Then what passes the
 * door: the signed index with a licence per cell, a cell streamed from the
 * vault and signed over the vault's hash, a cut stream that destroys the
 * socket, routing that says it runs on the phone, and DELETE.
 *
 * The vault is a stub here (vaultIndex/noPlaintext test the real one). The
 * peer comes from a test-only header the harness reads in place of the socket
 * (the real reading is in encDevices.test.mts).
 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Router } from 'express';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity, type PiIdentity } from '../identity.js';
import { EncDeviceStore, type BoatLanView } from '../encDevices.js';
import { publishChartDelivery } from '../encChartStore.js';
import { VaultUnavailableError, type VaultClient } from '../vaultClient.js';
import type { VaultCellMeta } from '../vault/protocol.js';
import { createEncRoutes } from './enc.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
        tailscale0: [
            {
                address: '100.86.90.84',
                netmask: '255.255.255.255',
                family: 'IPv4',
                internal: false,
                mac: '',
                cidr: '100.86.90.84/32',
            },
        ],
    },
    gateways: ['192.168.1.1'],
};

const CELL_BYTES = Buffer.from(JSON.stringify({ cells: [{ cellId: 'OC-99-ZZ0001', edition: 1, layers: {} }] }));
const CELL_SHA = createHash('sha256').update(CELL_BYTES).digest('hex');
const vaultCell: VaultCellMeta = {
    cellId: 'OC-99-ZZ0001',
    sourceCellId: 'ZZ5KESTR',
    sourceHO: 'ZZ',
    edition: 1,
    updateNumber: 0,
    issued: '2026-09-20',
    bbox: [-1.4, 50.7, -1.2, 50.8],
    featureCount: 2,
    sizeBytes: CELL_BYTES.length,
    contentSha256: CELL_SHA,
    installedAt: '2026-10-13T02:00:00.000Z',
    source: 'pi-decrypt',
    licence: 'protected',
};

function stubVault(overrides: Partial<VaultClient> = {}) {
    const calls: string[] = [];
    const vault: VaultClient = {
        status: async () => ({
            v: 1,
            state: 'ready',
            cells: 1,
            opened: 1,
            toOpen: 0,
            lruBytes: 0,
            lruCells: 0,
            waiting: 0,
            watching: false,
            rescanPending: false,
            decoder: 'up',
            skippedSets: [],
        }),
        index: async () => [vaultCell],
        openCell: async (cellId) => {
            calls.push(`open ${cellId}`);
            if (cellId !== vaultCell.cellId) throw new VaultUnavailableError('cell-not-found', 404);
            return { sha256: CELL_SHA, size: CELL_BYTES.length, stream: Readable.from([CELL_BYTES]) };
        },
        rescan: async () => ({ queued: false, summary: { new: 0, updated: 0, unchanged: 0, total: 0 } }),
        remove: async (cellId) => {
            calls.push(`remove ${cellId}`);
            return cellId === vaultCell.cellId;
        },
        hint: async () => {},
        ...overrides,
    };
    return { vault, calls };
}

async function harness(t: TestContext, vault: VaultClient = stubVault().vault) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-front-door-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const identity = loadOrCreateIdentity(path.join(root, 'identity'), 'Kestrel');
    const devices = new EncDeviceStore(path.join(root, 'cache', 'enc-devices.json'));
    const chartStoreDir = path.join(root, 'enc-charts');
    const router = createEncRoutes(identity, {
        vault,
        devices,
        chartStoreDir,
        lanView: () => view,
        peerOf: (req) => (req.headers['x-test-peer'] as string | undefined) ?? '192.168.1.23',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/enc', router);
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/enc`;
    const enrol = async (label = 'iPhone') => {
        const { code } = await devices.mintCode();
        const res = await fetch(`${base}/devices/enrol`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, label }),
        });
        assert.equal(res.status, 200);
        return (await res.json()) as { deviceId: string; token: string };
    };
    return { root, base, port, router, identity, devices, chartStoreDir, enrol };
}

/** Every route the router serves, from its own stack: [method, concrete path]. */
function routesOf(router: Router): [string, string][] {
    const out: [string, string][] = [];
    for (const layer of router.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[]) {
        if (!layer.route) continue;
        const concrete = layer.route.path.replace(/:cellId/g, 'OC-99-ZZ0001').replace(/:id/g, 'no-such-id');
        for (const method of Object.keys(layer.route.methods)) out.push([method.toUpperCase(), concrete]);
    }
    return out;
}

const UNTOKENED = new Set(['POST /devices/enrol', 'GET /devices/status']);

async function call(base: string, method: string, route: string, headers: Record<string, string> = {}) {
    const body = method === 'POST' ? JSON.stringify({}) : undefined;
    return fetch(`${base}${route}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body,
    });
}

test('every route in the router stack answers no-store, 401 without a token and 403 off the boat Wi-Fi', async (t) => {
    const h = await harness(t);
    const routes = routesOf(h.router);
    assert.ok(routes.length >= 19, `the stack is the real one (${routes.length} routes)`);
    for (const required of ['GET /installed', 'GET /installed/OC-99-ZZ0001/data', 'GET /health', 'GET /ocharts/setup'])
        assert.ok(
            routes.some(([m, p]) => `${m} ${p}` === required),
            required,
        );
    const { token } = await h.enrol();
    for (const [method, route] of routes) {
        const name = `${method} ${route.replace('OC-99-ZZ0001', ':cellId').replace('no-such-id', ':id')}`;
        const bare = await call(h.base, method, route);
        assert.equal(bare.headers.get('cache-control'), 'no-store', `${name} no-store`);
        assert.equal(bare.headers.get('pragma'), 'no-cache', `${name} pragma`);
        if (UNTOKENED.has(name)) assert.notEqual(bare.status, 401, name);
        else {
            assert.equal(bare.status, 401, name);
            assert.equal(((await bare.json()) as { code?: string }).code, 'chart-device-not-enrolled', name);
        }
        const tailnet = await call(h.base, method, route, {
            'X-Thalassa-Chart-Device': token,
            'x-test-peer': '100.101.102.103',
        });
        assert.equal(tailnet.status, 403, `${name} from the tailnet`);
        assert.equal(tailnet.headers.get('cache-control'), 'no-store');
        assert.equal(((await tailnet.json()) as { code?: string }).code, 'charts-boat-wifi-only');
        const router = await call(h.base, method, route, {
            'X-Thalassa-Chart-Device': token,
            'x-test-peer': '192.168.1.1',
        });
        assert.equal(router.status, 403, `${name} through the router`);
    }
    // A path the router does not serve, and a 5xx, are no-store too.
    const missing = await call(h.base, 'GET', '/no-such-route', { 'X-Thalassa-Chart-Device': token });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    const routing = await call(h.base, 'POST', '/route', { 'X-Thalassa-Chart-Device': token });
    assert.equal(routing.status, 503);
    assert.equal(routing.headers.get('cache-control'), 'no-store');
});

async function verifyAsTheApp(
    identity: PiIdentity,
    body: string,
    pathName: string,
    headers: Headers,
): Promise<boolean> {
    // services/PiPairingService.ts verifySignedResponse: sha256(body) hex, then
    // ECDSA P-256 over 'payload|<hash>|<path>|<time>' against the pinned SPKI.
    const signature = headers.get('x-pi-signature');
    const time = headers.get('x-pi-signature-time');
    if (!signature || !time) return false;
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const bodyHash = Buffer.from(digest).toString('hex');
    const key = await webcrypto.subtle.importKey(
        'spki',
        Buffer.from(identity.publicKeySpki, 'base64'),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
    );
    return webcrypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        Buffer.from(signature, 'base64'),
        new TextEncoder().encode(['payload', bodyHash, pathName, time].join('|')),
    );
}

test('the app verifier this test mirrors still signs payload|hash|path|time', async () => {
    const app = await fs.readFile(path.join(REPO, 'services', 'PiPairingService.ts'), 'utf8');
    assert.match(app, /\['payload', bodyHash, path, time\]/);
    assert.match(app, /fields\.join\('\|'\)/);
});

test('/installed lists the vault cells and the open ones, a licence on each, signed', async (t) => {
    const h = await harness(t);
    // A NOAA cell in the open store (public domain), beside the vault's protected one.
    const staged = path.join(h.root, 'US5ZZ01M.json');
    const open = JSON.stringify({ cells: [{ cellId: 'US5ZZ01M', layers: {} }] });
    await fs.writeFile(staged, open);
    await publishChartDelivery(path.join(h.chartStoreDir, 'open'), [
        {
            filename: staged,
            meta: {
                cellId: 'US5ZZ01M',
                sourceHO: 'US',
                edition: 1,
                issued: '2026-09-01',
                bbox: [-70.1, 41.1, -70, 41.2],
                featureCount: 0,
                sizeBytes: open.length,
                installedAt: '2026-10-13T00:00:00.000Z',
                source: 'url',
            },
        },
    ]);
    const { token } = await h.enrol();
    const res = await fetch(`${h.base}/installed`, { headers: { 'X-Thalassa-Chart-Device': token } });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text) as { cells: { cellId: string; licence: string; source: string }[] };
    assert.deepEqual(body.cells.map((c) => [c.cellId, c.licence]).sort(), [
        ['OC-99-ZZ0001', 'protected'],
        ['US5ZZ01M', 'open'],
    ]);
    assert.equal(await verifyAsTheApp(h.identity, text, '/api/enc/installed', res.headers), true);
});

test('a vault cell streams through, signed over the vault’s own hash', async (t) => {
    const h = await harness(t);
    const { token } = await h.enrol();
    const res = await fetch(`${h.base}/installed/OC-99-ZZ0001/data`, { headers: { 'X-Thalassa-Chart-Device': token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    assert.equal(text, CELL_BYTES.toString('utf8'));
    assert.equal(await verifyAsTheApp(h.identity, text, '/api/enc/installed/OC-99-ZZ0001/data', res.headers), true);
    // The phone's revision check: the body is exactly the indexed revision.
    assert.equal(createHash('sha256').update(text).digest('hex'), vaultCell.contentSha256);
});

test('a vault stream cut mid-way destroys the client socket', async (t) => {
    const cut = stubVault({
        openCell: async () => {
            const stream = new Readable({ read() {} });
            stream.push(CELL_BYTES.subarray(0, 10));
            setTimeout(() => stream.destroy(new Error('vault went away')), 20);
            return { sha256: CELL_SHA, size: CELL_BYTES.length, stream };
        },
    });
    const h = await harness(t, cut.vault);
    const { token } = await h.enrol();
    const outcome = await new Promise<string>((resolve) => {
        const req = http.get(
            {
                port: h.port,
                path: '/api/enc/installed/OC-99-ZZ0001/data',
                headers: { 'X-Thalassa-Chart-Device': token },
            },
            (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve(res.complete ? 'complete' : 'incomplete'));
                res.on('aborted', () => resolve('aborted'));
                res.on('error', () => resolve('error'));
            },
        );
        req.on('error', () => resolve('socket error'));
    });
    assert.notEqual(outcome, 'complete');
});

test('the vault’s refusals reach the phone as their codes, with Retry-After where it helps', async (t) => {
    for (const code of ['vault-starting', 'vault-busy', 'vault-decoder-down'] as const) {
        const busy = stubVault({
            openCell: async () => {
                throw new VaultUnavailableError(code, 503, 30);
            },
            index: async () => {
                throw new VaultUnavailableError(code, 503, 30);
            },
        });
        const h = await harness(t, busy.vault);
        const { token } = await h.enrol();
        for (const route of ['/installed', '/installed/OC-99-ZZ0001/data']) {
            const res = await fetch(`${h.base}${route}`, { headers: { 'X-Thalassa-Chart-Device': token } });
            assert.equal(res.status, 503, `${code} ${route}`);
            assert.equal(res.headers.get('retry-after'), '30');
            assert.equal(((await res.json()) as { code?: string }).code, code);
        }
    }
});

test('routing runs on the phone: /route and /route-prepped answer 503 routing-on-phone', async (t) => {
    const h = await harness(t);
    const { token } = await h.enrol();
    for (const route of ['/route', '/route-prepped']) {
        const res = await fetch(`${h.base}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Thalassa-Chart-Device': token },
            body: JSON.stringify({ fromLat: 50.76, fromLon: -1.3, toLat: 50.78, toLon: -1.28, draftM: 1.8 }),
        });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), {
            code: 'routing-on-phone',
            error: 'Routing runs on your phone in this build.',
        });
    }
});

test('DELETE: a protected cell goes to the vault, an open one loses its blobs', async (t) => {
    const s = stubVault();
    const h = await harness(t, s.vault);
    const { token } = await h.enrol();
    const del = (id: string) =>
        fetch(`${h.base}/installed/${id}`, { method: 'DELETE', headers: { 'X-Thalassa-Chart-Device': token } });
    assert.equal((await del('OC-99-ZZ0001')).status, 200);
    assert.ok(s.calls.includes('remove OC-99-ZZ0001'));
    const staged = path.join(h.root, 'open.json');
    await fs.writeFile(staged, '{"cells":[{"cellId":"US5ZZ02M"}]}');
    const openDir = path.join(h.chartStoreDir, 'open');
    await publishChartDelivery(openDir, [
        {
            filename: staged,
            meta: {
                cellId: 'US5ZZ02M',
                sourceHO: 'US',
                edition: 1,
                issued: '2026-09-01',
                bbox: [-70.1, 41.1, -70, 41.2],
                featureCount: 0,
                sizeBytes: 33,
                installedAt: '2026-10-13T00:00:00.000Z',
                source: 'url',
            },
        },
    ]);
    assert.equal((await fs.readdir(path.join(openDir, 'cells'))).length, 1);
    assert.equal((await del('US5ZZ02M')).status, 200);
    assert.deepEqual(await fs.readdir(path.join(openDir, 'cells')), []);
    assert.equal((await del('OC-99-ZZ0404')).status, 404);
});

test('devices: enrol, list, a code for another, remove, and the sixth', async (t) => {
    const h = await harness(t);
    const first = await h.enrol('iPhone');
    const auth = { 'X-Thalassa-Chart-Device': first.token };
    const status = (await (await fetch(`${h.base}/devices/status`, { headers: auth })).json()) as Record<
        string,
        unknown
    >;
    assert.equal(status.enrolled, true);
    assert.equal(status.cells, 1);
    assert.equal(status.vault, 'ready');
    assert.equal(status.seenAs, 'boat-wifi');
    const minted = (await (await fetch(`${h.base}/devices/code`, { method: 'POST', headers: auth })).json()) as {
        code: string;
        expiresAt: string;
    };
    assert.match(minted.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    const second = await fetch(`${h.base}/devices/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: minted.code, label: 'iPad' }),
    });
    assert.equal(second.status, 200);
    const list = (await (await fetch(`${h.base}/devices`, { headers: auth })).json()) as {
        devices: { id: string; label: string }[];
        maxDevices: number;
    };
    assert.deepEqual(
        list.devices.map((d) => d.label),
        ['iPhone', 'iPad'],
    );
    assert.equal(list.maxDevices, 5);
    for (let i = 0; i < 3; i++) await h.enrol(`Tablet ${i}`);
    const { code } = await h.devices.mintCode();
    const sixth = await fetch(`${h.base}/devices/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label: 'iPhone' }),
    });
    assert.equal(sixth.status, 409);
    assert.equal(((await sixth.json()) as { code: string }).code, 'chart-device-limit');
    const removeSelf = await fetch(`${h.base}/devices/${first.deviceId}`, { method: 'DELETE', headers: auth });
    assert.equal(removeSelf.status, 200);
    const after = await fetch(`${h.base}/installed`, { headers: auth });
    assert.equal(after.status, 401);
    assert.equal(((await after.json()) as { code: string }).code, 'chart-device-removed');
    const removedStatus = (await (await fetch(`${h.base}/devices/status`, { headers: auth })).json()) as Record<
        string,
        unknown
    >;
    assert.deepEqual(removedStatus.enrolled, false);
    assert.deepEqual(removedStatus.removed, true);
});
