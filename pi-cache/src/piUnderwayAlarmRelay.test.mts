import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PiUnderwayAlarmRelay,
    UNDERWAY_RELAY_MAX_BACKOFF_MS,
    UNDERWAY_RELAY_PROBE_MS,
    UNDERWAY_RELAY_READY_MS,
    wireUnderwayAlarm,
    type PiUnderwayAlarm,
    type PiUnderwayPass,
} from './piUnderwayAlarmRelay.js';

const START = 1_795_000_000_000;
const alarm = (kind: PiUnderwayAlarm['kind'] = 'off-route', at = START): PiUnderwayAlarm => ({
    key: `${kind}::${at}`,
    kind,
    raisedAt: at,
    ackedAt: null,
});
type Answer = Record<string, unknown>;
type Pending = { resolve: (value: Answer) => void; promise: Promise<Answer> };
function pending(): Pending {
    let resolve!: Pending['resolve'];
    const promise = new Promise<Answer>((done) => (resolve = done));
    return { resolve, promise };
}
function fixture() {
    let now = START;
    let internet = true;
    let credential: { relayId: string; token: string } | null = { relayId: 'boat-a', token: 'test-only-token' };
    let timeoutMs = 8_000;
    const requests: { body: Answer; signal: AbortSignal; url: string; headers: Answer }[] = [];
    let respond: (body: Answer) => Answer | Promise<Answer> = (body) =>
        body.action === 'probe' ? { ok: true, devices: 1, underway: { v: 1, enabled: true } } : { ok: true, acked: [] };
    const relay = new PiUnderwayAlarmRelay({
        endpoint: 'https://project.test/functions/v1/pi-alarm-relay',
        fetchImpl: async (url, init = {}) => {
            const body = JSON.parse(init.body as string) as Answer;
            requests.push({ body, signal: init.signal as AbortSignal, url, headers: init.headers as Answer });
            return { ok: true, status: 200, json: async () => await respond(body) };
        },
        credentials: () => credential,
        anonKey: () => 'public-test-key',
        internetAllowed: () => internet,
        ownerId: () => 'owner-a',
        now: () => now,
        utcOffsetMin: () => 600,
        get timeoutMs() {
            return timeoutMs;
        },
    });
    return {
        relay,
        requests,
        advance: (ms: number) => (now += ms),
        setInternet: (allowed: boolean) => (internet = allowed),
        setCredential: (value: typeof credential) => (credential = value),
        setTimeout: (value: number) => (timeoutMs = value),
        setResponse: (fn: typeof respond) => (respond = fn),
        async pass(description: PiUnderwayPass, ack: (key: string) => void = () => undefined) {
            relay.afterPass(description, ack);
            await relay.whenIdle();
        },
    };
}
const turns = async () => {
    for (let n = 0; n < 15; n++) await Promise.resolve();
};

test('old AIS probes, false and unknown capability never enable underway sends', async () => {
    for (const capability of [
        undefined,
        { v: 1, enabled: false },
        { v: 2, enabled: true },
        { v: 1, enabled: 'true' },
    ]) {
        const f = fixture();
        f.setResponse(() => ({ ok: true, devices: 1, ...(capability ? { underway: capability } : {}) }));
        await f.pass({ armed: true, alarms: [alarm()] });
        assert.equal(f.relay.status().state, 'unavailable');
        assert.equal(await f.relay.raise(alarm()), 'unavailable');
        assert.deepEqual(
            f.requests.map((r) => r.body.action),
            ['probe'],
        );
        assert.equal(f.requests[0].body.family, 'underway');
    }
});

test('explicit version-one capability requires phones before claiming ready', async () => {
    const f = fixture();
    f.setResponse(() => ({ ok: true, devices: 0, underway: { v: 1, enabled: true } }));
    assert.equal(await f.relay.probe(), 'unavailable');
    assert.deepEqual(f.relay.status().underway, { v: 1, enabled: true });
    f.setResponse(() => ({ ok: true, devices: 2, underway: { v: 1, enabled: true } }));
    assert.equal(await f.relay.probe(), 'ready');
});

