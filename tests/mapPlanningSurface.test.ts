import { describe, expect, it } from 'vitest';
import { shouldShowPlanChartKey, shouldSuppressChartOverlays } from '../components/map/mapConstants';

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

    it.each([
        ['ordinary Chart browsing', false, false, false, false, false, false],
        ['RoutePlanner-owned map', true, false, false, false, false, true],
        ['Plan tracer handoff', false, true, false, false, false, true],
        ['direct/manual Chart tracer without a Plan handoff', false, false, false, false, false, false],
        ['computed passage on Chart', false, false, false, false, false, false],
        ['embedded planner map', true, false, true, false, false, false],
        ['planner picker', true, false, false, true, false, false],
        ['planner pin view', true, false, false, false, true, false],
    ])(
        '%s chart-key visibility',
        (_label, cleanPlanningMap, planTracerActive, embedded, pickerMode, pinView, expected) => {
            expect(shouldShowPlanChartKey(cleanPlanningMap, planTracerActive, embedded, pickerMode, pinView)).toBe(
                expected,
            );
        },
    );
});
