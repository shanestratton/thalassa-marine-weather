import { describe, expect, it } from 'vitest';
import { effectiveChartContours, parseChartContours, suggestedChartContours } from '../services/enc/chartContours';
const custom = { shallowM: 2, safetyM: 3, deepM: 20, reliefSafety: true };
describe('mariner contour display preferences', () => {
    it('rejects nonfinite, missing, unordered and out-of-range preferences as a whole', () => {
        expect(parseChartContours(custom)).toEqual(custom);
        for (const bad of [
            null,
            {},
            [],
            { ...custom, shallowM: 0 },
            { ...custom, safetyM: 2 },
            { ...custom, deepM: 3 },
            { ...custom, deepM: 6001 },
            { ...custom, safetyM: '3' },
            { ...custom, reliefSafety: 1 },
            { ...custom, deepM: Infinity },
            { ...custom, safetyM: NaN },
        ])
            expect(parseChartContours(bad)).toBeNull();
    });
    it('never lowers the existing vessel requirement, retains a higher chosen contour and keeps deep above safety', () => {
        expect(effectiveChartContours(custom, 2.9)).toEqual(custom);
        expect(effectiveChartContours(custom, 5)).toEqual({ ...custom, safetyM: 5 });
        expect(effectiveChartContours(custom, 30)).toEqual({ ...custom, safetyM: 30, deepM: 31 });
        expect(effectiveChartContours(custom, 5999.5)).toEqual({ ...custom, safetyM: 5999.5, deepM: 6000 });
        for (const missing of [NaN, Infinity, 0, -1, 6000]) expect(effectiveChartContours(custom, missing)).toBeNull();
    });
    it('makes bounded ordered suggestions for small and large vessels, without persisting or inventing a tide offset', () => {
        for (const required of [0.15, 0.5, 2.9, 10, 100, 5999.5]) {
            const suggested = suggestedChartContours(required)!;
            expect(parseChartContours(suggested)).toEqual(suggested);
            expect(suggested.safetyM).toBeGreaterThanOrEqual(required);
            expect(suggested.reliefSafety).toBe(false);
            expect(suggested).not.toHaveProperty('tide');
        }
        expect(suggestedChartContours(NaN)).toBeNull();
    });
});
