/**
 * pi-alarm-relay's rules, pure (build 126, package 126-04b): what the Pi may
 * send, how a push is worded, and when it may be sent again.
 *
 * Nothing the Pi sends is trusted as words except the vessel's AIS name,
 * which is cleaned (control characters, markup, runs of space) and capped at
 * 40 characters. Every number is bounded; one out of range is dropped (said
 * as unknown), never repaired. The push text is built here from those numbers.
 */
import { plainTextFromMarkup } from '../_shared/plain-text.ts';

/** A Pi request is small: 20 open alarms fit in well under this. */
export const MAX_BODY_BYTES = 8 * 1024;
/** An open, unacknowledged alarm is pushed again this often. */
export const REPUSH_MS = 2 * 60_000;
/** Close quarters: every minute. */
export const CLOSE_QUARTERS_REPUSH_MS = 60_000;
/** Re-sends per alarm, after its first push. */
export const MAX_RESENDS = 10;
/**
 * Each hour, per owner, a busy anchorage cannot storm the phone: at most 30
 * new alarms pushed (a DANGER pushed afresh when its mute ran out counts as
 * one), and at most 20 re-sends of alarms already on the lock screen. Kept
 * apart so re-sends can never hold back the first push of a new alarm.
 */
export const MAX_NEW_ALARM_PUSHES_PER_HOUR = 30;
export const MAX_RESENDS_PER_HOUR = 20;
/** A 'blind' or 'no-fix' notice, per kind, at most this often. */
export const NOTICE_EVERY_MS = 30 * 60_000;
/** A test push at most once a minute, and ten an hour. */
export const TEST_EVERY_MS = 60_000;
export const MAX_TESTS_PER_HOUR = 10;
/**
 * A DANGER acknowledged this long ago that the Pi raises again is the end of
 * its 30-minute mute aboard (COLLISION_RULE.muteMinutes), not a repeat: it is
 * pushed afresh. Below 30 min to allow for the Pi learning the acknowledgement
 * a sync after it was made.
 */
export const MUTE_REOPEN_AFTER_MS = 25 * 60_000;
/**
 * An acknowledgement aboard said to have been made more than this before the
 * alarm's last push is stale: a request built before a DANGER's mute ran out
 * that arrived after it was pushed afresh. Requests time out in 8 s on the Pi.
 */
export const STALE_ACK_SLACK_MS = 60_000;
/** Resolved rows are kept a month, then deleted a batch at a time. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RETENTION_BATCH = 200;
/** The Pi reports at most this many open alarms (pi-cache AIS_WATCH_MAX_ALARMS). */
export const MAX_SYNC_ALARMS = 20;
export const MAX_NAME_CHARS = 40;

export const ALARM_KEY_RE = /^(collision|close-quarters|distress|blind|no-fix|test):[0-9]{0,9}:[0-9]{10,13}$/;

export type PiAlarmKind = 'collision' | 'close-quarters' | 'distress' | 'blind' | 'no-fix' | 'test';
export type PiNotificationType = 'collision_alarm' | 'distress_alarm' | 'pi_watch_notice';
const ALARM_KINDS: ReadonlySet<string> = new Set(['collision', 'close-quarters', 'distress']);
const LOST: ReadonlySet<string> = new Set([
    'no-fix',
    'own-motion-unknown',
    'target-motion-unknown',
    'report-too-old',
    'gone',
]);
const DISTRESS_KINDS: ReadonlySet<string> = new Set(['sart', 'mob', 'epirb']);

/** The bounded facts a push is worded from, as kept in pi_alarm_events.payload. */
export interface PiAlarmPayload {
    name: string;
    cpa_nm: number | null;
    tcpa_min: number | null;
    range_nm: number | null;
    bearing_deg: number | null;
    lat: number | null;
    lon: number | null;
    lost: string | null;
    distress_kind: string | null;
    position_known: boolean | null;
    /** A 'blind' notice: minutes since AIS was last heard. */
    silent_min: number | null;
    /** A 'no-fix' notice: no position fix, or our own course and speed unknown. */
    cause: 'fix' | 'motion' | null;
}

