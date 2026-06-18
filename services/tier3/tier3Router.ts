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
import { refineWithFairlead, groupChannels, corridorCenterline, type LateralMark } from '../fairlead';
import { snapToLeadingLines, type LeadingLine } from '../leadingLine';
import { angularDiff, freezeLeg, type LatLon, type Leg, type Refusal } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';

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
/** A point within this of a lateral mark is navigable water by the marks'
 *  own authority — used to stop the grid-NaN land veto refusing a buoyed
 *  channel narrower than a 50 m cell (~channel half-width). */
export const MARK_VOUCH_M = 150;

export interface Tier3Context {
    readonly grid: NavGrid;
    readonly marks: readonly LateralMark[];
    readonly leadingLines: readonly LeadingLine[];
}

const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
    Math.hypot((bLon - aLon) * mPerLonAt(aLat), (bLat - aLat) * M_PER_LAT);

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
    // Marks VOUCH for water. A buoyed channel narrower than a 50 m grid cell
    // reads as NaN (the cell "looks like land"), which made fairlead's isLand
    // veto refuse to follow a real channel (Newport NUM:27 — field finding
    // 2026-06-17: all gates passed except this veto). A centreline point that
    // sits within channel-half-width of a lateral mark IS navigable, whatever
    // the coarse grid says — so trust it. Bridges/centreline FAR from any buoy
    // still hit the real veto (the estate-land catch LNDARE misses).
    const fairleadIsLand = (p: LL): boolean => {
        if (ctx.marks.some((m) => distM(p.lat, p.lon, m.lat, m.lon) < MARK_VOUCH_M)) return false;
        return isLand(p);
    };

    // The A* slice for this span, in {lat,lon} object form for the refiners.
    let poly: LL[] = fullPolyline.slice(lo, hi + 1).map(([lon, lat]) => ({ lat, lon }));
    let vouched = false;
    const prov: string[] = [];

    // 1. Fairlead — ENGAGE (lowered floor; segmentRoute already vouched tier-3).
    if (ctx.marks.length >= 3) {
        const fl = refineWithFairlead(poly, [...ctx.marks], fairleadIsLand, {
            fromIdx: 0,
            minAlongFraction: TIER3_FAIRLEAD_MIN_FRAC,
            traverseM: 500,
        });
        if (fl.replacedRange) {
            poly = fl.polyline;
            vouched = true;
            prov.push(`fairlead${fl.channelKey ? `(${fl.channelKey})` : ''}`);
        } else {
            // declined despite a tier-3 classification — log WHY. For each
            // channel groupChannels finds, report key:size and whether its
            // FIRST and LAST mark sit near this span (f/l). A channel longer
            // than the span reads `…F-` (entry near, exit beyond) → fairlead's
            // both-endpoints-near gate is what's blocking, not minFrac.
            const near = ctx.marks.filter((m) => poly.some((p) => distM(p.lat, p.lon, m.lat, m.lon) < 500)).length;
            const chs = groupChannels([...ctx.marks])
                .map((ch) => {
                    const f = poly.some((p) => distM(p.lat, p.lon, ch[0].lat, ch[0].lon) < 500);
                    const l = poly.some((p) => distM(p.lat, p.lon, ch[ch.length - 1].lat, ch[ch.length - 1].lon) < 500);
                    if (!f && !l) return null; // only channels touching this span
                    const p = ch.filter((m) => m.side === 'port').length;
                    const s = ch.filter((m) => m.side === 'stbd').length;
                    const cl = corridorCenterline(ch).length; // 0 ⇒ one side empty ⇒ fairlead bails
                    return `${ch[0].key}:${ch.length}(p${p}s${s}cl${cl})${f ? 'F' : '-'}${l ? 'L' : '-'}`;
                })
                .filter(Boolean)
                .join(',');
            prov.push(`astar(nm=${near};${chs})`);
        }
    }

    // 2. Leading-line snap — straighten onto any charted transit the span hugs.
    if (ctx.leadingLines.length > 0) {
        const ll = snapToLeadingLines(poly, poly.map(isCaution), [...ctx.leadingLines], {
            isBlocked: isLand,
            isCaution,
        });
        if (ll.snapped > 0) {
            poly = ll.polyline;
            vouched = true;
            prov.push(`lead×${ll.snapped}`);
        }
    }

    // 3. De-spike backstop — no >120° reversal survives a tier-3 leg body.
    poly = deSpike(poly, TIER3_DESPIKE_DEG);
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
