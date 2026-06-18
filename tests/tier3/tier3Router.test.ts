/**
 * tier3Router (PHASE 2) — docs/THREE_TIER_ROUTING.md §4.
 * Proves the contract adapter UN-STEPS a tier-3 span: a stepped A* zigzag
 * through a marked channel comes out as a smooth, frozen Leg; a planted
 * double-back is removed; degenerate spans refuse; endpoints are pinned to
 * the span's BoundaryNodes by construction.
 */
import { describe, it, expect } from 'vitest';
import { routeTier3, type Tier3Context } from '../../services/tier3/tier3Router';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import type { LateralMark } from '../../services/fairlead';
import { isRefusal, type BoundaryNode, type LatLon } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';
import { auditStepping } from '../helpers/routeScorecard';

// ── Synthetic N-S channel geometry (~1 km, all 10 m deep) ──
const LAT_S = -27.29;
const LAT_N = -27.281;
const LON0 = 153.2;
const M_PER_LAT = 110_540;
const mPerLon = 111_320 * Math.cos((((LAT_S + LAT_N) / 2) * Math.PI) / 180);
const dLonM = (m: number): number => m / mPerLon; // metres → lon degrees
const dLatM = (m: number): number => m / M_PER_LAT;

function makeGrid(): NavGrid {
    const minLat = LAT_S - 0.002;
    const minLon = LON0 - 0.003;
    const dLat = 50 / M_PER_LAT;
    const dLon = 50 / mPerLon;
    const width = Math.ceil((LON0 + 0.003 - minLon) / dLon) + 1;
    const height = Math.ceil((LAT_N + 0.002 - minLat) / dLat) + 1;
    return {
        width,
        height,
        minLon,
        minLat,
        dLon,
        dLat,
        cells: new Float32Array(width * height).fill(10), // all deep
        preferred: new Uint8Array(width * height),
    };
}

/** A marked channel: port (west) + stbd (east) marks flanking the centreline. */
function channelMarks(): LateralMark[] {
    const marks: LateralMark[] = [];
    for (let s = 1; s <= 8; s++) {
        const lat = LAT_S + ((s - 0.5) / 8) * (LAT_N - LAT_S);
        marks.push({ lat, lon: LON0 - dLonM(30), side: 'port', key: 'TC', seq: s, name: `TC${s}` });
        marks.push({ lat, lon: LON0 + dLonM(30), side: 'stbd', key: 'TC', seq: s, name: `TC${s}` });
    }
    return marks;
}

/** The bug repro: an A* path that beads ±40 m left-right down the channel
 *  (sharp >90° kinks at every step — the bead-on-a-string signature). */
function steppedZigzag(): LatLon[] {
    const out: LatLon[] = [];
    for (let k = 0; k <= 20; k++) {
        const lat = LAT_S + (k / 20) * (LAT_N - LAT_S);
        const lon = LON0 + (k % 2 === 0 ? -1 : 1) * dLonM(40);
        out.push([lon, lat]);
    }
    return out;
}

/** legContract LatLon is a READONLY tuple; auditStepping's Polyline is mutable. */
const mut = (p: readonly LatLon[]): [number, number][] => p.map(([lon, lat]) => [lon, lat]);

const node = (at: LatLon, headingDeg: number): BoundaryNode => ({
    at,
    headingDeg,
    kind: 'channel-mouth',
    depthM: 10,
    snapped: true,
});

function spanOver(poly: LatLon[]): TierSpan {
    return {
        tier: 3,
        entry: node(poly[0], 0),
        exit: node(poly[poly.length - 1], 0),
        fromIdx: 0,
        toIdx: poly.length - 1,
        caution: false,
    };
}

