/**
 * Route segmentation — docs/THREE_TIER_ROUTING.md §2 (+ §6 red-team fix).
 *
 * The ONLY place tiers are chosen. It classifies a route into ordered tier
 * spans; it does not route. Routers never decide "should I act here" — that
 * silent-passthrough decision (the 0.59-vs-0.60 Newport channel skip) is
 * deleted at the source.
 *
 * RED-TEAM FATAL FIX: classify the REAL navigable polyline (the engine's A*
 * output), NOT the straight origin→dest rhumb. The navigable corridor bows
 * off the rhumb to follow the dredged channel around drying flats (Newport→
 * Murrarie is 22.26 NM navigable vs ~13 NM straight across ~10 NM of Bramble
 * Bay flats); classifying the straight line would refuse a working route.
 *
 * Pure. Reads the existing cached NavGrid (cells = depth, preferred = FAIRWY/
 * DRGARE channel, unvouched = no-evidence) + parsed lateral marks. No new ENC
 * fetch, no second grid build.
 */

import { UNCHARTED_MAX_RUN_M, type NavGrid } from '../inshoreRouterEngine';
import type { LateralMark } from '../fairlead';
import { tier2NavigableDepthM } from '../tier2/depthThreshold';
import type { BoundaryNode, LatLon, Refusal, TierId } from './legContract';

const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Within this of a lateral mark ⇒ inside a marked channel ⇒ tier 3. Wide
 *  enough that a mid-channel route between longitudinally-spaced marks stays
 *  ONE contiguous tier-3 span (200 m fragmented the Newport approach into
 *  short t3/t2 flickers, starving fairlead's along-transit gate — field
 *  finding 2026-06-17). The tier-2 deep crossing sits >300 m off any channel
 *  mark, so this does not steal the open-bay leg. */
export const TIER3_MARK_PROXIMITY_M = 300;
/** A routable-tier span shorter than this is absorbed into its neighbour
 *  (kills single-cell flapping at band edges — the same noise that beads A*).
 *  An UNKNOWN span is NEVER absorbed — a red patch always survives. */
export const MIN_SPAN_M = 300;

type Cls = 1 | 2 | 3 | 'unknown';

export interface TierSpan {
    readonly tier: TierId;
    readonly entry: BoundaryNode;
    readonly exit: BoundaryNode;
    /** Inclusive polyline vertex range. */
    readonly fromIdx: number;
    readonly toIdx: number;
    /** The span crosses caution (red) water somewhere. */
    readonly caution: boolean;
}

const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    Math.hypot((bLon - aLon) * mPerLonAt(aLat), (bLat - aLat) * M_PER_LAT);

const cellIdx = (grid: NavGrid, lon: number, lat: number): number => {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
    return y * grid.width + x;
};

const bearingDeg = (a: LatLon, b: LatLon): number => {
    const deg = (Math.atan2((b[0] - a[0]) * mPerLonAt(a[1]), (b[1] - a[1]) * M_PER_LAT) * 180) / Math.PI;
    return (deg + 360) % 360;
};

/**
 * Classify each vertex of the REAL navigable route, run-length-encode into
 * contiguous tier spans (hysteresis-smoothed), refuse on a long uncharted run,
 * and resolve the boundary nodes between spans.
 */
