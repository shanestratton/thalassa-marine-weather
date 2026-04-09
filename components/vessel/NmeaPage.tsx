/**
 * NmeaPage — Standalone NMEA Gateway connection page for the Vessel Hub.
 *
 * Shows connection status, configuration controls, and AIS Hub settings.
 * The "Instrument Panel" CTA navigates to the full multimeter dashboard.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('NmeaPage');
import { useNmeaStore, NmeaStatusDot } from '../nmea/useNmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { triggerHaptic } from '../../utils/system';
import { AisStore } from '../../services/AisStore';
import { AisHubService, type AisHubStats } from '../../services/AisHubService';

import { PageHeader } from '../ui/PageHeader';
import { FormField } from '../ui/FormField';

interface NmeaPageProps {
    onBack: () => void;
    onNavigateToGlass?: () => void;
}

// ── Device presets — auto-fills port for common NMEA gateways ──
const DEVICE_PRESETS = [
    { id: 'ydwg02', label: 'Yacht Devices YDWG-02', port: '1456' },
    { id: 'ikonvert', label: 'Digital Yacht iKonvert', port: '2000' },
    { id: 'w2k1', label: 'Actisense W2K-1', port: '2000' },
    { id: 'signalk', label: 'Signal K Server', port: '10110' },
    { id: 'direct', label: 'Direct TCP (NMEA 0183)', port: '10110' },
] as const;

export const NmeaPage: React.FC<NmeaPageProps> = ({ onBack, onNavigateToGlass }) => {
    const state = useNmeaStore();
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

    // AISHub uplink state
    const aisHubConfig = AisHubService.getConfig();
    const [aisHubEnabled, setAisHubEnabled] = useState(aisHubConfig.enabled);
    const [aisHubIp, setAisHubIp] = useState(aisHubConfig.ip);
    const [aisHubPort, setAisHubPort] = useState(String(aisHubConfig.port || ''));
    const [aisHubStats, setAisHubStats] = useState<AisHubStats>(AisHubService.getStats());

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

        // Subscribe to AISHub stats
        const unsubHub = AisHubService.subscribe((stats) => {
            setAisHubStats(stats);
        });

        return () => {
            unsub();
            clearInterval(poll);
            unsubAis();
            unsubHub();
        };
    }, []);

    const handleDeviceChange = useCallback((deviceId: string) => {
        setDevice(deviceId);
        localStorage.setItem('nmea_device', deviceId);
        const preset = DEVICE_PRESETS.find((d) => d.id === deviceId);
        if (preset) {
            setPort(preset.port);
            localStorage.setItem('nmea_port', preset.port);
        }
    }, []);

    const isConnected = connStatus === 'connected';
    const isConnecting = connStatus === 'connecting' || connStatus === 'error';

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
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
                >
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
                                        {DEVICE_PRESETS.map((d) => (
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
                                            placeholder={DEVICE_PRESETS.find((d) => d.id === device)?.port || '1456'}
                                            mono
                                            inputMode="numeric"
                                        />
                                    </div>
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

                    {/* ═══ AISHUB CONTRIBUTION ═══ */}
                    <div className="shrink-0 mb-3 p-4 rounded-2xl border bg-white/[0.03] border-white/[0.06] transition-all">
                        {/* Toggle row */}
                        <label className="flex items-center gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={aisHubEnabled}
                                onChange={(e) => {
                                    const enabled = e.target.checked;
                                    setAisHubEnabled(enabled);
                                    AisHubService.setEnabled(enabled);
                                    if (enabled && aisHubIp && aisHubPort) {
                                        AisHubService.configure(aisHubIp, parseInt(aisHubPort, 10));
                                    }
                                    triggerHaptic('light');
                                }}
                                className="w-4 h-4 rounded accent-sky-500 cursor-pointer"
                            />
                            <div className="flex-1">
                                <p className="text-sm font-bold text-white">Contribute to AISHub</p>
                                <p className="text-[11px] text-gray-500">Forward AIS data to the global network</p>
                            </div>
                            {aisHubEnabled && aisHubStats.isActive && (
                                <span className="flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[11px] font-bold text-emerald-400">LIVE</span>
                                </span>
                            )}
                        </label>

                        {/* Config fields — visible when enabled */}
                        {aisHubEnabled && (
                            <div className="mt-3 space-y-2">
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <FormField
                                            label="Station IP"
                                            value={aisHubIp}
                                            onChange={(v) => {
                                                setAisHubIp(v);
                                                if (v && aisHubPort) {
                                                    AisHubService.configure(v, parseInt(aisHubPort, 10));
                                                }
                                            }}
                                            placeholder="data.aishub.net"
                                            mono
                                        />
                                    </div>
                                    <div className="w-24">
                                        <FormField
                                            label="Port"
                                            value={aisHubPort}
                                            onChange={(v) => {
                                                setAisHubPort(v);
                                                if (aisHubIp && v) {
                                                    AisHubService.configure(aisHubIp, parseInt(v, 10));
                                                }
                                            }}
                                            placeholder="2345"
                                            mono
                                            inputMode="numeric"
                                        />
                                    </div>
                                </div>

                                {/* Stats line */}
                                {aisHubStats.sentenceCount > 0 && (
                                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/15">
                                        <span className="text-sky-400 text-xs">↑</span>
                                        <span className="text-[11px] text-sky-300 font-bold">
                                            {aisHubStats.sentenceCount.toLocaleString()} sentences forwarded
                                        </span>
                                        <span className="text-[11px] text-sky-300/50 ml-auto">
                                            {(aisHubStats.bytesSent / 1024).toFixed(1)} KB
                                        </span>
                                    </div>
                                )}

                                <p className="text-[11px] text-gray-500 leading-relaxed">
                                    Register at aishub.net to get your station IP and port. Data is sent only over Wi-Fi
                                    to manage costs.
                                </p>
                            </div>
                        )}
                    </div>

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
