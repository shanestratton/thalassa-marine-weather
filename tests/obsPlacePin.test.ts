/**
 * The chosen place's pin on Obs, and Locate going there first (126-18).
 *
 * Shane 2026-10-09: "also in the obs page, if it isnt the vessel location or
 * the phone location, can we have a pin in the location and that is where the
 * locate fab goes to on the obs page".
 *
 * The real follow-target store, boat chain (services/weatherPosition), phone
 * fix (obsCentre, phoneLastFix) and own-ship subject (ownshipBoatFix) run
 * here; only the receivers are faked: the boat's rungs (boatPositionChain),
 * the phone (GpsService) and the map (a Marker that records itself). Every
 * name and position is fictional, and the places are global.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { BoatFix } from '../services/boatPositionChain';
import type { GpsPosition } from '../services/GpsService';

const deps = vi.hoisted(() => ({
    lastKnown: null as GpsPosition | null,
    busFix: vi.fn<() => BoatFix | null>(() => null),
    piFix: vi.fn<() => Promise<BoatFix | null>>(async () => null),
    cloudFix: vi.fn<(now?: number, owner?: string) => Promise<BoatFix | null>>(async () => null),
    deviceRungOwner: vi.fn<(rung: 'bus' | 'pi') => string | null>(() => null),
}));

const markers = vi.hoisted(() => {
    class Marker {
        element: HTMLElement;
        anchor: string | undefined;
        lngLat: [number, number] | null = null;
        removed = false;
        constructor(options: { element: HTMLElement; anchor?: string }) {
            this.element = options.element;
            this.anchor = options.anchor;
            all.push(this);
        }
        setLngLat = vi.fn((lngLat: [number, number]) => {
            this.lngLat = [lngLat[0], lngLat[1]];
            return this;
        });
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
    NmeaStore: { getState: () => ({}), isBoatFeed: () => false, start: vi.fn(), subscribe: () => () => {} },
}));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { getSavedConfig: () => null } }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => null,
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
        watchPosition: () => () => {},
        getLastKnownPosition: () => deps.lastKnown,
        getCurrentPositionIfGranted: vi.fn(async () => null),
        requestCurrentForegroundPosition: vi.fn(async () => null),
        locationPermission: async () => 'denied',
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { readFileSync } from 'node:fs';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { __resetWeatherPositionForTests, rememberBoatFix, setWeatherFollowTarget } from '../services/weatherPosition';
import { __resetPhoneLastFixForTests, rememberPhoneFix } from '../services/phoneLastFix';
import { __resetObsCentreForTests, obsLocateSubject, type LocateStop } from '../components/map/obsCentre';
import { __resetOwnshipBoatFixForTests } from '../components/map/ownshipBoatFix';
import {
    PLACE_PIN_RECHECK_MS,
    PLACE_PIN_SAME_SPOT_M,
    chartAtStop,
    createPlacePinElement,
    followLocateFlight,
    locateStopLabel,
    nextLocateStop,
    noteLocateStop,
    obsLocateStops,
    placePinPoint,
    useNextLocateStop,
    useObsPlacePin,
    type LastLocateStop,
    type PlacePin,
} from '../components/map/obsPlacePin';

const NOW = Date.parse('2026-10-09T09:00:00.000Z');
const HOUR = 3_600_000;
/** Metres per degree of latitude on calculateDistance's sphere (3440.065 nm). */
const M_PER_DEG = (3440.065 * 1852 * Math.PI) / 180;
const north = (at: { lat: number; lon: number }, metres: number) => ({ lat: at.lat + metres / M_PER_DEG, lon: at.lon });

/** A fictional harbour, the boat on her mooring ~40 km off, and the phone ~1,000 km away. */
const PORT_KITTIWAKE = { lat: -16.48, lon: 145.46 };
const KITTIWAKE = { lat: -16.2, lon: 145.7 };
const PHONE_FAR = { lat: -25.48, lon: 145.46 };
/** Across the antimeridian: 0.002° of longitude at 16.78° S, about 213 m. */
const SAVUSAVU = { lat: -16.78, lon: 179.999 };
const SAVUSAVU_TWIN = { lat: -16.78, lon: -179.999 };
const SKIPPER = 'skipper-wd';
/** Horta, Faial: a second place a world away. */
const HORTA = { lat: 38.53, lon: -28.63 };

const busFixAt = (at: { lat: number; lon: number }, timestamp = NOW): BoatFix => ({
    latitude: at.lat,
    longitude: at.lon,
    timestamp,
    rung: 'bus',
    source: 'nmea-gateway',
});

function phoneAt(at: { lat: number; lon: number }, timestamp = NOW): GpsPosition {
    return { latitude: at.lat, longitude: at.lon, accuracy: 5, altitude: null, heading: null, speed: 0, timestamp };
}

