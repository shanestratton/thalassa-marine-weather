/**
 * VesselHub — Ship's Office & Active Watch dashboard.
 *
 * Three-zone split screen:
 *   Zone 1: Active Watch (Anchor Watch + Log Book) — two compact cards
 *   Zone 2: Ship's Office Grid (8 cards in 4x2) — compact design
 *   Zone 3: App Administration (account, dark mode, terms)
 */
import React, { useState, useEffect } from 'react';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { ChatService } from '../services/ChatService';
import { useSettings } from '../context/SettingsContext';
import { triggerHaptic } from '../utils/system';
import { supabase } from '../services/supabase';
import { getPendingInviteCount } from '../services/CrewService';
import { lazyRetry } from '../utils/lazyRetry';
const AdminPanel = lazyRetry(
    () => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })),
    'AdminPanel_Vessel',
);

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

export const VesselHub: React.FC<VesselHubProps> = React.memo(({ onNavigate, settings, onSave: _onSave }) => {
    // ── Vessel state ──
    const { settings: ctx } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isObserver = (ctx as any)?.vessel?.type === 'observer';

    // ── Anchor state ──
    const [anchorStatus, setAnchorStatus] = useState<'armed' | 'disarmed' | 'alarm'>('disarmed');
    const [anchorRadius, setAnchorRadius] = useState(0);
    const [showAdminPanel, setShowAdminPanel] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);

    // Load admin role async
    useEffect(() => {
        ChatService.initialize()
            .then(() => {
                setIsAdmin(ChatService.isAdmin());
            })
            .catch(() => {
                // Non-critical — admin check is best-effort
            });
    }, []);

    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snapshot) => {
            setAnchorRadius(snapshot.swingRadius || 0);
            setAnchorStatus(
                snapshot.state === 'alarm' ? 'alarm' : snapshot.state === 'watching' ? 'armed' : 'disarmed',
            );
        });
        return unsub;
    }, []);

    // ── Crew invite badge ──
    const [pendingCrewInvites, setPendingCrewInvites] = useState(0);
    useEffect(() => {
        if (!supabase) return;
        supabase.auth.getUser().then(({ data }) => {
            if (data.user) {
                getPendingInviteCount().then(setPendingCrewInvites);
            }
        });
    }, []);

    const anchorSublabel =
        anchorStatus === 'alarm' ? '⚠️ DRAG ALARM' : anchorStatus === 'armed' ? `Armed — ${anchorRadius}m` : 'Disarmed';
    const anchorAccent =
        anchorStatus === 'alarm'
            ? { color: 'text-red-400', bg: 'from-red-500/25 to-red-600/25 border-red-500/30' }
            : anchorStatus === 'armed'
              ? { color: 'text-emerald-400', bg: 'from-emerald-500/20 to-emerald-500/20 border-emerald-500/20' }
              : { color: 'text-red-400', bg: 'from-red-500/15 to-amber-500/15 border-red-500/20' };

    // Zone 2 cards — now 8 cards in compact 4x2 grid
    const officeCards: OfficeCard[] = [
        {
            id: 'checklists',
            label: 'Checklists',
            sublabel: 'Pre-Departure',
            icon: <ChecklistIcon />,
            page: 'checklists',
            accentColor: 'text-emerald-400',
            accentBg: 'from-emerald-500/20 to-sky-500/20 border-emerald-500/20',
        },
        {
            id: 'diary',
            label: 'Diary',
            sublabel: "Captain's Notes",
            icon: <PenIcon />,
            page: 'diary',
            accentColor: 'text-sky-400',
            accentBg: 'from-sky-500/20 to-purple-500/20 border-sky-500/20',
        },
        {
            id: 'inventory',
            label: 'Inventory',
            sublabel: 'Spares & Supplies',
            icon: <BoxIcon />,
            page: 'inventory',
            accentColor: 'text-amber-400',
            accentBg: 'from-amber-500/20 to-amber-500/20 border-amber-500/20',
        },
        {
            id: 'maintenance',
            label: 'R&M',
            sublabel: 'Tasks & Expiry',
            icon: <WrenchIcon />,
            page: 'maintenance',
            accentColor: 'text-sky-400',
            accentBg: 'from-sky-500/20 to-sky-500/20 border-sky-500/20',
        },
        {
            id: 'polars',
            label: 'Polars',
            sublabel: 'Tuning',
            icon: <ChartIcon />,
            page: 'polars',
            accentColor: 'text-emerald-400',
            accentBg: 'from-emerald-500/20 to-emerald-500/20 border-emerald-500/20',
        },
        {
            id: 'nmea',
            label: 'NMEA',
            sublabel: 'Network',
            icon: <SignalIcon />,
            page: 'nmea',
            accentColor: 'text-purple-400',
            accentBg: 'from-purple-500/20 to-purple-500/20 border-purple-500/20',
        },
        {
            id: 'equipment',
            label: 'Equipment',
            sublabel: 'Register',
            icon: <ClipboardIcon />,
            page: 'equipment',
            accentColor: 'text-red-400',
            accentBg: 'from-red-500/20 to-red-500/20 border-red-500/20',
        },
        {
            id: 'documents',
            label: 'Documents',
            sublabel: 'Legal',
            icon: <ShieldIcon />,
            page: 'documents',
            accentColor: 'text-sky-400',
            accentBg: 'from-sky-500/20 to-sky-500/20 border-sky-500/20',
        },
    ];

    return (
        <div
            className="w-full h-full flex flex-col px-4 pt-4 overflow-y-auto animate-in fade-in duration-300 vessel-hub-no-scrollbar"
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
        >
            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 1: ACTIVE WATCH — Two compact cards */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-red-500" />
                    <span className="text-[11px] font-black text-red-400 uppercase tracking-[0.2em]">Active Watch</span>
                </div>

                <div className="grid grid-cols-4 gap-3 stagger-cascade">
                    {/* Anchor Watch Card */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('compass');
                        }}
                        className={`stagger-item bg-gradient-to-br ${anchorAccent.bg} border rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.98]`}
                    >
                        <div className="p-1.5 rounded-lg bg-white/5 inline-block mb-1.5 group-hover:bg-white/10 transition-colors">
                            <svg
                                className={`w-4 h-4 ${anchorAccent.color}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 2L12 5M12 5C9.79 5 8 6.79 8 9V12L12 16L16 12V9C16 6.79 14.21 5 12 5ZM8 19H16M10 19V21M14 19V21M5 12H3M21 12H19"
                                />
                            </svg>
                        </div>
                        <h4 className="text-[11px] font-black text-white tracking-wide leading-tight">Anchor Watch</h4>
                        <p
                            className={`text-[11px] font-bold uppercase tracking-widest mt-0.5 ${anchorAccent.color} truncate`}
                        >
                            {anchorSublabel}
                        </p>
                    </button>

                    {/* 🛡️ Guardian Card — Maritime Neighborhood Watch */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('guardian');
                        }}
                        className="stagger-item bg-gradient-to-br from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.98]"
                    >
                        <div className="p-1.5 rounded-lg bg-white/5 inline-block mb-1.5 group-hover:bg-white/10 transition-colors">
                            <svg
                                className="w-4 h-4 text-amber-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                                />
                            </svg>
                        </div>
                        <h4 className="text-[11px] font-black text-white tracking-wide leading-tight">Guardian</h4>
                        <p className="text-[11px] text-amber-400 font-bold uppercase tracking-widest mt-0.5">
                            Bay Watch
                        </p>
                    </button>

                    {/* Passage Planning Card */}
                    <button
                        onClick={() => {
                            if (isObserver) return;
                            triggerHaptic('light');
                            onNavigate('route');
                        }}
                        className={`stagger-item bg-gradient-to-br ${isObserver ? 'from-slate-800/40 to-slate-800/40 border-white/5 opacity-40 cursor-not-allowed' : 'from-emerald-500/15 to-emerald-500/15 border-emerald-500/20 hover:scale-[1.02]'} border rounded-xl p-3 text-left group transition-all active:scale-[0.98]`}
                    >
                        <div className="p-1.5 rounded-lg bg-white/5 inline-block mb-1.5 group-hover:bg-white/10 transition-colors">
                            <div className="text-emerald-400">
                                <CompassIcon />
                            </div>
                        </div>
                        <h4 className="text-[11px] font-black text-white tracking-wide leading-tight">Passages</h4>
                        <p
                            className={`text-[11px] font-bold uppercase tracking-widest mt-0.5 ${isObserver ? 'text-gray-400' : 'text-emerald-400'}`}
                        >
                            {isObserver ? 'Vessel Required' : 'Route Plan'}
                        </p>
                    </button>

                    {/* Log Book Card */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('details');
                        }}
                        className="stagger-item bg-gradient-to-br from-sky-500/15 to-sky-500/15 border border-sky-500/20 rounded-xl p-3 text-left group hover:scale-[1.02] transition-all active:scale-[0.98]"
                    >
                        <div className="p-1.5 rounded-lg bg-white/5 inline-block mb-1.5 group-hover:bg-white/10 transition-colors">
                            <svg
                                className="w-4 h-4 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                                />
                            </svg>
                        </div>
                        <h4 className="text-[11px] font-black text-white tracking-wide leading-tight">Log Book</h4>
                        <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">
                            Voyage Entries
                        </p>
                    </button>
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 2: SHIP'S OFFICE — 4x2 compact grid */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-sky-500" />
                    <span className="text-[11px] font-black text-sky-400 uppercase tracking-[0.2em]">
                        Ship&apos;s Office
                    </span>
                </div>

                <div className="grid grid-cols-4 gap-3 stagger-cascade">
                    {officeCards.map((card) => {
                        const disabled = card.id === 'polars' && isObserver;
                        return (
                            <button
                                key={card.id}
                                onClick={() => {
                                    if (disabled) return;
                                    triggerHaptic('light');
                                    onNavigate(card.page);
                                }}
                                className={`stagger-item bg-gradient-to-br ${disabled ? 'from-slate-800/40 to-slate-800/40 border-white/5 opacity-40 cursor-not-allowed' : `${card.accentBg}`} border rounded-xl p-3 text-left group ${disabled ? '' : 'hover:scale-[1.03]'} transition-all active:scale-[0.97]`}
                            >
                                <div className="p-1.5 rounded-lg bg-white/5 inline-block mb-2 group-hover:bg-white/10 transition-colors">
                                    <div className={`${card.accentColor}`}>{card.icon}</div>
                                </div>
                                <h4 className="text-[11px] font-black text-white tracking-wide leading-tight">
                                    {card.label}
                                </h4>
                                <p
                                    className={`text-[11px] font-bold uppercase tracking-widest mt-1 ${disabled ? 'text-gray-400' : card.accentColor}`}
                                >
                                    {disabled ? 'Vessel Required' : card.sublabel}
                                </p>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 2.5: CREW SHARING */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-violet-500" />
                    <span className="text-[11px] font-black text-violet-400 uppercase tracking-[0.2em]">Crew</span>
                    {pendingCrewInvites > 0 && (
                        <span className="px-1.5 py-0.5 bg-amber-500/30 text-amber-300 text-[11px] font-bold rounded-full animate-pulse">
                            {pendingCrewInvites} invite{pendingCrewInvites !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>

                <button
                    onClick={() => {
                        triggerHaptic('light');
                        onNavigate('crew');
                    }}
                    className="w-full bg-gradient-to-br from-violet-500/15 to-fuchsia-500/15 border border-violet-500/20 rounded-xl p-4 text-left group hover:scale-[1.02] transition-all active:scale-[0.98] flex items-center gap-3"
                >
                    <div className="p-2 rounded-lg bg-white/5 group-hover:bg-white/10 transition-colors relative">
                        <svg
                            className="w-4 h-4 text-violet-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
                            />
                        </svg>
                        {pendingCrewInvites > 0 && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-amber-500 rounded-full border-2 border-[#0f172a]" />
                        )}
                    </div>
                    <div className="flex-1">
                        <h4 className="text-xs font-black text-white tracking-wide">Crew Sharing</h4>
                        <p className="text-[11px] font-bold uppercase tracking-widest mt-0.5 text-violet-400">
                            {pendingCrewInvites > 0 ? `${pendingCrewInvites} Pending` : 'Manage Access'}
                        </p>
                    </div>
                    <ChevronRight />
                </button>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ZONE 3: APP ADMINISTRATION */}
            {/* ═══════════════════════════════════════════ */}
            <div className="mt-2">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-gray-500" />
                    <span className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em]">
                        Administration
                    </span>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden divide-y divide-white/[0.06]">
                    {/* Account & Subscription */}
                    <button
                        onClick={() => onNavigate('settings')}
                        className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98]"
                    >
                        <div className="p-1.5 bg-white/5 rounded-lg">
                            <svg
                                className="w-4 h-4 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-white">Account, Subscription & Settings</p>
                            <p className="text-[11px] text-gray-400">{settings.isPro ? 'Thalassa PRO' : 'Free Plan'}</p>
                        </div>
                        <ChevronRight />
                    </button>
                </div>
            </div>

            {/* Admin Panel Modal */}
            <AdminPanel isOpen={showAdminPanel} onClose={() => setShowAdminPanel(false)} />
        </div>
    );
});

// ── Zone Icons (compact: w-4 h-4) ──

const BoxIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
        />
    </svg>
);

const WrenchIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36"
        />
    </svg>
);

const ChartIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-1.5L12 12l3 1.5 3-3V6"
        />
    </svg>
);

const SignalIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
        />
    </svg>
);

const ChevronRight: React.FC = () => (
    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
);

const ClipboardIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
        />
    </svg>
);

const ShieldIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

const CompassIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
    </svg>
);

const PenIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
        />
    </svg>
);

const ChecklistIcon: React.FC = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
    </svg>
);
