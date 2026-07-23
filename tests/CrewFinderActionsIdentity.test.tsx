import type React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewCard, CrewProfile, SailorMatch } from '../services/LonelyHeartsService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const crewService = vi.hoisted(() => ({
    currentUserId: null as string | null,
    init: vi.fn(),
    getMatches: vi.fn(),
    getCrewProfile: vi.fn(),
    getBlockedUserIds: vi.fn(),
    hasSuperLikedToday: vi.fn(),
    updateLastActive: vi.fn(),
    getCrewListings: vi.fn(),
    updateCrewProfile: vi.fn(),
    uploadCrewPhoto: vi.fn(),
    recordLike: vi.fn(),
    blockUser: vi.fn(),
    reportUser: vi.fn(),
    recordSuperLike: vi.fn(),
    deleteCrewProfile: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock('../services/LonelyHeartsService', () => ({
    LonelyHeartsService: crewService,
}));

vi.mock('../components/Toast', () => ({
    toast: toastMocks,
}));

vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => ({ lat: null, lon: null }),
    },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { useCrewFinderActions } from '../hooks/useCrewFinderActions';
import { useCrewFinderState } from '../hooks/useCrewFinderState';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function card(userId: string, displayName = userId): CrewCard {
    return { user_id: userId, display_name: displayName } as CrewCard;
}

function profile(userId: string, firstName: string): CrewProfile {
    return { user_id: userId, first_name: firstName } as CrewProfile;
}

function match(userId: string): SailorMatch {
    return { user_id: userId, display_name: userId } as SailorMatch;
}

function useHarness() {
    const crewState = useCrewFinderState();
    const actions = useCrewFinderActions(crewState.state, crewState.dispatch);
    return { ...crewState, actions };
}

async function renderReady() {
    const rendered = renderHook(() => useHarness());
    await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
    return rendered;
}

