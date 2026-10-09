/**
 * PiAlarmRelay — the night watch wakes the skipper's locked phone (build 126,
 * package 126-04b).
 *
 * WHY. The Pi grades every AIS target all night (aisWatch.ts), but a phone
 * iOS has suspended hears none of it. So each alarm goes to the cloud relay
 * (supabase/functions/pi-alarm-relay), which queues a push for the Pi's owner
 * that send-push delivers: Time Sensitive (Critical where Apple has granted
 * it), the anchor alarm's sound, one notification per vessel.
 *
 * WHAT IT HOLDS. Nothing of its own: the pairing credential the diary relay
 * holds, lent (diaryRelayOutbox.lendAlarmCredentials), and the public anon key
 * the gateway checks (as anchor-relay). The endpoint comes from the
 * process-startup trust anchor (canonicalPiAlarmRelayEndpoint), never a
 * request. The token travels in its header only and is never logged.
 *
 * WHAT IT SENDS.
 *   raise  each alarm the watch raises (onAlarm), once. No queue and no
 *          retry: a late collision alarm is worse than none (as the anchor
 *          broadcaster). An alarm still open is in the next sync anyway, and
 *          the relay pushes one it never heard.
 *   sync   the open alarms, every 15 s while one sounds (every 60 s when all
 *          are acknowledged), once more when the last one closes or the
 *          watch stands down (after a sync still out, when it is back). The relay
 *          re-pushes the unacknowledged ones when due and answers the keys
 *          acknowledged from ashore; those are applied here like a phone's
 *          acknowledgement aboard (aisWatch.ack), only to an alarm still
 *          sounding, so a DANGER's 30-minute mute never restarts on its own.
 *   probe  when the watch is armed, and hourly: can a push reach a phone?
 *   notice the watch blind (no AIS for 10 min) or without a fix (2 min): one
 *          per silence; the relay holds a second of a kind for 30 min.
 *   test   "Send a test from the Pi" (POST /api/ais-watch/test).
 * A relay that does not answer backs the syncs off (15 s doubling to 5 min).
 * An alarm naming an MMSI no radio sends is never sent (the relay refuses it).
 * A push the relay holds for its hourly cap is said in the log, once a run.
 *
 * WHAT IT SAYS. 'ready' only after the relay answered within the hour with a
 * phone to wake; 'internet-off' when the skipper's Pi policy forbids ordinary
 * internet (it is obeyed: no request at all, and the AIS key says so);
 * 'not-paired'; else 'unavailable'. aisWatch.describe() and the cloud row
 * carry it, and the phone's AIS key says "The Pi can wake this phone" only
 * on 'ready' (the capability rule).
 *
 * Never the gateway, never the YDWG-02: this talks only to the cloud.
 */
import { normaliseExactHttpOrigin } from './outboundHttp.js';
import { isMmsi } from './aisWatchStore.js';
import type {
    AisWatchAlarm,
    AisWatchDescription,
    AisWatchKind,
    AisWatchPushState,
    AisWatchPushStatus,
} from './aisWatch.js';

export const PI_ALARM_RELAY_PATH = '/functions/v1/pi-alarm-relay';
export const PI_ALARM_REQUEST_TIMEOUT_MS = 8_000;
/** While an alarm sounds: the relay's word (re-sends, acknowledgements from ashore) this often. */
export const PI_ALARM_SYNC_MS = 15_000;
/** While every open alarm is acknowledged: only to tell the relay when they close. */
export const PI_ALARM_SYNC_ACKED_MS = 60_000;
export const PI_ALARM_MAX_BACKOFF_MS = 5 * 60_000;
export const PI_ALARM_PROBE_EVERY_MS = 60 * 60_000;
/** 'ready' lasts this long after the relay last answered (the hourly probe renews it). */
export const PI_PUSH_READY_FOR_MS = 65 * 60_000;
/** The watch blind this long (no AIS at all) is worth waking the skipper for, once. */
export const PI_BLIND_NOTICE_AFTER_MS = 10 * 60_000;
/** No position fix (or our own motion unknown) this long, once. */
export const PI_NO_FIX_NOTICE_AFTER_MS = 2 * 60_000;
/** The relay keeps only 40 characters of a name; never send more. */
const MAX_NAME_CHARS = 40;

