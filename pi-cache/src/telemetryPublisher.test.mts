/**
 * The Pi publishes the boat — Shane 2026-09-06: "all of the data to supabase
 * needs to come from the pi, not from my phone", and the whole bus, not just
 * GPS.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnboardSupplement } from './onboardSensors.js';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { MAX_BACKOFF_MS, PUBLISH_INTERVAL_MS, TelemetryPublisher, buildTelemetryBody } from './telemetryPublisher.js';

const RAD = Math.PI / 180;
const SELF = {
    navigation: {
        position: { value: { latitude: -27.2, longitude: 153.11 }, timestamp: 't' },
        datetime: { value: '2026-09-06T06:00:00.000Z' },
        speedOverGround: { value: 3.0 }, // m/s
        courseOverGroundTrue: { value: 45 * RAD },
        headingTrue: { value: 40 * RAD },
        speedThroughWater: { value: 2.8 },
        attitude: { value: { roll: -8 * RAD, pitch: 1 * RAD }, timestamp: new Date().toISOString() },
    },
    environment: {
        wind: {
            speedTrue: { value: 7.0 },
            angleTrueWater: { value: -48 * RAD },
            directionTrue: { value: 350 * RAD },
            speedApparent: { value: 8.5 },
            angleApparent: { value: -33 * RAD },
        },
        depth: { belowTransducer: { value: 12.4 } },
        water: { temperature: { value: 295.65 } },
        outside: { pressure: { value: 101_320 } },
    },
    steering: { rudderAngle: { value: 2 * RAD } },
    propulsion: { port: { revolutions: { value: 30 } } }, // Hz
    electrical: { batteries: { house: { voltage: { value: 13.1 } } } },
};

test('reads the whole bus in the panel’s units: knots, signed degrees, metres, Celsius, hPa, rpm', () => {
    const s = readTelemetrySnapshot(SELF)!;
    assert.equal(s.reportedAt, '2026-09-06T06:00:00.000Z');
    assert.equal(s.lat, -27.2);
    assert.ok(Math.abs(s.sogKts! - 5.83) < 0.01);
    assert.ok(Math.abs(s.cogDeg! - 45) < 1e-9);
    assert.ok(Math.abs(s.twaDeg! - -48) < 1e-9, 'twa stays signed');
    assert.ok(Math.abs(s.awaDeg! - -33) < 1e-9);
    assert.ok(Math.abs(s.twdDeg! - 350) < 1e-9);
    assert.ok(Math.abs(s.heelDeg! - -8) < 1e-9);
    assert.equal(s.depthM, 12.4);
    assert.ok(Math.abs(s.waterTempC! - 22.5) < 1e-9);
    assert.ok(Math.abs(s.pressureHpa! - 1013.2) < 1e-9);
    assert.equal(s.rpm, 1800);
    assert.equal(s.voltageV, 13.1);
});

test('no document, or a document with nothing on it, is no snapshot; Null Island is not a position', () => {
    assert.equal(
        readTelemetrySnapshot({ navigation: {} }, () => 0),
        null,
    );
    const s = readTelemetrySnapshot({
        navigation: { position: { value: { latitude: 0, longitude: 0 } }, speedOverGround: { value: 1 } },
    })!;
    assert.equal(s.lat, null);
    assert.equal(s.lon, null);
});

test('the body is the Edge Function’s snake_case shape, marked as the Pi', () => {
    const body = buildTelemetryBody(readTelemetrySnapshot(SELF)!, 'calypso');
    assert.equal(body.source, 'pi');
    assert.equal(body.device_label, 'calypso');
    assert.equal(body.twa_deg, -48 + 0 || body.twa_deg);
    assert.ok('voltage_v' in body && 'depth_m' in body && 'rudder_deg' in body);
});

test('exports the actual position timestamp, never the independent GPS/report clock', () => {
    const now = Date.parse('2026-09-07T05:00:00Z');
    const doc = (timestamp: string | undefined) => ({
        timestamp: new Date(now).toISOString(),
        navigation: {
            timestamp: new Date(now).toISOString(),
            datetime: { value: new Date(now).toISOString() },
            position: { value: { latitude: -27.2, longitude: 153.11 }, timestamp },
        },
    });
    const fresh = readTelemetrySnapshot(doc(new Date(now - 1_000).toISOString()), () => now)!;
    assert.equal((buildTelemetryBody(fresh, 'test').extra as Record<string, unknown>).position_at, now - 1_000);
    for (const timestamp of [
        undefined,
        'bad',
        new Date(now - 600_000).toISOString(),
        new Date(now + 5_001).toISOString(),
    ]) {
        const stale = readTelemetrySnapshot(doc(timestamp), () => now)!;
        assert.equal(stale.reportedAt, new Date(now).toISOString());
        assert.equal(stale.extra?.position_at, undefined);
    }
});

function fakeSignalK(selfDoc: unknown) {
    return async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/signalk')) {
            return new Response(
                JSON.stringify({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } }),
                { status: 200 },
            );
        }
        if (u.startsWith('http://sk/')) return new Response(JSON.stringify(selfDoc), { status: 200 });
        return new Response('unexpected', { status: 500 });
    };
}

test('publishes with the pairing credential and the anon key, and reports sent', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const sk = fakeSignalK(SELF);
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) => {
            if (String(url).includes('telemetry-relay')) {
                calls.push({ url: String(url), init });
                return new Response('{"ok":true}', { status: 200 });
            }
            return sk(url, init);
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'a'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'calypso',
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['X-Thalassa-Pi-Relay-Id'], 'relay-1234567890abcdef');
    assert.equal(headers.apikey, 'anon');
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.equal(body.source, 'pi');
    assert.equal(body.lat, -27.2);
    assert.equal(publisher.status().consecutiveFailures, 0);
});

test('stands down when the skipper’s policy forbids internet, or the Pi is unpaired, and never posts', async () => {
    let posted = 0;
    const base = {
        fetchImpl: async (url: string | URL, init?: RequestInit) => {
            if (String(url).includes('telemetry-relay')) posted += 1;
            return fakeSignalK(SELF)(url, init);
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        deviceLabel: 'calypso',
    };
    const off = new TelemetryPublisher({
        ...base,
        credentials: () => ({ relayId: 'r'.repeat(20), token: 'b'.repeat(64) }),
        internetAllowed: () => false,
    });
    assert.equal(await off.publishOnce(), 'internet-off');
    const unpaired = new TelemetryPublisher({ ...base, credentials: () => null, internetAllowed: () => true });
    assert.equal(await unpaired.publishOnce(), 'not-paired');
    assert.equal(posted, 0);
});

test('a refusing cloud backs the Pi off, doubling to a five-minute cap, and a success resets it', async () => {
    let status = 500;
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) =>
            String(url).includes('telemetry-relay') ? new Response('no', { status }) : fakeSignalK(SELF)(url, init),
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'r'.repeat(20), token: 'c'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'calypso',
    });
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS);
    for (let i = 0; i < 3; i++) assert.equal(await publisher.publishOnce(), 'rejected');
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS * 8);
    for (let i = 0; i < 10; i++) await publisher.publishOnce();
    assert.equal(publisher.nextDelayMs(), MAX_BACKOFF_MS);
    status = 200;
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS);
});

/*
 * Pi update 1 (build 125, 125-10): the payload keys the phones date and label
 * her wind and depth by. Every position and reading is fictional; the boats
 * are off Cape Town and in the Solent, not at home.
 */