export function segmentRoute(
    polyline: readonly LatLon[],
    grid: NavGrid,
    marks: readonly LateralMark[],
    draftM: number,
    safetyM: number,
    tideSafetyM: number,
    opts: { refuseUnchartedRunM?: number | null } = {},
): TierSpan[] | Refusal {
    if (polyline.length < 2) {
        return { refused: true, reason: 'disconnected-grid' };
    }
    // null ⇒ NEVER refuse on a long unknown run — emit it as a caution span and
    // let the caller's own uncharted handling decide (the live engine already
    // runs a strict-uncharted sweep on the final geometry). Default keeps the
    // standalone refusal.
    const refuseUnchartedRunM = opts.refuseUnchartedRunM === undefined ? UNCHARTED_MAX_RUN_M : opts.refuseUnchartedRunM;
    const TIER2 = tier2NavigableDepthM(draftM, tideSafetyM);
    const draftFloor = draftM + safetyM;

    // ── 1. Classify each vertex (priority tier-3 > tier-1 > tier-2 > unknown) ──
    const cls: Cls[] = polyline.map(([lon, lat]) => {
        const idx = cellIdx(grid, lon, lat);
        const nearMark = marks.some((m) => distM(lat, lon, m.lat, m.lon) < TIER3_MARK_PROXIMITY_M);
        const preferred = idx >= 0 && grid.preferred?.[idx] === 1;
        if (nearMark || preferred) return 3; // marked/dredged channel — tier 3
        if (idx < 0) return 1; // off the ENC grid → offshore (GEBCO-only)
        const d = grid.cells[idx];
        // RED-TEAM: no-evidence is grid.unvouched (paired with UNKNOWN_OPEN=0),
        // NOT NaN. NaN just means "no DEPARE polygon" (may be OSM-vouched deep).
        if (grid.unvouched?.[idx] === 1 && d === 0) return 'unknown';
        if (!Number.isNaN(d) && d >= draftFloor) return 2; // navigable deep water
        return 'unknown'; // shallow/blocked yet on the route → flag, never clean
    });

    // Caution per vertex: tier-2 below the marks-free floor, or unknown.
    const cautionV: boolean[] = polyline.map(([lon, lat], i) => {
        if (cls[i] === 'unknown') return true;
        const idx = cellIdx(grid, lon, lat);
        if (idx < 0) return false;
        const d = grid.cells[idx];
        return Number.isNaN(d) || d < TIER2; // red where shallower than the marks-free band
    });

    // ── 2. Cumulative distance, for metre-based hysteresis ──
    const cum: number[] = [0];
    for (let i = 1; i < polyline.length; i++) {
        cum.push(cum[i - 1] + distM(polyline[i - 1][1], polyline[i - 1][0], polyline[i][1], polyline[i][0]));
    }
    const spanLenM = (lo: number, hi: number): number => cum[hi] - cum[lo];

    // ── 3. Hysteresis — absorb short ROUTABLE runs into a neighbour; never
    //       absorb an UNKNOWN run (a red patch always survives) ──
    let runs = encode(cls);
    let changed = true;
    while (changed && runs.length > 1) {
        changed = false;
        for (let r = 0; r < runs.length; r++) {
            const run = runs[r];
            if (run.cls === 'unknown') continue;
            if (spanLenM(run.lo, run.hi) >= MIN_SPAN_M) continue;
            // Absorb into the longer adjacent ROUTABLE neighbour (prefer prev).
            const prev = runs[r - 1];
            const next = runs[r + 1];
            const target = pickNeighbour(prev, next, spanLenM);
            if (!target) continue;
            for (let i = run.lo; i <= run.hi; i++) cls[i] = target;
            changed = true;
            break;
        }
        if (changed) runs = encode(cls);
    }

    // ── 4. Refuse a long uncharted run BEFORE any router sees the span ──
    if (refuseUnchartedRunM !== null) {
        for (const run of runs) {
            if (run.cls === 'unknown' && spanLenM(run.lo, run.hi) > refuseUnchartedRunM) {
                return { refused: true, reason: 'uncharted-run', atNM: cum[run.lo] / 1852 };
            }
        }
    }

    // Coalesce a single-vertex FIRST run into its neighbour. Boundary-sharing
    // (§5) makes span r start at runs[r-1].hi, so only the FIRST span can be
    // degenerate (fromIdx===toIdx) — when run 0 is one vertex (e.g. a berth-side
    // mark before the route drops into unvouched canal water). Merge it forward
    // so no tier router is handed a zero-length span.
    if (runs.length > 1 && runs[0].lo === runs[0].hi) {
        runs[1] = { ...runs[1], lo: runs[0].lo };
        runs.shift();
    }

    // ── 5. Resolve boundary nodes + emit ordered spans ──
    // Adjacent spans SHARE the seam vertex: span r's entry sits on the PREVIOUS
    // run's last vertex (runs[r-1].hi), which is exactly span r-1's exit. So
    // span(r-1).exit.at === span(r).entry.at (same polyline vertex) and the
    // Gluer's positional clause (≤1 m) holds. Without this, RLE runs are
    // disjoint (gap of one segment between spans) and every seam refuses
    // 'boundary-gap'. The shared vertex carries the prior tier's classification
    // but that's just the seam — its tier router pins it to the boundary node.
    const out: TierSpan[] = [];
    for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        const tier: TierId = run.cls === 'unknown' ? 2 : run.cls; // unknown rides tier-2 (red)
        const isFirst = r === 0;
        const isLast = r === runs.length - 1;
        const fromIdx = isFirst ? run.lo : runs[r - 1].hi; // share the previous span's exit vertex
        const toIdx = run.hi;
        const entry = boundaryNode(
            polyline,
            grid,
            fromIdx,
            isFirst ? 'origin' : kindFor(runs[r - 1].cls, run.cls),
            true,
        );
        const exit = boundaryNode(polyline, grid, toIdx, isLast ? 'dest' : kindFor(run.cls, runs[r + 1].cls), false);
        out.push({
            tier,
            entry,
            exit,
            fromIdx,
            toIdx,
            caution: cautionV.slice(fromIdx, toIdx + 1).some(Boolean),
        });
    }
    return out;
}

interface Run {
    cls: Cls;
    lo: number;
    hi: number;
}
function encode(cls: Cls[]): Run[] {
    const runs: Run[] = [];
    for (let i = 0; i < cls.length; i++) {
        const last = runs[runs.length - 1];
        if (last && last.cls === cls[i]) last.hi = i;
        else runs.push({ cls: cls[i], lo: i, hi: i });
    }
    return runs;
}

function pickNeighbour(
    prev: Run | undefined,
    next: Run | undefined,
    len: (lo: number, hi: number) => number,
): Cls | null {
    const pOk = prev && prev.cls !== 'unknown';
    const nOk = next && next.cls !== 'unknown';
    if (pOk && nOk) return len(prev.lo, prev.hi) >= len(next.lo, next.hi) ? prev.cls : next.cls;
    if (pOk) return prev.cls;
    if (nOk) return next.cls;
    return null;
}

function kindFor(from: Cls, to: Cls): BoundaryNode['kind'] {
    if (from === 1 || to === 1) return 'shelf-edge';
    if (from === 3 && to !== 3) return 'last-lead'; // leaving a channel
    if (to === 3) return 'channel-mouth'; // entering a channel
    return 'channel-mouth';
}

function boundaryNode(
    polyline: readonly LatLon[],
    grid: NavGrid,
    idx: number,
    kind: BoundaryNode['kind'],
    outbound: boolean,
): BoundaryNode {
    const at = polyline[idx];
    // Outbound heading THROUGH the node — bearing of the segment leaving it.
    const ref = outbound ? Math.min(idx + 1, polyline.length - 1) : idx;
    const refPrev = outbound ? idx : Math.max(idx - 1, 0);
    const headingDeg = bearingDeg(polyline[refPrev], polyline[ref]);
    const ci = cellIdx(grid, at[0], at[1]);
    const d = ci >= 0 ? grid.cells[ci] : NaN;
    return {
        at,
        headingDeg,
        kind,
        depthM: Number.isNaN(d) ? null : d,
        snapped: true,
    };
}
