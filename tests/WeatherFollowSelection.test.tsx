import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';

const world = vi.hoisted(() => ({
    settings: { defaultLocation: 'Initial port', forecastModel: 'gfs', satelliteMode: false } as Record<
        string,
        unknown
    >,
    initial: null as unknown,
    target: 'phone' as 'phone' | 'boat',
    gps: vi.fn(),
    requestGps: vi.fn(),
    boat: vi.fn(),
    reverse: vi.fn(),
    tides: vi.fn(),
    fetch: vi.fn(),
    cancel: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: world.settings,
        loading: true,
        updateSettings: (patch: object) => Object.assign(world.settings, patch),
    }),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPositionIfGranted: world.gps,
        requestCurrentForegroundPosition: world.requestGps,
    },
}));
vi.mock('../services/weatherService', () => ({ reverseGeocode: world.reverse }));
vi.mock('../services/weather/api/tides', () => ({ fetchTidesForPosition: world.tides }));
vi.mock('../components/Toast', () => ({ toast: { info: vi.fn() } }));
vi.mock('../services/nativeStorage', () => ({
    saveLargeData: vi.fn(),
    saveLargeDataImmediate: vi.fn(),
    deleteLargeData: vi.fn(),
    loadLargeData: vi.fn(async () => null),
    VOYAGE_CACHE_KEY: 'voyage',
}));
vi.mock('../services/weatherPosition', () => ({
    WEATHER_FOLLOW_TARGET_EVENT: 'test:target-change',
    getWeatherFollowTarget: () => world.target,
    setWeatherFollowTarget: (target: 'phone' | 'boat') => {
        world.target = target;
        window.dispatchEvent(new Event('test:target-change'));
    },
    setHeldChoice: vi.fn(),
    describeWeatherFix: (_fix: unknown, _now: number, target: string) =>
        `${target === 'boat' ? 'Boat' : 'Phone'} GPS unavailable`,
    weatherFixStatus: (fix: { kind: string }) => (fix.kind === 'held' ? 'last-known' : 'live'),
    resolveWeatherPosition: async (phone: () => Promise<unknown>, { target }: { target: string }) => {
        const value = target === 'boat' ? await world.boat() : await phone();
        const fix = value ? { ...(value as object), kind: target === 'boat' ? 'pi' : 'phone' } : null;
        return { fix, held: null, phone: target === 'phone' ? fix : null, ask: false };
    },
}));
vi.mock('../services/WeatherOrchestrator', () => ({
    STALE_THRESHOLD_MS: 30 * 60_000,
    weatherCacheKeysForScope: () => ({ data: 'weather', history: 'history', voyage: 'voyage', nextUpdate: 'next' }),
    loadWeatherCacheSyncForScope: () => world.initial,
    WeatherOrchestrator: class {
        static updateEnvironment = vi.fn();
        constructor(private callbacks: { setWeatherData: (data: unknown) => void }) {}
        loadInstantCache() {
            return world.initial;
        }
        checkCacheVersion() {}
        loadCache() {}
        loadCacheAndInit() {}
        dispose() {}
        cancelPendingLocation() {
            world.cancel();
        }
        patchLiveMetrics() {}
        async fetchWeather(name: string, options: { coords?: { lat: number; lon: number } }) {
            world.fetch(name, options);
            this.callbacks.setWeatherData({
                current: {},
                forecast: [],
                hourly: [],
                alerts: [],
                tides: [],
                tideHourly: [],
                ...(world.initial as object),
                locationName: name,
                coordinates: options.coords,
                generatedAt: new Date().toISOString(),
            });
        }
    },
}));

import { WeatherProvider, useWeather } from '../context/WeatherContext';
import { setWeatherFollowTarget } from '../services/weatherPosition';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useUIStore } from '../stores/uiStore';

