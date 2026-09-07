import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOnboardSensors } from './onboardSensors.js';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';
const now = Date.parse('2026-09-07T04:00:00Z');
const empty = { available: false, latest: null, samples: [], reason: 'not fitted' };
const sample = (at: number, hpa = 1017.9) => ({ at, hpa, tempC: 28 });
const bus = () => readTelemetrySnapshot({ navigation: { speedOverGround: { value: 0 } } }, () => now)!;

test('publishes real BMP390 pressure/history and never its enclosure temperature', () => {
    const merged = mergeOnboardSensors(
        bus(),
        {
            barometer: {
                available: true,
                reason: null,
                latest: sample(now),
                samples: [sample(now - 10_800_000, 1021.1)],
            },
        },
        now,
    )!;
    assert.equal(merged.pressureHpa, 1017.9);
    assert.equal(merged.waterTempC, null);
    assert.equal(merged.extra?.pressure_3h_hpa, 1021.1);
    assert.equal(buildTelemetryBody(merged, 'test').pressure_hpa, 1017.9);
});
test('never revives a dead barometer or fabricates three hours of history', () => {
    for (const barometer of [
        { ...empty, latest: sample(now) },
        { ...empty, available: true, latest: sample(now - 180_001) },
        { ...empty, available: true, latest: sample(now + 5_001) },
    ])
        assert.equal(mergeOnboardSensors(bus(), { barometer }, now)?.pressureHpa, null);
    const merged = mergeOnboardSensors(
        bus(),
        { barometer: { ...empty, available: true, latest: sample(now), samples: [sample(now - 3600_000)] } },
        now,
    )!;
    assert.equal(merged.extra?.pressure_3h_hpa, undefined);
});
test('only accepts explicitly selected house SmartShunt percent, including zero', () => {
    for (const soc of [0, 94.6, 100]) {
        const merged = mergeOnboardSensors(
            bus(),
            { barometer: empty, house: { source: 'victron-smartshunt-house', soc_pct: soc, at: now } },
            now,
        )!;
        assert.equal(merged.extra?.house_battery_soc_pct, soc);
    }
    for (const house of [
        { shunt_soc: 94.6, time: new Date(now).toISOString() },
        { source: 'victron-smartshunt-house', soc_pct: 94.6, at: now - 180_001 },
        { source: 'other-bank', soc_pct: 99, at: now },
        { source: 'victron-smartshunt-house', soc_pct: 101, at: now },
    ])
        assert.equal(
            mergeOnboardSensors(bus(), { barometer: empty, house }, now)?.extra?.house_battery_soc_pct,
            undefined,
        );
});
test('XDR is already in signed degrees; per-sensor freshness and sentinel are enforced', () => {
    const wind = {
        connected: true,
        generated_at_ms: now,
        sensor_at_ms: { heel: now, pitch: now },
        heel: -0.5,
        pitch: 2.75,
    };
    const merged = mergeOnboardSensors(bus(), { barometer: empty, wind }, now)!;
    assert.equal(merged.heelDeg, -0.5);
    assert.equal(merged.pitchDeg, 2.75);
    for (const bad of [
        { ...wind, connected: false },
        { ...wind, generated_at_ms: now - 10_001 },
        { ...wind, sensor_at_ms: { heel: now - 30_001 } },
        { ...wind, heel: 63.75 },
    ]) {
        assert.equal(mergeOnboardSensors(bus(), { barometer: empty, wind: bad }, now)?.heelDeg, null);
    }
});
test('does not overwrite Signal K attitude or GPS timestamp/position when supplementing', () => {
    const base = { ...bus(), reportedAt: '2026-09-07T03:59:00.000Z', lat: -27, lon: 153, heelDeg: 3 };
    const merged = mergeOnboardSensors(
        base,
        {
            barometer: empty,
            wind: { connected: true, generated_at_ms: now, sensor_at_ms: { heel: now }, heel: 5 },
            shipTimeZone: 'Australia/Brisbane',
        },
        now,
    )!;
    assert.equal(merged.heelDeg, 3);
    assert.equal(merged.reportedAt, base.reportedAt);
    assert.equal(merged.lat, -27);
    assert.equal(merged.extra?.ship_time_zone, 'Australia/Brisbane');
});
test('can report onboard pressure without GPS, but never creates a position or data from just a clock', () => {
    assert.equal(mergeOnboardSensors(null, { barometer: empty, shipTimeZone: 'Australia/Brisbane' }, now), null);
    const merged = mergeOnboardSensors(null, { barometer: { ...empty, available: true, latest: sample(now) } }, now)!;
    assert.equal(merged.lat, null);
    assert.equal(merged.pressureHpa, 1017.9);
    assert.equal(merged.reportedAt, new Date(now).toISOString());
});

test('a stale GPS envelope cannot reject fresh pressure or be re-stamped as a live position', () => {
    const oldBus = { ...bus(), reportedAt: new Date(now - 1_200_000).toISOString(), lat: -27, lon: 153, sogKts: 7 };
    const merged = mergeOnboardSensors(oldBus, { barometer: { ...empty, available: true, latest: sample(now) } }, now)!;
    assert.equal(merged.reportedAt, new Date(now).toISOString());
    assert.equal(merged.pressureHpa, 1017.9);
    assert.equal(merged.lat, null);
    assert.equal(merged.sogKts, null);
});

test('stale Signal K attitude yields to fresh bridge; explicit unavailable does not', () => {
    const old = readTelemetrySnapshot(
        {
            navigation: {
                speedOverGround: { value: 0 },
                attitude: { value: { roll: 0.4 }, timestamp: new Date(now - 31_000).toISOString() },
            },
        },
        () => now,
    )!;
    assert.equal(old.heelDeg, null);
    const wind = { connected: true, generated_at_ms: now, sensor_at_ms: { heel: now }, heel: 0.5 };
    assert.equal(mergeOnboardSensors(old, { barometer: empty, wind }, now)?.heelDeg, 0.5);
    assert.equal(
        mergeOnboardSensors(old, { barometer: empty, wind: { ...wind, attitude_ok: false } }, now)?.heelDeg,
        null,
    );
});
