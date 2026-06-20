/**
 * Tier-3 router adapter — docs/THREE_TIER_ROUTING.md §4 (re-home, not rewrite).
 *
 * Re-homes the EXISTING channel refiners (fairlead lateral-mark follow +
 * leading-line transit snap) onto a contract TierSpan. Given a span's two
 * BoundaryNodes + the slice of the REAL A* route between them, it produces a
 * FROZEN Leg (or a typed Refusal). The Gluer then concat-or-refuses.
 *
 * Why this kills the stepping bug CLASS (not just an instance):
 *   - The monolith spliced refiner output SEQUENTIALLY into one shared flat
 *     polyline; each splice silently mutated the prior across a contract-less
 *     boundary, and fairlead's `near/ch.length < minFrac` (the 0.59-vs-0.60
 *     Newport skip) would SILENTLY pass the raw zigzag through → stepping.
 *   - Here, segmentRoute has ALREADY decided this span is tier-3 (it abuts
 *     marks / a preferred channel), so the "should I act here?" decision is
 *     gone. The adapter ENGAGES fairlead with a lowered floor, and — whatever
 *     happens — a >120° reversal can never survive the de-spike backstop. A
 *     tier-3 leg is de-stepped by construction or it refuses; it never emits a
 *     bead-on-a-string zigzag.
 *
 * Pure. New file only — no shared-seam edits (a local de-spike stands in for
 * fairlead's un-exported dropSpikes). Coordinate discipline: the contract uses
 * tuples [lon,lat] (legContract.LatLon); the refiners use {lat,lon} objects —
 * converted at the boundary, never mixed.
 */

import type { NavGrid } from '../inshoreRouterEngine';
import { refineWithFairlead, type LateralMark } from '../fairlead';
import { snapToLeadingLines, type LeadingLine } from '../leadingLine';
import { angularDiff, freezeLeg, type LatLon, type Leg, type Refusal } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';
import { tryFineCanalLeg, type BuildFineGrid } from './fineCanalGrid';

/** {lat,lon} object form the refiners speak. Structurally matches fairlead's +
 *  leadingLine's own LatLon, so the same object satisfies both. */
interface LL {
    lat: number;
    lon: number;
}

/** Max turn (deg) a tier-3 leg body may contain — matches the Gluer's
 *  SEAM_MAX_TURN_DEG and fairlead's reversal limit. Above it = a double-back. */
export const TIER3_DESPIKE_DEG = 120;
/** Fairlead engagement floor for a span segmentRoute ALREADY vouched as tier-3.
 *  Low on purpose: segmentRoute has already decided this span abuts a marked
 *  channel, so fairlead should FOLLOW it even when the span covers only part
 *  of the channel's marks (a short berth-side approach span — field finding
 *  2026-06-17, Newport spans came out tier3:astar at 0.4). The along-transit
 *  + both-endpoints-near + isLand guards inside refineWithFairlead still
 *  prevent engaging a channel the route merely passes. */
export const TIER3_FAIRLEAD_MIN_FRAC = 0.2;

export interface Tier3Context {
    readonly grid: NavGrid;
    readonly marks: readonly LateralMark[];
    readonly leadingLines: readonly LeadingLine[];
    /** Optional: the OFFICIAL recommended tracks (RECTRC) for this region. Where
     *  the span already rides one of these (the hydrographer's centreline,
     *  snapped FIRST in applyThreeTier), the leading-line (NAVLNE) snap is
     *  vetoed for that run so RECTRC wins over the deliberately-off-centre
     *  transit. Absent/empty ⇒ no protection (canals/marinas with no track). */
    readonly recommendedTracks?: readonly LeadingLine[];
    /** Optional: build a fine-resolution NavGrid over a bbox (injected by the
     *  engine, captures buildNavGridCached). When present, a narrow canal span
     *  that no buoyed-channel refiner resolves is re-routed on a fine grid via
     *  the marina centreline solver — the corner-clip cure. Absent ⇒ the span
     *  keeps today's coarse A* slice (behaviour identical), so existing callers
     *  and tests are unaffected. */
    readonly buildFineGrid?: BuildFineGrid;
}

const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

const cellIdx = (grid: NavGrid, lon: number, lat: number): number => {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
    return y * grid.width + x;
};

const bearingDeg = (a: LL, b: LL): number => {
    const deg = (Math.atan2((b.lon - a.lon) * mPerLonAt(a.lat), (b.lat - a.lat) * M_PER_LAT) * 180) / Math.PI;
    return (deg + 360) % 360;
};

