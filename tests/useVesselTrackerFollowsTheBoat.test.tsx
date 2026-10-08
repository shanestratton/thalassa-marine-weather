/**
 * The own-ship marker follows the BOAT, from the same chain the Obs camera
 * centres on, so the two can never disagree.
 *
 * Shane 2026-10-07, on build 121, at home while the boat lay in a marina far
 * up the coast with her Pi publishing: "on the vessel location, that there is
 * no longer a dot for where the vessel is. We used to have a dot (but it could
 * be a nice little boat). With either anchored or stopped (depending on
 * whether the anchor watch is on). Also it would have sog."
 *
 * Since 5d455513 the camera centred on the boat's own chain (bus, Pi, her
 * cloud row, her held fix) while the marker still drew the ownship arbiter,
 * which ashore falls back to the phone: the chart opened on the boat and the
 * marker sat on the phone hundreds of kilometres away.
 *
 * The real tracker, the real startup camera, the follow-target store and the
 * boat chain (services/weatherPosition, components/map/obsCentre) run here;
 * only the receivers are faked: the boat's rungs (boatPositionChain), the
 * phone (GpsService), the instrument store, and the anchor watch's three
 * sources. Every name and position is fictional.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type mapboxgl from 'mapbox-gl';
import type { BoatFix } from '../services/boatPositionChain';
import type { GpsPosition } from '../services/GpsService';

const deps = vi.hoisted(() => ({
    nmea: {} as Record<string, unknown>,
    boatFeed: false,
    gatewaySaved: false,
    piBaseUrl: null as string | null,
    phoneCallbacks: [] as Array<(pos: GpsPosition) => void>,
    lastKnown: null as GpsPosition | null,
    gps: vi.fn(async () => null as GpsPosition | null),
    busFix: vi.fn<() => BoatFix | null>(() => null),
    piFix: vi.fn<() => Promise<BoatFix | null>>(async () => null),
    cloudFix: vi.fn<(now?: number, owner?: string) => Promise<BoatFix | null>>(async () => null),
    deviceRungOwner: vi.fn<(rung: 'bus' | 'pi') => string | null>(() => null),
    local: { state: 'idle', gpsSource: null } as Record<string, unknown>,
    shore: { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null } as Record<
        string,
        unknown
    >,
    piSession: null as string | null,
}));

const markers = vi.hoisted(() => {
    class Marker {
        element: HTMLElement;
        lngLat: [number, number] | null = null;
        removed = false;
        constructor(options: { element: HTMLElement }) {
            this.element = options.element;
            all.push(this);
        }
        setLngLat = vi.fn((lngLat: [number, number]) => {
            this.lngLat = [lngLat[0], lngLat[1]];
            return this;
        });
        getLngLat = () => (this.lngLat ? { lng: this.lngLat[0], lat: this.lngLat[1] } : null);
        getElement = () => this.element;
        addTo = vi.fn(() => this);
        remove = vi.fn(() => {
            this.removed = true;
        });
    }
    const all: Marker[] = [];
    return { Marker, all };
});

vi.mock('mapbox-gl', () => ({ default: { Marker: markers.Marker }, Marker: markers.Marker }));
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
        isBoatFeed: () => deps.boatFeed,
        start: vi.fn(),
        subscribe: () => () => {},
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { onPosition: () => () => {}, getPosition: () => null, start: vi.fn() },
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getSavedConfig: () => (deps.gatewaySaved ? { host: 'gateway.test' } : null) },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => deps.piBaseUrl,
        getStatus: () => ({ reachable: false, diaryRelayConfigured: false, diaryRelayOwnerId: null }),
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => ({ lat: 0, lon: 0, source: 'initial', timestamp: 0 }),
        subscribe: () => () => {},
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: (callback: (pos: GpsPosition) => void) => {
            deps.phoneCallbacks.push(callback);
            return () => {
                const at = deps.phoneCallbacks.indexOf(callback);
                if (at >= 0) deps.phoneCallbacks.splice(at, 1);
            };
        },
        getLastKnownPosition: () => deps.lastKnown,
        getCurrentPositionIfGranted: deps.gps,
        requestCurrentForegroundPosition: deps.gps,
        getCurrentPosition: deps.gps,
        locationPermission: async () => 'denied',
    },
}));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLastPosition: () => null } }));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { getSnapshot: () => deps.local, subscribe: () => () => {} },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: { getState: () => ({ role: 'idle', sessionCode: null }), onStateChange: () => () => {} },
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: { getSnapshot: () => deps.shore, subscribe: () => () => {} },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { keepingSessionCode: () => deps.piSession },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { __resetWeatherPositionForTests, rememberBoatFix, setWeatherFollowTarget } from '../services/weatherPosition';
import { __resetPhoneLastFixForTests } from '../services/phoneLastFix';
import { OBS_START_FOLLOW, useObsStartupCamera, type ObsStartTarget } from '../components/map/useObsStartupCamera';
import {
    __resetObsCentreForTests,
    locateOnObs,
    obsLocateSubject,
    type ObsBoatNames,
} from '../components/map/obsCentre';
import { useVesselTracker } from '../components/map/useVesselTracker';
import { phoneDotWanted, useLocationDot } from '../components/map/useLocationDot';
import { setBoatWindReadout, type BoatWindReadout } from '../components/map/boatWindReadout';
import {
    __resetOwnshipBoatFixForTests,
    ownshipMarkerSubject,
    vesselMarkerFixNow,
} from '../components/map/ownshipBoatFix';

const NOW = Date.parse('2026-10-07T02:00:00.000Z');
const HOUR = 3_600_000;
/** The boat, in a marina a long way up the coast (fictional). */
const BOAT = { lat: -20.27, lon: 148.72 };
/** The skipper's phone, at home (fictional). */
const HOME = { lat: -27.2, lon: 153.1 };
/** A boat this account crews on, elsewhere again. */
const CREWED = { lat: -19.1, lon: 147.6 };
const SKIPPER = 'skipper-wd';
const NAMES: ObsBoatNames = { own: 'Kittiwake', crew: { ownerId: SKIPPER, name: 'Wind Dancer' } };

