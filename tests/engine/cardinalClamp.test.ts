/**
 * cardinalClamp — the post-process that forces the final route onto a cardinal's SAFE side
 * (Shane: two East cardinals, the route ran WEST of Q(3)W). The obstacle disc can't steer
 * gate/track segments, so this nudges the assembled geometry directly. These tests are the
 * ONLY coverage — the golden + Newport repro suites feed zero cardinals (no orientHazards call),
 * so the clamp is a strict no-op there and is never exercised by them.
 */
import { describe, it, expect } from 'vitest';
import {
    parseCardinalDiscs,
    clampRouteToCardinalSafeSide,
    type CardinalDisc,
    type LateralClampMark,
} from '../../services/tier3/cardinalClamp';
import type { NavGrid } from '../../services/engine/types';

const MIN_LON = 153.0;
const MIN_LAT = -27.4;
const D = 0.0005; // ~55 m lat / ~49 m lon
const W = 400;
const H = 400;

function waterGrid(): NavGrid {
    const cells = new Float32Array(W * H);
    cells.fill(10);
    return {
        width: W,
        height: H,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon: D,
        dLat: D,
        cells,
        preferred: new Uint8Array(W * H),
        landBlocked: new Uint8Array(W * H),
    };
}

/** Mark a lon/lat box as hard land (cells=NaN, matching the engine's "A* won't go here" signal). */
function addLand(grid: NavGrid, lonLo: number, lonHi: number, latLo: number, latHi: number): void {
    for (let y = 0; y < grid.height; y++) {
        const lat = grid.minLat + (y + 0.5) * grid.dLat;
        if (lat < latLo || lat > latHi) continue;
        for (let x = 0; x < grid.width; x++) {
            const lon = grid.minLon + (x + 0.5) * grid.dLon;
            if (lon < lonLo || lon > lonHi) continue;
            const idx = y * grid.width + x;
            grid.cells[idx] = NaN;
            grid.landBlocked![idx] = 1;
        }
    }
}

const segKey = (a: readonly [number, number], b: readonly [number, number]): string =>
    `${a[0]}|${a[1]}→${b[0]}|${b[1]}`;

// A roughly N-S route at the given longitude (the hazard side of an east cardinal at 153.1).
function nsRoute(lon: number, latFrom: number, latTo: number, n = 9): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push([lon, latFrom + ((latTo - latFrom) * i) / (n - 1)]);
    return out;
}

// A roughly E-W route at the given latitude.
function ewRoute(lat: number, lonFrom: number, lonTo: number, n = 21): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push([lonFrom + ((lonTo - lonFrom) * i) / (n - 1), lat]);
    return out;
}

/** Output vertex longitude nearest the given latitude (for side-of-mark assertions). */
function lonNearestLat(poly: readonly [number, number][], lat: number): number {
    let best = Infinity;
    let lon = NaN;
    for (const [vlon, vlat] of poly) {
        const d = Math.abs(vlat - lat);
        if (d < best) {
            best = d;
            lon = vlon;
        }
    }
    return lon;
}
/** Output vertex latitude nearest the given longitude. */
function latNearestLon(poly: readonly [number, number][], lon: number): number {
    let best = Infinity;
    let lat = NaN;
    for (const [vlon, vlat] of poly) {
        const d = Math.abs(vlon - lon);
        if (d < best) {
            best = d;
            lat = vlat;
        }
    }
    return lat;
}

const noGates = { gateSegKeys: new Set<string>() };

describe('parseCardinalDiscs', () => {
    const haz = (props: Record<string, unknown>) => ({ properties: props });

    it('maps an oriented cardinal hazard (with stamped marker pos) to a CardinalDisc', () => {
        const out = parseCardinalDiscs([
            haz({
                _class: 'iala-oriented-hazard',
                _cardinalDir: 'e',
                _markerLat: -27.3,
                _markerLon: 153.1,
                _radiusM: 1000,
            }),
        ]);
        expect(out).toEqual([{ lat: -27.3, lon: 153.1, dir: 'e', radiusM: 1000 }]);
    });

    it('SKIPS a hazard with no stamped marker position (never derive from the centroid)', () => {
        expect(
            parseCardinalDiscs([haz({ _class: 'iala-oriented-hazard', _cardinalDir: 'e', _radiusM: 1000 })]).length,
        ).toBe(0);
    });

    it('SKIPS a land-bearing (non-cardinal) oriented hazard', () => {
        expect(
            parseCardinalDiscs([
                haz({ _class: 'iala-oriented-hazard', _cardinalDir: null, _markerLat: -27.3, _markerLon: 153.1 }),
            ]).length,
        ).toBe(0);
    });
});

