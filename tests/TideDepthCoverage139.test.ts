import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Polygon } from 'geojson';
const h = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('martinez-polygon-clipping', async (importOriginal) => {
    const actual = await importOriginal<typeof import('martinez-polygon-clipping')>();
    return {
        ...actual,
        union: (...args: Parameters<typeof actual.union>) => {
            h.calls++;
            if (h.fail) throw Error('Exact boolean operation failed.');
            return actual.union(...args);
        },
    };
});
import { buildTideDepthCoverage } from '../services/enc/tideDepthCoverage';
import { holdingGeometryRelation } from '../services/enc/holdingFootprint';
const rect = (w: number, s: number, e: number, n: number, depth: number): Feature<Polygon> => ({
    type: 'Feature',
    properties: { DRVAL1: depth },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const bounds = [-2, -2, 2, 2] as const,
    box = [-0.2, -0.2, 0.2, 0.2] as const;
const covered = (geometry: Polygon | GeoJSON.MultiPolygon, b = box) =>
    holdingGeometryRelation(geometry, b, () => {}).covers;
beforeEach(() => {
    h.fail = false;
    h.calls = 0;
});
describe('exact original positive-depth coverage, no sampled or hull fallback', () => {
    it('proves an adjoining original shallow/deep seam while preserving the lower bound', () => {
        const left = rect(-1, -1, 0, 1, 1),
            right = rect(0, -1, 1, 1, 5);
        expect(covered(left.geometry)).toBe(false);
        expect(covered(right.geometry)).toBe(false);
        const result = buildTideDepthCoverage([left, right], bounds, () => {})!;
        expect(covered(result.geometry)).toBe(true);
        expect(result.minimumAt(box)).toBe(1);
        expect(result.minimumAt([0.3, -0.2, 0.6, 0.2])).toBe(5);
    });
    it('does not close a narrow missing strip between original areas', () => {
        const result = buildTideDepthCoverage(
            [rect(-1, -1, -0.00001, 1, 1), rect(0.00001, -1, 1, 1, 5)],
            bounds,
            () => {},
        )!;
        expect(covered(result.geometry)).toBe(false);
    });
    it('preserves an original hole', () => {
        const original = rect(-1, -1, 1, 1, 1);
        original.geometry.coordinates.push([
            [-0.1, -0.1],
            [-0.1, 0.1],
            [0.1, 0.1],
            [0.1, -0.1],
            [-0.1, -0.1],
        ]);
        const result = buildTideDepthCoverage([original], bounds, () => {})!;
        expect(covered(result.geometry)).toBe(false);
    });
    it('subtracts a signed drying overlap instead of crediting positive water over it', () => {
        const result = buildTideDepthCoverage(
            [rect(-1, -1, 1, 1, 5), rect(-0.1, -0.1, 0.1, 0.1, -0.2)],
            bounds,
            () => {},
        )!;
        expect(covered(result.geometry)).toBe(false);
        expect(result.minimumAt([-0.05, -0.05, 0.05, 0.05])).toBe(-0.2);
    });
    it('unknown numeric depth is held, never treated as zero or skipped', () => {
        const original = rect(-1, -1, 1, 1, 1);
        original.properties!.DRVAL1 = 'unknown';
        expect(() => buildTideDepthCoverage([original], bounds, () => {})).toThrow(/unknown/);
    });
    it('a failed boolean operation has no rectangle or previous-geometry fallback', () => {
        h.fail = true;
        expect(() => buildTideDepthCoverage([rect(-1, -1, 0, 1, 1), rect(0, -1, 1, 1, 5)], bounds, () => {})).toThrow(
            /operation failed/,
        );
    });
    it('rejects excessive quadratic work before invoking the existing library', () => {
        const circle = (x: number): Feature<Polygon> => {
            const ring = Array.from({ length: 70 }, (_, i) => [
                x + 0.8 * Math.cos((i * 2 * Math.PI) / 70),
                0.8 * Math.sin((i * 2 * Math.PI) / 70),
            ]);
            ring.push([...ring[0]]);
            return { type: 'Feature', properties: { DRVAL1: 1 }, geometry: { type: 'Polygon', coordinates: [ring] } };
        };
        expect(() => buildTideDepthCoverage([circle(-0.1), circle(0.1)], bounds, () => {})).toThrow(
            /existing clipping work bound/,
        );
        expect(h.calls).toBe(0);
    });
});
