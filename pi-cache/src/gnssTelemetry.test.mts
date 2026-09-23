import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';

const now = Date.parse('2026-09-21T00:19:40Z');
const source = 'ydwg-tcp.YD';
const leaf = (value: unknown, at = now, receiver = source) => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: receiver,
});
const document = (gnss: Record<string, unknown>) => ({
    navigation: {
        position: leaf({ latitude: -27.2, longitude: 153.1 }),
        datetime: leaf(new Date(now).toISOString()),
        gnss,
    },
});
const extra = (gnss: Record<string, unknown>) => readTelemetrySnapshot(document(gnss), () => now)!.extra!;

test('publishes actual satellites/HDOP/quality with original times and no invented metres', () => {
    const snapshot = readTelemetrySnapshot(
        document({
            satellites: leaf(32, now - 1_000),
            horizontalDilution: leaf(0.47, now - 2_000),
            methodQuality: leaf('DGNSS fix', now - 3_000),
        }),
        () => now,
    )!;
    const wire = buildTelemetryBody(snapshot, 'test-boat');
    assert.deepEqual(wire.extra, {
        gnss_satellites: 32,
        gnss_satellites_at_ms: now - 1_000,
        gnss_hdop: 0.47,
        gnss_hdop_at_ms: now - 2_000,
        gnss_fix_quality: 2,
        gnss_fix_quality_at_ms: now - 3_000,
        gnss_source: source,
        position_at: now,
    });
    assert.equal(snapshot.extra?.gnss_accuracy_m, undefined);
});

test('selects exact source-key envelope instead of the USB last writer', () => {
    const values = extra({
        satellites: { ...leaf(11, now, 'ublox-gps.GP'), values: { [source]: leaf(32, now - 2_000) } },
        methodQuality: leaf('GNSS Fix', now, 'ublox-gps.GP'),
    });
    assert.equal(values.gnss_satellites, 32);
    assert.equal(values.gnss_satellites_at_ms, now - 2_000);
    assert.equal(values.gnss_fix_quality, undefined);
});

test('fresh GPS clock never revives absent, old, future, or wrong-receiver diagnostics', () => {
    for (const satellites of [
        leaf(32, now - 13_001),
        leaf(32, now + 1_001),
        { value: 32, $source: source },
        leaf(32, now, 'ydwg-other.YD'),
    ]) {
        assert.equal(extra({ satellites }).gnss_satellites, undefined);
    }
    const noSource = document({ satellites: leaf(32) });
    delete (noSource.navigation.position as Partial<ReturnType<typeof leaf>>).$source;
    assert.equal(readTelemetrySnapshot(noSource, () => now)?.extra?.gnss_source, undefined);
});

test('preserves no-fix zero values and maps all standard quality codes only', () => {
    assert.equal(
        extra({ satellites: leaf(0), horizontalDilution: leaf(0), methodQuality: leaf('no GPS') }).gnss_fix_quality,
        0,
    );
    for (const [code, quality] of [
        'no GPS',
        'GNSS Fix',
        'DGNSS fix',
        'Precise GNSS',
        'RTK fixed integer',
        'RTK float',
        'Estimated (DR) mode',
        'Manual input',
        'Simulator mode',
    ].entries()) {
        assert.equal(extra({ methodQuality: leaf(quality) }).gnss_fix_quality, code);
    }
    for (const quality of ['Error', 'unknown', 2, null]) {
        assert.equal(extra({ methodQuality: leaf(quality) }).gnss_fix_quality, undefined);
    }
    for (const value of [NaN, Infinity, -1, 2.5, 257, '32']) {
        assert.equal(extra({ satellites: leaf(value) }).gnss_satellites, undefined);
    }
});
