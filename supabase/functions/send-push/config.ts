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
 *
 * Build 129 (129-09) adds cyclone-watch's two types:
 *   cyclone_notice  a tropical cyclone within 600 NM of the boat: ordinary
 *   cyclone_urgent  within 300 NM, or its forecast track within 300 NM inside
 *                   72 h: a safety type (Time Sensitive, or Critical where
 *                   entitled), and still deliverable for 6 h, since a cyclone
 *                   that close is news for hours, not minutes
 * Both collapse to one lock-screen notification per storm (the urgent push
 * replaces the notice) in their own thread.
 *
 * Build 129 (129-06) adds official-alerts-watch's type:
 *   official_warning  an official marine or coastal warning in force at the
 *                     boat, in the issuer's words. One notification per
 *                     warning and its updates (collapse id provider:chain);
 *                     APNs keeps it until the warning expires (TTL = expiry,
 *                     capped at 7 days) and a queue row claimed after expiry
 *                     is dropped; Time Sensitive for Severe and Extreme and
 *                     never Critical (that is for the boat's own alarms); an
 *                     update that raised nothing replaces the notification
 *                     with no sound (passive).
 *
 * Build 129 (129-08) maps the quiet-boat watchdog's two types (held migration
 * 20261014180000_vessel_quiet_watch_crew):
 *   boat_quiet        her Pi, or her instruments, quiet for the grace: to the
 *                     owner and the crew who share her instruments. Time
 *                     Sensitive, day or night, never Critical; still news
 *                     hours later, so the default 6 h expiry.
 *   boat_quiet_clear  the all-clear, to those the page went to (or, the
 *                     watch switched off mid-page, its closing word). An
 *                     ordinary alert, so Sleep Focus keeps it quiet.
 * Both collapse to one lock-screen notification per boat (data.collapse, a
 * 16-hex key the watchdog derives from the owner) in a thread of their own.
 */

import { parseWeatherWatchNotice } from '../../../utils/weatherWatch.ts';
import { parseOverdueNotice } from '../../../utils/overdueWatch.ts';
import { isCurrentLightningNotice } from '../../../utils/licensedLightningPush.ts';
import { RADAR_RELAY_CONTACT, RADAR_RELAY_EPISODE, RADAR_RELAY_KEY } from '../../../utils/radarRelayContract.ts';
export const DIRECT_MESSAGE_TTL_SECONDS = 24 * 60 * 60;
export const WEATHER_ALERT_TTL_SECONDS = 60 * 60;
export const DEFAULT_ALERT_TTL_SECONDS = 6 * 60 * 60;
export const DISTRESS_ALARM_TTL_SECONDS = 10 * 60;
export const CYCLONE_URGENT_TTL_SECONDS = 6 * 60 * 60;
/** An official warning with no expiry is kept this long. */
export const OFFICIAL_WARNING_DEFAULT_TTL_SECONDS = 6 * 60 * 60;
/** And one that runs for weeks no longer than this. */
export const OFFICIAL_WARNING_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The anchor alarm's bundled sound (send-anchor-alarm's ANCHOR_ALARM_SOUND, ios/App/App). */
export const PI_ALARM_SOUND = 'thalassa-anchor-alarm.wav';
/** Older than this when claimed, a Pi alarm is history, not news. */
const PI_ALARM_DELIVERY_WINDOW_MS: Record<string, number> = {
    collision_alarm: 3 * 60_000,
    distress_alarm: 10 * 60_000,
    underway_alarm: 3 * 60_000,
    wake_alarm: 30_000,
    radar_alarm: 15_000,
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
        'radar_alarm', // Same collision priority, with the existing entitlement gate.
        'distress_alarm', // The Pi's radio hears an active distress beacon (126-04b)
        'underway_alarm', // Pi off-route/chart-ahead watch; evidence stays aboard (133-04)
        'cyclone_urgent', // A cyclone within 300 NM, or its track within 72 h (129-09)
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
        case 'lightning_nearby':
            return 'thalassa-weather';
        case 'buddy_notice':
            return 'thalassa-buddy';
        case 'overdue_notice':
            return 'thalassa-overdue';
        case 'hail':
            return 'thalassa-social';
        case 'collision_alarm':
            return 'thalassa-collision';
        case 'distress_alarm':
            return 'thalassa-distress';
        case 'underway_alarm':
            return 'thalassa-underway';
        case 'wake_alarm':
            return 'thalassa-wake-rules';
        case 'radar_alarm':
            return 'thalassa-radar';
        case 'cyclone_notice':
        case 'cyclone_urgent':
            return 'thalassa-cyclone';
        case 'official_warning':
            return 'thalassa-official';
        case 'boat_quiet':
        case 'boat_quiet_clear':
            return 'thalassa-boat';
        default:
            return 'thalassa-general';
    }
}

const isMmsi = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1_000_000 && v <= 999_999_999;

const isStormKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9]{2,12}$/.test(v);

/** official-alerts-watch's provider:chain, "nws:0123456789abcdef": under APNs's 64-byte collapse id. */
const isOfficialCollapse = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,39}:[0-9a-f]{16}$/.test(v);

/** The quiet-boat watchdog's per-boat key (129-08). */
const isBoatQuietCollapse = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);

/** An official warning's expiry, in ms, or NaN. */
const officialExpiry = (data: Record<string, unknown> | undefined): number =>
    typeof data?.expires === 'string' ? Date.parse(data.expires) : NaN;

/** Get the APNs collapse-id to coalesce duplicate alerts */
export function getCollapseId(type: string, data: Record<string, unknown>): string | null {
    if (type === 'overdue_notice') {
        const notice = parseOverdueNotice(data);
        return notice ? `overdue:${notice.revision}` : null;
    }
    if (
        type === 'buddy_notice' && typeof data.watch_id === 'string' &&
        /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(data.watch_id)
    ) return `buddy-${data.watch_id}`;
    if (type === 'radar_alarm' && typeof data.contact_key === 'string' && RADAR_RELAY_CONTACT.test(data.contact_key)) {
        return `radar-${data.contact_key}`;
    }
    if (type === 'weather_alert' && Object.hasOwn(data, 'weather_watch')) {
        const notice = parseWeatherWatchNotice(data, Date.now());
        return notice ? `wx-${notice.feature}-${notice.boatId}` : null;
    }
    // Collapse repeated BOLO alerts for the same vessel
    if (type === 'bolo_alert' && data?.mmsi) return `bolo-${data.mmsi}`;
    // Collapse geofence alerts for the same vessel
    if (type === 'geofence_alert' && data?.mmsi) return `geofence-${data.mmsi}`;
    // Collapse anchor alarms (only latest matters)
    if (type === 'anchor_alarm') return 'anchor-alarm';
    // The Pi's alarms: one on the lock screen per vessel, the newest numbers (126-04b)
    if (type === 'collision_alarm' && isMmsi(data?.mmsi)) return `collision-${data.mmsi}`;
    if (type === 'distress_alarm' && isMmsi(data?.mmsi)) return `distress-${data.mmsi}`;
    if (type === 'underway_alarm' && (data.kind === 'off-route' || data.kind === 'chart-ahead')) {
        return `underway-${data.kind}`;
    }
    if (
        type === 'wake_alarm' && typeof data.alarm_key === 'string' &&
        /^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$/.test(data.alarm_key) &&
        data.kind === data.alarm_key.split(':')[0]
    ) return String(data.kind);
    // One per storm: cyclone-watch's basin-and-number key, "SH37" (129-09).
    if ((type === 'cyclone_notice' || type === 'cyclone_urgent') && isStormKey(data?.storm_key)) {
        return `cyclone-${data.storm_key}`;
    }
    // One per official warning and its updates (129-06).
    if (type === 'official_warning' && isOfficialCollapse(data?.collapse)) return data.collapse;
    // One per boat: the all-clear lands on the page it answers (129-08).
    if ((type === 'boat_quiet' || type === 'boat_quiet_clear') && isBoatQuietCollapse(data?.collapse)) {
        return `boat-quiet-${data.collapse}`;
    }
    return null;
}

/** The two Pi alarms sound like the anchor alarm; everything else keeps the system sound. */
export function getAlertSound(type: string): string {
    return type === 'collision_alarm' || type === 'distress_alarm' || type === 'underway_alarm' ||
            type === 'wake_alarm' || type === 'radar_alarm'
        ? PI_ALARM_SOUND
        : 'default';
}

/**
 * Alert pushes are accepted by APNs even when a device is temporarily
 * unreachable.  An expiration of zero tells APNs to discard the alert rather
 * than retain it, which is right for an immediate safety alarm but wrong for a
 * private message a sailor may receive while briefly out of coverage.
 */
