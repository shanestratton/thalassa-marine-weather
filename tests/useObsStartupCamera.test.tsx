import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
    followKey: 'phone',
}));

vi.mock('../services/weatherPosition', () => ({ getWeatherFollowKey: () => dependencies.followKey }));

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

import {
    OBS_START_VESSEL,
    OBS_VESSEL_ZOOM,
    obsStartTarget,
    useObsStartupCamera,
    type ObsStartTarget,
} from '../components/map/useObsStartupCamera';
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
    dependencies.followKey = 'phone';
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
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
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
            expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [153.1, -27.5], zoom: 14 });
        },
    );

    it('takes a fresh store fix after the passive lookup has returned no position', async () => {
        const { map } = mountStartup();
        await act(async () => {});
        dependencies.location = { ...VESSEL, source: 'gps', timestamp: NOW };
        act(() => dependencies.locationListeners.forEach((listener) => listener()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('uses NMEA that arrives while a phone lookup is pending', async () => {
        const resolve = deferGps();
        const { map } = mountStartup();
        nmeaFix();
        // Even before the NMEA notification is delivered, resolution rechecks
        // the arbiter and cannot centre on the pending phone result.
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('centres immediately when NMEA publishes and ignores a later phone response', async () => {
        const resolve = deferGps();
        const { map } = mountStartup();
        nmeaFix();
        act(() => dependencies.nmeaListeners.forEach((listener) => listener()));
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
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
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
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
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
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

// Fictional coordinates for a chosen place far from the boat ("if i put
// hawaii in the glass page, when i go to the obs page, it should show me that
// location from the get go", Shane 2026-10-06).
const HAWAII = { lat: 21.3, lon: -157.85 };
const SUVA = { lat: -18.14, lon: 178.44 };
const hawaii = (): ObsStartTarget => obsStartTarget({ defaultLocation: 'Hawaii', defaultLocationCoords: HAWAII });
const suva = (): ObsStartTarget => obsStartTarget({ defaultLocation: 'Suva', defaultLocationCoords: SUVA });

function mountBox(target: ObsStartTarget, ready = true, enabled = true) {
    const map = new maps.FakeMap();
    const props = { mapRef: { current: map as unknown as mapboxgl.Map | null }, ready, enabled, target };
    const view = renderHook(
        ({ mapRef, ready, enabled, target }) => useObsStartupCamera(mapRef, ready, enabled, target),
        { initialProps: props },
    );
    return { ...view, map, props };
}

describe('reading the location box', () => {
    it.each([undefined, null, '', 'Current Location'])('follows the vessel for %j', (defaultLocation) => {
        expect(obsStartTarget({ defaultLocation, weatherCoords: WEATHER })).toEqual(OBS_START_VESSEL);
    });

    it('takes a chosen place from its saved coordinates, keyed on the choice', () => {
        const target = obsStartTarget({
            defaultLocation: 'Hawaii',
            defaultLocationCoords: HAWAII,
            weatherCoords: { lat: 21.31, lon: -157.86 },
        });
        expect(target).toEqual({ kind: 'place', key: 'place:Hawaii@21.3000,-157.8500', center: HAWAII });
    });

    it('fills a name-only choice from the report, and the key survives the report refining', () => {
        const first = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: { lat: 0, lon: 0 } });
        expect(first).toEqual({ kind: 'place', key: 'place:Hawaii', center: null });
        const resolved = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII });
        expect(resolved).toEqual({ kind: 'place', key: 'place:Hawaii', center: HAWAII });
    });
});

describe('OBS opens where the location box points', () => {
    it('opens a chosen place at z10 at once, with no boat hop and no ownship lookup', () => {
        nmeaFix(); // the boat is live and somewhere else entirely
        const { map } = mountBox(hawaii(), false);
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        // The place moves the camera only: ownship is not read, subscribed or
        // refreshed, so it cannot be mistaken for (or replaced by) the vessel.
        expect(dependencies.gps).not.toHaveBeenCalled();
        expect(dependencies.foregroundGps).not.toHaveBeenCalled();
        expect(dependencies.nmeaListeners.size).toBe(0);
        expect(dependencies.locationListeners.size).toBe(0);
    });

    it('still opens on the vessel at z14 while the box follows the boat', () => {
        nmeaFix();
        dependencies.followKey = 'boat';
        const { map } = mountBox(OBS_START_VESSEL);
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('waits for a name-only place to resolve rather than hopping via the boat', () => {
        nmeaFix();
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null });
        const { map, rerender, props } = mountBox(pending);
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(dependencies.gps).not.toHaveBeenCalled();
        rerender({ ...props, target: obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII }) });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it('lets a gesture win while a name-only place resolves', () => {
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null });
        const { map, rerender, props } = mountBox(pending);
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        rerender({ ...props, target: obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII }) });
        expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it('opens a name-only place on the next visit when it resolves while Obs is hidden', () => {
        // A typed Glass search resolves in about 0.4-2.7 s (never, offline).
        // Leaving Obs before it lands is not the skipper taking over the
        // camera, so the next visit opens on the place.
        nmeaFix();
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: { lat: 0, lon: 0 } });
        const { map, rerender, props } = mountBox(pending);
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, enabled: false });
        const resolved = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII });
        rerender({ ...props, enabled: false, target: resolved });
        expect(map.jumpTo).not.toHaveBeenCalled(); // nothing while Obs is hidden
        rerender({ ...props, enabled: true, target: resolved });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it.each([
        ['a chosen place', hawaii],
        ['the vessel', () => OBS_START_VESSEL],
    ] as const)('keeps the skipper’s view on a revisit when the box has not changed (%s)', (_label, target) => {
        nmeaFix();
        const { map, rerender, props } = mountBox(target());
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, enabled: false });
        rerender({ ...props, target: target(), enabled: true });
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
    });

    it('recentres on the next visit after the box changes, place to place and place to vessel', () => {
        nmeaFix();
        const { map, rerender, props } = mountBox(hawaii());
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        rerender({ ...props, enabled: false });
        rerender({ ...props, enabled: false, target: suva() });
        expect(map.jumpTo).toHaveBeenCalledTimes(1); // nothing while Obs is hidden
        rerender({ ...props, enabled: true, target: suva() });
        expect(map.jumpTo).toHaveBeenCalledTimes(2);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [SUVA.lon, SUVA.lat], zoom: 10 });
        rerender({ ...props, enabled: false, target: suva() });
        rerender({ ...props, enabled: false, target: OBS_START_VESSEL });
        rerender({ ...props, enabled: true, target: OBS_START_VESSEL });
        expect(map.jumpTo).toHaveBeenCalledTimes(3);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('treats a new follow target as a new box', () => {
        nmeaFix();
        const { map, rerender, props } = mountBox(OBS_START_VESSEL);
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, enabled: false });
        dependencies.followKey = 'boat';
        rerender({ ...props, enabled: true });
        expect(map.jumpTo).toHaveBeenCalledTimes(2);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('waits for the next visit when the box changes while Obs is on screen', () => {
        const { map, rerender, props } = mountBox(hawaii());
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, target: suva() });
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, target: suva(), enabled: false });
        rerender({ ...props, target: suva(), enabled: true });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [SUVA.lon, SUVA.lat], zoom: 10 });
    });

    it('leaves find-boat flying to the vessel at z14, never to the chosen place', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(OBS_VESSEL_ZOOM).toBe(14);
        expect(hub).toContain('const LOCATE_BOAT_ZOOM = OBS_VESSEL_ZOOM;');
        const locate = hub.slice(hub.indexOf('onLocateMe={() => {'), hub.indexOf('onRecenter={() => {'));
        expect(locate).toContain('resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState())');
        expect(locate.match(/zoom: LOCATE_BOAT_ZOOM/g)).toHaveLength(2);
        expect(locate).not.toContain('obsStart');
        expect(locate).not.toContain('weatherCoords');
    });

    it('follows the box when it moves before the camera has settled', async () => {
        // Boot order: the vessel centring is still waiting for a fix when the
        // saved place arrives. The place wins, and the late fix cannot undo it.
        const resolve = deferGps();
        const { map, rerender, props } = mountBox(OBS_START_VESSEL);
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, target: hawaii() });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        await act(async () => resolve(phoneFix()));
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
    });
});

