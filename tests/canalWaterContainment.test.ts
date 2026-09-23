import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { canalPathWithinWater, CANAL_WATER_LIMITS } from '../services/canalWaterContainment';

type Pair = [number, number];
const ll = (x: number, y: number): Pair => [153 + x / 99_000, -27 + y / 111_320];
const ring = (points: Pair[]): Pair[] => points.map(([x, y]) => ll(x, y));
const rectangle = (w: number, s: number, e: number, n: number): Pair[] =>
    ring([
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ]);
const polygon = (...rings: Pair[][]): Feature<Polygon> => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: rings },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const path = (...points: Pair[]): Pair[] => points.map(([x, y]) => ll(x, y));
const water = () => fc(polygon(rectangle(0, 0, 100, 100)));

describe('continuous canal water-union containment', () => {
    it('accepts complete interior segments and exact pinned endpoints without mutation', () => {
        const route = path([5, 5], [30, 60], [95, 95]);
        const mapped = water();
        const before = JSON.stringify({ route, mapped });
        expect(canalPathWithinWater(route, mapped)).toBe(true);
        expect(JSON.stringify({ route, mapped })).toBe(before);
    });

    it('rejects a 2 cm hole crossed between raster centres', () => {
        const mapped = fc(polygon(rectangle(0, 0, 100, 100), rectangle(49.99, 40, 50.01, 60)));
        expect(canalPathWithinWater(path([5, 50], [95, 50]), mapped)).toBe(false);
        expect(canalPathWithinWater(path([5, 20], [95, 20]), mapped)).toBe(true);
    });

    it('rejects a thin peninsula even though its chord endpoints are water', () => {
        const mapped = fc(
            polygon(
                ring([
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [50.01, 100],
                    [50.01, 49.9],
                    [49.99, 49.9],
                    [49.99, 100],
                    [0, 100],
                    [0, 0],
                ]),
            ),
        );
        expect(canalPathWithinWater(path([5, 50], [95, 50]), mapped)).toBe(false);
    });

    it('retains an L-shaped water bend but rejects its land-cutting diagonal', () => {
        const mapped = fc(
            polygon(
                ring([
                    [0, 0],
                    [30, 0],
                    [30, 70],
                    [100, 70],
                    [100, 100],
                    [0, 100],
                    [0, 0],
                ]),
            ),
        );
        expect(canalPathWithinWater(path([15, 15], [15, 85], [85, 85]), mapped)).toBe(true);
        expect(canalPathWithinWater(path([15, 15], [85, 85]), mapped)).toBe(false);
    });

    it('rejects endpoint land and shoreline runs or tangential vertex grazes', () => {
        expect(canalPathWithinWater(path([-1, 50], [50, 50]), water())).toBe(false);
        expect(canalPathWithinWater(path([0, 10], [0, 90]), water())).toBe(false);
        expect(canalPathWithinWater(path([0, 50], [50, 50]), water())).toBe(false);
        const mapped = fc(
            polygon(
                rectangle(0, 0, 100, 100),
                ring([
                    [50, 50],
                    [60, 70],
                    [40, 70],
                    [50, 50],
                ]),
            ),
        );
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped)).toBe(false);
    });

    it('does not mistake adjacent clipped tile boundaries for shorelines', () => {
        const mapped = fc(polygon(rectangle(0, 0, 50, 100)), polygon(rectangle(50, 0, 100, 100)));
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped)).toBe(true);
        expect(canalPathWithinWater(path([50, 10], [50, 90]), mapped)).toBe(true);
        expect(canalPathWithinWater(path([50, 50], [90, 90]), mapped)).toBe(true);
    });

    it('allows all four tiles meeting in open water but not a corner-only water connection', () => {
        const sw = polygon(rectangle(0, 0, 50, 50)),
            ne = polygon(rectangle(50, 50, 100, 100));
        const route = path([25, 25], [75, 75]);
        expect(canalPathWithinWater(route, fc(sw, ne))).toBe(false);
        expect(
            canalPathWithinWater(
                route,
                fc(sw, ne, polygon(rectangle(0, 50, 50, 100)), polygon(rectangle(50, 0, 100, 50))),
            ),
        ).toBe(true);
    });

    it('does not join a narrow unmapped gap between tiles', () => {
        const mapped = fc(polygon(rectangle(0, 0, 49.99, 100)), polygon(rectangle(50.01, 0, 100, 100)));
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped)).toBe(false);
    });

    it('uses polygon union semantics for overlapping water and another polygon filling a hole', () => {
        const withHole = polygon(rectangle(0, 0, 100, 100), rectangle(40, 40, 60, 60));
        const route = path([10, 50], [90, 50]);
        expect(canalPathWithinWater(route, fc(withHole, polygon(rectangle(40, 40, 60, 60))))).toBe(true);
        expect(canalPathWithinWater(route, fc(withHole, polygon(rectangle(39, 39, 61, 61))))).toBe(true);
        expect(canalPathWithinWater(route, fc(withHole, polygon(rectangle(40, 40, 59, 60))))).toBe(false);
        expect(
            canalPathWithinWater(route, fc(polygon(rectangle(0, 0, 100, 100)), polygon(rectangle(0, 0, 100, 100)))),
        ).toBe(true);
    });

    it('handles MultiPolygon pieces and does not rely on winding orientation', () => {
        const mapped: FeatureCollection = fc({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'MultiPolygon',
                coordinates: [[rectangle(0, 0, 50, 100).reverse()], [rectangle(50, 0, 100, 100)]],
            },
        });
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped)).toBe(true);
    });

    it('accepts a valid outer/hole vertex touch away from the route, as captured in Newport MVT water', () => {
        const mapped = fc(
            polygon(
                ring([
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [0, 100],
                    [0, 50],
                    [0, 0],
                ]),
                ring([
                    [0, 50],
                    [20, 40],
                    [30, 50],
                    [20, 60],
                    [0, 50],
                ]),
            ),
        );
        expect(canalPathWithinWater(path([10, 20], [90, 20]), mapped)).toBe(true);
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped)).toBe(false);
        expect(canalPathWithinWater(path([0, 50], [90, 50]), mapped)).toBe(false);
    });

    it('allows duplicate consecutive interior pins, but not a duplicate pin on a bank', () => {
        expect(canalPathWithinWater(path([10, 50], [10, 50]), water())).toBe(true);
        expect(canalPathWithinWater(path([0, 50], [0, 50]), water())).toBe(false);
    });

    it.each([
        null,
        {},
        { type: 'FeatureCollection', features: [] },
        { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] },
        fc({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: path([0, 0], [100, 100]) },
        }),
        fc(
            polygon(
                ring([
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [0, 100],
                ]),
            ),
        ),
        fc(
            polygon([
                [0, 0],
                [1, 0],
                [1, NaN],
                [0, 0],
            ]),
        ),
        fc(polygon(rectangle(0, 0, 100, 100), rectangle(110, 110, 120, 120))),
        fc(polygon(rectangle(0, 0, 100, 100), rectangle(20, 20, 60, 60), rectangle(40, 40, 70, 70))),
        fc(
            polygon(
                ring([
                    [0, 0],
                    [100, 100],
                    [0, 100],
                    [100, 0],
                    [0, 0],
                ]),
            ),
        ),
        fc(
            polygon(
                ring([
                    [0, 0],
                    [100, 0],
                    [50, 0],
                    [100, 100],
                    [0, 100],
                    [0, 0],
                ]),
            ),
        ),
    ])('fails closed on malformed or unsupported water input %j', (mapped) => {
        expect(canalPathWithinWater(path([10, 50], [90, 50]), mapped as FeatureCollection)).toBe(false);
    });

    it.each([
        { route: [] },
        { route: path([50, 50]) },
        {
            route: [
                [NaN, 0],
                [0, 0],
            ],
        },
        {
            route: [
                [180, 81],
                [180, 80],
            ],
        },
        {
            route: [
                [0, 0],
                [2, 0],
            ],
        },
    ] satisfies Array<{ route: Pair[] }>)('fails closed on malformed or unsupported route input %j', ({ route }) => {
        expect(canalPathWithinWater(route, water())).toBe(false);
    });

    it('fails closed on bounded input and computation budgets', () => {
        const feature = polygon(rectangle(0, 0, 100, 100));
        expect(
            canalPathWithinWater(path([10, 50], [90, 50]), fc(...Array(CANAL_WATER_LIMITS.features + 1).fill(feature))),
        ).toBe(false);
        expect(canalPathWithinWater(Array(CANAL_WATER_LIMITS.pathPoints + 1).fill(ll(50, 50)), water())).toBe(false);
        expect(
            canalPathWithinWater(
                path([10, 50], [90, 50]),
                fc(polygon(Array(CANAL_WATER_LIMITS.vertices + 1).fill(ll(50, 50)))),
            ),
        ).toBe(false);
        // Structurally valid coincident polygons cause too many candidate edge
        // comparisons: bounded rejection, not unbounded UI/worker computation.
        expect(canalPathWithinWater(path([10, 50], [90, 50]), fc(...Array(1_600).fill(feature)))).toBe(false);
    });
});
