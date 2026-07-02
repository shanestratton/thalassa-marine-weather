/**
 * Inshore Router Engine — A* pathfinding, cost model & centre-bias.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import { M_PER_DEG_LAT } from './constants';
import type { NavGrid } from './types';
import { mPerDegLon, bresenhamCells, isNavigable } from './geometry';
import { euclideanDistanceTransform } from '../marinaCenterline';

// ── Min-heap for A* open set ────────────────────────────────────────

export interface HeapEntry {
    f: number; // priority = g + h
    idx: number; // grid index
}

/** Exported for the heap-invariant unit test (tests/minHeap.test.ts) —
 *  the 2026-06-11 sinkDown bug silently degraded every A* route. */
export class MinHeap {
    private a: HeapEntry[] = [];
    push(e: HeapEntry): void {
        this.a.push(e);
        this.bubbleUp(this.a.length - 1);
    }
    pop(): HeapEntry | undefined {
        if (this.a.length === 0) return undefined;
        const top = this.a[0];
        const last = this.a.pop()!;
        if (this.a.length > 0) {
            this.a[0] = last;
            this.sinkDown(0);
        }
        return top;
    }
    get size(): number {
        return this.a.length;
    }
    private bubbleUp(i: number): void {
        const item = this.a[i];
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.a[p].f <= item.f) break;
            this.a[i] = this.a[p];
            i = p;
        }
        this.a[i] = item;
    }
    private sinkDown(i: number): void {
        const item = this.a[i];
        const n = this.a.length;
        // Hole pattern: children are hoisted up and `item` is placed last, so
        // every comparison must be against ITEM's priority — never against
        // this.a[i], which after the first hoist holds the hoisted child.
        // (The old version compared a[smallest] with smallest=i: the loop
        // terminated early and `item` landed above smaller children, breaking
        // the heap invariant — A* popped non-minimal nodes and returned
        // measurably suboptimal routes. Found 2026-06-11 via the seamanship
        // fixtures: 289,493 m-eq path on a grid with a 73,048 m-eq optimum.)
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = -1;
            let smallestF = item.f;
            if (l < n && this.a[l].f < smallestF) {
                smallest = l;
                smallestF = this.a[l].f;
            }
            if (r < n && this.a[r].f < smallestF) {
                smallest = r;
            }
            if (smallest === -1) break;
            this.a[i] = this.a[smallest];
            i = smallest;
        }
        this.a[i] = item;
    }
}

// ── A* ───────────────────────────────────────────────────────────────

/** Metres-equivalent surcharge for stepping OFF a preferred corridor
 *  (preferred=1 → preferred=0). Wired through aStar AND chainCostM so the
 *  search and the smoothing price edges identically. 0 = inert; flipped to
 *  the masterplan Phase 3 value (250) in its own knob commit. */
export const EXIT_PENALTY_M = 250;

/**
 * Medial-axis centring bias for the coarse A* cost. Every step's metres-cost
 * is scaled by (1 + CENTRE_BIAS·(1 − clearNorm)), where clearNorm is the
 * destination cell's clearance to the nearest blocked (NaN/land) cell,
 * normalised by {@link CENTRE_NORM_CELLS} and capped at 1. A bank-hugging
 * cell (clearNorm 0) therefore costs (1 + CENTRE_BIAS)× a mid-channel cell, so
 * A* bows to the centreline of confined water instead of taking the wall-hugging
 * shortest path. Open water past the half-width cap has clearNorm 1 ⇒ factor 1
 * ⇒ the offshore/coastal geodesic is unchanged.
 *
 * This is the SAME mechanism as marinaCenterline.solveCenterline (which uses
 * bias 5 on a unit step), but gentler — here it multiplies the depth-band
 * multipliers (4–6× in real water) rather than a unit base, and it must only
 * break the wall-hug tie, never override depth/caution avoidance OR a marked
 * gate's discipline. The factor is always ≥ 1, so the haversine heuristic stays
 * admissible (a step is never cheaper than its straight-line length — the
 * invariant cellCostMultiplier already guards).
 *
 * VALUE 0.5: swept against the full routing corpus + a synthetic unmarked
 * bending channel. The safe window is [0.3, 0.6] — the corpus holds at
 * clean-master parity throughout; at 0.7 a centring penalty starts to beat a
 * marked gate's threading dip (the wrong-side-temptation seamanship flip), and
 * below 0.3 the centring is too weak to break the wall-hug. 0.5 sits mid-window:
 * it pulls a 700 m channel's bend apex from ~+337 m (riding the bank) to ~+41 m
 * (near centre) while leaving a comfortable margin below the 0.7 break.
 */
