/**
 * The Crew List — discreet skipper / crew introductions
 *
 * Pure render shell — all business logic lives in useCrewFinderActions.
 * Sub-components: CrewBrowseBoard, CrewDetailView, CrewProfileForm, CrewMatchesList, CrewModals.
 */

import React from 'react';
import { useCrewFinderState, type CrewListIntroduction } from '../hooks/useCrewFinderState';
import { useCrewFinderActions } from '../hooks/useCrewFinderActions';
import { useCrewListConversation } from '../hooks/useCrewListConversation';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../services/authIdentityScope';
import { CrewProfileForm } from './crew-finder/CrewProfileForm';
import { CrewBrowseBoard } from './crew-finder/CrewBrowseBoard';
import { CrewDetailView } from './crew-finder/CrewDetailView';
import { CrewMatchesList } from './crew-finder/CrewMatchesList';
import { CrewListConversation } from './crew-finder/CrewListConversation';
import { CrewModals } from './crew-finder/CrewModals';
import { toast } from './Toast';
import { EditIcon, SearchIcon, ChatIcon } from './Icons';

type FCView = 'board' | 'detail' | 'my_profile' | 'matches';

interface ActiveCrewListIntroduction {
    introduction: CrewListIntroduction;
    identityKey: string;
    identityGeneration: number;
}

export const LonelyHeartsPage: React.FC = () => {
    const { state, dispatch } = useCrewFinderState();
    const actions = useCrewFinderActions(state, dispatch);
    const identityScope = React.useSyncExternalStore(
        (onStoreChange) => subscribeAuthIdentityScope(() => onStoreChange()),
        getAuthIdentityScope,
        getAuthIdentityScope,
    );
    const [activeIntroduction, setActiveIntroduction] = React.useState<ActiveCrewListIntroduction | null>(null);

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
        handlePauseCrewList,
        handlePhotoUpload,
        handlePhotoRemove,
        handleLike,
        handleBlock,
        handleReport,
        handleSuperLike,
        handleRespondToIntroduction,
        handleWithdrawIntroduction,
        handleDeleteProfile,
        goToNextCard,
        goToPrevCard,
        goToStart,
        handleCardTouchStart,
        handleCardTouchMove,
        handleCardTouchEnd,
        formatDate,
        isOpenEnded,
        currentUserId,
        matchedUserIds,
    } = actions;

    const { view, loading, listings, introductions, selectedCard, profile } = state;
    const activeIntroductionIsCurrent =
        activeIntroduction?.identityKey === identityScope.key &&
        activeIntroduction.identityGeneration === identityScope.generation;
    const currentActiveIntroduction = activeIntroductionIsCurrent
        ? introductions.find(
              (introduction) => introduction.request.id === activeIntroduction!.introduction.request.id,
          ) || activeIntroduction!.introduction
        : null;
    const conversation = useCrewListConversation(currentActiveIntroduction?.request.id || null);
    const isApprovedForCrewList =
        profile?.community_enabled === true &&
        profile.approval_status === 'approved' &&
        profile.verification_status === 'verified';
    const introductionCount = introductions.filter(
        (introduction) =>
            introduction.request.status === 'accepted' ||
            (introduction.direction === 'received' && introduction.request.status === 'pending'),
    ).length;

    if (currentActiveIntroduction) {
        const partnerName = currentActiveIntroduction.counterpart?.display_name || 'Crew List connection';
        return (
            <CrewListConversation
                partnerName={partnerName}
                messages={conversation.messages}
                currentUserId={currentUserId || ''}
                draft={conversation.draft}
                loading={conversation.loading}
                unavailable={conversation.unavailable}
                sending={conversation.sending}
                onDraftChange={conversation.setDraft}
                onSend={conversation.send}
                onBack={() => {
                    setActiveIntroduction(null);
                    setView('matches');
                }}
            />
        );
    }

    // ── Loading ──
    if (loading && listings.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <div className="w-10 h-10 mx-auto mb-4 border-2 border-emerald-500/30 border-t-teal-500 rounded-full animate-spin" />
                    <p className="text-sm text-white/60">Opening The Crew List...</p>
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
                        { key: 'my_profile' as FCView, label: 'My profile', Icon: EditIcon },
                        { key: 'board' as FCView, label: 'Crew List', Icon: SearchIcon },
                        {
                            key: 'matches' as FCView,
                            label: `Introductions${introductionCount > 0 ? ` (${introductionCount})` : ''}`,
                            Icon: ChatIcon,
                        },
                    ] as const
                ).map((tab) => (
                    <button
                        aria-label={`Open ${tab.label}`}
                        key={tab.key}
                        onClick={() => {
                            setActiveIntroduction(null);
                            if ((tab.key === 'board' || tab.key === 'matches') && !currentUserId) {
                                toast.error('Sign in first — go to Vessel > Settings > Account');
                                return;
                            }
                            if (tab.key === 'board' && !isApprovedForCrewList) {
                                setView('my_profile');
                                toast.error(
                                    'Your Crew List profile must be approved before you can browse or send introductions',
                                );
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
                        className={`flex-1 py-3 text-sm font-semibold transition-colors relative inline-flex items-center justify-center gap-1.5 ${view === tab.key ? 'text-emerald-400' : 'text-white/60 hover:text-white/60'}`}
                    >
                        <tab.Icon className="w-4 h-4" />
                        <span>{tab.label}</span>
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
                        onOpenIntroductions={() => setView('matches')}
                        goToNextCard={goToNextCard}
                        goToPrevCard={goToPrevCard}
                        goToStart={goToStart}
                        handleCardTouchStart={handleCardTouchStart}
                        handleCardTouchMove={handleCardTouchMove}
                        handleCardTouchEnd={handleCardTouchEnd}
                        matchedUserIds={matchedUserIds}
                        formatDate={formatDate}
                        isOpenEnded={isOpenEnded}
                    />
                )}

                {/* ══════ DETAIL VIEW ══════ */}
                {view === 'detail' && selectedCard && (
                    <CrewDetailView
                        selectedCard={selectedCard}
                        state={state}
                        onBack={() => setView('board')}
                        onLike={handleLike}
                        onOpenIntroductions={() => setView('matches')}
                        matchedUserIds={matchedUserIds}
                        formatDate={formatDate}
                        isOpenEnded={isOpenEnded}
                    />
                )}

                {/* ══════ MY PROFILE / LISTING ══════ */}
                {view === 'my_profile' && (
                    <CrewProfileForm
                        state={state}
                        dispatch={dispatch}
                        onSaveProfile={handleSaveProfile}
                        onPauseCrewList={handlePauseCrewList}
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
                        introductions={introductions}
                        onOpenConversation={(introduction) =>
                            setActiveIntroduction({
                                introduction,
                                identityKey: identityScope.key,
                                identityGeneration: identityScope.generation,
                            })
                        }
                        onRespondIntroduction={handleRespondToIntroduction}
                        onWithdrawIntroduction={handleWithdrawIntroduction}
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