let current: ReturnType<typeof useWeather>;
function Probe() {
    current = useWeather();
    return null;
}
function report(name: string, lat = -27.21, lon = 153.1): MarineWeatherReport {
    return {
        locationName: name,
        coordinates: { lat, lon },
        generatedAt: new Date().toISOString(),
        locationType: 'coastal',
        current: {},
        forecast: [],
        hourly: [],
        tides: [],
        tideHourly: [],
        alerts: [],
    } as unknown as MarineWeatherReport;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function mount() {
    render(
        <WeatherProvider>
            <Probe />
        </WeatherProvider>,
    );
}

async function establishPhoneFollow() {
    world.gps.mockImplementation(async () => ({
        latitude: -27.21,
        longitude: 153.1,
        timestamp: Date.now(),
    }));
    mount();
    await act(async () => {
        await current.selectLocation('Current Location');
    });
    expect(current.positionSource).toMatchObject({ kind: 'phone', target: 'phone', status: 'live' });
    expect(current.weatherData?.coordinates).toEqual({ lat: -27.21, lon: 153.1 });
    return { saved: current.weatherData!, fixTimestamp: current.positionSource!.timestamp };
}

beforeEach(() => {
    vi.clearAllMocks();
    world.settings = { defaultLocation: 'Initial port', forecastModel: 'gfs', satelliteMode: false };
    world.initial = report('Initial port');
    world.target = 'phone';
    world.gps.mockResolvedValue(null);
    world.requestGps.mockResolvedValue(null);
    world.boat.mockResolvedValue(null);
    world.reverse.mockResolvedValue('Newport');
    world.tides.mockResolvedValue(null);
    useUIStore.setState({ isOffline: false });
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('weather receiver selection boundaries', () => {
    it('leaves the first-run location choice empty without polling an unselected receiver', async () => {
        vi.useFakeTimers();
        world.settings.defaultLocation = '';
        world.initial = null;
        mount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(current.weatherData).toBeNull();
        expect(current.error).toBeNull();
        expect(current.positionSource).toBeNull();
        expect(world.gps).not.toHaveBeenCalled();
        expect(world.boat).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'failed'])('retains the saved port when the passive boot fix is %s', async (outcome) => {
        world.settings.defaultLocationCoords = { lat: -27.21, lon: 153.1 };
        if (outcome === 'failed') world.gps.mockRejectedValue(new Error('Location unavailable'));
        mount();
        const savedReport = current.weatherData;

        await act(async () => {
            await current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        expect(current.weatherData).toBe(savedReport);
        expect(world.settings.defaultLocation).toBe('Initial port');
        expect(world.settings.defaultLocationCoords).toEqual({ lat: -27.21, lon: 153.1 });
        expect(current.error).toBeNull();
        expect(current.positionSource).toBeNull();
        expect(current.backgroundUpdating).toBe(false);
        expect(world.requestGps).not.toHaveBeenCalled();
        expect(world.cancel).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('enters GPS follow using the successful passive boot fix without waiting for another fix', async () => {
        world.gps
            .mockResolvedValueOnce({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() })
            .mockReturnValue(new Promise(() => {}));
        mount();

        await act(async () => {
            await current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        expect(world.settings.defaultLocation).toBe('Current Location');
        expect(current.weatherData?.coordinates).toEqual({ lat: -27.2, lon: 153.08 });
        expect(current.positionSource).toMatchObject({ kind: 'phone', target: 'phone', status: 'live' });
        expect(world.requestGps).not.toHaveBeenCalled();
        expect(world.fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps cached port weather on an offline boot without probing GPS', async () => {
        useUIStore.setState({ isOffline: true });
        mount();
        const savedReport = current.weatherData;

        await act(async () => {
            await current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        expect(current.weatherData).toBe(savedReport);
        expect(world.settings.defaultLocation).toBe('Initial port');
        expect(world.gps).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('retains the cached port if the WAN goes offline while the passive boot fix is pending', async () => {
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        mount();
        const savedReport = current.weatherData;
        let boot!: Promise<void>;
        act(() => {
            boot = current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        await act(async () => {
            useUIStore.setState({ isOffline: true });
            pending.resolve({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
            await boot;
        });

        expect(current.weatherData).toBe(savedReport);
        expect(world.settings.defaultLocation).toBe('Initial port');
        expect(current.error).toBeNull();
        expect(current.positionSource).toBeNull();
        expect(world.cancel).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('discards a passive boot fix from the previous account before touching the new account', async () => {
        setAuthIdentityScope('account-a');
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        mount();
        let boot!: Promise<void>;
        act(() => {
            boot = current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        await act(async () => {
            world.initial = report('Account B port', -20.2, 148.7);
            world.settings = { ...world.settings, defaultLocation: 'Account B port' };
            setAuthIdentityScope('account-b');
        });
        await act(async () => {
            pending.resolve({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
            await boot;
        });

        expect(current.weatherData?.locationName).toBe('Account B port');
        expect(world.settings.defaultLocation).toBe('Account B port');
        expect(current.positionSource).toBeNull();
        expect(world.cancel).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('keeps the saved report during a boot probe and preserves a favourite picked before it returns', async () => {
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        mount();
        const savedReport = current.weatherData;
        let boot!: Promise<void>;
        act(() => {
            boot = current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });
        expect(current.weatherData).toBe(savedReport);
        expect(world.settings.defaultLocation).toBe('Initial port');
        expect(current.positionSource).toBeNull();

        await act(async () => {
            current.setHistoryCache({ Newport: report('Newport', -27.2, 153.08) });
        });
        await act(async () => {
            await current.selectLocation('Newport', { lat: -27.2, lon: 153.08 });
        });
        await act(async () => {
            pending.resolve({ latitude: -20.2, longitude: 148.7, timestamp: Date.now() });
            await boot;
        });

        expect(current.weatherData?.locationName).toBe('Newport');
        expect(world.settings.defaultLocation).toBe('Newport');
        expect(current.positionSource).toBeNull();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('discards a passive boot phone fix after the selected receiver changes', async () => {
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        mount();
        const savedReport = current.weatherData;
        let boot!: Promise<void>;
        act(() => {
            boot = current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });

        await act(async () => {
            setWeatherFollowTarget('boat');
            pending.resolve({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
            await boot;
        });

        expect(current.weatherData).toBe(savedReport);
        expect(world.settings.defaultLocation).toBe('Initial port');
        expect(current.positionSource).toBeNull();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('a delayed boot continuation cannot replace an explicit favourite', async () => {
        mount();
        await act(async () => {
            current.setHistoryCache({ Newport: report('Newport', -27.2, 153.08) });
        });
        await act(async () => {
            await current.selectLocation('Newport', { lat: -27.2, lon: 153.08 });
        });
        await act(async () => {
            await current.selectLocation('Current Location', undefined, { onlyIfUnselected: true });
        });
        expect(current.weatherData?.locationName).toBe('Newport');
        expect(world.gps).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });
    it('a delayed phone fix cannot overwrite a newer cached favourite', async () => {
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        mount();
        await act(async () => {
            current.setHistoryCache({ Newport: report('Newport', -27.2, 153.08) });
        });
        let first!: Promise<void>;
        act(() => {
            first = current.selectLocation('Current Location');
        });
        await act(async () => {
            await current.selectLocation('Newport', { lat: -27.2, lon: 153.08 });
        });
        expect(current.weatherData?.locationName).toBe('Newport');
        await act(async () => {
            pending.resolve({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
            await first;
        });
        expect(current.weatherData?.locationName).toBe('Newport');
        expect(current.positionSource).toBeNull();
        expect(world.fetch).not.toHaveBeenCalled();
        expect(world.cancel).toHaveBeenCalledTimes(2);
    });

    it('switching boat to phone fences a slower boat fix even though both say Current Location', async () => {
        const pending = deferred<unknown>();
        world.boat.mockReturnValue(pending.promise);
        world.gps.mockResolvedValue({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
        mount();
        let first!: Promise<void>;
        act(() => {
            setWeatherFollowTarget('boat');
            first = current.selectLocation('Current Location');
        });
        await act(async () => {
            setWeatherFollowTarget('phone');
            await current.selectLocation('Current Location');
        });
        const phoneCoordinates = current.weatherData?.coordinates;
        await act(async () => {
            pending.resolve({ lat: -20.2, lon: 148.7, timestamp: Date.now() });
            await first;
        });
        expect(current.weatherData?.coordinates).toEqual(phoneCoordinates);
        expect(current.positionSource).toMatchObject({ kind: 'phone', target: 'phone' });
        expect(world.fetch.mock.calls.every(([, options]) => options.coords.lat === -27.21)).toBe(true);
    });

    it('an unavailable selected phone clears the previous place rather than falling back to it', async () => {
        mount();
        await act(async () => {
            await current.selectLocation('Current Location');
        });
        expect(current.weatherData).toBeNull();
        expect(current.error).toBe('Phone GPS unavailable');
        expect(current.positionSource).toMatchObject({ kind: null, target: 'phone', status: 'unavailable' });
        expect(current.loading).toBe(false);
        expect(world.boat).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'failed'])(
        'retains proven same-phone weather through a %s follower read and recovers',
        async (outcome) => {
            vi.useFakeTimers();
            const { saved, fixTimestamp } = await establishPhoneFollow();
            world.fetch.mockClear();
            if (outcome === 'failed') world.gps.mockRejectedValue(new Error('Temporary GPS acquisition failure'));
            else world.gps.mockResolvedValue(null);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });
            expect(current.weatherData).toBe(saved);
            expect(current.weatherData?.coordinates).toEqual(saved.coordinates);
            expect(current.weatherData?.generatedAt).toBe(saved.generatedAt);
            expect(current.error).toBeNull();
            expect(current.positionSource).toMatchObject({
                kind: 'phone',
                target: 'phone',
                status: 'unavailable',
                timestamp: fixTimestamp,
                retainedWeather: true,
            });
            expect(world.boat).not.toHaveBeenCalled();
            expect(world.requestGps).not.toHaveBeenCalled();
            expect(world.fetch).not.toHaveBeenCalled();

            world.gps.mockImplementation(async () => ({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });
            expect(current.positionSource).toMatchObject({ kind: 'phone', target: 'phone', status: 'live' });
            expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
            expect(current.error).toBeNull();
            expect(current.weatherData?.coordinates).toEqual(saved.coordinates);
        },
    );

    it('keeps an established phone report while manual refresh awaits GPS and after a null result', async () => {
        vi.useFakeTimers();
        const { saved, fixTimestamp } = await establishPhoneFollow();
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        world.fetch.mockClear();
        await act(async () => {
            current.refreshData(true);
        });
        expect(current.weatherData).toBe(saved);
        expect(current.error).toBeNull();
        await act(async () => {
            pending.resolve(null);
        });
        expect(current.weatherData).toBe(saved);
        expect(current.weatherData?.generatedAt).toBe(saved.generatedAt);
        expect(current.error).toBeNull();
        expect(current.positionSource).toMatchObject({
            kind: 'phone',
            target: 'phone',
            status: 'unavailable',
            timestamp: fixTimestamp,
            retainedWeather: true,
        });
        expect(world.fetch).not.toHaveBeenCalled();
        expect(world.requestGps).not.toHaveBeenCalled();
    });

    it('does not treat an unproven startup cache as a successful same-phone fix', async () => {
        vi.useFakeTimers();
        world.settings.defaultLocation = 'Current Location';
        world.initial = report('Unverified cached port', -33.86, 151.2);
        await act(async () => {
            mount();
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.error).toBe('Phone GPS unavailable');
        expect(current.positionSource).toMatchObject({ kind: null, target: 'phone', status: 'unavailable' });
        expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
        expect(world.requestGps).not.toHaveBeenCalled();
    });

    it('does not grant retained-weather status to a report whose coordinates differ from the proven phone fix', async () => {
        vi.useFakeTimers();
        await establishPhoneFollow();
        await act(async () => {
            await current.fetchWeather('Different point', false, { lat: -20.2, lon: 148.7 });
        });
        world.gps.mockResolvedValue(null);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.error).toBe('Phone GPS unavailable');
        expect(current.positionSource).toMatchObject({ kind: null, target: 'phone', status: 'unavailable' });
        expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
    });

    it('does not retain an unfinished loading placeholder as a forecast after GPS acquisition fails', async () => {
        vi.useFakeTimers();
        world.initial = { ...report('Loading...'), loading: true, modelUsed: 'Loading...' };
        await establishPhoneFollow();
        expect(current.weatherData).toMatchObject({ loading: true });
        world.gps.mockResolvedValue(null);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.error).toBe('Phone GPS unavailable');
        expect(current.positionSource).toMatchObject({ kind: null, target: 'phone', status: 'unavailable' });
        expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
    });

    it('retains the same local forecast after a genuine 200-metre phone drift followed by an acquisition miss', async () => {
        vi.useFakeTimers();
        const { saved } = await establishPhoneFollow();
        world.gps.mockImplementation(async () => ({ latitude: -27.2118, longitude: 153.1, timestamp: Date.now() }));
        world.fetch.mockClear();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        const lastFixAt = Date.now();
        expect(current.weatherData).toBe(saved);
        expect(current.weatherData?.coordinates).toEqual({ lat: -27.21, lon: 153.1 });
        world.gps.mockResolvedValue(null);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.weatherData).toBe(saved);
        expect(current.weatherData?.generatedAt).toBe(saved.generatedAt);
        expect(current.error).toBeNull();
        expect(current.positionSource).toMatchObject({
            kind: 'phone',
            target: 'phone',
            status: 'unavailable',
            retainedWeather: true,
            timestamp: lastFixAt,
        });
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('does not retain the old forecast as same-place weather after the phone is genuinely far away', async () => {
        vi.useFakeTimers();
        const { saved } = await establishPhoneFollow();
        useUIStore.setState({ isOffline: true });
        world.gps.mockImplementation(async () => ({
            latitude: -20.2,
            longitude: 148.7,
            timestamp: Date.now(),
        }));
        world.fetch.mockClear();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.weatherData?.coordinates).toEqual(saved.coordinates);
        world.gps.mockResolvedValue(null);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.error).toBe('Phone GPS unavailable');
        expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('keeps a persistent outage visibly unavailable without pretending the fix or report refreshed', async () => {
        vi.useFakeTimers();
        const { saved, fixTimestamp } = await establishPhoneFollow();
        world.gps.mockResolvedValue(null);
        world.fetch.mockClear();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3 * 60_000);
        });
        expect(current.weatherData).toBe(saved);
        expect(current.weatherData?.generatedAt).toBe(saved.generatedAt);
        expect(current.positionSource).toMatchObject({
            kind: 'phone',
            target: 'phone',
            status: 'unavailable',
            timestamp: fixTimestamp,
            retainedWeather: true,
        });
        expect(current.error).toBeNull();
        expect(world.requestGps).not.toHaveBeenCalled();
        expect(world.fetch).not.toHaveBeenCalled();
        expect(world.boat).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'recovered'])(
        'a pending same-phone refresh cannot overwrite a favourite when it later becomes %s',
        async (outcome) => {
            vi.useFakeTimers();
            await establishPhoneFollow();
            const pending = deferred<unknown>();
            world.gps.mockReturnValue(pending.promise);
            await act(async () => {
                current.refreshData(true);
                current.setHistoryCache({ Mackay: report('Mackay', -21.1, 149.2) });
            });
            await act(async () => {
                await current.selectLocation('Mackay', { lat: -21.1, lon: 149.2 });
            });
            const selected = current.weatherData;
            await act(async () => {
                pending.resolve(
                    outcome === 'recovered' ? { latitude: -27.21, longitude: 153.1, timestamp: Date.now() } : null,
                );
            });
            expect(current.weatherData).toBe(selected);
            expect(current.weatherData?.locationName).toBe('Mackay');
            expect(current.positionSource).toBeNull();
            expect(current.error).toBeNull();
        },
    );

    it('does not retain phone weather for an unavailable boat even though both selections say Current Location', async () => {
        vi.useFakeTimers();
        await establishPhoneFollow();
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        await act(async () => {
            current.refreshData(true);
        });
        await act(async () => {
            setWeatherFollowTarget('boat');
            await current.selectLocation('Current Location');
        });
        await act(async () => {
            pending.resolve({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
        });
        expect(current.weatherData).toBeNull();
        expect(current.positionSource).toMatchObject({ kind: null, target: 'boat', status: 'unavailable' });
        expect(current.positionSource).not.toMatchObject({ retainedWeather: true });
        expect(current.error).toBe('Boat GPS unavailable');
    });

    it('clears retained phone weather across accounts and ignores a late recovery from the old account', async () => {
        vi.useFakeTimers();
        setAuthIdentityScope('account-a');
        await establishPhoneFollow();
        world.gps.mockResolvedValue(null);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.positionSource).toMatchObject({ retainedWeather: true });
        const pending = deferred<unknown>();
        world.gps.mockReturnValue(pending.promise);
        await act(async () => {
            current.refreshData(true);
        });
        await act(async () => {
            world.initial = null;
            world.settings = { ...world.settings, defaultLocation: 'Account B port' };
            setAuthIdentityScope('account-b');
        });
        expect(current.weatherData).toBeNull();
        expect(current.positionSource).toBeNull();
        await act(async () => {
            pending.resolve({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
        });
        expect(current.weatherData).toBeNull();
        expect(current.positionSource).toBeNull();
        expect(current.error).toBeNull();
    });

    it('manual refresh in vessel mode resolves the boat, never the phone', async () => {
        world.boat.mockResolvedValue({ lat: -20.2, lon: 148.7, timestamp: Date.now() });
        mount();
        await act(async () => {
            setWeatherFollowTarget('boat');
            await current.selectLocation('Current Location');
        });
        world.fetch.mockClear();
        await act(async () => {
            current.refreshData(true);
        });
        expect(world.fetch).toHaveBeenLastCalledWith(
            'Current Location',
            expect.objectContaining({ coords: { lat: -20.2, lon: 148.7 } }),
        );
        expect(world.gps).not.toHaveBeenCalled();
        expect(world.requestGps).not.toHaveBeenCalled();
    });

    it('only an explicit phone permission option requests foreground permission', async () => {
        world.requestGps.mockResolvedValue({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
        world.gps.mockResolvedValue({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() });
        mount();
        await act(async () => {
            await current.selectLocation('Current Location', undefined, { requestPhonePermission: true });
        });
        expect(world.requestGps).toHaveBeenCalledTimes(1);
        expect(current.positionSource?.kind).toBe('phone');
    });

    it('repairs a stale suburb even when the report already adopted the new coordinates', async () => {
        world.settings.defaultLocation = 'Current Location';
        world.initial = report('Scarborough', -27.2, 153.08);
        world.gps.mockResolvedValue({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
        mount();
        await waitFor(() => expect(current.weatherData?.locationName).toBe('Newport'));
        expect(world.reverse).toHaveBeenCalledWith(-27.2, 153.08);
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('a delayed follower name cannot overwrite a manually selected port', async () => {
        const pending = deferred<string>();
        world.settings.defaultLocation = 'Current Location';
        world.initial = report('Scarborough');
        world.gps.mockResolvedValue({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
        world.reverse.mockReturnValue(pending.promise);
        mount();
        await waitFor(() => expect(world.reverse).toHaveBeenCalled());
        await act(async () => {
            current.setHistoryCache({ Mackay: report('Mackay', -21.1, 149.2) });
        });
        await act(async () => {
            await current.selectLocation('Mackay', { lat: -21.1, lon: 149.2 });
        });
        await act(async () => {
            pending.resolve('Newport');
        });
        expect(current.weatherData?.locationName).toBe('Mackay');
        expect(current.positionSource).toBeNull();
    });

    it('allows a geocoder taking longer than one polling interval to complete', async () => {
        vi.useFakeTimers();
        const pending = deferred<string>();
        world.settings.defaultLocation = 'Current Location';
        world.initial = report('Scarborough');
        world.gps.mockResolvedValue({ latitude: -27.2, longitude: 153.08, timestamp: Date.now() });
        world.reverse.mockReturnValue(pending.promise);
        mount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(11_000);
        });
        expect(world.reverse).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve('Newport');
        });
        expect(current.weatherData?.locationName).toBe('Newport');
    });

    it('a delayed settings restore cannot override a selected but unavailable vessel', async () => {
        world.initial = null;
        mount();
        await act(async () => {
            setWeatherFollowTarget('boat');
            await current.selectLocation('Current Location');
        });
        await act(async () => {
            window.dispatchEvent(
                new CustomEvent('thalassa:settings-restored', {
                    detail: {
                        defaultLocation: 'Current Location',
                        defaultLocationCoords: { lat: -27.2, lon: 153.08 },
                    },
                }),
            );
        });
        expect(current.weatherData).toBeNull();
        expect(current.error).toBe('Boat GPS unavailable');
        expect(world.fetch).not.toHaveBeenCalled();
        expect(world.gps).not.toHaveBeenCalled();
    });

    it('a first settings restore resolves the selected boat instead of trusting saved phone coordinates', async () => {
        world.initial = null;
        world.target = 'boat';
        world.boat.mockResolvedValue({ lat: -20.2, lon: 148.7, timestamp: Date.now() });
        mount();
        await act(async () => {
            window.dispatchEvent(
                new CustomEvent('thalassa:settings-restored', {
                    detail: {
                        defaultLocation: 'Current Location',
                        defaultLocationCoords: { lat: -27.2, lon: 153.08 },
                    },
                }),
            );
        });
        expect(world.fetch).toHaveBeenLastCalledWith(
            'Current Location',
            expect.objectContaining({ coords: { lat: -20.2, lon: 148.7 } }),
        );
        expect(world.gps).not.toHaveBeenCalled();
    });

    it('retries a failed name lookup after a minute without weather refetch or a 5-second geocoder loop', async () => {
        vi.useFakeTimers();
        world.settings.defaultLocation = 'Current Location';
        world.gps.mockImplementation(async () => ({ latitude: -27.21, longitude: 153.1, timestamp: Date.now() }));
        world.reverse.mockRejectedValueOnce(new Error('Geocoder offline')).mockResolvedValue('Newport');
        await act(async () => {
            mount();
        });
        expect(current.weatherData?.locationName).toContain('27.2100°S');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(55_000);
        });
        expect(world.reverse).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(current.weatherData?.locationName).toBe('Newport');
        expect(world.reverse).toHaveBeenCalledTimes(2);
        expect(world.fetch).not.toHaveBeenCalled();
    });

    it('accepts a tide result slower than a follow tick and advances its station only on success', async () => {
        vi.useFakeTimers();
        const pending = deferred<unknown>();
        world.settings.defaultLocation = 'Current Location';
        world.gps.mockImplementation(async () => ({ latitude: -27.28, longitude: 153.1, timestamp: Date.now() }));
        world.tides.mockReturnValue(pending.promise);
        await act(async () => {
            mount();
        });
        expect(world.tides).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(world.tides).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve({
                tides: [{ height: 1.2 }],
                tideHourly: [],
                tideGUIDetails: { stationName: 'New station' },
            });
        });
        expect(current.weatherData?.tides).toEqual([{ height: 1.2 }]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(world.tides).toHaveBeenCalledTimes(1);
    });
});
