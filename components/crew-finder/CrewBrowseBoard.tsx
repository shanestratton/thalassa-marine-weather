/**
 * CrewBrowseBoard — discreet browse surface for Crew List introductions
 *
 * Extracted from LonelyHeartsPage to reduce file size.
 * Receives state + dispatch from parent with action callbacks.
 */

import React, { useCallback } from 'react';
import { CrewFinderState, CrewFinderAction } from '../../hooks/useCrewFinderState';
import { CrewCard, ListingType } from '../../services/LonelyHeartsService';
import { COUNTRIES, getStatesForCountry } from '../../data/locationData';
import { EmptyState } from '../ui/EmptyState';
import { SafeImage } from '../ui/SafeImage';

interface CrewListApprovalFields {
    approval_status?: string | null;
    verification_status?: string | null;
}

interface CrewBrowseBoardProps {
    state: CrewFinderState;
    dispatch: React.Dispatch<CrewFinderAction>;
    onApplyFilters: () => void;
    onClearFilters: () => void;
    onLike: (card: CrewCard) => void;
    onBlock: (userId: string, displayName: string) => void;
    onReport: () => void;
    onSuperLike: () => void;
    onOpenIntroductions: () => void;
    goToNextCard: () => void;
    goToPrevCard: () => void;
    goToStart: () => void;
    handleCardTouchStart: (e: React.TouchEvent) => void;
    handleCardTouchMove: (e: React.TouchEvent) => void;
    handleCardTouchEnd: () => void;
    matchedUserIds: Set<string>;
    formatDate: (iso: string | null) => string;
    isOpenEnded: (iso: string | null) => boolean;
}

const selectStyle = {
    backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")",
    backgroundRepeat: 'no-repeat' as const,
    backgroundPosition: 'right 12px center',
    backgroundSize: '20px',
};

