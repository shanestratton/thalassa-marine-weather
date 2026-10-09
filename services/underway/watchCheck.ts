/**
 * The watch check (build 126, 126-02b): a dead-man check while a voyage track
 * records on this phone. Loaded lazily, on idle, by hooks/useAppBootstrap.ts;
 * the rule is ./watchCheckRule.ts.
 *
 *  - OFF by default (Settings → Preferences → Under-way alarms); every 10,
 *    15, 20 or 30 min, 15 by default. No tier check: safety is never paywalled.
 *  - BOOKED AHEAD with iOS through the shared safety path
 *    (AnchorSafetyNotificationService), kind 'watch-check': Time Sensitive,
 *    its own three ids, the primary `leadSeconds` ahead and two reminders 30 s
 *    apart, so it reaches a locked phone with Thalassa suspended or killed.
 *    Focus lets it through only where the skipper allows Thalassa's Time
 *    Sensitive notifications; when iOS will not take it, the strip says so.
 *  - A minute before each check a card says so; at the check the phone
 *    sounds through AlarmAudioService under its own 'watch-check' lease
 *    (owner-scoped, never a force-stop: no other alarm is touched). Only
 *    "I'm on watch" answers it: it withdraws the booking and books the next
 *    check one interval from the tap. Opening the app is not an answer.
 *  - Runs only while a voyage track records, never from a berth or at
 *    anchor: the first check is booked once she has been under way for 10 s,
 *    and any anchor watch for her holds it (as a paused track does), booking
 *    afresh from the moment it ends. Stopped (her fixes within 50 m for
 *    10 min), an answered check waits once somebody has tapped I'm on watch
 *    since she stopped (a berth, an anchorage), until she is under way and
 *    clear of that spot. A stop never silences an unanswered check: aground
 *    with nobody on watch is exactly what it is for. Hove-to or becalmed she
 *    drifts further than 50 m, and it runs on.
 *  - Saved per account (Capacitor Preferences): the voyage, the next check,
 *    the interval, and a check still unanswered. A fresh process leaves what
 *    the last one booked with iOS until the Ship's Log says what records:
 *    the same voyage, and it books it again (a check that came due meanwhile
 *    is a "Missed watch check at …" that sounds until the tap, and books the
 *    next); ended, paused or another voyage, and it withdraws it.
 */
import { Preferences } from '@capacitor/preferences';
import { AlarmAudioService } from '../AlarmAudioService';
import { AnchorSafetyNotificationService } from '../AnchorSafetyNotificationService';
import { ShipLogService } from '../ShipLogService';
import { NmeaStore } from '../NmeaStore';
import { GpsService } from '../GpsService';
import { LocationStore } from '../../stores/LocationStore';
import { awaitSettingsLoaded, useSettingsStore } from '../../stores/settingsStore';
import { readCollisionAnchorWatch } from '../collisionAnchorWatch';
import { resolveOwnMotion, resolveOwnshipPosition } from '../ownshipPosition';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { collisionOwnStill } from '../../utils/collisionRule';
import { createLogger } from '../../utils/createLogger';
import { UnderwayAlarmStore } from './underwayAlarmStore';
import { sanitiseUnderwayPrefs } from './underwayRule';
import {
    WATCH_CHECK_NOTICES,
    WATCH_CHECK_START,
    WATCH_CHECK_STOPPED_WITHIN_M,
    metresBetween,
    nextWatchCheck,
    nextWatchCheckSpot,
    watchCheckCard,
    watchCheckLeadSeconds,
    watchCheckLockScreen,
    watchCheckStopped,
    type WatchCheckEvent,
    type WatchCheckSpot,
    type WatchCheckState,
} from './watchCheckRule';

const log = createLogger('WatchCheck');

export const WATCH_CHECK_STORAGE_KEY = 'thalassa_watch_check_v1';
const LEASE_OWNER = 'watch-check';
const TICK_MS = 5_000;
/** Under way this long, without a stop, before the first check is booked: a GPS blip at a berth is not a passage. */
const UNDER_WAY_FOR_MS = 10_000;
/** A phone fix older than this says nothing about where she is now (ownshipPosition's own limit). */
const PHONE_FIX_MAX_AGE_MS = 60_000;