describe('Crew Finder async identity fencing', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();

        crewService.currentUserId = 'account-a';
        crewService.init.mockImplementation(async () => {
            crewService.currentUserId = getAuthIdentityScope().userId;
        });
        crewService.getMatches.mockResolvedValue([]);
        crewService.getCrewProfile.mockResolvedValue(null);
        crewService.getBlockedUserIds.mockResolvedValue([]);
        crewService.hasSuperLikedToday.mockResolvedValue(false);
        crewService.updateLastActive.mockResolvedValue(undefined);
        crewService.getCrewListings.mockResolvedValue([]);
        crewService.updateCrewProfile.mockResolvedValue(true);
        crewService.uploadCrewPhoto.mockResolvedValue({ success: true, url: 'https://example.com/photo.jpg' });
        crewService.recordLike.mockResolvedValue({ matched: false });
        crewService.blockUser.mockResolvedValue(true);
        crewService.reportUser.mockResolvedValue(true);
        crewService.recordSuperLike.mockResolvedValue({ matched: false });
        crewService.deleteCrewProfile.mockResolvedValue(true);
    });

    it('discards every private A initialization result and initializes B afterwards', async () => {
        const matchesA = deferred<SailorMatch[]>();
        const profileA = deferred<CrewProfile | null>();
        const blockedA = deferred<string[]>();
        const superLikeA = deferred<boolean>();

        crewService.getMatches.mockReturnValueOnce(matchesA.promise).mockResolvedValue([match('match-b')]);
        crewService.getCrewProfile
            .mockReturnValueOnce(profileA.promise)
            .mockResolvedValue(profile('account-b', 'Profile B'));
        crewService.getBlockedUserIds.mockReturnValueOnce(blockedA.promise).mockResolvedValue(['blocked-b']);
        crewService.hasSuperLikedToday.mockReturnValueOnce(superLikeA.promise).mockResolvedValue(true);

        const rendered = renderHook(() => useHarness());
        await waitFor(() => expect(crewService.getMatches).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        expect(rendered.result.current.state.matches.map((item) => item.user_id)).toEqual(['match-b']);
        expect(rendered.result.current.state.profile.first_name).toBe('Profile B');
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set(['blocked-b']));
        expect(rendered.result.current.state.superLikeUsed).toBe(true);

        matchesA.resolve([match('private-match-a')]);
        profileA.resolve(profile('account-a', 'Private Profile A'));
        blockedA.resolve(['private-block-a']);
        superLikeA.resolve(false);
        await act(async () => Promise.all([matchesA.promise, profileA.promise, blockedA.promise, superLikeA.promise]));
        expect(rendered.result.current.state.matches.map((item) => item.user_id)).toEqual(['match-b']);
        expect(rendered.result.current.state.profile.first_name).toBe('Profile B');
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set(['blocked-b']));
        expect(rendered.result.current.state.superLikeUsed).toBe(true);
    });

    it('does not let a late A listing search populate B or complete A search UI', async () => {
        const rendered = await renderReady();
        const listingsA = deferred<CrewCard[]>();
        crewService.getCrewListings.mockReturnValueOnce(listingsA.promise);

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.applyFilters();
        });
        await waitFor(() => expect(crewService.getCrewListings).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        listingsA.resolve([card('private-listing-a')]);
        await act(async () => pending);
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));

        expect(rendered.result.current.state.listings).toEqual([]);
        expect(rendered.result.current.state.hasSearched).toBe(false);
    });

    it('drops a late A photo upload without touching B photo state', async () => {
        const rendered = await renderReady();
        const uploadA = deferred<{ success: boolean; url?: string }>();
        let uploadIdentity: string | null = null;
        crewService.uploadCrewPhoto.mockImplementationOnce(function (this: { currentUserId: string | null }) {
            uploadIdentity = this.currentUserId;
            return uploadA.promise;
        });
        const input = document.createElement('input');
        Object.defineProperty(input, 'files', {
            value: [new File(['photo'], 'crew.jpg', { type: 'image/jpeg' })],
        });

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handlePhotoUpload({
                target: input,
            } as React.ChangeEvent<HTMLInputElement>);
        });
        await waitFor(() => expect(crewService.uploadCrewPhoto).toHaveBeenCalledTimes(1));
        expect(uploadIdentity).toBe('account-a');

        act(() => setAuthIdentityScope('account-b'));
        uploadA.resolve({ success: true, url: 'https://example.com/private-a.jpg' });
        await act(async () => pending);

        expect(rendered.result.current.state.editPhotos).toEqual([]);
        expect(rendered.result.current.state.photoError).toBe('');
        expect(rendered.result.current.state.uploadingPhotoIdx).toBeNull();
    });

    it('drops a late A match result and never toasts it under B', async () => {
        const rendered = await renderReady();
        const likeA = deferred<{ matched: boolean }>();
        crewService.recordLike.mockReturnValueOnce(likeA.promise);
        toastMocks.success.mockClear();

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleLike(card('target', 'Target Sailor'));
        });
        await waitFor(() => expect(crewService.recordLike).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        likeA.resolve({ matched: true });
        await act(async () => pending);

        expect(rendered.result.current.state.likedUsers).toEqual(new Set());
        expect(rendered.result.current.state.matches).toEqual([]);
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops a direct late A block response before it can alter B', async () => {
        const rendered = await renderReady();
        const blockA = deferred<boolean>();
        crewService.blockUser.mockReturnValueOnce(blockA.promise);
        toastMocks.success.mockClear();

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleBlock('target-a', 'Target A');
        });
        await waitFor(() => expect(crewService.blockUser).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        blockA.resolve(true);
        await act(async () => pending);

        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set());
        expect(rendered.result.current.state.listings).toEqual([]);
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops late A block and report responses before mutating or toasting B', async () => {
        const rendered = await renderReady();
        const reportA = deferred<boolean>();
        crewService.reportUser.mockReturnValueOnce(reportA.promise);
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_SHOW_REPORT_MODAL', payload: 'target-a' });
            rendered.result.current.dispatch({ type: 'SET_REPORT_REASON', payload: 'Unsafe conduct' });
        });
        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleReport();
        });
        await waitFor(() => expect(crewService.reportUser).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        reportA.resolve(true);
        await act(async () => pending);

        expect(crewService.blockUser).not.toHaveBeenCalled();
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set());
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops a late A super-like response and its success toast under B', async () => {
        const rendered = await renderReady();
        const superLikeA = deferred<{ matched: boolean }>();
        crewService.recordSuperLike.mockReturnValueOnce(superLikeA.promise);
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({
                type: 'SET_SHOW_SUPER_LIKE_MODAL',
                payload: card('target-a', 'Target A'),
            });
            rendered.result.current.dispatch({ type: 'SET_SUPER_LIKE_MESSAGE', payload: 'Sail together?' });
        });
        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleSuperLike();
        });
        await waitFor(() => expect(crewService.recordSuperLike).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        superLikeA.resolve({ matched: true });
        await act(async () => pending);

        expect(rendered.result.current.state.superLikeUsed).toBe(false);
        expect(rendered.result.current.state.likedUsers).toEqual(new Set());
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops late A save and delete completions without changing B profile UI', async () => {
        const rendered = await renderReady();
        const saveA = deferred<boolean>();
        crewService.updateCrewProfile.mockReturnValueOnce(saveA.promise);
        toastMocks.success.mockClear();
        toastMocks.error.mockClear();

        let pendingSave!: Promise<void>;
        act(() => {
            pendingSave = rendered.result.current.actions.handleSaveProfile();
        });
        await waitFor(() => expect(crewService.updateCrewProfile).toHaveBeenCalledTimes(1));
        act(() => setAuthIdentityScope('account-b'));
        saveA.resolve(true);
        await act(async () => pendingSave);

        expect(rendered.result.current.state.saved).toBe(false);
        expect(rendered.result.current.state.profile).toEqual({});
        expect(toastMocks.success).not.toHaveBeenCalled();
        expect(toastMocks.error).not.toHaveBeenCalled();

        act(() => setAuthIdentityScope('account-a'));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        const deleteA = deferred<boolean>();
        crewService.deleteCrewProfile.mockReturnValueOnce(deleteA.promise);

        let pendingDelete!: Promise<void>;
        act(() => {
            pendingDelete = rendered.result.current.actions.handleDeleteProfile();
        });
        await waitFor(() => expect(crewService.deleteCrewProfile).toHaveBeenCalledTimes(1));
        act(() => setAuthIdentityScope('account-b'));
        deleteA.resolve(true);
        await act(async () => pendingDelete);

        expect(rendered.result.current.state.view).toBe('my_profile');
        expect(rendered.result.current.state.profile).toEqual({});
        expect(toastMocks.success).not.toHaveBeenCalled();
        expect(toastMocks.error).not.toHaveBeenCalled();
    });

    it('cancels an A swipe-completion timer at the identity boundary', async () => {
        const rendered = await renderReady();
        vi.useFakeTimers();
        try {
            act(() => {
                rendered.result.current.dispatch({
                    type: 'SET_LISTINGS',
                    payload: [card('one'), card('two')],
                });
            });
            act(() => rendered.result.current.actions.goToNextCard());
            expect(rendered.result.current.state.isAnimating).toBe(true);

            act(() => setAuthIdentityScope('account-b'));
            act(() => vi.advanceTimersByTime(300));
            vi.useRealTimers();
            await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));

            expect(rendered.result.current.state.currentCardIndex).toBe(0);
            expect(rendered.result.current.state.isAnimating).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
