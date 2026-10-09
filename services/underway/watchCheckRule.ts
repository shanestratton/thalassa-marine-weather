/**
 * The watch check's rule (build 126, 126-02b): pure, no clocks, no I/O. The
 * service that runs it (./watchCheck.ts) books what it says with iOS, sounds
 * it, saves it and publishes its card; the fixture and the tests read the
 * same words from here.
 *
 * A dead-man check while a voyage track records: every interval somebody on
 * watch taps "I'm on watch". A minute before each check a card says so. At
 * the check the phone sounds, and the alert booked ahead with iOS reaches
 * the lock screen even with Thalassa suspended. Only the tap answers it; it
 * books the next check one interval from the tap.
 */
import type { UnderwayAlarmCard } from './underwayAlarmStore';
import { rangeBearing } from '../../utils/collisionRule';

const MIN_MS = 60_000;
const METRES_PER_NM = 1852;

/** The heads-up card shows this long before a check. */
export const WATCH_CHECK_WARN_MS = MIN_MS;
/**
 * iOS delivers the check and two reminders 30 s apart, so a check first seen
 * later than this (the app killed or asleep) was missed, and says so.
 */
export const WATCH_CHECK_MISSED_AFTER_MS = 90_000;

/**
 * 'off': not running (no recording, or switched off). 'held': the track is
 * paused or an anchor watch is on, nothing booked. 'waiting': the next check
 * is booked for `dueAt`. 'sounding': a check came due, unanswered.
 */
export type WatchCheckPhase = 'off' | 'held' | 'waiting' | 'sounding';

export interface WatchCheckState {
    phase: WatchCheckPhase;
    intervalMin: number;
    /** When the check booked with iOS comes (or came) due, epoch ms; null when nothing is booked. */
    dueAt: number | null;
    /**
     * Sounding for a check that came due unseen (Thalassa asleep or killed),
     * or still unanswered when Thalassa was killed again: when it was due.
     * Null otherwise. Saved with the check, so only the tap clears it.
     */
    missedAt: number | null;
}

export const WATCH_CHECK_START: WatchCheckState = Object.freeze({
    phase: 'off',
    intervalMin: 15,
    dueAt: null,
    missedAt: null,
});

export type WatchCheckEvent =
    /** Switched on, recording, under way, no anchor watch: the first check. */
    | { type: 'start'; intervalMin: number }
    /** "I'm on watch". */
    | { type: 'ack' }
    /** The track paused, or an anchor watch is on. */
    | { type: 'pause' }
    | { type: 'resume' }
    /** The track ended, the switch went off, or the account changed. */
    | { type: 'end' }
    /** A tick: has the check come due? */
    | { type: 'due' }
    /** A fresh process found this check saved for the voyage still recording. */
    | { type: 'relaunch'; saved: { dueAt: number; intervalMin: number; missedAt?: number | null } }
    | { type: 'interval'; intervalMin: number };

export interface WatchCheckStep {
    state: WatchCheckState;
    /** 'book': withdraw any booking, then book `state.dueAt`. 'cancel': withdraw it. 'keep': leave iOS alone. */
    booking: 'book' | 'cancel' | 'keep';
}

const running = (s: WatchCheckState) => s.phase === 'waiting' || s.phase === 'sounding';
const nextAt = (intervalMin: number, nowMs: number) => nowMs + intervalMin * MIN_MS;
const keep = (state: WatchCheckState): WatchCheckStep => ({ state, booking: 'keep' });
const waiting = (intervalMin: number, dueAt: number): WatchCheckState => ({
    phase: 'waiting',
    intervalMin,
    dueAt,
    missedAt: null,
});

export function nextWatchCheck(state: WatchCheckState, event: WatchCheckEvent, nowMs: number): WatchCheckStep {
    switch (event.type) {
        case 'start':
            if (running(state)) return keep(state);
            return { state: waiting(event.intervalMin, nextAt(event.intervalMin, nowMs)), booking: 'book' };
        case 'ack':
            if (!running(state)) return keep(state);
            return { state: waiting(state.intervalMin, nextAt(state.intervalMin, nowMs)), booking: 'book' };
        case 'pause':
            if (!running(state)) return keep(state);
            return { state: { ...state, phase: 'held', dueAt: null, missedAt: null }, booking: 'cancel' };
        case 'resume':
            if (state.phase !== 'held') return keep(state);
            return { state: waiting(state.intervalMin, nextAt(state.intervalMin, nowMs)), booking: 'book' };
        case 'end':
            return state.phase === 'off' ? keep(state) : { state: WATCH_CHECK_START, booking: 'cancel' };
        case 'due': {
            if (state.phase !== 'waiting' || state.dueAt === null || nowMs < state.dueAt) return keep(state);
            const missed = nowMs - state.dueAt > WATCH_CHECK_MISSED_AFTER_MS;
            return keep({ ...state, phase: 'sounding', missedAt: missed ? state.dueAt : null });
        }
        case 'relaunch': {
            if (state.phase !== 'off') return keep(state);
            const { dueAt, intervalMin } = event.saved;
            const missedAt = event.saved.missedAt ?? null;
            if (dueAt > nowMs) {
                // The next check is still ahead: book it again. A check missed
                // before this kill, still unanswered, sounds on until the tap.
                const ahead: WatchCheckState =
                    missedAt === null
                        ? waiting(intervalMin, dueAt)
                        : { phase: 'sounding', intervalMin, dueAt, missedAt };
                return { state: ahead, booking: 'book' };
            }
            // Past due while Thalassa was not running, so nobody could have
            // answered it: say so, sound, and book the next check in case nobody
            // answers this one either. The first unanswered check is the one named.
            return {
                state: {
                    phase: 'sounding',
                    intervalMin,
                    dueAt: nextAt(intervalMin, nowMs),
                    missedAt: missedAt ?? dueAt,
                },
                booking: 'book',
            };
        }
        case 'interval':
            if (event.intervalMin === state.intervalMin) return keep(state);
            if (state.phase === 'waiting') {
                return { state: waiting(event.intervalMin, nextAt(event.intervalMin, nowMs)), booking: 'book' };
            }
            // Sounding, the tap books the new interval; held or off, the resume or start does.
            return keep({ ...state, intervalMin: event.intervalMin });
    }
}

