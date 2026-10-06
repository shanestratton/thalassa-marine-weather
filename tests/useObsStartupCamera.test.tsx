/**
 * Where Obs opens, and what it says when it cannot open on a live fix.
 *
 * Shane 2026-10-06, after testing Obs on a bus: "If the punter selects their
 * boat in the location box then it should put the vessels location in the
 * middle of the screen ... If the punter is on a duck I don't know maybe a
 * bus, then that should make no difference. But if the punter has selected
 * current location, then that should be the punters phone as centre on the
 * screen regardless of where they are. If there is no gps from their phone
 * then the last known location with a clear message telling them that."
 *
 * The real follow-target store and boat chain (services/weatherPosition) run
 * here; only the receivers are faked: the boat's rungs (boatPositionChain),
 * the phone (GpsService, LocationStore) and the instrument store's
 * notifications (NmeaStore). Places and positions are fictional.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type mapboxgl from 'mapbox-gl';
import type { GpsPosition } from '../services/GpsService';
import type { BoatFix } from '../services/boatPositionChain';
import type { OwnshipNavigationInput } from '../services/ownshipPosition';

const deps = vi.hoisted(() => ({
    nmea: {} as OwnshipNavigationInput,
    location: { lat: -27.47, lon: 153.02, source: 'initial', timestamp: 0 } as {
        lat: number;
        lon: number;
        source: string;
        timestamp: number;
    },
    nmeaListeners: new Set<() => void>(),
    locationListeners: new Set<() => void>(),
    gps: vi.fn(),
    foregroundGps: vi.fn(),
    backgroundGps: vi.fn(),
    lastKnown: null as GpsPosition | null,
    permission: vi.fn(async () => 'denied'),
    busFix: vi.fn<() => BoatFix | null>(() => null),
    piFix: vi.fn<() => Promise<BoatFix | null>>(async () => null),
    cloudFix: vi.fn<(now?: number, owner?: string) => Promise<BoatFix | null>>(async () => null),
    deviceRungOwner: vi.fn<(rung: 'bus' | 'pi') => string | null>(() => null),
}));

vi.mock('../services/boatPositionChain', () => ({
    busFix: deps.busFix,
    piFix: deps.piFix,
    cloudFix: deps.cloudFix,
    deviceRungOwner: deps.deviceRungOwner,
    CLOUD_FIX_MAX_AGE_MS: 60_000,
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => deps.nmea,
        subscribe: (listener: () => void) => {
            deps.nmeaListeners.add(listener);
            return () => deps.nmeaListeners.delete(listener);
        },
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => deps.location,
        subscribe: (listener: () => void) => {
            deps.locationListeners.add(listener);
            return () => deps.locationListeners.delete(listener);
        },
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPositionIfGranted: deps.gps,
        requestCurrentForegroundPosition: deps.foregroundGps,
        getCurrentPosition: deps.backgroundGps,
        getLastKnownPosition: () => deps.lastKnown,
        locationPermission: deps.permission,
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/memoryCensus', () => ({ registerCensusMap: vi.fn(), registerCensusProbe: vi.fn() }));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
vi.mock('../components/map/encPrewarmLifecycle', () => ({ deferEncPrewarm: () => vi.fn() }));
vi.mock('../components/map/paneAwareAttribution', () => ({ installPaneAwareAttribution: () => vi.fn() }));
vi.mock('../components/map/zombieMapGuard', () => ({ armZombieMapGuards: vi.fn() }));

const maps = vi.hoisted(() => {
    class FakeMap {
        listeners = new Map<string, Set<(event?: unknown) => void>>();
        touchZoomRotate = { disableRotation: vi.fn() };
        jumpTo = vi.fn();
        // No movestart, as Mapbox when a flight starts mid-ease: find-boat
        // must take the camera without relying on it.
        flyTo = vi.fn((_options: unknown) => this);
        addControl = vi.fn();
        remove = vi.fn();
        on = vi.fn((name: string, listener: (event?: unknown) => void) => {
            const listeners = this.listeners.get(name) ?? new Set();
            listeners.add(listener);
            this.listeners.set(name, listeners);
            return this;
        });
        off = vi.fn((name: string, listener: (event?: unknown) => void) => {
            this.listeners.get(name)?.delete(listener);
            return this;
        });
        once = vi.fn();
        constructor(public options: Record<string, unknown> = {}) {
            instances.push(this);
        }
        emit(name: string, event?: unknown) {
            [...(this.listeners.get(name) ?? [])].forEach((listener) => listener(event));
        }
    }
    const instances: FakeMap[] = [];
    return { FakeMap, instances };
});

vi.mock('mapbox-gl', () => ({ default: { Map: maps.FakeMap, ScaleControl: class {} } }));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { __resetWeatherPositionForTests, rememberBoatFix, setWeatherFollowTarget } from '../services/weatherPosition';
import { __resetPhoneLastFixForTests, rememberPhoneFix } from '../services/phoneLastFix';
import {
    OBS_NOTICE_GRACE_MS,
    OBS_START_FOLLOW,
    OBS_VESSEL_ZOOM,
    obsStartTarget,
    useObsStartupCamera,
    type ObsStartTarget,
} from '../components/map/useObsStartupCamera';
import {
    LOCATE_LOOKUP_DEADLINE_MS,
    OBS_LIVE_CHECK_MS,
    __resetObsCentreForTests,
    clearObsCentreNotice,
    findBoatOwner,
    getObsCentreNotice,
    locatePhone,
    locateVessel,
    obsCentreNoticeText,
    obsLocateSubject,
    showObsCentreNotice,
    useObsCentreNoticeWatch,
    type ObsBoatNames,
} from '../components/map/obsCentre';
import { useMapInit } from '../components/map/useMapInit';

const NOW = Date.parse('2026-10-06T02:00:00.000Z');
const HOUR = 3_600_000;
/** The boat, on her mooring. */
const VESSEL = { lat: -23.9, lon: 152.4 };
/** The punter, on a bus a long way from her. */
const BUS = { lat: -27.5, lon: 153.1 };
/** A boat this account crews on, elsewhere again. */
const WIND_DANCER = { lat: -19.1, lon: 147.6 };
const SKIPPER = 'skipper-wd';
const WEATHER = { lat: -33.86, lon: 151.2 };
const BROAD = [145, -28];
const NAMES: ObsBoatNames = { own: 'Serene Summer', crew: { ownerId: SKIPPER, name: 'Wind Dancer' } };

const busFixAt = (at = VESSEL, timestamp = NOW): BoatFix => ({
    latitude: at.lat,
    longitude: at.lon,
    timestamp,
    rung: 'bus',
    source: 'nmea-gateway',
});
const cloudFixAt = (at: { lat: number; lon: number }, timestamp = NOW): BoatFix => ({
    latitude: at.lat,
    longitude: at.lon,
    timestamp,
    rung: 'cloud',
    source: 'pi-cloud',
});

