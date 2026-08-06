import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';
import { apiCacheGet, apiCacheSet } from '../services/weather/apiCache';
import {
    getFromCache,
    getFromCacheOffline,
    saveToCache,
    weatherCacheKeyForCoordinates,
    type WeatherCacheCoordinates,
} from '../services/weather/cache';
import {
    PLAINTEXT_WEATHER_CACHE_KEYS,
    PLAINTEXT_WEATHER_CACHE_PREFIXES,
    canUsePlaintextWeatherCache,
    scrubIosPlaintextWeatherCaches,
} from '../services/weather/plaintextCachePrivacy';

const POINT: WeatherCacheCoordinates = { lat: -27.4698, lon: 153.0251 };

const report: MarineWeatherReport = {
    locationName: 'Brisbane',
    coordinates: POINT,
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
        date: '2026-08-06',
    },
    forecast: [],
    hourly: [],
    tides: [],
    boatingAdvice: 'Conditions favourable',
    generatedAt: new Date().toISOString(),
    modelUsed: 'open_meteo',
};

function setPlatform(platform: 'web' | 'ios'): void {
    vi.mocked(Capacitor.getPlatform).mockReturnValue(platform);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(platform === 'ios');
}

beforeEach(() => {
    localStorage.clear();
    setPlatform('web');
});

afterEach(() => {
    setPlatform('web');
    vi.restoreAllMocks();
});

describe('iOS direct weather-cache privacy', () => {
    it('scrubs every current and retired direct weather family without touching unrelated preferences', () => {
        const sensitiveKeys = [
            'marine_weather_cache_v9_point_-27.46980_153.02510',
            'marine_weather_cache_v8_brisbane',
            'thalassa_apicache_v3_point_openmeteo_-27.470_153.025',
            'thalassa_apicache_v2_tides_-27.5_153.0',
            'thalassa_rain_rainbow_-27.47_153.03',
            'thalassa_ocean_currents_sensitive-fingerprint',
            'thalassa_weather_windows:sensitive-fingerprint',
            'last_marine_report',
        ];
        for (const key of sensitiveKeys) localStorage.setItem(key, JSON.stringify({ coordinates: POINT }));
        localStorage.setItem('thalassa_units', 'metric');

        setPlatform('ios');

        expect(scrubIosPlaintextWeatherCaches()).toBe(sensitiveKeys.length);
        expect(sensitiveKeys.every((key) => localStorage.getItem(key) === null)).toBe(true);
        expect(localStorage.getItem('thalassa_units')).toBe('metric');
        expect(PLAINTEXT_WEATHER_CACHE_PREFIXES).toEqual(
            expect.arrayContaining([
                'marine_weather_cache_',
                'thalassa_apicache_',
                'thalassa_rain_',
                'thalassa_ocean_currents_',
                'thalassa_weather_windows',
            ]),
        );
        expect(PLAINTEXT_WEATHER_CACHE_KEYS).toContain('last_marine_report');
    });

    it('refuses planner point-cache reads and writes on iOS and turns an old exact report into a safe miss', () => {
        saveToCache(POINT, report);
        const key = weatherCacheKeyForCoordinates(POINT)!;
        expect(localStorage.getItem(key)).not.toBeNull();

        setPlatform('ios');
        const getItem = vi.spyOn(Storage.prototype, 'getItem');

        expect(getFromCache(POINT)).toBeNull();
        expect(getItem).not.toHaveBeenCalledWith(key);
        expect(getFromCacheOffline(POINT)).toBeNull();
        expect(localStorage.getItem(key)).toBeNull();
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        saveToCache(POINT, report);
        expect(setItem).not.toHaveBeenCalled();
        expect(localStorage.getItem(key)).toBeNull();
        expect(canUsePlaintextWeatherCache()).toBe(false);
    });

    it('refuses provider-cache reads and writes on iOS while retaining web cache behavior', () => {
        apiCacheSet('openmeteo', POINT.lat, POINT.lon, { temperature: 22 });
        expect(apiCacheGet('openmeteo', POINT.lat, POINT.lon)).toEqual({ temperature: 22 });

        setPlatform('ios');

        expect(apiCacheGet('openmeteo', POINT.lat, POINT.lon)).toBeNull();
        expect(
            [...Array(localStorage.length)].some((_, index) =>
                localStorage.key(index)?.startsWith('thalassa_apicache_'),
            ),
        ).toBe(false);
        apiCacheSet('openmeteo', POINT.lat, POINT.lon, { temperature: 23 });
        expect(apiCacheGet('openmeteo', POINT.lat, POINT.lon)).toBeNull();

        setPlatform('web');
        apiCacheSet('openmeteo', POINT.lat, POINT.lon, { temperature: 24 });
        expect(apiCacheGet('openmeteo', POINT.lat, POINT.lon)).toEqual({ temperature: 24 });
    });

    it('routes every remaining direct point-weather UI/service cache through the native privacy gate', () => {
        const dashboard = readFileSync(resolve(process.cwd(), 'components/Dashboard.tsx'), 'utf8');
        const currents = readFileSync(resolve(process.cwd(), 'services/OceanCurrentService.ts'), 'utf8');
        const windows = readFileSync(resolve(process.cwd(), 'services/WeatherWindowService.ts'), 'utf8');

        expect(dashboard).toContain('readPlaintextWeatherCacheItem(cacheKey)');
        expect(dashboard).toContain('writePlaintextWeatherCacheItem(');
        expect(dashboard).not.toContain('localStorage.getItem(cacheKey)');
        expect(currents).toContain('readPlaintextWeatherCacheItem(key)');
        expect(currents).toContain('writePlaintextWeatherCacheItem(key');
        expect(windows).toContain('readPlaintextWeatherCacheItem(cacheKey)');
        expect(windows).toContain('writePlaintextWeatherCacheItem(cacheKey');
    });
});
