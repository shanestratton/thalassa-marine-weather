/**
 * tier3Router (PHASE 2) — docs/THREE_TIER_ROUTING.md §4.
 * Proves the contract adapter UN-STEPS a tier-3 span: a stepped A* zigzag
 * through a marked channel comes out as a smooth, frozen Leg; a planted
 * double-back is removed; degenerate spans refuse; endpoints are pinned to
 * the span's BoundaryNodes by construction.
 */
import { describe, it, expect } from 'vitest';
import { routeTier3, followChannelGates, type Tier3Context } from '../../services/tier3/tier3Router';
import type { BuildFineGrid } from '../../services/tier3/fineCanalGrid';
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
        expect(leg.provenance).toBe('tier3:astar'); // no refiner engaged, just de-spiked
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
        expect(leg.provenance).toBe('tier3:astar');
        expect(leg.controllingDepthM).toBe(10);
        expect(leg.polyline[0]).toBe(leg.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toBe(leg.exit.at);
    });

    it('followChannelGates threads a Newport-convention channel (port even / stbd odd) and de-steps it', () => {
        // 4 gates down the channel; numbered sequentially DOWN the fairway with
        // alternating sides (stbd odd, port even) — the convention that defeats
        // fairlead's seq-paired centreline. The nearest-gate follower doesn't
        // care about the numbers.
        const marks: LateralMark[] = [];
        for (let g = 0; g < 4; g++) {
            const lat = LAT_S + (g / 3) * (LAT_N - LAT_S);
            marks.push({ lat, lon: LON0 - dLonM(30), side: 'stbd', key: 'NUM', seq: 2 * g + 1, name: `${2 * g + 1}` });
            marks.push({ lat, lon: LON0 + dLonM(30), side: 'port', key: 'NUM', seq: 2 * g + 2, name: `${2 * g + 2}` });
        }
        const zig = steppedZigzag(); // a stepped A* run down the channel centre
        const centre = followChannelGates(
            zig.map(([lon, lat]) => ({ lat, lon })),
            marks,
            grid,
        );
        expect(centre).not.toBeNull();
        if (!centre) return;
        // every gate midpoint sits on the channel centreline (lon ≈ LON0)
        for (const p of centre) expect(Math.abs(p.lon - LON0)).toBeLessThan(dLonM(45));
        // and the followed line is far smoother than the stepped input
        const tuples = centre.map((p) => [p.lon, p.lat] as [number, number]);
        expect(auditStepping(tuples).maxKinkDeg).toBeLessThan(auditStepping(mut(zig)).maxKinkDeg);
        expect(auditStepping(tuples).kinkCount).toBeLessThanOrEqual(auditStepping(mut(zig)).kinkCount);
    });

    it('followChannelGates declines (null) when there is no buoyed channel near the route', () => {
        const poly: LatLon[] = [];
        for (let k = 0; k <= 8; k++) poly.push([LON0, LAT_S + (k / 8) * (LAT_N - LAT_S)]);
        const centre = followChannelGates(
            poly.map(([lon, lat]) => ({ lat, lon })),
            [],
            grid,
        );
        expect(centre).toBeNull();
    });
});

describe('routeTier3 — fine canal fallback (Phase 2 branch wiring)', () => {
    // A coarse grid with a single navigable column (a 1-cell canal); everything
    // else is land. The narrowness probe should flag this; a wide grid must not.
    function narrowCoarseGrid(): NavGrid {
        const minLat = LAT_S - 0.002;
        const minLon = LON0 - 0.003;
        const dLat = 50 / M_PER_LAT;
        const dLon = 50 / mPerLon;
        const width = Math.ceil((LON0 + 0.003 - minLon) / dLon) + 1;
        const height = Math.ceil((LAT_N + 0.002 - minLat) / dLat) + 1;
        const cells = new Float32Array(width * height).fill(NaN);
        const cx = Math.floor((LON0 - minLon) / dLon);
        for (let y = 0; y < height; y++) cells[y * width + cx] = 10; // 1-cell channel
        return { width, height, minLon, minLat, dLon, dLat, cells, preferred: new Uint8Array(width * height) };
    }

    /** A no-marks span straight down the canal column. */
    function canalSpan(): { span: TierSpan; poly: LatLon[] } {
        const poly: LatLon[] = [];
        for (let k = 0; k <= 8; k++) poly.push([LON0, LAT_S + (k / 8) * (LAT_N - LAT_S)]);
        return { span: spanOver(poly), poly };
    }

    /** Build-a-fine-grid stub: an all-deep rectangle over the bbox at resM — so
     *  routeMarina trivially connects entry→exit (the corner-clip cure path). */
    const deepFineGrid: BuildFineGrid = (bbox, resM) => {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const dLat = resM / M_PER_LAT;
        const dLon = resM / mPerLon;
        const width = Math.ceil((maxLon - minLon) / dLon) + 1;
        const height = Math.ceil((maxLat - minLat) / dLat) + 1;
        return {
            width,
            height,
            minLon,
            minLat,
            dLon,
            dLat,
            cells: new Float32Array(width * height).fill(10),
            preferred: new Uint8Array(width * height),
        };
    };

    it('flips provenance astar→finegrid when a narrow canal + buildFineGrid are present', () => {
        const { span, poly } = canalSpan();
        const ctx: Tier3Context = {
            grid: narrowCoarseGrid(),
            marks: [],
            leadingLines: [],
            buildFineGrid: deepFineGrid,
        };
        const leg = routeTier3(span, poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toMatch(/^tier3:finegrid:k\d+$/); // finegrid:k<keel that connected>
        expect(leg.depthSource).toBe('marks-vouched'); // fine pass vouches the water
        // endpoints still pinned to the span's BoundaryNodes
        expect(leg.polyline[0]).toBe(leg.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toBe(leg.exit.at);
    });

    it('stays astar when buildFineGrid is absent (backward-compatible, behaviour identical)', () => {
        const { span, poly } = canalSpan();
        const ctx: Tier3Context = { grid: narrowCoarseGrid(), marks: [], leadingLines: [] };
        const leg = routeTier3(span, poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toBe('tier3:astar');
    });

    it('stays astar on a WIDE channel even with buildFineGrid (narrowness gate)', () => {
        // makeGrid() is all-deep and wide ⇒ isCanalNarrow false ⇒ fine pass skipped.
        const { span, poly } = canalSpan();
        const ctx: Tier3Context = { grid: makeGrid(), marks: [], leadingLines: [], buildFineGrid: deepFineGrid };
        const leg = routeTier3(span, poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toBe('tier3:astar(fine=notnarrow)'); // probe declined the wide channel
    });

    it('degrades to astar when the fine grid is disconnected (no fabricated route)', () => {
        const { span, poly } = canalSpan();
        // a fine grid that is ALL land ⇒ routeMarina returns null ⇒ keep A*.
        const landFineGrid: BuildFineGrid = (bbox, resM) => {
            const g = deepFineGrid(bbox, resM)!;
            g.cells.fill(NaN);
            return g;
        };
        const ctx: Tier3Context = {
            grid: narrowCoarseGrid(),
            marks: [],
            leadingLines: [],
            buildFineGrid: landFineGrid,
        };
        const leg = routeTier3(span, poly, ctx);
        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toBe('tier3:astar(fine=disconnected)'); // routeMarina null → kept A*
    });
});
