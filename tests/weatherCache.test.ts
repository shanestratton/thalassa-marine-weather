/**
 * Tests for the point-bound legacy weather cache used by planner workflows.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearCache,
    differenceInMinutes,
    findWeatherHistoryReport,
    getFromCache,
    getFromCacheOffline,
    MAX_WEATHER_HISTORY_ENTRIES,
    normalizeWeatherHistoryCache,
    purgeRetiredWeatherCacheEntries,
    saveToCache,
    recordWeatherHistoryReport,
    weatherCacheKeyForCoordinates,
    weatherHistoryKeyForCoordinates,
    type WeatherCacheCoordinates,
} from '../services/weather/cache';
import { MarineWeatherReport } from '../types';

const BRISBANE: WeatherCacheCoordinates = { lat: -27.4698, lon: 153.0251 };
const GOLD_COAST: WeatherCacheCoordinates = { lat: -28.0167, lon: 153.4 };
const HOBART: WeatherCacheCoordinates = { lat: -42.8821, lon: 147.3272 };

const makeReport = (
    model: string,
    coordinates: WeatherCacheCoordinates = BRISBANE,
    locationName = 'Brisbane',
): MarineWeatherReport => ({
    locationName,
    coordinates,
    current: {
        windSpeed: 15,
        windDirection: 'SE',
        windDegree: 135,
        waveHeight: 1.2,
        swellPeriod: 8,
        airTemperature: 22,
        condition: 'Partly Cloudy',
        description: 'Partly Cloudy',
        uvIndex: 5,
        humidity: 65,
        precipitation: 0,
        pressure: 1013,
        visibility: 10,
        day: 'Mon',
        date: '2025-01-01',
    },
    forecast: [],
    hourly: [],
    tides: [],
    boatingAdvice: 'Conditions favourable',
    generatedAt: new Date().toISOString(),
    modelUsed: model,
});

const agePointCache = (coordinates: WeatherCacheCoordinates, ageMinutes: number): void => {
    const key = weatherCacheKeyForCoordinates(coordinates);
    expect(key).not.toBeNull();
    const raw = localStorage.getItem(key!);
    expect(raw).not.toBeNull();
    const entry = JSON.parse(raw!);
    entry.timestamp = Date.now() - ageMinutes * 60 * 1000;
    localStorage.setItem(key!, JSON.stringify(entry));
};

beforeEach(() => {
    localStorage.clear();
});

describe('differenceInMinutes', () => {
    it('returns 0 for identical dates', () => {
        const date = new Date('2025-01-01T00:00:00Z');
        expect(differenceInMinutes(date, date)).toBe(0);
    });

    it('is symmetric and returns the absolute difference', () => {
        const first = new Date('2025-01-01T00:00:00Z');
        const second = new Date('2025-01-01T02:30:00Z');
        expect(differenceInMinutes(first, second)).toBe(150);
        expect(differenceInMinutes(first, second)).toBe(differenceInMinutes(second, first));
    });
});

describe('point-bound cache identity', () => {
    it('saves and retrieves a report for the exact requested coordinates', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));

        expect(getFromCache(BRISBANE)).toMatchObject({
            locationName: 'Brisbane',
            coordinates: BRISBANE,
        });
    });

    it('isolates two coordinates that share the same display name', () => {
        saveToCache(BRISBANE, makeReport('open_meteo', BRISBANE, 'Shared Bay'));

        expect(getFromCache(GOLD_COAST)).toBeNull();

        saveToCache(GOLD_COAST, makeReport('open_meteo', GOLD_COAST, 'Shared Bay'));
        expect(getFromCache(BRISBANE)?.coordinates).toEqual(BRISBANE);
        expect(getFromCache(GOLD_COAST)?.coordinates).toEqual(GOLD_COAST);
    });

    it('resolves history by embedded point and rejects ambiguous display names', () => {
        const brisbane = makeReport('open_meteo', BRISBANE, 'Shared Bay');
        const goldCoast = makeReport('open_meteo', GOLD_COAST, 'Shared Bay');
        const history = {
            [weatherHistoryKeyForCoordinates(BRISBANE)!]: brisbane,
            [weatherHistoryKeyForCoordinates(GOLD_COAST)!]: goldCoast,
        };

        expect(findWeatherHistoryReport(history, 'Shared Bay', BRISBANE)).toBe(brisbane);
        expect(findWeatherHistoryReport(history, 'Shared Bay', GOLD_COAST)).toBe(goldCoast);
        expect(findWeatherHistoryReport(history, 'Shared Bay')).toBeNull();
    });

    it('normalizes legacy name keys and retains only the newest record for each exact point', () => {
        const older = {
            ...makeReport('open_meteo', BRISBANE),
            generatedAt: new Date(Date.now() - 60_000).toISOString(),
        };
        const newer = { ...makeReport('open_meteo', BRISBANE), generatedAt: new Date().toISOString() };

        const normalized = normalizeWeatherHistoryCache({ Brisbane: older, 'Current Location': newer });

        expect(normalized).toEqual({ [weatherHistoryKeyForCoordinates(BRISBANE)!]: newer });
    });

    it('bounds precise-location history and discards stale or coordinate-less reports', () => {
        let history: Record<string, MarineWeatherReport> = {
            stale: {
                ...makeReport('open_meteo', HOBART),
                generatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
            },
            missingPoint: { ...makeReport('open_meteo'), coordinates: undefined },
        };
        for (let index = 0; index < MAX_WEATHER_HISTORY_ENTRIES + 5; index += 1) {
            history = recordWeatherHistoryReport(history, {
                ...makeReport('open_meteo', { lat: -20 - index / 100, lon: 150 + index / 100 }),
                generatedAt: new Date(Date.now() - index * 1000).toISOString(),
            });
        }

        expect(Object.keys(history)).toHaveLength(MAX_WEATHER_HISTORY_ENTRIES);
        expect(Object.values(history)).not.toContainEqual(expect.objectContaining({ coordinates: HOBART }));
        expect(Object.values(history).every((report) => report.coordinates !== undefined)).toBe(true);
    });

    it('rejects a report whose embedded coordinates do not match its requested point', () => {
        saveToCache(BRISBANE, makeReport('open_meteo', GOLD_COAST, 'Wrong point'));

        expect(getFromCache(BRISBANE)).toBeNull();
        expect(localStorage.length).toBe(0);
    });

    it('returns null for expired OpenMeteo cache data', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));
        agePointCache(BRISBANE, 31);

        expect(getFromCache(BRISBANE)).toBeNull();
    });

    it('discards a far-future timestamp instead of treating it as fresh forever', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));
        const key = weatherCacheKeyForCoordinates(BRISBANE)!;
        const entry = JSON.parse(localStorage.getItem(key)!);
        entry.timestamp = Date.now() + 60 * 60 * 1000;
        localStorage.setItem(key, JSON.stringify(entry));

        expect(getFromCache(BRISBANE)).toBeNull();
        expect(localStorage.getItem(key)).toBeNull();
    });

    it('keeps StormGlass cache valid for 60 minutes', () => {
        saveToCache(BRISBANE, makeReport('stormglass_pro'));
        agePointCache(BRISBANE, 45);

        expect(getFromCache(BRISBANE)).not.toBeNull();
    });

    it('keeps StormGlass cache valid after the OpenMeteo TTL', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));
        saveToCache(GOLD_COAST, makeReport('open_meteo', GOLD_COAST, 'Gold Coast'));

        clearCache(BRISBANE);

        expect(getFromCache(BRISBANE)).toBeNull();
        expect(getFromCache(GOLD_COAST)).not.toBeNull();
    });
});

describe('offline cache safety', () => {
    it('returns fresh exact-point data with a finite age', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));

        const result = getFromCacheOffline(BRISBANE);
        expect(result).toMatchObject({ stale: false, data: { coordinates: BRISBANE } });
        expect(Number.isFinite(result?.ageMinutes)).toBe(true);
        expect(result?.ageMinutes).toBeGreaterThanOrEqual(0);
    });

    it('returns expired exact-point data with a finite stale age', () => {
        saveToCache(HOBART, makeReport('open_meteo', HOBART, 'Hobart'));
        agePointCache(HOBART, 45);

        const result = getFromCacheOffline(HOBART);
        expect(result).toMatchObject({ stale: true, ageMinutes: 45 });
        expect(Number.isFinite(result?.ageMinutes)).toBe(true);
    });

    it('never substitutes another point when the requested point is missing', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));

        expect(getFromCacheOffline(HOBART)).toBeNull();
    });

    it('purges and never reads the retired global last-report fallback', () => {
        localStorage.setItem('last_marine_report', JSON.stringify(makeReport('open_meteo')));
        localStorage.setItem('marine_weather_cache_v6_brisbane', JSON.stringify({ private: 'legacy' }));
        localStorage.setItem('marine_weather_cache_v8_brisbane', JSON.stringify({ private: 'legacy' }));

        expect(getFromCacheOffline(HOBART)).toBeNull();
        expect(localStorage.getItem('last_marine_report')).toBeNull();
        expect(localStorage.getItem('marine_weather_cache_v6_brisbane')).toBeNull();
        expect(localStorage.getItem('marine_weather_cache_v8_brisbane')).toBeNull();
    });
});

describe('cache cleanup', () => {
    it('clearCache without a point removes every weather cache and retired fallback', () => {
        saveToCache(BRISBANE, makeReport('open_meteo'));
        saveToCache(GOLD_COAST, makeReport('open_meteo', GOLD_COAST, 'Gold Coast'));
        localStorage.setItem('marine_weather_cache_v8_legacy', 'legacy');
        localStorage.setItem('last_marine_report', 'legacy');
        localStorage.setItem('unrelated_setting', 'keep');

        clearCache();

        expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual([
            'unrelated_setting',
        ]);
    });

    it('reports and removes all retired entries', () => {
        localStorage.setItem('marine_weather_cache_v6_a', 'a');
        localStorage.setItem('marine_weather_cache_v7_b', 'b');
        localStorage.setItem('marine_weather_cache_v8_a', 'a');
        localStorage.setItem('marine_weather_cache_v8_b', 'b');
        localStorage.setItem('last_marine_report', 'last');

        expect(purgeRetiredWeatherCacheEntries()).toBe(5);
        expect(localStorage.length).toBe(0);
    });
});
