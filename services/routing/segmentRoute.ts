/**
 * Four-tier route segmentation.
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

import { UNCHARTED_MAX_RUN_M } from '../engine/constants';
import type { NavGrid } from '../engine/types';
import type { LateralMark } from '../fairlead';
import { tier2NavigableDepthM } from '../tier2/depthThreshold';
import type { BoundaryNode, LatLon, Refusal, TierId } from './legContract';

const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Within this of a lateral mark ⇒ inside a marked channel ⇒ tier 2. Wide
 *  enough that a mid-channel route between longitudinally-spaced marks stays
 *  ONE contiguous tier-2 span (200 m fragmented the Newport approach into
 *  short t3/t2 flickers, starving fairlead's along-transit gate — field
 *  finding 2026-06-17). Newport's buoyed EXIT gates are 700-800 m apart
 *  along-channel, so a route vertex midway between two gates sits ~400 m from
 *  the nearest individual mark; 300 m flickered the exit RED/YELLOW between
 *  gates (field finding 2026-06-21, reproduced on real ENC). 450 m bridges the
 *  widest measured mid-gate gap into ONE contiguous tier-2 span. The open bay
 *  is NO LONGER protected by this distance (a bay vertex can be <450 m from a
 *  scattered buoy) but by the tier-2 channelWater conjunction below
 *  (nearMark && (preferred||injected)) — open water is never preferred/injected,
 *  so it stays tier-3 regardless of nearby buoys. */
export const TIER3_MARK_PROXIMITY_M = 450;
/** A routable-tier span shorter than this is absorbed into its neighbour
 *  (kills single-cell flapping at band edges — the same noise that beads A*).
 *  An UNKNOWN span is NEVER absorbed — a red patch always survives. */
export const MIN_SPAN_M = 300;
/** After the LAST forced canal-egress gate, the marked channel must END (Shane: "from
 *  the last pair of markers the line turns teal"). The Newport exit's injected/dredged
 *  (channel-water) flag — and scattered marks — bleed past the fixed 675 m egress-tail
 *  window, keeping the bay side YELLOW. Suppress the contiguous exit-corridor run (channel
 *  water OR near a mark) past the last gate until the first GENUINE open-bay vertex.
 *  EXIT_TAIL_MAX_M hard-caps the run so it can never reach a DISTANT marked channel (e.g.
 *  the Brisbane River by the dest, ~10 km on), which keeps its tier-2. */
export const EXIT_TAIL_MAX_M = 5000;

type Cls = 1 | 2 | 3 | 4 | 'unknown';

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

interface SegmentRouteOptions {
    readonly refuseUnchartedRunM?: number | null;
    /** Vertices deliberately spliced onto an authoritative lead-out track. */
    readonly forceTier2?: readonly boolean[];
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
    opts: SegmentRouteOptions = {},
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
    const forceTier2 = opts.forceTier2 ?? [];

    // Cumulative distance, used by both egress-tail suppression and span-length
    // hysteresis below.
    const cum: number[] = [0];
    for (let i = 1; i < polyline.length; i++) {
        cum.push(cum[i - 1] + distM(polyline[i - 1][1], polyline[i - 1][0], polyline[i][1], polyline[i][0]));
    }
    const spanLenM = (lo: number, hi: number): number => cum[hi] - cum[lo];

    // A forced canal-egress chain is authoritative tier 2 up to the final gate.
    // The first few bridge vertices after that last gate can still sit inside
    // the same injected/preferred marker corridor, which used to spawn a second
    // stray yellow span in the bay. Suppress those egress-only channel hints on
    // the OPEN-WATER side of the forced run; the canal side stays tier 1.
    const forcedIdxs = forceTier2.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const egressCanalTailV: boolean[] = new Array(polyline.length).fill(false);
    const egressOpenTailV: boolean[] = new Array(polyline.length).fill(false);
    // Extends egressOpenTailV along the contiguous channel-water run after the LAST gate
    // (bounded by the open bay / a hard cap) so the YELLOW marked channel ends AT the gate
    // even when the exit's injected/dredged water bleeds past the fixed 675 m window.
    const egressOpenTailAllV: boolean[] = new Array(polyline.length).fill(false);
    // A vertex still inside the exit's marked corridor: on channel-water (dredged/injected)
    // OR within reach of a lateral mark. The egress-open-tail suppression walks the
    // contiguous such run past the last gate and stops at the first GENUINE open-bay vertex
    // (neither) — a per-vertex bound that survives the long sparse bridge segments the gate
    // hands to (the 24→25 segment was 1.77 km, so a distance-gap bound broke instantly).
    const inExitCorridor = (i: number): boolean => {
        const idx = cellIdx(grid, polyline[i][0], polyline[i][1]);
        if (idx >= 0 && (grid.preferred?.[idx] === 1 || grid.injectedCanal?.[idx] === 1)) return true;
        const [lon, lat] = polyline[i];
        return marks.some((m) => distM(lat, lon, m.lat, m.lon) < TIER3_MARK_PROXIMITY_M);
    };
    let forcedCanalSideAtStart: boolean | null = null;
    if (forcedIdxs.length > 0) {
        const firstForced = forcedIdxs[0];
        const lastForced = forcedIdxs[forcedIdxs.length - 1];
        const canalSideAtStart = cum[firstForced] <= cum[polyline.length - 1] - cum[lastForced];
        forcedCanalSideAtStart = canalSideAtStart;
        const suppressM = TIER3_MARK_PROXIMITY_M * 1.5;
        if (canalSideAtStart) {
            for (let i = firstForced - 1; i >= 0 && cum[firstForced] - cum[i] <= suppressM; i--) {
                egressCanalTailV[i] = true;
            }
            for (let i = lastForced + 1; i < polyline.length && cum[i] - cum[lastForced] <= suppressM; i++) {
                egressOpenTailV[i] = true;
            }
            // Open side = forward of the last gate (the bay). End the marked channel here.
            for (let i = lastForced + 1; i < polyline.length; i++) {
                if (cum[i] - cum[lastForced] > EXIT_TAIL_MAX_M || !inExitCorridor(i)) break;
                egressOpenTailAllV[i] = true;
            }
        } else {
            for (let i = lastForced + 1; i < polyline.length && cum[i] - cum[lastForced] <= suppressM; i++) {
                egressCanalTailV[i] = true;
            }
            for (let i = firstForced - 1; i >= 0 && cum[firstForced] - cum[i] <= suppressM; i--) {
                egressOpenTailV[i] = true;
            }
            // Open side = behind the first gate (canal is the arrival end).
            for (let i = firstForced - 1; i >= 0; i--) {
                if (cum[firstForced] - cum[i] > EXIT_TAIL_MAX_M || !inExitCorridor(i)) break;
                egressOpenTailAllV[i] = true;
            }
        }
    }

