/**
 * piNightWatch — the phone tells the Pi to keep the night watch (build 126,
 * package 126-04a). Loaded only on a phone with a Pi paired.
 *
 * Shane 2026-08-29: "lets wire up the shore watch to the pi, as long as it
 * still works device to device and pi to device." The Pi grades every AIS
 * target all night with the phone's own rule (pi-cache/src/aisWatch.ts); iOS
 * suspends the phone. So the collision shield drives both, with no new
 * switch:
 *
 *   - ARMING the shield on this phone (through its sound check) arms the Pi
 *     with the skipper's thresholds and our own MMSI (typed in Settings →
 *     Vessel, else the one our transponder reports); DISARMING stands this
 *     phone's arming down; a change to the thresholds while armed is sent
 *     again. Each request names this install (skipperDevice deviceIdReady):
 *     the Pi keeps every device that armed it and stands down when the last
 *     of them disarms, so quietening a tablet never ends the skipper's watch.
 *   - STANDING THE PI DOWN FOR EVERYONE is a separate, deliberate act from
 *     aboard (the second tap on the AIS key's watch row).
 *   - Only a change MADE on this phone is sent. Starting up sends nothing, so
 *     a crew phone with its shield off never stands down a watch the skipper
 *     set, and a phone that was armed before Pi update 2 does not arm a Pi on
 *     its own.
 *   - A change the Pi cannot hear yet waits (in memory) and goes the moment
 *     the boat LAN answers again; a refused one is tried again every 10 s
 *     (never faster, however often the LAN answers). Until then the row under
 *     the shield says so ("The Pi is still watching. Stand it down from
 *     aboard."). A Pi with no night watch (before Pi update 2: no ais_watch
 *     on the LAN, or a 404) is not asked at all.
 *   - ACKNOWLEDGEMENTS made on this phone (a card's Mute, Acknowledge or
 *     Silence) go to the Pi, which settles them for every phone aboard
 *     (services/piNightWatchStatus.ts brings the others' back).
 *
 * Build 126 (126-04b), the Pi wakes a locked phone:
 *   - "SEND A TEST FROM THE PI" (the AIS key, aboard) asks the Pi to push a
 *     test through the whole path (POST /api/ais-watch/test).
 *   - THE CLOUD LINK (startPiAlarmCloud; also started by a push from the Pi,
 *     paired or not): an acknowledgement made here, on any card, goes to
 *     acknowledge_pi_alarm for every key of the Pi's it settles, so the Pi
 *     stops re-sending from wherever the skipper is; aboard it goes to the
 *     Pi over the LAN too (above). When the app wakes ashore with the Pi's
 *     watch on, the owner's open alarms are read from pi_alarm_events and
 *     shown as cards 'from the Pi', and read again every 30 s while one shows.
 *     Before the table exists (the DB push not yet run) it asks once and stops.
 *   - Whether this phone's push token is registered for this account is read
 *     for the AIS key's capability line.
 *
 * Every request to the Pi rides the pinned transport (PiPairingService
 * pinnedPiRequest): the Pi's certificate is pinned to its pairing key, and a
 * plain fetch dies in silence (tests/PiTransportCompleteness.test.ts).
 */
import { AisGuardZone, type GuardZoneState } from './AisGuardZone';
import { AisGuardAlertStore, type AlarmAck } from './aisGuardAlertStore';
import { AisStore } from './AisStore';
import { readCollisionInputs } from './AisGuardWatch';
import { piCache } from './PiCacheService';
import { getPairing, pinnedPiRequest } from './PiPairingService';
import { PiNightWatchStatus } from './piNightWatchStatus';
import { getAuthIdentityScope } from './authIdentityScope';
import type { PiPushState } from '../utils/collisionWatchRow';
import { deviceIdReady } from './skipperDevice';
import { useSettingsStore } from '../stores/settingsStore';
import { sanitiseCollisionPrefs, type CollisionPrefs } from '../utils/collisionRule';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PiNightWatch');

