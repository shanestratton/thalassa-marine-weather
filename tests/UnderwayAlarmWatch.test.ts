/**
 * The under-way watch (build 126, 126-02a): off route and shoal water,
 * through 125's alarm channel.
 *
 *  - SOUND through AlarmAudioService under their own leases,
 *    'off-route-watch' and 'shoal-watch': owner-scoped, so clearing either can
 *    never silence the anchor alarm, and this path never force-stops.
 *  - THE LOCK SCREEN through the shared safety path, kinds 'off-route' and
 *    'shoal' (Time Sensitive, their own ids), never the anchor's.
 *  - Off route runs only while a route is followed; both stand down when
 *    switched off; a mute lasts 30 min (ending early back inside); a shoal
 *    acknowledgement lasts until the water deepens again.
 *  - HONEST: the strip says when the watch cannot see (no position, a stale
 *    sounder, not yet on the route), and going to the background with an alarm
 *    armed and nothing keeping Thalassa running posts one plain notice.
 *  - No paywall anywhere: safety is never a tier.
 *
 * Fictional boat 'Kestrel' (draft 2.4 m) on a Solent leg.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        scheduleSafetyAlert: vi.fn().mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' }),
        cancelSafetyAlert: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    local: { schedule: vi.fn().mockResolvedValue({ notifications: [] }) },
    app: { listeners: new Map<string, () => void>(), addListener: vi.fn() },
    bgGeo: { getLeaseState: vi.fn().mockResolvedValue({ active: false }) },
    follow: {
        isFollowing: false,
        routeCoords: [] as { lat: number; lon: number }[],
        voyageId: null as string | null,
        startedAt: null as string | null,
    },
    tracking: { isTracking: false, isPaused: false, isRapidMode: false } as Record<string, unknown>,
    /** The shore zone only where the Ship's Log has real ocean + coastline evidence for it. */
    shoreEvidence: null as string | null,
    /** This phone's own last fix (GpsService, read passively). */
    gps: null as null | {
        latitude: number;
        longitude: number;
        timestamp: number;
        speed: number;
        heading: number | null;
    },
    nmea: { state: {} as Record<string, unknown>, boatFeed: false },
    location: { lat: 0, lon: 0, source: 'none', timestamp: 0 },
    settings: { underwayAlarms: undefined as unknown, vessel: { draft: 2.4 * 3.28084 } as Record<string, unknown> },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: mocks.local }));
vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.app.addListener } }));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: mocks.bgGeo }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: () => ({ ...mocks.tracking }),
        getEvidencedShoreZone: () =>
            mocks.tracking.isTracking && !mocks.tracking.isPaused ? mocks.shoreEvidence : null,
    },
}));
vi.mock('../services/collisionAnchorWatch', () => ({ readCollisionAnchorWatch: () => 'none' }));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: Object.assign(() => undefined, {
        getState: () => mocks.follow,
        subscribe: () => () => undefined,
    }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(() => undefined, {
        getState: () => ({ settings: mocks.settings }),
        subscribe: () => () => undefined,
    }),
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => mocks.nmea.state,
        isBoatFeed: () => mocks.nmea.boatFeed,
        subscribe: () => () => undefined,
    },
}));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => mocks.location } }));
vi.mock('../services/GpsService', () => ({
    GpsService: { getLastKnownPosition: () => (mocks.gps ? { ...mocks.gps } : null) },
}));

import { AlarmAudioService } from '../services/AlarmAudioService';
import { AisGuardAlertStore } from '../services/aisGuardAlertStore';
import {
    UnderwayAlarmWatch,
    readUnderwayInputs,
    runUnderwayPass,
    setDebugUnderway,
    startUnderwayAlarmWatch,
    stopUnderwayAlarmWatch,
    type UnderwayInputs,
} from '../services/underway/UnderwayAlarmWatch';
import { UnderwayAlarmStore } from '../services/underway/underwayAlarmStore';
import { sanitiseUnderwayPrefs, UNDERWAY_NOTICES } from '../services/underway/underwayRule';
import { destinationPoint } from '../utils/navigationCalculations';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const S = 1_000;
const MIN = 60 * S;

/** The Solent, 50.7N 1.3W: a 6 NM leg west down the channel. */
const SOLENT = [{ lat: 50.77, lon: -1.3 }, destinationPoint(50.77, -1.3, 255, 6)];

