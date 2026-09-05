/**
 * distanceAccrual — the voyage's running distance only grows when the boat
 * has actually moved.
 *
 * Until 2026-09-06 the cumulative total was lastPos.cumulative + the leg to
 * every saved fix. A stationary receiver wobbles 2–5 m between fixes, the
 * buffered-track flush bypasses the ~10 m dedup on purpose (it must preserve
 * the sampler's geometry), and so a yacht ON THE HARD, "following a route"
 * overnight, logged 0.1 NM of pure jitter — enough to keep the "went nowhere"
 * sweep from deleting a track that went nowhere (Shane, 2026-09-06). The same
 * drift added a tenth of a mile to every real voyage per night at anchor.
 *
 * The fix is a DISTANCE ANCHOR kept beside the last position: distance accrues
 * from the anchor, and the anchor moves only when a fix is beyond the gate AND
 * either the boat was already moving or the previous fix was also beyond the
 * gate (two-fix confirmation). A cloud of jitter around a fixed point accrues
 * nothing however long it lasts; a single multipath spike — common in a
 * boatyard, with sheds and masts — is a candidate that the next fix cancels;
 * real sailing confirms on its second fix and then accrues every fix as before,
 * one straightened leg at the start being the only difference.
 *
 * The gate scales with measured GPS quality (GpsPrecision): 8 m on a precision
 * fix, 15 m standard, 30 m degraded. Speed, spike filters, the dedup and the
 * auto-pause clock are untouched — they still see the raw leg. Only the number
 * that decides "did this voyage go anywhere" changes.
 */
import { calculateDistanceNM } from './helpers';

export interface GeoPoint {
    latitude: number;
    longitude: number;
}

/** What the previous stored position carries forward. All optional: legacy records have none. */
export interface AccrualCarry {
    cumulativeDistanceNM: number;
    /** The position distance last accrued FROM. Defaults to the stored position itself. */
    accrualAnchor?: GeoPoint;
    /** One fix beyond the gate, awaiting confirmation by the next. */
    moveCandidate?: GeoPoint;
    /** The previous fix accrued — the boat is under way, no confirmation needed. */
    moving?: boolean;
}

export interface AccrualResult {
    cumulativeDistanceNM: number;
    /** What this fix added — 0 for jitter, a candidate, or a pin. */
    accruedNM: number;
    accrualAnchor: GeoPoint;
    moveCandidate?: GeoPoint;
    moving: boolean;
}

export const DEFAULT_ACCRUAL_GATE_M = 15;
const M_PER_NM = 1852;

/** The gate for the current GPS quality, with a standard-fix default when the tracker offers none. */
export function distanceAccrualGateM(thresholds: { distanceAccrualMinMovementM?: number } | null | undefined): number {
    const m = thresholds?.distanceAccrualMinMovementM;
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : DEFAULT_ACCRUAL_GATE_M;
}

/** A voyage's first fix: the anchor is the fix, nothing has moved yet. */
export function freshAccrual(fix: GeoPoint, cumulativeDistanceNM = 0): AccrualResult {
    return {
        cumulativeDistanceNM,
        accruedNM: 0,
        accrualAnchor: { latitude: fix.latitude, longitude: fix.longitude },
        moving: false,
    };
}

/** Carry a previous state forward unchanged (turn pins mark a PAST position and add nothing). */
export function carryAccrual(prev: AccrualCarry & GeoPoint): AccrualResult {
    return {
        cumulativeDistanceNM: prev.cumulativeDistanceNM,
        accruedNM: 0,
        accrualAnchor: prev.accrualAnchor ?? { latitude: prev.latitude, longitude: prev.longitude },
        moveCandidate: prev.moveCandidate,
        moving: prev.moving === true,
    };
}

export function accrueDistance(prev: AccrualCarry & GeoPoint, fix: GeoPoint, gateM: number): AccrualResult {
    const anchor = prev.accrualAnchor ?? { latitude: prev.latitude, longitude: prev.longitude };
    const fromAnchorNM = calculateDistanceNM(anchor.latitude, anchor.longitude, fix.latitude, fix.longitude);
    const fromAnchorM = fromAnchorNM * M_PER_NM;

    if (fromAnchorM < gateM) {
        // Within the gate of where distance last accrued: jitter, or a boat
        // that has stopped. Nothing accrues, the anchor holds, and any pending
        // candidate is cancelled — the "movement" did not persist.
        return {
            cumulativeDistanceNM: prev.cumulativeDistanceNM,
            accruedNM: 0,
            accrualAnchor: anchor,
            moving: false,
        };
    }

    if (prev.moving === true || prev.moveCandidate) {
        // Confirmed: under way already, or the previous fix was also beyond
        // the gate. Accrue from the anchor and move it here.
        return {
            cumulativeDistanceNM: prev.cumulativeDistanceNM + fromAnchorNM,
            accruedNM: fromAnchorNM,
            accrualAnchor: { latitude: fix.latitude, longitude: fix.longitude },
            moving: true,
        };
    }

    // First fix beyond the gate from a standstill: a candidate, not yet
    // distance. The next fix confirms it or cancels it.
    return {
        cumulativeDistanceNM: prev.cumulativeDistanceNM,
        accruedNM: 0,
        accrualAnchor: anchor,
        moveCandidate: { latitude: fix.latitude, longitude: fix.longitude },
        moving: false,
    };
}

/** The fields a stored position carries so the next fix can continue the accrual. */
export function accrualFields(r: AccrualResult): Pick<AccrualCarry, 'accrualAnchor' | 'moveCandidate' | 'moving'> {
    return { accrualAnchor: r.accrualAnchor, moveCandidate: r.moveCandidate, moving: r.moving };
}
