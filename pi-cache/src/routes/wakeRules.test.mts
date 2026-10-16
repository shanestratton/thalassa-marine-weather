import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAppJsonParser } from '../appJson.js';
import { EncDeviceStore, type BoatLanView } from '../encDevices.js';
import { PiWakeKeeper } from '../wakeKeeper/runner.js';
import { WakeKeeperStore } from '../wakeKeeper/store.js';
import { wakeHash, wakePairingId } from '../wakeKeeper/contract.js';
import { defaultWakeRules, wakeRulesCanonical } from '../wakeRule/wakeRule.js';
import { createWakeRuleRoutes } from './wakeRules.js';

const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002';
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
async function fixture(t: TestContext, earlierParser = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-wake-http-'));
    const data = { now: Date.parse('2026-10-16T00:00:00Z'), peer: '192.168.1.22', sourceReads: 0 };
    const devices = new EncDeviceStore(path.join(directory, 'enc-devices.json'), { now: () => data.now });
    const code = await devices.mintCode(),
        enrolled = await devices.enrol(code.code, 'Fictional phone', data.peer);
    const verdict = await devices.verify(enrolled.token);
    assert.equal(verdict.state, 'enrolled');
    if (verdict.state !== 'enrolled') throw new Error('fixture');
    const store = new WakeKeeperStore(directory),
        keeper = new PiWakeKeeper({
            store,
            devices,
            now: () => data.now,
            identity: () => ({
                ownerId: owner,
                piDeviceId: pi,
                pairingId: wakePairingId(owner, pi, 'fictional-relay-identity'),
            }),
            selfDocument: async () => {
                data.sourceReads++;
                return {
                    uuid: 'urn:mrn:imo:mmsi:000000001',
                    environment: {
                        wind: {
                            speedTrue: {
                                value: 10,
                                timestamp: new Date(data.now).toISOString(),
                                $source: 'fictional.1',
                                meta: { units: 'm/s' },
                            },
                        },
                    },
                };
            },
        });
    await keeper.start(false);
    data.now += 1000;
    await keeper.tick();
    const app = express();
    if (earlierParser) app.use(express.json({ limit: '64kb' }));
    else app.use(createAppJsonParser(false));
    app.use(
        '/api/wake-rules',
        (req, res, next) => {
            if (req.headers['x-test-app'] !== 'yes') return res.status(403).end();
            next();
        },
        createWakeRuleRoutes({ keeper, devices, peerOf: () => data.peer, lanView: () => view }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    t.after(async () => {
        keeper.stop();
        await new Promise<void>((r) => server.close(() => r()));
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'thalassa-wake-http-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/wake-rules`;
    const headers = {
        'x-test-app': 'yes',
        'x-thalassa-chart-device': enrolled.token,
        'content-type': 'application/json',
    };
    const sensors = await keeper.sensors(verdict.device),
        binding = sensors.binding!;
    const request = (expectedRevision: string | null = null) => {
        const rules = defaultWakeRules();
        return {
            schema: 1,
            expectedRevision,
            binding,
            draftM: 2,
            rules,
            rulesDigest: wakeHash(wakeRulesCanonical(rules, 2)),
        };
    };
    return { data, devices, keeper, store, enrolled, base, headers, binding, request };
}
test('actual HTTP door enforces app gate, physical LAN and enrollment independently of observe mode', async (t) => {
    const f = await fixture(t);
    assert.equal((await fetch(f.base + '/status')).status, 403);
    assert.equal((await fetch(f.base + '/status', { headers: { 'x-test-app': 'yes' } })).status, 401);
    for (const peer of ['100.76.1.2', '127.0.0.1', '192.168.1.1', '192.168.1.180', '203.0.113.7']) {
        f.data.peer = peer;
        const result = await fetch(f.base + '/status', {
            headers: { ...f.headers, 'x-forwarded-for': '192.168.1.22' },
        });
        assert.equal(result.status, 403);
        assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    f.data.peer = '192.168.1.22';
    const before = f.data.sourceReads;
    let response = await fetch(f.base + '/sensors?draftM=2.1', { headers: f.headers });
    assert.equal(response.status, 200);
    const sensors = await response.json();
    assert.equal(sensors.schema, 1);
    assert.equal(sensors.update, 7);
    assert.equal(sensors.draftM, 2.1);
    assert.equal(sensors.options[0].reading.at, f.data.now);
    assert.equal(f.data.sourceReads, before);
    response = await fetch(f.base + '/status', { headers: f.headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).proof, null);
    await f.devices.remove(f.enrolled.deviceId);
    assert.equal((await fetch(f.base + '/status', { headers: f.headers })).status, 401);
    assert.equal(
        (
            await fetch(f.base + '/configuration', {
                method: 'POST',
                headers: f.headers,
                body: JSON.stringify(f.request()),
            })
        ).status,
        401,
    );
    assert.equal(await f.store.load(), null);
});
test('actual HTTP configuration is exact bounded CAS; no path/URL/query surface or stale overwrite', async (t) => {
    const f = await fixture(t);
    const body = f.request();
    let response = await fetch(f.base + '/configuration', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const config = (await response.json()).configuration;
    const noDraft = await fetch(f.base + '/sensors?draftM=none', { headers: f.headers });
    assert.equal(noDraft.status, 200);
    assert.equal(
        (await noDraft.json()).draftM,
        null,
        'another saved profile draft is never borrowed after an explicit none',
    );
    const inherited = await fetch(f.base + '/sensors', { headers: f.headers });
    assert.equal(
        (await inherited.json()).draftM,
        2,
        'omission retains the explicit existing Pi configuration contract',
    );
    assert.equal(
        config.rules.every((r: { enabled: boolean }) => !r.enabled),
        true,
    );
    response = await fetch(f.base + '/configuration', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'wake-conflict');
    for (const query of [
        '?origin=http://127.0.0.1',
        '?draftM=0',
        '?draftM=21',
        '?draftM[]=2',
        '?draftM=NaN',
        '?draftM=2&draftM=3',
    ])
        assert.equal((await fetch(f.base + '/sensors' + query, { headers: f.headers })).status, 400);
    for (const suffix of ['?url=https://example.test', '?draftM=2'])
        assert.equal((await fetch(f.base + '/status' + suffix, { headers: f.headers })).status, 400);
    const invalid = { ...f.request(config.revision), url: 'https://example.test' };
    assert.equal(
        (await fetch(f.base + '/configuration', { method: 'POST', headers: f.headers, body: JSON.stringify(invalid) }))
            .status,
        400,
    );
    const forged = {
        ...f.request(config.revision),
        binding: { ...f.binding, deviceId: '00000000-0000-4000-8000-000000000004' },
    };
    assert.equal(
        (await fetch(f.base + '/configuration', { method: 'POST', headers: f.headers, body: JSON.stringify(forged) }))
            .status,
        403,
    );
    const clear = { schema: 1, expectedRevision: config.revision, binding: f.binding, rulesDigest: config.rulesDigest };
    assert.equal(
        (
            await fetch(f.base + '/configuration', {
                method: 'DELETE',
                headers: f.headers,
                body: JSON.stringify({ ...clear, rulesDigest: '0'.repeat(64) }),
            })
        ).status,
        409,
    );
    response = await fetch(f.base + '/configuration', {
        method: 'DELETE',
        headers: f.headers,
        body: JSON.stringify(clear),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { schema: 1, cleared: true });
    assert.equal(await f.store.load(), null);
});
test('raw wire limit covers chunked whitespace; malformed/compressed/already-parsed bodies fail closed', async (t) => {
    const f = await fixture(t),
        body = JSON.stringify(f.request());
    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(f.base + '/configuration', { method: 'POST', headers: f.headers }, (res) => {
            let response = '';
            res.on('data', (c) => {
                response += c;
            });
            res.on('end', () => resolve({ status: res.statusCode!, body: response }));
        });
        request.on('error', reject);
        request.write(' '.repeat(17000));
        request.end(body);
    });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).code, 'wake-body-too-large');
    assert.equal(await f.store.load(), null);
    assert.equal(
        (await fetch(f.base + '/configuration', { method: 'POST', headers: f.headers, body: '{"schema":' })).status,
        400,
    );
    assert.equal(
        (
            await fetch(f.base + '/configuration', {
                method: 'POST',
                headers: { ...f.headers, 'content-encoding': 'gzip' },
                body,
            })
        ).status,
        400,
    );
    const incorrectlyMounted = await fixture(t, true);
    assert.equal(
        (
            await fetch(incorrectlyMounted.base + '/configuration', {
                method: 'POST',
                headers: incorrectlyMounted.headers,
                body: JSON.stringify(incorrectlyMounted.request()),
            })
        ).status,
        400,
    );
    assert.equal(await incorrectlyMounted.store.load(), null);
});
