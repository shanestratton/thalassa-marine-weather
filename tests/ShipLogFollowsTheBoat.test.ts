/**
 * The log follows the boat, not the phone.
 *
 * Shane, 2026-09-07: the vessel on the hard at Scarborough, the phone driving
 * around Newport, and the Ship's Log showing 13.3 NM for the day. The dwell
 * rule of 2026-09-05 held — and was not enough, because from the phone her GPS
 * merely LOOKED dead. The Pi publishes her every few seconds, so:
 *
 *   - while ANY lane reports her (bus, the Pi direct, its cloud row) the phone
 *     may not stand in for her;
 *   - her remote fix is itself a track source, below the bus, above the phone;
 *   - a phone hundreds of metres from her recent fix is not aboard, and a
 *     phone that left cannot stand in for her even once she goes quiet;
 *   - and the owner is told why (the reason logs; the page shows a boat glyph,
 *     not a sentence — Shane 2026-09-08).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedPosition } from '../services/BgGeoManager';

const world = vi.hoisted(() => ({
    locationHandler: null as ((pos: CachedPosition) => void) | null,
    saved: { host: '192.168.1.151', port: 1456 } as { host: string; port: number } | null,
    pairing: { deviceId: 'pi' } as Record<string, unknown> | null,
    feedStatus: 'unavailable' as 'live' | 'stale' | 'unavailable',
    cloud: null as null | Record<string, unknown>,
    pi: null as null | Record<string, unknown>,
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        subscribeLocation: (cb: (pos: CachedPosition) => void) => {
            world.locationHandler = cb;
            return () => {
                world.locationHandler = null;
            };
        },
        subscribeHeartbeat: () => () => {},
        subscribeActivity: () => () => {},
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { onPosition: () => () => {}, getFeedStatus: () => world.feedStatus },
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getSavedConfig: () => world.saved },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => world.pairing }));
vi.mock('../services/boatPositionChain', () => ({
    piFix: async () => world.pi,
    cloudFix: async () => world.cloud,
}));
vi.mock('../services/EnvironmentService', () => ({ EnvironmentService: { updateFromGPS: vi.fn() } }));
vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: { feed: vi.fn(), getAdaptedThresholds: () => ({ courseChangeMinMovementM: 1 }), reset: vi.fn() },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    GpsSubscriptionManager,
    type GpsSubscriptionOptions,
    type PhoneHold,
} from '../services/shiplog/GpsSubscriptionManager';
import { GpsTrackBuffer } from '../services/shiplog/GpsTrackBuffer';

const SCARBOROUGH = { latitude: -27.195, longitude: 153.1056 }; // on the hard
const NEWPORT = { latitude: -27.215, longitude: 153.085 }; // ~3 km away, in the car

const phoneFix = (at: { latitude: number; longitude: number }, over: Partial<CachedPosition> = {}): CachedPosition =>
    ({
        ...at,
        accuracy: 5,
        altitude: 0,
        heading: 90,
        speed: 6, // m/s — driving
        timestamp: Date.now(),
        receivedAt: Date.now(),
        ...over,
    }) as CachedPosition;

const boatCloudFix = (ageMs: number) => ({
    ...SCARBOROUGH,
    timestamp: Date.now() - ageMs,
    rung: 'cloud',
    source: 'pi-cloud',
    sogKts: 0,
    cogDeg: null,
});

/** Let the poll's awaits (a dynamic import and two rungs) settle. */
const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
};

