/**
 * Find Crew Page — Crew Board & Sailor Connections
 *
 * Professional crew marketplace:
 * - Browse: Filterable feed of crew/skipper listings
 * - Detail: Full profile view with DM action
 * - My Listing: Rich profile form (skills, availability, partner, etc.)
 * - Matches: Mutual interest list with DM
 */

import React, { useEffect, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { useCrewFinderState } from '../hooks/useCrewFinderState';
import { CrewProfileForm } from './crew-finder/CrewProfileForm';

const log = createLogger('LonelyHeartsPage');
import {
    LonelyHeartsService,
    CrewCard,
    SailorMatch,
    CrewProfile,
    CrewSearchFilters,
    ListingType,
    AGE_RANGES,
} from '../services/LonelyHeartsService';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from './Toast';
import { triggerHaptic } from '../utils/system';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';
import { LocationStore } from '../stores/LocationStore';
import { COUNTRIES, getStatesForCountry } from '../data/locationData';

interface LonelyHeartsPageProps {
    onOpenDM: (userId: string, name: string) => void;
}

type FCView = 'board' | 'detail' | 'my_profile' | 'matches';

export const LonelyHeartsPage: React.FC<LonelyHeartsPageProps> = ({ onOpenDM }) => {
    const { state, dispatch } = useCrewFinderState();

    // ── Destructure state for backward compatibility ──
    const {
        view,
        loading,
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
        showFilters,
        selectedCard,
        matches,
        hasSearched,
        blockedUserIds,
        showReportModal,
        reportReason,
        showActionMenu,
        showSuperLikeModal,
        superLikeMessage,
        superLikeUsed,
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
        saving,
        saved,
        editPhotos,
        uploadingPhotoIdx,
        photoError,
        pendingPhotoIdx,
        showDeleteConfirm,
        deleting,
        showPreview,
        kbHeight,
        currentCardIndex,
        cardPhotoIndex,
        swipeX,
        swipeDirection,
        isAnimating,
        likedUsers,
        messagedUsers,
    } = state;

    // ── Setter shims (delegate to dispatch) ──
    const setView = useCallback((v: typeof view) => dispatch({ type: 'SET_VIEW', payload: v }), [dispatch]);
    const setLoading = useCallback((v: boolean) => dispatch({ type: 'SET_LOADING', payload: v }), [dispatch]);
    const setListings = useCallback(
        (v: CrewCard[] | ((prev: CrewCard[]) => CrewCard[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_LISTINGS', payload: v(state.listings) });
            } else {
                dispatch({ type: 'SET_LISTINGS', payload: v });
            }
        },
        [dispatch, state.listings],
    );
    const setFilters = useCallback((v: typeof filters) => dispatch({ type: 'SET_FILTERS', payload: v }), [dispatch]);
    const setFilterListingType = useCallback(
        (v: typeof filterListingType) => dispatch({ type: 'SET_FILTER_LISTING_TYPE', payload: v }),
        [dispatch],
    );
    const setFilterGender = useCallback((v: string) => dispatch({ type: 'SET_FILTER_GENDER', payload: v }), [dispatch]);
    const setFilterAgeRanges = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_FILTER_AGE_RANGES', payload: v(state.filterAgeRanges) });
            } else {
                dispatch({ type: 'SET_FILTER_AGE_RANGES', payload: v });
            }
        },
        [dispatch, state.filterAgeRanges],
    );
    const setFilterSkills = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_FILTER_SKILLS', payload: v(state.filterSkills) });
            } else {
                dispatch({ type: 'SET_FILTER_SKILLS', payload: v });
            }
        },
        [dispatch, state.filterSkills],
    );
    const setFilterExperience = useCallback(
        (v: string) => dispatch({ type: 'SET_FILTER_EXPERIENCE', payload: v }),
        [dispatch],
    );
    const setFilterRegion = useCallback((v: string) => dispatch({ type: 'SET_FILTER_REGION', payload: v }), [dispatch]);
    const setFilterLocationCountry = useCallback(
        (v: string) => dispatch({ type: 'SET_FILTER_LOCATION_COUNTRY', payload: v }),
        [dispatch],
    );
    const setFilterLocationState = useCallback(
        (v: string) => dispatch({ type: 'SET_FILTER_LOCATION_STATE', payload: v }),
        [dispatch],
    );
    const setFilterLocationCity = useCallback(
        (v: string) => dispatch({ type: 'SET_FILTER_LOCATION_CITY', payload: v }),
        [dispatch],
    );
    const setShowFilters = useCallback((v: boolean) => dispatch({ type: 'SET_SHOW_FILTERS', payload: v }), [dispatch]);
    const setSelectedCard = useCallback(
        (v: typeof selectedCard) => dispatch({ type: 'SET_SELECTED_CARD', payload: v }),
        [dispatch],
    );
    const setMatches = useCallback((v: typeof matches) => dispatch({ type: 'SET_MATCHES', payload: v }), [dispatch]);
    const setHasSearched = useCallback((v: boolean) => dispatch({ type: 'SET_HAS_SEARCHED', payload: v }), [dispatch]);
    const setBlockedUserIds = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: v(state.blockedUserIds) });
            } else {
                dispatch({ type: 'SET_BLOCKED_USER_IDS', payload: v });
            }
        },
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
        (v: typeof showSuperLikeModal) => dispatch({ type: 'SET_SHOW_SUPER_LIKE_MODAL', payload: v }),
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
    const setProfile = useCallback((v: typeof profile) => dispatch({ type: 'SET_PROFILE', payload: v }), [dispatch]);
    const setEditListingType = useCallback(
        (v: typeof editListingType) => dispatch({ type: 'SET_EDIT_LISTING_TYPE', payload: v }),
        [dispatch],
    );
    const setEditFirstName = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_FIRST_NAME', payload: v }),
        [dispatch],
    );
    const setEditGender = useCallback((v: string) => dispatch({ type: 'SET_EDIT_GENDER', payload: v }), [dispatch]);
    const setEditAge = useCallback((v: string) => dispatch({ type: 'SET_EDIT_AGE', payload: v }), [dispatch]);
    const setEditHasPartner = useCallback(
        (v: boolean) => dispatch({ type: 'SET_EDIT_HAS_PARTNER', payload: v }),
        [dispatch],
    );
    const setEditPartnerDetails = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_PARTNER_DETAILS', payload: v }),
        [dispatch],
    );
    const setEditSkills = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_EDIT_SKILLS', payload: v(state.editSkills) });
            } else {
                dispatch({ type: 'SET_EDIT_SKILLS', payload: v });
            }
        },
        [dispatch, state.editSkills],
    );
    const setEditExperience = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_EXPERIENCE', payload: v }),
        [dispatch],
    );
    const setEditRegion = useCallback((v: string) => dispatch({ type: 'SET_EDIT_REGION', payload: v }), [dispatch]);
    const setEditAvailFrom = useCallback(
        (v: string) => dispatch({ type: 'SET_EDIT_AVAIL_FROM', payload: v }),
        [dispatch],
    );
    const setEditAvailTo = useCallback((v: string) => dispatch({ type: 'SET_EDIT_AVAIL_TO', payload: v }), [dispatch]);
    const setEditBio = useCallback((v: string) => dispatch({ type: 'SET_EDIT_BIO', payload: v }), [dispatch]);
    const setEditVibe = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_EDIT_VIBE', payload: v(state.editVibe) });
            } else {
                dispatch({ type: 'SET_EDIT_VIBE', payload: v });
            }
        },
        [dispatch, state.editVibe],
    );
    const setEditLanguages = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_EDIT_LANGUAGES', payload: v(state.editLanguages) });
            } else {
                dispatch({ type: 'SET_EDIT_LANGUAGES', payload: v });
            }
        },
        [dispatch, state.editLanguages],
    );
    const setEditSmoking = useCallback((v: string) => dispatch({ type: 'SET_EDIT_SMOKING', payload: v }), [dispatch]);
    const setEditDrinking = useCallback((v: string) => dispatch({ type: 'SET_EDIT_DRINKING', payload: v }), [dispatch]);
    const setEditPets = useCallback((v: string) => dispatch({ type: 'SET_EDIT_PETS', payload: v }), [dispatch]);
    const setEditInterests = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_EDIT_INTERESTS', payload: v(state.editInterests) });
            } else {
                dispatch({ type: 'SET_EDIT_INTERESTS', payload: v });
            }
        },
        [dispatch, state.editInterests],
    );
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
    const setSaving = useCallback((v: boolean) => dispatch({ type: 'SET_SAVING', payload: v }), [dispatch]);
    const setSaved = useCallback((v: boolean) => dispatch({ type: 'SET_SAVED', payload: v }), [dispatch]);
    const setEditPhotos = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            if (typeof v === 'function') {
                // Need to read current state for functional updates
                dispatch({ type: 'SET_EDIT_PHOTOS', payload: v(state.editPhotos) });
            } else {
                dispatch({ type: 'SET_EDIT_PHOTOS', payload: v });
            }
        },
        [dispatch, state.editPhotos],
    );
    const setUploadingPhotoIdx = useCallback(
        (v: number | null) => dispatch({ type: 'SET_UPLOADING_PHOTO_IDX', payload: v }),
        [dispatch],
    );
    const setPhotoError = useCallback((v: string) => dispatch({ type: 'SET_PHOTO_ERROR', payload: v }), [dispatch]);
    const setPendingPhotoIdx = useCallback(
        (v: number) => dispatch({ type: 'SET_PENDING_PHOTO_IDX', payload: v }),
        [dispatch],
    );
    const setShowDeleteConfirm = useCallback(
        (v: boolean) => dispatch({ type: 'SET_SHOW_DELETE_CONFIRM', payload: v }),
        [dispatch],
    );
    const setDeleting = useCallback((v: boolean) => dispatch({ type: 'SET_DELETING', payload: v }), [dispatch]);
    const setShowPreview = useCallback((v: boolean) => dispatch({ type: 'SET_SHOW_PREVIEW', payload: v }), [dispatch]);
    const setKbHeight = useCallback((v: number) => dispatch({ type: 'SET_KB_HEIGHT', payload: v }), [dispatch]);
    const setCurrentCardIndex = useCallback(
        (v: number | ((prev: number) => number)) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_CURRENT_CARD_INDEX', payload: v(state.currentCardIndex) });
            } else {
                dispatch({ type: 'SET_CURRENT_CARD_INDEX', payload: v });
            }
        },
        [dispatch, state.currentCardIndex],
    );
    const setCardPhotoIndex = useCallback(
        (v: number | ((prev: number) => number)) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_CARD_PHOTO_INDEX', payload: v(state.cardPhotoIndex) });
            } else {
                dispatch({ type: 'SET_CARD_PHOTO_INDEX', payload: v });
            }
        },
        [dispatch, state.cardPhotoIndex],
    );
    const setSwipeX = useCallback((v: number) => dispatch({ type: 'SET_SWIPE_X', payload: v }), [dispatch]);
    const setSwipeDirection = useCallback(
        (v: 'left' | 'right' | null) => dispatch({ type: 'SET_SWIPE_DIRECTION', payload: v }),
        [dispatch],
    );
    const setIsAnimating = useCallback((v: boolean) => dispatch({ type: 'SET_IS_ANIMATING', payload: v }), [dispatch]);
    const setLikedUsers = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_LIKED_USERS', payload: v(state.likedUsers) });
            } else {
                dispatch({ type: 'SET_LIKED_USERS', payload: v });
            }
        },
        [dispatch, state.likedUsers],
    );
    const setMessagedUsers = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
            if (typeof v === 'function') {
                dispatch({ type: 'SET_MESSAGED_USERS', payload: v(state.messagedUsers) });
            } else {
                dispatch({ type: 'SET_MESSAGED_USERS', payload: v });
            }
        },
        [dispatch, state.messagedUsers],
    );

    // ── Refs (not state, kept as-is) ──
    const fileInputRef = useRef<HTMLInputElement>(null);
    const myProfileScrollRef = useRef<HTMLDivElement>(null);
    const swipeStartX = useRef(0);
    const swipeStartY = useRef(0);
    const isSwipeTracking = useRef(false);
    const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);

    // ── Keyboard height detection — same pattern as DiaryPage/AuthModal/Marketplace ──
    useEffect(() => {
        if (view !== 'my_profile') {
            setKbHeight(0);
            return;
        }
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        setKbHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        setTimeout(() => {
                            const focused = document.activeElement as HTMLElement;
                            const container = myProfileScrollRef.current;
                            if (!focused || !container) return;
                            if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') return;
                            const focusRect = focused.getBoundingClientRect();
                            const containerRect = container.getBoundingClientRect();
                            const offsetInContainer = focusRect.top - containerRect.top + container.scrollTop;
                            const targetScroll = offsetInContainer - containerRect.height * 0.3;
                            container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
                        }, 50);
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        setKbHeight(0);
                    });
                    cleanup = () => {
                        showHandle.then((h) => h.remove());
                        hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin not available */
                });
        } else {
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    const kbH = window.innerHeight - vp.height;
                    setKbHeight(kbH > 50 ? kbH : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }

        return () => {
            cleanup?.();
            setKbHeight(0);
        };
    }, [view]);

    // --- INIT ---
    useEffect(() => {
        const init = async () => {
            await LonelyHeartsService.init();
            await Promise.all([loadMatches(), loadProfile()]);
            // Load blocked users & update last active
            const blocked = await LonelyHeartsService.getBlockedUserIds();
            setBlockedUserIds(new Set(blocked));
            LonelyHeartsService.updateLastActive();
            const used = await LonelyHeartsService.hasSuperLikedToday();
            setSuperLikeUsed(used);
            setLoading(false);
        };
        init();
    }, []);

    // Auto-fill location from GPS if empty
    useEffect(() => {
        if (editLocationCity || editLocationState || editLocationCountry) return;
        if (view !== 'my_profile') return;
        const loc = LocationStore.getState();
        if (!loc.lat || !loc.lon) return;
        (async () => {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${loc.lat}&lon=${loc.lon}&format=json&zoom=10&addressdetails=1`,
                    { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } },
                );
                if (!res.ok) return;
                const data = await res.json();
                const addr = data.address || {};
                const city = addr.city || addr.town || addr.village || addr.suburb || addr.municipality || '';
                const state = addr.state || addr.region || addr.county || '';
                const country = addr.country || '';
                if (city) setEditLocationCity(city);
                if (state) setEditLocationState(state);
                if (country) setEditLocationCountry(country);
            } catch {
                /* GPS or network unavailable — user can fill manually */
            }
        })();
    }, [view, editLocationCity, editLocationState, editLocationCountry]);

    const loadListings = useCallback(
        async (f?: CrewSearchFilters) => {
            const applied = f || filters;
            const data = await LonelyHeartsService.getCrewListings(applied);
            setListings(data);
        },
        [filters],
    );

    const loadMatches = async () => {
        const m = await LonelyHeartsService.getMatches();
        setMatches(m);
    };

    const loadProfile = async () => {
        const dp = await LonelyHeartsService.getCrewProfile();
        if (dp) {
            // Batch: 22 state updates → 1 dispatch
            dispatch({ type: 'LOAD_PROFILE', payload: dp as CrewProfile });
        }
    };

    // --- SEARCH ---
    const applyFilters = async () => {
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
        await loadListings(f);
        setLoading(false);
        setShowFilters(false);
        setHasSearched(true);
    };

    const clearFilters = async () => {
        // Batch: 10 state updates → 1 dispatch
        dispatch({ type: 'CLEAR_FILTERS' });
        setLoading(true);
        await loadListings({});
        setLoading(false);
    };

    const toggleFilterSkill = (skill: string) => {
        setFilterSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
    };

    // --- SAVE PROFILE ---
    const handleSaveProfile = async () => {
        let uid = (LonelyHeartsService as any).currentUserId as string | null;
        log.info('[CrewFinder Save] uid from service:', uid?.slice(0, 8) || 'null');
        if (!uid) {
            // Auth might not have been ready at mount — retry init
            await LonelyHeartsService.init();
            uid = (LonelyHeartsService as any).currentUserId as string | null;
            log.info('[CrewFinder Save] uid after re-init:', uid?.slice(0, 8) || 'null');
        }
        if (!uid) {
            // Last resort: check supabase directly
            try {
                const { supabase } = await import('../services/supabase');
                if (supabase) {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    log.info('[CrewFinder Save] direct session check:', session?.user?.id?.slice(0, 8) || 'null');
                    if (session?.user?.id) {
                        uid = session.user.id;
                        // Fix the service state too
                        (LonelyHeartsService as any).currentUserId = uid;
                    }
                } else {
                    log.info('[CrewFinder Save] supabase is null (not configured)');
                }
            } catch (e) {
                console.warn('[CrewFinder Save] direct session check failed:', e);
            }
        }
        if (!uid) {
            toast.error('Sign in first — go to Vessel > Settings > Account');
            return;
        }
        setSaving(true);
        await LonelyHeartsService.updateCrewProfile({
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
        });
        // Reload profile so browse tab becomes accessible immediately
        await loadProfile();
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
    };

    const toggleEditSkill = (skill: string) => {
        setEditSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
    };

    // --- PHOTO UPLOAD ---
    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const idx = pendingPhotoIdx;
        setPhotoError('');
        setUploadingPhotoIdx(idx);
        const result = await LonelyHeartsService.uploadCrewPhoto(file);
        if (result.success && result.url) {
            setEditPhotos((prev) => {
                const next = [...prev];
                while (next.length <= idx) next.push('');
                next[idx] = result.url!;
                return next.filter(Boolean);
            });
        } else {
            setPhotoError(result.error || 'Upload failed');
        }
        setUploadingPhotoIdx(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handlePhotoRemove = (idx: number) => {
        setEditPhotos((prev) => prev.filter((_, i) => i !== idx));
    };

    // --- LIKE / INTEREST ---
    const handleLike = async (card: CrewCard) => {
        const alreadyLiked = likedUsers.has(card.user_id);

        if (alreadyLiked) {
            // Unstar
            setLikedUsers((prev) => {
                const next = new Set(prev);
                next.delete(card.user_id);
                try {
                    localStorage.setItem('crew_liked_users', JSON.stringify([...next]));
                } catch (e) {
                    console.warn(`[LonelyHeartsPage]`, e);
                }
                return next;
            });
            await LonelyHeartsService.recordLike(card.user_id, false);
            await loadMatches();
        } else {
            // Star
            setLikedUsers((prev) => {
                const next = new Set(prev);
                next.add(card.user_id);
                try {
                    localStorage.setItem('crew_liked_users', JSON.stringify([...next]));
                } catch (e) {
                    console.warn(`[LonelyHeartsPage]`, e);
                }
                return next;
            });
            const result = await LonelyHeartsService.recordLike(card.user_id, true);
            if (result.matched) {
                await loadMatches();
                toast.success(`⭐ It's a Match! You and ${card.display_name} starred each other!`);
            }
        }
    };
    // Track messaged users
    const trackMessagedUser = useCallback((userId: string) => {
        setMessagedUsers((prev) => {
            const next = new Set(prev);
            next.add(userId);
            try {
                localStorage.setItem('crew_messaged_users', JSON.stringify([...next]));
            } catch (e) {
                console.warn(`[LonelyHeartsPage]`, e);
            }
            return next;
        });
    }, []);

    // --- BLOCK / REPORT ---
    const handleBlock = async (userId: string, displayName: string) => {
        const success = await LonelyHeartsService.blockUser(userId);
        if (success) {
            setBlockedUserIds((prev) => new Set([...prev, userId]));
            setListings((prev) => prev.filter((l) => l.user_id !== userId));
            toast.success(`${displayName} blocked — they won't appear in your feed`);
        }
        setShowActionMenu(null);
    };

    const handleReport = async () => {
        if (!showReportModal || !reportReason.trim()) return;
        const success = await LonelyHeartsService.reportUser(showReportModal, reportReason.trim());
        if (success) {
            await handleBlock(showReportModal, 'User');
            toast.success('Report submitted — thanks for keeping the community safe');
        }
        setShowReportModal(null);
        setReportReason('');
    };

    // --- SUPER LIKE ---
    const handleSuperLike = async () => {
        if (!showSuperLikeModal) return;
        const result = await LonelyHeartsService.recordSuperLike(showSuperLikeModal.user_id, superLikeMessage.trim());
        // Also mark as regular liked
        setLikedUsers((prev) => {
            const next = new Set(prev);
            next.add(showSuperLikeModal.user_id);
            try {
                localStorage.setItem('crew_liked_users', JSON.stringify([...next]));
            } catch (e) {
                console.warn(`[LonelyHeartsPage]`, e);
            }
            return next;
        });
        setSuperLikeUsed(true);
        if (result.matched) {
            await loadMatches();
            toast.success(`🌟 Super Match! You and ${showSuperLikeModal.display_name} are connected!`);
        } else {
            toast.success(`🌟 Super Like sent to ${showSuperLikeModal.display_name}!`);
        }
        setShowSuperLikeModal(null);
        setSuperLikeMessage('');
    };

    // --- LAST ACTIVE HELPER ---
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

    // --- DM ICEBREAKERS ---
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
        if (sharedVibes.length > 0) {
            tips.push(`Shared vibe: ${sharedVibes[0]} — sounds like you'd get along!`);
        }
        const myLangs = editLanguages.length > 0 ? editLanguages : profile?.languages || [];
        const sharedLangs = myLangs.filter((l) => match.languages.includes(l));
        if (sharedLangs.length > 1) {
            tips.push(`You both speak ${sharedLangs.length} languages — try saying hello in ${sharedLangs[1]}!`);
        }
        if (tips.length === 0) tips.push('Say hello — every great voyage starts with a single wave! 👋');
        return tips.slice(0, 2);
    };

    // --- CARD STACK NAVIGATION ---
    const goToNextCard = useCallback(() => {
        if (isAnimating || listings.length === 0) return;
        dispatch({ type: 'SWIPE_ANIMATE', payload: { direction: 'left' } });
        setTimeout(() => {
            dispatch({
                type: 'SWIPE_COMPLETE',
                payload: { newIndex: Math.min(currentCardIndex + 1, listings.length) },
            });
        }, 250);
    }, [listings.length, isAnimating, currentCardIndex, dispatch]);

    const goToPrevCard = useCallback(() => {
        if (isAnimating || currentCardIndex <= 0) return;
        dispatch({ type: 'SWIPE_ANIMATE', payload: { direction: 'right' } });
        setTimeout(() => {
            dispatch({ type: 'SWIPE_COMPLETE', payload: { newIndex: Math.max(currentCardIndex - 1, 0) } });
        }, 250);
    }, [currentCardIndex, isAnimating, dispatch]);

    const goToStart = useCallback(() => {
        dispatch({ type: 'GO_TO_START' });
    }, [dispatch]);

    // Reset card index when listings change
    useEffect(() => {
        setCurrentCardIndex(0);
        setCardPhotoIndex(0);
    }, [filters]);

    // Swipe gesture handlers
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
        if (swipeX < -threshold) {
            goToNextCard();
        } else if (swipeX > threshold) {
            goToPrevCard();
        } else {
            setSwipeX(0);
        }
    }, [swipeX, goToNextCard, goToPrevCard]);

    // --- HELPERS ---
    const formatDate = (iso: string | null) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch (e) {
            log.warn(e);
            return iso;
        }
    };

    /** Detect sentinel end dates (2038+) that mean "open-ended" */
    const isOpenEnded = (iso: string | null) => {
        if (!iso) return true;
        try {
            return new Date(iso).getFullYear() >= 2038;
        } catch (e) {
            log.warn(e);
            return false;
        }
    };

    // --- DELETE LISTING ---
    const handleDeleteProfile = useCallback(async () => {
        setDeleting(true);
        triggerHaptic('medium');
        const success = await LonelyHeartsService.deleteCrewProfile();
        if (success) {
            // Batch: 23 state updates → 1 dispatch
            dispatch({ type: 'RESET_PROFILE' });
            toast.success('Listing removed from board');
            await loadListings();
        } else {
            toast.error('Failed to delete listing');
            setDeleting(false);
            setShowDeleteConfirm(false);
        }
    }, [loadListings, dispatch]);

    /** Get the current user's ID from the service (for own-card detection) */
    const currentUserId = (LonelyHeartsService as any).currentUserId as string | null;

    const activeFilterCount =
        (filterListingType ? 1 : 0) +
        (filterSkills.length > 0 ? 1 : 0) +
        (filterExperience ? 1 : 0) +
        (filterRegion ? 1 : 0);
    const matchedUserIds = new Set(matches.map((m) => m.user_id));

    /** Calculate compatibility score (0–100) between current user's profile and a match */
    const getCompatibility = (match: SailorMatch): { score: number; label: string; color: string } => {
        let score = 0;
        let possible = 0;

        // Shared interests (35 pts)
        const myInterests = editInterests.length > 0 ? editInterests : profile?.interests || [];
        if (myInterests.length > 0 || match.interests.length > 0) {
            const shared = myInterests.filter((i) => match.interests.includes(i)).length;
            const total = Math.max(myInterests.length, match.interests.length);
            score += total > 0 ? (shared / total) * 35 : 0;
            possible += 35;
        }

        // Shared vibes (25 pts)
        const myVibe = editVibe.length > 0 ? editVibe : profile?.vibe || [];
        if (myVibe.length > 0 || match.vibe.length > 0) {
            const shared = myVibe.filter((v) => match.vibe.includes(v)).length;
            const total = Math.max(myVibe.length, match.vibe.length);
            score += total > 0 ? (shared / total) * 25 : 0;
            possible += 25;
        }

        // Shared languages (15 pts)
        const myLangs = editLanguages.length > 0 ? editLanguages : profile?.languages || [];
        if (myLangs.length > 0 || match.languages.length > 0) {
            const shared = myLangs.filter((l) => match.languages.includes(l)).length;
            const total = Math.max(myLangs.length, match.languages.length);
            score += total > 0 ? (shared / total) * 15 : 0;
            possible += 15;
        }

        // Lifestyle alignment (15 pts: 5 each for smoking/drinking/pets)
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

        // Experience match (10 pts)
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

        // Normalise to percentage (if not enough data, scale up proportionally)
        const pct = possible > 0 ? Math.round((score / possible) * 100) : 0;

        // Nautical label
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

        // Color gradient
        const color = pct >= 75 ? 'emerald' : pct >= 50 ? 'sky' : pct >= 25 ? 'amber' : 'white';

        return { score: pct, label, color };
    };

    // --- LOADING ---
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
                        { key: 'my_profile' as FCView, label: '� My Listing' },
                        { key: 'board' as FCView, label: '� Browse' },
                        {
                            key: 'matches' as FCView,
                            label: `🤝 Connections${matches.length > 0 ? ` (${matches.length})` : ''}`,
                        },
                    ] as const
                ).map((tab) => (
                    <button
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
                    <div className="px-4 py-4 pb-44 flex flex-col min-h-full">
                        {/* Filters — hidden after search */}
                        {!hasSearched && (
                            <>
                                {/* Looking For label */}
                                <p className="text-xs font-black text-white/40 uppercase tracking-widest mb-2">
                                    Looking For
                                </p>
                                <div className="grid grid-cols-2 gap-3 mb-4">
                                    <button
                                        onClick={() =>
                                            setFilterListingType(
                                                filterListingType === 'seeking_crew' ? '' : 'seeking_crew',
                                            )
                                        }
                                        className={`py-4 rounded-2xl text-center transition-all border ${
                                            filterListingType === 'seeking_crew'
                                                ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10'
                                                : 'bg-white/[0.02] border-white/[0.06]'
                                        }`}
                                    >
                                        <span className="text-2xl block mb-1">⚓</span>
                                        <span
                                            className={`text-sm font-bold block ${filterListingType === 'seeking_crew' ? 'text-emerald-300' : 'text-white/70'}`}
                                        >
                                            A Captain
                                        </span>
                                    </button>
                                    <button
                                        onClick={() =>
                                            setFilterListingType(
                                                filterListingType === 'seeking_berth' ? '' : 'seeking_berth',
                                            )
                                        }
                                        className={`py-4 rounded-2xl text-center transition-all border ${
                                            filterListingType === 'seeking_berth'
                                                ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10'
                                                : 'bg-white/[0.02] border-white/[0.06]'
                                        }`}
                                    >
                                        <span className="text-2xl block mb-1">🧭</span>
                                        <span
                                            className={`text-sm font-bold block ${filterListingType === 'seeking_berth' ? 'text-emerald-300' : 'text-white/70'}`}
                                        >
                                            Crew
                                        </span>
                                    </button>
                                    {['Male', 'Female'].map((g) => (
                                        <button
                                            key={g}
                                            onClick={() => setFilterGender(filterGender === g ? '' : g)}
                                            className={`py-4 rounded-2xl text-center transition-all border ${
                                                filterGender === g
                                                    ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10'
                                                    : 'bg-white/[0.02] border-white/[0.06]'
                                            }`}
                                        >
                                            <span className="text-2xl block mb-1">{g === 'Male' ? '♂️' : '♀️'}</span>
                                            <span
                                                className={`text-sm font-bold block ${filterGender === g ? 'text-emerald-300' : 'text-white/70'}`}
                                            >
                                                {g}
                                            </span>
                                        </button>
                                    ))}
                                </div>

                                {/* Age bracket filter — shown after Captain/Crew selected */}
                                {filterListingType && (
                                    <div className="mb-4 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] fade-slide-down">
                                        <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 mb-2">
                                            Age Bracket
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {AGE_RANGES.map((age) => (
                                                <button
                                                    key={age}
                                                    onClick={() => {
                                                        setFilterAgeRanges((prev) =>
                                                            prev.includes(age)
                                                                ? prev.filter((a) => a !== age)
                                                                : [...prev, age],
                                                        );
                                                    }}
                                                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                                                        filterAgeRanges.includes(age)
                                                            ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/30'
                                                            : 'bg-white/[0.03] text-white/60 border border-white/[0.05]'
                                                    }`}
                                                >
                                                    {age}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Location Filters (optional) */}
                                <div className="px-6 mb-4">
                                    <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-white/40 mb-3">
                                        📍 Location (optional)
                                    </h3>
                                    <div className="space-y-2">
                                        <select
                                            value={filterLocationCountry}
                                            onChange={(e) => {
                                                setFilterLocationCountry(e.target.value);
                                                setFilterLocationState('');
                                            }}
                                            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500/30 transition-colors appearance-none"
                                            style={{
                                                backgroundImage:
                                                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")",
                                                backgroundRepeat: 'no-repeat',
                                                backgroundPosition: 'right 12px center',
                                                backgroundSize: '20px',
                                            }}
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
                                        {filterLocationCountry &&
                                            getStatesForCountry(filterLocationCountry).length > 0 && (
                                                <select
                                                    value={filterLocationState}
                                                    onChange={(e) => setFilterLocationState(e.target.value)}
                                                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-sky-500/30 transition-colors appearance-none"
                                                    style={{
                                                        backgroundImage:
                                                            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")",
                                                        backgroundRepeat: 'no-repeat',
                                                        backgroundPosition: 'right 12px center',
                                                        backgroundSize: '20px',
                                                    }}
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
                                        <input
                                            value={filterLocationCity}
                                            onChange={(e) => setFilterLocationCity(e.target.value)}
                                            onFocus={scrollInputAboveKeyboard}
                                            placeholder="City / Town (optional)"
                                            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors"
                                        />
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Pinned Search CTA — always visible */}
                        <div
                            className="fixed left-0 right-0 px-4 z-20"
                            style={{ bottom: 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}
                        >
                            <button
                                onClick={() => {
                                    if (hasSearched) {
                                        setHasSearched(false);
                                        setListings([]);
                                        setCurrentCardIndex(0);
                                        setCardPhotoIndex(0);
                                    } else {
                                        applyFilters();
                                    }
                                }}
                                disabled={
                                    !hasSearched &&
                                    (!filterListingType || !filterGender || filterAgeRanges.length === 0)
                                }
                                className={`w-full py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-2xl ${
                                    !hasSearched &&
                                    (!filterListingType || !filterGender || filterAgeRanges.length === 0)
                                        ? 'bg-white/[0.06] text-white/25 cursor-not-allowed'
                                        : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'
                                }`}
                            >
                                {hasSearched ? '🔍 New Search' : '🔍 Search'}
                            </button>
                        </div>

                        {/* ═══════ CARD STACK ═══════ */}
                        {listings.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-center">
                                {!filterListingType ? (
                                    /* Welcome state — no search yet */
                                    <div>
                                        <span className="text-5xl block mb-4">🌊</span>
                                        <h3 className="text-xl font-black text-white/60 mb-2">Find Your Sea Mate</h3>
                                        <p className="text-sm text-white/25 max-w-[240px] mx-auto leading-relaxed">
                                            Choose Captain or Crew above to start browsing. Your next adventure is
                                            waiting.
                                        </p>
                                    </div>
                                ) : (
                                    /* No results state — searched but empty */
                                    <>
                                        <span className="text-3xl block mb-4">🔍</span>
                                        <h3 className="text-lg font-bold text-white/60 mb-2">No Listings Yet</h3>
                                    </>
                                )}
                            </div>
                        ) : currentCardIndex >= listings.length ? (
                            /* ── End of cards ── */
                            <div className="text-center py-20">
                                <span className="text-5xl block mb-4">⚓</span>
                                <h3 className="text-xl font-black text-white/70 mb-2">You've seen all listings!</h3>
                                <p className="text-sm text-white/30 mb-6 max-w-[260px] mx-auto">
                                    That's all {listings.length} {listings.length === 1 ? 'listing' : 'listings'} for
                                    now. Check back later for new crew.
                                </p>
                                <button
                                    onClick={goToStart}
                                    className="px-6 py-3 rounded-2xl bg-gradient-to-r from-emerald-500/25 to-sky-500/25 border border-emerald-400/20 text-emerald-300 font-bold text-sm transition-all active:scale-95"
                                >
                                    ↩ Back to Beginning
                                </button>
                            </div>
                        ) : (
                            /* ── Active card ── */
                            <div className="relative">
                                {/* Counter */}
                                <div className="text-center mb-3">
                                    <span className="text-xs text-white/30 font-medium">
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
                                    const isMessaged = messagedUsers.has(card.user_id);
                                    const lastActive = getLastActiveLabel(card.last_active);
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
                                                        <img
                                                            src={allPhotos[cardPhotoIndex % allPhotos.length]}
                                                            alt=""
                                                            className="w-full h-full object-cover"
                                                        />
                                                        {/* Tap zones: left = prev, right = next */}
                                                        {allPhotos.length > 1 && (
                                                            <>
                                                                <div
                                                                    className="absolute top-0 left-0 w-1/2 h-full z-10 cursor-pointer"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setCardPhotoIndex((prev) =>
                                                                            Math.max(0, prev - 1),
                                                                        );
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
                                                        {/* Photo dots */}
                                                        {allPhotos.length > 1 && (
                                                            <div className="absolute top-3 left-0 right-0 flex justify-center gap-1.5 z-20">
                                                                {allPhotos.map((_, i) => (
                                                                    <div
                                                                        key={i}
                                                                        className={`rounded-full transition-all ${
                                                                            i === cardPhotoIndex % allPhotos.length
                                                                                ? 'w-2 h-2 bg-white shadow-lg'
                                                                                : 'w-1.5 h-1.5 bg-white/40'
                                                                        }`}
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

                                                {/* Gradient overlay */}
                                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

                                                {/* Name + type overlay */}
                                                <div className="absolute bottom-0 left-0 right-0 p-5">
                                                    <div className="flex items-end justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2">
                                                                <h2 className="text-2xl font-black text-white mb-1">
                                                                    {card.display_name}
                                                                </h2>
                                                                {card.is_verified && (
                                                                    <span
                                                                        className="w-5 h-5 rounded-full bg-sky-500/30 border border-sky-400/40 flex items-center justify-center text-[11px] text-sky-200"
                                                                        title="Verified"
                                                                    >
                                                                        ✓
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                {card.listing_type && (
                                                                    <span
                                                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider ${
                                                                            card.listing_type === 'seeking_crew'
                                                                                ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-400/20'
                                                                                : 'bg-amber-500/25 text-amber-300 border border-amber-400/20'
                                                                        }`}
                                                                    >
                                                                        {card.listing_type === 'seeking_crew'
                                                                            ? '⚓ Captain'
                                                                            : '🧭 Crew'}
                                                                    </span>
                                                                )}
                                                                {card.age_range && (
                                                                    <span className="text-sm text-white/50">
                                                                        {card.age_range}
                                                                    </span>
                                                                )}
                                                                {lastActive && (
                                                                    <span
                                                                        className={`text-[11px] font-medium ${lastActive.color}`}
                                                                    >
                                                                        ● {lastActive.text}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {/* Interaction badges */}
                                                        <div className="flex gap-1.5">
                                                            {isLiked && (
                                                                <span
                                                                    className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-sm"
                                                                    title="Interested"
                                                                >
                                                                    ⭐
                                                                </span>
                                                            )}
                                                            {isMessaged && (
                                                                <span
                                                                    className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-400/30 flex items-center justify-center text-sm"
                                                                    title="Messaged"
                                                                >
                                                                    💬
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Card body */}
                                            <div className="p-5 space-y-4">
                                                {/* Quick facts grid */}
                                                <div className="flex flex-wrap gap-2">
                                                    {(card.location_city ||
                                                        card.location_state ||
                                                        card.location_country) && (
                                                        <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">
                                                            📍{' '}
                                                            {[
                                                                card.location_city,
                                                                card.location_state,
                                                                card.location_country,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(', ')}
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
                                                    {card.gender && (
                                                        <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">
                                                            {card.gender}
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

                                                {/* Skills */}
                                                {card.skills.length > 0 && (
                                                    <div>
                                                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/30 mb-1.5">
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

                                                {/* Availability */}
                                                {(card.available_from ||
                                                    (card.available_to && !isOpenEnded(card.available_to))) && (
                                                    <div className="flex items-center gap-1.5 text-xs text-emerald-400/60">
                                                        <span>📅</span>
                                                        {card.available_from && isOpenEnded(card.available_to) ? (
                                                            <span>
                                                                Available from {formatDate(card.available_from)}
                                                            </span>
                                                        ) : (
                                                            <>
                                                                {card.available_from && (
                                                                    <span>From {formatDate(card.available_from)}</span>
                                                                )}
                                                                {card.available_from && card.available_to && (
                                                                    <span>—</span>
                                                                )}
                                                                {card.available_to && (
                                                                    <span>{formatDate(card.available_to)}</span>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Bio */}
                                                {card.bio && (
                                                    <p className="text-sm text-white/40 leading-relaxed">{card.bio}</p>
                                                )}
                                            </div>

                                            {/* Action buttons */}
                                            <div className="px-5 pb-5 flex gap-3">
                                                {isMatched ? (
                                                    <button
                                                        onClick={() => {
                                                            trackMessagedUser(card.user_id);
                                                            onOpenDM(card.user_id, card.display_name);
                                                        }}
                                                        disabled={messagedUsers.has(card.user_id)}
                                                        className={`flex-1 py-3.5 rounded-2xl font-bold text-sm transition-all active:scale-[0.97] ${
                                                            messagedUsers.has(card.user_id)
                                                                ? 'bg-white/[0.04] text-white/25 cursor-not-allowed'
                                                                : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-xl shadow-emerald-500/15'
                                                        }`}
                                                    >
                                                        {messagedUsers.has(card.user_id)
                                                            ? '✓ Message Sent'
                                                            : '💬 Message'}
                                                    </button>
                                                ) : (
                                                    <div className="flex-1 py-3.5 rounded-2xl text-center bg-white/[0.03] border border-white/[0.06]">
                                                        <span className="text-xs text-white/30 font-medium">
                                                            {isLiked
                                                                ? '⏳ Waiting for them to star you back'
                                                                : '⭐ Star to connect'}
                                                        </span>
                                                    </div>
                                                )}
                                                <button
                                                    onClick={() => handleLike(card)}
                                                    className={`w-14 rounded-2xl flex items-center justify-center text-xl transition-all active:scale-90 border ${
                                                        isLiked
                                                            ? 'bg-amber-500/20 border-amber-400/30 text-amber-300'
                                                            : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:bg-amber-500/10'
                                                    }`}
                                                >
                                                    ⭐
                                                </button>
                                                {/* Super Like */}
                                                {!isLiked && !superLikeUsed && (
                                                    <button
                                                        onClick={() => {
                                                            setShowSuperLikeModal(card);
                                                            setSuperLikeMessage('');
                                                        }}
                                                        className="w-14 rounded-2xl flex items-center justify-center text-xl transition-all active:scale-90 bg-gradient-to-r from-violet-500/20 to-pink-500/20 border border-violet-400/20 text-violet-300 hover:from-violet-500/30 hover:to-pink-500/30"
                                                        title="Super Like — send with a message!"
                                                    >
                                                        ⚡
                                                    </button>
                                                )}
                                                {/* Action menu (block/report) */}
                                                <div className="relative">
                                                    <button
                                                        onClick={() =>
                                                            setShowActionMenu(
                                                                showActionMenu === card.user_id ? null : card.user_id,
                                                            )
                                                        }
                                                        className="w-10 rounded-2xl flex items-center justify-center text-lg transition-all active:scale-90 bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/50"
                                                    >
                                                        ⋮
                                                    </button>
                                                    {showActionMenu === card.user_id && (
                                                        <div className="absolute right-0 bottom-full mb-2 w-40 rounded-xl bg-slate-800 border border-white/10 shadow-2xl overflow-hidden z-50">
                                                            <button
                                                                onClick={() =>
                                                                    handleBlock(card.user_id, card.display_name)
                                                                }
                                                                className="w-full px-4 py-3 text-left text-sm text-white/60 hover:bg-white/5 transition-colors"
                                                            >
                                                                🚫 Block
                                                            </button>
                                                            <button
                                                                onClick={() => {
                                                                    setShowReportModal(card.user_id);
                                                                    setShowActionMenu(null);
                                                                }}
                                                                className="w-full px-4 py-3 text-left text-sm text-red-400/60 hover:bg-red-500/10 transition-colors border-t border-white/[0.05]"
                                                            >
                                                                🚩 Report
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Navigation buttons — pinned above CTA */}
                                <div className="fixed left-0 right-0 bottom-0 z-10">
                                    {/* Fade-out gradient to mask content */}
                                    <div className="h-8 bg-gradient-to-t from-[#0c1220] to-transparent" />
                                    <div
                                        className="bg-[#0c1220] px-4"
                                        style={{ paddingBottom: 'calc(64px + env(safe-area-inset-bottom) + 72px)' }}
                                    >
                                        <div className="flex justify-between items-center">
                                            <button
                                                onClick={goToPrevCard}
                                                disabled={currentCardIndex <= 0}
                                                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                                                    currentCardIndex <= 0
                                                        ? 'text-white/15 cursor-not-allowed'
                                                        : 'text-white/50 bg-white/[0.03] border border-white/[0.06] active:scale-95'
                                                }`}
                                            >
                                                ‹ Previous
                                            </button>
                                            {/* Progress dots */}
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
                                                                className={`rounded-full transition-all ${
                                                                    actualIdx === currentCardIndex
                                                                        ? 'w-2.5 h-2.5 bg-emerald-400'
                                                                        : 'w-1.5 h-1.5 bg-white/15'
                                                                }`}
                                                            />
                                                        );
                                                    })}
                                                {currentCardIndex + 4 < listings.length && (
                                                    <span className="text-[11px] text-white/20 ml-0.5">…</span>
                                                )}
                                            </div>
                                            <button
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
                )}

                {/* ══════ DETAIL VIEW ══════ */}
                {view === 'detail' && selectedCard && (
                    <div className="px-4 py-5">
                        {/* Back button */}
                        <button
                            onClick={() => setView('board')}
                            className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white/60 mb-4 transition-colors"
                        >
                            ← Back to listings
                        </button>

                        {/* Profile header */}
                        <div className="text-center mb-6">
                            <div className="w-28 h-28 mx-auto rounded-2xl overflow-hidden border-3 border-white/[0.08] shadow-2xl mb-4">
                                {selectedCard.avatar_url ? (
                                    <img src={selectedCard.avatar_url} loading="lazy" alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-emerald-500/15 to-sky-500/15 flex items-center justify-center">
                                        <span className="text-3xl">
                                            {selectedCard.listing_type === 'seeking_crew' ? '🚢' : '⛵'}
                                        </span>
                                    </div>
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-white/90 mb-0.5">{selectedCard.display_name}</h2>
                            {selectedCard.age_range && (
                                <p className="text-sm text-white/35 mb-1">{selectedCard.age_range}</p>
                            )}
                            {selectedCard.listing_type && (
                                <span
                                    className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${
                                        selectedCard.listing_type === 'seeking_crew'
                                            ? 'bg-emerald-500/15 text-emerald-300/80'
                                            : 'bg-amber-500/15 text-amber-300/80'
                                    }`}
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
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Home Port
                                        </p>
                                        <p className="text-sm text-white/70">🏠 {selectedCard.home_port}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_region && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Region
                                        </p>
                                        <p className="text-sm text-white/70">📍 {selectedCard.sailing_region}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_experience && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Experience
                                        </p>
                                        <p className="text-sm text-white/70">🧭 {selectedCard.sailing_experience}</p>
                                    </div>
                                )}
                                {selectedCard.gender && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Gender
                                        </p>
                                        <p className="text-sm text-white/70">{selectedCard.gender}</p>
                                    </div>
                                )}
                                {selectedCard.age_range && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
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

                            {/* Availability — smart date display */}
                            {(selectedCard.available_from ||
                                (selectedCard.available_to && !isOpenEnded(selectedCard.available_to))) && (
                                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300/40 mb-1">
                                        Availability
                                    </p>
                                    <p className="text-sm text-emerald-200/70">
                                        📅{' '}
                                        {selectedCard.available_from
                                            ? formatDate(selectedCard.available_from)
                                            : 'Flexible'}
                                        {!isOpenEnded(selectedCard.available_to) && selectedCard.available_to
                                            ? ` — ${formatDate(selectedCard.available_to)}`
                                            : ' onwards'}
                                    </p>
                                </div>
                            )}

                            {/* Skills */}
                            {selectedCard.skills.length > 0 && (
                                <div>
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-2">
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
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-2">
                                        📝 About
                                    </h3>
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
                                    onClick={() => {
                                        trackMessagedUser(selectedCard.user_id);
                                        onOpenDM(selectedCard.user_id, selectedCard.display_name);
                                    }}
                                    disabled={messagedUsers.has(selectedCard.user_id)}
                                    className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-xl ${
                                        messagedUsers.has(selectedCard.user_id)
                                            ? 'bg-white/[0.04] text-white/25 cursor-not-allowed shadow-none'
                                            : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'
                                    }`}
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
                                onClick={() => handleLike(selectedCard)}
                                className={`w-16 rounded-2xl flex items-center justify-center text-2xl transition-all active:scale-90 border ${
                                    likedUsers.has(selectedCard.user_id)
                                        ? 'bg-amber-500/20 border-amber-400/30'
                                        : 'bg-white/[0.03] border-white/[0.06]'
                                }`}
                            >
                                ⭐
                            </button>
                        </div>
                    </div>
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
                    <div className="px-4 py-5">
                        {matches.length === 0 ? (
                            <div className="text-center py-16">
                                <span className="text-3xl block mb-4">🤝</span>
                                <h3 className="text-lg font-bold text-white/60 mb-2">No Connections Yet</h3>
                                <p className="text-sm text-white/25">
                                    When you ⭐ someone and they ⭐ you back, you'll both appear here. Start browsing!
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {matches.map((match) => {
                                    const compat = getCompatibility(match);
                                    const colorClasses =
                                        compat.color === 'emerald'
                                            ? 'text-emerald-300 border-emerald-400/30 bg-emerald-500/15'
                                            : compat.color === 'sky'
                                              ? 'text-sky-300 border-sky-400/30 bg-sky-500/15'
                                              : compat.color === 'amber'
                                                ? 'text-amber-300 border-amber-400/30 bg-amber-500/15'
                                                : 'text-white/40 border-white/10 bg-white/5';
                                    const barColor =
                                        compat.color === 'emerald'
                                            ? 'bg-emerald-400'
                                            : compat.color === 'sky'
                                              ? 'bg-sky-400'
                                              : compat.color === 'amber'
                                                ? 'bg-amber-400'
                                                : 'bg-white/20';
                                    return (
                                        <button
                                            key={match.user_id}
                                            onClick={() => onOpenDM(match.user_id, match.display_name)}
                                            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-emerald-400/10 transition-all active:scale-[0.98]"
                                        >
                                            <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-emerald-400/20 flex-shrink-0">
                                                {match.avatar_url ? (
                                                    <img
                                                        src={match.avatar_url}
                                                        alt=""
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full bg-gradient-to-br from-emerald-500/10 to-sky-500/10 flex items-center justify-center">
                                                        <span className="text-xl">⛵</span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex-1 text-left min-w-0">
                                                <p className="text-base font-semibold text-white/80 truncate">
                                                    {match.display_name}
                                                </p>
                                                <p className="text-xs text-white/60 truncate">
                                                    {match.home_port ? `📍 ${match.home_port}` : ''}
                                                </p>
                                                {/* Compatibility bar */}
                                                {compat.score > 0 && (
                                                    <div className="mt-1.5">
                                                        <div className="flex items-center gap-2 mb-0.5">
                                                            <span
                                                                className={`text-[11px] font-bold ${compat.color === 'emerald' ? 'text-emerald-300' : compat.color === 'sky' ? 'text-sky-300' : compat.color === 'amber' ? 'text-amber-300' : 'text-white/30'}`}
                                                            >
                                                                {compat.score}% · {compat.label}
                                                            </span>
                                                        </div>
                                                        <div className="w-full h-1 rounded-full bg-white/[0.05] overflow-hidden">
                                                            <div
                                                                className={`h-full rounded-full ${barColor} transition-all`}
                                                                style={{ width: `${compat.score}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                                {/* Round 2: Interest badges */}
                                                {match.interests.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-1.5">
                                                        {match.interests.slice(0, 4).map((i) => (
                                                            <span
                                                                key={i}
                                                                className="px-2 py-0.5 rounded-full bg-amber-500/10 text-[11px] text-amber-200/60 border border-amber-500/10"
                                                            >
                                                                {i}
                                                            </span>
                                                        ))}
                                                        {match.interests.length > 4 && (
                                                            <span className="px-2 py-0.5 rounded-full bg-white/[0.03] text-[11px] text-white/25">
                                                                +{match.interests.length - 4}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                {/* Icebreaker tips */}
                                                {(() => {
                                                    const tips = getIcebreakers(match);
                                                    return tips.length > 0 ? (
                                                        <div className="mt-1">
                                                            {tips.map((tip, i) => (
                                                                <p
                                                                    key={i}
                                                                    className="text-[11px] text-violet-300/40 italic"
                                                                >
                                                                    💡 {tip}
                                                                </p>
                                                            ))}
                                                        </div>
                                                    ) : null;
                                                })()}
                                            </div>
                                            <div
                                                className={`w-11 h-11 rounded-xl border flex items-center justify-center flex-shrink-0 ${colorClasses}`}
                                            >
                                                <span className="text-xs font-bold">
                                                    {compat.score > 0 ? `${compat.score}%` : '💬'}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Delete listing confirmation */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                title="Delete Your Listing?"
                message="This will permanently remove your crew listing from the board. You can always create a new one later."
                confirmLabel={deleting ? 'Deleting...' : 'Delete Listing'}
                cancelLabel="Keep It"
                onConfirm={handleDeleteProfile}
                onCancel={() => setShowDeleteConfirm(false)}
                destructive
            />

            {/* Report Modal */}
            {showReportModal && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowReportModal(null)}
                >
                    <div
                        className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-[90%] max-w-sm shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-lg font-bold text-white/80 mb-3">🚩 Report User</h3>
                        <p className="text-xs text-white/40 mb-4">Help us keep the community safe. What's the issue?</p>
                        <select
                            value={reportReason}
                            onChange={(e) => setReportReason(e.target.value)}
                            className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 mb-4 outline-none focus:border-white/20"
                        >
                            <option value="">Select a reason...</option>
                            <option value="Fake profile">Fake profile</option>
                            <option value="Inappropriate content">Inappropriate content</option>
                            <option value="Harassment">Harassment</option>
                            <option value="Spam">Spam</option>
                            <option value="Other">Other</option>
                        </select>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowReportModal(null)}
                                className="flex-1 py-3 rounded-xl bg-white/[0.05] text-sm text-white/40 font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleReport}
                                disabled={!reportReason}
                                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${
                                    reportReason
                                        ? 'bg-red-500/20 text-red-300 border border-red-500/20'
                                        : 'bg-white/[0.03] text-white/20 cursor-not-allowed'
                                }`}
                            >
                                Submit Report
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Super Like Modal */}
            {showSuperLikeModal && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowSuperLikeModal(null)}
                >
                    <div
                        className="bg-slate-900 border border-violet-500/20 rounded-2xl p-6 w-[90%] max-w-sm shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-violet-300 to-pink-300 mb-1">
                            ⚡ Super Like
                        </h3>
                        <p className="text-xs text-white/40 mb-4">
                            Send {showSuperLikeModal.display_name} a message with your star! (1 per day)
                        </p>
                        <textarea
                            value={superLikeMessage}
                            onChange={(e) => setSuperLikeMessage(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            placeholder="Hey! I noticed we both love diving..."
                            maxLength={200}
                            className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 mb-1 outline-none focus:border-violet-400/30 resize-none h-24"
                        />
                        <p className="text-[11px] text-white/20 text-right mb-4">{superLikeMessage.length}/200</p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowSuperLikeModal(null)}
                                className="flex-1 py-3 rounded-xl bg-white/[0.05] text-sm text-white/40 font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSuperLike}
                                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-violet-500/30 to-pink-500/30 text-sm font-bold text-violet-200 border border-violet-400/20 transition-all active:scale-[0.97]"
                            >
                                ⚡ Send Super Like
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
