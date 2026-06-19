/**
 * marinaCenterline — the MarinerEE marina/canal routing pipeline, ported
 * from the proven Python spike (~/Projects/MarinerEE/newport_demo.py).
 *
 * Self-contained, pure functions over flat typed-array grids so they can
 * be parity-tested in isolation (see marinaCenterline.test.ts) BEFORE
 * being wired into the 2 500-line inshoreRouterEngine. Nothing here
 * imports the engine; the engine adapts its NavGrid onto these.
 *
 * Pipeline (matches the spike, proven 0 land crossings across 6 Newport
 * routes with ~5 m keel clearance):
 *   1. euclideanDistanceTransform  — exact EDT (Felzenszwalb–Huttenlocher)
 *   2. keel-clearance erosion       — graph = (clearance ≥ keel)
 *   3. largestComponent             — drop orphan basins
 *   4. centerline cost + dijkstra   — ride mid-channel, deep water
 *   5. stringPull                   — straight legs (no staircase bends)
 *
 * Grid convention: row-major, index = y*width + x. A boolean "mask" is a
 * Uint8Array (1 = passable/water, 0 = blocked/land).
 *
 * PROVENANCE: the canonical reference is the Python in MarinerEE. If you
 * change behaviour here, re-run the parity fixture — divergence that
 * re-introduces a land crossing is a safety regression, not a nuance.
 */

export interface GridShape {
    width: number;
    height: number;
}

/**
 * Exact Euclidean distance transform. For every cell, the distance to the
 * nearest ZERO (background) cell — i.e. for a water mask, the clearance to
 * the nearest shore. Matches scipy.ndimage.distance_transform_edt(mask).
 *
 * Felzenszwalb & Huttenlocher's separable algorithm: O(width*height),
 * exact. We compute the squared transform separably (columns then rows)
 * then sqrt at the end.
 *
 * @param mask  1 = object (measured), 0 = background (distance source)
 * @returns Float32Array of Euclidean distances (0 on background cells)
 */
export function euclideanDistanceTransform(mask: Uint8Array, { width, height }: GridShape): Float32Array {
    const INF = 1e20;
    const n = Math.max(width, height);
    const sq = new Float64Array(width * height);

    // Seed: 0 on object cells (measured), INF on background. The 1-D
    // transform below propagates the nearest background distance INTO the
    // object cells.
    for (let i = 0; i < mask.length; i++) sq[i] = mask[i] ? INF : 0;

    // Scratch buffers reused across rows/cols (sized to the larger dim).
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);

    const dt1d = (len: number): void => {
        let k = 0;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for (let q = 1; q < len; q++) {
            let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < len; q++) {
            while (z[k + 1] < q) k++;
            const dq = q - v[k];
            d[q] = dq * dq + f[v[k]];
        }
    };

    // Pass 1: transform along columns (y).
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) f[y] = sq[y * width + x];
        dt1d(height);
        for (let y = 0; y < height; y++) sq[y * width + x] = d[y];
    }
    // Pass 2: transform along rows (x).
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) f[x] = sq[row + x];
        dt1d(width);
        for (let x = 0; x < width; x++) sq[row + x] = d[x];
    }

    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(sq[i]);
    return out;
}

/**
 * Keep only the largest 4-connected component of a mask; zero the rest.
 * Mirrors the spike's `label` + largest-CC filter — drops orphan
 * drying-basin blobs that aren't reachable from the main waterway (which
 * would otherwise let a marker snap into unreachable water).
 */
export function largestComponent(mask: Uint8Array, { width, height }: GridShape): Uint8Array {
    const labels = new Int32Array(width * height).fill(-1);
    const queue = new Int32Array(width * height);
    let bestLabel = -1;
    let bestSize = 0;
    let cur = 0;

    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start] !== -1) continue;
        // BFS flood fill this component.
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        labels[start] = cur;
        let size = 0;
        while (head < tail) {
            const idx = queue[head++];
            size++;
            const x = idx % width;
            const y = (idx / width) | 0;
            // 4-neighbours
            if (x > 0 && mask[idx - 1] && labels[idx - 1] === -1) {
                labels[idx - 1] = cur;
                queue[tail++] = idx - 1;
            }
            if (x < width - 1 && mask[idx + 1] && labels[idx + 1] === -1) {
                labels[idx + 1] = cur;
                queue[tail++] = idx + 1;
            }
            if (y > 0 && mask[idx - width] && labels[idx - width] === -1) {
                labels[idx - width] = cur;
                queue[tail++] = idx - width;
            }
            if (y < height - 1 && mask[idx + width] && labels[idx + width] === -1) {
                labels[idx + width] = cur;
                queue[tail++] = idx + width;
            }
        }
        if (size > bestSize) {
            bestSize = size;
            bestLabel = cur;
        }
        cur++;
    }

    const out = new Uint8Array(width * height);
    if (bestLabel >= 0) {
        for (let i = 0; i < out.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
    }
    return out;
}

