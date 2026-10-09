/**
 * The Pi keeps the night watch, part 2 (build 126, package 126-04b): the
 * Pi's alarm wakes the skipper's locked phone.
 *
 * The Pi has no Supabase user and holds no service key. It presents the
 * pairing credential the diary relay holds (lent, never logged) and the
 * public anon key to ONE endpoint, built from the process-startup trust
 * anchor: pi-alarm-relay, which queues the push for the Pi's owner. It obeys
 * the skipper's internet policy, sends each alarm once (no queue: a late
 * alarm is worse than none), keeps the relay's word in step every 15 s while
 * an alarm is open, and learns acknowledgements made ashore from the answer.
 * It says honestly whether it can wake a phone: 'ready' only after the relay
 * answered within the hour with a device to wake.
 *
 * Fictional: relay 'relay-kestrel-0001-fictional', Nordlicht 211000001, a
 * SART 970000003; the Solent and the Hauraki Gulf. Nothing touches a real Pi,
 * Supabase, the gateway or port 1456.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
    PI_ALARM_PROBE_EVERY_MS,
    PI_ALARM_SYNC_MS,
    PI_BLIND_NOTICE_AFTER_MS,
    PI_PUSH_READY_FOR_MS,
    PiAlarmRelay,
    canonicalPiAlarmRelayEndpoint,
    wireAlarm,
} from './piAlarmRelay.js';
import { AisNightWatch, type AisWatchAlarm, type AisWatchDescription } from './aisWatch.js';
import { createAisWatchRoutes } from './routes/aisWatch.js';
import { buildTelemetryBody } from './telemetryPublisher.js';

const ORIGIN = 'https://fictional-project.supabase.co';
const ENDPOINT = `${ORIGIN}/functions/v1/pi-alarm-relay`;
const RELAY = 'relay-kestrel-0001-fictional';
const TOKEN = 'f'.repeat(64);
const ANON = 'anon-public-key';
const OWNER = 'skipper-1';
const NORDLICHT = 211_000_001;
const SART = 970_000_003;
const T0 = Date.parse('2026-10-09T16:14:00Z');

interface Call {
    url: string;
    init: Record<string, unknown>;
    body: Record<string, unknown>;
}

function relayHarness(
    opts: {
        internet?: boolean;
        paired?: boolean;
        answer?: (
            body: Record<string, unknown>,
        ) => { status: number; json?: unknown } | 'hang' | Promise<{ status: number; json?: unknown }>;
        timeoutMs?: number;
    } = {},
) {
    let now = T0;
    let internet = opts.internet ?? true;
    const calls: Call[] = [];
    const answer =
        opts.answer ??
        ((body: Record<string, unknown>) =>
            body.action === 'probe' || body.action === 'test'
                ? { status: 200, json: { ok: true, devices: 1, queued: true } }
                : { status: 200, json: { ok: true, pushed: true, acked: [] } });
    const fetchImpl = (url: string, init: Record<string, unknown> = {}) => {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        calls.push({ url, init, body });
        const a = answer(body);
        if (a === 'hang') {
            return new Promise<never>((_resolve, reject) => {
                const signal = init.signal as AbortSignal | undefined;
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        }
        return Promise.resolve(a).then((r) => ({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => r.json ?? {},
            text: async () => JSON.stringify(r.json ?? {}),
        }));
    };
    const relay = new PiAlarmRelay({
        fetchImpl,
        endpoint: ENDPOINT,
        anonKey: () => ANON,
        credentials: () => ((opts.paired ?? true) ? { relayId: RELAY, token: TOKEN } : null),
        internetAllowed: () => internet,
        ownerId: () => ((opts.paired ?? true) ? OWNER : null),
        now: () => now,
        utcOffsetMin: () => 600,
        timeoutMs: opts.timeoutMs,
    });
    return {
        relay,
        calls,
        set internet(v: boolean) {
            internet = v;
        },
        advance(ms: number) {
            now += ms;
        },
        get now() {
            return now;
        },
    };
}

const alarm = (over: Partial<AisWatchAlarm> = {}): AisWatchAlarm => ({
    key: `collision:${NORDLICHT}:${T0}`,
    kind: 'collision',
    mmsi: NORDLICHT,
    name: 'NORDLICHT',
    cpaNm: 0.08,
    tcpaMin: 4.2,
    rangeNm: 1.62,
    bearingDeg: 312,
    lat: 50.8,
    lon: -1.17,
    raisedAt: T0,
    ackedAt: null,
    lost: null,
    ...over,
});

const described = (now: number, over: Partial<AisWatchDescription> = {}): AisWatchDescription => ({
    v: 1,
    state: 'armed',
    armed: true,
    armedAt: T0 - 60_000,
    lastPassAt: now,
    servedAt: now,
    atAnchor: false,
    own: 'moving',
    lastAisAt: now - 2_000,
    targets: 3,
    prefs: null,
    ownMmsi: 235_000_101,
    devices: 1,
    alarms: [],
    push: null,
    ...over,
});

const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

test('the endpoint comes from the trust anchor only', () => {
    assert.equal(canonicalPiAlarmRelayEndpoint(ORIGIN), ENDPOINT);
    assert.equal(canonicalPiAlarmRelayEndpoint(`${ORIGIN}/`), ENDPOINT);
    assert.throws(() => canonicalPiAlarmRelayEndpoint(`${ORIGIN}/elsewhere`));
});

test('the lent credential and the anon key go to the canonical endpoint, and nowhere else', async () => {
    const h = relayHarness();
    assert.equal(await h.relay.probe(), 'ready');
    const [call] = h.calls;
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, {
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
        'X-Thalassa-Pi-Relay-Id': RELAY,
        'X-Thalassa-Pi-Relay-Token': TOKEN,
    });
    assert.ok(call.init.signal instanceof AbortSignal, 'every request is bounded');
    assert.deepEqual(call.body, { action: 'probe', utc_offset_min: 600 });
    assert.ok(!JSON.stringify(call.body).includes(TOKEN), 'the token travels in its header only');

    await h.relay.raise(alarm());
    await h.relay.sync([alarm()]);
    await h.relay.test();
    assert.deepEqual(
        h.calls.map((c) => c.url),
        [ENDPOINT, ENDPOINT, ENDPOINT, ENDPOINT],
    );
    assert.deepEqual(
        h.calls.map((c) => c.body.action),
        ['probe', 'raise', 'sync', 'test'],
    );
});

test('a raise carries the bounded numbers and the name, capped; nothing else', async () => {
    const h = relayHarness();
    await h.relay.raise(alarm({ name: 'N'.repeat(90) }));
    const sent = h.calls[0].body.alarm as Record<string, unknown>;
    assert.deepEqual(sent, {
        key: `collision:${NORDLICHT}:${T0}`,
        kind: 'collision',
        mmsi: NORDLICHT,
        name: 'N'.repeat(40),
        cpa_nm: 0.08,
        tcpa_min: 4.2,
        range_nm: 1.62,
        bearing_deg: 312,
        lat: 50.8,
        lon: -1.17,
        lost: null,
        acked_ms_ago: null,
    });
    const sart = wireAlarm(
        alarm({
            key: `distress:${SART}:${T0}`,
            kind: 'distress',
            mmsi: SART,
            name: '',
            cpaNm: null,
            tcpaMin: null,
            lat: -36.75,
            lon: 174.95,
            distressKind: 'sart',
            positionKnown: true,
            ackedAt: T0 - 5_000,
        }),
        T0,
    );
    assert.equal(sart.distress_kind, 'sart');
    assert.equal(sart.position_known, true);
    assert.equal(sart.acked_ms_ago, 5_000);
});

test('internet use off on the Pi: no request at all, and it says so', async () => {
    const h = relayHarness({ internet: false });
    assert.equal(await h.relay.probe(), 'internet-off');
    assert.equal(await h.relay.raise(alarm()), 'internet-off');
    assert.equal(await h.relay.sync([alarm()]), null);
    assert.deepEqual(await h.relay.test(), { push: 'internet-off', queued: false });
    assert.equal(h.calls.length, 0);
    assert.equal(h.relay.status().state, 'internet-off');
    h.internet = true;
    assert.equal(h.relay.status().state, 'unavailable', 'not ready until the relay has answered');
});

test('not paired: no request, and it says so', async () => {
    const h = relayHarness({ paired: false });
    assert.equal(await h.relay.probe(), 'not-paired');
    assert.equal(await h.relay.raise(alarm()), 'not-paired');
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.relay.status(), { state: 'not-paired', checkedAt: null, ownerId: null });
});

test('ready only after an answer within the hour with a device to wake', async () => {
    const h = relayHarness();
    assert.equal(h.relay.status().state, 'unavailable', 'never asked');
    await h.relay.probe();
    assert.deepEqual(h.relay.status(), { state: 'ready', checkedAt: T0, ownerId: OWNER });
    h.advance(PI_PUSH_READY_FOR_MS + 1);
    assert.equal(h.relay.status().state, 'unavailable', 'an old answer proves nothing now');

    const none = relayHarness({ answer: () => ({ status: 200, json: { ok: true, devices: 0 } }) });
    assert.equal(await none.relay.probe(), 'unavailable', 'no phone registered to wake');
    const refused = relayHarness({ answer: () => ({ status: 401, json: { error: 'unauthorised' } }) });
    assert.equal(await refused.relay.probe(), 'unavailable');
});

test('a timeout is unavailable: the alarm is dropped, never queued, never retried in a storm', async () => {
    const h = relayHarness({ answer: () => 'hang', timeoutMs: 30 });
    await h.relay.probe();
    h.calls.length = 0;
    assert.equal(await h.relay.raise(alarm()), 'unavailable');
    assert.equal(h.calls.length, 1, 'one attempt');
    assert.equal(h.relay.status().state, 'unavailable');
    // The next passes: one sync when due, then backing off while the relay stays silent.
    const open = [alarm()];
    for (let i = 0; i < 24; i += 1) {
        h.advance(5_000);
        h.relay.afterPass(described(h.now, { alarms: open }), () => undefined);
        await settle();
        await new Promise((r) => setTimeout(r, 35));
    }
    // Two minutes of passes: at 15 s a sync would be 8; with backoff it is far fewer.
    const syncs = h.calls.filter((c) => c.body.action === 'sync').length;
    assert.ok(syncs >= 1 && syncs <= 4, `syncs: ${syncs}`);
    assert.equal(h.calls.filter((c) => c.body.action === 'raise').length, 1, 'the raise was not repeated');
});

test('an acknowledgement made ashore comes back in the sync answer and is applied like one aboard', async () => {
    const acked = alarm({ key: `collision:366000002:${T0}`, mmsi: 366_000_002, ackedAt: T0 - 1_000 });
    const h = relayHarness({
        answer: (body) =>
            body.action === 'sync'
                ? { status: 200, json: { ok: true, acked: [`collision:${NORDLICHT}:${T0}`, acked.key], pushed: 0 } }
                : { status: 200, json: { ok: true, devices: 1 } },
    });
    const applied: Array<[string, number]> = [];
    h.relay.afterPass(described(h.now, { alarms: [alarm(), acked] }), (kind, mmsi) => applied.push([kind, mmsi]));
    await settle();
    assert.deepEqual(
        applied,
        [['collision', NORDLICHT]],
        'only the one still sounding here: an acknowledged DANGER is never muted afresh',
    );
});

test('an acknowledgement answered for an alarm that began sounding again after the sync was built is not applied', async () => {
    // 02:44: Nordlicht's mute (acknowledged aboard at 02:14) is a breath from
    // running out when a sync goes, saying so. While it is out, the mute runs
    // out on the watch and she sounds again. The relay's answer still lists
    // her as acknowledged: that word is about the old mute, never a new one.
    let release: (r: { status: number; json?: unknown }) => void = () => undefined;
    const h = relayHarness({
        answer: (body) =>
            body.action === 'sync'
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : { status: 200, json: { ok: true, devices: 1 } },
    });
    const applied: number[] = [];
    const muted = alarm({ ackedAt: T0 - 30 * 60_000 + 500 });
    h.relay.afterPass(described(h.now, { alarms: [muted] }), (_kind, mmsi) => applied.push(mmsi));
    await settle();
    assert.equal(h.calls.filter((c) => c.body.action === 'sync').length, 1, 'the sync is out');
    // The watch lets the mute go now: what the next pass would describe.
    h.advance(5_000);
    release({ status: 200, json: { ok: true, acked: [muted.key], pushed: 0 } });
    await settle();
    assert.deepEqual(applied, [], 'never muted afresh by an answer about the old mute');
});

test('a stand-down reaches the relay: the closing sync goes, and the next arm is probed again', async () => {
    const h = relayHarness();
    let t = h.now;
    const watch = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: t }),
        atAnchor: () => false,
        now: () => t,
        onPass: (d) => h.relay.afterPass(d, (kind, mmsi) => void watch.ack(kind, mmsi)),
        pushStatus: () => h.relay.status(),
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    watch.arm(null);
    await watch.passOnce();
    await settle();
    assert.equal(h.calls.filter((c) => c.body.action === 'probe').length, 1, 'probed at arm time');
    // The relay has Nordlicht open (a pass that published her).
    h.advance(PI_ALARM_SYNC_MS);
    t = h.now;
    h.relay.afterPass(described(h.now, { alarms: [alarm()] }), () => undefined);
    await settle();
    h.calls.length = 0;
    // Someone aboard stands the watch down for everyone.
    h.advance(5_000);
    t = h.now;
    watch.disarm({ everyone: true });
    await settle();
    const syncs = h.calls.filter((c) => c.body.action === 'sync');
    assert.equal(syncs.length, 1, 'the closing sync');
    assert.deepEqual(syncs[0].body.alarms, []);
    // Armed again within the hour: probed again, as at any arm.
    h.advance(60_000);
    t = h.now;
    watch.arm(null);
    await watch.passOnce();
    await settle();
    assert.equal(h.calls.filter((c) => c.body.action === 'probe').length, 1, 'probed at the new arm');
});

test('a stand-down while a sync is out: the closing sync goes when it is back', async () => {
    let release: (r: { status: number; json?: unknown }) => void = () => undefined;
    let first = true;
    const h = relayHarness({
        answer: (body) => {
            if (body.action !== 'sync') return { status: 200, json: { ok: true, devices: 1 } };
            if (!first) return { status: 200, json: { ok: true, acked: [] } };
            first = false;
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    });
    h.relay.afterPass(described(h.now, { alarms: [alarm()] }), () => undefined);
    await settle();
    h.advance(5_000);
    h.relay.afterPass(described(h.now, { armed: false, state: 'off', alarms: [] }), () => undefined);
    await settle();
    assert.equal(h.calls.filter((c) => c.body.action === 'sync').length, 1, 'one at a time');
    release({ status: 200, json: { ok: true, acked: [] } });
    await settle();
    const syncs = h.calls.filter((c) => c.body.action === 'sync');
    assert.equal(syncs.length, 2, 'the closing sync, once the first is back');
    assert.deepEqual(syncs[1].body.alarms, []);
});

test('an alarm naming an MMSI no radio sends never goes to the relay, and never costs the others', async () => {
    const h = relayHarness();
    const bad = alarm({ key: `close-quarters:12345:${T0}`, kind: 'close-quarters', mmsi: 12_345 });
    assert.equal(await h.relay.raise(bad), 'unavailable');
    assert.equal(h.calls.length, 0, 'not raised');
    h.relay.afterPass(described(h.now, { alarms: [bad, alarm()] }), () => undefined);
    await settle();
    const sync = h.calls.find((c) => c.body.action === 'sync');
    assert.ok(sync);
    assert.deepEqual(
        (sync.body.alarms as Array<{ mmsi: number }>).map((a) => a.mmsi),
        [NORDLICHT],
    );
});

test('a push the relay holds for its hourly cap is said in the log, once per run', async () => {
    const h = relayHarness({
        answer: (body) =>
            body.action === 'raise'
                ? { status: 200, json: { ok: true, pushed: false, acked: false, held: 'hourly' } }
                : { status: 200, json: { ok: true, acked: [], pushed: 0, held: 1 } },
    });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
    try {
        await h.relay.raise(alarm());
        h.advance(PI_ALARM_SYNC_MS);
        h.relay.afterPass(described(h.now, { alarms: [alarm()] }), () => undefined);
        await settle();
    } finally {
        console.warn = warn;
    }
    assert.equal(warned.filter((w) => w.includes('hourly cap')).length, 1, warned.join(' | '));
});

test('sync: every 15 s while an alarm sounds, once more when the last one closes, then quiet', async () => {
    const h = relayHarness();
    const open = [alarm()];
    h.relay.afterPass(described(h.now, { alarms: open }), () => undefined);
    await settle();
    const syncs = () => h.calls.filter((c) => c.body.action === 'sync');
    assert.equal(syncs().length, 1);
    h.advance(5_000);
    h.relay.afterPass(described(h.now, { alarms: open }), () => undefined);
    await settle();
    assert.equal(syncs().length, 1, 'not every pass');
    h.advance(PI_ALARM_SYNC_MS);
    h.relay.afterPass(described(h.now, { alarms: open }), () => undefined);
    await settle();
    assert.equal(syncs().length, 2);
    h.advance(5_000);
    h.relay.afterPass(described(h.now, { alarms: [] }), () => undefined);
    await settle();
    assert.equal(syncs().length, 3, 'the closing sync resolves it on the relay');
    assert.deepEqual(syncs()[2].body.alarms, []);
    for (let i = 0; i < 10; i += 1) {
        h.advance(PI_ALARM_SYNC_MS);
        h.relay.afterPass(described(h.now, { alarms: [] }), () => undefined);
    }
    await settle();
    assert.equal(syncs().length, 3, 'nothing open: nothing sent');
});

test('probed when armed and hourly; never while disarmed', async () => {
    const h = relayHarness();
    const probes = () => h.calls.filter((c) => c.body.action === 'probe').length;
    h.relay.afterPass(described(h.now, { armed: false, state: 'off' }), () => undefined);
    await settle();
    assert.equal(probes(), 0);
    h.relay.afterPass(described(h.now), () => undefined);
    await settle();
    assert.equal(probes(), 1, 'at arm time');
    h.advance(PI_ALARM_PROBE_EVERY_MS - 5_000);
    h.relay.afterPass(described(h.now), () => undefined);
    await settle();
    assert.equal(probes(), 1);
    h.advance(5_000);
    h.relay.afterPass(described(h.now), () => undefined);
    await settle();
    assert.equal(probes(), 2, 'hourly');
});

test('blind for 10 min: one notice per silence; no position for 2 min: one notice', async () => {
    const h = relayHarness();
    const notices = () =>
        h.calls.filter((c) => c.body.action === 'raise').map((c) => c.body.alarm as Record<string, unknown>);
    const quietSince = h.now;
    const blind = () => described(h.now, { state: 'blind', lastAisAt: quietSince });
    h.relay.afterPass(blind(), () => undefined);
    h.advance(PI_BLIND_NOTICE_AFTER_MS - 5_000);
    h.relay.afterPass(blind(), () => undefined);
    await settle();
    assert.equal(notices().length, 0, 'a short silence offshore is not news');
    h.advance(5_000);
    h.relay.afterPass(blind(), () => undefined);
    await settle();
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].kind, 'blind');
    assert.equal(notices()[0].silent_min, 10);
    assert.match(String(notices()[0].key), /^blind::\d{13}$/);
    for (let i = 0; i < 20; i += 1) {
        h.advance(60_000);
        h.relay.afterPass(blind(), () => undefined);
    }
    await settle();
    assert.equal(notices().length, 1, 'one per silence');
    // A ship is heard: the silence is over. Quiet again for 10 min: a new notice.
    h.relay.afterPass(described(h.now), () => undefined);
    const again = h.now;
    h.advance(PI_BLIND_NOTICE_AFTER_MS);
    h.relay.afterPass(described(h.now, { state: 'blind', lastAisAt: again }), () => undefined);
    await settle();
    assert.equal(notices().length, 2);

    const fix = relayHarness();
    const lost = () => described(fix.now, { state: 'no-fix', own: 'no-fix' });
    fix.relay.afterPass(lost(), () => undefined);
    fix.advance(2 * 60_000);
    fix.relay.afterPass(lost(), () => undefined);
    await settle();
    const raised = fix.calls
        .filter((c) => c.body.action === 'raise')
        .map((c) => c.body.alarm as Record<string, unknown>);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].kind, 'no-fix');
    assert.equal(raised[0].cause, 'fix');
});

test('the watch says whether the Pi can wake a phone: in describe() and the cloud row', async () => {
    const h = relayHarness();
    await h.relay.probe();
    const watch = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: T0 }),
        atAnchor: () => false,
        now: () => T0,
        pushStatus: () => h.relay.status(),
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    assert.deepEqual(watch.describe().push, { state: 'ready', checkedAt: T0, ownerId: OWNER });
    assert.deepEqual(Object.keys(watch.cloudExtra()), ['ais_watch', 'ais_watch_at_ms', 'ais_watch_alarms']);
    assert.deepEqual(watch.cloudPushExtra(), { ais_watch_push: 'ready' });
    // A Pi with no relay wired says nothing of it.
    const bare = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: T0 }),
        atAnchor: () => false,
        now: () => T0,
    });
    assert.equal(bare.describe().push, null);
    assert.deepEqual(bare.cloudPushExtra(), {});
});

test('the push word is written LAST in the cloud extra, so the 40-key cap drops it before an instrument', () => {
    const snapshot = {
        reportedAt: new Date(T0).toISOString(),
        lat: -36.75,
        lon: 174.95,
        extra: { wind_history_identity: 'pi-fictional', house_battery_soc_pct: 87.5 },
    } as unknown as Parameters<typeof buildTelemetryBody>[0];
    const body = buildTelemetryBody(
        snapshot,
        'calypso',
        { ais_watch: 'armed', ais_watch_at_ms: T0, ais_watch_alarms: 0 },
        { ais_watch_push: 'ready' },
    );
    assert.deepEqual(Object.keys(body.extra as object), [
        'ais_watch',
        'ais_watch_at_ms',
        'ais_watch_alarms',
        'wind_history_identity',
        'house_battery_soc_pct',
        'ais_watch_push',
    ]);
    const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('trailingExtra: () => aisWatch.cloudPushExtra()'));
});

test('every pass is handed on (onPass), and a hook that throws never stops the watch', async () => {
    const seen: AisWatchDescription[] = [];
    let t = T0;
    const watch = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: t }),
        atAnchor: () => false,
        now: () => t,
        onPass: (d) => {
            seen.push(d);
            throw new Error('a hook that fails');
        },
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    watch.arm(null);
    await watch.passOnce();
    t += 5_000;
    await watch.passOnce();
    assert.equal(seen.length, 2);
    assert.equal(seen[1].lastPassAt, T0 + 5_000);
    assert.equal(watch.describe().state, 'blind');
});

test('POST /api/ais-watch/test sends one test through the relay and answers what happened', async () => {
    const watch = new AisNightWatch({
        documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: T0 }),
        atAnchor: () => false,
        now: () => T0,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    let tests = 0;
    const app = express();
    app.use(express.json());
    app.use(
        '/api/ais-watch',
        createAisWatchRoutes(watch, {
            test: async () => {
                tests += 1;
                return { push: 'ready', queued: true };
            },
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
        const port = (server.address() as AddressInfo).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/ais-watch/test`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'ok', push: 'ready', queued: true });
        assert.equal(tests, 1);
        // Without a relay wired (an older build): the route says so.
        const bare = express();
        bare.use('/api/ais-watch', createAisWatchRoutes(watch));
        const s2 = bare.listen(0, '127.0.0.1');
        await new Promise((r) => s2.once('listening', r));
        const p2 = (s2.address() as AddressInfo).port;
        const none = await fetch(`http://127.0.0.1:${p2}/api/ais-watch/test`, { method: 'POST' });
        assert.equal(none.status, 503);
        s2.close();
    } finally {
        server.close();
        watch.close();
    }
});

test('server.ts wires the relay: trust-anchor endpoint, lent credential, internet policy, the watch’s hooks', () => {
    const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('endpoint: canonicalPiAlarmRelayEndpoint(SUPABASE_ORIGIN)'));
    assert.ok(source.includes('credentials: () => diaryRelayOutbox.lendAlarmCredentials()'));
    assert.ok(source.includes('internetAllowed: () => diaryRelayOutbox.getConfiguration().allowInternet'));
    assert.ok(source.includes('onAlarm: (alarm) => void piAlarmRelay.raise(alarm)'));
    assert.ok(source.includes('pushStatus: () => piAlarmRelay.status()'));
    assert.match(
        source,
        /onPass: \(description\) =>\s+piAlarmRelay\.afterPass\(description, \(kind, mmsi\) => aisWatch\.ack\(kind, mmsi\)\)/,
    );
    assert.ok(source.includes('createAisWatchRoutes(aisWatch, { test: () => piAlarmRelay.test() })'));
    assert.ok(source.includes("app.use('/api/ais-watch', requireAppApi,"));
    // Never the gateway, never 1456.
    assert.ok(!/1456/.test(fs.readFileSync(new URL('./piAlarmRelay.ts', import.meta.url), 'utf8')));
});

test('the outbox lends the credential to the alarm relay, without its url', () => {
    const source = fs.readFileSync(new URL('./diaryRelayOutbox.ts', import.meta.url), 'utf8');
    assert.match(source, /lendAlarmCredentials\(\): \{ relayId: string; token: string \} \| null \{/);
});
