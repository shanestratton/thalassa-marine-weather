/**
 * Only her own devices can command the Pi (129-12).
 *
 * One table names every Pi route with its class, `read`, `raise` or
 * `command` (piCommandLock.ts PI_ROUTES), and one middleware reads it in
 * front of every route. These tests hold it over real HTTP through a real
 * express app:
 *
 *   - the table is complete: every route server.ts registers, and every route
 *     each router it mounts serves (enumerated from the routers' own stacks,
 *     never a list someone remembered), has a row, and every row is a route;
 *   - in enforce mode every `command` route refuses a device that is not set
 *     up, with a machine code and plain words naming the boat, and answers an
 *     enrolled one; in observe mode both are answered and the first is
 *     counted; every `raise` and `read` route answers anyone in both modes;
 *   - case, doubled and trailing slashes, URL-encoded segments, dot segments,
 *     HEAD, unknown methods and a method-override header never get a command
 *     past it; a revoked device is refused at once;
 *   - the switch: it will not turn on with no device set up, needs an
 *     enrolled device both ways and the boat's own Wi-Fi, and a Pi left with
 *     no device enrolled answers everyone again;
 *   - a watch keeps running through any refused command: the night watch and
 *     the anchor watch are still armed, and still alarm, after a refused
 *     stand-down.
 *
 * The peer comes from a test-only header (as encFrontDoor.test.mts does).
 * Everything is fictional: Ψυχή (a Greek charter yacht) and Tūī, their Pis on
 * 192.168.1.180, ships in the Solent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Router } from 'express';
import { createWakeRuleRoutes } from './routes/wakeRules.js';
import { loadOrCreateIdentity } from './identity.js';
import { EncDeviceStore, type BoatLanView } from './encDevices.js';
import {
    PI_ROUTES,
    PiInternetMemory,
    PiLockLedger,
    PiLockStore,
    canonicalPiPath,
    createPiCommandLock,
    createPiLockRoutes,
    findPiRoute,
    recoverPiLock,
    uncommandedRenewal,
    wrongShellUser,
    type PiCommandRequest,
    type PiLockMode,
    type PiRouteFacts,
    type PiRouteRule,
} from './piCommandLock.js';
import { AisNightWatch } from './aisWatch.js';
import { AIS_WATCH_MAX_DEVICES } from './aisWatchStore.js';
import { AnchorWatchRunner } from './anchorBroadcaster.js';
import { createAisWatchRoutes } from './routes/aisWatch.js';
import { createSignalKReadRoutes } from './routes/signalKRead.js';
import { createRadarRoutes } from './routes/radar.js';
import { createRadarWatchRoutes } from './routes/radarWatch.js';
import { createWeatherRoutes } from './routes/weather.js';
import { createTileRoutes } from './routes/tiles.js';
import { createGribRoutes } from './routes/grib.js';
import { createTideRoutes } from './routes/tides.js';
import { createMiscRoutes } from './routes/misc.js';
import { createChartRoutes } from './routes/charts.js';
import { createEncRoutes } from './routes/enc.js';
import { createOsmRoutes } from './routes/osm.js';
import { createPairRoutes } from './routes/pair.js';
import { createDiaryRelayRoutes } from './routes/diary.js';
import { createTrackRoutes } from './routes/track.js';
import { createSeabedRoutes } from './routes/seabed.js';
import { createRemoteAccessRoutes } from './routes/remoteAccess.js';
import type { VaultClient } from './vaultClient.js';
import { createUnderwayWatchRoutes } from './routes/underwayWatch.js';
import { createCourseRoutes } from './routes/course.js';
import { createPolarRoutes } from './routes/polars.js';
import { createOfflineWeatherRoutes } from './routes/offlineWeather.js';

const keepLoopAlive = (t: { after: (fn: () => void) => void }) => {
    const keepAlive = setInterval(() => undefined, 1_000);
    t.after(() => clearInterval(keepAlive));
};

const BOAT = 'Ψυχή';
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
const HEADER = 'X-Thalassa-Chart-Device';
const NO_WATCH: PiRouteFacts = { anchorWatch: () => null };

/** Every table row's path with each `:param` filled in, so it can be requested. */
const concrete = (route: string) => route.replace(/:[A-Za-z]+/g, 'zz-1');

interface Answer {
    status: number;
    body: Record<string, unknown>;
    headers: http.IncomingHttpHeaders;
}

/** One request with the path EXACTLY as written: fetch would normalise dot segments and case for us. */
function raw(
    port: number,
    method: string,
    rawPath: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method,
                path: rawPath,
                headers: {
                    ...(payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                        : {}),
                    ...opts.headers,
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let body: Record<string, unknown> = {};
                    try {
                        body = JSON.parse(text) as Record<string, unknown>;
                    } catch {
                        /* HEAD, or Express's own 404 page */
                    }
                    resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * The lock in front of a stand-in handler on every table route (each records
 * that it ran), the switch's own routes, and an EncDeviceStore in a temp dir.
 */
async function harness(
    t: TestContext,
    opts: { mode?: PiLockMode; facts?: PiRouteFacts; boat?: string; mount?: (app: express.Express) => void } = {},
) {
    keepLoopAlive(t);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const devices = new EncDeviceStore(path.join(root, 'enc-devices.json'));
    const store = new PiLockStore(path.join(root, 'pi-lock.json'));
    const ledger = new PiLockLedger();
    const logs: string[] = [];
    const ran: string[] = [];
    const boat = opts.boat ?? BOAT;
    const app = express();
    app.use(express.json());
    app.use(
        createPiCommandLock({
            devices,
            store,
            ledger,
            boatName: () => boat,
            facts: opts.facts ?? NO_WATCH,
            log: (line) => logs.push(line),
        }),
    );
    app.use(
        '/api/pi-lock',
        createPiLockRoutes({
            devices,
            store,
            ledger,
            boatName: () => boat,
            lanView: () => view,
            peerOf: (req) => (req.headers['x-test-peer'] as string | undefined) ?? '192.168.1.23',
        }),
    );
    opts.mount?.(app);
    for (const rule of PI_ROUTES) {
        if (rule.path === '/*' || rule.path.startsWith('/api/pi-lock')) continue;
        const method = rule.method.toLowerCase() as 'get' | 'post' | 'delete';
        app[method](rule.path, (req, res) => {
            ran.push(`${req.method} ${req.path}`);
            res.json({ ran: true, commanded: (req as PiCommandRequest).piCommand?.commanded ?? null });
        });
    }
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const port = (server.address() as AddressInfo).port;
    if (opts.mode) store.set(opts.mode);
    const enrol = async (label = 'iPhone') => {
        const { code } = await devices.mintCode();
        return devices.enrol(code, label, '192.168.1.23');
    };
    const call = (method: string, rawPath: string, o: { body?: unknown; headers?: Record<string, string> } = {}) =>
        raw(port, method, rawPath, o);
    return { root, port, devices, store, ledger, logs, ran, enrol, call, lockFile: path.join(root, 'pi-lock.json') };
}

const staticClass = (rule: PiRouteRule) => (typeof rule.class === 'string' ? rule.class : null);
const lockRules = PI_ROUTES.filter((r) => !r.door && r.path !== '/*');
const commandRules = lockRules.filter((r) => staticClass(r) === 'command');
const raiseRules = lockRules.filter((r) => staticClass(r) === 'raise');
const readRules = lockRules.filter((r) => staticClass(r) === 'read');

// ── The table is complete ─────────────────────────────────────────────────

const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const attachSource = readFileSync(new URL('./seabed/attach.ts', import.meta.url), 'utf8');

/** Every route a router serves, from its own stack: `METHOD /prefix/path`. */
function stackRoutes(prefix: string, router: Router): string[] {
    const out: string[] = [];
    for (const layer of router.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[]) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
            const sub = layer.route.path === '/' ? '' : layer.route.path;
            out.push(`${method.toUpperCase()} ${prefix}${sub}`);
        }
    }
    return out;
}

