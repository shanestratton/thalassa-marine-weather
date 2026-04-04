/**
 * CrewDetailView — Full profile detail view for crew listings
 *
 * Extracted from LonelyHeartsPage to reduce file size.
 */

import React from 'react';
import { CrewFinderState } from '../../hooks/useCrewFinderState';
import { CrewCard } from '../../services/LonelyHeartsService';

interface CrewDetailViewProps {
    selectedCard: CrewCard;
    state: CrewFinderState;
    onBack: () => void;
    onLike: (card: CrewCard) => void;
    onOpenDM: (userId: string, name: string) => void;
    matchedUserIds: Set<string>;
    formatDate: (iso: string | null) => string;
    isOpenEnded: (iso: string | null) => boolean;
    trackMessagedUser: (userId: string) => void;
}

export const CrewDetailView: React.FC<CrewDetailViewProps> = React.memo(
    ({ selectedCard, state, onBack, onLike, onOpenDM, matchedUserIds, formatDate, isOpenEnded, trackMessagedUser }) => {
        const { likedUsers, messagedUsers } = state;

        return (
            <div className="px-4 py-5">
                {/* Back button */}
                <button
                    aria-label="Go back"
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white/60 mb-4 transition-colors"
                >
                    ← Back to listings
                </button>

                {/* Profile header */}
                <div className="text-center mb-6">
                    <div className="w-28 h-28 mx-auto rounded-2xl overflow-hidden border-3 border-white/[0.08] shadow-2xl mb-4">
                        {selectedCard.avatar_url ? (
                            <img
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
                    {selectedCard.age_range && <p className="text-sm text-white/35 mb-1">{selectedCard.age_range}</p>}
                    {selectedCard.listing_type && (
                        <span
                            className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${selectedCard.listing_type === 'seeking_crew' ? 'bg-emerald-500/15 text-emerald-300/80' : 'bg-amber-500/15 text-amber-300/80'}`}
                        >
                            {selectedCard.listing_type === 'seeking_crew' ? '⚓ Captain' : '🧭 Crew'}
                        </span>
                    )}
                </div>

                {/* Info cards */}
                <div className="space-y-4">
                    {/* Quick facts */}
                    <div className="grid grid-cols-2 gap-2">
                        {selectedCard.home_port && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Home Port
                                </p>
                                <p className="text-sm text-white/70">🏠 {selectedCard.home_port}</p>
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
                        {selectedCard.gender && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Gender
                                </p>
                                <p className="text-sm text-white/70">{selectedCard.gender}</p>
                            </div>
                        )}
                        {selectedCard.age_range && (
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 mb-0.5">
                                    Age
                                </p>
                                <p className="text-sm text-white/70">{selectedCard.age_range}</p>
                            </div>
                        )}
                        {selectedCard.vibe.length > 0 && (
                            <div className="p-3 rounded-xl bg-purple-500/5 border border-purple-500/10">
                                <p className="text-[11px] font-bold uppercase tracking-wider text-purple-300/40 mb-0.5">
                                    Vibe
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
                </div>

                {/* Action bar */}
                <div className="flex gap-3 mt-6 sticky bottom-4">
                    {matchedUserIds.has(selectedCard.user_id) ? (
                        <button
                            aria-label="Messaged User"
                            onClick={() => {
                                trackMessagedUser(selectedCard.user_id);
                                onOpenDM(selectedCard.user_id, selectedCard.display_name);
                            }}
                            disabled={messagedUsers.has(selectedCard.user_id)}
                            className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-xl ${messagedUsers.has(selectedCard.user_id) ? 'bg-white/[0.04] text-white/40 cursor-not-allowed shadow-none' : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'}`}
                        >
                            {messagedUsers.has(selectedCard.user_id) ? '✓ Message Sent' : '💬 Send Message'}
                        </button>
                    ) : (
                        <div className="flex-1 py-4 rounded-2xl text-center bg-white/[0.03] border border-white/[0.06]">
                            <span className="text-sm text-white/30 font-medium">
                                {likedUsers.has(selectedCard.user_id)
                                    ? '⏳ Waiting for them to star you back'
                                    : '⭐ Star them to connect'}
                            </span>
                        </div>
                    )}
                    <button
                        aria-label="Like this item"
                        onClick={() => onLike(selectedCard)}
                        className={`w-16 rounded-2xl flex items-center justify-center text-2xl transition-all active:scale-90 border ${likedUsers.has(selectedCard.user_id) ? 'bg-amber-500/20 border-amber-400/30' : 'bg-white/[0.03] border-white/[0.06]'}`}
                    >
                        ⭐
                    </button>
                </div>
            </div>
        );
    },
);

CrewDetailView.displayName = 'CrewDetailView';