/** Her bus answers live where she is. */
function boatLive(at = KITTIWAKE) {
    deps.busFix.mockImplementation(() => busFixAt(at, Date.now()));
}

/** Only her held fix: where she was an hour ago, no receiver answering now. */
function boatHeld(at = KITTIWAKE) {
    rememberBoatFix(busFixAt(at, NOW - HOUR), NOW - HOUR);
}

function phoneLive(at = PHONE_FAR) {
    deps.lastKnown = phoneAt(at, Date.now());
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

const pin = (name: string, at: { lat: number; lon: number }): PlacePin =>
    placePinPoint({ defaultLocation: name, defaultLocationCoords: at })!;

const kinds = (stops: LocateStop[]) => stops.map((stop) => stop.kind);

const stopsFor = (place: PlacePin | null, patch: { ownBoatNamed?: boolean; mobActive?: boolean } = {}) =>
    obsLocateStops({
        boxFollows: false,
        ownBoatNamed: patch.ownBoatNamed ?? true,
        place,
        mobActive: !!patch.mobActive,
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('owner-k');
    reloadSharedBindersFromStorage();
    markers.all.length = 0;
    deps.lastKnown = null;
    deps.busFix.mockImplementation(() => null);
    deps.piFix.mockImplementation(async () => null);
    deps.cloudFix.mockImplementation(async () => null);
    deps.deviceRungOwner.mockImplementation(() => null);
    __resetWeatherPositionForTests();
    __resetPhoneLastFixForTests();
    __resetObsCentreForTests();
    __resetOwnshipBoatFixForTests();
    follow('phone');
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('placePinPoint: a point that really belongs to the chosen name', () => {
    it('picked coordinates are the point', () => {
        expect(placePinPoint({ defaultLocation: 'Port Kittiwake', defaultLocationCoords: PORT_KITTIWAKE })).toEqual({
            name: 'Port Kittiwake',
            lat: PORT_KITTIWAKE.lat,
            lon: PORT_KITTIWAKE.lon,
            drawLat: PORT_KITTIWAKE.lat,
        });
    });

    it('a name-only choice takes the report’s point once the report carries the same name', () => {
        expect(
            placePinPoint({
                defaultLocation: 'Port Kittiwake',
                defaultLocationCoords: null,
                weatherCoords: PORT_KITTIWAKE,
                weatherName: ' port kittiwake ',
            }),
        ).toMatchObject({ name: 'Port Kittiwake', lat: PORT_KITTIWAKE.lat, lon: PORT_KITTIWAKE.lon });
    });

    it('a report for another place is not this place (a name still resolving, the home port mid-typing)', () => {
        expect(
            placePinPoint({
                defaultLocation: 'Port Kitti',
                defaultLocationCoords: null,
                weatherCoords: SAVUSAVU,
                weatherName: 'Savusavu',
            }),
        ).toBeNull();
        expect(
            placePinPoint({ defaultLocation: 'Port Kittiwake', weatherCoords: PORT_KITTIWAKE, weatherName: null }),
        ).toBeNull();
    });

    it('the 0,0 optimistic stub, Current Location, NaN and out-of-range points are no place', () => {
        expect(
            placePinPoint({
                defaultLocation: 'Port Kittiwake',
                weatherCoords: { lat: 0, lon: 0 },
                weatherName: 'Port Kittiwake',
            }),
        ).toBeNull();
        expect(
            placePinPoint({ defaultLocation: 'Port Kittiwake', defaultLocationCoords: { lat: 0, lon: 0 } }),
        ).toBeNull();
        expect(
            placePinPoint({ defaultLocation: 'Current Location', defaultLocationCoords: PORT_KITTIWAKE }),
        ).toBeNull();
        expect(placePinPoint({ defaultLocation: '  ', defaultLocationCoords: PORT_KITTIWAKE })).toBeNull();
        expect(placePinPoint({ defaultLocation: null, defaultLocationCoords: PORT_KITTIWAKE })).toBeNull();
        expect(placePinPoint({ defaultLocation: 'Nowhere', defaultLocationCoords: { lat: NaN, lon: 1 } })).toBeNull();
        expect(placePinPoint({ defaultLocation: 'Nowhere', defaultLocationCoords: { lat: 91, lon: 1 } })).toBeNull();
        expect(placePinPoint({ defaultLocation: 'Nowhere', defaultLocationCoords: { lat: 1, lon: 181 } })).toBeNull();
    });

    // Just inside Mercator's edge (85.0511°): at the edge itself the real engine
    // kept the pin's body off the top of the canvas at z10 (browser test).
    it('a polar place is drawn at 85°, inside Mercator’s edge; the true latitude is kept for its weather', () => {
        const polar = placePinPoint({ defaultLocation: 'Polar Camp', defaultLocationCoords: { lat: 88, lon: 30 } });
        expect(polar).toEqual({ name: 'Polar Camp', lat: 88, lon: 30, drawLat: 85 });
        const south = placePinPoint({ defaultLocation: 'Polar Camp', defaultLocationCoords: { lat: -89.5, lon: 0.5 } });
        expect(south?.drawLat).toBe(-85);
        // Inside the band, the point itself.
        expect(
            placePinPoint({ defaultLocation: 'Station', defaultLocationCoords: { lat: -77.5, lon: 160 } })?.drawLat,
        ).toBe(-77.5);
    });
});

describe('obsLocateStops: where Locate goes, in order', () => {
    it('a place far from her and the phone: the place, the boat, then the phone', () => {
        boatLive();
        phoneLive();
        const stops = stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE));
        expect(stops).toEqual([
            { kind: 'place', lat: PORT_KITTIWAKE.lat, lon: PORT_KITTIWAKE.lon, name: 'Port Kittiwake' },
            { kind: 'boat', crewOwnerId: null },
            { kind: 'phone' },
        ]);
    });

    it(`within ${PLACE_PIN_SAME_SPOT_M} m of her live fix the place is hers: her mark stands for it`, () => {
        expect(PLACE_PIN_SAME_SPOT_M).toBe(250);
        boatLive(KITTIWAKE);
        phoneLive();
        expect(kinds(stopsFor(pin('Kittiwake’s bay', north(KITTIWAKE, 249))))).toEqual(['boat', 'phone']);
        expect(kinds(stopsFor(pin('Kittiwake’s bay', north(KITTIWAKE, 251))))).toEqual(['place', 'boat', 'phone']);
    });

    it('her held fix never hides the place: she may have moved', () => {
        boatHeld(KITTIWAKE);
        phoneLive();
        expect(kinds(stopsFor(pin('Kittiwake’s mooring', KITTIWAKE)))).toEqual(['place', 'boat', 'phone']);
    });

    it('no boat, the place 200 m from the phone’s live fix: the phone alone', () => {
        phoneLive(PHONE_FAR);
        expect(kinds(stopsFor(pin('Home jetty', north(PHONE_FAR, 200)), { ownBoatNamed: false }))).toEqual(['phone']);
    });

    it('the phone aboard her: no phone stop (one mark, hers)', () => {
        boatLive(KITTIWAKE);
        phoneLive(north(KITTIWAKE, 60));
        expect(kinds(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE)))).toEqual(['place', 'boat']);
    });

    it('a boat but no phone fix ever: no phone stop (no permission prompt mid-cycle)', () => {
        boatLive();
        expect(kinds(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE)))).toEqual(['place', 'boat']);
    });

    it('a kept phone fix counts as the phone’s place', () => {
        boatLive();
        rememberPhoneFix(phoneAt(PHONE_FAR, NOW - 2 * HOUR), NOW - 2 * HOUR);
        expect(kinds(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE)))).toEqual(['place', 'boat', 'phone']);
    });

    it('no boat and no phone fix: the place, then the phone (it may ask, as Locate always could)', () => {
        expect(kinds(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE), { ownBoatNamed: false }))).toEqual([
            'place',
            'phone',
        ]);
    });

    it('during a MOB the place is dropped: the boat first, as today', () => {
        boatLive();
        phoneLive();
        expect(kinds(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE), { mobActive: true }))).toEqual(['boat', 'phone']);
    });

    it('a name-only place still resolving has no stop', () => {
        boatLive();
        phoneLive();
        const resolving = placePinPoint({
            defaultLocation: 'Port Kittiwake',
            defaultLocationCoords: null,
            weatherCoords: SAVUSAVU,
            weatherName: 'Savusavu',
        });
        expect(kinds(stopsFor(resolving))).toEqual(['boat', 'phone']);
    });

    it('crewing with no boat of its own: the boat stop is the boat crewed on', () => {
        crewOnWindDancer();
        phoneLive();
        const stops = stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE), { ownBoatNamed: false });
        expect(stops[0].kind).toBe('place');
        expect(stops[1]).toEqual({ kind: 'boat', crewOwnerId: SKIPPER });
    });

    it('the box following a receiver: exactly today’s one stop, whatever else holds', () => {
        crewOnWindDancer();
        boatLive();
        phoneLive();
        const place = pin('Port Kittiwake', PORT_KITTIWAKE);
        for (const target of ['phone', 'boat', 'crew'] as const) {
            follow(target);
            for (const ownBoatNamed of [true, false])
                for (const mobActive of [true, false]) {
                    const stops = obsLocateStops({ boxFollows: true, ownBoatNamed, place, mobActive });
                    expect(stops, `${target} ${ownBoatNamed} ${mobActive}`).toEqual([
                        obsLocateSubject(true, ownBoatNamed),
                    ]);
                }
        }
    });

    it('across the antimeridian the place merges with her by the great circle (~213 m), not 360°', () => {
        boatLive(SAVUSAVU_TWIN);
        phoneLive();
        expect(kinds(stopsFor(pin('Savusavu', SAVUSAVU)))).toEqual(['boat', 'phone']);
    });
});

