/**
 * CHARACTERISATION — chart leading lines fed the PRODUCTION way (inshore
 * router Phase 1 review, 2026-09-29).
 *
 * The goldens (inshoreRouter.golden.test.ts) build their layers with
 * tests/helpers/corridorFixture.assembleLayers, which puts only the OSM
 * navigation lines into NAVLINE. Production also pushes the chart's own NAVLNE
 * CATNAV 3 leading lines there (InshoreRouter.ts: navLineLeads(navlne.features,
 * 'NAVLNE') into merged.NAVLINE), so "goldens identical" says nothing about
 * what Phase 1 did to chart leads. This file feeds them in the production
 * shape and pins what the router does, under both policies, so a later phase
 * cannot move it silently.
 *
 * Measured with the scratch prodleads probe (same requests as below):
 *
 *   case                               HEAD cfca0e77         Phase 1 (+ review fixes)
 *   newport-shane, strict (production)  24.58 NM, land 173 m  REFUSED hard-land-crossing, 2.6 km
 *   newport-shane, permissive           24.58 NM, land 173 m  19.62 NM, audit land run 2590 m
 *   Newport → Tangalooma, strict        REFUSED, 0.7 km       REFUSED, 0.7 km
 *   Newport → Tangalooma, permissive    23.80 NM, land 547 m  20.32 NM, audit land run 1993 m
 *
 * On the chart layers ALONE (this fixture's OSM capture is empty) the strict
 * refusal stood: HEAD's route leaned on land that the leading lines'
 * extensions used to vouch for (and that Pass 5b used to reopen). The
 * permissive runs were pinned AS THEY WERE — known bad, kilometres of charted
 * land — so that Phase 2 had to move them on purpose. Re-pin with the reason;
 * never loosen a bound to make a run pass.
 *
 * Phase 2a moved all four on purpose (2026-09-30; every number measured in
 * its own process, the scratch prodleads probe):
 *
 *   case                    Phase 1          round 1          round 2          fix-up
 *   newport-shane, strict   REFUSED 2.6 km   REFUSED 0.9 km   22.85 NM, 47 m   REFUSED 0.9 km
 *   newport-shane, perm.    19.62 NM, 2.6 km 24.62 NM, 125 m  22.85 NM, 47 m   24.62 NM, 125 m
 *   Tangalooma, strict      REFUSED 0.7 km   REFUSED 1.2 km   23.29 NM, 0 m    REFUSED 1.2 km
 *   Tangalooma, permissive  20.32 NM, 2.0 km 18.09 NM, 478 m  23.29 NM, 0 m    23.95 NM, 594 m
 *
 * Round 1: Pass 4 and the Pass 5b lead brush no longer paint 5 m over
 * FAIRWY / DRGARE / leads (nor reopen land), owner decision 1 decides where a
 * coarse chart's land paint stands (the fixture ranked as production ranks
 * it), and the final audit no longer counts a FAIRWY / DRGARE overlap as
 * water. Reverting those together gives the Phase 1 routes back.
 * Round 2 (owner decision 7, "carry on, amber"): on these chart layers the
 * Newport pin sits in charted decision-1 water (the harbour cell's
 * never-drying bands under the coarser cell's land paint), and so does the
 * Tangalooma pin. The route now leaves and arrives through that charted water
 * — 'needs tide' tails to the nearest water deep enough for the keel —
 * instead of snapping ~2 km off the Newport pin and relaxing charted land
 * across the peninsula. Both runs routed, with no more than 47 m of
 * charted land left in the audit.
 * The fix-up (2026-09-30) took that back at the Newport end: owner decision 2
 * says the offline Newport canal gets no route until the offline water pack,
 * and this chart-only capture is exactly that case (its 0–2 m canal band
 * under every cell's land paint). Decision-1 water is a charted pin only when
 * its finest band is itself deep enough for the keel — Tangalooma's, not the
 * canal's — so the strict runs refuse again, as in round 1.
 *
 * Production is never chart-only, though: the OSM overlay (canal lines,
 * marina basins, OSM water) is merged on top, and the grid treats the Newport
 * entrance channel as water through it. The GOLDEN at the end pins that shape
 * (review 2026-09-29): it routes, with no unvouched land.
 *
 * Phase 2b (2026-10-01): the offline water pack is built, so decision 2's
 * offline "no route" now applies only when the canal's tiles are NOT on the
 * phone. The chart-only refusals below are that case and stay as pinned; the
 * offline route WITH the pack is tests/waterPack/offlineNewportCanal.test.ts
 * (23.52 NM, 0 m unvouched land, from the canal pin). No re-pins here.
 */
