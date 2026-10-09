/**
 * The watch check (build 126, 126-02b): a dead-man check every N minutes
 * while a voyage track records on this phone.
 *
 *  - OFF by default; 10 / 15 / 20 / 30 min, 15 by default.
 *  - Booked AHEAD with iOS through the shared safety path, kind 'watch-check'
 *    (Time Sensitive, its own three ids, `leadSeconds` = the interval), so it
 *    fires on a locked phone with Thalassa suspended.
 *  - A minute before each check a card says so; at the check the phone sounds
 *    under its own 'watch-check' lease; only "I'm on watch" answers it, which
 *    cancels the booking and books the next interval from the tap.
 *  - Pause holds it, resume books from the resume, end cancels and forgets;
 *    a relaunch after a kill with the check past due says "Missed watch check
 *    at …" in the phone's own zone and locale, sounds once, and re-books.
 *  - It never starts at a berth (it starts once she is under way), waits
 *    while any anchor watch is on, and once she has stopped and somebody has
 *    answered there it waits until she is under way clear of the spot; a stop
 *    never silences an unanswered check. It never touches another kind's ids
 *    or leases, and an identity change cancels the old account's booking.
 *  - Stage-3 review: a fresh process leaves the last booking with iOS until
 *    the Ship's Log speaks; a stop and start in one JS context books again; a
 *    missed check survives a second kill; a sound that fails to start retries.
 *
 * Fictional boat 'Kestrel', on passage from Cowes to Cherbourg; clocks read
 * in Europe/London and Pacific/Auckland.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    audio: {
        startAlarm: vi.fn().mockResolvedValue({ playing: true }),
        stopAlarm: vi.fn().mockResolvedValue({ stopped: true }),
        isAlarmPlaying: vi.fn().mockResolvedValue({ playing: true }),
    },
    notify: {
        checkReadiness: vi.fn(),
        scheduleAlarm: vi.fn(),
        cancelAlarm: vi.fn(),
        scheduleSafetyAlert: vi.fn(),
        cancelSafetyAlert: vi.fn(),
    },
    prefs: new Map<string, string>(),
    track: {
        status: { isTracking: false, isPaused: false, isRapidMode: false, currentVoyageId: undefined } as Record<
            string,
            unknown
        >,
        listeners: new Set<(tracking: boolean, paused: boolean) => void>(),
    },
    settings: { underwayAlarms: undefined as unknown },
    settingsListeners: new Set<() => void>(),
    /** The settings' boot disk load (stores/settingsStore.ts awaitSettingsLoaded). */
    settingsLoaded: Promise.resolve() as Promise<void>,
    sogKn: null as number | null,
    /** The boat's own fresh fix (resolveOwnshipPosition), or none. */
    fix: null as null | { lat: number; lon: number },
    anchor: 'none' as 'none' | 'at-anchor' | 'elsewhere',
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: mocks.prefs.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => void mocks.prefs.set(key, value)),
        remove: vi.fn(async ({ key }: { key: string }) => void mocks.prefs.delete(key)),
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getPublishedTrackingStatus: () => ({ ...mocks.track.status }),
        onTrackingStateChange: (listener: (tracking: boolean, paused: boolean) => void) => {
            mocks.track.listeners.add(listener);
            listener(mocks.track.status.isTracking === true, mocks.track.status.isPaused === true);
            return () => mocks.track.listeners.delete(listener);
        },
    },
}));
vi.mock('../stores/settingsStore', () => ({
    awaitSettingsLoaded: () => mocks.settingsLoaded,
    useSettingsStore: Object.assign(() => undefined, {
        getState: () => ({ settings: mocks.settings }),
        subscribe: (listener: () => void) => {
            mocks.settingsListeners.add(listener);
            return () => mocks.settingsListeners.delete(listener);
        },
    }),
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}) } }));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => null } }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({}) } }));
vi.mock('../services/ownshipPosition', () => ({
    resolveOwnMotion: () => ({ sogKn: mocks.sogKn, cogDeg: mocks.sogKn === null ? null : 185, source: 'phone' }),
    resolveOwnshipPosition: () =>
        mocks.fix ? { ...mocks.fix, sog: null, cog: null, timestamp: Date.now(), source: 'nmea' } : null,
}));
vi.mock('../services/collisionAnchorWatch', () => ({ readCollisionAnchorWatch: () => mocks.anchor }));

import { AlarmAudioService } from '../services/AlarmAudioService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { UnderwayAlarmStore } from '../services/underway/underwayAlarmStore';
import { WATCH_CHECK_STORAGE_KEY, WatchCheck, startWatchCheck, stopWatchCheck } from '../services/underway/watchCheck';
import {
    WATCH_CHECK_NOTICES,
    WATCH_CHECK_START,
    nextWatchCheck,
    watchCheckCard,
    watchCheckClock,
    type WatchCheckState,
} from '../services/underway/watchCheckRule';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0); // 03:00 in Cowes (BST), 15:00 in Auckland (NZDT)
const S = 1_000;
const MIN = 60 * S;
const VOYAGE = 'voyage-kestrel-cowes-cherbourg';

