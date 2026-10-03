/**
 * GOLDEN ROUTE LOCK — Masterplan Stage I, Phase 0.
 *
 * Real-chart corridor fixtures (AU SENC cells + OSM overlay, captured from
 * production by Claude B, ROUTING_COLLAB.md replies 5–6) routed through the
 * REAL routeInshore. These are the seatbelt for every routing change in the
 * masterplan: any phase that moves these numbers without an explicit re-pin
 * gets reverted.
 *
 *  - Newport → Rivergate (Brisbane River): the ORCA-comparison benchmark.
 *    Claude B verified end-to-end: connected, 21 pts, 20.46 NM, snap 0 m
 *    both ends, 10 caution cells, pass4 FAIRWY+DRGARE=104, pass5b navline=21.
 *  - Newport → Tangalooma: pins the leading-line APPROACH machinery
 *    (route-via-transit: make the seaward mark, run the leads in).
 *  - Rivergate at draftM 2.44 (the real 8 ft Tayana draft, ship-blocker #3
 *    in ROUTING_COLLAB.md): the engine must stay connected and sane at the
 *    true draft, not just the 2.40 benchmark value.
 *
 * The cells+osm → layers assembly below is the documented injection recipe
 * from ROUTING_COLLAB.md (also embedded in each fixture's _meta) — the
 * Brisbane River sits INSIDE a coastal LNDARE polygon on the AU SENC, so
 * cells alone route destination-disconnected; production injects the OSM
 * overlay first. If Claude B exports assembleInshoreLayers() from
 * InshoreRouter.ts post-lock-in, swap this copy for the shared export.
 */

import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../services/inshoreRouterEngine';

import { auditUnvouchedHardLand } from '../services/engine/safetyAudit';
import { collectSurveyRuns } from '../services/engine/shallowRuns';
import { cellFinenessRank } from '../services/enc/scaleShadow';
import { inshoreRoutePieces, inshoreSegmentStates, surveyAmberMetres } from '../components/map/inshoreRouteState';
import { loadFixture, assembleLayers } from './helpers/corridorFixture';
import { chartedDryingM, HIGHEST_TIDE_SWEEP_M, nonRedOverShallow } from './helpers/nonRedOverShallow';
import { CORRIDOR_CELL_SCALE } from './helpers/corridorCellRanks';
import { encLayer } from './helpers/encCells';

// ── Shared assertions ──────────────────────────────────────────────

