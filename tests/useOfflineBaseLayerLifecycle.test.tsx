import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfflineBaseLayer } from '../components/map/useOfflineBaseLayer';

const mocks = vi.hoisted(() => ({ templates: vi.fn() }));
vi.mock('../services/MapOfflineService', () => ({ getOfflineTileTemplates: mocks.templates }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
const templates = {
    osm: 'https://fixture.invalid/osm/{z}/{x}/{y}.png',
    openseamap: 'https://fixture.invalid/marks/{z}/{x}/{y}.png',
    storage: 'web',
};

function makeMap() {
    const initial = [
        { id: 'background', type: 'background' },
        { id: 'water', type: 'fill' },
        { id: 'satellite-base-layer', type: 'raster' },
        { id: 'enc-vec-depare', type: 'fill' },
        { id: 'mob-marker', type: 'symbol' },
    ];
    const layers = [...initial];
    const sources = new Set<string>();
    const listeners = new Map<string, Set<() => void>>();
    const map = {
        isStyleLoaded: () => true,
        getStyle: () => ({ layers }),
        getSource: (id: string) => sources.has(id),
        addSource: vi.fn((id: string) => sources.add(id)),
        removeSource: (id: string) => sources.delete(id),
        getLayer: (id: string) => layers.find((layer) => layer.id === id),
        addLayer: vi.fn((layer: { id: string; type: string }, before?: string) => {
            const at = before ? layers.findIndex((entry) => entry.id === before) : -1;
            layers.splice(at < 0 ? layers.length : at, 0, layer);
        }),
        removeLayer: (id: string) => {
            const at = layers.findIndex((layer) => layer.id === id);
            if (at >= 0) layers.splice(at, 1);
        },
        on: (event: string, handler: () => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
        },
        off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
    };
    return {
        map,
        layers,
        sources,
        listeners,
        resetStyle: () => {
            layers.splice(0, layers.length, ...initial);
            sources.clear();
        },
        emit: (event: string) => {
            for (const handler of listeners.get(event) ?? []) handler();
        },
    };
}

describe('offline basemap lifecycle', () => {
    beforeEach(() => mocks.templates.mockReset().mockResolvedValue(templates));
    afterEach(() => vi.restoreAllMocks());

    it('places fallback above opaque bases and seamarks below chart/tactical overlays', async () => {
        const { map, layers } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(() => useOfflineBaseLayer(ref, true, false));
        await waitFor(() => expect(map.addLayer).toHaveBeenCalledTimes(2));
        expect(layers.map((layer) => layer.id)).toEqual([
            'background',
            'water',
            'satellite-base-layer',
            'osm-offline-fallback',
            'seamark-offline-fallback',
            'enc-vec-depare',
            'mob-marker',
        ]);
        hook.unmount();
    });

    it('restores both sources after style replacement and removes them when online or unmounted', async () => {
        const harness = makeMap();
        const ref = { current: harness.map as never };
        const hook = renderHook(({ online }) => useOfflineBaseLayer(ref, true, online), {
            initialProps: { online: false },
        });
        await waitFor(() => expect(harness.sources.size).toBe(2));
        act(() => {
            harness.resetStyle();
            harness.emit('style.load');
        });
        expect(harness.sources.size).toBe(2);
        const calls = harness.map.addLayer.mock.calls.length;
        act(() => harness.emit('idle'));
        expect(harness.map.addLayer).toHaveBeenCalledTimes(calls);
        hook.rerender({ online: true });
        expect(harness.sources.size).toBe(0);
        expect(harness.layers.some((layer) => layer.id.endsWith('offline-fallback'))).toBe(false);
        expect([...harness.listeners.values()].every((set) => set.size === 0)).toBe(true);
        hook.rerender({ online: false });
        await waitFor(() => expect(harness.sources.size).toBe(2));
        hook.unmount();
        expect(harness.sources.size).toBe(0);
    });

    it('cannot install a late offline-template result after connectivity returns', async () => {
        let resolve!: (value: typeof templates) => void;
        mocks.templates.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const { map } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(({ online }) => useOfflineBaseLayer(ref, true, online), {
            initialProps: { online: false },
        });
        hook.rerender({ online: true });
        await act(async () => {
            resolve(templates);
            await Promise.resolve();
        });
        expect(map.addSource).not.toHaveBeenCalled();
        hook.unmount();
    });
});
