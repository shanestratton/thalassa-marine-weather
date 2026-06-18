/**
 * Fine-res canal Tier-3 leg — the corner-clip cure, proven OFFLINE on a
 * synthetic L-bend canal grid (no ENC/MarinerEE dependency).
 *
 * The bug: at the coarse 50 m grid a canal is ~1 cell wide, so A* takes a
 * diagonal hop across an inside bend whose straight chord nicks the land cell
 * between two water cells — the route clips the bank. The fix routes the span on
 * a separate FINE grid with marinaCenterline.routeMarina, whose string-pulled
 * waypoints ride the eroded keel-safe graph and so never cross land.
 *
 * The fixture is a 90°-bend canal ~9 cells wide at ~12 m/cell: deep (10 m) along
 * an east arm and a north arm, land (NaN) everywhere else — including the inside
 * corner the naive chord cuts across. The test FIRST proves the straight chord
 * clips land (so the fixture genuinely exercises a corner-cut), THEN proves the
 * fine leg crosses zero land.
 */
import { describe, expect, it } from 'vitest';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import type { BoundaryNode, LatLon } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';
import { buildFineCanalLeg, isCanalNarrow, spanIsInjectedCanal } from '../../services/tier3/fineCanalGrid';

// ── Synthetic fine grid ────────────────────────────────────────────────
const W = 60;
const H = 60;
const MIN_LON = 153.0;
const MIN_LAT = -27.5;
const RES_M = 12;
const D_LAT = RES_M / 110_540;
const D_LON = RES_M / (111_320 * Math.cos((MIN_LAT * Math.PI) / 180));

/** Cell CENTRE → [lon,lat] (mirrors the module's convention). */
const centre = (x: number, y: number): LatLon => [MIN_LON + (x + 0.5) * D_LON, MIN_LAT + (y + 0.5) * D_LAT];

/** Build an L-canal NavGrid. `gapRowY`, if set, blanks the north arm at that row
 *  (a disconnected-canal variant). Deep water = 10 m, land = NaN. */
function makeLCanalGrid(gapRowY?: number): NavGrid {
    const cells = new Float32Array(W * H).fill(NaN);
    const set = (x: number, y: number, v: number): void => {
        if (x >= 0 && y >= 0 && x < W && y < H) cells[y * W + x] = v;
    };
    // East arm: x 5..41, y 26..34 (9 wide).
    for (let y = 26; y <= 34; y++) for (let x = 5; x <= 41; x++) set(x, y, 10);
    // North arm: x 32..40, y 5..34 (9 wide). Overlaps the east arm at the corner.
    for (let y = 5; y <= 34; y++) for (let x = 32; x <= 40; x++) set(x, y, 10);
    // Optional gap across the north arm → start/end land in different basins.
    if (gapRowY !== undefined) for (let x = 32; x <= 40; x++) set(x, gapRowY, NaN);
    return {
        width: W,
        height: H,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon: D_LON,
        dLat: D_LAT,
        cells,
        preferred: new Uint8Array(W * H),
    };
}

const node = (at: LatLon, kind: BoundaryNode['kind']): BoundaryNode => ({
    at,
    headingDeg: 0,
    kind,
    depthM: 10,
    snapped: true,
});

/** Span from the west end of the east arm to the north end of the north arm —
 *  the straight chord between them cuts the inside corner (land). */
function lCanalSpan(): TierSpan {
    const entryAt = centre(10, 30); // east arm, central
    const exitAt = centre(36, 8); // north arm, central
    return {
        tier: 3,
        entry: node(entryAt, 'channel-mouth'),
        exit: node(exitAt, 'dest'),
        fromIdx: 0,
        toIdx: 1,
        caution: false,
    };
}

/** Densely sample the straight segment a→b on the grid; true if any sample lands
 *  on a NaN (land) cell. The corner-cut oracle. */
function chordHitsLand(grid: NavGrid, a: LatLon, b: LatLon): boolean {
    const steps = 200;
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lon = a[0] + (b[0] - a[0]) * t;
        const lat = a[1] + (b[1] - a[1]) * t;
        const x = Math.floor((lon - grid.minLon) / grid.dLon);
        const y = Math.floor((lat - grid.minLat) / grid.dLat);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        if (Number.isNaN(grid.cells[y * grid.width + x])) return true;
    }
    return false;
}