function beside(offNm: number) {
    const abeam = destinationPoint(SOLENT[0].lat, SOLENT[0].lon, 255, 2);
    return offNm === 0 ? abeam : destinationPoint(abeam.lat, abeam.lon, 345, offNm);
}

let clock = T0;

interface Pass {
    offNm?: number | null;
    following?: boolean;
    sogKn?: number | null;
    depthM?: number | null;
    reference?: 'below-keel' | 'below-waterline' | 'below-transducer' | null;
    freshness?: 'live' | 'stale' | 'dead';
    boatFeed?: boolean;
    prefs?: unknown;
    advanceS?: number;
}

function inputsFor(o: Pass = {}): UnderwayInputs {
    clock += (o.advanceS ?? 10) * S;
    const offNm = o.offNm === undefined ? 0.05 : o.offNm;
    const point = offNm === null ? null : beside(offNm);
    return {
        nowMs: clock,
        prefs: sanitiseUnderwayPrefs(o.prefs),
        following: o.following === false ? null : { key: 'voyage-kestrel-1', route: SOLENT },
        fix: point ? { ...point, at: clock } : null,
        sogKn: o.sogKn === undefined ? 5 : o.sogKn,
        cogDeg: 255,
        atAnchor: false,
        zone: 'nearshore',
        depth: {
            boatFeed: o.boatFeed ?? true,
            depthM: 'depthM' in o ? (o.depthM ?? null) : 6,
            reference: o.reference === undefined ? 'below-keel' : o.reference,
            offsetM: null,
            freshness: o.freshness ?? 'live',
            readingAt: clock,
        },
        draftM: 2.4,
        draftAssumed: false,
        marginM: 0.5,
    };
}

const pass = (o: Pass = {}) => runUnderwayPass(inputsFor(o));
const idle = () => UnderwayAlarmWatch.whenIdle();
const kinds = () => UnderwayAlarmStore.getCards().map((c) => c.kind);
const safety = (fn: typeof mocks.notify.scheduleSafetyAlert, kind: string) =>
    fn.mock.calls.filter(([options]) => (options as { kind: string }).kind === kind);

let acquire: ReturnType<typeof vi.spyOn>;
let forceStop: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    clock = T0;
    UnderwayAlarmWatch.__resetForTests();
    UnderwayAlarmStore.clear();
    AisGuardAlertStore.clear();
    await AlarmAudioService.forceStop();
    vi.clearAllMocks();
    mocks.follow = { isFollowing: false, routeCoords: [], voyageId: null, startedAt: null };
    mocks.tracking = { isTracking: false, isPaused: false, isRapidMode: false };
    mocks.shoreEvidence = null;
    mocks.gps = null;
    mocks.nmea = { state: {}, boatFeed: false };
    mocks.settings.underwayAlarms = undefined;
    mocks.location = { lat: 0, lon: 0, source: 'none', timestamp: 0 };
    mocks.bgGeo.getLeaseState.mockResolvedValue({ active: false });
    mocks.app.listeners.clear();
    mocks.app.addListener.mockImplementation((event: string, listener: () => void) => {
        mocks.app.listeners.set(event, listener);
        return Promise.resolve({ remove: vi.fn() });
    });
    acquire = vi.spyOn(AlarmAudioService, 'acquire');
    forceStop = vi.spyOn(AlarmAudioService, 'forceStop');
});

afterEach(async () => {
    await idle();
    acquire.mockRestore();
    forceStop.mockRestore();
});

/** On the route, then off by `offNm` on two fixes 10 s apart: sounding. */
async function offRoute(offNm = 0.4) {
    pass({ offNm: 0.05 });
    pass({ offNm });
    pass({ offNm });
    await idle();
}

/** Three live readings 0.3 m under the keel: sounding. */
async function shallow(following = false) {
    for (let i = 0; i < 3; i++) pass({ following, depthM: 0.3 });
    await idle();
}