import { describe, expect, it } from 'vitest';
import { haversineM } from '../services/engine/geometry';
import { auditUnvouchedHardLand } from '../services/engine/safetyAudit';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
import { navLineLeads } from '../services/leadingLine';
import { assembleLayers, loadFixture } from './helpers/corridorFixture';
import { HIGHEST_TIDE_SWEEP_M, nonRedOverShallow } from './helpers/nonRedOverShallow';

const fx = loadFixture('newport-shane.corridor.json.gz');
// The OSM overlay production merges on top (the rivergate capture's: marina
// basins, the canal lines, OSM water and coastline). newport-shane's own
// capture carries none — the characterisation below is chart layers alone.
const osmRivergate = loadFixture('newport-rivergate.corridor.json.gz');

/** assembleLayers + the chart's CATNAV 3 leads, as InshoreRouter merges them. */
function productionLayers(osm: typeof fx.osm = fx.osm) {
    const layers = assembleLayers({ ...fx, osm });
    layers.NAVLINE.features.push(...navLineLeads(fx.cells.NAVLNE?.features ?? [], 'NAVLNE'));
    return layers;
}

const TANGALOOMA: RouteRequest = {
    fromLat: -27.2135,
    fromLon: 153.0875,
    toLat: -27.176,
    toLon: 153.371,
    draftM: 2.4,
    safetyM: 0.2,
    obstructionBufferM: 60,
};

/**
 * These tests route inside the test body (the goldens route at file load,
 * outside any per-test limit). A strict refusal tries every fallback before
 * it gives up: 9.6 s on the 8 GB Mac with v8 coverage on, and CI's runners
 * with coverage went past the global 20 s limit (CI 36623741291). A time
 * limit is not an assertion: the pins below are unchanged.
 */
const ROUTE_TEST_TIMEOUT_MS = 90_000;

function run(req: RouteRequest, strict: boolean, osm: typeof fx.osm = fx.osm) {
    const layers = productionLayers(osm);
    const r = routeInshore(layers, strict ? { ...req, unchartedPolicy: 'strict' } : req);
    if ('error' in r) return { refused: true as const, code: r.code, hardLandMaxRunM: r.debug?.hardLandMaxRunM };
    const audit = auditUnvouchedHardLand(layers, r.polyline);
    const [endLon, endLat] = r.polyline[r.polyline.length - 1];
    // Owner decision 10 (2026-09-30): with a tide assumed shallow water may be
    // needs-tide amber — only where that tide clears it, and never where no
    // band charts a depth. Swept from no tide to a 6 m top (round-4 review,
    // 2026-09-30: asked only at 2.5 m, and 24 m of uncharted river mouth
    // drew amber on newport-shane from a 2.6 m top).
    const sweep = HIGHEST_TIDE_SWEEP_M.map((h) => nonRedOverShallow(r, layers, req.draftM + (req.safetyM ?? 1), h));
    const sum = (k: keyof (typeof sweep)[number]) => sweep.reduce((m, x) => m + x[k], 0);
    return {
        refused: false as const,
        distanceNM: r.distanceNM,
        caution: (r.cautionMask ?? []).filter(Boolean).length,
        points: r.polyline.length,
        auditMaxRunM: audit.maxRunM,
        endGapM: haversineM(req.toLat, req.toLon, endLat, endLon),
        nonRedDryM: sum('dryM'),
        nonRedShallowM: sum('shallowM'),
        amberBeyondTideM: sum('amberBeyondTideM'),
        amberUnchartedM: sum('amberUnchartedM'),
    };
}