function phoneFix(overrides: Partial<GpsPosition> = {}): GpsPosition {
    return {
        latitude: BUS.lat,
        longitude: BUS.lon,
        accuracy: 5,
        altitude: null,
        heading: null,
        speed: 0,
        timestamp: NOW,
        ...overrides,
    };
}

/** The boat is live on her bus (and, for the old ownship arbiter, in the store). */
function boatLive(at = VESSEL, timestamp = NOW) {
    deps.busFix.mockImplementation(() => busFixAt(at, timestamp));
    deps.nmea = {
        latitude: { value: at.lat, lastUpdated: timestamp, freshness: 'live' },
        longitude: { value: at.lon, lastUpdated: timestamp, freshness: 'live' },
    };
}

/** The phone is live where the punter is (its watch tap and LocationStore both have it). */
function phoneLive(at = BUS, timestamp = NOW) {
    deps.lastKnown = phoneFix({ latitude: at.lat, longitude: at.lon, timestamp });
    deps.location = { lat: at.lat, lon: at.lon, source: 'gps', timestamp };
    deps.gps.mockResolvedValue(phoneFix({ latitude: at.lat, longitude: at.lon, timestamp }));
}

function follow(target: 'phone' | 'boat' | 'crew') {
    if (target === 'crew') setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'phone' });
    else setWeatherFollowTarget(target);
}

function deferGps() {
    let resolve!: (position: GpsPosition | null) => void;
    deps.gps.mockReturnValueOnce(new Promise<GpsPosition | null>((done) => (resolve = done)));
    return resolve;
}

/** Let the lookups (Pi, cloud, the phone, the permission read) answer. */
async function settleLookups() {
    for (let i = 0; i < 6; i += 1) await act(async () => {});
}

const jumpedTo = (map: InstanceType<typeof maps.FakeMap>) =>
    map.jumpTo.mock.calls.map(([options]) => (options as { center: number[] }).center);

function mountBox(target: ObsStartTarget = OBS_START_FOLLOW, ready = true, enabled = true) {
    const map = new maps.FakeMap();
    const props = { mapRef: { current: map as unknown as mapboxgl.Map | null }, ready, enabled, target };
    const view = renderHook(
        ({ mapRef, ready, enabled, target }) => useObsStartupCamera(mapRef, ready, enabled, target),
        { initialProps: props },
    );
    return { ...view, map, props };
}

const noticeText = (names: ObsBoatNames = NAMES) => {
    const notice = getObsCentreNotice();
    return notice ? obsCentreNoticeText(notice, names, Date.now()) : null;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('owner-ss');
    reloadSharedBindersFromStorage();
    maps.instances.length = 0;
    deps.nmea = {};
    deps.location = { lat: -27.47, lon: 153.02, source: 'initial', timestamp: NOW };
    deps.lastKnown = null;
    deps.nmeaListeners.clear();
    deps.locationListeners.clear();
    deps.gps.mockResolvedValue(null);
    deps.permission.mockResolvedValue('denied');
    deps.busFix.mockImplementation(() => null);
    deps.piFix.mockImplementation(async () => null);
    deps.cloudFix.mockImplementation(async () => null);
    deps.deviceRungOwner.mockImplementation(() => null);
    __resetWeatherPositionForTests();
    __resetPhoneLastFixForTests();
    __resetObsCentreForTests();
    follow('phone');
});

afterEach(async () => {
    cleanup();
    await Promise.resolve();
    await Promise.resolve();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('the box follows the BOAT: her position, never the phone', () => {
    beforeEach(() => follow('boat'));

    it('centres on her live fix at z14 and ignores the phone on the bus', async () => {
        boatLive();
        phoneLive();
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(deps.gps).not.toHaveBeenCalled();
        expect(getObsCentreNotice()).toBeNull();
        // Settled: no more listening, and a later phone fix cannot move it.
        expect(deps.nmeaListeners.size).toBe(0);
        expect(deps.locationListeners.size).toBe(0);
    });

    it('takes her cloud row when the bus is quiet, never the phone meanwhile', async () => {
        phoneLive();
        deps.cloudFix.mockImplementation(async (_now, owner) =>
            owner === 'self' ? cloudFixAt(VESSEL, NOW - 20_000) : null,
        );
        const { map } = mountBox();
        await settleLookups();
        expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('holds her last known fix with a message naming her and its age', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        phoneLive();
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
        expect(getObsCentreNotice()).toMatchObject({ state: 'held', at: NOW - 3 * HOUR });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        expect(noticeText({ own: null, crew: null })).toBe('Showing the last known position of your boat · 3 h ago');
    });

    it('with no position ever: the broad view and "No position from <boat> yet", not the phone', async () => {
        phoneLive();
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: BROAD, zoom: 3 });
        expect(noticeText()).toBe('No position from Serene Summer yet');
        expect(deps.gps).not.toHaveBeenCalled();
    });

    it('waits for her live fix without a message, then centres once and clears nothing it never said', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        let answer!: (fix: BoatFix | null) => void;
        deps.cloudFix.mockImplementation(() => new Promise((done) => (answer = done)));
        const { map } = mountBox();
        await act(async () => {});
        expect(getObsCentreNotice()).toBeNull(); // still asking: no message yet
        const moored = { lat: -23.91, lon: 152.41 };
        await act(async () => answer(cloudFixAt(moored, NOW)));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [moored.lon, moored.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('a live fix after the message clears it and centres once, then stops listening', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map } = mountBox();
        await settleLookups();
        expect(getObsCentreNotice()?.state).toBe('held');
        const underway = { lat: -23.8, lon: 152.5 };
        vi.setSystemTime(NOW + 1_000);
        boatLive(underway, NOW + 1_000);
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [underway.lon, underway.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
        expect(deps.nmeaListeners.size).toBe(0);
        const calls = map.jumpTo.mock.calls.length;
        boatLive({ lat: -23.7, lon: 152.6 }, NOW + 2_000);
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 3));
        expect(map.jumpTo).toHaveBeenCalledTimes(calls); // centred once, no following
    });

    it('after a gesture the late live fix never moves the camera', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map } = mountBox();
        await settleLookups();
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        const calls = map.jumpTo.mock.calls.length;
        boatLive({ lat: -23.8, lon: 152.5 }, NOW);
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 2));
        expect(map.jumpTo).toHaveBeenCalledTimes(calls);
        // The message still says what the chart opened on.
        expect(getObsCentreNotice()?.state).toBe('held');
    });

    it('the Pi over the boat LAN counts, the phone never', async () => {
        phoneLive();
        deps.piFix.mockImplementation(async () => ({
            ...busFixAt(VESSEL, NOW - 5_000),
            rung: 'pi',
            source: 'ydwg-tcp.YD',
        }));
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
    });
});

