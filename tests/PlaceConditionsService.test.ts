import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConditionsPlace } from '../services/anchorages/placeConditions';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: api.fetch }));
const now = Date.UTC(2026, 8, 23, 3, 25);
const place: ConditionsPlace = { id: 'test', lat: -20, lon: 149, kind: 'anchorage', fetchLandNM: Array(36).fill(0.3) };
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    api.fetch.mockReset();
    api.fetch.mockImplementation(async (operation: string, points: { lat: number; lon: number }[]) =>
        points.map((p) => ({
            latitude: p.lat,
            longitude: p.lon,
            hourly_units:
                operation === 'forecast'
                    ? { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', wind_direction_10m: '°', weather_code: 'wmo code' }
                    : { wave_height: 'm', wave_direction: '°', wave_period: 's' },
            hourly: {
                time: Array.from({ length: 72 }, (_, i) => Date.UTC(2026, 8, 23, 3 + i) / 1000),
                ...(operation === 'forecast'
                    ? {
                          wind_speed_10m: Array(72).fill(12),
                          wind_gusts_10m: Array(72).fill(17),
                          wind_direction_10m: Array(72).fill(135),
                          weather_code: Array(72).fill(0),
                      }
                    : {
                          wave_height: Array(72).fill(0.2),
                          wave_direction: Array(72).fill(135),
                          wave_period: Array(72).fill(5),
                      }),
            },
        })),
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe('Bounded live conditions', () => {
    it('shares one batched weather/marine pair across concurrent overlays and taps', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await Promise.all([svc.loadPlaceConditions([place]), svc.loadPlaceConditions([place])]);
        expect(api.fetch).toHaveBeenCalledTimes(2);
        expect(svc.cachedPlaceConditions(place).light).toBe('green');
        await svc.loadPlaceConditions([place]);
        expect(api.fetch).toHaveBeenCalledTimes(2);
    });
    it('refresh failure and offline status clear a previous favourable assessment', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await svc.loadPlaceConditions([place]);
        vi.stubGlobal('navigator', { onLine: false });
        expect(svc.cachedPlaceConditions(place).light).toBe('unknown');
        vi.unstubAllGlobals();
        vi.setSystemTime(now + 6 * 60_000);
        api.fetch.mockRejectedValue(new Error('offline'));
        await svc.loadPlaceConditions([place]);
        expect(svc.cachedPlaceConditions(place).light).toBe('unknown');
    });
    it('requests at most 24 cells and never greens unrequested distant points', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        const places = Array.from({ length: 100 }, (_, i) => ({ ...place, id: String(i), lat: -20 + i / 10 }));
        await svc.loadPlaceConditions(places);
        expect(api.fetch.mock.calls[0][1]).toHaveLength(24);
        expect(svc.cachedPlaceConditions(places[99]).light).toBe('unknown');
    });
});