export const CENTRE_BIAS = 0.5;

/**
 * Confinement-probe reach, in COARSE cells — how far the two-sided-confinement
 * gate looks for an opposing shore before calling a cell "open water". At the
 * 50 m engine resolution 12 cells ≈ 600 m, so channels up to ~1.2 km wide are
 * still recognised as channels (and centred); wider bays read as open and keep
 * the geodesic.
 */
export const CENTRE_HALF_WIDTH_CELLS = 12;

/**
 * Normalisation half-width, in COARSE cells, for the centring GRADIENT. A cell
 * this far (or farther) from the nearest shore counts as fully mid-channel
 * (norm 1 ⇒ factor 1.0); the bias ramps linearly from the bank to here. This is
 * DELIBERATELY smaller than the probe reach: tying the gradient to the probe
 * reach (12) would make a wide channel's gradient nearly flat (a 7-cell-half
 * channel's centre would still read norm 0.58, barely discounted), so the route
 * only half-leaves the bank on a sharp bend. At 6 (≈300 m) the gradient is
 * steep enough to pull the route to true mid-channel on typical canals/river
 * reaches, while a channel wider than ~12 cells simply has a flat factor-1 core
 * (already off both banks — correct). Swept with CENTRE_BIAS; see that constant.
 */
export const CENTRE_NORM_CELLS = 6;

/**
 * Cost multiplier per cell based on its known depth.
 *
 * Why this exists: without it, A* finds the geometrically shortest
 * path. In a wide bay or harbor that produces a straight line that
 * cuts diagonally across the chart, ignoring the dredged channel.
 * Channels in ENCs show as DEPARE polygons with deep DRVAL1 values
 * (often 10-20m+); shallow flats around them have shallower DRVAL1.
 *
 * By making deeper water cheaper than shallow/unknown water, A*
 * naturally prefers to stay in the channel even when a straighter
 * route exists. The multipliers are gentle — we still want short
 * routes — but enough to bias toward marked deep water.
 *
 * IMPORTANT: all multipliers must be ≥ 1.0 to keep the haversine
 * heuristic admissible. We never make travel CHEAPER than straight
 * line, only more expensive in less-preferred water.
 *
 *   depth >= 10m → 1.00 (baseline — preferred channel)
 *   depth >= 5m  → 1.10 (moderate — fine for most cruisers)
 *   depth >= 0   → 1.30 (shallow but navigable for shallow draft)
 *   depth == 0   → 50.0 (UNKNOWN_OPEN — strong penalty against marsh,
 *                        sliver gaps, and unsurveyed water)
 *
 * UNKNOWN_OPEN was 5× originally (compared to 1.5× before that). The
 * 5× value still wasn't enough at public-data resolutions: ogr2ogr's
 * polygon simplifier leaves narrow slivers between adjacent simplified
 * DEPARE polygons, and a 5× penalty was small enough that A* threaded
 * routes through them — producing paths that visually appeared to
 * cross "marked-shallow" polygons even though the underlying grid
 * cells were technically in the gap between bands. Bumped to 50× so
 * A* will detour up to 50 cells through marked-deep water before
 * accepting a single unmarked cell.
 */