const WIND_NOW = Date.parse('2026-10-08T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A Signal K self document with true wind: TWS (VWT) and TWD (MDA) each on their own leaf clock. */
function windDoc(opts: { twsAt?: number | null; twdAt?: number | null; twd?: number | null } = {}) {
    const twsAt = opts.twsAt === undefined ? WIND_NOW - 2_000 : opts.twsAt;
    const twdAt = opts.twdAt === undefined ? WIND_NOW - 2_000 : opts.twdAt;
    const leaf = (value: number, at: number | null) => ({
        value,
        $source: 'ydwg-tcp.YD',
        ...(at === null ? {} : { timestamp: iso(at) }),
    });
    return {
        // A current GPS clock on the document and the navigation branch: never a wind date.
        timestamp: iso(WIND_NOW),
        navigation: {
            timestamp: iso(WIND_NOW),
            datetime: { value: iso(WIND_NOW) },
            position: { value: { latitude: -34.05, longitude: 18.35 }, timestamp: iso(WIND_NOW - 1_000) },
        },
        environment: {
            timestamp: iso(WIND_NOW),
            wind: {
                speedTrue: leaf(7.2, twsAt),
                angleTrueWater: leaf(-40 * RAD, twsAt),
                ...(opts.twd === null ? {} : { directionTrue: leaf((opts.twd ?? 200) * RAD, twdAt) }),
            },
        },
    };
}

const bodyExtra = (doc: unknown) =>
    buildTelemetryBody(readTelemetrySnapshot(doc, () => WIND_NOW)!, 'test').extra as Record<string, unknown>;

test('wind_twd_at_ms: the TWD reading’s own Signal K time, never the publish or GPS time', () => {
    const extra = bodyExtra(windDoc({ twsAt: WIND_NOW - 2_000, twdAt: WIND_NOW - 3_500 }));
    assert.equal(extra.wind_twd_at_ms, WIND_NOW - 3_500);
    assert.equal(extra.wind_tws_at_ms, WIND_NOW - 2_000, 'TWS keeps its own date');
    assert.notEqual(extra.wind_twd_at_ms, WIND_NOW);
});

test('wind_twd_at_ms: a frozen TWD beside a fresh TWS goes out with its old time, so a phone can refuse it', () => {
    // Heading drops out: the gateway's MDA (TWD) stops while VWT (TWS) carries on.
    const frozenAt = WIND_NOW - 5 * 60_000;
    const extra = bodyExtra(windDoc({ twsAt: WIND_NOW - 1_000, twdAt: frozenAt }));
    assert.equal(extra.wind_twd_at_ms, frozenAt, 'dated as it is, however old');
    assert.equal(extra.wind_tws_at_ms, WIND_NOW - 1_000);
    // Hours old, and stamped ahead of the Pi's clock: still the reading's own time.
    assert.equal(bodyExtra(windDoc({ twdAt: WIND_NOW - 6 * 3_600_000 })).wind_twd_at_ms, WIND_NOW - 6 * 3_600_000);
    assert.equal(bodyExtra(windDoc({ twdAt: WIND_NOW + 30_000 })).wind_twd_at_ms, WIND_NOW + 30_000);
});

test('wind_twd_at_ms: none without a TWD, and none from a parent’s or the GPS clock', () => {
    assert.equal(bodyExtra(windDoc({ twd: null })).wind_twd_at_ms, undefined);
    // The leaf has no time of its own: the environment and document times are not its date.
    assert.equal(bodyExtra(windDoc({ twdAt: null })).wind_twd_at_ms, undefined);
    // The TWD itself still goes out, undated, as an older Pi sent it.
    assert.ok(Math.abs((readTelemetrySnapshot(windDoc({ twdAt: null }), () => WIND_NOW)!.twdDeg ?? 0) - 200) < 1e-9);
});

test('the published body carries wind_twd_at_ms, through the real publisher', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const sk = fakeSignalK(windDoc({ twsAt: WIND_NOW - 1_500, twdAt: WIND_NOW - 2_500 }));
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) => {
            if (String(url).includes('telemetry-relay')) {
                posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                return new Response('{"ok":true}', { status: 200 });
            }
            return sk(url, init);
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'd'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'pi',
        now: () => WIND_NOW,
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    const extra = posted[0].extra as Record<string, unknown>;
    assert.equal(extra.wind_twd_at_ms, WIND_NOW - 2_500);
    assert.equal(extra.wind_tws_at_ms, WIND_NOW - 1_500);
    assert.ok(Math.abs((posted[0].twd_deg as number) - 200) < 1e-9);
});