describe('off route', () => {
    it('0.4 NM off inshore: one off-route lease and one off-route lock-screen alert; back inside, both go', async () => {
        await offRoute(0.4);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith('off-route-watch');
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(safety(mocks.notify.scheduleSafetyAlert, 'off-route')).toHaveLength(1);
        const [options] = mocks.notify.scheduleSafetyAlert.mock.calls[0] as [{ title: string; body: string }];
        expect(options.title).toMatch(/^Off route: 0\.40 NM off the line$/);
        expect(options.body).toMatch(/limit 0\.25 NM/);
        expect(kinds()).toEqual(['off-route']);

        // Still off: no second lease, no second alert.
        pass({ offNm: 0.4 });
        await idle();
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledTimes(1);

        // Back inside 80% of the limit for 20 s.
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.audio.stopAlarm).toHaveBeenCalled();
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'off-route' });
        expect(kinds()).toEqual([]);
    });

    it('a mute silences it for 30 minutes with the card kept, and ends early back inside', async () => {
        await offRoute(0.4);
        UnderwayAlarmStore.mute('off-route', clock);
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'off-route' });
        const card = UnderwayAlarmStore.getCards()[0];
        expect(card.kind).toBe('off-route');
        expect(card.sounding).toBe(false);
        expect(card.mutedUntil).toBe(clock + 30 * MIN);

        // Ten minutes later, still off: still silent.
        pass({ offNm: 0.45, advanceS: 600 });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(acquire).toHaveBeenCalledTimes(1);

        // Back inside: the alarm clears and the mute ends with it.
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        await idle();
        expect(kinds()).toEqual([]);
        // Off again, well inside the 30 minutes: it sounds.
        pass({ offNm: 0.4 });
        pass({ offNm: 0.4 });
        await idle();
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('sounds again when the 30 minutes run out with her still off the line', async () => {
        await offRoute(0.4);
        UnderwayAlarmStore.mute('off-route', clock);
        await idle();
        pass({ offNm: 0.4, advanceS: 30 * 60 + 5 });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(UnderwayAlarmStore.getCards()[0].mutedUntil).toBeNull();
    });

    it('never runs while no route is followed', async () => {
        for (let i = 0; i < 10; i++) pass({ following: false, offNm: 3 });
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(kinds()).toEqual([]);
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
    });

    it('stands down at once when following stops or the switch goes off', async () => {
        await offRoute(0.4);
        pass({ following: false, offNm: 0.4 });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(kinds()).toEqual([]);

        await offRoute(0.4);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        pass({ offNm: 0.4, prefs: { offRoute: { enabled: false } } });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(kinds()).toEqual([]);
    });

    it('a new route starts a new latch: leaving a berth off the new line does not sound', async () => {
        await offRoute(0.4);
        const next = inputsFor({ offNm: 0.6 });
        runUnderwayPass({ ...next, following: { key: 'voyage-kestrel-2', route: SOLENT } });
        runUnderwayPass({ ...inputsFor({ offNm: 0.6 }), following: { key: 'voyage-kestrel-2', route: SOLENT } });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(UnderwayAlarmStore.getNotices()).toContain(UNDERWAY_NOTICES.arming);
    });

    it('says when it cannot see: not yet on the route, or no position', async () => {
        pass({ offNm: 0.6 });
        expect(UnderwayAlarmStore.getNotices()).toEqual([UNDERWAY_NOTICES.arming]);
        expect(UNDERWAY_NOTICES.arming).toBe('Off-route alarm arms once you are on the route.');
        pass({ offNm: 0.05 });
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
        pass({ offNm: null });
        expect(UnderwayAlarmStore.getNotices()).toEqual([UNDERWAY_NOTICES.noFix]);
        expect(UNDERWAY_NOTICES.noFix).toMatch(/no position/);
        await idle();
        expect(acquire).not.toHaveBeenCalled();
    });
});

