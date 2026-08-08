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
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
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
    const isConnecting = connStatus === 'connecting' || connStatus === 'error';

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
                                {isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Disconnected'}
                            </h3>
                            {/* Show host:port when connected or connecting */}
                            {(isConnected || isConnecting) && (
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

                        {/* Reconnect status message */}
                        {isConnecting && reconnectAttempts > 0 && (
                            <div className="mb-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/15">
                                <p className="text-xs text-amber-300 font-medium">
                                    Reconnecting... attempt {reconnectAttempts}
                                </p>
                                {lastError && (
                                    <p className="text-[11px] text-amber-200/50 mt-0.5 truncate">{lastError}</p>
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

                    {!FEATURE_VISIBILITY.aisHub && (
                        <div
                            className="shrink-0 mb-3 rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] p-4"
                            role="status"
                        >
                            <p className="text-sm font-bold text-amber-200">AISHub contribution unavailable in beta</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-amber-100/60">
                                AIS reception and the instrument display still work. Outbound UDP contribution is held
                                until its native bridge is compatible with this app release and device-tested.
                            </p>
                        </div>
                    )}

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