export function cellCostMultiplier(depth: number, preferred: boolean, drying = false): number {
    // Cells inside a marked fairway / dredged area always get the
    // baseline cost regardless of depth band — that's how we get
    // A* to follow the channel instead of cutting across deeper
    // open water nearby.
    //
    // 2026-05-20: tried depth-grading this (deep 1.0× / shallow 2.5×) to
    // make A* ride the deep dredged centre. It BACKFIRED — the Brisbane
    // shipping channel reads as 2 m in the 30 m bathymetry, so penalising
    // shallow preferred cells pushed A* OFF the channel onto a coast-
    // hugging path with more caution (Shane: "brisbane end it hugging the
    // coast now, it is not right"). The real lever is the vessel draft
    // (it was coming through at 0.914 m / 3 ft, far too shallow for a
    // 55' Tayana, so everything reads navigable) + FAIRWY coverage, NOT
    // cost tuning. Reverted to flat 1.0×.
    if (preferred) return 1.0;

    // Outside marked channels, prefer deeper water but allow shallow
    // navigable cells. The penalties are stiffer than before (was
    // 1.1/1.3/5.0 → now 1.5/2.5/50) because we now have FAIRWY data
    // for the "right" path and want to push A* into it. A 1.5×
    // penalty for "deep but unmarked" water means a 50% detour
    // through fairway beats a straight shot through unmarked deep
    // water — about right when the chart actually has fairways.
    // Steep cost gradient between "marked channel" (FAIRWY) and "just
    // navigable deep water" so A* commits to channels even when a
    // ~25% shorter straight-line route exists through generic
    // bathymetry-deep cells. Earlier 1.2× for deep water meant a
    // direct 11 NM line at 1.2× (13.2 NM-equiv) beat the 15 NM
    // channel-following path at 1.0× (15 NM-equiv); the route cut
    // straight across the Brisbane River shipping channel instead
    // of riding it.
    //
    // With deep = 2.5×, the direct line becomes 11 × 2.5 = 27.5
    // NM-equiv vs channel at 15 NM-equiv — A* now prefers the
    // channel route decisively. The boat is then routed through
    // marked safe water rather than open bay.
    //
    // 2026-05-12: bumped deep from 2.5 → 5.0. Coverage analysis
    // showed that even with 2.5× deep cost, the channel was only
    // winning when FAIRWY coverage was > 70% along the path. The
    // synthetic FAIRWY ribbon at 30 m half-width left gaps where
    // cell-centre sampling missed the polygon, dropping effective
    // coverage to ~50% — at which point direct-line through deep
    // beat the channel detour. Pairing this with the iOS-side
    // ribbon widening (30 → 100 m half-width) plus a stiffer 5×
    // gradient makes the channel route win even at 60% coverage.
    //
    // RETUNED 5/6/8 → 4/4.8/6.4 (2026-06-12, the Phase 3b bundle's one
    // knob, swept with the scorecard — ROUTING_COLLAB replies 12–13).
    // The 5× era was partly masked by the cost-blind smoother erasing
    // corridor detours; once smoothing/centerline became cost-no-worse,
    // honest geometry exposed 5× as over-aggressive (Tangalooma golden
    // +21%). Sweep at {2.5, 3, 4, 5} × all fixtures + goldens:
    //   2.5 → gate-shortcut un-flips (0/5 gates);
    //   3   → staggered ≥90% discipline un-flips (79.7);
    //   4   → ALL flips hold (GS 5/5, STAG 92.6, MID 10/11) and
    //         Tangalooma settles at +14.5% (18.43 NM) vs +21% at 5×;
    //   5   → same flips, Tangalooma +21%.
    // 4 is the smallest value that keeps every seamanship flip.
    if (depth >= 10) return 4.0;
    if (depth >= 5) return 4.8;
    // depth ∈ (0, 5) — shallow but passes the draft+safety cutoff.
    // Tried 18× on 2026-05-15 to push A* harder toward deep water at
    // Brisbane (user: "we will need to get out and push"). Combined
    // with the trailing-window PCA change, the result regressed
    // Newport — user "that broke the newport end". Back to 8×. The
    // Brisbane "favours shallow over deep" issue is more likely a
    // data-coverage problem (the 3 m bathymetry around the river
    // mouth is what the 30 m AusBathyTopo actually reads; the deep
    // shipping channel needs FAIRWY coverage to win) than a cost-
    // tuning one — pushing cost further amplifies routing artefacts.
    if (depth > 0) return 6.4;
    // CAUTION (depth < 0, the -1 sentinel) — soft-blocked: too shallow
    // for this vessel per our coarse bathymetry, but not land/hazard.
    // 40× — A* strongly prefers real water (5× the worst real-water
    // cost of 8×, 8× the typical deep-water 5×), but won't take an
    // insane detour to avoid caution. History:
    //   • 400× was the first cut and sent A* on ~10 km zigzag legs
    //     to dodge a single caution cell.
    //   • 25× routed Brisbane fine end-to-end but A* would accept a
    //     caution stretch when an "obvious" slightly-longer deep
    //     alternative existed.
    //   • 80× — tried 2026-05-15 to push A* harder toward deep
    //     alternatives at Brisbane. It made things WORSE — the
    //     bigger detour budget combined with the CLUSTER_LINK_M=900
    //     regression produced a huge westward zigzag through caution
    //     territory ("more red" overall). The 40× balance was right;
    //     the "favouring shallow over deep" at Brisbane is most
    //     likely a DATA limit — the "deep alternative" the user can
    //     see on screen reads as caution in our 30 m bathymetry too,
    //     so no cost tune fixes it. Needs better depth data.
    //   • Reverted to 40×.
    // DRYING tier within caution (charted DRVAL1 ≤ 0 — the bank dries at LAT).
    // Flat 40× made A* INDIFFERENT between a drying bank and 2 m of honest
    // water, so routes cut straight across banks a local skipper skirts
    // (Shane's Newport exit: the line crossed DRVAL1 0/−2 with a charted 2 m
    // band alongside). 3× the wet-caution cost steers off the bank without
    // recreating the 400×-era zigzags (drying cells are a narrow SUBSET of
    // caution, hugging the banks). Marked channels are exempt via `preferred`
    // above — a mark-vouched channel over a charted drying band still routes.
    // NOT the reverted depth-grading of d55ea29f: that graded PREFERRED water;
    // this grades only the red. Fixture: tests/engine/dryingCaution.test.ts.
    if (depth < 0) return drying ? 120.0 : 40.0;
    // UNKNOWN_OPEN — 500× (see earlier rationale). With non-preferred
    // bathymetry now at 2.5-5.0× the relative gap to unknown is
    // smaller (100× → 200×), still decisive.
    return 500.0;
}

