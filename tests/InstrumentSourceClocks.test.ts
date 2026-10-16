import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/AisShareService', () => ({ offer: vi.fn(), reportLink: vi.fn() }));
import { readTelemetrySnapshot, readTrackFix, readQualifiedRpm } from '../pi-cache/src/trackSignalk';
import { mergeOnboardSensors } from '../pi-cache/src/onboardSensors';
import { RollingWindHistory } from '../pi-cache/src/windHistory';
import { unpackInstrumentTimes } from '../services/instruments/measurements';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import { snapshotFromWire } from '../services/telemetryWire';
import { NmeaStore } from '../services/NmeaStore';
import { NmeaListenerService } from '../services/NmeaListenerService';
import { measuredCurrent } from '../services/instruments/measuredCurrent';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const NOW = Date.parse('2026-10-16T10:00:00Z');
const leaf = (value: unknown, at = NOW - 2000) => ({ value, timestamp: new Date(at).toISOString() });
const doc = () => ({
    navigation: {
        datetime: leaf(new Date(NOW).toISOString()),
        position: leaf({ latitude: 30, longitude: -60 }),
        speedOverGround: leaf(Math.sqrt(26) / 1.94384449),
        courseOverGroundTrue: leaf(Math.atan2(1, 5)),
        speedThroughWater: leaf(5 / 1.94384449),
        headingTrue: leaf(0),
    },
    environment: { wind: { speedTrue: leaf(7), angleTrueWater: leaf(Math.PI / 3), directionTrue: leaf(Math.PI / 3) } },
    propulsion: { main: { revolutions: leaf(0) } },
});
const listener = NmeaListenerService as unknown as {
    status: 'connected' | 'disconnected';
    accumulator: unknown;
    freshAccumulator(): unknown;
    parseNmeaSentence(s: string): void;
    emitSample(): void;
};
const feed = (body: string) => {
    let n = 0;
    for (const ch of body) n ^= ch.charCodeAt(0);
    listener.parseNmeaSentence(`$${body}*${n.toString(16).toUpperCase().padStart(2, '0')}`);
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    listener.status = 'disconnected';
    listener.accumulator = listener.freshAccumulator();
    NmeaStore.stop();
    setAuthIdentityScope(null);
});
afterEach(() => {
    NmeaStore.stop();
    listener.status = 'disconnected';
    vi.useRealTimers();
});
it('survives the actual Pi -> relay parser -> LAN/cloud wire -> store contract with original clocks', () => {
    const snapshot = readTelemetrySnapshot(doc(), () => NOW)!;
    const body = buildTelemetryBody(snapshot, 'fictional-test');
    expect(Object.keys(body.extra && typeof body.extra === 'object' ? body.extra : {})).toHaveLength(7);
    expect(JSON.stringify(body.extra).length).toBeLessThan(4096);
    const parsed = parseTelemetryBody(body, NOW);
    if (!parsed.ok) throw Error(parsed.error);
    for (const lane of ['cloud', 'lan'] as const) {
        NmeaStore.clearRemote();
        const wire = snapshotFromWire({ ...parsed.row }, lane)!.snapshot;
        NmeaStore.ingestRemote(wire);
        const state = NmeaStore.getState();
        expect(state.measurementTimes?.rpm).toBe(NOW - 2000);
        expect(state.instrumentEvidence?.readings.rpm).toMatchObject({ engineCount: 1, engineId: 'main' });
        expect(state.instrumentEvidence?.readings.stw?.at).toBe(NOW - 2000);
        const c = measuredCurrent(state.instrumentEvidence, NOW);
        expect(c.kind).toBe('available');
        if (c.kind === 'available') {
            expect(c.driftKts).toBeCloseTo(1);
            expect(c.setTrueDeg).toBeCloseTo(90);
        }
    }
});
it('a repeatedly received cached snapshot keeps the legacy gauge but cannot renew current/RPM evidence', () => {
    const body = buildTelemetryBody(readTelemetrySnapshot(doc(), () => NOW)!, 'fictional-test');
    NmeaStore.ingestRemote(snapshotFromWire(body, 'lan')!.snapshot);
    vi.setSystemTime(NOW + 14000);
    NmeaStore.ingestRemote(snapshotFromWire(body, 'lan')!.snapshot);
    expect(NmeaStore.getState().stw.value).toBeCloseTo(5);
    expect(NmeaStore.getState().stw.lastUpdated).toBe(NOW + 14000);
    expect(NmeaStore.getState().measurementTimes?.rpm).toBe(NOW - 2000);
    expect(measuredCurrent(NmeaStore.getState().instrumentEvidence, NOW + 14000).kind).toBe('unavailable');
});
it('legacy rows remain visible without deriving qualified measurements, and account fencing clears new evidence', () => {
    const d = doc();
    const body = buildTelemetryBody(readTelemetrySnapshot(d, () => NOW)!, 'fictional-test');
    delete body.extra;
    NmeaStore.ingestRemote(snapshotFromWire(body, 'lan')!.snapshot);
    expect(NmeaStore.getState().stw.value).toBeCloseTo(5);
    expect(measuredCurrent(NmeaStore.getState().instrumentEvidence, NOW).kind).toBe('unavailable');
    setAuthIdentityScope('fictional-other-account');
    expect(NmeaStore.getState().instrumentEvidence).toBeUndefined();
    expect(NmeaStore.getState().measurementTimes).toBeUndefined();
});
it('track source clocks survive separately from the GPS row time and legacy heading', () => {
    const fix = readTrackFix(doc())!;
    expect(fix).toMatchObject({
        gpsTimeMs: NOW,
        headingTrueDeg: 0,
        headingTrueAtMs: NOW - 2000,
        stwAtMs: NOW - 2000,
        cogTrueAtMs: NOW - 2000,
        sogAtMs: NOW - 2000,
        engineRpmAtMs: NOW - 2000,
    });
    const d = doc();
    d.navigation.headingTrue = { value: 0 } as ReturnType<typeof leaf>;
    expect(readTrackFix(d)?.headingTrueAtMs).toBeNull();
    expect(readTrackFix(d)?.hdgDeg).toBe(0);
});
it('does not borrow a parent timestamp, and known zero requires every engine original clock', () => {
    expect(
        readQualifiedRpm(
            { propulsion: { timestamp: new Date(NOW).toISOString(), main: { revolutions: { value: 0 } } } },
            NOW,
        ),
    ).toBeNull();
    expect(
        readQualifiedRpm({ propulsion: { main: { revolutions: leaf(0) }, other: { revolutions: { value: 0 } } } }, NOW),
    ).toBeNull();
    expect(
        readQualifiedRpm(
            { propulsion: { main: { revolutions: leaf(20) }, other: { revolutions: { value: 0 } } } },
            NOW,
        ),
    ).toMatchObject({ value: 1200, at: NOW - 2000, engineCount: 2, engineId: 'main' });
    expect(readQualifiedRpm({ propulsion: { main: { revolutions: leaf(0, NOW - 20000) } } }, NOW)).toBeNull();
});
it('qualifies actual VHW/RMC sentence values with their own receipt clocks instead of later depth or aggregate averages', () => {
    listener.status = 'connected';
    NmeaStore.start();
    feed('YDVHW,0,T,11,M,5,N,9.26,K');
    feed('YDRMC,100000,A,3000.000,N,06000.000,W,5.0990195,11.3099325,161026,,,A');
    vi.setSystemTime(NOW + 4000);
    feed('YDDPT,20,0,');
    listener.emitSample();
    expect(NmeaStore.getState().instrumentEvidence?.readings.stw).toMatchObject({
        at: NOW,
        value: 5,
        unit: 'knots',
        reference: 'water',
    });
    expect(measuredCurrent(NmeaStore.getState().instrumentEvidence, NOW + 4000).kind).toBe('available');
    feed('YDVHW,0,T,11,M,20,K,37.04,K');
    listener.emitSample();
    expect(NmeaStore.getState().instrumentEvidence?.readings.stw?.value).toBeNull();
    expect(NmeaStore.getState().stw.value).toBe(20);
});
it('a magnetic wind direction is never relabelled true, and invalid RPM status never qualifies', () => {
    listener.status = 'connected';
    NmeaStore.start();
    feed('YDMWD,,T,150,M,10,N,5.144,M');
    feed('YDRPM,E,1,1200,0,V');
    listener.emitSample();
    expect(NmeaStore.getState().twd.value).toBe(150);
    expect(NmeaStore.getState().instrumentEvidence?.readings.twdTrue?.value).toBeNull();
    expect(NmeaStore.getState().instrumentEvidence?.readings.rpm?.value).toBeNull();
});