/**
 * BFS outward from a cell to the nearest set cell in `mask`. Mirrors the
 * spike's snap_to_water against the eroded graph: a requested point near a
 * dock wall (clearance below the keel margin, so eroded out) snaps to the
 * nearest keel-safe water cell. Returns null if the mask is empty.
 */
export function snapToMask(mask: Uint8Array, { width, height }: GridShape, cell: Cell): Cell | null {
    const startIdx = cell.y * width + cell.x;
    if (startIdx >= 0 && startIdx < mask.length && mask[startIdx]) return cell;
    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const sx = Math.max(0, Math.min(width - 1, cell.x));
    const sy = Math.max(0, Math.min(height - 1, cell.y));
    const seed = sy * width + sx;
    queue[tail++] = seed;
    seen[seed] = 1;
    while (head < tail) {
        const idx = queue[head++];
        if (mask[idx]) return { x: idx % width, y: (idx / width) | 0 };
        const x = idx % width;
        const y = (idx / width) | 0;
        if (x > 0 && !seen[idx - 1]) {
            seen[idx - 1] = 1;
            queue[tail++] = idx - 1;
        }
        if (x < width - 1 && !seen[idx + 1]) {
            seen[idx + 1] = 1;
            queue[tail++] = idx + 1;
        }
        if (y > 0 && !seen[idx - width]) {
            seen[idx - width] = 1;
            queue[tail++] = idx - width;
        }
        if (y < height - 1 && !seen[idx + width]) {
            seen[idx + width] = 1;
            queue[tail++] = idx + width;
        }
    }
    return null;
}

/** Binary min-heap keyed by float cost, storing int cell indices. */
class MinHeap {
    private cost: Float64Array;
    private idx: Int32Array;
    private size = 0;
    constructor(capacity: number) {
        this.cost = new Float64Array(capacity);
        this.idx = new Int32Array(capacity);
    }
    get length(): number {
        return this.size;
    }
    push(cost: number, idx: number): void {
        let i = this.size++;
        this.cost[i] = cost;
        this.idx[i] = idx;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.cost[p] <= this.cost[i]) break;
            this.swap(i, p);
            i = p;
        }
    }
    pop(): { cost: number; idx: number } {
        const top = { cost: this.cost[0], idx: this.idx[0] };
        const last = --this.size;
        this.cost[0] = this.cost[last];
        this.idx[0] = this.idx[last];
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < this.size && this.cost[l] < this.cost[m]) m = l;
            if (r < this.size && this.cost[r] < this.cost[m]) m = r;
            if (m === i) break;
            this.swap(i, m);
            i = m;
        }
        return top;
    }
    private swap(a: number, b: number): void {
        const c = this.cost[a];
        this.cost[a] = this.cost[b];
        this.cost[b] = c;
        const x = this.idx[a];
        this.idx[a] = this.idx[b];
        this.idx[b] = x;
    }
}

export interface Cell {
    x: number;
    y: number;
}

/**
 * Centerline-preferring shortest path (Dijkstra) — port of the spike's
 * `solve_centerline`. Each 4-connected step costs more the closer the
 * destination cell is to a wall, so the path rides the medial axis of the
 * channel rather than hugging a bank.
 *
 * @param passable      1 = traversable, 0 = blocked (the eroded keel graph)
 * @param distanceField per-cell "goodness" (higher = more central/deeper).
 *                      In the marina pipeline this is
 *                      DEPTH_WEIGHT*depth + min(centerlineEDT, cap).
 * @param safeClearance distance value at/above which a cell pays the floor
 *                      step cost (cells in the deepest/widest water).
 * @param bias          centring strength; the spike uses 5.0.
 * @returns the path as [{x,y}, …] from start to end, or null if unreachable.
 */
