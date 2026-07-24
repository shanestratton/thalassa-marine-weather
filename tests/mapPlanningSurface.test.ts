import { describe, expect, it } from 'vitest';
import { shouldSuppressChartOverlays } from '../components/map/mapConstants';

describe('MapHub planning-surface classification', () => {
    it.each([
        ['ordinary Chart browsing', false, false, false, false],
        ['RoutePlanner-owned map', true, false, false, true],
        ['manual route tracer', false, true, false, true],
        ['computed passage', false, false, true, true],
        ['planner map showing a passage', true, false, true, true],
    ])('%s', (_label, cleanPlanningMap, tracing, showingPassage, expected) => {
        expect(shouldSuppressChartOverlays(cleanPlanningMap, tracing, showingPassage)).toBe(expected);
    });
});
