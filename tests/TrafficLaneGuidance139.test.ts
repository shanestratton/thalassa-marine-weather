import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import {
    buildTrafficLaneField,
    trafficLaneGridFields,
    auditTrafficLaneRoute,
    trafficCourseFactor,
    trafficGridCourse,
    trafficLaneStepFactor,
} from '../services/engine/trafficLanes';
import {
    applyExclusionField,
    buildExclusionField,
    auditFinishedRouteExclusions,
    finishedTrafficLaneGuidance,
} from '../services/engine/exclusionField';
import { aStar, chainCostM, chordCostM, lineOfSightClear } from '../services/engine/aStar';
import { smoothPath, deStaggerCentred, simplifyMarinaCells } from '../services/engine/pathShaping';
import { gridToLatLon } from '../services/engine/geometry';
import { navGridBytes } from '../services/engine/navGrid';
import type { NavGrid } from '../services/engine/types';
import { runRouteJob, type RouteJob } from '../services/routing/routeJob';
import { routeInshore } from '../services/inshoreRouterEngine';
const rect = (
    w = 164,
    s = -27.2,
    e = 164.01,
    n = -27.19,
    properties: Record<string, unknown> = {},
): Feature<Polygon> => ({
    type: 'Feature',
    properties,
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
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
function base(): NavGrid {
    return {
        width: 20,
        height: 20,
        minLon: 164,
        minLat: -27.2,
        dLon: 0.0005,
        dLat: 0.0005,
        cells: new Float32Array(400).fill(10),
        preferred: new Uint8Array(400),
        centreFactor: new Float32Array(400).fill(1),
        confined: new Uint8Array(400).fill(1),
    };
}
const grid = (properties: Record<string, unknown> = { ORIENT: 0 }) =>
    applyExclusionField(
        base(),
        buildExclusionField({ TSSLPT: fc(rect(undefined, undefined, undefined, undefined, properties)) }),
    );
describe('original S-57 lane orientation, with explicit unknowns', () => {
    it.each([0, 90, 180, 270, 360, '090.0'])('uses only original finite ORIENT %j', (value) => {
        const field = buildTrafficLaneField(fc(rect(undefined, undefined, undefined, undefined, { ORIENT: value })))!;
        expect(field.areas[0].direction).toBe(Number(value) % 360);
    });
    it.each([undefined, null, '', NaN, Infinity, -1, 361, 'north', '90degrees'])(
        'keeps missing/invalid orientation unknown: %j',
        (value) => {
            const field = buildTrafficLaneField(
                fc(rect(undefined, undefined, undefined, undefined, { ORIENT: value })),
            )!;
            expect(field.areas[0].direction).toBeNull();
            expect(
                auditTrafficLaneRoute(
                    [
                        [164.005, -27.191],
                        [164.005, -27.199],
                    ],
                    field,
                ),
            ).toEqual({ conflict: false, guidance: 'orientation-unknown' });
        },
    );
    it('does not infer flow from polygon order, aspect ratio or conflicting property names', () => {
        const feature = rect(undefined, undefined, undefined, undefined, { ORIENT: 0, orient: 180 });
        feature.geometry.coordinates[0].reverse();
        expect(buildTrafficLaneField(fc(feature))!.areas[0].direction).toBeNull();
    });
    it('clones only bounded original geometry and refuses incomplete or dateline source areas', () => {
        const original = rect(undefined, undefined, undefined, undefined, { ORIENT: 0, OBJNAM: 'licensed name' }),
            field = buildTrafficLaneField(fc(original))!;
        original.geometry.coordinates[0][0][0] = 0;
        expect(field.areas[0].geometry.coordinates[0][0][0]).toBe(164);
        expect(JSON.stringify(field)).not.toContain('licensed name');
        expect(() =>
            buildTrafficLaneField(
                fc({
                    type: 'Feature',
                    properties: { ORIENT: 0 },
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0, 0],
                            [1, 1],
                        ],
                    },
                }),
            ),
        ).toThrow('area');
        expect(() => buildTrafficLaneField(fc(rect(179, -1, -179, 1, { ORIENT: 0 })))).toThrow('dateline');
    });
});
describe('route-private lane fields and pricing', () => {
    it('does not write land/depth/preferred or cached chart fields; changed ORIENT gets a new private mask', () => {
        const cached = base();
        cached.cells[210] = NaN;
        cached.preferred[211] = 1;
        const bytes = navGridBytes(cached);
        const north = applyExclusionField(
            cached,
            buildExclusionField({ TSSLPT: fc(rect(undefined, undefined, undefined, undefined, { ORIENT: 0 })) }),
        );
        const south = applyExclusionField(
            cached,
            buildExclusionField({ TSSLPT: fc(rect(undefined, undefined, undefined, undefined, { ORIENT: 180 })) }),
        );
        expect(north.cells).toEqual(cached.cells);
        expect(north.preferred).toEqual(cached.preferred);
        expect(north.tssLane![210]).toBe(1);
        expect(Number.isNaN(north.cells[210])).toBe(true);
        expect(cached.tssLane).toBeUndefined();
        expect(navGridBytes(cached)).toBe(bytes);
        expect(north.tssDirection).not.toBe(south.tssDirection);
        expect(north.tssDirection![10]).toBe(0);
        expect(south.tssDirection![10]).toBe(180);
        expect(navGridBytes(north) - bytes).toBe(400 * 5);
    });
    it('marks conflicting overlapping flows unknown and preserves that status in the exact final audit', () => {
        const source = fc(
            rect(undefined, undefined, undefined, undefined, { ORIENT: 0 }),
            rect(undefined, undefined, undefined, undefined, { ORIENT: 180 }),
        );
        const field = buildTrafficLaneField(source)!,
            fields = trafficLaneGridFields(base(), field);
        expect(fields.tssLane![210]).toBe(2);
        expect(Number.isNaN(fields.tssDirection![210])).toBe(true);
        expect(
            auditTrafficLaneRoute(
                [
                    [164.005, -27.191],
                    [164.005, -27.199],
                ],
                field,
            ),
        ).toEqual({ conflict: false, guidance: 'orientation-unknown' });
    });
    it('favors flow and near-right-angle crossing, refusing reciprocal and oblique planned courses', () => {
        expect(trafficCourseFactor(0, 0)).toBe(1);
        expect(trafficCourseFactor(90, 0)).toBeGreaterThan(1);
        expect(trafficCourseFactor(80, 0)).toBeGreaterThan(trafficCourseFactor(90, 0));
        expect(trafficCourseFactor(180, 0)).toBe(Infinity);
        expect(trafficCourseFactor(45, 0)).toBe(Infinity);
        const g = grid(),
            a = { x: 2, y: 2 },
            b = { x: 2, y: 12 };
        expect(trafficLaneStepFactor(g, 42, 242, trafficGridCourse(g, a, b))).toBe(1);
        g.trackPrior = new Uint8Array(400).fill(2);
        g.trackPriorRequiredM = 2;
        expect(chainCostM(g, [a, b])).toBeGreaterThanOrEqual(0.9 * 10 * g.dLat * 111320);
    });
    it('A* follows flow/crossing, and cannot find an opposing path inside an all-lane grid', () => {
        const g = grid();
        expect(aStar(g, { x: 10, y: 2 }, { x: 10, y: 17 })).not.toBeNull();
        expect(aStar(g, { x: 2, y: 10 }, { x: 17, y: 10 })).not.toBeNull();
        expect(aStar(g, { x: 10, y: 17 }, { x: 10, y: 2 })).toBeNull();
    });
    it('keeps ordinary paths and chain prices unchanged when the lane source is absent or empty', () => {
        const a = base(),
            b = applyExclusionField(base(), buildExclusionField({ TSSLPT: fc() }));
        expect(b.tssLane).toBeUndefined();
        const from = { x: 2, y: 2 },
            to = { x: 16, y: 14 };
        expect(aStar(b, from, to)).toEqual(aStar(a, from, to));
        expect(chainCostM(b, [from, to])).toBe(chainCostM(a, [from, to]));
        const distant = applyExclusionField(
            base(),
            buildExclusionField({ TSSLPT: fc(rect(165, -28, 166, -27, { ORIENT: 0 })) }),
        );
        expect(distant.tssLane).toBeUndefined();
        expect(aStar(distant, from, to)).toEqual(aStar(a, from, to));
    });
    it('bounds source/grid work and cancels without mutating or partly adopting the cached chart grid', () => {
        expect(() => buildTrafficLaneField(fc(...Array.from({ length: 2001 }, () => rect())))).toThrow('bounded');
        const field = buildTrafficLaneField(fc(rect()))!,
            cached = base();
        expect(() => trafficLaneGridFields({ ...cached, width: 4001, height: 2000 }, field)).toThrow('budget');
        expect(() =>
            trafficLaneGridFields(cached, field, () => {
                throw Error('retired');
            }),
        ).toThrow('retired');
        expect(cached.tssLane).toBeUndefined();
        expect(cached.cells.every((value) => value === 10)).toBe(true);
    });
});
describe('smoothing and exact final lane geometry', () => {
    it('prices the actual chord course and preserves a flow/crossing bend through every grid simplifier', () => {
        const g = grid(),
            path = [
                { x: 2, y: 2 },
                { x: 2, y: 12 },
                { x: 12, y: 12 },
            ];
        expect(Number.isFinite(chainCostM(g, path))).toBe(true);
        expect(chordCostM(g, path[0], path[2])).toBe(Infinity);
        expect(lineOfSightClear(g, path[0], path[2])).toBe(false);
        for (const result of [smoothPath(g, path), deStaggerCentred(g, path, 20), simplifyMarinaCells(path, g)]) {
            expect(result.length).toBeGreaterThan(2);
            expect(
                auditTrafficLaneRoute(
                    result.map((p) => gridToLatLon(g, p.x, p.y)),
                    buildTrafficLaneField(fc(rect(undefined, undefined, undefined, undefined, { ORIENT: 0 }))),
                ),
            ).toEqual({ conflict: false, guidance: 'charted-flow' });
        }
    });
    it('checks complete line/polygon intervals, including a thin lane missed by coarse cell centres', () => {
        const source = fc(rect(164.0049999, -27.1951, 164.0050001, -27.1949, { ORIENT: 0 }));
        const field = buildTrafficLaneField(source)!;
        expect(
            auditTrafficLaneRoute(
                [
                    [164.0049, -27.1951],
                    [164.0051, -27.1949],
                ],
                field,
            ).conflict,
        ).toBe(true);
        expect(
            auditTrafficLaneRoute(
                [
                    [164.004, -27.195],
                    [164.006, -27.195],
                ],
                field,
            ),
        ).toEqual({ conflict: false, guidance: 'charted-flow' });
        expect(
            auditFinishedRouteExclusions({ TSSLPT: source }, [
                [164.0049, -27.1951],
                [164.0051, -27.1949],
            ])?.code,
        ).toBe('route-exclusion');
    });
    it('keeps hard separation zones closed regardless of a lane’s permitted direction', () => {
        const feature = rect(undefined, undefined, undefined, undefined, { ORIENT: 0 });
        const layers = { TSSLPT: fc(feature), TSEZNE: fc(feature) };
        expect(
            auditFinishedRouteExclusions(layers, [
                [164.005, -27.199],
                [164.005, -27.191],
            ])?.error,
        ).toContain('separation zone');
    });
    it('discloses unknown intersections and the final shared guard refuses an opposing postprocess', () => {
        const known = { TSSLPT: fc(rect(undefined, undefined, undefined, undefined, { ORIENT: 0 })) },
            line: [[number, number], [number, number]] = [
                [164.005, -27.199],
                [164.005, -27.191],
            ];
        expect(finishedTrafficLaneGuidance(known, line)).toBe('charted-flow');
        expect(auditFinishedRouteExclusions(known, [...line].reverse())?.code).toBe('route-exclusion');
        expect(finishedTrafficLaneGuidance({ TSSLPT: fc(rect()) }, line)).toBe('orientation-unknown');
        expect(finishedTrafficLaneGuidance({}, line)).toBeUndefined();
    });
    it('does not infer lane presence inside a complete polygon hole, and discloses ambiguous edge contact', () => {
        const feature = rect(undefined, undefined, undefined, undefined, { ORIENT: 0 });
        feature.geometry.coordinates.push([
            [164.004, -27.196],
            [164.006, -27.196],
            [164.006, -27.194],
            [164.004, -27.194],
            [164.004, -27.196],
        ]);
        const field = buildTrafficLaneField(fc(feature));
        expect(
            auditTrafficLaneRoute(
                [
                    [164.0045, -27.195],
                    [164.0055, -27.195],
                ],
                field,
            ),
        ).toEqual({ conflict: false });
        expect(
            auditTrafficLaneRoute(
                [
                    [164, -27.19],
                    [164.01, -27.19],
                ],
                field,
            ).guidance,
        ).toBe('orientation-unknown');
    });
    const job = (orient: unknown): RouteJob => ({
        layers: {
            DEPARE: fc(rect(163.99, -27.21, 164.02, -27.18, { DRVAL1: 10, DRVAL2: 20 })),
            TSSLPT: fc(rect(undefined, undefined, undefined, undefined, { ORIENT: orient })),
        },
        routeOpts: {
            fromLon: 164.002,
            fromLat: -27.195,
            toLon: 164.008,
            toLat: -27.195,
            draftM: 2,
            safetyM: 0.5,
            resolutionM: 50,
            obstructionBufferM: 30,
            unchartedPolicy: 'strict',
            surveyUncheckedCells: [],
        },
        origin: { lon: 164.002, lat: -27.195 },
        destination: { lon: 164.008, lat: -27.195 },
        airDraftM: null,
        cellsUsed: [],
        structuresUnknownCells: [],
        structuresUnknownBboxes: [],
        regionalPairs: [],
        leadGraph: null,
        tideCeilings: [],
        cloud: {
            polyline: [
                [164.002, -27.195],
                [164.008, -27.195],
            ],
            distanceNM: 1,
            elapsedMs: 0,
        },
    });
    it('carries lane guidance through the actual worker/main job and rejects an opposing external candidate', () => {
        const good = runRouteJob(job(90)).result;
        expect(good && 'polyline' in good && good.trafficLaneGuidance).toBe('charted-flow');
        const opposite = runRouteJob(job(270)).result;
        expect(opposite && 'error' in opposite && opposite.code).toBe('route-exclusion');
        const unknown = runRouteJob(job(undefined)).result;
        expect(unknown && 'polyline' in unknown && unknown.trafficLaneGuidance).toBe('orientation-unknown');
    });
    it('uses original TSSLPT again even if a request supplies a forged compiled field', () => {
        const sample = job(90),
            result = routeInshore(sample.layers, { ...sample.routeOpts, _exclusionField: { areas: [] } });
        expect('polyline' in result && result.trafficLaneGuidance).toBe('charted-flow');
        if ('polyline' in result) expect(auditFinishedRouteExclusions(sample.layers, result.polyline)).toBeNull();
    });
});
