/**
 * The Smart Polars learner's one feed (build 126, package 126-B6a; polars-01).
 *
 * The learner used to hear only this phone's own gateway socket. On a boat
 * with a Pi paired that socket never opens (Shane 2026-09-07: "no more signal
 * k or ydwg-02 on the actual phone unless there is no pi available"), so the
 * learner heard nothing at all while the Pi's LAN lane filled NmeaStore.
 *
 * Now it hears exactly one source: the socket's samples, passed straight
 * through, or the Pi over the boat link (its LAN or tailnet address), taken
 * from NmeaStore — source 'pi', a reading that has moved on, one per 5 s,
 * live metrics only, stamped with this phone's clock, and the wind only when
 * the Pi dated it. The cloud row and a crew phone's shared GPS never feed it,
 * and a fault in the learner never reaches the instruments.
 *
 * Real NmeaStore; PiTelemetryService is not started — ingestRemote is driven
 * directly, as the LAN lane would. Fictional boat "Albatross", off Belle-Île.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

const socket = vi.hoisted(() => ({
    status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
    samples: new Set<(s: unknown) => void>(),
    statuses: new Set<(s: string) => void>(),
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => socket.status,
        onSample: (cb: (s: unknown) => void) => {
            socket.samples.add(cb);
            return () => socket.samples.delete(cb);
        },
        onStatusChange: (cb: (s: string) => void) => {
            socket.statuses.add(cb);
            return () => socket.statuses.delete(cb);
        },
        getSavedConfig: () => null,
        start: vi.fn(),
        stop: vi.fn(),
    },
}));
const piLane = vi.hoisted(() => ({
    state: 'off' as string,
    listeners: new Set<(s: string) => void>(),
}));
vi.mock('../services/PiTelemetryService', () => ({
    PiTelemetryService: {
        getState: () => piLane.state,
        subscribe: (cb: (s: string) => void) => {
            piLane.listeners.add(cb);
            return () => piLane.listeners.delete(cb);
        },
    },
}));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logs.warn, error: vi.fn() }),
}));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import {
    learnerFeedState,
    subscribeLearnerFeedState,
    subscribeLearnerSamples,
    type LearnerSample,
} from '../services/smartPolarFeed';

const T0 = Date.parse('2026-10-10T09:00:00Z');

/**
 * Albatross's Pi, as the LAN lane hands it to the store: TWS 14, TWA 95, STW
 * 6.2, heading 210, engine off. The TWS leaf is dated by the Pi 300 ms before
 * this phone read it (extra.wind_tws_at_ms), on the Pi's own clock — not the
 * GPS clock reportedAt carries.
 */
const piSnapshot = (reportedAt: number, over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via: 'lan',
    deviceLabel: 'albatross-pi',
    reportedAt,
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

const gatewaySample = (timestamp: number, tws: number): NmeaSample => ({
    timestamp,
    tws,
    twa: 120,
    stw: 7.1,
    heading: 45,
    rpm: null,
    rudder: null,
    rudderSwing: null,
    voltage: 13.0,
    depth: null,
    sog: null,
    cog: null,
    waterTemp: null,
    latitude: null,
    longitude: null,
    hdop: null,
    satellites: null,
    gpsFixQuality: null,
});

/** Snapshots every 2 s, the LAN lane's poll, each read 300 ms after the Pi took it. */
function sailFor(seconds: number, over: Partial<RemoteInstrumentSnapshot> = {}): void {
    for (let t = 0; t < seconds; t += 2) {
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, over));
        vi.advanceTimersByTime(2_000);
    }
}

beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    socket.status = 'disconnected';
    socket.samples.clear();
    socket.statuses.clear();
    logs.warn.mockClear();
    piLane.state = 'off';
    piLane.listeners.clear();
    NmeaStore.clearRemote();
});
afterEach(() => {
    NmeaStore.clearRemote();
    vi.useRealTimers();
});

