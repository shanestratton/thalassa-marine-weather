import { useEffect, useRef, useState } from 'react';

/**
 * Track a compass angle continuously, so a rotating element always takes the
 * SHORT way round.
 *
 * CSS interpolates the number it is given. Hand it a bearing that jumps 359 →
 * 001 and the card spins 358° backwards through south — on a compass that reads
 * as the boat swinging violently, which on a phone clamped to the binnacle is
 * worse than no animation at all. Accumulating the signed delta instead keeps
 * the rendered number monotonic across the wrap: 359 → 361.
 *
 * Returns an angle that may grow without bound; that is deliberate and fine
 * for `rotate()`.
 */
export function useUnwrappedAngle(target: number | null): number {
    const [angle, setAngle] = useState(0);
    const previous = useRef(0);
    useEffect(() => {
        if (target === null || !Number.isFinite(target)) return;
        // Normalise with a true modulo. JS `%` keeps the sign of its left
        // operand, so once the accumulated angle had drifted positive and the
        // target sat near -360, the pre-mod sum went negative, the remainder
        // came out 360 too low, and the card took the LONG way round — a 190°
        // swing for a 10° change of heading (audit 2026-09-02).
        const norm = (x: number) => ((x % 360) + 360) % 360;
        let delta = norm(target - norm(previous.current) + 180); // 0..360
        delta -= 180; // → [-180, 180), the short way
        const next = previous.current + delta;
        previous.current = next;
        setAngle(next);
    }, [target]);
    return angle;
}
