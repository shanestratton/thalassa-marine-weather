/**
 * shallowRuns — the Phase 7 tide-window substrate.
 *
 * The engine must ship, per contiguous charted-shallow caution run ≥200 m on
 * the final polyline: its length, its along-track midpoint, and the REAL
 * charted min depth (the DRVAL1 the CAUTION sentinel erases, retained in
 * grid.shallowDepthM) — or minDepthM null when nothing charted vouches a depth
 * (uncharted caution), so no caller can fabricate a tide window from a hole in
 * the chart.
 *
 * Synthetic, CI-able, distinct lon region per the NavGrid cache-collision rule.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import type { FeatureCollection, Feature } from 'geojson';

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });

const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

describe('RouteResult.shallowRuns', () => {
    it('a charted-shallow band mid-corridor yields one run with the REAL DRVAL1 as minDepthM', () => {
        // West deep | 1 km band of DRVAL1=1.5 | east deep. Draft 2 + safety 1 →
        // floor 3 m, so the band reads CAUTION and A* has no cheaper way around
        // (outside the DEPARE rects is unknown-open at 500×).
        const FROM = { lat: -27.95, lon: 152.605 };
        const TO = { lat: -27.95, lon: 152.635 };
        const layers = {
            DEPARE: fc(
                rect(152.6, -27.96, 152.615, -27.94, { DRVAL1: 10, acronym: 'DEPARE' }),
                rect(152.615, -27.96, 152.625, -27.94, { DRVAL1: 1.5, acronym: 'DEPARE' }),
                rect(152.625, -27.96, 152.64, -27.94, { DRVAL1: 10, acronym: 'DEPARE' }),
            ),
        };
        const req: RouteRequest = {
            fromLat: FROM.lat,
            fromLon: FROM.lon,
            toLat: TO.lat,
            toLon: TO.lon,
            draftM: 2.0,
            safetyM: 1.0,
            resolutionM: 100,
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;

        const runs = r.shallowRuns ?? [];
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const main = runs.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
        // The REAL charted depth, not the CAUTION sentinel and not the floor.
        expect(main.minDepthM).toBe(1.5);
        // ~985 m band; allow smoothing/grid-quantisation spill either side.
        expect(main.lengthM).toBeGreaterThan(500);
        expect(main.lengthM).toBeLessThan(2000);
        // Midpoint lands inside the shallow band.
        expect(main.midLon).toBeGreaterThan(152.612);
        expect(main.midLon).toBeLessThan(152.628);
        // Segment indices index the FINAL polyline's segments.
        expect(main.startSeg).toBeGreaterThanOrEqual(0);
        expect(main.endSeg).toBeLessThan(r.polyline.length - 1);
        expect(main.endSeg).toBeGreaterThanOrEqual(main.startSeg);
    });

    it('an UNCHARTED caution run ships minDepthM null — never a fabricated depth', () => {
        // Same corridor shape but the middle band has NO DEPARE at all: under
        // unchartedPolicy 'strict' the crossing flags caution with zero charted
        // depth evidence, so the run must carry minDepthM null (a tide window
        // computed there would be invented).
        const FROM = { lat: -27.85, lon: 152.705 };
        const TO = { lat: -27.85, lon: 152.735 };
        const layers = {
            DEPARE: fc(
                rect(152.7, -27.86, 152.715, -27.84, { DRVAL1: 10, acronym: 'DEPARE' }),
                rect(152.725, -27.86, 152.74, -27.84, { DRVAL1: 10, acronym: 'DEPARE' }),
            ),
        };
        const req: RouteRequest = {
            fromLat: FROM.lat,
            fromLon: FROM.lon,
            toLat: TO.lat,
            toLon: TO.lon,
            draftM: 2.0,
            safetyM: 1.0,
            resolutionM: 100,
            unchartedPolicy: 'strict',
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;

        const runs = r.shallowRuns ?? [];
        expect(runs.length).toBeGreaterThanOrEqual(1);
        const main = runs.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
        expect(main.minDepthM).toBeNull();
    });
});