    // ── 1. Classify each vertex, inside-out per Shane's brief ───────────────
    //   tier 1: canals / marinas
    //   tier 2: lead-out / marked / dredged channels
    //   tier 3: inshore bay / coastal charted water
    //   tier 4: offshore / off-ENC, GEBCO-only water
    // Per-vertex "a channel mark/midpoint within reach", hoisted out because the
    // channel-fill pass (1b) reuses it to coalesce a buoyed channel into one corridor.
    const nearMarkV: boolean[] = polyline.map(([lon, lat], i) =>
        egressCanalTailV[i] || egressOpenTailV[i] || egressOpenTailAllV[i]
            ? false
            : marks.some((m) => distM(lat, lon, m.lat, m.lon) < TIER3_MARK_PROXIMITY_M),
    );
    const cls: Cls[] = polyline.map(([lon, lat], i) => {
        if (forceTier2[i]) return 2;
        const idx = cellIdx(grid, lon, lat);
        const nearMark = nearMarkV[i];
        const preferred =
            idx >= 0 &&
            grid.preferred?.[idx] === 1 &&
            !egressCanalTailV[i] &&
            !egressOpenTailV[i] &&
            !egressOpenTailAllV[i];
        // Injected nearshore canal water (the wide Mapbox-water fill) is
        // canal/marina water, NOT open deep water — it must reach the tier-1
        // canal router even though its synthetic depth (≥ draft+safety) would
        // otherwise read tier-3 here. Keyed on the injected source only, so the
        // open bay (no injectedCanal flag) stays tier-3.
        const injected = idx >= 0 && grid.injectedCanal?.[idx] === 1 && !egressOpenTailV[i] && !egressOpenTailAllV[i];
        // TIER-2 YELLOW = the channel EXITING the canal/marina: it needs either
        // charted channel water (DRGARE/FAIRWY) or lateral marks over channel /
        // injected canal water. Marks beside PLAIN OPEN water — the bay — are NOT
        // a channel: a route merely passing within 450 m of scattered buoys stays
        // tier-3 GREEN (the old "yellow in the open bay" bug). Injected water
        // WITHOUT marks is the marina/canal basin → tier-1 RED canal.
        const channelWater = preferred || injected;
        if (nearMark && channelWater) return 2; // buoyed + charted/canal channel → YELLOW
        if (preferred) return 2; // charted dredged/fairway channel → YELLOW
        if (injected) return 1; // canal/marina basin → RED
        if (idx < 0) return 4; // off the ENC grid → offshore (GEBCO-only)
        const d = grid.cells[idx];
        // RED-TEAM: no-evidence is grid.unvouched (paired with UNKNOWN_OPEN=0),
        // NOT NaN. NaN just means "no DEPARE polygon" (may be OSM-vouched deep).
        if (grid.unvouched?.[idx] === 1 && d === 0) return 'unknown';
        if (!Number.isNaN(d) && d >= draftFloor) return 3; // navigable inshore water
        return 'unknown'; // shallow/blocked yet on the route → flag, never clean
    });

