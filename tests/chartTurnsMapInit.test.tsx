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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event?: unknown) => void;
const world = vi.hoisted(() => ({
    maps: [] as Array<{
        handlers: Map<string, Set<Handler>>;
        keyboard: { disableRotation: ReturnType<typeof vi.fn> };
        touchZoomRotate: { disableRotation: ReturnType<typeof vi.fn> };
        bearing: number;
        zoom: number;
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
            bearing = 0;
            zoom = 3;
            constructor() {
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
    it('locks the keyboard’s Shift+arrow turn beside the twist (the hole in the north-up lock)', () => {
        renderHook(() => useMapInit(options()));
        const [map] = world.maps;
        expect(map.touchZoomRotate.disableRotation).toHaveBeenCalled();
        expect(map.keyboard.disableRotation).toHaveBeenCalled();
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
