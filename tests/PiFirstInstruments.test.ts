/**
 * Pi-first instruments — Shane 2026-09-07: "no more signal k or ydwg-02 on
 * the actual phone unless there is no pi available."
 *
 * Three seams: the store ranks the Pi over the boat LAN above its cloud row
 * and counts the LAN as the boat's own GPS; the LAN lane feeds instruments and
 * AIS off one answer; the policy opens the gateway socket only when there is
 * no Pi — and gives the slot back when the Pi returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
    status: 'disconnected' as string,
    saved: null as { host: string; port: number } | null,
    autoStart: vi.fn(() => true),
    stop: vi.fn(),
    order: [] as string[],
}));
const pairing = vi.hoisted(() => ({
    record: { deviceId: 'pi', boatName: 'Serene Summer' } as Record<string, unknown> | null,
    respond: (() => Promise.resolve({ status: 200, data: '{}' })) as () => Promise<{ status: number; data: string }>,
}));
const ais = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        onSample: vi.fn(() => vi.fn()),
        onStatusChange: vi.fn(() => vi.fn()),
        getSavedConfig: () => listener.saved,
        autoStart: () => {
            listener.order.push('socket');
            return listener.autoStart();
        },
        stop: () => listener.stop(),
    },
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
}));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn(), update: ais.update } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => pairing.record,
    pinnedPiRequest: () => pairing.respond(),
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: { getBaseUrl: () => 'https://192.168.1.50:3001', getStatus: () => ({ reachable: true }) },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { LAN_REMOTE_HOLD_MS, NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { PiTelemetryService, aisTargetFromWire } from '../services/PiTelemetryService';
import { FLAP_GUARD_MS, InstrumentSourcePolicy, PI_BACK_MS, PI_SILENT_MS } from '../services/InstrumentSourcePolicy';

const snapshot = (over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    deviceLabel: 'calypso',
    reportedAt: Date.now() - 2_000,
    lat: -27.2,
    lon: 153.11,
    sogKts: 6.1,
    cogDeg: 44,
    headingDeg: 41,
    stwKts: 5.8,
    twsKts: 14,
    twaDeg: -48,
    twdDeg: 350,
    awsKts: 17,
    awaDeg: -33,
    depthM: 12.4,
    heelDeg: -9,
    pitchDeg: 1,
    waterTempC: 22.5,
    rudderDeg: 2,
    rpm: null,
    voltageV: 13.1,
    ...over,
});

describe('the store: the Pi over the boat LAN outranks its cloud row, and counts as the boat', () => {
    beforeEach(() => {
        listener.status = 'disconnected';
        NmeaStore.clearRemote();
        // NmeaStore.start() does this in the app; the provider caches positions off the store.
        NmeaGpsProvider.start();
    });
    afterEach(() => {
        NmeaGpsProvider.stop();
    });

    it('a LAN snapshot is remote·lan, a boat feed, a GPS fix, and the cloud may not overwrite it', () => {
        expect(NmeaStore.ingestRemote(snapshot({ via: 'lan' }))).toBe(true);
        const s = NmeaStore.getState();
        expect(s.connectionStatus).toBe('remote');
        expect(s.remote?.via).toBe('lan');
        expect(NmeaStore.isBoatFeed()).toBe(true);
        expect(NmeaStore.hasGpsFix()).toBe(true);
        expect(NmeaGpsProvider.getFeedStatus()).toBe('live');
        expect(NmeaGpsProvider.getPosition()?.latitude).toBe(-27.2);

        expect(NmeaStore.ingestRemote(snapshot({ via: 'cloud', sogKts: 9.9 }))).toBe(false);
        expect(NmeaStore.getState().sog.value).toBe(6.1);
        expect(LAN_REMOTE_HOLD_MS).toBe(15_000);
    });

    it('the cloud alone is the boat seen from a distance: not a boat feed, not a GPS fix', () => {
        expect(NmeaStore.ingestRemote(snapshot({ via: 'cloud' }))).toBe(true);
        expect(NmeaStore.getState().remote?.via).toBe('cloud');
        expect(NmeaStore.isBoatFeed()).toBe(false);
        expect(NmeaStore.hasGpsFix()).toBe(false);
        expect(NmeaGpsProvider.getFeedStatus()).toBe('unavailable');
        // …and a LAN snapshot arriving now takes over.
        expect(NmeaStore.ingestRemote(snapshot({ via: 'lan', sogKts: 7 }))).toBe(true);
        expect(NmeaStore.getState().remote?.via).toBe('lan');
        expect(NmeaStore.getState().sog.value).toBe(7);
    });

    it('a lane clears only its own feed', () => {
        NmeaStore.ingestRemote(snapshot({ via: 'lan' }));
        NmeaStore.clearRemote('cloud');
        expect(NmeaStore.getState().remote?.via).toBe('lan');
        expect(NmeaStore.getState().sog.value).toBe(6.1);
        NmeaStore.clearRemote('lan');
        expect(NmeaStore.getState().remote).toBeNull();
        expect(NmeaStore.getState().connectionStatus).toBe('disconnected');
        expect(NmeaStore.getState().sog.value).toBeNull();
    });

    it('a connected gateway socket beats both lanes', () => {
        listener.status = 'connected';
        expect(NmeaStore.ingestRemote(snapshot({ via: 'lan' }))).toBe(false);
        expect(NmeaStore.ingestRemote(snapshot({ via: 'cloud' }))).toBe(false);
    });
});

const wire = (reportedAgoMs: number) => ({
    source: 'pi',
    device_label: 'calypso',
    reported_at: new Date(Date.now() - reportedAgoMs).toISOString(),
    lat: -27.2,
    lon: 153.11,
    sog_kts: 4.4,
    cog_deg: 90,
    depth_m: 3.3,
    twa_deg: -60,
});
const aisWire = [
    {
        mmsi: 503000111,
        name: 'Wandering Star',
        lat: -27.19,
        lon: 153.12,
        cog: 90,
        sog: 10,
        heading: 180,
        navStatus: 8,
        shipType: 36,
        callSign: 'VJN1234',
        destination: 'Mooloolaba',
        lastUpdated: Date.now() - 20_000,
    },
    { mmsi: 503000222, name: '', lat: -27.3, lon: 153.2, lastUpdated: Date.now() - 4_000 },
    { name: 'no mmsi', lat: -27.3, lon: 153.2, lastUpdated: Date.now() },
    'rubbish',
];

describe('PiTelemetryService: the boat off the Pi, over the LAN', () => {
    beforeEach(() => {
        PiTelemetryService.resetForTests();
        listener.status = 'disconnected';
        NmeaStore.clearRemote();
        ais.update.mockClear();
        pairing.record = { deviceId: 'pi', boatName: 'Serene Summer' };
    });

    it('feeds instruments and AIS off one answer, and knows the Pi is present and live', async () => {
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({ available: true, telemetry: wire(1_000), ais: aisWire }),
            });
        expect(await PiTelemetryService.pollOnce()).toBe('live');
        const s = NmeaStore.getState();
        expect(s.connectionStatus).toBe('remote');
        expect(s.remote?.via).toBe('lan');
        expect(s.depth.value).toBe(3.3);
        expect(s.twaSigned.value).toBe(-60);
        expect(NmeaStore.hasGpsFix()).toBe(true);
        expect(ais.update).toHaveBeenCalledTimes(2);
        expect(ais.update).toHaveBeenCalledWith(
            expect.objectContaining({ mmsi: 503000111, navStatus: 8, callSign: 'VJN1234' }),
        );
        expect(ais.update).toHaveBeenCalledWith(
            expect.objectContaining({ mmsi: 503000222, heading: 511, navStatus: 15, shipType: 0 }),
        );
        expect(PiTelemetryService.isPresent()).toBe(true);
        expect(PiTelemetryService.isLive()).toBe(true);
        expect(PiTelemetryService.lastSeenAt()).not.toBeNull();
    });

    it('a quiet bus is the Pi present with nothing to say: gauges empty, no fault, still present', async () => {
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({ available: true, telemetry: wire(1_000), ais: [] }),
            });
        await PiTelemetryService.pollOnce();
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({ available: false, telemetry: null, ais: [], reason: 'nothing on the bus' }),
            });
        expect(await PiTelemetryService.pollOnce()).toBe('quiet');
        expect(NmeaStore.getState().remote).toBeNull();
        expect(NmeaStore.getState().sog.value).toBeNull();
        expect(PiTelemetryService.isPresent()).toBe(true);
    });

    it('a stale snapshot is a quiet bus too — the Pi does not get to serve history as the boat', async () => {
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({ available: true, telemetry: wire(45_000), ais: [] }),
            });
        expect(await PiTelemetryService.pollOnce()).toBe('quiet');
        expect(NmeaStore.getState().remote).toBeNull();
    });

    it('a Pi that does not answer is unreachable; with nothing live to protect the LAN feed is cleared', async () => {
        pairing.respond = () => Promise.reject(new Error('-1202 pinned lane refused'));
        expect(await PiTelemetryService.pollOnce()).toBe('unreachable');
        expect(NmeaStore.getState().remote).toBeNull();
        expect(PiTelemetryService.isPresent()).toBe(false);
        pairing.record = null;
        expect(await PiTelemetryService.pollOnce()).toBe('searching');
    });

    it('never opens a socket to the gateway, and stopping clears only the LAN lane', async () => {
        NmeaStore.ingestRemote(snapshot({ via: 'cloud' }));
        PiTelemetryService.start();
        PiTelemetryService.stop();
        expect(NmeaStore.getState().remote?.via).toBe('cloud');
        expect(listener.autoStart).not.toHaveBeenCalled();
    });

    it('rubbish AIS entries are skipped, valid ones land in the phone’s shape', () => {
        expect(aisTargetFromWire(null)).toBeNull();
        expect(aisTargetFromWire('x')).toBeNull();
        expect(aisTargetFromWire({ name: 'no mmsi', lat: 1, lon: 1, lastUpdated: 1 })).toBeNull();
        expect(aisTargetFromWire({ mmsi: 1, lat: 91, lon: 1, lastUpdated: 1 })).toBeNull();
        expect(aisTargetFromWire(aisWire[0])).toMatchObject({
            mmsi: 503000111,
            sog: 10,
            cog: 90,
            destination: 'Mooloolaba',
        });
    });
});

describe('InstrumentSourcePolicy: the socket opens only when there is no Pi', () => {
    const T0 = Date.parse('2026-09-07T03:00:00Z');
    let lastSeen: number | null = null;

    beforeEach(() => {
        InstrumentSourcePolicy.resetForTests();
        PiTelemetryService.resetForTests();
        listener.autoStart.mockClear();
        listener.stop.mockClear();
        listener.order.length = 0;
        listener.saved = { host: '192.168.1.151', port: 1456 };
        lastSeen = null;
        vi.spyOn(NmeaStore, 'start').mockImplementation(() => listener.order.push('store') && undefined);
        vi.spyOn(PiTelemetryService, 'start').mockImplementation(() => listener.order.push('lan') && undefined);
        vi.spyOn(PiTelemetryService, 'lastSeenAt').mockImplementation(() => lastSeen);
    });
    afterEach(() => {
        InstrumentSourcePolicy.resetForTests();
        vi.restoreAllMocks();
    });

    it('with a Pi paired: the store and the LAN lane start, the socket does not', () => {
        pairing.record = { deviceId: 'pi' };
        expect(InstrumentSourcePolicy.boot(T0)).toBe('pi-first');
        expect(listener.order).toEqual(['store', 'lan']);
        expect(listener.autoStart).not.toHaveBeenCalled();
        expect(InstrumentSourcePolicy.mode()).toBe('pi');
        // Idempotent: a second boot does nothing more.
        expect(InstrumentSourcePolicy.boot(T0 + 1)).toBe('pi-first');
        expect(listener.order).toEqual(['store', 'lan']);
    });

    it('with no Pi: exactly the old boot — the store first, then the saved gateway', () => {
        pairing.record = null;
        expect(InstrumentSourcePolicy.boot(T0)).toBe('direct');
        expect(listener.order).toEqual(['store', 'socket']);
        expect(InstrumentSourcePolicy.mode()).toBe('direct');
    });

    it('with no Pi and no saved gateway: nothing starts on the punter’s behalf', () => {
        pairing.record = null;
        listener.saved = null;
        expect(InstrumentSourcePolicy.boot(T0)).toBe('idle');
        expect(listener.order).toEqual([]);
        expect(InstrumentSourcePolicy.mode()).toBe('none');
    });

    it('a Pi silent for a minute opens the gateway once; back for thirty seconds gives the slot back; never inside the flap guard', () => {
        pairing.record = { deviceId: 'pi' };
        InstrumentSourcePolicy.boot(T0);
        InstrumentSourcePolicy.tick(T0 + 30_000);
        expect(listener.autoStart).not.toHaveBeenCalled();
        InstrumentSourcePolicy.tick(T0 + PI_SILENT_MS);
        expect(listener.autoStart).toHaveBeenCalledTimes(1);
        expect(InstrumentSourcePolicy.mode()).toBe('pi-silent-direct');
        InstrumentSourcePolicy.tick(T0 + PI_SILENT_MS + 5_000);
        expect(listener.autoStart).toHaveBeenCalledTimes(1);

        // The Pi comes back and keeps answering.
        const back = T0 + PI_SILENT_MS + 10_000;
        for (let t = back; t <= back + PI_BACK_MS; t += 5_000) {
            lastSeen = t;
            InstrumentSourcePolicy.tick(t);
        }
        // Back long enough, but inside the flap guard from the open — not yet.
        expect(listener.stop).not.toHaveBeenCalled();
        const afterGuard = T0 + PI_SILENT_MS + FLAP_GUARD_MS;
        lastSeen = afterGuard;
        InstrumentSourcePolicy.tick(afterGuard);
        expect(listener.stop).toHaveBeenCalledTimes(1);
        expect(InstrumentSourcePolicy.mode()).toBe('pi');
    });

    it('a socket the skipper opened by hand is theirs: the policy neither opens nor closes anything', () => {
        pairing.record = { deviceId: 'pi' };
        InstrumentSourcePolicy.boot(T0);
        InstrumentSourcePolicy.noteManualConnect(T0);
        InstrumentSourcePolicy.tick(T0 + PI_SILENT_MS * 3);
        expect(listener.autoStart).not.toHaveBeenCalled();
        expect(InstrumentSourcePolicy.mode()).toBe('manual');
        InstrumentSourcePolicy.noteManualDisconnect(T0 + PI_SILENT_MS * 3);
        expect(InstrumentSourcePolicy.mode()).toBe('pi');
    });

    it('no saved gateway means no fallback: a silent Pi leaves the phone with the cloud, not a guessed socket', () => {
        pairing.record = { deviceId: 'pi' };
        listener.saved = null;
        InstrumentSourcePolicy.boot(T0);
        InstrumentSourcePolicy.tick(T0 + PI_SILENT_MS * 2);
        expect(listener.autoStart).not.toHaveBeenCalled();
    });
});
