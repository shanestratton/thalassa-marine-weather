import { describe, expect, it } from 'vitest';
import {
    buildRouteClock,
    emptyRouteWeather,
    HOUR,
    ROUTE_WEATHER_HOURS,
    routeWeatherQueryPoint,
    routeWeatherRows,
} from '../services/routeMeteogram';
import type { ResolvedRoutingPolar } from '../services/routingPolar';
import type { VesselProfile } from '../types/vessel';

const departure = Date.UTC(2026, 9, 16, 23, 30),
    nmPerDegree = (Math.PI / 180) * 3440.065;
const vessel = { type: 'sail', closeHauledTwa: 40 } as VesselProfile;
const polar: ResolvedRoutingPolar = {
    source: 'manual',
    label: 'Synthetic chosen polar',
    signature: 'synthetic',
    reason: 'fixture',
    polar: {
        angles: [0, 35, 40, 90, 180],
        windSpeeds: [10, 20],
        matrix: [
            [0, 0],
            [0, 0],
            [3, 5],
            [6, 8],
            [5, 7],
        ],
    },
};

describe('planned hourly positions, not waypoint-only forecasts', () => {
    it('walks every bend and changes its course at a vertex', () => {
        const clock = buildRouteClock(
            [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 0.1 },
                { lat: 0.1, lon: 0.1 },
                { lat: 0.1, lon: 0.2 },
            ],
            departure,
            nmPerDegree / 10,
        );
        expect(clock.totalDistanceNM).toBeCloseTo(nmPerDegree * 0.3, 4);
        expect(clock.positions[1].lat).toBeCloseTo(0, 8);
        expect(clock.positions[1].lon).toBeCloseTo(0.1, 8);
        expect(clock.positions[1].courseDeg).toBeCloseTo(0, 5);
        expect(clock.positions[2].lat).toBeCloseTo(0.1, 8);
        expect(clock.positions[2].courseDeg).toBeCloseTo(90, 3);
        expect(clock.positions[2].atMs).toBe(departure + 2 * HOUR);
        expect(clock.arrivalMs).toBeGreaterThan(departure + 2.99 * HOUR);
    });
    it('crosses the short side of the dateline, with no Greenwich excursion', () => {
        const clock = buildRouteClock(
            [
                { lat: 0, lon: 179.8 },
                { lat: 0, lon: -179.8 },
            ],
            departure,
            6,
        );
        expect(clock.totalDistanceNM).toBeCloseTo(24, 0);
        expect(clock.positions.every((p) => Math.abs(p.lon) > 179)).toBe(true);
        expect(clock.positions[1].courseDeg).toBeCloseTo(90, 5);
        expect(clock.positions.at(-1)).toMatchObject({ lat: 0, lon: -179.8 });
    });
    it('keeps a fractional final hour and exact endpoint, independent of local timezone', () => {
        const endpoint = { lat: -7.1234, lon: 178.9987 };
        const clock = buildRouteClock([{ lat: -7.1, lon: 178.8 }, endpoint], departure, 5.5);
        expect(clock.positions.at(-1)).toMatchObject(endpoint);
        expect(clock.positions.at(-1)!.atMs).toBe(clock.arrivalMs);
        expect(clock.arrivalMs).toBe(departure + (clock.totalDistanceNM / 5.5) * HOUR);
        expect(clock.positions[1].atMs).toBe(Date.UTC(2026, 9, 17, 0, 30));
    });
    it('does not add distance for repeated positions', () => {
        const a = { lat: -27.123456, lon: 153.123456 },
            b = { lat: -27.2, lon: 153.2 };
        expect(buildRouteClock([a, a, a, b], departure, 6)).toEqual(buildRouteClock([a, b], departure, 6));
    });
    it('bounds the hourly preview but keeps whole-route distance and honest arrival gap', () => {
        const clock = buildRouteClock(
            [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 100 },
            ],
            departure,
            6,
        );
        expect(clock.limited).toBe(true);
        expect(clock.positions.length).toBe(ROUTE_WEATHER_HOURS + 2);
        expect(clock.positions.at(-1)!.lon).toBe(100);
        expect(clock.positions.at(-1)!.gapBeforeHours).toBeGreaterThan(500);
        expect(clock.totalDistanceNM).toBeCloseTo(nmPerDegree * 100, 5);
    });
    it.each([0, -1, NaN, Infinity, 101])('requires a stated valid speed (%s)', (speed) => {
        expect(() =>
            buildRouteClock(
                [
                    { lat: 0, lon: 0 },
                    { lat: 0, lon: 1 },
                ],
                departure,
                speed,
            ),
        ).toThrow(/planned speed/);
    });
    it('rejects antipodal ambiguity and invalid geometry/clock', () => {
        expect(() =>
            buildRouteClock(
                [
                    { lat: 0, lon: 0 },
                    { lat: 0, lon: 180 },
                ],
                departure,
                6,
            ),
        ).toThrow(/intermediate/);
        expect(() =>
            buildRouteClock(
                [
                    { lat: NaN, lon: 0 },
                    { lat: 0, lon: 1 },
                ],
                departure,
                6,
            ),
        ).toThrow();
        expect(() =>
            buildRouteClock(
                [
                    { lat: 0, lon: 0 },
                    { lat: 0, lon: 1 },
                ],
                9e15,
                6,
            ),
        ).toThrow();
    });
    it('normalizes both sides of the same public dateline query bucket', () => {
        expect(routeWeatherQueryPoint({ lat: 1.1234, lon: 179.99 })).toEqual({ lat: 1, lon: -180 });
        expect(routeWeatherQueryPoint({ lat: 1.1234, lon: -179.99 })).toEqual({ lat: 1, lon: -180 });
    });
});