/** Her Pi's cloud row. A healthy Pi dates its position (position_at) whenever the fix is under 10 min old. */
const cloudFixAt = (
    at: { lat: number; lon: number },
    timestamp = NOW - 5_000,
    extra: Partial<BoatFix> = {},
): BoatFix => ({
    latitude: at.lat,
    longitude: at.lon,
    timestamp,
    rung: 'cloud',
    source: 'pi-cloud',
    sogKts: 0,
    cogDeg: null,
    positionAt: timestamp,
    ...extra,
});

/** The Pi's own /api/gps answer: a position and its time, no speed or course. */
const piFixAt = (at: { lat: number; lon: number }, timestamp = NOW - 2_000): BoatFix => ({
    latitude: at.lat,
    longitude: at.lon,
    timestamp,
    rung: 'pi',
    source: 'ydwg-tcp.YD',
});

function phoneAt(at: { lat: number; lon: number }, timestamp = NOW): GpsPosition {
    return {
        latitude: at.lat,
        longitude: at.lon,
        accuracy: 5,
        altitude: null,
        heading: null,
        speed: 0,
        timestamp,
    };
}

/** The phone has a fix where the skipper is, and its watch delivers it. */
function phoneLive(at = HOME) {
    deps.lastKnown = phoneAt(at);
    deps.gps.mockResolvedValue(phoneAt(at));
}

function emitPhone(at = HOME) {
    act(() => {
        for (const callback of [...deps.phoneCallbacks]) callback(phoneAt(at, Date.now()));
    });
}

/** The boat's Pi row in the cloud, as her own (owner 'self') or her skipper's. */
function cloudRow(fix: BoatFix | null, owner: 'self' | string = 'self') {
    deps.cloudFix.mockImplementation(async (_now, asked) => (asked === owner ? fix : null));
}

function follow(target: 'phone' | 'boat' | 'crew') {
    if (target === 'crew') setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'phone' });
    else setWeatherFollowTarget(target);
}

function crewOnWindDancer() {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({
            version: 1,
            userId: 'owner-k',
            confirmedAt: '2026-10-05T00:00:00.000Z',
            skippers: [],
            vessels: [{ ownerId: SKIPPER, vesselName: 'Wind Dancer', role: 'deckhand', lastAcceptedAt: '2026-10-01' }],
        }),
    );
    reloadSharedBindersFromStorage();
}

/** Let the lookups (Pi, cloud, the phone) answer. */
async function settle() {
    for (let i = 0; i < 8; i += 1) await act(async () => {});
}

function fakeMap() {
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    return {
        jumpTo: vi.fn(),
        flyTo: vi.fn(),
        on: vi.fn((name: string, listener: (event?: unknown) => void) => {
            const set = listeners.get(name) ?? new Set();
            set.add(listener);
            listeners.set(name, set);
        }),
        off: vi.fn((name: string, listener: (event?: unknown) => void) => {
            listeners.get(name)?.delete(listener);
        }),
        once: vi.fn(),
        getBearing: () => 0,
        getSource: () => undefined,
        getLayer: () => undefined,
        addSource: vi.fn(),
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
    };
}

/** Obs as MapHub mounts it: the startup camera, the own-ship marker, and (when wanted) the phone dot. */
function mountObs(target: ObsStartTarget = OBS_START_FOLLOW, phoneDot = false, windSpeedUnit?: string) {
    const map = fakeMap();
    const mapRef = { current: map as unknown as mapboxgl.Map | null };
    const dotRef = { current: null as mapboxgl.Marker | null };
    const view = renderHook(
        ({ unit }: { unit?: string }) => {
            useObsStartupCamera(mapRef, true, true, target);
            const tracker = useVesselTracker(mapRef, true, true, {
                names: NAMES,
                lookUp: true,
                windSpeedUnit: unit,
            });
            useLocationDot(mapRef, dotRef, true, phoneDot);
            return tracker;
        },
        { initialProps: { unit: windSpeedUnit } },
    );
    return { map, mapRef, dotRef, view };
}

