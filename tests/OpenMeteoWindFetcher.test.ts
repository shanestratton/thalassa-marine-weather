import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchOpenMeteoPoints: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: mocks.fetchOpenMeteoPoints,
}));

vi.mock('../services/weather/MultiModelWeatherService', () => ({
    AVAILABLE_MODELS: [{ id: 'ecmwf', name: 'ECMWF', openMeteoModel: 'ecmwf_ifs04' }],
    recommendModels: () => ['ecmwf'],
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => mocks.logger,
}));

import { fetchModelWindGrid } from '../services/weather/OpenMeteoWindFetcher';

function hourly(speed: number, direction: number) {
    return {
        hourly: {
            wind_speed_10m: [speed],
            wind_direction_10m: [direction],
            wind_gusts_10m: [speed + 5],
        },
    };
}

describe('fetchModelWindGrid', () => {
    it('keeps a z3 date-line viewport continuous while sending only valid provider longitudes', async () => {
        // At z3 a wide Australia/Pacific viewport can cross 180°. Mapbox gives
        // it a continuous extent (179…181), but Open-Meteo rejects 181 unless
        // the request coordinate is wrapped. The grid must retain 181 so its
        // image source can be split cleanly at the date line by the renderer.
        mocks.fetchOpenMeteoPoints.mockResolvedValueOnce(
            Array.from({ length: 9 }, (_, index) => hourly(18 + index, 90)),
        );

        const grid = await fetchModelWindGrid('ecmwf', { south: -1, north: 1, west: 179, east: 181 }, 1, 1);

        expect(grid).not.toBeNull();
        expect(mocks.fetchOpenMeteoPoints).toHaveBeenCalledWith(
            'forecast',
            [
                { lat: -1, lon: 179 },
                { lat: -1, lon: 180 },
                { lat: -1, lon: -179 },
                { lat: 0, lon: 179 },
                { lat: 0, lon: 180 },
                { lat: 0, lon: -179 },
                { lat: 1, lon: 179 },
                { lat: 1, lon: 180 },
                { lat: 1, lon: -179 },
            ],
            expect.objectContaining({ models: 'ecmwf_ifs04' }),
            4,
        );
        expect(grid).toMatchObject({
            width: 3,
            height: 3,
            lons: [179, 180, 181],
            west: 179,
            east: 181,
        });
    });

    it('also accepts a normalized date-line bbox without reversing its grid axis', async () => {
        mocks.fetchOpenMeteoPoints.mockResolvedValueOnce(
            Array.from({ length: 9 }, (_, index) => hourly(12 + index, 180)),
        );

        const grid = await fetchModelWindGrid('ecmwf', { south: -1, north: 1, west: 179, east: -179 }, 1, 1);

        expect(grid).toMatchObject({ lons: [179, 180, 181], west: 179, east: 181 });
    });

    it('publishes the grid’s own clock: frame 0 is the provider’s first valid hour, in UTC', async () => {
        // The chart keeps a grid for up to three hours and re-uses it across
        // viewports. Without a reference time "frame 0" was taken for NOW, and the
        // passage look-ahead's "+6 h" showed the wind for six hours after the
        // FETCH under a clock that said otherwise (review, 2026-09-18).
        mocks.fetchOpenMeteoPoints.mockResolvedValueOnce(
            Array.from({ length: 9 }, () => ({
                hourly: {
                    time: ['2026-09-18T09:00', '2026-09-18T10:00'],
                    wind_speed_10m: [12, 14],
                    wind_direction_10m: [90, 95],
                    wind_gusts_10m: [18, 20],
                },
            })),
        );
        const grid = await fetchModelWindGrid('ecmwf', { south: -1, north: 1, west: 150, east: 152 }, 2, 1);
        // The 'Z' is the point: a zone-less ISO date-time parses as LOCAL time,
        // which in Queensland would put the whole field ten hours out.
        expect(grid?.refTime).toBe('2026-09-18T09:00:00.000Z');
    });

    it('reads a unixtime axis too, and publishes no clock at all rather than a wrong one', async () => {
        mocks.fetchOpenMeteoPoints.mockResolvedValueOnce(
            Array.from({ length: 9 }, () => ({
                hourly: { time: [1789722000], wind_speed_10m: [12], wind_direction_10m: [90], wind_gusts_10m: [18] },
            })),
        );
        const unix = await fetchModelWindGrid('ecmwf', { south: -1, north: 1, west: 150, east: 152 }, 1, 1);
        expect(unix?.refTime).toBe(new Date(1789722000 * 1000).toISOString());

        mocks.fetchOpenMeteoPoints.mockResolvedValueOnce(Array.from({ length: 9 }, () => hourly(12, 90)));
        const bare = await fetchModelWindGrid('ecmwf', { south: -1, north: 1, west: 150, east: 152 }, 1, 1);
        expect(bare).not.toBeNull();
        expect(bare && 'refTime' in bare).toBe(false);
    });
});
