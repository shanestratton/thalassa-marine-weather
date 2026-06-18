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
import {
    euclideanDistanceTransform,
    routeMarina,
    snapToMask,
    stringPull,
    type Cell,
    type MarinaRouteParams,
    type MarinaRouteResult,
} from '../marinaCenterline';
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
    /** The keel-erosion margin (cells) that actually produced a connected route.
     *  Lower than requested ⇒ the canal was narrow and the keel was relaxed to
     *  keep it connected. Surfaced in provenance for on-device tuning. */
    keelCellsUsed: number;
}

/** Nominal depth (m) stamped into a bridged corridor cell. Deliberately tiny so
 *  the marina cost field always prefers REAL charted water (deeper + wider) over
 *  the bridge — the bridge is used ONLY where real water is absent. */
const BRIDGE_DEPTH_M = 0.5;

/**
 * Bridge the coarse A* corridor into the fine depth array. The coarse route is a
 * proven-navigable path (the coarse grid + canal carve vouched it); the fine
 * grid can disagree where finer LNDARE rasterisation resolves a thin wall/sliver
 * the 50 m carve bridged — splitting the canal into two components so routeMarina
 * returns null (disc:2comp). Stamping the corridor as low-preference navigable
 * water restores connectivity WITHOUT re-introducing the clip: where real canal
 * water exists the solver rides it (far higher cost-field value), so the bridge
 * only carries the route across genuine fine-grid gaps. Mutates `depth` in place,
 * only ever turning land (NaN) into BRIDGE_DEPTH_M — never overwriting real depth.
 */
