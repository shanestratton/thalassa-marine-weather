/**
 * Reading the boat off Signal K for the always-on track.
 *
 * The fixture below is Calypso's REAL self document, trimmed — envelopes,
 * meta blocks and all. That matters: the first version of the path walker only
 * unwrapped Signal K's { value } envelope at the END of a path, so
 * `navigation.position.latitude` came back undefined, every fix was declined,
 * and the recorder would have kept an empty track for ever without erroring
 * once. A handwritten fixture would have hidden it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTrackFix } from './trackSignalk.js';

/** Trimmed from Calypso, 2026-08-29T19:48Z, source ydwg-tcp.YD. */
const SELF = {
    navigation: {
        position: {
            meta: { description: 'The position of the vessel' },
            value: { latitude: -27.195103333333332, longitude: 153.10556 },
            $source: 'ydwg-tcp.YD',
            timestamp: '2026-08-29T19:48:49.000Z',
            sentence: 'RMC',
        },
        datetime: {
            meta: { description: 'Time and Date from the GNSS Positioning System' },
            value: '2026-08-29T19:48:49.820Z',
            sentence: 'ZDA',
        },
        speedOverGround: { meta: { units: 'm/s' }, value: 3.0 },
        courseOverGroundTrue: { meta: { units: 'rad' }, value: Math.PI / 2 },
        speedThroughWater: { meta: { units: 'm/s' }, value: 2.5 },
        headingTrue: { meta: { units: 'rad' }, value: 0.6562437988997077 },
        headingMagnetic: { meta: { units: 'rad' }, value: 0.4642575811364954 },
    },
    environment: {
        wind: {
            speedTrue: { meta: { units: 'm/s' }, value: 3.5 },
            directionTrue: { meta: { units: 'rad' }, value: 3.2375857631887177 },
        },
        water: { temperature: { meta: { units: 'K' }, value: 290.84999999999997 } },
    },
};

test('reads a position out of Signal K’s nested envelopes', () => {
    const fix = readTrackFix(SELF);
    assert.ok(fix, 'a real document must yield a fix');
    assert.equal(fix.lat, -27.195103333333332);
    assert.equal(fix.lon, 153.10556);
});

test('stamps the point with GPS time, not the receipt time', () => {
    // navigation.datetime is the GNSS clock (ZDA). position.timestamp is when
    // Signal K received it, off the Pi's own clock — which is the clock that
    // cannot be trusted.
    const fix = readTrackFix(SELF);
    assert.equal(fix?.gpsTimeMs, Date.parse('2026-08-29T19:48:49.820Z'));
});

test('a document with no GPS datetime yields an unrecordable fix', () => {
    const { datetime, ...rest } = SELF.navigation;
    const fix = readTrackFix({ ...SELF, navigation: rest });
    assert.ok(fix);
    assert.equal(fix.gpsTimeMs, null);
});

test('converts every SI unit the log does not speak', () => {
    const fix = readTrackFix(SELF);
    assert.ok(fix);
    // m/s → knots
    assert.ok(Math.abs((fix.sogKts ?? 0) - 3.0 * 1.94384) < 1e-9);
    assert.ok(Math.abs((fix.stwKts ?? 0) - 2.5 * 1.94384) < 1e-9);
    assert.ok(Math.abs((fix.twsKts ?? 0) - 3.5 * 1.94384) < 1e-9);
    // radians → degrees
    assert.ok(Math.abs((fix.cogDeg ?? 0) - 90) < 1e-9);
    assert.ok(Math.abs((fix.twdDeg ?? 0) - 185.5) < 0.1);
    assert.ok(Math.abs((fix.hdgDeg ?? 0) - 37.6) < 0.1);
    // Kelvin → °C. Recording 290.85 as a sea temperature would not throw; it
    // would just be wrong for years.
    assert.ok(Math.abs((fix.waterTempC ?? 0) - 17.7) < 0.01);
});

test('prefers TRUE heading, so the log does not mistake variation for current', () => {
    // COG is true. A magnetic heading against a true course would turn the
    // difference — the leeway and set this log exists to capture — into the
    // local variation, 11°E here, and look like a permanent easterly set.
    const fix = readTrackFix(SELF);
    assert.ok(Math.abs((fix?.hdgDeg ?? 0) - (0.6562437988997077 * 180) / Math.PI) < 1e-9);
});

test('drops COG when the boat is stopped', () => {
    // At anchor she swings the whole compass. Recording that is recording the
    // weathervane, and it makes every gust look like a turn.
    const stopped = {
        ...SELF,
        navigation: { ...SELF.navigation, speedOverGround: { value: 0 } },
    };
    const fix = readTrackFix(stopped);
    assert.equal(fix?.cogDeg, null);
    assert.equal(fix?.sogKts, 0);
});

test('absent instruments are null columns, not a lost point', () => {
    // Depth, heel and pressure are all missing from Calypso's bus today.
    const fix = readTrackFix(SELF);
    assert.ok(fix, 'the point still records');
    assert.equal(fix.depthM, null);
    assert.equal(fix.heelDeg, null);
    assert.equal(fix.pressureHpa, null);
});

test('refuses a document with no position at all', () => {
    assert.equal(readTrackFix({ navigation: { datetime: { value: '2026-08-29T19:48:49Z' } } }), null);
    assert.equal(readTrackFix({}), null);
    assert.equal(readTrackFix(null), null);
});

test('refuses Null Island', () => {
    // 0,0 is a coordinate, not a position — it is the Gulf of Guinea, and it
    // is what a receiver reports when it has nothing.
    const nowhere = {
        ...SELF,
        navigation: { ...SELF.navigation, position: { value: { latitude: 0, longitude: 0 } } },
    };
    assert.equal(readTrackFix(nowhere), null);
});

test('normalises a bearing rather than emitting a negative one', () => {
    const westish = {
        ...SELF,
        navigation: {
            ...SELF.navigation,
            speedOverGround: { value: 3 },
            courseOverGroundTrue: { value: -Math.PI / 2 },
        },
    };
    assert.ok(Math.abs((readTrackFix(westish)?.cogDeg ?? 0) - 270) < 1e-9);
});