function expectConnected(r: ReturnType<typeof routeInshore>): asserts r is RouteResult {
    if ('error' in r) throw new Error(`route failed: ${r.error}`);
    expect(r.polyline.length).toBeGreaterThanOrEqual(2);
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Endpoint snap distance: request point → nearest polyline terminal. */
function snapM(r: RouteResult, req: RouteRequest): { from: number; to: number } {
    const [fLon, fLat] = r.polyline[0];
    const [tLon, tLat] = r.polyline[r.polyline.length - 1];
    return {
        from: haversineM(req.fromLat, req.fromLon, fLat, fLon),
        to: haversineM(req.toLat, req.toLon, tLat, tLon),
    };
}

const cautionCount = (r: RouteResult): number => (r.cautionMask ?? []).filter(Boolean).length;

// ── Goldens ────────────────────────────────────────────────────────

describe('GOLDEN: Newport → Rivergate (Brisbane River, real AU cells)', () => {
    const fx = loadFixture('newport-rivergate.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, fx.request);

    it('resolves connected (no destination-disconnected)', () => {
        expectConnected(r);
    });

    // RE-PIN 21.89 → 22.26 NM (2026-06-12, Phase 3b bundle — ROUTING_COLLAB
    // replies 12–13, owner-approved). Decomposition: the cost-no-worse
    // smoothing/centerline correctness pair alone measured 22.48 (+2.7% —
    // the cost-blind smoother had been shaving real corridor adherence);
    // the bundle's one knob (deep tier 5→4) settles it at 22.26 (+1.7%).
    // Pin history: 20.46 capture → 22.64 lock-in → 21.89 heap fix → 22.26.
    // Re-pin only with an explicit masterplan-phase justification.
    //
    // RE-PIN 22.26 → 23.22 NM (2026-09-30, Phase 2a round-2 fix-up; measured
    // in its own process). HEAD 22.61 → rounds 1 and 2 22.47 (inside the old
    // ±2%) → 23.22: a charted shallow S-57 band now stands against a later
    // deep band that is neither S-57 nor OSM-vouched. The capture's GMRT
    // public-bathymetry bands (grade D) used to upgrade a charted shallow
    // band's CAUTION to deep in one feature order only; the route now keeps
    // off that charted shallow water (navGrid Pass 1, shallowest wins). With
    // that one rule reverted it measures 22.47 again. Caution 9 → 9.
    //
    // D12 (2026-10-02; owner decision 12, Shane: "Trust the detailed chart";
    // fix-up 2026-10-03, measured in its own process): 23.24 → 23.23 NM,
    // inside the pin, 38 → 34 points. All 9,453 m of the route's 'charts
    // disagree' was the overview and general cells' land paint (usage bands
    // 1–2) over never-drying bands of the approach cell OC-61-351824 and the
    // harbour cells (10ENB5 = AU5BNE01, 1:12,000; 10RCS5, 1:22,000), with no
    // OSM water there — probed along HEAD's stretch: 0–14 m under band-1 or
    // band-1–2 land only. Decision 12 ignores that land, so it goes. Where
    // AU428153's own (1:90,000) land lies over ENB5's water on this route the
    // river is OSM-vouched water, and decision 1 never applied there, before
    // or after. Charted drying ground crossed stays 30 m (pinned below), land
    // 0 m.
    //
    // Round 2 item (a), any-angle string pulling (2026-10-03, measured in its
    // own process): 23.23 → 23.22 NM, 34 → 33 points — one grid stair pulled
    // straight where its chord is at least as safe (engine/stringPull). Red
    // 19,791 m, caution 22, land 0 m and drying ground 30 m all unchanged.
    //
    // The real-chart check (2026-10-03; own process): 23.22 → 23.21 NM
    // (23.216 → 23.205), inside the pin, 33 → 32 points. A shallow band's
    // clearance is now a cost on the grid (a ring of 3× within ~46 m of water
    // that dries or never clears the keel, 1.5× within ~37 m of a 2–5 m band),
    // and it is drawn over the stretch inside it on every segment, not the
    // whole segment: the 11.3 km bay chord that was red end to end for one
    // caution cell 3.7 m from a 2 m band (NEAR_SHALLOW) is no longer red at
    // all, and the route's red falls 19,819 → 8,486 m drawn (18,193 → 6,851 m
    // at a 2.5 m tide). Inside a clearance: 10 m on a green segment 2.1 m off
    // a 2 m band, and 114 m of the needs-tide Newport exit 6–20 m off a bank
    // drying 2 m, found by the band's own edge (fix-up review, that day: a
    // band was found only through the cells whose centres it owns). The
    // river channel's 112 m, 14.7 m off a 0–2 m band, is not drawn: the marks
    // own the line there, so the ring cannot steer it (fix-up review). Land
    // 0 m and drying ground 30 m unchanged.
    it('distance pinned at 23.22 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(23.22 * 0.98);
        expect(r.distanceNM).toBeLessThan(23.22 * 1.02);
    });

    // PINNED 2026-09-30 (Phase 2a round-2 fix-up): the route crossed 47.1 m of
    // unvouched charted land at the Brisbane River mouth (seg ~35, near
    // -27.3956, 153.1507) — a sliver of LNDARE the 50 m grid reads as water
    // at the cell centres, since Phase 2a round 1 (HEAD's audit counted any
    // FAIRWY / DRGARE overlap as water and read 0 m). Not a regression in
    // land metres: HEAD's own route, run under today's audit, crosses 116.8 m
    // (141.8 m in all) at the Newport canal end instead.
    //
    // TIGHTENED 47.1 m → 0 m (round-3 review fix-up, 2026-09-30; measured in
    // its own process): the sliver was the river mouth's charted DRYING bank
    // (ENB5 -2.2..0) under the overview's land paint, which the OSM river's
    // synthetic 10 m kept as deep water. OSM water no longer outranks an S-57
    // band, nor beats land paint over a band that dries (navGrid Pass 1/2),
    // and the route keeps off it: 0 m of charted land, 30 m of charted drying
    // ground (was ~2.9 km, drawn yellow).
    it('crosses no unvouched charted land (was the 47.1 m river-mouth sliver)', () => {
        expectConnected(r);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
    });

    // PINNED (D12 fix-up review, 2026-10-03): nothing pinned the drying
    // ground a route crosses, so the first decision-12 build — which let
    // overview land yield to a detailed DRYING band — moved this route's
    // charted drying ground 30 → 279 m (a 249 m run at the Newport canal
    // mouth) with every pin here green. No tide data here: it is all red,
    // and Save stays blocked, but the proposal got worse. 30 m measured.
    it('crosses no more charted drying ground than it did (30 m, the river mouth)', () => {
        expectConnected(r);
        expect(chartedDryingM(r, layers)).toBeLessThanOrEqual(30);
    });

    // Round-3 review (2026-09-30): the river mouth's charted drying bank drew
    // as a yellow 'marked channel' with no chip — 2,880 m of it, 3,164 m below
    // draft + UKC. Nothing the finest S-57 survey charts drying or shallower
    // than the keel needs may be drawn anything but red.
    //
    // RE-PIN (owner decision 10, Shane 2026-09-30: "Amber if a tide clears
    // it"): …anything but red OR needs-tide amber — and amber only where the
    // tide clears it. With no tide data (the planner's first draw, and every
    // offline one) it is all red, as before; with a 2.5 m tide assumed (about
    // a Moreton Bay spring high) no amber stretch needs more than 2.5 m.
    it('draws shallow water red, or amber only where the tide clears it (decision 10)', () => {
        expectConnected(r);
        const needM = fx.request.draftM + (fx.request.safetyM ?? 1);
        // Swept from no tide to a 6 m top, and never amber where no band
        // charts a depth (round-4 review, 2026-09-30: asked only at 2.5 m, and
        // 24 m of uncharted river mouth drew amber from a 2.6 m top).
        for (const highestM of HIGHEST_TIDE_SWEEP_M) {
            const bad = nonRedOverShallow(r, layers, needM, highestM);
            expect(bad.dryM, `highest ${highestM}`).toBe(0);
            expect(bad.shallowM, `highest ${highestM}`).toBe(0);
            expect(bad.amberBeyondTideM, `highest ${highestM}`).toBe(0);
            expect(bad.amberUnchartedM, `highest ${highestM}`).toBe(0);
        }
    });

    it('endpoint snap < 100 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(100);
        expect(s.to).toBeLessThan(100);
    });

    // RE-PIN 9 → 25 (round-3 review fix-up, 2026-09-30; own process): the
    // river mouth is honest caution now. OSM water no longer paints the ENB5
    // cell's drying and 0–2 m bands 10 m deep (navGrid Pass 1), so the route
    // through the mouth runs red over the chart's own shallow water — 23.22 →
    // 23.24 NM, 37 → 38 points, and 2,994 m of drying ground crossed → 30 m.
    //
    // RE-PIN 25 → 22, D12 (2026-10-02, fix-up 2026-10-03; own process): the
    // overview's land over the approach and harbour cells' never-drying water
    // is no longer 'charts disagree' caution (owner decision 12); 38 → 34
    // points. The drying and shallow water stays red (the decision-10 sweep
    // above is unchanged), and the drying ground crossed stays 30 m.
    //
    // RE-PIN 22 → 21 (the real-chart check, 2026-10-03; own process): the
    // shallow bands' clearance ring steers one stretch off a band's cells.
    it('caution cells at or below the lock-in baseline (21)', () => {
        expectConnected(r);
        expect(cautionCount(r)).toBeLessThanOrEqual(21);
    });

    it('phaseTimings present and loosely bounded', () => {
        expectConnected(r);
        expect(r.phaseTimings).toBeTruthy();
        for (const [phase, ms] of Object.entries(r.phaseTimings ?? {})) {
            expect(ms, `phase ${phase} runaway`).toBeLessThan(30_000);
        }
    });
});