/** Each router factory server.ts (and seabed/attach.ts) mounts, built with stand-ins for what it holds. */
async function builtRouters(t: TestContext): Promise<Record<string, Router>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-routes-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const identity = loadOrCreateIdentity(path.join(root, 'identity'), BOAT);
    const devices = new EncDeviceStore(path.join(root, 'enc-devices.json'));
    const stub = {} as never;
    const watch = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: 0 }),
        atAnchor: () => false,
    });
    t.after(() => watch.close());
    return {
        createWeatherRoutes: createWeatherRoutes(stub, { supabaseUrl: '', supabaseAnonKey: '' }),
        createTileRoutes: createTileRoutes(stub, { supabaseUrl: '', supabaseAnonKey: '' }),
        createGribRoutes: createGribRoutes(stub, { supabaseUrl: '', supabaseAnonKey: '' }),
        createTideRoutes: createTideRoutes(stub, { supabaseUrl: '', supabaseAnonKey: '' }),
        createMiscRoutes: createMiscRoutes(stub, { supabaseUrl: '', supabaseAnonKey: '' }),
        createChartRoutes: createChartRoutes(),
        createEncRoutes: createEncRoutes(identity, {
            vault: {} as VaultClient,
            devices,
            chartStoreDir: path.join(root, 'enc-charts'),
        }),
        createOsmRoutes: createOsmRoutes(),
        createPairRoutes: createPairRoutes(identity),
        // A video relay, so the video routes are in the stack as they are on a Pi.
        createDiaryRelayRoutes: createDiaryRelayRoutes(stub, {} as never),
        createTrackRoutes: createTrackRoutes(stub, stub),
        createSeabedRoutes: createSeabedRoutes(stub),
        createRemoteAccessRoutes: createRemoteAccessRoutes(),
        createAisWatchRoutes: createAisWatchRoutes(watch),
        createUnderwayWatchRoutes: createUnderwayWatchRoutes(stub, devices),
        createWakeRuleRoutes: createWakeRuleRoutes({ keeper: stub, devices }),
        createRadarRoutes: createRadarRoutes(stub),
        createRadarWatchRoutes: createRadarWatchRoutes({ watch: stub, enrolled: () => null }),
        createSignalKReadRoutes: createSignalKReadRoutes(
            {
                notificationSnapshot: () => ({
                    schema: 1,
                    session: null,
                    startedAt: null,
                    state: 'stopped',
                    servedAt: 0,
                    notices: [],
                    truncated: false,
                }),
            },
            devices,
        ),
        createCourseRoutes: createCourseRoutes({
            devices,
            transport: stub,
            store: stub,
            enabled: () => false,
            pilotState: async () => 'unknown',
        }),
        createPolarRoutes: createPolarRoutes(stub),
        createOfflineWeatherRoutes: createOfflineWeatherRoutes(stub),
        createPiLockRoutes: createPiLockRoutes({
            devices,
            store: new PiLockStore(path.join(root, 'pi-lock.json')),
            ledger: new PiLockLedger(),
            boatName: () => BOAT,
        }),
    };
}

