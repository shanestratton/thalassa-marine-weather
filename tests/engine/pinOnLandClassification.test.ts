/**
 * A pin with no water within reach is reported as on land, not as
 * "disconnected water bodies".
 *
 * Every route carves a 60 m bubble of assumed water round the origin (the
 * endpoint carve: a marina pin under bleeding land paint). When no water body
 * reaches both pins, the failure is classified by asking whether each pin has
 * water within the 10 km snap reach — and asked of the CARVED grid, the
 * bubble answered for the origin: an origin deep inland was reported as
 * 'destination-disconnected' ("Origin and destination are in disconnected
 * water bodies…"), and a destination within 10 km of that bubble looked
 * reachable too. The Pi's old hand-merged copy fixed this on 2026-08-06
 * (01383633: read each pin's water before the carve); the fix never reached
 * this engine, which the Pi now runs unchanged.
 *
 * Synthetic charts at 32° N (1° lon ≈ 94.4 km), LNDARE only; draft 2.5 m.
 */
import type { FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import type { InshoreLayers } from '../../services/engine/types';

/** One LNDARE polygon per [lon, lat] ring (closed here). */
const land = (...rings: [number, number][][]): InshoreLayers => ({
    LNDARE: {
        type: 'FeatureCollection',
        features: rings.map((ring) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
        })),
    } as FeatureCollection,
});

const codeOf = (layers: InshoreLayers, req: RouteRequest): string | undefined => {
    const result = routeInshore(layers, req);
    return 'error' in result ? result.code : 'routed';
};

describe('a pin with no water within reach is on land', () => {
    it('an origin 14 km from any water is origin-on-land, and stays so on a repeat request', () => {
        // Land over the whole route bbox (lon −81.08…−80.82) but its east
        // strip: the origin's nearest water is 14.2 km east, the
        // destination's 4.7 km.
        const layers = land([
            [-81.1, 31.9],
            [-80.85, 31.9],
            [-80.85, 32.1],
            [-81.1, 32.1],
        ]);
        const req: RouteRequest = { fromLat: 32.0, fromLon: -81.0, toLat: 32.0, toLon: -80.9, draftM: 2.5 };
        expect(codeOf(layers, req)).toBe('origin-on-land');
        // The repeat reads the cached grid: the first route's bubble must not
        // have been written into it.
        expect(codeOf(layers, req)).toBe('origin-on-land');
    });

    it("a destination 12 km from any water is destination-on-land, though the origin's bubble is 7.6 km away", () => {
        // Water in the bbox's west strip (lon −81.08…−81.05) only: the
        // origin's nearest water is 4.7 km west, the destination's 12.3 km.
        const layers = land([
            [-81.05, 31.8],
            [-80.7, 31.8],
            [-80.7, 32.2],
            [-81.05, 32.2],
        ]);
        const req: RouteRequest = { fromLat: 32.0, fromLon: -81.0, toLat: 32.0, toLon: -80.92, draftM: 2.5 };
        expect(codeOf(layers, req)).toBe('destination-on-land');
        expect(codeOf(layers, req)).toBe('destination-on-land');
    });
});
