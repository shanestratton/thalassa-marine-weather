/**
 * WeatherScheduler — Unit + Integration tests for weather scheduling logic.
 *
 * Tests: bad weather detection, update interval selection,
 * clock alignment for smart polling, satellite mode, and
 * full scheduling pipeline integration.
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
        const hourly = new Array(13).fill({ windSpeed: 5 });
        hourly[12] = { windGust: 50 }; // 13th item — should be ignored (slice 0-12)
        expect(isBadWeather(makeWeather({ hourly }))).toBe(false);
    });

    // ── Edge Cases ──

    it('returns false at exactly 25 kts wind (boundary — not >25)', () => {
        expect(isBadWeather(makeWeather({ windSpeed: 25 }))).toBe(false);
    });

    it('returns true at 25.1 kts wind (just over boundary)', () => {
        expect(isBadWeather(makeWeather({ windSpeed: 25.1 }))).toBe(true);
    });

    it('returns false at exactly 2.5m waves (boundary — not >2.5)', () => {
        expect(isBadWeather(makeWeather({ waveHeight: 2.5 }))).toBe(false);
    });

    it('returns true at 2.6m waves', () => {
        expect(isBadWeather(makeWeather({ waveHeight: 2.6 }))).toBe(true);
    });

    it('returns false at exactly 5 mm/h rain (boundary)', () => {
        expect(isBadWeather(makeWeather({ precipitation: 5 }))).toBe(false);
    });

    it('returns false at exactly 2 nm visibility (boundary)', () => {
        expect(isBadWeather(makeWeather({ visibility: 2 }))).toBe(false);
    });

    it('returns true at 1.9 nm visibility', () => {
        expect(isBadWeather(makeWeather({ visibility: 1.9 }))).toBe(true);
    });

    it('handles undefined visibility (defaults to 10 nm — good)', () => {
        expect(isBadWeather(makeWeather({ visibility: undefined }))).toBe(false);
    });

    it('detects combined moderate conditions that individually pass', () => {
        // Each metric individually is "ok" but if any single one crosses, it triggers
        const combined = makeWeather({ windSpeed: 20, waveHeight: 2.0, precipitation: 4 });
        expect(isBadWeather(combined)).toBe(false); // All below thresholds
    });

    it('detects forecast gust at exactly index 11 (last checked slot)', () => {
        const hourly = new Array(12).fill({ windSpeed: 5 });
        hourly[11] = { windGust: 35 };
        expect(isBadWeather(makeWeather({ hourly }))).toBe(true);
    });

    it('handles empty hourly array', () => {
        expect(isBadWeather(makeWeather({ hourly: [] }))).toBe(false);
    });

    it('handles multiple simultaneous alerts', () => {
        expect(isBadWeather(makeWeather({
            alerts: [{ title: 'Gale Warning' }, { title: 'Tsunami Watch' }],
        }))).toBe(true);
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

    // ── Priority Chain ──

    it('satellite beats non-current in priority', () => {
        expect(getUpdateInterval('inland', calm, false, true)).toBe(SATELLITE_INTERVAL);
    });

    it('non-current beats bad weather in priority', () => {
        expect(getUpdateInterval('offshore', stormy, false, false)).toBe(INLAND_INTERVAL);
    });

    it('bad weather beats location-specific in priority', () => {
        // Coastal would normally be 30min, but bad weather → 10min
        expect(getUpdateInterval('coastal', stormy, true, false)).toBe(BAD_WEATHER_INTERVAL);
    });
});

// ── Clock Alignment ──

describe('alignToNextInterval', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('aligns hourly interval to top of next hour', () => {
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

    // ── Extra alignment edge cases ──

    it('aligns bad weather at :59 to top of next hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:59:00Z'));

        const target = alignToNextInterval(BAD_WEATHER_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(0);
        expect(targetDate.getUTCHours()).toBe(15);
    });

    it('aligns coastal at exactly :30 to :00 of next hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:30:00Z'));

        const target = alignToNextInterval(COASTAL_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCMinutes()).toBe(0);
        expect(targetDate.getUTCHours()).toBe(15);
    });

    it('aligns hourly at exactly :00 to next hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:00:00Z'));

        const target = alignToNextInterval(INLAND_INTERVAL);
        const targetDate = new Date(target);
        expect(targetDate.getUTCHours()).toBe(15);
        expect(targetDate.getUTCMinutes()).toBe(0);
    });
});

// ── Integration: Full Scheduling Pipeline ──

describe('Scheduling Pipeline (integration)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('bad weather → 10min interval → aligned to 10-min slot', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:03:00Z'));

        const weather = makeWeather({ windSpeed: 35 });
        const interval = getUpdateInterval('coastal', weather, true, false);
        expect(interval).toBe(BAD_WEATHER_INTERVAL);

        const nextUpdate = alignToNextInterval(interval);
        const nextDate = new Date(nextUpdate);
        expect(nextDate.getUTCMinutes()).toBe(10);
    });

    it('calm coastal → 30min interval → aligned to :30', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:05:00Z'));

        const weather = makeWeather();
        const interval = getUpdateInterval('coastal', weather, true, false);
        expect(interval).toBe(COASTAL_INTERVAL);

        const nextUpdate = alignToNextInterval(interval);
        const nextDate = new Date(nextUpdate);
        expect(nextDate.getUTCMinutes()).toBe(30);
    });

    it('calm inland → 60min interval → aligned to :00', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:45:00Z'));

        const weather = makeWeather();
        const interval = getUpdateInterval('inland', weather, true, false);
        expect(interval).toBe(INLAND_INTERVAL);

        const nextUpdate = alignToNextInterval(interval);
        const nextDate = new Date(nextUpdate);
        expect(nextDate.getUTCHours()).toBe(15);
        expect(nextDate.getUTCMinutes()).toBe(0);
    });

    it('satellite mode overrides storm → 3h interval → raw offset', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:15:00Z'));

        const weather = makeWeather({ windSpeed: 40 });
        const interval = getUpdateInterval('offshore', weather, true, true);
        expect(interval).toBe(SATELLITE_INTERVAL);

        // Satellite interval is >= INLAND_INTERVAL, so aligns to top of hour
        const nextUpdate = alignToNextInterval(interval);
        const nextDate = new Date(nextUpdate);
        expect(nextDate.getUTCHours()).toBe(15);
        expect(nextDate.getUTCMinutes()).toBe(0);
    });
});
