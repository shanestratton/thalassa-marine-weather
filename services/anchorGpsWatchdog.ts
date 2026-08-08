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

/** Consecutive out-of-circle readings required before the drag alarm fires. */
export const ALARM_CONFIRM_COUNT = 3;

/**
 * Drag-confirmation hysteresis (pure). The counter increments on each
 * consecutive out-of-circle reading and DECAYS by one on each inside reading,
 * so a single GPS jitter spike can never trip the alarm — only
 * `confirmCount` genuine breaches do. Returns the next counter and whether the
 * alarm should fire this tick.
 */
export function nextDragState(
    outsideCount: number,
    distanceFromAnchor: number,
    swingRadius: number,
    confirmCount: number = ALARM_CONFIRM_COUNT,
): { outsideCount: number; fire: boolean } {
    const isOutside = distanceFromAnchor > swingRadius;
    if (isOutside) {
        const next = outsideCount + 1;
        return { outsideCount: next, fire: next >= confirmCount };
    }
    return { outsideCount: Math.max(0, outsideCount - 1), fire: false };
}

// ── Why the watch went blind ────────────────────────────────────────────

/** Why a fix was refused by handleGpsUpdate's accuracy/age gates. */
export type GpsRejectReason = 'accuracy' | 'stale' | 'invalid';

export interface GpsRejection {
    source: 'native' | 'nmea';
    reason: GpsRejectReason;
    /** Reported accuracy in metres, when that is what disqualified it. */
    accuracy: number | null;
    at: number;
}

export interface BlindGpsFacts {
    nowMs: number;
    /** Last fix ACCEPTED from each source. */
    lastUsableFixAt: { native: number | null; nmea: number | null };
    /** Most recent fix refused, and why. */
    lastRejection: GpsRejection | null;
    /** Whether the NMEA feed is currently reachable at all. */
    nmeaFeedStatus: 'live' | 'stale' | 'unavailable';
    /** The circle the fix has to be good enough to resolve. */
    swingRadiusM: number;
    /** Accuracy ceiling a fix must beat to be usable. */
    accuracyLimitM: number;
}

const ago = (nowMs: number, thenMs: number | null): string | null => {
    if (thenMs == null) return null;
    const secs = Math.max(0, Math.round((nowMs - thenMs) / 1000));
    if (secs < 90) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};

/**
 * One sentence naming WHY the watch is blind, and what to do about it.
 *
 * "No GPS fix is arriving" is a symptom, and the two causes behind it need
 * opposite responses. A phone indoors produces fixes constantly — they are
 * simply too coarse to resolve a swing circle, and the answer is to get the
 * phone somewhere with sky or lean on the boat's own receiver. A dropped NMEA
 * feed produces no fixes at all, and the answer is to go and look at the
 * gateway. Reporting both as "GPS lost" sent Shane hunting satellites on a
 * boat whose GPS was healthy (2026-08-08).
 *
 * Pure so the wording is testable without a running watch.
 */
export function describeBlindGps(facts: BlindGpsFacts): string {
    const { nowMs, lastUsableFixAt, lastRejection, nmeaFeedStatus, swingRadiusM, accuracyLimitM } = facts;

    // A fix that arrives but is too coarse is the commonest case and the most
    // misread, so it is named first and in the skipper's terms: the number
    // that matters is the accuracy against the circle, not the fix count.
    if (lastRejection?.reason === 'accuracy' && lastRejection.accuracy != null) {
        const where = lastRejection.source === 'nmea' ? 'the boat’s GPS' : 'this phone';
        return (
            `Fixes are arriving from ${where} but they are ±${Math.round(lastRejection.accuracy)} m — ` +
            `too coarse to resolve a ${Math.round(swingRadiusM)} m swing circle (needs better than ` +
            `±${Math.round(accuracyLimitM)} m). Indoors or below deck will do this. ` +
            `Move the phone where it can see sky, or connect the boat’s GPS.`
        );
    }

    const nmeaAgo = ago(nowMs, lastUsableFixAt.nmea);
    const nativeAgo = ago(nowMs, lastUsableFixAt.native);

    if (nmeaFeedStatus === 'unavailable' && lastUsableFixAt.nmea != null) {
        return (
            `The boat’s GPS feed stopped (last fix ${nmeaAgo}) and this phone has not produced a usable one` +
            `${nativeAgo ? ` since ${nativeAgo}` : ' at all'}. Check the NMEA gateway and the phone’s view of the sky.`
        );
    }
    if (nmeaFeedStatus === 'unavailable') {
        return (
            `No NMEA feed, and this phone has not produced a fix good enough to use` +
            `${nativeAgo ? ` since ${nativeAgo}` : ' since the watch was armed'}. ` +
            `Get the phone somewhere with a clear view of the sky, or connect the boat’s GPS.`
        );
    }
    if (nmeaFeedStatus === 'stale') {
        return `The boat’s GPS feed has gone quiet${nmeaAgo ? ` (last fix ${nmeaAgo})` : ''}. Check the NMEA gateway.`;
    }
    return (
        `Fixes have stopped reaching the watch` +
        `${nmeaAgo || nativeAgo ? ` (last usable ${nmeaAgo ?? nativeAgo})` : ''}. Check your position now.`
    );
}
