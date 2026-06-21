/**
 * Tier-4 — the MARKED-CHANNEL leg.
 *
 * Where a route leaves the canal/marina (tier-3) and meets the first set of
 * LATERAL MARKERS (a buoyed channel with NO charted DRGARE/FAIRWY polygon), it
 * enters tier-4: follow the channel straight out to deep water (tier-2). The
 * spine is the RECOMMENDED TRACK (RECTRC) where charted; where the marks stand
 * alone with no recommended track (e.g. the Newport exit gate channel) it falls
 * back to the lateral-mark gate-follower. Renders YELLOW (pilotage water), as
 * distinct from the RED canal/caution and GREEN open water.
 *
 * SAFETY: the leg NEVER crosses land — it reuses the tier-3 land vetoes verbatim
 * (the grid landBlocked check + followChannelGates' own MARK_VOUCH_M land check).
 * On any failure it REFUSES (typed Refusal) rather than fabricate a centreline,
 * so stitchLegs falls back to the proven monolith — the route can never get worse
 * than today. Endpoints are pinned to the shared BoundaryNodes so the Gluer's
 * positional + heading clauses pass with no new glue logic.
 */
import type { NavGrid } from '../inshoreRouterEngine';
import { snapToLeadingLines, type LeadingLine } from '../leadingLine';
import { followChannelGates, deSpike, TIER3_DESPIKE_DEG } from '../tier3/tier3Router';
import { freezeLeg, type LatLon, type Leg, type Refusal } from '../routing/legContract';
import type { TierSpan } from '../routing/segmentRoute';
import type { LateralMark } from '../fairlead';

interface LL {
    lat: number;
    lon: number;
}

export interface Tier4Context {
    readonly grid: NavGrid;
    /** RECTRC recommended tracks ONLY — the authoritative seaward lead-lines the
     *  marked channel rides where charted. Absent/empty ⇒ gate-follower only. */
    readonly recommendedTracks: readonly LeadingLine[];
    readonly marks: readonly LateralMark[];
}

const cellIdx = (g: NavGrid, lon: number, lat: number): number => {
    const x = Math.floor((lon - g.minLon) / g.dLon);
    const y = Math.floor((lat - g.minLat) / g.dLat);
    if (x < 0 || y < 0 || x >= g.width || y >= g.height) return -1;
    return y * g.width + x;
};

/**
 * Build the tier-4 leg for one span, or refuse.
 *
 * @param span         the tier-4 span (entry/exit BoundaryNodes + the [from,to]
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

    // 1. RECTRC spine — snap onto the recommended track where charted. The whole
    //    route is already RECTRC-snapped before segmentation, so this is usually a
    //    no-op confirmation; it catches a span the global pass didn't cover. Tight
    //    corridor; `protect` undefined because tier-4 IS the protected track.
    if (ctx.recommendedTracks.length > 0) {
        const ll = snapToLeadingLines(poly, poly.map(isCaution), [...ctx.recommendedTracks], {
            isBlocked: isLand,
            isCaution,
            corridorM: 150,
            minRunM: 80,
            maxAngleDeg: 30,
        });
        if (ll.snapped > 0) {
            poly = ll.polyline;
            prov.push(`rectrc×${ll.snapped}`);
        }
    }

    // 2. Gate-follower fallback — where no RECTRC covers the marks (the Newport
    //    exit gate channel: buoys, no recommended track). Its INTERNAL land veto
    //    (MARK_VOUCH_M=150 m) rejects a cross-paired midpoint that lands on a
    //    mudflat → null. We REFUSE rather than fabricate a centreline.
    if (prov.length === 0 && ctx.marks.length >= 3) {
        const followed = followChannelGates(poly, [...ctx.marks], ctx.grid);
        if (followed) {
            poly = followed;
            prov.push('gates');
        } else {
            return { refused: true, reason: 'disconnected-grid' };
        }
    }

    // 3. De-spike backstop — no >120° reversal survives the leg body.
    poly = deSpike(poly, TIER3_DESPIKE_DEG);
    if (poly.length < 2) return { refused: true, reason: 'disconnected-grid' };

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
        tierId: 4,
        entry: span.entry,
        exit: span.exit,
        polyline,
        cautionMask,
        depthSource: prov.includes('gates') ? 'marks-vouched' : 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: `tier4:${prov.length ? prov.join('+') : 'astar'}`,
    });
}
