import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';

const weatherMocks = vi.hoisted(() => ({
    fetchWeatherByStrategy: vi.fn(),
    fetchPrecisionWeather: vi.fn(),
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(),
    fetchWeatherKitRealtime: vi.fn(),
    getCurrentPosition: vi.fn(),
    getCurrentPositionIfGranted: vi.fn(),
    isPremiumUser: vi.fn(),
    saveLargeData: vi.fn(),
    saveLargeDataImmediate: vi.fn(),
    loadLargeData: vi.fn(),
    loadLargeDataSync: vi.fn(),
    deleteLargeData: vi.fn(),
    readCacheVersion: vi.fn(),
    writeCacheVersion: vi.fn(),
    stormglassKeyPresent: false,
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
    isStormglassKeyPresent: () => weatherMocks.stormglassKeyPresent,
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: weatherMocks.getCurrentPosition,
        getCurrentPositionIfGranted: weatherMocks.getCurrentPositionIfGranted,
    },
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
import { weatherHistoryKeyForCoordinates } from '../services/weather/cache';
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
        isOffline: false,
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
        getIsOffline: () => state.isOffline,
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
    weatherMocks.getCurrentPosition.mockReset();
    weatherMocks.getCurrentPositionIfGranted.mockReset();
    weatherMocks.getCurrentPosition.mockResolvedValue(null);
    weatherMocks.getCurrentPositionIfGranted.mockResolvedValue(null);
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
    weatherMocks.stormglassKeyPresent = false;
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('WeatherOrchestrator identity fences', () => {
    it('uses the reachability probe as the offline authority even when navigator reports a network interface', async () => {
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        state.isOffline = true;
        state.history[weatherHistoryKeyForCoordinates({ lat: -27.4, lon: 153.1 })!] = makeReport('Cached port');
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.fetchWeather('Cached port', {
            force: true,
            coords: { lat: -27.4, lon: 153.1 },
        });

        expect(navigator.onLine).toBe(true);
        expect(weatherMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
        expect(weatherMocks.fetchPrecisionWeather).not.toHaveBeenCalled();
        expect(state.weatherData?.locationName).toBe('Cached port');
        expect(state.isFetching).toBe(false);
    });

    it('never serves the same display name from a different point while offline', async () => {
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        state.isOffline = true;
        state.weatherData = makeReport('Current Location', -27.4, 153.1);
        state.history[weatherHistoryKeyForCoordinates({ lat: -27.4, lon: 153.1 })!] = state.weatherData;
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.fetchWeather('Current Location', {
            force: true,
            coords: { lat: -20.2, lon: 148.7 },
        });

        expect(state.weatherData).toBeNull();
        expect(state.error).toBe('Offline Mode: No Data');
        expect(weatherMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
    });

    it('does not start a WeatherKit live patch while the reachability probe says offline', async () => {
        const { state, callbacks } = callbackHarness();
        state.weatherData = makeReport('Cached port');
        state.isOffline = true;
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.patchLiveMetrics();

        expect(weatherMocks.fetchWeatherKitRealtime).not.toHaveBeenCalled();
        expect(state.weatherData.current.airTemperature).toBeUndefined();
    });

    it('drops a live patch when the reachability probe turns offline during the request', async () => {
        const liveResult = deferred<{
            temperature: number;
            temperatureApparent: null;
            humidity: null;
            windSpeed: null;
            windDirection: null;
            windGust: null;
            pressure: null;
            visibility: null;
            cloudCover: null;
            dewPoint: null;
            uvIndex: null;
            precipitationIntensity: null;
            weatherCode: null;
            condition: string;
            observationTime: string;
        }>();
        weatherMocks.fetchWeatherKitRealtime.mockReturnValueOnce(liveResult.promise);
        const { state, callbacks } = callbackHarness();
        state.weatherData = makeReport('Cached port');
        const original = state.weatherData;
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        const patching = orchestrator.patchLiveMetrics();
        await flushPromises();
        state.isOffline = true;
        liveResult.resolve({
            temperature: 29,
            temperatureApparent: null,
            humidity: null,
            windSpeed: null,
            windDirection: null,
            windGust: null,
            pressure: null,
            visibility: null,
            cloudCover: null,
            dewPoint: null,
            uvIndex: null,
            precipitationIntensity: null,
            weatherCode: null,
            condition: 'Clear',
            observationTime: new Date().toISOString(),
        });
        await patching;

        expect(state.weatherData).toBe(original);
        expect(state.weatherData.current.airTemperature).toBeUndefined();
    });

    it('does not advertise a future refresh if connectivity is lost during a provider request', async () => {
        const weatherResult = deferred<MarineWeatherReport | null>();
        weatherMocks.fetchWeatherByStrategy.mockReturnValueOnce(weatherResult.promise);
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        const scope = getAuthIdentityScope();
        const orchestrator = new WeatherOrchestrator(callbacks, scope);

        const fetching = orchestrator.fetchWeather('Moreton Bay', {
            coords: { lat: -27.4, lon: 153.1 },
        });
        await flushPromises();
        state.isOffline = true;
        weatherResult.resolve(makeReport('Moreton Bay'));
        await fetching;
        await flushPromises();

        expect(state.nextUpdate).toBeNull();
        expect(localStorage.getItem(weatherCacheKeysForScope(scope).nextUpdate)).toBeNull();
    });

    it('does not refetch a fresh current report for a duplicate non-forced bootstrap request', async () => {
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        state.weatherData = makeReport('Sydney, NSW', -33.8688, 151.2093);
        state.loading = true;
        state.backgroundUpdating = true;
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.fetchWeather('Sydney, NSW', {
            coords: { lat: -33.8688, lon: 151.2093 },
        });

        expect(weatherMocks.fetchWeatherByStrategy).not.toHaveBeenCalled();
        expect(weatherMocks.fetchPrecisionWeather).not.toHaveBeenCalled();
        expect(state.loading).toBe(false);
        expect(state.backgroundUpdating).toBe(false);
    });

    it('does fetch a fresh same-name report when the requested point changed', async () => {
        const { state, callbacks } = callbackHarness({ satelliteMode: false });
        state.weatherData = makeReport('Shared Bay', -27.4, 153.1);
        weatherMocks.fetchWeatherByStrategy.mockResolvedValueOnce(makeReport('Shared Bay', -20.2, 148.7));
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.fetchWeather('Shared Bay', {
            coords: { lat: -20.2, lon: 148.7 },
        });

        expect(weatherMocks.fetchWeatherByStrategy).toHaveBeenCalledWith(-20.2, 148.7, 'Shared Bay', undefined);
        expect(state.weatherData?.coordinates).toEqual({ lat: -20.2, lon: 148.7 });
    });

    it('does not unlock the paid weather fallback when entitlement verification fails', async () => {
        weatherMocks.stormglassKeyPresent = true;
        weatherMocks.isPremiumUser.mockRejectedValueOnce(new Error('entitlement unavailable'));
        weatherMocks.fetchWeatherByStrategy.mockRejectedValueOnce(new Error('standard provider unavailable'));
        weatherMocks.fetchPrecisionWeather.mockResolvedValue(makeReport('Paid fallback'));
        const { callbacks } = callbackHarness({ satelliteMode: false });
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.fetchWeather('Moreton Bay', { coords: { lat: -27.4, lon: 153.1 } });

        expect(weatherMocks.fetchPrecisionWeather).not.toHaveBeenCalled();
    });

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
        weatherMocks.getCurrentPositionIfGranted.mockReturnValue(gpsResult.promise);
        const { callbacks } = callbackHarness({ defaultLocation: 'Current Location' });
        const orchestrator = new WeatherOrchestrator(callbacks, getAuthIdentityScope());

        await orchestrator.loadCacheAndInit();
        expect(weatherMocks.getCurrentPositionIfGranted).toHaveBeenCalledOnce();
        expect(weatherMocks.getCurrentPosition).not.toHaveBeenCalled();

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
