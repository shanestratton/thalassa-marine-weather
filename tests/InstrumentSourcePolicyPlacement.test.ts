/**
 * The gateway socket is not this phone's to take from ashore.
 *
 * Shane 2026-10-07, at home with the boat 900 km away and reading her over a
 * Tailscale subnet route: "gateway settings, sometime take over". The policy
 * opened the saved gateway whenever the Pi had been silent for a minute and
 * the cloud had not vouched for her — and over a VPN that carries the boat's
 * network the gateway answers from anywhere, so it took one of the YDWG-02's
 * three client slots from the kitchen table (the probe opened 13 sockets in
 * three minutes with the slots full). Now WHERE decides: aboard, or place
 * unknown with the phone on the gateway's own network and no VPN up.
 *
 * And the Pi lane itself: one jittery miss over 5G no longer costs 15 s, and
 * after the boat-network address misses it tries the Pi's own tailnet address.
 * Fictional data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
    saved: { host: '192.0.2.151', port: 1457 } as { host: string; port: number } | null,
    enabled: false,
    autoStart: vi.fn(() => true),
    stop: vi.fn(),
    gate: null as null | ((kind?: 'parked' | 'retry' | 'rung') => boolean),
}));
const pairing = vi.hoisted(() => ({
    record: { deviceId: 'fixture-pi' } as Record<string, unknown> | null,
    urls: [] as string[],
    respond: ((url: string) => Promise.reject(new Error(`no answer from ${url}`))) as (
        url: string,
    ) => Promise<{ status: number; data: string }>,
}));
const cloud = vi.hoisted(() => ({ row: null as null | { source: 'pi' | 'device'; reportedAt: number } }));
const placement = vi.hoisted(() => ({
    where: 'ashore' as 'aboard' | 'ashore' | 'unknown',
    fallbackPermitted: false,
}));
const hosts = vi.hoisted(() => ({
    base: 'https://192.0.2.180:3001' as string | null,
    remote: 'https://100.101.102.104:3001' as string | null,
}));

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => 'disconnected',
        onSample: vi.fn(() => vi.fn()),
        onStatusChange: vi.fn(() => vi.fn()),
        getSavedConfig: () => listener.saved,
        autoStart: () => {
            listener.enabled = true;
            return listener.autoStart();
        },
        stop: () => {
            listener.enabled = false;
            listener.stop();
        },
        isEnabled: () => listener.enabled,
        setResumeGate: (gate: null | ((kind?: 'parked' | 'retry' | 'rung') => boolean)) => {
            listener.gate = gate;
        },
    },
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
}));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn(), update: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => pairing.record,
    pinnedPiRequest: ({ url }: { url: string }) => {
        pairing.urls.push(url);
        return pairing.respond(url);
    },
}));
vi.mock('../services/CloudTelemetryService', () => ({
    CloudTelemetryService: { readOnce: async () => cloud.row },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => hosts.base,
        getRemoteBaseUrl: () => hosts.remote,
        getStatus: () => ({ reachable: true }),
    },
}));
vi.mock('../services/boatLink/BoatLinkService', () => ({
    BoatLinkService: { evaluate: () => ({ where: placement.where, fallbackPermitted: placement.fallbackPermitted }) },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NmeaStore } from '../services/NmeaStore';
import {
    PI_TELEMETRY_QUICK_RETRY_MS,
    PI_TELEMETRY_RETRY_MS,
    PiTelemetryService,
    seenAtWire,
    seenFromWire,
} from '../services/PiTelemetryService';
import { FLAP_GUARD_MS, InstrumentSourcePolicy, PI_SILENT_MS } from '../services/InstrumentSourcePolicy';
import { readRegisteredSocketOwner } from '../services/boatLink/socketOwner';

const T0 = Date.parse('2026-10-07T03:00:00Z');
/** Let the policy's cloud check (a dynamic import and one read) settle. */
const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('InstrumentSourcePolicy: where the phone is decides the fallback', () => {
    let lastSeen: number | null = null;

    beforeEach(() => {
        InstrumentSourcePolicy.resetForTests();
        PiTelemetryService.resetForTests();
        listener.autoStart.mockClear();
        listener.stop.mockClear();
        listener.saved = { host: '192.0.2.151', port: 1457 };
        listener.enabled = false;
        listener.gate = null;
        pairing.record = { deviceId: 'fixture-pi' };
        cloud.row = null;
        placement.where = 'ashore';
        placement.fallbackPermitted = false;
        lastSeen = null;
        vi.spyOn(NmeaStore, 'start').mockImplementation(() => undefined);
        vi.spyOn(PiTelemetryService, 'start').mockImplementation(() => undefined);
        vi.spyOn(PiTelemetryService, 'lastSeenAt').mockImplementation(() => lastSeen);
    });
    afterEach(() => {
        InstrumentSourcePolicy.resetForTests();
        vi.restoreAllMocks();
    });

    const runTicks = async (from: number, to: number) => {
        for (let t = from; t <= to; t += 5_000) {
            InstrumentSourcePolicy.tick(t);
            await settle();
        }
    };

    it('away, the Pi silent and the cloud stale: no socket in ten minutes (probes A and B)', async () => {
        InstrumentSourcePolicy.boot(T0);
        await runTicks(T0 + 5_000, T0 + 10 * 60_000);
        expect(listener.autoStart).not.toHaveBeenCalled();
        expect(InstrumentSourcePolicy.mode()).toBe('pi');
    });

    it('place unknown with no proof of the boat’s own network (a VPN up, or no interface data): no socket', async () => {
        placement.where = 'unknown';
        placement.fallbackPermitted = false;
        InstrumentSourcePolicy.boot(T0);
        await runTicks(T0 + 5_000, T0 + 5 * 60_000);
        expect(listener.autoStart).not.toHaveBeenCalled();
    });

    it('place unknown but on the gateway’s own network with no VPN: the fallback opens, once', async () => {
        placement.where = 'unknown';
        placement.fallbackPermitted = true;
        InstrumentSourcePolicy.boot(T0);
        await runTicks(T0 + 5_000, T0 + 3 * 60_000);
        expect(listener.autoStart).toHaveBeenCalledTimes(1);
        expect(InstrumentSourcePolicy.mode()).toBe('pi-silent-direct');
    });

    it('aboard the fallback opens; the moment the phone is away it closes, flap guard or not', async () => {
        placement.where = 'aboard';
        placement.fallbackPermitted = true;
        InstrumentSourcePolicy.boot(T0);
        await runTicks(T0 + 5_000, T0 + PI_SILENT_MS);
        expect(listener.autoStart).toHaveBeenCalledTimes(1);
        const opened = T0 + PI_SILENT_MS;
        // Walked ashore well inside the flap guard.
        placement.where = 'ashore';
        placement.fallbackPermitted = false;
        InstrumentSourcePolicy.tick(opened + 10_000);
        expect(opened + 10_000 - opened).toBeLessThan(FLAP_GUARD_MS);
        expect(listener.stop).toHaveBeenCalledTimes(1);
        expect(InstrumentSourcePolicy.mode()).toBe('pi');
        // And it does not reopen from ashore.
        await runTicks(opened + 15_000, opened + 10 * 60_000);
        expect(listener.autoStart).toHaveBeenCalledTimes(1);
    });

    it('a parked fallback socket stays parked from ashore; aboard, or a boat with no Pi, it may resume', async () => {
        placement.where = 'aboard';
        placement.fallbackPermitted = true;
        InstrumentSourcePolicy.boot(T0);
        expect(listener.gate).not.toBeNull();
        await runTicks(T0 + 5_000, T0 + PI_SILENT_MS);
        expect(InstrumentSourcePolicy.mode()).toBe('pi-silent-direct');
        expect(listener.gate!()).toBe(true);
        placement.fallbackPermitted = false;
        expect(listener.gate!()).toBe(false);
        // The skipper's own socket is theirs to resume.
        InstrumentSourcePolicy.noteManualConnect(T0 + PI_SILENT_MS + 1);
        expect(listener.gate!()).toBe(true);

        InstrumentSourcePolicy.resetForTests();
        pairing.record = null;
        InstrumentSourcePolicy.boot(T0);
        expect(InstrumentSourcePolicy.mode()).toBe('direct');
        expect(listener.gate!()).toBe(true);
    });

    it('foregrounded or a network change: the fallback’s immediate retry asks as a parked one does; a ladder rung only refuses ashore', async () => {
        placement.where = 'aboard';
        placement.fallbackPermitted = true;
        InstrumentSourcePolicy.boot(T0);
        await runTicks(T0 + 5_000, T0 + PI_SILENT_MS);
        expect(InstrumentSourcePolicy.mode()).toBe('pi-silent-direct');
        expect(listener.gate!('retry')).toBe(true);
        expect(listener.gate!('rung')).toBe(true);
        // Foregrounded at home after a night suspended aboard, before any fresh
        // fix: the place is unknown, and nothing proves the boat's network.
        placement.where = 'unknown';
        placement.fallbackPermitted = false;
        expect(listener.gate!('retry')).toBe(false);
        expect(listener.gate!('parked')).toBe(false);
        // The ladder keeps its own pace while the place is unknown: an unknown
        // place must not strand a fallback that opened aboard.
        expect(listener.gate!('rung')).toBe(true);
        // Ashore: nothing restarts it, and the next tick closes it.
        placement.where = 'ashore';
        expect(listener.gate!('rung')).toBe(false);
        expect(listener.gate!('retry')).toBe(false);
        // The skipper's own socket, and a boat with no Pi, restart as they always have.
        InstrumentSourcePolicy.noteManualConnect(T0 + PI_SILENT_MS + 1);
        expect(listener.gate!('retry')).toBe(true);
        expect(listener.gate!('rung')).toBe(true);
        InstrumentSourcePolicy.resetForTests();
        pairing.record = null;
        InstrumentSourcePolicy.boot(T0);
        expect(listener.gate!('rung')).toBe(true);
        expect(listener.gate!('retry')).toBe(true);
    });

    it('says who opened the socket, for the words on every screen', async () => {
        InstrumentSourcePolicy.boot(T0);
        expect(readRegisteredSocketOwner()).toBe('none');
        placement.where = 'aboard';
        placement.fallbackPermitted = true;
        await runTicks(T0 + 5_000, T0 + PI_SILENT_MS);
        expect(readRegisteredSocketOwner()).toBe('policy');
        InstrumentSourcePolicy.noteManualConnect(T0 + PI_SILENT_MS + 1);
        expect(readRegisteredSocketOwner()).toBe('skipper');

        InstrumentSourcePolicy.resetForTests();
        expect(readRegisteredSocketOwner()).toBeNull();
        pairing.record = null;
        InstrumentSourcePolicy.boot(T0);
        expect(readRegisteredSocketOwner()).toBe('boot');
    });
});

