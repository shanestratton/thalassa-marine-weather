/**
 * NmeaPage — Standalone NMEA Gateway connection page for the Vessel Hub.
 *
 * Shows connection status, configuration controls, and AIS Hub settings.
 * The "Instrument Panel" CTA navigates to the full multimeter dashboard.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('NmeaPage');
import { NmeaStatusDot } from '../nmea/useNmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { triggerHaptic } from '../../utils/system';
import { AisStore } from '../../services/AisStore';
import {
    getShareStats,
    isLowDataLink,
    isShareConfigured,
    isShareEnabled,
    setLowDataLink,
    setShareEnabled,
    subscribeShareStats,
} from '../../services/AisShareService';
import { Toggle } from '../settings/SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import {
    discoverGateways,
    subnetPrefixOf,
    isPrivateIpv4,
    type GatewayCandidate,
    type ScanPhase,
} from '../../services/nmea/gatewayScan';
import { nativeTcpProbe, detectSubnetPrefix } from '../../services/nmea/nativeTcpProbe';
import { VpnHairpinNotice } from '../network/VpnHairpinNotice';
import { NMEA_DEVICE_PROFILES } from '../../services/NmeaDeviceProfiles';
import { GpsReceiverStatusService, type GpsReceiverStatus } from '../../services/GpsReceiverStatusService';

import { PageHeader } from '../ui/PageHeader';
import { FormField } from '../ui/FormField';

interface NmeaPageProps {
    onBack: () => void;
    onNavigateToGlass?: () => void;
}

/** What the scan is doing right now, in the skipper's terms. */
function scanPhaseLabel(phase: ScanPhase): string {
    if (phase === 'default-ports') return 'Checking the usual gateway ports…';
    if (phase === 'finding-devices') return 'Nothing on the usual ports — finding devices…';
    return 'Checking those devices on other ports…';
}

