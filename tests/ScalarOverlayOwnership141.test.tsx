import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { useScalarGridOverlay, type ScalarOverlayOptions } from '../components/map/useScalarGridOverlay';
import type { ScalarGrid } from '../services/weather/scalarGridImage';
import { toast } from '../components/Toast';

vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));

type Layer = { id: string; type?: string; source?: string; layout?: { visibility?: string } };
function mapFixture() {
    const sources = new Map<string, object>();
    let layers: Layer[] = [
        { id: 'hybrid-base-layer', type: 'raster' },
        { id: 'enc-vec-depth', type: 'fill' },
    ];
    const events = new Map<string, Set<(event: unknown) => void>>();
    let loaded = false;
    const map = {
        sources,
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.find((layer) => layer.id === id),
        getStyle: () => ({ layers }),
        on: (name: string, callback: (event: unknown) => void) => {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name)!.add(callback);
        },
        off: (name: string, callback: (event: unknown) => void) => {
            events.get(name)?.delete(callback);
        },
        emit: (name: string, event: unknown = {}) => {
            for (const callback of [...(events.get(name) ?? [])]) callback(event);
        },
        addSource: vi.fn((id: string, value: object) => {
            sources.set(id, { ...value, updateImage: vi.fn() });
        }),
        addLayer: vi.fn((layer: Layer, before?: string) => {
            const index = layers.findIndex((item) => item.id === before);
            layers.splice(index < 0 ? layers.length : index, 0, layer);
        }),
        removeSource: vi.fn((id: string) => {
            sources.delete(id);
        }),
        removeLayer: vi.fn((id: string) => {
            layers = layers.filter((layer) => layer.id !== id);
        }),
        setLayoutProperty: vi.fn((id: string, _key: string, value: string) => {
            const layer = layers.find((layer) => layer.id === id);
            if (layer) layer.layout = { visibility: value };
        }),
        getLayoutProperty: (id: string) => layers.find((layer) => layer.id === id)?.layout?.visibility ?? 'visible',
        moveLayer: vi.fn((id: string, before?: string) => {
            const layer = layers.find((item) => item.id === id)!;
            layers = layers.filter((item) => item.id !== id);
            const index = layers.findIndex((item) => item.id === before);
            layers.splice(index < 0 ? layers.length : index, 0, layer);
        }),
        isSourceLoaded: () => loaded,
        content: () => {
            loaded = true;
            map.emit('sourcedata', { sourceId: 'scalar-test-source', sourceDataType: 'content' });
        },
        restyle: (next: Layer[]) => {
            sources.clear();
            layers = next;
            map.emit('style.load');
        },
        setLayers: (next: Layer[]) => {
            layers = next;
        },
    };
    return map;
}
const grid: ScalarGrid = {
    width: 2,
    height: 2,
    west: -10,
    south: -10,
    dx: 20,
    dy: 20,
    values: new Float32Array([0, 10, 20, 30]),
    validMask: new Uint8Array([1, 1, 1, 1]),
};
const active: ScalarOverlayOptions = {
    id: 'scalar-test',
    label: 'Observed scalar',
    credit: 'Original provider attribution',
    enabled: true,
    grid,
    stops: [
        [0, 0, 0, 0, 0],
        [30, 100, 100, 100, 180],
    ],
    revision: 'generation-field-validtime',
    sourceCurrent: () => true,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () =>
            ({
                createImageData: (width: number, height: number) => ({
                    width,
                    height,
                    data: new Uint8ClampedArray(width * height * 4),
                }),
                putImageData: vi.fn(),
            }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,fixture');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('one owned scalar image presentation', () => {
    it('publishes one bounded image below the chart and reports ready only after actual source content', () => {
        const map = mapFixture();
        const { result, unmount } = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, active),
        );
        expect(result.current).toBe('loading');
        expect(map.addSource).toHaveBeenCalledTimes(1);
        expect(map.getStyle().layers.map((layer) => layer.id)).toEqual([
            'hybrid-base-layer',
            'scalar-test-layer',
            'enc-vec-depth',
        ]);
        expect(map.addLayer.mock.calls[0][0]).toMatchObject({ paint: { 'raster-resampling': 'nearest' } });
        act(() => map.content());
        expect(result.current).toBe('ready');
        unmount();
        expect(map.sources.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes the old revision before a replacement and never keeps old pixels when data is absent', () => {
        const map = mapFixture();
        const { result, rerender, unmount } = renderHook(
            (props: ScalarOverlayOptions) =>
                useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, props),
            { initialProps: active },
        );
        const previous = map.getSource('scalar-test-source');
        rerender({ ...active, revision: 'replacement', grid: { ...grid, values: new Float32Array([1, 1, 1, 1]) } });
        expect(map.removeSource).toHaveBeenCalledTimes(1);
        expect(map.getSource('scalar-test-source')).not.toBe(previous);
        rerender({ ...active, revision: 'loading-new-source', grid: null });
        expect(result.current).toBe('unavailable');
        expect(map.sources.size).toBe(0);
        unmount();
    });

    it('retires on a source clock/ownership fence and ignores a later source-ready event', () => {
        const map = mapFixture();
        let current = true;
        const { result, unmount } = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, {
                ...active,
                sourceCurrent: () => current,
            }),
        );
        current = false;
        act(() => vi.advanceTimersByTime(1000));
        expect(result.current).toBe('unavailable');
        expect(map.sources.size).toBe(0);
        act(() => map.content());
        expect(result.current).toBe('unavailable');
        unmount();
    });

    it('refuses canvas or source failures and a source that never becomes ready', () => {
        const map = mapFixture();
        const { result, unmount } = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, active),
        );
        act(() => vi.advanceTimersByTime(10_000));
        expect(result.current).toBe('unavailable');
        expect(map.sources.size).toBe(0);
        unmount();
        vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:,');
        const second = mapFixture();
        const failed = renderHook(() =>
            useScalarGridOverlay({ current: second as unknown as mapboxgl.Map }, true, active),
        );
        expect(failed.result.current).toBe('unavailable');
        expect(second.addSource).not.toHaveBeenCalled();
        failed.unmount();
    });

    it('cannot clear another owner or install on an existing colliding source', () => {
        const map = mapFixture();
        const foreign = {};
        map.sources.set('scalar-test-source', foreign);
        const blocked = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, active),
        );
        expect(blocked.result.current).toBe('stuck-visible');
        blocked.unmount();
        expect(map.getSource('scalar-test-source')).toBe(foreign);
        expect(map.removeSource).not.toHaveBeenCalled();
        map.sources.clear();
        const own = renderHook(() => useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, active));
        map.sources.set('scalar-test-source', foreign);
        own.unmount();
        expect(map.getSource('scalar-test-source')).toBe(foreign);
        act(() => map.emit('remove'));
    });

    it('rebuilds only a current source after style reload and heals late imagery/chart order without churn', () => {
        const map = mapFixture();
        const { unmount } = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, active),
        );
        act(() =>
            map.restyle([
                { id: 'hybrid-base-layer', type: 'raster' },
                { id: 'enc-vec-depth', type: 'fill' },
            ]),
        );
        expect(map.addSource).toHaveBeenCalledTimes(2);
        map.setLayers([
            { id: 'enc-vec-depth' },
            { id: 'scalar-test-layer', source: 'scalar-test-source' },
            { id: 'hybrid-base-layer' },
        ]);
        act(() => map.emit('styledata'));
        expect(map.getStyle().layers.map((layer) => layer.id)).toEqual([
            'scalar-test-layer',
            'enc-vec-depth',
            'hybrid-base-layer',
        ]);
        const moves = map.moveLayer.mock.calls.length;
        act(() => map.emit('styledata'));
        expect(map.moveLayer).toHaveBeenCalledTimes(moves);
        unmount();
    });

    it('stops before publication if the owner retires during PNG encoding', () => {
        const map = mapFixture();
        let current = true;
        vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => {
            current = false;
            return 'data:image/png;base64,fixture';
        });
        const hook = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, {
                ...active,
                sourceCurrent: () => current,
            }),
        );
        expect(hook.result.current).toBe('unavailable');
        expect(map.addSource).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('does no canvas or map work while disabled', () => {
        const map = mapFixture();
        const hook = renderHook(() =>
            useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, { ...active, enabled: false }),
        );
        expect(hook.result.current).toBe('off');
        expect(map.addSource).not.toHaveBeenCalled();
        expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
        hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a healthy inline proof ready but immediately retires a replacement false proof', () => {
        const map = mapFixture();
        const hook = renderHook(
            (props: { current: boolean }) =>
                useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, {
                    ...active,
                    sourceCurrent: () => props.current,
                }),
            { initialProps: { current: true } },
        );
        act(() => map.content());
        expect(hook.result.current).toBe('ready');
        const paints = map.addSource.mock.calls.length;
        hook.rerender({ current: true });
        expect(hook.result.current).toBe('ready');
        expect(map.addSource).toHaveBeenCalledTimes(paints);
        hook.rerender({ current: false });
        expect(hook.result.current).toBe('unavailable');
        expect(map.sources.size).toBe(0);
        hook.unmount();
    });

    it('retains warning and attribution on a no-op remove and unverified hide even after user off', () => {
        const map = mapFixture();
        const remove = map.removeLayer.getMockImplementation()!;
        const hide = map.setLayoutProperty.getMockImplementation()!;
        const hook = renderHook(
            (props: ScalarOverlayOptions) =>
                useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, props),
            { initialProps: active },
        );
        map.removeLayer.mockImplementation(() => undefined);
        map.setLayoutProperty.mockImplementation(() => undefined);
        hook.rerender({ ...active, enabled: false });
        expect(hook.result.current).toBe('stuck-visible');
        expect(map.getLayer('scalar-test-layer')).toBeDefined();
        expect(toast.persistentError).toHaveBeenCalledWith(expect.stringContaining(active.credit), expect.any(Object));
        expect(map.removeSource).not.toHaveBeenCalled();
        map.removeLayer.mockImplementation(remove);
        map.setLayoutProperty.mockImplementation(hide);
        act(() => map.emit('idle'));
        expect(hook.result.current).toBe('off');
        expect(map.sources.size).toBe(0);
        expect(toast.dismiss).toHaveBeenCalled();
        hook.unmount();
    });

    it('accepts only read-back hidden presentation while retaining bounded source ownership until absence', () => {
        const map = mapFixture();
        const remove = map.removeLayer.getMockImplementation()!;
        const hook = renderHook(
            (props: ScalarOverlayOptions) =>
                useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, props),
            { initialProps: active },
        );
        map.removeLayer.mockImplementation(() => {
            throw new Error('style busy');
        });
        hook.rerender({ ...active, enabled: false });
        expect(hook.result.current).toBe('off');
        expect(map.getLayoutProperty('scalar-test-layer')).toBe('none');
        expect(map.sources.size).toBe(1);
        hook.rerender({ ...active, revision: 'new-cohort' });
        expect(hook.result.current).toBe('unavailable');
        expect(map.addSource).toHaveBeenCalledTimes(1);
        map.removeLayer.mockImplementation(remove);
        act(() => map.emit('idle'));
        expect(map.sources.size).toBe(0);
        hook.rerender({ ...active, revision: 'after-proven-removal' });
        expect(map.addSource).toHaveBeenCalledTimes(2);
        hook.unmount();
    });

    it('does not assume source removal succeeded and ends retirement on actual map removal', () => {
        const map = mapFixture();
        const hook = renderHook(
            (props: ScalarOverlayOptions) =>
                useScalarGridOverlay({ current: map as unknown as mapboxgl.Map }, true, props),
            { initialProps: active },
        );
        map.removeSource.mockImplementation(() => undefined);
        hook.rerender({ ...active, enabled: false });
        expect(hook.result.current).toBe('off');
        expect(map.getLayer('scalar-test-layer')).toBeUndefined();
        expect(map.sources.size).toBe(1);
        hook.rerender({ ...active, revision: 'blocked-by-retained-resource' });
        expect(hook.result.current).toBe('unavailable');
        expect(map.addSource).toHaveBeenCalledTimes(1);
        act(() => {
            map.sources.clear();
            map.emit('remove');
        });
        expect(hook.result.current).toBe('off');
        hook.unmount();
    });
});
