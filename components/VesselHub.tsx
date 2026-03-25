/**
 * VesselHub — Ship's Office & Active Watch dashboard.
 *
 * Premium glassmorphic vertical hierarchy:
 *   Section A: Active Watch Hero (Anchor + Passages) + Secondary (Guardian + Radio)
 *   Section B: Log Book slim strip
 *   Section C: Ship's Office vertical list (all office cards + crew + settings)
 */
import React, { useState, useEffect } from 'react';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { ChatService } from '../services/ChatService';
import { useSettings } from '../context/SettingsContext';
import { triggerHaptic } from '../utils/system';
import { supabase } from '../services/supabase';
import { getPendingInviteCount, getMyCrew } from '../services/CrewService';
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

// ── Glassmorphism constants ──
const GLASS = {
    card: {
        background: 'rgba(20, 25, 35, 0.6)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '16px',
    } as React.CSSProperties,
    listContainer: {
        background: 'rgba(20, 25, 35, 0.5)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '16px',
        overflow: 'hidden' as const,
    } as React.CSSProperties,
};

// ── Bathymetric contour background SVG ──
const CONTOUR_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cdefs%3E%3Cpattern id='c' patternUnits='userSpaceOnUse' width='100' height='100'%3E%3Cpath d='M50 10 C60 25,85 30,90 50 C95 70,75 85,50 90 C25 95,10 75,10 50 C10 25,30 5,50 10Z' fill='none' stroke='rgba(100,140,180,0.04)' stroke-width='0.5'/%3E%3Cpath d='M50 25 C55 35,70 38,75 50 C80 62,68 72,50 75 C32 78,22 65,22 50 C22 35,38 28,50 25Z' fill='none' stroke='rgba(100,140,180,0.03)' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23c)'/%3E%3C/svg%3E")`;

