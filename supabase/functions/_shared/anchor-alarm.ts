/** Alarm wording is intentionally different for a drag and an unobserved boat. */
export function anchorAlarmMessage(record: Record<string, unknown>): { title: string; body: string; kind: string } {
    const kind = typeof record.alarm_kind === 'string' ? record.alarm_kind : 'drag';
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
            title: '⚓ SHORE WATCH — EXPIRING',
            body:
                'This Shore Watch session expires in 15 minutes or less. Reopen Thalassa and start a new watch before protection ends.',
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
