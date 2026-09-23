import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEncVectorLayer } from '../components/map/useEncVectorLayer';
import { getEncDisplayState } from '../components/map/encDisplayState';

const mocks = vi.hoisted(() => ({
    merge: vi.fn(),
    mount: vi.fn(),
    refresh: vi.fn(),
    overview: vi.fn(),
    visibility: vi.fn(),
}));
vi.mock('../services/enc/EncHazardService', () => ({
    GLAZE_MIN_ZOOM: 10,
    getMergedVectorData: mocks.merge,
    hasAnyDisplayCells: () => true,
    setMergeInteractionProbe: vi.fn(),
    subscribe: () => () => {},
    subscribeGeometryUpgrades: () => () => {},
}));
vi.mock('../components/map/EncVectorLayer', () => ({
    attachEncFeatureClickHandlers: vi.fn(),
    detachEncFeatureClickHandlers: vi.fn(),
    mountEncVectorLayer: mocks.mount,
    refreshEncAsyncLayers: vi.fn(),
    refreshEncVectorData: mocks.refresh,
    setEncChartDetail: vi.fn(),
    setEncOverviewMode: mocks.overview,
    setEncVectorVisibility: mocks.visibility,
    unmountEncVectorLayer: vi.fn(),
    updateEncDepthStyle: vi.fn(),
}));

function chart(initialZoom: number) {
    let zoom = initialZoom;
    const handlers = new Map<string, Set<() => void>>();
    const map = {
        getZoom: () => zoom,
        getBounds: () => ({ getWest: () => 152, getSouth: () => -28, getEast: () => 154, getNorth: () => -23 }),
        isMoving: () => false,
        on: (event: string, fn: () => void) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
        once: vi.fn(),
    } as unknown as mapboxgl.Map;
    return {
        ref: { current: map },
        moveTo: (newZoom: number) => {
            zoom = newZoom;
            handlers.get('moveend')?.forEach((fn) => fn());
        },
    };
}
async function flush(ms = 300) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.merge.mockResolvedValue({ cellCount: 4, DEPARE: { features: [{}] }, DEPARE_GLAZE: { features: [] } });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ENC passage-fit overview', () => {
    it('mounts a low-zoom active passage against only its viewport, not an expanded coastline', async () => {
        const c = chart(5.6);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, true));
        await flush();
        expect(mocks.merge).toHaveBeenCalledWith([152, -28, 154, -23], 5.6, { includeReferences: true });
        expect(mocks.mount).toHaveBeenCalledOnce();
        expect(mocks.overview).toHaveBeenLastCalledWith(c.ref.current, true);
        expect(getEncDisplayState(c.ref.current)).toEqual({ phase: 'loaded', overview: true, loadedCells: 4 });
    });

    it.each([
        { zoom: 4, plotting: false },
        { zoom: 6, plotting: false },
        { zoom: 4.9, plotting: true },
    ])('does not turn the country-wide browsing boot into a merge: %o', async ({ zoom, plotting }) => {
        const c = chart(zoom);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, plotting));
        await flush();
        expect(mocks.merge).not.toHaveBeenCalled();
        expect(getEncDisplayState(c.ref.current).phase).toBe('zoom-in');
    });

    it('re-merges after route fit crosses below both old z6.5/7 floors and restores detail on zoom in', async () => {
        const c = chart(12);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, true));
        await flush();
        act(() => c.moveTo(5.6));
        await flush();
        await flush();
        expect(mocks.merge).toHaveBeenLastCalledWith([152, -28, 154, -23], 5.6, { includeReferences: true });
        expect(mocks.overview).toHaveBeenLastCalledWith(c.ref.current, true);
        act(() => c.moveTo(12));
        await flush();
        await flush();
        expect(mocks.overview).toHaveBeenLastCalledWith(c.ref.current, false);
        expect(getEncDisplayState(c.ref.current).overview).toBe(false);
    });

    it('reports unavailable overview data, not the metadata cell count as displayed charts', async () => {
        mocks.merge.mockResolvedValue(null);
        const c = chart(5.6);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, true));
        await flush();
        expect(mocks.mount).not.toHaveBeenCalled();
        expect(getEncDisplayState(c.ref.current)).toEqual({ phase: 'unavailable', overview: true, loadedCells: 0 });
    });

    it('does not lower cached harbour geometry when no overview-scale cell qualifies', async () => {
        const c = chart(15);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, true));
        await flush();
        mocks.overview.mockClear();
        mocks.merge.mockResolvedValue(null);
        act(() => c.moveTo(5.8));
        await flush();
        await flush();
        expect(mocks.overview).not.toHaveBeenCalledWith(c.ref.current, true);
        expect(getEncDisplayState(c.ref.current).phase).toBe('unavailable');
    });

    it('restores a still-cached chart status after zooming below the floor and back without merging again', async () => {
        const c = chart(12);
        renderHook(() => useEncVectorLayer(c.ref, true, true, true, 2.9, undefined, true));
        await flush();
        act(() => c.moveTo(4));
        await flush();
        expect(getEncDisplayState(c.ref.current).phase).toBe('zoom-in');
        act(() => c.moveTo(12));
        await flush();
        expect(getEncDisplayState(c.ref.current)).toEqual({ phase: 'loaded', overview: false, loadedCells: 4 });
        expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it('does not keep low-zoom plotting floors when the plot is closed with ENC off', async () => {
        const c = chart(5.6);
        const hook = renderHook(
            ({ plotting }) => useEncVectorLayer(c.ref, true, false, true, 2.9, undefined, plotting),
            {
                initialProps: { plotting: true },
            },
        );
        await flush();
        hook.rerender({ plotting: false });
        await flush();
        expect(mocks.overview).toHaveBeenLastCalledWith(c.ref.current, false);
        expect(mocks.visibility).toHaveBeenLastCalledWith(c.ref.current, false);
        expect(getEncDisplayState(c.ref.current).phase).toBe('off');
        expect(mocks.merge).toHaveBeenCalledOnce();
    });
});
