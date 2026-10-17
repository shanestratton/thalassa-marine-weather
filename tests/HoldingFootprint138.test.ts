import { describe, expect, it } from 'vitest';
import { holdingFootprint, holdingGeometryRelation, type HoldingBounds } from '../services/enc/holdingFootprint';
import type { Polygon } from 'geojson';
const box: HoldingBounds = [-0.01, -0.01, 0.01, 0.01];
const polygon = (): Polygon => ({
    type: 'Polygon',
    coordinates: [
        [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
        ],
    ],
});
describe('whole holding circle and incoming arc enclosure', () => {
    it('encloses both ends and the complete radius without sampling a ring', () => {
        const b = holdingFootprint({ lat: 0, lon: 0 }, { lat: 0, lon: 0.04 }, 100)!;
        expect(b[0]).toBeLessThan(-0.04);
        expect(b[2]).toBeGreaterThan(0.04);
        expect(b[3]).toBeGreaterThan(0.04);
        expect(holdingGeometryRelation(polygon(), b, () => {})).toEqual({ covers: true, intersects: true });
    });
    it('refuses a missing incoming leg, oversized leg, poles and unsplit dateline', () => {
        expect(holdingFootprint({ lat: 0, lon: 0 }, null, 100)).toBeNull();
        expect(holdingFootprint({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, 100)).toBeNull();
        expect(holdingFootprint({ lat: 81, lon: 0 }, { lat: 81, lon: 0 }, 100)).toBeNull();
        expect(holdingFootprint({ lat: 0, lon: 179.999 }, { lat: 0, lon: 179.998 }, 100)).toBeNull();
    });
    it('rejects a tiny unsampled hole, notch and boundary touching the envelope', () => {
        const hole = polygon();
        hole.coordinates.push([
            [0.001, 0.001],
            [0.002, 0.001],
            [0.002, 0.002],
            [0.001, 0.002],
            [0.001, 0.001],
        ]);
        expect(holdingGeometryRelation(hole, box, () => {}).covers).toBe(false);
        expect(
            holdingGeometryRelation(
                {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [-1, -1],
                            [1, -1],
                            [1, 1],
                            [0.001, 1],
                            [0.001, 0.001],
                            [-0.001, 0.001],
                            [-0.001, 1],
                            [-1, 1],
                            [-1, -1],
                        ],
                    ],
                },
                box,
                () => {},
            ).covers,
        ).toBe(false);
        const edge = polygon();
        edge.coordinates[0][0] = [-0.01, -0.01];
        edge.coordinates[0][4] = [-0.01, -0.01];
        expect(holdingGeometryRelation(edge, box, () => {}).covers).toBe(false);
    });
    it('detects an interior point/line but never invents MultiPoint connecting spans', () => {
        expect(holdingGeometryRelation({ type: 'Point', coordinates: [0, 0] }, box, () => {}).intersects).toBe(true);
        expect(
            holdingGeometryRelation(
                {
                    type: 'LineString',
                    coordinates: [
                        [-1, 0],
                        [1, 0],
                    ],
                },
                box,
                () => {},
            ).intersects,
        ).toBe(true);
        expect(
            holdingGeometryRelation(
                {
                    type: 'MultiPoint',
                    coordinates: [
                        [-1, 0],
                        [1, 0],
                    ],
                },
                box,
                () => {},
            ).intersects,
        ).toBe(false);
    });
    it('visits every coordinate and refuses malformed rings, ambiguous spans and exhausted budgets', () => {
        let count = 0;
        holdingGeometryRelation(polygon(), box, () => count++);
        expect(count).toBe(5);
        expect(() =>
            holdingGeometryRelation(polygon(), box, () => {
                throw Error('budget');
            }),
        ).toThrow('budget');
        const open = polygon();
        open.coordinates[0].pop();
        expect(() => holdingGeometryRelation(open, box, () => {})).toThrow('Unclosed');
        expect(() =>
            holdingGeometryRelation(
                {
                    type: 'LineString',
                    coordinates: [
                        [-179, 0],
                        [179, 0],
                    ],
                },
                box,
                () => {},
            ),
        ).toThrow('Dateline');
    });
    it('refuses self-intersections, invalid holes and bounded topology exhaustion', () => {
        expect(() =>
            holdingGeometryRelation(
                {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [-1, -1],
                            [1, 1],
                            [-1, 1],
                            [1, -1],
                            [-1, -1],
                        ],
                    ],
                },
                box,
                () => {},
            ),
        ).toThrow();
        const outside = polygon();
        outside.coordinates.push([
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 3],
            [2, 2],
        ]);
        expect(() => holdingGeometryRelation(outside, box, () => {})).toThrow('outside');
        expect(() =>
            holdingGeometryRelation(
                polygon(),
                box,
                () => {},
                () => {
                    throw Error('cohort comparisons');
                },
            ),
        ).toThrow('cohort comparisons');
    });
});
