/**
 * CrewDetailView — full Crew List profile with consent-first introductions
 *
 * Extracted from LonelyHeartsPage to reduce file size.
 */

import React from 'react';
import { CrewFinderState } from '../../hooks/useCrewFinderState';
import { CrewCard } from '../../services/LonelyHeartsService';
import { SafeImage } from '../ui/SafeImage';

interface CrewListApprovalFields {
    approval_status?: string | null;
    verification_status?: string | null;
}

interface CrewDetailViewProps {
    selectedCard: CrewCard;
    state: CrewFinderState;
    onBack: () => void;
    onLike: (card: CrewCard) => void;
    onOpenIntroductions: () => void;
    matchedUserIds: Set<string>;
    formatDate: (iso: string | null) => string;
    isOpenEnded: (iso: string | null) => boolean;
}

export const CrewDetailView: React.FC<CrewDetailViewProps> = React.memo(
    ({ selectedCard, state, onBack, onLike, onOpenIntroductions, matchedUserIds, formatDate, isOpenEnded }) => {
        const { likedUsers } = state;
        const review = selectedCard as CrewCard & CrewListApprovalFields;
        const isApprovedForCrewList =
            review.approval_status === 'approved' && review.verification_status === 'verified';
        // Never render the inherited chat-profile `home_port` field in Crew
        // List discovery. A public card is restricted to a broad state/country
        // area even if an old cached card carried a more precise value.
        const broadArea = [selectedCard.location_state, selectedCard.location_country].filter(Boolean).join(', ');

        return (
            <div className="px-4 py-5">
                {/* Back button */}
                <button
                    aria-label="Go back"
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white/60 mb-4 transition-colors"
                >
                    ← Back to Crew List
                </button>

                {/* Profile header */}
                <div className="text-center mb-6">
                    <div className="w-28 h-28 mx-auto rounded-2xl overflow-hidden border-3 border-white/[0.08] shadow-2xl mb-4">
                        {selectedCard.avatar_url ? (
                            <SafeImage
                                src={selectedCard.avatar_url}
                                loading="lazy"
                                alt=""
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <div className="w-full h-full bg-gradient-to-br from-emerald-500/15 to-sky-500/15 flex items-center justify-center">
                                <span className="text-3xl">
                                    {selectedCard.listing_type === 'seeking_crew' ? '🚢' : '⛵'}
                                </span>
                            </div>
                        )}
                    </div>
                    <h2 className="text-2xl font-black text-white/90 mb-0.5">{selectedCard.display_name}</h2>
                    {isApprovedForCrewList && (
                        <p className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-500/[0.10] px-2.5 py-1 text-[11px] font-semibold text-sky-100/85">
                            <span aria-hidden="true">✓</span> Approved for Crew List
                        </p>
                    )}
                    {selectedCard.listing_type && (
                        <span
                            className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${selectedCard.listing_type === 'seeking_crew' ? 'bg-emerald-500/15 text-emerald-300/80' : 'bg-amber-500/15 text-amber-300/80'}`}
                        >
                            {selectedCard.listing_type === 'seeking_crew' ? '⚓ Seeking crew' : '🧭 Seeking a skipper'}
                        </span>
                    )}
                </div>

                {/* Info cards */}
                <div className="space-y-4">
                    {/* Quick facts */}
                    <div className="grid grid-cols-2 gap-2">
                        {broadArea && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Broad Area
                                </p>
                                <p className="text-sm text-white/70">📍 {broadArea}</p>
                            </div>
                        )}
                        {selectedCard.sailing_region && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Region
                                </p>
                                <p className="text-sm text-white/70">📍 {selectedCard.sailing_region}</p>
                            </div>
                        )}
                        {selectedCard.sailing_experience && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Experience
                                </p>
                                <p className="text-sm text-white/70">🧭 {selectedCard.sailing_experience}</p>
                            </div>
                        )}
                        {selectedCard.vibe.length > 0 && (
                            <div className="p-3 rounded-xl bg-purple-500/5 border border-purple-500/10">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-purple-300/40 mb-0.5">
                                    Sailing Style
                                </p>
                                <p className="text-sm text-purple-200/70">{selectedCard.vibe.join(' · ')}</p>
                            </div>
                        )}
                        {selectedCard.languages.length > 0 && (
                            <div className="p-3 rounded-xl bg-sky-500/5 border border-sky-500/10">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-sky-300/40 mb-0.5">
                                    Languages
                                </p>
                                <p className="text-sm text-sky-200/70">{selectedCard.languages.join(', ')}</p>
                            </div>
                        )}
                    </div>

                    {/* Lifestyle */}
                    {(selectedCard.smoking || selectedCard.drinking || selectedCard.pets) && (
                        <div className="flex flex-wrap gap-2">
                            {selectedCard.smoking && (
                                <span className="px-3 py-1.5 rounded-xl bg-emerald-500/8 text-xs text-emerald-200/60 border border-emerald-500/10">
                                    🚬 {selectedCard.smoking}
                                </span>
                            )}
                            {selectedCard.drinking && (
                                <span className="px-3 py-1.5 rounded-xl bg-amber-500/8 text-xs text-amber-200/60 border border-amber-500/10">
                                    🍷 {selectedCard.drinking}
                                </span>
                            )}
                            {selectedCard.pets && (
                                <span className="px-3 py-1.5 rounded-xl bg-sky-500/8 text-xs text-sky-200/60 border border-sky-500/10">
                                    🐾 {selectedCard.pets}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Availability */}
                    {(selectedCard.available_from ||
                        (selectedCard.available_to && !isOpenEnded(selectedCard.available_to))) && (
                        <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                            <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300/40 mb-1">
                                Availability
                            </p>
                            <p className="text-sm text-emerald-200/70">
                                📅 {selectedCard.available_from ? formatDate(selectedCard.available_from) : 'Flexible'}
                                {!isOpenEnded(selectedCard.available_to) && selectedCard.available_to
                                    ? ` — ${formatDate(selectedCard.available_to)}`
                                    : ' onwards'}
                            </p>
                        </div>
                    )}

                    {/* Skills */}
                    {selectedCard.skills.length > 0 && (
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-2">
                                Seeking:
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {selectedCard.skills.map((skill) => (
                                    <span
                                        key={skill}
                                        className="px-3 py-1.5 rounded-full bg-emerald-500/10 text-xs text-emerald-200/70 border border-emerald-500/15"
                                    >
                                        {skill}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Bio */}
                    {selectedCard.bio && (
                        <div>
                            <h3 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-2">📝 About</h3>
                            <p className="text-sm text-white/60 leading-relaxed whitespace-pre-wrap">
                                {selectedCard.bio}
                            </p>
                        </div>
                    )}

                    <aside className="rounded-2xl border border-sky-400/15 bg-sky-500/[0.06] p-3 text-xs leading-relaxed text-sky-100/70">
                        <p className="font-bold text-sky-100/85">Privacy first</p>
                        <p className="mt-1">
                            Exact vessel location and contact details remain private. Send an introduction first;
                            private chat appears only after both sailors choose to connect.
                        </p>
                    </aside>
                </div>

                {/* Private chat is deliberately unavailable until the introduction is mutual. */}
                <div className="mt-6 sticky bottom-4">
                    {matchedUserIds.has(selectedCard.user_id) ? (
                        <button
                            aria-label={`View accepted introduction with ${selectedCard.display_name}`}
                            onClick={onOpenIntroductions}
                            className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-600 text-base font-bold text-white shadow-xl shadow-emerald-500/20 transition-all active:scale-[0.97]"
                        >
                            ✓ Connected · View introduction
                        </button>
                    ) : (
                        <button
                            aria-label={
                                likedUsers.has(selectedCard.user_id)
                                    ? `Withdraw introduction request for ${selectedCard.display_name}`
                                    : `Send introduction to ${selectedCard.display_name}`
                            }
                            onClick={() => onLike(selectedCard)}
                            className={`w-full py-4 rounded-2xl text-base font-bold transition-all active:scale-[0.97] ${likedUsers.has(selectedCard.user_id) ? 'border border-emerald-400/20 bg-emerald-500/[0.10] text-emerald-100' : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-xl shadow-emerald-500/20'}`}
                        >
                            {likedUsers.has(selectedCard.user_id)
                                ? '✓ Introduction sent — awaiting their choice'
                                : '✉️ Send introduction'}
                        </button>
                    )}
                </div>
            </div>
        );
    },
);

CrewDetailView.displayName = 'CrewDetailView';
