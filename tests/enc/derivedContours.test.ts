/**
 * derivedContours — the honest densification. The tests that matter are
 * the ones that stop it LYING: it must interpolate where soundings
 * surround the water, and refuse to invent depth across a gap.
 */
import { describe, it, expect } from 'vitest';

import { buildDerivedContours } from '../../services/enc/derivedContours';

/** A dense-ish grid of soundings around a point, depth = a function of
 *  position so we know where a level should cross. lon/lat spacing ~50 m. */
const DEG = 0.0005; // ~55 m at this latitude

function ramp(nx: number, ny: number, depthAt: (ix: number, iy: number) => number) {
    const pts = [];
    for (let ix = 0; ix < nx; ix++) {
        for (let iy = 0; iy < ny; iy++) {
            pts.push({ lon: 153 + ix * DEG, lat: -27 + iy * DEG, d: depthAt(ix, iy) });
        }
    }
    return pts;
}

describe('buildDerivedContours', () => {
    it('interpolates a contour through a depth ramp', () => {
        // Depth increases west→east from 1 m to 10 m across the grid, so
        // the 5 m level must appear somewhere in the middle.
        const pts = ramp(8, 8, (ix) => 1 + ix * (9 / 7));
        const fs = buildDerivedContours(pts, { levels: [5] });
        expect(fs.length).toBeGreaterThan(0);
        for (const f of fs) {
            expect(f.properties?._derived).toBe(true);
            expect(f.properties?._valdco).toBe(5);
            expect(f.geometry.type).toBe('LineString');
            expect(f.geometry.coordinates).toHaveLength(2);
        }
        // The 5 m crossing sits roughly mid-grid (ix≈4.11 → lon≈153+4.11·DEG).
        const xs = fs.flatMap((f) => f.geometry.coordinates.map((c) => c[0]));
        const meanX = xs.reduce((s, x) => s + x, 0) / xs.length;
        expect(meanX).toBeGreaterThan(153 + 3 * DEG);
        expect(meanX).toBeLessThan(153 + 5.5 * DEG);
    });

    it('emits nothing for a level outside the sounding range', () => {
        const pts = ramp(6, 6, () => 8); // all 8 m
        expect(buildDerivedContours(pts, { levels: [3] })).toEqual([]); // 3 m never crossed
        expect(buildDerivedContours(pts, { levels: [20] })).toEqual([]);
    });

    it('REFUSES to contour across a data gap (no extrapolation)', () => {
        // Two tight clusters ~5 km apart, shallow on the left, deep on the
        // right. A naive triangulation bridges them with long triangles;
        // the maxEdge guard must drop those so NO 5 m line is drawn in the
        // empty water between.
        const left = ramp(4, 4, () => 2).map((p) => ({ ...p }));
        const right = ramp(4, 4, () => 9).map((p) => ({ ...p, lon: p.lon + 0.05 })); // ~5 km east
        const fs = buildDerivedContours([...left, ...right], { levels: [5], maxEdgeM: 600 });
        // No triangle within either cluster straddles 5 m (each cluster is
        // uniform), and the bridging triangles are dropped → nothing.
        expect(fs).toEqual([]);
    });

    it('bails out honestly when soundings are too sparse', () => {
        const pts = ramp(2, 2, (ix) => 1 + ix * 5); // 4 points
        expect(buildDerivedContours(pts, { levels: [3], minSoundings: 8 })).toEqual([]);
    });

    it('drying heights (negative depth) never trip a positive contour', () => {
        const pts = ramp(6, 6, (ix, iy) => (ix + iy < 4 ? -0.5 : 1.5)); // dries vs 1.5 m
        // No level ≥ 2 can cross (max depth 1.5), and 2 m is our shallowest
        // default — so a drying flat densifies to nothing, not a phantom line.
        expect(buildDerivedContours(pts, { levels: [2, 3] })).toEqual([]);
    });

    it('ignores non-finite soundings without crashing', () => {
        const pts = [...ramp(6, 6, (ix) => 1 + ix * 1.5), { lon: NaN, lat: -27, d: 5 }, { lon: 153, lat: -27, d: NaN }];
        expect(() => buildDerivedContours(pts, { levels: [5] })).not.toThrow();
    });
});