describe('the box follows the boat crewed on: her skipper’s chain only', () => {
    beforeEach(() => follow('crew'));

    it('centres on her, never the own boat on the bus socket or the phone', async () => {
        boatLive(VESSEL); // a gateway socket that names no boat: not hers
        phoneLive();
        deps.cloudFix.mockImplementation(async (_now, owner) => (owner === SKIPPER ? cloudFixAt(WIND_DANCER) : null));
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [WIND_DANCER.lon, WIND_DANCER.lat], zoom: 14 });
        expect(jumpedTo(map)).not.toContainEqual([VESSEL.lon, VESSEL.lat]);
        expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
    });

    it('her held fix with a message naming her (or her skipper’s boat)', async () => {
        rememberBoatFix(cloudFixAt(WIND_DANCER, NOW - 26 * HOUR), NOW - 26 * HOUR, SKIPPER);
        rememberBoatFix(busFixAt(VESSEL, NOW - HOUR), NOW - HOUR); // the own boat's, newer: not hers
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [WIND_DANCER.lon, WIND_DANCER.lat], zoom: 14 });
        expect(noticeText()).toMatch(/^Showing Wind Dancer's last known position · yesterday \d\d:\d\d$/);
        expect(noticeText({ own: 'Serene Summer', crew: null })).toMatch(
            /^Showing the last known position of your skipper's boat · yesterday \d\d:\d\d$/,
        );
    });

    it('none at all: broad view and "No position from <her> yet"', async () => {
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: BROAD, zoom: 3 });
        expect(noticeText()).toBe('No position from Wind Dancer yet');
    });
});

