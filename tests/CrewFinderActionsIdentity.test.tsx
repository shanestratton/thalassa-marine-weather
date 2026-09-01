import type React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewCard, CrewIntroRequest, CrewProfile } from '../services/LonelyHeartsService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const crewService = vi.hoisted(() => ({
    currentUserId: null as string | null,
    init: vi.fn(),
    getCrewIntroRequests: vi.fn(),
    getCrewProfile: vi.fn(),
    getCrewListBlockedUserIds: vi.fn(),
    updateLastActive: vi.fn(),
    getCrewListings: vi.fn(),
    updateCrewProfile: vi.fn(),
    updateCrewListState: vi.fn(),
    submitCrewProfileForReview: vi.fn(),
    uploadCrewPhoto: vi.fn(),
    removeCrewPhotoAtIndex: vi.fn(),
    sendCrewIntroRequest: vi.fn(),
    withdrawCrewIntroRequest: vi.fn(),
    respondToCrewIntroRequest: vi.fn(),
    blockCrewListUser: vi.fn(),
    reportCrewListUser: vi.fn(),
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

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
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

function intro(
    id: string,
    senderId: string,
    recipientId: string,
    status: CrewIntroRequest['status'] = 'pending',
): CrewIntroRequest {
    return {
        id,
        sender_id: senderId,
        recipient_id: recipientId,
        message: '',
        status,
        created_at: '2026-07-27T00:00:00.000Z',
        responded_at: status === 'accepted' || status === 'declined' ? '2026-07-27T00:01:00.000Z' : null,
        withdrawn_at: status === 'withdrawn' ? '2026-07-27T00:01:00.000Z' : null,
    };
}

function useHarness() {
    const crewState = useCrewFinderState();
    const actions = useCrewFinderActions(crewState.state, crewState.dispatch);
    return { ...crewState, actions };
}

function useHarnessWithPublicationReady(publicationReady: boolean) {
    const crewState = useCrewFinderState();
    const actions = useCrewFinderActions(crewState.state, crewState.dispatch, { publicationReady });
    return { ...crewState, actions };
}