describe('nextLocateStop: one tap, the next stop', () => {
    const place: LocateStop = {
        kind: 'place',
        lat: PORT_KITTIWAKE.lat,
        lon: PORT_KITTIWAKE.lon,
        name: 'Port Kittiwake',
    };
    const boat: LocateStop = { kind: 'boat', crewOwnerId: null };
    const phone: LocateStop = { kind: 'phone' };
    const three = [place, boat, phone];

    it('cycles place → boat → phone → place, and starts at the first anywhere else', () => {
        expect(nextLocateStop(three, null)).toBe(place);
        expect(nextLocateStop(three, 'place')).toBe(boat);
        expect(nextLocateStop(three, 'boat')).toBe(phone);
        expect(nextLocateStop(three, 'phone')).toBe(place);
        // A stop no longer listed (the pin merged with her meanwhile): the first.
        expect(nextLocateStop([boat, phone], 'place')).toBe(boat);
        // One stop: always itself (every 124 flow).
        expect(nextLocateStop([phone], 'phone')).toBe(phone);
        expect(nextLocateStop([boat], null)).toBe(boat);
    });
});

/** A Web Mercator camera (512 px tiles), as Mapbox's: project, centre, zoom, moving. */
function fakeCamera(centre: { lat: number; lon: number }, zoom: number, moving = false) {
    const world = () => 512 * 2 ** camera.zoom;
    const x = (lon: number) => ((lon + 180) / 360) * world();
    const y = (lat: number) =>
        ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) * world();
    const camera = {
        centre,
        zoom,
        moving,
        project: ([lon, lat]: [number, number]) => ({
            x: x(lon) - x(camera.centre.lon) + 200,
            y: y(lat) - y(camera.centre.lat) + 400,
        }),
        getCenter: () => ({ lng: camera.centre.lon, lat: camera.centre.lat }),
        getZoom: () => camera.zoom,
        isMoving: () => camera.moving,
    };
    return { camera, map: camera as unknown as mapboxgl.Map, pxToLon: (px: number) => (px * 360) / world() };
}