// Owner decision 9 (Shane, 2026-09-30): survey quality on the route, "Yes,
// amber on the route". The corridor captures carry no M_QUAL; the repo's
// whole-cell fixture (tests/fixtures/newport-enc-cells.json.gz) carries the
// two harbour cells' real zones (OC-61-10ENB5: 73, OC-61-10RCS5: 5). The three
// coarser cells are merged here as production merges a cell whose data has
// no M_QUAL layer — "not checked" — at their real extents (the Pi store's
// index.json, read 2026-09-30). Measured on the pinned route in its own
// process (and on the Pi's own M_QUAL for all five cells: the same 696 m of
// CATZOC D and 223 m ungraded, the Moreton stretch graded well enough):
//   • 696 m of CATZOC D in the Newport canal estate — under its red;
//   • 223 m where ENB5 charts the river mouth but no ENB5 zone covers it —
//     ungraded, drawn amber over the yellow channel;
//   • 15.9 km owned by OC-61-351824 — not checked (a caveat, never amber).
// The route is the golden above: disclosure only, it never moves.
//
// RE-PIN (round-3 review fix-up, 2026-09-30; measured in its own process on
// the re-pinned route above):
//   • 696 → 680 m of CATZOC D — the canal leg's own geometry moved a little;
//   • 223 → 96 m ungraded, and ~222 → 72 m drawn amber: the route no longer
//     crosses the river-mouth drying bank where the ENB5 cell charts water
//     but carries no zone;
//   • survey-margin 0 → 7.45 km: the route reads decision 9's own words
//     ("where charted depth minus the zone error is below draft + UKC") on
//     water already charted shallower than the keel needs too (leadReview
//     surveyVerdict belowNeed). All of it lies under the red — 0 m drawn
//     amber — and says "survey may be out by 1.0 m" on its tide chips.
describe('GOLDEN: Newport → Rivergate — survey quality on the route (decision 9)', () => {
    const fx = loadFixture('newport-rivergate.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, fx.request);
    const rankOf = (id: string) => cellFinenessRank(CORRIDOR_CELL_SCALE[id]);
    const zones = ['OC-61-10ENB5', 'OC-61-10RCS5'].flatMap((id) =>
        encLayer(id, 'M_QUAL').map((z) => ({ ...z, properties: { ...z.properties, _scaleRank: rankOf(id) } })),
    );
    const unchecked = [
        { id: 'OC-61-051031', bbox: [150, -30, 180, 0] as const, rank: rankOf('OC-61-051031') },
        { id: 'OC-61-051032', bbox: [150, -30, 158, -20] as const, rank: rankOf('OC-61-051032') },
        { id: 'OC-61-351824', bbox: [153, -28, 154, -27] as const, rank: rankOf('OC-61-351824') },
    ];

    // Owner decision 10 (2026-09-30): the ~72 m is drawn as amber DASHES
    // ('survey'), never the solid amber of water that needs tide; the margin
    // stretches lie under red — or needs-tide amber once a tide is in.
    it('names 680 m of CATZOC D, 96 m ungraded, 7.45 km of margin under the red and the Moreton cell not checked; ~72 m draws as survey dashes', () => {
        expectConnected(r);
        const out = collectSurveyRuns({
            layers: { ...layers, M_QUAL: { type: 'FeatureCollection', features: zones } },
            polyline: r.polyline,
            draftM: fx.request.draftM,
            safetyM: fx.request.safetyM ?? 1,
            uncheckedCells: unchecked,
        });
        const m = (reason: string) =>
            out.surveyRuns.filter((x) => x.reason === reason).reduce((a, x) => a + x.lengthM, 0);
        expect(m('survey-poor')).toBeGreaterThan(680 * 0.9);
        expect(m('survey-poor')).toBeLessThan(680 * 1.1);
        expect(out.surveyRuns.find((x) => x.reason === 'survey-poor')?.catzoc).toBe(5);
        expect(m('survey-ungraded')).toBeGreaterThan(96 * 0.8);
        expect(m('survey-ungraded')).toBeLessThan(96 * 1.2);
        expect(m('survey-margin')).toBeGreaterThan(7_453 * 0.95);
        expect(m('survey-margin')).toBeLessThan(7_453 * 1.05);
        expect(m('survey-unchecked')).toBeGreaterThan(15_902 * 0.95);
        expect(m('survey-unchecked')).toBeLessThan(15_902 * 1.05);
        expect(out.uncheckedCells).toEqual(['OC-61-351824']);
        const states = inshoreSegmentStates(r);
        expect(states).not.toBeNull();
        let amberM = 0;
        for (const p of inshoreRoutePieces(r.polyline, states!, out.surveyRuns, r.chartedShallowSpans)) {
            if (p.state !== 'survey') continue;
            for (let i = 1; i < p.coordinates.length; i++)
                amberM += haversineM(
                    p.coordinates[i - 1][1],
                    p.coordinates[i - 1][0],
                    p.coordinates[i][1],
                    p.coordinates[i][0],
                );
        }
        expect(amberM).toBeGreaterThan(72 * 0.8);
        expect(amberM).toBeLessThan(72 * 1.2);
        // The margin stretches all lie under the red: none of them is amber.
        expect(surveyAmberMetres(r.polyline, states, out.surveyRuns, r.chartedShallowSpans).marginM).toBe(0);
    });
});

describe('GOLDEN: Newport → Rivergate at the REAL Tayana draft (2.44 m / 8 ft)', () => {
    // Ship-blocker #3 (ROUTING_COLLAB.md reply 4): the engine must behave at
    // the true draft, not just the 2.40 m benchmark. 4 cm deeper must not
    // disconnect the route or blow the corridor apart.
    const fx = loadFixture('newport-rivergate.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, { ...fx.request, draftM: 2.44 });

    it('still resolves connected at 2.44 m', () => {
        expectConnected(r);
    });

    // RE-PIN (round-3 review fix-up, 2026-09-30): the check still read the old
    // 22.26 NM pin ±10% after the 2.40 m benchmark moved to 23.22. It tracks
    // the benchmark now, at the benchmark's own ±2% (measured in its own
    // process: 23.24 NM, as at 2.40 m).
    it('distance within 2% of the 2.40 m benchmark (23.22 NM)', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(23.22 * 0.98);
        expect(r.distanceNM).toBeLessThan(23.22 * 1.02);
    });

    it('endpoint snap < 100 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(100);
        expect(s.to).toBeLessThan(100);
    });
});

