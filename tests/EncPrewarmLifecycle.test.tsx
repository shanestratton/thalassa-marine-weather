import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { useMapInit } from '../components/map/useMapInit';

const world = vi.hoisted(() => ({
    prewarm: vi.fn(),
    maps: [] as Array<{ remove: () => void }>,
    imports: [] as Array<() => void>,
}));

vi.mock('../components/map/encPrewarmLifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/map/encPrewarmLifecycle')>();
    return {
        deferEncPrewarm: (map: mapboxgl.Map, canRun: () => boolean) =>
            actual.deferEncPrewarm(
                map,
                canRun,
                () => new Promise((resolve) => world.imports.push(() => resolve({ prewarmEncMerge: world.prewarm }))),
            ),
    };
});
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
            private handlers = new Map<string, Set<() => void>>();
            touchZoomRotate = { disableRotation: vi.fn() };
            addControl = vi.fn();
            resize = vi.fn();
            constructor() {
                world.maps.push(this);
            }
            on(event: string, callback: () => void) {
                const listeners = this.handlers.get(event) ?? new Set();
                listeners.add(callback);
                this.handlers.set(event, listeners);
            }
            once(event: string, callback: () => void) {
                this.on(event, callback);
            }
            remove() {
                for (const callback of this.handlers.get('remove') ?? []) callback();
            }
        },
        ScaleControl: class {},
    },
}));

function options(
    overrides: { encVisible?: boolean; coordCapture?: boolean; pickerMode?: boolean; embedded?: boolean } = {},
) {
    return {
        containerRef: { current: document.createElement('div') },
        mapRef: { current: null as mapboxgl.Map | null },
        pinMarkerRef: { current: null },
        locationDotRef: { current: null },
        mapboxToken: 'test-only',
        mapStyle: 'mapbox://styles/mapbox/dark-v11',
        initialZoom: 10,
        minimalLabels: false,
        embedded: false,
        location: { lat: -19.26, lon: 146.82 },
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
        encVisible: true,
        coordCapture: false,
        ...overrides,
    };
}

async function settleImport() {
    await act(async () => {
        for (const resolve of world.imports.splice(0)) resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    world.maps.length = 0;
    world.imports.length = 0;
});
afterEach(cleanup);

describe('ENC boot prewarm obeys the live chart lifecycle', () => {
    it('does no merge work when ENC is switched off before OBS mounts', async () => {
        renderHook(() => useMapInit(options({ encVisible: false })));
        await settleImport();
        expect(world.maps).toHaveLength(1);
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('prewarms the enabled chart exactly once without waiting for its style load', async () => {
        const initial = options();
        renderHook(() => useMapInit(initial));
        await settleImport();
        expect(world.prewarm).toHaveBeenCalledOnce();
        expect(world.prewarm).toHaveBeenCalledWith(initial.mapRef.current);
    });

    it('lets the active plotter prewarm its required ENC even when the browse switch is off', async () => {
        renderHook(() => useMapInit(options({ encVisible: false, coordCapture: true })));
        await settleImport();
        expect(world.prewarm).toHaveBeenCalledOnce();
    });

    it.each([{ pickerMode: true }, { embedded: true }])(
        'does not prewarm a lightweight picker/embedded map: %o',
        async (mode) => {
            renderHook(() => useMapInit(options(mode)));
            await settleImport();
            expect(world.prewarm).not.toHaveBeenCalled();
        },
    );

    it('honours a switch off while the prewarm module import is still pending, without recreating the map', async () => {
        const initial = options();
        const view = renderHook((props) => useMapInit(props), { initialProps: initial });
        view.rerender({ ...initial, encVisible: false });
        await settleImport();
        expect(world.maps).toHaveLength(1);
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('does not revive a deferred prewarm when the map becomes a picker', async () => {
        const initial = options();
        const view = renderHook((props) => useMapInit(props), { initialProps: initial });
        view.rerender({ ...initial, pickerMode: true });
        await settleImport();
        expect(world.maps).toHaveLength(1);
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('stands down when plotting ends before import and the browse chart is still off', async () => {
        const initial = options({ encVisible: false, coordCapture: true });
        const view = renderHook((props) => useMapInit(props), { initialProps: initial });
        view.rerender({ ...initial, coordCapture: false });
        await settleImport();
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('leaves later chart activation to the normal ENC hook, not a new map/prewarm', async () => {
        const initial = options({ encVisible: false });
        const view = renderHook((props) => useMapInit(props), { initialProps: initial });
        await settleImport();
        view.rerender({ ...initial, encVisible: true });
        await settleImport();
        expect(world.maps).toHaveLength(1);
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('cannot warm a replaced map when both style-generation imports settle together', async () => {
        const initial = options();
        const view = renderHook((props) => useMapInit(props), { initialProps: initial });
        view.rerender({ ...initial, mapStyle: 'mapbox://styles/mapbox/light-v11' });
        await settleImport();
        expect(world.maps).toHaveLength(2);
        expect(initial.mapRef.current).toBe(world.maps[1]);
        expect(world.prewarm).toHaveBeenCalledOnce();
        expect(world.prewarm).toHaveBeenCalledWith(world.maps[1]);
    });

    it('does not start late work after hook cleanup removed the map', async () => {
        const view = renderHook(() => useMapInit(options()));
        view.unmount();
        await settleImport();
        expect(world.prewarm).not.toHaveBeenCalled();
    });

    it('does not start late work after an externally removed map', async () => {
        const initial = options();
        renderHook(() => useMapInit(initial));
        initial.mapRef.current!.remove();
        await settleImport();
        expect(world.prewarm).not.toHaveBeenCalled();
    });
});