/** A change or acknowledgement the Pi refused or never got is tried again this often. */
export const PI_WATCH_RETRY_MS = 10_000;
const READ_TIMEOUT_MS = 4_000;
/** Acknowledgements waiting for the Pi: at most this many, for at most this long. */
const ACK_QUEUE_MAX = 20;
const ACK_QUEUE_TTL_MS = 10 * 60_000;
/** While a card from the cloud shows, the cloud is asked again this often. */
export const PI_ALARM_CLOUD_POLL_MS = 30_000;
/** At a cold start, the Pi's LAN is given this long to answer before the cloud is asked. */
const CLOUD_COLD_START_MS = 3_000;
/** An open alarm the Pi has not mentioned for this long is not shown from the cloud. */
const CLOUD_ALARM_SEEN_MS = 15 * 60_000;
const PUSH_STATES: ReadonlySet<string> = new Set(['ready', 'unavailable', 'internet-off', 'not-paired']);

type Desired = { armed: true; prefs: CollisionPrefs; ownMmsi?: number } | { armed: false; everyone?: true };

const isMmsi = (n: unknown): n is number =>
    Number.isInteger(n) && (n as number) >= 1_000_000 && (n as number) <= 999_999_999;

function shieldArmed(state: GuardZoneState): boolean {
    return state.enabled && state.collisionChecked === true;
}

function readPrefs(): CollisionPrefs {
    return sanitiseCollisionPrefs(useSettingsStore.getState().settings?.collisionAlarm);
}

/** Our own MMSI: typed in Settings → Vessel, else the one our transponder reports (!AIVDO). */
function ownMmsi(): number | undefined {
    const typed = Number(useSettingsStore.getState().settings?.vessel?.mmsi);
    if (isMmsi(typed)) return typed;
    const heard = AisStore.getOwnMmsi();
    return isMmsi(heard) ? heard : undefined;
}

function armDesire(): Desired {
    const mmsi = ownMmsi();
    return { armed: true, prefs: readPrefs(), ...(mmsi !== undefined ? { ownMmsi: mmsi } : {}) };
}

class PiNightWatchClient {
    private armed = false;
    private prefsKey = '';
    private desired: Desired | null = null;
    private acks: Array<AlarmAck & { queuedAt: number }> = [];
    private sending = false;
    private retry: ReturnType<typeof setTimeout> | null = null;
    /** After a refusal, LAN answers do not send again before this (the 10 s retry does). */
    private backoffUntil = 0;
    private unsubscribers: Array<() => void> = [];
    private running = false;
    private readonly standDown = () => this.want({ armed: false, everyone: true });
    private readonly test = () => this.sendTest();
    /** This phone's token as registered for this account (PushNotificationService), once it has loaded. */
    private token: (() => string | null) | null = null;

    start(): void {
        if (this.running) return;
        this.running = true;
        this.armed = shieldArmed(AisGuardZone.getState());
        this.prefsKey = JSON.stringify(readPrefs());
        PiNightWatchStatus.setPaired(true);
        PiNightWatchStatus.setStandDownHandler(this.standDown);
        PiNightWatchStatus.setTestHandler(this.test);
        startPiAlarmCloud();
        void import('./PushNotificationService')
            .then(({ PushNotificationService }) => {
                // Registered for this account, not merely handed over by APNs:
                // only then can a push to the skipper reach this phone.
                this.token = () => PushNotificationService.getAssociatedToken();
                this.readToken();
            })
            .catch(() => undefined);
        this.unsubscribers = [
            AisGuardZone.subscribe((state) => this.onShield(state)),
            useSettingsStore.subscribe(() => this.onSettings()),
            AisGuardAlertStore.subscribeAcks((ack) => this.onAck(ack)),
            // Every LAN answer: a waiting change goes the moment the Pi is back.
            PiNightWatchStatus.subscribe(() => this.onStatus()),
        ];
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.desired = null;
        this.acks = [];
        this.backoffUntil = 0;
        PiNightWatchStatus.setStandDownHandler(null);
        PiNightWatchStatus.setTestHandler(null);
        PiNightWatchStatus.setPhoneAnchorWatch('none');
        PiNightWatchStatus.setPending(null);
        PiNightWatchStatus.setPaired(false);
    }

