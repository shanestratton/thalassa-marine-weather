import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../services/inshoreRouterEngine';
import { buildExclusionField, routeExclusionConflict } from '../services/engine/exclusionField';
import { runRouteJob, type RouteJob } from '../services/routing/routeJob';
import { auditFinishedRouteExclusions } from '../services/engine/exclusionField';
import { inshoreRouteCaveats, savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { inshoreRouteToGeoJSON } from '../services/InshoreRouter';

const rect = (w: number, s: number, e: number, n: number, properties = {}): Feature<Polygon> => ({
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
const request: RouteRequest = {
    fromLon: 164.01,
    fromLat: -27.2,
    toLon: 164.03,
    toLat: -27.2,
    draftM: 2,
    safetyM: 0.5,
    resolutionM: 50,
    unchartedPolicy: 'strict',
};
const depth = fc(rect(163.95, -27.27, 164.09, -27.13, { DRVAL1: 10, DRVAL2: 20 }));
const obstacle = rect(164.018, -27.203, 164.022, -27.197, { RESTRN: 7 });

describe('139 exclusion application through the real engine', () => {
    const cloudJob = (layers: InshoreLayers): RouteJob => ({
        layers,
        routeOpts: {
            ...request,
            safetyM: 0.5,
            obstructionBufferM: 30,
            unchartedPolicy: 'strict',
            surveyUncheckedCells: [],
        },
        origin: { lat: request.fromLat, lon: request.fromLon },
        destination: { lat: request.toLat, lon: request.toLon },
        airDraftM: null,
        cellsUsed: [],
        structuresUnknownCells: [],
        structuresUnknownBboxes: [],
        regionalPairs: [],
        leadGraph: null,
        tideCeilings: [],
        cloud: {
            polyline: [
                [request.fromLon, request.fromLat],
                [request.toLon, request.toLat],
            ],
            distanceNM: 1,
            elapsedMs: 0,
        },
    });
    it('refuses a cloud or post-processor line that skips the engine masks', () => {
        const job = cloudJob({ DEPARE: depth, USER_NOGO: fc(obstacle) });
        const output = runRouteJob(job);
        expect(output.result && 'error' in output.result && output.result.code).toBe('route-exclusion');
        expect(auditFinishedRouteExclusions(job.layers, job.cloud!.polyline)?.code).toBe('route-exclusion');
    });
    it('keeps a malformed hard source unavailable even after a candidate line exists', () => {
        const bad = rect(164.018, -27.203, 164.022, -27.197);
        bad.geometry.coordinates[0].pop();
        expect(auditFinishedRouteExclusions({ USER_NOGO: fc(bad) }, cloudJob({}).cloud!.polyline)?.code).toBe(
            'exclusion-unavailable',
        );
    });
    it('discloses missing class coverage only when the final route crosses that chart', () => {
        const job = cloudJob({ DEPARE: depth });
        job.exclusionsUnknownBboxes = [[164, -27.21, 164.04, -27.19]];
        const result = runRouteJob(job).result;
        expect(result && 'polyline' in result && result.exclusionsUnchecked).toBe(true);
        const away = runRouteJob({ ...job, exclusionsUnknownBboxes: [[165, -28, 166, -27]] }).result;
        expect(away && 'polyline' in away && away.exclusionsUnchecked).toBeUndefined();
        expect(inshoreRouteCaveats({ exclusionsUnchecked: true })).toContainEqual(
            expect.stringContaining('Area restrictions were not fully checked'),
        );
        if (!result || 'error' in result) return;
        const saved = inshoreRouteToGeoJSON(result, job.origin, job.destination);
        expect(saved.properties?.exclusionsUnchecked).toBe(true);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: saved })).toContainEqual(
            expect.stringContaining('Area restrictions were not fully checked'),
        );
    });
    it('keeps ordinary routes unchanged when only unrelated no-anchoring restrictions are present', () => {
        const plain = routeInshore({ DEPARE: depth }, request);
        const unrelated = routeInshore(
            { DEPARE: depth, RESARE: fc({ ...obstacle, properties: { RESTRN: 1 } }) },
            request,
        );
        expect('polyline' in plain).toBe(true);
        expect('polyline' in unrelated).toBe(true);
        if ('error' in plain || 'error' in unrelated) return;
        const { phaseTimings: firstTiming, ...firstResult } = plain;
        const { phaseTimings: cachedTiming, ...cachedResult } = unrelated;
        expect(firstTiming).toBeDefined();
        expect(cachedTiming).toBeDefined();
        expect(cachedResult).toEqual(firstResult);
    });
    it.each(['RESARE', 'TSEZNE', 'USER_NOGO'] as const)(
        'detours around %s and audits the complete finished polyline',
        (key) => {
            const layers: InshoreLayers = { DEPARE: depth, [key]: fc(obstacle) };
            const result = routeInshore(layers, request);
            expect('polyline' in result).toBe(true);
            if ('error' in result) return;
            const field = buildExclusionField({
                RESARE: layers.RESARE,
                TSEZNE: layers.TSEZNE,
                manual: layers.USER_NOGO,
            });
            expect(routeExclusionConflict(result.polyline, field)).toBeNull();
            expect(result.polyline.some((p) => Math.abs(p[1] + 27.2) > 0.003)).toBe(true);
        },
    );
    it('rejects a pin inside a hard polygon even with a forged empty compiled field', () => {
        const result = routeInshore(
            { DEPARE: depth, USER_NOGO: fc(obstacle) },
            { ...request, fromLon: 164.02, _exclusionField: { areas: [] } },
        );
        expect('error' in result && result.code).toBe('route-exclusion');
    });
    it('refuses malformed active hard geometry instead of dropping it', () => {
        const bad = rect(164.018, -27.203, 164.022, -27.197);
        bad.geometry.coordinates[0].pop();
        const result = routeInshore({ DEPARE: depth, USER_NOGO: fc(bad) }, request);
        expect('error' in result && result.code).toBe('exclusion-unavailable');
    });
});
