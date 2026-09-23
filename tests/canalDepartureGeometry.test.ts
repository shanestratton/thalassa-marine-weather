import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { FeatureCollection, Polygon, Position } from 'geojson';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import lineIntersect from '@turf/line-intersect';
import {
    buildCanalDepartureGeometry,
    canalDepartureBbox,
    canalSegmentsInWater,
    canalDistanceM,
    CANAL_RESOLUTION_M,
    CANAL_MAX_CELLS,
    type CanalPoint,
    type CanalPair,
} from '../services/canalDepartureGeometry';
import { decodeWaterFromTile, tilesForBbox, MAPBOX_WATER_ZOOM } from '../services/mapboxWater';

const ll = (x: number, y: number): CanalPair => [
    153 + x / (111320 * Math.cos((-27.2 * Math.PI) / 180)),
    -27.2 + y / 111320,
];
const p = (x: number, y: number): CanalPoint => {
    const [lon, lat] = ll(x, y);
    return { lon, lat };
};
const poly = (ring: number[][]): FeatureCollection<Polygon> => ({
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => ll(x, y))] },
        },
    ],
});
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const water = poly([
    [0, 0],
    [100, 0],
    [100, 175],
    [300, 175],
    [300, 0],
    [400, 0],
    [400, 250],
    [0, 250],
    [0, 0],
]);
const start = p(50, 50),
    exit = p(350, 50);
const build = (obstacles = empty, waterMap: FeatureCollection = water) =>
    buildCanalDepartureGeometry(start, exit, canalDepartureBbox(start, exit), waterMap, obstacles);

