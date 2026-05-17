/**
 * Tests for CourseChangeDetector — verifies the position-anchor + heading-
 * baseline algorithm fires only on real turns and not on noise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CourseChangeDetector, degreesToCardinal16, type TurnEvent } from '../services/shiplog/CourseChangeDetector';
import type { CachedPosition } from '../services/BgGeoManager';

// Lock the GPS-precision adapter to a permissive threshold so tests
// aren't at the mercy of accuracy heuristics. 1 metre lets us drive the
// detector with synthetic positions without it filtering them out.
vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getAdaptedThresholds: () => ({ courseChangeMinMovementM: 1 }),
    },
}));

const COURSE_CHECK_INTERVAL_MS = 15_000;

function makePos(lat: number, lon: number): CachedPosition {
    return {
        latitude: lat,
        longitude: lon,
        accuracy: 5,
        altitude: null,
        heading: 0,
        speed: 5,
        timestamp: Date.now(),
        receivedAt: Date.now(),
    } as CachedPosition;
}

describe('degreesToCardinal16', () => {
    it.each([
        [0, 'N'],
        [22.5, 'NNE'],
        [90, 'E'],
        [180, 'S'],
        [270, 'W'],
        [359, 'N'],
        [-22.5, 'NNW'],
    ])('maps %i° to %s', (deg, cardinal) => {
        expect(degreesToCardinal16(deg)).toBe(cardinal);
    });
});

describe('CourseChangeDetector', () => {
    let detector: CourseChangeDetector;
    let onTurn: (e: TurnEvent) => void;
    let turns: TurnEvent[];
    let pos: CachedPosition | null;
    let active: boolean;

    beforeEach(() => {
        vi.useFakeTimers();
        detector = new CourseChangeDetector();
        turns = [];
        onTurn = (e) => turns.push(e);
        pos = null;
        active = true;
    });

    afterEach(() => {
        detector.stop();
        vi.useRealTimers();
    });

    function startWithDefaults() {
        detector.start({
            getPos: () => pos,
            isActive: () => active,
            onTurn,
        });
    }

    it('fires no turns on a straight northward run', () => {
        pos = makePos(0, 0);
        startWithDefaults();
        for (let i = 1; i <= 5; i++) {
            // Move ~111m north each tick — well above the 1m threshold,
            // bearing stays 0° (north) the whole time.
            pos = makePos(0.001 * i, 0);
            vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        }
        expect(turns).toHaveLength(0);
    });

    it('fires once on a clear ~90° turn (north → east)', () => {
        pos = makePos(0, 0);
        startWithDefaults();
        // Tick 1: seed anchor (no turn possible yet)
        pos = makePos(0.001, 0); // 1° → north
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        // Tick 2: still north — seeds baseline
        pos = makePos(0.002, 0);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        expect(turns).toHaveLength(0);
        // Tick 3: now move east — bearing 90° from previous anchor
        pos = makePos(0.002, 0.001);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        expect(turns).toHaveLength(1);
        expect(turns[0].oldCardinal).toBe('N');
        expect(turns[0].newCardinal).toBe('E');
        // Lower bound updated 22.5 → 30 on 2026-05-17 when the firing
        // threshold was raised to filter out helm-trim noise. 90° N→E
        // still trivially clears it (90 ≥ 30), but the explicit bound
        // documents the actual contract.
        expect(turns[0].deltaDeg).toBeGreaterThanOrEqual(30);
    });

    it('does not fire when isActive returns false', () => {
        pos = makePos(0, 0);
        active = false;
        startWithDefaults();
        for (let i = 1; i <= 4; i++) {
            pos = makePos(0.001 * i, 0.001 * i); // clear NE turn
            vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        }
        expect(turns).toHaveLength(0);
    });

    it('skips ticks when getPos returns null', () => {
        pos = null;
        startWithDefaults();
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS * 5);
        expect(turns).toHaveLength(0);
    });

    it('stop() halts further callbacks', () => {
        pos = makePos(0, 0);
        startWithDefaults();
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS); // seed anchor
        pos = makePos(0.001, 0); // baseline north
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        detector.stop();
        pos = makePos(0.001, 0.005); // would have been a clear turn
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS * 5);
        expect(turns).toHaveLength(0);
    });

    it('reset() clears anchor + baseline so a new voyage starts fresh', () => {
        pos = makePos(0, 0);
        startWithDefaults();
        pos = makePos(0.001, 0);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        pos = makePos(0.002, 0);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS); // baseline = N
        detector.reset();
        // After reset, the next two ticks just re-seed; no turn even
        // though we move east now.
        pos = makePos(0.002, 0.001);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        pos = makePos(0.002, 0.002);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        // After reset the next tick seeds anchor, the one after seeds
        // baseline — no turn yet.
        expect(turns).toHaveLength(0);
    });

    it('an exception inside onTurn does not kill the detector loop', () => {
        let calls = 0;
        detector.start({
            getPos: () => pos,
            isActive: () => true,
            onTurn: () => {
                calls++;
                throw new Error('boom');
            },
        });
        pos = makePos(0, 0);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS); // seed
        pos = makePos(0.001, 0);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS); // baseline N
        pos = makePos(0.001, 0.001);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS); // turn → throw
        expect(calls).toBe(1);
        // Continue running — turn back south, expect another fire
        pos = makePos(-0.001, 0.001);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        pos = makePos(-0.005, 0.001);
        vi.advanceTimersByTime(COURSE_CHECK_INTERVAL_MS);
        expect(calls).toBeGreaterThan(1);
    });
});
