/**
 * routeReportWeather — the ETA schedule (cumulative great-circle ÷ speed) and
 * graceful degradation. Proxy mocked offline so no real network call: we still
 * get every waypoint's ETA, just with null weather.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: vi.fn().mockRejectedValue(new Error('offline')),
}));

import { fetchRouteWaypointWeather, windCompass } from '../services/routeReportWeather';

describe('routeReportWeather', () => {
    it('computes cumulative ETAs; no key → ETAs stand, weather null', async () => {
        // 0.1° of latitude = 6 NM. Three pins → two 6 NM legs; at 6 kt = 1 h each.
        const pins = [
            { lat: -27.0, lon: 153.0 },
            { lat: -27.1, lon: 153.0 },
            { lat: -27.2, lon: 153.0 },
        ];
        const rows = await fetchRouteWaypointWeather(pins, 0, 6);
        expect(rows.length).toBe(3);
        expect(rows[0].hoursFromDep).toBe(0);
        expect(rows[0].distanceNM).toBe(0);
        expect(rows[1].distanceNM).toBeCloseTo(6, 0);
        expect(rows[1].hoursFromDep).toBeCloseTo(1, 1);
        expect(rows[2].hoursFromDep).toBeCloseTo(2, 1);
        expect(rows[2].etaMs).toBeCloseTo(2 * 3_600_000, -4);
        expect(rows.every((r) => r.windKts === null && !r.beyondForecast)).toBe(true);
    });

    it('defaults a bad speed to 6 kt and handles an empty route', async () => {
        expect(await fetchRouteWaypointWeather([], 0, 6)).toEqual([]);
        const rows = await fetchRouteWaypointWeather(
            [
                { lat: -27, lon: 153 },
                { lat: -27.1, lon: 153 },
            ],
            0,
            0,
        );
        expect(rows[1].hoursFromDep).toBeCloseTo(1, 1); // 6 NM / 6 kt
    });

    it('windCompass maps degrees to the 16-point rose', () => {
        expect(windCompass(0)).toBe('N');
        expect(windCompass(90)).toBe('E');
        expect(windCompass(180)).toBe('S');
        expect(windCompass(225)).toBe('SW');
        expect(windCompass(360)).toBe('N');
        expect(windCompass(-90)).toBe('W');
    });
});