test('wire and request allowlists keep every chart fact and MMSI aboard', async () => {
    const f = fixture();
    const evidence = { ...alarm(), mmsi: 123456789, name: 'Secret cell', lat: 20, depthM: 1, etaMs: START + 30_000 };
    assert.deepEqual(wireUnderwayAlarm(evidence, START), {
        key: evidence.key,
        kind: 'off-route',
        acked_ms_ago: null,
    });
    await f.relay.probe();
    assert.equal(await f.relay.raise(evidence), 'sent');
    f.advance(15_000);
    await f.pass({ armed: true, alarms: [evidence, alarm('chart-ahead')] });
    for (const request of f.requests) {
        assert.equal(request.body.family, 'underway');
        assert.equal(request.body.utc_offset_min, 600);
        assert.equal(request.url, 'https://project.test/functions/v1/pi-alarm-relay');
        assert.equal(request.headers['X-Thalassa-Pi-Relay-Token'], 'test-only-token');
        const body = JSON.stringify(request.body);
        for (const field of ['mmsi', 'Secret cell', 'lat', 'depthM', 'etaMs'])
            assert.equal(body.includes(field), false);
    }
    assert.deepEqual(
        f.requests.map((r) => r.body.action),
        ['probe', 'raise', 'sync'],
    );
});

test('raises are fresh, one-shot, not queued; a later sync recovers an open event', async () => {
    const f = fixture();
    await f.relay.probe();
    f.setResponse(() => {
        throw new Error('offline');
    });
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    assert.equal(f.relay.status().state, 'unavailable');
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    assert.equal(f.requests.filter((r) => r.body.action === 'raise').length, 1);
    f.advance(31_000);
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    assert.equal(f.requests.filter((r) => r.body.action === 'raise').length, 1);
    f.setResponse(() => ({ ok: true, acked: [] }));
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.at(-1)!.body.action, 'sync');
    assert.equal((f.requests.at(-1)!.body.alarms as Answer[])[0].key, alarm().key);
});

test('sync cadence distinguishes sounding and acknowledged encounters; probe remains hourly', async () => {
    const f = fixture();
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, 2);
    f.advance(14_999);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, 2);
    f.advance(1);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, 3);
    const acked = { ...alarm(), ackedAt: START + 15_000 };
    f.advance(59_999);
    await f.pass({ armed: true, alarms: [acked] });
    assert.equal(f.requests.length, 3);
    f.advance(1);
    await f.pass({ armed: true, alarms: [acked] });
    assert.equal(f.requests.length, 4);
    f.advance(5 * 60_000);
    await f.pass({ armed: true, alarms: [acked] });
    assert.equal(f.requests.filter((r) => r.body.action === 'probe').length, 1);
    f.advance(UNDERWAY_RELAY_PROBE_MS);
    await f.pass({ armed: true, alarms: [acked] });
    assert.equal(f.requests.filter((r) => r.body.action === 'probe').length, 2);
});

test('failures back syncs off rather than storming the relay', async () => {
    const f = fixture();
    await f.pass({ armed: true, alarms: [alarm()] });
    f.setResponse(() => {
        throw new Error('unreachable');
    });
    f.advance(15_000);
    await f.pass({ armed: true, alarms: [alarm()] });
    const firstFailure = f.requests.length;
    f.advance(29_999);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, firstFailure);
    f.advance(1);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, firstFailure + 1);
    f.advance(59_999);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, firstFailure + 1);
    f.advance(1);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, firstFailure + 2);
    f.advance(UNDERWAY_RELAY_MAX_BACKOFF_MS);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(f.requests.length, firstFailure + 3);
});

test('only exact open encounter acknowledgements apply, once until clear', async () => {
    const f = fixture();
    const a = alarm();
    const acks: string[] = [];
    f.setResponse((body) =>
        body.action === 'probe'
            ? { ok: true, devices: 1, underway: { v: 1, enabled: true } }
            : { ok: true, acked: [a.key, 'collision:123456789:1795000000000', 'off-route::1795000000001'] },
    );
    await f.pass({ armed: true, alarms: [a] }, (key) => acks.push(key));
    f.advance(15_000);
    await f.pass({ armed: true, alarms: [a] }, (key) => acks.push(key));
    assert.deepEqual(acks, [a.key]);
    await f.pass({ armed: false, alarms: [] }, (key) => acks.push(key));
    assert.deepEqual(f.requests.at(-1)!.body.alarms, []);
});

