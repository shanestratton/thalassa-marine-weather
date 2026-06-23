/**
 * Inshore bay router — tier 3 in the four-tier brief.
 * The marks-free deep-water crossing: a straight deep line where it can,
 * bending around a <5 m shoal without ever entering it, and refusing
 * honestly when the exit isn't on deep water or no deep corridor connects.
 */
import { describe, it, expect } from 'vitest';
import { routeTier2, type Tier2Context } from '../../services/tier2/tier2Router';
import { tier2NavigableDepthM } from '../../services/tier2/depthThreshold';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import { isRefusal, type BoundaryNode, type LatLon } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';

const W = 40;
const H = 30;
const RES = 100;
const MIN_LAT = -27.3;
const MIN_LON = 153.2;
const M_PER_LAT = 110_540;
const mPerLon = 111_320 * Math.cos((MIN_LAT * Math.PI) / 180);
const dLat = RES / M_PER_LAT;
const dLon = RES / mPerLon;

/** depthFn(x,y) → metres; default 10 m (deep). */
function makeGrid(depthFn: (x: number, y: number) => number = () => 10): NavGrid {
    const cells = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells[y * W + x] = depthFn(x, y);
    return {
        width: W,
        height: H,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon,
        dLat,
        cells,
        preferred: new Uint8Array(W * H),
    };
}

/** Cell (x,y) → its centre [lon,lat]. */
const at = (x: number, y: number): LatLon => [MIN_LON + (x + 0.5) * dLon, MIN_LAT + (y + 0.5) * dLat];

const node = (p: LatLon): BoundaryNode => ({ at: p, headingDeg: 90, kind: 'channel-mouth', depthM: 10, snapped: true });

const span = (entry: LatLon, exit: LatLon): TierSpan => ({
    tier: 2,
    entry: node(entry),
    exit: node(exit),
    fromIdx: 0,
    toIdx: 1,
    caution: false,
});

const ctx = (grid: NavGrid): Tier2Context => ({ grid, draftM: 2.4, tideSafetyM: 0.5 });

const lat = (p: LatLon): number => p[1];

describe('routeTier2', () => {
    it('TIER2 floor resolves to 5 m for the Tayana (draft 2.4, tide 0.5)', () => {
        expect(tier2NavigableDepthM(2.4, 0.5)).toBe(5);
    });

    it('routes a straight deep crossing as a clean caution-free Leg', () => {
        const leg = routeTier2(span(at(2, 15), at(37, 15)), ctx(makeGrid()));
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.tierId).toBe(3);
        expect(leg.provenance).toBe('tier3:deepwater');
        expect(leg.depthSource).toBe('charted');
        expect(leg.controllingDepthM).toBe(10);
        expect(leg.cautionMask.every((c) => c === false)).toBe(true);
        expect(leg.polyline.length).toBeLessThanOrEqual(4); // straight → stringpulled to a near-line
        expect(leg.polyline[0]).toBe(leg.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toBe(leg.exit.at);
        expect(Object.isFrozen(leg)).toBe(true);
    });

    it('bends around a <5 m shoal without ever entering it', () => {
        // a 2 m wall at x∈{19,20} for y≥4, leaving a southern gap (y 0-3)
        const grid = makeGrid((x, y) => ((x === 19 || x === 20) && y >= 4 ? 2 : 10));
        const leg = routeTier2(span(at(2, 15), at(37, 15)), ctx(grid));
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;

        // never enters the shoal: every charted cell crossed is ≥ the 5 m floor
        expect(leg.controllingDepthM).toBeGreaterThanOrEqual(5);
        // it genuinely detoured south through the gap (dipped below the entry row)
        const entryLat = lat(at(2, 15));
        const southmost = Math.min(...leg.polyline.map(lat));
        expect(southmost).toBeLessThan(entryLat);
        expect(leg.polyline.length).toBeGreaterThan(2); // it bent, not a straight line
    });

    it('refuses when the exit boundary is not on deep water', () => {
        // a shallow SE corner (x≥34 AND y≤5) — exit dropped into its far corner
        const grid = makeGrid((x, y) => (x >= 34 && y <= 5 ? 2 : 10));
        const r = routeTier2(span(at(2, 15), at(38, 1)), ctx(grid));
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.reason).toBe('exit-not-deepwater');
    });

    it('refuses when no deep corridor connects entry to exit', () => {
        // a full 2 m wall at x=20 splits the bay into two disconnected deep pools
        const grid = makeGrid((x) => (x === 20 ? 2 : 10));
        const r = routeTier2(span(at(2, 15), at(37, 15)), ctx(grid));
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.reason).toBe('no-deepwater-corridor');
    });
});