describe('GOLDEN: Newport → Tangalooma (leading-line approach)', () => {
    const fx = loadFixture('newport-tangalooma.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, fx.request);

    it('resolves connected', () => {
        expectConnected(r);
    });

    // RE-PIN 16.09 → 18.43 NM (+14.5%, 2026-06-12 Phase 3b bundle —
    // owner-approved trade per ROUTING_COLLAB reply 13's protocol).
    // Decomposition: +21% (19.47) came ENTIRELY from the cost-no-worse
    // smoothing correctness fix at the old 5× deep tier — the cost-blind
    // smoother had been straight-lining across the leading-line/promoted-
    // river corridors this route now honestly follows; the bundle's 4×
    // retune claws back 1.04 NM. What the +14.5% buys (scorecard): gate-
    // shortcut 0/5→5/5 gates, staggered discipline 79.7→92.6%, midspan
    // 7/11→10/11 gates — length grew where corridor adherence grew.
    //
    // RE-PIN 18.43 → 19.48 → 20.35 NM (2026-09-30, Phase 2a rounds 1 and 2
    // and the round-2 fix-up), each step measured in its own process:
    //   • 18.38 → 19.38 (round 1): Pass 4 and the Pass 5b lead brush no
    //     longer paint 5 m "rescue depth" over FAIRWY / DRGARE / leads, and
    //     owner decision 1 (with the fixture ranked as production ranks it)
    //     decides where the overview's Moreton Island land paint stands.
    //     They move it together: reverting the two rescues alone reads 19.61,
    //     decision 1 alone 18.09, all three 18.38 again. The 18.38 route
    //     ended 28 m from the pin by crossing 862 m of charted land the
    //     final audit now counts; the 19.38 one stopped 429 m short instead.
    //   • 19.38 → 19.48 (round 2, owner decision 7 "carry on, amber"): the
    //     pin sits in decision-1 water, so the route now runs on to it
    //     through that charted water — a ~1.0 km 'needs tide' tail — instead
    //     of stopping at the nearest deep water. Caution 8 → 7, snap 429 → 0 m,
    //     land 24 → 0 m.
    //   • 19.48 → 19.91 (fix-up): the tail may no longer run through
    //     decision-1 water whose finest band is itself shallow (owner
    //     decision 2 — only a deep finest band under coarser land paint is a
    //     charted pin's water), and it weighs each step by how far the water
    //     falls short of the keel: 1036 m through 0 m → 1885 m through 2 m and
    //     the pin's 5 m decision-1 water. Either change alone gives 19.91.
    //   • 19.91 → 20.35 (fix-up): a charted shallow S-57 band now stands
    //     against a later GMRT public-bathymetry deep band (grade D) — the
    //     same fix as Rivergate's re-pin. Caution 7 → 18 (15 → 18 from this).
    //
    // D12 (2026-10-02; owner decision 12; own process): 20.36 → 20.18 NM,
    // inside the pin (−0.9%). The overview and general cells' Moreton Island
    // land paint over OC-61-351824's water no longer makes 'charts disagree'
    // caution, so the 1,906 m decision-1 tail to the pin is gone (below).
    // Re-measured in the fix-up (2026-10-03: decision 12 only over bands that
    // never dry, and its water keeps decision 1's protection from the land
    // skin), unchanged: 20.18 NM, 27 points, caution 15, 0 m of charted land
    // and 0 m of drying ground. Without that protection it crossed 1.6 km of
    // charted land at the Newport canal mouth.
    //
    // Round 2 item (a), any-angle string pulling (2026-10-03; own process):
    // 20.18 → 20.16 NM, 27 → 24 points — three grid-stair vertices pulled
    // out where each chord is at least as safe (engine/stringPull). Red
    // 14,098 → 14,079 m (the 'needs tide' stretches 6,283 → 6,264 m), never
    // longer; 0 m of land and drying ground as before.
    //
    // RE-PIN 20.35 → 19.97 NM (the real-chart check, 2026-10-03; own
    // process): 20.16 → 19.97 NM, 24 → 25 points, caution 13 → 12, 0.1% inside
    // the old pin's lower bound. A shallow band's clearance is a cost on the
    // grid now (the ring round water that dries or never clears the keel,
    // and round 2–5 m bands), so A* takes another line across the bay, clear
    // of the bands it used to skirt. The 7,418 m chord that was red end to
    // end for passing 0.7 m from a 0–2 m band (NEAR_SHALLOW) is no longer red:
    // red 14,119 → 6,702 m drawn (11,176 → 3,758 m at a 2.5 m tide). The
    // 10 m of the channel 28.2 and 28.4 m off a 0–2 m band is not drawn: the
    // marks own the line there (fix-up review, that day). 0 m of land and
    // drying ground as before.
    it('distance pinned at 19.97 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(19.97 * 0.98);
        expect(r.distanceNM).toBeLessThan(19.97 * 1.02);
    });

    // Owner decision 7 (2026-09-30): the Tangalooma pin sat in charted
    // decision-1 water (a finer never-drying band under the overview's land
    // paint). The route reached the pin, and the stretch past the last water
    // deep enough for the keel was its 'needs tide' tail — caution — never a
    // shortcut over land.
    //
    // Fix-up (2026-09-30): the tail's depth is the FINEST survey's. Round 2
    // pinned `minDepthM not null` — the 0 m of a coarser general cell's
    // generalised band, so the chip asked for +2.9 m of tide ("no window in
    // 24 h") over water the finest survey charts deep enough.
    //
    // RE-PIN, D12 (2026-10-02; owner decision 12, Shane: "Trust the detailed
    // chart"; measured in its own process): the land paint over the pin and
    // the 1,906 m tail is the overview and general cells' (OC-61-051031 /
    // OC-61-051032, usage bands 1–2) over the 1:90,000 OC-61-351824's 5 m+
    // water. That land is ignored now, so the pin is plain charted water deep
    // enough for the keel: no tail, no 'charts disagree' anywhere on the route
    // (4,302 m before, 0 after), and the route ends 28 m from the pin, as a
    // route to any deep-water pin does (it ran to the exact pin only as a
    // decision-7 charted pin).
    it('reaches the pin through the detailed chart’s own water: no tail, nothing disputed, no unvouched charted land', () => {
        expectConnected(r);
        expect(snapM(r, fx.request).to).toBeLessThan(150);
        expect(r.shallowRuns?.find((s) => s.endpointTail === 'destination')).toBeUndefined();
        expect(r.landPaintConflictMask?.some(Boolean) ?? false).toBe(false);
        expect(r.shallowRuns?.some((s) => s.chartsDisagree || s.coarserLandPaint) ?? false).toBe(false);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
    });

    it('caution cells at or below the lock-in baseline (12)', () => {
        expectConnected(r);
        // RE-PIN 10→11 (3-tier Phase 4 + along-segment caution, 42bf48c8):
        // route distance is byte-identical (18.43 NM pinned green), only the
        // caution count rose by ONE cell — the along-segment sampler catching
        // a mid-segment caution the old per-vertex sampler missed on the SAME
        // route. Honest by construction (stable geometry, +1 honest flag).
        //
        // RE-PIN 11→12 (recentreCanalRedOnEnc, Newport-end centring 2026-06-27):
        // the Newport canal RED now rides the ENC channel medial axis instead of
        // the OSM canal line it was snapped to (~8 m west). The centred path
        // passes through ONE more caution cell than the off-centre OSM line did —
        // the actual channel centre genuinely sits there. The re-centre marches
        // strictly BETWEEN LNDARE walls (it cannot cross land), distance is
        // unchanged (18.43 NM still green above), so this is +1 honest flag on a
        // more-accurate path, not a hazard incursion.
        //
        // RE-PIN 12→13 (drying-tier caution cost, 2026-07-02): drying cells
        // (charted DRVAL1 ≤ 0) now cost 120× vs wet caution's 40×, so the route
        // skirts drying banks through adjacent wet-shallow water instead of
        // cutting straight across (Shane's Newport exit crossed charted 0/−2 m
        // with a 2 m band alongside). The diversion splits/adds ONE caution run;
        // distance unchanged (18.43 NM still green above), leading-line approach
        // still fires. Safer water, +1 honest flag — the intended trade, locked
        // by tests/engine/dryingCaution.test.ts.
        //
        // RE-PIN 13→18 (2026-09-30, Phase 2a round-2 fix-up; own process):
        // round 2 measured 7. The tail rules (decision 2 + depth-weighted
        // steps) give 15; a charted shallow S-57 band standing against the
        // capture's later GMRT deep bands gives 18 — water the chart itself
        // calls too shallow, now drawn red instead of erased by grade-D public
        // bathymetry (navGrid Pass 1). Honest flags, not a hazard incursion:
        // the land audit below stays 0 m.
        //
        // RE-PIN 18 → 25 (round-3 review fix-up, 2026-09-30; own process):
        // OSM water no longer paints the Newport canal's 0–2 m ENB5 band (nor
        // any charted shallow band) deep, so the canal leg is honest caution
        // over the chart's own depth — its origin keeps the endpoint carve it
        // always had (navGrid chartedShallow: OSM water under land paint is
        // not a charted pin). 20.36 NM, the 1,906 m decision-1 tail to the
        // pin and 0 m of land all unchanged.
        //
        // RE-PIN 25 → 15, D12 (2026-10-02; owner decision 12; own process):
        // the 4,302 m of 'charts disagree' — the overview and general cells'
        // land over OC-61-351824's water, the pin's tail included — is not
        // caution any more; 35 → 27 points, 0 m of land.
        //
        // RE-PIN 15 → 13 (round 2 item a, any-angle string pulling,
        // 2026-10-03; own process): two caution segments' stair vertices are
        // pulled out — their chords read no state the stair did not, over no
        // more of it (engine/stringPull) — 27 → 24 points.
        //
        // RE-PIN 13 → 12 (the real-chart check, 2026-10-03; own process): the
        // line across the bay the clearance ring picks touches one caution
        // cell fewer (24 → 25 points).
        expect(cautionCount(r)).toBeLessThanOrEqual(12);
    });

    // RE-PIN (owner decision 10, 2026-09-30): red OR needs-tide amber where
    // the tide clears it — as the Rivergate golden above.
    it('draws shallow water red, or amber only where the tide clears it (decision 10)', () => {
        expectConnected(r);
        const needM = fx.request.draftM + (fx.request.safetyM ?? 1);
        // Swept from no tide to a 6 m top, and never amber where no band
        // charts a depth (round-4 review, 2026-09-30: asked only at 2.5 m, and
        // 24 m of uncharted river mouth drew amber from a 2.6 m top).
        for (const highestM of HIGHEST_TIDE_SWEEP_M) {
            const bad = nonRedOverShallow(r, layers, needM, highestM);
            expect(bad.dryM, `highest ${highestM}`).toBe(0);
            expect(bad.shallowM, `highest ${highestM}`).toBe(0);
            expect(bad.amberBeyondTideM, `highest ${highestM}`).toBe(0);
            expect(bad.amberUnchartedM, `highest ${highestM}`).toBe(0);
        }
    });

    // KNOWN ENGINE LIMITATION (Claude B's lane — re-diagnosed 2026-06-11 with
    // per-gate instrumentation; supersedes reply 8's WRECKS hypothesis).
    // Two real flaws were found and FIXED en route:
    //   1. hazard-buffer veto — splices now validate against LAND only
    //      (NavGrid.landBlocked: LNDARE/coastline/coastal buffer), so a lead
    //      is never vetoed by the wrecks it guides past; and
    //   2. beacon-geometry — buildLeadingApproach now sails transit-LINE
    //      extensions (capture → intersection turn → break-off abeam dest),
    //      never to the beacon positions, which routinely stand ashore.
    // The REMAINING blocker (measured): the outer transit's seaward extension
    // crosses charted LNDARE — the Tangalooma DRYING BANK (first land at
    // -27.1917,153.3634, on the anchor→turn leg). Fix belongs to masterplan
    // Phase 4 (drying-bank/WATLEV caution semantics) or a degrade-to-inner-
    // lead ladder — the ladder also fires a newly-detected lead at RIVERGATE,
    // moving that golden, so it needs a deliberate re-pin, not a smuggle.
    it.fails('routes via the charted leading-line approach (debug.leadingApproach)', () => {
        expectConnected(r);
        expect(r.debug?.leadingApproach, 'leading-line APPROACH machinery must fire on Tangalooma').toBeTruthy();
    });

    it('endpoint snap < 150 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(150);
        expect(s.to).toBeLessThan(150);
    });
});
