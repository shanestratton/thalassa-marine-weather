/**
 * Where the weather is FOR.
 *
 * 2026-09-06 (Shane, after driving to his daughter's with the forecast
 * following his phone): "boat GPS followed by u-blox GPS and finally phone
 * gps", and when she goes quiet, "hold her last fix. with a message of course."
 * 2026-09-08: "the weather should always be the punters location, BUT in the
 * saved locations, there should be one that has the vessel name as a special
 * saved location." So the PHONE is the default and the boat's order applies
 * when her row is picked — and nothing asks any more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage, selectCrewVessel } from '../services/vessel/sharedBinders';

const chain = vi.hoisted(() => ({
    busFix: vi.fn<() => import('../services/boatPositionChain').BoatFix | null>(() => null),
    piFix: vi.fn<() => Promise<import('../services/boatPositionChain').BoatFix | null>>(async () => null),
    cloudFix: vi.fn<(now?: number, owner?: string) => Promise<import('../services/boatPositionChain').BoatFix | null>>(
        async () => null,
    ),
    deviceRungOwner: vi.fn<(rung: 'bus' | 'pi') => string | null>(() => null),
}));
vi.mock('../services/boatPositionChain', () => ({
    busFix: chain.busFix,
    piFix: chain.piFix,
    cloudFix: chain.cloudFix,
    deviceRungOwner: chain.deviceRungOwner,
    CLOUD_FIX_MAX_AGE_MS: 60_000,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    ASK_DISTANCE_NM,
    CLOUD_POLL_MS,
    PI_POLL_MS,
    __resetWeatherPositionForTests,
    boatOrHeldFix,
    describeWeatherFix,
    formatFixAge,
    getHeldChoice,
    getWeatherFollowCrewOwner,
    getWeatherFollowTarget,
    heldBoatFix,
    WEATHER_FOLLOW_TARGET_EVENT,
    resolveWeatherPosition,
    setHeldChoice,
    setWeatherFollowTarget,
    rememberBoatFix,
    weatherFixStatus,
} from '../services/weatherPosition';

const T0 = Date.UTC(2026, 8, 6, 0, 30, 0); // 10:30 AEST, the boat on the hard at Scarborough
const SCARBOROUGH = { latitude: -27.2, longitude: 153.11 };
const DAUGHTERS = { lat: -27.47, lon: 153.02 }; // ~17 NM away
const bus = (timestamp = T0) => ({ ...SCARBOROUGH, timestamp, rung: 'bus' as const, source: 'nmea-gateway' });
const pi = (source = 'ydwg-tcp.YD', timestamp = T0) => ({ ...SCARBOROUGH, timestamp, rung: 'pi' as const, source });
const cloud = (timestamp = T0) => ({ ...SCARBOROUGH, timestamp, rung: 'cloud' as const, source: 'pi-cloud' });
const phoneAt = (lat: number, lon: number, timestamp = T0) => vi.fn(async () => ({ lat, lon, timestamp }));
const noPhone = () => vi.fn(async () => null);

describe('where the weather is for', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        localStorage.clear();
        setAuthIdentityScope(null);
        vi.clearAllMocks();
        chain.busFix.mockImplementation(() => null);
        chain.piFix.mockImplementation(async () => null);
        chain.cloudFix.mockImplementation(async () => null);
        chain.deviceRungOwner.mockImplementation(() => null);
        __resetWeatherPositionForTests();
        // Most of this suite is about the BOAT's order — the skipper has picked
        // her row. The default is tested on its own below.
        setWeatherFollowTarget('boat');
    });
    afterEach(() => vi.useRealTimers());

    describe('the default is the punter — the phone (Shane 2026-09-08)', () => {
        beforeEach(() => localStorage.clear());

        it('a fresh device follows the phone', () => {
            expect(getWeatherFollowTarget()).toBe('phone');
        });

        it('the phone answers even with the boat reporting — her receivers are not consulted', async () => {
            chain.busFix.mockImplementation(() => bus());
            const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon);
            const r = await resolveWeatherPosition(phone, { now: T0 });
            expect(r.fix).toMatchObject({ kind: 'phone', lat: DAUGHTERS.lat });
            expect(r.ask).toBe(false);
            expect(chain.busFix).not.toHaveBeenCalled();
            expect(chain.piFix).not.toHaveBeenCalled();
        });

        it('a phone that cannot answer stays unavailable, even with a live or held boat fix', async () => {
            chain.busFix.mockImplementation(() => bus());
            rememberBoatFix(bus(), T0);
            const live = await resolveWeatherPosition(noPhone(), { now: T0 });
            expect(live.fix).toBeNull();
            chain.busFix.mockImplementation(() => null);
            const held = await resolveWeatherPosition(noPhone(), { now: T0 + 3600_000 });
            expect(held.fix).toBeNull();
            expect(held.held).toBeNull();
            expect(held.ask).toBe(false);
            expect(chain.busFix).not.toHaveBeenCalled();
            expect(chain.piFix).not.toHaveBeenCalled();
            expect(chain.cloudFix).not.toHaveBeenCalled();
        });

        it('picking the boat is remembered per account; picking the phone puts it back', () => {
            setWeatherFollowTarget('boat');
            expect(getWeatherFollowTarget()).toBe('boat');
            setWeatherFollowTarget('phone');
            expect(getWeatherFollowTarget()).toBe('phone');
        });

        it('keeps an explicit boat choice in session when storage cannot write, and never leaks it to another account', () => {
            const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('quota');
            });
            try {
                setWeatherFollowTarget('boat');
                expect(getWeatherFollowTarget()).toBe('boat');
                setAuthIdentityScope('other-skipper');
                expect(getWeatherFollowTarget()).toBe('phone');
            } finally {
                writes.mockRestore();
            }
        });

        it('keeps the selected source if reading storage fails after a successful write', () => {
            setWeatherFollowTarget('boat');
            const reads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
                throw new Error('blocked');
            });
            try {
                expect(getWeatherFollowTarget()).toBe('boat');
                setWeatherFollowTarget('phone');
                expect(getWeatherFollowTarget()).toBe('phone');
            } finally {
                reads.mockRestore();
            }
        });

        it('a caller may name the target outright', async () => {
            chain.busFix.mockImplementation(() => bus());
            const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon), { now: T0, target: 'boat' });
            expect(r.fix?.kind).toBe('bus');
        });
    });

    it('the bus first — and the phone is not even asked', async () => {
        chain.busFix.mockImplementation(() => bus());
        const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon);
        const r = await resolveWeatherPosition(phone, { now: T0 });
        expect(r.fix).toMatchObject({ kind: 'bus', lat: SCARBOROUGH.latitude, lon: SCARBOROUGH.longitude });
        expect(r.ask).toBe(false);
        expect(phone).not.toHaveBeenCalled();
        expect(chain.piFix).not.toHaveBeenCalled();
    });

    it('remembers a live boat fix under the account-scoped key', async () => {
        chain.busFix.mockImplementation(() => bus());
        await boatOrHeldFix(T0);
        // Through the Storage API (length / key), not Object.keys (2026-09-30):
        // under Node 26 the suite runs on tests/setup.ts's in-memory Storage
        // shim, whose keys are not own properties, so Object.keys listed none
        // and this failed while Node 24 (CI) passed on jsdom's own storage.
        const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
        const keys = stored.filter((k): k is string => !!k && k.startsWith('thalassa_weather_last_boat_fix'));
        expect(keys).toHaveLength(1);
        expect(keys[0]).toContain('::');
        expect(heldBoatFix()).toMatchObject({ kind: 'held', timestamp: T0, rung: 'bus' });
    });

    it('then the Pi, which already chose between the bus and the u-blox stick', async () => {
        chain.piFix.mockImplementation(async () => pi('ublox-gps.GP'));
        const r = await resolveWeatherPosition(noPhone(), { now: T0 });
        expect(r.fix).toMatchObject({ kind: 'pi', source: 'ublox-gps.GP' });
        expect(describeWeatherFix(r.fix, T0)).toBe('USB GPS (Pi) · live');
    });

    it('then the Pi’s cloud row — the boat from a distance — before her held fix, and before the phone', async () => {
        // Shane 2026-09-07: the Glass read PHONE at Newport while the Pi was
        // publishing from the hardstand. The weather is for the boat.
        chain.cloudFix.mockImplementation(async () => cloud());
        const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon);
        const r = await resolveWeatherPosition(phone, { now: T0 });
        expect(r.fix?.kind).toBe('cloud');
        expect(r.fix?.lat).toBe(SCARBOROUGH.latitude);
        expect(r.ask).toBe(false);
        expect(phone).not.toHaveBeenCalled();
        // …and she is remembered, so the hold has her when the cloud goes quiet too.
        expect(heldBoatFix()?.rung).toBe('cloud');
        expect(describeWeatherFix(r.fix!, T0)).toBe('Boat GPS (via cloud) · live');
    });

    it('asks the cloud at most once per poll window, and never when the Pi answered direct', async () => {
        chain.cloudFix.mockImplementation(async () => cloud());
        await boatOrHeldFix(T0);
        await boatOrHeldFix(T0 + 1_000);
        expect(chain.cloudFix).toHaveBeenCalledTimes(1);
        await boatOrHeldFix(T0 + CLOUD_POLL_MS);
        expect(chain.cloudFix).toHaveBeenCalledTimes(2);
        chain.piFix.mockImplementation(async () => pi('ydwg-tcp.YD', T0 + CLOUD_POLL_MS * 3));
        await boatOrHeldFix(T0 + CLOUD_POLL_MS * 3);
        expect(chain.cloudFix).toHaveBeenCalledTimes(2);
    });

    it('asks the Pi at most once per poll window, whatever the tick rate', async () => {
        chain.piFix.mockImplementation(async () => pi());
        for (let i = 0; i < 6; i++) await boatOrHeldFix(T0 + i * 5_000);
        expect(chain.piFix).toHaveBeenCalledTimes(1);
        await boatOrHeldFix(T0 + PI_POLL_MS + 1);
        expect(chain.piFix).toHaveBeenCalledTimes(2);
    });

    it('a boat selection on a device that has never seen the boat stays unavailable, without asking the phone', async () => {
        const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon);
        const r = await resolveWeatherPosition(phone, { now: T0 });
        expect(r.fix).toBeNull();
        expect(r.held).toBeNull();
        expect(r.ask).toBe(false);
        expect(phone).not.toHaveBeenCalled();
        expect(describeWeatherFix(r.fix, T0, 'boat')).toBe('Boat GPS unavailable');
    });

    it('nothing at all → null, never a throw', async () => {
        const r = await resolveWeatherPosition(noPhone(), { now: T0 });
        expect(r.fix).toBeNull();
        const throwing = vi.fn(async () => {
            throw new Error('geolocation exploded');
        });
        expect((await resolveWeatherPosition(throwing, { now: T0 })).fix).toBeNull();
    });

    describe('when the boat goes quiet', () => {
        const later = T0 + 3 * 3600_000;

        beforeEach(async () => {
            chain.busFix.mockImplementation(() => bus());
            await boatOrHeldFix(T0); // she reported this morning …
            chain.busFix.mockImplementation(() => null); // … and has been quiet since
        });

        it('holds her last fix with its age, and does not ask while the phone is aboard', async () => {
            const aboard = phoneAt(SCARBOROUGH.latitude + 0.001, SCARBOROUGH.longitude, later);
            const r = await resolveWeatherPosition(aboard, { now: later });
            expect(r.fix).toMatchObject({ kind: 'held', lat: SCARBOROUGH.latitude, timestamp: T0 });
            expect(r.ask).toBe(false);
            expect(describeWeatherFix(r.fix, later)).toBe("Boat's last fix · 3h ago");
        });

        it('still holds her when the phone is clearly somewhere else — and does not ask (the choice is her row)', async () => {
            const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later);
            const r = await resolveWeatherPosition(phone, { now: later });
            expect(r.fix?.kind).toBe('held');
            expect(r.held?.timestamp).toBe(T0);
            expect(r.ask).toBe(false);
            expect(phone).not.toHaveBeenCalled();
        });

        it('the asking distance survives for the dialog copy, a couple of miles not a car park', () => {
            expect(ASK_DISTANCE_NM).toBe(2);
        });

        it('"hold the boat" stands for this fix: no more asking, no phone consulted', async () => {
            const held = heldBoatFix()!;
            setHeldChoice(held, 'boat');
            const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later);
            const r = await resolveWeatherPosition(phone, { now: later });
            expect(r.fix?.kind).toBe('held');
            expect(r.ask).toBe(false);
            expect(phone).not.toHaveBeenCalled();
        });

        it('"follow my phone" never falls back to the boat when the phone cannot answer', async () => {
            setWeatherFollowTarget('phone');
            const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later), { now: later });
            expect(r.fix).toMatchObject({ kind: 'phone', lat: DAUGHTERS.lat });
            expect(r.ask).toBe(false);
            const dark = await resolveWeatherPosition(noPhone(), { now: later });
            expect(dark.fix).toBeNull();
        });

        it('boot and fetch paths (mayAsk: false) hold her without touching the phone', async () => {
            const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later);
            const r = await resolveWeatherPosition(phone, { now: later, mayAsk: false });
            expect(r.fix?.kind).toBe('held');
            expect(r.ask).toBe(false);
            expect(phone).not.toHaveBeenCalled();
        });

        it('when she reports again the weather goes back to her and the old answer is forgotten', async () => {
            const held = heldBoatFix()!;
            setHeldChoice(held, 'phone');
            chain.busFix.mockImplementation(() => bus(later));
            const live = await resolveWeatherPosition(noPhone(), { now: later });
            expect(live.fix?.kind).toBe('bus');
            expect(getHeldChoice(heldBoatFix()!)).toBeNull();
            // Quiet again, a new fix on record → she is held at the newer fix, no question.
            chain.busFix.mockImplementation(() => null);
            const again = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later + 1), {
                now: later + 1,
            });
            expect(again.held?.timestamp).toBe(later);
            expect(again.ask).toBe(false);
        });
    });

    it('says which receiver, in a skipper’s words', () => {
        expect(describeWeatherFix(null)).toBe('No position');
        expect(describeWeatherFix({ kind: 'bus', timestamp: T0 }, T0)).toBe('Boat GPS · live');
        expect(describeWeatherFix({ kind: 'pi', timestamp: T0, source: 'ydwg-tcp.YD' }, T0)).toBe(
            'Boat GPS (via Pi) · live',
        );
        expect(describeWeatherFix({ kind: 'held', timestamp: T0 }, T0 + 2 * 86400_000)).toBe(
            "Boat's last fix · 2d ago",
        );
        expect(formatFixAge(30_000)).toBe('just now');
        expect(formatFixAge(5 * 60_000)).toBe('5m ago');
    });

    it('keeps a cached phone fix honestly last-known, without replacing its timestamp', async () => {
        const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, T0 - 180_000), {
            now: T0,
            target: 'phone',
        });
        expect(r.fix).toMatchObject({ kind: 'phone', timestamp: T0 - 180_000 });
        expect(weatherFixStatus(r.fix, T0)).toBe('last-known');
        expect(describeWeatherFix(r.fix, T0, 'phone')).toBe("Phone's last fix · 3m ago");
        expect(describeWeatherFix(null, T0, 'phone')).toBe('Phone GPS unavailable');
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, T0 + 60_000])(
        'rejects invalid/future phone timestamp %s rather than making it current',
        async (timestamp) => {
            const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, timestamp), {
                now: T0,
                target: 'phone',
            });
            expect(r.fix).toBeNull();
            expect(chain.busFix).not.toHaveBeenCalled();
        },
    );

    it.each([
        { rung: 'cloud' as const, source: 'skipper-phone' },
        { rung: 'cloud' as const, source: 'device' },
        { rung: 'cloud' as const, source: null },
        { rung: 'pi' as const, source: 'phone-gps' },
        { rung: 'phone' as const, source: 'gps' },
    ])('never promotes a non-boat source into live or remembered boat GPS: %s', async (provenance) => {
        chain.cloudFix.mockResolvedValue({ ...cloud(), ...provenance });
        const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon), { now: T0 });
        expect(r.fix).toBeNull();
        expect(heldBoatFix()).toBeNull();
        localStorage.setItem(
            authScopedStorageKey('thalassa_weather_last_boat_fix'),
            JSON.stringify({
                lat: SCARBOROUGH.latitude,
                lon: SCARBOROUGH.longitude,
                timestamp: T0,
                ...provenance,
            }),
        );
        expect(heldBoatFix()).toBeNull();
    });

    it('rechecks a throttled cloud answer before calling it live', async () => {
        chain.cloudFix.mockResolvedValue(cloud(T0 - 55_000));
        expect((await boatOrHeldFix(T0))?.kind).toBe('cloud');
        const stale = await boatOrHeldFix(T0 + 10_000);
        expect(chain.cloudFix).toHaveBeenCalledTimes(1);
        expect(stale).toMatchObject({ kind: 'held', timestamp: T0 - 55_000 });
        expect(weatherFixStatus(stale, T0 + 10_000)).toBe('last-known');
    });

    it('rechecks the Pi cache age and does not refresh the receiver timestamp', async () => {
        chain.piFix.mockResolvedValue(pi('ublox-gps.GP', T0 - 55_000));
        expect((await boatOrHeldFix(T0))?.kind).toBe('pi');
        expect(await boatOrHeldFix(T0 + 10_000)).toMatchObject({ kind: 'held', timestamp: T0 - 55_000 });
        expect(chain.piFix).toHaveBeenCalledTimes(1);
    });

    it('an older known receiver answer is history, never a new live position', async () => {
        chain.piFix.mockResolvedValue(pi('ublox-gps.GP', T0 - 3600_000));
        expect(await boatOrHeldFix(T0)).toMatchObject({ kind: 'held', timestamp: T0 - 3600_000 });
    });

    it('re-ages the fix after a slow network response', async () => {
        let complete!: (fix: ReturnType<typeof pi>) => void;
        chain.piFix.mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const pending = boatOrHeldFix(T0);
        vi.setSystemTime(T0 + 20_000);
        complete(pi('ublox-gps.GP', T0 - 50_000));
        expect(await pending).toMatchObject({ kind: 'held', timestamp: T0 - 50_000 });
    });

    it('does not refresh a held fix from malformed or future receiver timestamps', async () => {
        rememberBoatFix(bus(), T0);
        chain.piFix.mockResolvedValue(pi('ublox-gps.GP', Number.NaN));
        chain.cloudFix.mockResolvedValue(cloud(T0 + 120_000));
        expect(await boatOrHeldFix(T0)).toMatchObject({ kind: 'held', timestamp: T0 });
    });

    it('does not overwrite a newer held position with a late older receiver response', () => {
        rememberBoatFix(bus(T0), T0);
        rememberBoatFix({ ...pi('ublox-gps.GP', T0 - 3600_000), latitude: -28 }, T0);
        expect(heldBoatFix()).toMatchObject({ lat: SCARBOROUGH.latitude, timestamp: T0 });
    });

    it('clears cached Pi answers and the remember throttle across accounts', async () => {
        setAuthIdentityScope('skipper-a');
        chain.piFix.mockResolvedValue(pi());
        expect((await boatOrHeldFix(T0))?.kind).toBe('pi');
        setAuthIdentityScope('skipper-b');
        chain.piFix.mockResolvedValue(null);
        expect(await boatOrHeldFix(T0 + 1_000)).toBeNull();
        expect(chain.piFix).toHaveBeenCalledTimes(2);
        rememberBoatFix(bus(), T0 + 1_000);
        expect(heldBoatFix()).toMatchObject({ kind: 'held', timestamp: T0 });
    });

    it('a pending Pi answer cannot become the next account’s live or held fix', async () => {
        setAuthIdentityScope('skipper-a');
        let complete!: (fix: ReturnType<typeof pi>) => void;
        chain.piFix.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const previous = boatOrHeldFix(T0);
        setAuthIdentityScope('skipper-b');
        expect(await boatOrHeldFix(T0 + 1_000)).toBeNull();
        complete(pi());
        expect(await previous).toBeNull();
        expect(heldBoatFix()).toBeNull();
        expect(await boatOrHeldFix(T0 + 2_000)).toBeNull();
    });

    it('a pending cloud answer cannot become the next account’s live or held fix', async () => {
        setAuthIdentityScope('skipper-a');
        let complete!: (fix: ReturnType<typeof cloud>) => void;
        chain.cloudFix.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const previous = boatOrHeldFix(T0);
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
        expect(complete).toBeTypeOf('function');
        setAuthIdentityScope('skipper-b');
        expect(await boatOrHeldFix(T0 + 1_000)).toBeNull();
        complete(cloud());
        expect(await previous).toBeNull();
        expect(heldBoatFix()).toBeNull();
    });

    it('a pending phone request also respects an account switch', async () => {
        setAuthIdentityScope('skipper-a');
        let complete!: (fix: { lat: number; lon: number; timestamp: number }) => void;
        const provider = () =>
            new Promise<{ lat: number; lon: number; timestamp: number }>((resolve) => {
                complete = resolve;
            });
        const pending = resolveWeatherPosition(provider, { now: T0, target: 'phone' });
        setAuthIdentityScope('skipper-b');
        complete({ ...DAUGHTERS, timestamp: T0 });
        expect((await pending).fix).toBeNull();
    });
});

/**
 * Shane 2026-10-05: "when a punter is invited to another yacht, in the location
 * box, instead of showing their yacht, can it instead show the yacht that they
 * are now invited to" — and "if they have gps on their boat and on the invited
 * boat, you would need to be able to check both gps postions". Fictional crew
 * member 'crew-kim' crews on 'Wind Dancer' (skipper 'skipper-wd').
 */
