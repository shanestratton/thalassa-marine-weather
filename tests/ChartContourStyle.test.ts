import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { buildDepareFillColor, buildDepcntLabelField, DEPARE_BAND_COLORS } from '../components/map/encDepthStyle';
import {
    depthStyleState,
    setEncContourBands,
    setEncTideOffset,
    updateEncDepthStyle,
} from '../components/map/encDepthStyleState';
import { ENC_VEC_LAYERS, ENC_WATER_FILL_LAYERS } from '../components/map/encLayerIds';
import { evalExpr } from './enc/exprEval';
const custom = { shallowM: 2, safetyM: 6, deepM: 30, reliefSafety: true };
beforeEach(() => localStorage.clear());
describe('custom DEPARE display bands', () => {
    it('evaluates all four bounded S-52-style bands, exact boundaries, drying and lowercase attributes', () => {
        for (const [depth, colour] of [
            [-0.1, DEPARE_BAND_COLORS.drying],
            [0, DEPARE_BAND_COLORS.b0to2],
            [1.9, DEPARE_BAND_COLORS.b0to2],
            [2, DEPARE_BAND_COLORS.b2to5],
            [5.9, DEPARE_BAND_COLORS.b2to5],
            [6, DEPARE_BAND_COLORS.b10to20],
            [29.9, DEPARE_BAND_COLORS.b10to20],
            [30, DEPARE_BAND_COLORS.b50plus],
        ] as const) {
            expect(evalExpr(buildDepareFillColor(0, custom), { props: { drval1: depth } })).toBe(colour);
        }
    });
    it('leaves unknown depth unpainted, and refuses corrupt/unordered preferences instead of constructing invalid stops', () => {
        for (const value of [undefined, null, 'garbage', NaN])
            expect(
                evalExpr(buildDepareFillColor(0, custom), { props: JSON.parse(JSON.stringify({ DRVAL1: value })) }),
            ).toBe('rgba(0,0,0,0)');
        expect(buildDepareFillColor(0, { ...custom, safetyM: 1 })).toEqual(buildDepareFillColor());
        // Explicit JSON null is common in converted cells, not a measured zero.
        for (const props of [{ DRVAL1: null }, { drval1: null }])
            expect(evalExpr(buildDepareFillColor(), { props })).toBe('rgba(0,0,0,0)');
        for (const props of [{ VALDCO: null }, { valdco: null }])
            expect(evalExpr(buildDepcntLabelField(), { props })).toBe('');
    });
    it('keeps a datum-based physical keel and worst-case hazard threshold separate from a chosen deeper contour', () => {
        const filters = new Map<string, unknown>();
        const paint = vi.fn();
        const map = {
            getLayer: (id: string) => (id === ENC_VEC_LAYERS.DEPARE ? undefined : { id }),
            setFilter: (id: string, expr: unknown) => filters.set(id, expr),
            setPaintProperty: paint,
            setLayoutProperty: vi.fn(),
        } as unknown as mapboxgl.Map;
        depthStyleState.set(map, {
            safetyDepthM: 3,
            hazardDepthM: 5,
            depcntValdcosByCell: { coarse: [0, 5, 10, 20], fine: [0, 3, 6, 20] },
        });
        setEncContourBands(map, custom);
        const bold = (cell: string, VALDCO: number) =>
            evalExpr(filters.get(ENC_VEC_LAYERS.DEPCNT_SAFETY), { props: { _cellId: cell, VALDCO } });
        expect(bold('coarse', 10)).toBe(true);
        expect(bold('coarse', 5)).toBe(false);
        expect(bold('fine', 6)).toBe(true);
        expect(depthStyleState.get(map)).toMatchObject({ safetyDepthM: 3, hazardDepthM: 5 });
        // A new vessel/draft raises the effective display floor; stored choice is retained.
        updateEncDepthStyle(map, 8, 12);
        expect(bold('fine', 6)).toBe(false);
        expect(bold('fine', 20)).toBe(true);
        expect(depthStyleState.get(map)).toMatchObject({ safetyDepthM: 8, hazardDepthM: 12, contours: custom });
        // Synthetic visual tide-offset math never moves the datum contour.
        const before = filters.get(ENC_VEC_LAYERS.DEPCNT_SAFETY);
        setEncTideOffset(map, 4, Date.now() + 60000);
        expect(filters.get(ENC_VEC_LAYERS.DEPCNT_SAFETY)).toBe(before);
        expect(paint.mock.calls.some(([id]) => ENC_WATER_FILL_LAYERS.includes(id))).toBe(true);
        setEncContourBands(map, null);
        expect(depthStyleState.get(map)?.contours).toBeNull();
        expect(bold('coarse', 10)).toBe(true);
    });
});
