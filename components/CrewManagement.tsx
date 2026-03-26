/**
 * CrewManagement — Full crew sharing management page.
 *
 * Two sections:
 *   1. My Crew (Captain view): Invite, manage permissions, remove crew
 *   2. Shared With Me (Crew view): Pending invites, active memberships, leave
 *
 * Swipe-to-delete with 5s undo on both crew cards and membership cards.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { t } from '../theme';
import { ModalSheet } from './ui/ModalSheet';
import { UndoToast } from './ui/UndoToast';

import {
    type SharedRegister,
    type CrewMember,
    ALL_REGISTERS,
    VESSEL_REGISTERS,
    PASSAGE_REGISTERS,
    REGISTER_LABELS,
    REGISTER_ICONS,
    inviteCrew,
    getMyCrew,
    removeCrew,
    disbandGroup,
    updateCrewPermissions,
    getMyInvites,
    getMyMemberships,
    acceptInvite,
    declineInvite,
    leaveVessel,
} from '../services/CrewService';
import { supabase } from '../services/supabase';
import { triggerHaptic } from '../utils/system';
import { toast } from './Toast';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';
import { getDraftVoyages, updateVoyage, type Voyage } from '../services/VoyageService';
import { getCrewCount } from '../services/MealPlanService';
import { setActivePassage, getActivePassageId } from '../services/PassagePlanService';
import { AuthModal } from './AuthModal';
import { lazyRetry } from '../utils/lazyRetry';
const CastOffPanel = lazyRetry(
    () => import('./vessel/CastOffPanel').then((m) => ({ default: m.CastOffPanel })),
    'CastOffPanel_Crew',
);

interface CrewManagementProps {
    onBack: () => void;
}

// ── SwipeableCrewCard — extracted to crew/SwipeableCrewCard.tsx ──
import { SwipeableCrewCard } from './crew/SwipeableCrewCard';

// ── Main Component ─────────────────────────────────────────────

export const CrewManagement: React.FC<CrewManagementProps> = React.memo(({ onBack }) => {
    const [isAuthed, setIsAuthed] = useState(false);

    // Captain state
    const [myCrew, setMyCrew] = useState<CrewMember[]>([]);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRegisters, setInviteRegisters] = useState<SharedRegister[]>([]);
    const [inviteLoading, setInviteLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [inviteSuccess, setInviteSuccess] = useState(false);

    // Crew state
    const [pendingInvites, setPendingInvites] = useState<CrewMember[]>([]);
    const [memberships, setMemberships] = useState<CrewMember[]>([]);

    // Edit permissions modal
    const [editTarget, setEditTarget] = useState<CrewMember | null>(null);
    const [editRegisters, setEditRegisters] = useState<SharedRegister[]>([]);

    // Loading
    const [loading, setLoading] = useState(true);

    // ── Soft-delete with undo ──
    const [deletedMember, setDeletedMember] = useState<{ member: CrewMember; mode: 'captain' | 'crew' } | null>(null);

    // Auth modal for sign-in from this page
    const [showAuth, setShowAuth] = useState(false);

    // Cast Off state
    const [showCastOff, setShowCastOff] = useState(false);
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(null);

    // Draft passage plans (moved from Welcome Aboard)
    const [draftVoyages, setDraftVoyages] = useState<Voyage[]>([]);
    const [selectedPassageId, setSelectedPassageId] = useState<string>(getActivePassageId() || '');

    // Disband group
    const [showDisbandConfirm, setShowDisbandConfirm] = useState(false);
    const [disbandConfirmText, setDisbandConfirmText] = useState('');
    const [disbanding, setDisbanding] = useState(false);

    // Planning panel state
    const [showPlanning, setShowPlanning] = useState(false);
    const [planDeparture, setPlanDeparture] = useState('');
    const [planEta, setPlanEta] = useState('');
    const [planDeparturePort, setPlanDeparturePort] = useState('');
    const [planDestPort, setPlanDestPort] = useState('');
    const [planNotes, setPlanNotes] = useState('');
    const [planCrewCount, setPlanCrewCount] = useState(() => {
        const stored = localStorage.getItem('thalassa_crew_count');
        return stored ? parseInt(stored) || 2 : 2;
    });
    const [savingPlan, setSavingPlan] = useState(false);

    // Listen for crew count changes from other components (e.g. meal planner stepper)
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (typeof detail === 'number') setPlanCrewCount(detail);
        };
        window.addEventListener('thalassa:crew-changed', handler);
        return () => window.removeEventListener('thalassa:crew-changed', handler);
    }, []);

    // Check auth + get user email
    const [userEmail, setUserEmail] = useState<string | null>(null);
    useEffect(() => {
        if (!supabase) return;
        supabase.auth.getUser().then(({ data }) => {
            setIsAuthed(!!data.user);
            setUserEmail(data.user?.email || null);
        });
    }, []);

    // Load data
    const loadData = useCallback(async () => {
        setLoading(true);
        const [crew, invites, ships] = await Promise.all([getMyCrew(), getMyInvites(), getMyMemberships()]);
        setMyCrew(crew);
        setPendingInvites(invites);
        setMemberships(ships);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isAuthed) loadData();
    }, [isAuthed, loadData]);

    // Load voyage status + draft voyages
    useEffect(() => {
        import('../services/VoyageService').then(({ getCachedActiveVoyage }) => {
            const v = getCachedActiveVoyage();
            if (v) setActiveVoyageName(v.voyage_name);
        });
        getDraftVoyages().then(setDraftVoyages);
    }, []);

    // ── Handlers ──

    const handleInvite = async () => {
        if (!inviteEmail.trim() || inviteRegisters.length === 0) return;
        setInviteLoading(true);
        setInviteError(null);
        setInviteSuccess(false);

        const result = await inviteCrew(inviteEmail, inviteRegisters);

        if (result.success) {
            setInviteSuccess(true);
            triggerHaptic('medium');
            setTimeout(() => {
                setShowInviteModal(false);
                setInviteEmail('');
                setInviteRegisters([]);
                setInviteSuccess(false);
                loadData();
            }, 1200);
        } else {
            setInviteError(result.error || 'Failed to send invite');
            triggerHaptic('heavy');
        }
        setInviteLoading(false);
    };

    // Soft-delete: Remove from UI immediately, UndoToast owns the 5s countdown
    const handleSoftDelete = (member: CrewMember, mode: 'captain' | 'crew') => {
        triggerHaptic('medium');

        // Remove from UI optimistically
        if (mode === 'captain') {
            setMyCrew((prev) => prev.filter((m) => m.id !== member.id));
        } else {
            setMemberships((prev) => prev.filter((m) => m.id !== member.id));
        }

        setDeletedMember({ member, mode });
    };

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDelete = async () => {
        if (!deletedMember) return;
        const { member, mode } = deletedMember;
        setDeletedMember(null);
        try {
            if (mode === 'captain') {
                await removeCrew(member.id);
            } else {
                await leaveVessel(member.id);
            }
        } catch (e) {
            toast.error(mode === 'captain' ? 'Failed to remove crew' : 'Failed to leave vessel');
            // Restore on failure
            if (mode === 'captain') {
                setMyCrew((prev) => [...prev, member]);
            } else {
                setMemberships((prev) => [...prev, member]);
            }
        }
    };

    // ── Disband Group ──
    const handleDisbandGroup = async () => {
        setDisbanding(true);
        const result = await disbandGroup();
        setDisbanding(false);
        setShowDisbandConfirm(false);
        setDisbandConfirmText('');

        if (result.success) {
            triggerHaptic('heavy');
            toast.success(
                `Group disbanded — ${result.removedCount} member${result.removedCount !== 1 ? 's' : ''} removed`,
            );
            setMyCrew([]);
        } else {
            toast.error('Failed to disband group');
        }
    };

    const handleUndoDelete = () => {
        if (deletedMember) {
            if (deletedMember.mode === 'captain') {
                setMyCrew((prev) => [...prev, deletedMember.member]);
            } else {
                setMemberships((prev) => [...prev, deletedMember.member]);
            }
            toast.success('Restored');
        }
        setDeletedMember(null);
    };

    const handleAccept = async (invite: CrewMember) => {
        triggerHaptic('medium');
        const ok = await acceptInvite(invite.id);
        if (ok) {
            toast.success('Invite accepted!');
            loadData();
        }
    };

    const handleDecline = async (invite: CrewMember) => {
        triggerHaptic('light');
        const ok = await declineInvite(invite.id);
        if (ok) loadData();
    };

    const handleSavePermissions = async () => {
        if (!editTarget) return;
        const ok = await updateCrewPermissions(editTarget.id, editRegisters);
        if (ok) {
            setEditTarget(null);
            toast.success('Permissions updated');
            loadData();
        }
    };

    const toggleRegister = (
        register: SharedRegister,
        list: SharedRegister[],
        setList: (v: SharedRegister[]) => void,
    ) => {
        if (list.includes(register)) {
            setList(list.filter((r) => r !== register));
        } else {
            setList([...list, register]);
        }
    };

    // ── Planning Panel ──
    const openPlanning = useCallback(() => {
        const v = draftVoyages.find((d) => d.id === selectedPassageId);
        if (!v) return;
        setPlanDeparture(v.departure_time ? v.departure_time.slice(0, 16) : '');
        setPlanEta(v.eta ? v.eta.slice(0, 16) : '');
        setPlanDeparturePort(v.departure_port || '');
        setPlanDestPort(v.destination_port || '');
        setPlanNotes(v.notes || '');
        setShowPlanning(true);
        // Load crew count — read from shared localStorage first, Supabase as fallback
        const storedCrew = localStorage.getItem('thalassa_crew_count');
        if (storedCrew) {
            setPlanCrewCount(parseInt(storedCrew) || 2);
        } else {
            getCrewCount(v.id).then((count) => {
                setPlanCrewCount(count);
                localStorage.setItem('thalassa_crew_count', String(count));
            }).catch(() => setPlanCrewCount(2));
        }
        triggerHaptic('light');
    }, [draftVoyages, selectedPassageId]);

    const handleSavePlan = useCallback(async () => {
        if (!selectedPassageId) return;
        setSavingPlan(true);
        const result = await updateVoyage(selectedPassageId, {
            departure_time: planDeparture ? new Date(planDeparture).toISOString() : null,
            eta: planEta ? new Date(planEta).toISOString() : null,
            departure_port: planDeparturePort.trim() || null,
            destination_port: planDestPort.trim() || null,
            notes: planNotes.trim() || null,
        });
        setSavingPlan(false);
        if (result.voyage) {
            // Update local draft list with new values
            setDraftVoyages((prev) =>
                prev.map((v) => (v.id === selectedPassageId ? result.voyage! : v)),
            );
            toast.success('Passage updated');
            triggerHaptic('medium');
            setShowPlanning(false);
        } else {
            toast.error(result.error || 'Failed to save');
        }
    }, [selectedPassageId, planDeparture, planEta, planDeparturePort, planDestPort, planNotes]);

    // Filter out declined invites older than 7 days
    const visibleCrew = myCrew.filter((m) => {
        if (m.status !== 'declined') return true;
        const declinedAge = Date.now() - new Date(m.updated_at).getTime();
        return declinedAge < 7 * 24 * 60 * 60 * 1000; // 7 days
    });

    // ── Not authenticated ──
    if (!isAuthed) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <div className="shrink-0 px-4 pt-4 pb-3 flex items-center gap-2">
                    <button
                        aria-label="Go back"
                        onClick={onBack}
                        className="p-1.5 -ml-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Crew</h1>
                </div>
                <div className="flex-1 flex items-center justify-center p-8">
                    <div className="text-center">
                        <div className="text-4xl mb-4">👥</div>
                        <h2 className="text-lg font-bold text-white mb-2">Sign In Required</h2>
                        <p className="text-sm text-gray-400 max-w-xs mb-6">
                            Sign in to share your vessel registers with crew members.
                        </p>
                        <button
                            onClick={() => setShowAuth(true)}
                            className="px-6 py-3 bg-white text-slate-900 font-bold rounded-xl shadow-lg hover:bg-gray-100 transition-all active:scale-95"
                        >
                            Sign In
                        </button>
                    </div>
                </div>
                <AuthModal
                    isOpen={showAuth}
                    onClose={() => {
                        setShowAuth(false);
                        // Re-check auth after modal closes
                        if (supabase) {
                            supabase.auth.getUser().then(({ data }) => {
                                setIsAuthed(!!data.user);
                                setUserEmail(data.user?.email || null);
                            });
                        }
                    }}
                />
            </div>
        );
    }

    const isEmpty = visibleCrew.length === 0 && memberships.length === 0 && pendingInvites.length === 0;

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`}>
            {/* Header */}
            <div className="shrink-0 px-4 pt-4 pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button
                            aria-label="Go back"
                            onClick={onBack}
                            className="p-1.5 -ml-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Crew</h1>
                    </div>
                    <button
                        aria-label="Invite"
                        onClick={() => {
                            setShowInviteModal(true);
                            setInviteError(null);
                            setInviteSuccess(false);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 transition-colors"
                    >
                        + Invite
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-24" style={{ WebkitOverflowScrolling: 'touch' }}>
                {/* User's email — for sharing with potential crew */}
                {userEmail && (
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 mb-4 flex items-center justify-between">
                        <div>
                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                                Your Email (share for invites)
                            </p>
                            <p className="text-sm font-bold text-white mt-0.5">{userEmail}</p>
                        </div>
                        <button
                            aria-label="Text"
                            onClick={() => {
                                navigator.clipboard
                                    ?.writeText(userEmail)
                                    .then(() => {
                                        toast.success('Email copied!');
                                        triggerHaptic('light');
                                    })
                                    .catch(() => toast.error('Could not copy'));
                            }}
                            className="px-3 py-1.5 bg-sky-500/10 border border-sky-500/20 rounded-lg text-[11px] font-bold text-sky-300 active:scale-95 transition-transform"
                        >
                            📋 Copy
                        </button>
                    </div>
                )}

                {/* ── ACTIVE PASSAGE SELECTOR ── */}
                <div className="mb-4">
                    <label className="text-[10px] uppercase font-bold text-violet-400/60 tracking-wider mb-1.5 block">
                        🧭 Active Passage
                    </label>
                    {draftVoyages.length > 0 ? (
                        <select
                            value={selectedPassageId}
                            onChange={(e) => {
                                const id = e.target.value;
                                setSelectedPassageId(id);
                                if (id) {
                                    setActivePassage(id);
                                    triggerHaptic('light');
                                    // Update voyage name display
                                    const v = draftVoyages.find(v => v.id === id);
                                    if (v) setActiveVoyageName(v.voyage_name || `${v.departure_port || '?'} → ${v.destination_port || '?'}`);
                                } else {
                                    setActiveVoyageName(null);
                                }
                            }}
                            className="w-full bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/40 appearance-none cursor-pointer"
                            style={{
                                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23a78bfa'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: 'right 0.75rem center',
                                backgroundSize: '1rem',
                            }}
                        >
                            <option value="" style={{ background: '#1e293b' }}>
                                Select a passage…
                            </option>
                            {draftVoyages.map((v) => (
                                <option key={v.id} value={v.id} style={{ background: '#1e293b' }}>
                                    {v.voyage_name ||
                                        `${v.departure_port || '?'} → ${v.destination_port || '?'}`}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-lg p-3 text-center">
                            <p className="text-[11px] text-gray-400">
                                No draft passages yet. Plan a route from the <strong>Route Planner</strong> to create one.
                            </p>
                        </div>
                    )}
                </div>

                {/* ── PLANNING + CAST OFF BUTTONS ── */}
                {selectedPassageId && (
                    <div className="mb-4 space-y-2">
                        <div className="flex gap-2">
                            <button
                                onClick={openPlanning}
                                className={`flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${
                                    showPlanning
                                        ? 'bg-violet-500/15 border border-violet-500/30 text-violet-300'
                                        : 'bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:bg-white/[0.06] hover:text-white'
                                }`}
                            >
                                🧭 Planning
                            </button>
                            <button
                                onClick={() => {
                                    setShowCastOff(true);
                                    triggerHaptic('medium');
                                }}
                                disabled={!draftVoyages.find((v) => v.id === selectedPassageId)?.departure_time}
                                className="flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-amber-300 transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed hover:from-amber-500/20 hover:to-orange-500/20 flex items-center justify-center gap-1.5"
                            >
                                ⚓ Cast Off
                            </button>
                        </div>

                        {/* ── PLANNING PANEL ── */}
                        {showPlanning && (
                            <div className="bg-white/[0.02] border border-violet-500/15 rounded-xl p-4 space-y-3 animate-in slide-in-from-top-2 duration-200">
                                {/* Crew count badge (read-only) */}
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-black text-violet-400/60 uppercase tracking-widest">
                                        Passage Details
                                    </span>
                                    <span className="px-2.5 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-[10px] font-bold text-sky-400">
                                        👥 {planCrewCount} crew
                                    </span>
                                </div>

                                {/* Departure + ETA */}
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="min-w-0">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                                            Departure
                                        </label>
                                        <input
                                            type="date"
                                            value={planDeparture ? planDeparture.slice(0, 10) : ''}
                                            onChange={(e) => setPlanDeparture(e.target.value ? e.target.value + 'T08:00' : '')}
                                            onFocus={scrollInputAboveKeyboard}
                                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-[11px] text-white focus:outline-none focus:border-violet-500/40 [color-scheme:dark]"
                                        />
                                    </div>
                                    <div className="min-w-0">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                                            ETA
                                        </label>
                                        <input
                                            type="date"
                                            value={planEta ? planEta.slice(0, 10) : ''}
                                            onChange={(e) => setPlanEta(e.target.value ? e.target.value + 'T18:00' : '')}
                                            onFocus={scrollInputAboveKeyboard}
                                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-[11px] text-white focus:outline-none focus:border-violet-500/40 [color-scheme:dark]"
                                        />
                                    </div>
                                </div>

                                {/* Ports */}
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                                            From
                                        </label>
                                        <input
                                            type="text"
                                            value={planDeparturePort}
                                            onChange={(e) => setPlanDeparturePort(e.target.value)}
                                            onFocus={scrollInputAboveKeyboard}
                                            placeholder="Departure port"
                                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                                            To
                                        </label>
                                        <input
                                            type="text"
                                            value={planDestPort}
                                            onChange={(e) => setPlanDestPort(e.target.value)}
                                            onFocus={scrollInputAboveKeyboard}
                                            placeholder="Destination"
                                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40"
                                        />
                                    </div>
                                </div>

                                {/* Notes */}
                                <div>
                                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                                        Notes
                                    </label>
                                    <textarea
                                        value={planNotes}
                                        onChange={(e) => setPlanNotes(e.target.value)}
                                        onFocus={scrollInputAboveKeyboard}
                                        placeholder="Weather windows, tidal constraints, fuel stops…"
                                        rows={2}
                                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40 resize-none"
                                    />
                                </div>

                                {/* Readiness indicators */}
                                {planDeparture && planEta && (
                                    <div className="flex gap-2 text-[10px]">
                                        <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-emerald-400 font-bold">
                                            ✅ Dates set
                                        </span>
                                        <span className={`px-2 py-1 rounded-lg font-bold ${
                                            planCrewCount > 1
                                                ? 'bg-emerald-500/10 border border-emerald-500/15 text-emerald-400'
                                                : 'bg-amber-500/10 border border-amber-500/15 text-amber-400'
                                        }`}>
                                            {planCrewCount > 1 ? '✅' : '⚠️'} {planCrewCount} crew
                                        </span>
                                    </div>
                                )}

                                {/* Save + Cancel */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={handleSavePlan}
                                        disabled={savingPlan}
                                        className="flex-1 py-2.5 bg-violet-500/15 border border-violet-500/25 rounded-xl text-[11px] font-bold text-violet-300 uppercase tracking-widest hover:bg-violet-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
                                    >
                                        {savingPlan ? '⏳ Saving…' : '💾 Save'}
                                    </button>
                                    <button
                                        onClick={() => setShowPlanning(false)}
                                        className="px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-xl text-[11px] font-bold text-gray-400 hover:text-white transition-colors"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : (
                    <>
                        {/* ── How It Works — shown at TOP when empty ── */}
                        {isEmpty && (
                            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 mb-6">
                                <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3">
                                    How Crew Sharing Works
                                </h3>
                                <div className="space-y-2.5">
                                    {[
                                        { icon: '📧', text: "Tap + Invite and enter your crew's email address" },
                                        {
                                            icon: '🔐',
                                            text: 'Choose which registers to share (Inventory, Equipment, R&M, Documents)',
                                        },
                                        {
                                            icon: '✅',
                                            text: "They'll see the invite in their Thalassa app and accept it",
                                        },
                                        { icon: '✏️', text: 'Once accepted, their edits go directly to your data' },
                                        { icon: '👈', text: 'Swipe left on any crew card to remove access' },
                                    ].map((step, i) => (
                                        <div key={i} className="flex items-center gap-2.5">
                                            <span className="text-sm">{step.icon}</span>
                                            <p className="text-[11px] text-gray-400">{step.text}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── PENDING INVITES (Crew view) ── */}
                        {pendingInvites.length > 0 && (
                            <div className="mb-6">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="w-1 h-4 rounded-full bg-amber-500" />
                                    <span className="text-[11px] font-black text-amber-400 uppercase tracking-[0.2em]">
                                        Pending Invites
                                    </span>
                                    <span className="ml-auto px-2 py-0.5 bg-amber-500/20 text-amber-400 text-[11px] font-bold rounded-full">
                                        {pendingInvites.length}
                                    </span>
                                </div>

                                <div className="space-y-2">
                                    {pendingInvites.map((invite) => (
                                        <div
                                            key={invite.id}
                                            className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4"
                                        >
                                            <div className="flex items-start justify-between mb-3">
                                                <div>
                                                    <p className="text-sm font-bold text-white">{invite.owner_email}</p>
                                                    <p className="text-[11px] text-gray-400 mt-0.5">
                                                        wants to share registers with you
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Shared registers */}
                                            <div className="flex flex-wrap gap-1.5 mb-3">
                                                {invite.shared_registers.map((reg) => (
                                                    <span
                                                        key={reg}
                                                        className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-[11px] font-bold text-gray-300"
                                                    >
                                                        {REGISTER_ICONS[reg]} {REGISTER_LABELS[reg]}
                                                    </span>
                                                ))}
                                            </div>

                                            {/* Actions */}
                                            <div className="flex gap-2">
                                                <button
                                                    aria-label="Accept"
                                                    onClick={() => handleAccept(invite)}
                                                    className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors active:scale-95"
                                                >
                                                    Accept
                                                </button>
                                                <button
                                                    aria-label="Decline"
                                                    onClick={() => handleDecline(invite)}
                                                    className="flex-1 py-2 bg-white/5 hover:bg-white/10 text-gray-400 text-xs font-bold rounded-lg transition-colors active:scale-95"
                                                >
                                                    Decline
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── SHARED WITH ME (Crew view) — swipe to leave ── */}
                        {memberships.length > 0 && (
                            <div className="mb-6">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="w-1 h-4 rounded-full bg-emerald-500" />
                                    <span className="text-[11px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                                        Shared with Me
                                    </span>
                                </div>

                                <div className="space-y-2">
                                    {memberships.map((membership) => (
                                        <SwipeableCrewCard
                                            key={membership.id}
                                            member={membership}
                                            mode="crew"
                                            onDelete={() => handleSoftDelete(membership, 'crew')}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── MY CREW (Captain view) — swipe to remove ── */}
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <div className="w-1 h-4 rounded-full bg-sky-500" />
                                <span className="text-[11px] font-black text-sky-400 uppercase tracking-[0.2em]">
                                    My Crew
                                </span>
                                {visibleCrew.length > 0 && (
                                    <span className="ml-auto px-2 py-0.5 bg-sky-500/20 text-sky-400 text-[11px] font-bold rounded-full">
                                        {visibleCrew.length}
                                    </span>
                                )}
                            </div>

                            {visibleCrew.length === 0 ? (
                                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                                    <div className="text-3xl mb-3">👥</div>
                                    <p className="text-sm font-bold text-white mb-1">No Crew Yet</p>
                                    <p className="text-[11px] text-gray-400 max-w-xs mx-auto">
                                        Invite crew members to share Inventory, Equipment, R&M and Documents registers.
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {visibleCrew.map((member) => (
                                        <SwipeableCrewCard
                                            key={member.id}
                                            member={member}
                                            mode="captain"
                                            onDelete={() => handleSoftDelete(member, 'captain')}
                                            onEdit={
                                                member.status !== 'declined'
                                                    ? () => {
                                                          setEditTarget(member);
                                                          setEditRegisters([...member.shared_registers]);
                                                      }
                                                    : undefined
                                            }
                                        />
                                    ))}
                                </div>
                            )}

                            {/* ── Disband Group — danger zone ── */}
                            {visibleCrew.length > 0 && (
                                <button
                                    onClick={() => setShowDisbandConfirm(true)}
                                    className="w-full mt-4 py-3 px-4 rounded-xl border border-red-500/20 bg-red-500/5 text-red-400 text-xs font-bold hover:bg-red-500/10 transition-colors active:scale-[0.98]"
                                >
                                    🚨 Disband Entire Group
                                </button>
                            )}
                        </div>

                        {/* ── How It Works — shown at bottom when NOT empty ── */}
                        {!isEmpty && (
                            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 mb-6">
                                <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.15em] mb-3">
                                    How Crew Sharing Works
                                </h3>
                                <div className="space-y-2">
                                    {[
                                        { icon: '📧', text: 'Invite crew by their email address' },
                                        { icon: '🔐', text: 'Choose which registers to share' },
                                        { icon: '✅', text: 'Crew must accept the invite' },
                                        { icon: '✏️', text: 'Crew edits go to your data' },
                                        { icon: '👈', text: 'Swipe left to remove access' },
                                    ].map((step, i) => (
                                        <div key={i} className="flex items-center gap-2.5">
                                            <span className="text-sm">{step.icon}</span>
                                            <p className="text-[11px] text-gray-400">{step.text}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* ── INVITE MODAL ── */}
            <ModalSheet
                isOpen={showInviteModal}
                onClose={() => {
                    setShowInviteModal(false);
                    setInviteEmail('');
                    setInviteRegisters([]);
                    setInviteError(null);
                    setInviteSuccess(false);
                }}
                title="Invite Crew Member"
            >
                <div className="p-6 space-y-5">
                    {inviteSuccess ? (
                        <div className="text-center py-6">
                            <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-500/30">
                                <svg
                                    className="w-8 h-8 text-emerald-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-white mb-1">Invite Sent!</h3>
                            <p className="text-sm text-gray-400">{inviteEmail} will see the invite in their app.</p>
                        </div>
                    ) : (
                        <>
                            {/* Email input */}
                            <div>
                                <label className="text-[11px] uppercase font-bold text-gray-400 mb-1.5 ml-1 block tracking-wide">
                                    Crew Email Address
                                </label>
                                <input
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="firstmate@email.com"
                                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none transition-colors`}
                                    autoFocus
                                />
                            </div>

                            {/* Register selection — grouped */}
                            <div className="space-y-4">
                                {/* Vessel Registers */}
                                <div>
                                    <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                                        Vessel Registers
                                    </label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {VESSEL_REGISTERS.map((reg) => {
                                            const selected = inviteRegisters.includes(reg);
                                            return (
                                                <RegisterButton
                                                    key={reg}
                                                    reg={reg}
                                                    selected={selected}
                                                    onToggle={() =>
                                                        toggleRegister(reg, inviteRegisters, setInviteRegisters)
                                                    }
                                                />
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Passage Planning */}
                                <div>
                                    <label className="text-[11px] uppercase font-bold text-sky-400 mb-2 ml-1 block tracking-wide">
                                        🧭 Passage Planning
                                    </label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {PASSAGE_REGISTERS.map((reg) => {
                                            const selected = inviteRegisters.includes(reg);
                                            return (
                                                <RegisterButton
                                                    key={reg}
                                                    reg={reg}
                                                    selected={selected}
                                                    onToggle={() =>
                                                        toggleRegister(reg, inviteRegisters, setInviteRegisters)
                                                    }
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Error */}
                            {inviteError && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200">
                                    {inviteError}
                                </div>
                            )}

                            {/* Send button */}
                            <button
                                aria-label="Invite"
                                onClick={handleInvite}
                                disabled={inviteLoading || !inviteEmail.trim() || inviteRegisters.length === 0}
                                className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${!inviteEmail.trim() || inviteRegisters.length === 0 ? 'opacity-50' : 'hover:bg-gray-100'}`}
                            >
                                {inviteLoading ? (
                                    <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                                ) : (
                                    `Send Invite (${inviteRegisters.length} register${inviteRegisters.length !== 1 ? 's' : ''})`
                                )}
                            </button>
                        </>
                    )}
                </div>
            </ModalSheet>

            {/* ── EDIT PERMISSIONS MODAL ── */}
            <ModalSheet
                isOpen={!!editTarget}
                onClose={() => setEditTarget(null)}
                title={`Edit Access — ${editTarget?.crew_email || ''}`}
            >
                <div className="p-6 space-y-5">
                    <div>
                        <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 ml-1 block tracking-wide">
                            Shared Registers
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {ALL_REGISTERS.map((reg) => {
                                const selected = editRegisters.includes(reg);
                                return (
                                    <button
                                        aria-label="Register"
                                        key={reg}
                                        type="button"
                                        onClick={() => toggleRegister(reg, editRegisters, setEditRegisters)}
                                        className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
                                            selected
                                                ? 'bg-sky-500/15 border-sky-500/40'
                                                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg">{REGISTER_ICONS[reg]}</span>
                                            <p
                                                className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}
                                            >
                                                {REGISTER_LABELS[reg]}
                                            </p>
                                        </div>
                                        <div
                                            className={`mt-2 w-4 h-4 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : 'border-white/20'}`}
                                        >
                                            {selected && (
                                                <svg
                                                    className="w-2.5 h-2.5 text-white"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={3}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M4.5 12.75l6 6 9-13.5"
                                                    />
                                                </svg>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <button
                        aria-label="Save"
                        onClick={handleSavePermissions}
                        disabled={editRegisters.length === 0}
                        className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 ${editRegisters.length === 0 ? 'opacity-50' : 'hover:bg-gray-100'}`}
                    >
                        Save Changes
                    </button>
                </div>
            </ModalSheet>

            {/* ── UNDO TOAST ── */}
            <UndoToast
                isOpen={!!deletedMember}
                message={
                    deletedMember?.mode === 'captain'
                        ? `"${deletedMember?.member.crew_email}" removed`
                        : `Left "${deletedMember?.member.owner_email}"`
                }
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />

            {/* ── DISBAND GROUP CONFIRMATION ── */}
            <ModalSheet
                isOpen={showDisbandConfirm}
                onClose={() => {
                    setShowDisbandConfirm(false);
                    setDisbandConfirmText('');
                }}
                title="Disband Group"
            >
                <div className="space-y-4">
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                        <p className="text-sm text-red-300 font-bold mb-2">⚠️ This action cannot be undone</p>
                        <p className="text-[11px] text-red-300/70 leading-relaxed">
                            This will permanently remove{' '}
                            <strong>
                                all {visibleCrew.length} crew member{visibleCrew.length !== 1 ? 's' : ''}
                            </strong>{' '}
                            from your group. They will lose access to all shared registers and passage planning modules.
                        </p>
                    </div>

                    <div>
                        <label className="text-[11px] uppercase font-bold text-gray-400 mb-2 block tracking-wide">
                            Type DISBAND to confirm
                        </label>
                        <input
                            value={disbandConfirmText}
                            onChange={(e) => setDisbandConfirmText(e.target.value.toUpperCase())}
                            placeholder="DISBAND"
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/40"
                        />
                    </div>

                    <button
                        aria-label="Confirm Disband"
                        onClick={handleDisbandGroup}
                        disabled={disbandConfirmText !== 'DISBAND' || disbanding}
                        className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                            disbandConfirmText === 'DISBAND' && !disbanding
                                ? 'bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-500/20'
                                : 'bg-white/[0.04] text-gray-500 cursor-not-allowed'
                        }`}
                    >
                        {disbanding ? 'Disbanding…' : '🚨 Disband Entire Group'}
                    </button>
                </div>
            </ModalSheet>

            {/* ── CAST OFF PANEL ── */}
            {showCastOff && (
                <CastOffPanel
                    onClose={() => setShowCastOff(false)}
                    onCastOff={(voyage) => {
                        setActiveVoyageName(voyage.voyage_name);
                        setShowCastOff(false);
                    }}
                    onNavigateToGalley={() => {
                        window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'chat' } }));
                    }}
                />
            )}
        </div>
    );
});

// ── Reusable register toggle button ──
const RegisterButton: React.FC<{
    reg: SharedRegister;
    selected: boolean;
    onToggle: () => void;
}> = ({ reg, selected, onToggle }) => (
    <button
        aria-label="Register"
        type="button"
        onClick={onToggle}
        className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
            selected
                ? 'bg-sky-500/15 border-sky-500/40 shadow-lg shadow-sky-500/5'
                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
        }`}
    >
        <div className="flex items-center gap-2">
            <span className="text-lg">{REGISTER_ICONS[reg]}</span>
            <p className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}>{REGISTER_LABELS[reg]}</p>
        </div>
        <div
            className={`mt-2 w-4 h-4 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : 'border-white/20'}`}
        >
            {selected && (
                <svg
                    className="w-2.5 h-2.5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
            )}
        </div>
    </button>
);
