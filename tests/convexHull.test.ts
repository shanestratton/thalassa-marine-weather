/**
 * The swing envelope's geometry. See utils/convexHull.ts for why the anchor
 * trail is a hull rather than a smoothed line.
 */
import { describe, expect, it } from 'vitest';
import { convexHull, hullRing, type LonLat } from '../utils/convexHull';

const sortPts = (p: LonLat[]) => [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe('convexHull', () => {
    it('keeps only the outer corners of a filled square', () => {
        const pts: LonLat[] = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0.5, 0.5], // interior — must be dropped
            [0.5, 0.2],
            [0.2, 0.7],
        ];
        expect(sortPts(convexHull(pts))).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
        ]);
    });

    it('drops collinear points on an edge rather than leaving stray vertices', () => {
        const pts: LonLat[] = [
            [0, 0],
            [1, 0],
            [2, 0],
            [2, 2],
            [0, 2],
        ];
        const hull = convexHull(pts);
        expect(hull).toHaveLength(4);
        expect(hull).not.toContainEqual([1, 0]);
    });

    it('returns the points themselves when there is no area', () => {
        expect(convexHull([])).toEqual([]);
        expect(convexHull([[1, 2]])).toEqual([[1, 2]]);
        expect(
            sortPts(
                convexHull([
                    [1, 2],
                    [3, 4],
                ]),
            ),
        ).toEqual([
            [1, 2],
            [3, 4],
        ]);
    });

    it('de-duplicates, so a boat sitting still does not fake an area', () => {
        const same: LonLat[] = Array.from({ length: 40 }, () => [153.0, -27.5]);
        expect(convexHull(same)).toEqual([[153.0, -27.5]]);
        expect(hullRing(same)).toBeNull();
    });

    it('ignores non-finite coordinates instead of poisoning the hull', () => {
        const pts: LonLat[] = [
            [0, 0],
            [1, 0],
            [1, 1],
            [Number.NaN, 5],
            [0, Number.POSITIVE_INFINITY],
        ];
        const hull = convexHull(pts);
        expect(hull).toHaveLength(3);
        for (const [lon, lat] of hull) {
            expect(Number.isFinite(lon)).toBe(true);
            expect(Number.isFinite(lat)).toBe(true);
        }
    });

    it('encloses every input point — the envelope may never hide movement', () => {
        // The safety property. Whatever the wander, no fix may fall outside
        // the shape drawn around it.
        const pts: LonLat[] = [];
        for (let i = 0; i < 200; i++) {
            const a = (i * 137.50776405) % 360;
            const r = 0.00012 * Math.sqrt((i % 37) / 37);
            pts.push([153.0 + r * Math.cos((a * Math.PI) / 180), -27.5 + r * Math.sin((a * Math.PI) / 180)]);
        }
        const hull = convexHull(pts);
        const inside = ([px, py]: LonLat) => {
            for (let i = 0; i < hull.length; i++) {
                const a = hull[i];
                const b = hull[(i + 1) % hull.length];
                // Counter-clockwise hull: every point must be left of or on
                // each edge. A tiny epsilon absorbs float error on the edges.
                const side = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
                if (side < -1e-12) return false;
            }
            return true;
        };
        for (const p of pts) expect(inside(p), `${p} escaped the hull`).toBe(true);
    });

    it('closes the ring for GeoJSON, first point repeated last', () => {
        const ring = hullRing([
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ]);
        expect(ring).not.toBeNull();
        expect(ring![0]).toEqual(ring![ring!.length - 1]);
        expect(ring).toHaveLength(5);
    });

    it('has no ring for one or two fixes — nothing to shade yet', () => {
        expect(hullRing([[1, 2]])).toBeNull();
        expect(
            hullRing([
                [1, 2],
                [3, 4],
            ]),
        ).toBeNull();
    });
});