export function getApnsExpiration(
    type: string,
    isCritical: boolean,
    nowMs = Date.now(),
    data?: Record<string, unknown>,
): string {
    const nowSeconds = Math.floor(nowMs / 1000);
    // Informational source facts must not wait at APNs and arrive as fresh news.
    if (type === 'buddy_notice' || type === 'lightning_nearby') return '0';
    if (type === 'overdue_notice') {
        const notice = parseOverdueNotice(data, nowMs);
        return notice ? String(Math.floor(notice.expiresAt / 1000)) : '0';
    }
    if (type === 'weather_alert' && data && Object.hasOwn(data, 'weather_watch')) {
        const notice = parseWeatherWatchNotice(data, nowMs);
        return notice ? String(Math.floor(notice.expiresAt / 1000)) : '0';
    }
    if (type === 'wake_alarm' || type === 'radar_alarm') return '0'; // Never store a stale instrument/radar alarm at APNs.
    // An official warning is news until it expires (129-06).
    if (type === 'official_warning') {
        const expires = officialExpiry(data);
        if (!Number.isFinite(expires)) return String(nowSeconds + OFFICIAL_WARNING_DEFAULT_TTL_SECONDS);
        return String(
            Math.min(Math.max(Math.floor(expires / 1000), nowSeconds), nowSeconds + OFFICIAL_WARNING_MAX_TTL_SECONDS),
        );
    }
    // A distress beacon is still news ten minutes on; a stale CPA is not.
    if (type === 'distress_alarm') return String(nowSeconds + DISTRESS_ALARM_TTL_SECONDS);
    if (type === 'cyclone_urgent') return String(nowSeconds + CYCLONE_URGENT_TTL_SECONDS);
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
export function isStaleForDelivery(
    type: string,
    createdAt: unknown,
    nowMs = Date.now(),
    data?: Record<string, unknown>,
): boolean {
    if (type === 'lightning_nearby') {
        const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
        return !Number.isFinite(created) || created > nowMs || nowMs - created >= 60000 ||
            !isCurrentLightningNotice(data, nowMs);
    }
    if (type === 'overdue_notice') {
        const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
        return !Number.isFinite(created) || created > nowMs || nowMs - created >= 600_000 ||
            parseOverdueNotice(data, nowMs) === null;
    }
    if (type === 'buddy_notice') {
        const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
        return !Number.isFinite(created) || created > nowMs || nowMs - created >= 30 * 60_000;
    }
    if (type === 'radar_alarm') {
        if (
            typeof data?.source_at !== 'number' || !Number.isSafeInteger(data.source_at) || data.source_at <= 0 ||
            data.source_at > nowMs + 1000 || nowMs - data.source_at > 15_000 ||
            typeof data.alarm_key !== 'string' || !RADAR_RELAY_KEY.test(data.alarm_key) ||
            data.kind !== data.alarm_key.split(':')[0] ||
            typeof data.contact_key !== 'string' || !RADAR_RELAY_CONTACT.test(data.contact_key) ||
            typeof data.episode_id !== 'string' || !RADAR_RELAY_EPISODE.test(data.episode_id) ||
            typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
        ) return true;
    }
    if (type === 'weather_alert' && data && Object.hasOwn(data, 'weather_watch')) {
        return !parseWeatherWatchNotice(data, nowMs);
    }
    if (type === 'wake_alarm') {
        const age = data?.kind === 'wake-pressure' ? 120_000 : data?.kind === 'wake-battery' ? 180_000 : 13_000;
        if (
            typeof data?.source_at !== 'number' || !Number.isSafeInteger(data.source_at) || data.source_at <= 0 ||
            data.source_at > nowMs + 1000 || nowMs - data.source_at > age ||
            typeof data.kind !== 'string' ||
            !/^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery)$/.test(data.kind)
        ) return true;
        if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return true;
    }
    // An official warning that expired before the drain reached it is not news (129-06).
    if (type === 'official_warning') {
        const expires = officialExpiry(data);
        return Number.isFinite(expires) && expires <= nowMs;
    }
    const window = PI_ALARM_DELIVERY_WINDOW_MS[type];
    if (window === undefined || typeof createdAt !== 'string') return false;
    const created = Date.parse(createdAt);
    return Number.isFinite(created) && nowMs - created > window;
}

export type InterruptionLevel = 'time-sensitive' | 'active' | 'passive';

export interface ApsInput {
    title: string;
    body: string;
    type: string;
    isCritical?: boolean;
    threadId: string;
    badge?: number;
    /** Set by the type's data (getInterruptionLevel): this level, never Critical; 'passive' has no sound. */
    level?: InterruptionLevel;
}

/**
 * A type whose data sets its own interruption level, or undefined for the
 * isCritical rule. An official warning (129-06): Time Sensitive for Severe and
 * Extreme, active otherwise, passive (no sound) for an update that raised
 * nothing.
 */
export function getInterruptionLevel(type: string, data: Record<string, unknown>): InterruptionLevel | undefined {
    if (type === 'overdue_notice') return 'active';
    if (type === 'buddy_notice') return 'passive';
    if (type === 'wake_alarm') return 'time-sensitive'; // User-enabled preset; no Critical entitlement claim.
    // The quiet boat (129-08): the page goes at once, the all-clear as an ordinary alert.
    if (type === 'boat_quiet') return 'time-sensitive';
    if (type === 'boat_quiet_clear') return 'active';
    if (type !== 'official_warning') return undefined;
    if (data?.silent === true) return 'passive';
    return data?.severity === 'Severe' || data?.severity === 'Extreme' ? 'time-sensitive' : 'active';
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
    const level = payload.type === 'overdue_notice' ? 'active' : payload.level;
    if (level) {
        if (level !== 'passive') aps.sound = sound;
        aps['interruption-level'] = level;
    } else if (payload.isCritical && criticalAlertsEntitled) {
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
