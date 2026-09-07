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
 *   - and the page is told why, so it says "the log follows the boat" rather
 *     than looking broken.
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
import { describePhoneHold } from '../services/shiplog/phoneHoldText';

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

        // The boat's remote fix opened the track.
        expect(buffered).toHaveLength(1);
        expect(buffered[0].latitude).toBe(SCARBOROUGH.latitude);

        // Past warm-up, the phone offers Newport at driving speed. Refused.
        await vi.advanceTimersByTimeAsync(6_000);
        world.locationHandler!(phoneFix(NEWPORT));
        expect(buffered).toHaveLength(1);
        const hold = holds.at(-1);
        expect(hold?.reason).toBe('vessel-alive');
        expect(hold?.boatLane).toBe('cloud');
        expect(hold?.distanceM).toBeGreaterThan(2_500);
        expect(describePhoneHold(hold!)).toContain('her GPS is alive through the cloud');
        expect(describePhoneHold(hold!)).toContain('NM from her');
        expect(describePhoneHold(hold!)).toContain('The log follows the boat.');
    });

    it('once she goes quiet the phone still has to be aboard her: 3 km away is refused; only a phone with no recent boat fix may stand in', async () => {
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
        expect(describePhoneHold(holds.at(-1)!)).toContain('not aboard');

        // Her fix is now older than the aboard reference: nothing left to
        // compare the phone against, and the boat has been dead for minutes.
        // The phone may stand in — that is the fuse-blown-offshore case.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        world.locationHandler!(phoneFix(NEWPORT));
        expect(buffered).toHaveLength(2);
        expect(buffered[1].latitude).toBe(NEWPORT.latitude);
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
});
