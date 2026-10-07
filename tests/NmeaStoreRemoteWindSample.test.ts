/**
 * NmeaStore.getRemoteWindSample(): the Pi's own TWS sample time, kept beside
 * the value it dated, so "Her wind vs the models" can tell a dated Pi wind
 * from one the store re-stamped on receipt (NmeaStore.ingestRemote stamps
 * every metric with the phone's clock; the Pi can send tws_kts with no
 * wind_tws_at_ms when Signal K holds a cached value from an instrument that
 * is off).
 *
 * Real: the store. Faked: the gateway socket and the side services the store
 * starts. Ids and readings are fictional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
    status: 'disconnected',
    sample: null as null | ((sample: unknown) => void),
    statusChange: null as null | ((status: string) => void),
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        getSavedConfig: () => ({ host: 'boat-gateway', port: 10110 }),
        onSample: (cb: (sample: unknown) => void) => {
            listener.sample = cb;
            return () => (listener.sample = null);
        },
        onStatusChange: (cb: (status: string) => void) => {
            listener.statusChange = cb;
            return () => (listener.statusChange = null);
        },
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { assessHerWind, type HerWindInput } from '../components/map/boatModelCheck';

const now = 1_800_000_000_000;
function remote(over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot {
    return {
        source: 'pi',
        via: 'lan',
        deviceLabel: 'pi-tern',
        reportedAt: Date.now(),
        windSampleAt: Date.now() - 2_000,
        windSampleSource: 'n2k.42',
        windHistoryIdentity: 'boat-pi-tern',
        lat: null,
        lon: null,
        sogKts: null,
        cogDeg: null,
        headingDeg: null,
        stwKts: null,
        twsKts: 12,
        twaDeg: null,
        twdDeg: null,
        awsKts: null,
        awaDeg: null,
        depthM: null,
        heelDeg: null,
        pitchDeg: null,
        waterTempC: null,
        rudderDeg: null,
        rpm: null,
        voltageV: null,
        ...over,
    };
}

describe('NmeaStore.getRemoteWindSample', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        listener.status = 'disconnected';
        NmeaStore.stop();
        NmeaStore.clearRemote();
        setAuthIdentityScope('skipper-tern');
        NmeaStore.start();
    });
    afterEach(() => {
        NmeaStore.stop();
        NmeaStore.clearRemote();
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('a dated LAN snapshot: the value with the Pi’s own time and lane', () => {
        NmeaStore.ingestRemote(remote());
        expect(NmeaStore.getRemoteWindSample()).toEqual({ kts: 12, at: now - 2_000, via: 'lan' });
        // The exact value the store holds, so a strict comparison is valid.
        expect(NmeaStore.getState().tws.value).toBe(12);
    });

    it('a dated cloud snapshot names the cloud lane', () => {
        NmeaStore.ingestRemote(remote({ via: 'cloud', windSampleAt: now - 30_000, twsKts: 9.4 }));
        expect(NmeaStore.getRemoteWindSample()).toEqual({ kts: 9.4, at: now - 30_000, via: 'cloud' });
    });

    it('an undated snapshot after a dated one: null, never the old time on the new value', () => {
        NmeaStore.ingestRemote(remote());
        vi.setSystemTime(now + 5_000);
        NmeaStore.ingestRemote(remote({ windSampleAt: undefined, twsKts: 14 }));
        expect(NmeaStore.getState().tws.value).toBe(14);
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('a cloud snapshot older than 60 s: null', () => {
        NmeaStore.ingestRemote(remote({ via: 'cloud', windSampleAt: now - 61_000 }));
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('a LAN snapshot older than 20 s: null', () => {
        NmeaStore.ingestRemote(remote({ windSampleAt: now - 21_000 }));
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('clearRemote for the lane: null', () => {
        NmeaStore.ingestRemote(remote());
        NmeaStore.clearRemote('lan');
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('an account change: null', () => {
        NmeaStore.ingestRemote(remote());
        expect(NmeaStore.getRemoteWindSample()).not.toBeNull();
        setAuthIdentityScope('skipper-petrel');
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('a late row from the old sensor (the store’s early return): null', () => {
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.7', windSampleAt: now - 1_000 }));
        expect(NmeaStore.getRemoteWindSample()).toEqual({ kts: 12, at: now - 1_000, via: 'lan' });
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.42', windSampleAt: now - 5_000, twsKts: 30 }));
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });

    it('a cloud ingest refused by the LAN hold leaves the LAN sample', () => {
        NmeaStore.ingestRemote(remote());
        vi.setSystemTime(now + 3_000);
        expect(NmeaStore.ingestRemote(remote({ via: 'cloud', windSampleAt: now + 2_000, twsKts: 20 }))).toBe(false);
        expect(NmeaStore.getRemoteWindSample()).toEqual({ kts: 12, at: now - 2_000, via: 'lan' });
    });

    it('a gateway socket that replaces a remote feed: its leftovers are refused, its own wind reads', () => {
        // Her own boat, as "Her wind vs the models" gathers it (gatherHerWindInput),
        // with her instruments hers and nothing from the cloud.
        const her = (): HerWindInput => ({
            follow: 'boat',
            crewOwnerId: null,
            followKey: 'boat',
            owned: true,
            store: NmeaStore.getState(),
            remoteWindSample: NmeaStore.getRemoteWindSample(),
            remoteFeedEndedAt: NmeaStore.getRemoteFeedEndedAt(),
            chainFix: { lat: -17.75, lon: 168.3 },
            cloudRow: null,
        });
        // The Pi over the LAN sends a TWS it could not date: the LAN lane says so.
        NmeaStore.ingestRemote(remote({ windSampleAt: undefined, twsKts: 31 }));
        expect(assessHerWind(her(), Date.now())).toEqual({ ok: false, refusal: { kind: 'undated' } });
        expect(NmeaStore.getRemoteFeedEndedAt()).toBe(0);

        // Two seconds on the gateway socket comes up and the boat itself wins.
        vi.setSystemTime(now + 2_000);
        listener.status = 'connected';
        listener.statusChange?.('connected');
        expect(NmeaStore.getState().connectionStatus).toBe('connected');
        expect(NmeaStore.getRemoteFeedEndedAt()).toBe(now);
        // The store keeps the feed's 31 kt for its 13 s (the gauges do not blank)...
        expect(NmeaStore.getState().tws.value).toBe(31);
        // ...but it is not the gateway's, so it is not hers to rank.
        expect(assessHerWind(her(), Date.now())).toEqual({ ok: false, refusal: { kind: 'no-reading' } });

        // The socket's own 5 s aggregate: that one reads.
        vi.setSystemTime(now + 5_000);
        listener.sample?.({
            timestamp: Date.now(),
            tws: 14,
            twa: null,
            stw: null,
            heading: null,
            rpm: null,
            rudder: null,
            rudderSwing: null,
            voltage: null,
            depth: null,
            sog: null,
            cog: null,
            waterTemp: null,
            latitude: null,
            longitude: null,
        });
        const read = assessHerWind(her(), Date.now());
        expect(read).toMatchObject({ ok: true, reading: { kt: 14, at: now + 5_000, lane: 'gateway' } });
    });

    it('a connected gateway socket is not a remote feed: null', () => {
        NmeaStore.ingestRemote(remote());
        listener.status = 'connected';
        NmeaStore.clearRemote();
        expect(NmeaStore.getRemoteWindSample()).toBeNull();
    });
});
