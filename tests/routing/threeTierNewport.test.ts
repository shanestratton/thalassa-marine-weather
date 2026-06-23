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

    it('measured against the real marks — stepping AT the gates stays bounded', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        const s = auditStepping(result.polyline, gates);
        // gate-proximal kinks (the bead-on-a-string signature) must be few;
        // this is the assertion my earlier no-gates version vacuously passed.
        expect(s.kinksNearGate).toBeLessThanOrEqual(2);
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
