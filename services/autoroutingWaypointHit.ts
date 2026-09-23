import { AUTOROUTING_TRIAL_MAX_POINTS } from '../types/autorouting';

export interface TrialWaypointHitCandidate {
    /** Zero-based DISPLAY waypoint index, not a full-path vertex index. */
    index: number;
    x: number;
    y: number;
}

/** Permit duplicate rendered world/tile copies, but bound synchronous tap work. */
export const MAX_TRIAL_WAYPOINT_HIT_CANDIDATES = 2 * AUTOROUTING_TRIAL_MAX_POINTS;

/**
 * Select the nearest waypoint centre in a circular 44 px touch target. The
 * caller supplies ONLY projected Point features from the waypoint layer, with
 * its one-based displayed number converted to a zero-based index. Arbitrary
 * chart features must not be turned into candidates by guessing an index.
 *
 * Projection must use the rendered world copy nearest the tap. This function
 * deals only in screen pixels and neither wraps nor reinterprets coordinates.
 * Invalid candidates are ignored; invalid input or excess work returns null.
 * Exact distance ties choose the lowest index independent of feature order.
 */
export function nearestTrialWaypoint(
    candidates: readonly TrialWaypointHitCandidate[],
    point: { x: number; y: number },
    waypointCount: number,
    radiusPx = 22,
): number | null {
    if (
        !Array.isArray(candidates) ||
        candidates.length > MAX_TRIAL_WAYPOINT_HIT_CANDIDATES ||
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isInteger(waypointCount) ||
        waypointCount < 1 ||
        waypointCount > AUTOROUTING_TRIAL_MAX_POINTS ||
        !Number.isFinite(radiusPx) ||
        radiusPx <= 0
    )
        return null;

    let nearest: number | null = null;
    let nearestDistance = radiusPx;
    for (const candidate of candidates) {
        if (
            !candidate ||
            !Number.isInteger(candidate.index) ||
            candidate.index < 0 ||
            candidate.index >= waypointCount ||
            !Number.isFinite(candidate.x) ||
            !Number.isFinite(candidate.y)
        )
            continue;
        // Math.hypot avoids squared-distance overflow for malformed but finite
        // screen values. An overflowed subtraction is Infinity and cannot hit.
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (
            distance < nearestDistance ||
            (distance === nearestDistance && (nearest === null || candidate.index < nearest))
        ) {
            nearest = candidate.index === 0 ? 0 : candidate.index;
            nearestDistance = distance;
        }
    }
    return nearest;
}
