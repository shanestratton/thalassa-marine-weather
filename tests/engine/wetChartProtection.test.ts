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
 *
 * Owner decision 1 (2026-09-30) makes it a SCALE test: only a band charted at
 * a strictly FINER scale than the land paint, and never drying (DRVAL1 ≥ 0),
 * beats it; unknown ranks leave the land (tests/engine/chartWaterUnderLandPaint).
 * The fixture below now says what its prose always did — the mouth blob is
 * the COARSE cell's generalised coastline, the river the harbour cell's band —
 * by carrying the ranks the router's merge stamps (_scaleRank; higher is
 * finer). Unranked, the blob stands and the river is sealed (last test).
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import { buildNavGrid } from '../../services/engine/navGrid';
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
/** The harbour cell's fineness rank, and the overview cell's (coarser). */
const HARBOUR = { _scaleRank: 200 };
const OVERVIEW = { _scaleRank: 100 };
const layers = {
    DEPARE: fc(
        rect(152.5, -27.902, 152.505, -27.898, { DRVAL1: 10, acronym: 'DEPARE', ...HARBOUR }), // basin (deep)
        rect(152.505, RIVER_S, 152.517, RIVER_N, { DRVAL1: 2.0, acronym: 'DEPARE', ...HARBOUR }), // the river (wet, shallow)
        rect(152.517, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE', ...HARBOUR }), // open sea
    ),
    LNDARE: fc(
        rect(152.503, -27.898, 152.517, -27.88, { ...HARBOUR }), // north bank
        rect(152.503, -27.93, 152.517, -27.902, { ...HARBOUR }), // south bank
        // Generalised coarse-cell coastline blob across the river mouth — the
        // 1:90k class that survives scale-shadow and paints charted water.
        rect(152.514, -27.903, 152.517, -27.897, { ...OVERVIEW }),
    ),
};
/** The same chart with no ranks at all: the comparison cannot be made. */
const unranked = {
    DEPARE: fc(
        ...layers.DEPARE.features.map((f) => ({
            ...f,
            properties: { DRVAL1: f.properties!.DRVAL1, acronym: 'DEPARE' },
        })),
    ),
    LNDARE: fc(...layers.LNDARE.features.map((f) => ({ ...f, properties: {} }))),
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

    it('endpoint snap prefers HONEST water over a conflict creek (phantom-departure guard)', () => {
        // Pin on the north bank, equidistant-ish between the conflict-class
        // river mouth (land paint over the wet band, ~closer) and the honest
        // open sea to the east. The origin must snap to honest water, not
        // start the route inside the conflict corridor (the Mooloolaba
        // canal-estate phantom-departure regression, device 2026-07-02).
        //
        // Fix-up (2026-09-30): round 2 moved this pin to -27.8975 because at
        // -27.9 it sat in decision-1 water that decision 7 then routed FROM.
        // Owner decision 2 binds that water: a conflict creek whose finest
        // band (2 m) is shallower than the keel needs is no charted pin, so
        // the guard is back where it was, asserting what it always did.
        const r = routeInshore(layers, {
            ...req,
            // On the mouth's land blob: nearest cells are conflict-caution.
            fromLat: -27.9,
            fromLon: 152.5155,
            toLat: -27.9,
            toLon: 152.53,
        });
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const snap = (r as unknown as { debug?: { originSnap?: { snappedLon: number; snappedLat: number } } }).debug
            ?.originSnap;
        console.log(`originSnap: ${JSON.stringify(snap)}  polyline0: ${JSON.stringify(r.polyline[0])}`);
        // The ORIGIN SNAP must sit in honest water — east of the conflict
        // blob (lon ≥ 152.517, the open-sea band), never inside it.
        expect(snap).toBeDefined();
        expect(snap!.snappedLon).toBeGreaterThanOrEqual(152.5165);
    });

    it('a pin IN the shallow conflict river is no charted pin (decision 2 over decision 7)', () => {
        // The river's finest band is 2 m, under the 2.9 m floor: caution for
        // its depth, not only for the coarse blob over it — the offline
        // Newport canal's class (a 0–2 m band under land paint), which owner
        // decision 2 keeps unrouted until the offline water pack. No 'needs
        // tide' head from it (fix-up, 2026-09-30; round 2 asserted one).
        const q = { ...req, fromLat: -27.9, fromLon: 152.5155, toLat: -27.9, toLon: 152.53 };
        const r = routeInshore(layers, q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.originChartedPin).toBeUndefined();
        expect(r.shallowRuns?.some((x) => x.endpointTail)).toBe(false);
    });

    // Decision 1: DRVAL1 0 now counts as never drying (≥ 0), so the drying
    // channel here is a real drying band (DRVAL1 −0.5, was 0.0).
    it('a DRYING channel (DRVAL1 < 0) stays sealed — the spit is still a spit', () => {
        const drying = {
            ...layers,
            DEPARE: fc(
                rect(152.5, -27.902, 152.505, -27.898, { DRVAL1: 10, acronym: 'DEPARE', ...HARBOUR }),
                rect(152.505, RIVER_S, 152.517, RIVER_N, { DRVAL1: -0.5, acronym: 'DEPARE', ...HARBOUR }), // dries at LAT
                rect(152.517, -27.93, 152.545, -27.88, { DRVAL1: 10, acronym: 'DEPARE', ...HARBOUR }),
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

    it('UNRANKED, the coarse blob stands (decision 1 fails safe): the river mouth under it is land', () => {
        const probe = (l: typeof layers) => {
            const g = buildNavGrid(l, [152.495, -27.935, 152.55, -27.875], 50, req.draftM, req.safetyM ?? 1, 60);
            const x = Math.floor((152.5155 - g.minLon) / g.dLon);
            const y = Math.floor((-27.9 - g.minLat) / g.dLat);
            return g.landBlocked?.[y * g.width + x] === 1;
        };
        // Ranked: the harbour cell's river beats the overview's blob (water).
        expect(probe(layers)).toBe(false);
        // No ranks: the comparison cannot be made, so the land paint stands.
        expect(probe(unranked)).toBe(true);
    });
});
