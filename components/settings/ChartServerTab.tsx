/**
 * ChartServerTab — Settings panel for AvNav server configuration.
 *
 * Allows the user to configure their AvNav server connection,
 * scan the local network for chart servers, and view available charts.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
    AvNavService,
    type AvNavChart,
    type AvNavConnectionStatus,
    type DiscoveredServer,
} from '../../services/AvNavService';
import { Section, Row } from './SettingsPrimitives';
import { ChartServerSetupGuide } from './ChartServerSetupGuide';

export const ChartServerTab: React.FC = () => {
    const [host, setHost] = useState(AvNavService.getHost());
    const [port, setPort] = useState(String(AvNavService.getPort()));
    const [status, setStatus] = useState<AvNavConnectionStatus>(AvNavService.getStatus());
    const [charts, setCharts] = useState<AvNavChart[]>(AvNavService.getCharts());
    const [apiVersion, setApiVersion] = useState<string | null>(AvNavService.getApiVersion());
    const [lastError, setLastError] = useState<string | null>(AvNavService.getLastError());
    const [serverType, setServerType] = useState<'signalk' | 'avnav' | null>(AvNavService.getServerType());
    const [serverTypeChoice, setServerTypeChoice] = useState<'signalk' | 'avnav'>(
        () => (localStorage.getItem('avnav_server_type') as 'signalk' | 'avnav') || 'avnav',
    );
    const [wanHost, setWanHost] = useState(() => AvNavService.getWanHost());
    const [showAdvanced, setShowAdvanced] = useState(false);

    // Scan state
    const [scanning, setScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState(0);
    const [scanTotal, setScanTotal] = useState(0);
    const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);

    useEffect(() => {
        const unsubStatus = AvNavService.onStatusChange((s) => {
            setStatus(s);
            setApiVersion(AvNavService.getApiVersion());
            setLastError(AvNavService.getLastError());
            setServerType(AvNavService.getServerType());
        });
        const unsubCharts = AvNavService.onChartsChange((c) => setCharts(c));
        return () => {
            unsubStatus();
            unsubCharts();
        };
    }, []);

    const handleConnect = useCallback(() => {
        AvNavService.configure(host, parseInt(port, 10) || 3000, serverTypeChoice, wanHost || undefined);
        AvNavService.start();
    }, [host, port, serverTypeChoice, wanHost]);

    const handleDisconnect = useCallback(() => {
        AvNavService.stop();
    }, []);

    const handleScan = useCallback(async () => {
        setScanning(true);
        setScanProgress(0);
        setScanTotal(0);
        setDiscoveredServers([]);

        try {
            await AvNavService.scanNetwork(
                (scanned, total) => {
                    setScanProgress(scanned);
                    setScanTotal(total);
                },
                (server) => {
                    setDiscoveredServers((prev) => {
                        if (prev.some((s) => s.host === server.host && s.port === server.port)) return prev;
                        return [...prev, server];
                    });
                },
            );
        } catch (err) {
            console.error('[ChartServerTab] Scan failed:', err);
        } finally {
            setScanning(false);
        }
    }, []);

    const handleSelectServer = useCallback((server: DiscoveredServer) => {
        setHost(server.host);
        setPort(String(server.port));
        setServerTypeChoice(server.serverType);
        // Auto-connect
        AvNavService.configure(server.host, server.port, server.serverType);
        AvNavService.start();
    }, []);

    const isConnected = status === 'connected';
    const isConnecting = status === 'connecting';

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                    <span className="text-lg">⚓</span>
                </div>
                <div>
                    <h3 className="text-lg font-black text-white tracking-wide">Chart Server</h3>
                    <p className="text-[11px] text-gray-400">Connect to AvNav for nautical charts</p>
                </div>
            </div>

            {/* Connection Status */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4">
                <div className="flex items-center gap-3 mb-4">
                    <span
                        className={`w-3 h-3 rounded-full ${
                            isConnected
                                ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50'
                                : isConnecting
                                  ? 'bg-amber-400 animate-pulse'
                                  : status === 'error'
                                    ? 'bg-red-400 shadow-lg shadow-red-400/50'
                                    : 'bg-gray-500'
                        }`}
                    />
                    <div className="flex-1">
                        <p className="text-sm font-bold text-white">
                            {isConnected
                                ? 'Connected'
                                : isConnecting
                                  ? 'Connecting...'
                                  : status === 'error'
                                    ? 'Connection Error'
                                    : 'Disconnected'}
                        </p>
                        {isConnected && (
                            <p className="text-[11px] text-gray-400">
                                {serverType === 'avnav'
                                    ? 'AvNav'
                                    : apiVersion
                                      ? `AvNav API ${apiVersion}`
                                      : 'Connected'}{' '}
                                · {AvNavService.getActiveHost()}:{port}
                                {AvNavService.isWanActive() && (
                                    <span className="ml-1 text-[9px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded">
                                        WAN
                                    </span>
                                )}
                                {!AvNavService.isWanActive() && isConnected && (
                                    <span className="ml-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                                        LAN
                                    </span>
                                )}
                            </p>
                        )}
                        {lastError && !isConnected && <p className="text-[11px] text-red-400 mt-0.5">{lastError}</p>}
                    </div>
                    {isConnected || isConnecting ? (
                        <button
                            onClick={handleDisconnect}
                            className="px-4 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-xs font-bold uppercase tracking-wider hover:bg-red-500/25 transition-all active:scale-95"
                        >
                            Disconnect
                        </button>
                    ) : (
                        <button
                            onClick={handleConnect}
                            className="px-4 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold uppercase tracking-wider hover:bg-emerald-500/25 transition-all active:scale-95"
                        >
                            Connect
                        </button>
                    )}
                </div>
            </div>

            {/* ═══ SCAN NETWORK ═══ */}
            {!isConnected && (
                <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <span className="text-lg">📡</span>
                            <div>
                                <p className="text-sm font-bold text-white">Find My Server</p>
                                <p className="text-[9px] text-gray-500">Scan WiFi for AvNav / Signal K</p>
                            </div>
                        </div>
                        <button
                            onClick={handleScan}
                            disabled={scanning}
                            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all active:scale-95 ${
                                scanning
                                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400 animate-pulse cursor-wait'
                                    : 'bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25'
                            }`}
                        >
                            {scanning ? 'Scanning...' : 'Scan'}
                        </button>
                    </div>

                    {/* Progress */}
                    {scanning && scanTotal > 0 && (
                        <div className="mb-3">
                            <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-sky-500 to-teal-400 rounded-full transition-all duration-300"
                                    style={{ width: `${Math.min(100, (scanProgress / scanTotal) * 100)}%` }}
                                />
                            </div>
                            <p className="text-[9px] text-gray-600 mt-1 text-right">
                                {scanProgress}/{scanTotal} probes
                            </p>
                        </div>
                    )}

                    {/* Discovered servers */}
                    {discoveredServers.length > 0 && (
                        <div className="space-y-2">
                            {discoveredServers.map((server, idx) => (
                                <button
                                    key={`${server.host}:${server.port}-${idx}`}
                                    onClick={() => handleSelectServer(server)}
                                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/20 hover:bg-emerald-500/15 transition-all active:scale-[0.98] text-left"
                                >
                                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                                        <span className="text-sm">{server.serverType === 'avnav' ? '⛵' : '🔌'}</span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-bold text-white truncate">
                                            {server.host}:{server.port}
                                        </p>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span
                                                className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                                    server.serverType === 'avnav'
                                                        ? 'bg-emerald-500/20 text-emerald-400'
                                                        : 'bg-sky-500/20 text-sky-400'
                                                }`}
                                            >
                                                {server.serverType === 'avnav' ? 'AvNav' : 'Signal K'}
                                            </span>
                                        </div>
                                    </div>
                                    <span className="text-emerald-400 text-xs font-bold">Connect →</span>
                                </button>
                            ))}
                        </div>
                    )}

                    {/* No results after scan */}
                    {!scanning && scanTotal > 0 && discoveredServers.length === 0 && (
                        <div className="text-center py-3">
                            <p className="text-xs text-gray-500">No servers found on this network.</p>
                            <p className="text-[9px] text-gray-600 mt-1">
                                Make sure AvNav is running and your phone is on the same WiFi.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Server Configuration */}
            <Section title="Server Configuration">
                <Row label="Server Type">
                    <div className="flex gap-1 bg-black/40 rounded-xl p-1 border border-white/10">
                        <button
                            onClick={() => setServerTypeChoice('avnav')}
                            disabled={isConnected}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                                serverTypeChoice === 'avnav'
                                    ? 'bg-emerald-500/25 text-emerald-400 border border-emerald-500/40'
                                    : 'text-gray-500 hover:text-gray-300'
                            } disabled:opacity-50`}
                        >
                            AvNav
                        </button>
                        <button
                            onClick={() => setServerTypeChoice('signalk')}
                            disabled={isConnected}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                                serverTypeChoice === 'signalk'
                                    ? 'bg-sky-500/25 text-sky-400 border border-sky-500/40'
                                    : 'text-gray-500 hover:text-gray-300'
                            } disabled:opacity-50`}
                        >
                            Signal K
                        </button>
                    </div>
                </Row>
                <Row label="Host Address">
                    <input
                        type="text"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder={serverTypeChoice === 'avnav' ? '192.168.x.x' : 'signalk.local'}
                        disabled={isConnected}
                        className="w-48 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-600 outline-none focus:border-sky-500 focus:shadow-[0_0_10px_rgba(14,165,233,0.2)] transition-all disabled:opacity-50"
                    />
                </Row>
                <Row label="Port">
                    <input
                        type="number"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        placeholder="3000"
                        disabled={isConnected}
                        className="w-24 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-600 outline-none focus:border-sky-500 focus:shadow-[0_0_10px_rgba(14,165,233,0.2)] transition-all disabled:opacity-50"
                    />
                </Row>

                {/* ── Remote Access (hidden by default) ── */}
                <div className="px-4 pt-1">
                    <button
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
                    >
                        <span
                            style={{
                                transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                                display: 'inline-block',
                                fontSize: 8,
                            }}
                        >
                            ▶
                        </span>
                        Remote Access
                    </button>
                </div>

                {showAdvanced && (
                    <div className="px-4 pb-2 space-y-3" style={{ animation: 'bio-fadein 0.2s ease' }}>
                        <Row label="WAN Address">
                            <input
                                type="text"
                                value={wanHost}
                                onChange={(e) => setWanHost(e.target.value)}
                                placeholder="myboat.ddns.net"
                                disabled={isConnected}
                                className="w-48 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-600 outline-none focus:border-amber-500 focus:shadow-[0_0_10px_rgba(245,158,11,0.15)] transition-all disabled:opacity-50"
                            />
                        </Row>
                        <p className="text-[9px] text-gray-600 leading-relaxed">
                            Optional. If you have port forwarding or a dynamic DNS set up, enter your external
                            hostname/IP here. Thalassa will try your LAN address first and fall back to this when
                            you&apos;re away from the boat. Same port is used for both.
                        </p>
                    </div>
                )}
            </Section>

            {/* Available Charts */}
            <Section title="Nautical Charts">
                {charts.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                        <span className="text-2xl mb-2 block">🗺️</span>
                        {isConnected ? (
                            <>
                                <p className="text-sm text-gray-400 font-bold">No charts available</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Install the <span className="text-emerald-400 font-mono">avnav chart plugin</span>{' '}
                                    plugin on your AvNav server and add MBTiles chart files.
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-sm text-gray-400 font-bold">Connect to discover charts</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Tap &quot;Scan&quot; above or enter your chart server address and tap Connect.
                                </p>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {charts.map((chart) => (
                            <div
                                key={chart.id}
                                className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.04]"
                            >
                                <span className="text-lg">🗺️</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-white truncate">{chart.name}</p>
                                    {chart.description && (
                                        <p className="text-[10px] text-gray-500 truncate">{chart.description}</p>
                                    )}
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[10px] text-gray-500 font-mono">
                                            z{chart.minZoom}–{chart.maxZoom}
                                        </span>
                                        <span className="text-[10px] text-gray-600">·</span>
                                        <span className="text-[10px] text-gray-500">{chart.type}</span>
                                        <span className="text-[10px] text-gray-600">·</span>
                                        <span className="text-[10px] text-gray-500">{chart.format}</span>
                                    </div>
                                </div>
                                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {/* Setup Guide */}
            <ChartServerSetupGuide />
        </div>
    );
};