export const NmeaPage: React.FC<NmeaPageProps> = ({ onBack, onNavigateToGlass }) => {
    // One-time migrations: clear old defaults so new YDWG-02 defaults take effect
    if (localStorage.getItem('nmea_host') === '192.168.1.1') localStorage.removeItem('nmea_host');
    if (localStorage.getItem('nmea_port') === '10110') localStorage.removeItem('nmea_port');
    const [host, setHost] = useState(localStorage.getItem('nmea_host') || '192.168.1.151');
    const [port, setPort] = useState(localStorage.getItem('nmea_port') || '1456');
    const [device, setDevice] = useState(localStorage.getItem('nmea_device') || 'ydwg02');

    // Direct subscription to NmeaListenerService for connection status —
    // avoids the race condition where NmeaStore.start() misses the initial
    // 'connecting' status because NmeaListenerService.start() fires first.
    const [connStatus, setConnStatus] = useState(NmeaListenerService.getStatus());
    const [reconnectAttempts, setReconnectAttempts] = useState(0);
    const [lastError, setLastError] = useState<string | null>(null);
    const [aisCount, setAisCount] = useState(0);

    useEffect(() => {
        const unsub = NmeaListenerService.onStatusChange((s) => {
            setConnStatus(s);
            setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
            setLastError(NmeaListenerService.getLastError());
        });
        // Sync on mount
        setConnStatus(NmeaListenerService.getStatus());
        setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
        setLastError(NmeaListenerService.getLastError());

        // Poll reconnect state every second (attempt count isn't event-driven
        // — it updates between status changes during the reconnect backoff)
        const poll = setInterval(() => {
            setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
            setLastError(NmeaListenerService.getLastError());
            setConnStatus(NmeaListenerService.getStatus());
        }, 1000);

        // Subscribe to AIS target count updates
        const unsubAis = AisStore.subscribe((targets) => {
            setAisCount(targets.size);
        });

        return () => {
            unsub();
            clearInterval(poll);
            unsubAis();
        };
    }, []);

    const handleDeviceChange = useCallback((deviceId: string) => {
        setDevice(deviceId);
        localStorage.setItem('nmea_device', deviceId);
        const preset = NMEA_DEVICE_PROFILES.find((d) => d.id === deviceId);
        if (preset) {
            setPort(preset.port);
            localStorage.setItem('nmea_port', preset.port);
        }
    }, []);

    const isConnected = connStatus === 'connected';
    // 'error' used to be folded in here, so a FAILED connection rendered as
    // "Connecting..." forever — the screen never once said the word error
    // (Shane 2026-08-13: "it will not connect at all", with nothing on screen
    // saying so). Keep them apart: a failure has to look like a failure.
    const isConnecting = connStatus === 'connecting';
    const hasFailed = connStatus === 'error';

    // ── Position source ────────────────────────────────────────────────
    // Shane, 2026-08-02, with a Bad Elf GPS Pro+ paired: "there is no mention
    // of it anywhere in the app." He was right, and not because the detection
    // was missing — the whole chain exists — but because its ONLY consumer was
    // the system-status FAB, which returns null when nothing else is active
    // (SystemStatusButton.tsx:733). Bad Elf paired, no track running, no anchor
    // watch: activeCount 0, no FAB, and not one pixel in Thalassa naming a GPS
    // receiver. This page is where a skipper looks to ask "where is my data
    // coming from", so the answer lives here permanently.
    const [receiver, setReceiver] = useState<GpsReceiverStatus>(() => GpsReceiverStatusService.getStatus());
    useEffect(() => {
        let disposed = false;
        const refresh = () => {
            void GpsReceiverStatusService.refresh().then((r) => {
                if (!disposed) setReceiver(r);
            });
        };
        refresh();
        // refresh() reads a cache and enumerates accessories; it never starts
        // location services, so polling here costs no battery.
        const id = setInterval(refresh, 5000);
        return () => {
            disposed = true;
            clearInterval(id);
        };
    }, []);

    // ── Gateway scan ────────────────────────────────────────────────────
    const [subnet, setSubnet] = useState(() => localStorage.getItem('nmea_scan_subnet') || '');
    const [scanning, setScanning] = useState(false);
    /** WHY the sweep ended — an empty network field is not "nothing found". */
    const [scanOutcome, setScanOutcome] = useState<null | 'complete' | 'stopped' | 'invalid-network'>(null);
    const [scanPhase, setScanPhase] = useState<ScanPhase>('default-ports');
    const [scanProgress, setScanProgress] = useState(0);
    const [scanHits, setScanHits] = useState<GatewayCandidate[]>([]);
    const stopScanRef = useRef(false);

    // Work out the network ourselves — WebRTC if iOS allows it, else by
    // finding the router. The skipper should never have to go and read an IP
    // off another screen just to start a scan.
    const [detectingSubnet, setDetectingSubnet] = useState(false);
    useEffect(() => {
        if (subnet) return;
        let cancelled = false;
        setDetectingSubnet(true);
        void detectSubnetPrefix({ shouldStop: () => cancelled })
            .then((found) => {
                if (!cancelled && found) setSubnet(found.prefix);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setDetectingSubnet(false);
            });
        return () => {
            cancelled = true;
        };
    }, [subnet]);

    const stopScan = useCallback(() => {
        stopScanRef.current = true;
        setScanning(false);
    }, []);

    // The app unmounts pages on every tab switch, so without this a sweep the
    // skipper walked away from keeps running invisibly — holding the plugin's
    // serial native bridge and racing whatever the next page wants to do with
    // it. There is no way to reach the Stop button once the page is gone.
    useEffect(() => {
        return () => {
            stopScanRef.current = true;
        };
    }, []);

    const startScan = useCallback(() => {
        const prefix = subnet.trim().endsWith('.') ? subnet.trim() : `${subnet.trim()}.`;
        // Use the validators that already exist and are already tested, rather
        // than a looser regex that accepts 999.1.1. and would then sweep 254
        // addresses that cannot exist. isPrivateIpv4 also keeps a mistyped
        // public range from being scanned.
        const canonical = subnetPrefixOf(`${prefix}1`);
        if (!canonical || !isPrivateIpv4(`${canonical}1`)) {
            setScanOutcome('invalid-network');
            setScanHits([]);
            return;
        }
        localStorage.setItem('nmea_scan_subnet', prefix);
        triggerHaptic('medium');
        stopScanRef.current = false;
        setScanning(true);
        setScanOutcome(null);
        setScanHits([]);
        setScanProgress(0);
        setScanPhase('default-ports');

        void discoverGateways({
            subnetPrefix: prefix,
            probe: nativeTcpProbe,
            onPhase: setScanPhase,
            onProgress: (done, total) => setScanProgress(total > 0 ? done / total : 0),
            // Show each hit the moment it lands — on a 254-host sweep the
            // skipper should not wait for the whole thing to finish.
            onCandidate: (c) =>
                setScanHits((prev) => (prev.some((p) => p.host === c.host && p.port === c.port) ? prev : [...prev, c])),
            shouldStop: () => stopScanRef.current,
        })
            .then((all) => setScanHits(all))
            .catch((e) => log.warn('gateway scan failed:', e))
            .finally(() => {
                setScanning(false);
                setScanOutcome(stopScanRef.current ? 'stopped' : 'complete');
            });
    }, [subnet]);

    const applyScanHit = useCallback((hit: GatewayCandidate) => {
        triggerHaptic('light');
        setHost(hit.host);
        setPort(String(hit.port));
        localStorage.setItem('nmea_host', hit.host);
        localStorage.setItem('nmea_port', String(hit.port));
        if (hit.profileId) {
            setDevice(hit.profileId);
            localStorage.setItem('nmea_device', hit.profileId);
        }
        setScanHits([]);
        setScanOutcome(null);
    }, []);

    const handleConnect = useCallback(() => {
        triggerHaptic('medium');
        try {
            // Always stop first so re-tapping Connect restarts cleanly
            NmeaListenerService.stop();
            NmeaStore.stop();
            // Save config
            localStorage.setItem('nmea_host', host);
            localStorage.setItem('nmea_port', port);
            // Configure fresh
            NmeaListenerService.configure(host, parseInt(port, 10));
            // Start store FIRST so it catches the initial 'connecting' status
            NmeaStore.start();
            NmeaListenerService.start();
        } catch (e) {
            log.error('NMEA connect failed:', e);
        }
    }, [host, port]);

    const handleDisconnect = useCallback(() => {
        triggerHaptic('medium');
        // IMPORTANT: Stop listener FIRST so the 'disconnected' status fires
        // while the store is still subscribed and can relay it to the UI.
        NmeaListenerService.stop();
        NmeaStore.stop();
    }, []);

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="NMEA Gateway"
                    subtitle="Instruments & AIS"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'NMEA Gateway']}
                    action={<NmeaStatusDot />}
                />

                {/* Content — fills viewport */}
                <div
                    className="flex-1 px-4 min-h-0 overflow-y-auto"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    {/* ═══ POSITION SOURCE ═══
                        Always rendered — including when the answer is just
                        "iPhone GPS". A skipper with a receiver plugged in
                        needs to see whether the app is using it, and silence
                        is the one answer that helps nobody. */}
                    <div className="shrink-0 mb-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                        <div className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-400">
                            Position source
                        </div>
                        <div className="flex items-center gap-3">
                            <span
                                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                    receiver.kind === 'ios-accessory'
                                        ? 'bg-emerald-400'
                                        : receiver.kind === 'vessel-nmea'
                                          ? 'bg-sky-400'
                                          : receiver.kind === 'precision-location'
                                            ? 'bg-violet-400'
                                            : 'bg-slate-500'
                                }`}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[14px] font-bold text-white">
                                    {receiver.deviceName ?? receiver.label}
                                </div>
                                <div className="text-[11px] leading-snug text-gray-400">{receiver.detail}</div>
                            </div>
                        </div>
                        {receiver.kind === 'phone' && (
                            <p className="mt-2 text-[10px] leading-snug text-gray-500">
                                An MFi receiver (Bad Elf and similar) feeds iOS system-wide — it appears here once it
                                supplies a fix, with no setup needed.
                            </p>
                        )}
                    </div>

                    {/* ═══ CONNECTION CARD ═══ */}
                    <div
                        className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${
                            isConnected
                                ? 'bg-emerald-500/10 border-emerald-500/20'
                                : 'bg-white/[0.03] border-white/[0.06]'
                        }`}
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div
                                className={`w-3 h-3 rounded-full ${
                                    isConnected
                                        ? 'bg-emerald-400'
                                        : isConnecting
                                          ? 'bg-amber-400 animate-pulse'
                                          : 'bg-gray-500'
                                }`}
                            />
                            <h3 className="text-sm font-black text-white">
                                {isConnected
                                    ? 'Connected'
                                    : isConnecting
                                      ? 'Connecting...'
                                      : hasFailed
                                        ? 'Connection failed'
                                        : 'Disconnected'}
                            </h3>
                            {/* Show host:port when connected or connecting */}
                            {(isConnected || isConnecting || hasFailed) && (
                                <span className="text-xs text-white/40 font-mono ml-auto">
                                    {host}:{port}
                                </span>
                            )}
                            {/* AIS target count badge */}
                            {isConnected && aisCount > 0 && (
                                <span className="ml-2 px-2 py-0.5 rounded-lg bg-sky-500/15 border border-sky-500/20 text-[11px] font-black text-sky-400 uppercase tracking-wider">
                                    ⛴ {aisCount} AIS
                                </span>
                            )}
                        </div>

                        {/* A VPN hairpinning boat-LAN traffic makes a healthy
                            gateway look broken — laggy, dropping, "won't
                            connect". Name it here rather than let it be
                            rediagnosed as hardware (2026-08-08). */}
                        <VpnHairpinNotice hostIp={host} hostLabel="the NMEA gateway" className="mb-3" />

                        {/* Why it failed — shown on the FIRST failure, not
                            withheld until a retry, and never truncated.
                            Previously gated on reconnectAttempts > 0 and
                            wrapped in `truncate`, which clipped the tail of
                            "(SwiftSocket.SocketError error 3.)" — where the
                            only informative token, the final digit, lives.
                            Also survives the 5-minute park now, so the reason
                            is still on screen when it is finally read. */}
                        {(lastError || reconnectAttempts > 0) && !isConnected && (
                            <div className="mb-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/15">
                                {reconnectAttempts > 0 && (
                                    <p className="text-xs text-amber-300 font-medium">
                                        Reconnecting... attempt {reconnectAttempts}
                                    </p>
                                )}
                                {lastError && (
                                    <p className="mt-0.5 break-words text-[11px] leading-snug text-amber-200/70">
                                        {lastError}
                                    </p>
                                )}
                            </div>
                        )}

                        {!isConnected && !isConnecting && (
                            <div className="space-y-3 mb-3">
                                {/* Device preset selector */}
                                <div>
                                    <label className="block text-[11px] font-bold uppercase tracking-widest text-white/40 mb-1.5">
                                        Gateway Device
                                    </label>
                                    <select
                                        value={device}
                                        onChange={(e) => handleDeviceChange(e.target.value)}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white font-medium outline-none appearance-none cursor-pointer transition-colors focus:border-sky-500/40"
                                        style={{
                                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                                            backgroundRepeat: 'no-repeat',
                                            backgroundPosition: 'right 12px center',
                                        }}
                                    >
                                        {NMEA_DEVICE_PROFILES.map((d) => (
                                            <option key={d.id} value={d.id} className="bg-slate-900 text-white">
                                                {d.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                {/* Host + Port */}
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <FormField
                                            label="Host IP"
                                            value={host}
                                            onChange={setHost}
                                            placeholder="192.168.1.151"
                                            mono
                                        />
                                    </div>
                                    <div className="w-24">
                                        <FormField
                                            label="Port"
                                            value={port}
                                            onChange={setPort}
                                            placeholder={
                                                NMEA_DEVICE_PROFILES.find((d) => d.id === device)?.port || '1456'
                                            }
                                            mono
                                            inputMode="numeric"
                                        />
                                    </div>
                                </div>

                                {/* ═══ FIND IT FOR ME ═══
                                    Shane sailed to Tangalooma without instruments
                                    because the gateway's IP had been forgotten. The
                                    address is discoverable — so discover it. */}
                                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-black uppercase tracking-widest text-gray-300">
                                                Don’t know the IP?
                                            </div>
                                            <div className="mt-0.5 text-[11px] leading-snug text-gray-500">
                                                {scanning
                                                    ? scanPhaseLabel(scanPhase)
                                                    : detectingSubnet
                                                      ? 'Finding your network…'
                                                      : 'Scans your boat’s network for the gateway.'}
                                            </div>
                                        </div>
                                        <button
                                            onClick={scanning ? stopScan : startScan}
                                            className={`shrink-0 rounded-lg px-3 py-2 text-[11px] font-black uppercase tracking-widest active:scale-95 ${
                                                scanning ? 'bg-white/10 text-gray-300' : 'bg-teal-500/20 text-teal-300'
                                            }`}
                                        >
                                            {scanning ? 'Stop' : '🔍 Scan'}
                                        </button>
                                    </div>

                                    <div className="mt-2">
                                        <FormField
                                            label="Network"
                                            value={subnet}
                                            onChange={setSubnet}
                                            placeholder="192.168.1."
                                            mono
                                        />
                                        <p className="px-0.5 pt-1 text-[10px] leading-snug text-gray-500">
                                            The first three parts of your phone’s Wi-Fi address (iOS: Settings → Wi-Fi →
                                            ⓘ). Detected automatically when possible.
                                        </p>
                                    </div>

                                    {scanning && (
                                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                                            <div
                                                className="h-full rounded-full bg-teal-400 transition-[width] duration-200"
                                                style={{ width: `${Math.round(scanProgress * 100)}%` }}
                                            />
                                        </div>
                                    )}

                                    {scanHits.length > 0 && (
                                        <div className="mt-2 space-y-1.5">
                                            {scanHits.map((hit) => (
                                                <button
                                                    key={`${hit.host}:${hit.port}`}
                                                    onClick={() => applyScanHit(hit)}
                                                    className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-left active:scale-[0.98]"
                                                >
                                                    <span
                                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                                            hit.confidence === 'confirmed'
                                                                ? 'bg-emerald-400'
                                                                : 'bg-amber-400'
                                                        }`}
                                                    />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block font-mono text-[12px] font-bold text-white">
                                                            {hit.host}:{hit.port}
                                                        </span>
                                                        <span className="block text-[10px] text-gray-400">
                                                            {hit.confidence === 'confirmed'
                                                                ? `${hit.label} — live data`
                                                                : `${hit.label} — open, but silent`}
                                                        </span>
                                                    </span>
                                                    <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-teal-300">
                                                        Use
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {scanOutcome === 'invalid-network' && (
                                        <p className="mt-2 text-[11px] leading-snug text-amber-300/80">
                                            That doesn’t look like a local network address. It should be three numbers,
                                            like <span className="font-mono">192.168.1.</span>
                                        </p>
                                    )}
                                    {scanOutcome === 'stopped' && scanHits.length === 0 && (
                                        <p className="mt-2 text-[11px] leading-snug text-gray-400">
                                            Stopped — nothing found before you stopped it.
                                        </p>
                                    )}
                                    {scanOutcome === 'complete' && scanHits.length === 0 && (
                                        <p className="mt-2 text-[11px] leading-snug text-amber-300/80">
                                            Nothing found on {subnet}x. Check you’re on the boat’s Wi-Fi, confirm the
                                            network above, and make sure the gateway is powered.
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="flex gap-2">
                            {!isConnected && !isConnecting && (
                                <button
                                    onClick={handleConnect}
                                    aria-label="Connect NMEA"
                                    className="flex-1 py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-gradient-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500"
                                >
                                    Connect
                                </button>
                            )}
                            {isConnecting && (
                                <button
                                    onClick={handleConnect}
                                    aria-label="Retry NMEA connection"
                                    className="flex-1 py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-gradient-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500"
                                >
                                    <div className="flex items-center justify-center gap-2">
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        Retry
                                    </div>
                                </button>
                            )}
                            {isConnected && (
                                <button
                                    onClick={handleDisconnect}
                                    aria-label="Disconnect NMEA"
                                    className="flex-1 py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30"
                                >
                                    Disconnect
                                </button>
                            )}
                            {isConnecting && (
                                <button
                                    onClick={handleDisconnect}
                                    aria-label="Cancel connection"
                                    className="px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-white/[0.06] border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-all active:scale-[0.95]"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>
                    </div>

                    {/* ═══ FLEET SHARING (opt-in crowd-feed) ═══
                        Replaces the old "AISHub contribution unavailable"
                        banner: the uplink exists now, via the cloud relay
                        (authorized by AISHub in writing, 2026-03-18 — one
                        port for all feeds). Consent is PER-DEVICE and off by
                        default; the copy states the exposure plainly: the
                        boat's OWN transponder reports are part of what is
                        shared, and AISHub is public. */}
                    <FleetSharingCard connected={isConnected} />

                    {/* ═══ INSTRUMENT PANEL CTA ═══ */}
                    {onNavigateToGlass && (
                        <div style={{ paddingBottom: '8px' }}>
                            <button
                                onClick={() => {
                                    triggerHaptic('medium');
                                    onNavigateToGlass();
                                }}
                                aria-label="Open Instrument Panel"
                                className="w-full py-3.5 rounded-2xl text-sm font-black uppercase tracking-[0.2em] transition-all active:scale-[0.97] bg-gradient-to-r from-sky-600 via-cyan-500 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500 border border-sky-400/20 flex items-center justify-center gap-2"
                            >
                                <span className="text-lg">🧭</span>
                                <span>Instrument Panel</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * The crowd-feed consent card and its disclaimer sheet.
 *
 * Two rules shape this UI, both learned the hard way elsewhere in the app:
 *
 *  1. TURNING IT ON IS A DECISION; TURNING IT OFF IS NOT. Enabling opens the
 *     full disclaimer and requires an explicit accept — because for a boat with
 *     a transponder, opting in publishes its own position publicly and that
 *     cannot be undone once AISHub copies it onward. Disabling is one tap with
 *     no friction, no confirmation and no "are you sure": consent withdrawal
 *     must never carry a cost.
 *  2. A DEAD CONTROL MUST LOOK DEAD. Inert-with-reason whenever the relay is
 *     unconfigured or the skipper is signed out, never a green light over
 *     nothing.
 *
 * Note what is NOT here any more: "waiting for the gateway". A disconnected
 * gateway no longer stops the watch — the check-in reports the fault and
 * standing is held — so telling the skipper sharing has stopped would be
 * false, and would push them to switch it off.
 */
const ConsentSheet: React.FC<{ onAccept: () => void; onDismiss: () => void }> = ({ onAccept, onDismiss }) => (
    <div
        className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Share what you hear"
        onClick={onDismiss}
    >
        <div
            className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-white/10 bg-slate-900 p-5 pb-8 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
            <h2 className="text-lg font-bold text-gray-100">Share what you hear</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-gray-300">
                Turn this on and every AIS sentence your gateway hears gets sent to Thalassa&rsquo;s fleet map and on to
                AISHub, a public AIS network that copies it out to other tracking sites. It&rsquo;s off by default and
                it&rsquo;s entirely your call.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-amber-300">Your own boat becomes publicly trackable.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                If your setup transmits &mdash; any Class A or Class B transponder &mdash; your boat&rsquo;s own
                position reports go out with everything else. Your MMSI, your boat&rsquo;s name if it&rsquo;s programmed
                in, your position, course and speed, live, on public tracking websites, to anyone who cares to look.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                We can&rsquo;t take that back. Once it reaches AISHub it&rsquo;s copied onward within seconds and we
                have no way to reach the sites that copied it. Turning sharing off later stops new reports. It does not
                remove what&rsquo;s already out there.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Don&rsquo;t turn this on if there&rsquo;s any reason you&rsquo;d rather your boat wasn&rsquo;t findable
                &mdash; you sail alone, you&rsquo;re avoiding someone, or you&rsquo;re heading somewhere that being
                tracked is a risk.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                If your gear only receives and never transmits, nothing about your boat goes out. Only the ships you
                hear.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">Being heard by nobody still counts.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Anchored somewhere with no ships for 200 miles? That silence is worth as much as a busy harbour &mdash;
                it proves someone was listening out there. What we count is time on watch, never ships delivered. An
                empty ocean earns exactly what Sydney Harbour earns.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What we keep about you.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                One row: how many minutes you&rsquo;ve been on watch, when we last heard from you, and how many
                sentences you&rsquo;ve sent. Not where you were, not where you went, no history. It&rsquo;s deleted when
                your account is.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What this never affects.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Nothing here changes what you see from your own AIS receiver, the collision guard, the anchor radar, or
                any ship near you. That&rsquo;s safety data. It&rsquo;s never rationed, for anyone, and never will be.
            </p>

            <p className="mt-4 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Data cost.</span> About 5 MB a month when there&rsquo;s
                nothing to hear, more in busy water. Switch on Low-data link for a satellite connection and it&rsquo;s
                under 1 MB &mdash; you earn exactly the same either way.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Turning it off.</span> One tap, any time. Sharing stops
                immediately.
            </p>

            <div className="mt-5 flex flex-col gap-2">
                <button
                    type="button"
                    onClick={onAccept}
                    className="rounded-xl bg-emerald-500 px-4 py-3 text-[15px] font-semibold text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Share what I hear
                </button>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="rounded-xl px-4 py-3 text-[15px] font-semibold text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Not now
                </button>
            </div>
        </div>
    </div>
);

const FleetSharingCard: React.FC<{ connected: boolean }> = ({ connected }) => {
    const [enabled, setEnabled] = useState(() => isShareEnabled());
    const [lowData, setLowData] = useState(() => isLowDataLink());
    const [sheetOpen, setSheetOpen] = useState(false);
    const [, force] = useState(0);
    useEffect(() => subscribeShareStats(() => force((n) => n + 1)), []);
    // Sharing uploads through an authenticated endpoint — signed out, every
    // batch is dropped by getAuthenticatedFunctionHeaders. The card must not
    // claim "Sharing live" in that state (review, 2026-08-21).
    const signedIn = useAuthStore((state) => state.user !== null);

    const configured = isShareConfigured();
    const stats = getShareStats();
    const active = enabled && configured && signedIn;
    const hours = stats.card ? Math.floor(stats.card.watchMinutes / 60) : 0;

    return (
        <div className="shrink-0 mb-3 rounded-2xl border border-white/[0.08] bg-slate-900/60 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-100">Share what you hear</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                        Contribute the AIS traffic this gateway hears to the Thalassa fleet map and to AISHub&rsquo;s
                        public network. Off by default &mdash; sharing is an explicit choice.
                    </p>
                </div>
                <Toggle
                    checked={enabled}
                    onChange={(value) => {
                        // ON asks first. OFF is immediate — withdrawal must
                        // never be made harder than consent.
                        if (value) {
                            setSheetOpen(true);
                            return;
                        }
                        setShareEnabled(false);
                        setEnabled(false);
                    }}
                    label="Share what you hear"
                />
            </div>

            {enabled && !configured && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    This build has no share relay configured &mdash; nothing is being sent.
                </p>
            )}
            {enabled && configured && !signedIn && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    Sign in to share &mdash; the fleet feed needs a Thalassa account.
                </p>
            )}

            {active && (
                <>
                    <p className="mt-2 text-[11px] font-semibold text-emerald-300">
                        {stats.card
                            ? `On watch · ${hours.toLocaleString()} h total · ${stats.card.watchMinutes7d.toLocaleString()} min this week`
                            : 'On watch · first check-in on its way'}
                    </p>
                    {!connected && (
                        // Deliberately NOT an error. Standing is held through a
                        // gateway fault, and telling someone their contribution
                        // has stopped is how you get them to switch it off.
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Gateway down{stats.linkError ? ` — ${stats.linkError}` : ''}. Standing held. Nothing to fix
                            if the boat&rsquo;s ashore.
                        </p>
                    )}
                    {connected && stats.sharedTotal === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Nothing heard yet. If you&rsquo;re offshore that&rsquo;s exactly what we&rsquo;d expect, and
                            it still counts.
                        </p>
                    )}
                    {stats.rejected && stats.rejected.checksum > 0 && stats.rejected.notAis === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
                            Most sentences are failing their checksum &mdash; usually a baud-rate or NMEA-0183 wiring
                            fault.
                        </p>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                        <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-gray-200">Low-data link</p>
                            <p className="text-[11px] leading-relaxed text-gray-400">
                                Check in every 30 minutes instead of 5, for satellite. Earns exactly the same.
                            </p>
                        </div>
                        <Toggle
                            checked={lowData}
                            onChange={(value) => {
                                setLowDataLink(value);
                                setLowData(value);
                            }}
                            label="Low-data link"
                        />
                    </div>
                </>
            )}

            {sheetOpen && (
                <ConsentSheet
                    onAccept={() => {
                        setShareEnabled(true);
                        setEnabled(true);
                        setSheetOpen(false);
                        triggerHaptic();
                    }}
                    onDismiss={() => setSheetOpen(false)}
                />
            )}
        </div>
    );
};