const watchCalls = (fn: typeof mocks.notify.scheduleSafetyAlert) =>
    fn.mock.calls.map(([options]) => options as { kind: string; title?: string; body?: string; leadSeconds?: number });
const bookings = () => watchCalls(mocks.notify.scheduleSafetyAlert);
const cancels = () => watchCalls(mocks.notify.cancelSafetyAlert);
const watchCard = () => UnderwayAlarmStore.getCards().find((c) => c.kind === 'watch-check') ?? null;
const notices = () => UnderwayAlarmStore.getNotices();
const savedKey = () => authScopedStorageKey(WATCH_CHECK_STORAGE_KEY, getAuthIdentityScope());
const saved = () => {
    const raw = mocks.prefs.get(savedKey());
    return raw ? (JSON.parse(raw) as { voyageId: string; dueAt: number; intervalMin: number }) : null;
};

function setTrack(next: { tracking: boolean; paused?: boolean; voyageId?: string | null }) {
    mocks.track.status = {
        isTracking: next.tracking,
        isPaused: next.paused === true,
        isRapidMode: false,
        currentVoyageId: next.voyageId === undefined ? VOYAGE : (next.voyageId ?? undefined),
    };
    for (const listener of [...mocks.track.listeners]) {
        listener(next.tracking, next.paused === true);
    }
}

function setPrefs(watchCheck: { enabled?: boolean; intervalMin?: number } | undefined) {
    mocks.settings.underwayAlarms = watchCheck === undefined ? undefined : { watchCheck };
    for (const listener of [...mocks.settingsListeners]) listener();
}

/** Run the clock forward through the watch's own ticks, then let its side effects land. */
async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await WatchCheck.whenIdle();
}

/** Switched on, track recording under way at 6 kn: booked once she has been under way 10 s. */
async function underWayAndBooked(intervalMin = 15) {
    setPrefs({ enabled: true, intervalMin });
    mocks.sogKn = 6;
    setTrack({ tracking: true });
    await advance(10 * S);
    expect(bookings()).toHaveLength(1);
    return Date.now();
}

let acquire: ReturnType<typeof vi.spyOn>;
let release: ReturnType<typeof vi.spyOn>;
let forceStop: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    setAuthIdentityScope('kestrel-skipper');
    WatchCheck.__resetForTests();
    UnderwayAlarmStore.clear();
    await AlarmAudioService.forceStop();
    vi.clearAllMocks();
    mocks.notify.scheduleSafetyAlert.mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' });
    mocks.notify.cancelSafetyAlert.mockResolvedValue({ cancelled: true });
    mocks.prefs.clear();
    mocks.track.listeners.clear();
    mocks.track.status = { isTracking: false, isPaused: false, isRapidMode: false, currentVoyageId: undefined };
    mocks.settings.underwayAlarms = undefined;
    mocks.settingsListeners.clear();
    mocks.settingsLoaded = Promise.resolve();
    mocks.sogKn = null;
    mocks.fix = null;
    mocks.anchor = 'none';
    acquire = vi.spyOn(AlarmAudioService, 'acquire');
    release = vi.spyOn(AlarmAudioService, 'release');
    forceStop = vi.spyOn(AlarmAudioService, 'forceStop');
});