describe('the box is Current Location: the phone, never the boat', () => {
    it('centres on the phone’s live fix at z14 wherever the boat is', async () => {
        boatLive();
        phoneLive();
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
        expect(deps.busFix).not.toHaveBeenCalled();
    });

    it('asks the phone passively once when it holds no fix, and centres on the answer', async () => {
        boatLive();
        const resolve = deferGps();
        const { map } = mountBox();
        expect(deps.gps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
        expect(deps.foregroundGps).not.toHaveBeenCalled();
        expect(deps.backgroundGps).not.toHaveBeenCalled();
        expect(jumpedTo(map)).not.toContainEqual([VESSEL.lon, VESSEL.lat]);
        await act(async () => resolve(phoneFix()));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('no phone GPS: its last known fix and a message, never the live boat', async () => {
        boatLive();
        rememberPhoneFix(phoneFix({ timestamp: NOW - 2 * HOUR }), NOW - 2 * HOUR);
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        expect(jumpedTo(map)).not.toContainEqual([VESSEL.lon, VESSEL.lat]);
        expect(noticeText()).toBe('Phone GPS unavailable · showing where you were 2 h ago');
    });

    it.each([
        ['denied', 'Phone GPS unavailable: allow location to centre here'],
        ['prompt', 'Phone GPS unavailable: allow location to centre here'],
        ['granted', 'Phone GPS unavailable: no fix yet'],
    ] as const)('no phone fix ever (%s): the broad view, never the boat', async (permission, words) => {
        boatLive();
        deps.permission.mockResolvedValue(permission);
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: BROAD, zoom: 3 });
        expect(noticeText()).toBe(words);
    });

    it('a live phone fix after the message clears it and centres once', async () => {
        const { map } = mountBox();
        await settleLookups();
        expect(getObsCentreNotice()?.state).toBe('none');
        vi.setSystemTime(NOW + 1_000);
        phoneLive(BUS, NOW + 1_000);
        act(() => deps.locationListeners.forEach((listener) => listener()));
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
        expect(deps.locationListeners.size).toBe(0);
    });

    // An account change re-stamps LocationStore's GPS entry with the time of
    // the write, so an hours-old fix there would pass for live.
    it('LocationStore’s GPS entry alone is not a live phone fix', async () => {
        rememberPhoneFix(phoneFix({ timestamp: NOW - 2 * HOUR }), NOW - 2 * HOUR);
        deps.location = { ...BUS, source: 'gps', timestamp: NOW };
        const { map } = mountBox();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        expect(noticeText()).toBe('Phone GPS unavailable · showing where you were 2 h ago');
    });

    it.each(['initial', 'search', 'favorite', 'map_pin'])('a %s coordinate is not the phone', async (source) => {
        deps.location = { ...WEATHER, source, timestamp: NOW };
        const { map } = mountBox();
        await settleLookups();
        expect(jumpedTo(map)).not.toContainEqual([WEATHER.lon, WEATHER.lat]);
    });

    it.each([{ timestamp: NOW - 30_001 }, { timestamp: NOW + 5_001 }, { latitude: 91 }, { longitude: Number.NaN }])(
        'rejects an unusable phone answer: %j',
        async (overrides) => {
            const resolve = deferGps();
            const { map } = mountBox();
            await act(async () => resolve(phoneFix(overrides)));
            await settleLookups();
            expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
        },
    );
});

describe('the startup camera lifecycle', () => {
    it.each(['movestart', 'zoomstart', 'dragstart'])(
        'a user %s while the phone is asked keeps the view',
        async (event) => {
            const resolve = deferGps();
            const { map } = mountBox();
            const calls = map.jumpTo.mock.calls.length;
            act(() => map.emit(event, { originalEvent: new Event('pointermove') }));
            await act(async () => resolve(phoneFix()));
            await settleLookups();
            expect(map.jumpTo).toHaveBeenCalledTimes(calls);
            expect(deps.nmeaListeners.size).toBe(0);
            expect(deps.locationListeners.size).toBe(0);
        },
    );

    it('also respects a gesture before the map becomes ready', async () => {
        follow('boat');
        const { map, rerender, props } = mountBox(OBS_START_FOLLOW, false);
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        boatLive();
        rerender({ ...props, ready: true });
        await settleLookups();
        expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it('waits for map readiness without treating a programmatic move as a gesture', async () => {
        follow('boat');
        const { map, rerender, props } = mountBox(OBS_START_FOLLOW, false);
        boatLive();
        act(() => map.emit('movestart', {}));
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, ready: true });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    // Leaving Obs is not the skipper taking the camera (review 2026-10-06).
    it('never moves the hidden chart; a centring that had not centred takes the live fix on the next visit', async () => {
        const resolve = deferGps();
        const { map, rerender, props } = mountBox();
        expect(jumpedTo(map)).toEqual([BROAD]);
        rerender({ ...props, enabled: false });
        await act(async () => resolve(phoneFix()));
        phoneLive();
        await settleLookups();
        expect(jumpedTo(map)).toEqual([BROAD]); // nothing while Obs is hidden
        rerender(props);
        await settleLookups();
        expect(jumpedTo(map)).toEqual([BROAD, [BUS.lon, BUS.lat]]);
        expect(getObsCentreNotice()).toBeNull();
        // Centred: the visit after that keeps the view.
        rerender({ ...props, enabled: false });
        rerender(props);
        expect(map.jumpTo).toHaveBeenCalledTimes(2);
    });

    it('a camera the skipper took before leaving stays where it was left', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map, rerender, props } = mountBox();
        await settleLookups();
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        rerender({ ...props, enabled: false });
        boatLive({ lat: -23.8, lon: 152.5 });
        rerender(props);
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
    });

    it('does nothing on an initially inactive planning/picker/pin surface', () => {
        follow('boat');
        boatLive();
        const { map, rerender, props } = mountBox(OBS_START_FOLLOW, true, false);
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(map.on).not.toHaveBeenCalled();
        rerender({ ...props, enabled: true });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it.each(['unmount', 'replace'] as const)('ignores a pending phone answer after map %s', async (change) => {
        const resolve = deferGps();
        const { map, unmount, props } = mountBox();
        const calls = map.jumpTo.mock.calls.length;
        if (change === 'unmount') unmount();
        else props.mapRef.current = new maps.FakeMap() as unknown as mapboxgl.Map;
        await act(async () => resolve(phoneFix()));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledTimes(calls);
    });

    it('find-boat’s flight takes the camera: a late phone fix no longer moves it', async () => {
        follow('phone');
        const { map } = mountBox();
        await settleLookups(); // no phone fix: broad, waiting
        boatLive();
        await act(async () => {
            await locateVessel(map as unknown as mapboxgl.Map, null, NAMES, OBS_VESSEL_ZOOM);
        });
        const calls = map.jumpTo.mock.calls.length;
        phoneLive(BUS, NOW);
        act(() => deps.locationListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 2));
        expect(map.jumpTo).toHaveBeenCalledTimes(calls);
    });

    it('find-boat during the phone lookup: the boat’s message stands, not the phone’s', async () => {
        follow('phone');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const resolve = deferGps();
        const { map } = mountBox();
        await act(async () => {
            await locateVessel(map as unknown as mapboxgl.Map, null, NAMES, OBS_VESSEL_ZOOM);
        });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        await act(async () => resolve(null));
        await settleLookups();
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        expect(map.flyTo).toHaveBeenCalledOnce();
    });
});

/** The camera hook and the message watch, mounted together as MapHub mounts them. */
function mountObs(target: ObsStartTarget = OBS_START_FOLLOW) {
    const map = new maps.FakeMap();
    const props = { mapRef: { current: map as unknown as mapboxgl.Map | null }, ready: true, enabled: true, target };
    const view = renderHook(
        ({ mapRef, ready, enabled, target }) => {
            useObsStartupCamera(mapRef, ready, enabled, target);
            useObsCentreNoticeWatch(enabled);
        },
        { initialProps: props },
    );
    return { ...view, map, props };
}

describe('leaving Obs before it centred (review 2026-10-06)', () => {
    beforeEach(() => follow('boat'));
    const LIVE_ELSEWHERE = { lat: -23.5, lon: 152.9 };

    it('her cloud answers live while Obs is hidden: the next visit centres on it and the message goes', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        let answer!: (fix: BoatFix | null) => void;
        deps.cloudFix.mockImplementationOnce(() => new Promise((done) => (answer = done)));
        const { map, rerender, props } = mountObs();
        await act(async () => {});
        rerender({ ...props, enabled: false });
        await act(async () => answer(cloudFixAt(LIVE_ELSEWHERE, NOW)));
        await settleLookups();
        expect(jumpedTo(map)).toEqual([[VESSEL.lon, VESSEL.lat]]);
        rerender(props);
        await settleLookups();
        expect(jumpedTo(map)).toEqual([
            [VESSEL.lon, VESSEL.lat],
            [LIVE_ELSEWHERE.lon, LIVE_ELSEWHERE.lat],
        ]);
        expect(getObsCentreNotice()).toBeNull();
    });

    it('the message was up and she came live while Obs was hidden: centred on her, not left on the old fix unexplained', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map, rerender, props } = mountObs();
        await settleLookups();
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        rerender({ ...props, enabled: false });
        boatLive(LIVE_ELSEWHERE);
        rerender(props);
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [LIVE_ELSEWHERE.lon, LIVE_ELSEWHERE.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('nothing new: the next visit keeps the stand-in on screen and its message, said once', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map, rerender, props } = mountObs();
        await settleLookups();
        const said = getObsCentreNotice()?.id;
        rerender({ ...props, enabled: false });
        rerender(props);
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledTimes(1); // no re-hold: a layer's zoom frame stays
        expect(getObsCentreNotice()?.id).toBe(said);
    });

    it('a dismissed message is not said again on the next visit', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { rerender, props } = mountObs();
        await settleLookups();
        act(() => clearObsCentreNotice());
        rerender({ ...props, enabled: false });
        rerender(props);
        await settleLookups();
        act(() => vi.advanceTimersByTime(OBS_NOTICE_GRACE_MS));
        expect(getObsCentreNotice()).toBeNull();
    });

    it('no position ever, left before the lookup answered: the next visit still says so', async () => {
        let answer!: (fix: BoatFix | null) => void;
        deps.cloudFix.mockImplementationOnce(() => new Promise((done) => (answer = done)));
        const { map, rerender, props } = mountObs();
        await act(async () => {});
        rerender({ ...props, enabled: false });
        await act(async () => answer(null));
        await settleLookups();
        rerender(props);
        await settleLookups();
        expect(jumpedTo(map)).toEqual([BROAD]);
        expect(noticeText()).toBe('No position from Serene Summer yet');
    });
});