export function solveCenterline(
    passable: Uint8Array,
    shape: GridShape,
    start: Cell,
    end: Cell,
    distanceField: Float32Array,
    safeClearance: number,
    bias = 5.0,
): Cell[] | null {
    const { width, height } = shape;
    const startIdx = start.y * width + start.x;
    const endIdx = end.y * width + end.x;
    if (!passable[startIdx] || !passable[endIdx]) return null;

    const dRef = safeClearance > 0 ? safeClearance : 1.0;
    const invDRef = 1.0 / dRef;

    const best = new Float64Array(width * height).fill(Infinity);
    const parent = new Int32Array(width * height).fill(-1);
    const heap = new MinHeap(width * height);
    best[startIdx] = 0;
    heap.push(0, startIdx);

    const STEP = [-1, 1, -width, width]; // W, E, N, S

    while (heap.length > 0) {
        const { cost, idx } = heap.pop();
        if (idx === endIdx) break;
        if (cost > best[idx]) continue;
        const x = idx % width;
        for (let s = 0; s < 4; s++) {
            // Guard horizontal wrap for W/E steps.
            if (s === 0 && x === 0) continue;
            if (s === 1 && x === width - 1) continue;
            const nIdx = idx + STEP[s];
            if (nIdx < 0 || nIdx >= passable.length || !passable[nIdx]) continue;
            let dClamp = distanceField[nIdx];
            if (dClamp > dRef) dClamp = dRef;
            const dNorm = dClamp * invDRef;
            const step = 1.0 + bias * (1.0 - dNorm);
            const nd = cost + step;
            if (nd < best[nIdx]) {
                best[nIdx] = nd;
                parent[nIdx] = idx;
                heap.push(nd, nIdx);
            }
        }
    }

    if (parent[endIdx] === -1 && endIdx !== startIdx) return null;
    const path: Cell[] = [];
    let cur = endIdx;
    while (cur !== -1) {
        path.push({ x: cur % width, y: (cur / width) | 0 });
        if (cur === startIdx) break;
        cur = parent[cur];
    }
    path.reverse();
    return path;
}

/**
 * Line-of-sight string-pull — port of the spike's `simplify_los`. Reduces
 * a grid path to the minimal set of waypoints joined by straight segments
 * that each stay entirely inside `passable`. The grid solver only steps
 * N/S/E/W, so a diagonal channel comes out as a staircase; this replaces
 * those stairs with the straight line that actually fits, bending only
 * where a wall forces it.
 */
export function stringPull(path: Cell[], passable: Uint8Array, { width, height }: GridShape): Cell[] {
    if (path.length < 3) return path.slice();

    const clear = (a: Cell, b: Cell): boolean => {
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        if (n === 0) return true;
        for (let t = 0; t <= n; t++) {
            const x = Math.round(a.x + ((b.x - a.x) * t) / n);
            const y = Math.round(a.y + ((b.y - a.y) * t) / n);
            if (x < 0 || y < 0 || x >= width || y >= height || !passable[y * width + x]) return false;
        }
        return true;
    };

    const out: Cell[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        while (j > i + 1 && !clear(path[i], path[j])) j--;
        out.push(path[j]);
        i = j;
    }
    return out;
}

/**
 * Centreline-PRESERVING simplification — Douglas–Peucker on the raw Dijkstra
 * cell path, with a water-safety guard.
 *
 * Why not {@link stringPull} here: string-pull greedily jumps to the FARTHEST
 * cell with clear line-of-sight, i.e. it pulls the path taut to the longest
 * chord that fits inside the water. In a channel that runs alongside land the
 * longest clear chord is the one that hugs the inside bank — so taut-pull throws
 * away the mid-channel centreline the cost field just computed and replaces it
 * with a dead-straight wall-hugging line (Newport's berth-exit wall-hug).
 *
 * Douglas–Peucker instead keeps the point of MAXIMUM deviation at every bend, so
 * the simplified line stays on the centreline; it only drops a point when the
 * chord across it is within `toleranceCells` AND stays inside `passable`. The
 * tolerance removes the 4-connected staircase (stair noise ≤ ~1 cell) without
 * shortcutting the channel's curve. The water guard means a chord is never
 * collapsed across land or a bridged gap (those read as non-passable), so the
 * route still follows the raw path one cell at a time through any gap.
 */
