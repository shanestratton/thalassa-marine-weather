/**
 * Inshore router — marina-centerline refinement gate.
 *
 * Proves the integration of services/marinaCenterline.ts into routeInshore
 * behaves at the boundary that keeps it safe:
 *   • CLEAN-water corridor  → centerline refinement FIRES (mid-channel
 *     straight legs), debug.marinaCenterline === true.
 *   • corridor with CAUTION → refinement FALLS BACK to the tuned A* path
 *     (debug.marinaCenterline falsy) and the caution stays flagged red.
 *
 * This is the guard that lets us add the centerline polish to clean
 * marina/canal/bay routes WITHOUT touching the Brisbane-bar-style routes
 * that must keep their red warnings.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
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

const FROM = { lat: -27.2, lon: 153.08 };
const TO = { lat: -27.2, lon: 153.12 };
function baseReq(over: Partial<RouteRequest> = {}): RouteRequest {
    return {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
        ...over,
    };
}
const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

describe('marina-centerline refinement gate', () => {
    it('CLEAN deep-water corridor → refinement fires, straight legs, no caution', () => {
        // Deep DEPARE over the whole domain (well over draft+safety) → the
        // A* corridor is entirely clean, so the centerline pass should run.
        const deep = fc(rect(153.05, -27.25, 153.15, -27.15, { DRVAL1: 12.0 }));
        const r = routeInshore({ DEPARE: deep }, baseReq());
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.marinaCenterline).toBe(true); // refinement fired
        expect((r.cautionMask ?? []).filter(Boolean).length).toBe(0); // clean
        // Centerline + string-pull on open water → a near-straight line.
        expect(r.polyline.length).toBeLessThanOrEqual(6);
    });

    it('corridor forced through CAUTION → falls back to A*, caution stays flagged', () => {
        // Shallow (DRVAL1 1.0 < draft+safety 3.0) = CAUTION across the
        // WHOLE padded grid (the engine pads ~0.08° of open water beyond the
        // data, so the rect must comfortably exceed the route bbox or the
        // route just detours through clean padding). With no clean escape
        // and no marked channel, the only route is through caution water —
        // the refinement must NOT fire (it would drop the red flags); the
        // tuned A* path with caution flags must win.
        //
        // NOTE: a different bbox region (lon ~154) from the clean test
        // above — the engine's NavGrid cache keys on bbox + feature COUNTS
        // (not values), so two 1-DEPARE-feature routes at the same bbox
        // would collide and the second would get the first's cached grid.
        const shallow = fc(rect(153.9, -27.4, 154.3, -27.0, { DRVAL1: 1.0 }));
        const r = routeInshore(
            { DEPARE: shallow },
            baseReq({ fromLon: 154.08, toLon: 154.12, draftM: 2.0, safetyM: 1.0 }),
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.marinaCenterline).toBeFalsy(); // fell back
        expect((r.cautionMask ?? []).filter(Boolean).length).toBeGreaterThan(0); // still red
    });
});
