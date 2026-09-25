import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTelemetrySnapshot, TRUE_HEADING_MAX_AGE_MS } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';

const now = Date.parse('2026-09-24T07:00:00Z');
const rad = Math.PI / 180;
const leaf = (value: unknown, at = now - 1_000) => ({ value, timestamp: new Date(at).toISOString() });
const snapshot = (navigation: Record<string, unknown>, at = now) =>
    readTelemetrySnapshot({ navigation: { speedOverGround: { value: 0 }, ...navigation } }, () => at)!;
const absent = (navigation: Record<string, unknown>) => {
    const extra = snapshot(navigation).extra;
    assert.equal(extra?.heading_true_deg, undefined);
    assert.equal(extra?.heading_true_at_ms, undefined);
};

test('publishes real true heading and original time through existing wire extra', () => {
    const value = snapshot({ headingTrue: leaf(90 * rad) });
    assert.deepEqual(value.extra, { heading_true_deg: 90, heading_true_at_ms: now - 1_000 });
    assert.deepEqual(buildTelemetryBody(value, 'test').extra, value.extra);
    assert.equal(value.headingDeg, 90, 'legacy output unchanged');
});

test('north is valid and fresh true heading wins over magnetic', () => {
    const value = snapshot({
        headingTrue: leaf(0),
        headingMagnetic: leaf(80 * rad),
        magneticVariation: leaf(10 * rad),
    });
    assert.equal(value.extra?.heading_true_deg, 0);
    assert.equal(value.extra?.heading_true_at_ms, now - 1_000);
    assert.equal(snapshot({ headingTrue: leaf(2 * Math.PI) }).extra?.heading_true_deg, 0);
});

test('converts only qualified magnetic heading with fresh east/west signed variation', () => {
    for (const [heading, variation, expected] of [
        [350, 20, 10],
        [5, -15, 350],
        [90, 0, 90],
    ]) {
        const value = snapshot({
            headingMagnetic: leaf(heading * rad, now - 2_000),
            magneticVariation: leaf(variation * rad, now - 3_000),
        });
        assert.ok(Math.abs(Number(value.extra?.heading_true_deg) - expected) < 1e-9);
        assert.equal(value.extra?.heading_true_at_ms, now - 2_000);
        assert.ok(Math.abs(value.headingDeg! - heading) < 1e-9, 'legacy remains magnetic');
    }
});

test('missing or stale variation never silently labels magnetic as true', () => {
    absent({ headingMagnetic: leaf(120 * rad) });
    absent({ headingMagnetic: leaf(120 * rad), magneticVariation: { value: 0 } });
    absent({ headingMagnetic: leaf(120 * rad), magneticVariation: leaf(0, now - TRUE_HEADING_MAX_AGE_MS) });
    absent({ headingMagnetic: leaf(120 * rad), magneticVariation: leaf(0, now + 1) });
});

test('stale true heading permits a fully qualified fresh magnetic fallback', () => {
    const value = snapshot({
        headingTrue: leaf(0, now - TRUE_HEADING_MAX_AGE_MS),
        headingMagnetic: leaf(80 * rad),
        magneticVariation: leaf(10 * rad),
    });
    assert.equal(value.extra?.heading_true_deg, 90);
});

test('rejects future/stale/missing/bad timestamps without borrowing a parent or GPS clock', () => {
    for (const headingTrue of [
        leaf(1, now + 1),
        leaf(1, now - TRUE_HEADING_MAX_AGE_MS),
        { value: 1 },
        { value: 1, timestamp: 'bad' },
    ]) {
        absent({ timestamp: new Date(now).toISOString(), datetime: leaf(new Date(now).toISOString()), headingTrue });
    }
});

test('repeated polling never makes a stopped heading sensor fresh again', () => {
    const navigation = { headingTrue: leaf(45 * rad) };
    assert.equal(snapshot(navigation, now + 1_000).extra?.heading_true_at_ms, now - 1_000);
    assert.equal(snapshot(navigation, now + TRUE_HEADING_MAX_AGE_MS).extra?.heading_true_deg, undefined);
});

test('rejects nonfinite, nonnumeric and out-of-range angular values', () => {
    for (const value of [NaN, Infinity, '1', -0.1, 2 * Math.PI + 0.1]) absent({ headingTrue: leaf(value) });
    for (const value of [NaN, Infinity, '1', -Math.PI - 0.1, Math.PI + 0.1]) {
        absent({ headingMagnetic: leaf(1), magneticVariation: leaf(value) });
    }
});