/** Everything one pass needs, read once. Exported so tests can hand it in. */
export interface WatchCheckInputs {
    nowMs: number;
    enabled: boolean;
    intervalMin: number;
    /** A voyage track records on this phone (not paused). */
    recording: boolean;
    trackPaused: boolean;
    voyageId: string | null;
    sogKn: number | null;
    /** Her own fresh fix (the boat's GPS, else this phone's), or null. */
    position: { lat: number; lon: number } | null;
    /** Any anchor watch is on for her (services/collisionAnchorWatch.ts: at anchor, or kept elsewhere). */
    atAnchor: boolean;
    /**
     * The Ship's Log has published this account's tracking state since this
     * process started. Until it has, "not recording" may only mean it has not
     * reconciled yet, so the last process's booking is left with iOS.
     */
    logSpoke: boolean;
}

interface SavedCheck {
    voyageId: string;
    dueAt: number;
    intervalMin: number;
    /** A check still unanswered: when it was due. */
    missedAt?: number;
}

export function readWatchCheckInputs(nowMs: number = Date.now()): WatchCheckInputs {
    const prefs = sanitiseUnderwayPrefs(useSettingsStore.getState().settings?.underwayAlarms).watchCheck;
    const track = ShipLogService.getPublishedTrackingStatus();
    const nmea = NmeaStore.getState();
    const phone = GpsService.getLastKnownPosition();
    const boat = resolveOwnshipPosition(nmea, LocationStore.getState(), nowMs);
    const own =
        boat?.source === 'nmea'
            ? { lat: boat.lat, lon: boat.lon, source: 'nmea' as const }
            : phone
              ? { lat: phone.latitude, lon: phone.longitude, source: 'gps' as const }
              : null;
    const phoneFresh = !!phone && Math.abs(nowMs - phone.timestamp) <= PHONE_FIX_MAX_AGE_MS;
    return {
        nowMs,
        enabled: prefs.enabled,
        intervalMin: prefs.intervalMin,
        recording: track.isTracking === true && track.isPaused !== true,
        trackPaused: track.isPaused === true,
        voyageId: track.currentVoyageId ?? null,
        sogKn: resolveOwnMotion(nmea, phone, nowMs).sogKn,
        position: boat
            ? { lat: boat.lat, lon: boat.lon }
            : phoneFresh
              ? { lat: phone.latitude, lon: phone.longitude }
              : null,
        atAnchor: readCollisionAnchorWatch(own) !== 'none',
        logSpoke:
            (heardFrom !== null && isAuthIdentityScopeCurrent(heardFrom)) ||
            track.isTracking === true ||
            track.isPaused === true ||
            typeof track.currentVoyageId === 'string',
    };
}

// ── State ───────────────────────────────────────────────────────────────────

let state: WatchCheckState = WATCH_CHECK_START;
/** Whose check it is, and on which voyage ('' for a recording with no id yet; null for none). */
let owner: AuthIdentityScope | null = null;
let voyage: string | null = null;
/** The saved check for the current account: undefined until read. */
let saved: SavedCheck | null | undefined;
let loadedFor: AuthIdentityScope | null = null;
let underWaySince: number | null = null;
/** The voyage she has been under way on (null: not yet), so a berth never books a check. */
let armedVoyage: string | null = null;
/** Where she has stayed put, and since when. */
let spot: WatchCheckSpot | null = null;
/** The last I'm on watch, epoch ms. */
let lastAckAt: number | null = null;
/** Held because she stopped after an answer: where. It waits until she is under way clear of it. */
let stopHoldAt: { lat: number; lon: number } | null = null;
/** The account the Ship's Log last published for (after this module subscribed). */
let heardFrom: AuthIdentityScope | null = null;
/** Why nothing is booked with iOS ('refused', or 'app-only' off iOS), else null. */
let bookingProblem: 'refused' | 'app-only' | null = null;
/** What the strip says this pass (besides a booking problem). */
let standing: string | null = null;

let token: string | null = null;
let wantSound = false;
/** A sound change is queued: it acts on the latest wish, so one is enough. */
let soundQueued = false;
let tail: Promise<void> = Promise.resolve();
let loading: Promise<void> = Promise.resolve();
/** Bumped by every load and stop, so a late read never lands in a newer one. */
let loadGeneration = 0;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribers: Array<() => void> = [];
let queued = false;

/** Side effects run one at a time, in order, so the last word always wins. */
function run(operation: () => Promise<void>): void {
    tail = tail.then(operation).catch((error) => log.warn('watch check side effect failed:', error));
}

function storageKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(WATCH_CHECK_STORAGE_KEY, scope);
}

