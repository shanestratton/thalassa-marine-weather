/**
 * Four-tier wiring — end-to-end on Shane's REAL Newport→Murrarie
 * route (tests/fixtures/newport-shane.corridor.json.gz). This is the
 * regression that proves the live wiring: routeInshore now runs
 * segmentRoute → per-span tier routers → glue, and the result must
 *   (1) be produced by the tier-contract path (not the monolith fallback),
 *   (2) follow the Newport channel via a tier-2 channel span (the un-step),
 *   (3) carry NO double-back anywhere (the de-spike contract, end to end),
 *   (4) span origin → destination.
 */
import { describe, it, expect } from 'vitest';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../../services/inshoreRouterEngine';
import { loadFixture, assembleLayers } from '../helpers/corridorFixture';
import { auditStepping, type Gate } from '../helpers/routeScorecard';
import { parseLateralMarks } from '../../services/fairlead';

describe('four-tier wiring — Newport→Murrarie (Shane real route)', () => {
    const fx = loadFixture('newport-shane.corridor.json.gz');
    const layers = assembleLayers(fx) as InshoreLayers;
    const req = fx.request as RouteRequest;
    const result = routeInshore(layers, req);
    const ok = 'polyline' in result;
    // gates from the real lateral marks — so kinksNearGate is MEANINGFUL (a
    // kink within 150 m of a mark = stepping at that mark). An empty gate list
    // makes kinksNearGate vacuously 0; never assert on it without gates.
    const marks = parseLateralMarks([
        ...(layers.BOYLAT?.features ?? []),
        ...(layers.BCNLAT?.features ?? []),
    ] as Parameters<typeof parseLateralMarks>[0]);
    const gates: Gate[] = marks.map((m) => ({ port: { lat: m.lat, lon: m.lon }, stbd: { lat: m.lat, lon: m.lon } }));

    it('routes successfully (not a failure)', () => {
        expect(ok).toBe(true);
    });

    it('the tier contract path produced the route (not the monolith fallback)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(result.debug?.threeTier).toBeTruthy();
    });

    it('a tier-2 span carries the Newport channel (segmented + routed)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(result.debug?.threeTier).toContain('tier2');
    });

    it('no double-back anywhere on the route (de-spike contract holds end-to-end)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(auditStepping(result.polyline, gates).maxKinkDeg).toBeLessThan(120);
    });

    // RE-PIN 2 → 4 (D12 fix-up, 2026-10-03; owner decision 12, Shane: "Trust
    // the detailed chart"; measured in its own process). This capture is
    // chart-only (no OSM overlay), and decision 12 no longer disputes the
    // overview's land over the harbour cell's never-drying water at the
    // Newport canal mouth. The route used to leave the canal due EAST over
    // 2.2 km of charted land and met one mark (2F, 84 m). It now runs NORTH
    // through the entrance channel (still 1.2 km of relaxed charted land
    // here: the capture has no depth area in the channel) and past marks
    // 3, 4, 5 and 7 — where the tier-2 grid search steps 71 m sideways and
    // back (90°, 45°, 45°, 42° within 150 m of them, passing 12 m from mark
    // 5). A 50 m-grid artefact, not a new rule: it is round 2's item (a)
    // (any-angle string pulling), which should bring this back to 2. The
    // production shape (chart leads + OSM overlay) has 1 such kink (HEAD 0).
    //
    // RESTORED 4 → 2 (round 2 item a, any-angle string pulling, 2026-10-03;
    // measured in its own process): engine/stringPull pulls the stair taut
    // where a chord is as safe, and threads the 5/6 and 3/4 gates through
    // their centres. Two kinks remain near the marks, both the channel's own
    // shape: the turn north between mark 7 and the unnumbered starboard
    // sector-light beacon between 7 and 5 (78°), and the bend at the 5/6
    // centre (35°). The pull may not pass that beacon on its other side, nor
    // any mark closer than the stair did (or than 25 m).
    //
    // RE-PIN 2 → 3 (package 125-06, the same-tide pull; measured in its own
    // process): leaving the entrance's last pair the route turns for Moreton
    // Bay there (27°), over the 2–5 m band charted 2.0 m it was crossing
    // anyway, where it ran 400 m on north first (a 50° turn clear of the
    // marks). A turn for the destination, not a step: no mark is passed on
    // its other side or closer than the stair did (or than 25 m), and the
    // entrance marks are still passed wide (below).
    it('measured against the real marks — stepping AT the gates stays bounded', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        const s = auditStepping(result.polyline, gates);
        // gate-proximal kinks (the bead-on-a-string signature) must be few;
        // this is the assertion my earlier no-gates version vacuously passed.
        expect(s.kinksNearGate).toBeLessThanOrEqual(3);
    });

    // Round 2 item (a), 2026-10-03: the stair passed mark 5 at 12.2 m and
    // mark 4 at 6.0 m inside gates 54 m and 50 m wide. Threaded through the
    // gate centres, the entrance passes no lateral mark closer than 23 m
    // (measured: mark 6 23.2 m, 4 23.7 m, 2 23.9 m, 3 24.3 m, 7 26.0 m, 5 27.1 m).
    it('passes the entrance marks 3 to 7 wide, not by metres', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        const p = result.polyline;
        const entrance = marks.filter(
            (m) => m.lat > -27.1945 && m.lat < -27.182 && m.lon > 153.1015 && m.lon < 153.1035,
        );
        expect(entrance.length).toBeGreaterThanOrEqual(6);
        for (const m of entrance) {
            const kx = 111_320 * Math.cos((m.lat * Math.PI) / 180);
            const ky = 110_540;
            let best = Infinity;
            for (let i = 0; i + 1 < p.length; i++) {
                const dx = (p[i + 1][0] - p[i][0]) * kx;
                const dy = (p[i + 1][1] - p[i][1]) * ky;
                const qx = (m.lon - p[i][0]) * kx;
                const qy = (m.lat - p[i][1]) * ky;
                const l2 = dx * dx + dy * dy;
                const t = l2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
                best = Math.min(best, Math.hypot(qx - t * dx, qy - t * dy));
            }
            expect(best, `mark ${m.name ?? m.key}${m.seq}`).toBeGreaterThan(20);
        }
    });

    it('the route spans origin → destination', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        const p = result.polyline;
        expect(p.length).toBeGreaterThan(2);
        expect(Math.abs(p[0][0] - req.fromLon)).toBeLessThan(0.01);
        expect(Math.abs(p[0][1] - req.fromLat)).toBeLessThan(0.01);
        expect(Math.abs(p[p.length - 1][0] - req.toLon)).toBeLessThan(0.01);
        expect(Math.abs(p[p.length - 1][1] - req.toLat)).toBeLessThan(0.01);
    });
});