describe('chartAtStop: is the chart still where a stop left it', () => {
    const place = pin('Port Kittiwake', PORT_KITTIWAKE);
    const last = (patch: Partial<LastLocateStop>): LastLocateStop => ({
        kind: 'boat',
        lat: KITTIWAKE.lat,
        lon: KITTIWAKE.lon,
        zoom: 14,
        at: NOW - 10_000,
        ...patch,
    });

    it('centred on the pin at z10 (Obs opening on the place counts)', () => {
        const { map } = fakeCamera(PORT_KITTIWAKE, 10);
        expect(chartAtStop(map, { place, last: null })).toBe('place');
    });

    it('32 px is there, 33 px off is not, and nor is z10.6', () => {
        const { camera, map, pxToLon } = fakeCamera(PORT_KITTIWAKE, 10);
        camera.centre = { lat: PORT_KITTIWAKE.lat, lon: PORT_KITTIWAKE.lon + pxToLon(31.9) };
        expect(chartAtStop(map, { place, last: null })).toBe('place');
        camera.centre = { lat: PORT_KITTIWAKE.lat, lon: PORT_KITTIWAKE.lon + pxToLon(33) };
        expect(chartAtStop(map, { place, last: null })).toBeNull();
        camera.centre = PORT_KITTIWAKE;
        camera.zoom = 10.6;
        expect(chartAtStop(map, { place, last: null })).toBeNull();
    });

    it('the last boat flight’s spot, still centred: the boat', () => {
        const { map } = fakeCamera(KITTIWAKE, 14);
        expect(chartAtStop(map, { place, last: last({}) })).toBe('boat');
    });

    it('mid-flight within 2 s: the stop flown to; later, only where it landed counts', () => {
        const { camera, map } = fakeCamera({ lat: -20, lon: 150 }, 8, true);
        expect(chartAtStop(map, { place, last: last({ kind: 'phone', at: NOW - 1_000 }) })).toBe('phone');
        expect(chartAtStop(map, { place, last: last({ kind: 'phone', at: NOW - 2_500 }) })).toBeNull();
        camera.moving = false;
        expect(chartAtStop(map, { place, last: last({ kind: 'phone', at: NOW - 1_000 }) })).toBeNull();
    });

    it('a boat stop with no flight (no fix): still there while the chart is unmoved', () => {
        const { camera, map, pxToLon } = fakeCamera({ lat: -18, lon: 147 }, 11);
        const noFlight = last({ lat: -18, lon: 147, zoom: 11 });
        expect(chartAtStop(map, { place, last: noFlight })).toBe('boat');
        camera.centre = { lat: -18, lon: 147 + pxToLon(80) };
        expect(chartAtStop(map, { place, last: noFlight })).toBeNull();
    });

    it('a camera on another world copy (180° crossed) is still at the stop', () => {
        const { map } = fakeCamera({ lat: SAVUSAVU_TWIN.lat, lon: 180.001 }, 14);
        expect(chartAtStop(map, { place: null, last: last({ lat: SAVUSAVU_TWIN.lat, lon: SAVUSAVU_TWIN.lon }) })).toBe(
            'boat',
        );
    });

    it('nothing to compare: nowhere', () => {
        const { map } = fakeCamera({ lat: 51.5, lon: -0.1 }, 10);
        expect(chartAtStop(map, { place: null, last: null })).toBeNull();
    });

    it('a place stop is that place only: a new place chosen beside Obs is where the next tap goes', () => {
        boatLive();
        phoneLive();
        const horta = pin('Horta', HORTA);
        // Locate left the chart on Port Kittiwake's pin at z10.
        const { camera, map } = fakeCamera(PORT_KITTIWAKE, 10);
        const atOld = last({
            kind: 'place',
            lat: PORT_KITTIWAKE.lat,
            lon: PORT_KITTIWAKE.lon,
            zoom: 10,
            place: { name: 'Port Kittiwake', lat: PORT_KITTIWAKE.lat, lon: PORT_KITTIWAKE.lon },
        });
        expect(chartAtStop(map, { place, last: atOld })).toBe('place');
        expect(nextLocateStop(stopsFor(place), chartAtStop(map, { place, last: atOld })).kind).toBe('boat');
        // The Glass picks Horta; the chart stays put. Not at the place: the next tap is Horta.
        expect(chartAtStop(map, { place: horta, last: atOld })).toBeNull();
        expect(nextLocateStop(stopsFor(horta), chartAtStop(map, { place: horta, last: atOld }))).toMatchObject({
            kind: 'place',
            name: 'Horta',
            lat: HORTA.lat,
            lon: HORTA.lon,
        });
        // Mid-flight to the old place when Horta is chosen: still Horta next.
        camera.moving = true;
        expect(chartAtStop(map, { place: horta, last: { ...atOld, at: NOW - 500 } })).toBeNull();
        // The box back on Current Location (no place): not 'place' either.
        camera.moving = false;
        expect(chartAtStop(map, { place: null, last: atOld })).toBeNull();
    });
});