describe('routeTier3', () => {
    const grid = makeGrid();

    it('un-steps a marked-channel zigzag into a smooth frozen Leg', () => {
        const zig = steppedZigzag();
        const ctx: Tier3Context = { grid, marks: channelMarks(), leadingLines: [] };
        const leg = routeTier3(spanOver(zig), zig, ctx);

        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;

        // fairlead engaged — the channel the monolith would have skipped
        expect(leg.tierId).toBe(3);
        expect(leg.provenance).toContain('fairlead');
        expect(leg.depthSource).toBe('marks-vouched');

        // de-stepped: the bead-on-a-string signature collapses. The production
        // metric is kinkCount + alternationPairs (NOT maxKinkDeg — fairlead can
        // keep a sub-120° kink in the short kept prefix before the channel entry,
        // and that's the same residual the live engine tolerates).
        const before = auditStepping(mut(zig));
        const after = auditStepping(mut(leg.polyline));
        expect(before.alternationPairs).toBeGreaterThan(8); // the input truly zig-zags
        expect(before.kinkCount).toBeGreaterThan(12);
        expect(after.kinkCount).toBeLessThan(before.kinkCount / 3); // body collapsed to a line
        expect(after.alternationPairs).toBeLessThanOrEqual(2); // no stair-step alternation left
        expect(after.maxKinkDeg).toBeLessThanOrEqual(120); // de-spike contract: no double-back

        // endpoints pinned to the span's BoundaryNodes (Gluer positional clause)
        expect(leg.polyline[0]).toBe(leg.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toBe(leg.exit.at);

        // frozen by construction
        expect(Object.isFrozen(leg)).toBe(true);
        expect(Object.isFrozen(leg.polyline)).toBe(true);
        expect(leg.cautionMask.length).toBe(leg.polyline.length);
    });

    it('removes a planted >120° double-back even with no marks (de-spike backstop)', () => {
        // straight run S→N with one true out-and-back spike injected mid-path
        const poly: LatLon[] = [];
        for (let k = 0; k <= 10; k++) poly.push([LON0, LAT_S + (k / 10) * (LAT_N - LAT_S)]);
        // spike 80 m SOUTH of (and 10 m east of) its neighbours ⇒ ~176° reversal
        poly.splice(6, 0, [LON0 + dLonM(10), poly[5][1] - dLatM(80)]);

        const ctx: Tier3Context = { grid, marks: [], leadingLines: [] };
        const leg = routeTier3(spanOver(poly), poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;

        expect(auditStepping(mut(poly)).maxKinkDeg).toBeGreaterThan(120); // input has the spike
        expect(auditStepping(mut(leg.polyline)).maxKinkDeg).toBeLessThan(120); // leg never does
        expect(leg.provenance).toBe('tier3:smooth'); // no mark-follow → de-bead + de-spike
    });

    it('de-beads a stepped no-marks span (the gate-stepping fallback)', () => {
        const zig = steppedZigzag(); // ±40 m beads, but NO marks → fairlead can't engage
        const ctx: Tier3Context = { grid, marks: [], leadingLines: [] };
        const leg = routeTier3(spanOver(zig), zig, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toBe('tier3:smooth');
        // the moving average collapses the bead-on-a-string the A* leaves
        expect(auditStepping(mut(leg.polyline)).kinkCount).toBeLessThan(auditStepping(mut(zig)).kinkCount);
        expect(auditStepping(mut(leg.polyline)).maxKinkDeg).toBeLessThan(auditStepping(mut(zig)).maxKinkDeg);
    });

    it('refuses a degenerate (single-vertex) span', () => {
        const zig = steppedZigzag();
        const span: TierSpan = { ...spanOver(zig), fromIdx: 3, toIdx: 3 };
        const ctx: Tier3Context = { grid, marks: channelMarks(), leadingLines: [] };
        const r = routeTier3(span, zig, ctx);
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.reason).toBe('disconnected-grid');
    });

    it('a clean no-marks span passes through as a charted Leg, endpoints honoured', () => {
        const poly: LatLon[] = [];
        for (let k = 0; k <= 8; k++) poly.push([LON0, LAT_S + (k / 8) * (LAT_N - LAT_S)]);
        const ctx: Tier3Context = { grid, marks: [], leadingLines: [] };
        const leg = routeTier3(spanOver(poly), poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.depthSource).toBe('charted');
        expect(leg.provenance).toBe('tier3:smooth'); // straight stays straight; de-bead is a no-op shape-wise
        expect(leg.controllingDepthM).toBe(10);
        expect(leg.polyline[0]).toBe(leg.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toBe(leg.exit.at);
    });
});