/**
 * Stopped: her own fresh fixes have stayed within this of one spot for this
 * long (a becalmed or hove-to boat drifts further). A stop holds an answered
 * check only once somebody has tapped I'm on watch since she stopped: a berth
 * or an anchorage, not a grounding with nobody on watch. An unanswered check
 * is never held by a stop.
 */
export const WATCH_CHECK_STOPPED_WITHIN_M = 50;
export const WATCH_CHECK_STOPPED_FOR_MS = 10 * MIN_MS;
/** Fixes further apart than this say nothing about whether she stayed put. */
const STOP_FIX_GAP_MS = 2 * MIN_MS;

export interface WatchCheckSpot {
    lat: number;
    lon: number;
    /** When she came within the circle (epoch ms). */
    since: number;
    /** Her last fix within it. */
    lastSeen: number;
}

export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    return rangeBearing(a.lat, a.lon, b.lat, b.lon).rangeNm * METRES_PER_NM;
}

/** Where she has stayed, given her latest fresh fix (or none): a new spot once she leaves the circle. */
export function nextWatchCheckSpot(
    spot: WatchCheckSpot | null,
    fix: { lat: number; lon: number } | null,
    nowMs: number,
): WatchCheckSpot | null {
    if (!fix) return spot && nowMs - spot.lastSeen <= STOP_FIX_GAP_MS ? spot : null;
    if (spot && nowMs - spot.lastSeen <= STOP_FIX_GAP_MS && metresBetween(spot, fix) <= WATCH_CHECK_STOPPED_WITHIN_M) {
        return { ...spot, lastSeen: nowMs };
    }
    return { lat: fix.lat, lon: fix.lon, since: nowMs, lastSeen: nowMs };
}

/** She has stayed put long enough to count as stopped. */
export function watchCheckStopped(spot: WatchCheckSpot | null, nowMs: number): boolean {
    return !!spot && nowMs - spot.since >= WATCH_CHECK_STOPPED_FOR_MS && nowMs - spot.lastSeen <= STOP_FIX_GAP_MS;
}

/** Whole seconds until the check, as iOS takes it (5 s to an hour). */
export function watchCheckLeadSeconds(dueAt: number, nowMs: number): number {
    return Math.min(3_600, Math.max(5, Math.ceil((dueAt - nowMs) / 1_000)));
}

/** A time of day on the phone's own clock: its own zone and its own locale (03:15, 3:15 pm). */
export function watchCheckClock(ms: number, locale?: string, timeZone?: string): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(ms);
}

/** The card for the alarm stack, or null: a minute ahead, then sounding (or missed) until answered. */
export function watchCheckCard(
    state: WatchCheckState,
    nowMs: number,
    clock: (ms: number) => string = (ms) => watchCheckClock(ms),
): UnderwayAlarmCard | null {
    const every = `${state.intervalMin} min`;
    if (state.phase === 'sounding') {
        return {
            kind: 'watch-check',
            title: 'WATCH CHECK',
            value: state.missedAt !== null ? `Missed watch check at ${clock(state.missedAt)}` : "Tap I'm on watch",
            detail: `Nobody has tapped I'm on watch for ${every}`,
            sounding: true,
            mutedUntil: null,
        };
    }
    if (state.phase === 'waiting' && state.dueAt !== null && nowMs < state.dueAt) {
        if (state.dueAt - nowMs > WATCH_CHECK_WARN_MS) return null;
        return {
            kind: 'watch-check',
            title: 'WATCH CHECK',
            value: 'Watch check in 1 min',
            detail: `Every ${every} while the track records`,
            sounding: false,
            mutedUntil: null,
        };
    }
    return null;
}

/** What iOS shows at the check, booked ahead (it is true whenever it fires: a tap would have withdrawn it). */
export function watchCheckLockScreen(intervalMin: number): { title: string; body: string } {
    return {
        title: 'Watch check',
        body: `Nobody has tapped I'm on watch for ${intervalMin} min. Open Thalassa and tap I'm on watch.`,
    };
}

/** The strip under the cards: when the watch check is on but not booked, and why. */
export const WATCH_CHECK_NOTICES = Object.freeze({
    notUnderWay: 'Watch check starts once you are under way.',
    atAnchor: 'Watch check waits while the anchor watch is on.',
    stopped: 'Watch check waits while she is stopped, until she is under way again.',
    notBooked: 'Watch check: iOS did not book the lock-screen alert, so it sounds only with Thalassa open.',
    appOnly: 'Watch check sounds only while Thalassa is open on this device.',
});
