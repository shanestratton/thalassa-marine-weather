import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { GpsPosition } from '../services/GpsService';
import type { OwnshipNavigationInput } from '../services/ownshipPosition';

const dependencies = vi.hoisted(() => ({
    nmea: {} as OwnshipNavigationInput,
    location: { lat: -27.47, lon: 153.02, source: 'initial', timestamp: 0 },
    nmeaListeners: new Set<() => void>(),
    locationListeners: new Set<() => void>(),
    gps: vi.fn(),
    foregroundGps: vi.fn(),
    backgroundGps: vi.fn(),
}));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => dependencies.nmea,
        subscribe: (listener: () => void) => {
            dependencies.nmeaListeners.add(listener);
            return () => dependencies.nmeaListeners.delete(listener);
        },
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => dependencies.location,
        subscribe: (listener: () => void) => {
            dependencies.locationListeners.add(listener);
            return () => dependencies.locationListeners.delete(listener);
        },
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPositionIfGranted: dependencies.gps,
        requestCurrentForegroundPosition: dependencies.foregroundGps,
        getCurrentPosition: dependencies.backgroundGps,
    },
}));
vi.mock('../services/memoryCensus', () => ({ registerCensusMap: vi.fn(), registerCensusProbe: vi.fn() }));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
vi.mock('../components/map/encPrewarmLifecycle', () => ({ deferEncPrewarm: () => vi.fn() }));
vi.mock('../components/map/paneAwareAttribution', () => ({ installPaneAwareAttribution: () => vi.fn() }));
vi.mock('../components/map/zombieMapGuard', () => ({ armZombieMapGuards: vi.fn() }));

const maps = vi.hoisted(() => {
    class FakeMap {
        listeners = new Map<string, Set<(event?: unknown) => void>>();
        touchZoomRotate = { disableRotation: vi.fn() };
        jumpTo = vi.fn();
        addControl = vi.fn();
        remove = vi.fn();
        on = vi.fn((name: string, listener: (event?: unknown) => void) => {
            const listeners = this.listeners.get(name) ?? new Set();
            listeners.add(listener);
            this.listeners.set(name, listeners);
            return this;
        });
        off = vi.fn((name: string, listener: (event?: unknown) => void) => {
            this.listeners.get(name)?.delete(listener);
            return this;
        });
        once = vi.fn();
        constructor(public options: Record<string, unknown> = {}) {
            instances.push(this);
        }
        emit(name: string, event?: unknown) {
            this.listeners.get(name)?.forEach((listener) => listener(event));
        }
    }
    const instances: FakeMap[] = [];
    return { FakeMap, instances };
});

vi.mock('mapbox-gl', () => ({ default: { Map: maps.FakeMap, ScaleControl: class {} } }));

import { useObsStartupCamera } from '../components/map/useObsStartupCamera';
import { useMapInit } from '../components/map/useMapInit';

const NOW = Date.parse('2026-09-23T00:00:00.000Z');
const VESSEL = { lat: -23.9, lon: 152.4 };
const WEATHER = { lat: -33.86, lon: 151.2 };

function nmeaFix() {
    dependencies.nmea = {
        latitude: { value: VESSEL.lat, lastUpdated: NOW, freshness: 'live' },
        longitude: { value: VESSEL.lon, lastUpdated: NOW, freshness: 'live' },
    };
}

function phoneFix(overrides: Partial<GpsPosition> = {}): GpsPosition {
    return {
        latitude: -27.5,
        longitude: 153.1,
        accuracy: 5,
        altitude: null,
        heading: null,
        speed: 0,
        timestamp: NOW,
        ...overrides,
    };
}

function deferGps() {
    let resolve!: (position: GpsPosition | null) => void;
    dependencies.gps.mockReturnValueOnce(new Promise<GpsPosition | null>((done) => (resolve = done)));
    return resolve;
}

