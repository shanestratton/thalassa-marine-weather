import { describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { depthIndex, LIGHT_PALETTE, reliefIndexRamp, setReliefPalette } from '../components/map/reliefBase';
describe('client Relief safety marker', () => {
    it('retains the exact original ramp when off/invalid, with finite strictly increasing index stops', () => {
        const legacy = reliefIndexRamp(LIGHT_PALETTE.ramp);
        for (const bad of [null, NaN, Infinity, -1, 0, 0.3, 6001])
            expect(reliefIndexRamp(LIGHT_PALETTE.ramp, bad)).toEqual(legacy);
        const stops = (legacy as unknown[]).slice(3).filter((_, i) => i % 2 === 0) as number[];
        expect(stops.every((n, i) => Number.isFinite(n) && (i === 0 || n > stops[i - 1]))).toBe(true);
        expect(stops.at(-1)).toBe(255);
    });
    it('keeps unknown/land index0 and non-water255 transparent and rounds the coarse cutoff upward, without fabricating geometry', () => {
        for (const depth of [0.31, 1, 2, 3, 5, 30, 5999, 6000]) {
            const expression = reliefIndexRamp(LIGHT_PALETTE.ramp, depth) as unknown[];
            expect(expression[0]).toBe('case');
            expect(expression[1]).toEqual(['all', ['>', ['raster-value'], 0], ['<=', ['raster-value'], 254]]);
            expect(expression[3]).toBe('rgba(0,0,0,0)');
            expect((expression[2] as unknown[])[1]).toEqual(['<=', ['raster-value'], Math.ceil(depthIndex(depth))]);
        }
    });
    it('repaints only a changed palette/threshold, retains the explicit threshold on palette changes and supports reset', () => {
        const paint = vi.fn();
        const map = {
            getLayer: () => ({ minzoom: 0, maxzoom: 11 }),
            getStyle: () => ({ layers: [] }),
            setPaintProperty: paint,
            setLayerZoomRange: vi.fn(),
        } as unknown as mapboxgl.Map;
        expect(setReliefPalette(map, 'day', 3)).toBe(true);
        paint.mockClear();
        expect(setReliefPalette(map, 'day', 3)).toBe(false);
        expect(paint).not.toHaveBeenCalled();
        expect(setReliefPalette(map, 'day', 5)).toBe(true);
        expect(setReliefPalette(map, 'night')).toBe(true);
        const ramp = paint.mock.calls.filter(([, prop]) => prop === 'raster-color').at(-1)![2] as unknown[];
        expect((ramp[2] as unknown[])[1]).toEqual(['<=', ['raster-value'], Math.ceil(depthIndex(5))]);
        expect(setReliefPalette(map, 'night', null)).toBe(true);
        expect(setReliefPalette(map, 'night', null)).toBe(false);
    });
});