test('depth_reference and depth_offset_m: the body says what the depth is measured from', () => {
    const at = iso(WIND_NOW - 1_500);
    const depthDoc = (depth: Record<string, unknown>) => ({
        navigation: {
            datetime: { value: iso(WIND_NOW) },
            position: { value: { latitude: 50.77, longitude: -1.3 }, timestamp: at },
        },
        environment: { depth },
    });
    // A sounder with its keel offset set: the keel figure, the reference and the signed offset.
    const keel = buildTelemetryBody(
        readTelemetrySnapshot(
            depthDoc({
                belowTransducer: { value: 6.2, timestamp: at },
                transducerToKeel: { value: 1.1, timestamp: at },
                belowKeel: { value: 5.1, timestamp: at },
            }),
            () => WIND_NOW,
        )!,
        'test',
    );
    assert.equal(keel.depth_m, 5.1);
    assert.deepEqual(
        [
            (keel.extra as Record<string, unknown>).depth_reference,
            (keel.extra as Record<string, unknown>).depth_offset_m,
        ],
        ['below-keel', -1.1],
    );
    // No offset known: the raw reading, said to be below the transducer, with no offset.
    const raw = buildTelemetryBody(
        readTelemetrySnapshot(depthDoc({ belowTransducer: { value: 6.2, timestamp: at } }), () => WIND_NOW)!,
        'test',
    );
    assert.equal(raw.depth_m, 6.2);
    assert.equal((raw.extra as Record<string, unknown>).depth_reference, 'below-transducer');
    assert.equal((raw.extra as Record<string, unknown>).depth_offset_m, undefined);
    // A sounder with no keel setting that reports only DBS: below the waterline.
    const surface = buildTelemetryBody(
        readTelemetrySnapshot(depthDoc({ belowSurface: { value: 7.4, timestamp: at } }), () => WIND_NOW)!,
        'test',
    );
    assert.equal(surface.depth_m, 7.4);
    assert.equal((surface.extra as Record<string, unknown>).depth_reference, 'below-waterline');
});

