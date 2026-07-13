/**
 * True-coverage glaze clipping (the "shaded areas inshore" bug,
 * 2026-07-12): subtracting a finer cell's data-extent RECTANGLE left
 * glaze holes wherever the fine survey charts only part of that
 * rectangle — hard-edged dark boxes of raw imagery over perfectly
 * charted coarse water. clipFeatureOutsideCoverage subtracts the
 * finer cell's ACTUAL charted polygons instead.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { clipFeatureOutsideCoverage, type FineCoverage } from '../../services/enc/clipDepareOverlap';

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

const coarseBand: Feature = {
    type: 'Feature',
    properties: { DRVAL1: 5 },
    geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
};

// Fine survey: data-extent rect [0,0,6,6], but ACTUAL charted water is
// only an L-shape hugging two sides — the rect's inner corner is
// uncharted by the fine cell.
const fineL: FineCoverage = {
    bbox: [0, 0, 6, 6],
    coverage: [
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
    ],
};

describe('clipFeatureOutsideCoverage — true coverage, not rectangles', () => {
    it('removes only what the fine survey actually charts; the rect-minus-L region SURVIVES (the hole bug)', () => {
        const out = clipFeatureOutsideCoverage(coarseBand, [fineL]);
        expect(out).not.toBeNull();
        expect(covered(out, 1, 1)).toBe(false); // inside the L — fine survey owns it
        expect(covered(out, 4.5, 4.5)).toBe(true); // inside the rect, OUTSIDE the L — the old clip holed this
        expect(covered(out, 8, 8)).toBe(true); // clear of the fine cell entirely
        expect(out!.properties?.DRVAL1).toBe(5); // props ride along
    });

    it('identity when the coverage bbox never touches the feature', () => {
        const far: FineCoverage = { bbox: [100, 100, 110, 110], coverage: [[square(100, 100, 110, 110)]] };
        expect(clipFeatureOutsideCoverage(coarseBand, [far])).toBe(coarseBand);
    });

    it('returns null when the coverage swallows the feature whole', () => {
        const bigger: FineCoverage = { bbox: [-1, -1, 11, 11], coverage: [[square(-1, -1, 11, 11)]] };
        expect(clipFeatureOutsideCoverage(coarseBand, [bigger])).toBeNull();
    });

    it('subtracts multiple fine cells sequentially', () => {
        const nw: FineCoverage = { bbox: [0, 6, 4, 10], coverage: [[square(0, 6, 4, 10)]] };
        const out = clipFeatureOutsideCoverage(coarseBand, [fineL, nw]);
        expect(covered(out, 1, 1)).toBe(false); // L
        expect(covered(out, 2, 8)).toBe(false); // NW square
        expect(covered(out, 4.5, 4.5)).toBe(true); // still no hole
        expect(covered(out, 8, 2)).toBe(true);
    });

    it('non-polygon features pass through untouched', () => {
        const line: Feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: [
                    [0, 0],
                    [1, 1],
                ],
            },
        };
        expect(clipFeatureOutsideCoverage(line, [fineL])).toBe(line);
    });
});

import { coverageStripRects } from '../../services/enc/clipDepareOverlap';

describe('coverageStripRects — strips hug the survey, not its rectangle', () => {
    const EXT: [number, number, number, number] = [0, 0, 16, 16];
    const inAny = (rects: [number, number, number, number][], x: number, y: number) =>
        rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);

    it('a narrow diagonal corridor leaves the rest of the extent open', () => {
        // Channel-survey shape: feature boxes stepping diagonally.
        const feats: [number, number, number, number][] = [
            [0, 0, 4, 4],
            [3, 3, 7, 7],
            [6, 6, 10, 10],
            [9, 9, 13, 13],
            [12, 12, 16, 16],
        ];
        const rects = coverageStripRects(feats, EXT);
        expect(rects.length).toBeGreaterThan(1); // not the single-extent fallback
        expect(inAny(rects, 2, 2)).toBe(true); // on the corridor — clipped (conservative)
        expect(inAny(rects, 8, 8)).toBe(true); // corridor mid — clipped
        expect(inAny(rects, 14, 2)).toBe(false); // off-corridor — coarse glaze SURVIVES
        expect(inAny(rects, 2, 14)).toBe(false); // off-corridor — the old dark square, now open
    });

    it('no features → the whole extent (old behaviour)', () => {
        expect(coverageStripRects([], EXT)).toEqual([EXT]);
    });

    it('full-extent coverage stays a single rect-equivalent', () => {
        const rects = coverageStripRects([[0, 0, 16, 16]], EXT);
        expect(inAny(rects, 8, 8)).toBe(true);
        expect(inAny(rects, 0.5, 15.5)).toBe(true);
    });
});
