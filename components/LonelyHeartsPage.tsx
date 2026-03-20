/**
 * Find Crew Page — Crew Board & Sailor Connections
 *
 * Pure render shell — all business logic lives in useCrewFinderActions.
 * Sub-components: CrewBrowseBoard, CrewDetailView, CrewProfileForm, CrewMatchesList, CrewModals.
 */

import React from 'react';
import { useCrewFinderState } from '../hooks/useCrewFinderState';
import { useCrewFinderActions } from '../hooks/useCrewFinderActions';
import { CrewProfileForm } from './crew-finder/CrewProfileForm';
import { CrewBrowseBoard } from './crew-finder/CrewBrowseBoard';
import { CrewDetailView } from './crew-finder/CrewDetailView';
import { CrewMatchesList } from './crew-finder/CrewMatchesList';
import { CrewModals } from './crew-finder/CrewModals';
import { toast } from './Toast';

interface LonelyHeartsPageProps {
    onOpenDM: (userId: string, name: string) => void;
}

type FCView = 'board' | 'detail' | 'my_profile' | 'matches';

export const LonelyHeartsPage: React.FC<LonelyHeartsPageProps> = ({ onOpenDM }) => {
    const { state, dispatch } = useCrewFinderState();
    const actions = useCrewFinderActions(state, dispatch);

    const {
        setView,
        setHasSearched,
        setListings,
        setCurrentCardIndex,
        setFilterListingType,
        setFilterGender,
        setFilterAgeRanges,
        fileInputRef,
        myProfileScrollRef,
        applyFilters,
        clearFilters,
        handleSaveProfile,
        handlePhotoUpload,
        handlePhotoRemove,
        handleLike,
        handleBlock,
        handleReport,
        handleSuperLike,
        handleDeleteProfile,
        trackMessagedUser,
        goToNextCard,
        goToPrevCard,
        goToStart,
        handleCardTouchStart,
        handleCardTouchMove,
        handleCardTouchEnd,
        formatDate,
        isOpenEnded,
        getLastActiveLabel,
        getIcebreakers,
        getCompatibility,
        currentUserId,
        matchedUserIds,
    } = actions;

    const { view, loading, listings, matches, selectedCard, profile, editListingType } = state;

    // ── Loading ──
    if (loading && listings.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <div className="w-10 h-10 mx-auto mb-4 border-2 border-emerald-500/30 border-t-teal-500 rounded-full animate-spin" />
                    <p className="text-sm text-white/60">Finding crew nearby...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col">
            {/* Tab bar */}
            <div className="flex-shrink-0 sticky top-0 z-10 flex border-b border-white/[0.04] bg-slate-950">
                {(
                    [
                        { key: 'my_profile' as FCView, label: '📝 My Listing' },
                        { key: 'board' as FCView, label: '🔍 Browse' },
                        {
                            key: 'matches' as FCView,
                            label: `🤝 Connections${matches.length > 0 ? ` (${matches.length})` : ''}`,
                        },
                    ] as const
                ).map((tab) => (
                    <button
                        aria-label="User Id"
                        key={tab.key}
                        onClick={() => {
                            if ((tab.key === 'board' || tab.key === 'matches') && !currentUserId) {
                                toast.error('Sign in first — go to Vessel > Settings > Account');
                                return;
                            }
                            if (tab.key === 'board' && !profile?.listing_type && !editListingType) {
                                setView('my_profile');
                                toast.error('Create your listing first before browsing profiles');
                                return;
                            }
                            setView(tab.key);
                            if (tab.key === 'board') {
                                setHasSearched(false);
                                setListings([]);
                                setCurrentCardIndex(0);
                                setFilterListingType('');
                                setFilterGender('');
                                setFilterAgeRanges([]);
                            }
                        }}
                        className={`flex-1 py-3 text-sm font-semibold transition-colors relative ${view === tab.key ? 'text-emerald-400' : 'text-white/60 hover:text-white/60'}`}
                    >
                        {tab.label}
                        {view === tab.key && (
                            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-emerald-500 to-sky-500 rounded-full" />
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className={`flex-1 ${view !== 'my_profile' ? 'pb-24' : ''}`}>
                {/* ══════ BROWSE BOARD ══════ */}
                {view === 'board' && (
                    <CrewBrowseBoard
                        state={state}
                        dispatch={dispatch}
                        onApplyFilters={applyFilters}
                        onClearFilters={clearFilters}
                        onLike={handleLike}
                        onBlock={handleBlock}
                        onReport={handleReport}
                        onSuperLike={handleSuperLike}
                        onOpenDM={onOpenDM}
                        goToNextCard={goToNextCard}
                        goToPrevCard={goToPrevCard}
                        goToStart={goToStart}
                        handleCardTouchStart={handleCardTouchStart}
                        handleCardTouchMove={handleCardTouchMove}
                        handleCardTouchEnd={handleCardTouchEnd}
                        matchedUserIds={matchedUserIds}
                        getLastActiveLabel={getLastActiveLabel}
                        formatDate={formatDate}
                        isOpenEnded={isOpenEnded}
                        trackMessagedUser={trackMessagedUser}
                    />
                )}

                {/* ══════ DETAIL VIEW ══════ */}
                {view === 'detail' && selectedCard && (
                    <CrewDetailView
                        selectedCard={selectedCard}
                        state={state}
                        onBack={() => setView('board')}
                        onLike={handleLike}
                        onOpenDM={onOpenDM}
                        matchedUserIds={matchedUserIds}
                        formatDate={formatDate}
                        isOpenEnded={isOpenEnded}
                        trackMessagedUser={trackMessagedUser}
                    />
                )}

                {/* ══════ MY PROFILE / LISTING ══════ */}
                {view === 'my_profile' && (
                    <CrewProfileForm
                        state={state}
                        dispatch={dispatch}
                        onSaveProfile={handleSaveProfile}
                        onPhotoUpload={handlePhotoUpload}
                        onPhotoRemove={handlePhotoRemove}
                        onDeleteProfile={handleDeleteProfile}
                        myProfileScrollRef={myProfileScrollRef}
                        fileInputRef={fileInputRef}
                    />
                )}

                {/* ══════ MATCHES ══════ */}
                {view === 'matches' && (
                    <CrewMatchesList
                        matches={matches}
                        onOpenDM={onOpenDM}
                        getCompatibility={getCompatibility}
                        getIcebreakers={getIcebreakers}
                    />
                )}
            </div>

            {/* Modals */}
            <CrewModals
                state={state}
                dispatch={dispatch}
                onReport={handleReport}
                onSuperLike={handleSuperLike}
                onDeleteProfile={handleDeleteProfile}
            />
        </div>
    );
};
