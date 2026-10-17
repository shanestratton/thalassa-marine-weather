/**
 * The aboard GPS/instruments-silent alarm (129-08) inside the app-wide
 * under-way watch: its card first in the stack, its own sound lease
 * ('instruments-watch', owner-scoped, so it can never silence the anchor
 * alarm) and its own Time Sensitive lock-screen kind ('instruments-silent').
 * No Calypso, no internet: nothing here speaks through the voice path.
 *
 * Fictional boat 'Kestrel' in Oslofjord, 59.9N 10.7E.
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
        scheduleSafetyAlert: vi.fn().mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' }),
        cancelSafetyAlert: vi.fn().mockResolvedValue({ cancelled: true }),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: { schedule: vi.fn() } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLeaseState: vi.fn() } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: () => ({ isTracking: false, isPaused: false }),
        getEvidencedShoreZone: () => null,
    },
}));
vi.mock('../services/collisionAnchorWatch', () => ({ readCollisionAnchorWatch: () => 'none' }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({}), isBoatFeed: () => false, subscribe: () => () => undefined },
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: Object.assign(() => undefined, {
        getState: () => ({ isFollowing: false, routeCoords: [] }),
        subscribe: () => () => undefined,
    }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(() => undefined, {
        getState: () => ({ settings: { vessel: { draft: 6 } } }),
        subscribe: () => () => undefined,
    }),
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: { getState: () => ({ lat: 0, lon: 0, source: 'none', timestamp: 0 }) },
}));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => null } }));
const link = vi.hoisted(() => ({
    facts: { where: 'aboard', live: false, lastLive: { at: Date.UTC(2026, 9, 14, 21, 0, 0), lane: 'socket' } },
}));
vi.mock('../services/boatLink/BoatLinkService', () => ({ BoatLinkService: { boatFeedFacts: () => link.facts } }));
/** The boat link's gate asks these (131-01): a Pi paired or a gateway saved. */
const boatLinkSetUp = vi.hoisted(() => ({ saved: null as null | { host: string; port: number } }));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => null }));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getSavedConfig: () => boatLinkSetUp.saved },
}));

import { AlarmAudioService } from '../services/AlarmAudioService';
import {
    UnderwayAlarmWatch,
    readUnderwayInputs,
    runUnderwayPass,
    startUnderwayAlarmWatch,
    stopUnderwayAlarmWatch,
    type UnderwayInputs,
} from '../services/underway/UnderwayAlarmWatch';
import { UnderwayAlarmStore } from '../services/underway/underwayAlarmStore';
import { sanitiseUnderwayPrefs } from '../services/underway/underwayRule';
import { loadedBoatLink, resetBoatLinkGateForTests } from '../services/boatLink/boatLinkGate';

const T0 = Date.UTC(2026, 9, 14, 21, 0, 0);
const MIN = 60_000;
let clock = T0;

type Boat = NonNullable<UnderwayInputs['boat']>;

function inputs(boat: Partial<Boat>, o: { sogKn?: number | null; atAnchor?: boolean } = {}): UnderwayInputs {
    return {
        nowMs: clock,
        prefs: sanitiseUnderwayPrefs(undefined),
        following: null,
        fix: null,
        sogKn: o.sogKn === undefined ? 6 : o.sogKn,
        cogDeg: 190,
        atAnchor: o.atAnchor ?? false,
        zone: null,
        depth: { boatFeed: false, depthM: null, reference: null, offsetM: null, freshness: 'dead', readingAt: 0 },
        draftM: 1.8,
        draftAssumed: false,
        marginM: 0.5,
        boat: {
            where: 'aboard',
            live: false,
            lastLive: { at: T0, lane: 'pi-direct' },
            tracking: false,
            ...boat,
        },
    };
}