describe('PiTelemetryService: steady over a jittery link, and honest about its path', () => {
    beforeEach(() => {
        PiTelemetryService.resetForTests();
        NmeaStore.clearRemote();
        pairing.record = { deviceId: 'fixture-pi' };
        pairing.urls = [];
        hosts.base = 'https://192.0.2.180:3001';
        hosts.remote = 'https://100.101.102.104:3001';
    });
    afterEach(() => {
        PiTelemetryService.resetForTests();
        vi.useRealTimers();
    });

    it('the first misses retry quickly, then back off', async () => {
        vi.useFakeTimers();
        hosts.remote = null;
        pairing.respond = (url) => Promise.reject(new Error(`timed out: ${url}`));
        PiTelemetryService.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(pairing.urls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(PI_TELEMETRY_QUICK_RETRY_MS[0]);
        expect(pairing.urls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(PI_TELEMETRY_QUICK_RETRY_MS[1]);
        expect(pairing.urls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(PI_TELEMETRY_RETRY_MS - 100);
        expect(pairing.urls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(200);
        expect(pairing.urls).toHaveLength(4);
    });

    it('after the boat-network address misses it asks the Pi’s own tailnet address, and keeps the one that answered', async () => {
        pairing.respond = (url) =>
            url.startsWith('https://100.101.102.104')
                ? Promise.resolve({
                      status: 200,
                      data: JSON.stringify({
                          available: false,
                          telemetry: null,
                          ais: [],
                          path: { seen_from: '100.101.102.103' },
                      }),
                  })
                : Promise.reject(new Error('no route to host'));
        expect(await PiTelemetryService.pollOnce()).toBe('unreachable');
        expect(await PiTelemetryService.pollOnce()).toBe('quiet');
        expect(await PiTelemetryService.pollOnce()).toBe('quiet');
        expect(pairing.urls).toEqual([
            'https://192.0.2.180:3001/api/telemetry',
            'https://100.101.102.104:3001/api/telemetry',
            'https://100.101.102.104:3001/api/telemetry',
        ]);
        expect(PiTelemetryService.pathInfo()).toEqual({
            answeredVia: 'tailnet-host',
            seenFrom: '100.101.102.103',
            seenAt: null,
        });
    });

    it('records which saved address answered and the Pi’s echo — and nothing about where the phone is', async () => {
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({ available: false, telemetry: null, ais: [], path: { seen_from: '192.0.2.1' } }),
            });
        await PiTelemetryService.pollOnce();
        expect(PiTelemetryService.pathInfo()).toEqual({ answeredVia: 'lan-host', seenFrom: '192.0.2.1', seenAt: null });
        // A newer Pi also says which of its own addresses took the request.
        pairing.respond = () =>
            Promise.resolve({
                status: 200,
                data: JSON.stringify({
                    available: false,
                    telemetry: null,
                    ais: [],
                    path: { seen_from: '192.0.2.37', seen_at: '192.0.2.180' },
                }),
            });
        await PiTelemetryService.pollOnce();
        expect(PiTelemetryService.pathInfo()).toEqual({
            answeredVia: 'lan-host',
            seenFrom: '192.0.2.37',
            seenAt: '192.0.2.180',
        });
        // An older Pi sends no echo.
        pairing.respond = () =>
            Promise.resolve({ status: 200, data: JSON.stringify({ available: false, telemetry: null, ais: [] }) });
        await PiTelemetryService.pollOnce();
        expect(PiTelemetryService.pathInfo().seenFrom).toBeNull();
    });

    it('reads the echo strictly', () => {
        expect(seenFromWire({ seen_from: '192.0.2.37' })).toBe('192.0.2.37');
        expect(seenFromWire({ seen_from: '192.0.2.377' })).toBeNull();
        expect(seenFromWire({ seen_from: 'fe80::1' })).toBeNull();
        expect(seenFromWire({ seen_from: 7 })).toBeNull();
        expect(seenFromWire(null)).toBeNull();
        expect(seenFromWire('192.0.2.37')).toBeNull();
        expect(seenAtWire({ seen_at: '192.0.2.180' })).toBe('192.0.2.180');
        expect(seenAtWire({ seen_at: '::1' })).toBeNull();
        expect(seenAtWire({ seen_from: '192.0.2.37' })).toBeNull();
    });
});