/** Remove interior vertices whose deflection exceeds maxTurnDeg (a near-reversal).
 *  Endpoints are pinned. Mirrors fairlead.dropSpikes without importing it (that
 *  symbol isn't exported, and PHASE 2 touches no shared file). */
function deSpike(pts: LL[], maxTurnDeg: number): LL[] {
    if (pts.length < 3) return pts;
    const out = pts.slice();
    let changed = true;
    while (changed && out.length >= 3) {
        changed = false;
        for (let i = 1; i < out.length - 1; i++) {
            const turn = angularDiff(bearingDeg(out[i - 1], out[i]), bearingDeg(out[i], out[i + 1]));
            if (turn > maxTurnDeg) {
                out.splice(i, 1);
                changed = true;
                break;
            }
        }
    }
    return out;
}

const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    Math.hypot((bLon - aLon) * mPerLonAt(aLat), (bLat - aLat) * M_PER_LAT);

/** A port and its across-channel starboard mark are within this. */
const MAX_GATE_M = 500;
/** A mark/gate within this of the span counts as ON the route's channel. */
const FOLLOW_TRAVERSE_M = 500;
/** A point within this of a buoy is navigable by the marks' authority. */
const MARK_VOUCH_M = 150;

/** Perpendicular + along-route distance of point p to polyline `poly` (metres). */
function projectToPoly(p: LL, poly: LL[]): { along: number; perp: number } {
    let bestPerp = Infinity;
    let bestAlong = 0;
    let cum = 0;
    for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const mLon = mPerLonAt(a.lat);
        const bx = (b.lon - a.lon) * mLon;
        const by = (b.lat - a.lat) * M_PER_LAT;
        const px = (p.lon - a.lon) * mLon;
        const py = (p.lat - a.lat) * M_PER_LAT;
        const segLen2 = bx * bx + by * by || 1;
        const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLen2));
        const perp = Math.hypot(px - bx * t, py - by * t);
        const segLen = Math.hypot(bx, by);
        if (perp < bestPerp) {
            bestPerp = perp;
            bestAlong = cum + t * segLen;
        }
        cum += segLen;
    }
    return { along: bestAlong, perp: bestPerp };
}

/**
 * Follow the buoyed channel along a span by pairing each port mark with its
 * NEAREST starboard mark (a gate), taking gate midpoints, and ordering them
 * along the route. This sidesteps BOTH the 'NUM'-key channel lumping AND the
 * port-even/stbd-odd numbering convention that defeat fairlead's seq-based
 * corridorCenterline here — a gate is just the nearest red/green pair, whatever
 * their numbers. Returns the channel centreline (span-endpoints + ordered gate
 * midpoints), or null if there's no followable gate run or it would cross real
 * land far from any buoy. Marks VOUCH for water: a centreline point within
 * MARK_VOUCH_M of a buoy is navigable whatever the coarse grid says, so a
 * narrow buoyed channel the 50 m grid calls land is still followed; a bridge
 * that strays far from the buoys onto landBlocked is rejected.
 */