afterEach(async () => {
    stopWatchCheck();
    await WatchCheck.whenIdle();
    acquire.mockRestore();
    release.mockRestore();
    forceStop.mockRestore();
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

describe('the rule: nextWatchCheck(state, event, now)', () => {
    const waiting = (dueAt: number, intervalMin = 15): WatchCheckState => ({
        phase: 'waiting',
        intervalMin,
        dueAt,
        missedAt: null,
    });

    it('start books the first check one interval out; a second start changes nothing', () => {
        const step = nextWatchCheck(WATCH_CHECK_START, { type: 'start', intervalMin: 15 }, T0);
        expect(step).toEqual({ state: waiting(T0 + 15 * MIN), booking: 'book' });
        expect(nextWatchCheck(step.state, { type: 'start', intervalMin: 15 }, T0 + MIN).booking).toBe('keep');
    });

    it('ack, waiting or sounding, books the next check one interval from the tap', () => {
        expect(nextWatchCheck(waiting(T0 + 15 * MIN), { type: 'ack' }, T0 + 7 * MIN)).toEqual({
            state: waiting(T0 + 22 * MIN),
            booking: 'book',
        });
        const sounding: WatchCheckState = { phase: 'sounding', intervalMin: 15, dueAt: T0, missedAt: T0 };
        expect(nextWatchCheck(sounding, { type: 'ack' }, T0 + 2 * MIN)).toEqual({
            state: waiting(T0 + 17 * MIN),
            booking: 'book',
        });
        // Nothing running: nothing to answer.
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'ack' }, T0).booking).toBe('keep');
    });

    it('due sounds at the check; noticed after the lock-screen reminders it is a missed check', () => {
        expect(nextWatchCheck(waiting(T0), { type: 'due' }, T0 - S).booking).toBe('keep');
        expect(nextWatchCheck(waiting(T0), { type: 'due' }, T0 - S).state.phase).toBe('waiting');
        expect(nextWatchCheck(waiting(T0), { type: 'due' }, T0 + 2 * S)).toEqual({
            state: { phase: 'sounding', intervalMin: 15, dueAt: T0, missedAt: null },
            booking: 'keep',
        });
        expect(nextWatchCheck(waiting(T0), { type: 'due' }, T0 + 5 * MIN).state).toEqual({
            phase: 'sounding',
            intervalMin: 15,
            dueAt: T0,
            missedAt: T0,
        });
    });

    it('pause holds and cancels; resume books from the resume; end cancels and clears', () => {
        const held = nextWatchCheck(waiting(T0 + 15 * MIN), { type: 'pause' }, T0 + 5 * MIN);
        expect(held).toEqual({
            state: { phase: 'held', intervalMin: 15, dueAt: null, missedAt: null },
            booking: 'cancel',
        });
        expect(nextWatchCheck(held.state, { type: 'resume' }, T0 + 40 * MIN)).toEqual({
            state: waiting(T0 + 55 * MIN),
            booking: 'book',
        });
        expect(nextWatchCheck(waiting(T0 + 15 * MIN, 20), { type: 'end' }, T0 + 5 * MIN)).toEqual({
            state: WATCH_CHECK_START,
            booking: 'cancel',
        });
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'end' }, T0).booking).toBe('keep');
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'pause' }, T0).booking).toBe('keep');
    });

    it('relaunch: a past check is missed, sounds and re-books from now; a future one keeps its time', () => {
        const saved = { dueAt: T0 - 10 * MIN, intervalMin: 15 };
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'relaunch', saved }, T0)).toEqual({
            state: { phase: 'sounding', intervalMin: 15, dueAt: T0 + 15 * MIN, missedAt: T0 - 10 * MIN },
            booking: 'book',
        });
        expect(
            nextWatchCheck(
                WATCH_CHECK_START,
                { type: 'relaunch', saved: { dueAt: T0 + 7 * MIN, intervalMin: 10 } },
                T0,
            ),
        ).toEqual({ state: waiting(T0 + 7 * MIN, 10), booking: 'book' });
        // Due while Thalassa was not running is missed, however recently: nobody could have answered it.
        expect(
            nextWatchCheck(WATCH_CHECK_START, { type: 'relaunch', saved: { dueAt: T0 - 30 * S, intervalMin: 15 } }, T0)
                .state,
        ).toEqual({ phase: 'sounding', intervalMin: 15, dueAt: T0 + 15 * MIN, missedAt: T0 - 30 * S });
    });

    it('relaunch: a missed check nobody answered before the next kill is still missed (stage-3 review)', () => {
        // Saved while sounding: the next check booked, and the one that went unanswered.
        const saved = { dueAt: T0 + 13 * MIN, intervalMin: 15, missedAt: T0 - 12 * MIN };
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'relaunch', saved }, T0)).toEqual({
            state: { phase: 'sounding', intervalMin: 15, dueAt: T0 + 13 * MIN, missedAt: T0 - 12 * MIN },
            booking: 'book',
        });
        // The next one came due too: it still names the first check nobody answered, and books the one after.
        expect(nextWatchCheck(WATCH_CHECK_START, { type: 'relaunch', saved }, T0 + 20 * MIN)).toEqual({
            state: { phase: 'sounding', intervalMin: 15, dueAt: T0 + 35 * MIN, missedAt: T0 - 12 * MIN },
            booking: 'book',
        });
    });

    it('an interval change mid-watch re-books from now; held, it waits for the resume', () => {
        expect(nextWatchCheck(waiting(T0 + 15 * MIN), { type: 'interval', intervalMin: 30 }, T0 + 5 * MIN)).toEqual({
            state: waiting(T0 + 35 * MIN, 30),
            booking: 'book',
        });
        const held: WatchCheckState = { phase: 'held', intervalMin: 15, dueAt: null, missedAt: null };
        expect(nextWatchCheck(held, { type: 'interval', intervalMin: 10 }, T0)).toEqual({
            state: { ...held, intervalMin: 10 },
            booking: 'keep',
        });
    });
});

