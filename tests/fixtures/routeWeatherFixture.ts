import {
    buildRouteClock,
    emptyRouteWeather,
    routeWeatherRows,
    type RouteWeatherReport,
} from '../../services/routeMeteogram';
import { getAuthIdentityScope } from '../../services/authIdentityScope';
import type { VesselProfile } from '../../types/vessel';
import type { ResolvedRoutingPolar } from '../../services/routingPolar';
export const routeWeatherFixtureStart = Date.UTC(2026, 9, 16, 23, 30);
export const routeWeatherFixturePins = [
    { lat: 0, lon: 0 },
    { lat: 1, lon: 1 },
    { lat: 0, lon: 4 },
];
export const routeWeatherFixtureVessel: VesselProfile = {
    name: 'Fictional vessel',
    type: 'sail',
    length: 40,
    beam: 12,
    draft: 6,
    displacement: 10000,
    maxWaveHeight: 2,
    cruisingSpeed: 6,
};
export const routeWeatherFixturePolar: ResolvedRoutingPolar = {
    source: 'manual',
    label: 'Synthetic chosen polar',
    signature: 'synthetic-only',
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
export function routeWeatherFixture(identity = 'fixture'): RouteWeatherReport {
    const clock = buildRouteClock(routeWeatherFixturePins, routeWeatherFixtureStart, 6);
    return {
        ownerScope: getAuthIdentityScope(),
        identity,
        totalDistanceNM: clock.totalDistanceNM,
        departureMs: clock.departureMs,
        arrivalMs: clock.arrivalMs,
        speedKts: clock.speedKts,
        limited: clock.limited,
        rows: routeWeatherRows(
            clock,
            clock.positions.map((_, i) =>
                i === 3
                    ? emptyRouteWeather()
                    : {
                          windKts: i === 0 ? 0 : 12,
                          windDeg: i === 0 ? null : 90,
                          gustKts: i === 0 ? 0 : 20,
                          pressureHpa: 1000,
                      },
            ),
            { vessel: routeWeatherFixtureVessel, polar: routeWeatherFixturePolar },
        ),
        source: 'Synthetic wind fixture',
        sourceRun: new Date(routeWeatherFixtureStart).toISOString(),
        credit: 'Synthetic forecast only; no provider queried. UK Met Office (CC BY-SA 4.0) attribution fixture.',
        polarLabel: routeWeatherFixturePolar.label,
        loadedAtMs: routeWeatherFixtureStart,
        note: 'Coverage gaps remain unknown.',
    };
}
