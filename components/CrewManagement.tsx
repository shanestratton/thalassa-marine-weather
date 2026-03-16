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
import { useSwipeable } from '../hooks/useSwipeable';
import {
    type SharedRegister,
    type CrewMember,
    ALL_REGISTERS,
    REGISTER_LABELS,
    REGISTER_ICONS,
    inviteCrew,
    getMyCrew,
    removeCrew,
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

interface CrewManagementProps {
    onBack: () => void;
}

// ── SwipeableCrewCard ──────────────────────────────────────────
// Reusable card with swipe-to-reveal-delete, used for both
// "My Crew" (captain's view) and "Shared With Me" (crew's view).

interface SwipeableCrewCardProps {
    member: CrewMember;
    mode: 'captain' | 'crew';
    onDelete: () => void;
    onEdit?: () => void;
}

const SwipeableCrewCard: React.FC<SwipeableCrewCardProps> = ({ member, mode, onDelete, onEdit }) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();

    const isCaptain = mode === 'captain';
    const deleteLabel = isCaptain ? 'Remove' : 'Leave';

    return (
        <div className="relative overflow-hidden rounded-xl">
            {/* Delete/Leave zone (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                    </svg>
                    <span className="text-[11px] font-bold">{deleteLabel}</span>
                </div>
            </div>

            {/* Main card (slides on swipe) — ref attaches native touch listeners */}
            <div
                ref={ref}
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} ${isCaptain ? 'bg-white/[0.03] border border-white/[0.06]' : 'bg-emerald-500/5 border border-emerald-500/15'} rounded-xl p-4`}
                style={{ transform: `translateX(-${swipeOffset}px)`, touchAction: 'pan-y' }}
            >
                <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3">
                        {!isCaptain && (
                            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                                <span className="text-lg">⚓</span>
                            </div>
                        )}
                        <div>
                            <p className="text-sm font-bold text-white">
                                {isCaptain ? member.crew_email : member.owner_email}
                            </p>
                            {isCaptain ? (
                                <p
                                    className={`text-[11px] font-bold mt-0.5 ${member.status === 'accepted' ? 'text-emerald-400' : member.status === 'pending' ? 'text-amber-400' : 'text-gray-500'}`}
                                >
                                    {member.status === 'accepted'
                                        ? '✓ Active'
                                        : member.status === 'pending'
                                          ? '⏳ Waiting for them to accept'
                                          : 'Declined'}
                                </p>
                            ) : (
                                <p className="text-[11px] text-emerald-400 font-bold mt-0.5">Captain's Registers</p>
                            )}
                        </div>
                    </div>

                    {/* Edit button (captain only, non-declined) */}
                    {isCaptain && member.status !== 'declined' && onEdit && (
                        <button
                            onClick={onEdit}
                            className="text-[11px] text-sky-400/60 hover:text-sky-400 font-bold transition-colors px-2 py-1"
                        >
                            Edit
                        </button>
                    )}
                </div>

                {/* Explanation for crew */}
                {!isCaptain && (
                    <p className="text-[11px] text-gray-400 mb-2.5">
                        You have access to the following registers. Any changes you make will update the captain's data.
                    </p>
                )}

                {/* Shared register badges */}
                <div className="flex flex-wrap gap-1.5">
                    {member.shared_registers.map((reg) => (
                        <span
                            key={reg}
                            className={`px-2 py-1 ${isCaptain ? 'bg-white/5 border border-white/10 text-gray-300' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'} rounded-lg text-[11px] font-bold`}
                        >
                            {REGISTER_ICONS[reg]} {REGISTER_LABELS[reg]}
                        </span>
                    ))}
                </div>

                {/* Swipe hint — subtle */}
                <p className="text-[11px] text-gray-600 mt-2 text-right">← swipe to {deleteLabel.toLowerCase()}</p>
            </div>
        </div>
    );
};

// ── Main Component ─────────────────────────────────────────────

export const CrewManagement: React.FC<CrewManagementProps> = ({ onBack }) => {
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
        return declinedAge < 7 * 24 * 60 * 60 * 1000; // 7 days
    });

    // ── Not authenticated ──
    if (!isAuthed) {
        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <div className="shrink-0 px-4 pt-4 pb-3 flex items-center gap-2">
                    <button
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
                        <p className="text-sm text-gray-400 max-w-xs">
                            Sign in to share your vessel registers with crew members.
                        </p>
                    </div>
                </div>
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
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                                Your Email (share for invites)
                            </p>
                            <p className="text-sm font-bold text-white mt-0.5">{userEmail}</p>
                        </div>
                        <button
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

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : (
                    <>
                        {/* ── How It Works — shown at TOP when empty ── */}
                        {isEmpty && (
                            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 mb-6">
                                <h3 className="text-[11px] font-black text-gray-500 uppercase tracking-[0.15em] mb-3">
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
                                                    onClick={() => handleAccept(invite)}
                                                    className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors active:scale-95"
                                                >
                                                    Accept
                                                </button>
                                                <button
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
                        </div>

                        {/* ── How It Works — shown at bottom when NOT empty ── */}
                        {!isEmpty && (
                            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-4 mb-6">
                                <h3 className="text-[11px] font-black text-gray-500 uppercase tracking-[0.15em] mb-3">
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
                                <label className="text-[11px] uppercase font-bold text-gray-500 mb-1.5 ml-1 block tracking-wide">
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

                            {/* Register selection */}
                            <div>
                                <label className="text-[11px] uppercase font-bold text-gray-500 mb-2 ml-1 block tracking-wide">
                                    Share These Registers
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {ALL_REGISTERS.map((reg) => {
                                        const selected = inviteRegisters.includes(reg);
                                        return (
                                            <button
                                                key={reg}
                                                type="button"
                                                onClick={() => toggleRegister(reg, inviteRegisters, setInviteRegisters)}
                                                className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
                                                    selected
                                                        ? 'bg-sky-500/15 border-sky-500/40 shadow-lg shadow-sky-500/5'
                                                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                                                }`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="text-lg">{REGISTER_ICONS[reg]}</span>
                                                    <div>
                                                        <p
                                                            className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}
                                                        >
                                                            {REGISTER_LABELS[reg]}
                                                        </p>
                                                    </div>
                                                </div>
                                                {/* Checkbox indicator */}
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

                            {/* Error */}
                            {inviteError && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200">
                                    {inviteError}
                                </div>
                            )}

                            {/* Send button */}
                            <button
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
                        <label className="text-[11px] uppercase font-bold text-gray-500 mb-2 ml-1 block tracking-wide">
                            Shared Registers
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {ALL_REGISTERS.map((reg) => {
                                const selected = editRegisters.includes(reg);
                                return (
                                    <button
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
        </div>
    );
};