export const CrewBrowseBoard: React.FC<CrewBrowseBoardProps> = React.memo(
    ({
        state,
        dispatch,
        onApplyFilters,
        onLike,
        onBlock,
        onOpenIntroductions,
        goToNextCard,
        goToPrevCard,
        goToStart,
        handleCardTouchStart,
        handleCardTouchMove,
        handleCardTouchEnd,
        matchedUserIds,
        formatDate,
        isOpenEnded,
    }) => {
        const {
            listings,
            filterListingType,
            filterLocationCountry,
            filterLocationState,
            hasSearched,
            showActionMenu,
            superLikeUsed,
            currentCardIndex,
            cardPhotoIndex,
            swipeX,
            swipeDirection,
            likedUsers,
        } = state;

        // Helper setters via dispatch
        const setFilterListingType = useCallback(
            (v: ListingType | '') => dispatch({ type: 'SET_FILTER_LISTING_TYPE', payload: v }),
            [dispatch],
        );
        const setFilterLocationCountry = useCallback(
            (v: string) => dispatch({ type: 'SET_FILTER_LOCATION_COUNTRY', payload: v }),
            [dispatch],
        );
        const setFilterLocationState = useCallback(
            (v: string) => dispatch({ type: 'SET_FILTER_LOCATION_STATE', payload: v }),
            [dispatch],
        );
        const setCardPhotoIndex = useCallback(
            (fn: (p: number) => number) =>
                dispatch({ type: 'SET_CARD_PHOTO_INDEX', payload: fn(state.cardPhotoIndex) }),
            [dispatch, state.cardPhotoIndex],
        );
        const setShowActionMenu = useCallback(
            (v: string | null) => dispatch({ type: 'SET_SHOW_ACTION_MENU', payload: v }),
            [dispatch],
        );
        const setShowReportModal = useCallback(
            (v: string | null) => dispatch({ type: 'SET_SHOW_REPORT_MODAL', payload: v }),
            [dispatch],
        );
        const setShowSuperLikeModal = useCallback(
            (v: CrewCard | null) => dispatch({ type: 'SET_SHOW_SUPER_LIKE_MODAL', payload: v }),
            [dispatch],
        );
        const setSuperLikeMessage = useCallback(
            (v: string) => dispatch({ type: 'SET_SUPER_LIKE_MESSAGE', payload: v }),
            [dispatch],
        );
        const setHasSearched = useCallback(
            (v: boolean) => dispatch({ type: 'SET_HAS_SEARCHED', payload: v }),
            [dispatch],
        );
        const setListings = useCallback((v: CrewCard[]) => dispatch({ type: 'SET_LISTINGS', payload: v }), [dispatch]);
        const setCurrentCardIndex = useCallback(
            (v: number) => dispatch({ type: 'SET_CURRENT_CARD_INDEX', payload: v }),
            [dispatch],
        );

        return (
            <div className="px-4 py-4 pb-44 flex flex-col min-h-full">
                {/* Filters — hidden after search */}
                {!hasSearched && (
                    <>
                        <section
                            aria-labelledby="crew-list-browse-title"
                            className="mb-4 rounded-3xl border border-sky-400/15 bg-gradient-to-br from-sky-500/[0.08] to-emerald-500/[0.06] p-4"
                        >
                            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-sky-200/65">
                                The Crew List
                            </p>
                            <h2 id="crew-list-browse-title" className="mt-1 text-base font-black text-white">
                                Who would you like to sail with?
                            </h2>
                            <p className="mt-1 text-xs leading-relaxed text-white/55">
                                Choose an introduction path and, if useful, a broad area. Exact vessel locations and
                                contact details stay private until both people choose to connect.
                            </p>
                        </section>
                        <p className="text-xs font-black text-white/40 uppercase tracking-widest mb-2">
                            Introduction path
                        </p>
                        <div className="grid grid-cols-2 gap-3 mb-4">
                            <button
                                aria-pressed={filterListingType === 'seeking_crew'}
                                aria-label="Find a skipper with an open berth"
                                onClick={() =>
                                    setFilterListingType(filterListingType === 'seeking_crew' ? '' : 'seeking_crew')
                                }
                                className={`min-h-[8rem] rounded-2xl px-3 py-4 text-left transition-all border ${filterListingType === 'seeking_crew' ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10' : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'}`}
                            >
                                <span aria-hidden="true" className="text-2xl block mb-1">
                                    ⚓
                                </span>
                                <span
                                    className={`text-sm font-bold block ${filterListingType === 'seeking_crew' ? 'text-emerald-300' : 'text-white/70'}`}
                                >
                                    Find a skipper
                                </span>
                                <span className="mt-1 block text-[11px] leading-snug text-white/40">
                                    Browse skippers with an open berth or passage.
                                </span>
                            </button>
                            <button
                                aria-pressed={filterListingType === 'seeking_berth'}
                                aria-label="Find crew for a vessel or passage"
                                onClick={() =>
                                    setFilterListingType(filterListingType === 'seeking_berth' ? '' : 'seeking_berth')
                                }
                                className={`min-h-[8rem] rounded-2xl px-3 py-4 text-left transition-all border ${filterListingType === 'seeking_berth' ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10' : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'}`}
                            >
                                <span aria-hidden="true" className="text-2xl block mb-1">
                                    🧭
                                </span>
                                <span
                                    className={`text-sm font-bold block ${filterListingType === 'seeking_berth' ? 'text-emerald-300' : 'text-white/70'}`}
                                >
                                    Find crew
                                </span>
                                <span className="mt-1 block text-[11px] leading-snug text-white/40">
                                    Browse sailors looking to join a vessel or passage.
                                </span>
                            </button>
                        </div>

                        {/* Broad-area filters */}
                        <div className="px-6 mb-4">
                            <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-white/40 mb-3">
                                📍 Broad Area (optional)
                            </h3>
                            <div className="space-y-2">
                                <select
                                    value={filterLocationCountry}
                                    onChange={(e) => {
                                        setFilterLocationCountry(e.target.value);
                                        setFilterLocationState('');
                                    }}
                                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500/30 transition-colors appearance-none"
                                    style={selectStyle}
                                >
                                    <option value="" className="bg-[#1a1d2e]">
                                        Any Country
                                    </option>
                                    {COUNTRIES.map((c) => (
                                        <option key={c} value={c} className="bg-[#1a1d2e]">
                                            {c}
                                        </option>
                                    ))}
                                </select>
                                {filterLocationCountry && getStatesForCountry(filterLocationCountry).length > 0 && (
                                    <select
                                        value={filterLocationState}
                                        onChange={(e) => setFilterLocationState(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500/30 transition-colors appearance-none"
                                        style={selectStyle}
                                    >
                                        <option value="" className="bg-[#1a1d2e]">
                                            Any State / Province
                                        </option>
                                        {getStatesForCountry(filterLocationCountry).map((s) => (
                                            <option key={s} value={s} className="bg-[#1a1d2e]">
                                                {s}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {/* Pinned Search CTA */}
                <div
                    className="fixed left-0 right-0 px-4 z-20"
                    style={{ bottom: 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <button
                        aria-label={hasSearched ? 'Change Crew List search' : 'Show selected Crew List introductions'}
                        onClick={() => {
                            if (hasSearched) {
                                setHasSearched(false);
                                setListings([]);
                                setCurrentCardIndex(0);
                                dispatch({ type: 'SET_CARD_PHOTO_INDEX', payload: 0 });
                            } else {
                                onApplyFilters();
                            }
                        }}
                        disabled={!hasSearched && !filterListingType}
                        className={`w-full py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-2xl ${!hasSearched && !filterListingType ? 'bg-white/[0.06] text-white/40 cursor-not-allowed' : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'}`}
                    >
                        {hasSearched ? '↻ Change search' : 'Show Crew List'}
                    </button>
                </div>

                {/* Card Stack */}
                {listings.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-center">
                        {!filterListingType ? (
                            <EmptyState
                                icon="🌊"
                                title="Choose an introduction path"
                                description="Pick Find a skipper or Find crew to see approved sailors who have opted into The Crew List."
                            />
                        ) : (
                            <EmptyState
                                icon="🔍"
                                title="No Crew List profiles yet"
                                description="No approved profiles match this introduction path or broad area yet. Try a wider area soon."
                            />
                        )}
                    </div>
                ) : currentCardIndex >= listings.length ? (
                    <div className="text-center py-20">
                        <EmptyState
                            icon="⚓"
                            title="You are up to date"
                            description={`That is all ${listings.length} ${listings.length === 1 ? 'profile' : 'profiles'} for this Crew List search. Check back for new sailing opportunities.`}
                        />
                        <button
                            aria-label="To Start"
                            onClick={goToStart}
                            className="px-6 py-3 rounded-2xl bg-gradient-to-r from-emerald-500/25 to-sky-500/25 border border-emerald-400/20 text-emerald-300 font-bold text-sm transition-all active:scale-95 mt-4"
                        >
                            ↩ Review profiles
                        </button>
                    </div>
                ) : (
                    <div className="relative">
                        {/* Counter */}
                        <div className="text-center mb-3">
                            <span className="text-xs text-white/50 font-medium">
                                {currentCardIndex + 1} of {listings.length}
                            </span>
                        </div>

                        {/* Swipeable Card */}
                        {(() => {
                            const card = listings[currentCardIndex];
                            const allPhotos =
                                card.photos?.length > 0
                                    ? card.photos
                                    : card.photo_url || card.avatar_url
                                      ? [card.photo_url || card.avatar_url || '']
                                      : [];
                            const isLiked = likedUsers.has(card.user_id);
                            const isMatched = matchedUserIds.has(card.user_id);
                            const broadArea = [card.location_state, card.location_country].filter(Boolean).join(', ');
                            const review = card as CrewCard & CrewListApprovalFields;
                            const isApprovedForCrewList =
                                review.approval_status === 'approved' && review.verification_status === 'verified';
                            const cardRotation = swipeX * 0.03;
                            const cardOpacity = 1 - Math.abs(swipeX) / 400;
                            const exitTransform =
                                swipeDirection === 'left'
                                    ? 'translateX(-120%) rotate(-8deg)'
                                    : swipeDirection === 'right'
                                      ? 'translateX(120%) rotate(8deg)'
                                      : `translateX(${swipeX}px) rotate(${cardRotation}deg)`;

                            return (
                                <div
                                    key={card.user_id}
                                    onTouchStart={handleCardTouchStart}
                                    onTouchMove={handleCardTouchMove}
                                    onTouchEnd={handleCardTouchEnd}
                                    style={{
                                        transform: swipeDirection
                                            ? exitTransform
                                            : `translateX(${swipeX}px) rotate(${cardRotation}deg)`,
                                        opacity: swipeDirection ? 0 : cardOpacity,
                                        transition:
                                            swipeDirection || swipeX === 0
                                                ? 'transform 0.25s ease-out, opacity 0.25s ease-out'
                                                : 'none',
                                    }}
                                    className="rounded-3xl bg-gradient-to-b from-white/[0.04] to-white/[0.01] border border-white/[0.08] overflow-hidden shadow-2xl"
                                >
                                    {/* Large avatar */}
                                    <div className="relative w-full aspect-[4/3] bg-gradient-to-br from-slate-800 to-slate-900 overflow-hidden">
                                        {allPhotos.length > 0 ? (
                                            <>
                                                <SafeImage
                                                    src={allPhotos[cardPhotoIndex % allPhotos.length]}
                                                    alt=""
                                                    className="w-full h-full object-cover"
                                                />
                                                {allPhotos.length > 1 && (
                                                    <>
                                                        <div
                                                            className="absolute top-0 left-0 w-1/2 h-full z-10 cursor-pointer"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setCardPhotoIndex((prev) => Math.max(0, prev - 1));
                                                            }}
                                                        />
                                                        <div
                                                            className="absolute top-0 right-0 w-1/2 h-full z-10 cursor-pointer"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setCardPhotoIndex((prev) =>
                                                                    Math.min(allPhotos.length - 1, prev + 1),
                                                                );
                                                            }}
                                                        />
                                                    </>
                                                )}
                                                {allPhotos.length > 1 && (
                                                    <div className="absolute top-3 left-0 right-0 flex justify-center gap-1.5 z-20">
                                                        {allPhotos.map((_, i) => (
                                                            <div
                                                                key={i}
                                                                className={`rounded-full transition-all ${i === cardPhotoIndex % allPhotos.length ? 'w-2 h-2 bg-white shadow-lg' : 'w-1.5 h-1.5 bg-white/40'}`}
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <span className="text-7xl">
                                                    {card.listing_type === 'seeking_crew' ? '⚓' : '🧭'}
                                                </span>
                                            </div>
                                        )}
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                                        <div className="absolute bottom-0 left-0 right-0 p-5">
                                            <div className="flex items-end justify-between">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <h2 className="text-2xl font-black text-white mb-1">
                                                            {card.display_name}
                                                        </h2>
                                                        {isApprovedForCrewList && (
                                                            <span
                                                                className="w-5 h-5 rounded-full bg-sky-500/30 border border-sky-400/40 flex items-center justify-center text-[11px] text-sky-200"
                                                                aria-label="Approved Crew List profile"
                                                                title="Approved for Crew List"
                                                            >
                                                                ✓
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {card.listing_type && (
                                                            <span
                                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider ${card.listing_type === 'seeking_crew' ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-400/20' : 'bg-amber-500/25 text-amber-300 border border-amber-400/20'}`}
                                                            >
                                                                {card.listing_type === 'seeking_crew'
                                                                    ? '⚓ Seeking crew'
                                                                    : '🧭 Seeking a skipper'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex gap-1.5">
                                                    {isLiked && !isMatched && (
                                                        <span
                                                            className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-sm"
                                                            title="Introduction sent"
                                                        >
                                                            ✓
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Card body */}
                                    <div className="p-5 space-y-4">
                                        <div className="flex flex-wrap gap-2">
                                            {broadArea && (
                                                <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">
                                                    📍 {broadArea}
                                                </span>
                                            )}
                                            {card.sailing_region && (
                                                <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">
                                                    ⛵ {card.sailing_region}
                                                </span>
                                            )}
                                            {card.sailing_experience && (
                                                <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">
                                                    🧭 {card.sailing_experience}
                                                </span>
                                            )}
                                            {card.vibe.length > 0 && (
                                                <span className="px-3 py-1.5 rounded-xl bg-purple-500/10 text-xs text-purple-200/70 border border-purple-500/15">
                                                    {card.vibe.join(' · ')}
                                                </span>
                                            )}
                                            {card.languages.length > 0 && (
                                                <span className="px-3 py-1.5 rounded-xl bg-sky-500/10 text-xs text-sky-200/70 border border-sky-500/15">
                                                    {card.languages.map((l) => l.split(' ')[0]).join(' ')}
                                                </span>
                                            )}
                                        </div>
                                        {card.skills.length > 0 && (
                                            <div>
                                                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/50 mb-1.5">
                                                    Skills
                                                </p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {card.skills.map((skill) => (
                                                        <span
                                                            key={skill}
                                                            className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-xs text-emerald-200/70 border border-emerald-500/15"
                                                        >
                                                            {skill}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        {(card.available_from ||
                                            (card.available_to && !isOpenEnded(card.available_to))) && (
                                            <div className="flex items-center gap-1.5 text-xs text-emerald-400/60">
                                                <span>📅</span>
                                                {card.available_from && isOpenEnded(card.available_to) ? (
                                                    <span>Available from {formatDate(card.available_from)}</span>
                                                ) : (
                                                    <>
                                                        {card.available_from && (
                                                            <span>From {formatDate(card.available_from)}</span>
                                                        )}
                                                        {card.available_from && card.available_to && <span>—</span>}
                                                        {card.available_to && (
                                                            <span>{formatDate(card.available_to)}</span>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        {card.bio && (
                                            <p className="text-sm text-white/40 leading-relaxed">{card.bio}</p>
                                        )}
                                    </div>

                                    {/* Introductions are mutual before private chat is offered. */}
                                    <div className="px-5 pb-5 flex gap-3">
                                        {isMatched ? (
                                            <button
                                                aria-label={`View accepted introduction with ${card.display_name}`}
                                                onClick={onOpenIntroductions}
                                                className="flex-1 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-600 text-sm font-bold text-white shadow-xl shadow-emerald-500/15 transition-all active:scale-[0.97]"
                                            >
                                                ✓ Connected · View introduction
                                            </button>
                                        ) : (
                                            <button
                                                aria-label={
                                                    isLiked
                                                        ? `Withdraw introduction request for ${card.display_name}`
                                                        : `Send introduction to ${card.display_name}`
                                                }
                                                onClick={() => onLike(card)}
                                                className={`flex-1 py-3.5 rounded-2xl text-sm font-bold transition-all active:scale-[0.97] ${isLiked ? 'border border-emerald-400/20 bg-emerald-500/[0.10] text-emerald-200' : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-xl shadow-emerald-500/15'}`}
                                            >
                                                {isLiked ? '✓ Introduction sent' : '✉️ Send introduction'}
                                            </button>
                                        )}
                                        {!isMatched && !isLiked && !superLikeUsed && (
                                            <button
                                                aria-label={`Add a note to an introduction for ${card.display_name}`}
                                                onClick={() => {
                                                    setShowSuperLikeModal(card);
                                                    setSuperLikeMessage('');
                                                }}
                                                className="w-14 rounded-2xl flex items-center justify-center text-lg transition-all active:scale-90 bg-sky-500/[0.10] border border-sky-400/20 text-sky-200 hover:bg-sky-500/[0.16]"
                                                title="Send an introduction with a note"
                                            >
                                                ✎
                                            </button>
                                        )}
                                        <div className="relative">
                                            <button
                                                aria-label={`Open options for ${card.display_name}`}
                                                onClick={() =>
                                                    setShowActionMenu(
                                                        showActionMenu === card.user_id ? null : card.user_id,
                                                    )
                                                }
                                                className="w-10 rounded-2xl flex items-center justify-center text-lg transition-all active:scale-90 bg-white/[0.03] border border-white/[0.06] text-white/50 hover:text-white/50"
                                            >
                                                ⋮
                                            </button>
                                            {showActionMenu === card.user_id && (
                                                <div className="absolute right-0 bottom-full mb-2 w-40 rounded-xl bg-slate-800 border border-white/10 shadow-2xl overflow-hidden z-50">
                                                    <button
                                                        aria-label={`Block ${card.display_name}`}
                                                        onClick={() => onBlock(card.user_id, card.display_name)}
                                                        className="w-full px-4 py-3 text-left text-sm text-white/60 hover:bg-white/5 transition-colors"
                                                    >
                                                        🚫 Block sailor
                                                    </button>
                                                    <button
                                                        aria-label={`Report ${card.display_name}'s profile`}
                                                        onClick={() => {
                                                            setShowReportModal(card.user_id);
                                                            setShowActionMenu(null);
                                                        }}
                                                        className="w-full px-4 py-3 text-left text-sm text-red-400/60 hover:bg-red-500/10 transition-colors border-t border-white/[0.05]"
                                                    >
                                                        🚩 Report profile
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })()}

                        {/* Navigation buttons */}
                        <div className="fixed left-0 right-0 bottom-0 z-10">
                            <div className="h-8 bg-gradient-to-t from-[#0c1220] to-transparent" />
                            <div
                                className="bg-[#0c1220] px-4"
                                style={{ paddingBottom: 'calc(64px + env(safe-area-inset-bottom) + 72px)' }}
                            >
                                <div className="flex justify-between items-center">
                                    <button
                                        aria-label="Go to previous step"
                                        onClick={goToPrevCard}
                                        disabled={currentCardIndex <= 0}
                                        className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${currentCardIndex <= 0 ? 'text-white/40 cursor-not-allowed' : 'text-white/50 bg-white/[0.03] border border-white/[0.06] active:scale-95'}`}
                                    >
                                        ‹ Previous
                                    </button>
                                    <div className="flex gap-1 items-center">
                                        {listings
                                            .slice(
                                                Math.max(0, currentCardIndex - 3),
                                                Math.min(listings.length, currentCardIndex + 4),
                                            )
                                            .map((_, idx) => {
                                                const actualIdx = Math.max(0, currentCardIndex - 3) + idx;
                                                return (
                                                    <div
                                                        key={actualIdx}
                                                        className={`rounded-full transition-all ${actualIdx === currentCardIndex ? 'w-2.5 h-2.5 bg-emerald-400' : 'w-1.5 h-1.5 bg-white/15'}`}
                                                    />
                                                );
                                            })}
                                        {currentCardIndex + 4 < listings.length && (
                                            <span className="text-[11px] text-white/40 ml-0.5">…</span>
                                        )}
                                    </div>
                                    <button
                                        aria-label="Proceed to next step"
                                        onClick={goToNextCard}
                                        className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white/50 bg-white/[0.03] border border-white/[0.06] transition-all active:scale-95"
                                    >
                                        Next ›
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    },
);

CrewBrowseBoard.displayName = 'CrewBrowseBoard';
