import { describe, expect, it } from 'vitest';
import { summarizeOffshoreResult } from '../services/routing/offshoreJob';
import { inspectRouteEnvironment } from '../services/isochrone/routeComfort';
import type { OffshoreJob } from '../services/routing/offshoreProtocol';
import type { IsochroneResult } from '../services/isochrone/types';

const frame = (n: number) => new Float32Array(9).fill(n);
const route = [
    { lat: 0, lon: -30, timeHours: 0, tws: 10, twa: 90 },
    { lat: 0, lon: -29.98, timeHours: 6, tws: 10, twa: 90 },
] as IsochroneResult['route'];
const result = {
    route,
    routeCoordinates: route.map((p) => [p.lon, p.lat]),
    totalDurationHours: 6,
    totalDistanceNM: 1.2,
    arrivalTime: '2026-10-16T06:00:00Z',
    isochrones: [],
    shallowFlags: [],
} as IsochroneResult;
function job(gustCap: number | undefined = 30, departure = '2026-10-16T00:00:00Z'): OffshoreJob {
    return {
        departureTime: departure,
        config: { comfortParams: { maxGustKts: gustCap } },
        wind: {
            width: 3,
            height: 3,
            lats: [-1, 0, 1],
            lons: [-31, -30, -29],
            north: 1,
            south: -1,
            west: -31,
            east: -29,
            totalHours: 24,
            refTime: '2026-10-16T00:00:00Z',
            stepHours: Array.from({ length: 24 }, (_, i) => i),
            u: Array.from({ length: 24 }, () => frame(5)),
            v: Array.from({ length: 24 }, () => frame(0)),
            speed: Array.from({ length: 24 }, () => frame(5)),
            gust: Array.from({ length: 24 }, (_, i) => frame(i === 1 ? 30 : 9)),
        },
    } as OffshoreJob;
}
describe('final offshore environment sampling covers the route clock and first terminal', () => {
    it('rejects an intermediate hourly gust peak on a short slow segment', () => {
        expect(summarizeOffshoreResult(job(), result)).toBeNull();
    });
    it('samples actual forecast knots when departure falls halfway between forecast hours', () => {
        // Integer hours after this departure see at most37.9kt, below50kt.
        // The actual hour1 forecast knot is relative+0.5h and reaches58.3kt.
        expect(summarizeOffshoreResult(job(50, '2026-10-16T00:30:00Z'), result)).toBeNull();
        const uncapped = job(undefined, '2026-10-16T00:30:00Z');
        uncapped.config.comfortParams = {};
        expect(summarizeOffshoreResult(uncapped, result)?.maxGustKts).toBeCloseTo(58.3, 1);
    });
    it('rejects a wave limit breach at the first terminal before the sea subsides', () => {
        const inspected = inspectRouteEnvironment(
            route,
            { getWave: (_lat, _lon, h) => ({ heightM: h <= 1 ? 4 - 3.5 * h : 0.5, periodS: 8, directionFromDeg: 90 }) },
            null,
            3,
        );
        expect(inspected.rejected).toBe(true);
        expect(inspected.comfort.maxWaveM).toBe(4);
        expect(inspected.comfort.maxWaveAt).toEqual({ lat: 0, lon: -30 });
    });
    it('rejects the initial terminal when it starts inside a cyclone exclusion', () => {
        const inspected = inspectRouteEnvironment(route, null, { isExcluded: (_lat, _lon, h) => h === 0 }, undefined);
        expect(inspected.rejected).toBe(true);
    });
    it('retains an unknown first-terminal wave as incomplete coverage', () => {
        const inspected = inspectRouteEnvironment(
            route,
            { getWave: (_lat, _lon, h) => (h === 0 ? null : { heightM: 1, periodS: 8, directionFromDeg: 90 }) },
            null,
            3,
        );
        expect(inspected.rejected).toBe(false);
        expect(inspected.comfort.coverage).toBe('partial');
    });
});