/** Every route the Pi registers: server.ts's own, and each mounted router's stack under its prefix. */
async function registeredRoutes(t: TestContext): Promise<string[]> {
    const routes: string[] = [];
    // app.get('/path', ...) and the app-hosting fallback app.get(/^\/(?!api\/)…/, ...).
    for (const m of serverSource.matchAll(
        /\bapp\.(get|post|put|patch|delete|all)\(\s*(?:'([^']+)'|(\/\^[^\n]*?\/),)/g,
    )) {
        routes.push(`${m[1].toUpperCase()} ${m[2] ?? '/*'}`);
    }
    // express.static serves files outside /api only (the same app-hosting opt-in).
    if (/app\.use\(express\.static\(/.test(serverSource)) routes.push('GET /*');
    const routers = await builtRouters(t);
    const mounts = [
        ...[...serverSource.matchAll(/\bapp\.use\(\s*'([^']+)',([\s\S]*?)\);/g)].flatMap((mount) =>
            [...mount[2].matchAll(/\b(create\w+Routes)\(/g)].map((factory) => [mount[0], mount[1], factory[1]]),
        ),
        ...attachSource.matchAll(/\bapp\.use\(\s*'([^']+)',[\s\S]*?(create\w+Routes)\(/g),
    ];
    assert.ok(mounts.length >= 15, `server.ts mounts its routers (${mounts.length} found)`);
    for (const [, prefix, factory] of mounts) {
        const router = routers[factory];
        assert.ok(router, `${factory} is mounted at ${prefix}: build it here so its routes are classified`);
        routes.push(...stackRoutes(prefix, router));
    }
    return [...new Set(routes)];
}

test('every route the Pi registers has a row in the table, and every row is a route', async (t) => {
    const registered = await registeredRoutes(t);
    const rows = new Set(PI_ROUTES.map((r) => `${r.method} ${r.path}`));
    assert.ok(registered.length >= 90, `the real routes (${registered.length})`);
    const missing = registered.filter((r) => !rows.has(r));
    assert.deepEqual(missing, [], 'a route with no row is a command; give it its class in PI_ROUTES');
    const stale = [...rows].filter((r) => !registered.includes(r));
    assert.deepEqual(stale, [], 'a row for a route that no longer exists');
    // One row per route.
    assert.equal(rows.size, PI_ROUTES.length);
    // The safety lines, each where the plan put it.
    const classOf = (key: string) => {
        const row = PI_ROUTES.find((r) => `${r.method} ${r.path}` === key)!;
        return typeof row.class === 'string' ? row.class : 'by body';
    };
    assert.equal(classOf('POST /api/ais-watch/ack'), 'raise');
    assert.equal(classOf('POST /api/ais-watch'), 'by body');
    assert.equal(classOf('POST /api/anchor/watch'), 'by body');
    assert.equal(classOf('GET /api/signalk/notifications'), 'read');
    assert.equal(classOf('GET /api/radar/targets'), 'read');
    assert.equal(classOf('GET /api/radar/watch'), 'read');
    assert.equal(classOf('POST /api/radar/watch'), 'command');
    assert.equal(classOf('POST /api/radar/watch/ack'), 'command');
    assert.equal(classOf('DELETE /api/anchor/watch'), 'command');
    // A command, but for the internet policy said again as the Pi last took it.
    assert.equal(classOf('POST /api/configure'), 'by body');
    for (const key of [
        'POST /cache/purge',
        'POST /api/remote-access/enable',
        'POST /api/remote-access/disable',
        'POST /api/diary/entries',
        'POST /api/seabed/config',
        'POST /api/track/enable',
        'POST /api/ais-watch/test',
    ])
        assert.equal(classOf(key), 'command', key);
    // The chart door keeps every /api/enc route, the switch keeps its own.
    for (const row of PI_ROUTES) {
        if (row.path.startsWith('/api/enc') || row.path.startsWith('/api/polars') || row.path.startsWith('/api/radar'))
            assert.equal(row.door, 'chart', `${row.method} ${row.path}`);
        else if (row.path === '/api/pi-lock' && row.method === 'POST') assert.equal(row.door, 'lock');
        else assert.equal(row.door, undefined, `${row.method} ${row.path}`);
    }
});

test('a route missing from the table is a command, and so is anything the lock cannot read', () => {
    assert.equal(findPiRoute('POST', '/api/not-a-route'), null);
    assert.equal(findPiRoute('GET', '/api/not-a-route'), null);
    assert.equal(findPiRoute('PUT', '/api/configure'), null);
    // Normalised before matching.
    assert.equal(findPiRoute('POST', '/API//Configure/')?.path, '/api/configure');
    assert.equal(findPiRoute('POST', '/api/%63onfigure')?.path, '/api/configure');
    assert.equal(findPiRoute('HEAD', '/api/telemetry')?.path, '/api/telemetry');
    assert.equal(findPiRoute('DELETE', '/api/diary/video/chunk/a/1'), null);
    assert.equal(canonicalPiPath('/api/%E0%A4%A'), null, 'a broken escape');
    assert.equal(canonicalPiPath('/api/a\\b'), null, 'a backslash');
    assert.equal(canonicalPiPath('/api/../configure'), null, 'a dot segment');
    assert.equal(canonicalPiPath('/api/conf%00igure'), null, 'a control character');
    assert.equal(canonicalPiPath('/API//Ais-Watch/ack/?x=1'), '/api/ais-watch/ack');
    // App hosting answers outside /api and /cache only.
    assert.equal(findPiRoute('GET', '/index.html')?.path, '/*');
    assert.equal(findPiRoute('GET', '/api/secret'), null);
    assert.equal(findPiRoute('GET', '/cache/purge'), null);
});

// ── Commands, raises and reads, in each mode ──────────────────────────────

test('enforce: every command route refuses a device not set up, in words naming the boat, and answers an enrolled one', async (t) => {
    const h = await harness(t, { mode: 'enforce' });
    const { token } = await h.enrol();
    assert.ok(commandRules.length >= 14, `the command routes (${commandRules.length})`);
    for (const rule of commandRules) {
        const name = `${rule.method} ${rule.path}`;
        const route = concrete(rule.path);
        const bare = await h.call(rule.method, route, { body: rule.method === 'POST' ? {} : undefined });
        assert.equal(bare.status, 403, name);
        assert.equal(bare.body.code, 'pi-device-not-set-up', name);
        assert.equal(bare.body.status, 'error', name);
        assert.equal(bare.body.error, "This phone isn't set up for Ψυχή's Pi. Type the code from her Pi.", name);
        assert.equal(bare.headers['cache-control'], 'no-store', name);
        const unknown = await h.call(rule.method, route, { headers: { [HEADER]: 'x'.repeat(43) } });
        assert.equal(unknown.status, 403, `${name} with a token nobody was given`);
        const enrolled = await h.call(rule.method, route, {
            body: rule.method === 'POST' ? {} : undefined,
            headers: { [HEADER]: token },
        });
        assert.equal(enrolled.status, 200, `${name} from her own device`);
        assert.equal(enrolled.body.commanded, true, name);
    }
    assert.equal(h.ran.length, commandRules.length, 'only her own device got through');
});

test('observe (the default after install): every command route answers everyone, and counts who was not set up', async (t) => {
    const h = await harness(t);
    assert.equal(h.store.mode(), 'observe');
    const { token } = await h.enrol();
    for (const rule of commandRules) {
        const name = `${rule.method} ${rule.path}`;
        const route = concrete(rule.path);
        const bare = await h.call(rule.method, route, { body: rule.method === 'POST' ? {} : undefined });
        assert.equal(bare.status, 200, name);
        assert.equal(bare.body.commanded, true, `${name}: answered as today`);
        const enrolled = await h.call(rule.method, route, { headers: { [HEADER]: token } });
        assert.equal(enrolled.status, 200, name);
    }
    const status = await h.call('GET', '/api/pi-lock');
    const seen = status.body.unenrolled as { route: string; calls: number; lastAt: string }[];
    assert.deepEqual(
        seen.map((s) => s.route).sort(),
        commandRules.map((r) => `${r.method} ${r.path}`).sort(),
        'one count per route, by its table row',
    );
    assert.ok(seen.every((s) => s.calls === 1 && !Number.isNaN(Date.parse(s.lastAt))));
    // Logged by route and time only, and not once per call.
    assert.equal(h.logs.length, commandRules.length);
    assert.ok(
        h.logs.every((line) => /^\[pi-lock\] observe: (GET|POST|DELETE) \/\S+ from a device not set up/.test(line)),
    );
    for (let i = 0; i < 5; i++) await h.call('POST', '/cache/purge', { body: {} });
    assert.equal(h.logs.length, commandRules.length, 'a burst on one route is one log line a minute');
    const again = (await h.call('GET', '/api/pi-lock')).body.unenrolled as { route: string; calls: number }[];
    assert.equal(again.find((s) => s.route === 'POST /cache/purge')?.calls, 6);
});

test('raise routes answer anyone, in both modes: arm the night watch, acknowledge an alarm, start an anchor watch', async (t) => {
    for (const mode of ['observe', 'enforce'] as const) {
        const h = await harness(t, { mode });
        // Someone is set up, so the lock is in force (with nobody, she answers everyone).
        await h.enrol();
        assert.ok(raiseRules.length >= 1);
        for (const rule of raiseRules) {
            const res = await h.call(rule.method, concrete(rule.path), {
                body: { kind: 'collision', mmsi: 211000001 },
            });
            assert.equal(res.status, 200, `${mode} ${rule.method} ${rule.path}`);
            assert.equal(res.body.commanded, mode === 'observe', 'in enforce it is answered as a raise, not a command');
        }
        const arm = await h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: {} } });
        assert.equal(arm.status, 200, `${mode}: arming for this caller`);
        const start = await h.call('POST', '/api/anchor/watch', { body: { sessionCode: 'TUI123456789' } });
        assert.equal(start.status, 200, `${mode}: starting an anchor watch when none is running`);
    }
});