export function followChannelGates(
    sub: LL[],
    marks: readonly LateralMark[],
    grid: NavGrid,
    onDecline?: (reason: string) => void,
): LL[] | null {
    const decline = (r: string): null => {
        onDecline?.(r);
        return null;
    };
    if (sub.length < 2) return decline('sub<2');
    const near = marks.filter((m) => projectToPoly({ lat: m.lat, lon: m.lon }, sub).perp < FOLLOW_TRAVERSE_M);
    const port = near.filter((m) => m.side === 'port');
    const stbd = near.filter((m) => m.side === 'stbd');
    if (port.length < 2 || stbd.length < 2) return decline(`near${port.length}p${stbd.length}s`);

    const gates: { along: number; mid: LL }[] = [];
    for (const p of port) {
        let best: LateralMark | null = null;
        let bd = MAX_GATE_M;
        for (const s of stbd) {
            const d = distM(p.lat, p.lon, s.lat, s.lon);
            if (d < bd) {
                bd = d;
                best = s;
            }
        }
        if (!best) continue;
        const mid: LL = { lat: (p.lat + best.lat) / 2, lon: (p.lon + best.lon) / 2 };
        gates.push({ along: projectToPoly(mid, sub).along, mid });
    }
    if (gates.length < 2) return decline(`gates${gates.length}`);
    gates.sort((a, b) => a.along - b.along);

    const mids: LL[] = [];
    for (const g of gates) {
        const last = mids[mids.length - 1];
        if (!last || distM(last.lat, last.lon, g.mid.lat, g.mid.lon) > 10) mids.push(g.mid);
    }
    if (mids.length < 2) return decline(`mids${mids.length}`);

    const centre = [sub[0], ...mids, sub[sub.length - 1]];
    // Reject a bridge that strays onto REAL land away from the buoys — but ONLY
    // on the entry/exit STUBS (span-end → first/last gate). The gate-to-gate
    // BODY (a segment between two consecutive lateral-mark gate midpoints) IS the
    // buoyed channel: navigable by the marks' own authority even where the chart
    // paints intertidal LANDARE. Brisbane's channels (e.g. the Newport exit) run
    // over mudflats encoded as LANDARE; vetoing the body on that "land" is what
    // dropped the whole channel and left the span hugging on coarse A*. The marks
    // ARE the authority between their gates, so the body is vouched by construction.
    const buoyVouched = (p: LL): boolean => marks.some((m) => distM(p.lat, p.lon, m.lat, m.lon) < MARK_VOUCH_M);
    const onLand = (p: LL): boolean => {
        const i = cellIdx(grid, p.lon, p.lat);
        return i >= 0 && grid.landBlocked?.[i] === 1;
    };
    for (let i = 0; i < centre.length - 1; i++) {
        // Stub = the first segment (sub[0]→first gate) and the last (last
        // gate→sub[end]); everything between is the buoyed channel body.
        const isStub = i === 0 || i === centre.length - 2;
        if (!isStub) continue;
        const a = centre[i];
        const b = centre[i + 1];
        const segM = distM(a.lat, a.lon, b.lat, b.lon);
        const steps = Math.max(1, Math.ceil(segM / 25));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const q: LL = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
            if (onLand(q) && !buoyVouched(q)) return decline(i === 0 ? 'entry-land' : 'exit-land');
        }
    }
    return centre;
}

/**
 * Build the Tier-3 leg for one span, or refuse.
 *
 * @param span         the tier-3 span (carries entry/exit BoundaryNodes + the
 *                     [fromIdx,toIdx] range into `fullPolyline`)
 * @param fullPolyline the REAL navigable A* route (tuples [lon,lat])
 * @param ctx          grid + lateral marks + leading lines for this region
 */
