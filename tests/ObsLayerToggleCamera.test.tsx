/**
 * Switching a layer on never moves the Obs camera's centre (Shane 2026-10-06:
 * "when you go to select a layer like wind for example, it flys you to the new
 * location that you have in your glass page").
 *
 * Two paths framed a toggle, and both flew to the location box: MapHub's
 * framing snap (now useLayerFrameSnap) and useWeatherLayers' wind effect. Both
 * keep their zoom frame (wind z9, rain z7, a stack z7: Shane's own numbers)
 * and drop the centre, so a toggle reads the water on screen, wherever that is.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';

// Isobar and icon drawing need a real canvas; the camera is what is under test.
vi.mock('../components/map/isobarLayerSetup', () => ({
    initIsobarLayers: vi.fn(),
    hideIsobarLayers: vi.fn(),
    showIsobarLayers: vi.fn(),
    promoteNavLayers: vi.fn(),
    RAINVIEWER_COLOR_RAMP: '',
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useLayerFrameSnap } from '../components/map/mapHub/useLayerFrameSnap';
import { useWeatherLayers } from '../components/map/useWeatherLayers';
import { LAYER_FRAME_ZOOM, MULTI_LAYER_FRAME_ZOOM, type WeatherLayer } from '../components/map/mapConstants';

/** Every toggleable overlay, Sky and Sea alike. */
const LAYERS: WeatherLayer[] = [
    'wind',
    'velocity',
    'rain',
    'pressure',
    'clouds',
    'temperature',
    'waves',
    'currents',
    'sst',
    'chl',
    'seaice',
    'mld',
    'sea',
    'satellite',
    // The observed satellite cloud (W1-10) has no frame: switching it on
    // must not touch the camera at all.
    'satIR',
];

// The Glass location box is far from where the skipper is looking (the boat).
const LOOKING_AT = { lng: 148.72, lat: -20.27 };

function cameraMap(zoom = 14) {
    const camera = {
        jumpTo: vi.fn(),
        flyTo: vi.fn(),
        easeTo: vi.fn(),
    };
    const methods: Record<string, unknown> = {
        ...camera,
        getZoom: () => zoom,
        getCenter: () => ({ ...LOOKING_AT }),
        getSource: () => undefined,
        getLayer: () => undefined,
        getStyle: () => ({ layers: [], sources: {} }),
        isStyleLoaded: () => true,
        getBounds: () => ({
            getWest: () => 148,
            getEast: () => 149.5,
            getNorth: () => -19.5,
            getSouth: () => -21,
            contains: () => false,
        }),
        getContainer: () => document.createElement('div'),
        getCanvas: () => document.createElement('canvas'),
        getMinZoom: () => 3,
        getMaxZoom: () => 22,
        project: () => ({ x: 0, y: 0 }),
        unproject: () => ({ ...LOOKING_AT }),
        // Mapbox's handlers return the map for chaining.
        on: vi.fn(() => map),
        off: vi.fn(() => map),
        once: vi.fn(() => map),
    };
    const map = new Proxy(methods, { get: (object, key) => object[String(key)] ?? vi.fn() });
    return { map: map as unknown as mapboxgl.Map, camera };
}

/** No camera call may name a centre other than the one already on screen. */
function expectCentreHeld(camera: ReturnType<typeof cameraMap>['camera']) {
    expect(camera.jumpTo).not.toHaveBeenCalled();
    for (const fn of [camera.flyTo, camera.easeTo]) {
        for (const [options] of fn.mock.calls as [{ center?: [number, number] | { lng: number; lat: number } }][]) {
            if (options?.center === undefined) continue;
            const [lng, lat] = Array.isArray(options.center)
                ? options.center
                : [options.center.lng, options.center.lat];
            expect({ lng, lat }).toEqual(LOOKING_AT);
        }
    }
}

