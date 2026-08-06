import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOB must mark INSTANTLY from the position already held, and never wait for a
 * fresh fix.
 *
 * Shane, 2026-08-07: "the first time that you press it, it takes quite a while
 * to mark the position." activate() was awaiting
 * getCurrentPosition({ staleLimitMs: 15_000, timeoutSec: 6 }) — a six-second
 * stare on a cold receiver, and NOTHING at all if it timed out.
 *
 * Waiting makes a MOB mark worse, not better: the boat keeps moving away from
 * the incident while the fix resolves. At 6 kt those six seconds are ~18 m of
 * error added to the casualty's drift. A position from a few seconds ago is
 * closer to where the person actually went in than a perfect fix taken later.
 */

const mocks = vi.hoisted(() => ({
    getCurrentPosition: vi.fn(),
    cached: null as { lat: number; lon: number; sog: number; timestamp: number; cog: number; source: 'gps' } | null,
    lastKnown: null as {
        latitude: number;
        longitude: number;
        accuracy: number;
        timestamp: number;
        speed: number;
        heading: null;
        altitude: null;
    } | null,
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        // Live-fix cache MOB reads before any blocking acquisition.
        getLastKnownPosition: () => mocks.lastKnown,
        getCurrentPosition: mocks.getCurrentPosition,
        watchPosition: () => () => {},
    },
}));
vi.mock('../services/ownshipPosition', () => ({
    getCachedOwnshipPosition: () => mocks.cached,
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    },
}));
vi.mock('@capacitor/haptics', () => ({ Haptics: { impact: vi.fn(async () => {}) }, ImpactStyle: { Heavy: 'HEAVY' } }));
vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: { keepAwake: vi.fn(async () => {}), allowSleep: vi.fn(async () => {}) },
}));
vi.mock('../services/activeSafetyInterlock', () => ({ setLiveMobSafetyState: vi.fn() }));
// authIdentityScope is deliberately NOT mocked — MobService subscribes to it
// in its constructor, and the existing MOB suite uses the real module.

import { MobService, MOB_PRECISE_FIX_ACCURACY_M } from '../services/MobService';

beforeEach(async () => {
    mocks.getCurrentPosition.mockReset();
    mocks.cached = null;
    mocks.lastKnown = null;
    await MobService.clear().catch(() => {});
});

describe('MOB marks instantly', () => {
    it('uses the cached fix and never calls the blocking acquisition', async () => {
        mocks.cached = { lat: -27.2, lon: 153.1, sog: 0, cog: 0, timestamp: Date.now() - 2_000, source: 'gps' };
        mocks.getCurrentPosition.mockImplementation(async () => {
            throw new Error('activate() must not wait for a live fix when a cached one exists');
        });

        const snap = await MobService.activate();

        expect(snap).not.toBeNull();
        expect(snap?.fixLat).toBeCloseTo(-27.2, 5);
        expect(snap?.fixLon).toBeCloseTo(153.1, 5);
        expect(mocks.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('reports a fresh stationary cached mark as precise', async () => {
        // 2 s old, not moving: the estimate is base uncertainty only, so this
        // is allowed to read as a precise datum.
        mocks.cached = { lat: -27.2, lon: 153.1, sog: 0, cog: 0, timestamp: Date.now() - 2_000, source: 'gps' };
        const snap = await MobService.activate();
        expect(snap!.fixAccuracy).toBeLessThan(MOB_PRECISE_FIX_ACCURACY_M);
    });

    it('widens the circle for a stale fix taken at speed, rather than faking a pinpoint', async () => {
        // 60 s old at 6 kt ≈ 185 m of drift. The mark is still worth having —
        // it is a search datum — but it must not claim precision it lacks.
        mocks.cached = { lat: -27.2, lon: 153.1, sog: 6, cog: 90, timestamp: Date.now() - 60_000, source: 'gps' };
        const snap = await MobService.activate();
        expect(snap!.fixAccuracy).toBeGreaterThan(MOB_PRECISE_FIX_ACCURACY_M);
        expect(Number.isFinite(snap!.fixAccuracy)).toBe(true);
    });

    it('uses the last live GPS fix before ever blocking', async () => {
        // The real 8-second case: no NMEA and LocationStore empty (it is
        // written by user actions, not the GPS stream), but the chart's
        // location dot has a live subscription so a fix just went past.
        mocks.cached = null;
        mocks.lastKnown = {
            latitude: -27.25,
            longitude: 153.15,
            accuracy: 9,
            timestamp: Date.now() - 3_000,
            speed: 0,
            heading: null,
            altitude: null,
        };
        mocks.getCurrentPosition.mockImplementation(async () => {
            throw new Error('must not block when a live fix is already held');
        });

        const snap = await MobService.activate();

        expect(snap?.fixLat).toBeCloseTo(-27.25, 5);
        expect(mocks.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('ignores a live fix that is far too old to be a datum', async () => {
        mocks.cached = null;
        mocks.lastKnown = {
            latitude: -27.25,
            longitude: 153.15,
            accuracy: 9,
            timestamp: Date.now() - 10 * 60 * 1000,
            speed: 0,
            heading: null,
            altitude: null,
        };
        mocks.getCurrentPosition.mockResolvedValue({
            latitude: -27.4,
            longitude: 153.3,
            accuracy: 7,
            timestamp: Date.now(),
            speed: 0,
            heading: null,
            altitude: null,
        });

        const snap = await MobService.activate();

        expect(mocks.getCurrentPosition).toHaveBeenCalledOnce();
        expect(snap?.fixLat).toBeCloseTo(-27.4, 5);
    });

    it('falls back to a live acquisition only when there is nothing cached', async () => {
        mocks.cached = null;
        mocks.lastKnown = null;
        mocks.getCurrentPosition.mockResolvedValue({
            latitude: -27.3,
            longitude: 153.2,
            accuracy: 8,
            timestamp: Date.now(),
            speed: 0,
            heading: null,
            altitude: null,
        });

        const snap = await MobService.activate();

        expect(mocks.getCurrentPosition).toHaveBeenCalledOnce();
        expect(snap?.fixLat).toBeCloseTo(-27.3, 5);
    });
});