describe('what the card says', () => {
    it('a minute before the check, then sounding, then missed in the phone’s own zone and locale', () => {
        const state: WatchCheckState = { phase: 'waiting', intervalMin: 15, dueAt: T0 + 15 * MIN, missedAt: null };
        expect(watchCheckCard(state, T0 + 13 * MIN)).toBeNull();
        expect(watchCheckCard(state, T0 + 14 * MIN)).toMatchObject({
            kind: 'watch-check',
            value: 'Watch check in 1 min',
            sounding: false,
        });
        expect(watchCheckCard({ ...state, phase: 'sounding' }, T0 + 15 * MIN + 2 * S)?.value).toBe("Tap I'm on watch");
        const missed: WatchCheckState = {
            phase: 'sounding',
            intervalMin: 15,
            dueAt: T0 + 30 * MIN,
            missedAt: T0 + 15 * MIN,
        };
        const london = (ms: number) => watchCheckClock(ms, 'en-GB', 'Europe/London');
        const auckland = (ms: number) => watchCheckClock(ms, 'en-NZ', 'Pacific/Auckland');
        expect(watchCheckCard(missed, T0 + 25 * MIN, london)).toMatchObject({
            value: 'Missed watch check at 03:15',
            sounding: true,
        });
        expect(watchCheckCard(missed, T0 + 25 * MIN, auckland)?.value).toBe('Missed watch check at 3:15 pm');
    });
});