describe('the framing snap (MapHub)', () => {
    function mountSnap(map: mapboxgl.Map, suppressed = false) {
        const mapRef = { current: map } as MutableRefObject<mapboxgl.Map | null>;
        return renderHook(({ layers, suppressed }) => useLayerFrameSnap(mapRef, layers, suppressed), {
            initialProps: { layers: new Set<WeatherLayer>() as ReadonlySet<WeatherLayer>, suppressed },
        });
    }

    it.each(LAYERS)('switching %s on keeps the centre, with at most a zoom', (layer) => {
        const { map, camera } = cameraMap();
        const view = mountSnap(map);
        view.rerender({ layers: new Set([layer]), suppressed: false });
        expectCentreHeld(camera);
        expect(camera.flyTo).not.toHaveBeenCalled();
        const frame = LAYER_FRAME_ZOOM[layer];
        // Wind zooms in to its frame but never out: from z14 the zoom holds.
        if (frame === undefined || layer === 'wind' || layer === 'velocity')
            expect(camera.easeTo).not.toHaveBeenCalled();
        else expect(camera.easeTo).toHaveBeenCalledExactlyOnceWith({ zoom: frame, duration: 600 });
    });

    it.each(['wind', 'velocity'] as const)('switching %s on from further out zooms in to its frame', (layer) => {
        const { map, camera } = cameraMap(5);
        const view = mountSnap(map);
        view.rerender({ layers: new Set([layer]), suppressed: false });
        expectCentreHeld(camera);
        expect(camera.easeTo).toHaveBeenCalledExactlyOnceWith({ zoom: LAYER_FRAME_ZOOM[layer], duration: 600 });
    });

    it('frames a stack at the shared zoom without moving, and switching off does nothing', () => {
        const { map, camera } = cameraMap();
        const view = mountSnap(map);
        view.rerender({ layers: new Set<WeatherLayer>(['wind']), suppressed: false });
        view.rerender({ layers: new Set<WeatherLayer>(['wind', 'rain']), suppressed: false });
        expect(camera.easeTo).toHaveBeenLastCalledWith({ zoom: MULTI_LAYER_FRAME_ZOOM, duration: 600 });
        camera.easeTo.mockClear();
        view.rerender({ layers: new Set<WeatherLayer>(['wind']), suppressed: false });
        view.rerender({ layers: new Set<WeatherLayer>(), suppressed: false });
        expect(camera.easeTo).not.toHaveBeenCalled();
        expectCentreHeld(camera);
    });

    it('leaves Plan and the passage HUD camera alone', () => {
        const { map, camera } = cameraMap();
        const view = mountSnap(map, true);
        view.rerender({ layers: new Set<WeatherLayer>(['wind', 'rain']), suppressed: true });
        expect(camera.easeTo).not.toHaveBeenCalled();
    });
});

describe('useWeatherLayers toggles', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it.each(LAYERS)('switching %s on from the boat at z14 keeps the centre', (layer) => {
        const { map, camera } = cameraMap(14);
        const mapRef = { current: map } as MutableRefObject<mapboxgl.Map | null>;
        const { result } = renderHook(() =>
            useWeatherLayers(mapRef, true, false, { lat: LOOKING_AT.lat, lon: LOOKING_AT.lng }, false, undefined, true),
        );
        act(() => result.current.toggleLayer(layer));
        expectCentreHeld(camera);
        if (layer === 'wind' || layer === 'velocity') {
            // Wind zooms in to its frame but never out (2026-10-06): at z14
            // the close-in wind field shows the breeze, so the zoom holds.
            expect(camera.easeTo).not.toHaveBeenCalled();
        }
    });

    it('switching wind on from further out still zooms in to its z9 frame, about the same centre', () => {
        const { map, camera } = cameraMap(5);
        const mapRef = { current: map } as MutableRefObject<mapboxgl.Map | null>;
        const { result } = renderHook(() =>
            useWeatherLayers(mapRef, true, false, { lat: LOOKING_AT.lat, lon: LOOKING_AT.lng }, false, undefined, true),
        );
        act(() => result.current.toggleLayer('wind'));
        expectCentreHeld(camera);
        expect(camera.easeTo).toHaveBeenCalledWith({ zoom: LAYER_FRAME_ZOOM.wind, duration: 700 });
    });

    it.each(LAYERS)('switching %s on from a synoptic z3 view zooms, at most, about the same centre', (layer) => {
        const { map, camera } = cameraMap(3);
        const mapRef = { current: map } as MutableRefObject<mapboxgl.Map | null>;
        const { result } = renderHook(() =>
            useWeatherLayers(mapRef, true, false, { lat: LOOKING_AT.lat, lon: LOOKING_AT.lng }, false, undefined, true),
        );
        act(() => result.current.toggleLayer(layer));
        expectCentreHeld(camera);
    });
});
