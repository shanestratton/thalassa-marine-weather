/**
 * WeatherContext — Unit tests for weather orchestration logic
 *
 * NOTE: These tests have been migrated to weatherScheduler.test.ts
 * with expanded coverage. This file is kept for backward compatibility
 * but imports from the extracted WeatherScheduler service.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    isBadWeather,
    getUpdateInterval,
    alignToNextInterval,
    INLAND_INTERVAL,
    COASTAL_INTERVAL,
    BAD_WEATHER_INTERVAL,
    SATELLITE_INTERVAL,
} from '../services/WeatherScheduler';

// ── Helper — minimal MarineWeatherReport factory ──

function makeWeather(overrides: {
    windGust?: number;
    windSpeed?: number;
    waveHeight?: number;
    precipitation?: number;
    visibility?: number;
    alerts?: { title: string }[];
    hourly?: { windGust?: number; windSpeed?: number }[];
} = {}) {
    return {
        current: {
            windGust: overrides.windGust, // undefined unless explicitly set
            windSpeed: overrides.windSpeed ?? 5,
            waveHeight: overrides.waveHeight ?? 0.5,
            precipitation: overrides.precipitation ?? 0,
            visibility: overrides.visibility ?? 10,
        },
        alerts: overrides.alerts ?? [],
        hourly: overrides.hourly ?? [],
    } as any; // Cast — we only test the pure function's fields
}

// ── Bad Weather Detection ──

describe('isBadWeather', () => {
    it('returns false for calm conditions', () => {
        expect(isBadWeather(makeWeather())).toBe(false);
    });

    it('detects alerts', () => {
        expect(isBadWeather(makeWeather({
            alerts: [{ title: 'Gale Warning' }],
        }))).toBe(true);
    });

    it('detects high wind (>25 kts sustained)', () => {
        expect(isBadWeather(makeWeather({ windSpeed: 30 }))).toBe(true);
    });

    it('detects high gusts (>25 kts)', () => {
        expect(isBadWeather(makeWeather({ windGust: 30, windSpeed: 15 }))).toBe(true);
    });

    it('detects high waves (>2.5m)', () => {
        expect(isBadWeather(makeWeather({ waveHeight: 3.0 }))).toBe(true);
    });

    it('detects heavy rain (>5 mm/h)', () => {
        expect(isBadWeather(makeWeather({ precipitation: 8 }))).toBe(true);
    });

    it('detects poor visibility (<2 nm)', () => {
        expect(isBadWeather(makeWeather({ visibility: 1.5 }))).toBe(true);
    });

    it('detects forecast high wind in next 12h (>30 kts)', () => {
        expect(isBadWeather(makeWeather({
            hourly: [
                { windSpeed: 10 },
                { windSpeed: 15 },
                { windGust: 35 },
            ],
        }))).toBe(true);
    });

    it('ignores forecast beyond 12h', () => {
        // Only tests first 12 slots — add 13 items so the dangerous one is at index 12
        const hourly = new Array(13).fill({ windSpeed: 5 });
        hourly[12] = { windGust: 50 }; // This is the 13th, should be ignored (slice 0-12)
        expect(isBadWeather(makeWeather({ hourly }))).toBe(false);
    });
});

// ── Update Interval Selection ──

describe('getUpdateInterval', () => {
    const calm = makeWeather();
    const stormy = makeWeather({ windSpeed: 35 });

    it('returns 60min for inland in calm weather', () => {
        expect(getUpdateInterval('inland', calm, true, false)).toBe(INLAND_INTERVAL);
    });

    it('returns 30min for coastal in calm weather', () => {
        expect(getUpdateInterval('coastal', calm, true, false)).toBe(COASTAL_INTERVAL);
    });

    it('returns 60min for offshore in calm weather', () => {
        expect(getUpdateInterval('offshore', calm, true, false)).toBe(INLAND_INTERVAL);
    });

    it('returns 10min for ANY location type in bad weather', () => {
        expect(getUpdateInterval('inland', stormy, true, false)).toBe(BAD_WEATHER_INTERVAL);
        expect(getUpdateInterval('coastal', stormy, true, false)).toBe(BAD_WEATHER_INTERVAL);
        expect(getUpdateInterval('offshore', stormy, true, false)).toBe(BAD_WEATHER_INTERVAL);
    });

    it('returns 3h in satellite mode regardless of weather', () => {
        expect(getUpdateInterval('coastal', calm, true, true)).toBe(SATELLITE_INTERVAL);
        expect(getUpdateInterval('coastal', stormy, true, true)).toBe(SATELLITE_INTERVAL);
    });

    it('returns 60min for non-current location regardless of type', () => {
        expect(getUpdateInterval('coastal', calm, false, false)).toBe(INLAND_INTERVAL);
    });

    it('satellite mode overrides everything', () => {
        // Even non-current + bad weather → satellite interval
        expect(getUpdateInterval('coastal', stormy, false, true)).toBe(SATELLITE_INTERVAL);
    });
});

// ── Clock Alignment ──

describe('alignToNextInterval', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('aligns hourly interval to top of next hour', () => {
        // Set time to 14:35
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:35:00Z'));

        const target = alignToNextInterval(INLAND_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(0);
        expect(targetDate.getUTCHours()).toBe(15);
    });

    it('aligns coastal interval to :00 or :30', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:10:00Z'));

        const target = alignToNextInterval(COASTAL_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(30);
    });

    it('aligns coastal from 40 mins to top of next hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:40:00Z'));

        const target = alignToNextInterval(COASTAL_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(0);
        expect(targetDate.getUTCHours()).toBe(15);
    });

    it('aligns bad weather interval to 10-min slots', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:22:00Z'));

        const target = alignToNextInterval(BAD_WEATHER_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(30);
    });

    it('returns future timestamp', () => {
        vi.useFakeTimers();
        const now = new Date('2024-01-15T14:22:00Z');
        vi.setSystemTime(now);

        const target = alignToNextInterval(INLAND_INTERVAL);
        expect(target).toBeGreaterThan(now.getTime());
    });
});
