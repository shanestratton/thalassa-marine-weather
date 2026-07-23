import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';

const weatherMocks = vi.hoisted(() => ({
    fetchWeatherByStrategy: vi.fn(),
    fetchPrecisionWeather: vi.fn(),
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(),
    fetchWeatherKitRealtime: vi.fn(),
    getCurrentPosition: vi.fn(),
    isPremiumUser: vi.fn(),
    saveLargeData: vi.fn(),
    saveLargeDataImmediate: vi.fn(),
    loadLargeData: vi.fn(),
    loadLargeDataSync: vi.fn(),
    deleteLargeData: vi.fn(),
    readCacheVersion: vi.fn(),
    writeCacheVersion: vi.fn(),
}));

vi.mock('../services/weatherService', () => ({
    fetchWeatherByStrategy: weatherMocks.fetchWeatherByStrategy,
    fetchPrecisionWeather: weatherMocks.fetchPrecisionWeather,
    parseLocation: weatherMocks.parseLocation,
    reverseGeocode: weatherMocks.reverseGeocode,
}));

vi.mock('../services/weather/api/weatherkit', () => ({
    fetchWeatherKitRealtime: weatherMocks.fetchWeatherKitRealtime,
}));

vi.mock('../services/weather/keys', () => ({
    isStormglassKeyPresent: () => false,
}));

vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPosition: weatherMocks.getCurrentPosition },
}));

vi.mock('../managers/SubscriptionManager', () => ({
    isPremiumUser: weatherMocks.isPremiumUser,
}));

vi.mock('../services/nativeStorage', () => ({
    DATA_CACHE_KEY: 'thalassa_weather_cache_v9',
    VOYAGE_CACHE_KEY: 'thalassa_voyage_cache_v2',
    HISTORY_CACHE_KEY: 'thalassa_history_cache_v3',
    saveLargeData: weatherMocks.saveLargeData,
    saveLargeDataImmediate: weatherMocks.saveLargeDataImmediate,
    loadLargeData: weatherMocks.loadLargeData,
    loadLargeDataSync: weatherMocks.loadLargeDataSync,
    deleteLargeData: weatherMocks.deleteLargeData,
    readCacheVersion: weatherMocks.readCacheVersion,
    writeCacheVersion: weatherMocks.writeCacheVersion,
}));

vi.mock('../services/EnvironmentService', () => ({
    EnvironmentService: { updateFromWeatherData: vi.fn() },
}));

vi.mock('../services/sentry', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
}));

import {
    WeatherOrchestrator,
    weatherCacheKeysForScope,
    type OrchestratorCallbacks,
} from '../services/WeatherOrchestrator';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeReport(name: string, lat = -27.4, lon = 153.1): MarineWeatherReport {
    return {
        locationName: name,
        coordinates: { lat, lon },
        locationType: 'coastal',
        generatedAt: new Date().toISOString(),
        aiGeneratedAt: new Date().toISOString(),
        boatingAdvice: 'Proceed with care',
        current: {
            windSpeed: 8,
            windGust: 10,
            windDirection: 'E',
            waveHeight: 0.5,
            precipitation: 0,
            visibility: 10,
        },
        alerts: [],
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
    } as unknown as MarineWeatherReport;
}

