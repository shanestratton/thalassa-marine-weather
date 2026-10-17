import { describe, it, expect } from 'vitest';
import { aheadCone, aheadBounds, type AheadHazard } from '../services/underway/lookaheadRule';
import { coneIsCovered } from '../services/underway/lookaheadCoverage';

const cone = aheadCone({ lat: 0, lon: 0, at: 1_800_000_000_000, sogKn: 6, cogDeg: 0 })!;
const band = (south: number, north: number): AheadHazard => ({
    layer: 'DEPARE',
    minDepthM: 20,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [-1, south],
                [1, south],
                [1, north],
                [-1, north],
                [-1, south],
            ],
        ],
    },
});
describe('exact chart lookahead coverage', () => {
    it('joins actual depth areas while retaining an arbitrarily thin unsurveyed gap', () => {
        expect(coneIsCovered(cone, [band(-1, 0.007), band(0.007, 1)])).toBe(true);
        // Every cone vertex is covered; only an area difference sees this gap.
        expect(coneIsCovered(cone, [band(-1, 0.007), band(0.007001, 1)])).toBe(false);
    });
    it('does not certify a polygon hole or a lone spot sounding as chart coverage', () => {
        const hole = band(-1, 1);
        (hole.geometry.coordinates as number[][][]).push([
            [-0.0001, 0.007],
            [0.0001, 0.007],
            [0.0001, 0.008],
            [-0.0001, 0.008],
            [-0.0001, 0.007],
        ]);
        expect(coneIsCovered(cone, [hole])).toBe(false);
        expect(
            coneIsCovered(cone, [
                { layer: 'SOUNDG', minDepthM: 20, geometry: { type: 'Point', coordinates: [0, 0.005] } },
            ]),
        ).toBe(false);
    });
    it('includes both near-origin and far-side positions when splitting at the dateline', () => {
        const crossing = aheadCone({ lat: 0, lon: 179.999, at: cone.fix.at, sogKn: 6, cogDeg: 90 })!;
        const boxes = aheadBounds(crossing);
        expect(boxes.length).toBe(2);
        expect(
            crossing.polygon.every(([x, y]) => boxes.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n)),
        ).toBe(true);
    });
});
