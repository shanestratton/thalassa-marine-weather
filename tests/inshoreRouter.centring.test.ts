/**
 * Coarse-A* centring guard — the wall-hug cure (computeCentreFactor).
 *
 * An UNMARKED, two-sided, deep channel that BENDS, with a shallow caution bar
 * across its mouth. The bar ends tryMarinaCenterline's clean prefix, so the
 * channel BEYOND the bar falls back to raw coarse A* — the exact regime that
 * wall-hugs (rides the inside of each bend) without a centring term. With the
 * centring term the route bows back to mid-channel.
 *
 * Measured on master (no centring): the route rides the bank at ~+337 m off the
 * centreline at the bend apex (bank at ±350 m). With centring: ~+41 m. The 150 m
 * bound below cleanly separates the two — it FAILS on pre-centring master and
 * PASSES with the fix, and it is far enough from the bank (350 m) to never flake.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
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
const E_LON = 153.04; // ~3.95 km E–W at -27.4
const AMP = 0.004; // ~440 m S-bend amplitude
const HALF_W_M = 350; // banks 700 m apart — wide enough that the wall-hug is unambiguous
const latC = (lon: number): number => -27.4 + AMP * Math.sin((2 * Math.PI * (lon - W_LON)) / (E_LON - W_LON));

function bank(side: 'N' | 'S'): Feature {
    const hwDeg = HALF_W_M / M_PER_DEG_LAT;
    const farLat = side === 'N' ? -27.3 : -27.5; // extends PAST the DEPARE blanket → channel is sealed
    const edge: [number, number][] = [];
    for (let lon = W_LON; lon <= E_LON + 1e-9; lon += 0.0004)
        edge.push([lon, latC(lon) + (side === 'N' ? hwDeg : -hwDeg)]);
    const wx = W_LON - 0.01;
    const ex = E_LON + 0.01;
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [wx, farLat],
                    ...edge,
                    [ex, latC(E_LON) + (side === 'N' ? hwDeg : -hwDeg)],
                    [ex, farLat],
                    [wx, farLat],
                ],
            ],
        },
    };
}

describe('coarse-A* centring — unmarked bending channel beyond a caution bar', () => {
    const layers = {
        LNDARE: fc(bank('N'), bank('S')),
        DEPARE: fc(
            rect(152.98, -27.48, 153.06, -27.32, { DRVAL1: 12, DRVAL2: 20 }),
            rect(153.004, -27.46, 153.006, -27.34, { DRVAL1: 1.5 }), // the bar
        ),
    };
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

    it('rides mid-channel beyond the bar instead of hugging the bend (≤150 m off centreline)', () => {
        expect('polyline' in route).toBe(true);
        if (!('polyline' in route)) return;
        const poly = route.polyline as [number, number][];
        const latAt = (lon: number): number => {
            for (let i = 0; i < poly.length - 1; i++) {
                const [aLon, aLat] = poly[i];
                const [bLon, bLat] = poly[i + 1];
                if ((aLon - lon) * (bLon - lon) <= 0 && aLon !== bLon)
                    return aLat + ((bLat - aLat) * (lon - aLon)) / (bLon - aLon);
            }
            return NaN;
        };
        // Sample the channel WELL east of the bar (bar ends ~153.006; skip its
        // transition) through both bend apexes.
        let maxOff = 0;
        for (let lon = 153.014; lon <= 153.034; lon += 0.002) {
            const lat = latAt(lon);
            if (Number.isNaN(lat)) continue;
            maxOff = Math.max(maxOff, Math.abs(lat - latC(lon)) * M_PER_DEG_LAT);
        }
        // Master (no centring) rides the bend at ~337 m; the fix holds ~72 m. The
        // 150 m bound separates them with wide margin both ways.
        expect(maxOff).toBeLessThanOrEqual(150);
    });

    it('steers a CLEAN line, not a drunken stagger (few vertices through the channel)', () => {
        if (!('polyline' in route)) throw new Error('expected a route');
        const poly = route.polyline as [number, number][];
        // Count route vertices strictly inside the post-bar channel (between the
        // bar at ~153.006 and the east mouth). A clean line through a 2-bend S
        // needs only a handful; a grid stagger needs many.
        const interior = poly.filter(([lon]) => lon > 153.01 && lon < E_LON - 0.001).length;
        // De-staggered: ~4 vertices (the 2 S-bends). The pre-fix grid stagger is
        // ~12; the 8 bound separates them.
        expect(interior).toBeLessThanOrEqual(8);
    });
});