describe('the Pi over the boat link feeds the learner', () => {
    it('LAN snapshots every 2 s for 20 s give 4 samples, one per 5 s, each with wind, speed, heading and engine', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        sailFor(20);
        off();

        expect(got).toHaveLength(4);
        for (const s of got) {
            expect(s).toMatchObject({ tws: 14, twa: 95, stw: 6.2, heading: 210, rpm: 0, voltage: 12.8 });
        }
        // At least the 5 s cadence apart, on this phone's clock.
        for (let i = 1; i < got.length; i++) {
            expect(got[i].timestamp - got[i - 1].timestamp).toBeGreaterThanOrEqual(5_000);
        }
    });

    it('stamps each sample with the time this phone read it: a Pi clock a minute fast drops nothing', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        const before = Date.now();
        NmeaStore.ingestRemote(piSnapshot(Date.now() + 60_000));
        off();
        expect(got).toHaveLength(1);
        expect(got[0].timestamp).toBe(before);
    });

    it('a held reading (the same reportedAt again) is not a new sample', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        const held = Date.now() - 300;
        NmeaStore.ingestRemote(piSnapshot(held));
        vi.advanceTimersByTime(6_000);
        NmeaStore.ingestRemote(piSnapshot(held));
        vi.advanceTimersByTime(6_000);
        NmeaStore.ingestRemote(piSnapshot(held));
        expect(got).toHaveLength(1);
        // The reading moves on: learning again.
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300));
        off();
        expect(got).toHaveLength(2);
    });

    it('takes only live metrics: an engine reading the Pi stopped sending goes null, never stale', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300));
        vi.advanceTimersByTime(8_000);
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, { rpm: null, voltageV: null }));
        off();
        expect(got).toHaveLength(2);
        expect(got[0]).toMatchObject({ rpm: 0, voltage: 12.8 });
        expect(got[1]).toMatchObject({ tws: 14, stw: 6.2, rpm: null, voltage: null });
    });

    it('the wind only when the Pi dated it: a masthead unit gone quiet, held by Signal K, gives no wind', () => {
        // Signal K keeps the last TWS/TWA of a sensor that has stopped; the Pi
        // forwards them with no leaf time, and the store stamps them on
        // receipt. The boat speed keeps changing.
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        for (let i = 0; i < 10; i++) {
            NmeaStore.ingestRemote(
                piSnapshot(Date.now() - 300, {
                    windSampleAt: undefined,
                    windSampleSource: undefined,
                    stwKts: 4 + i * 0.3,
                }),
            );
            vi.advanceTimersByTime(2_000);
        }
        off();
        expect(NmeaStore.getState().tws.value).toBe(14); // the gauge still shows the held value
        expect(got.length).toBeGreaterThanOrEqual(3);
        for (const s of got) expect([s.tws, s.twa]).toEqual([null, null]);
        expect(got.map((s) => s.stw)).not.toContain(null);
    });

    it('a wind leaf time that stops moving on gives no wind after the first sample', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        const leafAt = Date.now() - 300;
        for (let i = 0; i < 4; i++) {
            NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, { windSampleAt: leafAt }));
            vi.advanceTimersByTime(3_000);
        }
        off();
        expect(got).toHaveLength(2);
        expect(got[0]).toMatchObject({ tws: 14, twa: 95 });
        expect(got[1]).toMatchObject({ tws: null, twa: null, stw: 6.2 });
    });

    it('carries the speed over the ground, so the learner can tell a mooring in a stream from sailing', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, { sogKts: 0.2, stwKts: 2.1 }));
        off();
        expect(got[0]).toMatchObject({ sog: 0.2, stw: 2.1 });
    });

    it('the cloud row never feeds it — the boat seen from ashore, up to a minute old', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        sailFor(20, { via: 'cloud' });
        off();
        expect(NmeaStore.getState().remote?.via).toBe('cloud');
        expect(got).toHaveLength(0);
    });

    it("a crew phone's shared GPS (source 'device') is not instruments, and never feeds it", () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        sailFor(20, { source: 'device', deviceLabel: 'crew phone' });
        off();
        expect(NmeaStore.getState().remote?.source).toBe('device');
        expect(got).toHaveLength(0);
    });

    it('stops at once when unsubscribed', () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        off();
        sailFor(20);
        expect(got).toHaveLength(0);
    });

    it('a learner that throws never reaches the instruments: later subscribers still get the reading', () => {
        const off = subscribeLearnerSamples(() => {
            throw new TypeError('a learner fault');
        });
        const panel = vi.fn();
        const offPanel = NmeaStore.subscribe(panel);
        expect(NmeaStore.ingestRemote(piSnapshot(Date.now() - 300))).toBe(true);
        expect(panel).toHaveBeenCalledTimes(1);
        // …and from the socket too: the throw stays in the learner.
        socket.status = 'connected';
        expect(() => {
            for (const cb of socket.samples) cb(gatewaySample(Date.now(), 18));
        }).not.toThrow();
        socket.status = 'disconnected'; // as the store's clearRemote in afterEach must see it
        offPanel();
        off();
        // Said once, with no names.
        expect(logs.warn).toHaveBeenCalledTimes(1);
        expect(String(logs.warn.mock.calls[0][0])).not.toMatch(/albatross/i);
    });

    it('says so in the log, without the boat or Pi name, when the Pi stops reaching the learner', () => {
        const off = subscribeLearnerSamples(() => undefined);
        sailFor(10);
        NmeaStore.clearRemote('lan');
        off();
        expect(logs.warn).toHaveBeenCalledTimes(1);
        expect(String(logs.warn.mock.calls[0][0])).not.toMatch(/albatross/i);
    });
});

