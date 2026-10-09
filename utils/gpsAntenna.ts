/**
 * Where the boat's own GPS antenna is: "GPS antenna to bow" in Settings →
 * Vessel → Dimensions (126-07c). The anchor watch uses it when the boat's GPS
 * (the instruments, or the Pi) marks the anchor. A phone has no fixed place
 * aboard and never uses it.
 *
 * Stored in FEET on the vessel profile (`gpsToBow`), like every other
 * dimension. No default: unset, 0 or implausible means no allowance, exactly
 * the watch as it was.
 */

const METRES_PER_FOOT = 0.3048;

/** The most it may be when the boat's length is not known (metres). */
export const GPS_TO_BOW_MAX_M = 60;

/** The longest it may be, in feet: her length when known, otherwise 60 m. */
function maxFt(lengthFt: number | undefined): number {
    return typeof lengthFt === 'number' && Number.isFinite(lengthFt) && lengthFt > 0
        ? Math.min(lengthFt, GPS_TO_BOW_MAX_M / METRES_PER_FOOT)
        : GPS_TO_BOW_MAX_M / METRES_PER_FOOT;
}

/** An entered figure (feet) kept within 0 and her length (or 60 m). */
export function clampGpsToBowFt(valueFt: number, lengthFt?: number): number {
    if (!Number.isFinite(valueFt) || valueFt <= 0) return 0;
    return Math.round(Math.min(valueFt, maxFt(lengthFt)) * 100) / 100;
}

/**
 * The profile's GPS-antenna-to-bow distance in metres, or 0 when unset or not
 * a number. Never more than her length (a length edited shorter afterwards
 * puts the antenna at her stern), nor 60 m.
 */
export function gpsToBowMetres(vessel: { gpsToBow?: number; length?: number } | null | undefined): number {
    const ft = vessel?.gpsToBow;
    if (typeof ft !== 'number' || !Number.isFinite(ft) || ft <= 0) return 0;
    return Math.min(ft, maxFt(vessel?.length)) * METRES_PER_FOOT;
}
