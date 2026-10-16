import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../services/inshoreRouterEngine';
import { buildExclusionField, routeExclusionConflict } from '../services/engine/exclusionField';

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
