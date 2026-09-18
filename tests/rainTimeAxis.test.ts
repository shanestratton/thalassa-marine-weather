/**
 * Which rain frame shows a moment, and how far the rain imagery reaches.
 *
 * Phase 3 of the passage strip: rain follows the look-ahead scrubber where a
 * product reaches. The frames are NOT a uniform axis (10/20/30-minute steps, a
 * seam between observed and forecast that is neither "now" nor contiguous), so
 * a frame is chosen by its clock time, never by index arithmetic — and a moment
 * past the imagery is said to be past it, never shown as the last frame.
 */
import { describe, expect, it } from 'vitest';
import {
    RAIN_BEYOND_MS,
    rainFollowIndex,
    rainFrameForTime,
    rainReachHours,
    snapshotClockMs,
} from '../components/map/rainTimeAxis';

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 19, 3, 16, 0);
const SNAPSHOT = Date.UTC(2026, 8, 19, 3, 0, 0); // on the hour, 16 min old — as probed
const FORECAST_MINUTES = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];

/** Twelve past radar frames every 10 min ending 6 min ago, then the forecast frames. */
const timeline = () => [
    ...Array.from({ length: 12 }, (_, i) => ({ timeMs: NOW - 6 * MIN - (11 - i) * 10 * MIN })),
    ...FORECAST_MINUTES.map((m) => ({ timeMs: SNAPSHOT + m * MIN })),
];

describe('the snapshot id is a clock only when it looks like one', () => {
    it('a recent unix time is believed', () => {
        expect(snapshotClockMs(SNAPSHOT / 1000, NOW)).toBe(SNAPSHOT);
    });

    it('an opaque id, a stale one, or one from the future is NOT — rain then simply does not follow', () => {
        expect(snapshotClockMs(42, NOW)).toBeNull();
        expect(snapshotClockMs((NOW - 4 * 3_600_000) / 1000, NOW)).toBeNull();
        expect(snapshotClockMs((NOW + 3_600_000) / 1000, NOW)).toBeNull();
        expect(snapshotClockMs(null, NOW)).toBeNull();
        expect(snapshotClockMs(Number.NaN, NOW)).toBeNull();
    });
});

describe('the frame for a moment', () => {
    it('is chosen by CLOCK alone: at 03:16 the nearest frame is the 03:20 forecast, not the 03:10 radar', () => {
        // Which is why the follower itself holds the OBSERVED radar at NOW: the
        // helper answers the question it is asked; "now" is not a forecast.
        const frames = timeline();
        const hit = rainFrameForTime(frames, NOW)!;
        expect(frames[hit.index].timeMs).toBe(SNAPSHOT + 20 * MIN);
        expect(hit.beyond).toBe(false);
    });

    it('+1 h 50 lands on the frame for 05:00 (the +120 min one) — by its CLOCK, across the uneven steps', () => {
        const frames = timeline();
        const hit = rainFrameForTime(frames, NOW + 110 * MIN)!;
        expect(frames[hit.index].timeMs).toBe(SNAPSHOT + 120 * MIN);
    });

    it('index arithmetic would have been wrong: ten frames on from now is not +100 minutes', () => {
        const frames = timeline();
        const byClock = rainFrameForTime(frames, NOW + 100 * MIN)!.index;
        expect(byClock).not.toBe(11 + 10);
    });

    it('past the last frame is BEYOND — the last frame is not the answer', () => {
        const frames = timeline();
        const lastMs = SNAPSHOT + 240 * MIN;
        expect(rainFrameForTime(frames, lastMs + RAIN_BEYOND_MS - 1)!.beyond).toBe(false);
        expect(rainFrameForTime(frames, lastMs + RAIN_BEYOND_MS + 1)!.beyond).toBe(true);
        expect(rainFrameForTime(frames, NOW + 20 * 3_600_000)!.beyond).toBe(true);
    });

    it('frames without a time are never chosen; with none at all there is no answer', () => {
        const frames = [{}, { timeMs: NOW }, {}];
        expect(rainFrameForTime(frames, NOW + 5 * MIN)!.index).toBe(1);
        expect(rainFrameForTime([{}, {}], NOW)).toBeNull();
        expect(rainFrameForTime(timeline(), Number.NaN)).toBeNull();
    });

    it('does not need the frames in time order', () => {
        const shuffled = [{ timeMs: NOW + 60 * MIN }, { timeMs: NOW - 10 * MIN }, { timeMs: NOW + 20 * MIN }];
        expect(rainFrameForTime(shuffled, NOW + 25 * MIN)!.index).toBe(2);
    });
});

describe('how far the rain reaches', () => {
    it('is the last frame’s clock minus now: about 3 h 44 with a 16-minute-old snapshot, not a flat four hours', () => {
        expect(rainReachHours(timeline(), NOW)).toBeCloseTo((240 - 16) / 60, 6);
    });

    it('radar alone reaches nowhere ahead', () => {
        expect(rainReachHours(timeline().slice(0, 12), NOW)).toBeNull();
        expect(rainReachHours([], NOW)).toBeNull();
    });
});

describe('what the chart shows while the skipper looks ahead', () => {
    const frames = timeline();
    const OBSERVED = 11; // the newest radar frame

    it('at NOW it is the newest OBSERVED frame — not the clock-nearest, which is a forecast', () => {
        expect(rainFollowIndex(frames, OBSERVED, NOW, 0)).toBe(OBSERVED);
        expect(rainFollowIndex(frames, OBSERVED, NOW, 9 * MIN)).toBe(OBSERVED);
    });

    it('within reach it is the frame for that moment, by clock, always an integer', () => {
        const i = rainFollowIndex(frames, OBSERVED, NOW, 110 * MIN);
        expect(Number.isInteger(i)).toBe(true);
        expect(frames[i].timeMs).toBe(SNAPSHOT + 120 * MIN);
    });

    it('past the reach it goes BACK to observed radar — the +4 h frame is never held under tomorrow’s clock', () => {
        expect(rainFollowIndex(frames, OBSERVED, NOW, 20 * 3_600_000)).toBe(OBSERVED);
    });

    it('frames with no clock (radar only, or a snapshot that is not a clock) just stay on observed radar', () => {
        const untimed = frames.map((f, i) => (i < 12 ? f : {}));
        expect(rainFollowIndex(untimed, OBSERVED, NOW, 110 * MIN)).toBe(OBSERVED);
    });

    it('never hands back an index outside the frames, whatever it is given', () => {
        expect(rainFollowIndex(frames, 999, NOW, 0)).toBe(frames.length - 1);
        expect(rainFollowIndex(frames, -5, NOW, 0)).toBe(0);
        expect(rainFollowIndex(frames, Number.NaN, NOW, Number.NaN)).toBe(0);
    });
});
