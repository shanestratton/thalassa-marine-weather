/**
 * Split a duration in hours into whole days and whole hours — rounding ONCE.
 *
 * Four passage components each did `Math.floor(h / 24)` days and then
 * `Math.round(h % 24)` hours, so 47.7 h printed as "1d 24h" and 23.6 h as
 * "24h" (audit 2026-09-02). Rounding the total first and then splitting makes
 * "24h" impossible: 47.7 → 48 → 2d 0h, 23.6 → 24 → 1d 0h.
 */
export function splitDaysHours(hours: number): { days: number; hours: number } {
    const total = Math.max(0, Math.round(hours));
    return { days: Math.floor(total / 24), hours: total % 24 };
}