describe('where a tap left the chart, and what the label says', () => {
    /** A camera that flies on request and says when it stops, as Mapbox's. */
    function flyingCamera(centre: { lat: number; lon: number }, zoom: number) {
        const moveend = new Set<() => void>();
        const camera = {
            centre,
            zoom,
            moving: false,
            getCenter: () => ({ lng: camera.centre.lon, lat: camera.centre.lat }),
            getZoom: () => camera.zoom,
            isMoving: () => camera.moving,
            once: vi.fn((name: string, listener: () => void) => {
                if (name === 'moveend') moveend.add(listener);
            }),
            land(to: { lat: number; lon: number }, z: number) {
                camera.centre = to;
                camera.zoom = z;
                camera.moving = false;
                const heard = [...moveend];
                moveend.clear();
                heard.forEach((listener) => listener());
            },
        };
        return { camera, map: camera as unknown as mapboxgl.Map };
    }

    it('the tap keeps the camera where it was; a flight’s landing spot replaces it, timed from take-off', () => {
        const { camera, map } = flyingCamera({ lat: 38.53, lon: -28.63 }, 9);
        const tap = noteLocateStop(map, { kind: 'boat', crewOwnerId: null }, NOW);
        expect(tap).toEqual({ kind: 'boat', lat: 38.53, lon: -28.63, zoom: 9, at: NOW });
        expect(tap).not.toHaveProperty('place');
        camera.moving = true;
        vi.setSystemTime(NOW + 3_000);
        const landed = vi.fn();
        followLocateFlight(map, tap, landed);
        expect(tap.at).toBe(NOW + 3_000);
        expect(landed).not.toHaveBeenCalled();
        camera.land(KITTIWAKE, 14);
        expect(tap).toMatchObject({ lat: KITTIWAKE.lat, lon: KITTIWAKE.lon, zoom: 14 });
        expect(landed).toHaveBeenCalledOnce();
    });

    it('a jump (Reduce Motion) has already landed: read at once', () => {
        const { camera, map } = flyingCamera({ lat: 38.53, lon: -28.63 }, 9);
        const viaduct = { kind: 'place' as const, lat: -36.84, lon: 174.76, name: 'Viaduct Harbour' };
        const tap = noteLocateStop(map, viaduct, NOW);
        // Which place it was, to tell it from a place chosen later.
        expect(tap.place).toEqual({ name: 'Viaduct Harbour', lat: -36.84, lon: 174.76 });
        camera.centre = { lat: -36.84, lon: 174.76 };
        camera.zoom = 10;
        const landed = vi.fn();
        followLocateFlight(map, tap, landed);
        expect(tap).toMatchObject({ kind: 'place', lat: -36.84, lon: 174.76, zoom: 10, at: NOW });
        expect(tap.place).toEqual({ name: 'Viaduct Harbour', lat: -36.84, lon: 174.76 });
        expect(landed).toHaveBeenCalledOnce();
        expect(camera.once).not.toHaveBeenCalled();
    });

    it('names the stop: the place, the boat (capitalised when unnamed), the phone', () => {
        const named = { own: 'Kittiwake', crew: { ownerId: SKIPPER, name: 'Wind Dancer' } };
        const unnamed = { own: null, crew: null };
        expect(locateStopLabel({ kind: 'place', lat: 1, lon: 2, name: 'الدوحة' }, named)).toBe('الدوحة');
        expect(locateStopLabel({ kind: 'boat', crewOwnerId: null }, named)).toBe('Kittiwake');
        expect(locateStopLabel({ kind: 'boat', crewOwnerId: SKIPPER }, named)).toBe('Wind Dancer');
        expect(locateStopLabel({ kind: 'boat', crewOwnerId: null }, unnamed)).toBe('Your boat');
        expect(locateStopLabel({ kind: 'boat', crewOwnerId: SKIPPER }, unnamed)).toBe("Your skipper's boat");
        expect(locateStopLabel({ kind: 'phone' }, named)).toBe('Your phone');
    });
});

