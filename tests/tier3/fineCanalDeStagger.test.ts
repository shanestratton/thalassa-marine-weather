/**
 * Fine-canal de-stagger guard — the "drunk steering" cure (fineCanalGrid.ts).
 *
 * An injected-Mapbox-water canal is FORCED through the tier-3 fine pass
 * (routeMarina on a ~12 m grid). routeMarina's 4-connected Dijkstra wanders
 * mid-channel; the injected branch USED to collapse that with centrelineSimplify,
 * which faithfully reproduced the wander as a jagged staircase (the cyan canal the
 * user saw zig-zag). The coarse-grid de-stagger never reaches this geometry — it
 * is owned entirely by the fine pass.
 *
 * The fix: prefer stringPull (taut → straight in a narrow canal, where there is no
 * room to wall-hug), falling back to centrelineSimplify only when the taut line
 * would shed clearance toward a bank (a WIDE canal). This is a NARROW diagonal
 * injected canal: pre-fix the rendered line carried ~1650° of staircase turning
 * over ~30 vertices; post-fix it is a near-straight ~0° line. The 300° bound
 * separates them with wide margin. A genuine wall-hug regression on wide canals is
 * caught separately by tests/routing/threeTierNewport.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import type { Feature, FeatureCollection } from 'geojson';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const rect = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});

const M_PER_DEG_LAT = 110_540;
const W_LON = 153.0;
const E_LON = 153.025;
const SLOPE = 0.6; // a shallow diagonal — makes the 4-connected fine grid staircase
const HALF_W_M = 90; // narrow canal (banks ~180 m apart)
const latC = (lon: number): number => -27.4 + SLOPE * (lon - W_LON);

function bank(side: 'N' | 'S'): Feature {
    const hwDeg = HALF_W_M / M_PER_DEG_LAT;
    const far = side === 'N' ? -27.34 : -27.46;
    const edge: [number, number][] = [];
    for (let lon = W_LON; lon <= E_LON + 1e-9; lon += 0.0003)
        edge.push([lon, latC(lon) + (side === 'N' ? hwDeg : -hwDeg)]);
    const wx = W_LON - 0.01;
    const ex = E_LON + 0.01;
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [
                [[wx, far], ...edge, [ex, latC(E_LON) + (side === 'N' ? hwDeg : -hwDeg)], [ex, far], [wx, far]],
            ],
        },
    };
}

describe('tier-3 fine canal — de-staggered, not drunk', () => {
    const hwDeg = HALF_W_M / M_PER_DEG_LAT;
    const depare: Feature[] = [rect(152.98, -27.47, 153.05, -27.33, { DRVAL1: 12, DRVAL2: 20 })];
    // Mapbox-water fill strip over the channel ⇒ buildNavGrid tags injectedCanal ⇒
    // the span is forced through the tier-3 fine pass.
    for (let lon = W_LON; lon < E_LON; lon += 0.0006) {
        depare.push(
            rect(lon, latC(lon) - hwDeg, lon + 0.0006, latC(lon) + hwDeg, { DRVAL1: 5, _source: 'mapbox-water' }),
        );
    }
    const layers = { LNDARE: fc(bank('N'), bank('S')), DEPARE: fc(...depare) };
    const req: RouteRequest = {
        fromLat: latC(W_LON + 0.0006),
        fromLon: W_LON + 0.0006,
        toLat: latC(E_LON - 0.0006),
        toLon: E_LON - 0.0006,
        draftM: 2,
        safetyM: 1,
        resolutionM: 50,
    };
    const route = routeInshore(layers, req);

    it('routes the injected canal through the fine pass (provenance = finegrid)', () => {
        expect('polyline' in route).toBe(true);
        const prov = (route as { debug?: { threeTier?: string } }).debug?.threeTier ?? '';
        expect(prov).toContain('finegrid');
    });

    it('steers a clean line, not a staircase (total turning ≤ 300°)', () => {
        if (!('polyline' in route)) throw new Error('expected a route');
        const poly = (route.polyline as [number, number][]).filter(
            ([lon]) => lon > W_LON + 0.003 && lon < E_LON - 0.003,
        );
        const bearing = (a: number[], b: number[]): number =>
            Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]);
        let sumTurn = 0;
        for (let i = 1; i < poly.length - 1; i++) {
            let d = bearing(poly[i], poly[i + 1]) - bearing(poly[i - 1], poly[i]);
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            sumTurn += Math.abs(d);
        }
        expect((sumTurn * 180) / Math.PI).toBeLessThanOrEqual(300);
    });
});