function bridgeCorridor(grid: NavGrid, depth: Float32Array, corridor: readonly LatLon[]): void {
    if (corridor.length < 2) return;
    const stepM = Math.max(3, gridResM(grid) / 3);
    for (let i = 0; i < corridor.length - 1; i++) {
        const a = corridor[i];
        const b = corridor[i + 1];
        const segM = Math.hypot(
            (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180),
            (b[1] - a[1]) * M_PER_DEG_LAT,
        );
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const cell = toCell(grid, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            if (!cell) continue;
            const idx = cell.y * grid.width + cell.x;
            if (Number.isNaN(depth[idx])) depth[idx] = BRIDGE_DEPTH_M;
        }
    }
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
 * @param paramsOverride  optional marina-param overrides (keelCells, etc.).
 * @param corridor  the coarse A* span slice [lon,lat]; bridged into the fine grid
 *                  as a low-preference navigable backbone to guarantee
 *                  connectivity (see bridgeCorridor). Omit to disable bridging.
 */
export function buildFineCanalLeg(
    fineGrid: NavGrid,
    span: TierSpan,
    paramsOverride?: Partial<MarinaRouteParams>,
    corridor?: readonly LatLon[],
): FineCanalLeg | null {
    const start = toCell(fineGrid, span.entry.at[0], span.entry.at[1]);
    const end = toCell(fineGrid, span.exit.at[0], span.exit.at[1]);
    if (!start || !end) return null;

    const baseParams: MarinaRouteParams = {
        keelCells: keelCellsFor(gridResM(fineGrid)),
        depthWeight: 15.0,
        canalHalfWidthCells: 12,
        bias: 5.0,
        ...paramsOverride,
    };

    // Adaptive keel, floored at 1. At a fine resolution finer than 12 m the keel
    // can be 2–3 cells, where a genuinely narrow canal erodes to disconnection
    // (routeMarina null) and the leg falls back to the clipping coarse A* slice.
    // Try the requested keel first (safest margin), then relax the erosion one
    // cell at a time — but NEVER below 1: keel 0 keeps cells with clearance ≥ 0,
    // which includes land (clearance 0), so it would route across the bank. At
    // 12 m keelCells is already 1, so this loop is a single safe pass there.
    const depth = marinaDepthArray(fineGrid);
    // Bridge the proven-navigable coarse corridor so a fine-grid barrier (a thin
    // wall the 50 m carve averaged away) can't split the canal into two
    // components. Low-preference, so the route still rides real water everywhere
    // it exists; the bridge only spans genuine fine-grid gaps.
    if (corridor) bridgeCorridor(fineGrid, depth, corridor);
    const shape = { width: fineGrid.width, height: fineGrid.height };
    let result: MarinaRouteResult | null = null;
    let keelUsed = baseParams.keelCells;
    for (let k = baseParams.keelCells; k >= 1; k--) {
        const r = routeMarina(depth, shape, start, end, { ...baseParams, keelCells: k });
        if (r && r.waypoints.length >= 2) {
            result = r;
            keelUsed = k;
            break;
        }
    }
    if (!result) return null;

    // Simplify the RAW Dijkstra path (result.cells) ourselves, against REAL water
    // ONLY — not routeMarina's own waypoints, whose string-pull tests LOS against
    // the BRIDGED graph and would happily cut a bend's inside corner through the
    // bridged chord (re-introducing the clip). Excluding bridge cells from the
    // simplifier's clear() test means a corner can only ever be cut across genuine
    // navigable water; the route follows the Dijkstra path one cell at a time
    // through any bridged gap, never shortcutting across it.
    const realWater = new Uint8Array(fineGrid.cells.length);
    for (let i = 0; i < realWater.length; i++) {
        const c = fineGrid.cells[i];
        realWater[i] = Number.isNaN(c) || c < 0 ? 0 : 1;
    }
    const waypoints = stringPull(result.cells, realWater, shape);
    const polyline: LatLon[] = waypoints.map((c) => cellCentreLatLon(fineGrid, c));
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
        keelCellsUsed: keelUsed,
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

/** Fine-grid cell resolution for the canal pass, in metres. Shane-tunable
 *  (10–15 m); 12 m keeps a tight crop bounded (~28k cells at 2 km²) and
 *  resolves a ~1-cell-at-50 m canal into ~8 cells wide. */
export const FINE_CANAL_RES_M = 12;

/** Max metres the corridor bridge may carry a leg across charted land before the
 *  fine pass DECLINES (keeps the coarse A* slice). A thin LNDARE bleed / wall is
 *  tens of metres; beyond this the canal is genuinely un-charted as water (a
 *  data-coverage gap, e.g. Newport's 427 m entry channel) and bridging would draw
 *  a confident fine route straight through the marina lots. Don't. */
export const MAX_BRIDGE_CROSSING_M = 60;

/** Apron added around the span crop, in degrees (~550 m). Generous enough that
 *  the canal stays connected to the coarse route's proven-reachable entry/exit
 *  cells (masterplan §9b 300 m + margin), tight enough to keep the build cheap. */
export const FINE_CANAL_APRON_DEG = 0.005;

/** Build-a-fine-grid callback the engine injects (captures buildNavGridCached +
 *  the chart layers). Returns a NavGrid over `bbox` at `resolutionM`, or null if
 *  the build is unavailable/failed. Kept as a callback so this module never
 *  imports the engine (no cycle): tier3 references only the NavGrid type. */
export type BuildFineGrid = (bbox: readonly [number, number, number, number], resolutionM: number) => NavGrid | null;

/** Tight bbox [minLon,minLat,maxLon,maxLat] around a span's polyline slice plus
 *  the seam endpoints, padded by `apronDeg`. */
export function spanCropBbox(
    fullPolyline: readonly LatLon[],
    span: TierSpan,
    apronDeg: number,
): [number, number, number, number] {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const extend = ([lon, lat]: LatLon): void => {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    };
    for (let i = span.fromIdx; i <= span.toIdx && i < fullPolyline.length; i++) extend(fullPolyline[i]);
    extend(span.entry.at);
    extend(span.exit.at);
    return [minLon - apronDeg, minLat - apronDeg, maxLon + apronDeg, maxLat + apronDeg];
}

export interface FineCanalAttempt {
    /** The fine leg, or null if the fine pass declined. */
    leg: FineCanalLeg | null;
    /** A short reason, surfaced into the leg provenance so on-device logs show
     *  WHY a span did or didn't take the fine pass:
     *    'notnarrow'    — the coarse corridor is wider than a canal (probe gate)
     *    'nogrid'       — the engine couldn't build a fine grid for the crop
     *    'disc:<sub>'   — declined; sub = nowater | nostart | noend | 2comp/<n>
     *    'barrier/<m>m' — declined; REAL water split by >MAX_BRIDGE_CROSSING_M of
     *                   charted land (a data-coverage gap, not a thin artifact)
     *    'k<n>,real'    — success on connected REAL water (clean fine route)
     *    'k<n>,split/br<m>m' — success; REAL water split by a SHORT (≤cap) gap the
     *                   bridge carried the leg <m> m across (a thin wall/sliver) */
    diag: string;
}

interface KeelFlood {
    /** Navigable (non-NaN) cells in the REAL (unbridged) fine grid. */
    waterCount: number;
    gStart: Cell | null;
    gEnd: Cell | null;
    /** gStart's keel-graph component reaches gEnd (REAL water, no bridge). */
    reached: boolean;
    /** Size (cells) of gStart's component. */
    startCompCells: number;
}

/** Reconstruct routeMarina's keel graph on the REAL (unbridged) water and flood
 *  from the snapped entry to test whether it reaches the snapped exit. This is
 *  the ground truth for "is this canal genuinely split here?" — independent of
 *  any corridor bridge, which is added only to the cost grid, not to fineGrid. */
function keelGraphFlood(fineGrid: NavGrid, span: TierSpan): KeelFlood | null {
    const start = toCell(fineGrid, span.entry.at[0], span.entry.at[1]);
    const end = toCell(fineGrid, span.exit.at[0], span.exit.at[1]);
    if (!start || !end) return null;
    const w = fineGrid.width;
    const h = fineGrid.height;
    const shape = { width: w, height: h };
    const depth = marinaDepthArray(fineGrid); // REAL water (fineGrid.cells, unbridged)
    const water = new Uint8Array(w * h);
    let waterCount = 0;
    for (let i = 0; i < water.length; i++)
        if (!Number.isNaN(depth[i])) {
            water[i] = 1;
            waterCount++;
        }
    if (waterCount === 0) return { waterCount: 0, gStart: null, gEnd: null, reached: false, startCompCells: 0 };
    const keel = keelCellsFor(gridResM(fineGrid));
    const clearance = euclideanDistanceTransform(water, shape);
    const graph = new Uint8Array(w * h);
    for (let i = 0; i < graph.length; i++) graph[i] = clearance[i] >= keel ? 1 : 0;
    const gStart = snapToMask(graph, shape, start);
    const gEnd = snapToMask(graph, shape, end);
    if (!gStart || !gEnd) return { waterCount, gStart, gEnd, reached: false, startCompCells: 0 };
    const seen = new Uint8Array(w * h);
    const startIdx = gStart.y * w + gStart.x;
    const queue: number[] = [startIdx];
    seen[startIdx] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
        const idx = queue[qi];
        const x = idx % w;
        const y = (idx / w) | 0;
        if (x > 0 && graph[idx - 1] && !seen[idx - 1]) {
            seen[idx - 1] = 1;
            queue.push(idx - 1);
        }
        if (x < w - 1 && graph[idx + 1] && !seen[idx + 1]) {
            seen[idx + 1] = 1;
            queue.push(idx + 1);
        }
        if (y > 0 && graph[idx - w] && !seen[idx - w]) {
            seen[idx - w] = 1;
            queue.push(idx - w);
        }
        if (y < h - 1 && graph[idx + w] && !seen[idx + w]) {
            seen[idx + w] = 1;
            queue.push(idx + w);
        }
    }
    return { waterCount, gStart, gEnd, reached: seen[gEnd.y * w + gEnd.x] === 1, startCompCells: queue.length };
}

/**
 * Sub-diagnose a 'disconnected' fine pass, so on-device logs pinpoint the cause
 * (runs only on the failure path):
 *   'nowater'     — the fine grid has no navigable water at all (canal absent)
 *   'nostart'/'noend' — an endpoint can't snap to keel-safe water
 *   '2comp/<n>'   — entry & exit are in DIFFERENT water bodies; n = entry's
 *                   component size in cells (small ⇒ an islanded berth basin)
 *   'nopath'      — same component yet no centreline (unexpected; solver edge)
 */
function diagnoseDisconnect(fineGrid: NavGrid, span: TierSpan): string {
    const f = keelGraphFlood(fineGrid, span);
    if (!f) return 'oob';
    if (f.waterCount === 0) return 'nowater';
    if (!f.gStart) return 'nostart';
    if (!f.gEnd) return 'noend';
    return f.reached ? 'nopath' : `2comp/${f.startCompCells}`;
}

/** Metres of the output route that run over cells the REAL grid calls NaN —
 *  i.e. the visible "crossing" length the bridge had to carry through a fine-grid
 *  barrier. ~0 ⇒ the route rides real water the whole way; non-zero ⇒ that many
 *  metres of the leg cross charted-land (the residual clip Shane sees). */
function bridgedCrossingM(fineGrid: NavGrid, polyline: readonly LatLon[]): number {
    const stepM = Math.max(3, gridResM(fineGrid) / 3);
    let total = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const segM = Math.hypot(
            (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180),
            (b[1] - a[1]) * M_PER_DEG_LAT,
        );
        const steps = Math.max(1, Math.ceil(segM / stepM));
        let overNaN = 0;
        for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) / steps;
            const cell = toCell(fineGrid, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            if (cell && Number.isNaN(fineGrid.cells[cell.y * fineGrid.width + cell.x])) overNaN++;
        }
        total += (overNaN / steps) * segM;
    }
    return total;
}

