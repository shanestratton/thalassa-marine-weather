/**
 * circularStats — small, tested helpers for averaging and comparing bearings.
 *
 * Compass bearings are circular: 350° and 10° are 20° apart, not 340°, and
 * their mean is 0°, not 180°. Arithmetic mean / min–max / subtraction all give
 * nonsense answers on a wrapped axis, so wind *direction* must never be treated
 * like a linear quantity (wind speed, temperature, etc.).
 */

const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/**
 * Vector (mean-of-angles) mean of a set of bearings in degrees, 0..360.
 * Returns null for an empty set, or when the vectors cancel exactly (a
 * perfectly opposed pair has no defined mean direction).
 */
export function circularMean(degs: Array<number | null | undefined>): number | null {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const d of degs) {
        if (d == null || !Number.isFinite(d)) continue;
        const r = (d * Math.PI) / 180;
        sx += Math.cos(r);
        sy += Math.sin(r);
        n++;
    }
    if (n === 0) return null;
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return null; // vectors cancel — undefined
    return norm360((Math.atan2(sy, sx) * 180) / Math.PI);
}

/**
 * Signed smallest rotation from bearing `from` to bearing `to`, in (-180, 180].
 * Positive = clockwise (the wind is veering); negative = anticlockwise (backing).
 */
export function circularDelta(from: number, to: number): number {
    return ((norm360(to) - norm360(from) + 540) % 360) - 180;
}

export type DirectionShift = 'veering' | 'backing' | 'steady';

/**
 * How the wind direction is shifting from `from` to `to`.
 * - veering  = turning clockwise (e.g. S → SW → W) — the meteorological term.
 * - backing  = turning anticlockwise (e.g. S → SE → E).
 * - steady   = change smaller than `thresholdDeg` either way.
 * Returns null if either bearing is missing.
 */
export function directionShift(
    from: number | null | undefined,
    to: number | null | undefined,
    thresholdDeg = 15,
): DirectionShift | null {
    if (from == null || !Number.isFinite(from) || to == null || !Number.isFinite(to)) return null;
    const d = circularDelta(from, to);
    if (Math.abs(d) < thresholdDeg) return 'steady';
    return d > 0 ? 'veering' : 'backing';
}