function parseSaved(raw: string | null): SavedCheck | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<SavedCheck>;
        return typeof v.voyageId === 'string' &&
            typeof v.dueAt === 'number' &&
            Number.isFinite(v.dueAt) &&
            typeof v.intervalMin === 'number' &&
            v.intervalMin > 0
            ? {
                  voyageId: v.voyageId,
                  dueAt: v.dueAt,
                  intervalMin: v.intervalMin,
                  ...(typeof v.missedAt === 'number' && Number.isFinite(v.missedAt) ? { missedAt: v.missedAt } : {}),
              }
            : null;
    } catch {
        return null;
    }
}

/** Save (or with null, forget) the account's check. Never writes into a newer account. */
function persist(scope: AuthIdentityScope, next: SavedCheck | null): void {
    if (isAuthIdentityScopeCurrent(scope)) saved = next;
    const key = storageKey(scope);
    run(async () => {
        if (next && !isAuthIdentityScopeCurrent(scope)) return;
        await (next ? Preferences.set({ key, value: JSON.stringify(next) }) : Preferences.remove({ key })).catch(
            (error) => log.warn('watch check could not be saved:', error),
        );
    });
}

/** Forget a saved check this process never took up, and withdraw what the last process booked for it. */
function forgetSaved(): void {
    withdraw();
    persist(getAuthIdentityScope(), null);
}

function withdraw(): void {
    run(async () => {
        await AnchorSafetyNotificationService.cancelSafetyAlert('watch-check').catch((error) =>
            log.warn('watch check booking could not be withdrawn:', error),
        );
    });
}

/** Withdraw any booking, then book the check iOS must deliver if nobody taps. */
function book(dueAt: number, intervalMin: number, nowMs: number): void {
    const leadSeconds = watchCheckLeadSeconds(dueAt, nowMs);
    const { title, body } = watchCheckLockScreen(intervalMin);
    withdraw();
    run(async () => {
        try {
            const booked = await AnchorSafetyNotificationService.scheduleSafetyAlert('watch-check', title, body, {
                leadSeconds,
            });
            bookingProblem = booked ? null : 'app-only';
        } catch (error) {
            bookingProblem = 'refused';
            log.warn('watch check could not be booked with iOS:', error);
        }
        publish(Date.now());
    });
}

/**
 * Sound while a check is unanswered; release only this lease, never
 * force-stop. A start that failed (another app's audio, a call) is tried
 * again on the next pass while it is still wanted.
 */
function sound(want: boolean): void {
    if (want === wantSound && !(want && token === null)) return;
    wantSound = want;
    if (soundQueued) return;
    soundQueued = true;
    run(async () => {
        soundQueued = false;
        // Act on the LATEST wish, not on what was true when this was queued.
        if (wantSound && !token) {
            token = await AlarmAudioService.acquire(LEASE_OWNER).catch((error) => {
                log.warn('watch check alarm audio could not start:', error);
                return null;
            });
        } else if (!wantSound && token) {
            const held = token;
            token = null;
            await AlarmAudioService.release(held).catch(() => AlarmAudioService.releaseEventually(held));
        }
    });
}

/** One event through the rule, and what it means for iOS, the sound and the saved check. */
function apply(event: WatchCheckEvent, nowMs: number): void {
    const step = nextWatchCheck(state, event, nowMs);
    const was = state;
    state = step.state;
    if (step.booking === 'book' && state.dueAt !== null) book(state.dueAt, state.intervalMin, nowMs);
    else if (step.booking === 'cancel') {
        withdraw();
        bookingProblem = null;
    }
    sound(state.phase === 'sounding');
    const scope = owner ?? getAuthIdentityScope();
    if ((state.phase === 'waiting' || state.phase === 'sounding') && state.dueAt !== null && voyage !== null) {
        const missedAt = state.phase === 'sounding' ? state.missedAt : null;
        if (
            !saved ||
            saved.voyageId !== voyage ||
            saved.dueAt !== state.dueAt ||
            saved.intervalMin !== state.intervalMin ||
            (saved.missedAt ?? null) !== missedAt
        ) {
            owner = scope;
            persist(scope, {
                voyageId: voyage,
                dueAt: state.dueAt,
                intervalMin: state.intervalMin,
                ...(missedAt !== null ? { missedAt } : {}),
            });
        }
    } else if (was.phase !== state.phase && (state.phase === 'off' || state.phase === 'held')) {
        persist(scope, null);
        if (state.phase === 'off') {
            owner = null;
            voyage = null;
        }
    }
}

function publish(nowMs: number): void {
    const notices: string[] = [];
    if (state.phase === 'waiting' || state.phase === 'sounding') {
        if (bookingProblem === 'refused') notices.push(WATCH_CHECK_NOTICES.notBooked);
        else if (bookingProblem === 'app-only') notices.push(WATCH_CHECK_NOTICES.appOnly);
    } else if (standing) notices.push(standing);
    UnderwayAlarmStore.setWatchCheck(watchCheckCard(state, nowMs), notices);
}

