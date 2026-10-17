import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { createOwnBoatSkillRoutes } from './ownBoatSkill.js';
import { CHART_DEVICE_HEADER, type BoatLanView } from '../encDevices.js';
import { createAppJsonParser } from '../appJson.js';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const lan: BoatLanView = {
    interfaces: {
        eth0: [
            {
                address: '192.168.1.180',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: '00:11:22:33:44:55',
                internal: false,
                cidr: '192.168.1.180/24',
            },
        ],
    },
    gateways: ['192.168.1.1'],
};
async function fixture(t: TestContext, preparse = false) {
    const device = {
        id: ID,
        label: 'Synthetic controller',
        enrolledAt: '2026-10-17T00:00:00Z',
        lastSeenAt: '2026-10-17T00:00:00Z',
    };
    let enrolled = true,
        changeAfterPrepare = false,
        verifies = 0;
    const calls: { method: string; args: unknown[] }[] = [];
    const call = (method: string, args: unknown[]) => {
        calls.push({ method, args });
    };
    const keeper = {
        capability: () => ({ schema: 1, installed: true }),
        prepare: async (...args: unknown[]) => {
            call('prepare', args);
            if (changeAfterPrepare) enrolled = false;
            return { schema: 1, synthetic: 'proposal' };
        },
        confirm: async (...args: unknown[]) => {
            call('confirm', args);
            return { schema: 1 };
        },
        enable: async (...args: unknown[]) => {
            call('enable', args);
            return { schema: 1, state: 'logging' };
        },
        openRead: async (...args: unknown[]) => {
            call('openRead', args);
            return { schema: 1, readId: 'a'.repeat(64), expiresAt: 1 };
        },
        read: async (...args: unknown[]) => {
            call('read', args);
            return { schema: 1, synthetic: 'private score' };
        },
        assertRead: (...args: unknown[]) => {
            call('assertRead', args);
            return {} as never;
        },
        off: (...args: unknown[]) => {
            call('off', args);
            return { schema: 1, state: 'off', cleared: args[2] };
        },
        controllerRetired: (...args: unknown[]) => {
            call('retired', args);
        },
    };
    const app = express();
    if (preparse) app.use(express.json());
    else app.use(createAppJsonParser(false));
    app.use(
        '/api/own-boat-skill',
        createOwnBoatSkillRoutes({
            keeper: keeper as never,
            devices: {
                verify: async (token) => {
                    verifies++;
                    return enrolled && token === 'synthetic-token'
                        ? { state: 'enrolled', device }
                        : { state: 'removed' };
                },
            },
            lanView: () => lan,
            peerOf: (req) => String(req.headers['x-fixture-peer'] ?? '192.168.1.90'),
        }),
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    return {
        calls,
        setRemoved: () => {
            enrolled = false;
        },
        changePrepare: () => {
            changeAfterPrepare = true;
        },
        verifies: () => verifies,
        async request(path: string, body?: unknown, headers: Record<string, string> = {}) {
            return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/own-boat-skill/` + path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { [CHART_DEVICE_HEADER]: 'synthetic-token', 'Content-Type': 'application/json', ...headers },
                body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
            });
        },
    };
}
test('actual HTTP private endpoints are boat-LAN and enrollment gated, even their public capability response', async (t) => {
    const f = await fixture(t);
    for (const peer of ['100.76.1.2', '127.0.0.1', '192.168.1.1']) {
        const response = await f.request('capability', undefined, { 'x-fixture-peer': peer });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    f.setRemoved();
    assert.equal((await f.request('capability')).status, 401);
    assert.equal(f.calls.length, 0);
});
test('ordinary global app JSON parser skips private raw body; prepare forwards live owner JWT separately from body', async (t) => {
    const f = await fixture(t);
    const response = await f.request(
        'prepare',
        { schema: 1, vesselId: ID },
        { Authorization: 'Bearer synthetic.jwt.only' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.calls, [{ method: 'prepare', args: [{ schema: 1, vesselId: ID }, ID, 'synthetic.jwt.only'] }]);
    assert.equal(f.verifies(), 2);
});
test('already-parsed bodies, oversized originals, compressed bodies and query overrides never enter the keeper', async (t) => {
    const pre = await fixture(t, true);
    assert.equal((await pre.request('prepare', { schema: 1 })).status, 409);
    const f = await fixture(t);
    assert.equal((await f.request('prepare', JSON.stringify({ value: 'x'.repeat(17000) }))).status, 413);
    assert.equal((await f.request('prepare', '{}', { 'Content-Encoding': 'gzip' })).status, 409);
    assert.equal((await f.request('read?capability=bad', { schema: 1 })).status, 409);
    assert.equal(f.calls.length, 0);
    assert.equal(pre.calls.length, 0);
});
test('controller removal during owner await withholds proposal and retires only the original controller revision', async (t) => {
    const f = await fixture(t);
    f.changePrepare();
    const response = await f.request('prepare', { schema: 1, vesselId: ID });
    assert.equal(response.status, 409);
    assert.equal(f.calls.at(-1)?.method, 'retired');
    assert.equal(f.calls.at(-1)?.args[0], ID);
});
test('private reads are rechecked synchronously after enrollment await and no capability appears in URL', async (t) => {
    const f = await fixture(t),
        cap = 'b'.repeat(64),
        readId = 'c'.repeat(64);
    assert.equal((await f.request('read', { schema: 1, capability: cap, readId })).status, 200);
    assert.deepEqual(
        f.calls.map((c) => c.method),
        ['read', 'assertRead'],
    );
    assert.deepEqual(f.calls[1].args, [cap, ID, readId]);
    assert.equal((await f.request('clear', { schema: 1, capability: cap })).status, 200);
    assert.deepEqual(f.calls.at(-1), { method: 'off', args: [cap, ID, true] });
});
