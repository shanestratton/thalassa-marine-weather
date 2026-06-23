/**
 * Inshore bay router — tier 3 in Shane's four-tier brief.
 *
 * The marks-free, depth-safe crossing between channels: from "just outside the
 * last lead" to the next channel mouth, over water deep enough to cross
 * UNATTENDED without threading marks — charted depth ≥ tier2NavigableDepthM
 * (5 m all-tide for the Tayana, Shane-confirmed). Marks OFF, depth mask ON,
 * flat geodesic cost (no channel-preference bias — tier 3 is NOT centreline-
 * hugging; it's the shortest deep line, bending only around shoals).
 *
 * Composes marinaCenterline's PROVEN pure grid primitives (snapToMask +
 * solveCenterline at bias 0 = uniform-cost 4-connected shortest path +
 * stringPull line-of-sight, which can't cut a shoal corner because the
 * solver is 4-connected) rather than hand-rolling an A*. New file only — no
 * shared-engine edits.
 *
 * Returns a FROZEN tier-3 Leg or a typed Refusal:
 *   - 'disconnected-grid'    entry/exit off the ENC grid
 *   - 'no-deepwater-corridor' no ≥5 m path connects entry→exit
 *   - 'exit-not-deepwater'   the exit boundary isn't on deep water
 */

import type { NavGrid } from '../inshoreRouterEngine';
import { snapToMask, solveCenterline, stringPull, type Cell, type GridShape } from '../marinaCenterline';
import { tier2NavigableDepthM } from './depthThreshold';
import { freezeLeg, type LatLon, type Leg, type Refusal } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';

/** A boundary node more than this many cells from the nearest deep cell is not
 *  genuinely on tier-3 inshore bay water (≈200 m at the 50 m default grid). */
export const TIER2_MAX_SNAP_CELLS = 4;

export interface Tier2Context {
    readonly grid: NavGrid;
    readonly draftM: number;
    readonly tideSafetyM: number;
}

const cellOf = (grid: NavGrid, lon: number, lat: number): Cell | null => {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
    return { x, y };
};

const cellDist = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y);

const toLatLon = (grid: NavGrid, c: Cell): LatLon => [
    grid.minLon + (c.x + 0.5) * grid.dLon,
    grid.minLat + (c.y + 0.5) * grid.dLat,
];

/**
 * Route one tier-3 span (an inshore deep-water crossing) into a frozen Leg, or refuse.
 *
 * @param span the tier-3 span (entry/exit BoundaryNodes — its polyline range
 *             is NOT followed; tier 3 routes its OWN deep line between the nodes)
 * @param ctx  grid + vessel draft/tide for the depth gate
 */
export function routeTier2(span: TierSpan, ctx: Tier2Context): Leg | Refusal {
    const { grid } = ctx;
    const shape: GridShape = { width: grid.width, height: grid.height };
    const TIER2 = tier2NavigableDepthM(ctx.draftM, ctx.tideSafetyM);

    const entryCell = cellOf(grid, span.entry.at[0], span.entry.at[1]);
    const exitCell = cellOf(grid, span.exit.at[0], span.exit.at[1]);
    if (!entryCell || !exitCell) return { refused: true, reason: 'disconnected-grid' };

    // The deep mask: only charted water ≥ the marks-free floor. Excludes NaN
    // (blocked), <0 (caution), 0 (unknown), and 0<d<5 (too shallow to cross).
    const n = grid.width * grid.height;
    const deep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const d = grid.cells[i];
        if (!Number.isNaN(d) && d >= TIER2) deep[i] = 1;
    }

    // Snap the boundary nodes onto deep water (the boundary sits on the channel
    // side; bay water starts adjacent). A far snap ⇒ the boundary isn't on
    // tier-3 water at all.
    const snStart = snapToMask(deep, shape, entryCell);
    const snEnd = snapToMask(deep, shape, exitCell);
    if (!snStart || cellDist(snStart, entryCell) > TIER2_MAX_SNAP_CELLS) {
        return { refused: true, reason: 'no-deepwater-corridor' };
    }
    if (!snEnd || cellDist(snEnd, exitCell) > TIER2_MAX_SNAP_CELLS) {
        return { refused: true, reason: 'exit-not-deepwater' };
    }

    // Uniform-cost shortest path over the deep mask (bias 0 ⇒ flat geodesic;
    // the distanceField is then irrelevant, so a zero field is correct).
    const flatField = new Float32Array(n);
    const path = solveCenterline(deep, shape, snStart, snEnd, flatField, 1, 0);
    if (!path || path.length === 0) return { refused: true, reason: 'no-deepwater-corridor' };

    const waypoints = stringPull(path, deep, shape);
    const polyline: LatLon[] = waypoints.map((c) => toLatLon(grid, c));
    if (polyline.length === 0) return { refused: true, reason: 'no-deepwater-corridor' };

    // Pin endpoints to the contract boundary nodes (Gluer positional clause).
    polyline[0] = span.entry.at;
    if (polyline.length === 1) polyline.push(span.exit.at);
    else polyline[polyline.length - 1] = span.exit.at;

    // Every cell on the path is ≥ TIER2 by construction → caution-free; the
    // controlling depth is the shallowest deep cell crossed.
    let controlling = Infinity;
    for (const c of path) {
        const d = grid.cells[c.y * grid.width + c.x];
        if (!Number.isNaN(d)) controlling = Math.min(controlling, d);
    }

    return freezeLeg({
        tierId: 3,
        entry: span.entry,
        exit: span.exit,
        polyline,
        cautionMask: polyline.map(() => false),
        depthSource: 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: 'tier3:deepwater',
    });
}
