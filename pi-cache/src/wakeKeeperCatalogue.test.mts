import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeSensorCatalogue, wakeStationPressure } from './wakeKeeper/catalogue.js';
import type { WakeInputContext } from './wakeRule/wakeRuleInputs.js';

const now = Date.parse('2026-10-16T00:00:00Z');
const leaf = (value: number, unit: string, at = now - 1000, source = 'fictional.1') => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: source,
    meta: { units: unit },
});
const context = (selfDocument: unknown): WakeInputContext => ({
    feedId: 'fictional-feed',
    localBoatSource: true,
    selfDocument,
    now,
    draftM: 2,
});
test('catalogue is fixed-preset only with original clocks, measured units, depth basis and physical instance', () => {
    const doc = {
        environment: {
            depth: { belowKeel: leaf(-0.2, 'm') },
            wind: { speedTrue: leaf(10, 'm/s') },
            outside: { pressure: leaf(101000, 'Pa') },
        },
        navigation: { speedOverGround: leaf(3, 'm/s') },
        propulsion: {
            main: {
                coolantTemperature: leaf(360, 'K'),
                oilPressure: leaf(300000, 'Pa'),
                revolutions: leaf(20, 'Hz', now - 2000),
            },
        },
        electrical: { batteries: { house: { voltage: leaf(12.5, 'V') }, start: { voltage: leaf(24.5, 'V') } } },
    };
    const result = wakeSensorCatalogue(context(doc));
    assert.equal(result.options.length, 9);
    assert.equal(result.truncated, false);
    const option = (preset: string) => result.options.find((r) => r.preset === preset)!;
    assert.deepEqual(option('depth-below-keel').reading, {
        preset: 'depth-below-keel',
        selection: option('depth-below-keel').selection,
        value: -0.2,
        at: now - 1000,
        depthBasis: 'below-keel',
    });
    assert.equal(option('engine-oil-below').reading?.at, now - 2000);
    assert.equal(option('engine-rpm-above').reading?.value, 1200);
    assert.ok(Math.abs(option('engine-coolant-above').reading!.value - 86.85) < 1e-10);
    assert.ok(Math.abs(option('wind-above').reading!.value - (10 * 3600) / 1852) < 1e-10);
    assert.equal(option('pressure-fall').reading, null);
    assert.equal(option('pressure-fall').measuredAt, now - 1000);
    assert.match(option('pressure-fall').label, /history warming/);
    assert.ok(result.options.every((o) => o.label.length <= 80));
});
test('depth offset and oil/RPM use the older dependency clock and refuse stale/conflicting units', () => {
    const doc = {
        environment: { depth: { belowTransducer: leaf(5, 'm'), transducerToKeel: leaf(1, 'm', now - 4000) } },
        propulsion: { main: { oilPressure: leaf(100000, 'Pa'), revolutions: leaf(20, 'Hz', now - 5000) } },
    };
    let result = wakeSensorCatalogue(context(doc));
    assert.equal(result.options.find((o) => o.preset === 'depth-below-keel')?.reading?.at, now - 4000);
    assert.equal(result.options.find((o) => o.preset === 'engine-oil-below')?.reading?.at, now - 5000);
    doc.environment.depth.transducerToKeel.meta.units = 'ft';
    result = wakeSensorCatalogue(context(doc));
    assert.equal(
        result.options.find((o) => o.preset === 'depth-below-keel')?.reading?.depthBasis,
        'conservative-full-draft',
    );
    doc.propulsion.main.revolutions.timestamp = new Date(now - 20_000).toISOString();
    assert.equal(
        wakeSensorCatalogue(context(doc)).options.some((o) => o.preset === 'engine-oil-below'),
        false,
    );
});
test('no aggregate engine, guessed battery, cloud/locality override, forecast pressure or inherited timestamps qualify', () => {
    const doc = {
        environment: {
            wind: { timestamp: new Date(now).toISOString(), speedTrue: { value: 12, $source: 'fictional.1' } },
            outside: { pressure: leaf(1013, 'hPa') },
        },
        propulsion: { port: { revolutions: leaf(20, 'Hz') }, starboard: { revolutions: leaf(20, 'Hz') } },
        electrical: { voltage: leaf(12, 'V') },
    };
    assert.deepEqual(wakeSensorCatalogue(context(doc)), { options: [], truncated: false });
    assert.equal(wakeStationPressure(context(doc)), null);
    assert.deepEqual(wakeSensorCatalogue({ ...context(doc), localBoatSource: false }), {
        options: [],
        truncated: false,
    });
    const pressure = { environment: { outside: { pressure: leaf(101000, 'Pa') } } };
    assert.deepEqual(wakeSensorCatalogue({ ...context(pressure), feedId: '' }), { options: [], truncated: false });
    assert.equal(wakeStationPressure({ ...context(pressure), now: NaN }), null);
});
test('catalogue explicitly reports bounded bank truncation without source substitution', () => {
    const batteries = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
            `bank${String(i).padStart(2, '0')}`,
            { voltage: leaf(12 + i / 100, 'V') },
        ]),
    );
    const result = wakeSensorCatalogue(context({ electrical: { batteries } }));
    assert.equal(result.options.length, 16);
    assert.equal(result.truncated, true);
    assert.deepEqual(
        result.options.map((o) => o.selection.instance),
        Object.keys(batteries).slice(0, 16),
    );
});
