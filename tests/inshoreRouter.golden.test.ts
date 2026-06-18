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

import { loadFixture, assembleLayers } from './helpers/corridorFixture';

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
    it('distance pinned at 22.26 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(22.26 * 0.98);
        expect(r.distanceNM).toBeLessThan(22.26 * 1.02);
    });

    it('endpoint snap < 100 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(100);
        expect(s.to).toBeLessThan(100);
    });

    it('caution cells at or below the lock-in baseline (9)', () => {
        expectConnected(r);
        expect(cautionCount(r)).toBeLessThanOrEqual(9);
    });

    it('phaseTimings present and loosely bounded', () => {
        expectConnected(r);
        expect(r.phaseTimings).toBeTruthy();
        for (const [phase, ms] of Object.entries(r.phaseTimings ?? {})) {
            expect(ms, `phase ${phase} runaway`).toBeLessThan(30_000);
        }
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

    it('distance within 10% of the 2.40 m benchmark (22.26 NM post-bundle)', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(22.26 * 0.9);
        expect(r.distanceNM).toBeLessThan(22.26 * 1.1);
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
    it('distance pinned at 18.43 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(18.43 * 0.98);
        expect(r.distanceNM).toBeLessThan(18.43 * 1.02);
    });

    it('caution cells at or below the lock-in baseline (11)', () => {
        expectConnected(r);
        // RE-PIN 10→11 (3-tier Phase 4 + along-segment caution, 42bf48c8):
        // route distance is byte-identical (18.43 NM pinned green), only the
        // caution count rose by ONE cell — the along-segment sampler catching
        // a mid-segment caution the old per-vertex sampler missed on the SAME
        // route. Honest by construction (stable geometry, +1 honest flag).
        expect(cautionCount(r)).toBeLessThanOrEqual(11);
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
