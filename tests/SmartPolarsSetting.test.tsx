/**
 * The Smart Polars switch in Settings → Preferences (build 126, package
 * 126-B6a; polars-01).
 *
 * Two faults, one switch:
 * - It was greyed out unless this phone's own gateway socket was open. On a
 *   Pi boat that socket never opens (Shane 2026-09-07: "no more signal k or
 *   ydwg-02 on the actual phone unless there is no pi available"), so Serene
 *   Summer could never turn it on. It now turns on with any boat link: a Pi
 *   paired, or a gateway saved.
 * - Turning it OFF stopped the whole instrument store and the socket: the
 *   Instrument Panel emptied, the boat's GPS left Anchor Watch and the Log,
 *   and the AIS targets — the collision alarm's — were cleared. Off now stops
 *   the learner and nothing else. These tests flip it with those consumers
 *   live and watch them carry on.
 *
 * Real NmeaStore, NmeaGpsProvider, AisStore, InstrumentSourcePolicy and
 * learner. The socket is a fake (no connection is ever opened), the Pi's LAN
 * lane is played by ingestRemote. Fictional boats: "Albatross" off Belle-Île
 * (Pi paired), "Kittiwake" in Puget Sound (a gateway, no Pi).
 */
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({
    status: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
    saved: null as { host: string; port: number } | null,
    samples: new Set<(s: unknown) => void>(),
    statuses: new Set<(s: string) => void>(),
    start: vi.fn(),
    stop: vi.fn(),
    configure: vi.fn(),
    autoStart: vi.fn(() => false),
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
        getSavedConfig: () => socket.saved,
        isEnabled: () => socket.status !== 'disconnected',
        setResumeGate: vi.fn(),
        start: socket.start,
        stop: socket.stop,
        configure: socket.configure,
        autoStart: socket.autoStart,
    },
}));
const pairing = vi.hoisted(() => ({ record: null as Record<string, string> | null }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => pairing.record,
    pinnedPiRequest: vi.fn(() => Promise.reject(new Error('no network in tests'))),
}));
const piLane = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../services/PiTelemetryService', () => ({
    PiTelemetryService: {
        start: piLane.start,
        stop: piLane.stop,
        lastSeenAt: () => null,
        getState: () => 'off',
        subscribe: () => () => undefined,
    },
}));
vi.mock('../services/boatLink/BoatLinkService', () => ({
    BoatLinkService: { evaluate: () => ({ where: 'aboard', fallbackPermitted: false }) },
}));
vi.mock('../services/CloudTelemetryService', () => ({ CloudTelemetryService: { readOnce: async () => null } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SmartPolarsSetting } from '../components/settings/SmartPolarsSetting';
import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { AisStore } from '../services/AisStore';
import { SmartPolarService } from '../services/SmartPolarService';
import type { UserSettings } from '../types';

const ALBATROSS_PI = {
    deviceId: 'albatross-pi',
    boatName: 'Albatross',
    publicKeySpki: 'fictional-spki',
    fingerprint: 'AA:BB',
    host: '10.20.0.5',
    pairedAt: '2026-10-01T08:00:00Z',
};
const KITTIWAKE_GATEWAY = { host: '192.168.4.1', port: 10110 };

const piSnapshot = (over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via: 'lan',
    deviceLabel: 'albatross-pi',
    reportedAt: Date.now() - 300,
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

const settingsWith = (smartPolarsEnabled: boolean) => ({ smartPolarsEnabled }) as unknown as UserSettings;

function setSocket(status: typeof socket.status): void {
    socket.status = status;
    for (const cb of [...socket.statuses]) cb(status);
}

/** The switch as Preferences holds it: each flip saved and shown. */
const Harness: React.FC<{ on: boolean }> = ({ on }) => {
    const [settings, setSettings] = useState(settingsWith(on));
    return <SmartPolarsSetting settings={settings} onSave={(patch) => setSettings({ ...settings, ...patch })} />;
};

const smartSwitch = () => screen.getByRole('switch', { name: 'Smart Polars' }) as HTMLButtonElement;

const learnerStop = vi.spyOn(SmartPolarService, 'stop');
const learnerStart = vi.spyOn(SmartPolarService, 'start');
const storeStop = vi.spyOn(NmeaStore, 'stop');

beforeEach(() => {
    socket.status = 'disconnected';
    socket.saved = null;
    socket.samples.clear();
    socket.statuses.clear();
    socket.start.mockClear();
    socket.stop.mockClear();
    socket.configure.mockClear();
    socket.autoStart.mockClear();
    piLane.start.mockClear();
    pairing.record = null;
    learnerStop.mockClear();
    learnerStart.mockClear();
    storeStop.mockClear();
});
afterEach(() => {
    cleanup();
    SmartPolarService.stop();
    NmeaStore.stop();
    localStorage.clear();
});

describe('the switch turns on with any boat link', () => {
    it('a Pi paired, the socket shut (as the Pi-first rule keeps it): the switch can be turned on', () => {
        pairing.record = ALBATROSS_PI;
        render(<SmartPolarsSetting settings={settingsWith(false)} onSave={vi.fn()} />);
        expect(smartSwitch().disabled).toBe(false);
        expect(screen.queryByText(/Needs your/)).toBeNull();
    });

    it('a gateway saved and not connected yet, no Pi: the switch can be turned on', () => {
        socket.saved = KITTIWAKE_GATEWAY;
        render(<SmartPolarsSetting settings={settingsWith(false)} onSave={vi.fn()} />);
        expect(smartSwitch().disabled).toBe(false);
    });

    it('nothing set up: greyed out, saying what it needs, with the way to the instruments page', () => {
        const navigate = vi.fn();
        window.addEventListener('thalassa:navigate', navigate);
        render(<SmartPolarsSetting settings={settingsWith(false)} onSave={vi.fn()} />);
        expect(smartSwitch().disabled).toBe(true);
        const caption = document.getElementById(smartSwitch().getAttribute('aria-describedby') ?? '');
        expect(caption?.textContent).toBe('Needs your boat’s instruments: pair the Pi, or set up an NMEA gateway.');
        fireEvent.click(screen.getByRole('button', { name: 'set up an NMEA gateway' }));
        window.removeEventListener('thalassa:navigate', navigate);
        expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'nmea' });
    });

    it('a gateway set up while the page is open: the switch wakes without a reload', () => {
        render(<SmartPolarsSetting settings={settingsWith(false)} onSave={vi.fn()} />);
        expect(smartSwitch().disabled).toBe(true);
        socket.saved = KITTIWAKE_GATEWAY;
        act(() => setSocket('connected'));
        expect(smartSwitch().disabled).toBe(false);
    });

    it('turning it on with a Pi paired asks the policy for the feed and opens no socket', async () => {
        pairing.record = ALBATROSS_PI;
        const onSave = vi.fn();
        render(<SmartPolarsSetting settings={settingsWith(false)} onSave={onSave} />);
        await act(async () => {
            fireEvent.click(smartSwitch());
        });
        expect(onSave).toHaveBeenCalledWith({ smartPolarsEnabled: true });
        expect(learnerStart).toHaveBeenCalledTimes(1);
        expect(piLane.start).toHaveBeenCalled();
        expect(socket.configure).not.toHaveBeenCalled();
        expect(socket.start).not.toHaveBeenCalled();
        expect(socket.autoStart).not.toHaveBeenCalled();
        // …and the learner hears the Pi.
        NmeaStore.ingestRemote(piSnapshot());
        expect(SmartPolarService.getStatus().minimumSpeed).toBe('pass');
    });
});

describe('turning it off stops only the learner', () => {
    it('on a Pi boat, the Instrument Panel, the boat GPS for Anchor Watch and the Log, and AIS all keep running', async () => {
        pairing.record = ALBATROSS_PI;
        // As InstrumentSourcePolicy.boot does with a Pi paired: the store (with
        // the boat GPS provider and AIS), and the LAN lane.
        NmeaStore.start();
        await SmartPolarService.start();
        NmeaStore.ingestRemote(piSnapshot());
        AisStore.update({ mmsi: 227123450, lat: 47.36, lon: -3.21, sog: 11.2, cog: 140, lastUpdated: Date.now() });

        const panel = vi.fn();
        const offPanel = NmeaStore.subscribe(panel);
        const boatGps = vi.fn();
        const offGps = NmeaGpsProvider.onPosition(boatGps);
        const traffic = vi.fn();
        const offTraffic = AisStore.subscribe(traffic);

        render(<SmartPolarsSetting settings={settingsWith(true)} onSave={vi.fn()} />);
        expect(smartSwitch().getAttribute('aria-checked')).toBe('true');
        fireEvent.click(smartSwitch());

        expect(learnerStop).toHaveBeenCalled();
        expect(storeStop).not.toHaveBeenCalled();
        expect(socket.stop).not.toHaveBeenCalled();

        // Nothing emptied.
        const state = NmeaStore.getState();
        expect(state.connectionStatus).toBe('remote');
        expect(state.remote?.via).toBe('lan');
        expect(state.tws.value).toBe(14);
        expect(NmeaStore.isBoatFeed()).toBe(true);
        expect(NmeaStore.hasGpsFix()).toBe(true);
        expect(NmeaGpsProvider.getFeedStatus()).toBe('live');
        expect(NmeaGpsProvider.getPosition()?.latitude).toBe(47.33);
        expect(AisStore.getCount()).toBe(1);

        // …and still updating: the next Pi reading and the next AIS report arrive.
        panel.mockClear();
        boatGps.mockClear();
        traffic.mockClear();
        NmeaStore.ingestRemote(piSnapshot({ twsKts: 15.5, lat: 47.331 }));
        AisStore.update({ mmsi: 227123451, lat: 47.4, lon: -3.25, sog: 6, cog: 300, lastUpdated: Date.now() });
        expect(panel).toHaveBeenCalled();
        expect(NmeaStore.getState().tws.value).toBe(15.5);
        expect(boatGps).toHaveBeenCalled();
        expect(NmeaGpsProvider.getPosition()?.latitude).toBe(47.331);
        expect(traffic).toHaveBeenCalled();
        expect(AisStore.getCount()).toBe(2);
        // The learner itself has stopped.
        expect(SmartPolarService.getStatus().recording).toBe(false);

        offPanel();
        offGps();
        offTraffic();
    });

    it("on a gateway boat, the gateway socket stays open: it is the instrument policy's, not this switch's", () => {
        socket.saved = KITTIWAKE_GATEWAY;
        socket.status = 'connected';
        NmeaStore.start();
        render(<SmartPolarsSetting settings={settingsWith(true)} onSave={vi.fn()} />);
        fireEvent.click(smartSwitch());
        expect(learnerStop).toHaveBeenCalled();
        expect(socket.stop).not.toHaveBeenCalled();
        expect(storeStop).not.toHaveBeenCalled();
        expect(NmeaStore.getState().connectionStatus).toBe('connected');
        expect(NmeaStore.isBoatFeed()).toBe(true);
    });
});

describe('turning it on, on a gateway boat, aims at the gateway the skipper saved', () => {
    // The old call passed settings.nmeaHost/nmeaPort, which nothing ever
    // writes, so it fell back to 192.168.1.1:10110 — the old default pair the
    // NMEA page deletes as wrong — and re-aimed every later reconnect there.
    const OLD_DEFAULT = ['192.168.1.1', 10110];

    it('socket connected: off, on, off — never re-aimed, never stopped', async () => {
        socket.saved = KITTIWAKE_GATEWAY;
        socket.status = 'connected';
        NmeaStore.start();
        render(<Harness on />);
        for (let i = 0; i < 3; i++) {
            await act(async () => {
                fireEvent.click(smartSwitch());
            });
        }
        expect(smartSwitch().getAttribute('aria-checked')).toBe('false');
        expect(socket.configure.mock.calls).not.toContainEqual(OLD_DEFAULT);
        for (const call of socket.configure.mock.calls) {
            expect(call).toEqual([KITTIWAKE_GATEWAY.host, KITTIWAKE_GATEWAY.port]);
        }
        expect(socket.stop).not.toHaveBeenCalled();
        expect(storeStop).not.toHaveBeenCalled();
    });

    it('socket disconnected (Disconnect pressed, or parked): on starts it at the saved address', async () => {
        socket.saved = { host: '192.0.2.10', port: 1457 };
        render(<Harness on={false} />);
        expect(smartSwitch().disabled).toBe(false);
        await act(async () => {
            fireEvent.click(smartSwitch());
        });
        expect(socket.configure.mock.calls).toEqual([['192.0.2.10', 1457]]);
        expect(socket.start).toHaveBeenCalledTimes(1);
    });
});