test('read routes answer anyone in enforce mode: the watch state is never hidden', async (t) => {
    const h = await harness(t, { mode: 'enforce' });
    assert.ok(readRules.length >= 50, `the read routes (${readRules.length})`);
    for (const rule of readRules) {
        const res = await h.call(rule.method, concrete(rule.path), { body: rule.method === 'POST' ? {} : undefined });
        assert.equal(res.status, 200, `${rule.method} ${rule.path}`);
    }
    for (const watchState of ['/api/ais-watch', '/api/telemetry', '/api/admin/status', '/status', '/health'])
        assert.equal((await h.call('GET', watchState)).status, 200, watchState);
});

test('by body: a stand-down is a command, an arm a raise; an anchor watch is a raise only while none runs, or renewed unchanged', async (t) => {
    let running: ReturnType<PiRouteFacts['anchorWatch']> = null;
    const h = await harness(t, { mode: 'enforce', facts: { anchorWatch: () => running } });
    const { token } = await h.enrol();
    for (const body of [
        { armed: false },
        { armed: false, everyone: true },
        { armed: false, device: 'dev-ipad' },
        {},
        [],
    ]) {
        const res = await h.call('POST', '/api/ais-watch', { body });
        assert.equal(res.status, 403, `stand-down ${JSON.stringify(body)}`);
        assert.equal(res.body.code, 'pi-device-not-set-up');
    }
    assert.equal(
        (await h.call('POST', '/api/ais-watch', { body: { armed: false }, headers: { [HEADER]: token } })).status,
        200,
    );

    const watch = { sessionCode: 'TUI123456789', anchorLat: -36.84, anchorLon: 174.77, swingRadius: 40 };
    assert.equal((await h.call('POST', '/api/anchor/watch', { body: watch })).status, 200, 'none running: a raise');
    running = { ...watch };
    assert.equal(
        (await h.call('POST', '/api/anchor/watch', { body: watch })).status,
        200,
        'the hourly renewal, unchanged',
    );
    for (const moved of [
        { ...watch, anchorLat: -36.85 },
        { ...watch, anchorLon: 174.78 },
        { ...watch, swingRadius: 400 },
        { ...watch, sessionCode: 'OTHER1234567' },
        {},
    ]) {
        const res = await h.call('POST', '/api/anchor/watch', { body: moved });
        assert.equal(res.status, 403, `moving or re-centring a running watch: ${JSON.stringify(moved)}`);
    }
    assert.equal(
        (
            await h.call('POST', '/api/anchor/watch', {
                body: { ...watch, anchorLat: -36.85 },
                headers: { [HEADER]: token },
            })
        ).status,
        200,
        'her own device may move it',
    );
    assert.equal((await h.call('DELETE', '/api/anchor/watch')).status, 403);
});

test('by body: the internet policy alone, said again as the Pi last took it, is a raise; anything else in configure is a command', async (t) => {
    keepLoopAlive(t);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-internet-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const memory = new PiInternetMemory(path.join(root, 'pi-internet.json'));
    const h = await harness(t, {
        mode: 'enforce',
        facts: { anchorWatch: () => null, internetPolicy: () => memory.read() },
    });
    const { token } = await h.enrol();
    // What every phone sends when it reaches her (PiCacheService reconcileDiaryRelayInternetPolicy).
    const policy = (allow: boolean) => ({ supabaseUrl: '', supabaseAnonKey: '', diaryRelayAllowInternet: allow });
    assert.equal(memory.read(), null);
    const first = await h.call('POST', '/api/configure', { body: policy(true) });
    assert.equal(first.status, 403, 'nothing kept yet: a command');
    assert.equal(first.body.code, 'pi-device-not-set-up');
    memory.remember(true);
    assert.equal(new PiInternetMemory(path.join(root, 'pi-internet.json')).read(), true, 'kept across a restart');
    assert.equal(statSync(path.join(root, 'pi-internet.json')).mode & 0o777, 0o600);
    const again = await h.call('POST', '/api/configure', { body: policy(true) });
    assert.equal(again.status, 200, 'the same policy, said again by a phone not set up');
    assert.equal(again.body.commanded, false, 'as a raise');
    for (const body of [
        policy(false),
        { ...policy(true), diaryRelayToken: 'x'.repeat(40) },
        { ...policy(true), supabaseUrl: 'https://relay.invalid' },
        { ...policy(true), prefetchLat: 50.78, prefetchLon: -1.2 },
        { diaryRelay: { allowInternet: true } },
        { diaryRelayAllowInternet: 'true' },
        {},
    ]) {
        const res = await h.call('POST', '/api/configure', { body });
        assert.equal(res.status, 403, `a command: ${JSON.stringify(body)}`);
    }
    const own = await h.call('POST', '/api/configure', { body: policy(false), headers: { [HEADER]: token } });
    assert.equal(own.status, 200, 'her own device sets another');
    assert.equal(own.body.commanded, true);
});

// ── Normalisation ─────────────────────────────────────────────────────────

test('no spelling of a command gets past it: case, slashes, escapes, dot segments, HEAD, other methods, an override header', async (t) => {
    const h = await harness(t, { mode: 'enforce' });
    await h.enrol();
    const attempts: [string, string, Record<string, string>?][] = [
        ['POST', '/API/CONFIGURE'],
        ['POST', '/Api/Configure/'],
        ['POST', '/api/configure/'],
        ['POST', '//api/configure'],
        ['POST', '/api//configure'],
        ['POST', '/api/%63onfigure'],
        ['POST', '/api/configure%2F'],
        ['POST', '/api/./configure'],
        ['POST', '/api/ais-watch/../configure'],
        ['POST', '/api/configure?ok=1'],
        ['POST', '/api\\configure'],
        ['PUT', '/api/configure'],
        ['PATCH', '/api/configure'],
        ['POST', '/api/configure', { 'X-HTTP-Method-Override': 'GET' }],
        ['POST', '/api/configure', { 'X-Method-Override': 'GET' }],
        ['DELETE', '/API/Anchor/WATCH/'],
        ['DELETE', '/api/anchor%2Fwatch'],
        ['HEAD', '/api/anchor/watch'],
        ['POST', '/cache/purge/'],
        ['POST', '/CACHE/PURGE'],
        ['POST', '/api/Remote-Access/Enable'],
        ['POST', '/api/diary/ENTRIES'],
    ];
    for (const [method, route, headers] of attempts) {
        const res = await h.call(method, route, { body: method === 'HEAD' ? undefined : {}, headers });
        assert.equal(res.status, 403, `${method} ${route} ${JSON.stringify(headers ?? {})}`);
    }
    assert.deepEqual(h.ran, [], 'no command handler ran');
});

