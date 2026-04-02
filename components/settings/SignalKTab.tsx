/**
 * SignalKTab — Settings panel for Signal K server configuration.
 *
 * Allows the user to configure their Signal K server connection
 * and view available nautical charts.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { SignalKService, type SignalKChart, type SignalKConnectionStatus } from '../../services/SignalKService';
import { Section, Row } from './SettingsPrimitives';
import { SignalKSetupGuide } from './SignalKSetupGuide';

export const SignalKTab: React.FC = () => {
    const [host, setHost] = useState(SignalKService.getHost());
    const [port, setPort] = useState(String(SignalKService.getPort()));
    const [status, setStatus] = useState<SignalKConnectionStatus>(SignalKService.getStatus());
    const [charts, setCharts] = useState<SignalKChart[]>(SignalKService.getCharts());
    const [apiVersion, setApiVersion] = useState<string | null>(SignalKService.getApiVersion());
    const [lastError, setLastError] = useState<string | null>(SignalKService.getLastError());

    useEffect(() => {
        const unsubStatus = SignalKService.onStatusChange((s) => {
            setStatus(s);
            setApiVersion(SignalKService.getApiVersion());
            setLastError(SignalKService.getLastError());
        });
        const unsubCharts = SignalKService.onChartsChange((c) => setCharts(c));
        return () => {
            unsubStatus();
            unsubCharts();
        };
    }, []);

    const handleConnect = useCallback(() => {
        SignalKService.configure(host, parseInt(port, 10) || 3000);
        SignalKService.start();
    }, [host, port]);

    const handleDisconnect = useCallback(() => {
        SignalKService.stop();
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
                    <h3 className="text-lg font-black text-white tracking-wide">Signal K</h3>
                    <p className="text-[11px] text-gray-400">
                        Connect to your vessel's Signal K server for nautical charts
                    </p>
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
                        {isConnected && apiVersion && (
                            <p className="text-[11px] text-gray-400">
                                Signal K API {apiVersion} · {host}:{port}
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

            {/* Server Configuration */}
            <Section title="Server Configuration">
                <Row label="Host Address">
                    <input
                        type="text"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="signalk.local"
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
                                    Install the{' '}
                                    <span className="text-emerald-400 font-mono">signalk-charts-provider-simple</span>{' '}
                                    plugin on your Signal K server and add MBTiles chart files.
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-sm text-gray-400 font-bold">Connect to discover charts</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Enter your Signal K server address above and tap Connect.
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
            <SignalKSetupGuide />
        </div>
    );
};