/**
 * Orchestrate the fine canal pass for one span: probe narrowness on the COARSE
 * grid, and only if it's a true canal, build a fine grid over the span crop and
 * route it with buildFineCanalLeg. Returns the corner-safe fine leg (or null)
 * plus a diagnostic reason — in the null case the caller keeps today's coarse A*
 * slice. This is the ONE function tier3Router calls; it owns the resolution +
 * apron policy.
 */
export function tryFineCanalLeg(
    span: TierSpan,
    fullPolyline: readonly LatLon[],
    coarseGrid: NavGrid,
    buildFineGrid: BuildFineGrid,
    paramsOverride?: Partial<MarinaRouteParams>,
): FineCanalAttempt {
    if (!isCanalNarrow(coarseGrid, fullPolyline, span)) return { leg: null, diag: 'notnarrow' };
    const bbox = spanCropBbox(fullPolyline, span, FINE_CANAL_APRON_DEG);
    const fineGrid = buildFineGrid(bbox, FINE_CANAL_RES_M);
    if (!fineGrid) return { leg: null, diag: 'nogrid' };
    const corridor = fullPolyline.slice(span.fromIdx, span.toIdx + 1);
    const leg = buildFineCanalLeg(fineGrid, span, paramsOverride, corridor);
    if (!leg) return { leg: null, diag: `disc:${diagnoseDisconnect(fineGrid, span)}` };
    // Was the REAL (unbridged) canal water already connected? If so it's a clean
    // fine route. If not, the bridge carried the leg across a fine-grid barrier —
    // measure how far. A thin artifact (a wall/sliver) is fine to bridge; a long
    // crossing means the canal is genuinely un-charted as water here (a data gap),
    // and bridging would draw a confident fine route across the marina lots — so
    // DECLINE and keep the coarse A* slice rather than fake clean water.
    const flood = keelGraphFlood(fineGrid, span);
    if (flood && !flood.reached) {
        const brM = bridgedCrossingM(fineGrid, leg.polyline);
        if (brM > MAX_BRIDGE_CROSSING_M) return { leg: null, diag: `barrier/${Math.round(brM)}m` };
        return { leg, diag: `k${leg.keelCellsUsed},split/br${Math.round(brM)}m` };
    }
    return { leg, diag: `k${leg.keelCellsUsed},real` };
}