    private onShield(state: GuardZoneState): void {
        const armed = shieldArmed(state);
        if (armed === this.armed) return;
        this.armed = armed;
        this.prefsKey = JSON.stringify(readPrefs());
        this.want(armed ? armDesire() : { armed: false });
    }

    private onSettings(): void {
        if (!this.armed) return;
        const key = JSON.stringify(readPrefs());
        if (key === this.prefsKey) return;
        this.prefsKey = key;
        this.want(armDesire());
    }

    private onAck(ack: AlarmAck): void {
        this.acks.push({ ...ack, queuedAt: Date.now() });
        if (this.acks.length > ACK_QUEUE_MAX) this.acks.splice(0, this.acks.length - ACK_QUEUE_MAX);
        void this.flush();
    }

    private onStatus(): void {
        this.readToken();
        this.readAnchorWatch();
        if (!this.desired && this.acks.length === 0) return;
        if (!PiNightWatchStatus.reachable() || Date.now() < this.backoffUntil) return;
        void this.flush();
    }

    /**
     * The Pi counts as at anchor only while it keeps an anchor watch itself.
     * While it says it keeps none, read whether this phone (or the device it
     * joined) puts the boat at anchor, so the row can say the Pi cannot see
     * that watch. Read on every LAN answer, only then.
     */
    private readAnchorWatch(): void {
        let mine: 'at-anchor' | 'elsewhere' | 'none' = 'none';
        if (PiNightWatchStatus.piAtAnchor() === false) {
            try {
                mine = readCollisionInputs().anchorWatch;
            } catch {
                mine = 'none';
            }
        }
        PiNightWatchStatus.setPhoneAnchorWatch(mine);
    }

    /** Whether this phone has a push token registered for this account, for the AIS key's capability line. */
    private readToken(): void {
        if (!this.running || !this.token) return;
        try {
            PiNightWatchStatus.setPushTokenHere(this.token() !== null);
        } catch {
            PiNightWatchStatus.setPushTokenHere(false);
        }
    }

    /** "Send a test from the Pi": the Pi's answer, or null when this phone cannot reach it. */
    private async sendTest(): Promise<{ push: PiPushState | null; queued: boolean } | null> {
        if (!this.running || !getPairing() || !PiNightWatchStatus.reachable()) return null;
        const body = await this.post('/api/ais-watch/test', {});
        if (body === null || body === 'gone') return null;
        const push = typeof body.push === 'string' && PUSH_STATES.has(body.push) ? (body.push as PiPushState) : null;
        return { push, queued: body.queued === true };
    }

    private want(next: Desired): void {
        this.desired = next;
        PiNightWatchStatus.setPending(next.armed ? 'arm' : 'disarm');
        void this.flush();
    }

    /** Which of the Pi's addresses to use: the one the LAN lane last heard her on. */
    private baseUrl(): string | null {
        const remote = PiNightWatchStatus.answeredVia() === 'tailnet-host' ? piCache.getRemoteBaseUrl() : null;
        return (remote ?? piCache.getBaseUrl())?.replace(/\/$/, '') ?? null;
    }

