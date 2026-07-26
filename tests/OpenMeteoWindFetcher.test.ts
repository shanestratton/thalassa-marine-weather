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
});
