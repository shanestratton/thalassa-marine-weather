/**
 * obsCentre's words and the phone's last fix (Shane 2026-10-06: "If there is
 * no gps from their phone then the last known location with a clear message
 * telling them that").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GpsPosition } from '../services/GpsService';
import type { BoatFix } from '../services/boatPositionChain';

const deps = vi.hoisted(() => ({
    lastKnown: null as GpsPosition | null,
    location: { lat: -27.47, lon: 153.02, source: 'initial', timestamp: 0 } as {
        lat: number;
        lon: number;
        source: string;
        timestamp: number;
    },
    // The boat's rungs (126-18: a place tap supersedes a boat tap still looking).
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
vi.mock('../services/GpsService', () => ({
    GpsService: { getLastKnownPosition: () => deps.lastKnown, getCurrentPositionIfGranted: vi.fn(async () => null) },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: { getState: () => deps.location, subscribe: () => () => {} },
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}), subscribe: () => () => {} } }));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    PHONE_REMEMBER_MIN_INTERVAL_MS,
    __resetPhoneLastFixForTests,
    rememberPhoneFix,
    storedPhoneFix,
} from '../services/phoneLastFix';
import {
    __resetObsCentreForTests,
    getObsCentreNotice,
    humanFixAge,
    obsBoatLabel,
    obsCentreNoticeText,
    phoneFixNow,
    showObsCentreNotice,
    clearObsCentreNotice,
    subscribeObsCentreNotice,
    locateOnObs,
    locatePlace,
    locateVessel,
    obsFlyTo,
    type ObsCentreNotice,
} from '../components/map/obsCentre';
import { obsStartTarget, useObsStartupCamera } from '../components/map/useObsStartupCamera';
import { NO_CAMERA_PADDING, clearCameraPadding } from '../components/map/cameraPadding';
import type mapboxgl from 'mapbox-gl';
import { WEATHER_FOLLOW_TARGET_EVENT, __resetWeatherPositionForTests } from '../services/weatherPosition';

/** Local clock times, so the words do not depend on the machine's time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(6, 12); // Tue 6 Oct, 12:00
const pos = (lat: number, lon: number, timestamp: number) => ({ latitude: lat, longitude: lon, timestamp });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    setAuthIdentityScope('owner-ss');
    __resetPhoneLastFixForTests();
    __resetObsCentreForTests();
    deps.lastKnown = null;
    deps.location = { lat: -27.47, lon: 153.02, source: 'initial', timestamp: NOW };
});
afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('a fix’s age in words', () => {
    it.each([
        [NOW - 20_000, 'just now'],
        [NOW - 12 * 60_000, '12 min ago'],
        [NOW - 3 * 3_600_000, '3 h ago'],
        [NOW - 11 * 3_600_000 - 59 * 60_000, '11 h ago'],
        [at(6, 0, 0), 'today 00:00'],
        [at(5, 16, 40), 'yesterday 16:40'],
        [at(3, 9, 5), 'Sat 09:05'],
        [at(12, 9, 5) - 30 * 86_400_000, '12 Sep'],
    ])('%s → %s', (timestamp, words) => {
        expect(humanFixAge(timestamp, NOW)).toBe(words);
    });

    it('a clock a little ahead is just now', () => {
        expect(humanFixAge(NOW + 3_000, NOW)).toBe('just now');
    });
});

describe('the message', () => {
    const notice = (patch: Partial<ObsCentreNotice>): ObsCentreNotice => ({
        id: 1,
        subject: { kind: 'boat', crewOwnerId: null },
        state: 'held',
        at: NOW - 3 * 3_600_000,
        permission: null,
        ...patch,
    });
    const names = { own: 'Serene Summer', crew: { ownerId: 'skipper-wd', name: 'Wind Dancer' } };

    it('names the boat and the age', () => {
        expect(obsCentreNoticeText(notice({}), names, NOW)).toBe(
            "Showing Serene Summer's last known position · 3 h ago",
        );
        expect(obsCentreNoticeText(notice({ state: 'none', at: null }), names, NOW)).toBe(
            'No position from Serene Summer yet',
        );
    });

    it('an unnamed boat is "your boat"; an unnamed crewed boat is "your skipper’s boat"', () => {
        const none = { own: null, crew: null };
        expect(obsCentreNoticeText(notice({}), none, NOW)).toBe(
            'Showing the last known position of your boat · 3 h ago',
        );
        const crewed = notice({ subject: { kind: 'boat', crewOwnerId: 'skipper-wd' }, at: at(5, 16, 40) });
        expect(obsCentreNoticeText(crewed, names, NOW)).toBe(
            "Showing Wind Dancer's last known position · yesterday 16:40",
        );
        expect(obsCentreNoticeText(crewed, none, NOW)).toBe(
            "Showing the last known position of your skipper's boat · yesterday 16:40",
        );
        // Another skipper's name is never borrowed.
        expect(
            obsCentreNoticeText(
                { ...crewed, state: 'none', at: null },
                { own: null, crew: { ownerId: 'x', name: 'Tern' } },
                NOW,
            ),
        ).toBe("No position from your skipper's boat yet");
        expect(obsBoatLabel(null, { own: '  ', crew: null })).toBe('your boat');
    });

    it('the phone: where you were, or why there is nothing', () => {
        const phone = { kind: 'phone' as const };
        expect(obsCentreNoticeText(notice({ subject: phone, at: NOW - 2 * 3_600_000 }), names, NOW)).toBe(
            'Phone GPS unavailable · showing where you were 2 h ago',
        );
        expect(
            obsCentreNoticeText(notice({ subject: phone, state: 'none', at: null, permission: 'denied' }), names, NOW),
        ).toBe('Phone GPS unavailable: allow location to centre here');
        expect(
            obsCentreNoticeText(notice({ subject: phone, state: 'none', at: null, permission: 'granted' }), names, NOW),
        ).toBe('Phone GPS unavailable: no fix yet');
    });

    it('is one at a time, cleared by id or by subject, and dropped on an account change', () => {
        const first = showObsCentreNotice({ subject: { kind: 'phone' }, state: 'none', at: null });
        const second = showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        expect(getObsCentreNotice()?.id).toBe(second);
        clearObsCentreNotice(first);
        expect(getObsCentreNotice()?.id).toBe(second);
        clearObsCentreNotice({ kind: 'phone' });
        expect(getObsCentreNotice()?.id).toBe(second);
        clearObsCentreNotice({ kind: 'boat', crewOwnerId: 'skipper-wd' });
        expect(getObsCentreNotice()?.id).toBe(second);
        clearObsCentreNotice({ kind: 'boat', crewOwnerId: null });
        expect(getObsCentreNotice()).toBeNull();
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW });
        setAuthIdentityScope('someone-else');
        expect(getObsCentreNotice()).toBeNull();
    });

    it('the same words again keep the standing message (said once)', () => {
        const heard = vi.fn();
        const stop = subscribeObsCentreNotice(heard);
        const first = showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW });
        expect(showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW })).toBe(
            first,
        );
        expect(heard).toHaveBeenCalledTimes(1);
        expect(
            showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW - 1 }),
        ).not.toBe(first);
        stop();
    });

    // Switch boat, or the crewing ending, while Obs shows a settled camera
    // (review 2026-10-06): the words would fall back to "your skipper's boat".
    it('a crewed boat’s message goes once she is neither followed nor crewed on', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: 'skipper-wd' }, state: 'held', at: NOW });
        window.dispatchEvent(new CustomEvent(WEATHER_FOLLOW_TARGET_EVENT));
        expect(getObsCentreNotice()).toBeNull();
        // The own boat's message is about her whatever the box follows.
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW });
        window.dispatchEvent(new CustomEvent(WEATHER_FOLLOW_TARGET_EVENT));
        expect(getObsCentreNotice()).not.toBeNull();
    });
});

describe('the phone’s position this device holds', () => {
    it('is the newer of the watch tap and the kept fix, each dated by the fix itself', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW - 3_600_000), NOW - 3_600_000);
        expect(phoneFixNow(NOW)).toEqual({ lat: -27.1, lon: 153.1, timestamp: NOW - 3_600_000, live: false });
        deps.lastKnown = { ...pos(-27.3, 153.3, NOW - 1_000), accuracy: 5, altitude: null, heading: null, speed: 0 };
        expect(phoneFixNow(NOW)).toMatchObject({ lat: -27.3, live: true });
        // A minute on, the same fix is last known, not live.
        expect(phoneFixNow(NOW + 61_000)).toMatchObject({ lat: -27.3, live: false });
    });

    // LocationStore dates its GPS entry by the write, and an account change
    // re-stamps it (review 2026-10-06): an hours-old fix would pass for live.
    it('never takes LocationStore’s entry, whatever it says', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW - 2 * 3_600_000), NOW - 2 * 3_600_000);
        deps.location = { lat: -27.2, lon: 153.2, source: 'gps', timestamp: NOW };
        expect(phoneFixNow(NOW)).toEqual({ lat: -27.1, lon: 153.1, timestamp: NOW - 2 * 3_600_000, live: false });
        for (const source of ['initial', 'search', 'favorite', 'map_pin']) {
            deps.location = { lat: -27.2, lon: 153.2, source, timestamp: NOW };
            expect(phoneFixNow(NOW)?.lat).toBe(-27.1);
        }
    });

    it('can leave the kept fix out (live checks)', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW - 10_000), NOW - 10_000);
        expect(phoneFixNow(NOW, { stored: false })).toBeNull();
    });
});

describe('the phone’s last fix, kept across relaunches', () => {
    it('is kept per account', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW), NOW);
        expect(storedPhoneFix(NOW)).toEqual({ lat: -27.1, lon: 153.1, timestamp: NOW });
        expect(localStorage.getItem(authScopedStorageKey('thalassa_last_phone_fix'))).not.toBeNull();
        setAuthIdentityScope('someone-else');
        expect(storedPhoneFix(NOW)).toBeNull();
    });

    it('rewrites when the phone moves or a minute passes, not on every still fix', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW), NOW);
        rememberPhoneFix(pos(-27.10001, 153.10001, NOW + 1_000), NOW + 1_000); // ~1.5 m
        expect(storedPhoneFix(NOW + 1_000)?.timestamp).toBe(NOW);
        rememberPhoneFix(pos(-27.101, 153.1, NOW + 2_000), NOW + 2_000); // ~110 m
        expect(storedPhoneFix(NOW + 2_000)?.timestamp).toBe(NOW + 2_000);
        const later = NOW + 2_000 + PHONE_REMEMBER_MIN_INTERVAL_MS;
        rememberPhoneFix(pos(-27.101, 153.1, later), later);
        expect(storedPhoneFix(later)?.timestamp).toBe(later);
    });

    it('ignores unusable or older fixes and never throws', () => {
        rememberPhoneFix(pos(-27.1, 153.1, NOW), NOW);
        for (const bad of [
            pos(91, 0, NOW + 1),
            pos(0, 0, NOW + 1),
            pos(-27, 153, NOW + 60_000),
            pos(-26, 152, NOW - 1),
        ])
            rememberPhoneFix(bad, NOW);
        rememberPhoneFix(null, NOW);
        expect(storedPhoneFix(NOW)).toEqual({ lat: -27.1, lon: 153.1, timestamp: NOW });
        localStorage.setItem(authScopedStorageKey('thalassa_last_phone_fix'), '{not json');
        expect(storedPhoneFix(NOW)).toBeNull();
    });
});

/**
 * A map that keeps its padding as Mapbox GL 3 does, and logs each camera call
 * in order. PLAN_CARD is what Plan's route fit (fitTraceBounds) left on the
 * shared map before build 124.
 */
