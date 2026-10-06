import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    passthroughUrl: vi.fn(() => null),
    // Null = "no usable Pi lane", so the hook falls through to direct — the
    // shape every caller now gets from the pinned-transport wrappers.
    passthroughJson: vi.fn(async () => null),
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: { passthroughUrl: mocks.passthroughUrl, passthroughJson: mocks.passthroughJson },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { useSquallMap } from '../components/map/useSquallMap';
import { squallStatusStore, squallStatusText } from '../services/weather/squallStatus';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeMap() {
    const sources = new Set<string>();
    const layers = new Set<string>();
    let maxZoom = 22;
    let minZoom = 0;
    const map = {
        __ausNzMinZoom: 3,
        getSource: vi.fn((id: string) => (sources.has(id) ? {} : undefined)),
        getLayer: vi.fn((id: string) => (layers.has(id) ? {} : undefined)),
        addSource: vi.fn((id: string) => sources.add(id)),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        getStyle: vi.fn(() => ({ layers: [] })),
        isSourceLoaded: vi.fn(() => true),
        getContainer: vi.fn(() => document.createElement('div')),
        getMaxZoom: vi.fn(() => maxZoom),
        getMinZoom: vi.fn(() => minZoom),
        setMaxZoom: vi.fn((value: number) => {
            maxZoom = value;
        }),
        setMinZoom: vi.fn((value: number) => {
            minZoom = value;
        }),
        getZoom: vi.fn(() => 3),
        flyTo: vi.fn(),
        easeTo: vi.fn(),
        on: vi.fn((_event: string, _callback: unknown) => undefined),
        off: vi.fn(),
    };
    return { map, sources, layers };
}

function emit(map: ReturnType<typeof makeMap>['map'], event: string, value: unknown) {
    const listener = map.on.mock.calls.find((call: unknown[]) => call[0] === event)?.[1] as unknown as (
        event: unknown,
    ) => void;
    listener?.(value);
}

describe('useSquallMap request lifecycle', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: null }) })),
        );
    });

    it('loads passage squalls without moving or constraining the map, including when HUD closes', async () => {
        const { map } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(
            ({ preserveViewport }) => useSquallMap(ref, true, true, undefined, undefined, preserveViewport),
            { initialProps: { preserveViewport: true } },
        );
        await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        hook.rerender({ preserveViewport: false });
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(map.easeTo).not.toHaveBeenCalled();
        expect(map.setMinZoom).not.toHaveBeenCalled();
        expect(map.setMaxZoom).not.toHaveBeenCalled();
        expect(map.on).not.toHaveBeenCalledWith('zoomend', expect.anything());
        hook.unmount();
    });

    it('releases standalone squall camera limits when the HUD takes over', () => {
        const { map } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(
            ({ preserveViewport }) => useSquallMap(ref, true, true, undefined, undefined, preserveViewport),
            { initialProps: { preserveViewport: false } },
        );
        expect(map.easeTo).toHaveBeenCalledOnce();
        expect(map.getMinZoom()).toBe(3);
        expect(map.getMaxZoom()).toBe(8);
        hook.rerender({ preserveViewport: true });
        expect(map.getMinZoom()).toBe(0);
        expect(map.getMaxZoom()).toBe(22);
        expect(map.off).toHaveBeenCalledWith('zoomend', expect.anything());
        expect(map.easeTo).toHaveBeenCalledOnce();
        hook.unmount();
    });

    it('opens the squall view about what is on screen, never flying the chart to a position', () => {
        // Obs opens where the location box points (Hawaii, say); switching
        // Squall on zoomed out about the phone's GPS instead (Shane
        // 2026-10-06: "if i look at any layers, it should show me the
        // details of that location").
        const { map } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(() => useSquallMap(ref, true, true));
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(map.easeTo).toHaveBeenCalledExactlyOnceWith({ zoom: 3, duration: 800 });
        hook.unmount();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('cannot mount an in-flight Chart snapshot after Plan suppresses the layer', async () => {
        const response = deferred<Response>();
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return response.promise;
        });
        vi.stubGlobal('fetch', fetchMock);
        const { map, sources, layers } = makeMap();

        const rendered = renderHook(({ visible }) => useSquallMap({ current: map as never }, true, visible), {
            initialProps: { visible: true },
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
        rendered.rerender({ visible: false });
        expect(signal.aborted).toBe(true);

        await act(async () => {
            response.resolve({
                ok: true,
                json: async () => ({ snapshot: 12345 }),
            } as Response);
            await response.promise;
            await Promise.resolve();
        });

        // The RAINBOW half is what this test guards: a snapshot that was
        // in flight when the view moved to Plan must never mount.
        expect(sources.has('squall-rainbow-source')).toBe(false);
        expect(layers.has('squall-rainbow-layer')).toBe(false);
        expect(map.addSource).not.toHaveBeenCalledWith('squall-rainbow-source', expect.anything());
        expect(map.addLayer).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: 'squall-rainbow-layer' }),
            expect.anything(),
        );

        // The SATELLITE half mounts synchronously while the layer is still
        // visible (it needs nothing from Rainbow — 2026-08-21), so it is
        // legitimately created here. What matters is that suppression takes
        // it away again: an IR layer surviving the switch to Plan would be a
        // leak painting cloud over the planning chart.
        expect(sources.has('squall-ir-source')).toBe(false);
        expect(layers.has('squall-ir-layer')).toBe(false);
    });
});

