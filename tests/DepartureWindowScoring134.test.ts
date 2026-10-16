import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsochroneResult } from '../services/isochrone/types';
import type { VesselProfile } from '../types';
import { planDepartureWindow } from '../services/departureWindow';
const mocks = vi.hoisted(() => ({ compute: vi.fn() }));
vi.mock('../services/IsochroneRouter', () => ({ computeIsochrones: mocks.compute }));
const start = Date.parse('2026-10-20T00:00:00Z');
const origin = { lat: 0, lon: 0 },
    destination = { lat: 0, lon: 0.1 };
const vessel = {
    type: 'sail',
    length: 38,
    cruisingSpeed: 6,
    draft: 5,
    maxWaveHeight: 30,
    minWindSpeed: 3,
    motoringSpeed: 7,
} as VesselProfile;
function candidate(departure: string): IsochroneResult {
    return {
        route: [origin, destination].map((p, i) => ({
            ...p,
            timeHours: i,
            distance: i * 6,
            speed: 6,
            bearing: 90,
            tws: 12,
            twa: 90,
            parentIndex: null,
        })),
        routeCoordinates: [
            [0, 0],
            [0.1, 0],
        ],
        shallowFlags: [false, false],
        isochrones: [],
        totalDistanceNM: 6,
        totalDurationHours: 1,
        arrivalTime: new Date(Date.parse(departure) + 3_600_000).toISOString(),
    };
}
const weather = {
    model: 'GFS',
    getWeather: (_lat: number, _lon: number, at: number) => ({
        windSpeedKts: 12,
        windDirection: 0,
        gustKts: 15,
        rainMmPerHour: at < start + 6 * 3_600_000 ? 4 : 0,
    }),
};
const run = (options: Parameters<typeof planDepartureWindow>[11] = {}) =>
    planDepartureWindow(
        origin,
        destination,
        vessel,
        { getWind: () => ({ speed: 12, direction: 0 }) },
        { windSpeeds: [5], angles: [90], matrix: [[6]] },
        null,
        { getCurrent: (_lat, _lon, hours) => ({ speed: 2, direction: hours < 6 ? 270 : 90 }) },
        null,
        { getWave: (_lat, _lon, hours) => ({ heightM: hours < 6 ? 3 : 1, periodS: 8, directionFromDeg: 90 }) },
        undefined,
        new Date(start).toISOString(),
        { maxScenarios: 2, weatherField: weather, ...options },
    );
beforeEach(() => {
    vi.restoreAllMocks();
    mocks.compute.mockReset();
    mocks.compute.mockImplementation(async (_o, _d, dep) => candidate(dep));
});
describe('departure comparison uses the same absolute weather clock and shared covered score', () => {
    it('ranks waves, rain, upwind, current and beta comfort and forwards the vessel motor policy', async () => {
        const scenarios = await run();
        expect(scenarios[0].departureTime).toBe('2026-10-20T06:00:00.000Z');
        expect(scenarios[0]).toMatchObject({
            maxWaveM: 1,
            maxRainMmPerHour: 0,
            upwindPct: 0,
            avgCurrentKts: 2,
            tideStatus: 'unknown',
            verdict: 'maybe',
        });
        expect(scenarios[0].rankedTerms).toEqual(
            expect.arrayContaining(['rain', 'waves', 'upwind', 'ocean current', 'beta comfort']),
        );
        expect(mocks.compute.mock.calls[0][5]).toMatchObject({ minWindSpeed: 3, motoringSpeed: 7 });
        expect(mocks.compute.mock.calls[1][9].getWave(0, 0, 0).heightM).toBe(1);
    });
    it('never rewards a departure because its rain coverage disappears', async () => {
        const scenarios = await run({
            weatherField: {
                ...weather,
                getWeather: (lat, lon, at) => ({
                    ...weather.getWeather(lat, lon, at),
                    rainMmPerHour: at < start + 6 * 3_600_000 ? 3 : null,
                }),
            },
        });
        expect(scenarios.every((s) => !s.rankedTerms!.includes('rain'))).toBe(true);
        expect(scenarios.find((s) => s.maxRainMmPerHour === null)!.coverage).toContain('rain');
    });
    it('reuses a caller-owned tide verdict and prevents a blocked time being selected as best', async () => {
        const tideForRoute = vi.fn(async (_route, at) =>
            at >= start + 6 * 3_600_000 ? ('blocked' as const) : ('clear' as const),
        );
        const scenarios = await run({ tideForRoute });
        expect(tideForRoute).toHaveBeenCalledTimes(2);
        expect(scenarios[0].departureTime).toBe('2026-10-20T00:00:00.000Z');
        expect(scenarios[1]).toMatchObject({ verdict: 'no-go', score: Infinity, tideStatus: 'blocked' });
    });
    it('caps the number of exploratory runs and honors the whole-operation deadline before publishing', async () => {
        const scenarios = await run({ maxScenarios: 1000, intervalHours: 3 });
        expect(scenarios).toHaveLength(24);
        expect(mocks.compute.mock.calls[1][2]).toBe('2026-10-20T03:00:00.000Z');
        mocks.compute.mockClear();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        mocks.compute.mockImplementation(async (_o, _d, dep) => {
            clock = 100;
            return candidate(dep);
        });
        const onProgress = vi.fn();
        expect(await run({ maxComputeMs: 50, onProgress })).toEqual([]);
        expect(mocks.compute).toHaveBeenCalledOnce();
        expect(onProgress).not.toHaveBeenCalled();
    });
});
