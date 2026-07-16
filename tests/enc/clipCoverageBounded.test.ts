/**
 * BOUNDED true-coverage glaze clip (2026-07-17) — the re-enable
 * precondition from the OOM post-mortem: martinez never sees a
 * subject/clip pair over the vertex cap; over-cap pairs degrade to the
 * strip-rect clip. These tests lock the gate, both fallback grades, the
 * three-state stripRects rule, and the stats the device session tunes
 * the cap from.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import {
    clipFeatureOutsideCoverage,
    coverageVertexCount,
    emptyClipStats,
    GLAZE_MARTINEZ_VERTEX_CAP,
    type CoverageGeom,
    type FineCoverage,
} from '../../services/enc/clipDepareOverlap';

/** Even-odd point-in-result test across every ring of the clipped geometry. */
function covered(feature: Feature | null, x: number, y: number): boolean {
    if (!feature) return false;
    const g = feature.geometry as Polygon | MultiPolygon;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let inside = false;
    for (const poly of polys) {
        for (const ring of poly) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i];
                const [xj, yj] = ring[j];
                if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
            }
        }
    }
    return inside;
}

const square = (x0: number, y0: number, x1: number, y1: number): Position[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];

const coarseBand = (): Feature => ({
    type: 'Feature',
    properties: { DRVAL1: 5 },
    geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
});

// Fine survey: data-extent rect [0,0,6,6], but ACTUAL charted water is
// only an L-shape hugging two sides — the rect's inner corner (4.5, 4.5)
// is uncharted by the fine cell.
const lShape: CoverageGeom = [
    [
        [
            [0, 0],
            [6, 0],
            [6, 3],
            [3, 3],
            [3, 6],
            [0, 6],
            [0, 0],
        ],
    ],
];
const fineL = (): FineCoverage => ({ bbox: [0, 0, 6, 6], coverage: lShape });

describe('coverageVertexCount', () => {
    it('counts every ring vertex across polygons and holes', () => {
        expect(coverageVertexCount(lShape)).toBe(7);
        expect(coverageVertexCount([[square(0, 0, 1, 1), square(0.2, 0.2, 0.8, 0.8)]])).toBe(10);
        expect(coverageVertexCount([])).toBe(0);
    });
});