describe('the Ship’s Log follows the boat, not the phone', () => {
    let mgr: GpsSubscriptionManager;
    let buffered: CachedPosition[];
    let holds: (PhoneHold | null)[];

    const options = (): GpsSubscriptionOptions => ({
        isNative: true,
        trackBuffer: new GpsTrackBuffer(),
        isActive: () => true,
        isRapidMode: () => false,
        isPrecisionMode: () => false,
        getIntervalMs: () => 30_000,
        getLastEntryTime: () => undefined,
        getPlottingProfile: () => ({ zone: 'nearshore', intervalMs: 3_000 }),
        onPlotPointBuffered: (pos) => buffered.push(pos),
        onFix: vi.fn(),
        onSpeedTierChanged: vi.fn(),
        onHeartbeatTick: vi.fn(),
        onPhoneHeld: (hold) => holds.push(hold),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-07T03:00:00Z'));
        world.locationHandler = null;
        world.saved = { host: '192.168.1.151', port: 1456 };
        world.pairing = { deviceId: 'pi' };
        world.feedStatus = 'unavailable';
        world.cloud = null;
        world.pi = null;
        buffered = [];
        holds = [];
        mgr = new GpsSubscriptionManager();
    });
    afterEach(() => {
        mgr.stop();
        vi.useRealTimers();
    });

    it('records HER from the cloud and refuses the phone in the car, saying why', async () => {
        world.cloud = boatCloudFix(4_000);
        mgr.start(options());
        await settle();

        // The boat's remote fix opened the track, tagged as her own GPS relayed.
        expect(buffered).toHaveLength(1);
        expect(buffered[0].latitude).toBe(SCARBOROUGH.latitude);
        expect(buffered[0].fixSource).toBe('vessel-relay');

        // Past warm-up, the phone offers Newport at driving speed. Refused.
        await vi.advanceTimersByTimeAsync(6_000);
        world.locationHandler!(phoneFix(NEWPORT));
        expect(buffered).toHaveLength(1);
        const hold = holds.at(-1);
        expect(hold?.reason).toBe('vessel-alive');
        expect(hold?.boatLane).toBe('cloud');
        expect(hold?.distanceM).toBeGreaterThan(2_500);
    });

    it('once she goes quiet the phone still has to be aboard her: 3 km away is refused, and stays refused once her fix is old', async () => {
        world.cloud = boatCloudFix(4_000);
        mgr.start(options());
        await settle();
        expect(buffered).toHaveLength(1);

        // The Pi stops answering; her last fix ages past the remote window.
        world.cloud = null;
        await vi.advanceTimersByTimeAsync(70_000);
        world.locationHandler!(phoneFix(NEWPORT));
        expect(buffered).toHaveLength(1);
        expect(holds.at(-1)?.reason).toBe('vessel-alive'); // not dead yet: the dwell is running

        // The full dwell served, she is dead by the app's definition — but her
        // fix is nine minutes old and three kilometres from this phone. Not aboard.
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        world.locationHandler!(phoneFix(NEWPORT));
        expect(buffered).toHaveLength(1);
        expect(holds.at(-1)?.reason).toBe('not-aboard');

        // Her fix is now older than the aboard reference. This used to be
        // "nothing left to compare against — stand in", which put the car
        // back in the log ten minutes after the Pi went quiet (build 123
        // review: the RUTX50's Wednesday reboot, a Starlink drop). She was
        // on the hard (SOG 0): she cannot have carried this phone 3 km.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        world.locationHandler!(phoneFix(NEWPORT));
        await vi.advanceTimersByTimeAsync(5_000);
        world.locationHandler!(phoneFix({ latitude: NEWPORT.latitude + 0.0002, longitude: NEWPORT.longitude }));
        expect(buffered).toHaveLength(1);
        expect(holds.at(-1)?.reason).toBe('not-aboard');
    });

    it('the fuse blown offshore: her last fix said 6 kn, and a phone where she could have sailed to since stands in, tagged phone', async () => {
        // Off Cape Hatteras, northbound at 6 kn, when her GPS fuse goes.
        const HATTERAS = { latitude: 35.2, longitude: -75.4 };
        world.cloud = { ...boatCloudFix(2_000), ...HATTERAS, sogKts: 6, cogDeg: 0 };
        mgr.start(options());
        await settle();
        expect(buffered).toHaveLength(1);
        world.cloud = null;

        const north = (m: number) => ({ latitude: HATTERAS.latitude + m / 111_320, longitude: HATTERAS.longitude });
        // The phone aboard keeps reporting: held while the dwell runs, then —
        // her fix still recent, the phone already 700 m on — "not aboard".
        await vi.advanceTimersByTimeAsync(70_000);
        world.locationHandler!(phoneFix(north(220), { speed: 3.1 }));
        expect(holds.at(-1)?.reason).toBe('vessel-alive');
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        world.locationHandler!(phoneFix(north(780), { speed: 3.1 }));
        expect(holds.at(-1)?.reason).toBe('not-aboard');

        // Eleven minutes on at 6 kn she is ~2 km north; so is the phone aboard her.
        await vi.advanceTimersByTimeAsync(11 * 60_000 - 250_000);
        world.locationHandler!(phoneFix(north(2_030), { speed: 3.1 }));
        await vi.advanceTimersByTimeAsync(5_000);
        world.locationHandler!(phoneFix(north(2_045), { speed: 3.1 }));
        expect(buffered.length).toBeGreaterThanOrEqual(2);
        expect(buffered.at(-1)?.fixSource).toBe('phone');
        expect(holds.at(-1)).toBeNull();
    });

    it('a phone judged aboard in this silence keeps the track after her fix ages, wherever she motors with her GPS dead', async () => {
        // At anchor off Nouméa (SOG 0) when her GPS dies; the phone is aboard.
        const ANCHORAGE = { latitude: -22.2796, longitude: 166.4389 };
        world.cloud = { ...boatCloudFix(2_000), ...ANCHORAGE };
        mgr.start(options());
        await settle();
        world.cloud = null;

        // Past the remote window she reads dead; the dwell runs from here.
        await vi.advanceTimersByTimeAsync(70_000);
        world.locationHandler!(phoneFix(ANCHORAGE, { speed: 0 }));
        expect(holds.at(-1)?.reason).toBe('vessel-alive');
        await vi.advanceTimersByTimeAsync(200_000);
        world.locationHandler!(phoneFix(ANCHORAGE, { speed: 0 }));
        await vi.advanceTimersByTimeAsync(5_000);
        world.locationHandler!(
            phoneFix({ latitude: ANCHORAGE.latitude + 0.0002, longitude: ANCHORAGE.longitude }, { speed: 0 }),
        );
        expect(buffered.at(-1)?.fixSource).toBe('phone');
        const afterAboard = buffered.length;

        // Fifteen minutes on she has motored a kilometre with her GPS still dead.
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        world.locationHandler!(
            phoneFix({ latitude: ANCHORAGE.latitude - 0.009, longitude: ANCHORAGE.longitude }, { speed: 2 }),
        );
        expect(buffered.length).toBeGreaterThan(afterAboard);
        expect(holds.at(-1)).toBeNull();
    });

    it('a phone-only punter — no gateway, no Pi — logs their own trip without waiting on anyone', async () => {
        world.saved = null;
        world.pairing = null;
        mgr.start(options());
        await settle();
        await vi.advanceTimersByTimeAsync(6_000);
        world.locationHandler!(phoneFix(NEWPORT));
        await vi.advanceTimersByTimeAsync(5_000);
        world.locationHandler!(phoneFix({ latitude: NEWPORT.latitude + 0.0003, longitude: NEWPORT.longitude }));
        expect(buffered.length).toBeGreaterThanOrEqual(1);
        expect(holds.filter(Boolean)).toHaveLength(0);
    });

    it('the bus that has spoken within the window beats the remote lane', async () => {
        world.feedStatus = 'live'; // the bus is streaming: the remote poll stays quiet
        world.cloud = boatCloudFix(2_000);
        mgr.start(options());
        await settle();
        expect(buffered).toHaveLength(0);
    });

    // ── Build 123, package VL: the stand-in is the skipper's to give ──────────
    //
    // The ref-null hole (voyagelog.md, whyWrong 3c): a boat configured but never
    // heard this session skipped the aboard test entirely, so ashore with no
    // VPN and the Pi offline, three minutes after the slide the phone owned the
    // log — the car track again. Now the phone stands in for a boat it has never
    // heard only if the skipper said "Log from this phone" at Start.
    describe('stand-in policy (build 123)', () => {
        // Annapolis, on the Chesapeake: the boat on her mooring, the skipper's
        // phone 2 km away in a car on the far side of Spa Creek.
        const EASTPORT_CAR = { latitude: 38.9655, longitude: -76.479 };
        const twoPhoneFixes = async (at: { latitude: number; longitude: number }) => {
            world.locationHandler!(phoneFix(at));
            await vi.advanceTimersByTimeAsync(5_000);
            world.locationHandler!(phoneFix({ latitude: at.latitude + 0.0002, longitude: at.longitude }));
        };

        it('a boat configured but never heard: 181 s of dead lanes does NOT hand the log to a phone 2 km away', async () => {
            mgr.start(options());
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            world.locationHandler!(phoneFix(EASTPORT_CAR));
            expect(holds.at(-1)?.reason).toBe('vessel-alive'); // the dwell is running

            await vi.advanceTimersByTimeAsync(181_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(buffered).toHaveLength(0);
            expect(holds.at(-1)?.reason).toBe('no-boat-fix');
        });

        it('a bus with wind but no GPS, phone plainly aboard (gwstate: phoneStandsInForBoat): the phone stands in after the dwell', async () => {
            // Most gateway-only boats worldwide: the YDWG-02 carries wind and
            // depth, the plotter keeps its GPS to itself. Her position can never
            // be heard, so "aboard" comes from gwstate — this phone on the
            // gateway's own Wi-Fi with no VPN up, a direct lane live.
            mgr.start({ ...options(), phoneWithBoat: () => true });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            world.locationHandler!(phoneFix(EASTPORT_CAR));
            await vi.advanceTimersByTimeAsync(181_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(buffered).toHaveLength(1);
            expect(buffered[0].fixSource).toBe('phone');
        });

        it('"Log from this phone" at Start (her GPS silent): the phone logs at once, every point tagged phone', async () => {
            mgr.start({ ...options(), standIn: () => ({ standIn: 'allowed', optedIn: true }) });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(buffered).toHaveLength(1);
            expect(buffered[0].fixSource).toBe('phone');
            expect(holds.filter(Boolean)).toHaveLength(0);
        });

        it('the opt-in yields the moment she speaks: her own lane takes the track back', async () => {
            // Aboard on her mooring this time: the skipper chose the phone
            // because her GPS was silent, then the Pi came back.
            const MOORING = { latitude: 38.9784, longitude: -76.4922 };
            mgr.start({ ...options(), standIn: () => ({ standIn: 'allowed', optedIn: true }) });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            await twoPhoneFixes(MOORING);
            expect(buffered).toHaveLength(1);

            world.cloud = { ...boatCloudFix(3_000), ...MOORING };
            await vi.advanceTimersByTimeAsync(10_000);
            await settle();
            world.cloud = { ...boatCloudFix(1_000), latitude: MOORING.latitude + 0.0004, longitude: MOORING.longitude };
            await vi.advanceTimersByTimeAsync(10_000);
            await settle();
            world.locationHandler!(phoneFix({ latitude: MOORING.latitude + 0.0005, longitude: MOORING.longitude }));
            expect(holds.at(-1)?.reason).toBe('vessel-alive');
            expect(buffered.at(-1)?.fixSource).toBe('vessel-relay');
        });

        it('"Wait for the boat" (or a Start from ashore): never, not even after the dwell in the fuse-blown case', async () => {
            world.cloud = boatCloudFix(4_000);
            mgr.start({ ...options(), standIn: () => ({ standIn: 'never', optedIn: false }) });
            await settle();
            expect(buffered).toHaveLength(1);

            world.cloud = null;
            // Dead for longer than the dwell AND her fix older than the aboard
            // reference: the default policy would let the phone in here.
            await vi.advanceTimersByTimeAsync(16 * 60_000);
            await twoPhoneFixes(NEWPORT);
            expect(buffered).toHaveLength(1);
            expect(holds.at(-1)?.reason).toBe('boat-only');
        });

        it("the Voyage End entry is judged by the voyage's own rule after stop(): an opted-in phone may still answer", async () => {
            // End Voyage flushes, stops the subscriptions, THEN writes Voyage
            // End. A stopped manager used to forget the policy and fall back
            // to the default, refusing the very phone that logged the passage.
            mgr.start({ ...options(), standIn: () => ({ standIn: 'allowed', optedIn: true }) });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(mgr.phoneMayStandIn()).toBe(true);
            mgr.stop();
            expect(mgr.phoneMayStandIn()).toBe(true);
        });

        it('…and so may a phone gwstate vouches for on a bus with no GPS, after stop()', async () => {
            mgr.start({ ...options(), phoneWithBoat: () => true });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            world.locationHandler!(phoneFix(EASTPORT_CAR));
            await vi.advanceTimersByTimeAsync(181_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(mgr.phoneMayStandIn()).toBe(true);
            mgr.stop();
            expect(mgr.phoneMayStandIn()).toBe(true);
        });

        it('…while a boat-only voyage stays boat-only after stop()', async () => {
            mgr.start({ ...options(), standIn: () => ({ standIn: 'never', optedIn: false }) });
            await settle();
            mgr.stop();
            expect(mgr.phoneMayStandIn()).toBe(false);
        });

        it('a phone-only punter is untouched: no boat, no policy needed, the phone logs', async () => {
            world.saved = null;
            world.pairing = null;
            mgr.start({ ...options(), standIn: () => ({ standIn: 'allowed', optedIn: false }) });
            await settle();
            await vi.advanceTimersByTimeAsync(6_000);
            await twoPhoneFixes(EASTPORT_CAR);
            expect(buffered).toHaveLength(1);
            expect(buffered[0].fixSource).toBe('phone');
        });
    });
});
