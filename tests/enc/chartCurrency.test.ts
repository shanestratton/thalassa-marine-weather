/**
 * chartCurrency — the chart-age read behind the attribution chip's currency
 * warning. The bug it fixes: the chip coloured only by CATZOC survey
 * quality, so a decade-old edition looked as fresh as this year's. These
 * lock in the fail-safe edges: unknown dates never read as fresh OR stale
 * wrongly, future dates clamp, and the stale threshold doesn't cry wolf.
 */
import { describe, it, expect } from 'vitest';

import { CHART_STALE_YEARS, chartAgeLabel, chartAgeYears, isChartStale } from '../../services/enc/chartCurrency';

const NOW = Date.parse('2026-07-16T00:00:00Z');

describe('chartAgeYears', () => {
    it('computes whole-year age from a full ISO issue date', () => {
        expect(chartAgeYears('2018-07-16', NOW)).toBeCloseTo(8, 1);
        expect(chartAgeYears('2016-01-16', NOW)).toBeCloseTo(10.5, 1);
    });
    it('accepts bare YYYY and YYYY-MM (→ Jan / 1st)', () => {
        expect(chartAgeYears('2020', NOW)).toBeCloseTo(6.5, 1);
        expect(chartAgeYears('2020-06', NOW)).toBeCloseTo(6.1, 1);
    });
    it('returns null for missing/placeholder/unparseable dates — never a wrong age', () => {
        expect(chartAgeYears(null, NOW)).toBeNull();
        expect(chartAgeYears(undefined, NOW)).toBeNull();
        expect(chartAgeYears('', NOW)).toBeNull();
        expect(chartAgeYears('not-a-date', NOW)).toBeNull();
    });
    it('clamps a future issue date to 0', () => {
        expect(chartAgeYears('2030-01-01', NOW)).toBe(0);
    });
});

describe('isChartStale', () => {
    it(`flags at the ${CHART_STALE_YEARS}-year threshold, not before`, () => {
        expect(isChartStale(CHART_STALE_YEARS)).toBe(true);
        expect(isChartStale(CHART_STALE_YEARS - 0.1)).toBe(false);
        expect(isChartStale(11)).toBe(true);
    });
    it('unknown age (null) is NOT stale — no false alarm', () => {
        expect(isChartStale(null)).toBe(false);
    });
    it('a normal 2-year-old chart is not stale', () => {
        expect(isChartStale(2)).toBe(false);
    });
});

describe('chartAgeLabel', () => {
    it('formats years and months, hides brand-new and unknown', () => {
        expect(chartAgeLabel(null)).toBeNull();
        expect(chartAgeLabel(0.02)).toBeNull(); // < 1 month — don't shout "0 yr"
        expect(chartAgeLabel(0.5)).toBe('6 mo');
        expect(chartAgeLabel(1.4)).toBe('1 yr');
        expect(chartAgeLabel(8.2)).toBe('8 yr');
    });
});