describe('shoal water', () => {
    it('sounds on its own lease and kind, with or without a route', async () => {
        await shallow(false);
        expect(acquire).toHaveBeenCalledWith('shoal-watch');
        expect(safety(mocks.notify.scheduleSafetyAlert, 'shoal')).toHaveLength(1);
        const [options] = mocks.notify.scheduleSafetyAlert.mock.calls[0] as [{ title: string; body: string }];
        expect(options.title).toBe('Shoal water: 0.3 m under the keel');
        expect(kinds()).toEqual(['shoal']);
    });

    it('acknowledge silences it until it clears, then it re-arms', async () => {
        await shallow(false);
        UnderwayAlarmStore.acknowledge('shoal', clock);
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'shoal' });
        expect(kinds()).toEqual([]);

        // Still shallow: silent.
        for (let i = 0; i < 5; i++) pass({ following: false, depthM: 0.2 });
        await idle();
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(kinds()).toEqual([]);

        // Deep water for 10 s: re-armed.
        for (let i = 0; i < 3; i++) pass({ following: false, depthM: 1.5 });
        // Shallow again: it sounds.
        await shallow(false);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(kinds()).toEqual(['shoal']);
    });

    it('the watch check’s I’m on watch is never a shoal acknowledgement (126-02b stage-3 review)', async () => {
        await shallow(false);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        UnderwayAlarmStore.onWatch(clock); // the watch-keeper answers the watch check
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(UnderwayAlarmStore.getCards()).toEqual([expect.objectContaining({ kind: 'shoal', sounding: true })]);
        expect(mocks.notify.cancelSafetyAlert).not.toHaveBeenCalled();
        // Still shallow on the next pass: the same lease, still sounding.
        pass({ following: false, depthM: 0.3 });
        await idle();
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(UnderwayAlarmStore.getCards()).toEqual([expect.objectContaining({ kind: 'shoal', sounding: true })]);
    });

    it('says when the sounder it was reading goes stale, and nothing when there never was one', async () => {
        // No boat sounder at all (a phone on its own): nothing to say on the chart.
        for (let i = 0; i < 3; i++) pass({ following: false, boatFeed: false, depthM: null });
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
        // Live, then stale under way: said.
        pass({ following: false, depthM: 6 });
        pass({ following: false, depthM: 6, freshness: 'stale' });
        expect(UnderwayAlarmStore.getNotices()).toEqual([UNDERWAY_NOTICES.shoalStale]);
        expect(UNDERWAY_NOTICES.shoalStale).toBe('Shoal alarm: depth reading stale');
        // Stopped at a berth: shoal is not watching, so nothing to say.
        pass({ following: false, depthM: 6, freshness: 'stale', sogKn: 0.2 });
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
        await idle();
        expect(acquire).not.toHaveBeenCalled();
    });

    it('stopped at a berth in shallow water never sounds', async () => {
        for (let i = 0; i < 6; i++) pass({ following: false, depthM: 0.2, sogKn: 0.1 });
        await idle();
        expect(acquire).not.toHaveBeenCalled();
    });
});

describe('the two together', () => {
    it('cards in order: shoal, then off route; the collision cards are left alone', async () => {
        AisGuardAlertStore.setCollision(
            [
                {
                    mmsi: 123400901,
                    name: 'FICTIONAL COASTER',
                    distanceNm: 1.4,
                    bearing: 44,
                    sog: 11,
                    cog: 230,
                    shipType: '70',
                    timestamp: clock,
                    collision: { cpaNm: 0.2, tcpaMin: 7, closeQuarters: false, reportAgeSec: 10, source: 'local' },
                },
            ],
            clock,
        );
        pass({ offNm: 0.05 });
        pass({ offNm: 0.4, depthM: 0.3 });
        pass({ offNm: 0.4, depthM: 0.3 });
        pass({ offNm: 0.4, depthM: 0.3 });
        await idle();
        expect(kinds()).toEqual(['shoal', 'off-route']);
        expect(AisGuardAlertStore.get().map((a) => a.mmsi)).toEqual([123400901]);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);
    });

    it('both switches off: nothing runs at all', async () => {
        const prefs = { offRoute: { enabled: false }, shoal: { enabled: false } };
        for (let i = 0; i < 6; i++) pass({ offNm: 0.6, depthM: 0.2, prefs });
        pass({ offNm: null, depthM: 6, freshness: 'stale', prefs });
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(kinds()).toEqual([]);
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
    });

    it('stopping the watch stands both alarms down: nothing sounds with no watch behind it', async () => {
        await offRoute(0.4);
        for (let i = 0; i < 3; i++) pass({ offNm: 0.4, depthM: 0.3 });
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);
        stopUnderwayAlarmWatch();
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(kinds()).toEqual([]);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'off-route' });
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'shoal' });
    });

    it('the smoke-build scenarios are inert in every other build (the constant folds to false)', async () => {
        setDebugUnderway({ kind: 'shoal', startedAt: Date.now(), until: Date.now() + 60_000 });
        setDebugUnderway({ kind: 'off-route', startedAt: Date.now(), until: Date.now() + 60_000 });
        const stop = startUnderwayAlarmWatch();
        stop();
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(kinds()).toEqual([]);
    });

    it('never releases or force-stops the anchor alarm, and never touches the anchor’s notifications', async () => {
        const anchor = await AlarmAudioService.acquire('anchor-watch');
        acquire.mockClear();
        await offRoute(0.4);
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        pass({ offNm: 0.1 });
        await shallow(false);
        UnderwayAlarmStore.acknowledge('shoal', clock);
        await idle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        expect(mocks.audio.stopAlarm).not.toHaveBeenCalled();
        expect(forceStop).not.toHaveBeenCalled();
        expect(mocks.notify.scheduleAlarm).not.toHaveBeenCalled();
        expect(mocks.notify.cancelAlarm).not.toHaveBeenCalled();
        await AlarmAudioService.release(anchor);
    });
});

