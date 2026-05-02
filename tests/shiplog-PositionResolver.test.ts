/**
 * Tests for PositionResolver — focused on the staleness boundaries since
 * the resolver is otherwise a thin forwarder over GpsService /
 * BgGeoManager / NmeaGpsProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGpsNavData, getGpsStatus } from '../services/shiplog/PositionResolver';
import type { CachedPosition } from '../services/BgGeoManager';

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getLastPosition: () => null,
        getFreshPosition: vi.fn(),
    },
}));

function makeFix(ageMs: number, overrides: Partial<CachedPosition> = {}): CachedPosition {
    return {
        latitude: 0,
        longitude: 0,
        accuracy: 5,
        altitude: null,
        heading: 90,
        speed: 5, // m/s = ~9.7 kts
        timestamp: Date.now() - ageMs,
        receivedAt: Date.now() - ageMs,
        ...overrides,
    } as CachedPosition;
}

describe('getGpsStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns "none" when no fix is supplied and not native', () => {
        expect(getGpsStatus(null, false)).toBe('none');
    });

    it('returns "locked" for fixes < 60s old', () => {
        expect(getGpsStatus(makeFix(30_000), false)).toBe('locked');
    });

    it('returns "stale" for fixes 60s–5min old', () => {
        expect(getGpsStatus(makeFix(120_000), false)).toBe('stale');
        expect(getGpsStatus(makeFix(290_000), false)).toBe('stale');
    });

    it('returns "none" for fixes > 5min old', () => {
        expect(getGpsStatus(makeFix(310_000), false)).toBe('none');
    });
});

describe('getGpsNavData', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns nulls when no fix is supplied', () => {
        expect(getGpsNavData(null, false)).toEqual({ sogKts: null, cogDeg: null });
    });

    it('returns nulls when fix is stale', () => {
        expect(getGpsNavData(makeFix(120_000), false)).toEqual({ sogKts: null, cogDeg: null });
    });

    it('converts m/s → knots and rounds heading for fresh fixes', () => {
        const fix = makeFix(5_000, { speed: 5, heading: 92.7 });
        expect(getGpsNavData(fix, false)).toEqual({ sogKts: 9.7, cogDeg: 93 });
    });

    it('returns null sog when speed is missing or negative', () => {
        const fixNoSpeed = makeFix(5_000, { speed: undefined as unknown as number });
        expect(getGpsNavData(fixNoSpeed, false).sogKts).toBeNull();
        const fixNeg = makeFix(5_000, { speed: -1 });
        expect(getGpsNavData(fixNeg, false).sogKts).toBeNull();
    });

    it('returns null cog when heading is missing or negative', () => {
        const fixNoHdg = makeFix(5_000, { heading: undefined as unknown as number });
        expect(getGpsNavData(fixNoHdg, false).cogDeg).toBeNull();
        const fixNeg = makeFix(5_000, { heading: -1 });
        expect(getGpsNavData(fixNeg, false).cogDeg).toBeNull();
    });
});