export function routeTier3(span: TierSpan, fullPolyline: readonly LatLon[], ctx: Tier3Context): Leg | Refusal {
    const lo = span.fromIdx;
    const hi = span.toIdx;
    if (hi - lo < 1) return { refused: true, reason: 'disconnected-grid' };

    const isLand = (p: LL): boolean => {
        const i = cellIdx(ctx.grid, p.lon, p.lat);
        if (i < 0) return false;
        // LAND-only veto (landBlocked when present) — a charted channel over a
        // caution bank must not be vetoed by the hazard it exists to guide past.
        return ctx.grid.landBlocked ? ctx.grid.landBlocked[i] === 1 : Number.isNaN(ctx.grid.cells[i]);
    };
    const isCaution = (p: LL): boolean => {
        const i = cellIdx(ctx.grid, p.lon, p.lat);
        if (i < 0) return false;
        const d = ctx.grid.cells[i];
        return Number.isNaN(d) || d < 0;
    };
    // The A* slice for this span, in {lat,lon} object form for the refiners.
    let poly: LL[] = fullPolyline.slice(lo, hi + 1).map(([lon, lat]) => ({ lat, lon }));
    let vouched = false;
    let usedFineGrid = false;
    const prov: string[] = [];

    // Fine-res canal fallback — where NO buoyed-channel solution applies, a
    // narrow canal/marina span routed on the coarse 50 m grid clips its bends
    // (the ~1-cell-wide canal forces a corner-cutting diagonal). Re-route it on
    // a SEPARATE fine grid with the parity-proven marina centreline solver,
    // whose string-pulled waypoints ride the eroded keel-safe graph (corner-
    // clip-free by construction). Returns false — keeping the coarse A* slice —
    // when no fine grid is injected, the span isn't a canal, or the canal is
    // disconnected at the keel margin (so it can only ever IMPROVE the leg).
    let fineDiag = '';
    const tryFine = (): boolean => {
        if (!ctx.buildFineGrid) return false;
        const att = tryFineCanalLeg(span, fullPolyline, ctx.grid, ctx.buildFineGrid);
        if (!att.leg) {
            fineDiag = att.diag; // 'notnarrow' | 'nogrid' | 'disconnected'
            return false;
        }
        poly = att.leg.polyline.map(([lon, lat]) => ({ lat, lon }));
        vouched = true;
        usedFineGrid = true;
        prov.push(`finegrid:${att.diag}`); // diag = `k<n>`, the keel that connected
        return true;
    };

    // 1. Fairlead — ENGAGE (lowered floor; segmentRoute already vouched tier-3).
    if (ctx.marks.length >= 3) {
        const fl = refineWithFairlead(poly, [...ctx.marks], isLand, {
            fromIdx: 0,
            minAlongFraction: TIER3_FAIRLEAD_MIN_FRAC,
            traverseM: 500,
        });
        // fl.replacedRange null ⇒ the local buoys don't reconstruct into a
        // clean port/stbd channel (the 'NUM'-key lumping + corridorCenterline
        // limitation diagnosed 2026-06-17 — see ROUTING_COLLAB / A's fairlead
        // fix). The span stays de-spiked A*; we do NOT fabricate a centreline.
        if (fl.replacedRange) {
            poly = fl.polyline;
            vouched = true;
            prov.push(`fairlead${fl.channelKey ? `(${fl.channelKey})` : ''}`);
        } else {
            // fairlead declined (lumped 'NUM' channels / numbering convention).
            // Fall back to nearest-gate following — robust to both, and
            // mark-vouched so a narrow buoyed channel the coarse grid calls land
            // is still followed. If THAT declines too, try the fine canal pass.
            let gateDecline = '';
            const followed = followChannelGates(poly, ctx.marks, ctx.grid, (r) => {
                gateDecline = r;
            });
            if (followed) {
                poly = followed;
                vouched = true;
                prov.push('gates');
            } else if (!tryFine()) {
                // Self-diagnosing provenance: WHY no channel follow. `fl-decl` =
                // fairlead's corridorCenterline wandered; `gate:<reason>` = which
                // followChannelGates check bailed (near<2/gates<2/entry-land/…).
                prov.push(`astar(fine=${fineDiag || '?'},fl-decl,gate:${gateDecline})`);
            }
        }
    } else {
        // No buoyed channel here (marks < 3) — try the fine canal pass directly.
        // On decline the span keeps its raw A* slice; the fine reason (if the
        // pass was attempted) is appended to the provenance for on-device diag.
        if (!tryFine() && fineDiag) prov.push(`astar(fine=${fineDiag})`);
    }

    // 2. Leading-line snap — straighten onto any charted transit the span hugs.
    //    Skipped for a fine-grid canal leg: its mid-channel geometry is already
    //    the authoritative route; a lead snap would pull it off the centreline.
    if (!usedFineGrid && ctx.leadingLines.length > 0) {
        const ll = snapToLeadingLines(poly, poly.map(isCaution), [...ctx.leadingLines], {
            isBlocked: isLand,
            isCaution,
            // RECTRC wins over NAVLNE: a run already on the recommended track is
            // protected from being dragged onto an off-centre leading line.
            protect: ctx.recommendedTracks ? [...ctx.recommendedTracks] : undefined,
        });
        if (ll.snapped > 0) {
            poly = ll.polyline;
            vouched = true;
            prov.push(`lead×${ll.snapped}`);
        }
    }

    // 3. De-spike backstop — no >120° reversal survives a tier-3 leg body.
    //    Skipped for the fine-grid leg: the marina solver's string-pulled
    //    centreline is monotonic + clearance-validated, and deSpike could drop a
    //    genuine sharp canal bend (a real >120° dog-leg the canal demands).
    if (!usedFineGrid) {
        poly = deSpike(poly, TIER3_DESPIKE_DEG);
    }
    if (poly.length < 2) return { refused: true, reason: 'disconnected-grid' };

    // 4. Back to contract tuples; pin endpoints to the exact boundary nodes so
    //    the Gluer's positional clause (≤1 m) is satisfied by construction.
    const polyline: LatLon[] = poly.map((p) => [p.lon, p.lat] as LatLon);
    polyline[0] = span.entry.at;
    polyline[polyline.length - 1] = span.exit.at;

    // 5. Per-vertex caution + controlling depth straight from the grid (the
    //    refiners' per-segment masks are not trusted — recomputed = provable).
    const cautionMask = polyline.map(([lon, lat]) => isCaution({ lat, lon }));
    let controlling = Infinity;
    for (const [lon, lat] of polyline) {
        const i = cellIdx(ctx.grid, lon, lat);
        if (i < 0) continue;
        const d = ctx.grid.cells[i];
        if (!Number.isNaN(d) && d >= 0) controlling = Math.min(controlling, d);
    }

    return freezeLeg({
        tierId: 3,
        entry: span.entry,
        exit: span.exit,
        polyline,
        cautionMask,
        depthSource: vouched ? 'marks-vouched' : 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: `tier3:${prov.length ? prov.join('+') : 'astar'}`,
    });
}