describe('the app goes to the background', () => {
    it('with an alarm armed and nothing keeping Thalassa running: one plain notice', async () => {
        pass({ offNm: 0.05 });
        await UnderwayAlarmWatch.onBackground(false, clock);
        await UnderwayAlarmWatch.onBackground(false, clock);
        expect(mocks.local.schedule).toHaveBeenCalledTimes(1);
        const [{ notifications }] = mocks.local.schedule.mock.calls[0] as [
            { notifications: { title: string; body: string }[] },
        ];
        expect(`${notifications[0].title}: ${notifications[0].body}`).toBe(UNDERWAY_NOTICES.paused);
        expect(UNDERWAY_NOTICES.paused).toBe(
            'Under-way alarms paused: Thalassa is in the background without a voyage track.',
        );
        UnderwayAlarmWatch.onForeground(clock);
        await UnderwayAlarmWatch.onBackground(false, clock);
        expect(mocks.local.schedule).toHaveBeenCalledTimes(2);
    });

    it('with a voyage track (the background GPS lease) keeping it running: no notice', async () => {
        pass({ offNm: 0.05 });
        await UnderwayAlarmWatch.onBackground(true, clock);
        expect(mocks.local.schedule).not.toHaveBeenCalled();
    });

    it('through the app’s own pause event, asking the background GPS lease', async () => {
        pass({ offNm: 0.05 });
        await vi.waitFor(() => expect(mocks.app.listeners.get('pause')).toBeDefined());
        mocks.app.listeners.get('pause')?.();
        await vi.waitFor(() => expect(mocks.local.schedule).toHaveBeenCalledTimes(1));
        mocks.app.listeners.get('resume')?.();
        mocks.bgGeo.getLeaseState.mockResolvedValue({ active: true });
        mocks.app.listeners.get('pause')?.();
        await new Promise((r) => setTimeout(r, 0));
        await idle();
        expect(mocks.local.schedule).toHaveBeenCalledTimes(1);
    });

    it('with nothing armed (no route followed, stopped): no notice', async () => {
        pass({ following: false, sogKn: 0, depthM: 6 });
        await UnderwayAlarmWatch.onBackground(false, clock);
        expect(mocks.local.schedule).not.toHaveBeenCalled();
    });
});