describe('the message does not wait on a slow network', () => {
    it('the boat: her last known fix is explained after a short grace, and her live answer still centres', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        let answer!: (fix: BoatFix | null) => void;
        deps.cloudFix.mockImplementationOnce(() => new Promise((done) => (answer = done)));
        const { map } = mountObs();
        await act(async () => {});
        expect(getObsCentreNotice()).toBeNull();
        act(() => vi.advanceTimersByTime(OBS_NOTICE_GRACE_MS - 1));
        expect(getObsCentreNotice()).toBeNull();
        act(() => vi.advanceTimersByTime(1));
        await settleLookups();
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        const moored = { lat: -23.91, lon: 152.41 };
        await act(async () => answer(cloudFixAt(moored, Date.now())));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [moored.lon, moored.lat], zoom: 14 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('the phone: no fix ever, said after the grace while the phone is still asked', async () => {
        deps.permission.mockResolvedValue('denied');
        deferGps();
        mountObs();
        act(() => vi.advanceTimersByTime(OBS_NOTICE_GRACE_MS));
        await settleLookups();
        expect(noticeText()).toBe('Phone GPS unavailable: allow location to centre here');
    });
});

// Fictional coordinates for a chosen place far from the boat ("if i put
// hawaii in the glass page, when i go to the obs page, it should show me that
// location from the get go", Shane 2026-10-06).
const HAWAII = { lat: 21.3, lon: -157.85 };
const SUVA = { lat: -18.14, lon: 178.44 };
const hawaii = (): ObsStartTarget => obsStartTarget({ defaultLocation: 'Hawaii', defaultLocationCoords: HAWAII });
const suva = (): ObsStartTarget => obsStartTarget({ defaultLocation: 'Suva', defaultLocationCoords: SUVA });

describe('reading the location box', () => {
    it.each([undefined, null, '', 'Current Location'])('follows a receiver for %j', (defaultLocation) => {
        expect(obsStartTarget({ defaultLocation, weatherCoords: WEATHER })).toEqual(OBS_START_FOLLOW);
    });

    it('takes a chosen place from its saved coordinates, keyed on the choice', () => {
        const target = obsStartTarget({
            defaultLocation: 'Hawaii',
            defaultLocationCoords: HAWAII,
            weatherCoords: { lat: 21.31, lon: -157.86 },
        });
        expect(target).toEqual({ kind: 'place', key: 'place:Hawaii@21.3000,-157.8500', center: HAWAII });
    });

    it('fills a name-only choice from the report, and the key survives the report refining', () => {
        const first = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: { lat: 0, lon: 0 } });
        expect(first).toEqual({ kind: 'place', key: 'place:Hawaii', center: null });
        const resolved = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII });
        expect(resolved).toEqual({ kind: 'place', key: 'place:Hawaii', center: HAWAII });
    });
});

describe('a chosen place: unchanged (905c5de8)', () => {
    it('opens it at z10 at once, with no boat hop and no position lookup', () => {
        follow('boat');
        boatLive(); // the boat is live and somewhere else entirely
        phoneLive();
        const { map } = mountBox(hawaii(), false);
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        expect(deps.gps).not.toHaveBeenCalled();
        expect(deps.busFix).not.toHaveBeenCalled();
        expect(deps.nmeaListeners.size).toBe(0);
        expect(deps.locationListeners.size).toBe(0);
        expect(getObsCentreNotice()).toBeNull();
    });

    it('a new place clears an old position message', async () => {
        const { map, rerender, props } = mountBox();
        await settleLookups();
        expect(getObsCentreNotice()).not.toBeNull();
        rerender({ ...props, enabled: false });
        rerender({ ...props, enabled: true, target: hawaii() });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        expect(getObsCentreNotice()).toBeNull();
    });

    it('waits for a name-only place to resolve rather than hopping via the boat', () => {
        boatLive();
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null });
        const { map, rerender, props } = mountBox(pending);
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, target: obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII }) });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it('lets a gesture win while a name-only place resolves', () => {
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null });
        const { map, rerender, props } = mountBox(pending);
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        rerender({ ...props, target: obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII }) });
        expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it('opens a name-only place on the next visit when it resolves while Obs is hidden', () => {
        const pending = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: { lat: 0, lon: 0 } });
        const { map, rerender, props } = mountBox(pending);
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, enabled: false });
        const resolved = obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: HAWAII });
        rerender({ ...props, enabled: false, target: resolved });
        expect(map.jumpTo).not.toHaveBeenCalled();
        rerender({ ...props, enabled: true, target: resolved });
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });
});

describe('a box chosen again after another is a new centring', () => {
    it('the boat (settled on her last known fix), then a place, then the boat again: back on her, said again', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map, rerender, props } = mountObs();
        await settleLookups();
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        rerender({ ...props, enabled: false });
        rerender({ ...props, enabled: true, target: hawaii() });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        expect(getObsCentreNotice()).toBeNull();
        rerender({ ...props, enabled: false, target: hawaii() });
        rerender({ ...props, enabled: true, target: OBS_START_FOLLOW });
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
    });
});

describe('revisits recentre only when the box changed', () => {
    it.each([
        ['a chosen place', hawaii],
        ['the boat', () => OBS_START_FOLLOW],
    ] as const)('keeps the skipper’s view on a revisit when the box has not changed (%s)', (_label, target) => {
        follow('boat');
        boatLive();
        const { map, rerender, props } = mountBox(target());
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, enabled: false });
        rerender({ ...props, target: target(), enabled: true });
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
    });

    it('recentres on the next visit after the box changes, place to place and place to the boat', () => {
        follow('boat');
        boatLive();
        const { map, rerender, props } = mountBox(hawaii());
        rerender({ ...props, enabled: false });
        rerender({ ...props, enabled: false, target: suva() });
        expect(map.jumpTo).toHaveBeenCalledTimes(1); // nothing while Obs is hidden
        rerender({ ...props, enabled: true, target: suva() });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [SUVA.lon, SUVA.lat], zoom: 10 });
        rerender({ ...props, enabled: false, target: suva() });
        rerender({ ...props, enabled: false, target: OBS_START_FOLLOW });
        rerender({ ...props, enabled: true, target: OBS_START_FOLLOW });
        expect(map.jumpTo).toHaveBeenCalledTimes(3);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('a new follow target is a new box: phone, then the boat', async () => {
        boatLive();
        phoneLive();
        const { map, rerender, props } = mountBox();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        rerender({ ...props, enabled: false });
        follow('boat');
        rerender({ ...props, enabled: true });
        expect(map.jumpTo).toHaveBeenCalledTimes(2);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('waits for the next visit when the box changes while Obs is on screen', () => {
        const { map, rerender, props } = mountBox(hawaii());
        rerender({ ...props, target: suva() });
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, target: suva(), enabled: false });
        rerender({ ...props, target: suva(), enabled: true });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [SUVA.lon, SUVA.lat], zoom: 10 });
    });

    it('a new follow target while Obs shows a settled camera waits for the next visit', () => {
        boatLive();
        phoneLive();
        const { map, rerender, props } = mountBox();
        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith({ center: [BUS.lon, BUS.lat], zoom: 14 });
        act(() => follow('boat'));
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
        rerender({ ...props, enabled: false });
        rerender({ ...props, enabled: true });
        expect(map.jumpTo).toHaveBeenCalledTimes(2);
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    // Boot order, Switch boat, or the box picked from a Glass pinned beside
    // Obs: the follow target moves while the camera is still waiting.
    it('a new follow target before the camera settles centres on the new one; the old one’s late fix never lands', async () => {
        boatLive();
        const resolve = deferGps();
        const { map } = mountBox();
        expect(jumpedTo(map)).toEqual([BROAD]); // the phone has nothing yet
        act(() => follow('boat'));
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        await act(async () => resolve(phoneFix()));
        phoneLive();
        act(() => deps.locationListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 7));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(jumpedTo(map)).not.toContainEqual([BUS.lon, BUS.lat]);
        expect(getObsCentreNotice()).toBeNull();
    });

    it('a new follow target takes the old receiver’s message with it, and says its own', async () => {
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map } = mountBox();
        await settleLookups();
        expect(noticeText()).toBe('Phone GPS unavailable: allow location to centre here');
        act(() => follow('boat'));
        expect(getObsCentreNotice()).toBeNull();
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
    });

    it('a place picked while the follow message shows takes the camera and the message goes', async () => {
        const { map, rerender, props } = mountBox();
        await settleLookups();
        expect(getObsCentreNotice()?.state).toBe('none');
        rerender({ ...props, target: hawaii() });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        expect(getObsCentreNotice()).toBeNull();
        phoneLive();
        act(() => deps.locationListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 7));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it('follows the box when it moves before the camera has settled', async () => {
        // Boot order: the phone is still being asked when the saved place
        // arrives. The place wins, and the late fix cannot undo it.
        const resolve = deferGps();
        const { map, rerender, props } = mountBox();
        rerender({ ...props, target: hawaii() });
        expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
        const calls = map.jumpTo.mock.calls.length;
        await act(async () => resolve(phoneFix()));
        await settleLookups();
        expect(map.jumpTo).toHaveBeenCalledTimes(calls);
        expect(getObsCentreNotice()).toBeNull();
    });
});