// ── Revoked devices ───────────────────────────────────────────────────────

test('a revoked device is refused at once, in its own words, and the device still set up is not', async (t) => {
    const h = await harness(t, { mode: 'enforce' });
    const phone = await h.enrol('iPhone');
    const tablet = await h.enrol('iPad');
    assert.equal(
        (await h.call('POST', '/api/configure', { body: {}, headers: { [HEADER]: tablet.token } })).status,
        200,
    );
    assert.equal(await h.devices.remove(tablet.deviceId), true);
    const refused = await h.call('POST', '/api/configure', { body: {}, headers: { [HEADER]: tablet.token } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'pi-device-removed');
    assert.equal(refused.body.error, "This phone was removed from Ψυχή's Pi. Type a new code from her Pi.");
    assert.equal(
        (await h.call('POST', '/api/configure', { body: {}, headers: { [HEADER]: phone.token } })).status,
        200,
    );
});

// ── The switch ────────────────────────────────────────────────────────────

test('the switch will not turn on with no device set up, and says why', async (t) => {
    const h = await harness(t, { boat: 'Tūī' });
    const status = await h.call('GET', '/api/pi-lock');
    assert.equal(status.status, 200);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.deepEqual(
        { ...status.body, since: undefined },
        {
            v: 1,
            capability: 'pi-command-lock',
            mode: 'observe',
            enforcing: false,
            devices: 0,
            thisDevice: 'not-set-up',
            unenrolled: [],
            since: undefined,
        },
    );
    const on = await h.call('POST', '/api/pi-lock', { body: { mode: 'enforce' } });
    assert.equal(on.status, 409);
    assert.equal(on.body.code, 'pi-lock-no-devices');
    assert.equal(
        on.body.error,
        "Set up a phone or tablet for Tūī's Pi first. With none set up, nobody could change her Pi.",
    );
    assert.equal(h.store.mode(), 'observe');
    await assert.rejects(fs.stat(h.lockFile), 'nothing was written');
});

test('the switch needs an enrolled device both ways, on her own Wi-Fi', async (t) => {
    const h = await harness(t);
    const { token } = await h.enrol();
    const bare = await h.call('POST', '/api/pi-lock', { body: { mode: 'enforce' } });
    assert.equal(bare.status, 403);
    assert.equal(bare.body.code, 'pi-device-not-set-up');
    const tailnet = await h.call('POST', '/api/pi-lock', {
        body: { mode: 'enforce' },
        headers: { [HEADER]: token, 'x-test-peer': '100.101.102.103' },
    });
    assert.equal(tailnet.status, 403);
    assert.equal(tailnet.body.code, 'pi-lock-boat-wifi-only');
    assert.equal(tailnet.body.error, "Change this on Ψυχή's own Wi-Fi.");
    for (const bad of [{}, { mode: 'on' }, { mode: true }])
        assert.equal((await h.call('POST', '/api/pi-lock', { body: bad, headers: { [HEADER]: token } })).status, 400);
    assert.equal(h.store.mode(), 'observe');

    const on = await h.call('POST', '/api/pi-lock', { body: { mode: 'enforce' }, headers: { [HEADER]: token } });
    assert.equal(on.status, 200);
    assert.equal(on.headers['cache-control'], 'no-store');
    assert.equal(on.body.mode, 'enforce');
    assert.equal(on.body.enforcing, true);
    assert.equal(on.body.thisDevice, 'set-up');
    assert.equal(h.store.mode(), 'enforce');
    assert.equal(statSync(h.lockFile).mode & 0o777, 0o600);
    assert.ok(!(await fs.readdir(path.dirname(h.lockFile))).some((f) => f.endsWith('.tmp')), 'written atomically');

    const offBare = await h.call('POST', '/api/pi-lock', { body: { mode: 'observe' } });
    assert.equal(offBare.status, 403, 'turning it off needs a token too');
    assert.equal(h.store.mode(), 'enforce');
    const off = await h.call('POST', '/api/pi-lock', { body: { mode: 'observe' }, headers: { [HEADER]: token } });
    assert.equal(off.status, 200);
    assert.equal(h.store.mode(), 'observe');
});

test('a Pi left with no device enrolled answers everyone again, rather than lock the boat out', async (t) => {
    const h = await harness(t);
    const phone = await h.enrol();
    assert.equal(
        (await h.call('POST', '/api/pi-lock', { body: { mode: 'enforce' }, headers: { [HEADER]: phone.token } }))
            .status,
        200,
    );
    assert.equal((await h.call('POST', '/api/configure', { body: {} })).status, 403);
    await h.devices.remove(phone.deviceId);
    assert.equal((await h.call('POST', '/api/configure', { body: {} })).status, 200);
    const status = (await h.call('GET', '/api/pi-lock')).body;
    assert.equal(status.mode, 'enforce', 'the switch stays where she left it');
    assert.equal(status.enforcing, false, 'but with nobody set up it answers everyone');
    // Everyone, raises included: an acknowledgement then silences every phone, as before the lock.
    const ack = await h.call('POST', '/api/ais-watch/ack', { body: { kind: 'collision', mmsi: 211000001 } });
    assert.equal(ack.body.commanded, true);
});

test('a device she removed stays refused even when no device is left: only a fresh code lets it back in', async (t) => {
    const h = await harness(t);
    const phone = await h.enrol();
    const removedPhone = { [HEADER]: phone.token };
    await h.call('POST', '/api/pi-lock', { body: { mode: 'enforce' }, headers: removedPhone });
    // Lost overboard: the skipper takes it off from a shell (enrolCode.js --remove), her only device.
    await h.devices.remove(phone.deviceId);
    for (const [method, route, body] of [
        ['DELETE', '/api/anchor/watch', undefined],
        ['POST', '/api/ais-watch', { armed: false, everyone: true }],
        ['POST', '/api/configure', {}],
    ] as const) {
        const refused = await h.call(method, route, { body, headers: removedPhone });
        assert.equal(refused.status, 403, `${method} ${route} from the removed phone`);
        assert.equal(refused.body.code, 'pi-device-removed');
        assert.equal((await h.call(method, route, { body })).status, 200, `${method} ${route}: everyone else`);
    }
    // Its raises only add, as a guest's do.
    const ack = await h.call('POST', '/api/ais-watch/ack', {
        body: { kind: 'collision', mmsi: 211000001 },
        headers: removedPhone,
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.commanded, false);
});

test('the mode file: missing is observe, unreadable is enforce, and the recovery from a shell is observe with a fresh code', async (t) => {
    keepLoopAlive(t);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-file-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'pi-lock.json');
    const store = new PiLockStore(file);
    assert.equal(store.mode(), 'observe');
    await fs.writeFile(file, '{ not json');
    assert.equal(store.mode(), 'enforce', 'fails closed: it existed, so she may have turned it on');
    store.set('enforce');
    // Another process (the recovery command) changes it: read fresh, at once.
    const devices = new EncDeviceStore(path.join(root, 'enc-devices.json'));
    const shell = new PiLockStore(file);
    const { code, expiresAt } = await recoverPiLock({ store: shell, devices });
    assert.equal(store.mode(), 'observe');
    assert.ok(Date.parse(expiresAt) - Date.now() > 25 * 60_000, 'the install-length code: 30 minutes');
    const enrolled = await devices.enrol(code, 'iPhone', '192.168.1.23');
    assert.equal((await devices.verify(enrolled.token)).state, 'enrolled');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /node dist\/vault\/enrolCode\.js --recover/);
    assert.match(readme, /node dist\/vault\/enrolCode\.js --list/);
    assert.match(readme, /node dist\/vault\/enrolCode\.js --remove ID/);
});

