import { afterEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { createEmptyMergedVectorData } from '../services/enc/EncHazardService';
import { refreshEncAsyncLayers, refreshEncVectorData } from '../components/map/EncVectorLayer';

function chart() {
    let removed = false;
    const handlers = new Map<string, () => void>();
    const setData = vi.fn();
    const areTilesLoaded = vi.fn(() => {
        if (removed) throw new Error('Mapbox style removed');
        return false;
    });
    const map = {
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        getSource: () => ({ setData }),
        getLayer: () => undefined,
        isMoving: () => false,
        areTilesLoaded,
        triggerRepaint: vi.fn(),
    } as unknown as mapboxgl.Map;
    return {
        map,
        setData,
        areTilesLoaded,
        remove: () => {
            removed = true;
            handlers.get('remove')?.();
        },
    };
}

afterEach(() => vi.useRealTimers());

describe('ENC uploads belong to their map', () => {
    it('abandons delayed uploads before querying a removed map style', () => {
        vi.useFakeTimers();
        const target = chart();
        refreshEncVectorData(target.map, createEmptyMergedVectorData());
        const before = target.areTilesLoaded.mock.calls.length;
        target.remove();
        expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
        expect(target.areTilesLoaded).toHaveBeenCalledTimes(before);
        expect(target.setData).not.toHaveBeenCalled();
    });

    it('opening a second map does not cancel the first map upload', () => {
        vi.useFakeTimers();
        const first = chart();
        const second = chart();
        refreshEncVectorData(first.map, createEmptyMergedVectorData());
        refreshEncVectorData(second.map, createEmptyMergedVectorData());
        vi.advanceTimersByTime(5000);
        expect(first.setData.mock.calls.length).toBeGreaterThan(10);
        expect(second.setData.mock.calls.length).toBe(first.setData.mock.calls.length);
    });

    it('deduplicates worker upgrades per map, not across both panes', () => {
        const first = chart();
        const second = chart();
        const data = createEmptyMergedVectorData();
        refreshEncAsyncLayers(first.map, data);
        refreshEncAsyncLayers(second.map, data);
        expect(first.setData).toHaveBeenCalledTimes(2);
        expect(second.setData).toHaveBeenCalledTimes(2);
        refreshEncAsyncLayers(first.map, data);
        expect(first.setData).toHaveBeenCalledTimes(2);
        first.remove();
        refreshEncAsyncLayers(first.map, createEmptyMergedVectorData());
        expect(first.setData).toHaveBeenCalledTimes(2);
    });
});