describe('Mapbox initial camera policy', () => {
    function mountMap(ownshipStartup: boolean, embedded = false, obsStart?: ObsStartTarget) {
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
                    obsStart,
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
        expect(maps.instances[0].options).toMatchObject({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        rerender({ initialCenter: { lat: -41, lon: 174 } });
        expect(maps.instances).toHaveLength(1);
        expect(maps.instances[0].remove).not.toHaveBeenCalled();
    });

    it('uses the broad fallback when OBS has only selected weather/home coordinates', () => {
        mountMap(true);
        expect(maps.instances[0].options.center).toEqual([145, -28]);
        expect(maps.instances[0].options.zoom).toBeLessThan(5);
    });

    it('constructs OBS on a place chosen in the location box at z10, not on the boat', () => {
        nmeaFix();
        mountMap(true, false, hawaii());
        expect(maps.instances[0].options).toMatchObject({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it('opens broad rather than on the boat while a name-only place resolves', () => {
        nmeaFix();
        mountMap(true, false, obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null }));
        expect(maps.instances[0].options.center).toEqual([145, -28]);
    });

    it('keeps a Plan/picker map off the Obs place start', () => {
        nmeaFix();
        mountMap(false, false, hawaii());
        expect(maps.instances[0].options).toMatchObject({ center: [WEATHER.lon, WEATHER.lat], zoom: 10 });
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
