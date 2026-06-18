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

describe('two-tier fine marina pass', () => {
    it('SHORT route (no pinned resolutionM) → fine pass accepted, finer grid, still clean', () => {
        // Marina-scale span (~0.04° < 0.06° threshold), no resolutionM → the
        // two-tier orchestrator runs the 50 m main route AND a ~10 m fine
        // pass, and (for clean open water that validates no-worse) keeps the
        // fine one. Region ~155 to dodge the count-keyed NavGrid cache.
        const deep = fc(rect(155.05, -27.25, 155.15, -27.15, { DRVAL1: 12.0 }));
        const r = routeInshore(
            { DEPARE: deep },
            { fromLat: -27.2, fromLon: 155.08, toLat: -27.2, toLon: 155.12, draftM: 2.0, safetyM: 1.0 },
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.twoTierFine).toBe(true); // fine pass won
        expect(r.debug?.gridSize.width).toBeGreaterThan(300); // ~10 m grid is fine
        expect((r.cautionMask ?? []).filter(Boolean).length).toBe(0); // never trades clean for red
    });

    it('a pinned resolutionM skips the fine pass (caller stays in control)', () => {
        const deep = fc(rect(155.5, -27.25, 155.6, -27.15, { DRVAL1: 12.0 }));
        const r = routeInshore({ DEPARE: deep }, baseReq({ fromLon: 155.53, toLon: 155.57 })); // resolutionM:100
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.twoTierFine).toBeFalsy(); // explicit res → main only
    });
});

describe('Fairlead — end-to-end through routeInshore (grid-validated, open-water)', () => {
    function point(lon: number, lat: number, props: Record<string, unknown>): Feature {
        return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } };
    }

    it('follows a buoyed channel in open water', () => {
        // Wide open DEPARE (no land within 150 m → open water everywhere) with a
        // buoyed channel along it (marks ~1 km apart). A route straight along
        // the band transits the channel → Fairlead fires.
        const deep = fc(rect(156.04, -27.206, 156.16, -27.194, { DRVAL1: 12.0 }));
        const stbd: Feature[] = [156.08, 156.09, 156.1, 156.11].map((lon, i) =>
            point(lon, -27.203, { CATLAM: 2, OBJNAM: `BC${2 * i + 1}` }),
        );
        const port: Feature[] = [156.085, 156.095, 156.105, 156.115].map((lon, i) =>
            point(lon, -27.197, { CATLAM: 1, OBJNAM: `BC${2 * i + 2}` }),
        );
        const r = routeInshore(
            { DEPARE: deep, BOYLAT: fc(...stbd, ...port) },
            baseReq({ fromLon: 156.05, toLon: 156.15, fromLat: -27.2, toLat: -27.2 }),
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // RE-PIN 2026-06-18 (3-tier Phase 4 + tier3 channel-follow, c05e9d02):
        // the route STILL follows the BC channel — but the fairlead now runs
        // inside the tier-3 span, so the provenance moved from
        // debug.fairlead='BC' to debug.threeTier='tier3:fairlead(BC)'. Same
        // intent (buoyed-channel follow), new path. Verified the debug live.
        expect(r.debug?.threeTier).toContain('fairlead(BC)');
    });

    it('REGRESSION: marks whose centreline crosses LNDARE land → does NOT fire, route never on land', () => {
        // The Newport failure shape: a buoyed "channel" whose midline cuts
        // across a land block. The grid (LNDARE-rasterised) makes those cells
        // land, so Fairlead's grid-validated splice must abort — no straight
        // line across land. The route detours around the block in clean water.
        const deep = fc(rect(156.34, -27.214, 156.46, -27.186, { DRVAL1: 12.0 }));
        const land = fc(rect(156.38, -27.203, 156.42, -27.197)); // block straddling the midline
        // Marks straddle the block (stbd south, port north) so their centreline
        // (lat ~-27.20) runs straight THROUGH the land block.
        const stbd: Feature[] = [156.36, 156.37, 156.43, 156.44].map((lon, i) =>
            point(lon, -27.207, { CATLAM: 2, OBJNAM: `BC${2 * i + 1}` }),
        );
        const port: Feature[] = [156.365, 156.375, 156.425, 156.435].map((lon, i) =>
            point(lon, -27.193, { CATLAM: 1, OBJNAM: `BC${2 * i + 2}` }),
        );
        const r = routeInshore(
            { DEPARE: deep, LNDARE: land, BOYLAT: fc(...stbd, ...port) },
            baseReq({ fromLon: 156.35, toLon: 156.45, fromLat: -27.2, toLat: -27.2 }),
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.fairlead).toBeUndefined(); // grid-validation aborted the across-land splice
        // And no polyline point sits inside the land block.
        for (const [lon, lat] of r.polyline) {
            const inLand = lon >= 156.38 && lon <= 156.42 && lat >= -27.203 && lat <= -27.197;
            expect(inLand).toBe(false);
        }
    });
});

describe('marina-centerline — clean-prefix scoping on mixed routes', () => {
    it('fires on the clean canal prefix even when the route later crosses caution', () => {
        // The Newport->Scarborough shape: a deep (clean) canal prefix in the
        // west + a shallow (caution) bay suffix in the east. The whole route
        // used to fall back to corner-cutting A* because of the downstream
        // caution; now the centerline owns the clean canal prefix and A* keeps
        // the caution bay. Region ~157 + 2 DEPARE features (distinct count) to
        // dodge the bbox+count-keyed NavGrid cache.
        const deepCanal = rect(157.04, -27.205, 157.09, -27.195, { DRVAL1: 12.0 }); // clean prefix
        const shallowBay = rect(157.09, -27.205, 157.13, -27.195, { DRVAL1: 1.0 }); // caution suffix
        const r = routeInshore(
            { DEPARE: fc(deepCanal, shallowBay) },
            {
                fromLat: -27.2,
                fromLon: 157.05,
                toLat: -27.2,
                toLon: 157.12,
                draftM: 2.0,
                safetyM: 1.0,
                resolutionM: 50,
            },
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.marinaCenterline).toBe(true); // fired on the clean prefix despite downstream caution
        expect((r.cautionMask ?? []).filter(Boolean).length).toBeGreaterThan(0); // caution bay still flagged red
    });
});