describe('clampRouteToCardinalSafeSide', () => {
    const east: CardinalDisc = { lat: -27.3, lon: 153.1, dir: 'e', radiusM: 1000 };

    it('GUARD 1: zero cardinals → byte-identical no-op', () => {
        const route = nsRoute(153.094, -27.302, -27.298);
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [], waterGrid(), noGates);
        expect(out.polyline).toEqual(route);
        expect(out.redMask).toEqual(red);
    });

    it('pushes a route running WEST of an EAST cardinal onto the east (safe) side', () => {
        const route = nsRoute(153.094, -27.303, -27.297); // ~590 m west of the buoy
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [east], waterGrid(), noGates);
        // The vertex closest to the cardinal's latitude must end up EAST of the buoy.
        let best = Infinity;
        let bestLon = NaN;
        for (const [lon, lat] of out.polyline) {
            const d = Math.abs(lat - east.lat);
            if (d < best) {
                best = d;
                bestLon = lon;
            }
        }
        expect(bestLon).toBeGreaterThan(east.lon); // crossed to the safe (east) side
    });

    it('GUARD land/no-water: safe side is land → no-op (never wall off the route)', () => {
        const grid = waterGrid();
        addLand(grid, east.lon, 153.2, -27.4, -27.2); // everything EAST of the buoy is land
        const route = nsRoute(153.094, -27.303, -27.297);
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [east], grid, noGates);
        expect(out.polyline).toEqual(route); // unchanged — can't reach the safe side
    });

    it('GUARD 6: a gate vertex on the hazard side is never moved', () => {
        const route = nsRoute(153.094, -27.303, -27.297);
        const red = route.map(() => false);
        // Make the middle vertex a gate endpoint (its segment is a lateral-pair gate segment).
        const mid = Math.floor(route.length / 2);
        const gateSegKeys = new Set<string>([segKey(route[mid], route[mid + 1])]);
        const out = clampRouteToCardinalSafeSide(route, red, [east], waterGrid(), { gateSegKeys });
        // The gate vertex (and its partner) must be present unchanged in the output.
        expect(out.polyline).toContainEqual(route[mid]);
        expect(out.polyline).toContainEqual(route[mid + 1]);
    });

    it('two EAST cardinals → route east of both (same side, Shane’s pair)', () => {
        const a: CardinalDisc = { lat: -27.305, lon: 153.1, dir: 'e', radiusM: 1000 };
        const b: CardinalDisc = { lat: -27.295, lon: 153.1, dir: 'e', radiusM: 1000 };
        const route = nsRoute(153.094, -27.31, -27.29, 21);
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [a, b], waterGrid(), noGates);
        const sideOk = (c: CardinalDisc) => {
            // nearest output vertex to c is on/east of the buoy
            let best = Infinity;
            let lon = NaN;
            for (const [vlon, vlat] of out.polyline) {
                const d = Math.hypot((vlon - c.lon) * 98900, (vlat - c.lat) * 111320);
                if (d < best) {
                    best = d;
                    lon = vlon;
                }
            }
            return lon >= c.lon;
        };
        expect(sideOk(a)).toBe(true);
        expect(sideOk(b)).toBe(true);
    });

    it('GUARD 3: opposed E/W cardinals at one spot → no oscillation (first axis wins, all finite)', () => {
        const e: CardinalDisc = { lat: -27.3, lon: 153.1, dir: 'e', radiusM: 1000 };
        const w: CardinalDisc = { lat: -27.3, lon: 153.1, dir: 'w', radiusM: 1000 };
        const route = nsRoute(153.094, -27.302, -27.298);
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [e, w], waterGrid(), noGates);
        for (const [lon, lat] of out.polyline) {
            expect(Number.isFinite(lon)).toBe(true);
            expect(Number.isFinite(lat)).toBe(true);
        }
        // East was committed first; the opposed West must NOT have pulled it back west of the buoy.
        let best = Infinity;
        let bestLon = NaN;
        for (const [lon, lat] of out.polyline) {
            const d = Math.abs(lat - e.lat);
            if (d < best) {
                best = d;
                bestLon = lon;
            }
        }
        expect(bestLon).toBeGreaterThan(e.lon);
    });

    it('GUARD 4: a far-off cardinal (>band) never moves the route', () => {
        const far: CardinalDisc = { lat: -26.5, lon: 153.1, dir: 'e', radiusM: 1000 }; // ~89 km north
        const route = nsRoute(153.094, -27.303, -27.297);
        const red = route.map(() => false);
        const out = clampRouteToCardinalSafeSide(route, red, [far], waterGrid(), noGates);
        expect(out.polyline).toEqual(route);
    });
});

