/**
 * Inshore Router Engine — post-A* path shaping (smooth, de-stagger, fair, marina).
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import { M_PER_DEG_LAT } from './constants';
import type { NavGrid, InshoreLayers, FairingMidpoint } from './types';
import { mPerDegLon, bresenhamCells, perpendicularDistanceDeg } from './geometry';
import { chainCostM, lineOfSightClear } from './aStar';
import { routeMarina, type Cell } from '../marinaCenterline';

/**
 * "String-pulling" smoothing on the A* output path.
 *
 * Why: A* on an 8-neighbor grid with diagonal cost = sqrt(2) finds
 * a cost-optimal path, but the path's GEOMETRY is often stair-shaped
 * (alternating diagonal + cardinal moves) when the goal isn't on a
 * pure diagonal. Two paths can have identical cost but very different
 * shapes — A* picks one arbitrarily.
 *
 * Smoothing fixes this without changing optimality: walk the path,
 * for each anchor point find the furthest subsequent point reachable
 * by a straight line through navigable cells. Replace the intermediate
 * stair-steps with the direct line. Result is much closer to the
 * geometrically-shortest polyline through the navigable region.
 */
export function smoothPath(grid: NavGrid, path: { x: number; y: number }[]): { x: number; y: number }[] {
    if (path.length < 3) return path;
    // Prefix sums of the path's TRUE cost, so any subpath's cost is O(1).
    // A chord may only replace a subpath when the chord's own cost is no
    // worse — without this, a route whose ENDS sit in expensive open water
    // (budget = max(endpoints)) could have its entire cost-optimal channel
    // detour collapsed into a straight expensive chord, silently undoing the
    // gate-following A* just paid for. (Found 2026-06-11 calibrating the
    // Phase 3 gate-shortcut fixture: A* threaded the marked dog-leg; the
    // smoother returned the straight line. Landed per ROUTING_COLLAB
    // reply 13 — a correctness fix under the geometry-is-the-law doctrine.)
    const prefix: number[] = [0];
    for (let k = 1; k < path.length; k++) {
        prefix.push(prefix[k - 1] + chainCostM(grid, [path[k - 1], path[k]]));
    }
    const out: { x: number; y: number }[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        // Linear scan from the back is cheap because clears happen
        // most of the time on long open stretches.
        while (j > i + 1) {
            if (lineOfSightClear(grid, path[i], path[j])) {
                const chord = Array.from(bresenhamCells(path[i].x, path[i].y, path[j].x, path[j].y));
                const chordCost = chainCostM(grid, chord);
                if (chordCost <= (prefix[j] - prefix[i]) * 1.0001 + 1e-6) break;
            }
            j--;
        }
        out.push(path[j]);
        i = j;
    }
    return out;
}

/** Tolerance (cells) for the centred-water de-stagger: stair/wobble noise up to
 *  this perpendicular deviation is collapsed; a real channel bend (larger
 *  deviation) is preserved. ~2 cells (100 m at 50 m) de-jaggies the grid path
 *  without shortcutting a canal's curve. */
export const DESTAGGER_TOLERANCE_CELLS = 2;

/**
 * De-stagger the route THROUGH CENTRED WATER ONLY — the cure for the "drunk
 * steering" wobble the centring term leaves behind.
 *
 * The centring term is priced into cellCostAt, so smoothPath's cost-no-worse
 * string-pull cannot straighten the mid-channel grid staircase (a straight chord
 * crosses marginally-off-centre cells whose centreFactor makes it cost-worse, so
 * the gate keeps the stagger). This is deliberate — it's the same gate that stops
 * the smoother re-hugging the bank — but it leaves a jagged line down the centre.
 *
 * Douglas–Peucker fixes that GEOMETRICALLY (cost-blind): keep the max-deviation
 * point at every real bend, drop the staircase noise within tolerance. A chord
 * may collapse ONLY when every sampled cell is UNMARKED, CONFIDENT water — i.e.
 * the water this fix governs:
 *   • marked cells (preferred FAIRWY/DRGARE OR a mark-governed disc) are NEVER
 *     simplified — they are already smoothed against their gate discipline and
 *     must stay byte-identical (the seamanship/golden corpus);
 *   • caution (< 0) and land (NaN) fail the guard, so a chord is never cut across
 *     a shoal or a bank, and a cost-optimal shoal detour is preserved.
 * (We key on the water class, NOT centreFactor > 1: a WIDE channel's flat-centre
 * cells read factor 1 yet are exactly where the route rides and staggers.)
 * The bounded tolerance means the collapsed chord stays on the centreline — it can
 * only remove deviation, never add it toward a wall.
 */
