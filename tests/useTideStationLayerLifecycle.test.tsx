import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { useTideStationLayer } from '../components/map/useTideStationLayer';
import type { TideStation, TideStationDetails } from '../services/tides/stationDetails';

const api = vi.hoisted(() => ({
    search: vi.fn(),
    details: vi.fn(),
    markers: [] as Array<{ remove: ReturnType<typeof vi.fn>; element: HTMLElement }>,
}));
vi.mock('../services/tides/stationDetails', () => ({
    fetchNearbyTideStations: api.search,
    fetchTideStationDetails: api.details,
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            element: HTMLElement;
            constructor({ element }: { element: HTMLElement }) {
                this.element = element;
                api.markers.push(this);
            }
            setLngLat = vi.fn(() => this);
            addTo = vi.fn((map: { getContainer: () => HTMLElement }) => {
                map.getContainer().append(this.element);
                return this;
            });
            remove = vi.fn(() => this.element.remove());
        },
    },
}));

const STATION: TideStation = { id: 'mackay', name: 'Mackay Harbour', lat: -21.1, lon: 149.2, distance: 8 };
const OTHER: TideStation = { id: 'townsville', name: 'Townsville', lat: -19.2, lon: 146.8, distance: 8 };
function details(station = STATION): TideStationDetails {
    const now = Date.now();
    return {
        station,
        predictionLocation: { lat: station.lat, lon: station.lon },
        predictionStationName: station.name,
        datum: 'LAT',
        requestedDatum: 'LAT',
        timezone: 'Australia/Brisbane',
        fetchedAtMs: now,
        heights: [
            { timeMs: now - 3600_000, heightM: 1 },
            { timeMs: now, heightM: 2 },
            { timeMs: now + 3600_000, heightM: 3 },
        ],
        extremes: [{ timeMs: now + 3600_000, heightM: 3, type: 'High' }],
        source: 'WorldTides',
        copyright: 'WorldTides',
        kind: 'prediction',
        wind: null,
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function makeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const sourceHistory: Array<{ setData: ReturnType<typeof vi.fn> }> = [];
    const layers: Array<{ id: string }> = [];
    const images = new Set<string>();
    const handlers = new Map<string, Set<(event: unknown) => void>>();
    const container = document.createElement('div');
    container.className = 'tide-test-map';
    document.body.append(container);
    const canvas = document.createElement('canvas');
    container.append(canvas);
    let center = { lat: -21.1, lng: 149.2 };
    let zoom = 8;
    let ready = true;
    let clickedId = STATION.id;
    const raw = {
        addSource: vi.fn((id: string) => {
            const source = { setData: vi.fn() };
            sources.set(id, source);
            sourceHistory.push(source);
        }),
        getSource: vi.fn((id: string) => sources.get(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        addLayer: vi.fn((layer: { id: string }, before?: string) => {
            const at = before ? layers.findIndex((item) => item.id === before) : -1;
            if (at < 0) layers.push(layer);
            else layers.splice(at, 0, layer);
        }),
        getLayer: vi.fn((id: string) => layers.find((layer) => layer.id === id)),
        removeLayer: vi.fn((id: string) => {
            const at = layers.findIndex((layer) => layer.id === id);
            if (at >= 0) layers.splice(at, 1);
        }),
        moveLayer: vi.fn((id: string, before?: string) => {
            const at = layers.findIndex((layer) => layer.id === id);
            const [item] = layers.splice(at, 1);
            const to = layers.findIndex((layer) => layer.id === before);
            if (to < 0) layers.push(item);
            else layers.splice(to, 0, item);
        }),
        getStyle: () => ({ layers }),
        isStyleLoaded: () => ready,
        hasImage: (id: string) => images.has(id),
        addImage: (id: string) => images.add(id),
        removeImage: (id: string) => images.delete(id),
        getZoom: () => zoom,
        getCenter: () => center,
        getContainer: () => container,
        getCanvas: () => canvas,
        fitBounds: vi.fn(),
        flyTo: vi.fn(),
        on: vi.fn(
            (event: string, layerOrFn: string | ((event: unknown) => void), maybeFn?: (event: unknown) => void) => {
                const key = typeof layerOrFn === 'string' ? `${event}:${layerOrFn}` : event;
                const callback = typeof layerOrFn === 'string' ? maybeFn! : layerOrFn;
                if (!handlers.has(key)) handlers.set(key, new Set());
                handlers.get(key)!.add(callback);
            },
        ),
        off: vi.fn(
            (event: string, layerOrFn: string | ((event: unknown) => void), maybeFn?: (event: unknown) => void) => {
                const key = typeof layerOrFn === 'string' ? `${event}:${layerOrFn}` : event;
                handlers.get(key)?.delete(typeof layerOrFn === 'string' ? maybeFn! : layerOrFn);
            },
        ),
        queryRenderedFeatures: vi.fn(() => [{ properties: { id: clickedId } }]),
    };
    const emit = (key: string) =>
        act(() =>
            handlers
                .get(key)
                ?.forEach((fn) => fn({ point: { x: 1, y: 1 }, originalEvent: { stopPropagation: vi.fn() } })),
        );
    return {
        raw,
        sources,
        layers,
        sourceHistory,
        handlers,
        container,
        ref: { current: raw as unknown as mapboxgl.Map },
        emit,
        click: (id = STATION.id) => {
            clickedId = id;
            emit('click:tide-station-symbols');
        },
        pan: (lat: number, lng: number) => {
            center = { lat, lng };
            emit('moveend');
        },
        setZoom: (value: number) => {
            zoom = value;
            emit('moveend');
        },
        beginStyle: () => {
            ready = false;
            sources.clear();
            layers.length = 0;
            images.clear();
        },
        finishStyle: () => {
            ready = true;
            emit('style.load');
        },
    };
}
const flush = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    api.search.mockReset().mockResolvedValue([STATION]);
    api.details.mockReset().mockResolvedValue(details());
    api.markers.length = 0;
});
afterEach(async () => {
    cleanup();
    await flush();
    document.querySelectorAll('.tide-test-map').forEach((node) => node.remove());
    vi.useRealTimers();
});

describe('tide station layer lifecycle', () => {
    it('loads stations immediately and never requests every station prediction', async () => {
        const c = makeMap();
        const hook = renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        expect(api.search).toHaveBeenCalledOnce();
        expect(api.details).not.toHaveBeenCalled();
        expect(hook.result.current.stationCount).toBe(1);
        expect(c.layers.map((layer) => layer.id)).toEqual(['tide-station-symbols', 'tide-station-labels']);
    });
    it('restores cached stations after Plan suppression and style replacement', async () => {
        const c = makeMap();
        const hook = renderHook(({ visible }) => useTideStationLayer(c.ref, true, visible), {
            initialProps: { visible: true },
        });
        await flush();
        const lastData = c.sourceHistory[0].setData.mock.calls.at(-1)?.[0];
        hook.rerender({ visible: false });
        expect(c.sources.size).toBe(0);
        hook.rerender({ visible: true });
        await flush();
        expect(c.sourceHistory[1].setData).toHaveBeenCalledWith(lastData);
        c.beginStyle();
        c.finishStyle();
        expect(c.sourceHistory[2].setData).toHaveBeenCalledWith(lastData);
        expect(api.search).toHaveBeenCalledOnce();
    });
    it('loads a new viewport after 650ms, not a minute, and handles valid empty responses', async () => {
        const c = makeMap();
        const hook = renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        api.search.mockResolvedValue([]);
        c.pan(-19.2, 146.8);
        act(() => vi.advanceTimersByTime(649));
        expect(api.search).toHaveBeenCalledOnce();
        act(() => vi.advanceTimersByTime(1));
        await flush();
        expect(api.search).toHaveBeenCalledTimes(2);
        expect(hook.result.current.stationCount).toBe(0);
        c.pan(-19.21, 146.8);
        act(() => vi.advanceTimersByTime(650));
        await flush();
        expect(api.search).toHaveBeenCalledTimes(2);
    });
    it('retries failed searches instead of memorising failure as a successful center', async () => {
        api.search.mockResolvedValueOnce(null).mockResolvedValue([STATION]);
        const c = makeMap();
        const hook = renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        expect(hook.result.current.error).toBe(true);
        c.emit('moveend');
        act(() => vi.advanceTimersByTime(650));
        await flush();
        expect(api.search).toHaveBeenCalledTimes(2);
        expect(hook.result.current.error).toBe(false);
        expect(hook.result.current.stationCount).toBe(1);
    });
    it('cancels moved-away requests and ignores a stale response', async () => {
        const first = deferred<TideStation[] | null>();
        api.search.mockReturnValueOnce(first.promise).mockResolvedValue([OTHER]);
        const c = makeMap();
        const hook = renderHook(() => useTideStationLayer(c.ref, true, true));
        const signal = api.search.mock.calls[0][2].signal as AbortSignal;
        c.pan(-19.2, 146.8);
        expect(signal.aborted).toBe(true);
        act(() => vi.advanceTimersByTime(650));
        await flush();
        first.resolve([STATION]);
        await flush();
        expect(hook.result.current.stationCount).toBe(1);
        expect(c.sourceHistory[0].setData.mock.calls.at(-1)?.[0].features[0].properties.id).toBe(OTHER.id);
    });
    it('does not fetch below overview zoom but loads promptly after zooming in', async () => {
        const c = makeMap();
        c.setZoom(4);
        renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        expect(api.search).not.toHaveBeenCalled();
        c.setZoom(8);
        act(() => vi.advanceTimersByTime(650));
        await flush();
        expect(api.search).toHaveBeenCalledOnce();
    });
    it('opens genuine on-demand predictions in a closeable React card without moving camera', async () => {
        const c = makeMap();
        renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        c.click();
        await flush();
        expect(api.details).toHaveBeenCalledOnce();
        expect(api.details.mock.calls[0][0]).toEqual(STATION);
        expect(screen.getByRole('heading', { name: STATION.name })).toBeTruthy();
        expect(c.container.querySelector('.tide-station-selected-gauge')).toBeTruthy();
        expect(c.raw.fitBounds).not.toHaveBeenCalled();
        expect(c.raw.flyTo).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /close/i }));
        await flush();
        expect(c.container.querySelector('.tide-station-detail-overlay')).toBeNull();
        expect(api.markers[0].remove).toHaveBeenCalledOnce();
    });
    it('aborts and ignores late details when station selection changes or closes', async () => {
        api.search.mockResolvedValue([STATION, OTHER]);
        const first = deferred<TideStationDetails | null>();
        api.details.mockReturnValueOnce(first.promise).mockResolvedValue(details(OTHER));
        const c = makeMap();
        renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        c.click();
        await flush();
        const signal = api.details.mock.calls[0][1].signal as AbortSignal;
        c.click(OTHER.id);
        await flush();
        expect(signal.aborted).toBe(true);
        first.resolve(details());
        await flush();
        expect(screen.getByRole('heading', { name: OTHER.name })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: STATION.name })).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        await flush();
        expect(c.container.querySelector('.tide-station-detail-overlay')).toBeNull();
    });
    it('keeps pointer events inside the card and releases pending work on disable', async () => {
        const pending = deferred<TideStationDetails | null>();
        api.details.mockReturnValue(pending.promise);
        const c = makeMap();
        const parentClick = vi.fn();
        c.container.addEventListener('pointerdown', parentClick);
        const hook = renderHook(({ visible }) => useTideStationLayer(c.ref, true, visible), {
            initialProps: { visible: true },
        });
        await flush();
        c.click();
        await flush();
        fireEvent.pointerDown(screen.getByRole('heading', { name: STATION.name }));
        expect(parentClick).not.toHaveBeenCalled();
        const signal = api.details.mock.calls[0][1].signal as AbortSignal;
        hook.rerender({ visible: false });
        await flush();
        expect(signal.aborted).toBe(true);
        expect(c.sources.size).toBe(0);
        expect([...c.handlers.values()].every((set) => set.size === 0)).toBe(true);
        pending.resolve(details());
        await flush();
        expect(c.container.querySelector('.tide-station-detail-overlay')).toBeNull();
    });
    it('places tide symbols below route foreground and settles after a late ENC layer', async () => {
        const c = makeMap();
        c.layers.push({ id: 'base' }, { id: 'routetrack-route-line' });
        renderHook(() => useTideStationLayer(c.ref, true, true));
        await flush();
        expect(c.layers.map((layer) => layer.id)).toEqual([
            'base',
            'tide-station-symbols',
            'tide-station-labels',
            'routetrack-route-line',
        ]);
        c.layers.splice(3, 0, { id: 'enc-land' });
        c.emit('idle');
        expect(c.layers.map((layer) => layer.id)).toEqual([
            'base',
            'enc-land',
            'tide-station-symbols',
            'tide-station-labels',
            'routetrack-route-line',
        ]);
        const moves = c.raw.moveLayer.mock.calls.length;
        c.emit('idle');
        expect(c.raw.moveLayer.mock.calls.length).toBe(moves);
    });
});
