/**
 * NmeaPage — Standalone NMEA Gateway dashboard for the Vessel Hub.
 *
 * Shows connection status, live instrument data, and connection controls.
 * Wraps the NMEA store hooks and UI primitives into a full-page view.
 */
import React, { useState, useCallback } from 'react';
import { useNmeaStore, NmeaValue, NmeaStatusDot } from '../nmea/useNmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { triggerHaptic } from '../../utils/system';

interface NmeaPageProps {
    onBack: () => void;
}

export const NmeaPage: React.FC<NmeaPageProps> = ({ onBack }) => {
    const state = useNmeaStore();
    const [host, setHost] = useState(localStorage.getItem('nmea_host') || '192.168.1.1');
    const [port, setPort] = useState(localStorage.getItem('nmea_port') || '10110');
    const [connecting, setConnecting] = useState(false);

    const isConnected = state.connectionStatus === 'connected';
    const isConnecting = state.connectionStatus === 'connecting';

    const handleConnect = useCallback(async () => {
        setConnecting(true);
        triggerHaptic('medium');
        try {
            localStorage.setItem('nmea_host', host);
            localStorage.setItem('nmea_port', port);
            NmeaListenerService.configure(host, parseInt(port, 10));
            NmeaListenerService.start();
        } catch (e) {
            console.error('NMEA connect failed:', e);
        } finally {
            setConnecting(false);
        }
    }, [host, port]);

    const handleDisconnect = useCallback(() => {
        triggerHaptic('medium');
        NmeaListenerService.stop();
    }, []);

    // Instrument data cards
    const instruments = [
        { label: 'True Wind Speed', metric: state.tws, unit: 'kts', icon: '💨' },
        { label: 'True Wind Angle', metric: state.twa, unit: '°', icon: '🧭' },
        { label: 'Speed Through Water', metric: state.stw, unit: 'kts', icon: '🌊' },
        { label: 'Speed Over Ground', metric: state.sog, unit: 'kts', icon: '📡' },
        { label: 'Course Over Ground', metric: state.cog, unit: '°', icon: '🗺️' },
        { label: 'Heading', metric: state.heading, unit: '°', icon: '⚓' },
        { label: 'Depth', metric: state.depth, unit: 'm', icon: '🔵' },
        { label: 'Water Temperature', metric: state.waterTemp, unit: '°C', icon: '🌡️' },
    ];

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                {/* ═══ HEADER ═══ */}
                <div className="shrink-0 px-4 pt-3 pb-2">
                    <div className="flex items-center gap-3">
                        <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div className="flex-1">
                            <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">NMEA</h1>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Instrument Data</p>
                        </div>
                        <NmeaStatusDot />
                    </div>
                </div>

                {/* Content — fills viewport, no scroll */}
                <div className="flex-1 flex flex-col px-4 min-h-0 overflow-hidden" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}>

                    {/* ═══ CONNECTION CARD ═══ */}
                    <div className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${isConnected
                        ? 'bg-emerald-500/10 border-emerald-500/20'
                        : 'bg-white/[0.03] border-white/[0.06]'
                        }`}>
                        <div className="flex items-center gap-3 mb-3">
                            <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-emerald-400' :
                                isConnecting ? 'bg-amber-400 animate-pulse' :
                                    'bg-gray-500'
                                }`} />
                            <h3 className="text-sm font-black text-white">
                                {isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Disconnected'}
                            </h3>
                        </div>

                        {!isConnected && (
                            <div className="flex gap-2 mb-3">
                                <div className="flex-1">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Host IP</label>
                                    <input
                                        type="text"
                                        value={host}
                                        onChange={e => setHost(e.target.value)}
                                        placeholder="192.168.1.1"
                                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 font-mono"
                                    />
                                </div>
                                <div className="w-24">
                                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Port</label>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        value={port}
                                        onChange={e => setPort(e.target.value)}
                                        placeholder="10110"
                                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 font-mono"
                                    />
                                </div>
                            </div>
                        )}

                        <button
                            onClick={isConnected ? handleDisconnect : handleConnect}
                            disabled={connecting || isConnecting}
                            className={`w-full py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] disabled:opacity-50 ${isConnected
                                ? 'bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30'
                                : 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500'
                                }`}
                        >
                            {connecting || isConnecting ? (
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                            ) : isConnected ? 'Disconnect' : 'Connect'}
                        </button>
                    </div>

                    {/* ═══ INSTRUMENT GRID ═══ */}
                    <h3 className="shrink-0 text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Live Instruments</h3>
                    <div className="flex-1 grid grid-cols-2 gap-2 min-h-0 auto-rows-fr">
                        {instruments.map(inst => (
                            <div
                                key={inst.label}
                                className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col justify-center min-h-0"
                            >
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-base">{inst.icon}</span>
                                    <span className="text-[8px] text-gray-500 font-bold uppercase tracking-widest leading-tight">{inst.label}</span>
                                </div>
                                <NmeaValue
                                    metric={inst.metric}
                                    unit={inst.unit}
                                    decimals={inst.unit === '°' ? 0 : 1}
                                    className="text-xl font-black"
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