export interface PiAlarmInput {
    key: string;
    kind: PiAlarmKind;
    mmsi: number | null;
    payload: PiAlarmPayload;
    /** Acknowledged aboard (on the Pi or a phone there) this long ago; null while it sounds. */
    ackedMsAgo: number | null;
}

export type RelayRequest =
    | { action: 'probe'; utcOffsetMin: number | null }
    | { action: 'test'; utcOffsetMin: number | null }
    | { action: 'raise'; utcOffsetMin: number | null; alarm: PiAlarmInput }
    | {
        action: 'sync';
        utcOffsetMin: number | null;
        alarms: PiAlarmInput[];
        /** Entries refused one by one: counted, never the whole sync. */
        skipped: number;
        /** Every alarm key the Pi listed, its refused entries' too: none of them is over. */
        listedKeys: string[];
    };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function isAlarmKind(kind: string): boolean {
    return ALARM_KINDS.has(kind);
}

function bounded(value: unknown, min: number, max: number, places: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
    const f = 10 ** places;
    return Math.round(value * f) / f;
}

/** The vessel's AIS name: markup and control characters out, space collapsed, 40 characters at most. */
export function cleanName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return plainTextFromMarkup(raw, { maxInputChars: 400, maxOutputChars: MAX_NAME_CHARS }).trim();
}

function isMmsi(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1_000_000 && value <= 999_999_999;
}

export function parseAlarm(raw: unknown, allowNotices: boolean): Parsed<PiAlarmInput> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'alarm must be an object' };
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : '';
    if (key.length > 64 || !ALARM_KEY_RE.test(key)) return { ok: false, error: 'not an alarm key' };
    const [keyKind, keyMmsi] = key.split(':');
    if (r.kind !== keyKind) return { ok: false, error: 'kind does not match the key' };
    const kind = keyKind as PiAlarmKind;
    if (kind === 'test' || (!allowNotices && !ALARM_KINDS.has(kind))) return { ok: false, error: 'not an alarm' };
    let mmsi: number | null = null;
    if (ALARM_KINDS.has(kind)) {
        if (!isMmsi(r.mmsi) || String(r.mmsi) !== keyMmsi) return { ok: false, error: 'mmsi does not match the key' };
        mmsi = r.mmsi;
    } else if (keyMmsi !== '' || (r.mmsi !== undefined && r.mmsi !== null)) {
        return { ok: false, error: 'a notice names no vessel' };
    }
    const ackedMsAgo = r.acked_ms_ago === null || r.acked_ms_ago === undefined
        ? null
        : bounded(r.acked_ms_ago, 0, 24 * 60 * 60_000, 0);
    const silent = bounded(r.silent_min, 0, 1_440, 0);
    const payload: PiAlarmPayload = {
        name: ALARM_KINDS.has(kind) ? cleanName(r.name) : '',
        cpa_nm: bounded(r.cpa_nm, 0, 100, 2),
        tcpa_min: bounded(r.tcpa_min, -1_440, 1_440, 1),
        range_nm: bounded(r.range_nm, 0, 1_000, 2),
        bearing_deg: typeof r.bearing_deg === 'number' && r.bearing_deg >= 360
            ? null
            : bounded(r.bearing_deg, 0, 359.999, 0),
        lat: bounded(r.lat, -90, 90, 5),
        lon: bounded(r.lon, -180, 180, 5),
        lost: typeof r.lost === 'string' && LOST.has(r.lost) ? r.lost : null,
        distress_kind: kind === 'distress' && typeof r.distress_kind === 'string' &&
                DISTRESS_KINDS.has(r.distress_kind)
            ? r.distress_kind
            : null,
        position_known: kind === 'distress' && typeof r.position_known === 'boolean' ? r.position_known : null,
        silent_min: kind === 'blind' ? silent : null,
        cause: kind === 'no-fix' ? (r.cause === 'motion' ? 'motion' : 'fix') : null,
    };
    return { ok: true, value: { key, kind, mmsi, payload, ackedMsAgo } };
}