describe('the watch check, running', () => {
    it('is OFF by default: a recording track under way books nothing, sounds nothing, shows nothing', async () => {
        startWatchCheck();
        mocks.sogKn = 6;
        setTrack({ tracking: true });
        await advance(20 * MIN);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(watchCard()).toBeNull();
        expect(notices()).toEqual([]);
        expect(saved()).toBeNull();
    });

    it('on, track starts under way: one Time Sensitive booking 900 s ahead, then the warning card at 14 min', async () => {
        startWatchCheck();
        const bookedAt = await underWayAndBooked(15);
        const [booking] = bookings();
        expect(booking).toMatchObject({ kind: 'watch-check', leadSeconds: 900 });
        expect(booking.title).toBe('Watch check');
        expect(booking.body).toBe("Nobody has tapped I'm on watch for 15 min. Open Thalassa and tap I'm on watch.");
        expect(saved()).toEqual({ voyageId: VOYAGE, dueAt: bookedAt + 15 * MIN, intervalMin: 15 });

        await advance(13 * MIN + 50 * S);
        expect(watchCard()).toBeNull();
        await advance(15 * S);
        expect(watchCard()).toMatchObject({ value: 'Watch check in 1 min', sounding: false });
        expect(acquire).not.toHaveBeenCalled();
        expect(bookings()).toHaveLength(1);
    });

    it('ack at minute 7: cancel, then a new booking 15 min from the ack', async () => {
        startWatchCheck();
        const bookedAt = await underWayAndBooked(15);
        await advance(7 * MIN);
        UnderwayAlarmStore.onWatch(Date.now());
        await WatchCheck.whenIdle();
        expect(cancels().filter((c) => c.kind === 'watch-check').length).toBeGreaterThanOrEqual(1);
        expect(bookings()).toHaveLength(2);
        expect(bookings()[1]).toMatchObject({ kind: 'watch-check', leadSeconds: 900 });
        const lastCancel = Math.max(...mocks.notify.cancelSafetyAlert.mock.invocationCallOrder);
        expect(lastCancel).toBeLessThan(mocks.notify.scheduleSafetyAlert.mock.invocationCallOrder[1]);
        expect(saved()?.dueAt).toBe(bookedAt + 7 * MIN + 15 * MIN);

        // No warning at the old check's minute: it is gone.
        await advance(7 * MIN + 10 * S);
        expect(watchCard()).toBeNull();
        expect(acquire).not.toHaveBeenCalled();
    });

    it('due while running: the watch-check lease and the sounding card; the ack releases it and re-books', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        await advance(15 * MIN + 5 * S);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith('watch-check');
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(watchCard()).toMatchObject({ value: "Tap I'm on watch", sounding: true });
        // iOS delivers the booked check and its reminders itself: nothing more is booked at the check.
        expect(bookings()).toHaveLength(1);

        // Still unanswered a minute on: the same one lease, the card waits.
        await advance(MIN);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(watchCard()?.sounding).toBe(true);

        UnderwayAlarmStore.onWatch(Date.now());
        await WatchCheck.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.audio.stopAlarm).toHaveBeenCalled();
        expect(watchCard()).toBeNull();
        expect(bookings()).toHaveLength(2);
        expect(bookings()[1].leadSeconds).toBe(900);
    });

    it('pause cancels and holds; resume re-books from the resume; end cancels and clears the state', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        await advance(5 * MIN);
        setTrack({ tracking: false, paused: true });
        await WatchCheck.whenIdle();
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        expect(saved()).toBeNull();
        expect(WatchCheck.getState().phase).toBe('held');

        // Paused past the old check: nothing sounds.
        await advance(20 * MIN);
        expect(acquire).not.toHaveBeenCalled();
        expect(watchCard()).toBeNull();

        setTrack({ tracking: true });
        await WatchCheck.whenIdle();
        const resumedAt = Date.now();
        expect(bookings()).toHaveLength(2);
        expect(bookings()[1].leadSeconds).toBe(900);
        expect(saved()?.dueAt).toBe(resumedAt + 15 * MIN);

        const cancelsBefore = cancels().length;
        setTrack({ tracking: false, paused: false, voyageId: null });
        await WatchCheck.whenIdle();
        expect(cancels().length).toBe(cancelsBefore + 1);
        expect(WatchCheck.getState()).toEqual(WATCH_CHECK_START);
        expect(saved()).toBeNull();
        await advance(30 * MIN);
        expect(acquire).not.toHaveBeenCalled();
        expect(bookings()).toHaveLength(2);
    });

    it('a relaunch after a kill with the check past due: "Missed watch check at …", sounds once, re-books', async () => {
        // The killed process saved this check and booked it with iOS.
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 - 10 * MIN, intervalMin: 15 }));
        setPrefs({ enabled: true, intervalMin: 15 });
        mocks.sogKn = 6;
        startWatchCheck();
        // At boot the Ship's Log has not reconciled yet: not tracking. That must not forget the check.
        await advance(2 * S);
        expect(saved()).not.toBeNull();
        // The booking the dead process left stays with iOS until the log says what records (stage-3 review).
        expect(cancels()).toEqual([]);
        expect(watchCard()).toBeNull();

        setTrack({ tracking: true }); // the Ship's Log resumes the same voyage in place
        await WatchCheck.whenIdle();
        const card = watchCard();
        const phoneClock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(T0 - 10 * MIN);
        expect(card).toMatchObject({ value: `Missed watch check at ${phoneClock}`, sounding: true });
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith('watch-check');
        expect(bookings()).toHaveLength(1);
        expect(bookings()[0]).toMatchObject({ kind: 'watch-check', leadSeconds: 900 });

        // Sounds once: more ticks, no second lease, no second booking.
        await advance(MIN);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(bookings()).toHaveLength(1);
    });

    it('a cold boot that reads the switch before the settings load does not forget the check', async () => {
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 - 10 * MIN, intervalMin: 15 }));
        let settingsLoaded!: () => void;
        mocks.settingsLoaded = new Promise<void>((resolve) => (settingsLoaded = resolve));
        mocks.sogKn = 6;
        startWatchCheck(); // the switch still reads OFF: the settings are not on disk yet
        await vi.advanceTimersByTimeAsync(2 * S); // (not whenIdle: that waits for the settings too)
        expect(cancels()).toEqual([]);
        expect(saved()).not.toBeNull();

        mocks.settings.underwayAlarms = { watchCheck: { enabled: true, intervalMin: 15 } };
        settingsLoaded();
        await WatchCheck.whenIdle();
        setTrack({ tracking: true });
        await WatchCheck.whenIdle();
        expect(watchCard()?.value).toMatch(/^Missed watch check at /);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(bookings()).toHaveLength(1);
    });

    it('a relaunch with the check still ahead keeps its time, silently', async () => {
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 + 7 * MIN, intervalMin: 15 }));
        setPrefs({ enabled: true, intervalMin: 15 });
        mocks.sogKn = 0; // drifting at the moment: a check booked before the kill still stands
        mocks.track.status = { isTracking: true, isPaused: false, isRapidMode: false, currentVoyageId: VOYAGE };
        startWatchCheck();
        await advance(S);
        expect(acquire).not.toHaveBeenCalled();
        expect(bookings()).toHaveLength(1);
        // 7 min ahead, give or take the second the saved check took to read.
        expect(bookings()[0].leadSeconds).toBeGreaterThanOrEqual(7 * 60 - 1);
        expect(bookings()[0].leadSeconds).toBeLessThanOrEqual(7 * 60);
        expect(WatchCheck.getState().dueAt).toBe(T0 + 7 * MIN);
    });

    it('a saved check from another voyage is not a missed check', async () => {
        mocks.prefs.set(
            savedKey(),
            JSON.stringify({ voyageId: 'voyage-kestrel-earlier', dueAt: T0 - 3 * 60 * MIN, intervalMin: 15 }),
        );
        startWatchCheck();
        await underWayAndBooked(15);
        expect(acquire).not.toHaveBeenCalled();
        expect(watchCard()).toBeNull();
        expect(saved()?.voyageId).toBe(VOYAGE);
    });

    it('an interval change mid-watch re-books from now', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        await advance(5 * MIN);
        setPrefs({ enabled: true, intervalMin: 30 });
        await WatchCheck.whenIdle();
        expect(bookings()).toHaveLength(2);
        expect(bookings()[1].leadSeconds).toBe(1800);
        expect(bookings()[1].body).toContain('for 30 min');
        expect(saved()).toMatchObject({ intervalMin: 30, dueAt: Date.now() + 30 * MIN });
        // The old 15-minute check is gone.
        await advance(11 * MIN);
        expect(acquire).not.toHaveBeenCalled();
    });

    it('switched off mid-watch: cancelled, silenced and forgotten', async () => {
        startWatchCheck();
        await underWayAndBooked(10);
        await advance(10 * MIN + 5 * S);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        setPrefs({ enabled: false, intervalMin: 10 });
        await WatchCheck.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        expect(watchCard()).toBeNull();
        expect(saved()).toBeNull();
    });

    it('never sounds at a berth: recording at the dock books nothing, and says it starts once under way', async () => {
        startWatchCheck();
        setPrefs({ enabled: true });
        mocks.sogKn = 0;
        setTrack({ tracking: true });
        await advance(40 * MIN);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(notices()).toEqual([WATCH_CHECK_NOTICES.notUnderWay]);
        // A GPS blip at the dock is not under way.
        mocks.sogKn = 3;
        await advance(5 * S);
        mocks.sogKn = 0;
        await advance(5 * S);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
        // Away from the dock: booked.
        mocks.sogKn = 5;
        await advance(15 * S);
        expect(bookings()).toHaveLength(1);
        expect(notices()).toEqual([]);
    });

    it('never sounds at anchor: an anchor watch holds it, and weighing anchor books it again', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        await advance(10 * MIN);
        mocks.anchor = 'at-anchor';
        mocks.sogKn = 0.2;
        await advance(5 * S);
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        expect(notices()).toEqual([WATCH_CHECK_NOTICES.atAnchor]);
        await advance(60 * MIN);
        expect(acquire).not.toHaveBeenCalled();
        expect(bookings()).toHaveLength(1);

        mocks.anchor = 'none';
        mocks.sogKn = 4;
        await advance(5 * S);
        expect(bookings()).toHaveLength(2);
        expect(bookings()[1].leadSeconds).toBe(900);
        expect(notices()).toEqual([]);
    });

    it('says so when iOS will not take the lock-screen alert', async () => {
        mocks.notify.scheduleSafetyAlert.mockRejectedValue(
            new Error('iOS did not confirm Time Sensitive lock-screen notifications.'),
        );
        startWatchCheck();
        setPrefs({ enabled: true, intervalMin: 15 });
        mocks.sogKn = 6;
        setTrack({ tracking: true });
        await advance(10 * S);
        expect(notices()).toEqual([WATCH_CHECK_NOTICES.notBooked]);
        // It still sounds in the app at the check.
        await advance(15 * MIN);
        expect(acquire).toHaveBeenCalledWith('watch-check');
    });

    it('never touches the anchor, collision, distress, shoal or off-route ids or leases', async () => {
        // Another alarm is already sounding under its own lease.
        const offRoute = await AlarmAudioService.acquire('off-route-watch');
        acquire.mockClear();
        startWatchCheck();
        await underWayAndBooked(10);
        await advance(10 * MIN + 5 * S); // sounding
        UnderwayAlarmStore.onWatch(Date.now()); // answered
        await WatchCheck.whenIdle();
        setTrack({ tracking: false, paused: true });
        setTrack({ tracking: true });
        setTrack({ tracking: false, paused: false, voyageId: null });
        await WatchCheck.whenIdle();

        for (const call of [...bookings(), ...cancels()]) expect(call.kind).toBe('watch-check');
        expect(mocks.notify.scheduleAlarm).not.toHaveBeenCalled();
        expect(mocks.notify.cancelAlarm).not.toHaveBeenCalled();
        expect(acquire.mock.calls.every(([owner]: unknown[]) => owner === 'watch-check')).toBe(true);
        expect(forceStop).not.toHaveBeenCalled();
        // The off-route lease is still held: the watch check released only its own.
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(release.mock.calls.every(([token]: unknown[]) => token !== offRoute)).toBe(true);
        await AlarmAudioService.release(offRoute);
    });

    it('an identity change cancels the old account’s booking and forgets its check', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        const oldKey = savedKey();
        await advance(15 * MIN + 5 * S); // sounding for the old account
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        const cancelsBefore = cancels().length;

        setAuthIdentityScope('kestrel-mate');
        await WatchCheck.whenIdle();
        expect(cancels().length).toBeGreaterThan(cancelsBefore);
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(watchCard()).toBeNull();
        expect(mocks.prefs.has(oldKey)).toBe(false);
        expect(WatchCheck.getState()).toEqual(WATCH_CHECK_START);
    });

    it('an anchor watch kept elsewhere (the Pi’s, graded from this phone) holds it too (stage-3 review)', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        await advance(5 * MIN);
        mocks.anchor = 'elsewhere';
        mocks.sogKn = 0.2;
        await advance(5 * S);
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        expect(WatchCheck.getState().phase).toBe('held');
        expect(notices()).toEqual([WATCH_CHECK_NOTICES.atAnchor]);
        await advance(60 * MIN);
        expect(acquire).not.toHaveBeenCalled();
        expect(bookings()).toHaveLength(1);
    });
});

