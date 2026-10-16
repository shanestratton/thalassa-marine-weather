import { describe, expect, it } from 'vitest';
import { expandMinifiedWeather, minifyWeather, type CompactSource } from '../utils/compactWeather';
const NOW = Date.parse('2026-10-16T02:17:19Z');
function source(): CompactSource {
    return {
        provider: 'weatherkit',
        timestamp: '2026-10-16T02:14:11Z',
        coordinates: { lat: -27.12, lon: 153.12 },
        timezone: 'Australia/Brisbane',
        isPremium: false,
        current: {
            temperature: null,
            feelsLike: 25.24,
            humidity: null,
            pressure: 1009.62,
            windSpeed: 0,
            windDirection: 0,
            windGust: null,
            condition: 'HeavyRainShowers',
            cloudCover: null,
            visibility: null,
            uvIndex: null,
            precipitation: 0,
            dewPoint: null,
            isDay: true,
        },
        hourly: Array.from({ length: 72 }, (_, i) => ({
            time: new Date(Date.parse('2026-10-16T00:00:00Z') + i * 3600_000).toISOString(),
            temperature: null,
            windSpeed: i === 2 ? null : i,
            windDirection: 0,
            windGust: null,
            precipitation: null,
            precipProbability: null,
            condition: 'Unknown',
            pressure: null,
            cloudCover: null,
            humidity: null,
        })),
        daily: Array.from({ length: 7 }, (_, i) => ({
            date: `2026-10-${16 + i}`,
            tempMax: null,
            tempMin: 0,
            windSpeedMax: null,
            windGustMax: null,
            condition: 'Unknown',
            precipSum: null,
            precipProbability: null,
            sunrise: '',
            sunset: '',
            uvIndexMax: null,
        })),
    };
}
describe('compact satellite forecast v2', () => {
    it('preserves the actual source times, nulls and genuine zeroes, with bounded horizons', () => {
        const full = source();
        const packed = minifyWeather(full, NOW);
        const decoded = expandMinifiedWeather(packed, -27.12, 153.12, NOW)!;
        expect(decoded.timestamp).toBe(full.timestamp.replace('Z', '.000Z'));
        expect(decoded.current.temperature).toBeNull();
        expect(decoded.current.windSpeed).toBe(0);
        expect(decoded.current.windDirection).toBe(0);
        expect(decoded.current.windGust).toBeNull();
        expect(decoded.current.condition).toBe('HeavyRainShowers');
        expect(decoded.hourly).toHaveLength(24);
        expect(decoded.hourly[0].time).toBe('2026-10-16T02:00:00.000Z');
        expect(decoded.hourly[0].windSpeed).toBeNull();
        expect(decoded.hourly[0].uvIndex).toBeNull();
        expect(decoded.daily).toHaveLength(5);
        expect(decoded.daily[0].tempMax).toBeNull();
        expect(decoded.daily[0].tempMin).toBe(0);
        expect(new TextEncoder().encode(JSON.stringify(packed)).length).toBeLessThan(7000);
    });
    it('does not slide validity times forward when a cached response is read later', () => {
        const packed = minifyWeather(source(), NOW);
        const later = expandMinifiedWeather(packed, -27.12, 153.12, NOW + 40 * 60_000)!;
        expect(later.hourly[0].time).toBe('2026-10-16T02:00:00.000Z');
    });
    it('refuses ambiguous wall-clock times rather than treating them as UTC', () => {
        const full = source();
        full.hourly[2].time = '2026-10-16T02:00';
        // The filter would otherwise interpret a local clock as the server's zone.
        full.hourly = [full.hourly[2]];
        expect(() => minifyWeather(full, NOW - 3600_000)).toThrow('Invalid source time');
    });
    it.each([
        (p: Record<string, unknown>) => {
            delete p.v;
        },
        (p: Record<string, unknown>) => {
            p.v = 1;
        },
        (p: Record<string, unknown>) => {
            p.lat = -28;
        },
        (p: Record<string, unknown>) => {
            p.ts = Math.floor((NOW - 2 * 3600_000) / 1000);
        },
        (p: Record<string, unknown>) => {
            p.ts = Math.floor((NOW + 10 * 60_000) / 1000);
        },
        (p: Record<string, unknown>) => {
            (p.c as Record<string, unknown>).w = '0';
        },
        (p: Record<string, unknown>) => {
            (p.h as Record<string, unknown>[])[1].at = 0;
        },
        (p: Record<string, unknown>) => {
            p.h = Array(25).fill((p.h as unknown[])[0]);
        },
        (p: Record<string, unknown>) => {
            p.h = [];
        },
        (p: Record<string, unknown>) => {
            p.d = [];
        },
        (p: Record<string, unknown>) => {
            (p.h as Record<string, unknown>[])[0].at = Math.floor(NOW / 1000);
        },
        (p: Record<string, unknown>) => {
            (p.d as Record<string, unknown>[])[0].date = '2026-02-31';
        },
        (p: Record<string, unknown>) => {
            (p.d as Record<string, unknown>[])[1].date = '2026-10-19';
        },
        (p: Record<string, unknown>) => {
            (p.d as Record<string, unknown>[])[0].rise = '2026-10-16T05:00';
        },
    ])('refuses incompatible, stale, wrong-area or malformed responses', (change) => {
        const packed = minifyWeather(source(), NOW);
        change(packed);
        expect(expandMinifiedWeather(packed, -27.12, 153.12, NOW)).toBeNull();
    });
});