describe('crew: the boat this account crews on has her own chain', () => {
    const CREW = 'crew-kim';
    const WIND_DANCER = 'skipper-wd';
    const TERN = 'skipper-tern';
    const snapshotKey = () => authScopedStorageKey('thalassa_shared_binders_v1');
    const vessel = (ownerId: string, vesselName: string, lastAcceptedAt = '2026-10-01T00:00:00.000Z') => ({
        ownerId,
        vesselName,
        role: 'deckhand',
        lastAcceptedAt,
    });
    /** The shared binder snapshot as a sync would store it, then read back. */
    const crewOn = (vessels: ReturnType<typeof vessel>[]) => {
        localStorage.setItem(
            snapshotKey(),
            JSON.stringify({
                version: 1,
                userId: CREW,
                confirmedAt: '2026-10-05T00:00:00.000Z',
                skippers: [],
                vessels,
            }),
        );
        reloadSharedBindersFromStorage();
    };
    const offshore = (timestamp = T0) => ({
        latitude: -19.1,
        longitude: 147.6,
        timestamp,
        rung: 'cloud' as const,
        source: 'pi-cloud',
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        localStorage.clear();
        setAuthIdentityScope(CREW);
        reloadSharedBindersFromStorage();
        vi.clearAllMocks();
        chain.busFix.mockImplementation(() => null);
        chain.piFix.mockImplementation(async () => null);
        chain.cloudFix.mockImplementation(async () => null);
        chain.deviceRungOwner.mockImplementation(() => null);
        __resetWeatherPositionForTests();
        crewOn([vessel(WIND_DANCER, 'Wind Dancer')]);
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('persists the crew target with her skipper, and old stored values keep working', () => {
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'boat' });
        expect(getWeatherFollowTarget()).toBe('crew');
        expect(getWeatherFollowCrewOwner()).toBe(WIND_DANCER);
        expect(localStorage.getItem(authScopedStorageKey('thalassa_weather_follow_target'))).toBe('crew');
        expect(
            JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_weather_follow_crew')) ?? 'null'),
        ).toEqual({
            ownerId: WIND_DANCER,
            fallback: 'boat',
        });
        __resetWeatherPositionForTests();
        expect(getWeatherFollowTarget()).toBe('crew');

        localStorage.setItem(authScopedStorageKey('thalassa_weather_follow_target'), 'boat');
        expect(getWeatherFollowTarget()).toBe('boat');
        expect(getWeatherFollowCrewOwner()).toBeNull();
        localStorage.setItem(authScopedStorageKey('thalassa_weather_follow_target'), 'phone');
        expect(getWeatherFollowTarget()).toBe('phone');
        // Leaving the crew boat clears her record.
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'phone' });
        setWeatherFollowTarget('boat');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_weather_follow_crew'))).toBeNull();
    });

    it('the crewed boat reads her skipper’s cloud row; the own boat reads only her own', async () => {
        chain.cloudFix.mockImplementation(async (_now, owner) => (owner === WIND_DANCER ? offshore() : null));
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'boat' });
        const crewed = await resolveWeatherPosition(noPhone(), { now: T0 });
        expect(crewed.fix).toMatchObject({ kind: 'cloud', lat: -19.1, lon: 147.6 });
        expect(chain.cloudFix).toHaveBeenCalledWith(T0, WIND_DANCER);
        expect(chain.cloudFix).not.toHaveBeenCalledWith(expect.anything(), 'self');

        chain.cloudFix.mockClear();
        setWeatherFollowTarget('boat');
        const own = await resolveWeatherPosition(noPhone(), { now: T0 });
        expect(chain.cloudFix).toHaveBeenCalledWith(T0, 'self');
        expect(chain.cloudFix).not.toHaveBeenCalledWith(expect.anything(), WIND_DANCER);
        // Her skipper's position never stands in for the own boat.
        expect(own.fix).toBeNull();
    });

    it('the phone’s own receivers are the crewed boat’s only when the paired Pi is hers', async () => {
        chain.busFix.mockImplementation(() => bus());
        chain.piFix.mockImplementation(async () => pi());
        // A gateway socket and a Pi that names nobody: shown for the own boat
        // as always, never the crewed boat's — and, since either boat's could
        // be on the other end, not kept as the own boat's last fix.
        expect(await boatOrHeldFix(T0, WIND_DANCER)).toBeNull();
        expect(chain.busFix).not.toHaveBeenCalled();
        expect(chain.piFix).not.toHaveBeenCalled();
        expect((await boatOrHeldFix(T0))?.kind).toBe('bus');
        expect(heldBoatFix(T0 + 1)).toBeNull();

        // Paired to Wind Dancer's Pi (its relay is her skipper's): hers, and
        // no longer the own boat's, which has no last fix of her own yet.
        chain.deviceRungOwner.mockImplementation(() => WIND_DANCER);
        chain.busFix.mockImplementation(() => null);
        const t1 = T0 + PI_POLL_MS;
        chain.piFix.mockImplementation(async () => pi('ydwg-tcp.YD', t1));
        expect((await boatOrHeldFix(t1, WIND_DANCER))?.kind).toBe('pi');
        chain.piFix.mockClear();
        expect(await boatOrHeldFix(t1 + 1_000)).toBeNull();
        expect(chain.piFix).not.toHaveBeenCalled();

        // Paired to the account's own Pi: the own boat's, as always.
        chain.deviceRungOwner.mockImplementation(() => CREW);
        const t2 = t1 + PI_POLL_MS;
        chain.piFix.mockImplementation(async () => pi('ydwg-tcp.YD', t2));
        expect((await boatOrHeldFix(t2))?.kind).toBe('pi');
        chain.piFix.mockClear();
        expect(await boatOrHeldFix(t2 + 1_000, WIND_DANCER)).toMatchObject({ kind: 'held', rung: 'pi', timestamp: t1 });
        expect(chain.piFix).not.toHaveBeenCalled();
    });

    it('a last fix kept before 2026-10-05 stays the own boat’s, unless the account crews', () => {
        // Kept under the one key there was. Back then an account that crewed
        // could keep its skipper's position there (her cloud row, her Pi), so
        // it is only trusted by an account that crews nowhere.
        const legacy = { lat: -20.27, lon: 148.72, timestamp: T0 - 3600_000, rung: 'cloud', source: 'pi-cloud' };
        const key = authScopedStorageKey('thalassa_weather_last_boat_fix');
        localStorage.setItem(key, JSON.stringify(legacy));
        crewOn([]);
        expect(heldBoatFix(T0)).toMatchObject({ kind: 'held', lat: -20.27, timestamp: T0 - 3600_000 });

        crewOn([vessel(WIND_DANCER, 'Wind Dancer')]);
        expect(heldBoatFix(T0)).toBeNull();
        // Dropped, so it cannot come back as hers when the crewing ends.
        expect(localStorage.getItem(key)).toBeNull();
        crewOn([]);
        expect(heldBoatFix(T0)).toBeNull();
    });

    it('while crewing, a receiver that names no boat is shown but never kept as the own boat’s', async () => {
        // Kestrel's own last fix, kept by this build.
        rememberBoatFix(pi('ydwg-tcp.YD', T0 - 3600_000), T0);
        // Aboard Wind Dancer, the phone's gateway socket (the same address as
        // Kestrel's) names no boat: the own row shows it, as it always has…
        const skippersBus = { latitude: -20.27, longitude: 148.72, timestamp: T0, rung: 'bus' as const };
        chain.busFix.mockImplementation(() => ({ ...skippersBus, source: 'nmea-gateway' }));
        expect(await boatOrHeldFix(T0)).toMatchObject({ kind: 'bus', lat: -20.27 });
        // …but Kestrel's last fix is still Kestrel's.
        expect(heldBoatFix(T0 + 1)).toMatchObject({ lat: -27.2, timestamp: T0 - 3600_000 });

        // A Pi whose relay is not set up names no boat either.
        chain.busFix.mockImplementation(() => null);
        chain.piFix.mockImplementation(async () => ({ ...skippersBus, rung: 'pi' as const, source: 'ydwg-tcp.YD' }));
        expect(await boatOrHeldFix(T0 + PI_POLL_MS)).toMatchObject({ kind: 'pi', lat: -20.27 });
        expect(heldBoatFix(T0 + PI_POLL_MS + 1)).toMatchObject({ lat: -27.2 });

        // Nobody's crew: the phone's receivers are the own boat's, kept as always.
        crewOn([]);
        chain.piFix.mockImplementation(async () => null);
        chain.busFix.mockImplementation(() => bus(T0 + 2 * PI_POLL_MS));
        await boatOrHeldFix(T0 + 2 * PI_POLL_MS);
        expect(heldBoatFix(T0 + 2 * PI_POLL_MS + 1)).toMatchObject({ rung: 'bus', timestamp: T0 + 2 * PI_POLL_MS });
    });

    it('a read-only look (the ★ menu’s) keeps nothing and clears nothing', async () => {
        rememberBoatFix(cloud(T0 - 3600_000), T0);
        const own = heldBoatFix(T0)!;
        setHeldChoice(own, 'boat');
        chain.cloudFix.mockImplementation(async (_now, owner) => (owner === WIND_DANCER ? offshore() : cloud(T0)));
        expect(await boatOrHeldFix(T0, WIND_DANCER, { readOnly: true })).toMatchObject({ kind: 'cloud', lat: -19.1 });
        expect(heldBoatFix(T0 + 1, WIND_DANCER)).toBeNull();
        expect(await boatOrHeldFix(T0, null, { readOnly: true })).toMatchObject({ kind: 'cloud', timestamp: T0 });
        expect(heldBoatFix(T0 + 1)).toMatchObject({ lat: -27.2, timestamp: T0 - 3600_000 });
        expect(getHeldChoice(own)).toBe('boat');
    });

    it('each boat keeps her own held fix', async () => {
        rememberBoatFix(pi('ydwg-tcp.YD', T0 - 3600_000), T0);
        expect(heldBoatFix(T0)).toMatchObject({ kind: 'held', lat: -27.2, timestamp: T0 - 3600_000 });
        expect(heldBoatFix(T0, WIND_DANCER)).toBeNull();

        chain.cloudFix.mockImplementation(async (_now, owner) => (owner === WIND_DANCER ? offshore() : null));
        await boatOrHeldFix(T0, WIND_DANCER);
        expect(heldBoatFix(T0 + 1, WIND_DANCER)).toMatchObject({ kind: 'held', lat: -19.1, rung: 'cloud' });
        // Hers did not overwrite the own boat's.
        expect(heldBoatFix(T0 + 1)).toMatchObject({ lat: -27.2, timestamp: T0 - 3600_000 });

        // Quiet later: each falls back to her own last fix.
        chain.cloudFix.mockImplementation(async () => null);
        expect(await boatOrHeldFix(T0 + CLOUD_POLL_MS, WIND_DANCER)).toMatchObject({ kind: 'held', lat: -19.1 });
        expect(await boatOrHeldFix(T0 + CLOUD_POLL_MS)).toMatchObject({ kind: 'held', lat: -27.2 });
    });

    it('follows a Switch boat, and tells the weather', () => {
        crewOn([vessel(WIND_DANCER, 'Wind Dancer'), vessel(TERN, 'Tern', '2026-09-01T00:00:00.000Z')]);
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'boat' });
        const keys: string[] = [];
        const listen = (event: Event) => keys.push((event as CustomEvent<{ key: string }>).detail.key);
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, listen);
        try {
            selectCrewVessel(TERN);
            expect(getWeatherFollowTarget()).toBe('crew');
            expect(getWeatherFollowCrewOwner()).toBe(TERN);
            expect(keys).toEqual([`crew:${TERN}`]);
        } finally {
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, listen);
        }
    });

    it('falls back when the crewing ends: her own boat when named, else the phone', () => {
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'boat' });
        const targets: string[] = [];
        const listen = (event: Event) => targets.push((event as CustomEvent<{ target: string }>).detail.target);
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, listen);
        try {
            crewOn([]);
            expect(getWeatherFollowTarget()).toBe('boat');
            expect(targets).toEqual(['boat']);
            // Kept: a later invitation does not drag the weather back unasked.
            crewOn([vessel(TERN, 'Tern')]);
            expect(getWeatherFollowTarget()).toBe('boat');
        } finally {
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, listen);
        }

        setWeatherFollowTarget('crew', { ownerId: TERN, fallback: 'phone' });
        crewOn([]);
        expect(getWeatherFollowTarget()).toBe('phone');
    });

    it('keeps following the stored boat while this device does not know the crewing yet', async () => {
        setWeatherFollowTarget('crew', { ownerId: WIND_DANCER, fallback: 'boat' });
        localStorage.removeItem(snapshotKey());
        reloadSharedBindersFromStorage();
        expect(getWeatherFollowTarget()).toBe('crew');
        expect(getWeatherFollowCrewOwner()).toBe(WIND_DANCER);
        await resolveWeatherPosition(noPhone(), { now: T0 });
        expect(chain.cloudFix).toHaveBeenCalledWith(T0, WIND_DANCER);
    });
});
