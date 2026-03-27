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
import { scrollInputAboveKeyboard as _scrollInputAboveKeyboard } from '../utils/keyboardScroll';
import { getDraftVoyages, updateVoyage, type Voyage } from '../services/VoyageService';
import { getCrewCount as _getCrewCount } from '../services/MealPlanService';
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

// ── Extracted sub-components ──
import { SwipeableCrewCard } from './crew/SwipeableCrewCard';
import { PassagePlanningPanel } from './crew/PassagePlanningPanel';
import { InviteCrewModal } from './crew/InviteCrewModal';
import { RegisterButton as _RegisterButton } from './crew/RegisterButton';
import { GalleyCard } from './chat/GalleyCard';
import { CustomsClearanceCard } from './passage/CustomsClearanceCard';
import { WeatherBriefingCard } from './passage/WeatherBriefingCard';
import { EssentialReservesCard } from './passage/EssentialReservesCard';
import { PassageSummaryCard } from './passage/PassageSummaryCard';
import { AidToNavigationCard } from './passage/AidToNavigationCard';
import { WatchScheduleCard } from './passage/WatchScheduleCard';
import { CommsPlanCard } from './passage/CommsPlanCard';
import { VesselCheckCard } from './passage/VesselCheckCard';
import { MedicalFirstAidCard } from './passage/MedicalFirstAidCard';

/* ── Delegation Badge ─── */
const DELEGATABLE_CARDS: Record<string, { label: string; roles: string[] }> = {
    vessel_check: { label: 'Vessel Pre-Check', roles: ['Bosun', 'Engineer', 'First Mate'] },
    medical: { label: 'Medical & First Aid', roles: ['Medic', 'Nurse', 'Doctor'] },
    essential_reserves: { label: 'Essential Reserves', roles: ['First Mate', 'Bosun'] },
    watch_schedule: { label: 'Watch Schedule', roles: ['First Mate', 'Watch Captain'] },
    comms_plan: { label: 'Communications', roles: ['Radio Operator', 'First Mate'] },
    customs_clearance: { label: 'Customs & Clearance', roles: ["Ship's Agent", 'First Mate'] },
};

/** Cards that ONLY the skipper can sign off — not delegatable */
const SKIPPER_ONLY = ['weather_briefing', 'aid_to_navigation'];

interface DelegationBadgeProps {
    cardKey: string;
    delegations: Record<string, string>;
    crewList: { crew_email: string }[];
    menuOpen: string | null;
    onMenuToggle: (key: string | null) => void;
    onAssign: (cardKey: string, crewEmail: string | null) => void;
}