// 129-08: the cloud's quiet-boat watchdog tells "her Pi is offline" from "her
// instruments are silent" by when the bus last spoke, sent as bus_at_ms.
const BUS_NOW = Date.parse('2026-10-14T03:00:00Z');
const stamped = (ageMs: number) => new Date(BUS_NOW - ageMs).toISOString();

test('bus_at_ms is the newest instrument reading’s own time, sent first among the snapshot’s keys', () => {
    const doc = {
        timestamp: stamped(0),
        navigation: {
            timestamp: stamped(0),
            datetime: { value: stamped(0), timestamp: stamped(0) },
            position: { value: { latitude: 59.91, longitude: 10.75 }, timestamp: stamped(90_000) },
            speedOverGround: { value: 2.1, timestamp: stamped(90_000) },
        },
        environment: {
            wind: { speedApparent: { value: 6.2, timestamp: stamped(4_000) } },
            depth: { belowTransducer: { value: 14.2, timestamp: stamped(30_000) } },
        },
    };
    const snapshot = readTelemetrySnapshot(doc, () => BUS_NOW)!;
    assert.equal(snapshot.extra?.bus_at_ms, BUS_NOW - 4_000, 'the apparent wind spoke last');
    const body = buildTelemetryBody(snapshot, 'test', { ais_watch: 'on' });
    assert.deepEqual(Object.keys(body.extra as Record<string, unknown>).slice(0, 2), ['ais_watch', 'bus_at_ms']);
});

test('no bus_at_ms from clocks, the document’s own stamp or a reading dated ahead of the Pi', () => {
    // The GPS clock, a sun calculation and the document's own stamp move with
    // the Pi's clock, not the bus; a far-future leaf is a bad clock.
    const doc = {
        timestamp: stamped(0),
        navigation: {
            timestamp: stamped(0),
            datetime: { value: stamped(0), timestamp: stamped(0) },
            position: { value: { latitude: 35.68, longitude: 139.77 }, timestamp: stamped(-60_000) },
        },
        environment: { sun: { value: 'day', timestamp: stamped(0) } },
    };
    const snapshot = readTelemetrySnapshot(doc, () => BUS_NOW)!;
    assert.equal(snapshot.extra?.bus_at_ms, undefined);
});

test('a frozen bus keeps its old bus_at_ms while the Pi keeps publishing', () => {
    const frozen = {
        navigation: {
            position: { value: { latitude: -33.86, longitude: 151.21 }, timestamp: stamped(20 * 60_000) },
            headingMagnetic: { value: 1.2, timestamp: stamped(21 * 60_000) },
        },
    };
    const snapshot = readTelemetrySnapshot(frozen, () => BUS_NOW)!;
    assert.equal(snapshot.extra?.bus_at_ms, BUS_NOW - 20 * 60_000);
});

// 129-08: the publisher keeps the cloud hearing the Pi while her bus is
// silent, without ever dating an old reading as new. Through the real
// publisher and the real onboard supplement the Pi runs (server.ts).
const PAIRED = {
    signalkOrigin: 'http://sk',
    endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
    anonKey: () => 'anon',
    credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'a'.repeat(64) }),
    internetAllowed: () => true,
    deviceLabel: 'kestrel-pi',
};

/** Signal K's document for a bus that went silent at `deadAt`: values and GPS clock frozen there. */
function frozenBus(deadAt: number) {
    const at = new Date(deadAt).toISOString();
    return {
        navigation: {
            datetime: { value: at, timestamp: at },
            position: { value: { latitude: 59.91, longitude: 10.75 }, timestamp: at },
            speedOverGround: { value: 0.1, timestamp: at },
        },
        environment: { depth: { belowTransducer: { value: 6.3, timestamp: at } } },
    };
}