describe('clampRouteToCardinalSafeSide — solo laterals (IALA-A red-to-port / green-to-starboard)', () => {
    // A southbound route (lat decreasing) at lon 153.1. Travel tangent ≈ (east 0, north −1).
    //   RED (port-hand): safe side = RIGHT of travel = WEST  ⇒ the boat passes west of the mark.
    //   GREEN (stbd):    safe side = LEFT  of travel = EAST  ⇒ the boat passes east of the mark.
    const southbound = (): [number, number][] => nsRoute(153.1, -27.295, -27.305, 25);
    const lat = -27.3;
    const clamp = (route: [number, number][], laterals: LateralClampMark[], grid = waterGrid(), gates = noGates) =>
        clampRouteToCardinalSafeSide(
            route,
            route.map(() => false),
            [],
            grid,
            { ...gates, laterals },
        );

    it('RED on the route’s east (boat to its east = WRONG) ⇒ route pushed WEST of the red', () => {
        const route = southbound();
        const redMark: LateralClampMark = { lat, lon: 153.099, side: 'port' }; // ~99 m west of the track
        const out = clamp(route, [redMark]);
        expect(out.movedLaterals).toBe(1);
        expect(lonNearestLat(out.polyline, lat)).toBeLessThan(redMark.lon); // crossed onto the WEST (safe) side
    });

    it('GREEN on the route’s west (boat to its west = WRONG) ⇒ route pushed EAST of the green', () => {
        const route = southbound();
        const grnMark: LateralClampMark = { lat, lon: 153.101, side: 'stbd' }; // ~99 m east of the track
        const out = clamp(route, [grnMark]);
        expect(out.movedLaterals).toBe(1);
        expect(lonNearestLat(out.polyline, lat)).toBeGreaterThan(grnMark.lon); // crossed onto the EAST (safe) side
    });

    it('already on the safe side ⇒ byte-identical no-op', () => {
        const route = southbound();
        // RED's safe side is WEST. Put it EAST of the track ⇒ the boat (153.1) is already WEST of it
        // (its safe side) ⇒ nothing to do.
        const redMark: LateralClampMark = { lat, lon: 153.101, side: 'port' };
        const out = clamp(route, [redMark]);
        expect(out.movedLaterals).toBe(0);
        expect(out.polyline).toEqual(route);
    });

    it('a port/starboard PAIR (a gate) ⇒ never clamped (paired marks belong to the channel router)', () => {
        const route = southbound();
        const pair: LateralClampMark[] = [
            { lat, lon: 153.099, side: 'port' }, // would be wrong-side on its own…
            { lat, lon: 153.101, side: 'stbd' }, // …but its opposite partner is ~198 m away ⇒ a gate
        ];
        const out = clamp(route, pair);
        expect(out.movedLaterals).toBe(0);
        expect(out.polyline).toEqual(route); // route stays dead-centre between the pair
    });

    it('solo wrong-side RED but on a GATE segment ⇒ never moved (gate vertices pinned)', () => {
        const route = southbound();
        const mid = Math.floor(route.length / 2);
        const gateSegKeys = new Set<string>([segKey(route[mid], route[mid + 1])]);
        const redMark: LateralClampMark = { lat, lon: 153.099, side: 'port' };
        const out = clamp(route, [redMark], waterGrid(), { gateSegKeys });
        expect(out.movedLaterals).toBe(0);
        expect(out.polyline).toContainEqual(route[mid]);
    });

    it('safe side is land ⇒ no-op (never wall off the route)', () => {
        const grid = waterGrid();
        addLand(grid, 153.0, 153.099, -27.4, -27.2); // everything WEST of the red is land
        const route = southbound();
        const redMark: LateralClampMark = { lat, lon: 153.099, side: 'port' }; // safe side = west = land
        const out = clamp(route, [redMark], grid);
        expect(out.movedLaterals).toBe(0);
        expect(out.polyline).toEqual(route);
    });

    it('travel-relative: an EASTBOUND route puts a RED’s safe side to the SOUTH', () => {
        // Travel tangent ≈ (east 1, north 0). RED safe = RIGHT of travel = SOUTH.
        const route = ewRoute(-27.3, 153.095, 153.105, 25);
        const lon0 = 153.1;
        const redMark: LateralClampMark = { lat: -27.299, lon: lon0, side: 'port' }; // ~111 m NORTH of the track
        // Boat is SOUTH of the mark already (track lat −27.3 < mark −27.299) ⇒ correct ⇒ no-op.
        const okOut = clamp(route, [redMark]);
        expect(okOut.movedLaterals).toBe(0);
        // Now put the RED SOUTH of the track ⇒ boat is NORTH ⇒ wrong ⇒ pushed south past it.
        const redSouth: LateralClampMark = { lat: -27.301, lon: lon0, side: 'port' };
        const wrongOut = clamp(route, [redSouth]);
        expect(wrongOut.movedLaterals).toBe(1);
        expect(latNearestLon(wrongOut.polyline, lon0)).toBeLessThan(redSouth.lat); // moved SOUTH (more-negative lat)
    });
});