function mountStartup(ready = true, enabled = true) {
    const map = new maps.FakeMap();
    const props = { mapRef: { current: map as unknown as mapboxgl.Map | null }, ready, enabled };
    const view = renderHook(({ mapRef, ready, enabled }) => useObsStartupCamera(mapRef, ready, enabled), {
        initialProps: props,
    });
    return { ...view, map, props };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    maps.instances.length = 0;
    dependencies.nmea = {};
    dependencies.location = { lat: -27.47, lon: 153.02, source: 'initial', timestamp: NOW };
    dependencies.nmeaListeners.clear();
    dependencies.locationListeners.clear();
    dependencies.gps.mockResolvedValue(null);
});

afterEach(async () => {
    cleanup();
    // Let the shared passive request settle before the next test.
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
});

describe('OBS startup camera', () => {
    it('centres on cached vessel NMEA ahead of a fresh phone position, exactly once', () => {
        nmeaFix();
        dependencies.location = { lat: -27.5, lon: 153.1, source: 'gps', timestamp: NOW };
        const { map, rerender, props } = mountStartup();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
        dependencies.location = { ...WEATHER, source: 'favorite', timestamp: NOW };
        act(() => dependencies.locationListeners.forEach((listener) => listener()));
        rerender({ ...props });
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        expect(dependencies.gps).not.toHaveBeenCalled();
        expect(dependencies.nmeaListeners.size).toBe(0);
        expect(dependencies.locationListeners.size).toBe(0);
    });

    it.each(['initial', 'search', 'favorite', 'map_pin'])(
        'waits for a real fix instead of centring on %s coordinates',
        async (source) => {
            dependencies.location = { ...WEATHER, source, timestamp: NOW };
            const resolve = deferGps();
            const { map } = mountStartup();
            expect(map.jumpTo).not.toHaveBeenCalled();
            expect(dependencies.gps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
            expect(dependencies.foregroundGps).not.toHaveBeenCalled();
            expect(dependencies.backgroundGps).not.toHaveBeenCalled();
            dependencies.location = { lat: -41, lon: 174, source: 'search', timestamp: NOW };
            act(() => dependencies.locationListeners.forEach((listener) => listener()));
            expect(map.jumpTo).not.toHaveBeenCalled();
            await act(async () => resolve(phoneFix()));
            expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [153.1, -27.5], zoom: 10 });
        },
    );

    it('takes a fresh store fix after the passive lookup has returned no position', async () => {
        const { map } = mountStartup();
        await act(async () => {});
        dependencies.location = { ...VESSEL, source: 'gps', timestamp: NOW };
        act(() => dependencies.locationListeners.forEach((listener) => listener()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
    });

    it('uses NMEA that arrives while a phone lookup is pending', async () => {
        const resolve = deferGps();
        const { map } = mountStartup();
        nmeaFix();
        // Even before the NMEA notification is delivered, resolution rechecks
        // the arbiter and cannot centre on the pending phone result.
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
    });

    it('centres immediately when NMEA publishes and ignores a later phone response', async () => {
        const resolve = deferGps();
        const { map } = mountStartup();
        nmeaFix();
        act(() => dependencies.nmeaListeners.forEach((listener) => listener()));
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
    });

    it.each([{ timestamp: NOW - 30_001 }, { timestamp: NOW + 5_001 }, { latitude: 91 }, { longitude: Number.NaN }])(
        'rejects an unusable asynchronous fix: %j',
        async (overrides) => {
            const resolve = deferGps();
            const { map } = mountStartup();
            await act(async () => resolve(phoneFix(overrides)));
            expect(map.jumpTo).not.toHaveBeenCalled();
        },
    );

    it.each(['movestart', 'zoomstart', 'dragstart'])(
        'preserves a user %s while a GPS request is pending',
        async (event) => {
            const resolve = deferGps();
            const { map } = mountStartup();
            act(() => map.emit(event, { originalEvent: new Event('pointermove') }));
            await act(async () => resolve(phoneFix()));
            expect(map.jumpTo).not.toHaveBeenCalled();
            expect(dependencies.nmeaListeners.size).toBe(0);
            expect(dependencies.locationListeners.size).toBe(0);
        },
    );

    it('also respects a gesture before the map becomes ready', () => {
        const { map, rerender, props } = mountStartup(false);
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        nmeaFix();
        rerender({ ...props, ready: true });
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(dependencies.gps).not.toHaveBeenCalled();
    });

    it('waits for map readiness without treating a programmatic move as a gesture', () => {
        const { map, rerender, props } = mountStartup(false);
        nmeaFix();
        act(() => map.emit('movestart', {}));
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, ready: true });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
    });

    it('cancels when leaving OBS and does not resume after returning', async () => {
        const resolve = deferGps();
        const { map, rerender, props } = mountStartup();
        rerender({ ...props, enabled: false });
        await act(async () => resolve(phoneFix()));
        nmeaFix();
        rerender(props);
        expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it('does nothing on an initially inactive planning/picker/pin surface', () => {
        nmeaFix();
        const { map, rerender, props } = mountStartup(true, false);
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(map.on).not.toHaveBeenCalled();
        expect(dependencies.gps).not.toHaveBeenCalled();
        rerender({ ...props, enabled: true });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
    });

    it.each(['unmount', 'replace'] as const)('ignores a pending response after map %s', async (change) => {
        const resolve = deferGps();
        const { map, unmount, props } = mountStartup();
        if (change === 'unmount') unmount();
        else props.mapRef.current = new maps.FakeMap() as unknown as mapboxgl.Map;
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).not.toHaveBeenCalled();
    });
});

