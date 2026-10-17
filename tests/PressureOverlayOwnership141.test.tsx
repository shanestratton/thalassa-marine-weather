import { ownedVectorFixture } from './helpers/ownedVectorFixture';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtmosView } from '../services/weather/api/atmosSession';
import { usePressureSymbolOverlay } from '../components/map/usePressureSymbolOverlay';
import { toast } from '../components/Toast';

vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));
vi.mock('../services/weather/atmosPressure', () => ({
    atmosPressureSymbols: () => ({
        contours: { type: 'FeatureCollection', features: [] },
        centers: { type: 'FeatureCollection', features: [] },
    }),
}));
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('bounded pressure vector ownership', () => {
    it('shares the map with the standalone pressure image without colliding with or removing that owner', () => {
        const f = ownedVectorFixture();
        const image = {};
        f.map.sources.set('atmos-pressure-source', image);
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        expect(f.map.sources.size).toBe(2);
        expect(f.map.sources.get('atmos-pressure-symbols-source')).toBeDefined();
        hook.unmount();
        expect(f.map.sources.size).toBe(1);
        expect(f.map.sources.get('atmos-pressure-source')).toBe(image);
    });
    it('requires actual current source content before ready and removes all dependent layers before their shared source', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        expect(hook.result.current).toBe('loading');
        expect(f.map.sources.size).toBe(1);
        expect(f.map.addLayer).toHaveBeenCalledTimes(3);
        act(() => f.map.content());
        expect(hook.result.current).toBe('ready');
        hook.unmount();
        expect(f.map.sources.size).toBe(0);
        expect(f.map.removeSource.mock.results.every((result) => result.type === 'return')).toBe(true);
        expect(f.map.getStyle().layers.every((layer) => !layer.id.startsWith('atmos-pressure'))).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the previous UTC before a replacement and never leaves old lines while the next view is missing', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(
            ({ view }) => usePressureSymbolOverlay(f.mapRef, true, true, view, 'Original IFS credit'),
            { initialProps: { view: f.view as AtmosView | null } },
        );
        act(() => f.map.content());
        hook.rerender({ view: null });
        expect(f.map.sources.size).toBe(0);
        expect(hook.result.current).toBe('unavailable');
    });

    it('accepts the actual first GeoJSON worker metadata completion only for the current owned source', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        act(() => f.map.emit('sourcedata', { sourceId: 'foreign', sourceDataType: 'metadata' }));
        expect(hook.result.current).toBe('loading');
        act(() => f.map.emit('sourcedata', { sourceId: 'atmos-pressure-symbols-source', sourceDataType: 'metadata' }));
        expect(hook.result.current).toBe('ready');
        f.retire();
        act(() => f.map.emit('sourcedata', { sourceId: 'atmos-pressure-symbols-source', sourceDataType: 'metadata' }));
        expect(hook.result.current).toBe('unavailable');
    });

    it('retires at the original source lifetime and refuses a late old content event', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        f.retire();
        act(() => f.map.content());
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.sources.size).toBe(0);
        act(() => f.map.content());
        expect(hook.result.current).not.toBe('ready');
    });

    it('retains an honest attributed warning when both removal and hiding are no-ops, including after user-off', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(
            ({ enabled }) => usePressureSymbolOverlay(f.mapRef, true, enabled, f.view, 'Original IFS credit'),
            { initialProps: { enabled: true } },
        );
        f.map.removeLayer.mockImplementation(() => undefined);
        f.map.setLayoutProperty.mockImplementation(() => undefined);
        hook.rerender({ enabled: false });
        expect(hook.result.current).toBe('stuck-visible');
        expect(toast.persistentError).toHaveBeenCalledWith(
            expect.stringContaining('Original IFS credit'),
            expect.anything(),
        );
        expect(f.map.sources.size).toBe(1);
        // Actual map removal proves the old scene can no longer paint, even if disposed lookups retain objects.
        act(() => f.map.emit('remove'));
        expect(hook.result.current).toBe('off');
    });

    it('never removes a foreign namespace and retains its warning until map removal proves no scene', () => {
        const f = ownedVectorFixture();
        const foreign = {};
        f.map.sources.set('atmos-pressure-symbols-source', foreign);
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        expect(hook.result.current).toBe('stuck-visible');
        expect(f.map.sources.get('atmos-pressure-symbols-source')).toBe(foreign);
        expect(f.map.removeSource).not.toHaveBeenCalled();
        act(() => f.map.emit('remove'));
        expect(hook.result.current).toBe('off');
    });

    it('rebuilds a changed style only while the exact original source remains current', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        act(() => f.map.content());
        act(() => f.map.restyle());
        expect(f.map.addSource).toHaveBeenCalledTimes(2);
        expect(hook.result.current).toBe('loading');
        f.retire();
        act(() => f.map.restyle());
        expect(f.map.addSource).toHaveBeenCalledTimes(2);
        expect(hook.result.current).toBe('unavailable');
    });

    it('holds a source that never delivers real content after the bounded render deadline', () => {
        const f = ownedVectorFixture();
        const hook = renderHook(() => usePressureSymbolOverlay(f.mapRef, true, true, f.view, 'Original IFS credit'));
        act(() => vi.advanceTimersByTime(10_001));
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.sources.size).toBe(0);
    });
});