describe('buildFineCanalLeg — corner-clip cure on a synthetic fine grid', () => {
    it('SANITY: the naive straight chord across the bend clips land', () => {
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        // If this fails the fixture is wrong — there is no corner-cut to cure.
        expect(chordHitsLand(grid, span.entry.at, span.exit.at)).toBe(true);
    });

    it('produces a leg whose every segment stays off land (no corner-clip)', () => {
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        const leg = buildFineCanalLeg(grid, span);
        expect(leg).not.toBeNull();
        const poly = leg!.polyline;
        expect(poly.length).toBeGreaterThanOrEqual(2);
        // PRIMARY assertion: no output segment crosses a land cell.
        for (let i = 0; i < poly.length - 1; i++) {
            expect(chordHitsLand(grid, poly[i], poly[i + 1])).toBe(false);
        }
    });

    it('pins endpoints to the span boundary nodes (seam identity)', () => {
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        const leg = buildFineCanalLeg(grid, span)!;
        expect(leg.polyline[0]).toEqual(span.entry.at);
        expect(leg.polyline[leg.polyline.length - 1]).toEqual(span.exit.at);
    });

    it('returns a per-segment caution mask of length polyline.length-1, all clean (deep)', () => {
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        const leg = buildFineCanalLeg(grid, span)!;
        expect(leg.cautionMask.length).toBe(leg.polyline.length - 1);
        expect(leg.cautionMask.every((c) => c === false)).toBe(true);
        expect(leg.controllingDepthM).toBe(10);
    });

    it('falls back to null when the canal is disconnected (no fabricated crossing)', () => {
        const grid = makeLCanalGrid(18); // blank the north arm at row 18
        const span = lCanalSpan();
        expect(buildFineCanalLeg(grid, span)).toBeNull();
    });

    it('the bend actually turns — the leg is not a single straight segment', () => {
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        const leg = buildFineCanalLeg(grid, span)!;
        // A clean L-route must have at least one interior bend vertex.
        expect(leg.polyline.length).toBeGreaterThanOrEqual(3);
    });

    it('default keel (12 m → 1) connects the wide L-canal and reports keelCellsUsed=1', () => {
        const leg = buildFineCanalLeg(makeLCanalGrid(), lCanalSpan())!;
        expect(leg.keelCellsUsed).toBe(1);
    });

    it('adapts the keel DOWN (never below 1) to keep a narrow canal connected', () => {
        // A 3-cell-wide straight canal: clearance is 1 at the banks, 2 mid-channel.
        // Force keelCells=3 (erodes it to nothing → disconnected); the adaptive
        // keel must relax to 2 (the mid row survives) and connect — never to 0
        // (keel 0 keeps clearance≥0 cells, i.e. land, and would cross the bank).
        const cells = new Float32Array(W * H).fill(NaN);
        for (let y = 28; y <= 30; y++) for (let x = 5; x <= 50; x++) cells[y * W + x] = 10;
        const grid: NavGrid = {
            width: W,
            height: H,
            minLon: MIN_LON,
            minLat: MIN_LAT,
            dLon: D_LON,
            dLat: D_LAT,
            cells,
            preferred: new Uint8Array(W * H),
        };
        const span: TierSpan = {
            tier: 3,
            entry: node(centre(8, 29), 'channel-mouth'),
            exit: node(centre(48, 29), 'dest'),
            fromIdx: 0,
            toIdx: 1,
            caution: false,
        };
        const leg = buildFineCanalLeg(grid, span, { keelCells: 3 });
        expect(leg).not.toBeNull();
        expect(leg!.keelCellsUsed).toBe(2); // relaxed 3→2, NOT 0
        expect(leg!.keelCellsUsed).toBeGreaterThanOrEqual(1);
        for (let i = 0; i < leg!.polyline.length - 1; i++) {
            expect(chordHitsLand(grid, leg!.polyline[i], leg!.polyline[i + 1])).toBe(false);
        }
    });

    it('bridges the coarse corridor to reconnect a fine-grid barrier (the disc:2comp cure)', () => {
        // Two water basins split by a 2-cell land wall — exactly the field case:
        // entry and exit land in different fine components (disc:2comp). The coarse
        // A* corridor crossed the wall (proving it navigable), so bridging it must
        // reconnect them.
        const cells = new Float32Array(W * H).fill(NaN);
        for (let y = 26; y <= 34; y++) {
            for (let x = 5; x <= 22; x++) cells[y * W + x] = 10; // left basin
            for (let x = 38; x <= 55; x++) cells[y * W + x] = 10; // right basin
        }
        // x 23..37 is a land wall.
        const grid: NavGrid = {
            width: W,
            height: H,
            minLon: MIN_LON,
            minLat: MIN_LAT,
            dLon: D_LON,
            dLat: D_LAT,
            cells,
            preferred: new Uint8Array(W * H),
        };
        const span: TierSpan = {
            tier: 3,
            entry: node(centre(10, 30), 'channel-mouth'),
            exit: node(centre(50, 30), 'dest'),
            fromIdx: 0,
            toIdx: 2,
            caution: false,
        };
        const corridor: LatLon[] = [centre(10, 30), centre(30, 30), centre(50, 30)]; // crosses the wall

        expect(buildFineCanalLeg(grid, span)).toBeNull(); // no corridor → 2 components → null
        const bridged = buildFineCanalLeg(grid, span, undefined, corridor);
        expect(bridged).not.toBeNull(); // corridor bridge → connected
        expect(bridged!.polyline[0]).toEqual(span.entry.at);
        expect(bridged!.polyline[bridged!.polyline.length - 1]).toEqual(span.exit.at);
    });

    it('bridging the CLIPPING corridor does NOT re-introduce the clip (real water wins)', () => {
        // The corridor handed in is the straight clipping chord across the inside
        // bend. Bridging it makes that chord navigable — but the real 9-cell canal
        // is deeper + wider (far higher cost-field value), so the solver rides the
        // canal and the output crosses ZERO land. This is the safety guarantee:
        // the bridge only carries the route across genuine gaps, never the clip.
        const grid = makeLCanalGrid();
        const span = lCanalSpan();
        const clippingCorridor: LatLon[] = [span.entry.at, span.exit.at];
        expect(chordHitsLand(grid, span.entry.at, span.exit.at)).toBe(true); // the chord clips
        const leg = buildFineCanalLeg(grid, span, undefined, clippingCorridor)!;
        for (let i = 0; i < leg.polyline.length - 1; i++) {
            expect(chordHitsLand(grid, leg.polyline[i], leg.polyline[i + 1])).toBe(false);
        }
    });

    it('bridges a DIAGONAL corridor across a 2-component gap (4-connectivity fix)', () => {
        // The Newport berth-exit bug (disc:2comp/9346/brNO): two water basins with
        // NO real connection, joined only by a DIAGONAL coarse corridor. routeMarina
        // is 4-connected, so a naive diagonal bridge leaves diagonally-adjacent cells
        // that read as a GAP → it never reconnects. The orthogonal-connector stamp
        // makes the diagonal bridge 4-connected so it does.
        const cells = new Float32Array(W * H).fill(NaN);
        for (let y = 8; y <= 16; y++) for (let x = 8; x <= 16; x++) cells[y * W + x] = 10; // basin 1 (NW)
        for (let y = 28; y <= 36; y++) for (let x = 28; x <= 36; x++) cells[y * W + x] = 10; // basin 2 (SE)
        const grid: NavGrid = {
            width: W,
            height: H,
            minLon: MIN_LON,
            minLat: MIN_LAT,
            dLon: D_LON,
            dLat: D_LAT,
            cells,
            preferred: new Uint8Array(W * H),
        };
        const span: TierSpan = {
            tier: 3,
            entry: node(centre(12, 12), 'channel-mouth'),
            exit: node(centre(32, 32), 'dest'),
            fromIdx: 0,
            toIdx: 1,
            caution: false,
        };
        const diagonalCorridor: LatLon[] = [centre(12, 12), centre(32, 32)]; // crosses the gap diagonally

        expect(buildFineCanalLeg(grid, span)).toBeNull(); // no corridor → 2 components → null
        const bridged = buildFineCanalLeg(grid, span, undefined, diagonalCorridor);
        expect(bridged).not.toBeNull(); // 4-connected diagonal bridge → reconnects
        expect(bridged!.polyline[0]).toEqual(span.entry.at);
        expect(bridged!.polyline[bridged!.polyline.length - 1]).toEqual(span.exit.at);
    });
});

