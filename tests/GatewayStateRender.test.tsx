/**
 * The NMEA Gateway page and Remote Access, rendered, while the boat's lanes
 * answer in turn — Shane 2026-10-07, at home with the boat 900 km away and
 * reading her over a Tailscale subnet route: "sometime take over, other times
 * it says i am onboard, sometimes it says remote, other times it says live."
 *
 * The real instrument store, the real boat-link service and the real page;
 * only the edges are faked (the gateway socket, the Pi lane's path record,
 * the phone's fix and interfaces, the Pi cache). Live elements are read
 * inside waitFor. Fictional data only.
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
    status: 'disconnected' as string,
    enabled: false,
    statusListeners: new Set<(s: string) => void>(),
}));
const pairing = vi.hoisted(() => ({ record: { deviceId: 'fixture-pi' } as Record<string, unknown> | null }));
const pi = vi.hoisted(() => ({
    path: {
        answeredVia: 'lan-host' as 'lan-host' | 'tailnet-host' | null,
        seenFrom: null as string | null,
        seenAt: null as string | null,
    },
}));
const phone = vi.hoisted(() => ({
    live: null as null | { latitude: number; longitude: number; accuracy: number; timestamp: number },
}));
const net = vi.hoisted(() => ({
    interfaces: [] as Array<{ name: string; address: string; family: 'ipv4' | 'ipv6'; tunnel: boolean }>,
}));

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        isEnabled: () => listener.enabled,
        isReconnecting: () => false,
        getReconnectAttempts: () => 0,
        getLastError: () => null,
        getSavedConfig: () => ({ host: '192.0.2.151', port: 1457 }),
        getConnectionInfo: () => ({
            status: listener.status,
            enabled: listener.enabled,
            host: '192.0.2.151',
            port: 1457,
            deviceId: 'ydwg02',
            deviceLabel: 'YDWG-02',
            transport: 'tcp',
        }),
        onSample: () => () => undefined,
        onStatusChange: (cb: (s: string) => void) => {
            listener.statusListeners.add(cb);
            return () => listener.statusListeners.delete(cb);
        },
        configure: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        setResumeGate: vi.fn(),
    },
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
}));
vi.mock('../services/AisStore', () => ({
    AisStore: { start: vi.fn(), stop: vi.fn(), update: vi.fn(), subscribe: () => () => undefined },
}));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => pairing.record }));
vi.mock('../services/PiTelemetryService', () => ({
    PiTelemetryService: {
        pathInfo: () => pi.path,
        getState: () => 'live',
        isPresent: () => true,
        subscribe: () => () => undefined,
        lastSeenAt: () => null,
        start: vi.fn(),
    },
}));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => phone.live } }));
vi.mock('../services/phoneLastFix', () => ({ storedPhoneFix: () => null }));
vi.mock('../services/network/networkContext', () => ({
    getInterfaces: async () => net.interfaces,
    // What the Remote Access card asked before it read the boat link.
    assessHostRoute: async () => ({
        vpnActive: net.interfaces.some((i) => i.tunnel),
        onSameLan: false,
        hairpinLikely: false,
        localAddress: null,
        warning: null,
    }),
}));
vi.mock('../services/GpsReceiverStatusService', () => {
    const status = {
        active: false,
        kind: 'phone',
        label: 'iPhone GPS',
        detail: 'iPhone GPS in use',
        isNmea: false,
        satellites: null,
        hdop: null,
        avgAccuracy: null,
        qualityLabel: null,
        deviceName: null,
    };
    return { GpsReceiverStatusService: { getStatus: () => status, refresh: async () => status } };
});
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        viaRemoteAccess: false,
        onStatusChange: () => () => undefined,
        getStatus: () => ({ reachable: true }),
        // The Pi's boat-network address, and its tailnet one (it runs Tailscale).
        getLanHost: () => '192.0.2.180',
        getRemoteBaseUrl: () => 'https://100.101.102.104:3001',
        fetchRemoteAccessStatus: async () => ({
            state: 'connected',
            dnsName: 'fixture-pi.tail1234.ts.net.',
            tailscaleIps: ['100.101.102.104'],
        }),
        enableRemoteAccess: vi.fn(),
        disableRemoteAccess: vi.fn(),
    },
}));
vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { BoatLinkService } from '../services/boatLink/BoatLinkService';
import { NmeaPage } from '../components/vessel/NmeaPage';
import { RemoteAccessSection } from '../components/settings/RemoteAccessSection';

const BOAT = { lat: -20.27, lon: 148.72 };
const PHONE_AWAY = { lat: -27.21, lon: 153.1 };
const PHONE_ABOARD = { lat: -20.2697, lon: 148.72 };
const HOME_WITH_TAILSCALE = [
    { name: 'en0', address: '10.0.0.23', family: 'ipv4' as const, tunnel: false },
    { name: 'utun4', address: '100.101.102.103', family: 'ipv4' as const, tunnel: true },
];
const BOAT_WIFI_WITH_TAILSCALE = [
    { name: 'en0', address: '192.0.2.37', family: 'ipv4' as const, tunnel: false },
    { name: 'utun4', address: '100.101.102.103', family: 'ipv4' as const, tunnel: true },
];

const snapshot = (via: 'lan' | 'cloud'): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via,
    deviceLabel: 'fixture-pi',
    reportedAt: Date.now() - 2_000,
    positionSampleAt: Date.now() - 2_000,
    lat: BOAT.lat,
    lon: BOAT.lon,
    sogKts: 0.1,
    cogDeg: 200,
    headingDeg: 190,
    stwKts: 0,
    twsKts: 12,
    twaDeg: -40,
    twdDeg: 120,
    awsKts: 13,
    awaDeg: -38,
    depthM: 5.2,
    heelDeg: 0,
    pitchDeg: 0,
    waterTempC: 24,
    rudderDeg: 0,
    rpm: null,
    voltageV: 13,
});

const setPhone = (at: { lat: number; lon: number }) => {
    phone.live = { latitude: at.lat, longitude: at.lon, accuracy: 8, timestamp: Date.now() - 1_000 };
};

beforeEach(async () => {
    localStorage.clear();
    listener.status = 'disconnected';
    listener.enabled = false;
    pairing.record = { deviceId: 'fixture-pi' };
    pi.path = { answeredVia: 'lan-host', seenFrom: null, seenAt: null };
    net.interfaces = HOME_WITH_TAILSCALE;
    setPhone(PHONE_AWAY);
    NmeaStore.clearRemote();
    BoatLinkService.resetForTests();
    await BoatLinkService.refreshNetworkForTests();
});
afterEach(() => {
    cleanup();
    NmeaStore.clearRemote();
    BoatLinkService.resetForTests();
});

describe('the NMEA Gateway page, 891 km from the boat, as her lanes answer in turn', () => {
    const pill = () => screen.getAllByRole('status')[0];

    it('reads "Away · Live" throughout — never Aboard — and the Pi card never gives way to gateway controls', async () => {
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<NmeaPage onBack={() => undefined} />);
        const seen: string[] = [];
        const expectAway = async () =>
            waitFor(() => {
                const text = pill().textContent ?? '';
                expect(text).toBe('Away · Live');
                seen.push(text);
            });

        await expectAway();
        // The direct lane lapses and the cloud fills in.
        act(() => {
            NmeaStore.clearRemote('lan');
            NmeaStore.ingestRemote(snapshot('cloud'));
        });
        await expectAway();
        // Direct again.
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        await expectAway();
        // The policy's fallback socket mid-attempt (it may not open from away
        // any more; even if one did, the page stays the Pi's).
        act(() => {
            listener.status = 'connecting';
            listener.enabled = true;
            for (const cb of listener.statusListeners) cb('connecting');
        });
        await expectAway();
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Retry NMEA connection' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Disconnect NMEA' })).toBeNull();
            expect(screen.queryByText('192.0.2.151:1457')).toBeNull();
        });

        expect(new Set(seen)).toEqual(new Set(['Away · Live']));
        expect(document.body.textContent).not.toMatch(/Aboard/);
        expect(screen.getByTestId('gateway-link-line')).toHaveTextContent(
            'Reading the boat through your Pi, over Tailscale.',
        );
    });

    it('aboard on the boat’s Wi-Fi, the same page says so', async () => {
        net.interfaces = [{ name: 'en0', address: '192.0.2.37', family: 'ipv4', tunnel: false }];
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.0.2.37', seenAt: '192.0.2.180' };
        setPhone(PHONE_ABOARD);
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<NmeaPage onBack={() => undefined} />);
        await waitFor(() => expect(pill()).toHaveTextContent('Aboard · Live'));
        expect(screen.getByTestId('gateway-link-line')).toHaveTextContent(
            'Reading the boat through your Pi, on the boat’s Wi-Fi.',
        );
    });

    it('with location off, no place word and the reason', async () => {
        phone.live = null;
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<NmeaPage onBack={() => undefined} />);
        await waitFor(() => expect(pill().textContent).toBe('Live'));
        expect(screen.getByTestId('gateway-where-note')).toHaveTextContent(
            'Thalassa needs this phone’s location to tell whether you’re aboard.',
        );
    });
});

describe('Remote Access never tells a phone 900 km away to turn its VPN off', () => {
    const banner = /on the Pi.s own network right now/;

    it('away over a subnet route, the Pi answering at its boat-network address: no banner', async () => {
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<RemoteAccessSection />);
        await waitFor(() => expect(screen.getByText('Reachable away from the boat')).toBeInTheDocument());
        // Give the old interface check its 20 s poll's first answer, then look.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(screen.queryByText(banner)).toBeNull();
        const card = screen.getByText('Reachable away from the boat').closest('div')!.parentElement!;
        await waitFor(() => expect(within(card).getByText(/reaching it over Tailscale now/)).toBeInTheDocument());
    });

    it('aboard, a VPN up, and the Pi saw the request come in through the router: the banner, proven', async () => {
        net.interfaces = BOAT_WIFI_WITH_TAILSCALE;
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.0.2.1', seenAt: '192.0.2.180' };
        setPhone(PHONE_ABOARD);
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<RemoteAccessSection />);
        await waitFor(() => expect(screen.getByText(banner)).toBeInTheDocument());
    });

    it('aboard on cellular alone, the VPN the only way to the Pi: no banner telling the skipper to turn it off', async () => {
        net.interfaces = [
            { name: 'pdp_ip0', address: '10.20.30.40', family: 'ipv4', tunnel: false },
            { name: 'utun4', address: '100.101.102.103', family: 'ipv4', tunnel: true },
        ];
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.0.2.1', seenAt: '192.0.2.180' };
        setPhone(PHONE_ABOARD);
        act(() => void NmeaStore.ingestRemote(snapshot('lan')));
        render(<RemoteAccessSection />);
        await waitFor(() => expect(screen.getByText('Reachable away from the boat')).toBeInTheDocument());
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(screen.queryByText(banner)).toBeNull();
    });
});
