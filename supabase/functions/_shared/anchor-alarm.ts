/** No check-in from the boat's phone for this long is a quiet phone (126-03b, D2). */
export const PHONE_QUIET_MS = 5 * 60_000;
/** A Pi keeps a watch for at most this long after the skipper's phone last authorised it. */
export const PI_LEASE_CAP_MS = 7 * 24 * 60 * 60_000;
/** "Ends soon" is said this long before that cap (D5). */
export const PI_ENDS_SOON_MS = 12 * 60 * 60_000;

/**
 * A watch the boat's PHONE keeps (watchkeeper 'phone'): is this alarm still
 * worth sending now? Never judged against a Pi binding (D1, D6).
 *   - contact_lost: while the phone is still watching and still quiet. A beat
 *     since, or the watch ended, means it is over.
 *   - anything else (its own drag push): within 120 s of being raised.
 */
export function phoneWatchAlarmCurrent(input: {
    kind: string;
    createdAt: number;
    heartbeatAt: number | null;
    vesselState: string | null;
    now: number;
}): boolean {
    if (input.kind === 'contact_lost') {
        return (
            input.vesselState === 'watching' &&
            (input.heartbeatAt === null || input.now - input.heartbeatAt > PHONE_QUIET_MS)
        );
    }
    return input.now - input.createdAt <= 120_000;
}

/** The Pi's 7-day lease from the skipper's last authorisation ends within 12 hours. */
export function piWatchEndsSoon(authorisedAt: number, now: number): boolean {
    return Number.isFinite(authorisedAt) && authorisedAt + PI_LEASE_CAP_MS - now <= PI_ENDS_SOON_MS;
}

/** Alarm wording is intentionally different for a drag and an unobserved boat. */
export function anchorAlarmMessage(record: Record<string, unknown>): { title: string; body: string; kind: string } {
    const kind = typeof record.alarm_kind === 'string' ? record.alarm_kind : 'drag';
    if (kind === 'contact_lost' && record.watchkeeper === 'phone') {
        return {
            kind,
            title: '⚓ SHORE WATCH — CONTACT LOST',
            body:
                'The phone keeping the anchor watch has stopped checking in. The anchor position cannot be confirmed. Check the boat and the phone immediately.',
        };
    }
    if (kind === 'contact_lost') {
        return {
            kind,
            title: '⚓ SHORE WATCH — CONTACT LOST',
            body:
                'The boat has stopped reporting. Its anchor position cannot be confirmed. Check the boat and its connection immediately.',
        };
    }
    if (kind === 'gps_lost') {
        return {
            kind,
            title: '⚓ SHORE WATCH — GPS LOST',
            body:
                'The boat is connected but has no fresh GPS position. Anchor dragging cannot be checked. Check the boat and its GPS immediately.',
        };
    }
    if (kind === 'session_expiring') {
        return {
            kind,
            title: '⚓ SHORE WATCH — ENDS SOON',
            body:
                'The Pi keeping the anchor watch stops within 12 hours unless the skipper opens Thalassa on the phone that handed it the watch.',
        };
    }
    const distance = typeof record.distance_m === 'number' && Number.isFinite(record.distance_m)
        ? `${Math.round(record.distance_m)}m`
        : 'an unknown distance';
    const radius = typeof record.swing_radius_m === 'number' && Number.isFinite(record.swing_radius_m)
        ? `${Math.round(record.swing_radius_m)}m`
        : 'unknown';
    return {
        kind: 'drag',
        title: '⚓ ANCHOR DRAG ALARM',
        body: `Your vessel has drifted ${distance} from anchor (${radius} swing radius). Check immediately!`,
    };
}

/** Reject malformed/old fixes; receiving a packet is not evidence of current GPS. */
export function validAnchorGps(payload: Record<string, unknown>, now: number): boolean {
    const vessel = payload.vessel as Record<string, unknown> | undefined;
    // Original Pi builds carry only vessel.timestamp; transport timestamp is
    // never an acceptable substitute for the receiver's fix time.
    const timestamp = payload.gpsTimestamp ?? vessel?.timestamp;
    return (
        payload.type !== 'status' &&
        payload.gpsAvailable !== false &&
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        now - timestamp <= 35_000 &&
        timestamp <= now + 5_000 &&
        typeof vessel?.latitude === 'number' &&
        Number.isFinite(vessel.latitude) &&
        Math.abs(vessel.latitude) <= 90 &&
        typeof vessel?.longitude === 'number' &&
        Number.isFinite(vessel.longitude) &&
        Math.abs(vessel.longitude) <= 180
    );
}
