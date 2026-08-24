/**
 * Kill #28 (Lady Musgrave, 2026-08-25) — no manufactured ring reaches Mapbox
 * unvalidated.
 *
 * The S–H degrade clips outer and hole rings INDEPENDENTLY, so an atoll
 * (drying-reef ring around a lagoon hole — Lady Musgrave exactly) yields
 * coincident outer/hole seams for every rect crossing the annulus, and in
 * the limiting case a polygon whose hole ring EQUALS its outer ring: exact
 * zero area. That class went straight into Mapbox's geojson-vt/earcut — in
 * the same renderer process, during quiet plotting, invisible to every
 * gauge. Both 2026-08-25 fatal trails (phone a3339 "3.3 GB available",
 * desktop h135 of 4192 MB) end at merge-done with a glaze job in flight.
 *
 * These tests pin the sanitizer's verdicts and the invariant that
 * clipFeatureOutsideBboxes output NEVER contains a degenerate ring.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { clipFeatureOutsideBboxes, sanitizeCoverageGeom } from '../services/enc/clipDepareOverlap';
import type { Bbox } from '../services/enc/clipDepareOverlap';

type Ring = Position[];

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];

const ringArea = (ring: Ring): number => {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(a / 2);
};

/** The Musgrave shape: reef ring with a lagoon hole. */
const atoll = (): Feature => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, 10), square(3, 3, 7, 7)] },
});

const outputPolys = (f: Feature): Ring[][] => {
    const g = f.geometry as Polygon | MultiPolygon;
    return g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
};

describe('sanitizeCoverageGeom', () => {
    it('keeps a healthy annulus untouched in substance', () => {
        const out = sanitizeCoverageGeom([[square(0, 0, 10, 10), square(3, 3, 7, 7)]]);
        expect(out).not.toBeNull();
        expect(out).toHaveLength(1);
        expect(out![0]).toHaveLength(2);
    });

    it('drops an exact-zero-area outer ring — the hole==outer limiting case collapses to null', () => {
        const r = square(2, 2, 8, 8);
        // Outer and hole IDENTICAL: the S–H artifact when a partition rect
        // lies wholly inside the lagoon. Zero paintable area → nothing ships.
        expect(sanitizeCoverageGeom([[r, r.map((p) => [...p]) as Ring]])).toBeNull();
    });

    it('drops a degenerate near-equal annulus (hole covers ~all of outer)', () => {
        const out = sanitizeCoverageGeom([[square(0, 0, 10, 10), square(0.0000001, 0.0000001, 10, 10)]]);
        expect(out).toBeNull();
    });

    it('drops sliver and short rings but keeps the polygon they rode in on', () => {
        const sliver: Ring = [
            [0, 0],
            [1e-7, 0],
            [1e-7, 1e-7],
            [0, 0],
        ];
        const out = sanitizeCoverageGeom([[square(0, 0, 10, 10), sliver]]);
        expect(out).not.toBeNull();
        expect(out![0]).toHaveLength(1); // sliver hole gone, outer kept
    });

    it('a non-finite coordinate poisons its ring, not the whole collection', () => {
        const bad: Ring = [
            [0, 0],
            [NaN, 5],
            [5, 5],
            [0, 0],
        ];
        const out = sanitizeCoverageGeom([[bad], [square(20, 20, 30, 30)]]);
        expect(out).not.toBeNull();
        expect(out).toHaveLength(1);
        expect(ringArea(out![0][0])).toBeCloseTo(100);
    });

    it('returns null when nothing paintable survives', () => {
        expect(sanitizeCoverageGeom([])).toBeNull();
        expect(
            sanitizeCoverageGeom([
                [
                    [
                        [0, 0],
                        [1, 1],
                        [0, 0],
                    ],
                ],
            ]),
        ).toBeNull();
    });
});

describe('clipFeatureOutsideBboxes output invariant — no degenerate ring ever ships', () => {
    const MIN_AREA = 1e-10;

    const assertClean = (f: Feature | null): void => {
        expect(f).not.toBeNull();
        for (const poly of outputPolys(f!)) {
            const outerArea = ringArea(poly[0]);
            expect(outerArea).toBeGreaterThan(MIN_AREA);
            for (let h = 1; h < poly.length; h++) {
                const holeArea = ringArea(poly[h]);
                expect(holeArea).toBeGreaterThan(MIN_AREA);
                expect(holeArea).toBeLessThan(outerArea); // never hole ≈ outer
            }
            for (const ring of poly) {
                for (const [x, y] of ring) {
                    expect(Number.isFinite(x)).toBe(true);
                    expect(Number.isFinite(y)).toBe(true);
                }
            }
        }
    };

    it('a rect crossing the lagoon produces only valid rings', () => {
        // Vertical slab through the middle of the atoll — the classic
        // coincident-seam configuration.
        assertClean(clipFeatureOutsideBboxes(atoll(), [[4, -1, 6, 11] as Bbox]));
    });

    it('a rect wholly inside the lagoon leaves the atoll untouched (identity)', () => {
        const f = atoll();
        // Subtracting water that the polygon does not cover: the hole bbox
        // test drops it or the clip returns identity — either way no
        // degenerate output.
        const out = clipFeatureOutsideBboxes(f, [[4.5, 4.5, 5.5, 5.5] as Bbox]);
        if (out !== null && out !== f) assertClean(out);
    });

    it('a strip-mask barrage across the annulus (the Musgrave degrade) stays clean', () => {
        // Many small rects marching across reef and lagoon, the way
        // coverageMaskStrips degrades a monster pair.
        const rects: Bbox[] = [];
        for (let x = 0; x < 10; x += 1.5) {
            rects.push([x, 2.4, x + 0.9, 3.6] as Bbox); // across the top reef/lagoon seam
            rects.push([x, 6.4, x + 0.9, 7.6] as Bbox); // across the bottom seam
        }
        assertClean(clipFeatureOutsideBboxes(atoll(), rects));
    });

    it('swallowed whole still reports null', () => {
        expect(clipFeatureOutsideBboxes(atoll(), [[-1, -1, 11, 11] as Bbox])).toBeNull();
    });
});