type FetchLike = (
    url: string,
    init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface PiAlarmRelayDeps {
    fetchImpl: FetchLike;
    /** canonicalPiAlarmRelayEndpoint(the trusted Supabase origin). */
    endpoint: string;
    /** The public anon key the gateway checks; read live because /api/configure can change it. */
    anonKey: () => string;
    /** The pairing credential, lent; null while unpaired. */
    credentials: () => { relayId: string; token: string } | null;
    /** The skipper's Pi-local internet policy. */
    internetAllowed: () => boolean;
    /** The account the pairing belongs to: the one the Pi wakes. */
    ownerId?: () => string | null;
    now?: () => number;
    /** This Pi's clock against UTC, so the push says the boat's time. */
    utcOffsetMin?: () => number;
    timeoutMs?: number;
}

export type RaiseOutcome = 'sent' | 'internet-off' | 'not-paired' | 'unavailable';

/** The relay's endpoint, from the trust anchor and nothing else. */
export function canonicalPiAlarmRelayEndpoint(trustedSupabaseOrigin: string): string {
    const origin = normaliseExactHttpOrigin(trustedSupabaseOrigin);
    return new URL(PI_ALARM_RELAY_PATH, `${origin}/`).href;
}

/** One alarm as the relay reads it (pi-alarm-relay/parse.ts): bounded numbers and the name. */
export function wireAlarm(alarm: AisWatchAlarm, now: number): Record<string, unknown> {
    const wire: Record<string, unknown> = {
        key: alarm.key,
        kind: alarm.kind,
        mmsi: alarm.mmsi,
        name: alarm.name.slice(0, MAX_NAME_CHARS),
        cpa_nm: alarm.cpaNm,
        tcpa_min: alarm.tcpaMin,
        range_nm: alarm.rangeNm,
        bearing_deg: alarm.bearingDeg,
        lat: alarm.lat,
        lon: alarm.lon,
        lost: alarm.lost,
        acked_ms_ago: alarm.ackedAt === null ? null : Math.max(0, now - alarm.ackedAt),
    };
    if (alarm.kind === 'distress') {
        wire.distress_kind = alarm.distressKind ?? null;
        wire.position_known = alarm.positionKnown ?? null;
    }
    return wire;
}

export class PiAlarmRelay {
    private lastOkAt: number | null = null;
    private devices = 0;
    private failures = 0;
    private lastSyncAt: number | null = null;
    private syncing = false;
    /**
     * The relay may hold open alarms of ours: one more sync is owed when none
     * is open here. True at start, so alarms left open by a restart are closed.
     */
    private relayHasOpen = true;
    private armedSeen = false;
    private lastProbeAt: number | null = null;
    private blindNoticed = false;
    private noFixSince: number | null = null;
    private noFixNoticed = false;
    /** A stand-down seen while a sync was out: its closing sync goes when that one is back. */
    private closeOwed: AisWatchDescription | null = null;
    private holdsLogged = false;

    constructor(private readonly deps: PiAlarmRelayDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    /** Why no request can go now, or null when one can. */
    private blocked(): Exclude<AisWatchPushState, 'ready' | 'unavailable'> | null {
        if (!this.deps.internetAllowed()) return 'internet-off';
        if (!this.deps.credentials() || !this.deps.anonKey()) return 'not-paired';
        return null;
    }

    status(): AisWatchPushStatus {
        const blocked = this.blocked();
        const ownerId = blocked === 'not-paired' ? null : (this.deps.ownerId?.() ?? null);
        if (blocked) return { state: blocked, checkedAt: this.lastOkAt, ownerId };
        const fresh = this.lastOkAt !== null && this.now() - this.lastOkAt <= PI_PUSH_READY_FOR_MS;
        return { state: fresh && this.devices > 0 ? 'ready' : 'unavailable', checkedAt: this.lastOkAt, ownerId };
    }

    /** One request; the relay's JSON answer, or null when it did not answer 2xx. Never throws. */
    private async post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        const credential = this.deps.credentials();
        const anonKey = this.deps.anonKey();
        if (!credential || !anonKey) return null;
        try {
            const res = await this.deps.fetchImpl(this.deps.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // The anon key is public and is what the gateway checks; the
                    // relay credential is what identifies this Pi.
                    apikey: anonKey,
                    Authorization: `Bearer ${anonKey}`,
                    'X-Thalassa-Pi-Relay-Id': credential.relayId,
                    'X-Thalassa-Pi-Relay-Token': credential.token,
                },
                body: JSON.stringify({ ...body, utc_offset_min: this.utcOffset() }),
                signal: AbortSignal.timeout(this.deps.timeoutMs ?? PI_ALARM_REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) {
                this.failed(`HTTP ${res.status}`);
                return null;
            }
            const answer = (await res.json().catch(() => ({}))) as unknown;
            this.failures = 0;
            this.lastOkAt = this.now();
            return answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
        } catch {
            this.failed('no answer');
            return null;
        }
    }

    private failed(why: string): void {
        // One line per failure run, never per request.
        if (this.failures === 0) console.warn(`[pi-alarm] the relay did not take it (${why})`);
        this.failures += 1;
    }

    private utcOffset(): number | null {
        const offset = this.deps.utcOffsetMin?.() ?? null;
        return offset !== null && Number.isInteger(offset) && offset >= -720 && offset <= 840 ? offset : null;
    }

    private noteDevices(answer: Record<string, unknown>): void {
        const n = answer.devices;
        this.devices = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
    }

    /** Can a push reach the skipper's phone? */
    async probe(): Promise<AisWatchPushState> {
        const blocked = this.blocked();
        if (blocked) return blocked;
        this.lastProbeAt = this.now();
        const answer = await this.post({ action: 'probe' });
        if (answer) this.noteDevices(answer);
        return this.status().state;
    }

    /** One alarm, sent once. */
    async raise(alarm: AisWatchAlarm): Promise<RaiseOutcome> {
        const blocked = this.blocked();
        if (blocked) return blocked;
        if (!isMmsi(alarm.mmsi)) return 'unavailable';
        // The relay has it from here: the next sync can wait its interval.
        this.lastSyncAt = this.now();
        this.relayHasOpen = true;
        const answer = await this.post({ action: 'raise', alarm: wireAlarm(alarm, this.now()) });
        if (answer) this.noteHolds(answer.held === 'hourly' ? 1 : 0);
        return answer ? 'sent' : 'unavailable';
    }

    /** The relay's hourly caps held a push: said once a run, again only after one went. */
    private noteHolds(held: number): void {
        if (held > 0 && !this.holdsLogged) {
            console.warn('[pi-alarm] the relay is holding alarm pushes: its hourly cap is reached');
        }
        this.holdsLogged = held > 0;
    }

    /** The watch blind or without a fix: one ordinary notice. */
    async notice(
        kind: 'blind' | 'no-fix',
        detail: { silentMin?: number; cause?: 'fix' | 'motion' },
    ): Promise<RaiseOutcome> {
        const blocked = this.blocked();
        if (blocked) return blocked;
        const alarm: Record<string, unknown> = { key: `${kind}::${this.now()}`, kind };
        if (kind === 'blind' && detail.silentMin !== undefined) alarm.silent_min = Math.round(detail.silentMin);
        if (kind === 'no-fix') alarm.cause = detail.cause ?? 'fix';
        const answer = await this.post({ action: 'raise', alarm });
        return answer ? 'sent' : 'unavailable';
    }

    /** The open alarms; the keys acknowledged on the relay, or null when it did not answer. */
    async sync(alarms: AisWatchAlarm[]): Promise<string[] | null> {
        if (this.blocked()) return null;
        const now = this.now();
        this.lastSyncAt = now;
        const answer = await this.post({
            action: 'sync',
            alarms: alarms.filter((a) => isMmsi(a.mmsi)).map((a) => wireAlarm(a, now)),
        });
        if (!answer) return null;
        this.relayHasOpen = alarms.length > 0;
        this.noteHolds(typeof answer.held === 'number' ? answer.held : 0);
        const acked = Array.isArray(answer.acked) ? answer.acked : [];
        return acked.filter((k): k is string => typeof k === 'string' && k.length <= 64);
    }

    /** "Send a test from the Pi": through the whole path. */
    async test(): Promise<{ push: AisWatchPushState; queued: boolean }> {
        const blocked = this.blocked();
        if (blocked) return { push: blocked, queued: false };
        const answer = await this.post({ action: 'test' });
        if (answer) this.noteDevices(answer);
        return { push: this.status().state, queued: answer?.queued === true };
    }

    private syncDue(alarms: AisWatchAlarm[], now: number): boolean {
        if (alarms.length === 0) return this.relayHasOpen;
        if (this.lastSyncAt === null) return true;
        const base = alarms.some((a) => a.ackedAt === null) ? PI_ALARM_SYNC_MS : PI_ALARM_SYNC_ACKED_MS;
        const wait = this.failures === 0 ? base : Math.min(PI_ALARM_MAX_BACKOFF_MS, base * 2 ** this.failures);
        return now - this.lastSyncAt >= wait;
    }

    /**
     * After every pass of the watch: probe when armed and hourly, the
     * blind / no-fix notice once per silence, and the sync when it is due.
     * `applyAck` is the watch's own acknowledgement (aisWatch.ack).
     */
    afterPass(d: AisWatchDescription, applyAck: (kind: AisWatchKind, mmsi: number) => void): void {
        const now = this.now();
        if (!d.armed) {
            this.armedSeen = false;
            this.blindNoticed = false;
            this.noFixSince = null;
            this.noFixNoticed = false;
        } else {
            if (!this.armedSeen || (this.lastProbeAt !== null && now - this.lastProbeAt >= PI_ALARM_PROBE_EVERY_MS)) {
                this.armedSeen = true;
                void this.probe();
            }
            this.watchNotices(d, now);
        }

        const open = d.armed ? d.alarms : [];
        if (this.syncing) {
            // Stood down while a sync is out: the closing one is owed.
            this.closeOwed = d.armed ? null : d;
            return;
        }
        this.closeOwed = null;
        if (this.blocked() || !this.syncDue(open, now)) return;
        this.syncing = true;
        void this.sync(open)
            .then((acked) => {
                for (const key of acked ?? []) {
                    // Only an alarm sounding when this sync was built: the answer is about
                    // that moment, so an acknowledged DANGER is never muted afresh.
                    const alarm = open.find((a) => a.key === key && a.ackedAt === null);
                    if (!alarm) continue;
                    try {
                        applyAck(alarm.kind, alarm.mmsi);
                    } catch {
                        /* The watch runs on. */
                    }
                }
            })
            .finally(() => {
                this.syncing = false;
                const owed = this.closeOwed;
                this.closeOwed = null;
                if (owed) this.afterPass(owed, applyAck);
            });
    }

    private watchNotices(d: AisWatchDescription, now: number): void {
        if (d.state === 'blind') {
            const silentSince = Math.max(d.lastAisAt ?? 0, d.armedAt ?? now);
            if (!this.blindNoticed && now - silentSince >= PI_BLIND_NOTICE_AFTER_MS) {
                this.blindNoticed = true;
                void this.notice('blind', { silentMin: Math.floor((now - silentSince) / 60_000) });
            }
        } else {
            this.blindNoticed = false;
        }
        if (d.state === 'no-fix') {
            this.noFixSince ??= now;
            if (!this.noFixNoticed && now - this.noFixSince >= PI_NO_FIX_NOTICE_AFTER_MS) {
                this.noFixNoticed = true;
                void this.notice('no-fix', { cause: d.own === 'unknown' ? 'motion' : 'fix' });
            }
        } else {
            this.noFixSince = null;
            this.noFixNoticed = false;
        }
    }
}