/**
 * Per-cell medial-axis centring multiplier for the coarse A* cost — the cure for
 * the channel wall-hug. An exact Euclidean distance transform of the navigable
 * mask gives every water cell its clearance (in cells) to the nearest blocked
 * cell; that is clamped to {@link CENTRE_NORM_CELLS},
 * normalised to [0,1], and mapped to (1 + {@link CENTRE_BIAS}·(1 − norm)). A
 * bank-hugging cell (norm 0) gets the full (1 + CENTRE_BIAS) penalty; a
 * mid-channel cell (norm 1) gets 1.0; open water past the half-width is flat at
 * 1.0 so the offshore/coastal geodesic is untouched.
 *
 * Computed ONCE per grid (O(width·height)) and stored on grid.centreFactor, then
 * read by aStar AND cellCostAt so the search and the smoother/acceptance gates
 * price edges identically — the EXIT_PENALTY_M doctrine, extended to centring.
 */
export function computeCentreFactor(grid: NavGrid, markGoverned?: Uint8Array): Float32Array {
    const w = grid.width;
    const h = grid.height;
    const total = w * h;
    // Foreground (1) = CONFIDENT navigable water (depth ≥ 0). Background (0) =
    // land (NaN) AND charted-shallow caution (< 0). Centring then rides the
    // middle of the SAFE channel and is pushed OFF shallow banks — never pulled
    // toward a geometrically-central shoal (the Tangalooma caution regression a
    // bare navigable-mask EDT caused).
    const navMask = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
        const d = grid.cells[i];
        navMask[i] = !Number.isNaN(d) && d >= 0 ? 1 : 0;
    }
    const clearance = euclideanDistanceTransform(navMask, { width: w, height: h });

    // Two-sided-confinement gate. Centring must engage ONLY in a genuine channel —
    // water bounded on OPPOSING sides (canal, marina basin, river reach) — never
    // along a one-sided coast, where bowing toward the medial axis means bowing
    // AWAY from the shore into open water (at a headland gate that is the WRONG
    // SIDE of the mark — the wrong-side-temptation regression). A cell is
    // "confined" when, probing outward up to one half-width, at least one opposing
    // direction-pair (N/S, E/W, or a diagonal) BOTH hit a boundary cell. Running
    // off the grid edge counts as open (the crop edge is not a real wall).
    const cap = CENTRE_HALF_WIDTH_CELLS;
    const boundedWithin = (x: number, y: number, dx: number, dy: number): boolean => {
        for (let s = 1; s <= cap; s++) {
            const nx = x + dx * s;
            const ny = y + dy * s;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false; // off-grid = open
            if (navMask[ny * w + nx] === 0) return true; // hit a land/caution boundary
        }
        return false; // open water within a half-width this way
    };
    const isConfined = (x: number, y: number): boolean =>
        (boundedWithin(x, y, 0, -1) && boundedWithin(x, y, 0, 1)) || // N & S
        (boundedWithin(x, y, -1, 0) && boundedWithin(x, y, 1, 0)) || // W & E
        (boundedWithin(x, y, -1, -1) && boundedWithin(x, y, 1, 1)) || // NW & SE
        (boundedWithin(x, y, 1, -1) && boundedWithin(x, y, -1, 1)); // NE & SW

    // Confinement mask, stored on the grid: 1 = navigable water bounded on
    // opposing sides (a real channel). Drives both the centring gate below AND
    // the de-stagger (which acts only on confined water, so an open bar approach
    // is left alone). Only computed for navigable cells; land/caution stay 0.
    const confined = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
        if (navMask[i] === 1 && isConfined(i % w, (i / w) | 0)) confined[i] = 1;
    }
    grid.confined = confined;

    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) {
        // Where a marked channel defines the line — a FAIRWY/DRGARE (preferred) OR
        // within a paired channel's mark-governed disc (markGoverned) — the lateral
        // marks + leading lines ALREADY own the centreline via fairlead/gate
        // following. Geometric centring would fight that discipline, pulling the
        // route off the midpoint chain, even to the WRONG SIDE of a mark (the
        // seamanship regressions). Suppress it there (factor 1.0) so the marked
        // route is byte-identical to today. Centring is the authority ONLY where no
        // marked channel exists — canals, marina basins, unmarked nearshore water
        // (exactly the wall-hug the user reports).
        if (grid.preferred[i] === 1 || (markGoverned && markGoverned[i] === 1)) {
            out[i] = 1;
            continue;
        }
        // Off a one-sided coast / in open water ⇒ no centring (factor 1.0).
        if (confined[i] === 0) {
            out[i] = 1;
            continue;
        }
        const norm = Math.min(clearance[i], CENTRE_NORM_CELLS) / CENTRE_NORM_CELLS;
        out[i] = 1 + CENTRE_BIAS * (1 - norm);
    }
    return out;
}