test('the shell tool runs only as the owner of CACHE_DIR: plain sudo would leave files the service cannot read', async (t) => {
    keepLoopAlive(t);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-user-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const owner = statSync(root).uid;
    assert.equal(wrongShellUser(root, owner), null, 'the service user');
    assert.equal(wrongShellUser(path.join(root, 'not-yet'), owner + 1), null, 'no CACHE_DIR to own yet');
    assert.equal(wrongShellUser(root, undefined), null, 'a platform with no uids');
    const asRoot = wrongShellUser(root, owner === 0 ? 1 : 0);
    assert.match(asRoot ?? '', /^Nothing changed\. Run this as the Pi service's own user/);
    assert.match(asRoot ?? '', /sudo -u "\$\(stat -c %U /);
    const tool = readFileSync(new URL('./vault/enrolCode.ts', import.meta.url), 'utf8');
    const guard = tool.indexOf('if (wrongUser) {');
    assert.ok(guard > 0 && guard < tool.indexOf("args[0] === '--list'"), 'checked before every mode');
    assert.match(tool, /wrongShellUser\(cacheDir\(\), process\.getuid\?\.\(\)\)/);
});

test('a token never reaches a log line, the status read or a refusal, and no caller address is kept', async (t) => {
    const h = await harness(t, { mode: 'enforce' });
    const phone = await h.enrol();
    const tablet = await h.enrol('iPad');
    await h.devices.remove(tablet.deviceId);
    const bogus = 'kestrelBogusToken_' + 'q'.repeat(25);
    for (const token of [bogus, tablet.token]) {
        await h.call('POST', '/api/configure', { body: {}, headers: { [HEADER]: token } });
        await h.call('DELETE', '/api/anchor/watch', { headers: { [HEADER]: token } });
    }
    await h.store.set('observe');
    await h.call('POST', '/api/configure', { body: {}, headers: { [HEADER]: bogus } });
    const status = await h.call('GET', '/api/pi-lock', { headers: { [HEADER]: phone.token } });
    const everything = JSON.stringify([h.logs, status.body]);
    for (const secret of [bogus, tablet.token, phone.token, '192.168.1.23', '127.0.0.1'])
        assert.ok(!everything.includes(secret), `never ${secret.slice(0, 12)}…`);
    assert.equal(status.body.thisDevice, 'set-up');
});

// ── Watches keep running through a refused command ────────────────────────

const T0 = Date.parse('2026-10-13T21:00:00Z');
const KN = 1 / 1.94384;
const RAD = Math.PI / 180;
const NORDLICHT = 211_000_001;
const SOLENT = { lat: 50.78, lon: -1.2 };
const STRICT = { offshore: { cpaNm: 0.5, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } };
const LOOSE = { offshore: { cpaNm: 0.1, tcpaMin: 3 }, inshore: { cpaNm: 0.05, tcpaMin: 2 } };
const iso = (at: number) => new Date(at).toISOString();
const leaf = (value: unknown, at: number) => ({ value, timestamp: iso(at), $source: 'ydwg-tcp.AI' });

/** Kestrel under way in the Solent, Nordlicht 2 NM east heading straight at her. */
function headOn(now: number) {
    const east = 2 - ((now - T0) / 3_600_000) * 18;
    return {
        selfDoc: {
            navigation: {
                position: {
                    value: { latitude: SOLENT.lat, longitude: SOLENT.lon },
                    timestamp: iso(now - 1_000),
                    $source: 'ydwg-tcp.GP',
                },
                speedOverGround: leaf(8 * KN, now - 1_000),
                courseOverGroundTrue: leaf(90 * RAD, now - 1_000),
            },
        },
        vesselsDoc: {
            'urn:mrn:imo:mmsi:235000101': { name: 'Kestrel', navigation: {} },
            [`urn:mrn:imo:mmsi:${NORDLICHT}`]: {
                mmsi: String(NORDLICHT),
                name: 'NORDLICHT',
                navigation: {
                    position: leaf(
                        { latitude: SOLENT.lat, longitude: SOLENT.lon + east / (60 * Math.cos(SOLENT.lat * RAD)) },
                        now - 2_000,
                    ),
                    speedOverGround: leaf(10 * KN, now - 2_000),
                    courseOverGroundTrue: leaf(270 * RAD, now - 2_000),
                },
            },
        },
        selfAnswer: 'vessels.urn:mrn:imo:mmsi:235000101',
        readAt: now,
    };
}

test('the night watch keeps running through a refused stand-down, still alarms, and a guest arm can only add to it', async (t) => {
    let now = T0;
    const raised: string[] = [];
    const watch = new AisNightWatch({
        documents: async () => headOn(now),
        atAnchor: () => false,
        now: () => now,
        onAlarm: (alarm) => raised.push(alarm.key),
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    t.after(() => watch.close());
    let test = 0;
    const h = await harness(t, {
        mode: 'enforce',
        mount: (app) =>
            app.use(
                '/api/ais-watch',
                createAisWatchRoutes(watch, {
                    test: async () => {
                        test += 1;
                        return { push: 'ready', queued: true };
                    },
                }),
            ),
    });
    const skipper = await h.enrol();
    const own = { [HEADER]: skipper.token };
    assert.equal(
        (
            await h.call('POST', '/api/ais-watch', {
                body: { armed: true, prefs: STRICT, device: 'dev-skipper', ownMmsi: 235000101 },
                headers: own,
            })
        ).status,
        200,
    );
    for (const standDown of [
        { armed: false, everyone: true },
        { armed: false, device: 'dev-skipper' },
        { armed: false },
    ]) {
        const refused = await h.call('POST', '/api/ais-watch', { body: standDown });
        assert.equal(refused.status, 403, JSON.stringify(standDown));
        assert.equal(refused.body.code, 'pi-device-not-set-up');
    }
    assert.equal((await h.call('POST', '/api/ais-watch/test', { body: {} })).status, 403, 'a test push is a command');
    assert.equal(test, 0);
    assert.equal(watch.describe().armed, true, 'still armed');
    now += 5_000;
    await watch.passOnce();
    assert.equal(watch.describe().alarms.length, 1, 'and still alarms');
    assert.equal(raised.length, 1);

    // A guest's arm adds, never weakens: not the skipper's thresholds, not her MMSI, nobody pushed off.
    for (const device of ['dev-skipper', 'dev-guest', null]) {
        const arm = await h.call('POST', '/api/ais-watch', {
            body: { armed: true, prefs: LOOSE, ownMmsi: NORDLICHT, ...(device ? { device } : {}) },
        });
        assert.equal(arm.status, 200, `guest arm as ${device}`);
    }
    const after = watch.describe();
    assert.deepEqual(after.prefs, STRICT, 'the strictest thresholds still hold');
    assert.equal(after.ownMmsi, 235000101, "a guest cannot make Nordlicht 'our own boat'");
    assert.equal(after.devices, 3);
    // More guests than the list holds: the newest are not taken, nobody already on it is pushed off.
    for (let i = 0; i < AIS_WATCH_MAX_DEVICES; i++)
        await h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: LOOSE, device: `dev-guest-${i}` } });
    assert.equal(watch.describe().devices, AIS_WATCH_MAX_DEVICES);
    assert.deepEqual(watch.describe().prefs, STRICT);
    // The skipper's own entry was still there: her disarm takes one off.
    assert.equal(
        (await h.call('POST', '/api/ais-watch', { body: { armed: false, device: 'dev-skipper' }, headers: own }))
            .status,
        200,
    );
    assert.equal(watch.describe().devices, AIS_WATCH_MAX_DEVICES - 1);
    assert.equal(watch.describe().armed, true, "the guests' arms still hold it");
    // Her own device stands it down for everyone.
    assert.equal(
        (await h.call('POST', '/api/ais-watch', { body: { armed: false, everyone: true }, headers: own })).status,
        200,
    );
    assert.equal(watch.describe().armed, false);
});

/** A night watch on Kestrel in the Solent, Nordlicht closing, and the lock in enforce in front of its routes. */
async function enforcedWatch(t: TestContext) {
    let now = T0;
    const raised: string[] = [];
    const watch = new AisNightWatch({
        documents: async () => headOn(now),
        atAnchor: () => false,
        now: () => now,
        onAlarm: (alarm) => raised.push(alarm.key),
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    t.after(() => watch.close());
    const h = await harness(t, {
        mode: 'enforce',
        mount: (app) => app.use('/api/ais-watch', createAisWatchRoutes(watch)),
    });
    const skipper = await h.enrol();
    const pass = async (ms = 5_000) => {
        now += ms;
        await watch.passOnce();
    };
    return { h, watch, raised, pass, own: { [HEADER]: skipper.token } };
}

test("a guest's arm never names our own boat, even when the Pi knows no MMSI of hers", async (t) => {
    // A receive-only boat: no MMSI typed, no !AIVDO, so the skipper's phone arms with none.
    const { h, watch, raised, pass, own } = await enforcedWatch(t);
    const arm = (body: Record<string, unknown>, headers?: Record<string, string>) =>
        h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: STRICT, ...body }, headers });
    // A watch that is off, armed first by a phone not set up naming Nordlicht.
    assert.equal((await arm({ device: 'dev-guest', ownMmsi: NORDLICHT })).status, 200);
    assert.equal(watch.describe().armed, true, 'a guest may arm it');
    assert.equal(watch.describe().ownMmsi, null, 'but not name another ship as ours');
    assert.equal((await arm({ device: 'dev-skipper' }, own)).status, 200);
    for (const device of ['dev-guest', 'dev-other', null])
        await arm({ ownMmsi: NORDLICHT, ...(device ? { device } : {}) });
    assert.equal(watch.describe().ownMmsi, null);
    await pass();
    assert.equal(raised.length, 1, 'Nordlicht, closing head-on, still alarms');
    assert.equal(watch.describe().alarms[0].mmsi, NORDLICHT);
    // Her own device may name her MMSI.
    assert.equal((await arm({ device: 'dev-skipper', ownMmsi: 235000101 }, own)).status, 200);
    assert.equal(watch.describe().ownMmsi, 235000101);
});

