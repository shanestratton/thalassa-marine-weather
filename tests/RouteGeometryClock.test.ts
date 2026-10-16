import { describe, expect, it } from 'vitest';
import type { IsochroneNode, IsochroneResult } from '../services/isochrone/types';
import { stitchIsochrones } from '../services/routing/stitchIsochrones';
import { verifiedIsochroneRoute } from '../services/routing/verifiedIsochroneRoute';
import { sailingStatsForNodes } from '../services/isochrone/routeStats';
import { routeComfortForNodes } from '../services/isochrone/routeComfort';
const node = (lon: number, timeHours: number, mode: 'sail' | 'motor', waveHeightM: number | null): IsochroneNode => ({
    lat: 0,
    lon,
    timeHours,
    speed: 6,
    bearing: 90,
    tws: 12,
    twa: 90,
    propulsion: mode,
    waveHeightM,
    wavePeriodS: 8,
    waveFromDeg: 90,
    distance: timeHours * 6,
    parentIndex: null,
});
function leg(route: IsochroneNode[]): IsochroneResult {
    const sailingStats = sailingStatsForNodes(route);
    return {
        route,
        sailingStats,
        motorHours: sailingStats.motorHours,
        comfort: routeComfortForNodes(route),
        routeCoordinates: route.map((n) => [n.lon, n.lat]),
        shallowFlags: route.map(() => false),
        isochrones: [],
        totalDistanceNM: route.at(-1)!.distance,
        totalDurationHours: route.at(-1)!.timeHours,
        arrivalTime: '2026-10-17T15:00:00Z',
    };
}
describe('one modeled clock survives chart verification and multi-leg joins', () => {
    it('shifts second-leg timestamps/distances and retains partial wave coverage and relaxation', () => {
        const first = leg([node(0, 0, 'sail', 1), node(1, 10, 'motor', 1)]);
        const second = leg([node(1, 0, 'sail', null), node(1.5, 5, 'sail', null)]);
        first.comfort = { ...first.comfort!, relaxedFromM: 0.9, usedLimitM: 1.035 };
        const result = stitchIsochrones(first, second);
        expect(result.route.map((n) => n.timeHours)).toEqual([0, 10, 15]);
        expect(result.route.map((n) => n.distance)).toEqual([0, 60, 90]);
        expect(result.sailingStats).toMatchObject({ motorHours: 10, reachingHours: 5, totalHours: 15, tacks: null });
        expect(result.comfort).toMatchObject({
            coverage: 'partial',
            knownHours: 10,
            unknownHours: 5,
            relaxedFromM: 0.9,
        });
    });
    it('keeps modeled ETA and raw motor attribution when the verifier returns the same geometry', () => {
        const candidate = leg([node(0, 0, 'sail', 1), node(1, 10, 'motor', 1)]);
        const result = verifiedIsochroneRoute(
            candidate,
            candidate.route.map((n) => ({ ...n, timeHours: n.timeHours * 2 })),
            '2026-10-17T00:00:00Z',
            3,
        );
        expect(result.totalDurationHours).toBe(10);
        expect(result.route.at(-1)!.timeHours).toBe(10);
        expect(result.motorHours).toBe(10);
    });
    it('does not transfer propulsion or wave clearance to a changed chart geometry', () => {
        const candidate = leg([node(0, 0, 'sail', 1), node(1, 10, 'motor', 1)]);
        const result = verifiedIsochroneRoute(
            candidate,
            [...candidate.route, node(1.5, 15, 'motor', 1)],
            '2026-10-17T00:00:00Z',
            6,
        );
        expect(result.totalDurationHours).toBeCloseTo(15, 0);
        expect(result.motorHours).toBeNull();
        expect(result.sailingStats!.unknownHours).toBeGreaterThan(14);
        expect(result.comfort!.coverage).toBe('unavailable');
        expect(result.environmentNotes!.join(' ')).toContain('propulsion and prior wave clearance are unknown');
    });
});