describe('chosen routing polar is separate from the plan clock', () => {
    const clock = buildRouteClock(
        [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.2 },
        ],
        departure,
        6,
    );
    it('uses course-relative true wind, point of sail and the selected polar', () => {
        const samples = clock.positions.map(() => ({ windKts: 15, windDeg: 0, gustKts: 20, pressureHpa: null }));
        const rows = routeWeatherRows(clock, samples, { vessel, polar });
        expect(rows[0].twaDeg).toBeCloseTo(90);
        expect(rows[0].pointOfSail?.toLowerCase()).toContain('beam');
        expect(rows[0].polarSpeedKts).toBe(7);
        expect(rows.at(-1)!.atMs).toBe(clock.arrivalMs);
        expect(rows.at(-1)!.distanceNM).toBe(clock.totalDistanceNM);
    });
    it('does not extrapolate a sailing speed below or above the chosen polar’s wind range', () => {
        for (const windKts of [0.1, 5, 25, 100]) {
            const rows = routeWeatherRows(clock, [{ ...emptyRouteWeather(), windKts, windDeg: 0 }], { vessel, polar });
            expect(rows[0].twaDeg).toBeCloseTo(90);
            expect(rows[0].polarSpeedKts).toBeNull();
        }
        const row = routeWeatherRows(clock, [{ ...emptyRouteWeather(), windKts: 1e-15, windDeg: 90 }], {
            vessel,
            polar,
        })[0];
        expect(row.windKts).toBe(0);
        expect(row.twaDeg).toBeNull();
        expect(row.polarSpeedKts).toBeNull();
    });
    it('retains no-go zero, while calm/unknown wind and motor boats get no invented sailing speed', () => {
        const headwind = clock.positions.map(() => ({ ...emptyRouteWeather(), windKts: 15, windDeg: 90 }));
        expect(routeWeatherRows(clock, headwind, { vessel, polar })[0].polarSpeedKts).toBe(0);
        expect(
            routeWeatherRows(clock, headwind, { vessel: { ...vessel, type: 'power' }, polar })[0].polarSpeedKts,
        ).toBeNull();
        for (const sample of [
            emptyRouteWeather(),
            { ...emptyRouteWeather(), windKts: 0 },
            { ...emptyRouteWeather(), windKts: 12 },
        ]) {
            const row = routeWeatherRows(clock, [sample], { vessel, polar })[0];
            expect(row.twaDeg).toBeNull();
            expect(row.polarSpeedKts).toBeNull();
        }
    });
});
