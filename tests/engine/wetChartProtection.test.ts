/**
 * Wet-at-LAT S-57 protection — the Mooloolah sealed-river bug (2026-07-02).
 *
 * A charted narrow river (D2-5: wet at LAT, shallow for the keel) flanked by
 * LNDARE banks used to be unroutable end-to-end: the Pass-6 land buffer sealed
 * every cell of a ≤3-cell-wide unprotected CAUTION channel, and a coarser
 * cell's generalised LNDARE (which survives scale-shadow — the landmass
 * polygon is never fully inside the fine cell's bbox) hard-blocked it in
 * Pass 2. Result on the real Mooloolaba data: routes exited over the drying
 * beach spit at 120× because the charted front door didn't exist in the grid.
 *
 * The knob: S-57 DEPARE bands with DRVAL1 > 0 set protectedCells — a genuine
 * chart water claim that land paint and the buffer cannot erase. The cell
 * still PRICES as caution (40×, red). Drying bands (DRVAL1 ≤ 0) keep the old
 * behaviour: land wins, the buffer seals — a spit stays a spit.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
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

// A marina basin (deep, protected-class water) connected to the open sea ONLY
// by a narrow charted river: ~100 m wide (2 cells at 50 m), 1.2 km long,
// D2-5 (DRVAL1=2 → caution for the 2.9 m floor), flanked by LNDARE banks.
// A coarse-cell "generalised coastline" LNDARE blob also paints the river
// mouth. Sea on the east.
const RIVER_S = -27.9005;
const RIVER_N = -27.8995; // ~110 m wide
const layers = {
    DEPARE: fc(
        rect(152.5, -27.902, 152.505, -27.898, { DRVAL1: 10, acronym: 'DEPARE' }), // basin (deep)
        rect(152.505, RIVER_S, 152.517, RIVER_N, { DRVAL1: 2.0, acronym: 'DEPARE' }), // the river (wet, shallow)
        rect(152.517, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }), // open sea
    ),
    LNDARE: fc(
        rect(152.503, -27.898, 152.517, -27.88, {}), // north bank
        rect(152.503, -27.93, 152.517, -27.902, {}), // south bank
        // Generalised coarse-cell coastline blob across the river mouth — the
        // 1:90k class that survives scale-shadow and paints charted water.
        rect(152.514, -27.903, 152.517, -27.897, {}),
    ),
};
const req: RouteRequest = {
    fromLat: -27.9,
    fromLon: 152.502, // in the basin
    toLat: -27.9,
    toLon: 152.53, // out at sea
    draftM: 2.4,
    safetyM: 0.5, // floor 2.9 — the river is honest caution
    resolutionM: 50,
};

describe('wet-at-LAT S-57 protection (sealed-river knob)', () => {
    it('routes the charted narrow river end-to-end as caution (front door open)', () => {
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // The route must ride the river corridor — SAMPLE along segments
        // (smoothed vertices can skip the whole river): every sampled point
        // between basin and sea stays inside the river's lat band (no bank
        // crossing, no giant detour, no refusal).
        const poly = r.polyline as Position[];
        const riverPts: Position[] = [];
        for (let i = 0; i + 1 < poly.length; i++) {
            for (let s = 0; s <= 40; s++) {
                const t = s / 40;
                const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
                const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
                if (lon > 152.506 && lon < 152.516) riverPts.push([lon, lat]);
            }
        }
        expect(riverPts.length).toBeGreaterThan(3);
        for (const [, lat] of riverPts) {
            expect(lat).toBeGreaterThan(RIVER_S - 0.0006);
            expect(lat).toBeLessThan(RIVER_N + 0.0006);
        }
        // And it ships honest red: the river run is caution with its real depth.
        expect((r.shallowRuns ?? []).some((x) => x.minDepthM === 2)).toBe(true);
    });

    it('a DRYING channel (DRVAL1 = 0) stays sealed — the spit is still a spit', () => {
        const drying = {
            ...layers,
            DEPARE: fc(
                rect(152.5, -27.902, 152.505, -27.898, { DRVAL1: 10, acronym: 'DEPARE' }),
                rect(152.505, RIVER_S, 152.517, RIVER_N, { DRVAL1: 0.0, acronym: 'DEPARE' }), // dries at LAT
                rect(152.517, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE' }),
            ),
        };
        const r = routeInshore(drying, { ...req, unchartedPolicy: 'strict' });
        // The only exit dries at LAT and is flanked by land: the buffer seals
        // it exactly as before this knob. Either an honest refusal, or (via
        // the endpoint-relax rescue) a route that must NOT pretend the drying
        // gut is charted water without flagging caution on it.
        if (isResult(r)) {
            const riverPts = (r.polyline as Position[]).filter(([lon]) => lon > 152.506 && lon < 152.516);
            const mask = r.cautionMask ?? [];
            const anyCaution = mask.some(Boolean);
            expect(riverPts.length === 0 || anyCaution).toBe(true);
        } else {
            expect(r.error.length).toBeGreaterThan(0);
        }
    });
});
