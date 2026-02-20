/**
 * VesselHub — Ship's Office & Active Watch dashboard.
 *
 * Three-zone split screen:
 *   Zone 1: Active Watch (anchor alarm, log entry) — top priority
 *   Zone 2: Ship's Office Grid (inventory, maintenance, polars, NMEA) — 2x2 cards
 *   Zone 3: App Administration (account, dark mode, terms) — bottom rows
 */
import React, { useState, useEffect, useCallback } from 'react';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { NmeaListenerService } from '../services/NmeaListenerService';
import { triggerHaptic } from '../utils/system';

interface VesselHubProps {
    onNavigate: (page: string) => void;
    settings: Record<string, unknown>;
    onSave: (updates: Record<string, unknown>) => void;
}

// Zone 2 card config
interface OfficeCard {
    id: string;
    label: string;
    sublabel: string;
    icon: React.ReactNode;
    page: string;
    accentColor: string;
    accentBg: string;
}

export const VesselHub: React.FC<VesselHubProps> = ({ onNavigate, settings, onSave }) => {
    // ── Anchor state ──
    const [anchorActive, setAnchorActive] = useState(false);
    const [anchorRadius, setAnchorRadius] = useState(0);
    const [anchorStatus, setAnchorStatus] = useState<'armed' | 'disarmed' | 'alarm'>('disarmed');

    // Poll anchor state via the actual AnchorWatchService API
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snapshot) => {
            setAnchorActive(snapshot.state === 'watching' || snapshot.state === 'alarm');
            setAnchorRadius(snapshot.swingRadius || 0);
            setAnchorStatus(snapshot.state === 'alarm' ? 'alarm' : snapshot.state === 'watching' ? 'armed' : 'disarmed');
        });
        return unsub;
    }, []);

    const toggleAnchor = useCallback(() => {
        triggerHaptic('medium');
        if (anchorActive) {
            AnchorWatchService.stopWatch();
            setAnchorActive(false);
            setAnchorStatus('disarmed');
        } else {
            onNavigate('compass'); // Navigate to anchor page for deployment
        }
    }, [anchorActive, onNavigate]);

    const handleLogEntry = useCallback(() => {
        triggerHaptic('light');
        onNavigate('details'); // Navigate to log page
    }, [onNavigate]);

    // Zone 2 cards
    const officeCards: OfficeCard[] = [
        {
            id: 'inventory',
            label: 'Inventory',
            sublabel: 'Spares & Supplies',
            icon: <BoxIcon />,
            page: 'inventory',
            accentColor: 'text-amber-400',
            accentBg: 'from-amber-500/20 to-orange-500/20 border-amber-500/20',
        },
        {
            id: 'maintenance',
            label: 'Maintenance',
            sublabel: 'Tasks & Expiry',
            icon: <WrenchIcon />,
            page: 'maintenance',
            accentColor: 'text-sky-400',
            accentBg: 'from-sky-500/20 to-cyan-500/20 border-sky-500/20',
        },
        {
            id: 'polars',
            label: 'Polars',
            sublabel: 'Performance Data',
            icon: <ChartIcon />,
            page: 'polars',
            accentColor: 'text-emerald-400',
            accentBg: 'from-emerald-500/20 to-teal-500/20 border-emerald-500/20',
        },
        {
            id: 'nmea',
            label: 'NMEA',
            sublabel: 'Network Gateway',
            icon: <SignalIcon />,
            page: 'nmea',
            accentColor: 'text-violet-400',
            accentBg: 'from-violet-500/20 to-purple-500/20 border-violet-500/20',
        },
    ];

    const anchorColors = {
        disarmed: { bg: 'from-gray-600/20 to-gray-700/20', border: 'border-gray-500/20', text: 'text-gray-400', button: 'bg-gray-600', label: 'Disarmed' },
        armed: { bg: 'from-emerald-600/20 to-green-600/20', border: 'border-emerald-500/30', text: 'text-emerald-400', button: 'bg-emerald-600', label: `Armed — ${anchorRadius}m Swing Radius` },
        alarm: { bg: 'from-red-600/30 to-red-700/30', border: 'border-red-500/40', text: 'text-red-400', button: 'bg-red-600 animate-pulse', label: '⚠️ DRAG ALARM' },
    };
    const ac = anchorColors[anchorStatus];

    return (
        <div className="w-full max-w-2xl mx-auto px-4 pb-24 pt-4 animate-in fade-in duration-300">

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 1: ACTIVE WATCH */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-5 rounded-full bg-red-500" />
                    <span className="text-[10px] font-black text-red-400 uppercase tracking-[0.2em]">Active Watch</span>
                </div>

                {/* Anchor Alarm Card */}
                <div className={`bg-gradient-to-br ${ac.bg} border ${ac.border} rounded-2xl p-5 mb-3`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className={`p-3 rounded-xl ${anchorStatus === 'alarm' ? 'bg-red-600/30' : anchorStatus === 'armed' ? 'bg-emerald-500/20' : 'bg-gray-600/20'}`}>
                                <svg className={`w-7 h-7 ${ac.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L12 5M12 5C9.79 5 8 6.79 8 9V12L12 16L16 12V9C16 6.79 14.21 5 12 5ZM8 19H16M10 19V21M14 19V21M5 12H3M21 12H19" />
                                </svg>
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-white tracking-wide">Anchor Watch</h3>
                                <p className={`text-xs font-bold ${ac.text} uppercase tracking-widest`}>{ac.label}</p>
                            </div>
                        </div>

                        {/* Toggle */}
                        <button
                            onClick={toggleAnchor}
                            className={`w-16 h-9 rounded-full transition-all duration-300 relative ${anchorActive ? ac.button : 'bg-gray-700'
                                } shadow-lg`}
                        >
                            <div className={`absolute top-1 w-7 h-7 bg-white rounded-full shadow-md transition-transform duration-300 ${anchorActive ? 'translate-x-8' : 'translate-x-1'
                                }`} />
                        </button>
                    </div>
                </div>

                {/* Drop Log Entry Button */}
                <button
                    onClick={handleLogEntry}
                    className="w-full py-4 bg-gradient-to-r from-sky-600/20 to-cyan-600/20 border border-sky-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-sky-600/30 hover:to-cyan-600/30 transition-all active:scale-[0.98]"
                >
                    <div className="p-2 bg-sky-500/20 rounded-lg group-hover:bg-sky-500/30 transition-colors">
                        <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                    </div>
                    <span className="text-sm font-black text-sky-400 uppercase tracking-[0.15em]">Log Current Position</span>
                </button>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 2: SHIP'S OFFICE GRID */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-5 rounded-full bg-sky-500" />
                    <span className="text-[10px] font-black text-sky-400 uppercase tracking-[0.2em]">Ship&apos;s Office</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    {officeCards.map(card => (
                        <button
                            key={card.id}
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate(card.page);
                            }}
                            className={`bg-gradient-to-br ${card.accentBg} border rounded-2xl p-5 text-left group hover:scale-[1.02] transition-all active:scale-[0.98]`}
                        >
                            <div className={`p-3 rounded-xl bg-white/5 inline-block mb-3 group-hover:bg-white/10 transition-colors`}>
                                <div className={`${card.accentColor}`}>{card.icon}</div>
                            </div>
                            <h4 className="text-sm font-black text-white tracking-wide">{card.label}</h4>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">{card.sublabel}</p>
                        </button>
                    ))}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 3: APP ADMINISTRATION */}
            {/* ═══════════════════════════════════════════ */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-5 rounded-full bg-gray-600" />
                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">Administration</span>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl overflow-hidden divide-y divide-white/[0.06]">
                    {/* Account & Subscription */}
                    <button
                        onClick={() => onNavigate('settings')}
                        className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-white/[0.03] transition-colors"
                    >
                        <div className="p-2 bg-white/5 rounded-lg">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Account & Subscription</p>
                            <p className="text-[10px] text-gray-500">{(settings as Record<string, unknown>).isPro ? 'Thalassa PRO' : 'Free Plan'}</p>
                        </div>
                        <ChevronRight />
                    </button>

                    {/* Dark/Light Mode */}
                    <div className="px-5 py-4 flex items-center gap-4">
                        <div className="p-2 bg-white/5 rounded-lg">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Dark Mode</p>
                            <p className="text-[10px] text-gray-500">Always on for maritime use</p>
                        </div>
                        <div className="w-10 h-6 bg-emerald-600 rounded-full relative">
                            <div className="absolute top-0.5 right-0.5 w-5 h-5 bg-white rounded-full shadow" />
                        </div>
                    </div>

                    {/* Terms & Privacy */}
                    <button
                        onClick={() => window.open('https://thalassa.app/terms', '_blank')}
                        className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-white/[0.03] transition-colors"
                    >
                        <div className="p-2 bg-white/5 rounded-lg">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-bold text-white">Terms & Privacy</p>
                        </div>
                        <ChevronRight />
                    </button>
                </div>

                <p className="text-center text-[9px] text-gray-600 mt-4 font-bold uppercase tracking-widest">
                    Thalassa Marine Weather v2.0
                </p>
            </div>
        </div>
    );
};

// ── Zone 2 Icons ──

const BoxIcon: React.FC = () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
    </svg>
);

const WrenchIcon: React.FC = () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36" />
    </svg>
);

const ChartIcon: React.FC = () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-1.5L12 12l3 1.5 3-3V6" />
    </svg>
);

const SignalIcon: React.FC = () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
    </svg>
);

const ChevronRight: React.FC = () => (
    <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
);
