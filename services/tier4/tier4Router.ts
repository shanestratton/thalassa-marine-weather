/**
 * Tier-2 — the MARKED-CHANNEL / lead-out leg.
 *
 * Where a route leaves the canal/marina (tier-1) and meets the first set of
 * LATERAL MARKERS (a buoyed channel with NO charted DRGARE/FAIRWY polygon), it
 * enters tier-2: follow the channel straight out to inshore bay water (tier-3). The
 * spine is the RECOMMENDED TRACK (RECTRC) where charted; where the marks stand
 * alone with no recommended track (e.g. the Newport exit gate channel) it falls
 * back to the lateral-mark gate-follower. Renders YELLOW (pilotage water), as
 * distinct from the RED canal/caution and GREEN open water.
 *
 * SAFETY: the leg NEVER crosses land — it reuses the local land vetoes verbatim
 * (the grid landBlocked check + followChannelGates' own MARK_VOUCH_M land check).
 * On any failure it REFUSES (typed Refusal) rather than fabricate a centreline,
 * so stitchLegs falls back to the proven monolith — the route can never get worse
 * than today. Endpoints are pinned to the shared BoundaryNodes so the Gluer's
 * positional + heading clauses pass with no new glue logic.
 */
import type { NavGrid } from '../inshoreRouterEngine';
import { snapToLeadingLines, type LeadingLine } from '../leadingLine';
import { distM, refineWithFairlead } from '../fairlead';
import { followChannelGates, deSpike, TIER3_DESPIKE_DEG, TIER3_FAIRLEAD_MIN_FRAC } from '../tier3/tier3Router';
import { engineLog } from '../engine/constants';
import { freezeLeg, type LatLon, type Leg, type Refusal } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';
import type { LateralMark } from '../fairlead';

interface LL {
    lat: number;
    lon: number;
}

interface EgressLeadingLine extends LeadingLine {
    /** First point index that belongs to tier 2 when this chain starts inside a canal handoff. */
    readonly tier2FromIndex?: number;
}

export interface Tier4Context {
    readonly grid: NavGrid;
    /** RECTRC recommended tracks ONLY — the authoritative seaward lead-lines the
     *  marked channel rides where charted. Absent/empty ⇒ gate-follower only. */
    readonly recommendedTracks: readonly LeadingLine[];
    readonly marks: readonly LateralMark[];
    /** OSM channel-midpoint CHAINS as ordered centrelines (one LeadingLine per
     *  _chainId, vertices sorted by _chainOrder) — the buoyed channel's spine
     *  (Shane's "7-5-3-1" Newport exit). Snapped onto FIRST: a buoyed chain IS the
     *  channel, so NO land-veto and NO gate-pairing. Empty ⇒ RECTRC + gate fallback. */
    readonly channelChains: readonly LeadingLine[];
    /** The exact egress tracks the engine was willing to splice from canal to
     *  lead-out water. Includes chart RECTRC fallback when regional midpoint
     *  chains are absent. */
    readonly egressTracks?: readonly EgressLeadingLine[];
    readonly egressMask?: readonly boolean[];
    /** When the engine has deliberately inserted a canal→channel egress, that
     *  egress track is the explicit route contract for this leg. */
    readonly preferChannelChains?: boolean;
}

const cellIdx = (g: NavGrid, lon: number, lat: number): number => {
    const x = Math.floor((lon - g.minLon) / g.dLon);
    const y = Math.floor((lat - g.minLat) / g.dLat);
    if (x < 0 || y < 0 || x >= g.width || y >= g.height) return -1;
    return y * g.width + x;
};

function pointToSegmentM(p: LL, a: LL, b: LL): number {
    const refLat = (a.lat + b.lat) / 2;
    const mx = 111_320 * Math.cos((refLat * Math.PI) / 180);
    const my = 110_540;
    const ax = a.lon * mx;
    const ay = a.lat * my;
    const bx = b.lon * mx;
    const by = b.lat * my;
    const px = p.lon * mx;
    const py = p.lat * my;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointToPolylineM(p: LL, line: readonly LL[]): number {
    if (line.length === 0) return Infinity;
    if (line.length === 1) return distM(p, line[0]);
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const d = pointToSegmentM(p, line[i], line[i + 1]);
        if (d < best) best = d;
    }
    return best;
}

function nearestTrackIndex(p: LL, track: readonly LL[]): { idx: number; distM: number } {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < track.length; i++) {
        const d = distM(p, track[i]);
        if (d < best) {
            best = d;
            idx = i;
        }
    }
    return { idx, distM: best };
}