describe('the message clears once a live fix arrives, wherever the camera is', () => {
    it('for the boat, while Obs shows', () => {
        follow('boat');
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW - HOUR });
        const view = renderHook(({ on }) => useObsCentreNoticeWatch(on), { initialProps: { on: true } });
        boatLive();
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        expect(getObsCentreNotice()).toBeNull();
        view.unmount();
    });

    it('for the phone, from LocationStore or the 5 s re-check', () => {
        showObsCentreNotice({ subject: { kind: 'phone' }, state: 'none', at: null });
        const view = renderHook(() => useObsCentreNoticeWatch(true));
        deps.lastKnown = phoneFix({ timestamp: NOW + 2_000 });
        vi.setSystemTime(NOW + 3_000);
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS));
        expect(getObsCentreNotice()).toBeNull();
        view.unmount();
    });

    it('only for the receiver it is about, and not while Obs is hidden', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        const view = renderHook(({ on }) => useObsCentreNoticeWatch(on), { initialProps: { on: false } });
        boatLive();
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 2));
        expect(getObsCentreNotice()).not.toBeNull();
        // A live phone says nothing about the boat.
        deps.busFix.mockImplementation(() => null);
        phoneLive();
        view.rerender({ on: true });
        act(() => deps.locationListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS));
        expect(getObsCentreNotice()).not.toBeNull();
        view.unmount();
    });
});

