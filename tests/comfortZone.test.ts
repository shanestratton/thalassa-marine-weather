/**
 * ComfortZoneEngine — Unit tests for comfort limit functions
 *
 * Tests: hasActiveComfortLimits, exceedsComfortLimits
 * (generateComfortZoneOverlay uses canvas — needs browser, skipped here)
 */

import { describe, it, expect } from 'vitest';
import { hasActiveComfortLimits, exceedsComfortLimits } from '../services/ComfortZoneEngine';

// ── hasActiveComfortLimits ──

describe('hasActiveComfortLimits', () => {
    it('returns false for undefined params', () => {
        expect(hasActiveComfortLimits(undefined)).toBe(false);
    });

    it('returns false for empty params', () => {
        expect(hasActiveComfortLimits({})).toBe(false);
    });

    it('returns true when maxWindKts is set', () => {
        expect(hasActiveComfortLimits({ maxWindKts: 25 })).toBe(true);
    });

    it('returns true when maxWaveM is set', () => {
        expect(hasActiveComfortLimits({ maxWaveM: 3 })).toBe(true);
    });

    it('returns true when maxGustKts is set', () => {
        expect(hasActiveComfortLimits({ maxGustKts: 35 })).toBe(true);
    });

    it('returns true when all params are set', () => {
        expect(hasActiveComfortLimits({ maxWindKts: 25, maxWaveM: 3, maxGustKts: 35 })).toBe(true);
    });
});

// ── exceedsComfortLimits ──

describe('exceedsComfortLimits', () => {
    const defaultParams = { maxWindKts: 25, maxGustKts: 35, maxWaveM: 3 };

    it('returns false when all values are under limits', () => {
        expect(exceedsComfortLimits(20, 30, 2, defaultParams)).toBe(false);
    });

    it('returns true when wind exceeds limit', () => {
        expect(exceedsComfortLimits(30, 30, 2, defaultParams)).toBe(true);
    });

    it('returns true when gusts exceed limit', () => {
        expect(exceedsComfortLimits(20, 40, 2, defaultParams)).toBe(true);
    });

    it('returns true when waves exceed limit', () => {
        expect(exceedsComfortLimits(20, 30, 4, defaultParams)).toBe(true);
    });

    it('returns false when wind equals limit (not exceeded)', () => {
        expect(exceedsComfortLimits(25, 30, 2, defaultParams)).toBe(false);
    });

    it('returns false when gusts equals limit', () => {
        expect(exceedsComfortLimits(20, 35, 2, defaultParams)).toBe(false);
    });

    it('returns false when waves equals limit', () => {
        expect(exceedsComfortLimits(20, 30, 3, defaultParams)).toBe(false);
    });

    it('handles null gust (ignores gust check)', () => {
        expect(exceedsComfortLimits(20, null, 2, defaultParams)).toBe(false);
    });

    it('handles null wave height (ignores wave check)', () => {
        expect(exceedsComfortLimits(20, 30, null, defaultParams)).toBe(false);
    });

    it('handles both null (only checks wind)', () => {
        expect(exceedsComfortLimits(20, null, null, defaultParams)).toBe(false);
        expect(exceedsComfortLimits(30, null, null, defaultParams)).toBe(true);
    });

    it('handles partial params (only wind limit)', () => {
        expect(exceedsComfortLimits(20, 50, 10, { maxWindKts: 25 })).toBe(false);
        expect(exceedsComfortLimits(30, 50, 10, { maxWindKts: 25 })).toBe(true);
    });

    it('handles partial params (only wave limit)', () => {
        expect(exceedsComfortLimits(100, 100, 2, { maxWaveM: 3 })).toBe(false);
        expect(exceedsComfortLimits(100, 100, 4, { maxWaveM: 3 })).toBe(true);
    });
});