test('stand-down during an in-flight sync closes only underway and ignores its stale ack', async () => {
    const f = fixture();
    const wait = pending();
    const acks: string[] = [];
    let syncs = 0;
    f.setResponse((body) => {
        if (body.action === 'probe') return { ok: true, devices: 1, underway: { v: 1, enabled: true } };
        return ++syncs === 1 ? wait.promise : { ok: true, acked: [] };
    });
    f.relay.afterPass({ armed: true, alarms: [alarm()] }, (key) => acks.push(key));
    await turns();
    assert.equal(syncs, 1);
    f.relay.afterPass({ armed: false, alarms: [] }, (key) => acks.push(key));
    wait.resolve({ ok: true, acked: [alarm().key] });
    await f.relay.whenIdle();
    assert.deepEqual(acks, []);
    assert.deepEqual(
        f.requests.filter((r) => r.body.action === 'sync').map((r) => r.body.alarms),
        [[wireUnderwayAlarm(alarm(), START)], []],
    );
    assert.ok(f.requests.every((r) => r.body.family === 'underway'));
    await f.pass({ armed: false, alarms: [] });
    assert.equal(syncs, 2);
});

test('a replacement encounter cannot inherit an old ack and syncs without waiting the old cadence', async () => {
    const f = fixture();
    const wait = pending();
    const next = alarm('off-route', START + 1);
    const acks: string[] = [];
    let syncs = 0;
    f.setResponse((body) => {
        if (body.action === 'probe') return { ok: true, devices: 1, underway: { v: 1, enabled: true } };
        return ++syncs === 1 ? wait.promise : { ok: true, acked: [] };
    });
    f.relay.afterPass({ armed: true, alarms: [alarm()] }, (key) => acks.push(key));
    await turns();
    f.relay.afterPass({ armed: true, alarms: [next] }, (key) => acks.push(key));
    wait.resolve({ ok: true, acked: [alarm().key] });
    await f.relay.whenIdle();
    assert.deepEqual(acks, []);
    assert.equal(syncs, 2);
    assert.equal((f.requests.at(-1)!.body.alarms as Answer[])[0].key, next.key);
});

test('acknowledged state travels as bounded age; neither kind carries another family', async () => {
    const f = fixture();
    const old = { ...alarm(), ackedAt: START - 48 * 60 * 60_000 };
    await f.pass({ armed: true, alarms: [old, alarm('chart-ahead')] });
    const wire = f.requests.at(-1)!.body.alarms as Answer[];
    assert.equal(wire[0].acked_ms_ago, 24 * 60 * 60_000);
    assert.equal(wire[1].acked_ms_ago, null);
    assert.equal(wireUnderwayAlarm({ ...alarm(), key: 'collision:123456789:1795000000000' }, START), null);
    assert.equal(wireUnderwayAlarm({ ...alarm(), raisedAt: START + 1 }, START), null);
});

test('internet policy and missing pairing make no request; changed credentials invalidate readiness', async () => {
    const f = fixture();
    f.setInternet(false);
    await f.pass({ armed: true, alarms: [alarm()] });
    assert.equal(await f.relay.raise(alarm()), 'internet-off');
    assert.equal(f.requests.length, 0);
    f.setInternet(true);
    f.setCredential(null);
    assert.equal(await f.relay.probe(), 'not-paired');
    assert.equal(f.relay.status().ownerId, null);
    assert.equal(f.requests.length, 0);
    f.setCredential({ relayId: 'boat-a', token: 'test-only-token' });
    assert.equal(await f.relay.probe(), 'ready');
    f.setCredential({ relayId: 'boat-b', token: 'other-test-token' });
    assert.equal(f.relay.status().state, 'unavailable');
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    assert.equal(f.requests.length, 1);
});

test('expired capability and clocks moving backwards never claim readiness', async () => {
    const f = fixture();
    await f.relay.probe();
    f.advance(UNDERWAY_RELAY_READY_MS + 1);
    assert.equal(f.relay.status().state, 'unavailable');
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    const other = fixture();
    await other.relay.probe();
    other.advance(-1);
    assert.equal(other.relay.status().state, 'unavailable');
});

test('a non-aborting transport/body reader still has a bounded deadline and one request at a time', async () => {
    const f = fixture();
    f.setTimeout(250);
    f.setResponse(() => new Promise<Answer>(() => undefined));
    const first = f.relay.probe();
    await turns();
    assert.equal(await f.relay.raise(alarm()), 'unavailable');
    assert.equal(await f.relay.probe(), 'unavailable');
    assert.equal(f.requests.length, 1);
    assert.equal(await first, 'unavailable');
    assert.equal(f.requests[0].signal.aborted, true);
});

test('restart with no armed watch closes only stale underway encounters after capability proof', async () => {
    const f = fixture();
    await f.pass({ armed: false, alarms: [] });
    assert.deepEqual(
        f.requests.map((r) => r.body.action),
        ['probe', 'sync'],
    );
    assert.deepEqual(f.requests[1].body.alarms, []);
    assert.ok(f.requests.every((r) => r.body.family === 'underway'));
});