const liveMarkers = () => markers.all.filter((marker) => !marker.removed);
const vesselMarker = () => liveMarkers().find((marker) => marker.element.classList.contains('vessel-tracker-marker'));
const phoneDot = () => liveMarkers().find((marker) => marker.element.classList.contains('loc-dot'));
const badge = () => vesselMarker()?.element.querySelector('.vessel-sog-badge')?.textContent ?? null;
const badgeTone = () =>
    (vesselMarker()?.element.querySelector('.vessel-sog-badge') as HTMLElement | null)?.dataset.tone ?? null;
const greyed = () =>
    ((vesselMarker()?.element.querySelector('.vessel-arrow') as HTMLElement | null)?.style.filter ?? '').includes(
        'grayscale',
    );
/** A vessel marker drawn at the phone: the phone shown as the boat. */
const ownShipAtPhone = () =>
    markers.all.filter(
        (marker) => marker.element.classList.contains('vessel-tracker-marker') && marker.lngLat?.[0] === HOME.lon,
    );
const cameraCentre = (map: ReturnType<typeof fakeMap>) =>
    (map.jumpTo.mock.calls.at(-1)?.[0] as { center: [number, number] } | undefined)?.center ?? null;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('owner-k');
    reloadSharedBindersFromStorage();
    markers.all.length = 0;
    deps.nmea = {};
    deps.boatFeed = false;
    deps.gatewaySaved = false;
    deps.piBaseUrl = null;
    deps.phoneCallbacks.length = 0;
    deps.lastKnown = null;
    deps.gps.mockResolvedValue(null);
    deps.busFix.mockImplementation(() => null);
    deps.piFix.mockImplementation(async () => null);
    deps.cloudFix.mockImplementation(async () => null);
    deps.deviceRungOwner.mockImplementation(() => null);
    deps.local = { state: 'idle', gpsSource: null };
    deps.shore = { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null };
    deps.piSession = null;
    __resetWeatherPositionForTests();
    __resetPhoneLastFixForTests();
    __resetObsCentreForTests();
    __resetOwnshipBoatFixForTests();
    follow('phone');
});

