/**
 * Smart Polars learn on a Pi boat (build 126, package 126-B6a; polars-01).
 *
 * The learner subscribed to the phone's own gateway socket and nothing else.
 * With a Pi paired that socket never opens (the Pi-first rule), so on Serene
 * Summer, or any Pi boat, the switch could be on all season and record
 * nothing. Now the learner hears the Pi over the boat link too.
 *
 * The real learner, the real grid and the real instrument store, started the
 * way InstrumentSourcePolicy starts it for a Pi boat; the Pi's LAN lane is
 * played by ingestRemote every 2 s. Fictional boats: "Albatross", off
 * Belle-Île (a Pi), "Kittiwake" in Puget Sound (a gateway, no Pi).
 *
 * What it must not learn from: wind the Pi did not date (a masthead unit gone
 * quiet, its last value held by Signal K), and a boat that is not going
 * anywhere — moored, berthed or anchored in a stream, where the log reads the
 * current going by.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({
    status: 'disconnected' as string,
    samples: new Set<(s: unknown) => void>(),
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => socket.status,
        onSample: (cb: (s: unknown) => void) => {
            socket.samples.add(cb);
            return () => socket.samples.delete(cb);
        },
        onStatusChange: () => () => undefined,
        getSavedConfig: () => null,
        start: vi.fn(),
        stop: vi.fn(),
    },
}));
vi.mock('../services/PiTelemetryService', () => ({
    PiTelemetryService: { getState: () => 'live', subscribe: () => () => undefined },
}));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { SmartPolarService } from '../services/SmartPolarService';
import { SmartPolarStore } from '../services/SmartPolarStore';

const piSnapshot = (over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via: 'lan',
    deviceLabel: 'albatross-pi',
    reportedAt: Date.now() - 300,
    // The TWS leaf's own time, as the Pi sends it while the wind is fresh.
    windSampleAt: Date.now() - 300,
    windSampleSource: 'masthead.115',
    lat: 47.33,
    lon: -3.18,
    sogKts: 6.4,
    cogDeg: 212,
    headingDeg: 210,
    stwKts: 6.2,
    twsKts: 14,
    twaDeg: 95,
    twdDeg: 305,
    awsKts: 15.1,
    awaDeg: 70,
    depthM: 22,
    heelDeg: 12,
    pitchDeg: 1,
    waterTempC: 16.5,
    rudderDeg: 3,
    rpm: 0,
    voltageV: 12.8,
    ...over,
});

/** Steady sailing for `seconds`, the LAN lane's 2 s poll, inclusive of both ends. */
function sail(seconds: number, over: Partial<RemoteInstrumentSnapshot> = {}): void {
    for (let t = 0; t <= seconds; t += 2) {
        NmeaStore.ingestRemote(piSnapshot(over));
        if (t < seconds) vi.advanceTimersByTime(2_000);
    }
}

const recordSample = vi.spyOn(SmartPolarStore, 'recordSample');

beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T09:00:00Z') });
    socket.status = 'disconnected';
    // As InstrumentSourcePolicy.boot does with a Pi paired: the store, and no socket.
    NmeaStore.start();
    recordSample.mockClear();
    await SmartPolarService.start();
});
afterEach(() => {
    SmartPolarService.stop();
    SmartPolarService.resetStats();
    NmeaStore.stop();
    vi.useRealTimers();
});

describe('Smart Polars learn on a Pi boat', () => {
    it('60 s of steady sailing over the boat link records samples once the 30 s steady window passes', () => {
        sail(60);
        expect(socket.samples.size).toBeGreaterThan(0); // the socket path is still there for a gateway boat
        expect(recordSample.mock.calls.length).toBeGreaterThanOrEqual(6);
        for (const [tws, twa, stw] of recordSample.mock.calls) {
            expect([tws, twa, stw]).toEqual([14, 95, 6.2]);
        }
        const status = SmartPolarService.getStatus();
        expect(status.recording).toBe(true);
        expect(status.engineOff).toBe('pass');
    });

    it("the Pi's engine reading reaches the learner: motor-sailing at 1,800 rpm records nothing", () => {
        sail(60, { rpm: 1800 });
        expect(recordSample).not.toHaveBeenCalled();
        expect(SmartPolarService.getStatus().engineOff).toBe('fail');
    });

    it('a masthead unit gone quiet: wind held with no leaf time, boat speed still changing, records nothing', () => {
        for (let t = 0; t <= 120; t += 2) {
            NmeaStore.ingestRemote(
                piSnapshot({ windSampleAt: undefined, windSampleSource: undefined, stwKts: 4 + (t % 12) * 0.1 }),
            );
            if (t < 120) vi.advanceTimersByTime(2_000);
        }
        expect(NmeaStore.getState().tws.value).toBe(14);
        expect(recordSample).not.toHaveBeenCalled();
    });

    it('moored in a 2 kn stream (the log reads the current, the ground says she is still): records nothing', () => {
        sail(60, { sogKts: 0.2, stwKts: 2.1 });
        expect(recordSample).not.toHaveBeenCalled();
        expect(SmartPolarService.getStatus().minimumSpeed).toBe('fail');
    });

    it('the same check on a gateway boat: STW 2.1 with SOG 0.1 is a mooring, SOG unknown is not held against her', () => {
        const kittiwake = (timestamp: number, sog: number | null) => ({
            timestamp,
            tws: 12,
            twa: 110,
            stw: 2.1,
            heading: 80,
            rpm: null,
            voltage: 12.9,
            sog,
        });
        socket.status = 'connected';
        for (let t = 0; t <= 60; t += 5) {
            for (const cb of socket.samples) cb(kittiwake(Date.now(), 0.1));
            vi.advanceTimersByTime(5_000);
        }
        expect(recordSample).not.toHaveBeenCalled();
        for (let t = 0; t <= 60; t += 5) {
            for (const cb of socket.samples) cb(kittiwake(Date.now(), null));
            vi.advanceTimersByTime(5_000);
        }
        expect(recordSample).toHaveBeenCalled();
        expect(recordSample.mock.calls[0]).toEqual([12, 110, 2.1]);
    });

    it('the cloud row never teaches it: the same boat, seen from ashore, records nothing', () => {
        sail(60, { via: 'cloud' });
        expect(recordSample).not.toHaveBeenCalled();
    });

    it("a crew phone sharing its GPS (source 'device') records nothing", () => {
        sail(60, { source: 'device', deviceLabel: 'crew phone' });
        expect(recordSample).not.toHaveBeenCalled();
    });
});