export function deStaggerCentred(
    grid: NavGrid,
    path: { x: number; y: number }[],
    toleranceCells = DESTAGGER_TOLERANCE_CELLS,
): { x: number; y: number }[] {
    if (path.length < 3) return path;
    const w = grid.width;
    const h = grid.height;
    const collapsible = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        if (n === 0) return true;
        for (let t = 0; t <= n; t++) {
            const x = Math.round(a.x + ((b.x - a.x) * t) / n);
            const y = Math.round(a.y + ((b.y - a.y) * t) / n);
            if (x < 0 || y < 0 || x >= w || y >= h) return false;
            const idx = y * w + x;
            // Unmarked, confident, CONFINED water only.
            if (Number.isNaN(grid.cells[idx]) || grid.cells[idx] < 0) return false; // land / caution
            if (grid.preferred[idx] === 1) return false; // FAIRWY / DRGARE
            if (grid.markGoverned?.[idx] === 1) return false; // mark-governed disc
            // A real channel (incl. a wide channel's flat-centre), NOT an open
            // approach — so a bar run / coastal leg is never straightened. Cached
            // grids lacking the mask fall back to the centreFactor gradient.
            if (grid.confined) {
                if (grid.confined[idx] !== 1) return false;
            } else if (grid.centreFactor && grid.centreFactor[idx] <= 1) {
                return false;
            }
            // Don't reshape the route hard against a caution shoal: if any cell on
            // the chord ABUTS caution, leave smoothPath's careful geometry — else a
            // straightened approach re-enters a bar at a different point and picks
            // up an extra shallow cell (the Tangalooma lock-in). Land neighbours are
            // fine (a narrow canal abuts its banks everywhere).
            if (
                (x > 0 && grid.cells[idx - 1] < 0) ||
                (x < w - 1 && grid.cells[idx + 1] < 0) ||
                (y > 0 && grid.cells[idx - w] < 0) ||
                (y < h - 1 && grid.cells[idx + w] < 0)
            )
                return false;
        }
        return true;
    };
    const keep = new Uint8Array(path.length);
    keep[0] = 1;
    keep[path.length - 1] = 1;
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
            const dev = Math.abs((path[k].x - a.x) * dy - (path[k].y - a.y) * dx) / len;
            if (dev > maxDev) {
                maxDev = dev;
                maxIdx = k;
            }
        }
        if (maxDev <= toleranceCells && collapsible(a, b)) continue;
        keep[maxIdx] = 1;
        stack.push([lo, maxIdx]);
        stack.push([maxIdx, hi]);
    }
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < path.length; i++) if (keep[i]) out.push(path[i]);
    return out;
}

// ── Fairing across midpoint-disc sequences ──────────────────────────

/** Bounded cost give-back for fairing: a chord may replace a subpath
 *  costing up to this factor LESS — the explicit, documented carve-out
 *  from smoothPath's cost-no-worse rule, safe because the gate-serving
 *  test below makes wrong-siding structurally impossible. Calibrated on
 *  the stepping fixture (bead-hop ratios ≈ 1.12-1.15); the gate-shortcut
 *  dog-leg's erase ratio is ≥ ~3×, far outside it. */
export const FAIRING_MAX_COST_FACTOR = 1.25;
/** A faired chord must pass within this fraction of each served gate's
 *  half-width — margin against 50 m cell quantisation. */
export const FAIRING_GATE_FRACTION = 0.9;

/** The Pass-5 channel midpoints (orchestrator Step 4) with their real
 *  gate half-widths — the fairing pass's gate-serving truth. */
export function collectFairingMidpoints(layers: InshoreLayers): FairingMidpoint[] {
    const out: FairingMidpoint[] = [];
    const scan = (features: unknown[] | undefined): void => {
        for (const f of (features ?? []) as Array<{
            geometry?: { type?: string; coordinates?: [number, number] } | null;
            properties?: { _class?: string; _pairDistanceM?: number } | null;
        }>) {
            if (f.properties?._class !== 'channel_midpoint') continue;
            const pairDistM = f.properties._pairDistanceM;
            if (typeof pairDistM !== 'number' || pairDistM <= 0) continue;
            if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
            const [lon, lat] = f.geometry.coordinates;
            out.push({ lat, lon, halfWidthM: pairDistM / 2 });
        }
    };
    scan(layers.BOYLAT?.features as unknown[]);
    scan(layers.BCNLAT?.features as unknown[]);
    return out;
}

