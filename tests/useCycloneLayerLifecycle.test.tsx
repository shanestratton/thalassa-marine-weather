import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCycloneLayer } from '../components/map/useCycloneLayer';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), errors: vi.fn(), clouds: vi.fn(), removeClouds: vi.fn() }));
vi.mock('../services/weather/CycloneTrackingService', () => ({
    fetchActiveCyclones: mocks.fetch,
    fetchGfsTrackerPositions: async () => new Map(),
    findClosestCyclone: (storms: ActiveCyclone[]) => storms[0] ?? null,
}));
vi.mock('../stores/WindStore', () => ({ WindStore: { subscribe: () => () => undefined } }));
vi.mock('../components/map/cloudOverlay', () => ({
    mountCloudOverlay: mocks.clouds,
    removeCloudOverlay: mocks.removeClouds,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.errors }),
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Point: class Point {
            constructor(
                public x: number,
                public y: number,
            ) {}
        },
        Marker: class Marker {
            constructor(private options: { element: HTMLElement }) {}
            setLngLat() {
                return this;
            }
            addTo(map: { getContainer: () => HTMLElement }) {
                map.getContainer().append(this.options.element);
                return this;
            }
            remove() {
                this.options.element.remove();
            }
        },
    },
}));

function storm(sid: string): ActiveCyclone {
    const current = { lat: -20, lon: 155, time: '2026-09-27T00:00:00Z', windKts: 70, pressureMb: 980 };
    return {
        sid,
        name: sid,
        basin: 'P',
        category: 1,
        categoryLabel: '1',
        currentPosition: current,
        track: [{ ...current, lat: -19, time: '2026-09-26T18:00:00Z' }, current],
        forecastTrack: [
            { ...current, lat: -21, time: '2026-09-27T06:00:00Z' },
            { ...current, lat: -22, time: '2026-09-27T12:00:00Z' },
        ],
        maxWindKts: 70,
        minPressureMb: 980,
        nature: 'TC',
    };
}

function makeMap() {
    const container = document.createElement('div');
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, { id: string }>();
    const listeners = new Map<string, Set<() => void>>();
    let minZoom = 0,
        maxZoom = 22;
    const map = {
        getContainer: () => container,
        getStyle: () => ({ layers: [...layers.values()], sources: Object.fromEntries(sources) }),
        isStyleLoaded: () => true,
        getSource: (id: string) => sources.get(id),
        addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
        removeSource: (id: string) => sources.delete(id),
        getLayer: (id: string) => layers.get(id),
        addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
        removeLayer: (id: string) => layers.delete(id),
        getZoom: () => 3,
        getMinZoom: () => minZoom,
        getMaxZoom: () => maxZoom,
        setMinZoom: (value: number) => {
            minZoom = value;
        },
        setMaxZoom: (value: number) => {
            maxZoom = value;
        },
        getCenter: () => ({ lat: -20, lng: 155 }),
        project: ([lon, lat]: number[]) => ({ x: lon, y: lat }),
        flyTo: vi.fn(),
        easeTo: vi.fn(),
        on: (event: string, handler: () => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
        },
        off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
    };
    return { map, container, sources, layers, listeners };
}

describe('cyclone catalogue lifecycle', () => {
    const timers = new Map<number, () => Promise<void>>();
    beforeEach(() => {
        timers.clear();
        mocks.fetch.mockReset();
        mocks.errors.mockClear();
        mocks.clouds.mockClear();
        mocks.removeClouds.mockClear();
        const originalSetInterval = globalThis.setInterval;
        const originalClearInterval = globalThis.clearInterval;
        vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => Promise<void>, ms: number) => {
            if (ms === 60_000 || ms === 30 * 60_000) {
                timers.set(ms, callback);
                return ms;
            }
            return originalSetInterval(callback, ms);
        }) as never);
        vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
            if (!timers.delete(id)) originalClearInterval(id);
        }) as never);
    });
    afterEach(() => vi.restoreAllMocks());

    it('removes departed storm tracks without removing surviving or unrelated layers', async () => {
        const first = storm('FIRST'),
            second = storm('SECOND');
        mocks.fetch.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([second]);
        const h = makeMap();
        h.layers.set('unrelated-route', { id: 'unrelated-route' });
        const ref = { current: h.map as never };
        const hook = renderHook(() => useCycloneLayer(ref, true, true, -20, 155));
        await waitFor(() => {
            expect(mocks.errors.mock.calls).toEqual([]);
            expect(h.layers.has('past-track-FIRST-line')).toBe(true);
        });
        expect(h.container.querySelectorAll('.cyclone-marker')).toHaveLength(2);
        await act(async () => {
            await timers.get(30 * 60_000)!();
        });
        expect(h.layers.has('past-track-FIRST-line')).toBe(false);
        expect(h.sources.has('past-track-FIRST')).toBe(false);
        expect(h.layers.has('past-track-SECOND-line')).toBe(true);
        expect(h.layers.has('unrelated-route')).toBe(true);
        expect(h.container.querySelectorAll('.cyclone-marker')).toHaveLength(1);
        expect(mocks.errors).not.toHaveBeenCalled();
        hook.unmount();
        expect([...h.layers.keys()]).toEqual(['unrelated-route']);
        expect(h.sources.size).toBe(0);
        expect(h.container.querySelector('svg')).toBeNull();
        expect([...h.listeners.values()].every((set) => set.size === 0)).toBe(true);
    });

    it('clears all storm visuals and selection after a successful empty refresh', async () => {
        const first = storm('FIRST');
        mocks.fetch.mockResolvedValueOnce([first]).mockResolvedValueOnce([]);
        const h = makeMap();
        const ref = { current: h.map as never },
            closest = vi.fn();
        const hook = renderHook(() => useCycloneLayer(ref, true, true, -20, 155, closest, undefined, first));
        await waitFor(() => {
            expect(mocks.errors.mock.calls).toEqual([]);
            expect(h.layers.has('past-track-FIRST-line')).toBe(true);
        });
        expect(h.layers.has('cyclone-sleeve-core')).toBe(true);
        expect(h.container.querySelector('#cyclone-hud-badges')).not.toBeNull();
        await act(async () => {
            await timers.get(30 * 60_000)!();
        });
        expect(h.layers.size).toBe(0);
        expect(h.sources.size).toBe(0);
        expect(h.container.querySelector('.cyclone-marker')).toBeNull();
        expect(h.container.querySelector('svg')).toBeNull();
        expect(h.container.querySelector('#cyclone-hud-badges')).toBeNull();
        expect(closest).toHaveBeenLastCalledWith(null);
        expect(mocks.removeClouds).toHaveBeenCalled();
        expect(mocks.errors).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('does not retain the old probability sleeve when the refreshed storm has no forecast', async () => {
        const first = storm('FIRST');
        mocks.fetch.mockResolvedValueOnce([first]).mockResolvedValueOnce([{ ...first, forecastTrack: [] }]);
        const h = makeMap();
        const ref = { current: h.map as never };
        const hook = renderHook(() => useCycloneLayer(ref, true, true, -20, 155));
        await waitFor(() => {
            expect(mocks.errors.mock.calls).toEqual([]);
            expect(h.layers.has('cyclone-sleeve-core')).toBe(true);
        });
        await act(async () => {
            await timers.get(30 * 60_000)!();
        });
        expect(h.sources.has('cyclone-sleeve-src')).toBe(false);
        expect(h.layers.has('cyclone-sleeve-core')).toBe(false);
        expect(h.layers.has('past-track-FIRST-line')).toBe(true);
        expect(mocks.errors).not.toHaveBeenCalled();
        hook.unmount();
    });
});