// ── Narrowness probe (runs on the COARSE grid) ─────────────────────────
describe('isCanalNarrow — gate the fine pass to true canals', () => {
    /** A straight horizontal corridor `widthCells` cells wide on a coarse grid. */
    function corridorGrid(widthCells: number): { grid: NavGrid; poly: LatLon[]; span: TierSpan } {
        const w = 40;
        const h = 40;
        const dLat = 50 / 110_540;
        const dLon = 50 / (111_320 * Math.cos((MIN_LAT * Math.PI) / 180));
        const cells = new Float32Array(w * h).fill(NaN);
        const yLo = Math.floor((h - widthCells) / 2);
        for (let y = yLo; y < yLo + widthCells; y++) for (let x = 2; x < w - 2; x++) cells[y * w + x] = 10;
        const grid: NavGrid = {
            width: w,
            height: h,
            minLon: MIN_LON,
            minLat: MIN_LAT,
            dLon,
            dLat,
            cells,
            preferred: new Uint8Array(w * h),
        };
        const yMid = yLo + Math.floor(widthCells / 2);
        const at = (x: number): LatLon => [MIN_LON + (x + 0.5) * dLon, MIN_LAT + (yMid + 0.5) * dLat];
        const poly: LatLon[] = [at(4), at(12), at(20), at(28), at(34)];
        const span: TierSpan = {
            tier: 3,
            entry: node(poly[0], 'channel-mouth'),
            exit: node(poly[poly.length - 1], 'dest'),
            fromIdx: 0,
            toIdx: poly.length - 1,
            caution: false,
        };
        return { grid, poly, span };
    }

    it('flags a 1-cell canal as narrow', () => {
        const { grid, poly, span } = corridorGrid(1);
        expect(isCanalNarrow(grid, poly, span)).toBe(true);
    });

    it('flags a 2-cell canal as narrow', () => {
        const { grid, poly, span } = corridorGrid(2);
        expect(isCanalNarrow(grid, poly, span)).toBe(true);
    });

    it('does NOT flag a wide (10-cell) bay channel', () => {
        const { grid, poly, span } = corridorGrid(10);
        expect(isCanalNarrow(grid, poly, span)).toBe(false);
    });
});

