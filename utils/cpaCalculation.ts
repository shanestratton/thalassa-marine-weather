/**
 * CPA / TCPA computation — Closest Point of Approach for AIS collision avoidance.
 *
 * Standard maritime safety calculation:
 *   CPA  = minimum distance (NM) between two vessels if they maintain current course & speed
 *   TCPA = time (minutes) until CPA occurs (negative = vessels are diverging)
 *
 * Reference: COLREGS / ITU-R M.1371-5
 */

const DEG_TO_RAD = Math.PI / 180;
const NM_PER_DEG_LAT = 60; // 1° latitude ≈ 60 NM

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
    risk: 'DANGER' | 'CAUTION' | 'SAFE' | 'NONE';
}

/**
 * Compute CPA and TCPA between own vessel and a target.
 *
 * All positions in decimal degrees, COG in degrees true, SOG in knots.
 * navStatus is the AIS navigational status of the target (optional).
 * Returns null if either vessel has no valid position.
 */
export function computeCpa(
    ownLat: number,
    ownLon: number,
    ownCog: number,
    ownSog: number,
    targetLat: number,
    targetLon: number,
    targetCog: number,
    targetSog: number,
    targetNavStatus?: number,
): CpaResult | null {
    if (!isFinite(ownLat) || !isFinite(ownLon)) return null;
    if (!isFinite(targetLat) || !isFinite(targetLon)) return null;

    // Current distance & bearing
    const distance = haversineNm(ownLat, ownLon, targetLat, targetLon);
    const bearing = initialBearing(ownLat, ownLon, targetLat, targetLon);

    // ── Both vessels stationary → nobody is going anywhere ──
    if (ownSog < 0.5 && targetSog < 0.5) {
        return {
            cpa: distance,
            tcpa: 0,
            distance,
            bearing,
            risk: 'NONE', // Two parked boats can't collide
        };
    }

    // Convert to local Cartesian (NM) relative to own vessel
    const cosLat = Math.cos(ownLat * DEG_TO_RAD);

    // Relative position of target (NM)
    const dx = (targetLon - ownLon) * NM_PER_DEG_LAT * cosLat;
    const dy = (targetLat - ownLat) * NM_PER_DEG_LAT;

    // Velocity components (NM/hour) — COG is clockwise from north
    const ownVx = ownSog * Math.sin(ownCog * DEG_TO_RAD);
    const ownVy = ownSog * Math.cos(ownCog * DEG_TO_RAD);
    const tgtVx = targetSog * Math.sin(targetCog * DEG_TO_RAD);
    const tgtVy = targetSog * Math.cos(targetCog * DEG_TO_RAD);

    // Relative velocity
    const dvx = tgtVx - ownVx;
    const dvy = tgtVy - ownVy;

    const dvSq = dvx * dvx + dvy * dvy;

    let tcpaHours: number;
    let cpa: number;

    if (dvSq < 0.001) {
        // Vessels are on nearly parallel courses at similar speeds
        tcpaHours = 0;
        cpa = distance;
    } else {
        // TCPA = -(Δr · Δv) / |Δv|²
        tcpaHours = -(dx * dvx + dy * dvy) / dvSq;

        // Position at TCPA
        const cpaDx = dx + dvx * tcpaHours;
        const cpaDy = dy + dvy * tcpaHours;
        cpa = Math.sqrt(cpaDx * cpaDx + cpaDy * cpaDy);
    }

    const tcpaMinutes = tcpaHours * 60;

    return {
        cpa: Math.round(cpa * 100) / 100,
        tcpa: Math.round(tcpaMinutes * 10) / 10,
        distance: Math.round(distance * 100) / 100,
        bearing: Math.round(bearing * 10) / 10,
        risk: riskLevel(cpa, tcpaMinutes, ownSog, targetSog, targetNavStatus),
    };
}

/**
 * Determine collision risk level — harbour-aware.
 *
 * Context rules (prevents false alarms in marinas/harbours):
 *  - Target is anchored/moored (nav_status 1, 5, 6) → NONE (they're parked)
 *  - Own vessel stationary (SOG < 0.5) → max CAUTION (awareness, not alarm)
 *  - Diverging (TCPA < 0) or far future (> 60 min) → NONE/SAFE
 *  - Low combined speed (< 3 kn) → relaxed thresholds (harbour speeds)
 *  - Normal underway situation → standard COLREGS thresholds
 */
function riskLevel(
    cpaNm: number,
    tcpaMinutes: number,
    ownSog: number,
    targetSog: number,
    targetNavStatus?: number,
): 'DANGER' | 'CAUTION' | 'SAFE' | 'NONE' {
    // ── Target is anchored, moored, or not under command ──
    const isTargetStationary = targetNavStatus === 1 || targetNavStatus === 5 || targetNavStatus === 6;
    if (isTargetStationary) return 'NONE';

    // ── Diverging or already past ──
    if (tcpaMinutes < 0) return 'NONE';

    // ── More than 60 minutes away ──
    if (tcpaMinutes > 60) return 'SAFE';

    // ── Own vessel is stationary — awareness only, not alarm ──
    if (ownSog < 0.5) {
        // Still show CAUTION if something is barrelling toward us close
        if (cpaNm < 0.2 && tcpaMinutes < 10 && targetSog > 3) return 'CAUTION';
        return 'NONE';
    }

    // ── Low combined speed (harbour / marina / slow manoeuvring) ──
    const combinedSpeed = ownSog + targetSog;
    if (combinedSpeed < 3) {
        // Very relaxed — only warn if really close and imminent
        if (cpaNm < 0.1 && tcpaMinutes < 5) return 'CAUTION';
        return 'SAFE';
    }

    // ── Standard underway COLREGS thresholds ──
    // DANGER: CPA < 0.5 NM within 15 min (imminent close quarters)
    if (cpaNm < 0.5 && tcpaMinutes < 15) return 'DANGER';
    // CAUTION: CPA < 1.0 NM within 30 min
    if (cpaNm < 1.0 && tcpaMinutes < 30) return 'CAUTION';
    // CAUTION: CPA < 0.5 NM within 60 min (approaching close quarters)
    if (cpaNm < 0.5 && tcpaMinutes < 60) return 'CAUTION';
    return 'SAFE';
}

/** Haversine distance in nautical miles */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return c * 3440.065; // Earth radius in NM
}

/** Initial bearing from point 1 to point 2 (degrees true, 0-360) */
function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
    const x =
        Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
        Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
    const brng = Math.atan2(y, x) / DEG_TO_RAD;
    return (brng + 360) % 360;
}
