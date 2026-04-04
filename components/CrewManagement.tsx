/**
 * CrewManagement — Passage Planning orchestrator.
 *
 * Coordinates auth, passage selection, crew management, and readiness cards.
 * UI sections delegated to:
 *   - CrewRoster: crew list, invites, memberships
 *   - ReadinessCardStack: all 8 passage readiness cards
 *   - DelegationBadge: card delegation UI
 *   - InviteCrewModal: invite form
 */

import React, { useState, useEffect, useCallback } from 'react';
import { t } from '../theme';
import { ModalSheet } from './ui/ModalSheet';
import { UndoToast } from './ui/UndoToast';

import {
    type SharedRegister,
    type CrewMember,
    ALL_REGISTERS,
    REGISTER_ICONS,
    REGISTER_LABELS,
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
import { getDraftVoyages, updateVoyage, type Voyage } from '../services/VoyageService';
import { setActivePassage, getActivePassageId } from '../services/PassagePlanService';
import { AuthModal } from './AuthModal';
import { lazyRetry } from '../utils/lazyRetry';

// ── Extracted sub-components ──
import { InviteCrewModal } from './crew/InviteCrewModal';
import { CrewRoster } from './crew/CrewRoster';
import { ReadinessCardStack } from './crew/ReadinessCardStack';

const CastOffPanel = lazyRetry(
    () => import('./vessel/CastOffPanel').then((m) => ({ default: m.CastOffPanel })),
    'CastOffPanel_Crew',
);

interface CrewManagementProps {
    onBack: () => void;
}

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

    // Soft-delete with undo
    const [deletedMember, setDeletedMember] = useState<{ member: CrewMember; mode: 'captain' | 'crew' } | null>(null);

    // Auth + Cast Off
    const [showAuth, setShowAuth] = useState(false);
    const [showCastOff, setShowCastOff] = useState(false);
    const [_activeVoyageName, setActiveVoyageName] = useState<string | null>(null);

    // Draft passage plans
    const [draftVoyages, setDraftVoyages] = useState<Voyage[]>([]);
    const [selectedPassageId, setSelectedPassageId] = useState<string>(getActivePassageId() || '');

    // ── Readiness card states ──
    const [customsCleared, setCustomsCleared] = useState(false);
    const [customsProgress, setCustomsProgress] = useState<{ total: number; checked: number }>({
        total: 0,
        checked: 0,
    });
    const [weatherReviewed, setWeatherReviewed] = useState(false);
    const [reservesReady, setReservesReady] = useState(false);
    const [navAcknowledged, setNavAcknowledged] = useState(false);
    const [watchBriefed, setWatchBriefed] = useState(false);
    const [commsReady, setCommsReady] = useState(false);
    const [vesselChecked, setVesselChecked] = useState(false);
    const [medicalReady, setMedicalReady] = useState(false);

    // Passage Intelligence states
    const [vesselProfileReady, setVesselProfileReady] = useState(false);
    const [comfortProfileReady, setComfortProfileReady] = useState(false);
    const [weatherWindowReady, setWeatherWindowReady] = useState(false);
    const [currentsBriefed, setCurrentsBriefed] = useState(false);

    // Card delegation
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

    // All readiness cards green → Cast Off unlocked
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
    const [planDeparture, setPlanDeparture] = useState('');

    // Auth check
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
        getDraftVoyages().then((drafts) => {
            setDraftVoyages(drafts);
            // Pre-fill departure date for the active passage
            const activeId = getActivePassageId();
            if (activeId) {
                const v = drafts.find((d) => d.id === activeId);
                if (v?.departure_time) setPlanDeparture(v.departure_time.slice(0, 16));
            }
        });
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

    const handleSoftDelete = (member: CrewMember, mode: 'captain' | 'crew') => {
        triggerHaptic('medium');
        if (mode === 'captain') {
            setMyCrew((prev) => prev.filter((m) => m.id !== member.id));
        } else {
            setMemberships((prev) => prev.filter((m) => m.id !== member.id));
        }
        setDeletedMember({ member, mode });
    };

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
        } catch {
            toast.error(mode === 'captain' ? 'Failed to remove crew' : 'Failed to leave vessel');
            if (mode === 'captain') {
                setMyCrew((prev) => [...prev, member]);
            } else {
                setMemberships((prev) => [...prev, member]);
            }
        }
    };

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

    // Filter out declined invites older than 7 days
    const visibleCrew = myCrew.filter((m) => {
        if (m.status !== 'declined') return true;
        const declinedAge = Date.now() - new Date(m.updated_at).getTime();
        return declinedAge < 7 * 24 * 60 * 60 * 1000;
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
                        aria-label="Invite crew member"
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
                                    const v = draftVoyages.find((v) => v.id === id);
                                    if (v) {
                                        setActiveVoyageName(
                                            v.voyage_name ||
                                                `${v.departure_port || '?'} → ${v.destination_port || '?'}`,
                                        );
                                        // Pre-fill departure date for inline picker
                                        setPlanDeparture(v.departure_time ? v.departure_time.slice(0, 16) : '');
                                    }
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

                {/* ── DEPARTURE DATE + CAST OFF (single row) ── */}
                {selectedPassageId && (
                    <div className="mb-4 flex items-end gap-2">
                        {/* Departure date — date only, time decided later */}
                        <div className="flex-1 min-w-0">
                            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-1 block">
                                📅 Departure Date
                            </label>
                            <input
                                type="date"
                                value={planDeparture ? planDeparture.slice(0, 10) : ''}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setPlanDeparture(val);
                                    // Auto-save to voyage
                                    if (selectedPassageId && val) {
                                        updateVoyage(selectedPassageId, {
                                            departure_time: new Date(val + 'T00:00:00').toISOString(),
                                        }).then((result) => {
                                            if (result.voyage) {
                                                setDraftVoyages((prev) =>
                                                    prev.map((v) => (v.id === selectedPassageId ? result.voyage! : v)),
                                                );
                                            }
                                        });
                                    }
                                }}
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/30 transition-colors [color-scheme:dark]"
                            />
                        </div>

                        {/* Cast Off CTA */}
                        <button
                            onClick={() => {
                                setShowCastOff(true);
                                triggerHaptic('medium');
                            }}
                            disabled={!allCardsReady}
                            className={`shrink-0 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 ${
                                allCardsReady
                                    ? 'bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20 text-emerald-300 hover:from-emerald-500/20 hover:to-teal-500/20'
                                    : 'bg-white/[0.03] border-white/[0.08] text-gray-500'
                            }`}
                        >
                            ⚓ Cast Off
                        </button>
                    </div>
                )}

                {/* ── CREW ROSTER ── */}
                <CrewRoster
                    visibleCrew={visibleCrew}
                    pendingInvites={pendingInvites}
                    memberships={memberships}
                    loading={loading}
                    onSoftDeleteCaptain={(m) => handleSoftDelete(m, 'captain')}
                    onSoftDeleteCrew={(m) => handleSoftDelete(m, 'crew')}
                    onEditMember={(m) => {
                        setEditTarget(m);
                        setEditRegisters([...m.shared_registers]);
                    }}
                    onAcceptInvite={handleAccept}
                    onDeclineInvite={handleDecline}
                    onDisbandClick={() => setShowDisbandConfirm(true)}
                />

                {/* ── READINESS CARDS ── */}
                {!loading && (
                    <ReadinessCardStack
                        selectedPassageId={selectedPassageId}
                        draftVoyages={draftVoyages}
                        visibleCrew={visibleCrew}
                        planCrewCount={Math.max(visibleCrew.length + 1, 2)}
                        weatherReviewed={weatherReviewed}
                        reservesReady={reservesReady}
                        vesselChecked={vesselChecked}
                        medicalReady={medicalReady}
                        watchBriefed={watchBriefed}
                        commsReady={commsReady}
                        customsCleared={customsCleared}
                        navAcknowledged={navAcknowledged}
                        customsProgress={customsProgress}
                        onWeatherChange={setWeatherReviewed}
                        onReservesChange={setReservesReady}
                        onVesselCheckChange={setVesselChecked}
                        onMedicalChange={setMedicalReady}
                        onWatchChange={setWatchBriefed}
                        onCommsChange={setCommsReady}
                        onCustomsChange={(total, checked) => {
                            setCustomsProgress({ total, checked });
                            setCustomsCleared(total > 0 && checked >= total);
                        }}
                        onNavChange={setNavAcknowledged}
                        cardDelegations={cardDelegations}
                        delegationMenuOpen={delegationMenuOpen}
                        onDelegationMenuToggle={setDelegationMenuOpen}
                        onAssignCard={assignCard}
                        vesselProfileReady={vesselProfileReady}
                        comfortProfileReady={comfortProfileReady}
                        weatherWindowReady={weatherWindowReady}
                        currentsBriefed={currentsBriefed}
                        onVesselProfileChange={setVesselProfileReady}
                        onComfortProfileChange={setComfortProfileReady}
                        onWeatherWindowChange={setWeatherWindowReady}
                        onCurrentsChange={setCurrentsBriefed}
                    />
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
                                        aria-label="Register new crew member"
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
                        aria-label="Save crew management changes"
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
                    initialVoyageId={selectedPassageId || undefined}
                    onCastOff={(voyage) => {
                        setActiveVoyageName(voyage.voyage_name);
                        setShowCastOff(false);
                    }}
                />
            )}
        </div>
    );
});