const PLAN_CARD = { top: 90, bottom: 130, left: 300, right: 40 };
function paddedMap(padding: Partial<typeof PLAN_CARD> = PLAN_CARD) {
    const state = { padding: { ...NO_CAMERA_PADDING, ...padding } };
    const calls: Array<[string, unknown]> = [];
    const map = {
        getPadding: () => ({ ...state.padding }),
        setPadding: vi.fn((next: typeof PLAN_CARD) => {
            calls.push(['setPadding', next]);
            state.padding = { ...next };
        }),
        flyTo: vi.fn((options: unknown) => calls.push(['flyTo', options])),
        jumpTo: vi.fn((options: unknown) => calls.push(['jumpTo', options])),
    };
    return { map, calls, state, as: map as unknown as mapboxgl.Map };
}

describe('Obs never flies under a padding another surface left (build 124)', () => {
    // Shane 2026-10-08: "when i click the locate fab, it goes to the first
    // image which is not centred". The flight named no padding, so Mapbox
    // reused Plan's and put her 130 pt right of centre.
    it('Locate clears the padding, then flies to the fix at the canvas centre', async () => {
        // A phone in Lisbon (the button is the same for every coast).
        deps.lastKnown = { ...pos(38.69, -9.22, NOW - 1_000), accuracy: 5, altitude: null, heading: null, speed: 0 };
        const { as, calls, state } = paddedMap();
        const outcome = await locateOnObs(as, { kind: 'phone' }, { own: null, crew: null }, 14);
        expect(calls).toEqual([
            ['setPadding', { top: 0, right: 0, bottom: 0, left: 0 }],
            ['flyTo', { center: [-9.22, 38.69], zoom: 14, duration: 1200 }],
        ]);
        expect(state.padding).toEqual(NO_CAMERA_PADDING);
        expect(outcome).toEqual({ centred: true, announcement: 'Chart centred on your position.' });
    });

    it('a map with no padding is not touched first (no extra camera events)', () => {
        const { as, calls, map } = paddedMap({});
        obsFlyTo(as, { lat: 21.3, lon: -157.86 }, 14);
        expect(map.setPadding).not.toHaveBeenCalled();
        expect(calls).toEqual([['flyTo', { center: [-157.86, 21.3], zoom: 14, duration: 1200 }]]);
    });

    it('any side counts, and a map without getPadding (a test double, an old map) is simply flown', () => {
        const { as, map } = paddedMap({ bottom: 130 });
        expect(clearCameraPadding(as)).toBe(true);
        expect(map.setPadding).toHaveBeenCalledExactlyOnceWith({ top: 0, right: 0, bottom: 0, left: 0 });
        expect(clearCameraPadding(as)).toBe(false);
        const flyTo = vi.fn();
        expect(clearCameraPadding({ flyTo } as unknown as mapboxgl.Map)).toBe(false);
        obsFlyTo({ flyTo } as unknown as mapboxgl.Map, { lat: -36.84, lon: 174.76 }, 14);
        expect(flyTo).toHaveBeenCalledExactlyOnceWith({ center: [174.76, -36.84], zoom: 14, duration: 1200 });
    });

    it('a map that went away meanwhile does not throw', () => {
        const gone = {
            getPadding: () => {
                throw new Error('map removed');
            },
        } as unknown as mapboxgl.Map;
        expect(clearCameraPadding(gone)).toBe(false);
    });
});

