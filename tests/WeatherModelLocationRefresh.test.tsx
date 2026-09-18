import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';

const world = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    cache: null as unknown,
    fetch: vi.fn(),
    parse: vi.fn(),
    reverse: vi.fn(),
    gps: vi.fn(),
    boat: vi.fn(),
    precision: vi.fn(),
    premium: false,
    target: 'phone' as 'phone' | 'boat',
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: world.settings, loading: true, updateSettings: vi.fn() }),
}));
vi.mock('../services/nativeStorage', () => ({
    usesNativeEncryptedLargeStorage: () => false,
    DATA_CACHE_KEY: 'weather',
    VOYAGE_CACHE_KEY: 'voyage',
    HISTORY_CACHE_KEY: 'history',
    loadLargeDataSync: (key: string) => (key.startsWith('weather::') ? world.cache : null),
    loadLargeData: vi.fn(async (key: string) =>
        key.startsWith('thalassa_weather_cache_schema::') ? 'v19.2-WEATHERKIT-FIX' : null,
    ),
    saveLargeData: vi.fn(),
    saveLargeDataImmediate: vi.fn(),
    deleteLargeData: vi.fn(),
    readCacheVersion: vi.fn(async () => 'v19.2-WEATHERKIT-FIX'),
    writeCacheVersion: vi.fn(),
}));
vi.mock('../services/weatherService', () => ({
    fetchWeatherByStrategy: world.fetch,
    fetchPrecisionWeather: world.precision,
    parseLocation: world.parse,
    reverseGeocode: world.reverse,
}));
vi.mock('../services/weather/api/weatherkit', () => ({ fetchWeatherKitRealtime: vi.fn(async () => null) }));
vi.mock('../services/weather/keys', () => ({ isStormglassKeyPresent: () => world.premium }));
vi.mock('../managers/SubscriptionManager', () => ({ isPremiumUser: vi.fn(async () => world.premium) }));
vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPositionIfGranted: world.gps, requestCurrentForegroundPosition: vi.fn() },
}));
vi.mock('../services/weatherPosition', () => ({
    WEATHER_FOLLOW_TARGET_EVENT: 'test:weather-target',
    getWeatherFollowTarget: () => world.target,
    setHeldChoice: vi.fn(),
    describeWeatherFix: () => 'GPS unavailable',
    weatherFixStatus: () => 'live',
    resolveWeatherPosition: async (phone: () => Promise<unknown>, { target }: { target: string }) => {
        const value = target === 'phone' ? await phone() : await world.boat();
        const fix = value ? { ...(value as object), kind: target === 'phone' ? 'phone' : 'pi' } : null;
        return { fix, held: null, phone: target === 'phone' ? fix : null, ask: false };
    },
}));
vi.mock('../services/EnvironmentService', () => ({ EnvironmentService: { updateFromWeatherData: vi.fn() } }));
vi.mock('../services/sentry', () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock('../services/geminiService', () => ({ enrichMarineWeather: vi.fn(async (report) => report) }));
vi.mock('../components/Toast', () => ({ toast: { info: vi.fn() } }));

import { WeatherProvider, useWeather } from '../context/WeatherContext';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useUIStore } from '../stores/uiStore';

const MUSGRAVE = { lat: -23.907, lon: 152.404 };
const USA = { lat: 37.7749, lon: -122.4194 };
const report = (name = 'Lady Musgrave', coords = MUSGRAVE): MarineWeatherReport =>
    ({
        locationName: name,
        coordinates: coords,
        generatedAt: new Date().toISOString(),
        aiGeneratedAt: new Date().toISOString(),
        locationType: 'offshore',
        current: { windSpeed: 12 },
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
        alerts: [],
        boatingAdvice: 'Fixture',
    }) as unknown as MarineWeatherReport;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}
