/**
 * The chart's own map, ready to turn (127-11a): the keyboard hole closed
 * (Decision 4), an orientation turn never cancels the tracer's long press
 * (audit A10), and the opening zoom it caches is the same however the chart
 * is turned (audit A13).
 *
 * Shane 2026-05-18: "prevent the earth from rotating on the chart page".
 * Every gesture lock stays; the modes of 127-11b turn the chart themselves,
 * with `thalassaOrientation` in each turn's eventData.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { waitFor } from '@testing-library/react';
const startup = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../services/initialReliefMapStyle', () => ({ initialReliefMapStyle: startup.prepare }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event?: unknown) => void;
const world = vi.hoisted(() => ({
    maps: [] as Array<{
        handlers: Map<string, Set<Handler>>;
        options: Record<string, unknown>;
        keyboard: { disableRotation: ReturnType<typeof vi.fn> };
        touchZoomRotate: { disableRotation: ReturnType<typeof vi.fn> };
        bearing: number;
        zoom: number;
        getSource: ReturnType<typeof vi.fn>;
        isStyleLoaded: () => boolean;
        fire: (event: string, data?: Record<string, unknown>) => void;
    }>,
    resize: [] as Array<() => void>,
}));

vi.mock('../components/map/encPrewarmLifecycle', () => ({ deferEncPrewarm: () => () => {} }));
vi.mock('../services/memoryCensus', () => ({ registerCensusMap: vi.fn(), registerCensusProbe: vi.fn() }));
vi.mock('../components/map/paneAwareAttribution', () => ({ installPaneAwareAttribution: () => vi.fn() }));
vi.mock('../components/map/zombieMapGuard', () => ({ armZombieMapGuards: vi.fn() }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: {} }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../services/GpsService', () => ({ GpsService: {} }));
vi.mock('../utils/createMarkerEl', () => ({ createPinMarker: vi.fn() }));
vi.mock('../services/AvNavService', () => ({ AvNavService: {}, encryptOchartsUrl: vi.fn() }));
vi.mock('../services/MBTilesService', () => ({ MBTilesService: {} }));
vi.mock('../services/PiCacheService', () => ({ piCache: {} }));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
vi.mock('mapbox-gl', () => ({
    default: {
        Map: class {
            handlers = new Map<string, Set<Handler>>();
            touchZoomRotate = { disableRotation: vi.fn() };
            keyboard = { disableRotation: vi.fn() };
            addControl = vi.fn();
            resize = vi.fn();
            isStyleLoaded = () => false;
            getSource = vi.fn();
            bearing = 0;
            zoom = 3;
            constructor(public options: Record<string, unknown>) {
                world.maps.push(this as never);
            }
            on(event: string, callback: Handler) {
                const listeners = this.handlers.get(event) ?? new Set();
                listeners.add(callback);
                this.handlers.set(event, listeners);
            }
            once(event: string, callback: Handler) {
                const wrapped: Handler = (e) => {
                    this.handlers.get(event)?.delete(wrapped);
                    callback(e);
                };
                this.on(event, wrapped);
            }
            off(event: string, callback: Handler) {
                this.handlers.get(event)?.delete(callback);
            }
            fire(event: string, data: Record<string, unknown> = {}) {
                for (const callback of [...(this.handlers.get(event) ?? [])]) callback({ type: event, ...data });
            }
            getZoom() {
                return this.zoom;
            }
            getBearing() {
                return this.bearing;
            }
            /** Mapbox's projection: web mercator about a camera at 150°E 30°S, turned by the bearing. */
            project([lng, lat]: [number, number]) {
                const size = 512 * Math.pow(2, this.zoom);
                const merc = (lo: number, la: number) => ({
                    x: ((lo + 180) / 360) * size,
                    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) / (2 * Math.PI)) * size,
                });
                const p = merc(lng, lat);
                const c = merc(150, -30);
                const a = (-this.bearing * Math.PI) / 180;
                const dx = p.x - c.x;
                const dy = p.y - c.y;
                return { x: 195 + dx * Math.cos(a) - dy * Math.sin(a), y: 422 + dx * Math.sin(a) + dy * Math.cos(a) };
            }
            remove() {
                this.fire('remove');
            }
        },
        ScaleControl: class {},
    },
}));

import { useMapInit } from '../components/map/useMapInit';

function options(onMapLongPress = vi.fn()) {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 390 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 844 });
    return {
        containerRef: { current: container },
        mapRef: { current: null as mapboxgl.Map | null },
        pinMarkerRef: { current: null },
        locationDotRef: { current: null },
        mapboxToken: 'test-only',
        mapStyle: 'mapbox://styles/mapbox/dark-v11',
        initialZoom: 10,
        minimalLabels: false,
        embedded: false,
        location: { lat: 48.38, lon: -4.49 },
        pickerMode: false,
        settingPoint: null,
        showPassage: false,
        departure: null,
        arrival: null,
        setMapReady: vi.fn(),
        setActiveLayer: vi.fn(),
        setDeparture: vi.fn(),
        setArrival: vi.fn(),
        setSettingPoint: vi.fn(),
        encVisible: false,
        coordCapture: false,
        onMapLongPress,
    };
}

