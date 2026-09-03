/**
 * DataFreshness — the app's shared "Updated Xm ago" formatter.
 *
 * Why this exists
 * ---------------
 * The scorecard audit on 2026-05-17 flagged error/offline handling as the
 * single biggest UX deduction: the app fetched weather, log data and vessel
 * state but never told the skipper when each surface was last refreshed.
 * Every surface that answers that question now speaks age the same way,
 * through `formatAge`, rather than growing a second formatter.
 *
 * The reusable freshness *pill* that once lived here was removed on
 * 2026-09-03: no surface ever mounted it (the Glass status row and the
 * dashboard badges compose their own markup around `formatAge`), so it was
 * shipping a self-ticking 30 s interval nothing could see. Git history has
 * the markup if a pill is ever wanted again.
 */

/** Format a millisecond delta as a compact, marine-friendly age. */
export function formatAge(ageMs: number): string {
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