describe('clipFeatureOutsideCoverage — bounded pairs', () => {
    it('under-cap pair runs exact martinez (L charted → clipped, inner corner kept)', () => {
        const stats = emptyClipStats();
        const out = clipFeatureOutsideCoverage(coarseBand(), [fineL()], GLAZE_MARTINEZ_VERTEX_CAP, stats);
        expect(covered(out, 1, 1)).toBe(false); // inside the L — fine survey owns it
        expect(covered(out, 4.5, 4.5)).toBe(true); // rect's inner corner — fine is silent, coarse keeps painting
        expect(covered(out, 8, 8)).toBe(true); // outside the fine bbox entirely
        expect(stats.pairsExact).toBe(1);
        expect(stats.pairsStripped).toBe(0);
        // subject (5 verts) + coverage (7 verts)
        expect(stats.maxPairVertices).toBe(12);
    });

    it('over-cap pair degrades to the strip-rect clip, never martinez', () => {
        const stats = emptyClipStats();
        // Strips describe only the L's bottom bar — the vertical bar is
        // NOT stripped, so unlike exact clipping it keeps coarse paint.
        const fine: FineCoverage = { ...fineL(), stripRects: [[0, 0, 6, 3]] };
        const out = clipFeatureOutsideCoverage(coarseBand(), [fine], 8, stats);
        expect(stats.pairsExact).toBe(0);
        expect(stats.pairsStripped).toBe(1);
        expect(stats.maxPairVertices).toBe(12);
        expect(covered(out, 1, 1)).toBe(false); // inside the strip → clipped
        expect(covered(out, 1, 5)).toBe(true); // vertical bar not stripped → coarse survives (approximation)
        expect(covered(out, 8, 8)).toBe(true);
    });

    it('over-cap pair with NO stripRects falls back to the data-extent rect', () => {
        const out = clipFeatureOutsideCoverage(coarseBand(), [fineL()], 8);
        // Whole [0,0,6,6] rect clipped — including the uncharted corner
        // (the honest cost of the degraded grade).
        expect(covered(out, 4.5, 4.5)).toBe(false);
        expect(covered(out, 8, 8)).toBe(true);
    });

    it('over-cap pair with EMPTY stripRects clips NOTHING (three-state rule)', () => {
        const feature = coarseBand();
        const stats = emptyClipStats();
        const fine: FineCoverage = { ...fineL(), stripRects: [] };
        const out = clipFeatureOutsideCoverage(feature, [fine], 8, stats);
        expect(out).toBe(feature); // untouched identity — not even a clone
        expect(stats.pairsStripped).toBe(1);
    });

    it('mixed fines: exact under the cap, strips over it, both applied in order', () => {
        const stats = emptyClipStats();
        const under = fineL(); // 5+7 = 12 verts
        const over: FineCoverage = {
            // A dense ring around (8, 8) that busts the cap.
            bbox: [7, 7, 9, 9],
            coverage: [
                [
                    Array.from({ length: 40 }, (_, i): Position => {
                        const a = (i / 39) * 2 * Math.PI;
                        return [8 + Math.cos(a), 8 + Math.sin(a)];
                    }),
                ],
            ],
            stripRects: [[7, 7, 9, 9]],
        };
        const out = clipFeatureOutsideCoverage(coarseBand(), [under, over], 20, stats);
        expect(stats.pairsExact).toBe(1);
        expect(stats.pairsStripped).toBe(1);
        expect(covered(out, 1, 1)).toBe(false); // exact-clipped under the L
        expect(covered(out, 4.5, 4.5)).toBe(true); // exact clip spared the corner
        expect(covered(out, 8, 8)).toBe(false); // strip-clipped under the dense ring's rect
        expect(covered(out, 5, 9)).toBe(true); // untouched elsewhere
    });

    it('strip fallback can swallow the subject whole → null', () => {
        const stats = emptyClipStats();
        const fine: FineCoverage = { ...fineL(), bbox: [0, 0, 10, 10], stripRects: [[0, 0, 10, 10]] };
        const out = clipFeatureOutsideCoverage(coarseBand(), [fine], 8, stats);
        expect(out).toBeNull();
        expect(stats.pairsStripped).toBe(1);
    });

    it('non-overlapping fine is prefiltered — no pair counted at all', () => {
        const feature = coarseBand();
        const stats = emptyClipStats();
        const fine: FineCoverage = { bbox: [20, 20, 30, 30], coverage: [[square(20, 20, 30, 30)]] };
        const out = clipFeatureOutsideCoverage(feature, [fine], 8, stats);
        expect(out).toBe(feature);
        expect(stats.pairsExact + stats.pairsStripped + stats.pairsRectFallback).toBe(0);
        expect(stats.maxPairVertices).toBe(0);
    });

    it('default cap is the exported GLAZE_MARTINEZ_VERTEX_CAP (normal cells clip exact)', () => {
        const stats = emptyClipStats();
        const out = clipFeatureOutsideCoverage(coarseBand(), [fineL()], undefined, stats);
        expect(stats.pairsExact).toBe(1);
        expect(covered(out, 4.5, 4.5)).toBe(true);
        expect(GLAZE_MARTINEZ_VERTEX_CAP).toBeGreaterThan(1000);
    });

    it('subject growth from an earlier clip feeds the next pair gate', () => {
        const stats = emptyClipStats();
        // First fine clips exactly (subject grows past 5 verts as the L is
        // carved out); the second pair's recorded vertex count must reflect
        // the GROWN subject, not the original square.
        const second: FineCoverage = { bbox: [6, 6, 10, 10], coverage: [[square(6, 6, 10, 10)]] };
        clipFeatureOutsideCoverage(coarseBand(), [fineL(), second], GLAZE_MARTINEZ_VERTEX_CAP, stats);
        expect(stats.pairsExact).toBe(2);
        // Pair 1 = 5+7 = 12; pair 2 = grown subject (>5) + 5 > 12.
        expect(stats.maxPairVertices).toBeGreaterThan(12);
    });
});