const setupResizeObserver = window.ResizeObserver;
beforeEach(() => {
    vi.clearAllMocks();
    world.maps.length = 0;
    world.resize.length = 0;
    // tests/setup.ts's never calls back; this one lets a test resize the chart.
    window.ResizeObserver = class {
        constructor(callback: () => void) {
            world.resize.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});
afterEach(() => {
    cleanup();
    window.ResizeObserver = setupResizeObserver;
    vi.useRealTimers();
});

describe('the chart can turn, and only its modes turn it', () => {
    it('does not create an abandoned chart after asynchronous terrain/style boot completes', async () => {
        vi.stubGlobal('caches', {});
        let resolve!: (style: string) => void;
        startup.prepare.mockImplementation(
            () =>
                new Promise<string>((r) => {
                    resolve = r;
                }),
        );
        try {
            const view = renderHook(() => useMapInit(options()));
            await waitFor(() => expect(startup.prepare).toHaveBeenCalledOnce());
            expect(world.maps).toHaveLength(0);
            const signal = startup.prepare.mock.calls[0][2] as AbortSignal;
            view.unmount();
            expect(signal.aborted).toBe(true);
            await act(async () => resolve('mapbox://styles/mapbox/dark-v11'));
            expect(world.maps).toHaveLength(0);
        } finally {
            vi.unstubAllGlobals();
            startup.prepare.mockReset();
        }
    });
    it('boots an inline relief style offline and maps hydrated terrain synchronously without changing charts', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const bridge = await import('../services/offlineReliefRuntime');
        const url = 'https://tiles.thalassatiles.com/v1/relief-global/idx/0/0/0.png';
        bridge.publishOfflineRelief(new Map([[url, 'capacitor://localhost/_capacitor_file_/saved-terrain.png']]));
        try {
            renderHook(() => useMapInit(options()));
            const [map] = world.maps;
            expect(map.options.style).toMatchObject({
                version: 8,
                sources: {},
                layers: [{ id: 'land', type: 'background' }],
            });
            const transform = map.options.transformRequest as (url: string, type: string) => { url: string };
            expect(transform(url, 'Tile')).toEqual({ url: 'capacitor://localhost/_capacitor_file_/saved-terrain.png' });
            expect(transform('https://api.mapbox.com/styles/v1/mapbox/dark-v11', 'Style')).toEqual({
                url: 'https://api.mapbox.com/styles/v1/mapbox/dark-v11',
            });
            const setTiles = vi.fn();
            map.getSource.mockReturnValue({ setTiles });
            expect(map.isStyleLoaded()).toBe(false);
            bridge.publishOfflineRelief(new Map([[url, 'capacitor://localhost/_capacitor_file_/saved-terrain.png']]));
            expect(setTiles).toHaveBeenCalledTimes(4);
            expect(setTiles).toHaveBeenCalledWith([
                'https://tiles.thalassatiles.com/v1/relief-global/idx/{z}/{x}/{y}.png',
            ]);
        } finally {
            online.mockRestore();
            bridge.publishOfflineRelief(new Map());
        }
    });
    it('locks the keyboard’s Shift+arrow turn beside the twist (the hole in the north-up lock)', () => {
        renderHook(() => useMapInit(options()));
        const [map] = world.maps;
        expect(map.touchZoomRotate.disableRotation).toHaveBeenCalled();
        expect(map.keyboard.disableRotation).toHaveBeenCalled();
    });

    it('never snaps a turned chart north at the end of a pan (127-11b)', () => {
        // Mapbox's bearingSnap (7° by default) swings a chart within 7° of north
        // to north at the end of every pan or pinch; Track up on 005° would be
        // snapped north by each pan and turned straight back by the mode.
        renderHook(() => useMapInit(options()));
        const [map] = world.maps;
        expect(map.options).toMatchObject({ bearingSnap: 0, dragRotate: false, pitchWithRotate: false });
    });

    it('an orientation turn does not cancel the tracer’s long press; a gesture’s rotatestart still does', () => {
        vi.useFakeTimers();
        const onMapLongPress = vi.fn();
        renderHook(() => useMapInit(options(onMapLongPress)));
        const [map] = world.maps;
        const press = () =>
            map.fire('mousedown', {
                point: { x: 120, y: 300 },
                lngLat: { lat: 48.4, lng: -4.5 },
                originalEvent: { target: document.body },
            });
        press();
        map.fire('rotatestart', { thalassaOrientation: true });
        act(() => {
            vi.advanceTimersByTime(520);
        });
        expect(onMapLongPress).toHaveBeenCalledExactlyOnceWith(48.4, -4.5);
        press();
        map.fire('rotatestart', { originalEvent: { type: 'touchmove' } });
        act(() => {
            vi.advanceTimersByTime(520);
        });
        expect(onMapLongPress).toHaveBeenCalledOnce();
    });

    it('the opening zoom it caches is the same north up and turned to 60° after a resize', () => {
        renderHook(() => useMapInit(options()));
        const [map] = world.maps;
        const opening = () => (map as unknown as { __ausNzMinZoom: number }).__ausNzMinZoom;
        map.fire('idle');
        const northUp = opening();
        expect(Number.isFinite(northUp)).toBe(true);
        map.bearing = 60;
        for (const callback of world.resize) callback();
        expect(opening()).toBeCloseTo(northUp, 9);
    });
});
