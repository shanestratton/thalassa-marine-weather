/**
 * SUB-GRID FAIRING FLOOR — the live marker-stepping field bug
 * (Newport→Pinkenba, 2026-06-16, ROUTING_COLLAB reply 30).
 *
 * Root cause (3-agent trace): the pairing emits gates as narrow as 16 m
 * (half-width 8 m). fairPath's gate-serving guard then demands a faired
 * chord pass within halfWidth × FAIRING_GATE_FRACTION (8 × 0.9 = 7.2 m)
 * of every served gate — SUB-CELL precision a 50 m grid cannot deliver.
 * So the chord that would straighten the route is rejected by a phantom
 * narrow gate and the bead-kink is pinned in place: the route steps.
 *
 * The fix: floor the per-gate tolerance at half a grid cell
 * (gridResM × 0.5 = 25 m on the 50 m routing grid). For a gate whose
 * marks fall inside ~one cell (half-width < gridResM) the grid carries
 * NO resolvable side, so demanding sub-cell siding is meaningless — the
 * honest precision is the cell itself. For a RESOLVABLE gate
 * (half-width ≥ gridResM) the tight 0.9 guard already exceeds the floor,
 * so the floor is INERT and wrong-siding stays structurally impossible
 * (the fairingSafety arithmetic proof, reply 30).
 *
 * This tests fairPath directly with a hand-built beaded chain — a flat
 * reach with a single 45° bump — because the floor changes a ~7 m
 * decision a 50 m A* grid can't cleanly express end-to-end; the unit is
 * the precise vehicle (matches the engine's aStar/chainCostM/MinHeap
 * test exports).
 */
import { describe, expect, it } from 'vitest';
import { fairPath, type FairingMidpoint, type NavGrid } from '../services/inshoreRouterEngine';

const M_PER_DEG_LAT = 111_320; // matches the engine constant
const RES_M = 50; // routing-grid cell size
const MIN_LAT = -27.25;
const MIN_LON = 153.0;
const WIDTH = 50;
const HEIGHT = 30;
const dLat = RES_M / M_PER_DEG_LAT;
// Grid mid-lat → metres-per-°lon (only affects ALONG-chord geometry; the
// gates sit on a horizontal chord so perpendicular distance is pure-lat).
const MID_LAT = MIN_LAT + (HEIGHT * dLat) / 2;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((MID_LAT * Math.PI) / 180);
const dLon = RES_M / M_PER_DEG_LON;

/** All-navigable 50 m grid (depth 10 m everywhere, no preference). */
function makeGrid(): NavGrid {
    const cells = new Float32Array(WIDTH * HEIGHT);
    cells.fill(10);
    return {
        width: WIDTH,
        height: HEIGHT,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon,
        dLat,
        cells,
        preferred: new Uint8Array(WIDTH * HEIGHT),
    };
}

// The beaded chain: a flat reach at cell-row y=10 with a single 45° bump
// up to (18,18) and back. The straight chord (2,10)→(46,10) is clear,
// shorter, and SHOULD collapse the bump — unless a gate pins it.
const CHAIN = [
    { x: 2, y: 10 },
    { x: 10, y: 10 },
    { x: 18, y: 18 },
    { x: 26, y: 10 },
    { x: 46, y: 10 },
];

const chordLat = MIN_LAT + (10 + 0.5) * dLat; // lat of the flat reach

/** A gate sitting ON the rising ramp (so the beaded subpath serves it)
 *  at `heightM` above the flat chord (so the straight chord is exactly
 *  `heightM` away from it). On a 45° ramp lon-cell == lat-cell, so a
 *  single height fixes both coordinates. */
function gateOnRamp(heightM: number, halfWidthM: number): FairingMidpoint {
    const latCellOffset = heightM / RES_M; // cells above row 10
    return {
        lat: chordLat + heightM / M_PER_DEG_LAT,
        lon: MIN_LON + (10 + latCellOffset + 0.5) * dLon,
        halfWidthM,
    };
}

const noExcluded = () => false;

/** Min distance (m) from a gate to the faired polyline, for the
 *  seamanship bound. */
function minDistToOutputM(g: FairingMidpoint, out: { x: number; y: number }[]): number {
    const toLL = (c: { x: number; y: number }): [number, number] => [
        MIN_LON + (c.x + 0.5) * dLon,
        MIN_LAT + (c.y + 0.5) * dLat,
    ];
    const seg = (a: [number, number], b: [number, number]): number => {
        const ax = (a[0] - g.lon) * M_PER_DEG_LON;
        const ay = (a[1] - g.lat) * M_PER_DEG_LAT;
        const bx = (b[0] - g.lon) * M_PER_DEG_LON;
        const by = (b[1] - g.lat) * M_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        return Math.hypot(ax + dx * t, ay + dy * t);
    };
    let best = Infinity;
    for (let i = 1; i < out.length; i++) {
        const d = seg(toLL(out[i - 1]), toLL(out[i]));
        if (d < best) best = d;
    }
    return best;
}

describe('fairPath — sub-grid gate tolerance floor', () => {
    it('control: with no gates the bump collapses to a straight chord', () => {
        const out = fairPath(makeGrid(), CHAIN, [], noExcluded);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual(CHAIN[0]);
        expect(out[out.length - 1]).toEqual(CHAIN[CHAIN.length - 1]);
    });

    it('a 16 m sub-grid gate (h=8 m) no longer pins the bead-kink — the route fairs straight', () => {
        // The field minimum: a 16 m "gate" sitting 15 m off the flat
        // chord. Pre-fix the 7.2 m guard rejects the straightening chord
        // (15 > 7.2) and the kink is pinned → 4 waypoints. Post-fix the
        // 25 m floor admits it (15 < 25) → collapses to 2.
        const gate = gateOnRamp(15, 8);
        const out = fairPath(makeGrid(), CHAIN, [gate], noExcluded);
        expect(out).toHaveLength(2);
        // Honest seamanship for a sub-grid gate: the route stays within
        // the grid's resolvable precision (½ cell) of the gate — siding
        // tighter than that is noise on a 50 m grid.
        expect(minDistToOutputM(gate, out)).toBeLessThanOrEqual(RES_M * 0.5 + 1e-6);
    });

    it('a RESOLVABLE gate (h=100 m) genuinely off the chord still blocks the collapse — floor is inert', () => {
        // Half-width 100 m ≥ cell, sitting 95 m off the chord. Its tight
        // guard (100 × 0.9 = 90 m) already exceeds the 25 m floor, so the
        // floor never loosens it: 95 > 90 → the chord is refused and the
        // route keeps the bend (no wrong-siding). Identical before/after
        // the floor — the regression guard for resolvable gates.
        const gate = gateOnRamp(95, 100);
        const out = fairPath(makeGrid(), CHAIN, [gate], noExcluded);
        expect(out.length).toBeGreaterThan(2);
    });
});