describe('strict canal departure geometry', () => {
    it.each([0, 1, 2, 3])('retains a mid-channel bend in the actual returned geometry, rotation %s', (turns) => {
        const rotate = (point: number[]) => {
            let [x, y] = point;
            for (let i = 0; i < turns; i++) [x, y] = [300 - y, x];
            return [x, y];
        };
        const ring = [
            [0, 0],
            [240, 0],
            [240, 255],
            [177, 255],
            [177, 63],
            [0, 63],
            [0, 0],
        ].map(rotate);
        const from = rotate([60, 31.5]),
            to = rotate([208.5, 210]);
        const a = p(from[0], from[1]),
            b = p(to[0], to[1]);
        const result = buildCanalDepartureGeometry(a, b, canalDepartureBbox(a, b), poly(ring), empty);
        const metres = (c: CanalPair) => [
            (c[0] - 153) * 111320 * Math.cos((-27.2 * Math.PI) / 180),
            (c[1] + 27.2) * 111320,
        ];
        const distanceToBank = (point: number[]) =>
            Math.min(
                ...ring.slice(1).map((end, index) => {
                    const start = ring[index],
                        dx = end[0] - start[0],
                        dy = end[1] - start[1];
                    const t = Math.max(
                        0,
                        Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)),
                    );
                    return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
                }),
            );
        for (let i = 1; i < result.coordinates.length; i++) {
            const from = metres(result.coordinates[i - 1]),
                to = metres(result.coordinates[i]);
            for (let sample = 0; sample <= 100; sample++) {
                const fraction = sample / 100;
                const at = [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction];
                // The old shortest-visible-line result was only ~6 m from the
                // inner corner. Check returned lon/lat against the independent
                // vector banks, not just the helper's intermediate cell path.
                expect(distanceToBank(at)).toBeGreaterThan(24);
            }
        }
    });
    it('checks tiny crossed cells and both sides of grid edges, including provider crop entries', () => {
        const grid = { width: 6, height: 6, minLon: 0, minLat: 0, dLon: 1, dLat: 1, water: new Uint8Array(36).fill(1) };
        grid.water[1 * 6 + 2] = 0;
        expect(
            canalSegmentsInWater(
                [
                    [1.5, 1.5],
                    [3.5, 2.5],
                ],
                grid,
            ),
        ).toBe(false);
        expect(
            canalSegmentsInWater(
                [
                    [2, 2],
                    [2, 3],
                ],
                grid,
            ),
        ).toBe(false);
        expect(
            canalSegmentsInWater(
                [
                    [-1, 4.5],
                    [7, 4.5],
                ],
                grid,
                true,
            ),
        ).toBe(true);
        expect(
            canalSegmentsInWater(
                [
                    [-1, 1.5],
                    [7, 1.5],
                ],
                grid,
                true,
            ),
        ).toBe(false);
    });
    it('accepts the reported 4.78 km exit within unchanged grid/tile budgets', () => {
        // Screenshot 2026-09-13 06:09: DMS rounded to 0.001 minutes.
        // This tests input/budget acceptance, not real-world navigability.
        const a = { lat: -(27 + 12.869 / 60), lon: 153 + 5.268 / 60 };
        const b = { lat: -(27 + 10.318 / 60), lon: 153 + 5.652 / 60 };
        expect(canalDistanceM(a, b)).toBeCloseTo(4775.19, 1);
        const bbox = canalDepartureBbox(a, b);
        expect(tilesForBbox(bbox, MAPBOX_WATER_ZOOM)).toHaveLength(33);
        // Synthetic all-water polygon: exercise the full worker-owned solver
        // at this shape/size without claiming it represents the Newport banks.
        const [w, s, e, n] = bbox;
        const result = buildCanalDepartureGeometry(
            a,
            b,
            bbox,
            {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [w, s],
                                    [e, s],
                                    [e, n],
                                    [w, n],
                                    [w, s],
                                ],
                            ],
                        },
                    },
                ],
            },
            empty,
        );
        expect(result.grid.width * result.grid.height).toBe(659610);
        expect(result.grid.water.length).toBeLessThanOrEqual(CANAL_MAX_CELLS);
        expect(result.grid.dLat * 111320).toBe(CANAL_RESOLUTION_M);
        expect(result.coordinates[0]).toEqual([a.lon, a.lat]);
        expect(result.coordinates.at(-1)).toEqual([b.lon, b.lat]);
        expect(canalSegmentsInWater(result.coordinates, result.grid)).toBe(true);
    });
    it('uses the old marina solver around a U-shaped canal; all straight legs stay in mapped water', () => {
        const result = build();
        expect(result.coordinates[0]).toEqual(ll(50, 50));
        expect(result.coordinates.at(-1)).toEqual(ll(350, 50));
        expect(result.coordinates.length).toBeGreaterThan(4);
        expect(result.coordinates.some((c) => c[1] > ll(0, 175)[1])).toBe(true);
        for (let i = 1; i < result.coordinates.length; i++) {
            const a = result.coordinates[i - 1],
                b = result.coordinates[i];
            for (let j = 0; j <= 100; j++) {
                const t = j / 100;
                expect(
                    booleanPointInPolygon([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], water.features[0]),
                ).toBe(true);
            }
        }
    });
    it('retains every exact ordered marker midpoint through a canal bend after per-leg string pulling', () => {
        const gates = [p(50, 135), p(50, 210), p(200, 215), p(350, 210), exit];
        const result = buildCanalDepartureGeometry(start, exit, canalDepartureBbox(start, exit), water, empty, gates);
        let previous = 0;
        for (const gate of gates) {
            const index = result.coordinates.findIndex(
                (c, i) => i > previous && c[0] === gate.lon && c[1] === gate.lat,
            );
            expect(index).toBeGreaterThan(previous);
            previous = index;
        }
        expect(result.coordinates.at(-1)).toEqual([exit.lon, exit.lat]);
        // Independently test all legs, including the raw midpoint/grid joins.
        for (let i = 1; i < result.coordinates.length; i++) {
            const a = result.coordinates[i - 1],
                b = result.coordinates[i];
            for (let j = 0; j <= 100; j++)
                expect(
                    booleanPointInPolygon(
                        [a[0] + ((b[0] - a[0]) * j) / 100, a[1] + ((b[1] - a[1]) * j) / 100],
                        water.features[0],
                    ),
                ).toBe(true);
        }
    });
    it('allows departure exactly on the first gate without duplicating or dropping later gates', () => {
        const gates = [start, p(50, 210), p(350, 210), exit];
        const result = buildCanalDepartureGeometry(start, exit, canalDepartureBbox(start, exit), water, empty, gates);
        expect(result.coordinates[0]).toEqual([start.lon, start.lat]);
        expect(result.coordinates.filter((c) => c[0] === start.lon && c[1] === start.lat)).toHaveLength(1);
        for (const gate of gates) expect(result.coordinates).toContainEqual([gate.lon, gate.lat]);
    });
    it('removes raster-centre micro-reversals at exact verified gates, but leaves manual endpoint behaviour unchanged', () => {
        const a = p(50, 50),
            b = p(50, 210),
            gate = p(50, 125);
        const bbox = canalDepartureBbox(a, b);
        const manual = buildCanalDepartureGeometry(a, b, bbox, water, empty);
        const constrained = buildCanalDepartureGeometry(a, b, bbox, water, empty, [gate, b]);
        expect(constrained.coordinates).toEqual([
            [a.lon, a.lat],
            [gate.lon, gate.lat],
            [b.lon, b.lat],
        ]);
        expect(manual.coordinates.length).toBeGreaterThan(constrained.coordinates.length);
        expect(canalSegmentsInWater(constrained.coordinates, constrained.grid)).toBe(true);
    });
    it('keeps grid endpoints when pruning would cut the eroded bank margin', () => {
        const a = p(2, 50),
            b = p(50, 150);
        const result = buildCanalDepartureGeometry(a, b, canalDepartureBbox(a, b), water, empty, [b]);
        expect(result.coordinates[0]).toEqual([a.lon, a.lat]);
        // The requested departure is raw mapped water, not an eroded cell.
        // Its existing short raw-water join must remain instead of replacing
        // it with a new long bank-adjacent segment.
        const next = result.coordinates[1];
        expect(canalDistanceM(a, { lon: next[0], lat: next[1] })).toBeLessThanOrEqual(12);
        expect(result.coordinates.length).toBeGreaterThan(2);
        for (let i = 1; i < result.coordinates.length; i++) {
            const from = result.coordinates[i - 1],
                to = result.coordinates[i];
            for (let j = 0; j <= 100; j++)
                expect(
                    booleanPointInPolygon(
                        [from[0] + ((to[0] - from[0]) * j) / 100, from[1] + ((to[1] - from[1]) * j) / 100],
                        water.features[0],
                    ),
                ).toBe(true);
        }
    });
    it('rejects a blocked required midpoint instead of snapping it or bypassing that marker gate', () => {
        const gate = p(50, 210);
        const obstacles: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [gate.lon, gate.lat] } },
            ],
        };
        expect(() =>
            buildCanalDepartureGeometry(start, exit, canalDepartureBbox(start, exit), water, obstacles, [gate, exit]),
        ).toThrow(/verified marker gate is outside mapped unobstructed water/);
    });
    it.each([
        [],
        [p(50, 210)],
        [p(50, 210), p(50, 210), exit],
        [p(50, 500), exit],
        [{ lat: NaN, lon: 153 }, exit],
        Array.from({ length: 25 }, (_, i) => p(50, 100 + i)),
    ])('rejects malformed, repeated, oversized or out-of-crop gate constraints', (...gates) => {
        expect(() =>
            buildCanalDepartureGeometry(start, exit, canalDepartureBbox(start, exit), water, empty, gates),
        ).toThrow(/profile|marker gate|map area/);
    });
    it('refuses a thin wall across the connected channel, with no straight fallback', () => {
        const obstacles: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: [ll(-10, 150), ll(110, 150)] },
                },
            ],
        };
        expect(() => build(obstacles)).toThrow(/No connected canal exit/);
    });
    it('refuses a closed bridge span and disconnected basins', () => {
        expect(() =>
            build(
                poly([
                    [-10, 149],
                    [110, 149],
                    [110, 151],
                    [-10, 151],
                    [-10, 149],
                ]),
            ),
        ).toThrow(/No connected/);
        const separated = {
            ...empty,
            features: [
                ...poly([
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [0, 100],
                    [0, 0],
                ]).features,
                ...poly([
                    [300, 0],
                    [400, 0],
                    [400, 100],
                    [300, 100],
                    [300, 0],
                ]).features,
            ],
        };
        expect(() => build(empty, separated)).toThrow(/No connected/);
    });
    it('does not snap a point on land into a different water body', () => {
        expect(() =>
            buildCanalDepartureGeometry(p(200, 100), exit, canalDepartureBbox(p(200, 100), exit), water, empty),
        ).toThrow(/outside mapped/);
    });
    it('missing water remains unavailable, not an ocean shortcut', () => {
        expect(() => build(empty, empty)).toThrow(/outside mapped/);
    });
    it('preserves holes in a water polygon', () => {
        const holeWater = poly([
            [0, 0],
            [400, 0],
            [400, 250],
            [0, 250],
            [0, 0],
        ]);
        holeWater.features[0].geometry.coordinates.push(
            [
                [100, 5],
                [300, 5],
                [300, 175],
                [100, 175],
                [100, 5],
            ].map(([x, y]) => ll(x, y)),
        );
        const result = build(empty, holeWater);
        expect(result.coordinates.some((c) => c[1] > ll(0, 175)[1])).toBe(true);
    });
    it('checks provider segments inside the crop, even if both ends are outside it', () => {
        const { grid } = build();
        expect(canalSegmentsInWater([ll(-1000, 50), ll(1000, 50)], grid, true)).toBe(false);
        expect(canalSegmentsInWater([ll(50, 210), ll(350, 210)], grid, true)).toBe(true);
        expect(canalSegmentsInWater([ll(-1000, 1000), ll(1000, 1000)], grid, true)).toBe(true);
    });
    it('caps span, resolution and allocation; rejects polar/invalid coordinates', () => {
        expect(() => canalDepartureBbox(start, p(16000, 100))).toThrow(/too large/);
        expect(() => canalDepartureBbox(start, start)).toThrow(/20 m/);
        expect(() => canalDepartureBbox({ lat: NaN, lon: 153 }, exit)).toThrow(/valid/);
        expect(() => canalDepartureBbox({ lat: 85, lon: 153 }, exit)).toThrow(/valid/);
        expect(() => canalDepartureBbox(start, p(2800, 2800))).toThrow(/too large/);
    });
    it('routes the captured Newport canal bend without crossing the independent polygon boundary or pontoons', () => {
        const buf = readFileSync(join(__dirname, 'fixtures/mapbox-water-16-60637-37918.mvt'));
        const features = decodeWaterFromTile(buf, 16, 60637, 37918);
        const overlay = JSON.parse(
            gunzipSync(readFileSync(join(__dirname, 'fixtures/newport-canal-osm.json.gz'))).toString(),
        );
        // Two recorded canal-centre vertices within this ONE captured tile;
        // the full Newport exit spans other tiles fetched by the live adapter.
        const a = { lon: 153.0922886, lat: -27.2102277 },
            b = { lon: 153.0927659, lat: -27.2069373 };
        const result = buildCanalDepartureGeometry(
            a,
            b,
            canalDepartureBbox(a, b),
            { type: 'FeatureCollection', features },
            overlay.berths,
        );
        expect(result.coordinates.length).toBeGreaterThan(3);
        // Check each pontoon independently: Turf over a FeatureCollection also
        // reports intersections BETWEEN its different pontoon features.
        for (const berth of overlay.berths.features)
            expect(lineIntersect({ type: 'LineString', coordinates: result.coordinates }, berth).features).toHaveLength(
                0,
            );
        for (let i = 1; i < result.coordinates.length; i++) {
            const prev = result.coordinates[i - 1],
                next = result.coordinates[i];
            for (let s = 0; s <= 200; s++) {
                const t = s / 200;
                const pt: Position = [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t];
                expect(features.some((f) => booleanPointInPolygon(pt, f))).toBe(true);
            }
        }
    });
});
