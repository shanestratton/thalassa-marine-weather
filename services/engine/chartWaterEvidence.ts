/**
 * What counts as water where chart land paint says land — decided ONCE, for
 * the nav grid (navGrid Pass 1/2) and the final-route land audit
 * (safetyAudit.auditUnvouchedHardLand), so the independent veto can never
 * vouch for land the grid kept as land (Phase 2a review, 2026-09-30).
 *
 *   • OSM-vouched engineered water (marina, canal, dock, river, the injected
 *     OSM / Mapbox `natural=water` polygons): trusted over chunky LNDARE —
 *     unchanged doctrine.
 *   • An S-57 depth band (DEPARE, or DRGARE — a dredged area's DRVAL1 is its
 *     charted depth): only under owner decision 1 — the finest band on the
 *     spot is charted at a strictly FINER scale than the finest land paint
 *     there, and never dries (services/enc/scaleShadow.ts). A drying,
 *     undepthed, equal-scale, coarser or unranked band leaves the land paint
 *     standing.
 *   • A FAIRWY is a route area, not a depth claim: never water evidence.
 */
import { bandNeverDries, finerBandBeatsLand, finestSurveyOwners, landRankKey } from '../enc/scaleShadow';
import { isS57ChartProps, readS57 } from '../enc/types';

/**
 * Authoritative engineered water from OSM (or injected as OSM water) — the
 * DEPARE features the grid protects against LNDARE bleed. S-57 chart bands
 * (an `acronym`, or the ogr2ogr path's OBJL: isS57ChartProps) are NOT this:
 * they answer to decision 1.
 *
 * `landuse=basin` and `water=basin` are deliberately absent (2026-05-14):
 * suburban OSM tags inland stormwater retention ponds with them; on the
 * Redcliffe Peninsula there are dozens, each one a phantom 3–4 m corridor
 * across land. Real marina basins are `leisure=marina`, real canals
 * `waterway=canal`.
 */
export function isAuthoritativeOsmWater(props: Record<string, unknown> | null | undefined): boolean {
    if (!props || isS57ChartProps(props)) return false;
    const leisure = props['leisure'];
    const waterway = props['waterway'];
    const water = props['water'];
    const natural = props['natural'];
    const harbour = props['harbour'];
    return (
        leisure === 'marina' ||
        waterway === 'dock' ||
        waterway === 'canal' ||
        waterway === 'fairway' ||
        waterway === 'river' ||
        waterway === 'riverbank' ||
        // `water=*` subtags for marina contexts (Newport canals use these
        // for the side arms branching off the main basin)
        water === 'canal' ||
        water === 'harbour' ||
        water === 'marina' ||
        water === 'dock' ||
        water === 'river' ||
        water === 'lake' ||
        // OsmRouteOverlayService injects natural=water polygons into DEPARE
        // for rivers / harbours / basins (and the Mapbox canal fill carries
        // it too): OSM-derived navigable water, authoritative over LNDARE
        // bleed.
        natural === 'water' ||
        harbour === 'yes'
    );
}

/** A chart depth band's claim on a spot: its fineness rank (null =
 * unranked) and whether its charted DRVAL1 never dries. */
export interface BandClaim {
    rank: number | null;
    neverDries: boolean;
}

/** Read an S-57 DEPARE / DRGARE feature's band claim (null: not an S-57
 * band — no acronym or OBJL). */
export function bandClaimOf(props: Record<string, unknown> | null | undefined): BandClaim | null {
    if (!props || !isS57ChartProps(props)) return null;
    const rank = typeof props._scaleRank === 'number' ? props._scaleRank : null;
    const raw = readS57(props, 'DRVAL1');
    return { rank, neverDries: bandNeverDries(typeof raw === 'number' ? raw : null) };
}

/**
 * Decision 1 at one spot, given every S-57 band and every land paint that
 * covers it: does the FINEST band beat the FINEST land paint? The grid's
 * per-cell rule, for a single point:
 *   • land: the finest ranked paint (by landRankKey: a paint known by its
 *     usage band alone counts as that band's finest); any unranked paint
 *     poisons it (unknown);
 *   • bands: the finest ranked band owns the spot with every band tied with
 *     it (scaleShadow surveyRanksTie) — and every owner must never dry; an
 *     unranked band counts only when no ranked band covers the spot, and then
 *     the rank is unknown and cannot beat anything.
 */
export function finestBandBeatsLand(bands: readonly BandClaim[], landRanks: readonly (number | null)[]): boolean {
    if (landRanks.length === 0) return false;
    let land: number | null = -Infinity;
    for (const r of landRanks) {
        if (r === null) {
            land = null;
            break;
        }
        const key = landRankKey(r);
        if (key > (land as number)) land = key;
    }
    if (land === null) return false;
    // The finest ranked band and every band TIED with it own the spot
    // (scaleShadow finestSurveyOwners; round-2 review, 2026-09-30).
    const { owners, rank } = finestSurveyOwners(bands.map((b) => b.rank));
    if (rank === null) return false;
    return owners.every((i) => bands[i].neverDries) && finerBandBeatsLand(rank, land);
}