test("a guest's acknowledgement silences that phone only; her own device's silences every phone", async (t) => {
    const { h, watch, raised, pass, own } = await enforcedWatch(t);
    await h.call('POST', '/api/ais-watch', {
        body: { armed: true, prefs: STRICT, device: 'dev-skipper', ownMmsi: 235000101 },
        headers: own,
    });
    // Before any alarm: a guest's acknowledgement is not kept to settle one raised later.
    for (const kind of ['collision', 'close-quarters', 'distress']) {
        const early = await h.call('POST', '/api/ais-watch/ack', { body: { kind, mmsi: NORDLICHT } });
        assert.equal(early.status, 200, kind);
        assert.equal(early.body.acked, false);
        assert.equal(early.body.local, true, 'the phone keeps it to itself');
    }
    await pass();
    assert.equal(raised.length, 1, 'raised, and pushed: no guest settled it in advance');
    assert.equal(watch.describe().alarms[0].ackedAt, null);
    const guest = await h.call('POST', '/api/ais-watch/ack', { body: { kind: 'collision', mmsi: NORDLICHT } });
    assert.equal(guest.body.acked, false);
    assert.equal(guest.body.local, true);
    assert.equal(watch.describe().alarms[0].ackedAt, null, 'still loud on every other phone');
    const mine = await h.call('POST', '/api/ais-watch/ack', {
        body: { kind: 'collision', mmsi: NORDLICHT },
        headers: own,
    });
    assert.equal(mine.body.acked, true);
    assert.equal(mine.body.local, undefined);
    assert.notEqual(watch.describe().alarms[0].ackedAt, null, 'her own device mutes it aboard');
});

test('observe: an acknowledgement from a device not set up silences every phone, as today', async (t) => {
    let now = T0;
    const watch = new AisNightWatch({
        documents: async () => headOn(now),
        atAnchor: () => false,
        now: () => now,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    t.after(() => watch.close());
    const h = await harness(t, { mount: (app) => app.use('/api/ais-watch', createAisWatchRoutes(watch)) });
    await h.enrol();
    await h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: STRICT, ownMmsi: 235000101 } });
    now += 5_000;
    await watch.passOnce();
    const ack = await h.call('POST', '/api/ais-watch/ack', { body: { kind: 'collision', mmsi: NORDLICHT } });
    assert.equal(ack.body.acked, true);
    assert.notEqual(watch.describe().alarms[0].ackedAt, null);
});