/** The request body (already size-checked and parsed as JSON). */
export function parseRelayRequest(body: Record<string, unknown>): Parsed<RelayRequest> {
    const offset = body.utc_offset_min;
    const utcOffsetMin = typeof offset === 'number' && Number.isInteger(offset) && offset >= -720 && offset <= 840
        ? offset
        : null;
    switch (body.action) {
        case 'probe':
        case 'test':
            return { ok: true, value: { action: body.action as 'probe' | 'test', utcOffsetMin } };
        case 'raise': {
            const alarm = parseAlarm(body.alarm, true);
            return alarm.ok ? { ok: true, value: { action: 'raise', utcOffsetMin, alarm: alarm.value } } : alarm;
        }
        case 'sync': {
            if (!Array.isArray(body.alarms) || body.alarms.length > MAX_SYNC_ALARMS) {
                return { ok: false, error: `alarms must be a list of at most ${MAX_SYNC_ALARMS}` };
            }
            // One bad entry (an MMSI no radio sends, say) is skipped and
            // counted: it must never cost the others their re-sends and the
            // acknowledgements made ashore.
            const alarms: PiAlarmInput[] = [];
            const seen = new Set<string>();
            const listedKeys = new Set<string>();
            let skipped = 0;
            for (const raw of body.alarms) {
                const rawKey = (raw as Record<string, unknown> | null)?.key;
                if (typeof rawKey === 'string' && rawKey.length <= 64) listedKeys.add(rawKey);
                const alarm = parseAlarm(raw, false);
                if (!alarm.ok) {
                    skipped += 1;
                    continue;
                }
                if (seen.has(alarm.value.key)) continue;
                seen.add(alarm.value.key);
                alarms.push(alarm.value);
            }
            return { ok: true, value: { action: 'sync', utcOffsetMin, alarms, skipped, listedKeys: [...listedKeys] } };
        }
        default:
            return { ok: false, error: 'action must be probe, raise, sync or test' };
    }
}

export function notificationTypeFor(kind: PiAlarmKind): PiNotificationType {
    if (kind === 'distress') return 'distress_alarm';
    if (kind === 'collision' || kind === 'close-quarters') return 'collision_alarm';
    return 'pi_watch_notice';
}

/** Close quarters is pushed again every minute; the rest every two. */
export function repushAfterMs(kind: PiAlarmKind): number {
    return kind === 'close-quarters' ? CLOSE_QUARTERS_REPUSH_MS : REPUSH_MS;
}

/**
 * The time on the boat's own clock, from the Pi's UTC offset ('02:14'), or in
 * UTC said as such when the Pi gave none or keeps UTC ('16:14 UTC').
 */
export function clockText(nowMs: number, utcOffsetMin: number | null): string {
    const offset = utcOffsetMin ?? 0;
    const d = new Date(nowMs + offset * 60_000);
    const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    return offset === 0 ? `${hhmm} UTC` : hhmm;
}

const nm = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1));
const bearing = (x: number) => `${String(Math.round(x) % 360).padStart(3, '0')}°`;

const DISTRESS_WORDS: Record<string, string> = {
    sart: 'AIS-SART',
    mob: 'man overboard beacon',
    epirb: 'EPIRB-AIS beacon',
};

