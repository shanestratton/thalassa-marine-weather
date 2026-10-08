/**
 * CPA / TCPA computation — Closest Point of Approach for AIS collision avoidance.
 *
 * Standard maritime safety calculation:
 *   CPA  = minimum distance (NM) between two vessels if they maintain current course & speed
 *   TCPA = time (minutes) until CPA occurs (negative = vessels are diverging)
 *
 * Reference: COLREGS / ITU-R M.1371-5
 *
 * Build 125 (package 125-01): this is now a thin face on utils/collisionRule.ts,
 * the one rule the popup's chip, the collision alarm and Calypso all use, so
 * the chip can never call DANGER what the alarm stays quiet about (or the
 * other way round). The geometry wraps the antimeridian, and a speed or course
 * that is 'not available' (SOG 102.3, COG 360) or simply unknown gives no CPA
 * at all instead of a CPA computed from a made-up 0.
 */

import {
    DEFAULT_COLLISION_PREFS,
    assessCollision,
    gradeCollisionRisk,
    type CollisionPairName,
    type CollisionPrefs,
    type CollisionRisk,
} from './collisionRule';

export interface CpaResult {
    /** Closest Point of Approach in nautical miles */
    cpa: number;
    /** Time to CPA in minutes (negative = diverging) */
    tcpa: number;
    /** Current distance in nautical miles */
    distance: number;
    /** Bearing from own vessel to target (degrees true) */
    bearing: number;
    /** Risk level based on CPA + TCPA */
    risk: CollisionRisk;
    /** CPA < 0.1 NM and TCPA < 3 min while we're moving: always an alarm. */
    closeQuarters: boolean;
}

/**
 * Compute CPA and TCPA between own vessel and a target.
 *
 * All positions in decimal degrees, COG in degrees true, SOG in knots; pass
 * null for anything unknown. `prefs` is the skipper's threshold pair
 * (Settings → Preferences), defaulting to the recommended one; `reportAgeSec`
 * is the age of the target's report; `ownPair` is the pair in use (the
 * alarm's hysteresis, from resolveOwnMotion), else it follows our speed.
 *
 * Returns null when either position is invalid, or when there is no honest
 * CPA to give: either vessel's motion is unknown, or the report is too old.
 */
export function computeCpa(
    ownLat: number,
    ownLon: number,
    ownCog: number | null,
    ownSog: number | null,
    targetLat: number,
    targetLon: number,
    targetCog: number | null,
    targetSog: number | null,
    targetNavStatus?: number,
    prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS,
    reportAgeSec?: number | null,
    ownPair?: CollisionPairName | null,
): CpaResult | null {
    const a = assessCollision(
        { lat: ownLat, lon: ownLon, sogKn: ownSog, cogDeg: ownCog, pair: ownPair },
        {
            lat: targetLat,
            lon: targetLon,
            sogKn: targetSog,
            cogDeg: targetCog,
            navStatus: targetNavStatus,
            reportAgeSec,
        },
        prefs,
    );
    if (!a || a.rangeOnly || a.cpaNm === null || a.tcpaMin === null) return null;
    return {
        cpa: Math.round(a.cpaNm * 100) / 100,
        tcpa: Math.round(a.tcpaMin * 10) / 10,
        distance: Math.round(a.rangeNm * 100) / 100,
        bearing: Math.round(a.bearingDeg * 10) / 10,
        risk: a.risk,
        closeQuarters: a.closeQuarters,
    };
}

/**
 * Determine collision risk level — harbour-aware, with the skipper's
 * thresholds. The rule itself (and why each line is there) lives in
 * utils/collisionRule.ts → gradeCollisionRisk.
 */
export function riskLevel(
    cpaNm: number,
    tcpaMinutes: number,
    ownSog: number,
    targetSog: number,
    targetNavStatus?: number,
    prefs: CollisionPrefs = DEFAULT_COLLISION_PREFS,
    pair?: CollisionPairName | null,
): CollisionRisk {
    return gradeCollisionRisk(cpaNm, tcpaMinutes, ownSog, targetSog, targetNavStatus, prefs, pair).risk;
}
