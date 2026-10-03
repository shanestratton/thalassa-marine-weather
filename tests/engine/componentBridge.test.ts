/**
 * The component bridge: a pocket is bridged to the bay whichever water body
 * is numbered 0, and two large water bodies are never bridged.
 *
 * A pin in a pocket of water behind a thin wall (a canal estate behind its
 * seawall, Newport) is joined to the bay by the component bridge
 * (b61c443b, 2026-05-20): a corridor across the shortest gap, so the route
 * leaves through the wall at its thinnest instead of snapping the pin out to
 * the nearest bay water. labelConnectedComponents numbers water bodies from
 * 0, in scan order from the grid's south-west corner — and the bridge read 0
 * as "no water within reach", so it never bridged to or from the body
 * numbered 0. That is often the open bay: four of the five corridor fixtures
 * number Moreton Bay 0 (their pins share it, so no bridge is needed).
 * Measured on the Newport → Rivergate fixture with the Newport pin in its
 * pocket and the other pin swept over 25 points of the bay and river, both
 * ways, as the app routes (unchartedPolicy 'strict'): 14 of the 50 routes
 * skipped a bridge to water body 0. Two of them changed with the fix. From
 * the pin to −27.43, 153.2 was refused as crossing 1.4 km of charted land;
 * now it is a 25.1 NM route that starts 30 m from the pin and crosses none.
 * The reverse was refused the same way and now crosses 50 m, which the
 * planner's land check still refuses. The five fixture routes, forward,
 * reversed and at 2.44 m draft, do not change.
 *
 * The same skip had been hiding the bridge between two LARGE water bodies,
 * carved as clear navigable water across up to 500 m of land. Fixed alone,
 * the label let it carve through the 300 m land wall of decision 11's test
 * charts (tests/engine/noTideClears), routing where the only link between
 * the basins dries. Only a small pocket is bridged now (2026-10-04).
 *
 * Synthetic charts in a local metric frame round (LON0, LAT0), deep water
 * everywhere. The grid's south-west corner is water, so the water body
 * holding it is numbered 0. Each case is also routed with a land strip along
 * the grid's south edge holding a 200 m puddle, 8 km from the route: the
 * puddle is scanned first and numbered 0 instead. The route must not care.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { haversineM } from '../../services/engine/geometry';
import type { InshoreLayers } from '../../services/engine/types';

const LAT0 = -27.47;
const LON0 = 153.3;
const KY = 111_320;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
/** [lon, lat] of a point `x` m east and `y` m north of (LON0, LAT0). */
const at = (x: number, y: number): [number, number] => [LON0 + x / KX, LAT0 + y / KY];
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const box = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] },
});
const land = (x0: number, y0: number, x1: number, y1: number) => box(x0, y0, x1, y1, { acronym: 'LNDARE' });

/** Land over the grid's south edge (it lies near y = −8,756 m for pins at
 *  y = 150) with a 200 m puddle at x −5,000…−4,800, y −8,600…−8,400: the
 *  first water scanned. */
const SOUTH_STRIP_WITH_PUDDLE = [
    land(-30_000, -30_000, -5000, -8000),
    land(-4800, -30_000, 30_000, -8000),
    land(-5000, -30_000, -4800, -8600),
    land(-5000, -8400, -4800, -8000),
];

const layersWith = (...lands: Feature[]): InshoreLayers => ({
    DEPARE: fc(box(-40_000, -40_000, 40_000, 40_000, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 })),
    LNDARE: fc(...lands),
});

/** From x0 to x1 m east along y = 150, as the app routes (InshoreRouter.ts):
 *  strict, so the final land audit runs. */
const reqAlong = (x0: number, x1: number): RouteRequest => ({
    fromLon: at(x0, 150)[0],
    fromLat: at(x0, 150)[1],
    toLon: at(x1, 150)[0],
    toLat: at(x1, 150)[1],
    draftM: 2.4,
    safetyM: 0.5,
    unchartedPolicy: 'strict',
});