/** One pass of the watch check. Exported for tests, which hand in their own inputs. */
export function runWatchCheckPass(inputs: WatchCheckInputs = readWatchCheckInputs()): void {
    const { nowMs } = inputs;
    keepTicking(inputs.enabled && inputs.recording);
    // Until this account's saved check is read, a not-yet-recording boot must not be taken for an ended voyage.
    if (saved === undefined || !loadedFor || !isAuthIdentityScopeCurrent(loadedFor)) return;
    standing = null;

    if (!inputs.enabled) {
        apply({ type: 'end' }, nowMs);
        if (saved) forgetSaved();
        reset();
        return publish(nowMs);
    }
    if (!inputs.recording && !inputs.trackPaused) {
        // Not recording. A fresh process hears nothing from the Ship's Log
        // until it reconciles, so a saved check (and the booking the last
        // process left with iOS) stands until the log has said so; a running
        // check is over.
        if (state.phase !== 'off') apply({ type: 'end' }, nowMs);
        else if (saved && inputs.logSpoke) forgetSaved();
        reset();
        return publish(nowMs);
    }
    const voyageKey = inputs.voyageId ?? '';
    if (state.phase !== 'off' && voyageKey !== voyage) {
        apply({ type: 'end' }, nowMs); // a different voyage: start afresh
        reset();
    }
    voyage = voyageKey;
    const stopped = watchMotion(inputs, voyageKey);

    if (inputs.trackPaused || inputs.atAnchor) {
        if (state.phase === 'waiting' || state.phase === 'sounding') apply({ type: 'pause' }, nowMs);
        else if (saved) forgetSaved(); // held when it was last seen: no missed check
        if (inputs.atAnchor && inputs.recording) standing = WATCH_CHECK_NOTICES.atAnchor;
        return publish(nowMs);
    }

    if (state.phase === 'off') {
        if (saved && saved.voyageId === voyageKey) {
            armedVoyage = voyageKey;
            apply({ type: 'relaunch', saved }, nowMs);
        } else {
            if (saved) forgetSaved(); // another voyage's: not a missed check
            if (armedVoyage === voyageKey) apply({ type: 'start', intervalMin: inputs.intervalMin }, nowMs);
        }
    }
    // Stopped, and somebody has answered since she stopped: a berth or an
    // anchorage. An answered check waits; an unanswered one never does.
    if (state.phase === 'waiting' && stopped && spot && lastAckAt !== null && lastAckAt >= spot.since) {
        apply({ type: 'pause' }, nowMs);
        stopHoldAt = { lat: spot.lat, lon: spot.lon };
        armedVoyage = null;
    }
    if (state.phase === 'held' && armedVoyage === voyageKey) {
        apply({ type: 'resume' }, nowMs);
        stopHoldAt = null;
    }
    if (state.phase === 'off' || state.phase === 'held') {
        standing = stopHoldAt ? WATCH_CHECK_NOTICES.stopped : WATCH_CHECK_NOTICES.notUnderWay;
    }
    if (inputs.intervalMin !== state.intervalMin) apply({ type: 'interval', intervalMin: inputs.intervalMin }, nowMs);
    apply({ type: 'due' }, nowMs);
    publish(nowMs);
}

/**
 * Where she has stayed and whether she is under way: under way 10 s arms
 * the voyage (after a stop hold, only clear of the spot where she stopped).
 * Returns whether she is stopped.
 */
function watchMotion(inputs: WatchCheckInputs, voyageKey: string): boolean {
    const { nowMs, sogKn, position } = inputs;
    const underWay = sogKn !== null && !collisionOwnStill(sogKn, false);
    underWaySince = underWay ? (underWaySince ?? nowMs) : null;
    spot = nextWatchCheckSpot(spot, position, nowMs);
    const clear =
        !stopHoldAt || (position !== null && metresBetween(stopHoldAt, position) > WATCH_CHECK_STOPPED_WITHIN_M);
    if (underWaySince !== null && nowMs - underWaySince >= UNDER_WAY_FOR_MS && clear) armedVoyage = voyageKey;
    return watchCheckStopped(spot, nowMs);
}

function reset(): void {
    underWaySince = null;
    armedVoyage = null;
    spot = null;
    lastAckAt = null;
    stopHoldAt = null;
}

function safePass(why: string): void {
    try {
        runWatchCheckPass();
    } catch (error) {
        log.warn(`watch check pass failed on ${why}:`, error);
    }
}

