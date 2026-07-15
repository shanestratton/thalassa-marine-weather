/**
 * hazardSeverity — the ONE ordering of ENC hazard severity, shared by the
 * within-cell pick (EncSpatialIndex.queryPoint) and the across-cell merge
 * (EncHazardService.queryHazards). Keeping it in one place is the fix for
 * the mission-audit finding: queryPoint picked the most-severe hazard
 * WITHIN a cell, but the cross-cell merge kept the FIRST hazard it found —
 * and since candidate cells resolve through an async pool in a
 * nondeterministic order, the reported hazard/depth/provenance for a point
 * covered by overlapping coarse+fine cells was order-dependent (and could
 * under-report the worse of two hazards).
 *
 * Pure + unit-tested.
 */

import type { EncHazardResult, EncHazardType } from './types';

/** Severity ranking of hazard TYPES — land is the hardest stop, shallow
 *  the softest. Used verbatim by queryPoint for its within-cell pick, so
 *  the two levels can never disagree on which hazard is worse. */
export const HAZARD_TYPE_SEVERITY: Record<EncHazardType, number> = {
    land: 5,
    rock: 4,
    wreck: 3,
    obstruction: 2,
    shallow: 1,
    coast: 0, // coastlines live in their own tree; never a point hazard
};

/** Coverage/hazard tier: uncovered < clear water < hazard. */
function tier(r: EncHazardResult): number {
    if (!r.covered) return 0;
    return r.hazard ? 2 : 1;
}

/** Depth severity for the tiebreak among same-type hazards: SHALLOWER is
 *  worse, and a null (unknown) depth is the WORST — the router can't
 *  confirm clearance, so it must assume the shallowest. */
function depthSeverity(minDepthM: number | null): number {
    return minDepthM == null ? Infinity : -minDepthM;
}

/**
 * Total-order comparison of two per-cell results by how dangerous they
 * are: tier (hazard > clear > uncovered), then hazard TYPE, then depth
 * (shallower/unknown worse), then cellId as a final deterministic
 * tiebreak. Returns >0 when `a` is the more severe, <0 when `b` is.
 *
 * The cellId tiebreak makes this a TOTAL order, which makes
 * mergeHazardResults a commutative + associative fold — so the answer is
 * independent of the (nondeterministic) order cells resolve in.
 */
function compareSeverity(a: EncHazardResult, b: EncHazardResult): number {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 2) {
        // Both hazards: worse TYPE wins, then shallower/unknown depth.
        const sa = a.hazardType ? HAZARD_TYPE_SEVERITY[a.hazardType] : -1;
        const sb = b.hazardType ? HAZARD_TYPE_SEVERITY[b.hazardType] : -1;
        if (sa !== sb) return sa - sb;
        const da = depthSeverity(a.minDepthM);
        const db = depthSeverity(b.minDepthM);
        if (da !== db) return da - db;
    }
    // Deterministic provenance tiebreak (never a safety factor). This makes
    // the fold total-ordered — but only because queryHazards folds ONE result
    // per DISTINCT cell, so two folded results never share a cellId. If that
    // invariant ever changes, add catzoc (survey quality) ahead of this.
    return (a.cellId ?? '').localeCompare(b.cellId ?? '');
}

/**
 * Fold two per-cell query results into the MORE SEVERE (most conservative
 * for grounding avoidance) one. Any hazard beats clear water; among
 * hazards the worse type wins, then the shallower/unknown depth. Because
 * compareSeverity is a total order, reducing a point's per-cell results
 * with this is order-independent and always surfaces the worst hazard.
 */
export function mergeHazardResults(a: EncHazardResult, b: EncHazardResult): EncHazardResult {
    return compareSeverity(a, b) >= 0 ? a : b;
}