describe('useNextLocateStop: the button’s next stop as state', () => {
    function mountNext(enabled = true) {
        const listeners = new Map<string, Set<() => void>>();
        const map = {
            on: vi.fn((name: string, listener: () => void) => {
                const set = listeners.get(name) ?? new Set();
                set.add(listener);
                listeners.set(name, set);
            }),
            off: vi.fn((name: string, listener: () => void) => listeners.get(name)?.delete(listener)),
        };
        const mapRef = { current: map as unknown as mapboxgl.Map | null };
        let answer: LocateStop = { kind: 'boat', crewOwnerId: null };
        const read = vi.fn(() => answer);
        let renders = 0;
        const view = renderHook(
            ({ on, dep }: { on: boolean; dep: number }) => {
                renders += 1;
                return useNextLocateStop(mapRef, true, on, read, [dep]);
            },
            { initialProps: { on: enabled, dep: 0 } },
        );
        const emit = (name: string) => act(() => [...(listeners.get(name) ?? [])].forEach((listener) => listener()));
        return {
            view,
            read,
            emit,
            set: (stop: LocateStop) => (answer = stop),
            renders: () => renders,
            listeners: () => listeners.get('moveend')?.size ?? 0,
        };
    }

    it('reads on mount, on each camera stop and every recheck; re-renders only on a change', () => {
        const next = mountNext();
        expect(next.view.result.current[0]).toEqual({ kind: 'boat', crewOwnerId: null });
        const settled = next.renders();
        next.emit('moveend');
        act(() => vi.advanceTimersByTime(PLACE_PIN_RECHECK_MS));
        expect(next.renders()).toBe(settled);
        next.set({ kind: 'phone' });
        next.emit('moveend');
        expect(next.view.result.current[0]).toEqual({ kind: 'phone' });
        next.set({ kind: 'place', lat: -16.48, lon: 145.46, name: 'Port Kittiwake' });
        act(() => vi.advanceTimersByTime(PLACE_PIN_RECHECK_MS));
        expect(next.view.result.current[0]).toMatchObject({ kind: 'place', name: 'Port Kittiwake' });
        // The refresh it hands back reads at once (a tap that did not move the chart).
        next.set({ kind: 'boat', crewOwnerId: null });
        act(() => next.view.result.current[1]());
        expect(next.view.result.current[0]).toEqual({ kind: 'boat', crewOwnerId: null });
        next.view.unmount();
        expect(next.listeners()).toBe(0);
    });

    it('as MapHub reads it: a new place after Locate reached the old one turns the button back to the place', () => {
        boatLive();
        phoneLive();
        const { camera, map } = fakeCamera(PORT_KITTIWAKE, 10);
        Object.assign(camera, { on: vi.fn(), off: vi.fn() });
        const mapRef = { current: map as mapboxgl.Map | null };
        const lastStop: { current: LastLocateStop | null } = { current: null };
        const view = renderHook(
            ({ place }: { place: PlacePin }) =>
                useNextLocateStop(
                    mapRef,
                    true,
                    true,
                    () => nextLocateStop(stopsFor(place), chartAtStop(map, { place, last: lastStop.current })),
                    [place],
                ),
            { initialProps: { place: pin('Port Kittiwake', PORT_KITTIWAKE) } },
        );
        // A tap that took the chart to Port Kittiwake's pin: the next goes to the boat.
        const tapped = nextLocateStop(stopsFor(pin('Port Kittiwake', PORT_KITTIWAKE)), null);
        expect(tapped).toMatchObject({ kind: 'place', name: 'Port Kittiwake' });
        lastStop.current = noteLocateStop(map, tapped);
        act(() => view.result.current[1]());
        expect(view.result.current[0].kind).toBe('boat');
        // Horta chosen on the Glass beside Obs; the chart stays where it was.
        view.rerender({ place: pin('Horta', HORTA) });
        expect(view.result.current[0]).toMatchObject({ kind: 'place', name: 'Horta' });
        // That tap lands on Horta: then the boat again.
        camera.centre = HORTA;
        lastStop.current = noteLocateStop(map, view.result.current[0]);
        act(() => view.result.current[1]());
        expect(view.result.current[0].kind).toBe('boat');
    });

    it('off Obs it does not listen, but its inputs changing still re-read it', () => {
        const next = mountNext(false);
        expect(next.listeners()).toBe(0);
        next.set({ kind: 'phone' });
        next.view.rerender({ on: false, dep: 1 });
        expect(next.view.result.current[0]).toEqual({ kind: 'phone' });
    });
});

