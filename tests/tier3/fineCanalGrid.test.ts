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
import { buildFineCanalLeg, isCanalNarrow } from '../../services/tier3/fineCanalGrid';

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