/** A burst of changes gets one pass, a microtask after the first. */
function queuePass(): void {
    if (queued || !started) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        if (started) safePass('change');
    });
}

/** The tick runs only while there is something to watch: switched on and recording. */
function keepTicking(on: boolean): void {
    if (!started) return;
    if (on && !timer) timer = setInterval(() => safePass('tick'), TICK_MS);
    else if (!on && timer) {
        clearInterval(timer);
        timer = null;
    }
}

/**
 * Read this account's saved check, after the settings' own disk load (a cold
 * boot reads the switch as off until then, and that must not forget a check)
 * and after any save still queued (a stop and start in one JS context). What
 * the last process booked stays with iOS: the passes reconcile it once the
 * Ship's Log has said what records.
 */
function load(scope: AuthIdentityScope): void {
    saved = undefined;
    loadedFor = null;
    const generation = ++loadGeneration;
    loading = tail
        .then(() =>
            Promise.all([
                Preferences.get({ key: storageKey(scope) })
                    .then(({ value }) => parseSaved(value))
                    .catch(() => null),
                awaitSettingsLoaded().catch(() => undefined),
            ]),
        )
        .then(([found]) => {
            if (generation !== loadGeneration || !started || !isAuthIdentityScopeCurrent(scope)) return;
            saved = found;
            loadedFor = scope;
            safePass('load');
        });
}

/** The account changed: the old account's check is withdrawn, silenced and forgotten. */
function onIdentity(next: AuthIdentityScope, previous: AuthIdentityScope): void {
    const had = state.phase !== 'off' || !!saved;
    state = WATCH_CHECK_START;
    owner = null;
    voyage = null;
    heardFrom = null;
    reset();
    bookingProblem = null;
    standing = null;
    if (had) {
        withdraw();
        persist(previous, null);
    }
    sound(false);
    publish(Date.now());
    load(next);
}

function onVisible(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') queuePass();
}

/** Start the watch check. Idempotent; returns the stopper. */
export function startWatchCheck(): () => void {
    if (started) return stopWatchCheck;
    started = true;
    // The log calls back once at once with its unreconciled state; only what it publishes after is its word.
    let subscribing = true;
    const offTracking = ShipLogService.onTrackingStateChange(() => {
        if (!subscribing) heardFrom = getAuthIdentityScope();
        queuePass();
    });
    subscribing = false;
    unsubscribers = [
        offTracking,
        useSettingsStore.subscribe(queuePass),
        subscribeAuthIdentityScope(onIdentity),
        UnderwayAlarmStore.subscribeActions(({ kind, nowMs }) => {
            if (kind !== 'watch-check') return;
            if (state.phase === 'waiting' || state.phase === 'sounding') lastAckAt = nowMs;
            apply({ type: 'ack' }, nowMs);
            publish(nowMs);
            queuePass(); // stopped at a berth, the answer holds it at once
        }),
    ];
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible);
        unsubscribers.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
    load(getAuthIdentityScope());
    return stopWatchCheck;
}

/**
 * Stop: silence it and take its card down. A booking stays with iOS, and so
 * does the saved check: the watch check is only stopped with the app, and a
 * booked check is exactly what must still fire then. What this process knew
 * is forgotten, so a later start in the same JS context (a remount after a
 * render crash) takes the saved check up exactly as a fresh process would:
 * booked again, or missed.
 */
export function stopWatchCheck(): void {
    if (timer) clearInterval(timer);
    timer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    started = false;
    queued = false;
    loadGeneration++;
    sound(false);
    state = WATCH_CHECK_START;
    owner = null;
    voyage = null;
    saved = undefined;
    loadedFor = null;
    heardFrom = null;
    reset();
    bookingProblem = null;
    standing = null;
    UnderwayAlarmStore.setWatchCheck(null, []);
}

export const WatchCheck = {
    getState(): WatchCheckState {
        return state;
    },

    /** Test seam: resolves once the saved check is read and every queued side effect has run. */
    async whenIdle(): Promise<void> {
        await loading;
        let seen: Promise<void> | null = null;
        while (seen !== tail) {
            seen = tail;
            await tail;
        }
    },

    /** Test seam. */
    __resetForTests(): void {
        stopWatchCheck();
        state = WATCH_CHECK_START;
        owner = null;
        voyage = null;
        saved = undefined;
        loadedFor = null;
        reset();
        bookingProblem = null;
        standing = null;
        token = null;
        wantSound = false;
        soundQueued = false;
        heardFrom = null;
        tail = Promise.resolve();
        loading = Promise.resolve();
    },
};
