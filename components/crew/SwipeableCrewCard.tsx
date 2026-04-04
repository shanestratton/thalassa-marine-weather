/**
 * SwipeableCrewCard — Reusable card with swipe-to-reveal-delete.
 * Used for both "My Crew" (captain's view) and "Shared With Me" (crew's view).
 */

import React from 'react';
import { useSwipeable } from '../../hooks/useSwipeable';
import { type SharedRegister, REGISTER_LABELS, REGISTER_ICONS } from '../../services/CrewService';
import { type CrewMember } from '../../services/CrewService';

export interface SwipeableCrewCardProps {
    member: CrewMember;
    mode: 'captain' | 'crew';
    onDelete: () => void;
    onEdit?: () => void;
}

export const SwipeableCrewCard: React.FC<SwipeableCrewCardProps> = ({ member, mode, onDelete, onEdit }) => {
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
                                    className={`text-[11px] font-bold mt-0.5 ${member.status === 'accepted' ? 'text-emerald-400' : member.status === 'pending' ? 'text-amber-400' : 'text-gray-400'}`}
                                >
                                    {member.status === 'accepted'
                                        ? '✓ Active'
                                        : member.status === 'pending'
                                          ? '⏳ Waiting for them to accept'
                                          : 'Declined'}
                                </p>
                            ) : (
                                <p className="text-[11px] text-emerald-400 font-bold mt-0.5">Skipper's Registers</p>
                            )}
                        </div>
                    </div>

                    {/* Edit button (captain only, non-declined) */}
                    {isCaptain && member.status !== 'declined' && onEdit && (
                        <button
                            aria-label="Edit"
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
                        You have access to the following registers. Any changes you make will update the Skipper's data.
                    </p>
                )}

                {/* Shared register badges */}
                <div className="flex flex-wrap gap-1.5">
                    {member.shared_registers.map((reg: SharedRegister) => (
                        <span
                            key={reg}
                            className={`px-2 py-1 ${isCaptain ? 'bg-white/5 border border-white/10 text-gray-300' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'} rounded-lg text-[11px] font-bold`}
                        >
                            {REGISTER_ICONS[reg]} {REGISTER_LABELS[reg]}
                        </span>
                    ))}
                </div>

                {/* Swipe hint — subtle */}
                <p className="text-[11px] text-gray-500 mt-2 text-right">← swipe to {deleteLabel.toLowerCase()}</p>
            </div>
        </div>
    );
};
