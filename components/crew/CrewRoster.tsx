/**
 * CrewRoster — My Crew list + Pending Invites + Shared With Me.
 *
 * Extracted from CrewManagement to reduce monolithic component.
 * Handles the captain crew list, invite acceptance, and crew view sections.
 */

import React from 'react';
import { type CrewMember, REGISTER_ICONS, REGISTER_LABELS } from '../../services/CrewService';
import { SwipeableCrewCard } from './SwipeableCrewCard';
import { EmptyState } from '../ui/EmptyState';
import { ShimmerBlock } from '../ui/ShimmerBlock';

interface CrewRosterProps {
    visibleCrew: CrewMember[];
    pendingInvites: CrewMember[];
    memberships: CrewMember[];
    loading: boolean;
    onSoftDeleteCaptain: (member: CrewMember) => void;
    onSoftDeleteCrew: (member: CrewMember) => void;
    onEditMember: (member: CrewMember) => void;
    onAcceptInvite: (invite: CrewMember) => void;
    onDeclineInvite: (invite: CrewMember) => void;
    onDisbandClick: () => void;
}

export const CrewRoster: React.FC<CrewRosterProps> = ({
    visibleCrew,
    pendingInvites,
    memberships,
    loading,
    onSoftDeleteCaptain,
    onSoftDeleteCrew,
    onEditMember,
    onAcceptInvite,
    onDeclineInvite,
    onDisbandClick,
}) => {
    if (loading) {
        return (
            <div className="py-6 space-y-3">
                <ShimmerBlock variant="list" rows={3} />
            </div>
        );
    }

    return (
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
                            <div key={invite.id} className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
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
                                        onClick={() => onAcceptInvite(invite)}
                                        className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors active:scale-95"
                                    >
                                        Accept
                                    </button>
                                    <button
                                        aria-label="Decline"
                                        onClick={() => onDeclineInvite(invite)}
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
                                onDelete={() => onSoftDeleteCrew(membership)}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* ── MY CREW (Captain view) — swipe to remove ── */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-4 rounded-full bg-sky-500" />
                    <span className="text-[11px] font-black text-sky-400 uppercase tracking-[0.2em]">My Crew</span>
                    {visibleCrew.length > 0 && (
                        <span className="ml-auto px-2 py-0.5 bg-sky-500/20 text-sky-400 text-[11px] font-bold rounded-full">
                            {visibleCrew.length}
                        </span>
                    )}
                </div>

                {visibleCrew.length === 0 ? (
                    <EmptyState
                        icon="👥"
                        title="No Crew Yet"
                        description="Invite crew members to share Inventory, Equipment, R&M and Documents registers."
                    />
                ) : (
                    <div className="space-y-2 stagger-in">
                        {visibleCrew.map((member) => (
                            <SwipeableCrewCard
                                key={member.id}
                                member={member}
                                mode="captain"
                                onDelete={() => onSoftDeleteCaptain(member)}
                                onEdit={member.status !== 'declined' ? () => onEditMember(member) : undefined}
                            />
                        ))}
                    </div>
                )}

                {/* Disband Group — danger zone */}
                {visibleCrew.length > 0 && (
                    <button
                        onClick={onDisbandClick}
                        className="w-full mt-4 py-3 px-4 rounded-xl border border-red-500/20 bg-red-500/5 text-red-400 text-xs font-bold hover:bg-red-500/10 transition-colors active:scale-[0.98]"
                    >
                        🚨 Disband Entire Group
                    </button>
                )}
            </div>
        </>
    );
};
