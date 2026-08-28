/**
 * useCrewFinderActions — All business logic for the Crew Finder
 *
 * Extracted from LonelyHeartsPage to reduce the component to a pure render shell.
 * Contains: setter shims, effects (init, keyboard, GPS auto-fill), search/filter,
 * profile save, photo upload, like/block/report/super-like, swipe gestures,
 * compatibility scoring, icebreakers, helpers.
 */

import { useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { createLogger } from '../utils/createLogger';
import { CrewFinderState, CrewFinderAction, CrewListIntroduction } from './useCrewFinderState';
import {
    LonelyHeartsService,
    CrewCard,
    CrewIntroRequest,
    SailorMatch,
    CrewProfile,
    CrewSearchFilters,
    ListingType,
} from '../services/LonelyHeartsService';
import { toast } from '../components/Toast';
import { triggerHaptic } from '../utils/system';
import { LocationStore } from '../stores/LocationStore';
import { useKeyboardOffset } from './useKeyboardOffset';
import React from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const log = createLogger('CrewFinderActions');

type ScopedServiceResult<T> = { status: 'current'; value: T } | { status: 'stale' } | { status: 'unauthenticated' };

type CrewFinderServiceInternals = {
    currentUserId: string | null;
};

/**
 * LonelyHeartsService stores its user ID on `this`. Give every logical
 * operation an identity-bound facade so an A upload cannot start with A,
 * await compression, then resume with the singleton's newly initialized B ID.
 * Object.create preserves all service methods while shadowing only the mutable
 * identity field; operations for B can begin immediately without waiting for a
 * slow or hung A request.
 */
function serviceForIdentity(scope: AuthIdentityScope): typeof LonelyHeartsService {
    const scopedService = Object.create(LonelyHeartsService) as typeof LonelyHeartsService;
    (scopedService as unknown as CrewFinderServiceInternals).currentUserId = scope.userId;
    return scopedService;
}

async function runForIdentity<T>(
    scope: AuthIdentityScope,
    operation: (service: typeof LonelyHeartsService) => Promise<T>,
): Promise<ScopedServiceResult<T>> {
    if (!isAuthIdentityScopeCurrent(scope)) return { status: 'stale' };
    if (!scope.userId) return { status: 'unauthenticated' };

    const value = await operation(serviceForIdentity(scope));
    if (!isAuthIdentityScopeCurrent(scope)) return { status: 'stale' };
    return { status: 'current', value };
}

function subscribeIdentitySnapshot(onStoreChange: () => void): () => void {
    return subscribeAuthIdentityScope(() => onStoreChange());
}

/** Turn the deliberately limited Crew List profile into the card shape used by
 * the existing browsing and accepted-introduction views.  Never hydrate a
 * counterpart from chat-profile data: Crew List visibility is its own opt-in
 * boundary. */
function crewProfileToCard(profile: CrewProfile): CrewCard {
    const broadArea = [profile.location_state, profile.location_country].filter(Boolean).join(', ') || null;
    const photos = profile.photos.length > 0 ? [...profile.photos] : profile.photo_url ? [profile.photo_url] : [];
    return {
        user_id: profile.user_id,
        display_name: profile.first_name || 'Crew List sailor',
        avatar_url: profile.photo_url,
        vessel_name: null,
        home_port: broadArea,
        listing_type: profile.listing_type,
        crew_intents: [...profile.crew_intents],
        first_name: profile.first_name,
        photo_url: profile.photo_url,
        gender: null,
        age_range: null,
        has_partner: false,
        partner_details: null,
        skills: [...profile.skills],
        sailing_experience: profile.sailing_experience,
        sailing_region: profile.sailing_region,
        available_from: profile.available_from,
        available_to: profile.available_to,
        bio: profile.bio,
        vibe: [...profile.vibe],
        languages: [...profile.languages],
        smoking: profile.smoking,
        drinking: profile.drinking,
        pets: profile.pets,
        interests: [...profile.interests],
        last_active: profile.last_active,
        is_verified: profile.approval_status === 'approved' && profile.verification_status === 'verified',
        approval_status: profile.approval_status,
        verification_status: profile.verification_status,
        // A town/harbour remains an owner-only profile field.  Keep the
        // in-memory card shape deliberately broad as a second line of
        // defence if an older backend ever returns more than the public
        // Crew List projection.
        location_city: null,
        location_state: profile.location_state,
        location_country: profile.location_country,
        photos,
    };
}

function crewCardToAcceptedMatch(card: CrewCard, acceptedAt: string): SailorMatch {
    const broadArea = [card.location_state, card.location_country].filter(Boolean).join(', ') || null;
    return {
        user_id: card.user_id,
        display_name: card.display_name,
        dating_first_name: card.first_name,
        dating_photos: [...card.photos],
        avatar_url: card.avatar_url,
        vessel_name: card.vessel_name,
        // Accepted introductions do not imply consent to share an exact port.
        home_port: broadArea,
        interests: [...card.interests],
        vibe: [...card.vibe],
        languages: [...card.languages],
        smoking: card.smoking,
        drinking: card.drinking,
        pets: card.pets,
        sailing_experience: card.sailing_experience,
        matched_at: acceptedAt,
    };
}

async function hydrateCrewIntroductions(
    service: typeof LonelyHeartsService,
    ownerId: string,
    requests: CrewIntroRequest[],
    blockedUserIds: ReadonlySet<string> = new Set(),
): Promise<{ introductions: CrewListIntroduction[]; matches: SailorMatch[]; sentPendingUserIds: Set<string> }> {
    const participantRequests = requests.filter((request) => {
        if (request.sender_id !== ownerId && request.recipient_id !== ownerId) return false;
        const counterpartId = request.sender_id === ownerId ? request.recipient_id : request.sender_id;
        return !blockedUserIds.has(counterpartId);
    });
    const candidates = participantRequests.map((request) =>
        request.sender_id === ownerId ? request.recipient_id : request.sender_id,
    );
    const counterpartIds = [...new Set(candidates)];
    const profiles = await Promise.all(
        counterpartIds.map(async (userId) => [userId, await service.getCrewProfile(userId)] as const),
    );
    const cards = new Map<string, CrewCard>();
    for (const [userId, profile] of profiles) {
        if (profile) cards.set(userId, crewProfileToCard(profile));
    }

    const introductions = participantRequests.map((request) => {
        const direction = request.sender_id === ownerId ? 'sent' : 'received';
        const counterpartId = direction === 'sent' ? request.recipient_id : request.sender_id;
        return { request, counterpart: cards.get(counterpartId) ?? null, direction } satisfies CrewListIntroduction;
    });
    const matches = introductions
        .filter((introduction) => introduction.request.status === 'accepted' && introduction.counterpart)
        .map((introduction) =>
            crewCardToAcceptedMatch(
                introduction.counterpart!,
                introduction.request.responded_at || introduction.request.created_at,
            ),
        );
    const sentPendingUserIds = new Set(
        introductions
            .filter((introduction) => introduction.direction === 'sent' && introduction.request.status === 'pending')
            .map((introduction) => introduction.request.recipient_id),
    );

    return { introductions, matches, sentPendingUserIds };
}

// ────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────

interface CrewFinderActionOptions {
    /**
     * Server-backed account checks required before a private draft may enter
     * the automatic publication check. Optional for isolated callers/tests.
     */
    publicationReady?: boolean;
    publicationState?: 'checking' | 'ready' | 'blocked' | 'unavailable';
}

export function useCrewFinderActions(
    state: CrewFinderState,
    dispatch: React.Dispatch<CrewFinderAction>,
    options: CrewFinderActionOptions = {},
) {
    const publicationState = options.publicationState ?? (options.publicationReady === false ? 'blocked' : 'ready');
    const publicationReady = publicationState === 'ready';
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);
    const {
        view,
        listings,
        filters,
        filterListingType,
        filterSkills,
        filterExperience,
        filterRegion,
        filterLocationCountry,
        filterLocationState,
        showReportModal,
        reportReason,
        showSuperLikeModal,
        superLikeMessage,
        profile,
        editListingType,
        editFirstName,
        editHasPartner,
        editPartnerDetails,
        editSkills,
        editExperience,
        editRegion,
        editAvailFrom,
        editAvailTo,
        editBio,
        editVibe,
        editLanguages,
        editSmoking,
        editDrinking,
        editPets,
        editInterests,
        editLocationCity,
        editLocationState,
        editLocationCountry,
        editPhotos,
        pendingPhotoIdx,
        currentCardIndex,
        swipeX,
        isAnimating,
    } = state;

    // ── Setter shims ──
    const setView = useCallback((v: CrewFinderState['view']) => dispatch({ type: 'SET_VIEW', payload: v }), [dispatch]);
    const setLoading = useCallback((v: boolean) => dispatch({ type: 'SET_LOADING', payload: v }), [dispatch]);
    const setListings = useCallback(
        (v: CrewCard[] | ((prev: CrewCard[]) => CrewCard[])) => {
            dispatch({ type: 'SET_LISTINGS', payload: typeof v === 'function' ? v(state.listings) : v });
        },
        [dispatch, state.listings],
    );
    const setFilters = useCallback((v: CrewSearchFilters) => dispatch({ type: 'SET_FILTERS', payload: v }), [dispatch]);
    const setFilterListingType = useCallback(
        (v: ListingType | '') => dispatch({ type: 'SET_FILTER_LISTING_TYPE', payload: v }),
        [dispatch],
    );
    const setFilterGender = useCallback((v: string) => dispatch({ type: 'SET_FILTER_GENDER', payload: v }), [dispatch]);
    const setFilterAgeRanges = useCallback(
        (v: string[] | ((prev: string[]) => string[])) =>
            dispatch({
                type: 'SET_FILTER_AGE_RANGES',
                payload: typeof v === 'function' ? v(state.filterAgeRanges) : v,
            }),
        [dispatch, state.filterAgeRanges],
    );
    const setShowFilters = useCallback((v: boolean) => dispatch({ type: 'SET_SHOW_FILTERS', payload: v }), [dispatch]);
    const setHasSearched = useCallback((v: boolean) => dispatch({ type: 'SET_HAS_SEARCHED', payload: v }), [dispatch]);
    const setBlockedUserIds = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) =>
            dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: typeof v === 'function' ? v(state.blockedUserIds) : v }),
        [dispatch, state.blockedUserIds],
    );
    const setShowReportModal = useCallback(
        (v: string | null) => dispatch({ type: 'SET_SHOW_REPORT_MODAL', payload: v }),
        [dispatch],
    );
    const setReportReason = useCallback((v: string) => dispatch({ type: 'SET_REPORT_REASON', payload: v }), [dispatch]);
    const setShowActionMenu = useCallback(
        (v: string | null) => dispatch({ type: 'SET_SHOW_ACTION_MENU', payload: v }),
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
    const setSuperLikeUsed = useCallback(
        (v: boolean) => dispatch({ type: 'SET_SUPER_LIKE_USED', payload: v }),
        [dispatch],
    );
    const setSaving = useCallback((v: boolean) => dispatch({ type: 'SET_SAVING', payload: v }), [dispatch]);
    const setSaved = useCallback((v: boolean) => dispatch({ type: 'SET_SAVED', payload: v }), [dispatch]);
    const setEditPhotos = useCallback(
        (v: string[] | ((prev: string[]) => string[])) =>
            dispatch({ type: 'SET_EDIT_PHOTOS', payload: typeof v === 'function' ? v(state.editPhotos) : v }),
        [dispatch, state.editPhotos],
    );
    const setUploadingPhotoIdx = useCallback(
        (v: number | null) => dispatch({ type: 'SET_UPLOADING_PHOTO_IDX', payload: v }),
        [dispatch],
    );
    const setPhotoError = useCallback((v: string) => dispatch({ type: 'SET_PHOTO_ERROR', payload: v }), [dispatch]);
    const setEditLocationCity = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_LOCATION_CITY', payload: v }),
        [dispatch],
    );
    const setEditLocationState = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_LOCATION_STATE', payload: v }),
        [dispatch],
    );
    const setEditLocationCountry = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_LOCATION_COUNTRY', payload: v }),
        [dispatch],
    );
    const setKbHeight = useCallback((v: number) => dispatch({ type: 'SET_KB_HEIGHT', payload: v }), [dispatch]);
    const keyboardHeight = useKeyboardOffset(view === 'my_profile');
    const setCurrentCardIndex = useCallback(
        (v: number | ((prev: number) => number)) =>
            dispatch({
                type: 'SET_CURRENT_CARD_INDEX',
                payload: typeof v === 'function' ? v(state.currentCardIndex) : v,
            }),
        [dispatch, state.currentCardIndex],
    );
    const setCardPhotoIndex = useCallback(
        (v: number | ((prev: number) => number)) =>
            dispatch({ type: 'SET_CARD_PHOTO_INDEX', payload: typeof v === 'function' ? v(state.cardPhotoIndex) : v }),
        [dispatch, state.cardPhotoIndex],
    );
    const setSwipeX = useCallback((v: number) => dispatch({ type: 'SET_SWIPE_X', payload: v }), [dispatch]);
    // ── Refs ──
    const fileInputRef = useRef<HTMLInputElement>(null);
    const myProfileScrollRef = useRef<HTMLDivElement>(null);
    const swipeStartX = useRef(0);
    const swipeStartY = useRef(0);
    const isSwipeTracking = useRef(false);
    const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
    const delayedCallbacks = useRef<Set<number>>(new Set());

    const clearDelayedCallbacks = useCallback(() => {
        for (const timer of delayedCallbacks.current) window.clearTimeout(timer);
        delayedCallbacks.current.clear();
    }, []);

    const scheduleForIdentity = useCallback((scope: AuthIdentityScope, callback: () => void, delayMs: number) => {
        const timer = window.setTimeout(() => {
            delayedCallbacks.current.delete(timer);
            if (isAuthIdentityScopeCurrent(scope)) callback();
        }, delayMs);
        delayedCallbacks.current.add(timer);
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeAuthIdentityScope(() => {
            clearDelayedCallbacks();
            if (fileInputRef.current) fileInputRef.current.value = '';
        });
        return () => {
            unsubscribe();
            clearDelayedCallbacks();
        };
    }, [clearDelayedCallbacks]);

    // ── Keyboard height detection ──
    useEffect(() => {
        setKbHeight(keyboardHeight);
    }, [keyboardHeight, setKbHeight]);

    // ── Init ──
    useEffect(() => {
        const scope = identityScope;
        let active = true;
        if (!scope.userId) {
            setLoading(false);
            return;
        }

        void runForIdentity(scope, async (service) => {
            const [introRequests, loadedProfile, blocked] = await Promise.all([
                service.getCrewIntroRequests(),
                service.getCrewProfile(scope.userId!),
                service.getCrewListBlockedUserIds(),
                service.updateLastActive(),
            ]);
            const hydratedIntroductions = await hydrateCrewIntroductions(
                service,
                scope.userId!,
                introRequests,
                new Set(blocked),
            );
            return { hydratedIntroductions, loadedProfile, blocked };
        })
            .then((result) => {
                if (!active || result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
                dispatch({ type: 'SET_INTRODUCTIONS', payload: result.value.hydratedIntroductions.introductions });
                dispatch({ type: 'SET_MATCHES', payload: result.value.hydratedIntroductions.matches });
                dispatch({ type: 'SET_LIKED_USERS', payload: result.value.hydratedIntroductions.sentPendingUserIds });
                if (result.value.loadedProfile) {
                    dispatch({ type: 'LOAD_PROFILE', payload: result.value.loadedProfile });
                }
                dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: new Set(result.value.blocked) });
                dispatch({ type: 'SET_SUPER_LIKE_USED', payload: false });
                dispatch({ type: 'SET_LOADING', payload: false });
            })
            .catch((error) => {
                if (!active || !isAuthIdentityScopeCurrent(scope)) return;
                log.warn('Crew Finder initialization failed:', error);
                dispatch({ type: 'SET_LOADING', payload: false });
            });

        return () => {
            active = false;
        };
        // Setter shims deliberately stay out of this dependency list; dispatch
        // is stable and the auth generation is the lifecycle boundary.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identityScope.generation, dispatch]);

    // ── Auto-fill location from GPS ──
    useEffect(() => {
        const scope = identityScope;
        if (editLocationCity || editLocationState || editLocationCountry) return;
        if (view !== 'my_profile') return;
        const loc = LocationStore.getState();
        if (!loc.lat || !loc.lon) return;
        const controller = new AbortController();
        void (async () => {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${loc.lat}&lon=${loc.lon}&format=json&zoom=10&addressdetails=1`,
                    {
                        headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' },
                        signal: controller.signal,
                    },
                );
                if (!res.ok || !isAuthIdentityScopeCurrent(scope)) return;
                const data = await res.json();
                if (!isAuthIdentityScopeCurrent(scope)) return;
                const addr = data.address || {};
                const city = addr.city || addr.town || addr.village || addr.suburb || addr.municipality || '';
                const st = addr.state || addr.region || addr.county || '';
                const country = addr.country || '';
                if (city) setEditLocationCity(city);
                if (st) setEditLocationState(st);
                if (country) setEditLocationCountry(country);
            } catch {
                /* GPS or network unavailable */
            }
        })();
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, editLocationCity, editLocationState, editLocationCountry, identityScope.generation]);

    // ── Data loading ──
    const loadListings = useCallback(
        async (f?: CrewSearchFilters, scope: AuthIdentityScope = getAuthIdentityScope()): Promise<boolean> => {
            try {
                const result = await runForIdentity(scope, (service) => service.getCrewListings(f || filters));
                if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return false;
                dispatch({ type: 'SET_LISTINGS', payload: result.value });
                return true;
            } catch (error) {
                if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew listings load failed:', error);
                return false;
            }
        },
        [dispatch, filters],
    );

    /** Reload the authoritative database state after a request is sent,
     * accepted, declined, or withdrawn.  Pending outbound IDs and accepted
     * chat access are derived from that state—not local optimistic flags. */
    const refreshIntroductions = useCallback(
        async (scope: AuthIdentityScope = getAuthIdentityScope()): Promise<boolean> => {
            if (!scope.userId) return false;
            try {
                const result = await runForIdentity(scope, async (service) => {
                    const [requests, blocked] = await Promise.all([
                        service.getCrewIntroRequests(),
                        service.getCrewListBlockedUserIds(),
                    ]);
                    const hydrated = await hydrateCrewIntroductions(service, scope.userId!, requests, new Set(blocked));
                    return { ...hydrated, blocked };
                });
                if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return false;
                dispatch({ type: 'SET_INTRODUCTIONS', payload: result.value.introductions });
                dispatch({ type: 'SET_MATCHES', payload: result.value.matches });
                dispatch({ type: 'SET_LIKED_USERS', payload: result.value.sentPendingUserIds });
                dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: new Set(result.value.blocked) });
                return true;
            } catch (error) {
                if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew List introductions load failed:', error);
                return false;
            }
        },
        [dispatch],
    );

    // ── Search ──
    const applyFilters = async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const f: CrewSearchFilters = {};
        if (filterListingType) f.listing_type = filterListingType;
        if (filterSkills.length > 0) f.skills = filterSkills;
        if (filterExperience) f.experience = filterExperience;
        if (filterRegion) f.region = filterRegion;
        if (filterLocationCountry) f.location_country = filterLocationCountry;
        if (filterLocationState) f.location_state = filterLocationState;
        // Discovery is intentionally limited to state/province and country.
        // Do not carry a legacy town filter into the public query.
        setFilters(f);
        setLoading(true);
        const loaded = await loadListings(f, scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        setLoading(false);
        if (!loaded) return;
        setShowFilters(false);
        setHasSearched(true);
    };

    const clearFilters = async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        dispatch({ type: 'CLEAR_FILTERS' });
        setLoading(true);
        await loadListings({}, scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        setLoading(false);
    };

    // ── Save Profile ──
    const handleSaveProfile = async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) {
            toast.error('Sign in first — go to Vessel > Settings > Account');
            return;
        }
        if (publicationState === 'checking' || publicationState === 'unavailable') {
            toast.error(
                publicationState === 'checking'
                    ? 'Still checking your account verification — try again in a moment'
                    : 'Could not check your account verification — retry the trust check first',
            );
            return;
        }
        const intent =
            editListingType === 'seeking_crew'
                ? 'find_crew'
                : editListingType === 'seeking_berth'
                  ? 'find_skipper'
                  : null;
        if (!intent || !editFirstName.trim() || !editPhotos[0] || editBio.trim().length < 20) {
            toast.error('Add your intent, first name, clear primary headshot and a short bio before publishing');
            return;
        }

        const updates = {
            listing_type: (editListingType as ListingType) || null,
            first_name: editFirstName.trim() || null,
            has_partner: editHasPartner,
            partner_details: editHasPartner ? editPartnerDetails.trim() || null : null,
            skills: editSkills,
            sailing_experience: editExperience || null,
            sailing_region: editRegion.trim() || null,
            location_city: editLocationCity.trim() || null,
            location_state: editLocationState.trim() || null,
            location_country: editLocationCountry.trim() || null,
            available_from: editAvailFrom || null,
            available_to: editAvailTo || null,
            bio: editBio.trim() || null,
            vibe: editVibe,
            languages: editLanguages,
            smoking: editSmoking || null,
            drinking: editDrinking || null,
            pets: editPets || null,
            interests: editInterests,
        };

        setSaving(true);
        try {
            const result = await runForIdentity(scope, async (service) => {
                const profileSaved = await service.updateCrewProfile(updates);
                if (!profileSaved || !isAuthIdentityScopeCurrent(scope)) {
                    return { outcome: 'failed' as const, profileSaved, loadedProfile: null };
                }

                // Saving an unchanged live profile must never hide it or run a
                // redundant check. The database demotes genuinely material
                // edits so their exact new snapshot is checked again.
                const profileAfterSave = await service.getCrewProfile(scope.userId!);
                if (!profileAfterSave || !isAuthIdentityScopeCurrent(scope)) {
                    return { outcome: 'failed' as const, profileSaved, loadedProfile: null };
                }
                // Profile fields are always safe to save as a private draft.
                // Publication waits for verified email and mobile status.
                if (!publicationReady) {
                    return { outcome: 'draft_saved' as const, profileSaved, loadedProfile: profileAfterSave };
                }
                if (
                    profileAfterSave.approval_status === 'approved' &&
                    profileAfterSave.verification_status === 'verified' &&
                    profileAfterSave.crew_list_visibility === 'visible'
                ) {
                    return { outcome: 'live' as const, profileSaved, loadedProfile: profileAfterSave };
                }
                if (profileAfterSave.approval_status === 'pending') {
                    return { outcome: 'manual_review' as const, profileSaved, loadedProfile: profileAfterSave };
                }

                const stateSaved = await service.updateCrewListState({
                    community_enabled: true,
                    crew_intents: [intent],
                    crew_list_visibility: 'private',
                });
                if (!stateSaved || !isAuthIdentityScopeCurrent(scope)) {
                    return { outcome: 'failed' as const, profileSaved, loadedProfile: null };
                }
                const submitted = await service.submitCrewProfileForReview();
                if (!submitted || !isAuthIdentityScopeCurrent(scope)) {
                    return { outcome: 'failed' as const, profileSaved, loadedProfile: null };
                }
                const loadedProfile = await service.getCrewProfile(scope.userId!);
                if (
                    loadedProfile?.approval_status === 'approved' &&
                    loadedProfile.verification_status === 'verified' &&
                    loadedProfile.crew_list_visibility === 'visible'
                ) {
                    return { outcome: 'published' as const, profileSaved, loadedProfile };
                }
                if (loadedProfile?.approval_status === 'pending') {
                    return { outcome: 'manual_review' as const, profileSaved, loadedProfile };
                }
                return { outcome: 'failed' as const, profileSaved, loadedProfile };
            });
            if (result.status === 'stale' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.status === 'unauthenticated') {
                setSaving(false);
                toast.error('Unable to verify this account — sign in again');
                return;
            }

            setSaving(false);
            if (result.value.outcome === 'failed' || !result.value.profileSaved) {
                toast.error('Could not save your Crew List profile');
                return;
            }
            if (result.value.loadedProfile) {
                dispatch({ type: 'LOAD_PROFILE', payload: result.value.loadedProfile });
            }
            setSaved(true);
            scheduleForIdentity(scope, () => setSaved(false), 2500);
            toast.success(
                result.value.outcome === 'live'
                    ? 'Crew List profile saved — your listing remains live'
                    : result.value.outcome === 'published'
                      ? 'Crew List profile published — you are live'
                      : result.value.outcome === 'manual_review'
                        ? 'Profile saved privately — it needs a quick safety review'
                        : result.value.outcome === 'draft_saved'
                          ? 'Private draft saved — verify your email and mobile before publishing'
                          : 'Crew List profile saved',
            );
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew profile save failed:', error);
            setSaving(false);
            toast.error('Could not save your Crew List profile');
        }
    };

    /**
     * Discreetly take a Crew List profile offline without deleting the sailor's
     * private draft. The server makes it undiscoverable immediately; returning
     * runs the normal automatic safety check again.
     */
    const handlePauseCrewList = async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        setSaving(true);
        try {
            const result = await runForIdentity(scope, async (service) => {
                const paused = await service.updateCrewListState({ community_enabled: false });
                if (!paused || !isAuthIdentityScopeCurrent(scope)) return { paused, profile: null };
                const updatedProfile = await service.getCrewProfile(scope.userId!);
                return { paused, profile: updatedProfile };
            });
            if (result.status === 'stale' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.status === 'unauthenticated' || !result.value.paused) {
                toast.error('Could not pause your Crew List profile');
                return;
            }
            if (result.value.profile) dispatch({ type: 'LOAD_PROFILE', payload: result.value.profile });
            toast.success('Crew List paused — your profile is private. Publish again whenever you are ready.');
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew List pause failed:', error);
            toast.error('Could not pause your Crew List profile');
        } finally {
            if (isAuthIdentityScopeCurrent(scope)) setSaving(false);
        }
    };

    // ── Photo Upload ──
    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const idx = pendingPhotoIdx;
        if (idx > 0 && !editPhotos[idx - 1]) {
            setPhotoError(idx === 1 ? 'Add your primary headshot first' : 'Add photos in order');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setPhotoError('');
        setUploadingPhotoIdx(idx);
        try {
            const scopedResult = await runForIdentity(scope, (service) =>
                service.uploadCrewPhoto(file, { persistPrimary: idx === 0 }),
            );
            if (scopedResult.status === 'stale' || !isAuthIdentityScopeCurrent(scope)) return;
            if (scopedResult.status === 'unauthenticated') {
                setPhotoError('Unable to verify this account');
            } else if (scopedResult.value.success && scopedResult.value.url) {
                setEditPhotos((prev) => {
                    const next = [...prev];
                    while (next.length <= idx) next.push('');
                    next[idx] = scopedResult.value.url!;
                    return next.filter(Boolean);
                });
            } else {
                setPhotoError(scopedResult.value.error || 'Upload failed');
            }
            setUploadingPhotoIdx(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew photo upload failed:', error);
            setPhotoError('Upload failed');
            setUploadingPhotoIdx(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handlePhotoRemove = async (idx: number) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || idx < 0 || idx >= editPhotos.length) return;
        setPhotoError('');
        setUploadingPhotoIdx(idx);
        try {
            const result = await runForIdentity(scope, async (service) => {
                const removed = await service.removeCrewPhotoAtIndex(idx);
                if (!removed || !isAuthIdentityScopeCurrent(scope)) return { removed, profile: null };
                const updatedProfile = await service.getCrewProfile(scope.userId!);
                return { removed, profile: updatedProfile };
            });
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (!result.value.removed) {
                setPhotoError('Could not remove that photo');
                return;
            }
            if (result.value.profile) {
                dispatch({ type: 'LOAD_PROFILE', payload: result.value.profile });
            } else {
                setEditPhotos((current) => current.filter((_, position) => position !== idx));
            }
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew photo removal failed:', error);
            setPhotoError('Could not remove that photo');
        } finally {
            if (isAuthIdentityScopeCurrent(scope)) setUploadingPhotoIdx(null);
        }
    };

    // ── Crew List introductions ──
    // The legacy callback name remains because the presentation components use
    // it, but it now sends/withdraws an introduction rather than recording a
    // social "like".  Chat remains unavailable until the recipient accepts.
    const handleLike = async (card: CrewCard) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        try {
            const pending = state.introductions.find(
                (introduction) =>
                    introduction.direction === 'sent' &&
                    introduction.request.recipient_id === card.user_id &&
                    introduction.request.status === 'pending',
            );
            if (pending) {
                const result = await runForIdentity(scope, (service) =>
                    service.withdrawCrewIntroRequest(pending.request.id),
                );
                if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
                if (!result.value) {
                    toast.error('Could not withdraw that introduction');
                    return;
                }
            } else {
                const result = await runForIdentity(scope, (service) => service.sendCrewIntroRequest(card.user_id, ''));
                if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
                if (!result.value) {
                    toast.error('Could not send that introduction');
                    return;
                }
            }
            await refreshIntroductions(scope);
            if (isAuthIdentityScopeCurrent(scope)) {
                toast.success(
                    pending
                        ? 'Introduction withdrawn'
                        : `Introduction sent to ${card.display_name}. They choose whether to connect.`,
                );
            }
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew List introduction action failed:', error);
            if (isAuthIdentityScopeCurrent(scope)) toast.error('Could not update that introduction');
        }
    };

    // ── Block / Report ──
    const handleBlock = async (userId: string, displayName: string) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        try {
            const result = await runForIdentity(scope, (service) => service.blockCrewListUser(userId));
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.value) {
                setBlockedUserIds((prev) => new Set([...prev, userId]));
                setListings((prev) => prev.filter((l) => l.user_id !== userId));
                await refreshIntroductions(scope);
                toast.success(`${displayName} blocked — they won't appear in your feed`);
            }
            setShowActionMenu(null);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew block failed:', error);
        }
    };

    const handleReport = async () => {
        if (!showReportModal || !reportReason.trim()) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const targetId = showReportModal;
        const reason = reportReason.trim();
        try {
            const result = await runForIdentity(scope, async (service) => {
                // Safety action is independent from optional moderation reporting:
                // a temporary report failure must never leave a sailor exposed.
                const blocked = await service.blockCrewListUser(targetId);
                const reported = await service.reportCrewListUser(targetId, reason);
                return { reported, blocked };
            });
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.value.blocked) {
                setBlockedUserIds((prev) => new Set([...prev, targetId]));
                setListings((prev) => prev.filter((listing) => listing.user_id !== targetId));
                await refreshIntroductions(scope);
                toast.success('User blocked — they will not appear in your Crew List');
            }
            if (result.value.reported) {
                toast.success('Report submitted — thanks for keeping the community safe');
            } else if (!result.value.blocked) {
                toast.error('Could not submit the report or block that user');
            } else {
                toast.error('User blocked, but the report could not be submitted');
            }
            setShowReportModal(null);
            setReportReason('');
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew report failed:', error);
        }
    };

    // ── Introduction with a note ──
    const handleSuperLike = async () => {
        if (!showSuperLikeModal) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const target = showSuperLikeModal;
        const message = superLikeMessage.trim();
        if (message.length < 2) {
            toast.error('Write a short sailing-related note before sending your introduction');
            return;
        }
        try {
            const result = await runForIdentity(scope, (service) =>
                service.sendCrewIntroRequest(target.user_id, message),
            );
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (!result.value) {
                toast.error(
                    'Could not send that introduction. Keep contact details in Thalassa until you both connect.',
                );
                return;
            }
            await refreshIntroductions(scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setShowSuperLikeModal(null);
            setSuperLikeMessage('');
            setSuperLikeUsed(false);
            toast.success(`Introduction sent to ${target.display_name}`);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew List noted introduction failed:', error);
            if (isAuthIdentityScopeCurrent(scope)) toast.error('Could not send that introduction');
        }
    };

    const handleRespondToIntroduction = async (requestId: string, response: 'accepted' | 'declined') => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        try {
            const result = await runForIdentity(scope, (service) =>
                service.respondToCrewIntroRequest(requestId, response),
            );
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (!result.value) {
                toast.error('That introduction could not be updated');
                return;
            }
            await refreshIntroductions(scope);
            if (isAuthIdentityScopeCurrent(scope)) {
                toast.success(
                    response === 'accepted'
                        ? 'Introduction accepted — private chat is now available'
                        : 'Introduction declined',
                );
            }
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew List introduction response failed:', error);
            if (isAuthIdentityScopeCurrent(scope)) toast.error('That introduction could not be updated');
        }
    };

    const handleWithdrawIntroduction = async (requestId: string) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        try {
            const result = await runForIdentity(scope, (service) => service.withdrawCrewIntroRequest(requestId));
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (!result.value) {
                toast.error('That introduction could not be withdrawn');
                return;
            }
            await refreshIntroductions(scope);
            if (isAuthIdentityScopeCurrent(scope)) toast.success('Introduction withdrawn');
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew List introduction withdrawal failed:', error);
            if (isAuthIdentityScopeCurrent(scope)) toast.error('That introduction could not be withdrawn');
        }
    };

    // ── Delete Listing ──
    const handleDeleteProfile = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        dispatch({ type: 'SET_DELETING', payload: true });
        triggerHaptic('medium');
        try {
            const result = await runForIdentity(scope, async (service) => {
                const deleted = await service.deleteCrewProfile();
                if (!deleted || !isAuthIdentityScopeCurrent(scope)) return { deleted, listings: null };
                const nextListings = await service.getCrewListings(filters);
                return { deleted, listings: nextListings };
            });
            if (result.status === 'stale' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.status === 'current' && result.value.deleted) {
                dispatch({ type: 'RESET_PROFILE' });
                if (result.value.listings) {
                    dispatch({ type: 'SET_LISTINGS', payload: result.value.listings });
                }
                toast.success('Listing removed from board');
                return;
            }
            toast.error('Failed to delete listing');
            dispatch({ type: 'SET_DELETING', payload: false });
            dispatch({ type: 'SET_SHOW_DELETE_CONFIRM', payload: false });
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew listing deletion failed:', error);
            toast.error('Failed to delete listing');
            dispatch({ type: 'SET_DELETING', payload: false });
            dispatch({ type: 'SET_SHOW_DELETE_CONFIRM', payload: false });
        }
    }, [dispatch, filters]);

    // ── Card Stack Navigation ──
    const goToNextCard = useCallback(() => {
        if (isAnimating || listings.length === 0) return;
        const scope = getAuthIdentityScope();
        dispatch({ type: 'SWIPE_ANIMATE', payload: { direction: 'left' } });
        scheduleForIdentity(
            scope,
            () => {
                dispatch({
                    type: 'SWIPE_COMPLETE',
                    payload: { newIndex: Math.min(currentCardIndex + 1, listings.length) },
                });
            },
            250,
        );
    }, [listings.length, isAnimating, currentCardIndex, dispatch, scheduleForIdentity]);

    const goToPrevCard = useCallback(() => {
        if (isAnimating || currentCardIndex <= 0) return;
        const scope = getAuthIdentityScope();
        dispatch({ type: 'SWIPE_ANIMATE', payload: { direction: 'right' } });
        scheduleForIdentity(
            scope,
            () => {
                dispatch({ type: 'SWIPE_COMPLETE', payload: { newIndex: Math.max(currentCardIndex - 1, 0) } });
            },
            250,
        );
    }, [currentCardIndex, isAnimating, dispatch, scheduleForIdentity]);

    const goToStart = useCallback(() => {
        dispatch({ type: 'GO_TO_START' });
    }, [dispatch]);

    // Reset card index when filters change
    useEffect(() => {
        setCurrentCardIndex(0);
        setCardPhotoIndex(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters]);

    // ── Swipe Gesture Handlers ──
    const handleCardTouchStart = useCallback(
        (e: React.TouchEvent) => {
            if (isAnimating) return;
            swipeStartX.current = e.touches[0].clientX;
            swipeStartY.current = e.touches[0].clientY;
            isSwipeTracking.current = true;
            directionLocked.current = null;
        },
        [isAnimating],
    );

    const handleCardTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isSwipeTracking.current) return;
        const dx = e.touches[0].clientX - swipeStartX.current;
        const dy = e.touches[0].clientY - swipeStartY.current;
        if (!directionLocked.current) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            directionLocked.current = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical';
        }
        if (directionLocked.current === 'vertical') return;
        e.preventDefault();
        setSwipeX(dx);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleCardTouchEnd = useCallback(() => {
        if (!isSwipeTracking.current || directionLocked.current === 'vertical') {
            isSwipeTracking.current = false;
            directionLocked.current = null;
            return;
        }
        isSwipeTracking.current = false;
        directionLocked.current = null;
        const threshold = 60;
        if (swipeX < -threshold) goToNextCard();
        else if (swipeX > threshold) goToPrevCard();
        else setSwipeX(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [swipeX, goToNextCard, goToPrevCard]);

    // ── Helpers ──
    const formatDate = (iso: string | null) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch (e) {
            log.warn(e);
            return iso;
        }
    };

    const isOpenEnded = (iso: string | null) => {
        if (!iso) return true;
        try {
            return new Date(iso).getFullYear() >= 2038;
        } catch (e) {
            log.warn(e);
            return false;
        }
    };

    const getLastActiveLabel = (lastActive: string | null): { text: string; color: string } | null => {
        if (!lastActive) return null;
        const diff = Date.now() - new Date(lastActive).getTime();
        const hours = diff / (1000 * 60 * 60);
        if (hours < 1) return { text: 'Online now', color: 'text-emerald-400' };
        if (hours < 24) return { text: 'Active today', color: 'text-emerald-400/60' };
        if (hours < 72) return { text: 'Active this week', color: 'text-sky-400/50' };
        if (hours < 168) return { text: 'Active recently', color: 'text-white/30' };
        return { text: 'Been a while', color: 'text-white/20' };
    };

    // ── Icebreakers ──
    const getIcebreakers = (match: SailorMatch): string[] => {
        const myInterests = editInterests.length > 0 ? editInterests : profile?.interests || [];
        const shared = myInterests.filter((i) => match.interests.includes(i));
        const tips: string[] = [];
        if (shared.length > 0) {
            const pick = shared[Math.floor(Math.random() * shared.length)];
            tips.push(`You both love ${pick} — ask about their favourite spot!`);
        }
        const myVibes = editVibe.length > 0 ? editVibe : profile?.vibe || [];
        const sharedVibes = myVibes.filter((v) => match.vibe.includes(v));
        if (sharedVibes.length > 0) tips.push(`Shared vibe: ${sharedVibes[0]} — sounds like you'd get along!`);
        const myLangs = editLanguages.length > 0 ? editLanguages : profile?.languages || [];
        const sharedLangs = myLangs.filter((l) => match.languages.includes(l));
        if (sharedLangs.length > 1)
            tips.push(`You both speak ${sharedLangs.length} languages — try saying hello in ${sharedLangs[1]}!`);
        if (tips.length === 0) tips.push('Say hello — every great voyage starts with a single wave! 👋');
        return tips.slice(0, 2);
    };

    // ── Compatibility Scoring ──
    const getCompatibility = (match: SailorMatch): { score: number; label: string; color: string } => {
        let score = 0;
        let possible = 0;

        const myInterests = editInterests.length > 0 ? editInterests : profile?.interests || [];
        if (myInterests.length > 0 || match.interests.length > 0) {
            const s = myInterests.filter((i) => match.interests.includes(i)).length;
            const t = Math.max(myInterests.length, match.interests.length);
            score += t > 0 ? (s / t) * 35 : 0;
            possible += 35;
        }

        const myVibe = editVibe.length > 0 ? editVibe : profile?.vibe || [];
        if (myVibe.length > 0 || match.vibe.length > 0) {
            const s = myVibe.filter((v) => match.vibe.includes(v)).length;
            const t = Math.max(myVibe.length, match.vibe.length);
            score += t > 0 ? (s / t) * 25 : 0;
            possible += 25;
        }

        const myLangs = editLanguages.length > 0 ? editLanguages : profile?.languages || [];
        if (myLangs.length > 0 || match.languages.length > 0) {
            const s = myLangs.filter((l) => match.languages.includes(l)).length;
            const t = Math.max(myLangs.length, match.languages.length);
            score += t > 0 ? (s / t) * 15 : 0;
            possible += 15;
        }

        const mySmoking = editSmoking || profile?.smoking;
        const myDrinking = editDrinking || profile?.drinking;
        const myPets = editPets || profile?.pets;
        if (mySmoking && match.smoking) {
            score += mySmoking === match.smoking ? 5 : 0;
            possible += 5;
        }
        if (myDrinking && match.drinking) {
            score += myDrinking === match.drinking ? 5 : 0;
            possible += 5;
        }
        if (myPets && match.pets) {
            score += myPets === match.pets ? 5 : 0;
            possible += 5;
        }

        const myExp = editExperience || profile?.sailing_experience;
        if (myExp && match.sailing_experience) {
            const levels = [
                'Just Got My Sea Legs',
                'Weekend Warrior',
                'Coastal Cruiser',
                'Liveaboard',
                'Bluewater Veteran',
                'Salty Dog 🧂',
            ];
            const myIdx = levels.indexOf(myExp);
            const theirIdx = levels.indexOf(match.sailing_experience);
            if (myIdx >= 0 && theirIdx >= 0) {
                const diff = Math.abs(myIdx - theirIdx);
                score += diff === 0 ? 10 : diff === 1 ? 7 : diff === 2 ? 4 : 1;
            }
            possible += 10;
        }

        const pct = possible > 0 ? Math.round((score / possible) * 100) : 0;
        const label =
            pct >= 90
                ? 'Perfect Storm ⚡'
                : pct >= 75
                  ? 'Smooth Sailing ⛵'
                  : pct >= 60
                    ? 'Fair Winds 🌤'
                    : pct >= 40
                      ? 'Choppy Waters 🌊'
                      : pct >= 20
                        ? 'Light Breeze 💨'
                        : 'Dead Calm 🪨';
        const color = pct >= 75 ? 'emerald' : pct >= 50 ? 'sky' : pct >= 25 ? 'amber' : 'white';
        return { score: pct, label, color };
    };

    // ── Derived values ──
    const currentUserId = identityScope.userId;
    const matchedUserIds = useMemo(() => new Set(state.matches.map((m) => m.user_id)), [state.matches]);

    return {
        // Setter shims (used by tab bar logic in component)
        setView,
        setHasSearched,
        setListings,
        setCurrentCardIndex,
        setFilterListingType,
        setFilterGender,
        setFilterAgeRanges,

        // Refs
        fileInputRef,
        myProfileScrollRef,

        // Actions
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
        // Navigation
        goToNextCard,
        goToPrevCard,
        goToStart,
        handleCardTouchStart,
        handleCardTouchMove,
        handleCardTouchEnd,

        // Helpers
        formatDate,
        isOpenEnded,
        getLastActiveLabel,
        getIcebreakers,
        getCompatibility,

        // Derived
        currentUserId,
        matchedUserIds,
    };
}
