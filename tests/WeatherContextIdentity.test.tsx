import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';

const contextMocks = vi.hoisted(() => ({
    storage: new Map<string, unknown>(),
    updateSettings: vi.fn(),
    gps: vi.fn(),
    fetchWeatherByStrategy: vi.fn(),
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(),
    settings: {
        defaultLocation: 'Locked test port',
        defaultLocationCoords: { lat: -27.4, lon: 153.1 },
        forecastModel: 'gfs',
        satelliteMode: false,
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: contextMocks.settings,
        updateSettings: contextMocks.updateSettings,
        loading: true,
    }),
}));

vi.mock('../services/nativeStorage', () => ({
    DATA_CACHE_KEY: 'thalassa_weather_cache_v9',
    VOYAGE_CACHE_KEY: 'thalassa_voyage_cache_v2',
    HISTORY_CACHE_KEY: 'thalassa_history_cache_v3',
    saveLargeData: vi.fn(async (key: string, value: unknown) => {
        contextMocks.storage.set(key, value);
    }),
    saveLargeDataImmediate: vi.fn(async (key: string, value: unknown) => {
        contextMocks.storage.set(key, value);
    }),
    loadLargeData: vi.fn(async (key: string) => {
        if (key.startsWith('thalassa_weather_cache_schema::')) return 'v19.2-WEATHERKIT-FIX';
        return contextMocks.storage.get(key) ?? null;
    }),
    loadLargeDataSync: vi.fn((key: string) => {
        if (key.startsWith('thalassa_weather_cache_schema::')) return 'v19.2-WEATHERKIT-FIX';
        return contextMocks.storage.get(key) ?? null;
    }),
    deleteLargeData: vi.fn(async (key: string) => {
        contextMocks.storage.delete(key);
    }),
    readCacheVersion: vi.fn(async () => 'v19.2-WEATHERKIT-FIX'),
    writeCacheVersion: vi.fn(async () => undefined),
}));

vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPosition: contextMocks.gps },
}));

vi.mock('../services/weatherService', () => ({
    fetchWeatherByStrategy: contextMocks.fetchWeatherByStrategy,
    fetchPrecisionWeather: vi.fn(),
    parseLocation: contextMocks.parseLocation,
    reverseGeocode: contextMocks.reverseGeocode,
}));

vi.mock('../services/EnvironmentService', () => ({
    EnvironmentService: { updateFromWeatherData: vi.fn() },
}));