/** Title and body for one push, from the bounded facts only. Within send-push's 120/500 limits. */
export function pushText(
    alarm: { kind: PiAlarmKind; mmsi: number | null; payload: PiAlarmPayload },
    nowMs: number,
    utcOffsetMin: number | null,
): { title: string; body: string } {
    const p = alarm.payload;
    const when = clockText(nowMs, utcOffsetMin);
    const who = p.name || (alarm.mmsi === null ? 'A vessel' : `MMSI ${alarm.mmsi}`);
    switch (alarm.kind) {
        case 'collision':
        case 'close-quarters': {
            const parts: string[] = [];
            if (p.cpa_nm !== null && p.lost === null) {
                // As the phone's own card words it (aisGuardAlertStore collisionLines).
                const t = p.tcpa_min;
                const soon = t === null
                    ? ''
                    : t < 0
                    ? ' passed, opening'
                    : t < 1
                    ? ' within a minute'
                    : ` in ${Math.round(t)} min`;
                parts.push(`CPA ${nm(p.cpa_nm)} NM${soon}`);
            } else {
                parts.push(p.lost !== null ? 'CPA unknown (contact lost)' : 'CPA unknown');
            }
            if (p.bearing_deg !== null) parts.push(`bearing ${bearing(p.bearing_deg)}`);
            if (p.range_nm !== null) parts.push(`${nm(p.range_nm)} NM`);
            return {
                title: `${alarm.kind === 'close-quarters' ? 'Close quarters' : 'Collision risk'}: ${who}`,
                body: `${parts.join(', ')}. From your boat’s Pi, ${when}.`,
            };
        }
        case 'distress': {
            const words = DISTRESS_WORDS[p.distress_kind ?? 'sart'] ?? DISTRESS_WORDS.sart;
            const where = p.position_known === false || p.lat === null || p.lon === null
                ? `${who}: position not yet received`
                : p.bearing_deg !== null && p.range_nm !== null
                ? `${who}, bearing ${bearing(p.bearing_deg)}, ${nm(p.range_nm)} NM`
                : `${who}, range unknown: no position fix aboard`;
            return { title: `Distress: ${words} active`, body: `${where}. Heard by your boat’s Pi, ${when}.` };
        }
        case 'blind':
            return {
                title: 'Night watch blind',
                body: p.silent_min !== null && p.silent_min > 0
                    ? `Your boat’s Pi can’t see AIS traffic (no reports for ${p.silent_min} min). The night watch is blind.`
                    : 'Your boat’s Pi can’t see AIS traffic. The night watch is blind.',
            };
        case 'no-fix':
            return {
                title: 'Night watch: no position',
                body: p.cause === 'motion'
                    ? 'Your boat’s Pi can’t read her own course and speed, so it can’t work out collision risk.'
                    : 'Your boat’s Pi has lost its position fix, so it can’t work out collision risk.',
            };
        case 'test':
            return {
                title: 'TEST: the night watch can reach you',
                body: `A test from your boat’s Pi, ${when}. If it woke your locked phone, the Pi can wake you.`,
            };
    }
}

/**
 * What the phone reads off the push (send-push spreads it into the APNs
 * payload): enough to show the alarm as a card 'from the Pi' and to
 * acknowledge it by its key. Numbers and the cleaned name only.
 */
export function pushData(
    alarm: { key: string; kind: PiAlarmKind; mmsi: number | null; payload: PiAlarmPayload },
    raisedAtMs: number,
    resend = false,
): Record<string, string | number | boolean> {
    const data: Record<string, string | number | boolean> = { kind: alarm.kind, alarm_key: alarm.key };
    if (alarm.mmsi !== null) data.mmsi = alarm.mmsi;
    if (!isAlarmKind(alarm.kind)) return data;
    data.raised_at_ms = raisedAtMs;
    // The hourly caps count first pushes and re-sends apart (relay.ts hourlyRoom).
    data.resend = resend;
    const p = alarm.payload;
    if (p.name) data.name = p.name;
    for (const field of ['cpa_nm', 'tcpa_min', 'range_nm', 'bearing_deg', 'lat', 'lon'] as const) {
        const v = p[field];
        if (v !== null) data[field] = v;
    }
    if (p.lost !== null) data.lost = p.lost;
    if (p.distress_kind !== null) data.distress_kind = p.distress_kind;
    if (p.position_known !== null) data.position_known = p.position_known;
    return data;
}
