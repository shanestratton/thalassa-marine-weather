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

import type { EncAreaGraze, EncHazardResult, EncHazardType } from './types';

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
 *  confirm clearance, so it must assume the shallowest. Exported so the
 *  within-cell pick (EncSpatialIndex.queryPoint) uses the SAME tiebreak as
 *  the cross-cell merge — the two levels must never disagree. */
export function depthSeverity(minDepthM: number | null): number {
    return minDepthM == null ? Infinity : -minDepthM;
}

/**
 * Compare two hazards by TYPE (worse type wins) then DEPTH (shallower /
 * unknown worse). Returns >0 when A is more severe, <0 when B is, 0 when
 * equal. This is the SINGLE ordering both the within-cell pick
 * (EncSpatialIndex.queryPoint) and the cross-cell fold call, so the two
 * levels are structurally incapable of disagreeing on which hazard is worse.
 */
export function compareHazardSeverity(
    aType: EncHazardType | null | undefined,
    aDepth: number | null,
    bType: EncHazardType | null | undefined,
    bDepth: number | null,
): number {
    const sa = aType ? HAZARD_TYPE_SEVERITY[aType] : -1;
    const sb = bType ? HAZARD_TYPE_SEVERITY[bType] : -1;
    if (sa !== sb) return sa - sb;
    return depthSeverity(aDepth) - depthSeverity(bDepth);
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
        // Both hazards: worse TYPE wins, then shallower/unknown depth — the
        // SAME comparator queryPoint uses for its within-cell pick.
        const c = compareHazardSeverity(a.hazardType, a.minDepthM, b.hazardType, b.minDepthM);
        if (c !== 0) return c;
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

/**
 * True when graze `a` is MORE significant than `b` for the route-wide lateral-
 * clearance advisory: land (drying bank / islet) before shoal/obstruction, then
 * the closest clearance. The ONE graze ordering — shared by the per-cell pick
 * (EncSpatialIndex.segmentAreaGraze), the cross-cell fold (EncHazardService),
 * and the route-wide accumulator (landAvoidance), which hand-mirrored it three
 * ways before (cycle-7 re-audit). Pure + unit-tested.
 */
export function grazeOutranks(a: EncAreaGraze, b: EncAreaGraze): boolean {
    const aLand = a.type === 'land';
    const bLand = b.type === 'land';
    if (aLand !== bLand) return aLand;
    return a.clearanceM < b.clearanceM;
}
