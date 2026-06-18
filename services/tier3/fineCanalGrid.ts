/**
 * fineCanalGrid — Tier-3 fine-resolution canal/marina leg (THREE_TIER §canal).
 *
 * The corner-clip cure. At the shared 50 m engine grid a canal is ~1 cell wide,
 * so A* takes a diagonal hop whose straight segment nicks the corner of the land
 * cell between two water cells — the route visibly clips the bank on a canal
 * bend. This module routes that one span on a SEPARATE fine grid (built by the
 * engine over a tight crop, ~12 m/cell) using the parity-proven marinaCenterline
 * solver, whose string-pulled waypoints ride the eroded keel-safe graph and so
 * are corner-clip-free BY CONSTRUCTION.
 *
 * Pure + self-contained: depends only on marinaCenterline (the parity-green
 * pipeline) and the NavGrid TYPE — no engine import cycle. The engine injects an
 * already-built fine NavGrid; this module never builds one itself, so it stays
 * trivially offline-testable against a synthetic grid.
 *
 * Connectivity safety: routeMarina returns null when start/end fall in different
 * keel-margin basins (it keeps ALL eroded components, never the largest) — so an
 * over-eroded narrow canal yields null, NOT a fabricated land-crossing snap. The
 * caller falls back to the existing de-spiked A* slice on null, so the fine grid
 * can ONLY improve a canal leg, never disconnect the route.
 *
 * Coordinate convention: the contract LatLon is the tuple [lon, lat]
 * (legContract.LatLon); marinaCenterline speaks {x,y} cells. Converted at the
 * boundary against the fine grid's own origin/cell-size, never mixed.
 */

import type { NavGrid } from '../inshoreRouterEngine';
import { routeMarina, type Cell, type MarinaRouteParams } from '../marinaCenterline';
import type { LatLon } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';

/** Metres per degree latitude — matches tier3Router's M_PER_LAT. Used only to
 *  derive an approximate cell-resolution for the keel margin (rounded). */
const M_PER_DEG_LAT = 110_540;

/** Keel-clearance margin in metres — mirrors the engine's KEEL_M so the fine
 *  pass erodes the same physical safety wall the coarse marina pass does. */
const KEEL_M = 5;

/** Keel margin in fine cells for a given cell resolution (≥1). At 12 m/cell this
 *  is 1 (a 12 m wall); see the open-question note on richer fine-res keels. */
const keelCellsFor = (resolutionM: number): number => Math.max(1, Math.round(KEEL_M / Math.max(1, resolutionM)));

/** Approximate metres-per-cell of a grid, from its latitude cell size. */
const gridResM = (grid: NavGrid): number => grid.dLat * M_PER_DEG_LAT;

/** [lon,lat] → integer cell on `grid`, or null if outside. Floor (cell index),
 *  matching the engine/tier3 convention. */
function toCell(grid: NavGrid, lon: number, lat: number): Cell | null {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
    return { x, y };
}

/** Cell CENTRE → [lon,lat]. The +0.5 places the point mid-cell so the rendered
 *  line rides the channel middle, not a cell corner. */
function cellCentreLatLon(grid: NavGrid, c: Cell): LatLon {
    return [grid.minLon + (c.x + 0.5) * grid.dLon, grid.minLat + (c.y + 0.5) * grid.dLat];
}

/**
 * Build the marina solver's depth array from a NavGrid, treating anything the
 * grid can't vouch as keel-safe water as BLOCKED. NavGrid.cells convention:
 * NaN = land, <0 = charted-shallow (caution), 0 = unknown-open, ≥0 = depth.
 * For a keel-safe canal route we want only confident navigable water, so:
 *   NaN | <0  → NaN (blocked: land or too shallow for the keel)
 *   0         → 1.0 (unknown-open: nominal 1 m, navigable but not deep)
 *   >0        → the charted depth
 * (Identical to the engine's tryMarinaCenterline depth construction.)
 */
function marinaDepthArray(grid: NavGrid): Float32Array {
    const out = new Float32Array(grid.cells.length);
    for (let i = 0; i < out.length; i++) {
        const c = grid.cells[i];
        if (Number.isNaN(c) || c < 0) out[i] = NaN;
        else if (c === 0) out[i] = 1.0;
        else out[i] = c;
    }
    return out;
}

/** Per-SEGMENT caution mask (length = polyline.length-1) sampled against the
 *  FINE grid — NOT the coarse grid, whose ~1-cell canal would mislabel these
 *  sub-50 m mid-channel cells. A segment is caution if it samples a charted-
 *  shallow (<0) or unvouched-open cell. Land (NaN) is ignored: a keel-safe
 *  marina route never crosses it, and treating it as "caution" would mis-render
 *  the (impossible) case as red rather than the route being wrong. */
function perSegmentCaution(grid: NavGrid, polyline: readonly LatLon[]): boolean[] {
    const stepM = Math.max(10, gridResM(grid) / 2);
    const mask: boolean[] = [];
    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const segM = Math.hypot(
            (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180),
            (b[1] - a[1]) * M_PER_DEG_LAT,
        );
        const steps = Math.max(1, Math.ceil(segM / stepM));
        let caution = false;
        for (let s = 0; s <= steps && !caution; s++) {
            const t = s / steps;
            const cell = toCell(grid, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            if (!cell) continue;
            const idx = cell.y * grid.width + cell.x;
            const d = grid.cells[idx];
            if (Number.isNaN(d)) continue;
            if (d < 0 || (d === 0 && grid.unvouched?.[idx] === 1)) caution = true;
        }
        mask.push(caution);
    }
    return mask;
}

