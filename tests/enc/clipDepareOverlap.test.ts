/**
 * clipDepareOverlap — the render-merge de-duplication that stops the
 * satellite glaze double-painting where coarse and fine cells overlap.
 * Invariants: area is conserved (big minus hole), pieces never overlap,
 * holes survive, untouched features come back by IDENTITY (no churn).
 */
import { describe, it, expect } from 'vitest';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { clipFeatureOutsideBboxes, clipLineFeatureOutsideBboxes } from '../../services/enc/clipDepareOverlap';

const rect = (minX: number, minY: number, maxX: number, maxY: number): Position[] => [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
];

const feat = (coords: Position[][]): Feature => ({
    type: 'Feature',
    properties: { DRVAL1: 0, DRVAL2: 2 },
    geometry: { type: 'Polygon', coordinates: coords },
});

/** Shoelace area of one ring (abs). */
function ringArea(ring: Position[]): number {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return Math.abs(a / 2);
}

/** Net polygon area: outer minus holes, summed over a (Multi)Polygon. */
function featureArea(f: Feature): number {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let total = 0;
    for (const p of polys) {
        total += ringArea(p[0]);
        for (let h = 1; h < p.length; h++) total -= ringArea(p[h]);
    }
    return total;
}

describe('clipDepareOverlap — glaze de-duplication geometry', () => {
    it('subtracting a centred bbox conserves area exactly (big minus hole)', () => {
        const f = feat([rect(0, 0, 10, 10)]); // area 100
        const out = clipFeatureOutsideBboxes(f, [[4, 4, 6, 6]]); // hole area 4
        expect(out).not.toBeNull();
        expect(featureArea(out!)).toBeCloseTo(96, 6);
    });

    it('pieces are disjoint — total equals sum of parts, no double-paint', () => {
        // Two overlapping holes: total removed = union area, not the sum.
        const f = feat([rect(0, 0, 10, 10)]);
        const out = clipFeatureOutsideBboxes(f, [
            [2, 2, 6, 6], // 16
            [4, 4, 8, 8], // 16, overlaps previous by 4 → union 28
        ]);
        expect(featureArea(out!)).toBeCloseTo(100 - 28, 6);
    });

    it('keeps holes (island in a depth band) through the clip', () => {
        const f = feat([rect(0, 0, 10, 10), rect(1, 1, 3, 3)]); // 100 - 4 = 96
        const out = clipFeatureOutsideBboxes(f, [[6, 0, 10, 10]]); // right 40 gone (no island there)
        expect(featureArea(out!)).toBeCloseTo(96 - 40, 6);
    });

    it('returns the ORIGINAL object when nothing overlaps (identity fast path)', () => {
        const f = feat([rect(0, 0, 10, 10)]);
        const out = clipFeatureOutsideBboxes(f, [[20, 20, 30, 30]]);
        expect(out).toBe(f);
    });

    it('returns null when the finer coverage swallows the feature whole', () => {
        const f = feat([rect(2, 2, 4, 4)]);
        expect(clipFeatureOutsideBboxes(f, [[0, 0, 10, 10]])).toBeNull();
    });

    it('never mutates the input feature', () => {
        const f = feat([rect(0, 0, 10, 10)]);
        const snapshot = JSON.stringify(f);
        clipFeatureOutsideBboxes(f, [[4, 4, 6, 6]]);
        expect(JSON.stringify(f)).toBe(snapshot);
    });
});

describe('clipDepareOverlap — line edition (contours/coastlines)', () => {
    const line = (coords: Position[]): Feature => ({
        type: 'Feature',
        properties: { VALDCO: 5 },
        geometry: { type: 'LineString', coordinates: coords },
    });

    it('a line crossing finer coverage splits with the covered middle removed', () => {
        const f = line([
            [0, 5],
            [10, 5],
        ]);
        const out = clipLineFeatureOutsideBboxes(f, [[4, 0, 6, 10]]);
        expect(out).not.toBeNull();
        expect(out!.geometry.type).toBe('MultiLineString');
        const parts = (out!.geometry as { coordinates: Position[][] }).coordinates;
        expect(parts).toHaveLength(2);
        expect(parts[0][1][0]).toBeCloseTo(4, 9); // first piece ends at the bbox edge
        expect(parts[1][0][0]).toBeCloseTo(6, 9); // second resumes past it
    });

    it('a line fully inside finer coverage vanishes', () => {
        const f = line([
            [4.5, 5],
            [5.5, 5],
        ]);
        expect(clipLineFeatureOutsideBboxes(f, [[4, 0, 6, 10]])).toBeNull();
    });

    it('a clear line returns by identity', () => {
        const f = line([
            [0, 20],
            [10, 20],
        ]);
        expect(clipLineFeatureOutsideBboxes(f, [[4, 0, 6, 10]])).toBe(f);
    });
});