/** The boat's own fix, 'Kestrel' off Cherbourg (fictional positions). */
const OFFING = { lat: 49.7, lon: -1.62 };
const BERTH = { lat: 49.6468, lon: -1.6206 };
/** Metres north of a position. */
const north = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 111_320, lon: p.lon });

describe('stage-3 review fixes', () => {
    it('a sound that would not start is tried again on the next pass, and only one lease is ever held', async () => {
        startWatchCheck();
        await underWayAndBooked(15);
        // iOS will not start the alarm once (another app's audio, a call).
        mocks.audio.startAlarm.mockRejectedValueOnce(new Error('audio session busy'));
        await advance(15 * MIN);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(watchCard()?.sounding).toBe(true);

        await advance(5 * S); // the next pass
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        await advance(MIN);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('stopped and started again in one JS context (a remount): the check is booked again, after any withdrawal', async () => {
        startWatchCheck();
        const bookedAt = await underWayAndBooked(15);
        await advance(3 * MIN);
        stopWatchCheck();
        startWatchCheck();
        await WatchCheck.whenIdle();
        const lastBooking = Math.max(...mocks.notify.scheduleSafetyAlert.mock.invocationCallOrder);
        const lastCancel = Math.max(0, ...mocks.notify.cancelSafetyAlert.mock.invocationCallOrder);
        expect(lastBooking).toBeGreaterThan(lastCancel);
        expect(bookings()).toHaveLength(2);
        // The same check: due 15 min after the first booking, 12 min from now.
        expect(bookings()[1].leadSeconds).toBe(12 * 60);
        expect(WatchCheck.getState()).toMatchObject({ phase: 'waiting', dueAt: bookedAt + 15 * MIN });
    });

    it('stopped and started again while it sounds: it sounds again, says it was missed, and books the next', async () => {
        startWatchCheck();
        const bookedAt = await underWayAndBooked(15);
        await advance(15 * MIN + 5 * S);
        await advance(2 * MIN);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        stopWatchCheck();
        await WatchCheck.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        startWatchCheck();
        await WatchCheck.whenIdle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(watchCard()).toMatchObject({ value: expect.stringMatching(/^Missed watch check at /), sounding: true });
        const lastBooking = Math.max(...mocks.notify.scheduleSafetyAlert.mock.invocationCallOrder);
        const lastCancel = Math.max(0, ...mocks.notify.cancelSafetyAlert.mock.invocationCallOrder);
        expect(lastBooking).toBeGreaterThan(lastCancel);
        expect(saved()).toMatchObject({ missedAt: bookedAt + 15 * MIN, dueAt: Date.now() + 15 * MIN });
    });

    it('a fresh process leaves the last booking with iOS while the Ship’s Log has said nothing', async () => {
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 + 9 * MIN, intervalMin: 15 }));
        setPrefs({ enabled: true, intervalMin: 15 });
        startWatchCheck();
        await advance(30 * MIN); // the log never publishes (no auth user offline, a swallowed native read)
        expect(cancels()).toEqual([]);
        expect(saved()).not.toBeNull();

        // Then it says the voyage ended: the dead process's booking is withdrawn and the check forgotten.
        setTrack({ tracking: false, paused: false, voyageId: null });
        await WatchCheck.whenIdle();
        expect(cancels()).toEqual([{ kind: 'watch-check' }]);
        expect(saved()).toBeNull();
        expect(acquire).not.toHaveBeenCalled();
    });

    it('a fresh process withdraws the last booking when the log says the voyage is paused', async () => {
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 + 9 * MIN, intervalMin: 15 }));
        setPrefs({ enabled: true, intervalMin: 15 });
        startWatchCheck();
        await advance(2 * S);
        expect(cancels()).toEqual([]);
        setTrack({ tracking: false, paused: true });
        await WatchCheck.whenIdle();
        expect(cancels()).toEqual([{ kind: 'watch-check' }]);
        expect(saved()).toBeNull();
        expect(bookings()).toEqual([]);
    });

    it('killed twice before anybody taps: the missed check is still missed, and still sounds', async () => {
        mocks.prefs.set(savedKey(), JSON.stringify({ voyageId: VOYAGE, dueAt: T0 - 10 * MIN, intervalMin: 15 }));
        setPrefs({ enabled: true, intervalMin: 15 });
        mocks.sogKn = 6;
        mocks.track.status = { isTracking: true, isPaused: false, isRapidMode: false, currentVoyageId: VOYAGE };
        startWatchCheck();
        await advance(S);
        const missedWords = watchCard()?.value;
        expect(missedWords).toMatch(/^Missed watch check at /);
        const nextDue = WatchCheck.getState().dueAt as number;
        expect(nextDue - Date.now()).toBeGreaterThan(14 * MIN);
        expect(saved()).toMatchObject({ missedAt: T0 - 10 * MIN, dueAt: nextDue });

        // Two minutes on, nobody has tapped; the skipper swipes Thalassa away.
        await advance(2 * MIN);
        WatchCheck.__resetForTests();
        await AlarmAudioService.forceStop();
        UnderwayAlarmStore.clear();
        acquire.mockClear();

        startWatchCheck();
        await advance(S);
        expect(watchCard()).toMatchObject({ value: missedWords, sounding: true });
        expect(acquire).toHaveBeenCalledWith('watch-check');
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(WatchCheck.getState().phase).toBe('sounding');
        // The next check stays booked for the same time.
        expect(WatchCheck.getState().dueAt).toBe(nextDue);
        const lead = bookings().at(-1)?.leadSeconds as number;
        expect(Math.abs(lead - (nextDue - Date.now()) / 1000)).toBeLessThanOrEqual(2);

        UnderwayAlarmStore.onWatch(Date.now());
        await WatchCheck.whenIdle();
        expect(watchCard()).toBeNull();
        expect(saved()).not.toHaveProperty('missedAt');
    });

    it('at a berth after the passage: one check, answered, then it waits until she is under way again', async () => {
        startWatchCheck();
        mocks.fix = OFFING;
        await underWayAndBooked(15);
        // Two minutes on she is alongside, and stays there.
        await advance(2 * MIN);
        mocks.sogKn = 0.1;
        mocks.fix = BERTH;
        await advance(13 * MIN + 5 * S); // the check comes due: nobody has answered since she stopped
        expect(watchCard()?.sounding).toBe(true);
        expect(acquire).toHaveBeenCalledTimes(1);

        UnderwayAlarmStore.onWatch(Date.now()); // the crew, aboard and awake
        await advance(5 * S);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(WatchCheck.getState().phase).toBe('held');
        expect(cancels().at(-1)).toEqual({ kind: 'watch-check' });
        const lastBooking = Math.max(...mocks.notify.scheduleSafetyAlert.mock.invocationCallOrder);
        expect(Math.max(...mocks.notify.cancelSafetyAlert.mock.invocationCallOrder)).toBeGreaterThan(lastBooking);
        expect(notices()).toEqual([WATCH_CHECK_NOTICES.stopped]);
        expect(saved()).toBeNull();

        // All night alongside, GPS wandering a few metres and the odd speed blip: nothing.
        const booked = bookings().length;
        for (let i = 0; i < 12; i++) {
            mocks.fix = north(BERTH, i % 2 ? 12 : -9);
            mocks.sogKn = i === 5 ? 1.2 : 0.1;
            await advance(5 * MIN);
        }
        expect(bookings()).toHaveLength(booked);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(watchCard()).toBeNull();

        // Away in the morning: under way and clear of the berth, the check books again.
        mocks.sogKn = 4;
        mocks.fix = north(BERTH, 120);
        await advance(15 * S);
        expect(bookings()).toHaveLength(booked + 1);
        expect(bookings().at(-1)?.leadSeconds).toBe(900);
        expect(notices()).toEqual([]);
    });

    it('stopped with nobody answering (aground, say): the check still sounds, and a stop never silences it', async () => {
        startWatchCheck();
        mocks.fix = OFFING;
        await underWayAndBooked(15);
        await advance(2 * MIN);
        mocks.sogKn = 0;
        mocks.fix = north(OFFING, 400);
        await advance(13 * MIN + 5 * S);
        expect(watchCard()?.sounding).toBe(true);
        await advance(40 * MIN);
        expect(watchCard()?.sounding).toBe(true);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(WatchCheck.getState().phase).toBe('sounding');
        expect(notices()).toEqual([]);
    });

    it('answered once she has stopped, but the tap came before she stopped: the next check still comes', async () => {
        startWatchCheck();
        mocks.fix = OFFING;
        await underWayAndBooked(15);
        await advance(MIN);
        UnderwayAlarmStore.onWatch(Date.now()); // answered while still under way
        await advance(MIN);
        mocks.sogKn = 0.1;
        mocks.fix = BERTH; // then alongside
        await advance(14 * MIN);
        expect(watchCard()?.sounding).toBe(true);
        expect(WatchCheck.getState().phase).toBe('sounding');
    });
});