describe('stopped, arrived, and steering by the phone (stage-3 review)', () => {
    it('muted, then anchored off the line all night: it never sounds again at anchor', async () => {
        await offRoute(0.4);
        UnderwayAlarmStore.mute('off-route', clock);
        await idle();
        // Anchored 0.4 NM off the line, the anchor watch on, a pass a minute for two hours.
        for (let i = 0; i < 120; i++) {
            runUnderwayPass({ ...inputsFor({ offNm: 0.4, sogKn: 0.1, advanceS: 60 }), atAnchor: true });
        }
        await idle();
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(safety(mocks.notify.scheduleSafetyAlert, 'off-route')).toHaveLength(1);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(kinds()).toEqual([]);
    });

    it('past the end of the route: on into the marina 0.4 NM beyond the end pin never sounds', async () => {
        const end = SOLENT[1];
        const at = (p: { lat: number; lon: number }) => {
            const base = inputsFor({ sogKn: 3 });
            runUnderwayPass({ ...base, fix: { ...p, at: base.nowMs } });
        };
        at(beside(0.05));
        at(destinationPoint(SOLENT[0].lat, SOLENT[0].lon, 255, 5.95));
        for (let i = 1; i <= 8; i++) at(destinationPoint(end.lat, end.lon, 300, 0.05 * i));
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(kinds()).toEqual([]);
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
    });

    it('a day sail that ends where it starts is not arrived in the berth: off the line later, it sounds', async () => {
        const home = SOLENT[0];
        const away = destinationPoint(home.lat, home.lon, 255, 3);
        const loop = { key: 'voyage-kestrel-loop', route: [home, away, home] };
        const at = (p: { lat: number; lon: number }, cogDeg: number) => {
            const base = inputsFor({ sogKn: 2 });
            runUnderwayPass({ ...base, cogDeg, following: loop, fix: { ...p, at: base.nowMs } });
        };
        // Manoeuvring in the berth, her head toward the marina (along the leg home).
        at(destinationPoint(home.lat, home.lon, 345, 0.03), 75);
        at(destinationPoint(home.lat, home.lon, 345, 0.03), 75);
        // Out along the first leg, then 0.4 NM off it.
        for (const along of [0.5, 1, 1.5]) at(destinationPoint(home.lat, home.lon, 255, along), 255);
        const abeam = destinationPoint(home.lat, home.lon, 255, 1.6);
        at(destinationPoint(abeam.lat, abeam.lon, 345, 0.4), 255);
        at(destinationPoint(abeam.lat, abeam.lon, 345, 0.4), 255);
        await idle();
        expect(acquire).toHaveBeenCalledWith('off-route-watch');
        expect(kinds()).toEqual(['off-route']);
    });

    it('a phone on its own (no boat GPS): the alarm steers by the phone’s own last fix, as the HUD does', async () => {
        // What production holds: the selected place is a search, never 'gps'.
        mocks.location = { lat: 51.5, lon: -0.12, source: 'search', timestamp: T0 };
        mocks.follow = {
            isFollowing: true,
            routeCoords: SOLENT,
            voyageId: 'voyage-kestrel-1',
            startedAt: '2026-10-10T01:00:00Z',
        };
        let now = T0;
        const step = (offNm: number) => {
            now += 10 * S;
            const p = beside(offNm);
            mocks.gps = { latitude: p.lat, longitude: p.lon, timestamp: now - 2 * S, speed: 2.5, heading: 255 };
            runUnderwayPass(readUnderwayInputs(now));
        };
        step(0.05);
        const inputs = readUnderwayInputs(now);
        expect(inputs.fix).not.toBeNull();
        expect(inputs.sogKn).toBeCloseTo(4.86, 1);
        step(0.6);
        step(0.6);
        await idle();
        expect(acquire).toHaveBeenCalledWith('off-route-watch');
        expect(UnderwayAlarmStore.getNotices()).not.toContain(UNDERWAY_NOTICES.noFix);
        // A phone fix over 30 s old is no fix: the strip says so.
        mocks.gps = { ...mocks.gps!, timestamp: now - 45 * S };
        runUnderwayPass(readUnderwayInputs(now));
        expect(UnderwayAlarmStore.getNotices()).toContain(UNDERWAY_NOTICES.noFix);
    });

    it('a voyage track’s unconfirmed nearshore (offline) is no zone; real coastal evidence is', () => {
        const now = T0 + 5 * MIN;
        mocks.tracking = { isTracking: true, isPaused: false, loggingZone: 'nearshore' };
        mocks.shoreEvidence = null;
        expect(readUnderwayInputs(now).zone).toBeNull();
        mocks.shoreEvidence = 'nearshore';
        expect(readUnderwayInputs(now).zone).toBe('nearshore');
    });

    it('offline on a long open-water leg with a track recording: the offshore limit, not the inshore one', async () => {
        // The Bay of Islands out to sea, 30 NM; mid-leg, 15 NM from both ends.
        const bay = [{ lat: -35.2, lon: 174.1 }, destinationPoint(-35.2, 174.1, 45, 30)];
        const mid = destinationPoint(-35.2, 174.1, 45, 15);
        mocks.follow = { isFollowing: true, routeCoords: bay, voyageId: 'voyage-kestrel-3', startedAt: null };
        mocks.tracking = { isTracking: true, isPaused: false, loggingZone: 'nearshore' };
        mocks.shoreEvidence = null;
        let now = T0;
        const step = (offNm: number) => {
            now += 10 * S;
            const p = offNm === 0 ? mid : destinationPoint(mid.lat, mid.lon, 135, offNm);
            mocks.gps = { latitude: p.lat, longitude: p.lon, timestamp: now - S, speed: 2.5, heading: 45 };
            runUnderwayPass(readUnderwayInputs(now));
        };
        step(0);
        for (let i = 0; i < 4; i++) step(0.62);
        await idle();
        expect(acquire).not.toHaveBeenCalled();
    });

    it('a sounder lost under way is said; walking off a berthed boat is not', async () => {
        pass({ following: false, depthM: 6 });
        pass({ following: false, boatFeed: false, depthM: null });
        expect(UnderwayAlarmStore.getNotices()).toEqual([UNDERWAY_NOTICES.shoalLost]);
        expect(UNDERWAY_NOTICES.shoalLost).toBe('Shoal alarm: no depth from the boat');
        // The Pi's cloud row arrives shallow: never believed, and the strip still says it.
        for (let i = 0; i < 4; i++) pass({ following: false, boatFeed: false, depthM: 0.2 });
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(UnderwayAlarmStore.getNotices()).toEqual([UNDERWAY_NOTICES.shoalLost]);

        UnderwayAlarmWatch.__resetForTests();
        UnderwayAlarmStore.clear();
        pass({ following: false, depthM: 6, sogKn: 0.1 });
        pass({ following: false, boatFeed: false, depthM: null, sogKn: 3 });
        expect(UnderwayAlarmStore.getNotices()).toEqual([]);
    });

    it('alongside in shallow water with GPS speed blips: never sounds', async () => {
        for (let blip = 0; blip < 3; blip++) {
            for (let i = 0; i < 20; i++) pass({ following: false, depthM: 0.3, sogKn: 0.1, advanceS: 2 });
            pass({ following: false, depthM: 0.3, sogKn: 0.7, advanceS: 2 });
        }
        await idle();
        expect(acquire).not.toHaveBeenCalled();
        expect(kinds()).toEqual([]);
    });
});

