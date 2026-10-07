/**
 * Gateway state fixture — the NMEA Gateway page and the System status box,
 * fed fictional boat data with no Pi, gateway, account or network behind them.
 *
 * Nothing here opens a connection. The Pi lane, the cloud lane and the gateway
 * socket are never started: the store is fed by hand (ingestRemote, or a
 * sample handed to the store's own listener), and a socket's status is set on
 * the listener without a socket. The gateway host is a TEST-NET-1 address
 * (192.0.2.0/24, RFC 5737), which no network routes.
 *
 * Places are fictional pairings in the English Channel: the phone at
 * Lymington, the boat at St Peter Port (about 160 km apart), or the phone a
 * dinghy's length from her.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NmeaPage } from '../../components/vessel/NmeaPage';
import { SystemStatusButton } from '../../components/SystemStatusButton';
import { NmeaStore, type RemoteInstrumentSnapshot } from '../../services/NmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { CloudTelemetryService } from '../../services/CloudTelemetryService';
import { BoatLinkService } from '../../services/boatLink/BoatLinkService';
import * as networkContext from '../../services/network/networkContext';
import '../../index.css';

type Scenario =
    | 'ashore-lan'
    | 'ashore-cloud'
    | 'ashore-takeover'
    | 'aboard-lan'
    | 'gateway-vpn'
    | 'aboard-closed'
    | 'aboard-fallback';
const SCENARIOS: Scenario[] = [
    'ashore-lan',
    'ashore-cloud',
    'ashore-takeover',
    'aboard-lan',
    'gateway-vpn',
    'aboard-closed',
    'aboard-fallback',
];

const params = new URLSearchParams(location.search);
const scenario: Scenario = SCENARIOS.includes(params.get('scenario') as Scenario)
    ? (params.get('scenario') as Scenario)
    : 'ashore-lan';
const view = params.get('view') === 'status' ? 'status' : 'gateway';
const mode = params.get('mode') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');

const BOAT = { lat: 49.4567, lon: -2.5361 };
const PHONE_ASHORE = { lat: 50.7584, lon: -1.5418 };
const PHONE_ABOARD = { lat: 49.4569, lon: -2.5365 };
const ashore = !scenario.startsWith('aboard-');
const piPaired = scenario !== 'gateway-vpn' && scenario !== 'aboard-closed';
const now = Date.now();

// ── Saved settings, as a phone that set these up would hold them ──
localStorage.setItem('nmea_host', '192.0.2.151');
localStorage.setItem('nmea_port', '1457');
localStorage.setItem('nmea_device', 'ydwg02');
if (piPaired) {
    localStorage.setItem(
        'thalassa_pi_pairing_v1',
        JSON.stringify({
            deviceId: 'fixture-pi',
            boatName: 'Fixture Boat',
            publicKeySpki: 'fixture-key',
            host: '192.0.2.180',
            pairedAt: now - 86_400_000,
        }),
    );
    // The paired Pi runs Tailscale: the app learned its tailnet address
    // (fictional, 100.64/10) from the Pi's remote-access status.
    localStorage.setItem('thalassa_pi_remote_host', '100.101.102.104');
} else {
    localStorage.removeItem('thalassa_pi_pairing_v1');
    localStorage.removeItem('thalassa_pi_remote_host');
}
const phone = ashore ? PHONE_ASHORE : PHONE_ABOARD;
localStorage.setItem(
    'thalassa_last_phone_fix::anonymous',
    JSON.stringify({ lat: phone.lat, lon: phone.lon, timestamp: now - 5_000 }),
);
// The boat's last fix as this phone kept it, ten minutes ago: a phone that
// has seen her before knows where she was even when nothing answers now.
localStorage.setItem(
    'thalassa_boatlink_boat_fix::anonymous',
    JSON.stringify({ lat: BOAT.lat, lon: BOAT.lon, at: now - 10 * 60_000, accuracyM: 5 }),
);

// No account and no backend: the System status sheet's cloud reader would
// find no row and clear the lane this fixture fills by hand.
CloudTelemetryService.retain = () => undefined;
CloudTelemetryService.release = () => undefined;

// ── This phone's interfaces: home Wi-Fi with a tunnel up ashore; the boat's
//    Wi-Fi and no tunnel aboard. Only a build with the seam takes them. ──
const seed = (networkContext as unknown as { __seedNetworkInterfacesForTests?: (list: unknown[]) => void })
    .__seedNetworkInterfacesForTests;
seed?.(
    ashore
        ? [
              { name: 'en0', address: '10.0.0.23', family: 'ipv4', tunnel: false },
              { name: 'utun4', address: '100.101.102.103', family: 'ipv4', tunnel: true },
          ]
        : [{ name: 'en0', address: '192.0.2.37', family: 'ipv4', tunnel: false }],
);

const snapshot = (via: 'lan' | 'cloud'): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via,
    deviceLabel: 'fixture-pi',
    reportedAt: now - 3_000,
    positionSampleAt: now - 3_000,
    lat: BOAT.lat,
    lon: BOAT.lon,
    sogKts: 0.1,
    cogDeg: 212,
    headingDeg: 208,
    stwKts: 0,
    twsKts: 14.2,
    twaDeg: -48,
    twdDeg: 255,
    awsKts: 15.1,
    awaDeg: -45,
    depthM: 6.4,
    heelDeg: 1,
    pitchDeg: 0,
    waterTempC: 15.8,
    rudderDeg: 0,
    rpm: null,
    voltageV: 12.9,
});

type ListenerInternals = {
    setStatus(status: string): void;
    enabled: boolean;
    reconnectAttempts: number;
    lastError: string | null;
    listeners: Set<(sample: unknown) => void>;
};
const listener = NmeaListenerService as unknown as ListenerInternals;

// The lanes keep answering every two seconds, as a live Pi does.
const keepAnswering = (via: 'lan' | 'cloud') => {
    const answer = () => NmeaStore.ingestRemote({ ...snapshot(via), reportedAt: Date.now() - 2_000 });
    answer();
    setInterval(answer, 2_000);
};

switch (scenario) {
    case 'ashore-lan':
    case 'aboard-lan':
        keepAnswering('lan');
        break;
    case 'ashore-cloud':
        keepAnswering('cloud');
        break;
    case 'ashore-takeover':
        // The Pi has gone quiet and a fallback socket is mid-retry.
        listener.enabled = true;
        listener.reconnectAttempts = 3;
        listener.lastError = 'The gateway did not answer (timed out).';
        listener.setStatus('connecting');
        break;
    case 'gateway-vpn':
    case 'aboard-closed':
    case 'aboard-fallback': {
        // A gateway-only boat read over a VPN from ashore: a connected socket
        // with one aggregate sample. Or aboard one, just after the skipper
        // pressed Disconnect: the socket closed, its last reading ageing. Or
        // aboard a boat whose Pi has gone silent: the policy's fallback
        // socket reading the gateway direct (with a Pi paired and no policy
        // booted here, an open socket is the policy's).
        NmeaStore.start();
        if (scenario === 'aboard-fallback') listener.enabled = true;
        listener.setStatus('connected');
        const sample = {
            timestamp: Date.now(),
            tws: 14.2,
            twa: 48,
            twaSigned: -48,
            stw: 0,
            heading: 208,
            rpm: null,
            rudder: null,
            rudderSwing: null,
            voltage: 12.9,
            depth: 6.4,
            sog: 0.1,
            cog: 212,
            waterTemp: 15.8,
            latitude: BOAT.lat,
            longitude: BOAT.lon,
            hdop: 0.8,
            satellites: 11,
            gpsFixQuality: 1,
        };
        const emit = () => {
            for (const cb of listener.listeners) cb({ ...sample, timestamp: Date.now() });
        };
        emit();
        if (scenario === 'aboard-closed') {
            // The page was open while it was connected; then Disconnect
            // (NmeaPage.handleDisconnect: the listener first, then the store).
            BoatLinkService.evaluate();
            listener.enabled = false;
            listener.setStatus('disconnected');
            NmeaStore.stop();
            break;
        }
        setInterval(emit, 2_000);
        break;
    }
}

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            {view === 'gateway' ? (
                <NmeaPage onBack={() => {}} onNavigateToGlass={() => {}} />
            ) : (
                <div className="flex justify-end p-4">
                    <SystemStatusButton currentView="vessel" onNavigateAnchor={() => {}} alwaysShow />
                </div>
            )}
            {/* The app's tab bar: 4rem plus the home-indicator inset. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t border-white/10 bg-slate-900"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                <div className="h-16" />
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