it('the fully populated actual supplement/history/AIS path preserves every scalar through the existing relay bounds', () => {
    const d: { navigation: Record<string, unknown>; environment: Record<string, unknown>; propulsion: unknown } = doc();
    d.navigation.position = { ...leaf({ latitude: 30, longitude: -60 }), $source: 'x'.repeat(120) };
    d.navigation.gnss = {
        satellites: { ...leaf(12), $source: 'x'.repeat(120) },
        horizontalDilution: { ...leaf(0.8), $source: 'x'.repeat(120) },
        methodQuality: { ...leaf('GNSS Fix'), $source: 'x'.repeat(120) },
    };
    d.navigation.attitude = leaf({ roll: 0.1, pitch: 0.2 });
    d.navigation.leewayAngle = leaf(-0.03);
    d.environment.depth = { belowTransducer: leaf(10), transducerToKeel: leaf(2) };
    d.environment.wind = {
        speedTrue: { ...leaf(7), $source: 'x'.repeat(120) },
        angleTrueWater: leaf(1),
        directionTrue: leaf(1),
    };
    const bus = readTelemetrySnapshot(d, () => NOW)!;
    const b = { hpa: 1013, tempC: 20, at: NOW - 1000 };
    const snapshot = mergeOnboardSensors(
        bus,
        {
            barometer: {
                available: true,
                reason: null,
                latest: b,
                samples: [b, { ...b, at: b.at - 10800000, hpa: 1012 }],
            },
            house: { source: 'victron-smartshunt-house', at: NOW, soc_pct: 70 },
        },
        NOW,
    )!;
    const history = new RollingWindHistory();
    history.ingest({ kts: 12, at: NOW - 2000, source: 'x'.repeat(120) }, NOW);
    snapshot.extra = { ...snapshot.extra, ...history.extra(NOW), wind_history_identity: 'p'.repeat(120) };
    const body = buildTelemetryBody(
        snapshot,
        'fictional-test',
        { ais_watch: 'armed', ais_watch_at_ms: NOW, ais_watch_alarms: 0 },
        { ais_watch_push: 'ready' },
    );
    const extra = body.extra as Record<string, number | string>;
    expect(Object.keys(extra).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(extra).length).toBeLessThan(4096);
    expect(String(extra.instrument_times_v1).length).toBeLessThanOrEqual(120);
    const parsed = parseTelemetryBody(body, NOW);
    if (!parsed.ok) throw Error(parsed.error);
    expect(parsed.row.extra).toEqual(extra);
    expect(snapshotFromWire({ ...parsed.row }, 'lan')!.snapshot.measurementTimes?.rpm).toBe(NOW - 2000);
    expect(unpackInstrumentTimes(extra.instrument_times_v1)?.leewayDeg).toBeCloseTo((-0.03 * 180) / Math.PI, 5);
});
it.each(['[]', '[1,2,3,4,5,6,0,null]', '[1,2,3,4,5,6,30,7]', '[1,2,3,4,5,"6",null,null]', 'x'.repeat(121)])(
    'refuses a malformed packed clock contract %s',
    (value) => expect(unpackInstrumentTimes(value)).toBeNull(),
);