const within = (value: number | undefined, pin: number, frac: number): void => {
    expect(value).toBeGreaterThan(pin * (1 - frac));
    expect(value).toBeLessThan(pin * (1 + frac));
};

describe(
    'CHARACTERISATION: chart CATNAV 3 leads in the production shape (newport-shane cells)',
    { timeout: ROUTE_TEST_TIMEOUT_MS },
    () => {
        it('the fixture carries the chart leads this file is about', () => {
            const leads = navLineLeads(fx.cells.NAVLNE?.features ?? [], 'NAVLNE');
            expect(leads.length).toBe(31);
            expect(leads.every((f) => f.properties?.CATNAV === 3)).toBe(true);
        });

        // RE-PIN (2026-09-30, see the header): REFUSED 2590 m (Phase 1) →
        // REFUSED 922 m (round 1) → routed 22.85 NM (round 2) → REFUSED 922 m
        // again (fix-up). Owner decision 2 binds: the offline Newport canal
        // gets no route until the offline water pack (Phase 2b). This capture
        // with its empty OSM overlay IS that case — the pin sits in Hawk /
        // Jabiru Canal, whose only chart water is the harbour cell's 0–2 m
        // band under every cell's land paint. Round 2 made that decision-1
        // water a decision-7 charted pin and routed out through a 5.56 km
        // 'needs tide' tail that crossed ~60 m of hard land. Decision-1 water
        // is a charted pin now only when its finest band is itself deep enough
        // (Tangalooma's 10–15 m, the Rivergate dredged area's 9.1 m).
        it('newport-shane, strict (the production policy): refuses — the offline canal gets no route (decision 2)', () => {
            const r = run(fx.request, true);
            expect(r.refused, JSON.stringify(r)).toBe(true);
            if (!r.refused) return;
            expect(r.code).toBe('hard-land-crossing');
            within(r.hardLandMaxRunM, 922, 0.05);
        });

        // RE-PIN (2026-09-30): 19.62 NM, audit 2590 m (Phase 1) → 24.62 NM,
        // 125 m, caution 50 (round 1) → 22.85 NM, 47 m, caution 60 (round 2)
        // → 24.62 NM, 125 m, caution 50 again (fix-up: decision 2, as above).
        it('newport-shane, permissive: 24.62 NM with a ~125 m audit land run (known bad, pinned as is)', () => {
            const r = run(fx.request, false);
            expect(r.refused).toBe(false);
            if (r.refused) return;
            within(r.distanceNM, 24.619, 0.02);
            within(r.auditMaxRunM, 124.9, 0.05);
            expect(r.caution).toBeLessThanOrEqual(50);
        });

        // RE-PIN (2026-09-30): REFUSED 742 m (Phase 1) → REFUSED 1248 m
        // (round 1) → routed 23.29 NM (round 2) → REFUSED 1248 m again
        // (fix-up): the Newport origin is the offline canal (decision 2).
        it('Newport → Tangalooma, strict: refuses — the Newport origin is the offline canal (decision 2)', () => {
            const r = run(TANGALOOMA, true);
            expect(r.refused, JSON.stringify(r)).toBe(true);
            if (!r.refused) return;
            expect(r.code).toBe('hard-land-crossing');
            within(r.hardLandMaxRunM, 1_248, 0.05);
        });

        // RE-PIN (2026-09-30): 20.32 NM, audit 1991 m (Phase 1) → 18.09 NM,
        // 478 m, caution 11, 1080 m short of the pin (round 1) → 23.29 NM,
        // 0 m, caution 24, at the pin (round 2) → 23.95 NM, 594 m, caution 19,
        // at the pin (fix-up): the Tangalooma end keeps its decision-7 tail
        // (a deep finest band under the overview's land paint), the Newport
        // end is the offline canal again (decision 2) and relaxes charted land
        // as permissive does. Known bad, pinned as is.
        it('Newport → Tangalooma, permissive: 23.95 NM to the pin, a ~594 m audit land run (known bad, pinned as is)', () => {
            const r = run(TANGALOOMA, false);
            expect(r.refused).toBe(false);
            if (r.refused) return;
            within(r.distanceNM, 23.954, 0.02);
            within(r.auditMaxRunM, 594.1, 0.05);
            expect(r.caution).toBeLessThanOrEqual(19);
            expect(r.endGapM).toBeLessThan(1);
        });
    },
);