test('observe: a stand-down from a device not set up works exactly as today', async (t) => {
    const watch = new AisNightWatch({
        documents: async () => headOn(T0),
        atAnchor: () => false,
        now: () => T0,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    t.after(() => watch.close());
    const h = await harness(t, { mount: (app) => app.use('/api/ais-watch', createAisWatchRoutes(watch)) });
    await h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: STRICT, device: 'dev-skipper' } });
    await h.call('POST', '/api/ais-watch', { body: { armed: true, prefs: LOOSE, device: 'dev-skipper' } });
    assert.deepEqual(watch.describe().prefs, LOOSE, 'its own thresholds, as today');
    assert.equal((await h.call('POST', '/api/ais-watch', { body: { armed: false, everyone: true } })).status, 200);
    assert.equal(watch.describe().armed, false);
});

test('the anchor watch keeps running through a refused stop, and still alarms when she drags', async (t) => {
    const ANCHOR = { sessionCode: 'PSYCHE123456', anchorLat: 50.78, anchorLon: -1.2, swingRadius: 40 };
    let fixAt = Date.now();
    const posts: string[] = [];
    const timers: Array<() => void> = [];
    const runner = new AnchorWatchRunner({
        signalkOrigin: 'http://127.0.0.1:3000',
        now: () => Date.now(),
        fetchImpl: (async (url: string, init?: { body?: string }) => {
            if (url.endsWith('/signalk'))
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        endpoints: { v1: { 'signalk-http': 'http://127.0.0.1:3000/signalk/v1/api/' } },
                    }),
                    text: async () => '',
                };
            if (url.endsWith('vessels/self')) {
                // A new fix every read, never from the future.
                fixAt = Math.max(fixAt + 1, Date.now());
                // 0.001 deg of latitude is ~111 m: well outside the 40 m circle.
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        navigation: {
                            position: {
                                value: { latitude: 50.781, longitude: -1.2 },
                                timestamp: new Date(fixAt).toISOString(),
                            },
                        },
                    }),
                    text: async () => '',
                };
            }
            posts.push(init?.body ?? '');
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }) as unknown as typeof fetch,
        setIntervalImpl: ((fn: () => void) => {
            timers.push(fn);
            return 1 as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearIntervalImpl: (() => {
            timers.length = 0;
        }) as unknown as typeof clearInterval,
    });
    t.after(() => runner.close());
    const h = await harness(t, {
        mode: 'enforce',
        facts: { anchorWatch: () => runner.current() },
        mount: (app) => {
            // server.ts's handlers, as they decide: stop on DELETE; an uncommanded renewal keeps what runs.
            app.delete('/api/anchor/watch', (_req, res) => {
                runner.stop();
                res.json({ status: 'ok', watch: runner.describe() });
            });
            app.post('/api/anchor/watch', (req, res) => {
                if (uncommandedRenewal(req, runner.isRunning())) return res.json({ status: 'ok', kept: true });
                runner.start(req.body, {
                    url: 'https://relay.invalid/functions/v1/anchor-relay',
                    relayId: 'r'.repeat(20),
                    token: 'relay-token',
                    anonKey: 'anon',
                });
                return res.json({ status: 'ok', kept: false });
            });
        },
    });
    await h.enrol();
    // A phone not set up hands the watch over (a raise: none running) and renews it unchanged.
    assert.equal((await h.call('POST', '/api/anchor/watch', { body: ANCHOR })).body.kept, false);
    assert.equal(runner.isRunning(), true);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
    timers.forEach((fn) => fn());
    await flush();
    const renewal = await h.call('POST', '/api/anchor/watch', { body: ANCHOR });
    assert.equal(renewal.status, 200);
    assert.equal(renewal.body.kept, true, 'kept as it runs: the drag count is not reset by a renewal');
    // Stop and move, refused.
    assert.equal((await h.call('DELETE', '/api/anchor/watch')).status, 403);
    assert.equal((await h.call('POST', '/api/anchor/watch', { body: { ...ANCHOR, anchorLat: 50.781 } })).status, 403);
    assert.equal(runner.isRunning(), true, 'still armed');
    for (let i = 0; i < 3; i++) {
        timers.forEach((fn) => fn());
        await flush();
    }
    assert.ok(
        posts.some((body) => /"isAlarm":true/.test(body)),
        'and it still cries drag',
    );
});

test('server.ts: the lock is in front of every route, fed the chart door’s devices, the switch mounted, a renewal kept', () => {
    const lock = serverSource.indexOf('app.use(\n    createPiCommandLock({');
    const json = serverSource.indexOf('app.use(createAppJsonParser(UNSAFE_ADMIN_API_ENABLED));');
    const firstRoute = serverSource.indexOf("app.get('/health'");
    assert.ok(lock > 0, 'the lock is mounted at the app level');
    assert.ok(json > 0 && json < lock, 'after the body parser, so a stand-down is read from its body');
    assert.ok(lock < firstRoute, 'before the first route');
    const block = serverSource.slice(lock, serverSource.indexOf('\n);', lock));
    assert.match(block, /devices: chartDevices,/);
    assert.match(block, /store: piLock,/);
    assert.match(block, /boatName: \(\) => identity\.boatName,/);
    assert.match(block, /anchorWatch: \(\) => anchorWatch\.current\(\)/);
    assert.match(serverSource, /app\.use\(\s*'\/api\/pi-lock',\s*requireAppApi,\s*createPiLockRoutes\(\{/);
    const post = serverSource.slice(serverSource.indexOf("app.post('/api/anchor/watch'"));
    const keep = post.indexOf('uncommandedRenewal(req, anchorWatch.isRunning())');
    assert.ok(
        keep > 0 && keep < post.indexOf('anchorWatch.start('),
        'a renewal from a device not set up never restarts it',
    );
    assert.match(serverSource, /new PiLockStore\(path\.join\(CACHE_DIR, 'pi-lock\.json'\)\)/);
    // The internet policy: read for the configure row, kept only from a command.
    assert.match(block, /internetPolicy: \(\) => piInternet\.read\(\)/);
    assert.match(serverSource, /new PiInternetMemory\(path\.join\(CACHE_DIR, 'pi-internet\.json'\)\)/);
    const configure = serverSource.slice(serverSource.indexOf("app.post('/api/configure'"));
    const remember = configure.slice(0, configure.indexOf('piInternet.remember(policy)'));
    assert.match(
        remember,
        /if \(policy !== undefined && \(req as PiCommandRequest\)\.piCommand\?\.commanded !== false\) \{\s*try \{\s*$/,
    );
    assert.ok(
        configure.indexOf('const policy = applyDiaryRelayConfiguration(requestBody);') <
            configure.indexOf('piInternet.remember(policy)'),
        'kept once it is applied',
    );
});
