import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeatherWindowService, meanWindDirection } from '../services/WeatherWindowService';

const CACHE_PREFIX = 'thalassa_weather_windows';

afterEach(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
});

describe('WeatherWindowService direction and cache handling', () => {
    it('averages wind directions circularly at north instead of inverting them to south', () => {
        expect(meanWindDirection([350, 10])).toBeCloseTo(0, 5);
        expect(meanWindDirection([355, 5, 15])).toBeCloseTo(5, 5);
    });

    it('uses a stable forecast bearing when opposing directions have no true mean', () => {
        expect(meanWindDirection([0, 180])).toBe(0);
    });

    it('clears every coordinate-specific weather-window cache entry', () => {
        localStorage.setItem(`${CACHE_PREFIX}:-20.3,148.7`, JSON.stringify({ analysisTime: new Date().toISOString() }));
        localStorage.setItem(`${CACHE_PREFIX}:51.5,-0.1`, JSON.stringify({ analysisTime: new Date().toISOString() }));
        localStorage.setItem('unrelated-cache', 'keep');

        WeatherWindowService.clearCache();

        expect(localStorage.getItem(`${CACHE_PREFIX}:-20.3,148.7`)).toBeNull();
        expect(localStorage.getItem(`${CACHE_PREFIX}:51.5,-0.1`)).toBeNull();
        expect(localStorage.getItem('unrelated-cache')).toBe('keep');
        localStorage.removeItem('unrelated-cache');
    });

    it('reports no best window when a forecast has no complete departure block', async () => {
        const response = {
            ok: true,
            json: vi.fn().mockResolvedValue({
                hourly: {
                    time: [],
                    wind_speed_10m: [],
                    wind_direction_10m: [],
                    precipitation_probability: [],
                    wave_height: [],
                },
            }),
        };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as unknown as Response);
        const signal = new AbortController().signal;
        const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);

        const result = await WeatherWindowService.analyse(-20.3, 148.7);

        expect(result.windows).toEqual([]);
        expect(result.bestWindowIndex).toBe(-1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(timeoutMock).toHaveBeenCalledWith(20_000);
        expect(fetchMock).toHaveBeenNthCalledWith(1, expect.any(String), { signal });
        expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(String), { signal });
        fetchMock.mockRestore();
        timeoutMock.mockRestore();
    });

    it('refuses invalid coordinates without caching or making a network request', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        const result = await WeatherWindowService.analyse(91, 148.7);

        expect(result.windows).toEqual([]);
        expect(result.bestWindowIndex).toBe(-1);
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockRestore();
    });

    it('does not score incomplete hourly series as a valid departure window', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                hourly: {
                    time: Array.from({ length: 6 }, (_, i) => `2026-07-23T0${i}:00`),
                    wind_speed_10m: [12, 12, 12, 12, 12, 12],
                    wind_direction_10m: [90, 90, 90, 90, 90, 90],
                    precipitation_probability: [0, 0, 0, 0, 0, 0],
                    wave_height: [],
                },
            }),
        } as unknown as Response);

        const result = await WeatherWindowService.analyse(-20.3, 148.7);

        expect(result.windows).toEqual([]);
        expect(result.bestWindowIndex).toBe(-1);
        fetchMock.mockRestore();
    });
});
