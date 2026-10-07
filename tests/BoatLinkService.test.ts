/**
 * BoatLinkService — one snapshot for every screen, and it holds still.
 *
 * Shane 2026-10-07, at home with the boat 900 km away and reading her over a
 * Tailscale subnet route: "sometime take over, other times it says i am
 * onboard, sometimes it says remote, other times it says live." The real
 * instrument store is fed the way the Pi lane and the cloud lane feed it, in
 * the orders they actually answer in; the label must say the same thing
 * throughout. Only the edges are faked: the gateway socket, the Pi lane's
 * path record, the phone's fix and its interfaces. Fictional data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
    status: 'disconnected' as string,
    enabled: false,
    saved: { host: '192.0.2.151', port: 1457 } as { host: string; port: number } | null,
    reconnecting: false,
    statusListeners: new Set<(s: string) => void>(),
    sampleListeners: new Set<(s: unknown) => void>(),
}));
const pairing = vi.hoisted(() => ({ record: { deviceId: 'fixture-pi' } as Record<string, unknown> | null }));
const pi = vi.hoisted(() => ({
    path: {
        answeredVia: 'lan-host' as 'lan-host' | 'tailnet-host' | null,
        seenFrom: null as string | null,
        seenAt: null as string | null,
    },
    state: 'live' as string,
    present: true,
}));
/** The Pi cache: its boat-network host, its tailnet address (it runs Tailscale), and whose diary it relays. */
const cache = vi.hoisted(() => ({
    lanHost: '192.0.2.180' as string | null,
    remote: 'https://100.101.102.104:3001' as string | null,
    relayOwner: null as string | null,
}));
const cloudRow = vi.hoisted(() => ({ ownerId: null as string | null }));
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
        isReconnecting: () => listener.reconnecting,
        getSavedConfig: () => listener.saved,
        getConnectionInfo: () => ({
            status: listener.status,
            enabled: listener.enabled,
            host: listener.saved?.host ?? '192.0.2.151',
            port: listener.saved?.port ?? 1457,
            deviceId: 'ydwg02',
            deviceLabel: 'YDWG-02',
            transport: 'tcp',
        }),
        onSample: (cb: (s: unknown) => void) => {
            listener.sampleListeners.add(cb);
            return () => listener.sampleListeners.delete(cb);
        },
        onStatusChange: (cb: (s: string) => void) => {
            listener.statusListeners.add(cb);
            return () => listener.statusListeners.delete(cb);
        },
    },
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
}));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn(), update: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => pairing.record }));
vi.mock('../services/PiTelemetryService', () => ({
    PiTelemetryService: {
        pathInfo: () => pi.path,
        getState: () => pi.state,
        isPresent: () => pi.present,
        subscribe: () => () => undefined,
    },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getLanHost: () => cache.lanHost,
        getRemoteBaseUrl: () => cache.remote,
        getStatus: () => ({
            reachable: true,
            diaryRelayConfigured: cache.relayOwner !== null,
            diaryRelayOwnerId: cache.relayOwner ?? undefined,
        }),
    },
}));
vi.mock('../services/CloudTelemetryService', () => ({
    CloudTelemetryService: { getLatest: () => (cloudRow.ownerId ? { ownerId: cloudRow.ownerId } : null) },
}));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => phone.live } }));
vi.mock('../services/phoneLastFix', () => ({ storedPhoneFix: () => null }));
vi.mock('../services/network/networkContext', () => ({ getInterfaces: async () => net.interfaces }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { BoatLinkService, ROUTE_HOLD_MS } from '../services/boatLink/BoatLinkService';
import { setSocketOwnerReader } from '../services/boatLink/socketOwner';
import { WHERE_HOLD_MS } from '../services/boatLink/boatLinkModel';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const T0 = Date.parse('2026-10-07T03:00:00Z');
const BOAT = { lat: -20.27, lon: 148.72 };
/** About 891 km from the boat. */
const PHONE_AWAY = { lat: -27.21, lon: 153.1 };
/** About 30 m from the boat. */
const PHONE_ABOARD = { lat: -20.2697, lon: 148.72 };

const HOME_WITH_TAILSCALE = [
    { name: 'en0', address: '10.0.0.23', family: 'ipv4' as const, tunnel: false },
    { name: 'utun4', address: '100.101.102.103', family: 'ipv4' as const, tunnel: true },
];
const BOAT_WIFI = [{ name: 'en0', address: '192.0.2.37', family: 'ipv4' as const, tunnel: false }];
/** The boat's Wi-Fi with a VPN left up (as Shane runs Tailscale aboard, subnet routes off). */
const BOAT_WIFI_WITH_TAILSCALE = [
    ...BOAT_WIFI,
    { name: 'utun4', address: '100.101.102.103', family: 'ipv4' as const, tunnel: true },
];

const snapshot = (via: 'lan' | 'cloud', over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
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
    ...over,
});

const setPhone = (at: { lat: number; lon: number }, accuracy = 8) => {
    phone.live = { latitude: at.lat, longitude: at.lon, accuracy, timestamp: Date.now() - 1_000 };
};
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** `metres` north of a point. */
const northOf = (p: { lat: number; lon: number }, metres: number) => ({ lat: p.lat + metres / 111_320, lon: p.lon });

/** The gateway socket connects, and the bus sends one aggregate sample (no GPS on the bus when `at` is null). */
function socketConnects(at: { lat: number; lon: number } | null = BOAT) {
    listener.status = 'connected';
    listener.enabled = true;
    for (const cb of listener.statusListeners) cb('connected');
    for (const cb of listener.sampleListeners)
        cb({
            timestamp: Date.now(),
            tws: 12,
            twa: 40,
            stw: 0,
            heading: 190,
            rpm: null,
            rudder: null,
            rudderSwing: null,
            voltage: 13,
            depth: 5,
            sog: 0.1,
            cog: 200,
            waterTemp: 24,
            latitude: at?.lat ?? null,
            longitude: at?.lon ?? null,
            hdop: at ? 0.9 : null,
            satellites: at ? 10 : null,
            gpsFixQuality: at ? 1 : null,
        });
}
function socketCloses() {
    listener.status = 'disconnected';
    listener.enabled = false;
    for (const cb of listener.statusListeners) cb('disconnected');
}

/** The boat's fix as this device kept it, `ago` before now (her instruments since off, or her Pi dead). */
function keepBoatFixFrom(ago: number) {
    const now = Date.now();
    vi.setSystemTime(now - ago);
    NmeaStore.ingestRemote(snapshot('cloud'));
    BoatLinkService.evaluate();
    NmeaStore.clearRemote();
    BoatLinkService.resetForTests();
    vi.setSystemTime(now);
}

describe('BoatLinkService', () => {
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        localStorage.clear();
        listener.status = 'disconnected';
        listener.enabled = false;
        listener.reconnecting = false;
        listener.saved = { host: '192.0.2.151', port: 1457 };
        pairing.record = { deviceId: 'fixture-pi' };
        pi.path = { answeredVia: 'lan-host', seenFrom: null, seenAt: null };
        pi.state = 'live';
        pi.present = true;
        cache.lanHost = '192.0.2.180';
        cache.remote = 'https://100.101.102.104:3001';
        cache.relayOwner = null;
        cloudRow.ownerId = null;
        phone.live = null;
        net.interfaces = HOME_WITH_TAILSCALE;
        setSocketOwnerReader(null);
        NmeaStore.clearRemote();
        BoatLinkService.resetForTests();
        await BoatLinkService.refreshNetworkForTests();
    });
    afterEach(() => {
        NmeaStore.clearRemote();
        BoatLinkService.resetForTests();
        vi.useRealTimers();
    });

    it('away over a subnet route, the Pi answering at its boat-network address: never "Aboard"', () => {
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('lan'));
        const s = BoatLinkService.evaluate();
        expect(NmeaStore.isBoatFeed()).toBe(true); // her own receivers, read directly…
        expect(s.where).toBe('ashore'); // …from 891 km away.
        expect(s.pill).toMatchObject({ text: 'Away · Live', tone: 'sky' });
        expect(s.line).toBe('Reading the boat through your Pi, over Tailscale.');
        expect(s.statusRow).toBe('Away · Pi over Tailscale · live');
        expect(s.fallbackPermitted).toBe(false);
        expect(JSON.stringify(s)).not.toMatch(/Aboard/);
    });

    it('the label does not oscillate as the Pi direct and the cloud answer in turn', () => {
        setPhone(PHONE_AWAY);
        const seen: string[] = [];
        const lines: string[] = [];
        const look = () => {
            const s = BoatLinkService.evaluate();
            seen.push(s.pill.text);
            lines.push(s.line ?? '');
        };
        // The probe's sequence: direct, a jittery gap the cloud fills, direct
        // again, the cloud refused while direct is fresh, direct lapsing.
        NmeaStore.ingestRemote(snapshot('lan'));
        look();
        advance(5_000);
        NmeaStore.ingestRemote(snapshot('cloud')); // refused: direct is fresher
        look();
        advance(16_000);
        NmeaStore.clearRemote('lan'); // the direct lane lapses …
        NmeaStore.ingestRemote(snapshot('cloud')); // … and the cloud fills it
        look();
        advance(4_000);
        NmeaStore.ingestRemote(snapshot('lan')); // direct is back inside the route hold
        look();
        advance(3_000);
        NmeaStore.ingestRemote(snapshot('cloud')); // refused again
        look();
        expect(new Set(seen)).toEqual(new Set(['Away · Live']));
        // The sentence under it did not change words for a lane that held less than ten seconds.
        expect(new Set(lines)).toEqual(new Set(['Reading the boat through your Pi, over Tailscale.']));
        expect(ROUTE_HOLD_MS).toBe(10_000);
    });

    it('a moment with neither of the Pi’s lanes between them is bridged; a long silence is said', () => {
        setPhone(PHONE_AWAY);
        const unsubscribe = BoatLinkService.subscribe(() => undefined);
        try {
            NmeaStore.ingestRemote(snapshot('lan'));
            expect(BoatLinkService.evaluate().line).toBe('Reading the boat through your Pi, over Tailscale.');
            // The direct lane lapses; the store tells its watchers before the cloud fills in.
            NmeaStore.clearRemote('lan');
            expect(BoatLinkService.evaluate().line).toBe(
                'Your Pi isn’t answering right now. Its readings show here as soon as it does.',
            );
            NmeaStore.ingestRemote(snapshot('cloud'));
            expect(BoatLinkService.evaluate().line).toBe('Reading the boat through your Pi, over Tailscale.');
            // Silent for longer than the hold: the cloud's own words when it answers.
            NmeaStore.clearRemote();
            BoatLinkService.evaluate();
            advance(ROUTE_HOLD_MS + 1_000);
            setPhone(PHONE_AWAY);
            NmeaStore.ingestRemote(snapshot('cloud'));
            expect(BoatLinkService.evaluate().line).toBe('Reading the boat through your Pi’s internet updates.');
        } finally {
            unsubscribe();
        }
    });

    it('a lane that holds for ten seconds does change the sentence, never the place', () => {
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('lan'));
        BoatLinkService.evaluate();
        advance(21_000);
        NmeaStore.clearRemote('lan');
        NmeaStore.ingestRemote(snapshot('cloud'));
        expect(BoatLinkService.evaluate().line).toBe('Reading the boat through your Pi, over Tailscale.');
        advance(ROUTE_HOLD_MS);
        NmeaStore.ingestRemote(snapshot('cloud'));
        const s = BoatLinkService.evaluate();
        expect(s.line).toBe('Reading the boat through your Pi’s internet updates.');
        expect(s.pill.text).toBe('Away · Live');
    });

    it('one stray phone fix beside her cannot flip Away to Aboard; seen again ten seconds later, it does', () => {
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('ashore');
        advance(2_000);
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('ashore');
        advance(5_000);
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('ashore');
        advance(6_000);
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('aboard');
    });

    it('aboard on the boat’s Wi-Fi with GPS agreeing and the Pi seeing this phone’s own address', async () => {
        net.interfaces = BOAT_WIFI;
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.0.2.37', seenAt: '192.0.2.180' };
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        const s = BoatLinkService.evaluate();
        expect(s.pill).toMatchObject({ text: 'Aboard · Live', tone: 'green' });
        expect(s.line).toBe('Reading the boat through your Pi, on the boat’s Wi-Fi.');
        expect(s.hairpin).toBe(false);
        expect(s.fallbackPermitted).toBe(true);
    });

    it('GPS unavailable: an honest unknown — no place word, the reason, and no fallback over a VPN', () => {
        NmeaStore.ingestRemote(snapshot('lan'));
        const s = BoatLinkService.evaluate();
        expect(s.where).toBe('unknown');
        expect(s.pill.text).toBe('Live');
        expect(s.whereNote).toBe('Thalassa needs this phone’s location to tell whether you’re aboard.');
        expect(s.fallbackPermitted).toBe(false);
    });

    it('GPS unavailable aboard: the Pi seeing this phone’s own Wi-Fi address, on its own /24, is enough', async () => {
        net.interfaces = BOAT_WIFI;
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.0.2.37', seenAt: '192.0.2.180' };
        NmeaStore.ingestRemote(snapshot('lan'));
        const s = BoatLinkService.evaluate();
        expect(s.where).toBe('aboard');
        expect(s.whereReason).toBe('same-network');
        expect(s.pill.text).toBe('Aboard · Live');
    });

    it('a gateway-only boat read over a VPN from away', () => {
        pairing.record = null;
        setPhone(PHONE_AWAY);
        NmeaStore.start();
        try {
            listener.status = 'connected';
            listener.enabled = true;
            for (const cb of listener.statusListeners) cb('connected');
            for (const cb of listener.sampleListeners)
                cb({
                    timestamp: Date.now(),
                    tws: 12,
                    twa: 40,
                    stw: 0,
                    heading: 190,
                    rpm: null,
                    rudder: null,
                    rudderSwing: null,
                    voltage: 13,
                    depth: 5,
                    sog: 0.1,
                    cog: 200,
                    waterTemp: 24,
                    latitude: BOAT.lat,
                    longitude: BOAT.lon,
                    hdop: 0.9,
                    satellites: 10,
                    gpsFixQuality: 1,
                });
            const s = BoatLinkService.evaluate();
            expect(s.lane).toBe('socket');
            expect(s.socketOwner).toBe('boot');
            expect(s.pill.text).toBe('Away · Live');
            // No Pi running Tailscale and no MagicDNS name: a 100.64/10 tunnel
            // could be NetBird or WARP as well, so it is "your VPN".
            expect(s.line).toBe('Connected to the YDWG-02 over your VPN.');
        } finally {
            listener.status = 'disconnected';
            for (const cb of listener.statusListeners) cb('disconnected');
            NmeaStore.stop();
        }
    });

    it('a gateway-only boat away with no VPN: a grey Not connected, never a red failure', () => {
        pairing.record = null;
        net.interfaces = [{ name: 'en0', address: '192.168.1.44', family: 'ipv4', tunnel: false }];
        setPhone(PHONE_AWAY);
        // The boat's fix as this device last kept it.
        NmeaStore.ingestRemote(snapshot('cloud'));
        BoatLinkService.evaluate();
        NmeaStore.clearRemote();
        advance(10 * 60_000);
        setPhone(PHONE_AWAY);
        listener.status = 'error';
        listener.enabled = true;
        const s = BoatLinkService.evaluate();
        expect(s.where).toBe('ashore');
        expect(s.pill).toMatchObject({ text: 'Away · Not connected', tone: 'grey' });
        expect(s.line).toBe('The YDWG-02 answers on the boat’s Wi-Fi, or over a VPN to the boat’s network.');
    });

    it('Pi only, through the cloud, from away (Starlink or 4G with no way in)', () => {
        net.interfaces = [{ name: 'pdp_ip0', address: '198.51.100.9', family: 'ipv4', tunnel: false }];
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('cloud'));
        const s = BoatLinkService.evaluate();
        expect(s.pill).toMatchObject({ text: 'Away · Live', tone: 'sky' });
        expect(s.line).toBe('Reading the boat through your Pi’s internet updates.');
        expect(s.statusRow).toBe('Away · Pi through the cloud · live');
    });

    it('a cloud row a phone published is not the boat’s position', () => {
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('cloud', { source: 'device', lat: PHONE_AWAY.lat, lon: PHONE_AWAY.lon }));
        const s = BoatLinkService.evaluate();
        expect(s.where).not.toBe('aboard');
    });

    it('the policy’s fallback socket mid-attempt is never the skipper’s red failure', () => {
        setSocketOwnerReader(() => 'policy');
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        BoatLinkService.evaluate();
        NmeaStore.clearRemote();
        advance(6 * 60_000);
        setPhone(PHONE_ABOARD);
        listener.status = 'error';
        listener.enabled = true;
        const s = BoatLinkService.evaluate();
        expect(s.socketOwner).toBe('policy');
        expect(s.pill.tone).not.toBe('red');
        expect(s.line).toBe(
            'Your Pi hasn’t answered for a minute, so this phone is trying the YDWG-02 directly until it’s back.',
        );
    });

    it('a decision from last night does not hold back this morning’s: foregrounded at home 14 h later, Away at once', () => {
        // Aboard in the evening, the app suspended there.
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('aboard');
        NmeaStore.clearRemote();
        advance(14 * 3_600_000);
        // Foregrounded at home before any lane has answered. The phone's last
        // fix is fourteen hours old: no place yet, and no fallback over the VPN.
        let s = BoatLinkService.evaluate();
        expect(s.where).toBe('unknown');
        expect(s.fallbackPermitted).toBe(false);
        // The phone's first fresh fix, against the boat's kept one.
        setPhone(PHONE_AWAY);
        s = BoatLinkService.evaluate();
        expect(s.where).toBe('ashore');
        expect(s.whereReason).toBe('apart');
        expect(s.fallbackPermitted).toBe(false);
        expect(JSON.stringify(s)).not.toMatch(/Aboard/);
        // …and it stays Away while the confirmation window would have run.
        advance(9_000);
        setPhone(PHONE_AWAY);
        expect(BoatLinkService.evaluate().where).toBe('ashore');
        expect(WHERE_HOLD_MS).toBe(600_000);
    });

    it('a change of side against a decision that still holds is still confirmed twice', () => {
        setPhone(PHONE_ABOARD);
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('aboard');
        advance(60_000);
        setPhone(northOf(BOAT, 2_000));
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('aboard');
        advance(10_000);
        setPhone(northOf(BOAT, 2_000));
        NmeaStore.ingestRemote(snapshot('lan'));
        expect(BoatLinkService.evaluate().where).toBe('ashore');
    });

    it('after Disconnect a gateway-only boat never says "Connected to" a closed socket', async () => {
        pairing.record = null;
        net.interfaces = BOAT_WIFI;
        await BoatLinkService.refreshNetworkForTests();
        setPhone(PHONE_ABOARD);
        NmeaStore.start();
        try {
            socketConnects();
            expect(BoatLinkService.evaluate().line).toBe('Connected to the YDWG-02 on the boat’s Wi-Fi.');
            // NmeaPage.handleDisconnect: the listener first, then the store.
            socketCloses();
            NmeaStore.stop();
            advance(15_000);
            setPhone(PHONE_ABOARD);
            let s = BoatLinkService.evaluate();
            expect(s.pill.text).toBe('Aboard · 15 s old');
            expect(s.line).toBe(
                'Last reading came through the YDWG-02 on the boat’s Wi-Fi, 15 s ago. It isn’t connected now.',
            );
            expect(s.statusRow).toBe('Aboard · YDWG-02 not connected · 15 s old');
            advance(4 * 60_000);
            setPhone(PHONE_ABOARD);
            s = BoatLinkService.evaluate();
            expect(s.line).toBe(
                'Last reading came through the YDWG-02 on the boat’s Wi-Fi, 4 min ago. It isn’t connected now.',
            );
            expect(JSON.stringify(s)).not.toMatch(/Connected to/);
        } finally {
            socketCloses();
            NmeaStore.stop();
        }
    });

    it('the fallback socket closed because the phone went ashore: the Pi line, never the gateway "connected"', () => {
        let owner: 'policy' | 'none' = 'policy';
        setSocketOwnerReader(() => owner);
        setPhone(PHONE_ABOARD);
        NmeaStore.start();
        try {
            socketConnects();
            expect(BoatLinkService.evaluate().line).toBe(
                'Your Pi hasn’t answered for a minute, so this phone is reading the YDWG-02 directly until it’s back.',
            );
            // The policy gives the gateway its slot back.
            owner = 'none';
            socketCloses();
            advance(20_000);
            setPhone(northOf(BOAT, 30_000));
            const s = BoatLinkService.evaluate();
            expect(s.line).toBe('Your Pi isn’t answering right now. Its readings show here as soon as it does.');
            expect(JSON.stringify(s)).not.toMatch(/Connected to|reading the YDWG-02/);
        } finally {
            socketCloses();
            NmeaStore.stop();
        }
    });

    it('a routed VPN from home, the Pi seeing my home address: never "Aboard", and no fallback', async () => {
        // Site-to-site WireGuard from the boat's router, no address
        // translation, and no tunnel on this phone at all.
        keepBoatFixFrom(3 * 86_400_000);
        net.interfaces = [{ name: 'en0', address: '192.168.1.44', family: 'ipv4', tunnel: false }];
        await BoatLinkService.refreshNetworkForTests();
        pi.path = { answeredVia: 'lan-host', seenFrom: '192.168.1.44', seenAt: '192.0.2.180' };
        pi.state = 'quiet'; // her instruments are off while she is left
        setPhone(PHONE_AWAY);
        const s = BoatLinkService.evaluate();
        expect(s.where).not.toBe('aboard');
        expect(s.whereReason).not.toBe('same-network');
        expect(s.fallbackPermitted).toBe(false);
        expect(JSON.stringify(s)).not.toMatch(/Aboard|boat’s Wi-Fi/);
    });

    it('the Pi dead for three days, the skipper back aboard with a VPN up: the fallback may open', async () => {
        keepBoatFixFrom(3 * 86_400_000);
        net.interfaces = BOAT_WIFI_WITH_TAILSCALE;
        await BoatLinkService.refreshNetworkForTests();
        pi.state = 'unreachable';
        pi.present = false;
        setPhone(northOf(BOAT, 13));
        const s = BoatLinkService.evaluate();
        expect(s.where).toBe('unknown');
        expect(s.fallbackPermitted).toBe(true);
        // The same, 900 km away on a home network with the same numbers: no.
        net.interfaces = [
            { name: 'en0', address: '192.0.2.99', family: 'ipv4', tunnel: false },
            { name: 'utun4', address: '100.101.102.103', family: 'ipv4', tunnel: true },
        ];
        await BoatLinkService.refreshNetworkForTests();
        setPhone(PHONE_AWAY);
        expect(BoatLinkService.evaluate().fallbackPermitted).toBe(false);
    });

    it('a bus with wind but no GPS: on the boat’s Wi-Fi the phone stands in for her position; over a VPN it does not', async () => {
        pairing.record = null;
        net.interfaces = BOAT_WIFI;
        await BoatLinkService.refreshNetworkForTests();
        setPhone(PHONE_ABOARD);
        NmeaStore.start();
        try {
            socketConnects(null);
            let s = BoatLinkService.evaluate();
            expect(s.lane).toBe('socket');
            expect(s.whereReason).toBe('no-boat-fix');
            expect(s.phoneStandsInForBoat).toBe(true);
            net.interfaces = BOAT_WIFI_WITH_TAILSCALE;
            await BoatLinkService.refreshNetworkForTests();
            s = BoatLinkService.evaluate();
            expect(s.phoneStandsInForBoat).toBe(false);
        } finally {
            socketCloses();
            NmeaStore.stop();
        }
    });

    it('a crewed boat’s cloud row on screen is not where the paired Pi’s boat is', async () => {
        setAuthIdentityScope('fixture-skipper-a');
        try {
            net.interfaces = BOAT_WIFI;
            await BoatLinkService.refreshNetworkForTests();
            cache.relayOwner = 'fixture-skipper-a'; // the paired Pi is this account's own boat
            cloudRow.ownerId = 'fixture-skipper-b'; // the store shows the boat this account crews on
            pi.state = 'unreachable';
            pi.present = false;
            setPhone(PHONE_ABOARD);
            // Boat B, 60 km off, reporting through her own Pi's cloud row.
            const boatB = northOf(BOAT, 60_000);
            NmeaStore.ingestRemote(snapshot('cloud', { lat: boatB.lat, lon: boatB.lon }));
            BoatLinkService.evaluate();
            await vi.dynamicImportSettled();
            const s = BoatLinkService.evaluate();
            expect(s.where).not.toBe('ashore');
            expect(s.whereReason).toBe('no-boat-fix');
            expect(s.fallbackPermitted).toBe(true);
            // Nor is B's fix kept as the own boat's.
            NmeaStore.clearRemote();
            BoatLinkService.resetForTests();
            await BoatLinkService.refreshNetworkForTests();
            expect(BoatLinkService.evaluate().whereReason).toBe('no-boat-fix');
        } finally {
            setAuthIdentityScope(null);
        }
    });

    it('a fix kept beside one Pi is dropped once another Pi is paired', () => {
        keepBoatFixFrom(60 * 60_000);
        setPhone(PHONE_AWAY);
        expect(BoatLinkService.evaluate().whereReason).toBe('apart');
        BoatLinkService.resetForTests();
        pairing.record = { deviceId: 'fixture-pi-2' };
        setPhone(PHONE_AWAY);
        expect(BoatLinkService.evaluate().whereReason).toBe('no-boat-fix');
    });

    it('the skipper’s phone sharing the boat: a live lane on every screen, never her position', () => {
        pairing.record = null;
        listener.saved = null;
        setPhone(PHONE_AWAY);
        NmeaStore.ingestRemote(snapshot('cloud', { source: 'device' }));
        const s = BoatLinkService.evaluate();
        expect(s.lane).toBe('shared');
        expect(s.data.state).toBe('live');
        expect(s.line).toBe('Reading the boat through the skipper’s phone.');
        expect(s.hub).toMatchObject({ value: 'Live', status: 'Through the skipper’s phone' });
        expect(s.statusRow).toBe('Skipper’s phone through the cloud · live');
        expect(s.where).toBe('unknown');
    });

    it('subscribers hear a change once, and not for an identical re-evaluation', () => {
        setPhone(PHONE_AWAY);
        const heard = vi.fn();
        const unsubscribe = BoatLinkService.subscribe(heard);
        try {
            heard.mockClear();
            NmeaStore.ingestRemote(snapshot('lan'));
            const first = heard.mock.calls.length;
            expect(first).toBeGreaterThan(0);
            BoatLinkService.evaluate();
            BoatLinkService.evaluate();
            expect(heard.mock.calls.length).toBe(first);
            expect(BoatLinkService.getSnapshot()).toBe(BoatLinkService.getSnapshot());
        } finally {
            unsubscribe();
        }
    });
});