describe('Mapbox initial camera policy', () => {
    function mountMap(ownshipStartup: boolean, embedded = false) {
        const container = document.createElement('div');
        Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 800 } });
        return renderHook(
            ({ initialCenter }) =>
                useMapInit({
                    containerRef: { current: container },
                    mapRef,
                    pinMarkerRef: { current: null },
                    locationDotRef: { current: null },
                    mapboxToken: 'test-token',
                    mapStyle: 'mapbox://styles/mapbox/dark-v11',
                    initialZoom: 5,
                    minimalLabels: false,
                    embedded,
                    ownshipStartup,
                    location: dependencies.location,
                    initialCenter,
                    encVisible: false,
                    settingPoint: null,
                    showPassage: false,
                    departure: null,
                    arrival: null,
                    setMapReady: vi.fn(),
                    setActiveLayer: vi.fn(),
                    setDeparture: vi.fn(),
                    setArrival: vi.fn(),
                    setSettingPoint: vi.fn(),
                }),
            { initialProps: { initialCenter: WEATHER } },
        );
    }
    let mapRef: { current: mapboxgl.Map | null };
    beforeEach(() => {
        mapRef = { current: null };
    });

    it('constructs OBS at the cached vessel and never rebuilds for weather hydration', () => {
        nmeaFix();
        const { rerender } = mountMap(true);
        expect(maps.instances[0].options).toMatchObject({ center: [VESSEL.lon, VESSEL.lat], zoom: 10 });
        rerender({ initialCenter: { lat: -41, lon: 174 } });
        expect(maps.instances).toHaveLength(1);
        expect(maps.instances[0].remove).not.toHaveBeenCalled();
    });

    it('uses the broad fallback when OBS has only selected weather/home coordinates', () => {
        mountMap(true);
        expect(maps.instances[0].options.center).toEqual([145, -28]);
        expect(maps.instances[0].options.zoom).toBeLessThan(5);
    });

    it('preserves selected-location startup for a Plan/picker map', () => {
        nmeaFix();
        mountMap(false);
        expect(maps.instances[0].options).toMatchObject({ center: [WEATHER.lon, WEATHER.lat], zoom: 10 });
    });

    it('preserves embedded map centre and zoom', () => {
        nmeaFix();
        mountMap(false, true);
        expect(maps.instances[0].options).toMatchObject({ center: [153.02, -27.47], zoom: 5 });
    });
});