/**
 * Collapse waypoint subpaths to chords across midpoint-disc sequences
 * (the marker-stepping fix — see the call site for doctrine). Greedy
 * longest-chord like smoothPath; a chord is accepted only when
 *   (a) every chord cell is navigable, non-caution, and not excluded
 *       (strict no-evidence cells via `isExcluded`);
 *   (b) every midpoint the SUBPATH served (within its own half-width)
 *       is still within FAIRING_GATE_FRACTION × half-width of the chord;
 *   (c) chordCost ≤ subpathCost × FAIRING_MAX_COST_FACTOR.
 */
export function fairPath(
    grid: NavGrid,
    chain: { x: number; y: number }[],
    midpoints: FairingMidpoint[],
    isExcluded: (idx: number) => boolean,
): { x: number; y: number }[] {
    if (chain.length < 3) return chain;
    const mPerLonG = mPerDegLon(grid.minLat + (grid.height * grid.dLat) / 2);
    // Cell side in metres — the grid's resolvable precision. Used to floor
    // the gate-serving tolerance below (sub-grid gates carry no side the
    // raster can express). Mirrors line ~2437 (tryMarinaCenterline).
    const gridResM = grid.dLat * M_PER_DEG_LAT;
    const toLL = (c: { x: number; y: number }): [number, number] => [
        grid.minLon + (c.x + 0.5) * grid.dLon,
        grid.minLat + (c.y + 0.5) * grid.dLat,
    ];
    const distToSegM = (m: FairingMidpoint, a: [number, number], b: [number, number]): number => {
        const ax = (a[0] - m.lon) * mPerLonG;
        const ay = (a[1] - m.lat) * M_PER_DEG_LAT;
        const bx = (b[0] - m.lon) * mPerLonG;
        const by = (b[1] - m.lat) * M_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        return Math.hypot(ax + dx * t, ay + dy * t);
    };
    const distToChainM = (m: FairingMidpoint, lo: number, hi: number): number => {
        let best = Infinity;
        for (let k = lo; k < hi; k++) {
            const d = distToSegM(m, toLL(chain[k]), toLL(chain[k + 1]));
            if (d < best) best = d;
        }
        return best;
    };
    const chordClear = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
        for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
            const idx = c.y * grid.width + c.x;
            const d = grid.cells[idx];
            if (Number.isNaN(d) || d < 0 || isExcluded(idx)) return false;
        }
        return true;
    };
    const prefix: number[] = [0];
    for (let k = 1; k < chain.length; k++) {
        prefix.push(prefix[k - 1] + chainCostM(grid, [chain[k - 1], chain[k]]));
    }

    const out: { x: number; y: number }[] = [chain[0]];
    let i = 0;
    while (i < chain.length - 1) {
        let j = chain.length - 1;
        for (; j > i + 1; j--) {
            if (!chordClear(chain[i], chain[j])) continue;
            const chord = Array.from(bresenhamCells(chain[i].x, chain[i].y, chain[j].x, chain[j].y));
            const chordCost = chainCostM(grid, chord);
            if (chordCost > (prefix[j] - prefix[i]) * FAIRING_MAX_COST_FACTOR + 1e-6) continue;
            // Gate-serving: every midpoint the subpath served must stay
            // served by the chord.
            const a = toLL(chain[i]);
            const b = toLL(chain[j]);
            let serves = true;
            for (const m of midpoints) {
                if (distToChainM(m, i, j) > m.halfWidthM) continue; // subpath didn't serve it
                // Sub-grid gates (half-width < cell) can't be sided more
                // tightly than the raster resolves, so floor the serving
                // tolerance at half a cell. INERT for resolvable gates
                // (half-width ≥ ~gridResM/1.8 keeps the tight 0.9 guard),
                // so wrong-siding stays impossible — see fairing-subgrid
                // fixture + reply 30 proof.
                const tolM = Math.max(m.halfWidthM * FAIRING_GATE_FRACTION, gridResM * 0.5);
                if (distToSegM(m, a, b) > tolM) {
                    serves = false;
                    break;
                }
            }
            if (serves) break;
        }
        out.push(chain[j]);
        i = j;
    }
    return out;
}

// ── Marina-centerline refinement (MarinerEE port) ───────────────────
//
// Re-routes a CLEAN-water A* corridor with the centerline pipeline
// (services/marinaCenterline.ts): rides mid-channel with keel clearance
// and comes out as straight legs. Used only when the A* corridor has no
// caution cells — the marina/canal/clean-bay case — so marginal-water
// routes that must stay RED (the Brisbane bar) keep their tuned path.
// Returns the centerline waypoints (cells), or null to fall back to
// smoothPath (over-eroded / disconnected at the keel margin / leg
// validation failed → never fabricate, always defer to the proven A*).

