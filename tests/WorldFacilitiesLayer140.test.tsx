import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
const h = vi.hoisted(() => ({
    load: vi.fn(),
    epoch: 0,
    satellite: false,
    cleared: new Set<() => void>(),
    settings: new Set<(...args: unknown[]) => void>(),
}));
vi.mock('../services/marineCatalogue/service', () => ({ loadMarineArea: h.load }));
vi.mock('../services/marineCatalogue/cache', () => ({
    catalogueCacheEpoch: () => h.epoch,
    subscribeCatalogueCacheCleared: (fn: () => void) => {
        h.cleared.add(fn);
        return () => h.cleared.delete(fn);
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.satellite }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { satelliteMode: h.satellite } }),
        subscribe: (fn: (...args: unknown[]) => void) => {
            h.settings.add(fn);
            return () => h.settings.delete(fn);
        },
    },
}));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: vi.fn() }));
import WorldFacilitiesLayer from '../components/map/WorldFacilitiesLayer';
import { setAuthIdentityScope } from '../services/authIdentityScope';
function fakeMap() {
    const listeners = new Map<string, (...args: unknown[]) => void>(),
        sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>(),
        layers = new Set<string>();
    const map = {
        zoom: 10,
        lng: 0.1,
        lat: 0.1,
        loaded: true,
        isStyleLoaded: () => map.loaded,
        getStyle: () => ({ version: 8, sources: {}, layers: [] }),
        getZoom: () => map.zoom,
        getCenter: () => ({ lng: map.lng, lat: map.lat }),
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.has(id),
        addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
        addLayer: ({ id }: { id: string }) => layers.add(id),
        removeLayer: (id: string) => layers.delete(id),
        removeSource: (id: string) => sources.delete(id),
        on: (event: string, layerOrFn: string | ((...args: unknown[]) => void), fn?: (...args: unknown[]) => void) =>
            listeners.set(event, fn ?? (layerOrFn as (...args: unknown[]) => void)),
        off: (event: string) => listeners.delete(event),
    };
    return { map: map as unknown as mapboxgl.Map, state: map, listeners, sources, layers };
}
const result = () => ({
    records: [{ id: 'osm-node1', kind: 'fuel', facilityKinds: ['fuel'], name: 'Fictional fuel', lat: 0.1, lon: 0.1 }],
    manifests: [
        {
            dataset: 'facilities-world',
            generation: 'world-fixture',
            sourceAt: '2026-10-01T00:00:00Z',
            coverage: 'Fictional only',
        },
    ],
    partial: false,
    cachedOnly: h.satellite,
});
beforeEach(() => {
    h.load.mockReset();
    h.load.mockImplementation(async () => result());
    h.satellite = false;
    setAuthIdentityScope(null);
});
afterEach(cleanup);
it('starts only when mounted/ready, uses only the world dataset and tears map/handlers down', async () => {
    const f = fakeMap(),
        status = vi.fn();
    const view = render(<WorldFacilitiesLayer map={f.map} mapReady={false} onStatus={status} />);
    expect(h.load).not.toHaveBeenCalled();
    await act(async () => view.rerender(<WorldFacilitiesLayer map={f.map} mapReady onStatus={status} />));
    expect(h.load).toHaveBeenCalledWith(0.1, 0.1, ['facilities-world'], expect.any(AbortSignal));
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ready', count: 1 }));
    expect(f.layers.size).toBe(1);
    const signal = h.load.mock.calls[0][3];
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(f.layers.size).toBe(0);
    expect(f.sources.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    expect(h.settings.size).toBe(0);
    expect(h.cleared.size).toBe(0);
    expect(status).toHaveBeenLastCalledWith(null);
});
it('aborts and rejects late data on account/cache/offline changes without increasing reader limits', async () => {
    const f = fakeMap(),
        status = vi.fn();
    let resolve!: (v: unknown) => void;
    h.load.mockImplementationOnce(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const view = render(<WorldFacilitiesLayer map={f.map} mapReady onStatus={status} />);
    const first = h.load.mock.calls[0][3];
    await act(async () => {
        setAuthIdentityScope('fictional-other');
    });
    expect(first.aborted).toBe(true);
    expect(h.load).toHaveBeenCalledTimes(2);
    await act(async () => {
        resolve({ ...result(), records: [...result().records, { ...result().records[0], id: 'stale' }] });
    });
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 }));
    await act(async () => {
        h.epoch++;
        for (const fn of h.cleared) fn();
    });
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable', count: 0 }));
    const source = [...f.sources.values()][0];
    expect(source.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
    await act(async () => {
        window.dispatchEvent(new Event('offline'));
    });
    expect(h.load).toHaveBeenCalledTimes(3);
    view.unmount();
});
it('requires zoom7, reloads on10NM drift/style replacement and immediately honors Satellite pause', async () => {
    const f = fakeMap(),
        status = vi.fn();
    f.state.zoom = 5;
    const view = render(<WorldFacilitiesLayer map={f.map} mapReady onStatus={status} />);
    expect(h.load).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'zoom' }));
    await act(async () => {
        f.state.zoom = 10;
        f.listeners.get('moveend')!();
    });
    expect(h.load).toHaveBeenCalledTimes(1);
    await act(async () => {
        f.state.lng += 0.01;
        f.listeners.get('moveend')!();
    });
    expect(h.load).toHaveBeenCalledTimes(1);
    await act(async () => {
        f.state.lng += 0.2;
        f.listeners.get('moveend')!();
    });
    expect(h.load).toHaveBeenCalledTimes(2);
    // Existing source data can be loading while the style itself remains installed.
    f.state.loaded = false;
    await act(async () => {
        h.satellite = true;
        for (const fn of h.settings) fn({ settings: { satelliteMode: true } }, { settings: { satelliteMode: false } });
    });
    expect(h.load).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ cachedOnly: true }));
    f.state.loaded = true;
    f.layers.clear();
    f.sources.clear();
    await act(async () => {
        f.listeners.get('style.load')!();
    });
    expect(f.layers.size).toBe(1);
    expect(h.load).toHaveBeenCalledTimes(4);
    view.unmount();
});
