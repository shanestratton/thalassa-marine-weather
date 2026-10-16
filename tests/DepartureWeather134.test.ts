import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: mocks.fetch }));
import { loadDepartureWeather } from '../services/routing/departureWeather';
const start = Date.parse('2026-10-20T00:00:00Z');
beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (_op, points) =>
        points.map(() => ({
            hourly: {
                time: [start / 1000, start / 1000 + 3600],
                wind_speed_10m: [12, 14],
                wind_direction_10m: [350, 10],
                wind_gusts_10m: [15, 20],
                precipitation: [null, 2],
            },
        })),
    );
});
it('makes one named-model batch and keeps rain unknown, strict horizon and north-crossing direction', async () => {
    const field = await loadDepartureWeather({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1]).toHaveLength(25);
    expect(mocks.fetch.mock.calls[0][2]).toMatchObject({ models: 'gfs_seamless', timeformat: 'unixtime' });
    expect(field!.getWeather(0, 0, start)!.rainMmPerHour).toBeNull();
    expect(field!.getWeather(0, 0, start + 1_800_000)).toMatchObject({
        windSpeedKts: 13,
        windDirection: 0,
        rainMmPerHour: 2,
    });
    expect(field!.getWeather(0, 0, start - 1)).toBeNull();
    expect(field!.getWeather(0, 0, start + 3_600_001)).toBeNull();
});
it('never downloads in Satellite Mode or makes an accidental worldwide date-line grid', async () => {
    expect(await loadDepartureWeather({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, true)).toBeNull();
    expect(await loadDepartureWeather({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
});
