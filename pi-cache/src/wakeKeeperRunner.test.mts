import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PiWakeKeeper } from './wakeKeeper/runner.js';
import { WakeKeeperStore } from './wakeKeeper/store.js';
import { WakeRelay } from './wakeKeeper/relay.js';
import { wakeCloudContext, type WakeCloudContext } from './wakeKeeper/relayProtocol.js';
import {
    wakeHash,
    wakePairingId,
    wakeEnrollmentRevision,
    type WakeBinding,
    type WakePairIdentity,
    type WakeConfigurationRequest,
} from './wakeKeeper/contract.js';
import {
    defaultWakeRules,
    wakeRulesCanonical,
    evaluateWakeRule,
    initialWakeState,
    type WakePreset,
} from './wakeRule/wakeRule.js';
import type { ChartDevicePublic } from './encDevices.js';
const start = Date.parse('2026-10-16T00:00:00Z');
const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002';
const device: ChartDevicePublic = {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'Fictional phone',
    enrolledAt: new Date(start - 60_000).toISOString(),
    lastSeenAt: new Date(start).toISOString(),
};
const pair: WakePairIdentity = {
    ownerId: owner,
    piDeviceId: pi,
    pairingId: wakePairingId(owner, pi, 'fictional-relay-identity'),
};
function request(
    binding: WakeBinding,
    preset?: WakePreset,
    expectedRevision: string | null = null,
): WakeConfigurationRequest {
    const rules = defaultWakeRules();
    if (preset) {
        const r = rules.find((r) => r.preset === preset)!;
        r.enabled = true;
        r.selection = {
            feedId: binding.feedId,
            sensorId: 'fictional.1',
            reference: preset === 'wind-above' ? 'true-water' : 'station-3h-fall',
        };
        r.minimumDurationMs = 10_000;
    }
    return {
        schema: 1,
        expectedRevision,
        binding,
        draftM: 2,
        rules,
        rulesDigest: wakeHash(wakeRulesCanonical(rules, 2)),
    };
}
async function fixture(t: TestContext, relay?: WakeRelay) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-wake-runner-'));
    t.after(async () => {
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'thalassa-wake-runner-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const data = {
        now: start,
        identity: { ...pair } as WakePairIdentity | null,
        devices: [{ ...device }],
        reads: 0,
        document: null as unknown,
        block: null as (() => Promise<unknown>) | null,
        enrollmentFailure: false,
    };
    const store = new WakeKeeperStore(directory);
    const deps = {
        store,
        identity: () => data.identity,
        devices: {
            list: async () => {
                if (data.enrollmentFailure) throw new Error('synthetic unreadable file');
                return data.devices;
            },
        },
        selfDocument: async () => {
            data.reads++;
            return data.block ? data.block() : data.document;
        },
        now: () => data.now,
        relay,
    };
    const keeper = new PiWakeKeeper(deps);
    await keeper.start(false);
    t.after(() => keeper.stop());
    const wind = (value = 20, at = data.now) => ({
        uuid: 'urn:mrn:imo:mmsi:000000001',
        environment: {
            wind: {
                speedTrue: {
                    value,
                    $source: 'fictional.1',
                    timestamp: new Date(at).toISOString(),
                    meta: { units: 'm/s' },
                },
            },
        },
    });
    const pressure = (pa = 101000, source = 'fictional.1', at = data.now) => ({
        uuid: 'urn:mrn:imo:mmsi:000000001',
        environment: {
            outside: {
                pressure: { value: pa, $source: source, timestamp: new Date(at).toISOString(), meta: { units: 'Pa' } },
            },
        },
    });
    data.now += 100;
    data.document = wind();
    await keeper.tick();
    const binding = (await keeper.sensors(device)).binding!;
    assert.ok(binding);
    return { data, keeper, store, deps, binding, wind, pressure };
}
test('actual keeper transports complete original-clock episodes and applies only matching cloud ACKs; pairing retirement drops ready', async (t) => {
    let now = start,
        remote: unknown = null,
        revision: string | null = null;
    const sent: Record<string, unknown>[] = [];
    const relay = new WakeRelay({
        endpoint: 'https://pcisdplnodrphauixcau.supabase.co/functions/v1/pi-alarm-relay',
        anonKey: () => 'fictional-gateway',
        credentials: () => ({ relayId: 'fictional-relay-identity', token: 'fictional-not-secret' }),
        ownerId: () => owner,
        internetAllowed: () => true,
        now: () => now,
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            sent.push(body);
            if (body.action === 'probe')
                return Response.json({
                    ok: true,
                    devices: 1,
                    wake: { v: 1, enabled: true },
                    context: remote,
                    contextRevision: revision,
                    retired: false,
                });
            revision ??= '00000000-0000-4000-8000-000000000006';
            if (body.action === 'bind') {
                remote = body.context;
                return Response.json({
                    ok: true,
                    wake: { v: 1, enabled: true },
                    contextRevision: revision,
                    queued: 0,
                    acked: [],
                });
            }
            if (body.action === 'retire')
                return Response.json({
                    ok: true,
                    retired: true,
                    wake: { v: 1, enabled: true },
                    contextRevision: '00000000-0000-4000-8000-000000000007',
                    queued: 0,
                    acked: [],
                });
            return Response.json({
                ok: true,
                wake: { v: 1, enabled: true },
                contextRevision: revision,
                queued: 0,
                acked: body.states.flatMap((r: { alarm: { key: string } | null }) => (r.alarm ? [r.alarm.key] : [])),
            });
        },
    });
    const f = await fixture(t, relay);
    now = f.data.now;
    await f.keeper.configure(request(f.binding, 'wind-above'), device);
    await f.keeper.tick();
    await relay.settled();
    f.data.now += 10_001;
    now = f.data.now;
    f.data.document = f.wind();
    await f.keeper.tick();
    await relay.settled();
    const status = await f.keeper.status(device),
        wind = status.rules.find((r) => r.preset === 'wind-above')!;
    assert.equal(status.push.state, 'ready');
    assert.equal(status.push.capability, 1);
    assert.equal(wind.episode?.sourceAt, f.data.now);
    assert.equal(wind.episode?.ackedAt, f.data.now);
    assert.equal(wind.audible, false);
    const snapshot = sent.filter((r) => r.action === 'sync').at(-1) as {
        evaluatedAt: number;
        states: { alarm: { sourceAt: number } | null }[];
    };
    assert.equal(snapshot.evaluatedAt, f.data.now);
    assert.equal(snapshot.states.find((r) => r.alarm)?.alarm?.sourceAt, f.data.now);
    f.data.identity = null;
    assert.equal((await f.keeper.status(device)).push.capability, 0);
    await relay.settled();
    assert.equal(sent.at(-1)?.action, 'retire');
});
test('explicit cloud review verifies caller enrollment, local CAS and physical feed before scheduling exactly that context', async (t) => {
    let now = start,
        remote: WakeCloudContext | null = null;
    const cloudRevision = '00000000-0000-4000-8000-000000000066',
        calls: Record<string, unknown>[] = [];
    const relay = new WakeRelay({
        endpoint: 'https://pcisdplnodrphauixcau.supabase.co/functions/v1/pi-alarm-relay',
        anonKey: () => 'fictional-gateway',
        credentials: () => ({ relayId: 'fictional-relay-identity', token: 'fictional-not-secret' }),
        ownerId: () => owner,
        internetAllowed: () => true,
        now: () => now,
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            calls.push(body);
            if (body.action === 'probe')
                return Response.json({
                    ok: true,
                    devices: 1,
                    wake: { v: 1, enabled: true },
                    context: remote,
                    contextRevision: cloudRevision,
                    retired: false,
                });
            if (body.action === 'bind') remote = body.context;
            return Response.json({
                ok: true,
                wake: { v: 1, enabled: true },
                contextRevision: cloudRevision,
                queued: 0,
                acked: [],
            });
        },
    });
    const f = await fixture(t, relay);
    now = f.data.now;
    const config = await f.keeper.configure(request(f.binding, 'wind-above'), device);
    remote = { ...wakeCloudContext(config, f.keeper.instance), rulesDigest: 'e'.repeat(64) };
    await f.keeper.tick();
    await relay.settled();
    assert.equal((await f.keeper.status(device)).push.conflict?.revision, cloudRevision);
    const review = {
        schema: 1 as const,
        expectedRevision: config.revision,
        rulesDigest: config.rulesDigest,
        binding: f.binding,
        expectedContextRevision: cloudRevision,
    };
    await assert.rejects(
        f.keeper.reviewRelay({ ...review, expectedRevision: '00000000-0000-4000-8000-000000000099' }, device),
        { code: 'conflict' },
    );
    await assert.rejects(
        f.keeper.reviewRelay(
            { ...review, binding: { ...f.binding, deviceId: '00000000-0000-4000-8000-000000000099' } },
            device,
        ),
        { code: 'binding' },
    );
    assert.equal(
        calls.some((c) => c.action === 'bind'),
        false,
    );
    const second = { ...device, id: '00000000-0000-4000-8000-000000000077' };
    f.data.devices.push(second);
    const b = {
        ...review,
        binding: { ...f.binding, deviceId: second.id, enrollmentRevision: wakeEnrollmentRevision(second) },
    };
    assert.deepEqual(await f.keeper.reviewRelay(b, second), { schema: 1, accepted: true });
    await relay.settled();
    assert.equal(relay.status().state, 'ready');
    assert.equal(calls.filter((c) => c.action === 'bind').length, 1);
    assert.deepEqual((calls.find((c) => c.action === 'bind')!.context as WakeCloudContext).binding, config.binding);
});
test('defaults OFF; read endpoints never poll source; phone and Pi evaluate exactly the same original reading', async (t) => {
    const f = await fixture(t),
        { keeper, data, binding } = f;
    let status = await keeper.status(device);
    assert.equal(status.configured, false);
    assert.equal(status.proof, null);
    assert.equal(status.reason, 'off');
    const before = data.reads;
    const sensor = (await keeper.sensors(device)).options.find((o) => o.preset === 'wind-above')!;
    assert.equal(sensor.reading?.at, data.now);
    assert.equal(data.reads, before);
    const body = request(binding, 'wind-above');
    const config = await keeper.configure(body, device);
    status = await keeper.status(device);
    assert.equal(status.proof, null);
    data.now += 1000;
    data.document = f.wind();
    await keeper.tick();
    status = await keeper.status(device);
    assert.equal(status.rules.find((r) => r.preset === 'wind-above')?.status, 'pending');
    const reading = (await keeper.sensors(device)).options.find((o) => o.preset === 'wind-above')!.reading;
    assert.deepEqual(
        status.rules.find((r) => r.preset === 'wind-above')?.lastAt,
        evaluateWakeRule(config.rules[1], initialWakeState(), reading, data.now).state.lastAt,
    );
    assert.equal(status.proof?.rulesDigest, body.rulesDigest);
    assert.deepEqual(status.proof?.binding, binding);
    const last = data.now;
    data.now += 10_000;
    await keeper.tick();
    status = await keeper.status(device);
    assert.equal(status.rules[1].active, false);
    assert.equal(status.rules[1].lastAt, last);
    data.document = f.wind();
    await keeper.tick();
    assert.equal((await keeper.status(device)).rules[1].active, true);
    assert.deepEqual(status.push, { state: 'unavailable', capability: 0 });
});
test('stale neither fires nor clears active state; proof expires without a poll, backwards wall clock cannot keep old green', async (t) => {
    const f = await fixture(t);
    const body = request(f.binding, 'wind-above');
    body.rules[1].minimumDurationMs = 0;
    body.rulesDigest = wakeHash(wakeRulesCanonical(body.rules, 2));
    await f.keeper.configure(body, device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    let status = await f.keeper.status(device);
    assert.equal(status.rules[1].active, true);
    assert.ok(status.proof);
    f.data.now -= 100;
    assert.equal((await f.keeper.status(device)).proof, null);
    f.data.now += 14_100;
    status = await f.keeper.status(device);
    assert.equal(status.proof, null);
    assert.equal(status.rules[1].status, 'unknown');
    assert.equal(status.rules[1].active, true);
    assert.equal(status.rules[1].value, null);
    f.data.document = null;
    await f.keeper.tick();
    status = await f.keeper.status(device);
    assert.equal(status.rules[1].active, true);
    assert.equal(status.rules[1].status, 'unknown');
    f.data.document = f.wind(1);
    await f.keeper.tick();
    assert.equal((await f.keeper.status(device)).rules[1].active, true);
    f.data.now += 31_000;
    f.data.document = f.wind(1);
    await f.keeper.tick();
    // A missing source interval cannot count towards the clear duration.
    assert.equal((await f.keeper.status(device)).rules[1].active, true);
});
test('process restart and stopped-loop restart require a new postboot original measurement, no persisted active/proof', async (t) => {
    const f = await fixture(t);
    await f.keeper.configure(request(f.binding, 'wind-above'), device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    assert.ok((await f.keeper.status(device)).proof);
    f.keeper.stop();
    const restarted = new PiWakeKeeper(f.deps);
    t.after(() => restarted.stop());
    await restarted.start(false);
    await restarted.tick();
    assert.equal((await restarted.status(device)).proof, null);
    assert.equal((await restarted.status(device)).rules[1].active, false);
    f.data.now += 1000;
    f.data.document = f.wind();
    await restarted.tick();
    assert.ok((await restarted.status(device)).proof);
    restarted.stop();
    await restarted.start(false);
    await restarted.tick();
    assert.equal((await restarted.status(device)).proof, null);
});
test('owner/pair/feed/enrollment change retires pending state, catalogue and proof; late old-document work cannot commit', async (t) => {
    const f = await fixture(t);
    await f.keeper.configure(request(f.binding, 'wind-above'), device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    assert.ok((await f.keeper.status(device)).proof);
    let release!: (value: unknown) => void;
    const deferred = new Promise<unknown>((r) => {
        release = r;
    });
    f.data.block = () => deferred;
    const ticking = f.keeper.tick();
    await new Promise((r) => setTimeout(r, 5));
    f.data.identity = { ...pair, ownerId: '00000000-0000-4000-8000-000000000004' };
    assert.equal((await f.keeper.status(device)).configuration, null);
    release(f.wind());
    await ticking;
    assert.deepEqual((await f.keeper.sensors(device)).options, []);
    assert.equal((await f.keeper.status(device)).proof, null);
    f.data.block = null;
    f.data.identity = { ...pair };
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    f.data.devices = [];
    const status = await f.keeper.status(device);
    assert.equal(status.proof, null);
    assert.equal(status.reason, 'binding-changed');
    assert.deepEqual((await f.keeper.sensors(device)).options, []);
});
test('different verified vessel feed cannot reuse old selection/profile; offline explicit stand-down remains possible', async (t) => {
    const f = await fixture(t),
        config = await f.keeper.configure(request(f.binding, 'wind-above'), device);
    f.data.now += 1000;
    f.data.document = { ...f.wind(), uuid: 'urn:mrn:imo:mmsi:000000002' };
    await f.keeper.tick();
    const status = await f.keeper.status(device);
    assert.equal(status.reason, 'binding-changed');
    assert.equal(status.proof, null);
    assert.notEqual(status.binding?.feedId, f.binding.feedId);
    assert.equal(status.rules.length, 0);
    await assert.rejects(f.keeper.configure(request(f.binding, 'wind-above', config.revision), device), {
        code: 'binding',
    });
    f.data.document = null;
    await f.keeper.clear(
        { schema: 1, binding: f.binding, expectedRevision: config.revision, rulesDigest: config.rulesDigest },
        device,
    );
    assert.equal((await f.keeper.status(device)).configured, false);
});
test('real measured pressure warms over bounded minutes, retains current leaf, resets on physical source change', async (t) => {
    const f = await fixture(t);
    f.data.now += 1000;
    f.data.document = f.pressure();
    await f.keeper.tick();
    let sensors = await f.keeper.sensors(device);
    assert.equal(sensors.pressure.state, 'warming');
    assert.equal(sensors.options.find((o) => o.preset === 'pressure-fall')?.reading, null);
    for (let i = 1; i <= 190; i++) {
        f.data.now += 60_000;
        f.data.document = f.pressure(101000 - i * 3);
        await f.keeper.tick();
    }
    sensors = await f.keeper.sensors(device);
    assert.equal(sensors.pressure.state, 'ready');
    assert.equal(sensors.pressure.sampleCount, 191);
    assert.ok(sensors.pressure.spanMs >= 3 * 3_600_000);
    const reading = sensors.options.find((o) => o.preset === 'pressure-fall')!.reading!;
    assert.equal(reading.at, f.data.now);
    assert.ok(reading.value > 4 && reading.value < 7);
    for (let i = 0; i < 100; i++) {
        f.data.now += 10;
        f.data.document = f.pressure(100400);
        await f.keeper.tick();
    }
    sensors = await f.keeper.sensors(device);
    assert.equal(sensors.pressure.sampleCount, 191);
    assert.equal(sensors.pressure.state, 'ready');
    f.data.now += 1000;
    f.data.document = f.pressure(100400, 'fictional.other');
    await f.keeper.tick();
    sensors = await f.keeper.sensors(device);
    assert.equal(sensors.pressure.state, 'warming');
    assert.equal(sensors.pressure.sampleCount, 1);
});
test('enabled selection must be from a current qualified fixed source; failed CAS never overwrites saved config', async (t) => {
    const f = await fixture(t),
        bad = request(f.binding, 'wind-above');
    bad.rules[1].selection!.sensorId = 'not-present';
    bad.rulesDigest = wakeHash(wakeRulesCanonical(bad.rules, 2));
    await assert.rejects(f.keeper.configure(bad, device), { code: 'binding' });
    const config = await f.keeper.configure(request(f.binding), device);
    await assert.rejects(f.keeper.configure(request(f.binding), device), { code: 'conflict' });
    assert.equal((await f.store.load())?.revision, config.revision);
    await assert.rejects(
        f.keeper.clear(
            { schema: 1, binding: f.binding, expectedRevision: config.revision, rulesDigest: '0'.repeat(64) },
            device,
        ),
        { code: 'conflict' },
    );
});
test('unreadable enrollment is unknown rather than alarm clear; a later confirmed removal retires the profile', async (t) => {
    const f = await fixture(t),
        body = request(f.binding, 'wind-above');
    body.rules[1].minimumDurationMs = 0;
    body.rulesDigest = wakeHash(wakeRulesCanonical(body.rules, 2));
    await f.keeper.configure(body, device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    assert.equal((await f.keeper.status(device)).rules[1].active, true);
    f.data.enrollmentFailure = true;
    await f.keeper.tick();
    let status = await f.keeper.status(device);
    assert.equal(status.reason, 'storage-unavailable');
    assert.equal(status.proof, null);
    assert.equal(status.rules[1].active, true);
    assert.equal(status.rules[1].status, 'unknown');
    f.data.enrollmentFailure = false;
    f.data.devices = [];
    status = await f.keeper.status(device);
    assert.equal(status.reason, 'binding-changed');
    assert.deepEqual(status.rules, []);
});
test('an atomic external configuration revision is adopted on the next owned tick; old active evaluation is never persisted', async (t) => {
    const f = await fixture(t),
        body = request(f.binding, 'wind-above');
    body.rules[1].minimumDurationMs = 0;
    body.rulesDigest = wakeHash(wakeRulesCanonical(body.rules, 2));
    const old = await f.keeper.configure(body, device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    assert.equal((await f.keeper.status(device)).rules[1].active, true);
    const off = await f.store.configure(request(f.binding, undefined, old.revision), async () => true, f.data.now);
    await f.keeper.tick();
    const status = await f.keeper.status(device);
    assert.equal(status.configuration?.revision, off.revision);
    assert.equal(status.reason, 'off');
    assert.equal(status.proof, null);
    assert.equal(status.rules[1].active, false);
});
test('another currently enrolled phone can review/replace/clear the same owner/pair/feed using exact CAS and its own enrollment', async (t) => {
    const f = await fixture(t),
        other = {
            ...device,
            id: '00000000-0000-4000-8000-000000000004',
            enrolledAt: new Date(start - 30_000).toISOString(),
        };
    f.data.devices.push(other);
    const a = await f.keeper.configure(request(f.binding, 'wind-above'), device);
    const b = (await f.keeper.sensors(other)).binding!;
    assert.equal(b.deviceId, other.id);
    const seen = await f.keeper.status(other);
    assert.equal(seen.configuration?.binding.deviceId, device.id);
    assert.equal(seen.binding?.deviceId, other.id);
    const clear = { schema: 1 as const, expectedRevision: a.revision, binding: b, rulesDigest: a.rulesDigest };
    await assert.rejects(f.keeper.clear({ ...clear, expectedRevision: null }, other), { code: 'conflict' });
    await assert.rejects(f.keeper.clear({ ...clear, rulesDigest: '0'.repeat(64) }, other), { code: 'conflict' });
    await assert.rejects(f.keeper.clear({ ...clear, binding: { ...b, feedId: b.feedId.replace(/.$/, '0') } }, other), {
        code: 'conflict',
    });
    await assert.rejects(
        f.keeper.clear(
            {
                ...clear,
                binding: {
                    ...b,
                    enrollmentRevision: wakeEnrollmentRevision({ ...other, enrolledAt: new Date(start).toISOString() }),
                },
            },
            other,
        ),
        { code: 'binding' },
    );
    await assert.rejects(f.keeper.clear({ ...clear, binding: f.binding }, other), { code: 'binding' });
    for (const altered of [
        { ...b, ownerId: '00000000-0000-4000-8000-000000000099' },
        {
            ...b,
            piDeviceId: '00000000-0000-4000-8000-000000000098',
            feedId: 'pi:00000000-0000-4000-8000-000000000098:' + 'a'.repeat(24),
        },
        { ...b, pairingId: 'b'.repeat(64) },
    ])
        await assert.rejects(f.keeper.clear({ ...clear, binding: altered }, other), { code: 'binding' });
    await f.keeper.clear(clear, other);
    assert.equal(await f.store.load(), null);
    const armedAgain = await f.keeper.configure(request(f.binding, 'wind-above'), device);
    const replacement = await f.keeper.configure(request(b, undefined, armedAgain.revision), other);
    assert.equal(replacement.binding.deviceId, other.id);
    f.data.devices = f.data.devices.filter((d) => d.id !== other.id);
    await assert.rejects(
        f.keeper.clear(
            { schema: 1, expectedRevision: replacement.revision, binding: b, rulesDigest: replacement.rulesDigest },
            other,
        ),
        { code: 'binding' },
    );
    assert.equal((await f.store.load())?.revision, replacement.revision);
});
test('a rejected CAS cannot clear an existing active rule or restart its confirmation history', async (t) => {
    const f = await fixture(t),
        body = request(f.binding, 'wind-above');
    body.rules[1].minimumDurationMs = 0;
    body.rulesDigest = wakeHash(wakeRulesCanonical(body.rules, 2));
    const saved = await f.keeper.configure(body, device);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    const before = await f.keeper.status(device);
    assert.equal(before.rules[1].active, true);
    await assert.rejects(f.keeper.configure({ ...body, expectedRevision: null }, device), { code: 'conflict' });
    let status = await f.keeper.status(device);
    assert.equal(status.rules[1].active, true);
    assert.equal(status.rules[1].lastAt, before.rules[1].lastAt);
    assert.equal(status.proof, null);
    await assert.rejects(
        f.keeper.clear(
            { schema: 1, expectedRevision: null, binding: f.binding, rulesDigest: saved.rulesDigest },
            device,
        ),
        { code: 'conflict' },
    );
    status = await f.keeper.status(device);
    assert.equal(status.rules[1].active, true);
    assert.equal(status.configuration?.revision, saved.revision);
    f.data.now += 1000;
    f.data.document = f.wind();
    await f.keeper.tick();
    assert.equal((await f.keeper.status(device)).rules[1].active, true);
    assert.ok((await f.keeper.status(device)).proof);
});
