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
export type GpsRejectReason = 'accuracy' | 'stale' | 'invalid' | 'source-mismatch';

export interface GpsRejection {
    source: 'native' | 'nmea';
    reason: GpsRejectReason;
    /** Reported accuracy in metres, when that is what disqualified it. */
    accuracy: number | null;
    at: number;
    /** For 'source-mismatch': how far the phone was from the vessel's last
     *  known position. */
    separationM?: number;
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

    // The phone is somewhere the boat cannot be. Name this first: it is the
    // only case where going blind is the SAFE outcome, and the skipper needs
    // to understand that the watch refused a fix on purpose rather than
    // failing to get one.
    if (lastRejection?.reason === 'source-mismatch') {
        const km = lastRejection.separationM != null ? lastRejection.separationM / 1000 : null;
        const howFar = km == null ? 'a long way' : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`;
        return (
            `This phone is ${howFar} from where your boat last reported, so its GPS is not being used — ` +
            `it would measure where YOU are, not the boat. The boat’s GPS feed has dropped: check the ` +
            `gateway, or keep a device aboard as the watch host.`
        );
    }

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

// ── Cross-source handover plausibility ──────────────────────────────────

/**
 * The window in which falling back from the boat's GPS to the phone's is a
 * FAILOVER rather than a guess.
 *
 * On the boat the two receivers are metres apart, so when the NMEA feed drops
 * the phone is a sound backup — but only while we still know roughly where the
 * vessel was. Once the boat's last known position is this old, the phone is no
 * longer evidence about the boat; it is evidence about the phone.
 */
export const SOURCE_HANDOVER_WINDOW_MS = 10 * 60_000;

/**
 * Generous drift allowance while the feed was dark: 3 m/s is about 6 knots,
 * faster than any anchored boat drags. Being generous here is deliberate —
 * this guard exists to catch a phone in a different POSTCODE, not to
 * second-guess a boat that moved.
 */
const MAX_DRIFT_MPS = 3;

export interface SourceHandoverCheck {
    /** Metres between the phone's fix and the vessel's last known position. */
    separationM: number;
    /** How far apart they could legitimately be by now. */
    allowanceM: number;
    nmeaAgeMs: number;
}

/**
 * May a phone fix stand in for the boat's, given where the boat last was?
 *
 * Shane connected the anchor watch to the boat's GPS over Tailscale and asked
 * whether it replaced his two-device shore setup (2026-08-08). Not on its own:
 * iOS suspends the app when the screen locks, which kills the socket to the
 * gateway, and twelve seconds later the watch was quietly measuring the
 * distance from the anchor to WHEREVER THE PHONE WAS. Ashore and far away that
 * is a false drag alarm; ashore and near the anchorage it is worse — the phone
 * sits inside the swing circle and the watch reports all clear while the boat
 * drags across the bay.
 *
 * Returns null when the handover is fine (or when there is nothing to compare
 * against — a phone-only watch must keep working). Otherwise returns the
 * numbers that disqualified it.
 */
export function checkSourceHandover(params: {
    nowMs: number;
    /** Last position accepted from the boat's GPS, if any. */
    lastNmea: { latitude: number; longitude: number; at: number } | null;
    candidate: { latitude: number; longitude: number; accuracy: number };
    swingRadiusM: number;
    distanceM: (aLat: number, aLon: number, bLat: number, bLon: number) => number;
}): SourceHandoverCheck | null {
    const { nowMs, lastNmea, candidate, swingRadiusM, distanceM } = params;
    // Never had the boat's GPS — this watch is phone-only by design.
    if (!lastNmea) return null;

    const nmeaAgeMs = Math.max(0, nowMs - lastNmea.at);
    const separationM = distanceM(lastNmea.latitude, lastNmea.longitude, candidate.latitude, candidate.longitude);

    // Too long dark to call this a failover at all.
    if (nmeaAgeMs > SOURCE_HANDOVER_WINDOW_MS) {
        return { separationM, allowanceM: 0, nmeaAgeMs };
    }

    const allowanceM = swingRadiusM + Math.max(candidate.accuracy, 0) + (MAX_DRIFT_MPS * nmeaAgeMs) / 1000;
    return separationM > allowanceM ? { separationM, allowanceM, nmeaAgeMs } : null;
}
