/**
 * Three-tier wiring (PHASE 4) — end-to-end on Shane's REAL Newport→Murrarie
 * route (tests/fixtures/newport-shane.corridor.json.gz). This is the
 * regression that proves the live wiring: routeInshore now runs
 * segmentRoute → per-span tier routers → glue, and the result must
 *   (1) be produced by the three-tier path (not the monolith fallback),
 *   (2) follow the Newport channel via a tier-3 fairlead span (the un-step),
 *   (3) carry NO double-back anywhere (the de-spike contract, end to end),
 *   (4) span origin → destination.
 */
import { describe, it, expect } from 'vitest';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../../services/inshoreRouterEngine';
import { loadFixture, assembleLayers } from '../helpers/corridorFixture';
import { auditStepping } from '../helpers/routeScorecard';

describe('three-tier wiring — Newport→Murrarie (Shane real route)', () => {
    const fx = loadFixture('newport-shane.corridor.json.gz');
    const layers = assembleLayers(fx) as InshoreLayers;
    const req = fx.request as RouteRequest;
    const result = routeInshore(layers, req);
    const ok = 'polyline' in result;

    it('routes successfully (not a failure)', () => {
        expect(ok).toBe(true);
    });

    it('the three-tier contract path produced the route (not the monolith fallback)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(result.debug?.threeTier).toBeTruthy();
    });

    it('a tier-3 span carries the route (the Newport channel is segmented + routed)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(result.debug?.threeTier).toContain('tier3');
    });

    it('no double-back anywhere on the route (de-spike contract holds end-to-end)', () => {
        if (!('polyline' in result)) throw new Error('route failed');
        expect(auditStepping(result.polyline).maxKinkDeg).toBeLessThan(120);
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