let current: ReturnType<typeof useWeather>;
function Probe() {
    current = useWeather();
    return null;
}
const tree = () => (
    <WeatherProvider>
        <Probe />
    </WeatherProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('model-account-a');
    useUIStore.setState({ isOffline: false });
    world.settings = {
        defaultLocation: 'Lady Musgrave',
        defaultLocationCoords: { lat: -27.21, lon: 153.1 },
        forecastModel: 'dwd_icon',
        offshoreModel: 'sg',
    };
    world.cache = report();
    world.premium = false;
    world.precision.mockReset().mockResolvedValue(report());
    world.target = 'phone';
    world.parse.mockReset();
    world.parse.mockResolvedValue({ ...USA, name: 'Unrelated USA match' });
    world.reverse.mockReset();
    world.reverse.mockResolvedValue('Lady Musgrave');
    world.gps.mockReset();
    world.gps.mockImplementation(async () => ({
        latitude: MUSGRAVE.lat,
        longitude: MUSGRAVE.lon,
        timestamp: Date.now(),
    }));
    world.boat.mockReset();
    world.boat.mockImplementation(async () => ({ ...MUSGRAVE, timestamp: Date.now() }));
    world.fetch.mockReset();
    world.fetch.mockImplementation(async (lat, lon, name) => report(name, { lat, lon }));
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('model-only weather refresh preserves location intent', () => {
    it('replaces a nine-day cached report on model change without restamping the provider time', async () => {
        const oldStamp = new Date(Date.now() - 9 * 24 * 3_600_000).toISOString();
        const providerStamp = new Date(Date.now() - 15 * 60_000).toISOString();
        world.cache = { ...report(), locationType: 'inshore', generatedAt: oldStamp, modelUsed: 'spitfire+sg' };
        world.settings.forecastModel = 'spitfire';
        const replacement = {
            ...report(),
            locationType: 'inshore' as const,
            generatedAt: providerStamp,
            modelUsed: 'om:ecmwf_ifs025+sg',
            current: { ...report().current, windSpeed: 18 },
        };
        world.fetch.mockResolvedValue(replacement);
        const view = render(tree());
        expect(current.weatherData?.generatedAt).toBe(oldStamp);
        world.settings = { ...world.settings, forecastModel: 'ecmwf_ifs025' };
        view.rerender(tree());
        await waitFor(() => expect(current.weatherData?.generatedAt).toBe(providerStamp));
        expect(world.fetch).toHaveBeenCalledExactlyOnceWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Lady Musgrave', 'inshore');
        expect(world.parse).not.toHaveBeenCalled();
        expect(current.weatherData).toMatchObject({
            coordinates: MUSGRAVE,
            modelUsed: 'om:ecmwf_ifs025+sg',
            current: { windSpeed: 18 },
        });
        expect(current.error).toBeNull();
    });

    it('retains the true nine-day age and exposes a model-refresh failure instead of calling it fresh', async () => {
        const oldStamp = new Date(Date.now() - 9 * 24 * 3_600_000).toISOString();
        world.cache = { ...report(), locationType: 'inshore', generatedAt: oldStamp, modelUsed: 'spitfire+sg' };
        world.settings.forecastModel = 'spitfire';
        world.fetch.mockRejectedValue(new Error('Model source unavailable'));
        const view = render(tree());
        world.settings = { ...world.settings, forecastModel: 'ecmwf_ifs025' };
        view.rerender(tree());
        await waitFor(() => expect(current.error).toContain('Model source unavailable'));
        expect(world.fetch).toHaveBeenCalledExactlyOnceWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Lady Musgrave', 'inshore');
        expect(current.weatherData).toMatchObject({
            generatedAt: oldStamp,
            coordinates: MUSGRAVE,
            modelUsed: 'spitfire+sg',
        });
        expect(current.loading).toBe(false);
        expect(current.backgroundUpdating).toBe(false);
    });

    it.each(['forecastModel', 'offshoreModel'])(
        'keeps the displayed named point on a %s change without forward geocoding',
        async (setting) => {
            const view = render(tree());
            world.settings = {
                ...world.settings,
                [setting]: setting === 'forecastModel' ? 'ecmwf_aifs025_single' : 'icon',
            };
            view.rerender(tree());
            await waitFor(() => expect(world.fetch).toHaveBeenCalled());
            expect(world.fetch).toHaveBeenLastCalledWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Lady Musgrave', 'offshore');
            expect(world.parse).not.toHaveBeenCalled();
            expect(current.weatherData).toMatchObject({ locationName: 'Lady Musgrave', coordinates: MUSGRAVE });
            expect(world.settings.defaultLocationCoords).toEqual({ lat: -27.21, lon: 153.1 });
        },
    );

    it('uses the saved name/coordinate pair when no report is displayed', async () => {
        world.cache = null;
        world.settings.defaultLocationCoords = MUSGRAVE;
        const view = render(tree());
        world.settings = { ...world.settings, forecastModel: 'ecmwf_aifs025_single' };
        view.rerender(tree());
        await waitFor(() => expect(world.fetch).toHaveBeenCalled());
        expect(world.fetch).toHaveBeenLastCalledWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Lady Musgrave', undefined);
        expect(world.parse).not.toHaveBeenCalled();
    });

    it('refuses to reinterpret a displayed label whose coordinates are missing', async () => {
        world.cache = { ...report(), coordinates: undefined };
        const view = render(tree());
        world.settings = { ...world.settings, forecastModel: 'ecmwf_aifs025_single' };
        view.rerender(tree());
        await waitFor(() => expect(current.error).toMatch(/coordinates unavailable/));
        expect(world.parse).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
        expect(current.weatherData?.locationName).toBe('Lady Musgrave');
    });

    it.each(['phone', 'boat'] as const)(
        'queues the latest model during a %s follow refresh and never paints the obsolete result',
        async (target) => {
            world.target = target;
            world.settings.defaultLocation = 'Current Location';
            const old = deferred<MarineWeatherReport>();
            const latest = deferred<MarineWeatherReport>();
            world.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
            const view = render(tree());
            await act(async () => current.refreshData(true));
            await waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(1));
            world.settings = { ...world.settings, forecastModel: 'ecmwf_aifs025_single' };
            view.rerender(tree());
            world.settings = { ...world.settings, offshoreModel: 'icon' };
            view.rerender(tree());
            await act(async () => {
                old.resolve(report('Obsolete model result'));
            });
            expect(current.weatherData?.locationName).not.toBe('Obsolete model result');
            await waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(2));
            expect(world.fetch).toHaveBeenLastCalledWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Lady Musgrave', 'offshore');
            await act(async () => {
                latest.resolve(report('Lady Musgrave'));
            });
            expect(current.weatherData).toMatchObject({ locationName: 'Lady Musgrave', coordinates: MUSGRAVE });
            expect(world.parse).not.toHaveBeenCalled();
        },
    );

    it.each(['location', 'account'])('drops a queued model refresh after a %s change', async (change) => {
        world.settings.defaultLocation = 'Current Location';
        const old = deferred<MarineWeatherReport>();
        world.fetch.mockReturnValueOnce(old.promise);
        const view = render(tree());
        await act(async () => current.refreshData(true));
        await waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(1));
        world.settings = { ...world.settings, forecastModel: 'ecmwf_aifs025_single' };
        view.rerender(tree());
        if (change === 'location') {
            await act(async () => {
                await current.selectLocation('Selected reef', { lat: -24, lon: 153 });
            });
        } else {
            await act(async () => {
                setAuthIdentityScope('model-account-b');
            });
            expect(getAuthIdentityScope().userId).toBe('model-account-b');
        }
        const calls = world.fetch.mock.calls.length;
        await act(async () => {
            old.resolve(report('Obsolete model result'));
        });
        expect(world.fetch).toHaveBeenCalledTimes(calls);
        expect(current.weatherData?.locationName).not.toBe('Obsolete model result');
    });

    it('does not apply a previous offshore point classification to a newly selected place', async () => {
        render(tree());
        await act(async () => current.selectLocation('New town', USA));
        await waitFor(() => expect(world.fetch).toHaveBeenCalledWith(USA.lat, USA.lon, 'New town', undefined));
    });

    it('does not infer shoreline classification from even a nearby but different point', async () => {
        render(tree());
        const moved = { ...MUSGRAVE, lat: MUSGRAVE.lat + 0.00001 };
        await act(async () => current.selectLocation('Moved point', moved));
        await waitFor(() => expect(world.fetch).toHaveBeenCalledWith(moved.lat, moved.lon, 'Moved point', undefined));
    });

    it('recovers a visited exact-point class from account-scoped history when returning from another location', async () => {
        render(tree());
        await act(async () => current.refreshData(true));
        await waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(current.loading).toBe(false));
        await act(async () => current.selectLocation('New town', USA));
        await waitFor(() => expect(current.weatherData?.coordinates).toEqual(USA));
        await act(async () => current.fetchWeather('Musgrave renamed', true, MUSGRAVE));
        await waitFor(() =>
            expect(world.fetch).toHaveBeenLastCalledWith(MUSGRAVE.lat, MUSGRAVE.lon, 'Musgrave renamed', 'offshore'),
        );
    });

    it('passes the verified exact-point class to the premium precision fallback too', async () => {
        world.premium = true;
        world.fetch.mockRejectedValue(new Error('Primary source unavailable'));
        const view = render(tree());
        world.settings = { ...world.settings, offshoreModel: 'ecmwf' };
        view.rerender(tree());
        await waitFor(() => expect(world.precision).toHaveBeenCalledWith('Lady Musgrave', MUSGRAVE, false, 'offshore'));
    });
});
