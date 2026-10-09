/**
 * send-push's per-type APNs settings, apart from the handler so they can be
 * tested (config_test.ts) without starting a server.
 *
 * Build 126 (126-04b) adds the boat Pi's three types (pi-alarm-relay):
 *   collision_alarm  a ship closing on the boat, from the Pi's night watch
 *   distress_alarm   an active AIS-SART, MOB or EPIRB-AIS beacon the Pi hears
 *   pi_watch_notice  the watch gone blind or without a fix, or a test: ordinary
 * The two alarms are safety types: Time Sensitive, or Critical only where
 * Apple has granted the entitlement (APNS_CRITICAL_ALERTS_ENABLED); the
 * anchor alarm's own sound, bundled in the app; one notification per vessel
 * on the lock screen. A collision alarm is never delivered late: APNs drops
 * it at once if the phone cannot be reached (a stale CPA is worse than none),
 * and a queue row the retry drain finds more than 3 minutes old is dropped
 * here (the Pi pushes again every 2 minutes while it still alarms). A
 * distress beacon stays relevant for 10 minutes.
 */

export const DIRECT_MESSAGE_TTL_SECONDS = 24 * 60 * 60;
export const WEATHER_ALERT_TTL_SECONDS = 60 * 60;
export const DEFAULT_ALERT_TTL_SECONDS = 6 * 60 * 60;
export const DISTRESS_ALARM_TTL_SECONDS = 10 * 60;
/** The anchor alarm's bundled sound (send-anchor-alarm's ANCHOR_ALARM_SOUND, ios/App/App). */
export const PI_ALARM_SOUND = 'thalassa-anchor-alarm.wav';
/** Older than this when claimed, a Pi alarm is history, not news. */
const PI_ALARM_DELIVERY_WINDOW_MS: Record<string, number> = {
    collision_alarm: 3 * 60_000,
    distress_alarm: 10 * 60_000,
};

export function isCriticalType(type: string): boolean {
    return [
        'anchor_alarm',
        'bolo_alert', // Armed vessel moved — safety critical
        'suspicious_alert', // Suspicious activity reported — safety critical
        'drag_warning', // Neighbor dragging anchor — safety critical
        'geofence_alert', // Vessel left home geofence — safety critical
        'severe_weather_alert', // 50kt+ wind / extreme conditions — safety critical
        'collision_alarm', // The Pi's night watch: a ship closing on the boat (126-04b)
        'distress_alarm', // The Pi's radio hears an active distress beacon (126-04b)
    ].includes(type);
}

/** Map notification type to APNs thread-id for grouping in Notification Center */
export function getThreadId(type: string): string {
    switch (type) {
        case 'dm':
            return 'thalassa-messages';
        case 'bolo_alert':
        case 'suspicious_alert':
        case 'drag_warning':
        case 'geofence_alert':
            return 'thalassa-guardian';
        case 'anchor_alarm':
            return 'thalassa-anchor';
        case 'weather_alert':
            return 'thalassa-weather';
        case 'hail':
            return 'thalassa-social';
        case 'collision_alarm':
            return 'thalassa-collision';
        case 'distress_alarm':
            return 'thalassa-distress';
        default:
            return 'thalassa-general';
    }
}

const isMmsi = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1_000_000 && v <= 999_999_999;

/** Get the APNs collapse-id to coalesce duplicate alerts */
export function getCollapseId(type: string, data: Record<string, unknown>): string | null {
    // Collapse repeated BOLO alerts for the same vessel
    if (type === 'bolo_alert' && data?.mmsi) return `bolo-${data.mmsi}`;
    // Collapse geofence alerts for the same vessel
    if (type === 'geofence_alert' && data?.mmsi) return `geofence-${data.mmsi}`;
    // Collapse anchor alarms (only latest matters)
    if (type === 'anchor_alarm') return 'anchor-alarm';
    // The Pi's alarms: one on the lock screen per vessel, the newest numbers (126-04b)
    if (type === 'collision_alarm' && isMmsi(data?.mmsi)) return `collision-${data.mmsi}`;
    if (type === 'distress_alarm' && isMmsi(data?.mmsi)) return `distress-${data.mmsi}`;
    return null;
}

/** The two Pi alarms sound like the anchor alarm; everything else keeps the system sound. */
export function getAlertSound(type: string): string {
    return type === 'collision_alarm' || type === 'distress_alarm' ? PI_ALARM_SOUND : 'default';
}

/**
 * Alert pushes are accepted by APNs even when a device is temporarily
 * unreachable.  An expiration of zero tells APNs to discard the alert rather
 * than retain it, which is right for an immediate safety alarm but wrong for a
 * private message a sailor may receive while briefly out of coverage.
 */
export function getApnsExpiration(type: string, isCritical: boolean, nowMs = Date.now()): string {
    const nowSeconds = Math.floor(nowMs / 1000);
    // A distress beacon is still news ten minutes on; a stale CPA is not.
    if (type === 'distress_alarm') return String(nowSeconds + DISTRESS_ALARM_TTL_SECONDS);
    if (isCritical) return '0';

    switch (type) {
        case 'dm':
        case 'sos':
        case 'hail':
        case 'watch_schedule_published':
            return String(nowSeconds + DIRECT_MESSAGE_TTL_SECONDS);
        case 'weather_alert':
            return String(nowSeconds + WEATHER_ALERT_TTL_SECONDS);
        default:
            return String(nowSeconds + DEFAULT_ALERT_TTL_SECONDS);
    }
}

/**
 * A Pi alarm the retry drain claims late (its queue row older than the
 * alarm's window) is dropped rather than delivered as news. Every other type
 * keeps the drain's own one-hour fence (20260813070000).
 */
export function isStaleForDelivery(type: string, createdAt: unknown, nowMs = Date.now()): boolean {
    const window = PI_ALARM_DELIVERY_WINDOW_MS[type];
    if (window === undefined || typeof createdAt !== 'string') return false;
    const created = Date.parse(createdAt);
    return Number.isFinite(created) && nowMs - created > window;
}

export interface ApsInput {
    title: string;
    body: string;
    type: string;
    isCritical?: boolean;
    threadId: string;
    badge?: number;
}

/** The `aps` dictionary for one alert push. */
export function buildAps(payload: ApsInput, criticalAlertsEntitled: boolean): Record<string, unknown> {
    // No 'content-available': the app has no background completion handler
    // (AppDelegate implements no didReceiveRemoteNotification:fetchCompletionHandler:),
    // so a silent-wake hint did nothing but declare a background mode the app
    // never used (audit item 20). An alert push is delivered without it.
    const aps: Record<string, unknown> = {
        alert: { title: payload.title, body: payload.body },
        'thread-id': payload.threadId,
    };

    // Badge management
    if (payload.badge !== undefined) {
        aps.badge = payload.badge;
    }

    const sound = getAlertSound(payload.type);
    if (payload.isCritical && criticalAlertsEntitled) {
        // Critical Alert — bypasses DND and silent mode (requires Apple entitlement)
        aps.sound = { critical: 1, name: sound, volume: 1.0 };
        aps['interruption-level'] = 'critical';
    } else if (payload.isCritical) {
        // Safety alerts remain prominent without falsely claiming an Apple
        // Critical Alerts entitlement that may not be provisioned.
        aps.sound = sound;
        aps['interruption-level'] = 'time-sensitive';
    } else {
        aps.sound = sound;
        aps['interruption-level'] = 'active';
    }
    return aps;
}