function useHarnessWithPublicationState(publicationState: 'checking' | 'ready' | 'blocked' | 'unavailable') {
    const crewState = useCrewFinderState();
    const actions = useCrewFinderActions(crewState.state, crewState.dispatch, { publicationState });
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
        crewService.getCrewIntroRequests.mockResolvedValue([]);
        crewService.getCrewProfile.mockResolvedValue(null);
        crewService.getCrewListBlockedUserIds.mockResolvedValue([]);
        crewService.updateLastActive.mockResolvedValue(undefined);
        crewService.getCrewListings.mockResolvedValue([]);
        crewService.updateCrewProfile.mockResolvedValue(true);
        crewService.updateCrewListState.mockResolvedValue(true);
        crewService.submitCrewProfileForReview.mockResolvedValue(true);
        crewService.uploadCrewPhoto.mockResolvedValue({ success: true, url: 'https://example.com/photo.jpg' });
        crewService.removeCrewPhotoAtIndex.mockResolvedValue(true);
        crewService.sendCrewIntroRequest.mockResolvedValue(intro('intro-default', 'account-a', 'target'));
        crewService.withdrawCrewIntroRequest.mockResolvedValue(true);
        crewService.respondToCrewIntroRequest.mockResolvedValue(true);
        crewService.blockCrewListUser.mockResolvedValue(true);
        crewService.reportCrewListUser.mockResolvedValue(true);
        crewService.deleteCrewProfile.mockResolvedValue(true);
    });

    it('discards every private A initialization result and initializes B afterwards', async () => {
        const introsA = deferred<CrewIntroRequest[]>();
        const profileA = deferred<CrewProfile | null>();
        const blockedA = deferred<string[]>();

        crewService.getCrewIntroRequests.mockReturnValueOnce(introsA.promise).mockResolvedValue([]);
        crewService.getCrewProfile
            .mockReturnValueOnce(profileA.promise)
            .mockResolvedValue(profile('account-b', 'Profile B'));
        crewService.getCrewListBlockedUserIds.mockReturnValueOnce(blockedA.promise).mockResolvedValue(['blocked-b']);

        const rendered = renderHook(() => useHarness());
        await waitFor(() => expect(crewService.getCrewIntroRequests).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        expect(rendered.result.current.state.introductions).toEqual([]);
        expect(rendered.result.current.state.matches).toEqual([]);
        expect(rendered.result.current.state.profile.first_name).toBe('Profile B');
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set(['blocked-b']));
        expect(rendered.result.current.state.superLikeUsed).toBe(false);

        introsA.resolve([intro('private-intro-a', 'account-a', 'private-target-a')]);
        profileA.resolve(profile('account-a', 'Private Profile A'));
        blockedA.resolve(['private-block-a']);
        await act(async () => Promise.all([introsA.promise, profileA.promise, blockedA.promise]));
        expect(rendered.result.current.state.introductions).toEqual([]);
        expect(rendered.result.current.state.matches).toEqual([]);
        expect(rendered.result.current.state.profile.first_name).toBe('Profile B');
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set(['blocked-b']));
        expect(rendered.result.current.state.superLikeUsed).toBe(false);
    });

    it('does not project participant-readable pending or accepted introductions for blocked counterparts', async () => {
        crewService.getCrewIntroRequests.mockResolvedValue([
            intro('pending-blocked', 'account-a', 'blocked-pending'),
            intro('accepted-blocked', 'blocked-accepted', 'account-a', 'accepted'),
        ]);
        crewService.getCrewListBlockedUserIds.mockResolvedValue(['blocked-pending', 'blocked-accepted']);
        crewService.getCrewProfile.mockImplementation(async (userId: string) => profile(userId, `Sailor ${userId}`));

        const rendered = await renderReady();

        expect(rendered.result.current.state.introductions).toEqual([]);
        expect(rendered.result.current.state.matches).toEqual([]);
        expect(rendered.result.current.state.likedUsers).toEqual(new Set());
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set(['blocked-pending', 'blocked-accepted']));
        expect(crewService.getCrewProfile).toHaveBeenCalledWith('account-a');
        expect(crewService.getCrewProfile).not.toHaveBeenCalledWith('blocked-pending');
        expect(crewService.getCrewProfile).not.toHaveBeenCalledWith('blocked-accepted');
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
        // `!` — HTMLInputElement.files is typed FileList | null, and TS cannot see
        // through the Object.defineProperty above that sets it. The test itself
        // put the file there, so it is non-null by construction.
        expect(crewService.uploadCrewPhoto).toHaveBeenCalledWith(input.files![0], { persistPrimary: true });
        expect(uploadIdentity).toBe('account-a');

        act(() => setAuthIdentityScope('account-b'));
        uploadA.resolve({ success: true, url: 'https://example.com/private-a.jpg' });
        await act(async () => pending);

        expect(rendered.result.current.state.editPhotos).toEqual([]);
        expect(rendered.result.current.state.photoError).toBe('');
        expect(rendered.result.current.state.uploadingPhotoIdx).toBeNull();
    });

    it('drops a late A introduction request and never toasts it under B', async () => {
        const rendered = await renderReady();
        const introductionA = deferred<CrewIntroRequest | null>();
        crewService.sendCrewIntroRequest.mockReturnValueOnce(introductionA.promise);
        toastMocks.success.mockClear();

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleLike(card('target', 'Target Sailor'));
        });
        await waitFor(() => expect(crewService.sendCrewIntroRequest).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        introductionA.resolve(intro('intro-a', 'account-a', 'target'));
        await act(async () => pending);

        expect(rendered.result.current.state.likedUsers).toEqual(new Set());
        expect(rendered.result.current.state.matches).toEqual([]);
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops a late A Crew List block response before it can alter B', async () => {
        const rendered = await renderReady();
        const blockA = deferred<boolean>();
        crewService.blockCrewListUser.mockReturnValueOnce(blockA.promise);
        toastMocks.success.mockClear();

        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleBlock('target-a', 'Target A');
        });
        await waitFor(() => expect(crewService.blockCrewListUser).toHaveBeenCalledTimes(1));

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
        crewService.reportCrewListUser.mockReturnValueOnce(reportA.promise);
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_SHOW_REPORT_MODAL', payload: 'target-a' });
            rendered.result.current.dispatch({ type: 'SET_REPORT_REASON', payload: 'Unsafe conduct' });
        });
        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.actions.handleReport();
        });
        await waitFor(() => expect(crewService.reportCrewListUser).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        reportA.resolve(true);
        await act(async () => pending);

        expect(crewService.blockCrewListUser).toHaveBeenCalledTimes(1);
        expect(rendered.result.current.state.blockedUserIds).toEqual(new Set());
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops a late A noted introduction and its success toast under B', async () => {
        const rendered = await renderReady();
        const introductionA = deferred<CrewIntroRequest | null>();
        crewService.sendCrewIntroRequest.mockReturnValueOnce(introductionA.promise);
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
        await waitFor(() => expect(crewService.sendCrewIntroRequest).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        introductionA.resolve(intro('intro-a', 'account-a', 'target-a'));
        await act(async () => pending);

        expect(rendered.result.current.state.superLikeUsed).toBe(false);
        expect(rendered.result.current.state.likedUsers).toEqual(new Set());
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops late A response and withdrawal completions before they can expose private chat under B', async () => {
        const rendered = await renderReady();
        const responseA = deferred<boolean>();
        crewService.respondToCrewIntroRequest.mockReturnValueOnce(responseA.promise);
        toastMocks.success.mockClear();

        let pendingResponse!: Promise<void>;
        act(() => {
            pendingResponse = rendered.result.current.actions.handleRespondToIntroduction('intro-a', 'accepted');
        });
        await waitFor(() => expect(crewService.respondToCrewIntroRequest).toHaveBeenCalledWith('intro-a', 'accepted'));

        act(() => setAuthIdentityScope('account-b'));
        responseA.resolve(true);
        await act(async () => pendingResponse);

        expect(rendered.result.current.state.matches).toEqual([]);
        expect(rendered.result.current.state.introductions).toEqual([]);
        expect(toastMocks.success).not.toHaveBeenCalled();

        act(() => setAuthIdentityScope('account-a'));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        const withdrawalA = deferred<boolean>();
        crewService.withdrawCrewIntroRequest.mockReturnValueOnce(withdrawalA.promise);

        let pendingWithdrawal!: Promise<void>;
        act(() => {
            pendingWithdrawal = rendered.result.current.actions.handleWithdrawIntroduction('intro-a');
        });
        await waitFor(() => expect(crewService.withdrawCrewIntroRequest).toHaveBeenCalledWith('intro-a'));

        act(() => setAuthIdentityScope('account-b'));
        withdrawalA.resolve(true);
        await act(async () => pendingWithdrawal);

        expect(rendered.result.current.state.matches).toEqual([]);
        expect(rendered.result.current.state.introductions).toEqual([]);
        expect(toastMocks.success).not.toHaveBeenCalled();
    });

    it('drops late A save and delete completions without changing B profile UI', async () => {
        const rendered = await renderReady();
        const saveA = deferred<boolean>();
        crewService.updateCrewProfile.mockReturnValueOnce(saveA.promise);
        toastMocks.success.mockClear();
        toastMocks.error.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: 'seeking_crew' });
            rendered.result.current.dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: 'Sailor A' });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_PHOTOS',
                payload: ['https://example.com/headshot.jpg'],
            });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_BIO',
                payload: 'An experienced sailor looking for a thoughtful coastal passage.',
            });
        });

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

    it('saves a complete private draft without opting in or submitting before account checks pass', async () => {
        const rendered = renderHook(() => useHarnessWithPublicationReady(false));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        crewService.getCrewProfile.mockResolvedValue(profile('account-a', 'Sailor A'));
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: 'seeking_crew' });
            rendered.result.current.dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: 'Sailor A' });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_PHOTOS',
                payload: ['https://example.com/headshot.jpg'],
            });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_BIO',
                payload: 'An experienced sailor looking for a thoughtful coastal passage.',
            });
        });

        await act(async () => rendered.result.current.actions.handleSaveProfile());

        expect(crewService.updateCrewProfile).toHaveBeenCalledTimes(1);
        expect(crewService.updateCrewListState).not.toHaveBeenCalled();
        expect(crewService.submitCrewProfileForReview).not.toHaveBeenCalled();
        expect(toastMocks.success).toHaveBeenCalledWith(
            'Private draft saved — verify your email and mobile before publishing',
        );
    });

    it('does not mutate a profile while the current account trust check is unknown', async () => {
        const rendered = renderHook(() => useHarnessWithPublicationState('checking'));
        await waitFor(() => expect(rendered.result.current.state.loading).toBe(false));
        toastMocks.error.mockClear();

        await act(async () => rendered.result.current.actions.handleSaveProfile());

        expect(crewService.updateCrewProfile).not.toHaveBeenCalled();
        expect(crewService.updateCrewListState).not.toHaveBeenCalled();
        expect(crewService.submitCrewProfileForReview).not.toHaveBeenCalled();
        expect(toastMocks.error).toHaveBeenCalledWith(
            'Still checking your account verification — try again in a moment',
        );
    });

    it('reports the authoritative automatic-publication outcome after reloading the profile', async () => {
        const rendered = await renderReady();
        crewService.getCrewProfile.mockReset();
        crewService.getCrewProfile
            .mockResolvedValueOnce({
                ...profile('account-a', 'Sailor A'),
                approval_status: 'draft',
                verification_status: 'unverified',
                crew_list_visibility: 'private',
            })
            .mockResolvedValueOnce({
                ...profile('account-a', 'Sailor A'),
                approval_status: 'approved',
                verification_status: 'verified',
                crew_list_visibility: 'visible',
            });
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: 'seeking_crew' });
            rendered.result.current.dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: 'Sailor A' });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_PHOTOS',
                payload: ['https://example.com/headshot.jpg'],
            });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_BIO',
                payload: 'An experienced sailor looking for a thoughtful coastal passage.',
            });
        });
        await act(async () => rendered.result.current.actions.handleSaveProfile());

        expect(crewService.updateCrewListState).toHaveBeenCalledWith({
            community_enabled: true,
            crew_intents: ['find_crew'],
            crew_list_visibility: 'private',
        });
        expect(crewService.submitCrewProfileForReview).toHaveBeenCalledTimes(1);
        expect(toastMocks.success).toHaveBeenCalledWith('Crew List profile published — you are live');
    });

    it('keeps an uncertain automatic result private and describes the human fallback', async () => {
        const rendered = await renderReady();
        crewService.getCrewProfile.mockReset();
        crewService.getCrewProfile
            .mockResolvedValueOnce({
                ...profile('account-a', 'Sailor A'),
                approval_status: 'draft',
                verification_status: 'unverified',
                crew_list_visibility: 'private',
            })
            .mockResolvedValueOnce({
                ...profile('account-a', 'Sailor A'),
                approval_status: 'pending',
                verification_status: 'pending',
                crew_list_visibility: 'private',
            });
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: 'seeking_berth' });
            rendered.result.current.dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: 'Sailor A' });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_PHOTOS',
                payload: ['https://example.com/headshot.jpg'],
            });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_BIO',
                payload: 'An experienced sailor looking for a thoughtful coastal passage.',
            });
        });
        await act(async () => rendered.result.current.actions.handleSaveProfile());

        expect(crewService.submitCrewProfileForReview).toHaveBeenCalledTimes(1);
        expect(toastMocks.success).toHaveBeenCalledWith(
            'Changes saved privately — the safety check needs a closer look',
        );
    });

    it('does not rerun publication for an unchanged profile that remains live', async () => {
        const rendered = await renderReady();
        crewService.getCrewProfile.mockReset();
        crewService.getCrewProfile.mockResolvedValueOnce({
            ...profile('account-a', 'Sailor A'),
            approval_status: 'approved',
            verification_status: 'verified',
            crew_list_visibility: 'visible',
        });
        toastMocks.success.mockClear();

        act(() => {
            rendered.result.current.dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: 'seeking_crew' });
            rendered.result.current.dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: 'Sailor A' });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_PHOTOS',
                payload: ['https://example.com/headshot.jpg'],
            });
            rendered.result.current.dispatch({
                type: 'SET_EDIT_BIO',
                payload: 'An experienced sailor looking for a thoughtful coastal passage.',
            });
        });
        await act(async () => rendered.result.current.actions.handleSaveProfile());

        expect(crewService.updateCrewListState).not.toHaveBeenCalled();
        expect(crewService.submitCrewProfileForReview).not.toHaveBeenCalled();
        expect(toastMocks.success).toHaveBeenCalledWith('Crew List profile saved — your listing remains live');
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