/**
 * 8-neighbor A* on the navigability grid. Distance cost is meter-step
 * × cellCostMultiplier(depth). Heuristic = straight-line meter distance
 * to goal (admissible because all multipliers are ≥ 1.0).
 *
 * Exported for the Phase 11 connector parity fixture (K independent A*
 * runs are the reference the multi-target search must match within 1%).
 * `stats.popped`, when supplied, counts heap pops — the deterministic
 * latency proxy the fixture asserts on (wall-clock flakes in CI).
 */
export function aStar(
    grid: NavGrid,
    start: { x: number; y: number },
    end: { x: number; y: number },
    stats?: { popped: number },
): { x: number; y: number }[] | null {
    const w = grid.width;
    const h = grid.height;
    const total = w * h;

    const gScore = new Float64Array(total);
    gScore.fill(Infinity);
    const cameFrom = new Int32Array(total);
    cameFrom.fill(-1);

    const startIdx = start.y * w + start.x;
    const endIdx = end.y * w + end.x;

    // Pre-compute mPerLon at grid's mid-latitude. The variation across
    // a 5 NM grid is < 0.1% — using a constant lets us avoid a cos()
    // per neighbor expansion (saves ~30% on a 200×200 grid).
    const midLat = grid.minLat + (grid.height * grid.dLat) / 2;
    const mPerLonGrid = mPerDegLon(midLat);

    gScore[startIdx] = 0;
    const heuristic = (x: number, y: number): number => {
        const dx = (end.x - x) * grid.dLon * mPerLonGrid;
        const dy = (end.y - y) * grid.dLat * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
    };

    const open = new MinHeap();
    open.push({ f: heuristic(start.x, start.y), idx: startIdx });

    // 8-neighbor offsets — base step distances in meters get computed
    // once below using the precomputed mPerLonGrid.
    const NEIGHBORS: { dx: number; dy: number }[] = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
    ];
    // Pre-compute meter step length for each of the 8 directions
    // (cardinal vs diagonal). All cells have the same dLat/dLon so
    // these are identical for every cell — saves the sqrt-per-edge.
    const stepLengthsM = NEIGHBORS.map(({ dx, dy }) =>
        Math.sqrt((dx * grid.dLon * mPerLonGrid) ** 2 + (dy * grid.dLat * M_PER_DEG_LAT) ** 2),
    );

    // Medial-axis centring field — the cure for the wall-hug. Each step below is
    // multiplied by centreFactor[dest] so the search bows to mid-channel in
    // confined water and is untouched in open water (factor 1). Computed once and
    // SHARED with cellCostAt (the smoother/gate pricing) via grid.centreFactor, so
    // no refinement step can re-straighten a centred leg onto the bank. Lazily
    // attached here for grids the builder didn't populate (disk/test fixtures).
    if (!grid.centreFactor) grid.centreFactor = computeCentreFactor(grid);
    const centreFactor = grid.centreFactor;

    while (open.size > 0) {
        const { idx } = open.pop()!;
        if (stats) stats.popped++;
        if (idx === endIdx) {
            // Reconstruct.
            const path: { x: number; y: number }[] = [];
            let cur = idx;
            while (cur !== -1) {
                path.push({ x: cur % w, y: Math.floor(cur / w) });
                cur = cameFrom[cur];
            }
            return path.reverse();
        }
        const cx = idx % w;
        const cy = Math.floor(idx / w);
        const curG = gScore[idx];
        const curPreferred = grid.preferred[idx] === 1;

        for (let n = 0; n < NEIGHBORS.length; n++) {
            const { dx, dy } = NEIGHBORS[n];
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            const cellDepth = grid.cells[nIdx];
            if (Number.isNaN(cellDepth)) continue; // blocked

            const cellPreferred = grid.preferred[nIdx] === 1;
            // Corridor-exit surcharge (additive ≥0 → the distance heuristic
            // stays admissible; cellCostMultiplier untouched, flat-preferred
            // doctrine preserved). See EXIT_PENALTY_M.
            const exitPenalty = curPreferred && !cellPreferred ? EXIT_PENALTY_M : 0;
            // NaN ≤ 0 is false, so absent shallowDepthM ⇒ never drying.
            const cellDrying = cellDepth < 0 && grid.shallowDepthM !== undefined && grid.shallowDepthM[nIdx] <= 0;
            const tentativeG =
                curG +
                stepLengthsM[n] * cellCostMultiplier(cellDepth, cellPreferred, cellDrying) * centreFactor[nIdx] +
                exitPenalty;
            if (tentativeG < gScore[nIdx]) {
                cameFrom[nIdx] = idx;
                gScore[nIdx] = tentativeG;
                open.push({ f: tentativeG + heuristic(nx, ny), idx: nIdx });
            }
        }
    }
    return null;
}

