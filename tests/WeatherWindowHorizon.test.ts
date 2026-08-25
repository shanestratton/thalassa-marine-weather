/**
 * WeatherWindowService.analyse — the scoreable horizon is the longest VALID
 * PREFIX of the hourly series, never the aligned length.
 *
 * Shane 2026-08-25 ("still cannot get a weather window???"): Open-Meteo
 * answers a 16-day request with 16-day series for every model, but the
 * commercial marine model's real horizon is ~10 days — wave_height comes
 * back 384 rows with a null tail (measured: 226 non-null at the Newport
 * departure). The validity loop treated that tail as corruption and threw
 * at the marine horizon, so the card read 'unavailable' on a perfectly
 * healthy provider — deterministically; Retry could never succeed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import { WeatherWindowService } from '../services/WeatherWindowService';

const HOURS = 16 * 24;

function hourlyTimes(): string[] {
    const t0 = Date.parse('2026-08-25T00:00:00Z');
    return Array.from({ length: HOURS }, (_, i) => new Date(t0 + i * 3_600_000).toISOString());
}

/** Marine + forecast replies: full 16-day wind, waves valid only for the
 *  first `waveHours` then null — the measured provider shape. */
function mockReplies(waveHours: number): void {
    const wave = Array.from({ length: HOURS }, (_, i) => (i < waveHours ? 0.8 : null));
    fetchProxy.mockImplementation(async (operation: string) =>
        operation === 'marine'
            ? {
                  hourly: {
                      wave_height: wave,
                      wave_direction: wave.map((v) => (v === null ? null : 90)),
                      wave_period: wave.map((v) => (v === null ? null : 7)),
                      wind_wave_height: wave.map((v) => (v === null ? null : 0.4)),
                  },
              }
            : {
                  hourly: {
                      time: hourlyTimes(),
                      wind_speed_10m: Array(HOURS).fill(10),
                      wind_direction_10m: Array(HOURS).fill(120),
                      precipitation_probability: Array(HOURS).fill(5),
                  },
              },
    );
}

describe('WeatherWindowService — valid-prefix horizon', () => {
    beforeEach(() => {
        localStorage.clear();
        fetchProxy.mockReset();
    });
    afterEach(() => {
        localStorage.clear();
    });

    it('a null wave tail shortens the horizon instead of failing the analysis', async () => {
        mockReplies(240); // marine model runs 10 of the 16 days
        const result = await WeatherWindowService.analyse(-27.205, 153.0933, undefined, 30);
        expect(result.availability).toBe('available');
        if (result.availability === 'available') {
            expect(result.windows.length).toBeGreaterThan(0);
            // Every scored window fits inside the wave horizon.
            const horizonEnd = Date.parse(hourlyTimes()[240 - 1]);
            for (const w of result.windows) {
                expect(Date.parse(w.time)).toBeLessThanOrEqual(horizonEnd);
            }
            // And the null tail was genuinely trimmed: fewer windows than the
            // 16-day maximum of 64.
            expect(result.windows.length).toBeLessThanOrEqual(40);
        }
    });

    it('an all-null wave series (land cell) yields zero windows but stays available — the provider answered', async () => {
        // House contract (weatherWindowDirection.test.ts): 'unavailable' is
        // reserved for provider FAILURE; an answered request with nothing
        // scoreable is an empty window list.
        mockReplies(0);
        const result = await WeatherWindowService.analyse(-27.205, 153.0933, undefined, 30);
        expect(result.availability).toBe('available');
        if (result.availability === 'available') {
            expect(result.windows).toEqual([]);
            expect(result.bestWindowIndex).toBe(-1);
        }
    });

    it('a fully valid 16-day response still scores the full horizon', async () => {
        mockReplies(HOURS);
        const result = await WeatherWindowService.analyse(-27.205, 153.0933, undefined, 30);
        expect(result.availability).toBe('available');
        if (result.availability === 'available') {
            expect(result.windows.length).toBe(64);
        }
    });
});