describe('find-boat (locateVessel) flies to the BOAT at z14, never the phone', () => {
    function locate(map: InstanceType<typeof maps.FakeMap>, owner = findBoatOwner(true)) {
        return locateVessel(map as unknown as mapboxgl.Map, owner, NAMES, OBS_VESSEL_ZOOM);
    }
    const flewTo = (map: InstanceType<typeof maps.FakeMap>) =>
        map.flyTo.mock.calls.map(([options]) => options as { center: number[]; zoom: number });

    it.each([
        ['the boat', () => follow('boat')],
        ['Current Location (the phone on the bus)', () => follow('phone')],
        ['a chosen place', () => follow('phone')],
    ] as const)('box = %s: the live boat, never the phone', async (_label, setUp) => {
        setUp();
        boatLive();
        phoneLive();
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(flewTo(map)).toEqual([{ center: [VESSEL.lon, VESSEL.lat], zoom: 14, duration: 1200 }]);
        expect(outcome).toEqual({ centred: true, announcement: 'Chart centred on Serene Summer.' });
        expect(deps.gps).not.toHaveBeenCalled();
        expect(deps.foregroundGps).not.toHaveBeenCalled();
    });

    it('box = the boat crewed on: her, by her skipper’s row', async () => {
        follow('crew');
        boatLive(VESSEL); // the own boat's socket: not hers
        deps.cloudFix.mockImplementation(async (_now, owner) => (owner === SKIPPER ? cloudFixAt(WIND_DANCER) : null));
        const map = new maps.FakeMap();
        const outcome = await locate(map, findBoatOwner(true));
        expect(flewTo(map)).toEqual([{ center: [WIND_DANCER.lon, WIND_DANCER.lat], zoom: 14, duration: 1200 }]);
        expect(outcome?.announcement).toBe('Chart centred on Wind Dancer.');
    });

    it('her last known fix: flies there with the message', async () => {
        follow('phone');
        phoneLive();
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(flewTo(map)).toEqual([{ center: [VESSEL.lon, VESSEL.lat], zoom: 14, duration: 1200 }]);
        expect(outcome).toEqual({ centred: true, announcement: '' });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
    });

    it('no boat position ever: the chart stays, the message says so, and the phone is not a stand-in', async () => {
        follow('phone');
        phoneLive();
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(outcome).toEqual({ centred: false, announcement: '' });
        expect(noticeText()).toBe('No position from Serene Summer yet');
    });

    it('no boat position, while the phone’s message stands: that message stays and the button says it', async () => {
        follow('phone');
        rememberPhoneFix(phoneFix({ timestamp: NOW - 2 * HOUR }), NOW - 2 * HOUR);
        showObsCentreNotice({ subject: { kind: 'phone' }, state: 'held', at: NOW - 2 * HOUR });
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(noticeText()).toBe('Phone GPS unavailable · showing where you were 2 h ago');
        expect(outcome).toEqual({
            centred: false,
            announcement: 'No position from Serene Summer yet. The chart has not moved.',
            noFix: true,
        });
    });

    it('a tap that finds only what the message already says speaks those words itself', async () => {
        follow('boat');
        const map = new maps.FakeMap();
        expect(await locate(map)).toEqual({ centred: false, announcement: '' });
        expect(await locate(map)).toEqual({
            centred: false,
            announcement: 'No position from Serene Summer yet',
            noFix: true,
        });
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        expect(await locate(map)).toEqual({ centred: true, announcement: '' });
        expect(await locate(map)).toEqual({
            centred: true,
            announcement: "Showing Serene Summer's last known position · 3 h ago",
        });
    });

    it('her network lookup is capped: past the deadline, her last known fix, before the button gives up', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        deps.cloudFix.mockImplementation(() => new Promise(() => {}));
        const map = new maps.FakeMap();
        let outcome: unknown;
        void locate(map).then((answer) => (outcome = answer));
        await act(async () => {}); // the tap has returned; the lookup is under way
        await act(async () => vi.advanceTimersByTime(LOCATE_LOOKUP_DEADLINE_MS - 1));
        expect(map.flyTo).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(1));
        await settleLookups();
        expect(flewTo(map)).toEqual([{ center: [VESSEL.lon, VESSEL.lat], zoom: 14, duration: 1200 }]);
        expect(outcome).toEqual({ centred: true, announcement: '' });
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 3 h ago");
        expect(LOCATE_LOOKUP_DEADLINE_MS).toBeLessThan(11_000); // MapActionFabs' no-fix line
    });

    it('her last known fix, then she comes live with the chart untouched: one flight to her, and the message goes', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const map = new maps.FakeMap();
        const watch = renderHook(() => useObsCentreNoticeWatch(true));
        await act(async () => {
            await locate(map);
        });
        expect(getObsCentreNotice()?.state).toBe('held');
        const underway = { lat: -23.8, lon: 152.5 };
        boatLive(underway);
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        expect(flewTo(map).map((flight) => flight.center)).toEqual([
            [VESSEL.lon, VESSEL.lat],
            [underway.lon, underway.lat],
        ]);
        expect(getObsCentreNotice()).toBeNull();
        watch.unmount();
    });

    it('her last known fix, then a pan, then she comes live: the message goes, the chart stays', async () => {
        follow('boat');
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const map = new maps.FakeMap();
        const watch = renderHook(() => useObsCentreNoticeWatch(true));
        await act(async () => {
            await locate(map);
        });
        act(() => map.emit('dragstart', { originalEvent: new Event('pointermove') }));
        boatLive({ lat: -23.8, lon: 152.5 });
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        expect(map.flyTo).toHaveBeenCalledTimes(1);
        expect(getObsCentreNotice()).toBeNull();
        watch.unmount();
    });

    it('a live boat clears an older message', async () => {
        showObsCentreNotice({ subject: { kind: 'phone' }, state: 'none', at: null });
        boatLive();
        await locate(new maps.FakeMap());
        expect(getObsCentreNotice()).toBeNull();
    });

    it('a newer tap supersedes a slower one', async () => {
        let answer!: (fix: BoatFix | null) => void;
        deps.cloudFix.mockImplementationOnce(() => new Promise((done) => (answer = done)));
        const map = new maps.FakeMap();
        const first = locate(map);
        await act(async () => {});
        boatLive();
        const second = await locate(map);
        answer(cloudFixAt(WIND_DANCER));
        expect(await first).toBeNull();
        expect(second?.centred).toBe(true);
        expect(map.flyTo).toHaveBeenCalledTimes(1);
    });

    it('looks for the boat crewed on when the account has no boat of its own', () => {
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1'),
            JSON.stringify({
                version: 1,
                userId: 'owner-ss',
                confirmedAt: '2026-10-05T00:00:00.000Z',
                skippers: [],
                vessels: [
                    { ownerId: SKIPPER, vesselName: 'Wind Dancer', role: 'deckhand', lastAcceptedAt: '2026-10-01' },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
        follow('phone');
        expect(findBoatOwner(false)).toBe(SKIPPER);
        // A skipper with a boat of her own finds hers, even while crewing elsewhere.
        expect(findBoatOwner(true)).toBeNull();
        follow('boat');
        expect(findBoatOwner(false)).toBeNull();
    });
});

describe('the locate button follows the location box', () => {
    const subject = (boxFollows: boolean, ownBoatNamed = true) => obsLocateSubject(boxFollows, ownBoatNamed);
    function crewOnWindDancer() {
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1'),
            JSON.stringify({
                version: 1,
                userId: 'owner-ss',
                confirmedAt: '2026-10-05T00:00:00.000Z',
                skippers: [],
                vessels: [
                    { ownerId: SKIPPER, vesselName: 'Wind Dancer', role: 'deckhand', lastAcceptedAt: '2026-10-01' },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    }

    it('the boat’s row: the boat; the boat crewed on: her; Current Location: the phone', () => {
        follow('boat');
        expect(subject(true)).toEqual({ kind: 'boat', crewOwnerId: null });
        expect(subject(true, false)).toEqual({ kind: 'boat', crewOwnerId: null });
        follow('crew');
        expect(subject(true)).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
        follow('phone');
        expect(subject(true)).toEqual({ kind: 'phone' });
        expect(subject(true, false)).toEqual({ kind: 'phone' });
    });

    it('a chosen place: the boat when the account has one, else the phone', () => {
        follow('phone');
        expect(subject(false, true)).toEqual({ kind: 'boat', crewOwnerId: null });
        expect(subject(false, false)).toEqual({ kind: 'phone' });
        // No name, but a position of her own: she exists.
        rememberBoatFix(busFixAt(VESSEL, NOW - HOUR), NOW - HOUR);
        expect(subject(false, false)).toEqual({ kind: 'boat', crewOwnerId: null });
        localStorage.clear();
        __resetWeatherPositionForTests();
        follow('phone');
        crewOnWindDancer();
        expect(subject(false, false)).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
        follow('boat');
        expect(subject(false, false)).toEqual({ kind: 'boat', crewOwnerId: null });
    });

    it('is wired so in MapHub: the box decides, never the place or the weather point', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(OBS_VESSEL_ZOOM).toBe(14);
        expect(hub).toContain('const LOCATE_BOAT_ZOOM = OBS_VESSEL_ZOOM;');
        const handler = hub.slice(hub.indexOf('onLocateMe={() => {'), hub.indexOf('onRecenter={() => {'));
        expect(handler).toContain('locateOnObs(');
        expect(handler).toContain("obsLocateSubject(obsStart.kind === 'follow', Boolean(ownBoatName))");
        expect(handler).toContain('LOCATE_BOAT_ZOOM');
        for (const absent of ['GpsService', 'LocationStore', 'resolveOwnshipPosition', 'weatherCoords'])
            expect(handler).not.toContain(absent);
    });
});

describe('Locate me on the phone (locatePhone), never the boat', () => {
    const locate = (map: InstanceType<typeof maps.FakeMap>) =>
        locatePhone(map as unknown as mapboxgl.Map, OBS_VESSEL_ZOOM);
    const flewTo = (map: InstanceType<typeof maps.FakeMap>) =>
        map.flyTo.mock.calls.map(([options]) => (options as { center: number[] }).center);

    it('its live fix, asking nothing, wherever the boat is', async () => {
        boatLive();
        phoneLive();
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(flewTo(map)).toEqual([[BUS.lon, BUS.lat]]);
        expect(outcome).toEqual({ centred: true, announcement: 'Chart centred on your position.' });
        expect(deps.foregroundGps).not.toHaveBeenCalled();
    });

    it('no fix held: asks on the tap (foreground), flies there and keeps it', async () => {
        boatLive();
        deps.foregroundGps.mockResolvedValue(phoneFix({ timestamp: NOW - 2_000 }));
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(deps.foregroundGps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
        expect(deps.backgroundGps).not.toHaveBeenCalled();
        expect(flewTo(map)).toEqual([[BUS.lon, BUS.lat]]);
        expect(outcome?.centred).toBe(true);
        expect(localStorage.getItem(authScopedStorageKey('thalassa_last_phone_fix'))).toContain('-27.5');
    });

    it('no answer: its last known fix with the message, never the live boat', async () => {
        boatLive();
        deps.foregroundGps.mockResolvedValue(null);
        rememberPhoneFix(phoneFix({ timestamp: NOW - 2 * HOUR }), NOW - 2 * HOUR);
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(flewTo(map)).toEqual([[BUS.lon, BUS.lat]]);
        expect(outcome).toEqual({ centred: true, announcement: '' });
        expect(noticeText()).toBe('Phone GPS unavailable · showing where you were 2 h ago');
    });

    it('none ever: the chart stays and the message says why', async () => {
        boatLive();
        deps.foregroundGps.mockResolvedValue(null);
        deps.permission.mockResolvedValue('denied');
        const map = new maps.FakeMap();
        const outcome = await locate(map);
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(outcome).toEqual({ centred: false, announcement: '' });
        expect(noticeText()).toBe('Phone GPS unavailable: allow location to centre here');
    });

    it('none ever, while the boat’s message stands: that message stays and the button says it', async () => {
        deps.foregroundGps.mockResolvedValue(null);
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW - HOUR });
        const outcome = await locate(new maps.FakeMap());
        expect(noticeText()).toBe("Showing Serene Summer's last known position · 1 h ago");
        expect(outcome).toEqual({
            centred: false,
            announcement: 'Phone GPS unavailable. The chart has not moved.',
            noFix: true,
        });
    });

    it('its flight takes the startup camera: a late boat fix cannot move it', async () => {
        follow('boat');
        const { map } = mountBox();
        await settleLookups(); // no boat position: broad, waiting
        phoneLive();
        await act(async () => {
            await locate(map);
        });
        const calls = map.jumpTo.mock.calls.length;
        boatLive();
        act(() => deps.nmeaListeners.forEach((listener) => listener()));
        act(() => vi.advanceTimersByTime(OBS_LIVE_CHECK_MS * 2));
        expect(map.jumpTo).toHaveBeenCalledTimes(calls);
    });
});

describe('Mapbox initial camera policy', () => {
    function mountMap(ownshipStartup: boolean, embedded = false, obsStart?: ObsStartTarget) {
        const container = document.createElement('div');
        Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 800 } });
        return renderHook(
            ({ initialCenter }) =>
                useMapInit({
                    containerRef: { current: container },
                    mapRef,
                    pinMarkerRef: { current: null },
                    locationDotRef: { current: null },
                    mapboxToken: 'test-token',
                    mapStyle: 'mapbox://styles/mapbox/dark-v11',
                    initialZoom: 5,
                    minimalLabels: false,
                    embedded,
                    ownshipStartup,
                    obsStart,
                    location: deps.location,
                    initialCenter,
                    encVisible: false,
                    settingPoint: null,
                    showPassage: false,
                    departure: null,
                    arrival: null,
                    setMapReady: vi.fn(),
                    setActiveLayer: vi.fn(),
                    setDeparture: vi.fn(),
                    setArrival: vi.fn(),
                    setSettingPoint: vi.fn(),
                }),
            { initialProps: { initialCenter: WEATHER } },
        );
    }
    let mapRef: { current: mapboxgl.Map | null };
    beforeEach(() => {
        mapRef = { current: null };
    });

    it('builds OBS on the boat’s live fix when the box follows her, and never rebuilds', () => {
        follow('boat');
        boatLive();
        phoneLive();
        const { rerender } = mountMap(true);
        expect(maps.instances[0].options).toMatchObject({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
        rerender({ initialCenter: { lat: -41, lon: 174 } });
        expect(maps.instances).toHaveLength(1);
        expect(maps.instances[0].remove).not.toHaveBeenCalled();
    });

    it('builds OBS on her held fix rather than the phone', () => {
        follow('boat');
        phoneLive();
        rememberBoatFix(busFixAt(VESSEL, NOW - 3 * HOUR), NOW - 3 * HOUR);
        mountMap(true);
        expect(maps.instances[0].options).toMatchObject({ center: [VESSEL.lon, VESSEL.lat], zoom: 14 });
    });

    it('builds OBS on the phone when the box is Current Location, not the boat', () => {
        boatLive();
        phoneLive();
        mountMap(true);
        expect(maps.instances[0].options).toMatchObject({ center: [BUS.lon, BUS.lat], zoom: 14 });
    });

    it('uses the broad fallback when what the box follows has no position', () => {
        boatLive(); // the boat is no stand-in for the phone
        mountMap(true);
        expect(maps.instances[0].options.center).toEqual(BROAD);
        expect(maps.instances[0].options.zoom).toBeLessThan(5);
    });

    it('builds OBS on a place chosen in the location box at z10, not on the boat', () => {
        follow('boat');
        boatLive();
        mountMap(true, false, hawaii());
        expect(maps.instances[0].options).toMatchObject({ center: [HAWAII.lon, HAWAII.lat], zoom: 10 });
    });

    it('opens broad rather than on the boat while a name-only place resolves', () => {
        follow('boat');
        boatLive();
        mountMap(true, false, obsStartTarget({ defaultLocation: 'Hawaii', weatherCoords: null }));
        expect(maps.instances[0].options.center).toEqual(BROAD);
    });

    it('keeps a Plan/picker map off the Obs place start', () => {
        boatLive();
        mountMap(false, false, hawaii());
        expect(maps.instances[0].options).toMatchObject({ center: [WEATHER.lon, WEATHER.lat], zoom: 10 });
    });

    it('preserves selected-location startup for a Plan/picker map', () => {
        boatLive();
        mountMap(false);
        expect(maps.instances[0].options).toMatchObject({ center: [WEATHER.lon, WEATHER.lat], zoom: 10 });
    });

    it('preserves embedded map centre and zoom', () => {
        boatLive();
        mountMap(false, true);
        expect(maps.instances[0].options).toMatchObject({ center: [153.02, -27.47], zoom: 5 });
    });
});