/**
 * Locate to the place chosen in the location box (126-18). Shane 2026-10-09:
 * "if it isnt the vessel location or the phone location, can we have a pin in
 * the location and that is where the locate fab goes to on the obs page".
 * Fictional places; the boat is "Kittiwake".
 */
describe('Locate to the chosen place (locatePlace)', () => {
    const PORT_KITTIWAKE = { lat: -16.48, lon: 145.46, name: 'Port Kittiwake' };
    const KITTIWAKE_NAMES = { own: 'Kittiwake', crew: null };

    /** paddedMap, with the event methods the startup camera listens through. */
    function cameraMap(padding: Partial<typeof PLAN_CARD> = {}) {
        const listeners = new Map<string, Set<(event?: unknown) => void>>();
        const padded = paddedMap(padding);
        Object.assign(padded.map, {
            on: vi.fn((name: string, listener: (event?: unknown) => void) => {
                const set = listeners.get(name) ?? new Set();
                set.add(listener);
                listeners.set(name, set);
            }),
            off: vi.fn((name: string, listener: (event?: unknown) => void) => {
                listeners.get(name)?.delete(listener);
            }),
        });
        return padded;
    }

    beforeEach(() => {
        __resetWeatherPositionForTests();
        deps.busFix.mockImplementation(() => null);
        deps.piFix.mockImplementation(async () => null);
        deps.cloudFix.mockImplementation(async () => null);
        deps.deviceRungOwner.mockImplementation(() => null);
    });

    it('flies after the tap returns, to the place at the given zoom, on the whole canvas', async () => {
        const { as, calls, map } = paddedMap();
        const answer = locatePlace(as, PORT_KITTIWAKE, 10);
        // Not yet: the button must hear the flight as this tap's (MapActionFabs).
        expect(map.flyTo).not.toHaveBeenCalled();
        const outcome = await answer;
        expect(calls).toEqual([
            ['setPadding', { top: 0, right: 0, bottom: 0, left: 0 }],
            ['flyTo', { center: [145.46, -16.48], zoom: 10, duration: 1200 }],
        ]);
        expect(outcome).toEqual({ centred: true, announcement: 'Chart centred on Port Kittiwake.' });
    });

    it('needs no fix and no network: it works offline', async () => {
        const { as, map } = paddedMap({});
        await locatePlace(as, PORT_KITTIWAKE, 10);
        expect(map.flyTo).toHaveBeenCalledOnce();
        expect(deps.piFix).not.toHaveBeenCalled();
        expect(deps.cloudFix).not.toHaveBeenCalled();
    });

    it('clears a standing message: it no longer describes the chart', async () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'held', at: NOW - 3_600_000 });
        expect(obsCentreNoticeText(getObsCentreNotice()!, KITTIWAKE_NAMES, NOW)).toBe(
            "Showing Kittiwake's last known position · 1 h ago",
        );
        const { as } = paddedMap({});
        await locatePlace(as, PORT_KITTIWAKE, 10);
        expect(getObsCentreNotice()).toBeNull();
    });

    it('claims the camera: a name-only startup centring still resolving settles and never jumps later', async () => {
        const { as, map } = cameraMap();
        const mapRef = { current: as };
        const view = renderHook(({ target }) => useObsStartupCamera(mapRef, true, true, target), {
            initialProps: { target: obsStartTarget({ defaultLocation: 'Port Kittiwake' }) },
        });
        expect(map.jumpTo).not.toHaveBeenCalled();
        await locatePlace(as, PORT_KITTIWAKE, 10);
        // The name resolves after the tap: the skipper's flight stands.
        view.rerender({
            target: obsStartTarget({ defaultLocation: 'Port Kittiwake', weatherCoords: { lat: -16.5, lon: 145.5 } }),
        });
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(map.flyTo).toHaveBeenCalledOnce();
        view.unmount();
    });

    it('a place tap after a boat tap still looking: her late answer resolves null and never flies', async () => {
        let answer!: (fix: BoatFix | null) => void;
        deps.piFix.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
        const { as, map } = paddedMap({});
        const boat = locateVessel(as, null, KITTIWAKE_NAMES, 14);
        await vi.advanceTimersByTimeAsync(0);
        expect(deps.piFix).toHaveBeenCalledOnce();
        const place = await locatePlace(as, PORT_KITTIWAKE, 10);
        expect(place).toEqual({ centred: true, announcement: 'Chart centred on Port Kittiwake.' });
        answer({ latitude: -16.2, longitude: 145.7, timestamp: Date.now(), rung: 'pi', source: 'ydwg-tcp.YD' });
        expect(await boat).toBeNull();
        expect(map.flyTo).toHaveBeenCalledExactlyOnceWith({ center: [145.46, -16.48], zoom: 10, duration: 1200 });
    });

    it('across the antimeridian: flyTo is given the place itself (Mapbox takes the short way)', async () => {
        const { as, map } = paddedMap({});
        await locatePlace(as, { lat: -16.78, lon: 179.999, name: 'Savusavu' }, 10);
        await locatePlace(as, { lat: -16.78, lon: -179.999, name: 'Savusavu, east' }, 10);
        expect(map.flyTo.mock.calls.map(([options]) => (options as { center: number[] }).center)).toEqual([
            [179.999, -16.78],
            [-179.999, -16.78],
        ]);
    });

    it('locateOnObs routes a place stop to locatePlace at the place zoom, and the others exactly as before', async () => {
        const { as, map } = paddedMap({});
        const outcome = await locateOnObs(
            as,
            { kind: 'place', lat: -36.84, lon: 174.76, name: 'Viaduct Harbour' },
            KITTIWAKE_NAMES,
            14,
            10,
        );
        expect(outcome).toEqual({ centred: true, announcement: 'Chart centred on Viaduct Harbour.' });
        expect(map.flyTo).toHaveBeenLastCalledWith({ center: [174.76, -36.84], zoom: 10, duration: 1200 });
        // The phone, as it always was: the fix zoom.
        deps.lastKnown = { ...pos(38.53, -28.63, NOW - 1_000), accuracy: 5, altitude: null, heading: null, speed: 0 };
        expect(await locateOnObs(as, { kind: 'phone' }, KITTIWAKE_NAMES, 14, 10)).toEqual({
            centred: true,
            announcement: 'Chart centred on your position.',
        });
        expect(map.flyTo).toHaveBeenLastCalledWith({ center: [-28.63, 38.53], zoom: 14, duration: 1200 });
        // The boat, as it always was.
        deps.busFix.mockImplementation(() => ({
            latitude: -16.2,
            longitude: 145.7,
            timestamp: Date.now(),
            rung: 'bus',
            source: 'nmea-gateway',
        }));
        expect(await locateOnObs(as, { kind: 'boat', crewOwnerId: null }, KITTIWAKE_NAMES, 14, 10)).toEqual({
            centred: true,
            announcement: 'Chart centred on Kittiwake.',
        });
        expect(map.flyTo).toHaveBeenLastCalledWith({ center: [145.7, -16.2], zoom: 14, duration: 1200 });
        // A place stop with no place zoom given flies at the one zoom passed.
        await locateOnObs(as, { kind: 'place', lat: 38.53, lon: -28.63, name: 'Horta' }, KITTIWAKE_NAMES, 12);
        expect(map.flyTo).toHaveBeenLastCalledWith({ center: [-28.63, 38.53], zoom: 12, duration: 1200 });
    });
});