// GOLDEN — the production shape: the newport-shane cells (with their chart
// NAVLNE leads) PLUS the OSM overlay, strict, 60 m obstruction buffer.
//
// Phase 1 review (high, 2026-09-29): with the overlay present the grid treats
// the Newport entrance channel as water (the OSM canal carve and OSM-vouched
// water), but the lead clip read S-57 water only. It cut the entrance lead
// (NAVLNE 406/3035, ORIENT 183) into two pieces with a ~590 m gap exactly in
// the channel (-27.1961 to -27.2015, LNDARE with no S-57 DEPARE), and the
// strict router REFUSED both departures (hard-land-crossing ~1.0 km);
// permissive ran out the channel, U-turned into the canal estate and crossed
// ~1.04 km of charted LNDARE. HEAD cfca0e77 routed both cleanly (24.58 NM /
// 23.95 NM, 0 m of unvouched land under the new audit), as did the same tree
// with no chart leads. The goldens (OSM only) and the characterisation above
// (chart only) never saw it. The grid now clips a lead against its OWN land
// verdict, so a stretch the grid already treats as water keeps its lead.
//
// Measured after the fix (scratch prodleads probe; HEAD in brackets):
//   newport-shane          24.54 NM, caution 6, audit 0 m  [24.58 NM, 4, 0 m]
//   Newport -> Rivergate   23.93 NM, caution 9, audit 0 m  [23.95 NM, 4, 0 m]
// The extra caution segments are the land-conflict cells HEAD's reopen used
// to paint as 5 m water, now honest CAUTION.
//
// RE-PIN the caution caps (2026-09-30, Phase 2a round 1; distances still
// inside ±2%, audit still 0 m): newport-shane 6 → 10 (24.54 → 24.55 NM),
// Newport -> Rivergate 9 → 12 (23.93 → 23.90 NM). Pass 4 and the Pass 5b lead
// brush no longer paint charted-shallow water under a FAIRWY, DRGARE or lead
// 5 m deep, so those segments now draw honest red (reverting the lead brush
// alone: 4 and 7). Round 2 (owner decision 7) moves neither: both pins are
// OSM water in the production shape. Nor does the fix-up (measured in its own
// process: 24.551 NM c10, 23.894 NM c12, audit 0 m) — but 6 segments of each
// that ride a marked channel over charted-shallow water (min -2.2 m) now draw
// red with their tide chips instead of yellow (components/map/
// inshoreRouteState.ts; tests/inshoreRouteState.test.ts).
//
// RE-PIN the caution caps (round-3 review fix-up, 2026-09-30; each measured in
// its own process; distances inside ±2%, audit still 0 m): newport-shane
// 10 → 61 (24.551 → 24.718 NM, 36 → 76 points), Newport -> Rivergate 12 → 101
// (23.894 → 23.904 NM, 30 → 171 points). The OSM overlay's water polygons
// carry a synthetic 10 m; they used to outrank the chart's own S-57 bands, so
// both routes crossed the Brisbane River mouth's charted drying bank (ENB5
// -2.2..0) drawn as a yellow marked channel with no chip — 2,738 m and
// 2,959 m of it. OSM water is water, not depth, now (navGrid Pass 1/2): the
// routes cross 0 m and 30 m of drying ground, and ride a charted track
// through the mouth whose short, dense segments are honest caution over the
// chart's 0–2 m bands — the extra points and caution segments.
//
// RE-PIN the caution caps (round 4, 2026-09-30; each measured in its own
// process; distances and the 0 m audit unchanged): newport-shane 61 → 36
// (76 → 51 points), Newport -> Rivergate 101 → 35 (171 → 43 points). The
// density was NOT a winding channel: it was the lateral-mark follower's
// scaffold (fairlead — its centreline sampled mark by mark, then an 11-point
// moving average), shipped vertex for vertex. Through the river mouth 138 of
// Rivergate's 171 points lay on a 6.8 km stretch turning 0.0–2.7° per vertex,
// straight to within 1 m inside one state (tier-2 channel; caution over
// decision-1 water for 74 of them), and the cap counted every one. The engine
// now collapses near-collinear vertices (2.5 m, the canal re-centre's own
// tolerance) inside runs of one state, and only where the merged line reads
// the same grid caution, hazard buffer and chart depth facts and crosses no
// land (engine/geometry collapseStateRuns, shallowRuns chartStateAlong): the
// same 23.904 / 24.718 NM, the same shallow runs (6,868 m at 0 m, 9,965 m
// uncharted, 9,507 m down to -2.2 m), the same colours. Points are pinned
// too, so a scaffold that comes back cannot hide inside the cap.
//
// RE-PIN Rivergate points 43 → 44 (round-4 review fix-up, 2026-09-30;
// measured in its own process): the chart facts are now read exactly
// (shallowRuns chartSampler — band pieces, decision-1 cells walked every
// 5 m, not sampled every 25 m), and one vertex the 25 m key merged stays:
// 153.18383, -27.34672, between two yellow channel segments, where the
// second clips a decision-1 cell the 25 m samples stepped over — the merged
// chord would read it and the first segment does not. Not caution, so no
// colour moves: 23.904 NM, the same three shallow runs, danger 25.98 km,
// teal 0.60 km, yellow 17.62 km with no tide data.
//
// RE-PIN newport-shane caution 36 → 37, points 51 → 52 (round 5, 2026-10-01;
// measured in its own process, with and without the pin): the round-4
// collapse had merged Newport's exit channel 7/8 → 3/4 into one chord and
// dropped gate 5/6's vertex — its centre sits 1.2 m off that chord, inside
// the 2.5 m tolerance. A lateral-mark gate crossing is an anchor now
// (tierPipeline gateAnchorMask → collapseStateRuns `pinned`), so the line
// draws a point in every Newport gate again: that one vertex and its extra
// caution segment, nothing else — the same 24.718 NM, the same four shallow
// runs (6,681, 15,416 and 440 m at 0 m; 1,565 m at 2 m). Rivergate kept all
// four gate vertices already: unchanged.
describe('GOLDEN: chart leads + OSM overlay (the production shape), strict', { timeout: ROUTE_TEST_TIMEOUT_MS }, () => {
    it.each([
        ['newport-shane', { ...fx.request, obstructionBufferM: 60 }, 24.54, 37, 52],
        ['Newport -> Rivergate', osmRivergate.request, 23.93, 35, 44],
    ] as const)('%s routes (%s NM), with no unvouched charted land', (_name, req, nm, maxCaution, maxPoints) => {
        const r = run(req, true, osmRivergate.osm);
        expect(r.refused, JSON.stringify(r)).toBe(false);
        if (r.refused) return;
        expect(r.auditMaxRunM).toBe(0);
        within(r.distanceNM, nm, 0.02);
        expect(r.caution).toBeLessThanOrEqual(maxCaution);
        expect(r.points).toBeLessThanOrEqual(maxPoints);
        // Nothing the finest S-57 survey charts drying or too shallow for the
        // keel is drawn anything but red (round-3 review, 2026-09-30) — or,
        // since owner decision 10 (2026-09-30), needs-tide amber where the
        // tide clears it, never beyond it.
        expect(r.nonRedDryM).toBe(0);
        expect(r.nonRedShallowM).toBe(0);
        expect(r.amberBeyondTideM).toBe(0);
        expect(r.amberUnchartedM).toBe(0);
    });
});