describe('spanIsInjectedCanal — detect injected canal water along a span', () => {
    const w = 20;
    const h = 20;
    const dLat = 50 / 110_540;
    const dLon = 50 / (111_320 * Math.cos((MIN_LAT * Math.PI) / 180));
    const at = (x: number, y: number): LatLon => [MIN_LON + (x + 0.5) * dLon, MIN_LAT + (y + 0.5) * dLat];
    // A poly straight down column x=10, rows 2..17 (16 vertices).
    const poly: LatLon[] = [];
    for (let y = 2; y <= 17; y++) poly.push(at(10, y));
    const span: TierSpan = {
        tier: 3,
        entry: node(poly[0], 'channel-mouth'),
        exit: node(poly[poly.length - 1], 'dest'),
        fromIdx: 0,
        toIdx: poly.length - 1,
        caution: false,
    };
    const baseGrid = (): NavGrid => ({
        width: w,
        height: h,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon,
        dLat,
        cells: new Float32Array(w * h).fill(10),
        preferred: new Uint8Array(w * h),
    });

    it('true when the span runs through majority injected water', () => {
        const grid = baseGrid();
        grid.injectedCanal = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) grid.injectedCanal[y * w + 10] = 1; // whole column injected
        expect(spanIsInjectedCanal(grid, poly, span)).toBe(true);
    });

    it('false when under half the span is injected', () => {
        const grid = baseGrid();
        grid.injectedCanal = new Uint8Array(w * h);
        for (let y = 2; y <= 5; y++) grid.injectedCanal[y * w + 10] = 1; // only 4 of 16 vertices
        expect(spanIsInjectedCanal(grid, poly, span)).toBe(false);
    });

    it('false when the grid omits the injectedCanal mask (back-compat default)', () => {
        expect(spanIsInjectedCanal(baseGrid(), poly, span)).toBe(false);
    });
});