/** Keel-clearance margin in cells, derived from the grid resolution.
 *  Target ~5 m off a wall (the spike's 3 px ≈ 5 m), min 1 cell so even a
 *  coarse grid keeps the route off the immediate bank. */
export function keelCellsFor(resolutionM: number): number {
    const KEEL_M = 5;
    return Math.max(1, Math.round(KEEL_M / Math.max(1, resolutionM)));
}

/**
 * Clearance-aware Douglas-Peucker for the marina centerline. Collapses a
 * run of cells to a straight chord ONLY when that chord (a) stays within
 * tolerance of every intermediate point AND (b) crosses no land/caution
 * cell. So grid stair-steps on the straights flatten to clean diagonals,
 * but a corner — even a gentle one whose apex sits within the tolerance —
 * is never shaved, because the shortcut chord would clip the bank and the
 * clearance test forces the split. Operates in CELL space.
 */
export function simplifyMarinaCells(cells: { x: number; y: number }[], grid: NavGrid): { x: number; y: number }[] {
    if (cells.length < 3) return cells.slice();
    const TOL = 1.6; // cells — generous; the clearance check is the safety net
    const chordClear = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
        for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
            const d = grid.cells[c.y * grid.width + c.x];
            if (Number.isNaN(d) || d < 0) return false;
        }
        return true;
    };
    const out: { x: number; y: number }[] = [];
    const rec = (lo: number, hi: number): void => {
        if (hi <= lo + 1) {
            out.push(cells[lo]);
            return;
        }
        const a = cells[lo];
        const b = cells[hi];
        let maxDev = 0;
        let idx = lo;
        for (let i = lo + 1; i < hi; i++) {
            const dev = perpendicularDistanceDeg([cells[i].x, cells[i].y], [a.x, a.y], [b.x, b.y]);
            if (dev > maxDev) {
                maxDev = dev;
                idx = i;
            }
        }
        if (maxDev <= TOL && chordClear(a, b)) {
            out.push(cells[lo]); // chord is safe + straight enough → drop the middle
        } else {
            rec(lo, idx);
            rec(idx, hi);
        }
    };
    rec(0, cells.length - 1);
    out.push(cells[cells.length - 1]);
    return out;
}

export function tryMarinaCenterline(
    grid: NavGrid,
    start: { x: number; y: number },
    end: { x: number; y: number },
): { x: number; y: number }[] | null {
    // Actual metres-per-cell from the built grid (req.resolutionM is
    // optional; the grid's dLat is the ground truth).
    const resolutionM = grid.dLat * M_PER_DEG_LAT;
    // Build a depth array for the centerline pass: only CONFIDENT water is
    // navigable. NaN (land/hazard) and negative (CAUTION) → blocked; 0
    // (unknown/open) → nominal 1 m; positive → charted depth. Caution is
    // blocked here because the centerline route is the "clean" route; any
    // route that needs to touch caution water stays on the A* path with
    // its red flags.
    const n = grid.width * grid.height;
    const depth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const d = grid.cells[i];
        depth[i] = Number.isNaN(d) || d < 0 ? NaN : d === 0 ? 1.0 : d;
    }

    const result = routeMarina(depth, { width: grid.width, height: grid.height }, start as Cell, end as Cell, {
        keelCells: keelCellsFor(resolutionM),
        depthWeight: 15.0,
        canalHalfWidthCells: 12,
        bias: 5.0,
    });
    if (!result) return null;

    // Return the raw mid-channel centerline CELLS, not routeMarina's
    // string-pulled waypoints. The engine's downstream Douglas-Peucker
    // (¼-cell tolerance) simplifies these shape-preservingly — straight
    // legs on straight runs — but, unlike the greedy line-of-sight
    // string-pull, it NEVER shortcuts across a bend's inside corner (which
    // shaved the canal corners). The cells all sit in the keel-eroded graph
    // by construction; belt-and-braces check that none is land/caution.
    const cells = result.cells;
    for (const c of cells) {
        const d = grid.cells[c.y * grid.width + c.x];
        if (Number.isNaN(d) || d < 0) return null;
    }
    // De-staircase BEFORE returning, but CLEARANCE-AWARE so it never shaves
    // a corner. The raw centerline steps N/S/E/W (a "staticy" stairstep on
    // diagonals); plain Douglas-Peucker smooths it but at a tolerance loose
    // enough to remove the stairs it ALSO cuts a gentle bend whose apex sits
    // within tolerance. simplifyMarinaCells collapses a stair-run to a
    // straight chord ONLY when that chord stays in clear water — any chord
    // that would clip land/caution is split and kept. Clean diagonals on the
    // straights, every corner honoured.
    return simplifyMarinaCells(cells, grid);
}