function callbackHarness(settings: Record<string, unknown> = {}) {
    const state = {
        weatherData: null as MarineWeatherReport | null,
        history: {} as Record<string, MarineWeatherReport>,
        loading: false,
        loadingMessage: '',
        backgroundUpdating: false,
        staleRefresh: false,
        error: null as string | null,
        nextUpdate: null as number | null,
        versionChecked: false,
        quota: 0,
        isFetching: false,
        locationMode: 'selected' as 'gps' | 'selected',
        settings,
    };
    const callbacks: OrchestratorCallbacks = {
        setWeatherData: (value) => {
            state.weatherData = value;
        },
        setLoading: (value) => {
            state.loading = value;
        },
        setLoadingMessage: (value) => {
            state.loadingMessage = value;
        },
        setBackgroundUpdating: (value) => {
            state.backgroundUpdating = value;
        },
        setStaleRefresh: (value) => {
            state.staleRefresh = value;
        },
        setError: (value) => {
            state.error = value;
        },
        setNextUpdate: (value) => {
            state.nextUpdate = value;
        },
        setHistoryCache: (updater) => {
            state.history = updater(state.history);
        },
        setVersionChecked: (value) => {
            state.versionChecked = value;
        },
        incrementQuota: () => {
            state.quota += 1;
        },
        getWeatherData: () => state.weatherData,
        getSettings: () => state.settings,
        getHistoryCache: () => state.history,
        getLocationMode: () => state.locationMode,
        getIsFetching: () => state.isFetching,
        setIsFetching: (value) => {
            state.isFetching = value;
        },
    };
    return { state, callbacks };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    setAuthIdentityScope('account-a');
    weatherMocks.isPremiumUser.mockResolvedValue(false);
    weatherMocks.loadLargeData.mockResolvedValue(null);
    weatherMocks.loadLargeDataSync.mockReturnValue(null);
    weatherMocks.saveLargeDataImmediate.mockResolvedValue(undefined);
    weatherMocks.saveLargeData.mockResolvedValue(undefined);
    weatherMocks.deleteLargeData.mockResolvedValue(undefined);
    weatherMocks.readCacheVersion.mockResolvedValue(null);
    weatherMocks.writeCacheVersion.mockResolvedValue(undefined);
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('WeatherOrchestrator identity fences', () => {
    it('does not let an A fetch result or finally clear B while B is fetching', async () => {
        const aResult = deferred<MarineWeatherReport | null>();
        const bResult = deferred<MarineWeatherReport | null>();
        weatherMocks.fetchWeatherByStrategy
            .mockImplementationOnce(() => aResult.promise)
            .mockImplementationOnce(() => bResult.promise);
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        const scopeA = getAuthIdentityScope();
        const orchestratorA = new WeatherOrchestrator(callbacks, scopeA);

        const fetchA = orchestratorA.fetchWeather('Account A port', {
            coords: { lat: -27.4, lon: 153.1 },
        });
        await flushPromises();

        const scopeB = setAuthIdentityScope('account-b');
        Object.assign(state, {
            weatherData: null,
            history: {},
            loading: true,
            backgroundUpdating: false,
            staleRefresh: false,
            error: null,
            nextUpdate: null,
            quota: 0,
            isFetching: false,
        });
        const orchestratorB = new WeatherOrchestrator(callbacks, scopeB);
        const fetchB = orchestratorB.fetchWeather('Account B port', {
            coords: { lat: -20.2, lon: 148.7 },
            silent: true,
        });
        await flushPromises();

        aResult.resolve(makeReport('Private A result'));
        await fetchA;

        expect(state.weatherData).toBeNull();
        expect(state.isFetching).toBe(true);
        expect(state.backgroundUpdating).toBe(true);
        expect(state.loading).toBe(true);

        bResult.resolve(makeReport('Safe B result', -20.2, 148.7));
        await fetchB;

        expect(state.weatherData?.locationName).toBe('Safe B result');
        expect(state.isFetching).toBe(false);
        expect(state.backgroundUpdating).toBe(false);
        expect(weatherMocks.saveLargeDataImmediate).toHaveBeenCalledWith(
            weatherCacheKeysForScope(scopeB).data,
            expect.objectContaining({ locationName: 'Safe B result' }),
        );
        expect(weatherMocks.saveLargeDataImmediate).not.toHaveBeenCalledWith(
            weatherCacheKeysForScope(scopeA).data,
            expect.anything(),
        );
    });

    it('drops an A cache load that resolves after the identity changes', async () => {
        const cacheResult = deferred<MarineWeatherReport | null>();
        weatherMocks.loadLargeData.mockImplementationOnce(() => cacheResult.promise);
        const { state, callbacks } = callbackHarness({ defaultLocation: '' });
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        const loading = orchestrator.loadCacheAndInit();
        setAuthIdentityScope('account-b');
        cacheResult.resolve(makeReport('Cached private A port'));
        await loading;

        expect(state.weatherData).toBeNull();
        expect(state.history).toEqual({});
        expect(state.loading).toBe(false);
        expect(weatherMocks.saveLargeDataImmediate).not.toHaveBeenCalled();
    });

    it('drops a late A GPS fix before it can start a fetch for B', async () => {
        const gpsResult = deferred<{ latitude: number; longitude: number } | null>();
        weatherMocks.getCurrentPosition.mockReturnValue(gpsResult.promise);
        const { callbacks } = callbackHarness({ defaultLocation: 'Current Location' });
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.loadCacheAndInit();
        expect(weatherMocks.getCurrentPosition).toHaveBeenCalledOnce();

        setAuthIdentityScope('account-b');
        gpsResult.resolve({ latitude: -27.4, longitude: 153.1 });
        await flushPromises();

        expect(weatherMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
    });

    it('cancels a named-location startup timer on identity transition', async () => {
        vi.useFakeTimers();
        const { callbacks } = callbackHarness({
            defaultLocation: 'Private A marina',
            defaultLocationCoords: { lat: -27.4, lon: 153.1 },
        });
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.loadCacheAndInit();
        setAuthIdentityScope('account-b');
        await vi.advanceTimersByTimeAsync(200);

        expect(weatherMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
    });

    it('persists weather and next-update only under the captured identity', async () => {
        const scopeA = getAuthIdentityScope();
        weatherMocks.fetchWeatherByStrategy.mockResolvedValue(makeReport('Account A port'));
        const { callbacks } = callbackHarness({ satelliteMode: false });
        const orchestrator = new WeatherOrchestrator(callbacks, scopeA);

        await orchestrator.fetchWeather('Account A port', {
            coords: { lat: -27.4, lon: 153.1 },
        });
        await flushPromises();

        const keys = weatherCacheKeysForScope(scopeA);
        expect(weatherMocks.saveLargeDataImmediate).toHaveBeenCalledWith(
            keys.data,
            expect.objectContaining({ locationName: 'Account A port' }),
        );
        expect(localStorage.getItem(keys.nextUpdate)).toMatch(/^\d+$/);
        expect(localStorage.getItem('thalassa_next_update')).toBeNull();
    });
});
