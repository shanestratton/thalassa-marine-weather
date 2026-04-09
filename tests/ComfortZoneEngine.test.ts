/**
 * ComfortZoneEngine — Unit tests
 *
 * Tests the pure threshold-checking functions:
 * hasActiveComfortLimits and exceedsComfortLimits.
 */

import { describe, it, expect } from 'vitest';
import { hasActiveComfortLimits, exceedsComfortLimits } from '../services/ComfortZoneEngine';
import type { ComfortParams } from '../types/settings';

// ── hasActiveComfortLimits ──────────────────────────────────────

describe('hasActiveComfortLimits', () => {
    it('returns false for undefined params', () => {
        expect(hasActiveComfortLimits(undefined)).toBe(false);
    });

    it('returns false for empty params', () => {
        expect(hasActiveComfortLimits({} as ComfortParams)).toBe(false);
    });

    it('returns true when maxWindKts is set', () => {
        expect(hasActiveComfortLimits({ maxWindKts: 25 } as ComfortParams)).toBe(true);
    });

    it('returns true when maxWaveM is set', () => {
        expect(hasActiveComfortLimits({ maxWaveM: 2.5 } as ComfortParams)).toBe(true);
    });

    it('returns true when maxGustKts is set', () => {
        expect(hasActiveComfortLimits({ maxGustKts: 30 } as ComfortParams)).toBe(true);
    });

    it('returns true when multiple limits are set', () => {
        expect(
            hasActiveComfortLimits({
                maxWindKts: 25,
                maxWaveM: 2.5,
                maxGustKts: 30,
            } as ComfortParams),
        ).toBe(true);
    });
});

// ── exceedsComfortLimits ────────────────────────────────────────

describe('exceedsComfortLimits', () => {
    it('returns false when wind is below limit', () => {
        expect(exceedsComfortLimits(15, null, null, { maxWindKts: 25 } as ComfortParams)).toBe(false);
    });

    it('returns true when wind exceeds limit', () => {
        expect(exceedsComfortLimits(30, null, null, { maxWindKts: 25 } as ComfortParams)).toBe(true);
    });

    it('returns true when gust exceeds limit', () => {
        expect(exceedsComfortLimits(15, 35, null, { maxGustKts: 30 } as ComfortParams)).toBe(true);
    });

    it('returns false when gust is null (no data)', () => {
        expect(exceedsComfortLimits(15, null, null, { maxGustKts: 30 } as ComfortParams)).toBe(false);
    });

    it('returns true when wave exceeds limit', () => {
        expect(exceedsComfortLimits(10, null, 3.0, { maxWaveM: 2.5 } as ComfortParams)).toBe(true);
    });

    it('returns false when wave is null (no data)', () => {
        expect(exceedsComfortLimits(10, null, null, { maxWaveM: 2.5 } as ComfortParams)).toBe(false);
    });

    it('returns true when any one limit is exceeded', () => {
        const params = { maxWindKts: 25, maxWaveM: 2.5, maxGustKts: 30 } as ComfortParams;
        // Only wave exceeds
        expect(exceedsComfortLimits(10, 15, 3.0, params)).toBe(true);
    });

    it('returns false when all within limits', () => {
        const params = { maxWindKts: 25, maxWaveM: 2.5, maxGustKts: 30 } as ComfortParams;
        expect(exceedsComfortLimits(15, 20, 1.5, params)).toBe(false);
    });

    it('returns false when no limits configured', () => {
        expect(exceedsComfortLimits(50, 60, 5.0, {} as ComfortParams)).toBe(false);
    });

    it('boundary: exactly at limit does not trigger (> not >=)', () => {
        expect(exceedsComfortLimits(25, null, null, { maxWindKts: 25 } as ComfortParams)).toBe(false);
    });
});