describe('what it reads', () => {
    it('reads the followed route, the Ship’s Log zone, the switches and the draft from the app', () => {
        const now = T0 + 5 * MIN;
        mocks.follow.isFollowing = true;
        mocks.follow.routeCoords = SOLENT;
        mocks.follow.voyageId = 'voyage-kestrel-1';
        mocks.follow.startedAt = '2026-10-10T01:00:00Z';
        mocks.tracking = { isTracking: true, isPaused: false, loggingZone: 'offshore' };
        mocks.shoreEvidence = 'offshore';
        mocks.settings.underwayAlarms = { offRoute: { inshoreNm: 0.1 } };
        mocks.gps = { latitude: 50.7, longitude: -1.4, timestamp: now - 2 * S, speed: 2.5, heading: 255 };
        const inputs = readUnderwayInputs(now);
        expect(inputs.following?.route).toEqual(SOLENT);
        expect(inputs.zone).toBe('offshore');
        expect(inputs.prefs.offRoute.inshoreNm).toBe(0.1);
        expect(inputs.fix).toEqual({ lat: 50.7, lon: -1.4, at: now - 2 * S });
        expect(inputs.draftM).toBeCloseTo(2.4, 3);
        expect(inputs.draftAssumed).toBe(false);
        expect(inputs.marginM).toBe(0.5);

        // Not recording a track: no zone. Not following: no route.
        mocks.tracking = { isTracking: false, isPaused: false, loggingZone: 'offshore' };
        mocks.follow.isFollowing = false;
        const quiet = readUnderwayInputs(now);
        expect(quiet.zone).toBeNull();
        expect(quiet.following).toBeNull();
    });

    it('never asks what tier the account is: both alarms for everyone', () => {
        for (const file of [
            'services/underway/underwayRule.ts',
            'services/underway/underKeelClearance.ts',
            'services/underway/UnderwayAlarmWatch.ts',
            'services/underway/underwayAlarmStore.ts',
            'components/map/UnderwayAlarmCards.tsx',
        ]) {
            const source = readFileSync(resolve(process.cwd(), file), 'utf8');
            expect(source, file).not.toMatch(/canAccess|SubscriptionService|subscriptionTier|isPro\b|useSubscription/);
        }
    });
});