    // ── 1b. CHANNEL FILL — a marked channel is ONE corridor, not a string of gates ──
    // A real buoyed channel has gates 700-800 m apart, and its charted/injected
    // (channelWater) flag is patchy BETWEEN them — so step 1 flickers t2 (at a gate, on
    // channelWater) / t3 (mid-gate, flag dropped) / t1 (channelWater but the nearest mark
    // fell just past reach). That is the stepped RED/YELLOW Shane sees. Coalesce: within a
    // maximal run of nearMark vertices, if ANY vertex reached tier-2, the WHOLE run is that
    // one channel → promote every non-'unknown' vertex to tier-2. The open bay never gets
    // promoted (its vertices are NOT nearMark, OR the run holds no tier-2 because it never
    // had channelWater), so it stays tier-3. 'unknown' (caution) is preserved — a verify-
    // depth patch stays RED even mid-channel.
    for (let i = 0; i < cls.length; ) {
        if (!nearMarkV[i]) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < cls.length && nearMarkV[j + 1]) j++;
        let runHasChannel = false;
        for (let k = i; k <= j; k++) if (cls[k] === 2) runHasChannel = true;
        if (runHasChannel) for (let k = i; k <= j; k++) if (cls[k] !== 'unknown') cls[k] = 2;
        i = j + 1;
    }

    // Caution per vertex: inshore bay water below the marks-free floor, or unknown.
    const cautionV: boolean[] = polyline.map(([lon, lat], i) => {
        if (cls[i] === 'unknown') return true;
        const idx = cellIdx(grid, lon, lat);
        if (idx < 0) return false;
        const d = grid.cells[idx];
        return Number.isNaN(d) || d < TIER2; // red where shallower than the marks-free band
    });

    // ── 3. Hysteresis — absorb short ROUTABLE runs into a neighbour; never
    //       absorb an UNKNOWN run (a red patch always survives) ──
    let runs = encode(cls);
    let changed = true;
    while (changed && runs.length > 1) {
        changed = false;
        for (let r = 0; r < runs.length; r++) {
            const run = runs[r];
            // Never dissolve an UNKNOWN (red patch), tier-1 canal/marina water,
            // or a tier-2 mark-portal. Those are structural boundaries the
            // navigator depends on. Tiny tier-3 gaps inside a patchy channel may
            // still be absorbed into the surrounding tier-2 run.
            const forcedTier2Run =
                run.cls === 2 && forcedIdxs.length > 0 && forceTier2.slice(run.lo, run.hi + 1).some(Boolean);
            const firstForced = forcedIdxs[0] ?? -1;
            const lastForced = forcedIdxs[forcedIdxs.length - 1] ?? -1;
            const egressAdjacentTier2Run =
                run.cls === 2 &&
                forcedIdxs.length > 0 &&
                !forcedTier2Run &&
                ((run.lo > lastForced && cum[run.lo] - cum[lastForced] <= 2500) ||
                    (run.hi < firstForced && cum[firstForced] - cum[run.hi] <= 2500));
            const structuralTier2Run =
                run.cls === 2 && (forcedIdxs.length === 0 || forcedTier2Run || !egressAdjacentTier2Run);
            if (run.cls === 'unknown' || run.cls === 1 || structuralTier2Run) continue;
            if (!egressAdjacentTier2Run && spanLenM(run.lo, run.hi) >= MIN_SPAN_M) continue;
            // Absorb into the longer adjacent ROUTABLE neighbour (prefer prev).
            const prev = runs[r - 1];
            const next = runs[r + 1];
            const target =
                egressAdjacentTier2Run && forcedCanalSideAtStart !== null
                    ? run.lo > lastForced
                        ? forcedCanalSideAtStart
                            ? 3
                            : 1
                        : forcedCanalSideAtStart
                          ? 1
                          : 3
                    : pickNeighbour(prev, next, spanLenM);
            if (!target) continue;
            for (let i = run.lo; i <= run.hi; i++) cls[i] = target;
            changed = true;
            break;
        }
        if (changed) runs = encode(cls);
    }

    // ── 3b. Re-assert the egress-open-tail suppression ──
    // Hysteresis (and the channel-fill before it) can pull a suppressed exit-corridor cell
    // back into the marked-channel (tier-2) run, so the YELLOW bleeds one vertex past the
    // last gate again. egressOpenTailAllV marks the cells that MUST be tier-3 (the bay side
    // of the last gate); force them back so the yellow ends exactly AT the gate.
    if (forcedIdxs.length > 0) {
        let reAsserted = false;
        for (let i = 0; i < cls.length; i++) {
            if (egressOpenTailAllV[i] && cls[i] === 2) {
                cls[i] = 3;
                reAsserted = true;
            }
        }
        if (reAsserted) runs = encode(cls);
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
        const tier: TierId = run.cls === 'unknown' ? 3 : run.cls; // unknown rides tier-3 (red)
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
    if (from === 4 || to === 4) return 'shelf-edge';
    if ((from === 1 && to === 2) || (from === 2 && to === 1)) return 'mark-portal'; // canal/marina ↔ lead-out channel
    if (from === 2 && to === 3) return 'last-lead'; // channel → inshore bay
    if (from === 3 && to === 2) return 'channel-mouth'; // inshore bay → channel
    if (to === 1 || to === 2) return 'channel-mouth'; // entering canal/channel water
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