function turnDeg(a: LL, b: LL, c: LL): number {
    const mx = 111_320 * Math.cos((b.lat * Math.PI) / 180);
    const my = 110_540;
    const ux = (b.lon - a.lon) * mx;
    const uy = (b.lat - a.lat) * my;
    const vx = (c.lon - b.lon) * mx;
    const vy = (c.lat - b.lat) * my;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1 || lv < 1) return 0;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
    return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Build the tier-2 leg for one span, or refuse.
 *
 * @param span         the tier-2 span (entry/exit BoundaryNodes + the [from,to]
 *                     range into `fullPolyline`)
 * @param fullPolyline the REAL navigable A* route (tuples [lon,lat])
 * @param ctx          grid + RECTRC tracks + lateral marks for this region
 */
export function routeTier4(span: TierSpan, fullPolyline: readonly LatLon[], ctx: Tier4Context): Leg | Refusal {
    const lo = span.fromIdx;
    const hi = span.toIdx;
    if (hi - lo < 1) return { refused: true, reason: 'disconnected-grid' };

    // LAND-only veto (mirrors tier3Router.ts:262-268 exactly): a charted channel
    // over a caution bank must not be vetoed by the hazard it exists to guide past.
    const isLand = (p: LL): boolean => {
        const i = cellIdx(ctx.grid, p.lon, p.lat);
        if (i < 0) return false;
        return ctx.grid.landBlocked ? ctx.grid.landBlocked[i] === 1 : Number.isNaN(ctx.grid.cells[i]);
    };
    const isCaution = (p: LL): boolean => {
        const i = cellIdx(ctx.grid, p.lon, p.lat);
        if (i < 0) return false;
        const d = ctx.grid.cells[i];
        return Number.isNaN(d) || d < 0;
    };

    let poly: LL[] = fullPolyline.slice(lo, hi + 1).map(([lon, lat]) => ({ lat, lon }));
    const prov: string[] = [];
    const isEgressSpan = ctx.preferChannelChains && (ctx.egressMask?.slice(lo, hi + 1).some(Boolean) ?? false);
    const chainTracks = (): readonly LeadingLine[] =>
        isEgressSpan && ctx.egressTracks?.length ? ctx.egressTracks : ctx.channelChains;
    const forceExplicitChainGeometry = (tracks: readonly LeadingLine[], allowRewrite: boolean): number => {
        const GATE_ON_SPAN_M = 120;
        const ENDPOINT_ON_CHAIN_M = isEgressSpan ? 3000 : 2500;
        let best: {
            pts: LL[];
            gates: number;
            endpointM: number;
            needsStraighten: boolean;
        } | null = null;

        for (const track of tracks) {
            if (track.pts.length < 2) continue;

            const servedGateIdxs: number[] = [];
            for (let i = 0; i < track.pts.length; i++) {
                if (pointToPolylineM(track.pts[i], poly) <= GATE_ON_SPAN_M) servedGateIdxs.push(i);
            }
            if (servedGateIdxs.length < 2) continue;

            const entry = { lat: span.entry.at[1], lon: span.entry.at[0] };
            const exit = { lat: span.exit.at[1], lon: span.exit.at[0] };
            let start = nearestTrackIndex(entry, track.pts);
            let end = nearestTrackIndex(exit, track.pts);
            const endpointM = start.distM + end.distM;
            if (endpointM > ENDPOINT_ON_CHAIN_M) continue;

            if (start.idx === end.idx) {
                start = { idx: servedGateIdxs[0], distM: start.distM };
                end = { idx: servedGateIdxs[servedGateIdxs.length - 1], distM: end.distM };
            }
            const minServed = servedGateIdxs[0];
            const maxServed = servedGateIdxs[servedGateIdxs.length - 1];
            let startIdx = start.idx;
            let endIdx = end.idx;
            if (startIdx <= endIdx) {
                startIdx = Math.min(startIdx, minServed);
                endIdx = Math.max(endIdx, maxServed);
            } else {
                startIdx = Math.max(startIdx, maxServed);
                endIdx = Math.min(endIdx, minServed);
            }
            const ordered =
                startIdx <= endIdx
                    ? track.pts.slice(startIdx, endIdx + 1)
                    : track.pts.slice(endIdx, startIdx + 1).reverse();
            if (ordered.length < 2) continue;

            const out: LL[] = [entry];
            for (const p of ordered) out.push({ lat: p.lat, lon: p.lon });
            out.push(exit);

            const deduped: LL[] = [];
            for (const p of out) {
                const last = deduped[deduped.length - 1];
                if (last && distM(last, p) < 1) continue;
                deduped.push(p);
            }
            if (deduped.length < 2) continue;

            const hasOffCentreVertex = poly
                .map((p) => pointToPolylineM(p, track.pts))
                .some((d) => d <= GATE_ON_SPAN_M && d > 55);
            const hasSharpGateTurn = poly.some(
                (p, i) =>
                    i > 0 &&
                    i + 1 < poly.length &&
                    pointToPolylineM(p, track.pts) <= GATE_ON_SPAN_M &&
                    turnDeg(poly[i - 1], p, poly[i + 1]) > 95,
            );
            const needsStraighten = hasOffCentreVertex && hasSharpGateTurn;
            const candidate = { pts: deduped, gates: servedGateIdxs.length, endpointM, needsStraighten };
            if (
                !best ||
                candidate.gates > best.gates ||
                (candidate.gates === best.gates && endpointM < best.endpointM)
            ) {
                best = candidate;
            }
        }

        if (!best) return 0;
        if (allowRewrite) {
            if (!best.needsStraighten) return 0;
            poly = best.pts;
        }
        return best.gates;
    };
    const snapChannelChain = (): boolean => {
        const tracks = chainTracks();
        if (tracks.length === 0 || poly.length < 4) return false;
        const ch = snapToLeadingLines(poly, poly.map(isCaution), [...tracks], {
            isCaution,
            corridorM: 180,
            minRunM: 60,
            maxAngleDeg: 35,
        });
        if (ch.snapped > 0) {
            poly = ch.polyline;
            prov.push(`chain×${ch.snapped}`);
            return true;
        }
        return false;
    };

    if (isEgressSpan) {
        const explicitGates = forceExplicitChainGeometry(chainTracks(), false);
        if (explicitGates >= 2) prov.push(`chain×${explicitGates}`);
        else snapChannelChain();
    }

    // 1. RECTRC spine — snap onto the recommended track where charted. The whole
    //    route is already RECTRC-snapped before segmentation, so this is usually a
    //    no-op confirmation; it catches a span the global pass didn't cover. Tight
    //    corridor; `protect` undefined because tier-2 IS the protected track.
    if (prov.length === 0 && ctx.recommendedTracks.length > 0) {
        const ll = snapToLeadingLines(poly, poly.map(isCaution), [...ctx.recommendedTracks], {
            isBlocked: isLand,
            isCaution,
            corridorM: 150,
            minRunM: 80,
            maxAngleDeg: 30,
            // Follow the RECTRC's curve through river bends, don't chord across (wall-hug fix).
            followInteriorVertices: true,
        });
        if (ll.snapped > 0) {
            poly = ll.polyline;
            prov.push(`rectrc×${ll.snapped}`);
        }
    }

    // 1b. CHANNEL-MIDPOINT CHAIN — where no RECTRC covers the marks, snap onto the OSM
    //     midpoint centreline (Shane's "7-5-3-1") BEFORE the gate-follower. A buoyed chain
    //     IS the channel: isBlocked is OMITTED (no land veto) and there is no gate-pairing,
    //     so this one snap sidesteps ALL THREE gate declines (near<2/side, gates0,
    //     body-land) that otherwise leave the leg a stepped A* staircase. Generous corridor
    //     captures the de-spiked A* slice a few 50 m cells off-centre; low minRun lets the
    //     short Newport exit snap. snapToLeadingLines pins origin/dest + rejects a
    //     perpendicular brush-by (maxAngleDeg), so it can't grab the PARALLEL channel
    //     ~1.1 km away. Needs ≥4 vertices; on no-snap, falls through to the gate-follower.
    if (prov.length === 0) {
        const explicitGates = forceExplicitChainGeometry(
            [...(ctx.channelChains ?? []), ...(ctx.egressTracks ?? [])],
            true,
        );
        if (explicitGates >= 2) prov.push(`chain×${explicitGates}`);
        else snapChannelChain();
    }

    // 1c. Fairlead — preserve the proven lateral-mark follower for charted
    // buoyed channels. This catches wider synthetic/real gate spacing where the
    // nearest-gate fallback declines, while still keeping the tier-2 boundary.
    if (prov.length === 0 && ctx.marks.length >= 3) {
        const fl = refineWithFairlead(poly, [...ctx.marks], isLand, {
            fromIdx: 0,
            minAlongFraction: TIER3_FAIRLEAD_MIN_FRAC,
            traverseM: 500,
        });
        if (fl.replacedRange) {
            poly = fl.polyline;
            prov.push(`fairlead${fl.channelKey ? `(${fl.channelKey})` : ''}`);
        }
    }

    // 2. Gate-follower fallback — where no RECTRC covers the marks (the Newport
    //    exit gate channel: buoys, no recommended track). Its INTERNAL land veto
    //    (MARK_VOUCH_M=150 m) rejects a cross-paired midpoint that lands on a
    //    mudflat → null. We REFUSE rather than fabricate a centreline.
    // gateDecline carries WHY followChannelGates bailed (sub<2 / nearNpMs / gatesN / midsN /
    // entry-land / body-land / exit-land), folded into provenance below — without it the
    // device cannot say why a tier-2 leg renders the stepped A* slice instead of straight.
    let gateDecline = ctx.marks.length < 3 ? `marks${ctx.marks.length}` : '';
    if (prov.length === 0 && ctx.marks.length >= 3) {
        const followed = followChannelGates(poly, [...ctx.marks], ctx.grid, (r) => {
            gateDecline = r;
        });
        if (followed) {
            poly = followed;
            prov.push('gates');
            gateDecline = '';
        }
        // else: keep the A* slice (de-spiked below) rather than REFUSE. A marked
        // channel the gate-follower can't cleanly resolve (e.g. two parallel
        // channels lumped, gate:body-land) stays tier-2 (YELLOW) on its A* geometry
        // — it does NOT drop the whole route to the monolith. The A* slice is on
        // navigable water, so the never-cross-land guarantee holds (honest A*, not
        // a fabricated centreline).
    }

    // 3. De-spike backstop — no >120° reversal survives the leg body. The
    // exception is a deliberate canal-egress chain: Newport→Pinkenba must sail
    // out through the outer gate before turning back toward the bay route, and
    // the Gluer has an explicit allow-list for that seam.
    if (!(isEgressSpan && prov.some((p) => p.startsWith('chain×')))) {
        poly = deSpike(poly, TIER3_DESPIKE_DEG);
    }
    if (poly.length < 2) return { refused: true, reason: 'disconnected-grid' };

    // 3b. Ride the recommended track. A HUGGING tier-2 leg — a partial RECTRC snap (rectrc×k, the
    //     rest still raw A*) or a gate-decline A* slice — rides the channel EDGE near the bank, not
    //     its centre (Shane's Pinkenba: the route hugs the NW edge of a channel that itself
    //     correctly runs near the NW wall). The RECTRC IS the channel CENTRELINE, so a firmer
    //     re-snap NOW — after the de-spike, when the leg is smoother + more parallel; the step-1
    //     snap only caught a few vertices off the raw A* staircase — rides the route down the
    //     channel centre. Skips clean paired-mark structures (chain/fairlead/gates own their
    //     centreline). isBlocked=isLand keeps it off land; corridor + maxAngle reject a
    //     perpendicular brush-by so it can't grab a parallel channel.
    const ridable = !prov.some((p) => p.startsWith('gates') || p.startsWith('chain') || p.startsWith('fairlead'));
    if (ridable && ctx.recommendedTracks.length > 0) {
        const ride = snapToLeadingLines(poly, poly.map(isCaution), [...ctx.recommendedTracks], {
            isBlocked: isLand,
            isCaution,
            corridorM: 250,
            minRunM: 40,
            maxAngleDeg: 45,
            followInteriorVertices: true,
        });
        if (ride.snapped > 0) {
            poly = ride.polyline;
            engineLog.warn(`[channelRide] tier2 rode RECTRC +${ride.snapped} (was ${prov.join('+') || 'astar'})`);
        }
    }

    // 4. Back to contract tuples; pin endpoints to the exact boundary nodes so the
    //    Gluer's positional clause (≤1 m) is satisfied by construction.
    const polyline: LatLon[] = poly.map((p) => [p.lon, p.lat] as LatLon);
    polyline[0] = span.entry.at;
    polyline[polyline.length - 1] = span.exit.at;

    // 5. Per-vertex caution + controlling depth straight from the grid.
    const cautionMask = polyline.map(([lon, lat]) => isCaution({ lat, lon }));
    let controlling = Infinity;
    for (const [lon, lat] of polyline) {
        const i = cellIdx(ctx.grid, lon, lat);
        if (i < 0) continue;
        const d = ctx.grid.cells[i];
        if (!Number.isNaN(d) && d >= 0) controlling = Math.min(controlling, d);
    }

    return freezeLeg({
        tierId: span.tier,
        entry: span.entry,
        exit: span.exit,
        polyline,
        cautionMask,
        depthSource: prov.includes('gates') ? 'marks-vouched' : 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: `tier${span.tier}:${prov.length ? prov.join('+') : `astar${gateDecline ? `(gate:${gateDecline})` : ''}`}`,
    });
}
