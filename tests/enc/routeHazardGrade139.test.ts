import { describe, expect, it } from 'vitest';
import { gradeRouteHazard, gradedRouteHazards, routeHazardsForFile } from '../../services/enc/routeHazardGrade';
import type { RouteHazardReportEntry } from '../../services/enc/EncHazardReportService';

const hazard = (patch: Partial<RouteHazardReportEntry> = {}): RouteHazardReportEntry => ({
    cellId: 'US5TEST1',
    sourceHO: 'US',
    hazardType: 'wreck',
    representativePoint: { lat: 12.34567, lon: 123.45678 },
    distanceNm: 0.01,
    side: 'port',
    minDepthM: null,
    description: 'Original chart name',
    ...patch,
});
describe('139 worst-first proximity briefing', () => {
    it.each(['wreck', 'rock', 'obstruction', 'shallow'] as const)(
        'puts an on-track %s with unknown clearance first',
        (hazardType) => {
            expect(gradeRouteHazard(hazard({ hazardType }), 3)).toBe('danger');
        },
    );
    it('does not call charted deep water or distant coast an on-track grounding', () => {
        expect(gradeRouteHazard(hazard({ minDepthM: 8 }), 3)).toBe('caution');
        expect(gradeRouteHazard(hazard({ hazardType: 'coast', distanceNm: 0.5 }), 3)).toBe('note');
    });
    it('keeps a drying patch ahead of a closer deep feature, without mutating source facts', () => {
        const deep = hazard({ minDepthM: 8, distanceNm: 0.001 });
        const drying = hazard({ hazardType: 'shallow', minDepthM: -0.5, distanceNm: 0.04 });
        const entries = Object.freeze([Object.freeze(deep), Object.freeze(drying)]);
        const result = gradedRouteHazards({ entries: [...entries], requiredDepthM: 3 });
        expect(result.map((e) => e.grade)).toEqual(['danger', 'caution']);
        expect(result[0].minDepthM).toBe(-0.5);
        expect(entries[0]).toBe(deep);
    });
    it.each([NaN, Infinity, -1])('preserves invalid distance %s as unknown/caution', (distanceNm) => {
        expect(gradeRouteHazard(hazard({ distanceNm, minDepthM: 8 }), 3)).toBe('caution');
    });
    it.each([undefined, 0, NaN])('never assumes clearance from an invalid boat floor %s', (floor) => {
        expect(gradeRouteHazard(hazard({ minDepthM: 8 }), floor)).toBe('danger');
    });
});

describe('139 licensed hazard file boundary', () => {
    const report = (entries: RouteHazardReportEntry[]) => ({
        entries,
        requiredDepthM: 3,
        cellsConsulted: 2,
        bufferNm: 1,
        advisories: [{ severity: 'caution' as const, text: 'Private licensed chart position 12.34567' }],
    });
    it('returns no protected names, positions, depths, distances or advisory prose', () => {
        const result = routeHazardsForFile(report([hazard({ cellId: 'AU5TEST1', sourceHO: 'AU' })]), (id) => ({
            id,
            sourceHO: 'AU',
        }));
        expect(result).toEqual({ entries: [], withheld: { danger: 1, caution: 0, note: 0 } });
        expect(JSON.stringify(result)).not.toMatch(/12\.34567|123\.45678|Original chart|AU5TEST1|Private licensed/);
    });
    it.each(['missing', 'protected', 'wrong-ho', 'wrong-id'] as const)(
        'refuses a NOAA-looking row when the registry is %s',
        (mode) => {
            const result = routeHazardsForFile(report([hazard()]), (id) =>
                mode === 'missing'
                    ? null
                    : {
                          id: mode === 'wrong-id' ? 'US5OTHER' : id,
                          sourceHO: mode === 'wrong-ho' ? 'AU' : 'US',
                          ...(mode === 'protected' ? { licence: 'protected' } : {}),
                      },
            );
            expect(result.entries).toEqual([]);
            expect(result.withheld.danger).toBe(1);
        },
    );
    it('prints an open registered row in the same worst-first order, while withholding its protected neighbour', () => {
        const result = routeHazardsForFile(
            report([
                hazard({ cellId: 'US5DEEP1', minDepthM: 8 }),
                hazard({ cellId: 'AU5TEST1', sourceHO: 'AU' }),
                hazard({ cellId: 'US5DANG1', minDepthM: -0.5, distanceNm: 0.04 }),
            ]),
            (id) => ({ id }),
        );
        expect(result.entries.map((e) => e.cellId)).toEqual(['US5DANG1', 'US5DEEP1']);
        expect(result.withheld.danger).toBe(1);
    });
});
