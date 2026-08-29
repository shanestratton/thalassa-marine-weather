/**
 * The Pi's always-on track (Shane 2026-08-30).
 *
 * Two rules here are load-bearing rather than cosmetic: a fix with no GPS time
 * is never recorded, because a Pi has no RTC battery and a track stamped from
 * a wrong system clock is misfiled for ever; and a stop keeps its FIRST and
 * LAST fix, because "we sat in that anchorage for fourteen hours" is the fact
 * worth remembering about it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_TRACK_RULES,
    EMPTY_STATE,
    considerFix,
    courseDeltaDeg,
    isStationary,
    logReason,
    type RecorderState,
    type TrackFix,
    type TrackPoint,
} from './trackRecorder.js';

const T0 = 1_756_500_000_000;

function fix(over: Partial<TrackFix> = {}): TrackFix {
    return {
        lat: -27.195,
        lon: 153.105,
        gpsTimeMs: T0,
        sogKts: 5,
        cogDeg: 90,
        depthM: 8.2,
        twsKts: 12,
        twdDeg: 130,
        stwKts: 4.6,
        hdgDeg: 84,
        waterTempC: 21.4,
        pressureHpa: null,
        heelDeg: -6.5,
        ...over,
    };
}

const point = (over: Partial<TrackPoint> = {}): TrackPoint =>
    ({ ...fix(), gpsTimeMs: T0, reason: 'first', ...over }) as TrackPoint;

// ── the clock ──────────────────────────────────────────────────────────────

test('a fix with no GPS time is never recorded', () => {
    // A Pi without an RTC boots at 1970 or at whenever it last was. Better a
    // gap in the track than a lie about when the boat was somewhere.
    assert.equal(logReason(null, fix({ gpsTimeMs: null })), null);
    const { append } = considerFix(EMPTY_STATE, fix({ gpsTimeMs: null }));
    assert.deepEqual(append, []);
});

test('a fix with no GPS time does not disturb the state', () => {
    const state: RecorderState = { last: point(), stopAnchor: null, stopLatest: null };
    const out = considerFix(state, fix({ gpsTimeMs: null }));
    assert.equal(out.state.last, state.last);
});

// ── course arithmetic ──────────────────────────────────────────────────────

test('course delta is the SHORT way round north', () => {
    // 359 to 001 is a two-degree nudge, not a 358-degree turn. Getting this
    // backwards logs a point on every wave heading north, and none at all
    // swinging through south.
    assert.equal(courseDeltaDeg(359, 1), 2);
    assert.equal(courseDeltaDeg(1, 359), 2);
    assert.equal(courseDeltaDeg(10, 350), 20);
    assert.equal(courseDeltaDeg(90, 270), 180);
    assert.equal(courseDeltaDeg(90, 90), 0);
});

// ── when to log ────────────────────────────────────────────────────────────

test('the first fix is always kept', () => {
    assert.equal(logReason(null, fix()), 'first');
});

test('a fix that has barely moved is not kept', () => {
    const last = point();
    assert.equal(logReason(last, fix({ gpsTimeMs: T0 + 5_000 })), null);
});

test('moving far enough logs a point', () => {
    const last = point();
    // ~40 m east of the last point.
    assert.equal(logReason(last, fix({ lon: 153.1054, gpsTimeMs: T0 + 5_000 })), 'distance');
});

test('turning far enough logs a point even without moving', () => {
    const last = point({ cogDeg: 90 });
    assert.equal(logReason(last, fix({ cogDeg: 130, gpsTimeMs: T0 + 5_000 })), 'course');
});

test('a long straight leg still gets a heartbeat', () => {
    const last = point();
    const t = T0 + DEFAULT_TRACK_RULES.heartbeatMs;
    assert.equal(logReason(last, fix({ gpsTimeMs: t })), 'heartbeat');
});

test('a missing course never counts as a turn', () => {
    const last = point({ cogDeg: null });
    assert.equal(logReason(last, fix({ cogDeg: 200, gpsTimeMs: T0 + 1_000 })), null);
});

// ── stopping ───────────────────────────────────────────────────────────────

test('slow and close is stationary; slow and drifting away is not', () => {
    // Speed alone is not enough: a boat drifting at 0.2 kt for six hours has
    // gone a mile.
    const anchor = { lat: -27.195, lon: 153.105 };
    assert.equal(isStationary(anchor, fix({ sogKts: 0.1 })), true);
    assert.equal(isStationary(anchor, fix({ sogKts: 0.1, lon: 153.107 })), false);
    assert.equal(isStationary(anchor, fix({ sogKts: 4 })), false);
});

test('a stop writes nothing while it lasts', () => {
    let state: RecorderState = { last: point(), stopAnchor: null, stopLatest: null };
    for (let i = 1; i <= 200; i += 1) {
        const out = considerFix(state, fix({ sogKts: 0.05, gpsTimeMs: T0 + i * 60_000 }));
        assert.deepEqual(out.append, [], `minute ${i} should write nothing`);
        state = out.state;
    }
});

test('a stop is CLOSED with its last fix, so its duration survives', () => {
    // Fourteen hours at anchor should read as fourteen hours, not as a gap.
    let state: RecorderState = { last: point(), stopAnchor: null, stopLatest: null };
    const stopEndMs = T0 + 14 * 60 * 60_000;
    state = considerFix(state, fix({ sogKts: 0.05, gpsTimeMs: T0 + 60_000 })).state;
    state = considerFix(state, fix({ sogKts: 0.05, gpsTimeMs: stopEndMs })).state;

    const out = considerFix(state, fix({ sogKts: 5, lon: 153.107, gpsTimeMs: stopEndMs + 60_000 }));
    assert.equal(out.append.length, 2);
    assert.equal(out.append[0].reason, 'stop-end');
    assert.equal(out.append[0].gpsTimeMs, stopEndMs);
    assert.equal(out.append[1].reason, 'distance');
    assert.equal(out.state.stopAnchor, null);
});

test('the boat carries her instruments into the log', () => {
    const { append } = considerFix(EMPTY_STATE, fix());
    assert.equal(append.length, 1);
    const p = append[0];
    assert.equal(p.depthM, 8.2);
    assert.equal(p.twsKts, 12);
    assert.equal(p.twdDeg, 130);
    // SOG against STW, and COG against HDG: the difference between each pair
    // is the current the boat actually sat in.
    assert.equal(p.sogKts, 5);
    assert.equal(p.stwKts, 4.6);
    assert.equal(p.cogDeg, 90);
    assert.equal(p.hdgDeg, 84);
    assert.equal(p.waterTempC, 21.4);
    assert.equal(p.heelDeg, -6.5);
});

test('an opening point is written even when she is already stopped', () => {
    // Switching the recorder on at anchor used to write nothing until the boat
    // next moved. "0 points" is indistinguishable from a broken recorder, and
    // it also loses when the stop began. Found on the boat 2026-08-30.
    const { append, state } = considerFix(EMPTY_STATE, fix({ sogKts: 0 }));
    assert.equal(append.length, 1);
    assert.equal(append[0].reason, 'first');
    assert.equal(state.last?.gpsTimeMs, T0);
});

test('the opening point does not disable stop suppression afterwards', () => {
    // It must still go quiet once it has that first point, or a boat left at
    // anchor would log every heartbeat for a week.
    let state: RecorderState = considerFix(EMPTY_STATE, fix({ sogKts: 0 })).state;
    for (let i = 1; i <= 50; i += 1) {
        const out = considerFix(state, fix({ sogKts: 0, gpsTimeMs: T0 + i * 60_000 }));
        assert.deepEqual(out.append, [], `minute ${i} should stay quiet`);
        state = out.state;
    }
});