export function centrelineSimplify(
    path: Cell[],
    passable: Uint8Array,
    { width, height }: GridShape,
    toleranceCells = 1.5,
): Cell[] {
    if (path.length < 3) return path.slice();

    const clear = (a: Cell, b: Cell): boolean => {
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        if (n === 0) return true;
        for (let t = 0; t <= n; t++) {
            const x = Math.round(a.x + ((b.x - a.x) * t) / n);
            const y = Math.round(a.y + ((b.y - a.y) * t) / n);
            if (x < 0 || y < 0 || x >= width || y >= height || !passable[y * width + x]) return false;
        }
        return true;
    };

    const keep = new Uint8Array(path.length);
    keep[0] = 1;
    keep[path.length - 1] = 1;
    // Iterative DP — avoids deep recursion on a long per-cell path.
    const stack: Array<[number, number]> = [[0, path.length - 1]];
    while (stack.length) {
        const seg = stack.pop();
        if (!seg) break;
        const [lo, hi] = seg;
        if (hi <= lo + 1) continue;
        const a = path[lo];
        const b = path[hi];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        let maxDev = -1;
        let maxIdx = -1;
        for (let k = lo + 1; k < hi; k++) {
            // Perpendicular distance of path[k] from the chord a→b (cell units).
            const dev = Math.abs((path[k].x - a.x) * dy - (path[k].y - a.y) * dx) / len;
            if (dev > maxDev) {
                maxDev = dev;
                maxIdx = k;
            }
        }
        // Collapse the run to one straight chord ONLY if it is both flat enough
        // and the chord stays in water; otherwise keep the worst offender (which
        // preserves the bend / forces the line back into water) and recurse.
        if (maxDev <= toleranceCells && clear(a, b)) continue;
        keep[maxIdx] = 1;
        stack.push([lo, maxIdx]);
        stack.push([maxIdx, hi]);
    }
    const out: Cell[] = [];
    for (let i = 0; i < path.length; i++) if (keep[i]) out.push(path[i]);
    return out;
}

/**
 * Clearance-constrained string-pull — the cure for BOTH the wobble AND the
 * corner-hug, in one mechanism.
 *
 * Plain {@link stringPull} pulls the path TAUT to the longest clear chord: dead
 * straight on a straight reach (good — no wobble) but it cuts the inside of every
 * bend and hugs the bank (bad). {@link centrelineSimplify}/smoothing keep the
 * centre but reproduce the medial-axis staircase/wander as a drunk wobble.
 *
 * This keeps the taut string-pull but adds ONE rule: a chord may only replace a
 * run of the centreline if it never gets CLOSER to a bank than the centreline did
 * at the same point (within `clearanceTolCells`). On a straight reach the taut
 * chord is at least as central as the wandering medial axis, so it is accepted →
 * a clean straight line, the staircase/wander ignored (no wobble). At a BEND the
 * taut chord cuts toward the inside bank, dropping clearance well below the
 * rounded medial axis → rejected → the bend's centreline vertices are kept → the
 * route rounds the corner mid-channel instead of clipping it.
 *
 * `clearance` is the EDT of the navigable mask (cells to nearest shore).
 */
export function stringPullCentred(
    path: Cell[],
    passable: Uint8Array,
    clearance: Float32Array,
    { width, height }: GridShape,
    clearanceTolCells = 1,
): Cell[] {
    if (path.length < 3) return path.slice();
    // Chord path[i]→path[j] OK iff every sampled cell is passable AND its clearance
    // is ≥ the medial axis's clearance at the matching along-position − tol.
    const chordOK = (i: number, j: number): boolean => {
        const a = path[i];
        const b = path[j];
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        if (n === 0) return true;
        for (let t = 0; t <= n; t++) {
            const f = t / n;
            const x = Math.round(a.x + (b.x - a.x) * f);
            const y = Math.round(a.y + (b.y - a.y) * f);
            if (x < 0 || y < 0 || x >= width || y >= height || !passable[y * width + x]) return false;
            const axis = path[Math.round(i + f * (j - i))];
            if (clearance[y * width + x] < clearance[axis.y * width + axis.x] - clearanceTolCells) return false;
        }
        return true;
    };
    const out: Cell[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        while (j > i + 1 && !chordOK(i, j)) j--;
        out.push(path[j]);
        i = j;
    }
    return out;
}

