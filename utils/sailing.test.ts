/**
 * Unit tests for utils/sailing.ts — Maritime calculation functions
 * Tests cover hull speed, stability ratios, sailing scores, Beaufort scale, and tide status
 */
import { describe, it, expect } from 'vitest';
import {
    calculateHullSpeed,
    calculateMCR,
    calculateCSF,
    calculateDLR,
    getTideStatus,
    calculateDailyScore,
    getSailingScoreColor,
    getSailingConditionText,
    getBeaufort,
} from './sailing';

describe('calculateHullSpeed', () => {
    it('calculates hull speed for 30ft LWL', () => {
        const speed = calculateHullSpeed(30);
        expect(speed).toBeCloseTo(1.34 * Math.sqrt(30), 2);
        expect(speed).toBeCloseTo(7.34, 1);
    });

    it('longer waterline = faster hull speed', () => {
        expect(calculateHullSpeed(40)).toBeGreaterThan(calculateHullSpeed(30));
    });

    it('returns 0 for 0 LWL', () => {
        expect(calculateHullSpeed(0)).toBe(0);
    });
});

describe('calculateMCR', () => {
    it('returns a positive number for valid inputs', () => {
        const mcr = calculateMCR(20000, 40, 12);
        expect(mcr).toBeGreaterThan(0);
    });
});

describe('calculateCSF', () => {
    it('returns a positive number', () => {
        expect(calculateCSF(20000, 12)).toBeGreaterThan(0);
    });
});

describe('calculateDLR', () => {
    it('returns a positive number', () => {
        const dlr = calculateDLR(15000, 30);
        expect(dlr).toBeGreaterThan(0);
    });

    it('heavier displacement = higher DLR', () => {
        expect(calculateDLR(30000, 30)).toBeGreaterThan(calculateDLR(15000, 30));
    });
});

describe('getTideStatus', () => {
    const mkHourly = (heights: number[]) => heights.map(h => ({ tideHeight: h }));

    it('returns "high" at local peak', () => {
        const hourly = mkHourly([1.0, 2.0, 3.0, 2.0, 1.0]);
        expect(getTideStatus(2, hourly as never)).toBe('high');
    });

    it('returns "low" at local trough', () => {
        const hourly = mkHourly([3.0, 2.0, 1.0, 2.0, 3.0]);
        expect(getTideStatus(2, hourly as never)).toBe('low');
    });

    it('returns "rising" when increasing', () => {
        const hourly = mkHourly([1.0, 2.0, 3.0, 4.0, 5.0]);
        expect(getTideStatus(2, hourly as never)).toBe('rising');
    });

    it('returns "falling" when decreasing', () => {
        const hourly = mkHourly([5.0, 4.0, 3.0, 2.0, 1.0]);
        expect(getTideStatus(2, hourly as never)).toBe('falling');
    });

    it('returns "steady" at boundary (idx=0)', () => {
        const hourly = mkHourly([2.0, 3.0]);
        expect(getTideStatus(0, hourly as never)).toBe('steady');
    });
});

describe('calculateDailyScore', () => {
    it('perfect conditions = 100', () => {
        expect(calculateDailyScore(10, 0.5)).toBe(100);
    });

    it('extreme wind = very low score', () => {
        expect(calculateDailyScore(50, 1)).toBeLessThanOrEqual(20);
    });

    it('extreme waves = very low score', () => {
        expect(calculateDailyScore(10, 15)).toBeLessThanOrEqual(10);
    });

    it('calm wind penalizes sailboats', () => {
        const sailScore = calculateDailyScore(3, 0.5, { type: 'sail' } as never);
        expect(sailScore).toBeLessThan(100);
    });

    it('calm wind does not penalize powerboats', () => {
        const powerScore = calculateDailyScore(3, 0.5, { type: 'power' } as never);
        expect(powerScore).toBe(100);
    });

    it('score is clamped 0-100', () => {
        expect(calculateDailyScore(80, 20)).toBeGreaterThanOrEqual(0);
        expect(calculateDailyScore(0, 0)).toBeLessThanOrEqual(100);
    });
});

describe('getSailingScoreColor', () => {
    it('≥80 = emerald', () => expect(getSailingScoreColor(85)).toContain('emerald'));
    it('≥60 = blue', () => expect(getSailingScoreColor(65)).toContain('blue'));
    it('≥40 = yellow', () => expect(getSailingScoreColor(45)).toContain('yellow'));
    it('<40 = red', () => expect(getSailingScoreColor(20)).toContain('red'));
});

describe('getSailingConditionText', () => {
    it('≥80 = Excellent', () => expect(getSailingConditionText(85)).toBe('Excellent'));
    it('≥60 = Good', () => expect(getSailingConditionText(65)).toBe('Good'));
    it('≥40 = Fair', () => expect(getSailingConditionText(45)).toBe('Fair'));
    it('<40 = Poor', () => expect(getSailingConditionText(20)).toBe('Poor'));
});

describe('getBeaufort', () => {
    it('null returns force 0, Unknown', () => {
        const b = getBeaufort(null);
        expect(b.force).toBe(0);
        expect(b.desc).toBe('Unknown');
    });

    it('0 knots = Calm (force 0)', () => {
        expect(getBeaufort(0).force).toBe(0);
        expect(getBeaufort(0).desc).toBe('Calm');
    });

    it('5 knots = Light Breeze (force 2)', () => {
        expect(getBeaufort(5).force).toBe(2);
    });

    it('15 knots = Moderate Breeze (force 4)', () => {
        expect(getBeaufort(15).force).toBe(4);
    });

    it('35 knots = Gale (force 8)', () => {
        expect(getBeaufort(35).force).toBe(8);
    });

    it('65+ knots = Hurricane (force 12)', () => {
        expect(getBeaufort(70).force).toBe(12);
        expect(getBeaufort(70).desc).toBe('Hurricane');
    });

    it('always returns sea state description', () => {
        const b = getBeaufort(25);
        expect(b.sea).toBeTruthy();
        expect(b.sea.length).toBeGreaterThan(0);
    });
});