describe('the pin element', () => {
    it('is a 44 × 44 button naming the place, its chip hidden from VoiceOver', () => {
        const el = createPlacePinElement('Port Kittiwake');
        expect(el.tagName).toBe('BUTTON');
        expect(el.getAttribute('type')).toBe('button');
        expect(el.getAttribute('role')).toBe('button');
        expect(el.classList.contains('obs-place-pin')).toBe(true);
        expect(el.dataset.glyph).toBe('place');
        expect(el.style.width).toBe('44px');
        expect(el.style.height).toBe('44px');
        expect(el.getAttribute('aria-label')).toBe('Port Kittiwake, the place you chose. Show its weather');
        const chip = el.querySelector('.obs-place-pin__label') as HTMLElement;
        expect(chip.textContent).toBe('Port Kittiwake');
        expect(chip.getAttribute('aria-hidden')).toBe('true');
        expect(chip.getAttribute('dir')).toBe('auto');
        expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('stays a button on the real Mapbox marker (which makes any role-less element an image)', async () => {
        const actual = await vi.importActual<typeof import('mapbox-gl')>('mapbox-gl');
        const el = createPlacePinElement('Port Kittiwake');
        const marker = new actual.default.Marker({ element: el, anchor: 'bottom' });
        try {
            expect(marker.getElement()).toBe(el);
            expect(el.getAttribute('role')).toBe('button');
        } finally {
            marker.remove();
        }
    });

    it('a name is text, never markup', () => {
        const el = createPlacePinElement('<img src=x onerror=alert(1)>');
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.obs-place-pin__label')?.textContent).toBe('<img src=x onerror=alert(1)>');
        const rtl = createPlacePinElement('الدوحة');
        expect(rtl.querySelector('.obs-place-pin__label')?.textContent).toBe('الدوحة');
    });
});

/** Obs as MapHub mounts the pin: a map whose canvas container hears clicks, as Mapbox's does. */
function mountPin(initial: { place: PlacePin | null; ready?: boolean }) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const mapClick = vi.fn();
    container.addEventListener('click', mapClick);
    const map = { getCanvasContainer: () => container };
    const mapRef = { current: map as unknown as mapboxgl.Map | null };
    const onTap = vi.fn();
    const view = renderHook(
        ({ place, ready }: { place: PlacePin | null; ready: boolean }) => useObsPlacePin(mapRef, ready, place, onTap),
        { initialProps: { place: initial.place, ready: initial.ready ?? true } },
    );
    const live = () =>
        markers.all.filter((marker) => !marker.removed && marker.element.classList.contains('obs-place-pin'));
    const attach = () => {
        for (const marker of live()) if (!marker.element.isConnected) container.appendChild(marker.element);
    };
    return { view, live, attach, mapClick, onTap, container };
}

describe('useObsPlacePin: one gold pin at the chosen place', () => {
    it('one marker at [lon, lat], tip-anchored, labelled', () => {
        boatLive();
        phoneLive();
        const { live } = mountPin({ place: pin('Port Kittiwake', PORT_KITTIWAKE) });
        expect(live()).toHaveLength(1);
        expect(live()[0].lngLat).toEqual([PORT_KITTIWAKE.lon, PORT_KITTIWAKE.lat]);
        expect(live()[0].anchor).toBe('bottom');
        expect(live()[0].element.querySelector('.obs-place-pin__label')?.textContent).toBe('Port Kittiwake');
    });

    it('a new place moves and relabels the same marker, never a second one', () => {
        const { view, live } = mountPin({ place: pin('Port Kittiwake', PORT_KITTIWAKE) });
        const first = live()[0];
        view.rerender({ place: pin('Horta', { lat: 38.53, lon: -28.63 }), ready: true });
        expect(live()).toEqual([first]);
        expect(first.lngLat).toEqual([-28.63, 38.53]);
        expect(first.element.querySelector('.obs-place-pin__label')?.textContent).toBe('Horta');
        expect(first.element.getAttribute('aria-label')).toBe('Horta, the place you chose. Show its weather');
        expect(markers.all.filter((marker) => marker.element.classList.contains('obs-place-pin'))).toHaveLength(1);
    });

    it('Current Location, Obs hidden or a MOB (MapHub passes no place): removed, then back', () => {
        const place = pin('Port Kittiwake', PORT_KITTIWAKE);
        const { view, live } = mountPin({ place });
        view.rerender({ place: null, ready: true });
        expect(live()).toHaveLength(0);
        view.rerender({ place, ready: true });
        expect(live()).toHaveLength(1);
        expect(live()[0].lngLat).toEqual([PORT_KITTIWAKE.lon, PORT_KITTIWAKE.lat]);
        view.unmount();
        expect(live()).toHaveLength(0);
    });

    it('waits for the map', () => {
        const { view, live } = mountPin({ place: pin('Port Kittiwake', PORT_KITTIWAKE), ready: false });
        expect(live()).toHaveLength(0);
        view.rerender({ place: pin('Port Kittiwake', PORT_KITTIWAKE), ready: true });
        expect(live()).toHaveLength(1);
    });

    it('the boat arriving within 250 m: gone at the next 5 s recheck, back when she leaves', () => {
        const place = pin('Port Kittiwake', PORT_KITTIWAKE);
        const { live } = mountPin({ place });
        expect(live()).toHaveLength(1);
        boatLive(north(PORT_KITTIWAKE, 120));
        act(() => vi.advanceTimersByTime(PLACE_PIN_RECHECK_MS));
        expect(live()).toHaveLength(0);
        boatLive(KITTIWAKE);
        act(() => vi.advanceTimersByTime(PLACE_PIN_RECHECK_MS));
        expect(live()).toHaveLength(1);
    });

    it('the phone’s live fix on the place hides it too (its mark stands there)', () => {
        phoneLive(north(PORT_KITTIWAKE, 30));
        const { live } = mountPin({ place: pin('Port Kittiwake', PORT_KITTIWAKE) });
        expect(live()).toHaveLength(0);
    });

    it('a tap opens the weather for the TRUE point, its bubble on the pin, once, and never reaches the map', () => {
        const polar = placePinPoint({ defaultLocation: 'Polar Camp', defaultLocationCoords: { lat: 88, lon: 30 } })!;
        const { live, attach, mapClick, onTap } = mountPin({ place: polar });
        attach();
        expect(live()[0].lngLat).toEqual([30, 85]);
        live()[0].element.click();
        // The weather asked for at the true point; the bubble and its spot on the pin, at 85°.
        expect(onTap).toHaveBeenCalledExactlyOnceWith(88, 30, { lat: 85, lon: 30 });
        expect(mapClick).not.toHaveBeenCalled();
    });
});

describe('stacking (index.css)', () => {
    /** Each rule's own selectors and body (an @media block's inner rules included). */
    const rules = readFileSync('index.css', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('}')
        .map((chunk) => {
            const open = chunk.lastIndexOf('{');
            if (open < 0) return null;
            const head = chunk.slice(0, open);
            return {
                selectors: head
                    .slice(head.lastIndexOf('{') + 1)
                    .split(',')
                    .map((selector) => selector.trim()),
                body: chunk.slice(open + 1),
            };
        })
        .filter((rule): rule is { selectors: string[]; body: string } => rule !== null);
    const zOf = (selector: string) => {
        for (const rule of rules) {
            if (!rule.selectors.includes(selector)) continue;
            const z = /z-index:\s*(\d+)/.exec(rule.body);
            if (z) return Number(z[1]);
        }
        return null;
    };

    it('the pin under the boat and the phone, all three under the bubbles; the MOB datum and the inspect spot on top', () => {
        expect(zOf('.obs-place-pin')).toBe(1);
        expect(zOf('.vessel-tracker-marker')).toBe(2);
        expect(zOf('.loc-dot')).toBe(2);
        expect(zOf('.mob-marker')).toBe(3);
        expect(zOf('.weather-inspect-spot')).toBe(3);
        expect(zOf('.mapboxgl-popup')).toBe(500);
        expect(zOf('.weather-inspect-popup')).toBe(10000);
    });
});
