/**
 * NTM survey-override zones — the Mooloolah-bar mechanism in miniature.
 *
 * A fresh MSQ survey (acknowledged + current, injected as NTMZONE) must:
 *   1. override the chart's depth in BOTH directions (a drying ENC band
 *      becomes surveyed-1.4 caution; a 2–5 m ENC band becomes surveyed-1.4
 *      caution) with the surveyed depth carried into shallowRuns;
 *   2. grade caution price by requiredRise so the router crosses the DEEPEST
 *      surveyed water (the 2.5 m alternative corridor) instead of the
 *      geometrically shorter 1.4 m shoal — even at ~2× the crossing length,
 *      the real Mooloolah geometry ratio;
 *   3. leave ordinary chart caution at the flat 40× (no NTMZONE ⇒ no change).
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import { cellCostMultiplier } from '../../services/engine/aStar';
import type { FeatureCollection, Feature, Position } from 'geojson';

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

// Geometry (all at ~-27.9): a deep basin with a shallow BAR band at mid-lon
// blocking the west→east passage. The bar is charted 2.0 m on the chart
// (caution for the 2.9 m floor). The survey says: the direct crossing at the
// endpoints' latitude is really 1.4 m; a corridor ~1 km NORTH is really 2.5 m.
const BAR_W = 152.52;
const BAR_E = 152.523; // ~300 m wide band
const layers = {
    DEPARE: fc(
        rect(152.5, -27.93, BAR_W, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // west deep
        rect(BAR_W, -27.93, BAR_E, -27.88, { DRVAL1: 2.0, acronym: 'DEPARE' }), // the charted bar
        rect(BAR_E, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // east deep
    ),
};
// Survey zones spanning the bar band: shallow at the direct line, deeper north.
const surveyZone = (minLat: number, maxLat: number, depthM: number, label: string): Feature =>
    rect(BAR_W - 0.0002, minLat, BAR_E + 0.0002, maxLat, {
        _class: 'ntm-survey',
        depthM,
        _noticeKey: 'T1',
        _label: label,
    });
const NTMZONE = fc(
    surveyZone(-27.93, -27.905, 1.4, 'surveyed shoal (direct line)'),
    surveyZone(-27.905, -27.9, 2.5, 'surveyed alternative corridor'),
    surveyZone(-27.9, -27.88, 1.4, 'surveyed shoal (north)'),
);
const base: RouteRequest = {
    fromLat: -27.918,
    fromLon: 152.505,
    toLat: -27.918,
    toLon: 152.54,
    draftM: 2.4,
    safetyM: 0.5, // floor 2.9
    resolutionM: 50,
};

function crossingLat(poly: [number, number][]): number {
    const lats: number[] = [];
    for (let i = 0; i + 1 < poly.length; i++) {
        for (let s = 0; s <= 20; s++) {
            const t = s / 20;
            const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
            if (lon > BAR_W && lon < BAR_E) lats.push(poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t);
        }
    }
    return lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length);
}

describe('NTM survey-override zones', () => {
    it('grades the caution multiplier by surveyed requiredRise; plain caution stays flat', () => {
        // Plain chart caution: flat 40× (drying 120×, assist 10×) — unchanged.
        expect(cellCostMultiplier(-1, false)).toBe(40.0);
        expect(cellCostMultiplier(-1, false, true)).toBe(120.0);
        expect(cellCostMultiplier(-1, false, false, true)).toBe(10.0);
        // Surveyed caution grades by rise: 15 + 40·rise, capped [5, 110].
        expect(cellCostMultiplier(-1, false, false, false, 0.4)).toBeCloseTo(31.0);
        expect(cellCostMultiplier(-1, false, false, false, 1.5)).toBeCloseTo(75.0);
        expect(cellCostMultiplier(-1, false, false, false, 9)).toBe(110.0);
        // Under the tideAssist profile the grading rides the assist scale.
        expect(cellCostMultiplier(-1, false, false, true, 0.4)).toBeCloseTo(9.0);
        expect(cellCostMultiplier(-1, false, false, true, 1.5)).toBeCloseTo(20.0);
    });

    it('WITHOUT the survey: crosses the charted 2.0 m bar on the direct line', () => {
        const r = routeInshore(layers, base);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // Flat caution — no reason to detour; crossing stays near the endpoints' latitude.
        expect(Math.abs(crossingLat(r.polyline) - -27.918)).toBeLessThan(0.004);
        const runs = r.shallowRuns ?? [];
        expect(runs.some((x) => x.minDepthM === 2 && !x.ntmSurveyed)).toBe(true);
    });

    it('WITH the survey: detours to the 2.5 m surveyed corridor and ships the surveyed depth', () => {
        const r = routeInshore({ ...layers, NTMZONE }, base);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // The graded pricing must pull the crossing ~1.4 km north into the
        // surveyed 2.5 m corridor (rise 0.4 → 31×) instead of the direct
        // 1.4 m shoal (rise 1.5 → 75×).
        const lat = crossingLat(r.polyline);
        expect(lat).toBeGreaterThan(-27.905);
        expect(lat).toBeLessThan(-27.9);
        const runs = r.shallowRuns ?? [];
        // The run's depth is the SURVEY's 2.5, not the chart's 2.0 — and says so.
        expect(runs.some((x) => x.minDepthM === 2.5 && x.ntmSurveyed === true)).toBe(true);
        // requiredRise for the chip: 2.9 − 2.5 = +0.4 m above LAT.
    });

    it('never carves REAL land: a DEPARE-less plug (breakwater class) stays blocked', () => {
        // The plug has NO chart water claim beneath it — the bar band is split
        // around it — so the survey zone must NOT reopen it (a true breakwater
        // is charted LNDARE with no DEPARE under the structure).
        const landLayers = {
            DEPARE: fc(
                rect(152.5, -27.93, BAR_W, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }),
                rect(BAR_W, -27.93, BAR_E, -27.906, { DRVAL1: 2.0, acronym: 'DEPARE' }), // bar south of plug
                rect(BAR_W, -27.899, BAR_E, -27.88, { DRVAL1: 2.0, acronym: 'DEPARE' }), // bar north of plug
                rect(BAR_E, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }),
            ),
            LNDARE: fc(rect(BAR_W - 0.0005, -27.906, BAR_E + 0.0005, -27.899, {})), // plug over the corridor
        };
        const r = routeInshore({ ...landLayers, NTMZONE }, base);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const inPlug = (r.polyline as Position[]).some(
            ([lon, lat]) => lon > BAR_W - 0.0005 && lon < BAR_E + 0.0005 && lat > -27.906 && lat < -27.899,
        );
        expect(inPlug).toBe(false);
    });

    it('REOPENS the land-vs-charted-water conflict class inside a zone (generalised LNDARE over DEPARE)', () => {
        // Same corridor plug, but here the chart's 2.0 m bar band runs UNDER
        // the land paint (the Mooloolah entrance: 1:90k coastal LNDARE over
        // the harbour cell's D2-5) — the fresh survey resolves the conflict
        // to water and the route rides the surveyed 2.5 m corridor through it.
        const conflictLayers = {
            DEPARE: layers.DEPARE, // bar band continuous — a water claim under the plug
            LNDARE: fc(rect(BAR_W - 0.0005, -27.906, BAR_E + 0.0005, -27.899, {})),
        };
        const r = routeInshore({ ...conflictLayers, NTMZONE }, base);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const lat = crossingLat(r.polyline);
        expect(lat).toBeGreaterThan(-27.905);
        expect(lat).toBeLessThan(-27.9);
        const runs = r.shallowRuns ?? [];
        expect(runs.some((x) => x.minDepthM === 2.5 && x.ntmSurveyed === true)).toBe(true);
    });
});