export const VesselHub: React.FC<VesselHubProps> = React.memo(({ onNavigate, settings, onSave: _onSave }) => {
    // ── Vessel state ──
    const { settings: ctx } = useSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isObserver = (ctx as any)?.vessel?.type === 'observer';

    // ── Anchor state ──
    const [anchorStatus, setAnchorStatus] = useState<'armed' | 'disarmed' | 'alarm'>('disarmed');
    const [anchorRadius, setAnchorRadius] = useState(0);
    const [showAdminPanel, setShowAdminPanel] = useState(false);
    const [_isAdmin, setIsAdmin] = useState(false);

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

    // ── Draft passage plans ──
    const [passageCrewCount, setPassageCrewCount] = useState(0);
    useEffect(() => {
        getMyCrew().then((c) => setPassageCrewCount(c.length));
    }, []);

    // ── Anchor display ──
    const anchorLabel =
        anchorStatus === 'alarm' ? '⚠️ DRAG ALARM' : anchorStatus === 'armed' ? `Armed — ${anchorRadius}m` : 'Disarmed';
    const anchorColor = anchorStatus === 'alarm' ? '#ef4444' : anchorStatus === 'armed' ? '#22d3ee' : '#9ca3af';

    return (
        <div
            className="w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar"
            style={{
                paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                backgroundImage: CONTOUR_BG,
                backgroundSize: '400px 400px',
            }}
        >
            {/* Scrollable content area */}
            <div className="flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pt-4">
                {/* ═══════════════════════════════════════════ */}
                {/* SECTION A: ACTIVE WATCH — Hero Card        */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionLabel color="#ef4444" label="Active Watch" />

                    {/* Hero card — Anchor + Passages side by side */}
                    <div style={GLASS.card} className="p-0 overflow-hidden mb-3">
                        <div className="flex">
                            {/* Left: Anchor Watch */}
                            <button
                                aria-label="Anchor Watch"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('compass');
                                }}
                                className="flex-1 p-4 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98] border-r border-white/[0.06]"
                            >
                                <div className="flex items-center gap-2.5 mb-2">
                                    <div
                                        className="w-2.5 h-2.5 rounded-full"
                                        style={{
                                            backgroundColor: anchorColor,
                                            boxShadow:
                                                anchorStatus !== 'disarmed' ? `0 0 8px ${anchorColor}60` : 'none',
                                            animation: anchorStatus === 'alarm' ? 'pulse 1s infinite' : 'none',
                                        }}
                                    />
                                    <span className="text-[13px] font-black text-white tracking-wide">
                                        Anchor Watch
                                    </span>
                                </div>
                                <p
                                    className="text-[11px] font-bold uppercase tracking-widest"
                                    style={{ color: anchorColor }}
                                >
                                    {anchorLabel}
                                </p>
                            </button>

                            {/* Right: Passages */}
                            <button
                                aria-label="Passages"
                                onClick={() => {
                                    if (isObserver) return;
                                    triggerHaptic('light');
                                    onNavigate('route');
                                }}
                                className={`flex-1 p-4 text-left transition-all active:scale-[0.98] ${
                                    isObserver ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.03]'
                                }`}
                            >
                                <div className="flex items-center gap-2.5 mb-2">
                                    <CompassIcon />
                                    <span className="text-[13px] font-black text-white tracking-wide">Passages</span>
                                </div>
                                <p
                                    className={`text-[11px] font-bold uppercase tracking-widest ${isObserver ? 'text-gray-500' : 'text-cyan-400'}`}
                                >
                                    {isObserver ? 'Vessel Required' : 'Route Plan'}
                                </p>
                            </button>
                        </div>
                    </div>

                    {/* Secondary row — Guardian + Radio */}
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            aria-label="Guardian"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('guardian');
                            }}
                            style={GLASS.card}
                            className="p-3.5 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-2.5">
                                <div className="p-2 rounded-lg" style={{ background: 'rgba(245, 158, 11, 0.12)' }}>
                                    <ShieldIcon color="#f59e0b" />
                                </div>
                                <div>
                                    <h4 className="text-[12px] font-black text-white tracking-wide">Guardian</h4>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mt-0.5">
                                        Bay Watch
                                    </p>
                                </div>
                            </div>
                        </button>

                        <button
                            aria-label="Report Position"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('radio');
                            }}
                            style={GLASS.card}
                            className="p-3.5 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-2.5">
                                <div className="p-2 rounded-lg" style={{ background: 'rgba(245, 158, 11, 0.12)' }}>
                                    <SignalIcon color="#f59e0b" />
                                </div>
                                <div>
                                    <h4 className="text-[12px] font-black text-white tracking-wide">Radio</h4>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mt-0.5">
                                        Report Pos
                                    </p>
                                </div>
                            </div>
                        </button>
                    </div>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SECTION B: LOG BOOK — Slim horizontal strip */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionLabel color="#0ea5e9" label="Log Book" />
                    <button
                        aria-label="Log Book"
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('details');
                        }}
                        style={GLASS.card}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-all active:scale-[0.98]"
                    >
                        <div className="p-2 rounded-lg" style={{ background: 'rgba(14, 165, 233, 0.12)' }}>
                            <BookIcon color="#0ea5e9" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <span className="text-[12px] font-black text-white tracking-wide">Voyage Entries</span>
                            <p className="text-[10px] text-gray-500 truncate mt-0.5 italic">
                                Tap to view or add entries
                            </p>
                        </div>
                        <div className="p-1.5 rounded-lg" style={{ background: 'rgba(14, 165, 233, 0.12)' }}>
                            <PlusIcon color="#0ea5e9" />
                        </div>
                    </button>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SECTION C: SHIP'S OFFICE — Vertical list   */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionLabel color="#0ea5e9" label="Ship's Office" />
                    <div style={GLASS.listContainer}>
                        <OfficeRow
                            icon={<PenIcon color="#0ea5e9" />}
                            label="Diary"
                            status="Captain's Notes"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('diary');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<SignalIcon color="#a855f7" />}
                            label="NMEA"
                            status="Network"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('nmea');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ChartIcon color="#22d3ee" />}
                            label="Polars"
                            status={isObserver ? 'Vessel Required' : 'Tuning'}
                            statusColor={isObserver ? '#6b7280' : '#9ca3af'}
                            onClick={() => {
                                if (isObserver) return;
                                triggerHaptic('light');
                                onNavigate('polars');
                            }}
                            disabled={isObserver}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<BoxIcon color="#f59e0b" />}
                            label="Ship's Stores"
                            status="Provisions & Spares"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('inventory');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ChecklistIcon color="#22d3ee" />}
                            label="Checklists"
                            status="Pre-Departure"
                            statusColor="#22d3ee"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('checklists');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<WrenchIcon color="#0ea5e9" />}
                            label="R&M"
                            status="Tasks & Expiry"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('maintenance');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ClipboardIcon color="#ef4444" />}
                            label="Equipment"
                            status="Register"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('equipment');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<DocShieldIcon color="#0ea5e9" />}
                            label="Documents"
                            status="Legal"
                            statusColor="#9ca3af"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('documents');
                            }}
                        />
                    </div>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SECTION D: CREW & ADMIN — Consolidated     */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-6">
                    <SectionLabel color="#8b5cf6" label="Crew & Admin" />
                    <div style={GLASS.listContainer}>
                        <OfficeRow
                            icon={<CrewIcon color="#8b5cf6" />}
                            label="Crew Management"
                            status={
                                passageCrewCount > 0
                                    ? `${passageCrewCount} crew`
                                    : pendingCrewInvites > 0
                                      ? `${pendingCrewInvites} Pending`
                                      : 'Invite Crew'
                            }
                            statusColor={pendingCrewInvites > 0 ? '#f59e0b' : '#8b5cf6'}
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('crew');
                            }}
                            badge={pendingCrewInvites > 0 ? pendingCrewInvites : undefined}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<UserIcon color="#9ca3af" />}
                            label="Account & Settings"
                            status={settings.isPro ? 'Thalassa PRO' : 'Free Plan'}
                            statusColor={settings.isPro ? '#22d3ee' : '#9ca3af'}
                            onClick={() => onNavigate('settings')}
                        />
                    </div>
                </div>
            </div>

            {/* Admin Panel Modal */}
            <AdminPanel isOpen={showAdminPanel} onClose={() => setShowAdminPanel(false)} />
        </div>
    );
});