describe('a gateway socket: one source, never both', () => {
    it("passes the socket's samples straight through, and the LAN lane adds nothing while it is connected", () => {
        const got: LearnerSample[] = [];
        const off = subscribeLearnerSamples((s) => got.push(s));
        socket.status = 'connected';
        const a = gatewaySample(Date.now(), 18);
        for (const cb of socket.samples) cb(a);
        vi.advanceTimersByTime(5_000);
        const b = gatewaySample(Date.now(), 18.4);
        for (const cb of socket.samples) cb(b);
        // The Pi answering too (the Pi-silent fallback): the store refuses it,
        // so the learner cannot count the same wind twice.
        expect(NmeaStore.ingestRemote(piSnapshot(Date.now() - 300))).toBe(false);
        vi.advanceTimersByTime(6_000);
        expect(NmeaStore.ingestRemote(piSnapshot(Date.now() - 300))).toBe(false);
        off();
        expect(got).toEqual([a, b]);
    });
});

describe('learnerFeedState: where the learner hears the boat from', () => {
    it("'pi' with the Pi over the boat link", () => {
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300));
        expect(learnerFeedState()).toBe('pi');
    });

    it("'gateway' with this phone's socket connected", () => {
        socket.status = 'connected';
        expect(learnerFeedState()).toBe('gateway');
    });

    it("'cloud' with only the cloud row (or a crew phone's GPS)", () => {
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, { via: 'cloud' }));
        expect(learnerFeedState()).toBe('cloud');
        NmeaStore.clearRemote();
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300, { source: 'device', deviceLabel: 'crew phone' }));
        expect(learnerFeedState()).toBe('cloud');
    });

    it("'quiet' with the Pi answering and her instruments switched off", () => {
        piLane.state = 'quiet';
        expect(learnerFeedState()).toBe('quiet');
        piLane.state = 'unreachable';
        expect(learnerFeedState()).toBe('none');
    });

    it("'none' with nothing reaching the boat", () => {
        expect(learnerFeedState()).toBe('none');
        socket.status = 'connecting';
        expect(learnerFeedState()).toBe('none');
    });

    it('tells a subscriber each change, once', () => {
        const seen: string[] = [];
        const off = subscribeLearnerFeedState((s) => seen.push(s));
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300));
        vi.advanceTimersByTime(2_000);
        NmeaStore.ingestRemote(piSnapshot(Date.now() - 300));
        NmeaStore.clearRemote('lan');
        piLane.state = 'quiet';
        for (const cb of piLane.listeners) cb('quiet');
        socket.status = 'connected';
        for (const cb of socket.statuses) cb('connected');
        off();
        expect(seen).toEqual(['pi', 'none', 'quiet', 'gateway']);
    });
});