describe('squall snapshot clock and actual tile readiness', () => {
    const now = Date.parse('2026-09-27T06:00:00Z');
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        mocks.passthroughJson.mockResolvedValue(null);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: (now - 15 * 60_000) / 1000 }) })),
        );
        squallStatusStore.reset();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    async function settle() {
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    }
    const sourceReady = { sourceId: 'squall-rainbow-source', sourceDataType: 'content', isSourceLoaded: true };

    it('uses the snapshot time, waits for tiles, and cannot renew an old snapshot age by fetching it again', async () => {
        const { map } = makeMap();
        const hook = renderHook(() => useSquallMap({ current: map as never }, true, true));
        await settle();
        expect(hook.result.current.snapshotTimeMs).toBe(now - 15 * 60_000);
        expect(hook.result.current.fetchedAtMs).toBe(now);
        expect(hook.result.current.phase).toBe('loading');
        expect(hook.result.current.tilesReady).toBe(false);
        act(() => emit(map, 'sourcedata', sourceReady));
        expect(hook.result.current.phase).toBe('ready');
        expect(squallStatusText(hook.result.current)).toBe('Snapshot 15m old');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        });
        expect(hook.result.current.fetchedAtMs).toBe(now + 5 * 60_000);
        expect(squallStatusText(hook.result.current)).toBe('Snapshot 20m old');
        expect(map.addSource.mock.calls.filter(([id]) => id === 'squall-rainbow-source')).toHaveLength(1);
        hook.unmount();
    });

    it('keeps a tile failure visible even if Mapbox later reports failed requests as loaded', async () => {
        const { map } = makeMap();
        const hook = renderHook(() => useSquallMap({ current: map as never }, true, true));
        await settle();
        act(() => emit(map, 'error', { sourceId: 'another-source', error: new Error('unrelated') }));
        expect(hook.result.current.error).toBeNull();
        act(() => emit(map, 'error', { sourceId: 'squall-rainbow-source', error: new Error('404') }));
        act(() => emit(map, 'sourcedata', sourceReady));
        expect(hook.result.current.tilesReady).toBe(false);
        expect(squallStatusText(hook.result.current)).toContain('tiles unavailable');
        hook.unmount();
        expect(squallStatusStore.get().phase).toBe('idle');
    });

    it('times out stalled tiles and retries after foregrounding without a made-up Live status', async () => {
        const { map } = makeMap();
        const hook = renderHook(() => useSquallMap({ current: map as never }, true, true));
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(hook.result.current.error).toContain('tiles unavailable');
        Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
        vi.setSystemTime(now + 2 * 24 * 3_600_000);
        act(() => window.dispatchEvent(new Event('focus')));
        expect(fetch).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'visible' });
        act(() => window.dispatchEvent(new Event('focus')));
        await settle();
        expect(fetch).toHaveBeenCalledTimes(2);
        act(() => emit(map, 'sourcedata', sourceReady));
        expect(squallStatusText(hook.result.current)).toBe('Snapshot 48h 15m old');
        hook.unmount();
    });

    it('retains unknown snapshot time for an opaque ID and reports refresh failures with the prior snapshot', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ snapshot: 123 }) } as Response);
        const { map } = makeMap();
        const hook = renderHook(() => useSquallMap({ current: map as never }, true, true));
        await settle();
        act(() => emit(map, 'sourcedata', sourceReady));
        expect(hook.result.current.snapshotTimeMs).toBeNull();
        expect(squallStatusText(hook.result.current)).toBe('Snapshot time unknown');
        vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        });
        expect(hook.result.current.error).toContain('refresh unavailable');
        act(() => emit(map, 'sourcedata', sourceReady));
        expect(hook.result.current.error).toContain('refresh unavailable');
        expect(hook.result.current.fetchedAtMs).toBe(now);
        hook.unmount();
    });
});