/**
 * Cost multiplier at a specific grid cell. Thin wrapper over
 * cellCostMultiplier that reads depth + preferred straight from
 * the grid arrays.
 */
export function cellCostAt(grid: NavGrid, x: number, y: number): number {
    const idx = y * grid.width + x;
    // × centreFactor so the smoother + acceptance gates price edges EXACTLY as
    // aStar did (centred). Absent on cached/test grids ⇒ 1 (prior behaviour).
    const centre = grid.centreFactor ? grid.centreFactor[idx] : 1;
    const drying = grid.cells[idx] < 0 && grid.shallowDepthM !== undefined && grid.shallowDepthM[idx] <= 0;
    return cellCostMultiplier(grid.cells[idx], grid.preferred[idx] === 1, drying) * centre;
}

export function lineOfSightClear(grid: NavGrid, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    // Cost-aware line of sight. The smoothed straight line must not
    // route through water STRICTLY WORSE than either endpoint already
    // uses. This is what keeps smoothPath from collapsing a channel
    // traversal into a corner-cutting diagonal: inside a FAIRWY both
    // endpoints are cost 1.0, so the line can only "see through" other
    // 1.0 cells — it has to stay in the channel, threading the marker
    // pairs A* routed it through. In open water both endpoints are
    // 5.0, so the line is free to cut across other 5.0 cells.
    //
    // Before this was cost-blind (just `isNavigable`), which let
    // smoothPath straight-line from a channel's entrance to its exit
    // because the open water ALONGSIDE the channel is technically
    // navigable — producing routes that visibly ignored the "stay
    // between the markers" rule (the Brisbane River bug, 2026-05-14).
    //
    // Also: never smooth ACROSS the CAUTION boundary. A straight line
    // is clear only if every cell shares the anchor's caution-state.
    // Without this, smoothPath strings a long diagonal from real water
    // straight THROUGH shallow caution water — the cost-budget gate
    // doesn't stop it because budget = max(endpoints), and a caution
    // endpoint (400×) lifts the bar high enough for the 400× caution
    // cells in between to pass. Result: long diagonals cutting corners
    // across shallow flats, and mostly-deep segments wrongly flagged
    // red. Splitting at the boundary keeps red runs and normal runs as
    // cleanly-bounded segments that follow the real cell path.
    const aCaution = grid.cells[a.y * grid.width + a.x] < 0;
    const budget = Math.max(cellCostAt(grid, a.x, a.y), cellCostAt(grid, b.x, b.y));
    for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
        if (!isNavigable(grid, c.x, c.y)) return false;
        if (grid.cells[c.y * grid.width + c.x] < 0 !== aCaution) return false;
        if (cellCostAt(grid, c.x, c.y) > budget) return false;
    }
    return true;
}