const DelegationBadge: React.FC<DelegationBadgeProps> = ({
    cardKey,
    delegations,
    crewList,
    menuOpen,
    onMenuToggle,
    onAssign,
}) => {
    if (SKIPPER_ONLY.includes(cardKey)) {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/15 text-[9px] font-bold text-amber-400/80 uppercase tracking-wider ml-1.5">
                👨‍✈️ Skipper
            </span>
        );
    }

    const assigned = delegations[cardKey];
    const emailPrefix = (email: string) => email.split('@')[0].slice(0, 12);
    const isOpen = menuOpen === cardKey;

    return (
        <span className="relative inline-flex ml-1.5">
            <button
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMenuToggle(isOpen ? null : cardKey);
                }}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all border ${
                    assigned
                        ? 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        : 'bg-white/[0.04] border-white/[0.08] text-gray-500 hover:text-gray-300 hover:bg-white/[0.08]'
                }`}
            >
                {assigned ? `👤 ${emailPrefix(assigned)}` : '👤 Assign'}
            </button>

            {isOpen && (
                <div
                    className="absolute top-full left-0 mt-1 z-50 w-48 bg-gray-900/95 backdrop-blur-lg border border-white/10 rounded-xl shadow-2xl py-1 animate-in fade-in slide-in-from-top-1 duration-150"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                >
                    <div className="px-3 py-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-widest">
                        {DELEGATABLE_CARDS[cardKey]?.roles.join(' · ') || 'Assign To'}
                    </div>
                    {crewList.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-gray-500 italic">No crew members yet</div>
                    ) : (
                        crewList.map((c) => (
                            <button
                                key={c.crew_email}
                                onClick={() => onAssign(cardKey, c.crew_email)}
                                className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                                    assigned === c.crew_email
                                        ? 'bg-sky-500/10 text-sky-400 font-bold'
                                        : 'text-gray-300 hover:bg-white/[0.06]'
                                }`}
                            >
                                <span className="mr-1.5">{assigned === c.crew_email ? '✓' : '○'}</span>
                                {c.crew_email}
                            </button>
                        ))
                    )}
                    {assigned && (
                        <>
                            <div className="border-t border-white/[0.06] my-1" />
                            <button
                                onClick={() => onAssign(cardKey, null)}
                                className="w-full text-left px-3 py-2 text-xs text-red-400/70 hover:bg-red-500/10 transition-colors"
                            >
                                ✕ Unassign
                            </button>
                        </>
                    )}
                </div>
            )}
        </span>
    );
};

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
    const [_activeVoyageName, setActiveVoyageName] = useState<string | null>(null);

    // Draft passage plans (moved from Welcome Aboard)
    const [draftVoyages, setDraftVoyages] = useState<Voyage[]>([]);
    const [selectedPassageId, setSelectedPassageId] = useState<string>(getActivePassageId() || '');

    // Customs readiness tracking
    const [customsCleared, setCustomsCleared] = useState(false);
    const [customsProgress, setCustomsProgress] = useState<{ total: number; checked: number }>({
        total: 0,
        checked: 0,
    });

    // Weather briefing tracking
    const [weatherReviewed, setWeatherReviewed] = useState(false);

    // Essential reserves tracking
    const [reservesReady, setReservesReady] = useState(false);

    // Aid to Navigation legal acknowledgment
    const [navAcknowledged, setNavAcknowledged] = useState(false);

    // Watch schedule tracking
    const [watchBriefed, setWatchBriefed] = useState(false);

    // Communications plan tracking
    const [commsReady, setCommsReady] = useState(false);

    // Vessel pre-departure check tracking
    const [vesselChecked, setVesselChecked] = useState(false);

    // Medical & first aid tracking
    const [medicalReady, setMedicalReady] = useState(false);

    // Card delegation — which crew member is responsible for each card
    const DELEGATION_STORAGE_KEY = 'thalassa_card_delegations';
    const [cardDelegations, setCardDelegations] = useState<Record<string, string>>(() => {
        try {
            const stored = localStorage.getItem(DELEGATION_STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });
    const [delegationMenuOpen, setDelegationMenuOpen] = useState<string | null>(null);

    const assignCard = useCallback((cardKey: string, crewEmail: string | null) => {
        setCardDelegations((prev) => {
            const next = { ...prev };
            if (crewEmail) {
                next[cardKey] = crewEmail;
            } else {
                delete next[cardKey];
            }
            try {
                localStorage.setItem(DELEGATION_STORAGE_KEY, JSON.stringify(next));
            } catch {
                /* ignore */
            }
            return next;
        });
        setDelegationMenuOpen(null);
    }, []);

    // Compute if ALL readiness cards are green (for Cast Off gate)
    const allCardsReady =
        customsCleared &&
        weatherReviewed &&
        reservesReady &&
        navAcknowledged &&
        watchBriefed &&
        commsReady &&
        vesselChecked &&
        medicalReady;

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
        try {
            const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
            if (raw) {
                const s = JSON.parse(raw);
                if (s?.vessel?.crewCount) return s.vessel.crewCount;
            }
        } catch {
            /* ignore */
        }
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
    const [_userEmail, setUserEmail] = useState<string | null>(null);
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
        // Load crew count from vessel settings, fallback to localStorage, then Supabase
        let settingsCrewCount = 2;
        try {
            const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
            if (raw) {
                const s = JSON.parse(raw);
                if (s?.vessel?.crewCount) settingsCrewCount = s.vessel.crewCount;
            }
        } catch {
            /* ignore */
        }
        setPlanCrewCount(settingsCrewCount);
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
            setDraftVoyages((prev) => prev.map((v) => (v.id === selectedPassageId ? result.voyage! : v)));
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
                    <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Passage Planning</h1>
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

    const _isEmpty = visibleCrew.length === 0 && memberships.length === 0 && pendingInvites.length === 0;

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
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Passage Planning</h1>
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
                        + Invite Crew
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-24" style={{ WebkitOverflowScrolling: 'touch' }}>
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
                                    const v = draftVoyages.find((v) => v.id === id);
                                    if (v)
                                        setActiveVoyageName(
                                            v.voyage_name ||
                                                `${v.departure_port || '?'} → ${v.destination_port || '?'}`,
                                        );
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
                                    {v.voyage_name || `${v.departure_port || '?'} → ${v.destination_port || '?'}`}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-lg p-3 text-center">
                            <p className="text-[11px] text-gray-400">
                                No draft passages yet. Plan a route from the <strong>Route Planner</strong> to create
                                one.
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
                                disabled={
                                    !allCardsReady ||
                                    !draftVoyages.find((v) => v.id === selectedPassageId)?.departure_time
                                }
                                className={`flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 ${
                                    allCardsReady
                                        ? 'bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20 text-emerald-300 hover:from-emerald-500/20 hover:to-teal-500/20'
                                        : 'bg-white/[0.03] border-white/[0.08] text-gray-500'
                                }`}
                            >
                                ⚓ Cast Off
                            </button>
                        </div>

                        {/* ── PLANNING PANEL ── */}
                        {showPlanning && (
                            <PassagePlanningPanel
                                planDeparture={planDeparture}
                                planEta={planEta}
                                planDeparturePort={planDeparturePort}
                                planDestPort={planDestPort}
                                planNotes={planNotes}
                                planCrewCount={Math.max(planCrewCount, visibleCrew.length + 1)}
                                savingPlan={savingPlan}
                                onDepartureChange={setPlanDeparture}
                                onEtaChange={setPlanEta}
                                onDeparturePortChange={setPlanDeparturePort}
                                onDestPortChange={setPlanDestPort}
                                onNotesChange={setPlanNotes}
                                onSave={handleSavePlan}
                                onCancel={() => setShowPlanning(false)}
                            />
                        )}
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : (
                    <>
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

                        {/* ═══ 1. PASSAGE SUMMARY — Context setter ═══ */}
                        {(() => {
                            const activeVoyage = draftVoyages.find((v) => v.id === selectedPassageId);
                            if (!activeVoyage) return null;
                            return (
                                <div className="mb-4">
                                    <details className="group">
                                        <summary className="w-full flex items-center gap-3 p-3 rounded-2xl border bg-gradient-to-r from-sky-500/[0.06] to-indigo-500/[0.03] border-sky-500/15 hover:from-sky-500/[0.1] hover:to-indigo-500/[0.06] transition-all cursor-pointer list-none">
                                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/10 border border-sky-500/20 flex items-center justify-center text-xl flex-shrink-0">
                                                🧭
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="text-lg font-semibold text-white">Passage Summary</p>
                                                <p className="text-sm text-sky-400/70">
                                                    {activeVoyage.departure_port || '—'} →{' '}
                                                    {activeVoyage.destination_port || '—'}
                                                </p>
                                            </div>
                                            <svg
                                                className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                                />
                                            </svg>
                                        </summary>
                                        <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                            <PassageSummaryCard
                                                departPort={activeVoyage.departure_port || undefined}
                                                destPort={activeVoyage.destination_port || undefined}
                                                departureTime={activeVoyage.departure_time}
                                                eta={activeVoyage.eta}
                                            />
                                        </div>
                                    </details>
                                </div>
                            );
                        })()}

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

                        {/* ═══ 2. WEATHER BRIEFING — Go/No-Go decision ═══ */}
                        {(() => {
                            const activeVoyage = draftVoyages.find((v) => v.id === selectedPassageId);
                            const departPort = activeVoyage?.departure_port;
                            const destPort = activeVoyage?.destination_port;
                            return (
                                <div className="mb-4">
                                    <details className="group">
                                        <summary
                                            className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                                weatherReviewed
                                                    ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                                    : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                            }`}
                                        >
                                            <div
                                                className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                                    weatherReviewed
                                                        ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                        : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                                }`}
                                            >
                                                {weatherReviewed ? '✅' : '🌤️'}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="text-lg font-semibold text-white inline-flex items-center">
                                                    Weather Briefing
                                                    <DelegationBadge
                                                        cardKey="weather_briefing"
                                                        delegations={cardDelegations}
                                                        crewList={visibleCrew}
                                                        menuOpen={delegationMenuOpen}
                                                        onMenuToggle={setDelegationMenuOpen}
                                                        onAssign={assignCard}
                                                    />
                                                </p>
                                                <p
                                                    className={`text-sm ${weatherReviewed ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                                >
                                                    {weatherReviewed
                                                        ? '✅ Briefing reviewed — conditions accepted'
                                                        : 'Review models & forecast before departure'}
                                                </p>
                                            </div>
                                            <svg
                                                className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                                />
                                            </svg>
                                        </summary>
                                        <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                            <WeatherBriefingCard
                                                voyageId={selectedPassageId}
                                                departPort={departPort || undefined}
                                                destPort={destPort || undefined}
                                                onReviewedChange={setWeatherReviewed}
                                            />
                                        </div>
                                    </details>
                                </div>
                            );
                        })()}

                        {/* ═══ 3. ESSENTIAL RESERVES — Boat physically ready ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        reservesReady
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            reservesReady
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                        }`}
                                    >
                                        {reservesReady ? '✅' : '⛽'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Essential Reserves
                                            <DelegationBadge
                                                cardKey="essential_reserves"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${reservesReady ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                        >
                                            {reservesReady
                                                ? '✅ All critical reserves confirmed'
                                                : 'Fuel · Water · Gas · Safety'}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <EssentialReservesCard
                                        voyageId={selectedPassageId}
                                        onReviewedChange={setReservesReady}
                                    />
                                </div>
                            </details>
                        </div>

                        {/* ═══ 4. VESSEL PRE-DEPARTURE CHECK — Systems verified ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        vesselChecked
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            vesselChecked
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                        }`}
                                    >
                                        {vesselChecked ? '✅' : '🔧'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Vessel Pre-Check
                                            <DelegationBadge
                                                cardKey="vessel_check"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${vesselChecked ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                        >
                                            {vesselChecked
                                                ? '✅ All vessel systems verified'
                                                : 'Engine · Electrical · Hull · Safety'}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <VesselCheckCard voyageId={selectedPassageId} onReviewedChange={setVesselChecked} />
                                </div>
                            </details>
                        </div>

                        {/* ═══ 5. MEDICAL & FIRST AID — Crew medical readiness ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        medicalReady
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            medicalReady
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                        }`}
                                    >
                                        {medicalReady ? '✅' : '🏥'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Medical & First Aid
                                            <DelegationBadge
                                                cardKey="medical"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${medicalReady ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                        >
                                            {medicalReady
                                                ? '✅ Crew medical info recorded · Kit verified'
                                                : 'Allergies · Emergency contacts · First aid kit'}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <MedicalFirstAidCard
                                        voyageId={selectedPassageId}
                                        onReviewedChange={setMedicalReady}
                                    />
                                </div>
                            </details>
                        </div>

                        {/* ═══ 6. VOYAGE PROVISIONING — Crew fed ═══ */}
                        <div className="mb-4">
                            <GalleyCard className="" registeredCrewCount={visibleCrew.length} />
                        </div>

                        {/* ═══ 5. WATCH SCHEDULE — Crew organised ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        watchBriefed
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            watchBriefed
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                        }`}
                                    >
                                        {watchBriefed ? '✅' : '⏰'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Watch Schedule
                                            <DelegationBadge
                                                cardKey="watch_schedule"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${watchBriefed ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                        >
                                            {watchBriefed
                                                ? '✅ Watch rotation briefed to crew'
                                                : `${planCrewCount} crew · Set watch rotation`}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <WatchScheduleCard
                                        voyageId={selectedPassageId}
                                        crewCount={planCrewCount}
                                        onReviewedChange={setWatchBriefed}
                                    />
                                </div>
                            </details>
                        </div>

                        {/* ═══ 6. COMMUNICATIONS PLAN — Shore contact & radio ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        commsReady
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            commsReady
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                        }`}
                                    >
                                        {commsReady ? '✅' : '📡'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Communications Plan
                                            <DelegationBadge
                                                cardKey="comms_plan"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${commsReady ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                        >
                                            {commsReady
                                                ? '✅ Comms plan confirmed · Shore contact set'
                                                : 'Radio · Position reports · Shore contact'}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <CommsPlanCard voyageId={selectedPassageId} onReviewedChange={setCommsReady} />
                                </div>
                            </details>
                        </div>

                        {/* ═══ 7. CUSTOMS & IMMIGRATION — Paperwork (international only) ═══ */}
                        {(() => {
                            const activeVoyage = draftVoyages.find((v) => v.id === selectedPassageId);
                            const departPort = activeVoyage?.departure_port;
                            const destPort = activeVoyage?.destination_port;
                            if (!departPort || !destPort) return null;
                            const minimalPlan = {
                                customs: {
                                    required: true,
                                    departingCountry: departPort,
                                    destinationCountry: destPort,
                                },
                            };
                            return (
                                <div className="mb-4">
                                    <details className="group">
                                        <summary
                                            className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                                customsCleared
                                                    ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                                    : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                                            }`}
                                        >
                                            <div
                                                className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                                    customsCleared
                                                        ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                        : 'from-red-500/20 to-orange-500/10 border-red-500/20'
                                                }`}
                                            >
                                                {customsCleared ? '✅' : '🛂'}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="text-lg font-semibold text-white inline-flex items-center">
                                                    Customs & Immigration
                                                    <DelegationBadge
                                                        cardKey="customs_clearance"
                                                        delegations={cardDelegations}
                                                        crewList={visibleCrew}
                                                        menuOpen={delegationMenuOpen}
                                                        onMenuToggle={setDelegationMenuOpen}
                                                        onAssign={assignCard}
                                                    />
                                                </p>
                                                <p
                                                    className={`text-sm ${customsCleared ? 'text-emerald-400/70' : 'text-red-400/70'}`}
                                                >
                                                    {customsCleared
                                                        ? '✅ All documents cleared'
                                                        : customsProgress.total > 0
                                                          ? `${customsProgress.checked}/${customsProgress.total} documents · ${departPort} → ${destPort}`
                                                          : `${departPort} → ${destPort}`}
                                                </p>
                                            </div>
                                            <svg
                                                className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                                />
                                            </svg>
                                        </summary>
                                        <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                            <CustomsClearanceCard
                                                voyageId={selectedPassageId}
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                voyagePlan={minimalPlan as any}
                                                onCheckedChange={(total, checked) => {
                                                    setCustomsProgress({ total, checked });
                                                    setCustomsCleared(total > 0 && checked >= total);
                                                }}
                                            />
                                        </div>
                                    </details>
                                </div>
                            );
                        })()}

                        {/* ═══ 8. AID TO NAVIGATION — Final legal gate (always last) ═══ */}
                        <div className="mb-4">
                            <details className="group">
                                <summary
                                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer list-none ${
                                        navAcknowledged
                                            ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                                            : 'bg-gradient-to-r from-amber-500/[0.06] to-orange-500/[0.03] border-amber-500/15 hover:from-amber-500/[0.1] hover:to-orange-500/[0.06]'
                                    }`}
                                >
                                    <div
                                        className={`w-11 h-11 rounded-xl bg-gradient-to-br border flex items-center justify-center text-xl flex-shrink-0 ${
                                            navAcknowledged
                                                ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20'
                                                : 'from-amber-500/20 to-orange-500/10 border-amber-500/20'
                                        }`}
                                    >
                                        {navAcknowledged ? '✅' : '⚓'}
                                    </div>
                                    <div className="flex-1 text-left">
                                        <p className="text-lg font-semibold text-white inline-flex items-center">
                                            Aid to Navigation
                                            <DelegationBadge
                                                cardKey="aid_to_navigation"
                                                delegations={cardDelegations}
                                                crewList={visibleCrew}
                                                menuOpen={delegationMenuOpen}
                                                onMenuToggle={setDelegationMenuOpen}
                                                onAssign={assignCard}
                                            />
                                        </p>
                                        <p
                                            className={`text-sm ${navAcknowledged ? 'text-emerald-400/70' : 'text-amber-400/70'}`}
                                        >
                                            {navAcknowledged
                                                ? '✅ All acknowledgments accepted'
                                                : "Legal disclaimers · Skipper's acknowledgment"}
                                        </p>
                                    </div>
                                    <svg
                                        className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </summary>
                                <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                    <AidToNavigationCard
                                        voyageId={selectedPassageId}
                                        onAcknowledgedChange={setNavAcknowledged}
                                        allOtherCardsReady={
                                            customsCleared &&
                                            weatherReviewed &&
                                            reservesReady &&
                                            watchBriefed &&
                                            commsReady
                                        }
                                    />
                                </div>
                            </details>
                        </div>
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
                <InviteCrewModal
                    inviteEmail={inviteEmail}
                    inviteRegisters={inviteRegisters}
                    inviteLoading={inviteLoading}
                    inviteError={inviteError}
                    inviteSuccess={inviteSuccess}
                    onEmailChange={setInviteEmail}
                    onToggleRegister={(reg) => toggleRegister(reg, inviteRegisters, setInviteRegisters)}
                    onInvite={handleInvite}
                />
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

// RegisterButton is now in ./crew/RegisterButton.tsx
