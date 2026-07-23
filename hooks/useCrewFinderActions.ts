/**
 * useCrewFinderActions — All business logic for the Crew Finder
 *
 * Extracted from LonelyHeartsPage to reduce the component to a pure render shell.
 * Contains: setter shims, effects (init, keyboard, GPS auto-fill), search/filter,
 * profile save, photo upload, like/block/report/super-like, swipe gestures,
 * compatibility scoring, icebreakers, helpers.
 */

import { useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { CrewFinderState, CrewFinderAction } from './useCrewFinderState';
import {
    LonelyHeartsService,
    CrewCard,
    SailorMatch,
    CrewProfile,
    CrewSearchFilters,
    ListingType,
} from '../services/LonelyHeartsService';
import { toast } from '../components/Toast';
import { triggerHaptic } from '../utils/system';
import { LocationStore } from '../stores/LocationStore';
import React from 'react';
import {
    authScopedStorageKey,
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

// ────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────

export function useCrewFinderActions(state: CrewFinderState, dispatch: React.Dispatch<CrewFinderAction>) {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);
    const {
        view,
        listings,
        filters,
        filterListingType,
        filterGender,
        filterAgeRanges,
        filterSkills,
        filterExperience,
        filterRegion,
        filterLocationCountry,
        filterLocationState,
        filterLocationCity,
        showReportModal,
        reportReason,
        showSuperLikeModal,
        superLikeMessage,
        profile,
        editListingType,
        editFirstName,
        editGender,
        editAge,
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
        likedUsers,
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
    const _setFilterSkills = useCallback(
        (v: string[] | ((prev: string[]) => string[])) =>
            dispatch({ type: 'SET_FILTER_SKILLS', payload: typeof v === 'function' ? v(state.filterSkills) : v }),
        [dispatch, state.filterSkills],
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
    const setLikedUsers = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) =>
            dispatch({ type: 'SET_LIKED_USERS', payload: typeof v === 'function' ? v(state.likedUsers) : v }),
        [dispatch, state.likedUsers],
    );
    const setMessagedUsers = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) =>
            dispatch({ type: 'SET_MESSAGED_USERS', payload: typeof v === 'function' ? v(state.messagedUsers) : v }),
        [dispatch, state.messagedUsers],
    );

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
        const scope = identityScope;
        if (view !== 'my_profile') {
            setKbHeight(0);
            return;
        }
        let active = true;
        let cleanup: (() => void) | undefined;
        if (Capacitor.isNativePlatform()) {
            void import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    if (!active || !isAuthIdentityScopeCurrent(scope)) return;
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                        setKbHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        scheduleForIdentity(
                            scope,
                            () => {
                                const focused = document.activeElement as HTMLElement;
                                const container = myProfileScrollRef.current;
                                if (!focused || !container) return;
                                if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') return;
                                const focusRect = focused.getBoundingClientRect();
                                const containerRect = container.getBoundingClientRect();
                                const offsetInContainer = focusRect.top - containerRect.top + container.scrollTop;
                                const targetScroll = offsetInContainer - containerRect.height * 0.3;
                                container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
                            },
                            50,
                        );
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        if (isAuthIdentityScopeCurrent(scope)) setKbHeight(0);
                    });
                    cleanup = () => {
                        void showHandle.then((h) => h.remove());
                        void hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin unavailable on web */
                });
        } else {
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    const kbH = window.innerHeight - vp.height;
                    setKbHeight(kbH > 50 ? kbH : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }
        return () => {
            active = false;
            cleanup?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, identityScope.generation, scheduleForIdentity]);

    // ── Init ──
    useEffect(() => {
        const scope = identityScope;
        let active = true;
        if (!scope.userId) {
            setLoading(false);
            return;
        }

        void runForIdentity(scope, async (service) => {
            const [matches, loadedProfile, blocked, superLikeUsed] = await Promise.all([
                service.getMatches(),
                service.getCrewProfile(scope.userId!),
                service.getBlockedUserIds(),
                service.hasSuperLikedToday(),
                service.updateLastActive(),
            ]);
            return { matches, loadedProfile, blocked, superLikeUsed };
        })
            .then((result) => {
                if (!active || result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
                dispatch({ type: 'SET_MATCHES', payload: result.value.matches });
                if (result.value.loadedProfile) {
                    dispatch({ type: 'LOAD_PROFILE', payload: result.value.loadedProfile });
                }
                dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: new Set(result.value.blocked) });
                dispatch({ type: 'SET_SUPER_LIKE_USED', payload: result.value.superLikeUsed });
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

    // ── Search ──
    const applyFilters = async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const f: CrewSearchFilters = {};
        if (filterListingType) f.listing_type = filterListingType;
        if (filterGender) f.gender = filterGender;
        if (filterAgeRanges.length > 0) f.age_ranges = filterAgeRanges;
        if (filterSkills.length > 0) f.skills = filterSkills;
        if (filterExperience) f.experience = filterExperience;
        if (filterRegion) f.region = filterRegion;
        if (filterLocationCountry) f.location_country = filterLocationCountry;
        if (filterLocationState) f.location_state = filterLocationState;
        if (filterLocationCity) f.location_city = filterLocationCity;
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
        const updates: Partial<Omit<CrewProfile, 'user_id' | 'created_at' | 'updated_at'>> = {
            listing_type: (editListingType as ListingType) || null,
            first_name: editFirstName.trim() || null,
            gender: editGender || null,
            age_range: editAge || null,
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
            photo_url: editPhotos[0] || null,
        };

        setSaving(true);
        try {
            const result = await runForIdentity(scope, async (service) => {
                const updated = await service.updateCrewProfile(updates);
                if (!updated || !isAuthIdentityScopeCurrent(scope)) return { updated, loadedProfile: null };
                const loadedProfile = await service.getCrewProfile(scope.userId!);
                return { updated, loadedProfile };
            });
            if (result.status === 'stale' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.status === 'unauthenticated') {
                setSaving(false);
                toast.error('Unable to verify this account — sign in again');
                return;
            }

            setSaving(false);
            if (!result.value.updated) {
                toast.error('Could not save your listing');
                return;
            }
            if (result.value.loadedProfile) {
                dispatch({ type: 'LOAD_PROFILE', payload: result.value.loadedProfile });
            }
            setSaved(true);
            scheduleForIdentity(scope, () => setSaved(false), 2500);
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            log.warn('Crew profile save failed:', error);
            setSaving(false);
            toast.error('Could not save your listing');
        }
    };

    // ── Photo Upload ──
    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const idx = pendingPhotoIdx;
        setPhotoError('');
        setUploadingPhotoIdx(idx);
        try {
            const scopedResult = await runForIdentity(scope, (service) => service.uploadCrewPhoto(file));
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

    const handlePhotoRemove = (idx: number) => {
        setEditPhotos((prev) => prev.filter((_, i) => i !== idx));
    };

    // ── Like / Interest ──
    const handleLike = async (card: CrewCard) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const alreadyLiked = likedUsers.has(card.user_id);
        if (alreadyLiked) {
            setLikedUsers((prev) => {
                const next = new Set(prev);
                next.delete(card.user_id);
                try {
                    if (isAuthIdentityScopeCurrent(scope)) {
                        localStorage.setItem(
                            authScopedStorageKey('crew_liked_users', scope),
                            JSON.stringify([...next]),
                        );
                    }
                } catch (e) {
                    console.warn(`[CrewFinder]`, e);
                }
                return next;
            });
        } else {
            setLikedUsers((prev) => {
                const next = new Set(prev);
                next.add(card.user_id);
                try {
                    if (isAuthIdentityScopeCurrent(scope)) {
                        localStorage.setItem(
                            authScopedStorageKey('crew_liked_users', scope),
                            JSON.stringify([...next]),
                        );
                    }
                } catch (e) {
                    console.warn(`[CrewFinder]`, e);
                }
                return next;
            });
        }

        try {
            const result = await runForIdentity(scope, async (service) => {
                const likeResult = await service.recordLike(card.user_id, !alreadyLiked);
                if (!isAuthIdentityScopeCurrent(scope)) return { likeResult, matches: null };
                const matches = alreadyLiked || likeResult.matched ? await service.getMatches() : null;
                return { likeResult, matches };
            });
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.value.matches) {
                dispatch({ type: 'SET_MATCHES', payload: result.value.matches });
            }
            if (!alreadyLiked && result.value.likeResult.matched) {
                toast.success(`⭐ It's a Match! You and ${card.display_name} starred each other!`);
            }
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew like failed:', error);
        }
    };

    const trackMessagedUser = useCallback((userId: string) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        setMessagedUsers((prev) => {
            if (!isAuthIdentityScopeCurrent(scope)) return prev;
            const next = new Set(prev);
            next.add(userId);
            try {
                localStorage.setItem(authScopedStorageKey('crew_messaged_users', scope), JSON.stringify([...next]));
            } catch (e) {
                console.warn(`[CrewFinder]`, e);
            }
            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Block / Report ──
    const handleBlock = async (userId: string, displayName: string) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        try {
            const result = await runForIdentity(scope, (service) => service.blockUser(userId));
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.value) {
                setBlockedUserIds((prev) => new Set([...prev, userId]));
                setListings((prev) => prev.filter((l) => l.user_id !== userId));
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
                const reported = await service.reportUser(targetId, reason);
                if (!reported || !isAuthIdentityScopeCurrent(scope)) return { reported, blocked: false };
                const blocked = await service.blockUser(targetId);
                return { reported, blocked };
            });
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;
            if (result.value.reported) {
                if (result.value.blocked) {
                    setBlockedUserIds((prev) => new Set([...prev, targetId]));
                    setListings((prev) => prev.filter((listing) => listing.user_id !== targetId));
                    toast.success(`User blocked — they won't appear in your feed`);
                }
                toast.success('Report submitted — thanks for keeping the community safe');
            }
            setShowReportModal(null);
            setReportReason('');
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew report failed:', error);
        }
    };

    // ── Super Like ──
    const handleSuperLike = async () => {
        if (!showSuperLikeModal) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        const target = showSuperLikeModal;
        const message = superLikeMessage.trim();
        try {
            const result = await runForIdentity(scope, async (service) => {
                const superLike = await service.recordSuperLike(target.user_id, message);
                if (!superLike.matched || !isAuthIdentityScopeCurrent(scope)) {
                    return { superLike, matches: null };
                }
                const matches = await service.getMatches();
                return { superLike, matches };
            });
            if (result.status !== 'current' || !isAuthIdentityScopeCurrent(scope)) return;

            setLikedUsers((prev) => {
                const next = new Set(prev);
                next.add(target.user_id);
                try {
                    if (isAuthIdentityScopeCurrent(scope)) {
                        localStorage.setItem(
                            authScopedStorageKey('crew_liked_users', scope),
                            JSON.stringify([...next]),
                        );
                    }
                } catch (error) {
                    console.warn(`[CrewFinder]`, error);
                }
                return next;
            });
            setSuperLikeUsed(true);
            if (result.value.matches) {
                dispatch({ type: 'SET_MATCHES', payload: result.value.matches });
            }
            if (result.value.superLike.matched) {
                toast.success(`🌟 Super Match! You and ${target.display_name} are connected!`);
            } else {
                toast.success(`🌟 Super Like sent to ${target.display_name}!`);
            }
            setShowSuperLikeModal(null);
            setSuperLikeMessage('');
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('Crew super-like failed:', error);
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
        handlePhotoUpload,
        handlePhotoRemove,
        handleLike,
        handleBlock,
        handleReport,
        handleSuperLike,
        handleDeleteProfile,
        trackMessagedUser,

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
