import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { useCruisingReferenceLayer } from '../components/map/useCruisingReferenceLayer';
import type { CruisingPoint, MooringColourFilter } from '../services/anchorages/cruisingReference';
const api = vi.hoisted(() => ({ official: vi.fn(), tile: vi.fn() }));
vi.mock('../services/anchorages/CruisingReferenceService', () => ({
    loadOfficialMoorings: api.official,
    loadReferenceTile: api.tile,
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Popup: class {
            setLngLat() {
                return this;
            }
            setHTML() {
                return this;
            }
            addTo() {
                return this;
            }
            remove() {}
        },
    },
}));
const blue: CruisingPoint = {
    id: 'qpws-1',
    kind: 'mooring',
    name: 'Official',
    lon: 148.9,
    lat: -20.1,
    colours: ['blue'],
    band: 'green',
    mooringClass: 'B',
    access: 'Public',
    notes: '',
    source: 'QPWS',
    sourceUrl: '',
    retrievedAt: '2026-09-23',
    approximate: false,
};
const white: CruisingPoint = {
    ...blue,
    id: 'osm-node1',
    name: 'White',
    source: 'OpenStreetMap',
    colours: ['white'],
    band: null,
};
function makeMap() {
    const sources = new Map<
        string,
        { data: GeoJSON.FeatureCollection; setData: (d: GeoJSON.FeatureCollection) => void }
    >();
    const layers = new Map<string, unknown>(),
        images = new Set<string>();
    const handlers = new Map<string, Set<() => void>>();
    const canvas = document.createElement('canvas');
    let styleReady = true;
    const map = {
        isStyleLoaded: () => styleReady,
        getCenter: () => ({ lat: -20.1, lng: 148.9 }),
        getZoom: () => 13,
        getBounds: () => ({
            getWest: () => 148.8,
            getEast: () => 148.95,
            getSouth: () => -20.2,
            getNorth: () => -20.1,
        }),
        getStyle: () => ({ layers: [] }),
        getCanvas: () => canvas,
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, opts: { data: GeoJSON.FeatureCollection }) => {
            const s = {
                data: opts.data,
                setData(d: GeoJSON.FeatureCollection) {
                    s.data = d;
                },
            };
            sources.set(id, s);
        },
        removeSource: (id: string) => sources.delete(id),
        getLayer: (id: string) => layers.get(id),
        addLayer: (l: { id: string }) => layers.set(l.id, l),
        removeLayer: (id: string) => layers.delete(id),
        hasImage: (id: string) => images.has(id),
        addImage: (id: string) => images.add(id),
        removeImage: (id: string) => images.delete(id),
        on: (event: string, layerOrFn: string | (() => void), fn?: () => void) => {
            const key = typeof layerOrFn === 'string' ? `${event}:${layerOrFn}` : event;
            const set = handlers.get(key) ?? new Set();
            set.add(fn ?? (layerOrFn as () => void));
            handlers.set(key, set);
        },
        off: (event: string, layerOrFn: string | (() => void), fn?: () => void) => {
            const key = typeof layerOrFn === 'string' ? `${event}:${layerOrFn}` : event;
            handlers.get(key)?.delete(fn ?? (layerOrFn as () => void));
        },
    };
    return {
        ref: { current: map as unknown as mapboxgl.Map },
        sources,
        layers,
        images,
        handlers,
        reload: () => {
            styleReady = false;
            sources.clear();
            layers.clear();
            images.clear();
            handlers.get('style.load')?.forEach((fn) => fn());
            styleReady = true;
        },
    };
}
beforeEach(() => {
    api.official.mockReset().mockResolvedValue([blue]);
    api.tile
        .mockReset()
        .mockResolvedValue({ points: [white, { ...white, id: 'osm-node2', kind: 'anchorage' }], stale: false });
});
afterEach(cleanup);
describe('Independent cruising reference lifecycle', () => {
    it('does no reference work when off', () => {
        const m = makeMap();
        renderHook(() => useCruisingReferenceLayer(m.ref, true, false, false, 'all'));
        expect(api.tile).not.toHaveBeenCalled();
        expect(api.official).not.toHaveBeenCalled();
        expect(m.sources.size).toBe(0);
    });
    it('shows both, filters only moorings without refetching, restores style and cleans up', async () => {
        const m = makeMap();
        const hook = renderHook(
            ({ filter }: { filter: MooringColourFilter }) => useCruisingReferenceLayer(m.ref, true, true, true, filter),
            { initialProps: { filter: 'all' as MooringColourFilter } },
        );
        await waitFor(() => expect(m.sources.get('cruising-moorings')?.data.features).toHaveLength(2));
        expect(hook.result.current.anchors.features).toHaveLength(1);
        const calls = api.tile.mock.calls.length;
        hook.rerender({ filter: 'white' });
        expect(m.sources.get('cruising-moorings')?.data.features).toHaveLength(1);
        expect(hook.result.current.anchors.features).toHaveLength(1);
        expect(api.tile).toHaveBeenCalledTimes(calls);
        act(() => m.reload());
        expect(m.layers.has('cruising-mooring-symbols')).toBe(true);
        hook.unmount();
        expect(m.sources.size).toBe(0);
        expect(m.images.size).toBe(0);
        expect([...m.handlers.values()].every((s) => !s.size)).toBe(true);
    });
    it('keeps official points on a worldwide failure and marks the coverage incomplete', async () => {
        api.tile.mockRejectedValue(new Error('offline'));
        const m = makeMap();
        const { result } = renderHook(() => useCruisingReferenceLayer(m.ref, true, true, true, 'all'));
        await waitFor(() => expect(result.current.status).toContain('unavailable'));
        expect(m.sources.get('cruising-moorings')?.data.features).toHaveLength(1);
    });
    it('repairs a diffed style replacement which emits styledata but not style.load', async () => {
        const m = makeMap();
        const hook = renderHook(() => useCruisingReferenceLayer(m.ref, true, true, true, 'all'));
        await waitFor(() => expect(m.sources.get('cruising-moorings')?.data.features).toHaveLength(2));
        act(() => {
            m.sources.clear();
            m.layers.clear();
            m.images.clear();
            m.handlers.get('styledata')?.forEach((fn) => fn());
        });
        await waitFor(() => expect(m.sources.get('cruising-moorings')?.data.features).toHaveLength(2));
        hook.unmount();
    });
    it('never lets late responses resurrect a disabled layer', async () => {
        let resolve!: (value: { points: CruisingPoint[]; stale: boolean }) => void;
        api.tile.mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const m = makeMap();
        const hook = renderHook(() => useCruisingReferenceLayer(m.ref, true, true, false, 'all'));
        await waitFor(() => expect(api.tile).toHaveBeenCalled());
        hook.unmount();
        await act(async () => resolve({ points: [white], stale: false }));
        expect(m.sources.size).toBe(0);
        expect(m.layers.size).toBe(0);
    });
});
