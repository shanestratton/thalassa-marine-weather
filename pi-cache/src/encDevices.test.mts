/**
 * Who may get the boat's charts (127-C-d decisions 4 and 5): phones and
 * tablets enrolled by a one-time code, at most five, on the boat's own Wi-Fi.
 * The Pi keeps only hashes of codes and tokens. Fictional peers and devices.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import {
    ChartDeviceError,
    EncDeviceStore,
    MAX_CHART_DEVICES,
    classifyPeer,
    createEncFrontDoor,
    normaliseChartCode,
    parseProcNetRoute,
    type BoatLanView,
} from './encDevices.js';

const require = createRequire(import.meta.url);
const MIN = 60_000;

async function store(t: TestContext) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-devices-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let now = Date.UTC(2026, 9, 13, 2, 0, 0);
    const file = path.join(dir, 'enc-devices.json');
    const devices = new EncDeviceStore(file, { now: () => now });
    return {
        file,
        devices,
        clock: () => now,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

const refusal = (code: string, status: number) => (error: unknown) => {
    assert.ok(error instanceof ChartDeviceError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
};

test('a code is ten Crockford base32 characters and works exactly once', async (t) => {
    const s = await store(t);
    const { code, expiresAt } = await s.devices.mintCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    assert.ok(Date.parse(expiresAt) > 0);
    const typed = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`;
    assert.equal(normaliseChartCode(typed), code, 'read as the app reads it');
    const enrolled = await s.devices.enrol(typed, 'iPhone', '192.168.1.23');
    assert.match(enrolled.deviceId, /^[\w-]{1,64}$/);
    assert.match(enrolled.token, /^[\w-]{43}$/);
    await assert.rejects(s.devices.enrol(code, 'iPad', '192.168.1.24'), refusal('chart-code-invalid', 403));
});

test('a code expires after 15 minutes, and the install code after 30', async (t) => {
    const s = await store(t);
    const { code } = await s.devices.mintCode();
    s.advance(15 * MIN + 1);
    await assert.rejects(s.devices.enrol(code, 'iPhone', '192.168.1.23'), refusal('chart-code-invalid', 403));
    const install = await s.devices.mintCode({ ttlMs: 30 * MIN });
    s.advance(29 * MIN);
    await s.devices.enrol(install.code, 'iPhone', '192.168.1.23');
});

test('at most three codes are pending: a fourth retires the oldest', async (t) => {
    const s = await store(t);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await s.devices.mintCode()).code);
    await assert.rejects(s.devices.enrol(codes[0], 'iPhone', '192.168.1.23'), refusal('chart-code-invalid', 403));
    for (const code of codes.slice(1)) await s.devices.enrol(code, 'iPad', '192.168.1.23');
});

test('a sixth device gets 409 chart-device-limit, and its code still works after a removal', async (t) => {
    const s = await store(t);
    const ids: string[] = [];
    for (let i = 0; i < MAX_CHART_DEVICES; i++) {
        const { code } = await s.devices.mintCode();
        ids.push((await s.devices.enrol(code, `Tablet ${i}`, '192.168.1.23')).deviceId);
    }
    assert.equal(MAX_CHART_DEVICES, 5);
    const { code } = await s.devices.mintCode();
    await assert.rejects(s.devices.enrol(code, 'iPhone', '192.168.1.23'), refusal('chart-device-limit', 409));
    assert.equal(await s.devices.remove(ids[0]), true);
    await s.devices.enrol(code, 'iPhone', '192.168.1.23');
    assert.equal((await s.devices.list()).length, 5);
});

test('five wrong codes in ten minutes from one address answer 429; another address still may try', async (t) => {
    const s = await store(t);
    const { code } = await s.devices.mintCode();
    for (let i = 0; i < 5; i++) {
        await assert.rejects(s.devices.enrol('0000000000', 'x', '192.168.1.66'), refusal('chart-code-invalid', 403));
    }
    await assert.rejects(s.devices.enrol(code, 'x', '192.168.1.66'), (error: unknown) => {
        refusal('chart-code-tries', 429)(error);
        assert.ok((error as ChartDeviceError).retryAfterSeconds! > 0);
        return true;
    });
    s.advance(10 * MIN + 1);
    await s.devices.enrol(code, 'iPhone', '192.168.1.66');
});

test('twenty wrong codes in an hour overall answer 429 to everyone', async (t) => {
    const s = await store(t);
    const { code } = await s.devices.mintCode();
    for (let i = 0; i < 20; i++) {
        // Four tries from each of five addresses, spread over the hour.
        await assert.rejects(
            s.devices.enrol('0000000000', 'x', `192.168.1.${70 + (i % 5)}`),
            refusal('chart-code-invalid', 403),
        );
        s.advance(2 * MIN);
    }
    await assert.rejects(s.devices.enrol(code, 'iPhone', '192.168.1.99'), refusal('chart-code-tries', 429));
});

test('tokens are compared by hash with timingSafeEqual, and the file holds no raw token or code', async (t) => {
    const s = await store(t);
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const original = crypto.timingSafeEqual;
    let compared = 0;
    crypto.timingSafeEqual = ((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        compared++;
        return original(a, b);
    }) as typeof crypto.timingSafeEqual;
    syncBuiltinESMExports();
    t.after(() => {
        crypto.timingSafeEqual = original;
        syncBuiltinESMExports();
    });
    const pending = (await s.devices.mintCode()).code;
    const { code } = await s.devices.mintCode();
    const { deviceId, token } = await s.devices.enrol(code, 'iPhone', '192.168.1.23');
    const seen = await s.devices.verify(token);
    assert.equal(seen.state, 'enrolled');
    assert.equal(seen.state === 'enrolled' && seen.device.id, deviceId);
    assert.ok(compared > 0, 'compared with timingSafeEqual');
    assert.equal((await s.devices.verify('A'.repeat(43))).state, 'unknown');
    assert.equal((await s.devices.verify(undefined)).state, 'unknown');
    assert.equal((await s.devices.verify('not a token')).state, 'unknown');
    const text = await fs.readFile(s.file, 'utf8');
    assert.ok(!text.includes(token), 'no raw token');
    assert.ok(!text.includes(code) && !text.includes(pending), 'no raw code');
    assert.ok(text.includes(createHash('sha256').update(token).digest('hex')), 'the token is kept as its SHA-256');
    assert.equal((await fs.stat(s.file)).mode & 0o777, 0o600);
});

test('a removed device gets chart-device-removed; a device can remove itself', async (t) => {
    const s = await store(t);
    const { code } = await s.devices.mintCode();
    const { deviceId, token } = await s.devices.enrol(code, 'iPhone', '192.168.1.23');
    const listed = await s.devices.list();
    assert.deepEqual(Object.keys(listed[0]).sort(), ['enrolledAt', 'id', 'label', 'lastSeenAt']);
    assert.equal(await s.devices.remove(deviceId), true);
    assert.equal((await s.devices.verify(token)).state, 'removed');
    assert.equal(await s.devices.remove(deviceId), false);
});

test('another process minting a code (enrolCode.js over ssh) is seen by the running store', async (t) => {
    const s = await store(t);
    const other = new EncDeviceStore(s.file, { now: s.clock });
    const { code } = await other.mintCode();
    await s.devices.enrol(code, 'iPhone', '192.168.1.23');
});

test(
    'a removal over ssh while the service writes a lastSeenAt stays removed (the lock file)',
    { timeout: 10_000 },
    async (t) => {
        const s = await store(t);
        const { code } = await s.devices.mintCode();
        const { deviceId, token } = await s.devices.enrol(code, 'Lost phone', '192.168.1.23');
        let paused!: () => void;
        let release!: () => void;
        const inside = new Promise<void>((resolve) => (paused = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        let hold = true;
        // thalassa-cache, ten minutes on: its lastSeenAt write is due, and it stops
        // between reading the list and writing it back.
        const service = new EncDeviceStore(s.file, {
            now: () => s.clock() + 10 * MIN,
            beforeWrite: async () => {
                if (!hold) return;
                hold = false;
                paused();
                await gate;
            },
        });
        // enrolCode.js --remove, a second process.
        const ssh = new EncDeviceStore(s.file, { now: () => s.clock() + 10 * MIN });
        assert.equal((await service.verify(token)).state, 'enrolled');
        await inside;
        const removing = ssh.remove(deviceId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        release();
        assert.equal(await removing, true, 'Removed <id>.');
        await service.mintCode(); // after its lastSeenAt write, in the service's own order
        assert.equal((await new EncDeviceStore(s.file).verify(token)).state, 'removed', 'the lost phone stays removed');
        assert.deepEqual(await ssh.list(), []);
        await assert.rejects(fs.stat(`${s.file}.lock`), { code: 'ENOENT' }, 'the lock is let go');
    },
);

test('a lock left by a writer that died goes after ten seconds', async (t) => {
    const s = await store(t);
    await fs.writeFile(`${s.file}.lock`, '4242\n');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${s.file}.lock`, old, old);
    const t0 = Date.now();
    await s.devices.mintCode();
    assert.ok(Date.now() - t0 < 2_000);
    await assert.rejects(fs.stat(`${s.file}.lock`), { code: 'ENOENT' });
});

// ── The boat's own Wi-Fi only ──────────────────────────────────────────────

const view: BoatLanView = {
    interfaces: {
        lo: [
            {
                address: '127.0.0.1',
                netmask: '255.0.0.0',
                family: 'IPv4',
                internal: true,
                mac: '',
                cidr: '127.0.0.1/8',
            },
        ],
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

test('peers: the boat LAN is allowed; the router, the tailnet, loopback, strangers and IPv6 are not', () => {
    const rows: [string, boolean][] = [
        ['192.168.1.23', true],
        ['::ffff:192.168.1.23', true],
        ['192.168.1.1', false],
        ['100.101.102.103', false],
        ['127.0.0.1', false],
        ['10.0.0.5', false],
        ['fe80::1', false],
        ['192.168.1.180', false],
        ['', false],
    ];
    for (const [peer, allowed] of rows) assert.equal(classifyPeer(peer, view).boatLan, allowed, peer);
    assert.equal(classifyPeer('192.168.1.1', view).seenAs, 'router');
    assert.equal(classifyPeer('100.101.102.103', view).seenAs, 'tailnet');
    assert.equal(classifyPeer('127.0.0.1', view).seenAs, 'loopback');
    assert.equal(classifyPeer('fe80::1', view).seenAs, 'ipv6');
    assert.equal(classifyPeer('192.168.1.23', view).seenAs, 'boat-wifi');
});

test('the default gateway comes from /proc/net/route', () => {
    const text =
        'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
        'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n' +
        'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n';
    assert.deepEqual(parseProcNetRoute(text), ['192.168.1.1']);
});

function fakeExchange(remoteAddress: string, headers: Record<string, string> = {}, reqPath = '/installed') {
    const req = {
        socket: { remoteAddress },
        headers,
        method: 'GET',
        path: reqPath,
        url: reqPath,
    } as unknown as Request;
    const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
    const res = {
        setHeader: (k: string, v: string) => {
            sent.headers[k.toLowerCase()] = v;
        },
        status(code: number) {
            sent.status = code;
            return this;
        },
        json(body: unknown) {
            sent.body = body;
            return this;
        },
    } as unknown as Response;
    return { req, res, sent };
}

test('the front door reads the socket, never X-Forwarded-For', async (t) => {
    const s = await store(t);
    const door = createEncFrontDoor({ devices: s.devices, lanView: () => view });
    const allowed = fakeExchange('192.168.1.23', { 'x-forwarded-for': '100.1.2.3' }, '/devices/status');
    let passed = false;
    await door(allowed.req, allowed.res, () => {
        passed = true;
    });
    assert.equal(passed, true, 'the header is ignored: the socket says boat Wi-Fi');
    assert.equal(allowed.sent.headers['cache-control'], 'no-store');
    const refused = fakeExchange('100.101.102.103', { 'x-forwarded-for': '192.168.1.23' }, '/devices/status');
    await door(refused.req, refused.res, () => assert.fail('a tailnet peer passed'));
    assert.equal(refused.sent.status, 403);
    assert.deepEqual(refused.sent.body, {
        code: 'charts-boat-wifi-only',
        error: 'Charts come over the boat’s own Wi-Fi.',
        seenAs: 'tailnet',
    });
});
