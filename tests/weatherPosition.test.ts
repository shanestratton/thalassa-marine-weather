/**
 * Where the weather is FOR — Shane, 2026-09-06, after driving to his
 * daughter's with the forecast following his phone: "boat GPS followed by
 * u-blox GPS and finally phone gps", and when she goes quiet, "hold her last
 * fix. with a message of course."
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
    busFix: vi.fn<() => import('../services/boatPositionChain').BoatFix | null>(() => null),
    piFix: vi.fn<() => Promise<import('../services/boatPositionChain').BoatFix | null>>(async () => null),
}));
vi.mock('../services/boatPositionChain', () => ({
    busFix: chain.busFix,
    piFix: chain.piFix,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    ASK_DISTANCE_NM,
    PI_POLL_MS,
    __resetWeatherPositionForTests,
    boatOrHeldFix,
    describeWeatherFix,
    formatFixAge,
    getHeldChoice,
    heldBoatFix,
    resolveWeatherPosition,
    setHeldChoice,
} from '../services/weatherPosition';

const T0 = Date.UTC(2026, 8, 6, 0, 30, 0); // 10:30 AEST, the boat on the hard at Scarborough
const SCARBOROUGH = { latitude: -27.2, longitude: 153.11 };
const DAUGHTERS = { lat: -27.47, lon: 153.02 }; // ~17 NM away
const bus = (timestamp = T0) => ({ ...SCARBOROUGH, timestamp, rung: 'bus' as const, source: 'nmea-gateway' });
const pi = (source = 'ydwg-tcp.YD', timestamp = T0) => ({ ...SCARBOROUGH, timestamp, rung: 'pi' as const, source });
const phoneAt = (lat: number, lon: number, timestamp = T0) => vi.fn(async () => ({ lat, lon, timestamp }));
const noPhone = () => vi.fn(async () => null);

describe('where the weather is for', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        chain.busFix.mockImplementation(() => null);
        chain.piFix.mockImplementation(async () => null);
        __resetWeatherPositionForTests();
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
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('thalassa_weather_last_boat_fix'));
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

    it('asks the Pi at most once per poll window, whatever the tick rate', async () => {
        chain.piFix.mockImplementation(async () => pi());
        for (let i = 0; i < 6; i++) await boatOrHeldFix(T0 + i * 5_000);
        expect(chain.piFix).toHaveBeenCalledTimes(1);
        await boatOrHeldFix(T0 + PI_POLL_MS + 1);
        expect(chain.piFix).toHaveBeenCalledTimes(2);
    });

    it('a device that has never seen a boat follows the phone, as before', async () => {
        const phone = phoneAt(DAUGHTERS.lat, DAUGHTERS.lon);
        const r = await resolveWeatherPosition(phone, { now: T0 });
        expect(r.fix).toMatchObject({ kind: 'phone', lat: DAUGHTERS.lat });
        expect(r.held).toBeNull();
        expect(r.ask).toBe(false);
        expect(describeWeatherFix(r.fix, T0)).toBe('Phone GPS');
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

        it('still holds her, but asks once the phone is clearly somewhere else', async () => {
            const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later), { now: later });
            expect(r.fix?.kind).toBe('held');
            expect(r.held?.timestamp).toBe(T0);
            expect(r.phone).toMatchObject({ kind: 'phone', lat: DAUGHTERS.lat });
            expect(r.ask).toBe(true);
        });

        it('the asking distance is a couple of miles, not a car park', () => {
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

        it('"follow my phone" follows the phone, and falls back to her fix if the phone cannot answer', async () => {
            const held = heldBoatFix()!;
            setHeldChoice(held, 'phone');
            const r = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later), { now: later });
            expect(r.fix).toMatchObject({ kind: 'phone', lat: DAUGHTERS.lat });
            expect(r.ask).toBe(false);
            const dark = await resolveWeatherPosition(noPhone(), { now: later });
            expect(dark.fix?.kind).toBe('held');
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
            // Quiet again, a new fix on record → the question is fresh.
            chain.busFix.mockImplementation(() => null);
            const again = await resolveWeatherPosition(phoneAt(DAUGHTERS.lat, DAUGHTERS.lon, later + 1), {
                now: later + 1,
            });
            expect(again.held?.timestamp).toBe(later);
            expect(again.ask).toBe(true);
        });
    });

    it('says which receiver, in a skipper’s words', () => {
        expect(describeWeatherFix(null)).toBe('No position');
        expect(describeWeatherFix({ kind: 'bus', timestamp: 0 })).toBe('Boat GPS · live');
        expect(describeWeatherFix({ kind: 'pi', timestamp: 0, source: 'ydwg-tcp.YD' })).toBe(
            'Boat GPS (via Pi) · live',
        );
        expect(describeWeatherFix({ kind: 'held', timestamp: T0 }, T0 + 2 * 86400_000)).toBe(
            "Boat's last fix · 2d ago",
        );
        expect(formatFixAge(30_000)).toBe('just now');
        expect(formatFixAge(5 * 60_000)).toBe('5m ago');
    });
});