// ══════════════════════════════════════
// ── Shared Components ──
// ══════════════════════════════════════

/** Section label with colored pip */
const SectionLabel: React.FC<{ color: string; label: string }> = ({ color, label }) => (
    <div className="flex items-center gap-2 mb-2.5">
        <div className="w-1 h-3.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color }}>
            {label}
        </span>
    </div>
);

/** Divider between list rows */
const ListDivider: React.FC = () => <div className="mx-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }} />;

/** Ship's Office list row */
const OfficeRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    status: string;
    statusColor: string;
    onClick: () => void;
    disabled?: boolean;
    badge?: number;
}> = ({ icon, label, status, statusColor, onClick, disabled, badge }) => (
    <button
        aria-label={label}
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all active:scale-[0.98] ${
            disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.03]'
        }`}
    >
        <div className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
            {icon}
        </div>
        <span className="flex-1 text-[12px] font-bold text-white tracking-wide">{label}</span>
        {badge !== undefined && (
            <span className="px-1.5 py-0.5 bg-amber-500/30 text-amber-300 text-[10px] font-bold rounded-full">
                {badge}
            </span>
        )}
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: statusColor }}>
            {status}
        </span>
        <ChevronRight />
    </button>
);

// ══════════════════════════════════════
// ── Icons (16x16) ──
// ══════════════════════════════════════

const ChevronRight: React.FC = () => (
    <svg
        className="w-3.5 h-3.5 text-gray-500 ml-1"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
);

const CompassIcon: React.FC = () => (
    <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
    </svg>
);

const ShieldIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

const SignalIcon: React.FC<{ color?: string }> = ({ color = 'currentColor' }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
        />
    </svg>
);

const BookIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
        />
    </svg>
);

const PlusIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);

const ChecklistIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
    </svg>
);

const PenIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
        />
    </svg>
);

const BoxIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
        />
    </svg>
);

const WrenchIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36"
        />
    </svg>
);

const ChartIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-1.5L12 12l3 1.5 3-3V6"
        />
    </svg>
);

const ClipboardIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
        />
    </svg>
);

const DocShieldIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

const CrewIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
    </svg>
);

const UserIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
        />
    </svg>
);