afterEach(async () => {
    cleanup();
    await Promise.resolve();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('box = the boat: the marker is HER, where the camera centres, never the phone', () => {
    beforeEach(() => {
        follow('boat');
        deps.piBaseUrl = 'https://pi.test:3001';
    });

    it("Shane's case: her Pi's cloud row from home puts a 'Stopped' boat on the boat, not on the phone", async () => {
        phoneLive(HOME);
        cloudRow(cloudFixAt(BOAT, NOW - 5_000, { sogKts: 0.1 }));
        const { map } = mountObs();
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));

        expect(cameraCentre(map)).toEqual([BOAT.lon, BOAT.lat]);
        const marker = vesselMarker();
        expect(marker?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(marker?.element.dataset.source).toBe('vessel');
        expect(marker?.element.dataset.lane).toBe('cloud');
        expect(badge()).toBe('Stopped');
        expect(marker?.element.getAttribute('aria-label')).toBe('Kittiwake, stopped; heading unavailable');
        // One marker: the phone never gets the boat's.
        expect(liveMarkers().filter((m) => m.lngLat?.[0] === HOME.lon)).toHaveLength(0);
    });

    it('under way, watched from ashore: her SOG on the badge and her course on the bow', async () => {
        cloudRow(cloudFixAt(BOAT, NOW - 4_000, { sogKts: 6.2, cogDeg: 135 }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('6.2 kts');
        const el = vesselMarker()!.element;
        expect(el.dataset.directionSource).toBe('course');
        expect((el.querySelector('.vessel-arrow') as HTMLElement).style.transform).toBe('rotate(135deg)');
        expect(el.getAttribute('aria-label')).toBe(
            'Kittiwake, 6.2 knots; course over ground 135° true; bow heading unavailable',
        );
    });

    it('a true heading from her row turns the bow even at rest', async () => {
        cloudRow(cloudFixAt(BOAT, NOW - 4_000, { sogKts: 0, headingTrueDeg: 212, headingTrueAt: NOW - 6_000 }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        const el = vesselMarker()!.element;
        expect(badge()).toBe('Stopped');
        expect(el.dataset.directionSource).toBe('heading');
        expect((el.querySelector('.vessel-arrow') as HTMLElement).style.transform).toBe('rotate(212deg)');
    });

    it('dates her row by its position sample: a Pi republishing an old fix is not live', async () => {
        cloudRow(cloudFixAt(BOAT, NOW - 3_000, { sogKts: 0, positionAt: NOW - 7 * 60_000 }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(badge()).toMatch(/^Last fix 7 min$/);
    });

    it("a row with no sample time (the Pi's GPS 10 min old or more) is undated: 'No fix' on a grey boat", async () => {
        // The plotter is off at the marina; the Pi republishes its last lat/lon
        // every 5 s and leaves out position_at, as System status and Radio read it.
        cloudRow(cloudFixAt(BOAT, NOW - 3_000, { sogKts: 0, positionAt: null }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        const marker = vesselMarker();
        expect(marker?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(marker?.element.dataset.lane).toBe('cloud');
        expect(badge()).toBe('No fix');
        expect(greyed()).toBe(true);
        expect(marker?.element.dataset.directionSource).toBe('unknown');
    });

    it('a row that loses its sample time keeps counting from her last dated fix, never renews it', async () => {
        cloudRow(cloudFixAt(BOAT, NOW - 3_000));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Stopped');
        // Her GPS goes quiet; the Pi keeps reporting the same lat/lon, undated.
        deps.cloudFix.mockImplementation(async (_now, owner) =>
            owner === 'self' ? cloudFixAt(BOAT, Date.now() - 2_000, { positionAt: null }) : null,
        );
        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });
        await settle();
        await act(async () => {
            vi.advanceTimersByTime(30_000);
        });
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.element.dataset.lane).toBe('cloud');
        expect(badge()).toBe('Last fix 1 min');
        expect(greyed()).toBe(true);
    });

    it("the Pi lane carries no speed: her fresh cloud row beside the Pi's fix lends her SOG", async () => {
        deps.piFix.mockImplementation(async () => piFixAt(BOAT, Date.now() - 1_000));
        cloudRow(cloudFixAt(BOAT, NOW - 3_000, { sogKts: 6.2, cogDeg: 135 }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.element.dataset.lane).toBe('pi');
        expect(badge()).toBe('6.2 kts');
        expect(vesselMarker()?.element.dataset.directionSource).toBe('course');
    });

    it("a cloud row that puts her somewhere else lends the Pi lane nothing: 'SOG —'", async () => {
        deps.piFix.mockImplementation(async () => piFixAt(BOAT, Date.now() - 1_000));
        // About 220 m from the Pi's fix.
        cloudRow(cloudFixAt({ lat: BOAT.lat + 0.002, lon: BOAT.lon }, NOW - 3_000, { sogKts: 6.2, cogDeg: 135 }));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.element.dataset.lane).toBe('pi');
        expect(badge()).toBe('SOG —');
    });

    it("only her held fix: a grey 'Last fix 3 h' at it, where the camera holds, and no bow", async () => {
        phoneLive(HOME);
        rememberBoatFix(cloudFixAt(BOAT, NOW - 3 * HOUR), NOW - 3 * HOUR);
        const { map } = mountObs();
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));
        expect(cameraCentre(map)).toEqual([BOAT.lon, BOAT.lat]);
        const marker = vesselMarker();
        expect(marker?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(marker?.element.dataset.lane).toBe('held');
        expect(badge()).toBe('Last fix 3 h');
        expect((marker!.element.querySelector('.vessel-arrow') as HTMLElement).style.filter).toContain('grayscale');
        expect(marker?.element.dataset.directionSource).toBe('unknown');
    });

    it('no position from her at all: no marker, never the phone in her place', async () => {
        phoneLive(HOME);
        mountObs();
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()).toBeUndefined();
    });

    it('her cloud row arriving later moves the marker onto her (the marker asks her chain itself)', async () => {
        mountObs();
        await settle();
        expect(vesselMarker()).toBeUndefined();
        cloudRow(cloudFixAt(BOAT, Date.now() - 2_000));
        // Past the chain's 30 s cloud throttle.
        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
    });

    it("aboard on her bus: the boat's instruments, exactly as before", async () => {
        deps.boatFeed = true;
        deps.busFix.mockImplementation(() => ({
            latitude: BOAT.lat,
            longitude: BOAT.lon,
            timestamp: Date.now(),
            rung: 'bus',
            source: 'nmea-gateway',
        }));
        deps.nmea = {
            connectionStatus: 'connected',
            latitude: { value: BOAT.lat, lastUpdated: NOW, freshness: 'live' },
            longitude: { value: BOAT.lon, lastUpdated: NOW, freshness: 'live' },
            sog: { value: 6.2, lastUpdated: NOW, freshness: 'live' },
            cog: { value: 80, lastUpdated: NOW, freshness: 'live' },
        };
        mountObs();
        await settle();
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(vesselMarker()?.element.dataset.lane).toBe('bus');
        expect(badge()).toBe('6.2 kts');
    });

    it("aboard on her bus with no fresh SOG: 'SOG —', never an invented 'Stopped'", async () => {
        deps.boatFeed = true;
        deps.busFix.mockImplementation(() => ({
            latitude: BOAT.lat,
            longitude: BOAT.lon,
            timestamp: Date.now(),
            rung: 'bus',
            source: 'nmea-gateway',
        }));
        deps.nmea = {
            connectionStatus: 'connected',
            latitude: { value: BOAT.lat, lastUpdated: NOW, freshness: 'live' },
            longitude: { value: BOAT.lon, lastUpdated: NOW, freshness: 'live' },
            // A talker sending GLL without VTG/RMC: the last SOG is a minute old.
            sog: { value: 6.2, lastUpdated: NOW - 60_000, freshness: 'stale' },
        };
        mountObs();
        await settle();
        expect(vesselMarker()?.element.dataset.lane).toBe('bus');
        expect(badge()).toBe('SOG —');
    });
});

describe('the badge reads the one anchor-watch truth, for this boat only', () => {
    beforeEach(() => {
        follow('boat');
        deps.piBaseUrl = 'https://pi.test:3001';
        cloudRow(cloudFixAt(BOAT, NOW - 5_000));
    });

    const broadcast = (overrides: Record<string, unknown> = {}) => ({
        type: 'position',
        vessel: { latitude: BOAT.lat, longitude: BOAT.lon, accuracy: 5, heading: 0, timestamp: NOW - 2_000 },
        anchor: { latitude: BOAT.lat + 0.0002, longitude: BOAT.lon, timestamp: NOW - HOUR },
        distance: 22,
        swingRadius: 40,
        isAlarm: false,
        timestamp: NOW - 2_000,
        ...overrides,
    });

    it("the Pi keeping the watch, this phone joined as Shore Watch: 'Anchored'", async () => {
        deps.piSession = 'PI-WATCH';
        deps.shore = {
            sessionCode: 'PI-WATCH',
            position: broadcast(),
            stale: false,
            cause: null,
            lastContactAt: NOW - 2_000,
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Anchored');
        expect(badgeTone()).toBe('anchored');
    });

    it("the Pi keeping the watch with no updates on this phone yet: 'Anchored', in the row's amber", async () => {
        deps.piSession = 'PI-WATCH';
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Anchored');
        expect(badgeTone()).toBe('caution');
        expect(vesselMarker()?.element.getAttribute('aria-label')).toContain('no anchor watch updates on this phone');
    });

    it("the Pi's watch has lost its data: 'Anchored' in the row's red, never the calm green", async () => {
        deps.piSession = 'PI-WATCH';
        deps.shore = {
            sessionCode: 'PI-WATCH',
            position: broadcast(),
            stale: false,
            cause: 'contact-lost',
            lastContactAt: NOW - 2_000,
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Anchored');
        expect(badgeTone()).toBe('alarm');
        const classes = vesselMarker()!.element.querySelector('.vessel-sog-badge')!.classList;
        expect(classes.contains('text-red-400')).toBe(true);
        expect(classes.contains('text-emerald-400')).toBe(false);
        expect(vesselMarker()?.element.getAttribute('aria-label')).toContain('anchor watch has no current data');
    });

    it("the Pi's watch authorisation expiring: 'Anchored' in the row's amber", async () => {
        deps.piSession = 'PI-WATCH';
        deps.shore = {
            sessionCode: 'PI-WATCH',
            position: broadcast(),
            stale: false,
            cause: 'session-expiring',
            lastContactAt: NOW - 2_000,
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Anchored');
        expect(badgeTone()).toBe('caution');
    });

    it("the Pi reporting a drag: 'Anchor alarm', never a calm label", async () => {
        deps.piSession = 'PI-WATCH';
        deps.shore = {
            sessionCode: 'PI-WATCH',
            position: broadcast({ isAlarm: true, distance: 70 }),
            stale: false,
            cause: 'drag',
            lastContactAt: NOW - 2_000,
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Anchor alarm');
    });

    it("the phone keeping the watch aboard on her bus: 'Anchored'", async () => {
        deps.boatFeed = true;
        deps.busFix.mockImplementation(() => ({
            latitude: BOAT.lat,
            longitude: BOAT.lon,
            timestamp: Date.now(),
            rung: 'bus',
            source: 'nmea-gateway',
        }));
        deps.nmea = {
            connectionStatus: 'connected',
            latitude: { value: BOAT.lat, lastUpdated: NOW, freshness: 'live' },
            longitude: { value: BOAT.lon, lastUpdated: NOW, freshness: 'live' },
            sog: { value: 0, lastUpdated: NOW, freshness: 'live' },
        };
        deps.local = {
            state: 'watching',
            gpsSource: 'nmea',
            distanceFromAnchor: 12,
            swingRadius: 40,
            alarmTriggeredAt: null,
            alarmCause: null,
            vesselPosition: { latitude: BOAT.lat, longitude: BOAT.lon, timestamp: NOW },
        };
        mountObs();
        await settle();
        expect(badge()).toBe('Anchored');
    });

    it("a watch this phone runs on its own GPS at home is not hers: the boat stays 'Stopped'", async () => {
        deps.local = {
            state: 'watching',
            gpsSource: 'native',
            distanceFromAnchor: 3,
            swingRadius: 40,
            alarmTriggeredAt: null,
            alarmCause: null,
            vesselPosition: { latitude: HOME.lat, longitude: HOME.lon, timestamp: NOW },
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Stopped');
    });

    it("another device's watch on a boat 50 m away or more is not hers", async () => {
        deps.shore = {
            sessionCode: 'OTHER',
            position: broadcast({ vessel: { latitude: BOAT.lat + 0.01, longitude: BOAT.lon, timestamp: NOW } }),
            stale: false,
            cause: null,
            lastContactAt: NOW - 2_000,
        };
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(badge()).toBe('Stopped');
    });
});

/**
 * Build 123, W1-WC (Shane 2026-10-07: "as soon as the punter zooms out from
 * there, then the wind models kick in"): wherever Obs's wind field is not
 * showing her wind, her own reading rides on her own marker. The overlay
 * publishes it (boatWindReadout); the marker shows it only on the boat it is
 * for, and never while the field already shows it. Fictional values.
 */
describe('her own wind on her own marker', () => {
    const HERS: BoatWindReadout = {
        wind: { kt: 14, fromDeg: 200, stale: false },
        boat: { crewOwnerId: null },
        fieldShowsHers: false,
    };
    const windChip = () => vesselMarker()?.element.querySelector<HTMLElement>('.vessel-wind-chip') ?? null;
    /** What her wind chip says, or null while it is hidden. */
    const windText = () => {
        const chip = windChip();
        return !chip || chip.style.display === 'none'
            ? null
            : (chip.querySelector('.vessel-wind-text')?.textContent ?? null);
    };
    const name = () => vesselMarker()?.element.getAttribute('aria-label') ?? null;

    beforeEach(() => {
        follow('boat');
        deps.piBaseUrl = 'https://pi.test:3001';
        cloudRow(cloudFixAt(BOAT, NOW - 5_000, { sogKts: 0.1 }));
    });
    afterEach(() => setBoatWindReadout(null));

    it('her reading on her marker, after her own words in its name; gone when the field takes it over', async () => {
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(windText()).toBeNull();
        act(() => setBoatWindReadout(HERS));
        expect(windText()).toBe('14 kt SSW');
        expect(name()).toBe('Kittiwake, stopped; heading unavailable; boat wind 14 knots from south-south-west');
        // The badge keeps its words.
        expect(badge()).toBe('Stopped');
        // Zoomed back in to 14: the field paints her wind, and her marker lets go.
        act(() => setBoatWindReadout({ ...HERS, fieldShowsHers: true }));
        expect(windText()).toBeNull();
        expect(name()).toBe('Kittiwake, stopped; heading unavailable');
        // Out again; then her reading gone (aged out, scrubbed away, wind off).
        act(() => setBoatWindReadout(HERS));
        expect(windText()).toBe('14 kt SSW');
        act(() => setBoatWindReadout(null));
        expect(windText()).toBeNull();
    });

    it('in the user’s own speed unit, repainted when it changes', async () => {
        const { view } = mountObs(OBS_START_FOLLOW, false, 'kmh');
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        act(() => setBoatWindReadout(HERS));
        expect(windText()).toBe('26 km/h SSW');
        expect(name()).toMatch(/; boat wind 26 kilometres per hour from south-south-west$/);
        view.rerender({ unit: 'mps' });
        expect(windText()).toBe('7.2 m/s SSW');
    });

    it('a marker drawn after her reading arrived wears it at once', async () => {
        act(() => setBoatWindReadout(HERS));
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()).toBeDefined();
        expect(windText()).toBe('14 kt SSW');
    });

    it('another boat’s wind never rides on her', async () => {
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        act(() => setBoatWindReadout({ ...HERS, boat: { crewOwnerId: SKIPPER } }));
        expect(windText()).toBeNull();
        expect(name()).toBe('Kittiwake, stopped; heading unavailable');
    });

    it('the boat crewed on wears her own wind, not the own boat’s', async () => {
        crewOnWindDancer();
        follow('crew');
        deps.cloudFix.mockImplementation(async (_now, owner) =>
            owner === SKIPPER ? cloudFixAt(CREWED) : owner === 'self' ? cloudFixAt(BOAT) : null,
        );
        mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        act(() => setBoatWindReadout(HERS));
        expect(windText()).toBeNull();
        act(() =>
            setBoatWindReadout({
                wind: { kt: 22, fromDeg: 90, stale: false },
                boat: { crewOwnerId: SKIPPER },
                fieldShowsHers: false,
            }),
        );
        expect(windText()).toBe('22 kt E');
        expect(name()).toMatch(/^Wind Dancer, stopped; .*; boat wind 22 knots from east$/);
    });

    it('the phone’s own marker never wears a boat’s wind', async () => {
        follow('phone');
        deps.piBaseUrl = null;
        deps.cloudFix.mockImplementation(async () => null);
        phoneLive(HOME);
        const { view } = mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(2_000));
        emitPhone(HOME);
        expect(view.result.current.subject).toBe('phone');
        act(() => setBoatWindReadout(HERS));
        expect(windText()).toBeNull();
        expect(name()).toBe('Own ship, stopped; heading unavailable');
    });
});

describe('box = the boat crewed on: her skipper’s row, never the own boat’s', () => {
    it('draws the crewed boat where the camera centres', async () => {
        crewOnWindDancer();
        follow('crew');
        deps.piBaseUrl = 'https://pi.test:3001';
        deps.cloudFix.mockImplementation(async (_now, owner) =>
            owner === SKIPPER ? cloudFixAt(CREWED) : owner === 'self' ? cloudFixAt(BOAT) : null,
        );
        const { map } = mountObs();
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(cameraCentre(map)).toEqual([CREWED.lon, CREWED.lat]);
        expect(vesselMarker()?.lngLat).toEqual([CREWED.lon, CREWED.lat]);
        expect(vesselMarker()?.element.getAttribute('aria-label')).toMatch(/^Wind Dancer, stopped;/);
    });
});

describe('box = a chosen place: the camera on the place, the marker on her', () => {
    it('draws the own boat, and the locate button lands on the marker', async () => {
        deps.piBaseUrl = 'https://pi.test:3001';
        phoneLive(HOME);
        cloudRow(cloudFixAt(BOAT, NOW - 5_000));
        const place: ObsStartTarget = {
            kind: 'place',
            key: 'place:Harbour Town@-20.3500,148.9500',
            center: { lat: -20.35, lon: 148.95 },
        };
        const { map } = mountObs(place);
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));
        expect(map.jumpTo).toHaveBeenCalledWith({ center: [148.95, -20.35], zoom: 10 });
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);

        await act(async () => {
            await locateOnObs(map as unknown as mapboxgl.Map, obsLocateSubject(false, true), NAMES, 14);
        });
        const flown = (map.flyTo.mock.calls.at(-1)?.[0] as { center: [number, number] }).center;
        expect(flown).toEqual(vesselMarker()?.lngLat);
    });
});

describe('box = Current Location: the phone gets its own dot, the boat keeps hers', () => {
    beforeEach(() => {
        follow('phone');
        deps.piBaseUrl = 'https://pi.test:3001';
    });

    it('ashore: the phone dot where the camera centres, and the boat marker on the boat', async () => {
        phoneLive(HOME);
        cloudRow(cloudFixAt(BOAT, NOW - 5_000));
        const { map } = mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));
        expect(cameraCentre(map)).toEqual([HOME.lon, HOME.lat]);
        const dot = phoneDot();
        expect(dot?.lngLat).toEqual([HOME.lon, HOME.lat]);
        expect(dot?.element.dataset.source).toBe('phone');
        expect(dot?.element.getAttribute('aria-label')).toBe('Your phone');
        // A little phone, not a dot (Shane 2026-10-08: "a little picture of a mobile phone").
        expect(dot?.element.querySelector('svg[data-glyph="phone"]')).not.toBeNull();
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(vesselMarker()?.element.dataset.source).toBe('vessel');
    });

    it('aboard: one marker, no dot on top of her', async () => {
        const aboard = { lat: BOAT.lat + 0.0002, lon: BOAT.lon + 0.0002 };
        phoneLive(aboard);
        cloudRow(cloudFixAt(BOAT, NOW - 5_000));
        mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(aboard);
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(phoneDot()).toBeUndefined();
    });

    it('the dot is wanted only on Obs, with the box on Current Location, and the marker on a boat', () => {
        const base = {
            obsShowing: true,
            boxFollows: true,
            followTarget: 'phone' as const,
            markerSubject: 'boat' as const,
        };
        expect(phoneDotWanted(base)).toBe(true);
        expect(phoneDotWanted({ ...base, obsShowing: false })).toBe(false);
        expect(phoneDotWanted({ ...base, boxFollows: false })).toBe(false);
        expect(phoneDotWanted({ ...base, followTarget: 'boat' })).toBe(false);
        expect(phoneDotWanted({ ...base, followTarget: 'crew' })).toBe(false);
        // A phone-only punter's marker IS the phone: no second pin.
        expect(phoneDotWanted({ ...base, markerSubject: 'phone' })).toBe(false);
    });
});

describe("crew aboard the skipper's boat, her Pi paired, the box on Current Location", () => {
    it('draws the boat under her feet from her Pi, with her SOG, and no second pin on her', async () => {
        crewOnWindDancer();
        follow('phone');
        const aboard = { lat: CREWED.lat + 0.0002, lon: CREWED.lon + 0.0002 };
        phoneLive(aboard);
        deps.piBaseUrl = 'https://pi.test:3001';
        // The Pi's diary relay is the skipper's: the chain reads it for her boat only.
        deps.deviceRungOwner.mockImplementation((rung) => (rung === 'pi' ? SKIPPER : null));
        deps.piFix.mockImplementation(async () => piFixAt(CREWED, Date.now() - 1_000));
        deps.cloudFix.mockImplementation(async (_now, owner) =>
            owner === SKIPPER ? cloudFixAt(CREWED, Date.now() - 3_000, { sogKts: 0.2 }) : null,
        );
        const { view } = mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(aboard);
        act(() => vi.advanceTimersByTime(1_000));
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
        expect(view.result.current.subject).toBe('boat');
        const marker = vesselMarker();
        expect(marker?.lngLat).toEqual([CREWED.lon, CREWED.lat]);
        expect(marker?.element.dataset.lane).toBe('pi');
        expect(badge()).toBe('Stopped');
        expect(marker?.element.getAttribute('aria-label')).toMatch(/^Wind Dancer, stopped;/);
        expect(phoneDot()).toBeUndefined();
    });
});

describe('a second device with no receivers of hers, the box on Current Location', () => {
    beforeEach(() => follow('phone'));

    it('one failed read never hands the marker back to the phone: she stays, as where she was', async () => {
        phoneLive(HOME);
        cloudRow(cloudFixAt(BOAT, NOW - 3_000));
        const { view } = mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(HOME);
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);

        deps.cloudFix.mockImplementation(async () => {
            throw new Error('offline');
        });
        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        emitPhone(HOME);
        expect(view.result.current.subject).toBe('boat');
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(vesselMarker()?.element.dataset.lane).toBe('held');
        expect(badge()).toMatch(/^Last fix /);
        expect(ownShipAtPhone()).toHaveLength(0);

        // The marker keeps asking: she answers again and is live.
        cloudRow(cloudFixAt(BOAT, Date.now() - 2_000));
        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.element.dataset.lane).toBe('cloud');
        expect(badge()).toBe('Stopped');
        expect(ownShipAtPhone()).toHaveLength(0);
    });

    it('the phone never flashes up as own ship before her first answer, on this mount or the next', async () => {
        phoneLive(HOME);
        let answer: (fix: BoatFix | null) => void = () => {};
        deps.cloudFix.mockImplementation((_now, owner) =>
            owner === 'self'
                ? new Promise<BoatFix | null>((resolve) => {
                      answer = resolve;
                  })
                : Promise.resolve(null),
        );
        const first = mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(HOME);
        expect(vesselMarker()).toBeUndefined();
        await act(async () => answer(cloudFixAt(BOAT, Date.now() - 2_000)));
        await settle();
        act(() => vi.advanceTimersByTime(1_000));
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(phoneDot()?.lngLat).toEqual([HOME.lon, HOME.lat]);

        // Obs again, later, before her row answers: she is where she was, never the phone.
        first.view.unmount();
        await act(async () => {
            vi.advanceTimersByTime(90_000);
        });
        mountObs(OBS_START_FOLLOW, true);
        await settle();
        emitPhone(HOME);
        expect(vesselMarker()?.lngLat).toEqual([BOAT.lon, BOAT.lat]);
        expect(ownShipAtPhone()).toHaveLength(0);
    });

    it('a look that never answers holds the phone back for 2 s at most', async () => {
        phoneLive(HOME);
        deps.cloudFix.mockImplementation(() => new Promise<BoatFix | null>(() => {}));
        mountObs();
        await settle();
        emitPhone(HOME);
        expect(vesselMarker()).toBeUndefined();
        act(() => vi.advanceTimersByTime(2_000));
        expect(vesselMarker()?.lngLat).toEqual([HOME.lon, HOME.lat]);
        expect(vesselMarker()?.element.dataset.source).toBe('phone');
    });
});

describe('a phone-only punter: unchanged', () => {
    it('no gateway, no Pi, no fix of a boat: the marker is the phone, as Own ship', async () => {
        phoneLive(HOME);
        const { view } = mountObs();
        await settle();
        emitPhone(HOME);
        expect(view.result.current.subject).toBe('phone');
        const marker = vesselMarker();
        expect(marker?.lngLat).toEqual([HOME.lon, HOME.lat]);
        expect(marker?.element.dataset.source).toBe('phone');
        expect(badge()).toBe('Stopped');
        expect(marker?.element.getAttribute('aria-label')).toBe('Own ship, stopped; heading unavailable');
    });
});

describe('whose position the marker draws, per box', () => {
    it('box = boat: her, receivers or not; box = crew: the crewed boat', () => {
        follow('boat');
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
        crewOnWindDancer();
        follow('crew');
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
    });

    it('box = phone or a place: the own boat when she has a receiver of her own, else the phone', () => {
        follow('phone');
        expect(ownshipMarkerSubject()).toEqual({ kind: 'phone' });
        deps.gatewaySaved = true;
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
        deps.gatewaySaved = false;
        deps.piBaseUrl = 'https://pi.test:3001';
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
        deps.piBaseUrl = null;
        // A fix of hers this device holds is a receiver of her own too.
        rememberBoatFix(cloudFixAt(BOAT, NOW - 2 * HOUR), NOW - 2 * HOUR);
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
    });

    it("a receiver known to be a crewed boat's is hers, never the own boat's", () => {
        follow('phone');
        crewOnWindDancer();
        deps.piBaseUrl = 'https://pi.test:3001';
        deps.deviceRungOwner.mockImplementation((rung) => (rung === 'pi' ? SKIPPER : null));
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
        // A gateway that names no boat is the own boat's, as the chain reads it.
        deps.gatewaySaved = true;
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
        // A Pi whose skipper this account does not crew for is the own boat's.
        deps.gatewaySaved = false;
        deps.deviceRungOwner.mockImplementation((rung) => (rung === 'pi' ? 'owner-k' : null));
        expect(ownshipMarkerSubject()).toEqual({ kind: 'boat', crewOwnerId: null });
    });

    it("reads exactly the camera's chain: a held fix is 'held' and carries no speed, course or bow", () => {
        rememberBoatFix(cloudFixAt(BOAT, NOW - 2 * HOUR, { sogKts: 5, cogDeg: 90 }), NOW - 2 * HOUR);
        expect(vesselMarkerFixNow(null)).toEqual({
            lat: BOAT.lat,
            lon: BOAT.lon,
            timestamp: NOW - 2 * HOUR,
            lane: 'held',
            sogKts: null,
            cogDeg: null,
            headingTrueDeg: null,
            headingTrueAt: null,
        });
    });
});

describe('source guards', () => {
    it("the tracker's boat branch never reads the phone", () => {
        const source = readFileSync('components/map/useVesselTracker.ts', 'utf8');
        const branch = source.slice(source.indexOf('const paintBoat ='), source.indexOf('// ── end paintBoat'));
        expect(branch.length).toBeGreaterThan(200);
        expect(branch).not.toMatch(/GpsService|LocationStore\.getState\(\)\.(lat|lon)|BgGeoManager/);
        // And the marker does not hold the cloud lane open: that would put the row into
        // NmeaStore, where the arbiter would hand it to Guardian, AIS and the diary as 'nmea'.
        expect(source).not.toMatch(/CloudTelemetryService\.retain\(/);
    });
});