vi.mock('../components/Toast', () => ({
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { WeatherProvider, useWeather } from '../context/WeatherContext';
import { weatherCacheKeysForScope } from '../services/WeatherOrchestrator';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useWeatherStore } from '../stores/weatherStore';

function makeReport(name: string, generatedAt = new Date().toISOString()): MarineWeatherReport {
    return {
        locationName: name,
        coordinates: { lat: -27.4, lon: 153.1 },
        locationType: 'coastal',
        generatedAt,
        current: {},
        alerts: [],
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
    } as unknown as MarineWeatherReport;
}

type WeatherContextValue = ReturnType<typeof useWeather>;

let latestContext: WeatherContextValue | null = null;
let accountAContext: WeatherContextValue | null = null;

function Probe() {
    const weather = useWeather();
    latestContext = weather;
    if (weather.weatherData?.locationName === 'Account A port') accountAContext = weather;
    return (
        <div data-testid="weather-state">
            {weather.weatherData?.locationName ?? 'none'}|{weather.voyagePlan ? 'voyage' : 'no-voyage'}|
            {weather.loading ? 'loading' : 'ready'}
        </div>
    );
}

beforeEach(() => {
    contextMocks.storage.clear();
    contextMocks.updateSettings.mockClear();
    contextMocks.gps.mockReset();
    contextMocks.gps.mockResolvedValue(null);
    contextMocks.fetchWeatherByStrategy.mockReset();
    contextMocks.parseLocation.mockReset();
    contextMocks.reverseGeocode.mockReset();
    Object.assign(contextMocks.settings, {
        defaultLocation: 'Locked test port',
        defaultLocationCoords: { lat: -27.4, lon: 153.1 },
        forecastModel: 'gfs',
        satelliteMode: false,
    });
    latestContext = null;
    accountAContext = null;
    setAuthIdentityScope('account-a');
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('WeatherProvider identity transition', () => {
    it('replaces visible A state and the Zustand bridge with blank B state', async () => {
        const scopeA = getAuthIdentityScope();
        contextMocks.storage.set(weatherCacheKeysForScope(scopeA).data, makeReport('Account A port'));

        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        expect(screen.getByTestId('weather-state')).toHaveTextContent('Account A port|no-voyage|ready');
        expect(useWeatherStore.getState().weatherData?.locationName).toBe('Account A port');

        await act(async () => {
            setAuthIdentityScope('account-b');
        });

        expect(screen.getByTestId('weather-state')).toHaveTextContent('none|no-voyage|loading');
        expect(useWeatherStore.getState()).toMatchObject({
            weatherData: null,
            voyagePlan: null,
            loading: true,
            error: null,
            backgroundUpdating: false,
            staleRefresh: false,
            nextUpdate: null,
            historyCache: {},
        });
    });

    it('rejects public callbacks retained from A after B becomes active', async () => {
        const scopeA = getAuthIdentityScope();
        contextMocks.storage.set(weatherCacheKeysForScope(scopeA).data, makeReport('Account A port'));
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        expect(accountAContext).not.toBeNull();

        const staleA = accountAContext!;
        let scopeB = getAuthIdentityScope();
        await act(async () => {
            scopeB = setAuthIdentityScope('account-b');
        });

        await act(async () => {
            staleA.saveVoyagePlan({ name: 'Private A voyage' } as never);
            staleA.setHistoryCache({ leaked: makeReport('Private A history') });
            staleA.incrementQuota();
            staleA.refreshData(true);
            await staleA.selectLocation('Private A destination', { lat: -20.2, lon: 148.7 });
            staleA.clearVoyagePlan();
        });

        expect(latestContext?.weatherData).toBeNull();
        expect(latestContext?.voyagePlan).toBeNull();
        expect(latestContext?.historyCache).toEqual({});
        expect(latestContext?.quotaUsed).toBe(0);
        expect(contextMocks.storage.has(weatherCacheKeysForScope(scopeB).voyage)).toBe(false);
        expect(contextMocks.updateSettings).not.toHaveBeenCalled();
    });

    it('keeps first-paint cache UX while showing only B cache after the switch', async () => {
        const scopeA = getAuthIdentityScope();
        contextMocks.storage.set(weatherCacheKeysForScope(scopeA).data, makeReport('Account A port'));
        const syntheticScopeB = {
            key: 'user:account-b',
            userId: 'account-b',
            generation: scopeA.generation + 1,
        } as const;
        contextMocks.storage.set(weatherCacheKeysForScope(syntheticScopeB).data, makeReport('Account B port'));

        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        expect(screen.getByTestId('weather-state')).toHaveTextContent('Account A port');

        await act(async () => {
            setAuthIdentityScope('account-b');
        });

        expect(screen.getByTestId('weather-state')).toHaveTextContent('Account B port|no-voyage|ready');
        expect(useWeatherStore.getState().weatherData?.locationName).toBe('Account B port');
    });

    it('cancels an A reconnect timer before it can fetch or write for B', async () => {
        vi.useFakeTimers();
        const scopeA = getAuthIdentityScope();
        contextMocks.storage.set(
            weatherCacheKeysForScope(scopeA).data,
            makeReport('Stale Account A port', new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()),
        );
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );

        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        await act(async () => {
            setAuthIdentityScope('account-b');
            await vi.advanceTimersByTimeAsync(2_000);
        });

        expect(contextMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
        expect(latestContext?.weatherData).toBeNull();
        expect(contextMocks.storage.has(weatherCacheKeysForScope(getAuthIdentityScope()).data)).toBe(false);
    });

    it('drops an A GPS-follow result before geocode or fetch after A → B', async () => {
        Object.assign(contextMocks.settings, {
            defaultLocation: 'Current Location',
            defaultLocationCoords: undefined,
        });
        let resolveGps!: (position: { latitude: number; longitude: number } | null) => void;
        contextMocks.gps.mockReturnValue(
            new Promise((resolve) => {
                resolveGps = resolve;
            }),
        );
        const scopeA = getAuthIdentityScope();
        contextMocks.storage.set(weatherCacheKeysForScope(scopeA).data, makeReport('Account A GPS port'));
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        expect(contextMocks.gps).toHaveBeenCalled();

        await act(async () => {
            setAuthIdentityScope('account-b');
            resolveGps({ latitude: -20.2, longitude: 148.7 });
            await Promise.resolve();
        });

        expect(contextMocks.reverseGeocode).not.toHaveBeenCalled();
        expect(contextMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
        expect(latestContext?.weatherData).toBeNull();
    });
});
