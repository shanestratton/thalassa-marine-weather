/**
 * anchorGpsWatchdog — pure GPS-staleness decision for the anchor watch.
 *
 * Drag detection only runs when a fresh, accurate GPS fix arrives
 * (AnchorWatchService.handleGpsUpdate early-returns on poor accuracy). If
 * GPS is lost or stays degraded while watching, `distanceFromAnchor`
 * silently freezes at its last value and the drag alarm can NEVER fire —
 * the exact failure mode an anchor alarm exists to catch.
 *
 * This module is the independent watchdog's decision, kept pure (no
 * Capacitor / timers / I/O) so it can be unit-tested directly and reused
 * by the Bosun Pi side without dragging in the native stack.
 */

/** No usable GPS fix for this long while watching → the watch is blind. */
export const GPS_LOST_THRESHOLD_MS = 90_000;

/**
 * True when the anchor watch has gone blind: no usable GPS fix has been
 * accepted within `thresholdMs`. A blind watch cannot detect dragging, so
 * the caller must raise an alarm rather than leave the skipper staring at a
 * frozen distance reading.
 *
 * @param nowMs              current wall-clock time (Date.now())
 * @param lastUsableFixAtMs  timestamp of the most recent fix that passed the
 *                           accuracy gate, or null if none yet (cold start)
 * @param thresholdMs        staleness budget (defaults to GPS_LOST_THRESHOLD_MS)
 */
export function isAnchorGpsStale(
    nowMs: number,
    lastUsableFixAtMs: number | null,
    thresholdMs: number = GPS_LOST_THRESHOLD_MS,
): boolean {
    if (lastUsableFixAtMs == null) return false;
    return nowMs - lastUsableFixAtMs > thresholdMs;
}