const idle = () => UnderwayAlarmWatch.whenIdle();
const kinds = () => UnderwayAlarmStore.getCards().map((c) => c.kind);
const safety = (kind: string) =>
    mocks.notify.scheduleSafetyAlert.mock.calls.filter(([options]) => (options as { kind: string }).kind === kind);

let acquire: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    clock = T0;
    UnderwayAlarmWatch.__resetForTests();
    UnderwayAlarmStore.clear();
    await AlarmAudioService.forceStop();
    vi.clearAllMocks();
    acquire = vi.spyOn(AlarmAudioService, 'acquire');
});

afterEach(async () => {
    await idle();
    acquire.mockRestore();
});

describe('the aboard GPS/instruments-silent alarm', () => {
    it('sounds after 2 min aboard and under way: its card first, its own lease and lock-screen kind', async () => {
        clock = T0 + MIN;
        runUnderwayPass(inputs({}));
        await idle();
        expect(kinds()).toEqual([]);

        clock = T0 + 2 * MIN;
        runUnderwayPass(inputs({}));
        await idle();
        expect(kinds()).toEqual(['instruments']);
        const [card] = UnderwayAlarmStore.getCards();
        expect(card).toMatchObject({
            title: 'INSTRUMENTS SILENT',
            value: 'No GPS or instruments from the boat for 2 minutes',
            sounding: true,
        });
        expect(acquire).toHaveBeenCalledWith('instruments-watch');
        expect(safety('instruments-silent')).toHaveLength(1);
        expect(safety('instruments-silent')[0][0]).toMatchObject({
            title: 'No GPS or instruments from the boat for 2 minutes',
            body: 'Check her instruments’ power and the gateway.',
        });

        // A minute on, the card counts on; no second lease, no second lock-screen alert.
        clock = T0 + 3 * MIN;
        runUnderwayPass(inputs({ where: 'unknown' }));
        await idle();
        expect(UnderwayAlarmStore.getCards()[0].value).toBe('No GPS or instruments from the boat for 3 minutes');
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(safety('instruments-silent')).toHaveLength(1);

        // The data is back: the card, the sound and the lock-screen alert go.
        clock = T0 + 4 * MIN;
        runUnderwayPass(inputs({ live: true, lastLive: { at: clock, lane: 'pi-direct' } }));
        await idle();
        expect(kinds()).toEqual([]);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'instruments-silent' });
    });

    it('also at anchor with a watch on, and with a voyage track recording while stopped', async () => {
        clock = T0 + 5 * MIN;
        runUnderwayPass(inputs({}, { sogKn: 0, atAnchor: true }));
        await idle();
        expect(kinds()).toEqual(['instruments']);
        UnderwayAlarmWatch.__resetForTests();
        UnderwayAlarmStore.clear();
        runUnderwayPass(inputs({ tracking: true }, { sogKn: 0 }));
        await idle();
        expect(kinds()).toEqual(['instruments']);
    });

    it('under way while her data was live, then no speed at all once it died: still sounds', async () => {
        // Live and under way: her own SOG says so.
        runUnderwayPass(inputs({ live: true, lastLive: { at: T0, lane: 'pi-direct' } }, { sogKn: 6 }));
        // The bus dies, and the phone has no speed of its own (no location permission).
        clock = T0 + 2 * MIN;
        runUnderwayPass(inputs({}, { sogKn: null }));
        await idle();
        expect(kinds()).toEqual(['instruments']);
    });

    it('stopped while her data was live, then silent with no speed: says nothing (the berth)', async () => {
        runUnderwayPass(inputs({ live: true, lastLive: { at: T0, lane: 'pi-direct' } }, { sogKn: 0 }));
        clock = T0 + 5 * MIN;
        runUnderwayPass(inputs({}, { sogKn: null }));
        await idle();
        expect(kinds()).toEqual([]);
    });

    it('a route being followed arms it, whatever the speed', async () => {
        clock = T0 + 2 * MIN;
        const route = [
            { lat: 59.91, lon: 10.75 },
            { lat: 59.8, lon: 10.6 },
        ] as unknown as NonNullable<UnderwayInputs['following']>['route'];
        runUnderwayPass({ ...inputs({}, { sogKn: null }), following: { key: 'oslofjord', route } });
        await idle();
        expect(kinds()).toContain('instruments');
    });

    it('never ashore, never at a berth with nothing to watch, never for a cloud row that stopped', async () => {
        clock = T0 + 30 * MIN;
        runUnderwayPass(inputs({ where: 'ashore' }));
        runUnderwayPass(inputs({}, { sogKn: 0 }));
        runUnderwayPass(inputs({}, { sogKn: null }));
        runUnderwayPass(inputs({ lastLive: { at: T0, lane: 'cloud' } }));
        runUnderwayPass(inputs({ lastLive: null }));
        await idle();
        expect(kinds()).toEqual([]);
        expect(acquire).not.toHaveBeenCalled();
        expect(safety('instruments-silent')).toHaveLength(0);
    });

    it('with no boat facts (BoatLink not loaded yet) it says nothing', async () => {
        clock = T0 + 30 * MIN;
        runUnderwayPass({ ...inputs({}), boat: null });
        await idle();
        expect(kinds()).toEqual([]);
    });

    it('Acknowledge silences it until the data is back, then it re-arms', async () => {
        clock = T0 + 2 * MIN;
        runUnderwayPass(inputs({}));
        await idle();
        UnderwayAlarmStore.acknowledge('instruments', clock);
        await idle();
        expect(kinds()).toEqual([]);
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);

        clock = T0 + 20 * MIN;
        runUnderwayPass(inputs({}));
        await idle();
        expect(kinds()).toEqual([]);

        clock = T0 + 21 * MIN;
        runUnderwayPass(inputs({ live: true, lastLive: { at: clock, lane: 'socket' } }));
        clock = T0 + 23 * MIN;
        runUnderwayPass(inputs({ lastLive: { at: T0 + 21 * MIN, lane: 'socket' } }));
        await idle();
        expect(kinds()).toEqual(['instruments']);
    });

    it('with no Pi and no gateway the watch never loads the boat link: the alarm hears only her socket or her Pi (131-01)', async () => {
        resetBoatLinkGateForTests();
        boatLinkSetUp.saved = null;
        startUnderwayAlarmWatch();
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(readUnderwayInputs(clock).boat).toBeNull();
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(loadedBoatLink()).toBeNull();
        } finally {
            stopUnderwayAlarmWatch();
        }
    });

    it('reads where the phone is and the last live reading from BoatLink once the watch runs', async () => {
        resetBoatLinkGateForTests();
        expect(readUnderwayInputs(clock).boat).toBeNull();
        // A boat with a gateway saved (131-01 loads the boat link only for one, or a Pi).
        boatLinkSetUp.saved = { host: '192.0.2.151', port: 1457 };
        startUnderwayAlarmWatch();
        try {
            await vi.waitFor(() => expect(readUnderwayInputs(clock).boat).toEqual({ ...link.facts, tracking: false }));
        } finally {
            stopUnderwayAlarmWatch();
            boatLinkSetUp.saved = null;
        }
    });

    it('sits first, above the shoal and off-route cards', async () => {
        UnderwayAlarmStore.set(
            [
                { kind: 'off-route', title: 'Off route', value: 'v', detail: 'd', sounding: true, mutedUntil: null },
                {
                    kind: 'instruments',
                    title: 'INSTRUMENTS SILENT',
                    value: 'v',
                    detail: 'd',
                    sounding: true,
                    mutedUntil: null,
                },
                { kind: 'shoal', title: 'Shoal', value: 'v', detail: 'd', sounding: true, mutedUntil: null },
            ],
            [],
        );
        expect(kinds()).toEqual(['instruments', 'shoal', 'off-route']);
    });
});