export interface MarinaRouteParams {
    /** Keel-clearance margin in cells. graph = (clearance ≥ keelCells). */
    keelCells: number;
    /** Depth weight in the cost field (spike: 15.0). */
    depthWeight: number;
    /** Centerline cap in cells — one canal half-width (spike: 12). */
    canalHalfWidthCells: number;
    /** Dijkstra centring strength (spike: 5.0). */
    bias: number;
}

export const DEFAULT_MARINA_PARAMS: MarinaRouteParams = {
    keelCells: 3,
    depthWeight: 15.0,
    canalHalfWidthCells: 12,
    bias: 5.0,
};

export interface MarinaRouteResult {
    /** Straight-leg waypoints in grid cells (string-pulled). */
    waypoints: Cell[];
    /** Raw per-cell Dijkstra path (pre-string-pull), for diagnostics. */
    cells: Cell[];
    /** Min clearance to TRUE shore along the path, in cells. */
    minClearanceCells: number;
    /** Mean clearance to TRUE shore along the path, in cells. */
    meanClearanceCells: number;
}

/**
 * Full marina pipeline over a navigable+depth grid. `depth` is the
 * per-cell charted depth in metres with NaN for blocked/land (exactly the
 * inshore engine's NavGrid.cells convention). Returns straight-leg
 * waypoints, or null if start/end aren't connected at the keel margin —
 * which correctly means "no safe passage", show RED, don't fake it.
 */
export function routeMarina(
    depth: Float32Array,
    shape: GridShape,
    start: Cell,
    end: Cell,
    params: MarinaRouteParams = DEFAULT_MARINA_PARAMS,
): MarinaRouteResult | null {
    const { width, height } = shape;

    // navigable = cells with a real depth (not NaN/blocked).
    const water = new Uint8Array(width * height);
    for (let i = 0; i < water.length; i++) water[i] = Number.isNaN(depth[i]) ? 0 : 1;

    // Clearance to true shore (for both the keel erosion and reporting).
    const trueClearance = euclideanDistanceTransform(water, shape);

    // Keel-clearance erosion: the pathfinding graph is water that's at
    // least keelCells from a true shore. Euclidean threshold (rounder,
    // slightly more correct than the spike's cityblock binary_erosion).
    //
    // We deliberately keep ALL eroded components (not just the largest).
    // If start and end land in different water bodies, Dijkstra returns
    // null and routeMarina returns null — the truthful "no safe passage"
    // answer. Filtering to the largest component would instead let an
    // endpoint in a disconnected basin snap across land to the main
    // waterway and fabricate a route — the exact thing we must never do.
    const graph = new Uint8Array(width * height);
    for (let i = 0; i < graph.length; i++) graph[i] = trueClearance[i] >= params.keelCells ? 1 : 0;

    // Centerline inside the eroded graph, capped at one canal half-width.
    const centerline = euclideanDistanceTransform(graph, shape);

    // Cost field: depth-weighted + centerline (matches the spike).
    const cost = new Float32Array(width * height);
    let costMax = 0;
    for (let i = 0; i < cost.length; i++) {
        if (!graph[i]) continue;
        const c = Math.min(centerline[i], params.canalHalfWidthCells);
        const d = Number.isNaN(depth[i]) ? 0 : depth[i];
        const v = params.depthWeight * d + c;
        cost[i] = v;
        if (v > costMax) costMax = v;
    }
    const safeClearance = costMax * 0.85;

    // Snap requested endpoints to the eroded graph — a dock-side point may
    // sit closer to a wall than the keel margin (eroded out), so route
    // from the nearest keel-safe water. Null snap = no reachable safe
    // water at all → no route.
    const gStart = snapToMask(graph, shape, start);
    const gEnd = snapToMask(graph, shape, end);
    if (!gStart || !gEnd) return null;

    const cells = solveCenterline(graph, shape, gStart, gEnd, cost, safeClearance, params.bias);
    if (!cells) return null;

    const waypoints = stringPull(cells, graph, shape);

    let minC = Infinity;
    let sumC = 0;
    for (const { x, y } of cells) {
        const c = trueClearance[y * width + x];
        if (c < minC) minC = c;
        sumC += c;
    }
    return {
        waypoints,
        cells,
        minClearanceCells: minC,
        meanClearanceCells: sumC / cells.length,
    };
}