function publisherOver(
    doc: () => unknown,
    clock: { now: number },
    barometer?: { at: number; hpa: number; tempC: number },
) {
    const bodies: Record<string, unknown>[] = [];
    const sk = (url: string | URL, init?: RequestInit) => {
        const d = doc();
        return d === null ? Promise.reject(new Error('Signal K down')) : fakeSignalK(d)(url, init);
    };
    const publisher = new TelemetryPublisher({
        ...PAIRED,
        now: () => clock.now,
        fetchImpl: async (url, init) => {
            if (String(url).includes('telemetry-relay')) {
                bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                return new Response('{"ok":true}', { status: 200 });
            }
            return sk(url, init);
        },
        supplement: createOnboardSupplement({
            barometer: () => ({
                available: !!barometer,
                reason: barometer ? null : 'no sensor fitted',
                latest: barometer ?? null,
                samples: barometer ? [barometer] : [],
            }),
            now: () => clock.now,
        }),
    });
    return { publisher, bodies };
}

test('every post says when the Pi sent it, by its own clock, beside the readings’ own time', async () => {
    const clock = { now: BUS_NOW };
    const { publisher, bodies } = publisherOver(() => frozenBus(BUS_NOW - 3_000), clock);
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(bodies[0].sent_at, new Date(BUS_NOW).toISOString());
    assert.equal(bodies[0].reported_at, new Date(BUS_NOW - 3_000).toISOString());
});

test('a bus silent 16 min, no onboard sensors: still posted as it is, dated by its stalled clock, with bus_at_ms', async () => {
    const deadAt = BUS_NOW - 16 * 60_000;
    const clock = { now: BUS_NOW };
    const { publisher, bodies } = publisherOver(() => frozenBus(deadAt), clock);
    // Before 129-08 the supplement set this bus aside and nothing went: 'no-data'.
    assert.equal(await publisher.publishOnce(), 'sent');
    const body = bodies[0];
    assert.equal(body.reported_at, new Date(deadAt).toISOString(), 'never re-dated as new');
    assert.equal(body.sent_at, new Date(BUS_NOW).toISOString());
    assert.equal(body.lat, 59.91, 'her last position, under its own old time');
    assert.equal((body.extra as Record<string, unknown>).bus_at_ms, deadAt);
});

test('a bus silent 16 min beside a fresh barometer: the barometer’s snapshot carries the bus’s bus_at_ms', async () => {
    const deadAt = BUS_NOW - 16 * 60_000;
    const clock = { now: BUS_NOW };
    const { publisher, bodies } = publisherOver(() => frozenBus(deadAt), clock, {
        at: BUS_NOW - 20_000,
        hpa: 1012.4,
        tempC: 18.5,
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    const body = bodies[0];
    assert.equal(body.reported_at, new Date(BUS_NOW).toISOString(), 'the barometer’s own fresh time');
    assert.equal(body.pressure_hpa, 1012.4);
    assert.equal(body.lat, null, 'the stalled bus’s position is not passed off as current');
    const extra = body.extra as Record<string, unknown>;
    assert.equal(extra.bus_at_ms, deadAt);
    assert.equal(Object.keys(extra)[0], 'bus_at_ms');
});

test('Signal K stops answering: the bus as last read, dated as it was, until it answers again', async () => {
    const clock = { now: BUS_NOW };
    let doc: unknown = frozenBus(BUS_NOW - 2_000);
    const { publisher, bodies } = publisherOver(() => doc, clock);
    assert.equal(await publisher.publishOnce(), 'sent');
    doc = null;
    clock.now = BUS_NOW + 20 * 60_000;
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(bodies[1].reported_at, new Date(BUS_NOW - 2_000).toISOString());
    assert.equal((bodies[1].extra as Record<string, unknown>).bus_at_ms, BUS_NOW - 2_000);
    assert.equal(bodies[1].sent_at, new Date(BUS_NOW + 20 * 60_000).toISOString());
});

test('nothing ever read and nothing on board: still nothing to send', async () => {
    const clock = { now: BUS_NOW };
    const { publisher, bodies } = publisherOver(() => null, clock);
    assert.equal(await publisher.publishOnce(), 'no-data');
    assert.equal(bodies.length, 0);
});
