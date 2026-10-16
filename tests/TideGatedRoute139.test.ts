import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { routeInshore } from '../services/inshoreRouterEngine';
import type { NavGrid, RouteRequest } from '../services/engine/types';
import { applyTideSoundingMinima } from '../services/engine/tideGatedRoute';
import { buildExclusionField, routeExclusionConflict } from '../services/engine/exclusionField';
const T = Date.parse('2026-10-17T01:00:23.456Z');
const rect = (w: number, s: number, e: number, n: number, properties = {}): Feature<Polygon> => ({
    type: 'Feature',
    properties: { acronym: 'DEPARE', ...properties },
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
function request(): RouteRequest {
    return {
        fromLat: 0,
        fromLon: -0.0015,
        toLat: 0,
        toLon: 0.0015,
        draftM: 2,
        safetyM: 0.5,
        unchartedPolicy: 'strict',
        _tideCandidate: {
            enabled: true,
            from: { lat: 0, lon: -0.0015 },
            to: { lat: 0, lon: 0.0015 },
            departureMs: T,
            speedKts: 6,
            requiredM: 2.5,
            expiresAtMs: T + 3600000,
            uncertaintyMs: 60000,
            maxJourneyMs: 900000,
            areas: [
                {
                    id: 'fictional-bank',
                    geometry: rect(-0.001, -0.002, 0.001, 0.002).geometry,
                    coverage: [-0.01, -0.01, 0.01, 0.01],
                    station: { lat: 0, lon: 0 },
                    maxDistanceKm: 15,
                    chartedDepthM: 1,
                    windows: [{ fromMs: T - 3600000, untilMs: T + 3600000, minLowM: 2 }],
                },
            ],
        },
    };
}
const layers = () => ({
    DEPARE: fc(
        rect(-0.2, -0.2, -0.00035, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
        rect(0.00035, -0.2, 0.2, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
        rect(-0.00035, 0.0009, 0.00035, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
        rect(-0.00035, -0.2, 0.00035, -0.0009, { DRVAL1: 5, DRVAL2: 10 }),
        rect(-0.00035, -0.0009, 0.00035, 0.0009, { DRVAL1: 1, DRVAL2: 2 }),
    ),
});
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(T + 1000));
afterEach(() => vi.restoreAllMocks());
describe('optional tide route through the real strict grid/engine', () => {
    it('returns an unsmoothed exact candidate clock and amber segments', () => {
        const r = routeInshore(layers(), request());
        expect('polyline' in r, JSON.stringify(r)).toBe(true);
        if ('error' in r) return;
        expect(r._tideCandidatePath?.tideCells.length).toBeGreaterThan(0);
        expect(r.polyline[0]).toEqual([-0.0015, 0]);
        expect(r.polyline.at(-1)).toEqual([0.0015, 0]);
        expect(r.channelMask?.every(Boolean)).toBe(true);
        expect(r._tideCandidatePath?.timesMs[0]).toBe(T);
    });
    it.each(['RESARE', 'TSEZNE', 'USER_NOGO'] as const)(
        'cannot clear a %s no-go with a tide hint or forged field',
        (key) => {
            const block = fc(rect(-0.0005, -0.003, 0.0005, 0.003, { RESTRN: 7 }));
            const original = { ...layers(), [key]: block };
            const r = routeInshore(original, { ...request(), _exclusionField: { areas: [] } });
            if ('polyline' in r)
                expect(
                    routeExclusionConflict(
                        r.polyline,
                        buildExclusionField({
                            RESARE: original.RESARE,
                            TSEZNE: original.TSEZNE,
                            manual: original.USER_NOGO,
                        }),
                    ),
                ).toBeNull();
            else expect(r.code).toBe('tide-window-unavailable');
        },
    );
    it('holds when the complete crossing interval misses the window', () => {
        const req = request();
        req._tideCandidate!.areas[0].windows[0].untilMs = T + 30000;
        const r = routeInshore(layers(), req);
        expect('error' in r && r.code).toBe('tide-window-unavailable');
    });
    it('rejects a worker request with a different speed-derived depth contract or endpoint', () => {
        const req = request();
        req._tideCandidate!.requiredM = 2;
        const r = routeInshore(layers(), req);
        expect('error' in r && r.code).toBe('tide-window-unavailable');
    });
});
describe('original sounding minima never supply area coverage', () => {
    function grid(): NavGrid {
        return {
            width: 3,
            height: 1,
            minLon: 0,
            minLat: 0,
            dLon: 0.001,
            dLat: 0.001,
            cells: new Float32Array([5, -1, NaN]),
            preferred: new Uint8Array(3),
            shallowDepthM: new Float32Array([NaN, NaN, NaN]),
            exclusionBlocked: new Uint8Array([0, 0, 1]),
        };
    }
    it('a deep sounding does not block or raise the original band and cannot open unknown water', () => {
        const g = grid();
        applyTideSoundingMinima(g, [{ lat: 0.0005, lon: 0.0015, depthM: 20 }]);
        expect(g.cells[0]).toBe(5);
        expect(g.shallowDepthM![0]).toBe(5);
        expect(g.cells[1]).toBe(-1);
        expect(g.shallowDepthM![1]).toBeNaN();
        expect(g.cells[2]).toBeNaN();
    });
    it('a shallow sounding lowers a band, while an original signed drying depth remains blocked', () => {
        const g = grid();
        g.shallowDepthM![1] = 1;
        applyTideSoundingMinima(g, [{ lat: 0.0005, lon: 0.0005, depthM: 0.6 }]);
        expect(g.cells[0]).toBeCloseTo(0.6);
        expect(g.shallowDepthM![1]).toBeCloseTo(0.6);
        applyTideSoundingMinima(g, [{ lat: 0.0005, lon: 0.0005, depthM: -0.2 }]);
        expect(g.cells[0]).toBeNaN();
        expect(g.cells[1]).toBeNaN();
    });
    it('a malformed original depth cannot become a zero or a navigation credit', () => {
        expect(() => applyTideSoundingMinima(grid(), [{ lat: 0.0005, lon: 0.0005, depthM: NaN }])).toThrow(/unknown/);
    });
});