it('direct engine identity is explicit and any fresh running engine suppresses sailing even after another engine zero', () => {
    listener.status = 'connected';
    NmeaStore.start();
    feed('YDRPM,E,1,1200,0,A');
    listener.emitSample();
    expect(NmeaStore.getState().instrumentEvidence?.readings.rpm).toMatchObject({
        value: 1200,
        at: NOW,
        engineId: 'NMEA-E-1',
        engineCount: 1,
    });
    vi.setSystemTime(NOW + 4000);
    feed('YDRPM,E,2,0,0,A');
    listener.emitSample();
    expect(NmeaStore.getState().instrumentEvidence?.readings.rpm).toMatchObject({
        value: 1200,
        at: NOW,
        engineCount: 2,
    });
    feed('YDRPM,E,1,0,0,A');
    listener.emitSample();
    expect(NmeaStore.getState().instrumentEvidence?.readings.rpm).toMatchObject({ value: 0, engineCount: 2 });
});
it('shaft RPM alone cannot qualify an engine identity or engine hours', () => {
    listener.status = 'connected';
    NmeaStore.start();
    feed('YDRPM,S,1,1200,0,A');
    listener.emitSample();
    expect(NmeaStore.getState().rpm.value).toBe(1200);
    expect(NmeaStore.getState().instrumentEvidence?.readings.rpm).toBeUndefined();
});