export interface FineCanalLeg {
    /** The fine canal polyline as contract tuples [lon,lat], endpoints pinned
     *  to the span's boundary nodes (seam identity). */
    polyline: LatLon[];
    /** Per-segment caution against the FINE grid (length = polyline.length-1). */
    cautionMask: boolean[];
    /** Min charted depth (m) along the leg, or null if none vouched. */
    controllingDepthM: number | null;
}

/**
 * Route one Tier-3 canal span on a pre-built fine grid. Returns the corner-safe
 * fine leg, or null when the fine grid can't vouch a connected keel-safe canal
 * (caller falls back to the coarse A* slice — never a regression).
 *
 * @param fineGrid  a NavGrid the engine has already built over the span's crop
 *                  at fine resolution (~12 m). Its origin/cell-size define the
 *                  cell↔latlon mapping used here.
 * @param span      the Tier-3 span; entry.at / exit.at are the seam boundary
 *                  points the leg must start and end on exactly.
 * @param paramsOverride  optional marina-param overrides (keelCells, etc.) for
 *                  tuning; keelCells defaults to the fine grid's resolution.
 */
export function buildFineCanalLeg(
    fineGrid: NavGrid,
    span: TierSpan,
    paramsOverride?: Partial<MarinaRouteParams>,
): FineCanalLeg | null {
    const start = toCell(fineGrid, span.entry.at[0], span.entry.at[1]);
    const end = toCell(fineGrid, span.exit.at[0], span.exit.at[1]);
    if (!start || !end) return null;

    const params: MarinaRouteParams = {
        keelCells: keelCellsFor(gridResM(fineGrid)),
        depthWeight: 15.0,
        canalHalfWidthCells: 12,
        bias: 5.0,
        ...paramsOverride,
    };

    const result = routeMarina(
        marinaDepthArray(fineGrid),
        { width: fineGrid.width, height: fineGrid.height },
        start,
        end,
        params,
    );
    if (!result || result.waypoints.length < 2) return null;

    // string-pulled waypoints ride the eroded keel-safe graph → corner-clip-free.
    const polyline: LatLon[] = result.waypoints.map((c) => cellCentreLatLon(fineGrid, c));
    // Pin endpoints to the exact seam nodes so the Gluer's identity check holds
    // (the fine interior lives on cell centres; the seams must match the coarse
    // boundary tuples byte-for-byte).
    polyline[0] = span.entry.at;
    polyline[polyline.length - 1] = span.exit.at;

    const cautionMask = perSegmentCaution(fineGrid, polyline);

    // Controlling (min) charted depth along the leg, from the fine grid.
    let controlling = Infinity;
    for (const [lon, lat] of polyline) {
        const cell = toCell(fineGrid, lon, lat);
        if (!cell) continue;
        const d = fineGrid.cells[cell.y * fineGrid.width + cell.x];
        if (!Number.isNaN(d) && d >= 0) controlling = Math.min(controlling, d);
    }

    return {
        polyline,
        cautionMask,
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
    };
}

/**
 * Narrowness probe (runs on the COARSE grid): is the corridor along this span
 * narrow enough to be a canal/marina worth a fine grid? Samples each span
 * segment, measures navigable width perpendicular to the local heading on the
 * coarse grid, and returns true when the MEDIAN width is ≤ maxCells navigable
 * cells — i.e. a true canal, not a wide bay channel (where the fine pass is
 * unnecessary cost and the coarse A* already renders clean).
 *
 * Default maxCells = 2.5 ⇒ a ≤2-cell corridor (≤~100 m at 50 m) is "canal".
 */
export function isCanalNarrow(
    coarseGrid: NavGrid,
    fullPolyline: readonly LatLon[],
    span: TierSpan,
    maxCells = 2.5,
): boolean {
    const navigable = (x: number, y: number): boolean =>
        x >= 0 &&
        y >= 0 &&
        x < coarseGrid.width &&
        y < coarseGrid.height &&
        !Number.isNaN(coarseGrid.cells[y * coarseGrid.width + x]);

    const PROBE = 6; // cells to step outward each side before giving up
    const widths: number[] = [];
    for (let i = span.fromIdx; i < span.toIdx && i + 1 < fullPolyline.length; i++) {
        const a = fullPolyline[i];
        const b = fullPolyline[i + 1];
        // heading in cell space
        const hx = (b[0] - a[0]) / coarseGrid.dLon;
        const hy = (b[1] - a[1]) / coarseGrid.dLat;
        const len = Math.hypot(hx, hy) || 1;
        // perpendicular unit (cell space)
        const px = -hy / len;
        const py = hx / len;
        // segment midpoint → its containing cell (FLOOR, not round: a cell
        // centre sits at +0.5, and round-half-up would land one cell over).
        const bx = Math.floor(((a[0] + b[0]) / 2 - coarseGrid.minLon) / coarseGrid.dLon);
        const by = Math.floor(((a[1] + b[1]) / 2 - coarseGrid.minLat) / coarseGrid.dLat);
        let w = navigable(bx, by) ? 1 : 0; // the midpoint cell itself
        for (let s = 1; s <= PROBE; s++) {
            if (navigable(Math.round(bx + px * s), Math.round(by + py * s))) w++;
            else break;
        }
        for (let s = 1; s <= PROBE; s++) {
            if (navigable(Math.round(bx - px * s), Math.round(by - py * s))) w++;
            else break;
        }
        widths.push(w);
    }
    if (widths.length === 0) return false;
    widths.sort((u, v) => u - v);
    const median = widths[Math.floor(widths.length / 2)];
    return median <= maxCells;
}