describe('a pocket is bridged to the bay whichever water body is numbered 0', () => {
    /** The pocket x 0…300, y 0…300; its wall 1 km thick but 150 m on the east. */
    const POCKET_WALLS = [
        land(-1000, -1000, 0, 1300),
        land(300, -1000, 450, 1300),
        land(0, -1000, 300, 0),
        land(0, 300, 300, 1300),
    ];
    // From the pocket's middle to the bay 2.85 km east.
    const req = reqAlong(150, 3000);
    const route = (layers: InshoreLayers): RouteResult => {
        const r = routeInshore(layers, req);
        if ('error' in r) throw new Error(`no route: ${r.code} ${r.error}`);
        return r;
    };
    const startM = (r: RouteResult): number => haversineM(req.fromLat, req.fromLon, r.polyline[0][1], r.polyline[0][0]);
    const bayIsZero = route(layersWith(...POCKET_WALLS));
    const puddleIsZero = route(layersWith(...POCKET_WALLS, ...SOUTH_STRIP_WITH_PUDDLE));

    it('the pin is bridged when the bay is numbered 0', () => {
        // Unbridged, the pin snapped out through the wall to the bay: 424 m.
        expect(bayIsZero.debug?.originSnap?.snapDistanceM ?? 0).toBeLessThan(60);
        expect(startM(bayIsZero)).toBeLessThan(60);
    });

    it('it routes exactly as it does when a puddle is numbered 0 instead', () => {
        expect(startM(puddleIsZero)).toBeLessThan(60);
        expect(bayIsZero.polyline).toEqual(puddleIsZero.polyline);
        expect(bayIsZero.cautionMask).toEqual(puddleIsZero.cautionMask);
        // The bridge decides only where the route leaves the pocket; the wall
        // it crosses is the land audit's business, as on any bridged route.
        expect(bayIsZero.debug?.hardLandAwayM).toBe(puddleIsZero.debug?.hardLandAwayM);
    });
});

describe('two large water bodies are never bridged', () => {
    // Two basins split by a 300 m land wall the full height of the grid, the
    // pins 1 km either side of it. Bridged — as the engine did whenever
    // neither basin was numbered 0 — the wall got a corridor of clear water
    // where the scan first met its narrowest gap, 8 km south, and the 16 km
    // detour to it and back was drawn clear across 320 m of charted land.
    // Unbridged, the origin's snap reaches through the wall, so the localized
    // relax retry crosses it: straight, red, and reported by the final land
    // audit (debug.hardLandAwayM), which the planner and Auto refuse.
    const WALL = land(1000, -40_000, 1300, 40_000);
    const req = reqAlong(0, 2500);
    const route = (layers: InshoreLayers): RouteResult => {
        const r = routeInshore(layers, req);
        if ('error' in r) throw new Error(`no route: ${r.code} ${r.error}`);
        return r;
    };
    const westIsZero = route(layersWith(WALL));
    const puddleIsZero = route(layersWith(WALL, ...SOUTH_STRIP_WITH_PUDDLE));
    /** Metres east of LON0. */
    const xM = (lon: number): number => (lon - LON0) * KX;

    it('a way through a thin land wall is red, straight and reported as land, whichever basin is numbered 0', () => {
        for (const r of [westIsZero, puddleIsZero]) {
            r.polyline.slice(1).forEach(([lon], i) => {
                const [a, b] = [xM(r.polyline[i][0]), xM(lon)];
                if (Math.max(a, b) > 1000 && Math.min(a, b) < 1300)
                    expect(r.cautionMask?.[i], `segment ${i}`).toBe(true);
            });
            expect(r.debug?.hardLandAwayM ?? 0).toBeGreaterThan(0);
            expect(r.distanceNM).toBeLessThan(2); // the pins are 2.5 km apart
        }
        expect(westIsZero.polyline).toEqual(puddleIsZero.polyline);
    });
});