    /** The Pi's answer, 'gone' when it has no such endpoint (before Pi update 2), or null when it did not take it. */
    private async post(path: string, data: unknown): Promise<Record<string, unknown> | 'gone' | null> {
        const base = this.baseUrl();
        if (!base) return null;
        try {
            const res = await pinnedPiRequest({
                url: `${base}${path}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                data,
                readTimeout: READ_TIMEOUT_MS,
                responseType: 'text',
            });
            if (res.status === 404) {
                log.warn(`the Pi has no ${path} (no night watch before Pi update 2)`);
                return 'gone';
            }
            if (res.status < 200 || res.status >= 300) {
                log.warn(`the Pi refused ${path} (HTTP ${res.status})`);
                return null;
            }
            try {
                const body = JSON.parse(typeof res.data === 'string' ? res.data : '{}') as unknown;
                return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
            } catch {
                return {};
            }
        } catch (error) {
            log.warn(`the Pi did not take ${path}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /** Send what waits, in order: the watch first, then the acknowledgements. */
    private async flush(): Promise<void> {
        if (this.sending || !this.running) return;
        this.sending = true;
        let refused = false;
        try {
            const device = await deviceIdReady();
            // A Pi that answers the LAN with no night watch is not asked: the
            // change waits for a Pi that has one (the row says this Pi has none).
            while (
                this.running &&
                getPairing() &&
                PiNightWatchStatus.reachable() &&
                PiNightWatchStatus.hasNightWatch() !== false
            ) {
                if (this.desired) {
                    const desired = this.desired;
                    const body = await this.post('/api/ais-watch', { ...desired, device });
                    if (body === null) {
                        refused = true;
                        break;
                    }
                    // Sent, or a Pi with no such endpoint: either way nothing waits.
                    if (this.desired === desired) {
                        this.desired = null;
                        PiNightWatchStatus.setPending(null);
                    }
                    if (body === 'gone') {
                        this.acks = [];
                        break;
                    }
                    continue;
                }
                const now = Date.now();
                this.acks = this.acks.filter((a) => now - a.queuedAt <= ACK_QUEUE_TTL_MS);
                const ack = this.acks[0];
                if (!ack) break;
                const body = await this.post('/api/ais-watch/ack', { kind: ack.kind, mmsi: ack.mmsi });
                if (body === null) {
                    refused = true;
                    break;
                }
                // Taken (the Pi keeps one it has no alarm for yet), or a Pi with no watch to take it.
                this.acks.shift();
            }
        } catch (error) {
            refused = true;
            log.warn(`night watch link: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.sending = false;
            if (refused) this.backoffUntil = Date.now() + PI_WATCH_RETRY_MS;
            this.scheduleRetry();
        }
    }

    private scheduleRetry(): void {
        if (!this.running || this.retry || (!this.desired && this.acks.length === 0)) return;
        // A Pi with no night watch: nothing to try again until it has one (a LAN answer says so).
        if (PiNightWatchStatus.hasNightWatch() === false) return;
        this.retry = setTimeout(() => {
            this.retry = null;
            void this.flush();
        }, PI_WATCH_RETRY_MS);
    }
}

// ── The cloud link (126-04b) ──────────────────────────────────────────────

const signedIn = () => getAuthIdentityScope().userId !== null;
/** The table is not there yet (the DB push not run), or this account may not read it: stop asking. */
let cloudDisabled = false;
let cloudFetching: Promise<void> | null = null;

/** The owner's open, unacknowledged, recent alarms from pi_alarm_events, as cards 'from the Pi'. */
export function refreshPiAlarms(): Promise<void> {
    if (cloudDisabled || !signedIn()) return Promise.resolve();
    cloudFetching ??= (async () => {
        try {
            const { supabase } = await import('./supabase');
            if (!supabase) return;
            const { data, error } = await supabase
                .from('pi_alarm_events')
                .select('alarm_key, kind, mmsi, payload, raised_at')
                .is('resolved_at', null)
                .is('acked_at', null)
                .in('kind', ['collision', 'close-quarters', 'distress'])
                .gte('last_seen_at', new Date(Date.now() - CLOUD_ALARM_SEEN_MS).toISOString())
                .order('raised_at', { ascending: false })
                .limit(20);
            if (error) {
                const code = (error as { code?: string }).code ?? '';
                if (code === '42P01' || code === 'PGRST205' || code === '42501') cloudDisabled = true;
                log.warn(`the Pi's alarms could not be read from the cloud (${code || 'error'})`);
                return;
            }
            const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
            PiNightWatchStatus.setCloudAlarms(
                rows.map((r) => ({
                    ...(r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {}),
                    alarm_key: r.alarm_key,
                    kind: r.kind,
                    mmsi: r.mmsi,
                    raised_at_ms: typeof r.raised_at === 'string' ? Date.parse(r.raised_at) : null,
                })),
            );
        } catch (error) {
            log.warn(`the Pi's alarms: ${error instanceof Error ? error.message : String(error)}`);
        }
    })().finally(() => {
        cloudFetching = null;
    });
    return cloudFetching;
}

class PiAlarmCloudLink {
    private stops: Array<() => void> = [];
    private poll: ReturnType<typeof setInterval> | null = null;

    start(): void {
        if (this.stops.length > 0) return;
        const onVisible = () => this.resume();
        document.addEventListener('visibilitychange', onVisible);
        const cold = setTimeout(() => this.resume(), CLOUD_COLD_START_MS);
        this.stops = [
            AisGuardAlertStore.subscribeAcks((ack) => void this.acknowledge(ack)),
            PiNightWatchStatus.subscribe(() => this.schedulePoll()),
            () => document.removeEventListener('visibilitychange', onVisible),
            () => clearTimeout(cold),
        ];
        this.schedulePoll();
    }

    stop(): void {
        for (const stop of this.stops) stop();
        this.stops = [];
        if (this.poll) clearInterval(this.poll);
        this.poll = null;
    }

    /** Waking ashore with the Pi's watch on (aboard, the LAN says it all). */
    private resume(): void {
        if (document.visibilityState === 'hidden' || PiNightWatchStatus.reachable()) return;
        if (PiNightWatchStatus.watchKnownOn() || PiNightWatchStatus.hasCloudAlarms()) void refreshPiAlarms();
    }

    /** While a card from the cloud shows, ask again, so one resolved or acknowledged elsewhere goes. */
    private schedulePoll(): void {
        const want = PiNightWatchStatus.hasCloudAlarms() && !cloudDisabled;
        if (want && !this.poll) {
            this.poll = setInterval(() => {
                if (document.visibilityState !== 'hidden') void refreshPiAlarms();
            }, PI_ALARM_CLOUD_POLL_MS);
        } else if (!want && this.poll) {
            clearInterval(this.poll);
            this.poll = null;
        }
    }

    /** Every key of the Pi's this acknowledgement settles, to the cloud: the Pi stops re-sending. */
    private async acknowledge(ack: AlarmAck): Promise<void> {
        const keys = PiNightWatchStatus.keysFor(ack.kind, ack.mmsi);
        if (keys.length === 0 || !signedIn()) return;
        try {
            const { supabase } = await import('./supabase');
            if (!supabase) return;
            for (const key of keys) {
                const { error } = await supabase.rpc('acknowledge_pi_alarm', { p_alarm_key: key });
                if (error) log.warn(`the cloud did not take the acknowledgement (${error.code ?? 'error'})`);
                else PiNightWatchStatus.markCloudAcked(key);
            }
        } catch (error) {
            log.warn(`acknowledgement to the cloud: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

let cloudLink: PiAlarmCloudLink | null = null;

/** Start the cloud half (acknowledgements from anywhere, the open alarms on waking). Idempotent. */
export function startPiAlarmCloud(): void {
    cloudLink ??= new PiAlarmCloudLink();
    cloudLink.start();
}

let client: PiNightWatchClient | null = null;

/** Start the phone's half of the Pi's night watch. Idempotent; returns the stopper. */
export function startPiNightWatch(): () => void {
    client ??= new PiNightWatchClient();
    client.start();
    const mine = client;
    return () => mine.stop();
}

/** Test seam. */
export function __resetPiNightWatchForTests(): void {
    client?.stop();
    client = null;
    cloudLink?.stop();
    cloudLink = null;
    cloudDisabled = false;
    cloudFetching = null;
}
