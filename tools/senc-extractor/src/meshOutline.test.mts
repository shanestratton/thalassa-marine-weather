import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { meshToPolygons, signedArea2, type Pt, type Tri } from './meshOutline.js';

/**
 * Triangle mesh → polygon rings.
 *
 * The whole point is that a chart's depth areas keep their real shape. A wrong
 * outline is not a cosmetic bug — the inshore router treats DEPARE as the
 * navigable/not-navigable boundary — so every test here is about the shape
 * being RIGHT or the function refusing to answer.
 */

/** Square [0,0]-[s,s], split into two triangles, consistently wound. */
const square = (s = 10, ox = 0, oy = 0): Tri[] => [
    [
        [ox, oy],
        [ox + s, oy],
        [ox + s, oy + s],
    ],
    [
        [ox, oy],
        [ox + s, oy + s],
        [ox, oy + s],
    ],
];

/** Area enclosed by a polygon (outer minus holes). */
const polyArea = (rings: Pt[][]): number =>
    rings.reduce((sum, ring, i) => sum + ((i === 0 ? 1 : -1) * Math.abs(signedArea2(ring))) / 2, 0);

describe('meshToPolygons', () => {
    it('dissolves a two-triangle square into one 4-corner ring', () => {
        const out = meshToPolygons(square());
        assert.ok(out, 'expected an outline');
        assert.equal(out.length, 1, 'one polygon');
        assert.equal(out[0].length, 1, 'no holes');
        // The shared diagonal must be gone — a 4-corner ring, not 5.
        assert.equal(out[0][0].length, 5, 'closed 4-corner ring');
        assert.equal(polyArea(out[0]), 100);
    });

    it('keeps the area of a many-triangle fan', () => {
        // A fan around a centre point: every interior spoke is shared by two
        // triangles and must cancel, leaving only the outer boundary.
        const centre: Pt = [0, 0];
        const n = 12;
        const rim: Pt[] = Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2;
            return [Math.cos(a), Math.sin(a)] as Pt;
        });
        const tris: Tri[] = rim.map((p, i) => [centre, p, rim[(i + 1) % n]]);
        const out = meshToPolygons(tris);
        assert.ok(out);
        assert.equal(out.length, 1);
        assert.equal(out[0][0].length, n + 1, 'rim only — every spoke cancelled');
        const meshArea = tris.reduce(
            (s, t) =>
                s + Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2,
            0,
        );
        assert.ok(Math.abs(polyArea(out[0]) - meshArea) < 1e-9);
    });

    it('recovers a hole rather than filling it in', () => {
        // Square annulus: outer 0..30, hole 10..20. Built as a ring of quads
        // around the hole, each split into two triangles.
        const ringPts = (lo: number, hi: number): Pt[] => [
            [lo, lo],
            [hi, lo],
            [hi, hi],
            [lo, hi],
        ];
        const outer = ringPts(0, 30);
        const inner = ringPts(10, 20);
        const tris: Tri[] = [];
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            tris.push([outer[i], outer[j], inner[j]]);
            tris.push([outer[i], inner[j], inner[i]]);
        }
        const out = meshToPolygons(tris);
        assert.ok(out, 'expected an outline');
        assert.equal(out.length, 1, 'one polygon');
        assert.equal(out[0].length, 2, 'outer + one hole');
        // 30x30 minus 10x10 = 800. If the hole were dropped this reads 900.
        assert.equal(polyArea(out[0]), 800);
        // The hole must wind opposite to its outer, or renderers fill it.
        assert.ok(signedArea2(out[0][0]) > 0, 'outer CCW');
        assert.ok(signedArea2(out[0][1]) < 0, 'hole CW');
    });

    it('keeps two disjoint islands separate instead of nesting them', () => {
        // This is why AreaGeometry.polygons exists: through `rings`, the second
        // island would become a HOLE punched in the first.
        const out = meshToPolygons([...square(10, 0, 0), ...square(10, 100, 100)]);
        assert.ok(out);
        assert.equal(out.length, 2, 'two separate polygons');
        assert.equal(out[0].length, 1);
        assert.equal(out[1].length, 1);
        assert.equal(polyArea(out[0]) + polyArea(out[1]), 200);
    });

    it('survives mixed triangle winding', () => {
        // GL_TRIANGLE_STRIP alternates orientation every other triangle. Winding
        // is normalised per triangle, so a mesh with both orientations still
        // resolves — this must not depend on the caller pre-normalising.
        const tris = square();
        const flipped: Tri = [tris[1][0], tris[1][2], tris[1][1]];
        const out = meshToPolygons([tris[0], flipped]);
        assert.ok(out, 'mixed winding should still resolve');
        assert.equal(polyArea(out[0]), 100);
    });

    it('drops zero-area slivers without changing the shape', () => {
        // FR466870 carried 3,514 near-zero slivers and 41 zero-area triangles.
        // A degenerate triangle cannot cancel its edges and would hang a spur
        // off the boundary.
        const degenerate: Tri = [
            [0, 0],
            [10, 10],
            [5, 5],
        ]; // collinear — zero area
        const repeated: Tri = [
            [0, 0],
            [0, 0],
            [10, 0],
        ]; // repeated vertex
        const out = meshToPolygons([...square(), degenerate, repeated]);
        assert.ok(out, 'slivers must not defeat reconstruction');
        assert.equal(out.length, 1);
        assert.equal(out[0][0].length, 5, 'still a clean 4-corner ring');
        assert.equal(polyArea(out[0]), 100);
    });

    it('tolerates a one-ULP vertex mismatch between neighbours', () => {
        // Without vertex snapping, a single ULP of difference leaves an
        // interior edge uncancelled and tears a false slit through a depth
        // area. Quantisation is what stops that.
        const eps = 1e-13;
        const tris: Tri[] = [
            [
                [0, 0],
                [10, 0],
                [10, 10],
            ],
            [
                [0, 0],
                [10 + eps, 10 - eps],
                [0, 10],
            ],
        ];
        const out = meshToPolygons(tris);
        assert.ok(out, 'near-identical vertices must be treated as shared');
        assert.equal(out[0][0].length, 5);
    });

    it('refuses an unresolvable mesh rather than guessing', () => {
        // A lone edge-pair that cannot close is exactly the case that must fail
        // closed: the caller keeps the triangles and the chart still renders,
        // just unimproved. Returning a torn outline would redraw a depth area
        // with the wrong shape.
        assert.equal(meshToPolygons([]), null);
        const allDegenerate: Tri[] = [
            [
                [0, 0],
                [1, 1],
                [2, 2],
            ],
        ];
        assert.equal(meshToPolygons(allDegenerate), null);
    });

    it('never invents or moves a vertex', () => {
        // Every output coordinate must be one that was in the input. Snapping
        // is used for COMPARISON only; emitting a rounded coordinate would
        // shift a charted boundary.
        const tris = square(10);
        const inputs = new Set(tris.flat().map((p) => `${p[0]},${p[1]}`));
        const out = meshToPolygons(tris);
        assert.ok(out);
        for (const ring of out[0]) {
            for (const p of ring) {
                assert.ok(inputs.has(`${p[0]},${p[1]}`), `invented vertex ${p}`);
            }
        }
    });
});