/**
 * Total traversal cost (metres-equivalent) of a chain of 8-neighbour grid
 * cells, priced EXACTLY like A*'s neighbour expansion: step length ×
 * destination-cell multiplier × centreFactor (via cellCostAt), plus
 * EXIT_PENALTY_M on every preferred→non-preferred transition. Used by
 * smoothPath's cost-no-worse rule and the marina-centerline acceptance gate, so
 * no post-A* refinement can silently undo a cost-optimal detour OR re-straighten
 * a centred leg back onto the bank.
 */
export function chainCostM(grid: NavGrid, chain: { x: number; y: number }[]): number {
    const mPerLonG = M_PER_DEG_LAT * Math.cos(((grid.minLat + (grid.height * grid.dLat) / 2) * Math.PI) / 180);
    const stepLonM = grid.dLon * mPerLonG;
    const stepLatM = grid.dLat * M_PER_DEG_LAT;
    let cost = 0;
    for (let i = 1; i < chain.length; i++) {
        const dx = Math.abs(chain[i].x - chain[i - 1].x);
        const dy = Math.abs(chain[i].y - chain[i - 1].y);
        const stepM = Math.hypot(dx * stepLonM, dy * stepLatM);
        cost += stepM * cellCostAt(grid, chain[i].x, chain[i].y);
        const fromPref = grid.preferred[chain[i - 1].y * grid.width + chain[i - 1].x] === 1;
        const toPref = grid.preferred[chain[i].y * grid.width + chain[i].x] === 1;
        if (fromPref && !toPref) cost += EXIT_PENALTY_M;
    }
    return cost;
}
