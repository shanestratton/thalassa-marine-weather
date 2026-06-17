/**
 * Tier-2 depth gate — docs/THREE_TIER_ROUTING.md §1.5.
 *
 * The single named constant of the three-tier split: how deep charted water
 * must be before the router will cut STRAIGHT ACROSS it, marks-free, unattended.
 *
 *   tideSafetyM (0.5 m) is Shane's CONFIRMED rising-tide BAR margin — a
 *   pilotage number for an attended shallow crossing where you watch the tide
 *   and thread the marks. It is NOT the number that licenses skipping the marks.
 *
 *   Skipping the marks needs all-tide clearance without pilotage = the 2×draft
 *   comfort floor (4.8 m for the Tayana's 2.4 m draft), clamped UP to the chart's
 *   banded DEPARE truth — landing on the de-facto 5 m industry contour.
 *
 * Shane-confirmed 5 m all-tide (2026-06-17).
 */

/** Standard DEPARE depth-contour bands (m). DRVAL1 is banded, not continuous,
 *  so the threshold must land ON a band to avoid edge flicker. */
const DEPARE_BANDS = [2, 3, 5, 10, 15, 20, 30, 50] as const;

/** Round a depth UP to the nearest charted DEPARE band. */
export function clampToDepareBand(m: number): number {
    for (const b of DEPARE_BANDS) if (b >= m) return b;
    return DEPARE_BANDS[DEPARE_BANDS.length - 1];
}

/**
 * The marks-free navigable-depth floor for a vessel. Below this, crossing
 * open water without threading marks is not licensed — the water is tier-3's
 * job (a marked/dredged channel) or refused.
 */
export function tier2NavigableDepthM(draftM: number, tideSafetyM: number): number {
    return clampToDepareBand(Math.max(draftM + tideSafetyM, 2 * draftM));
}
