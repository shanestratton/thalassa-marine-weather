/**
 * Find Crew Page — Crew Board & Sailor Connections
 * 
 * Professional crew marketplace:
 * - Browse: Filterable feed of crew/skipper listings
 * - Detail: Full profile view with DM action
 * - My Listing: Rich profile form (skills, availability, partner, etc.)
 * - Matches: Mutual interest list with DM
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    LonelyHeartsService,
    CrewCard,
    SailorMatch,
    CrewProfile,
    CrewSearchFilters,
    ListingType,
    SKILL_OPTIONS,
    GENDER_OPTIONS,
    AGE_RANGES,
    EXPERIENCE_LEVELS,
    LISTING_TYPES,
} from '../services/LonelyHeartsService';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from './Toast';
import { triggerHaptic } from '../utils/system';

interface LonelyHeartsPageProps {
    onOpenDM: (userId: string, name: string) => void;
}

type FCView = 'board' | 'detail' | 'my_profile' | 'matches';

export const LonelyHeartsPage: React.FC<LonelyHeartsPageProps> = ({ onOpenDM }) => {
    const [view, setView] = useState<FCView>('my_profile');
    const [loading, setLoading] = useState(true);

    // Board
    const [listings, setListings] = useState<CrewCard[]>([]);
    const [filters, setFilters] = useState<CrewSearchFilters>({});
    const [filterListingType, setFilterListingType] = useState<ListingType | ''>('');
    const [filterGender, setFilterGender] = useState('');
    const [filterAgeRanges, setFilterAgeRanges] = useState<string[]>([]);
    const [filterSkills, setFilterSkills] = useState<string[]>([]);
    const [filterExperience, setFilterExperience] = useState('');
    const [filterRegion, setFilterRegion] = useState('');
    const [showFilters, setShowFilters] = useState(false);

    // Detail
    const [selectedCard, setSelectedCard] = useState<CrewCard | null>(null);

    // Matches
    const [matches, setMatches] = useState<SailorMatch[]>([]);
    const [hasSearched, setHasSearched] = useState(false);

    // My Profile form
    const [profile, setProfile] = useState<Partial<CrewProfile>>({});
    const [editListingType, setEditListingType] = useState<ListingType | ''>('');
    const [editFirstName, setEditFirstName] = useState('');
    const [editGender, setEditGender] = useState('');
    const [editAge, setEditAge] = useState('');
    const [editHasPartner, setEditHasPartner] = useState(false);
    const [editPartnerDetails, setEditPartnerDetails] = useState('');
    const [editSkills, setEditSkills] = useState<string[]>([]);
    const [editExperience, setEditExperience] = useState('');
    const [editRegion, setEditRegion] = useState('');
    const [editAvailFrom, setEditAvailFrom] = useState('');
    const [editAvailTo, setEditAvailTo] = useState('');
    const [editBio, setEditBio] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    // Photo (up to 6)
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    const [uploadingPhotoIdx, setUploadingPhotoIdx] = useState<number | null>(null);
    const [photoError, setPhotoError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [pendingPhotoIdx, setPendingPhotoIdx] = useState(0);
    // Delete listing
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Card stack state
    const [currentCardIndex, setCurrentCardIndex] = useState(0);
    const [cardPhotoIndex, setCardPhotoIndex] = useState(0);
    const [swipeX, setSwipeX] = useState(0);
    const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
    const [isAnimating, setIsAnimating] = useState(false);
    const swipeStartX = useRef(0);
    const swipeStartY = useRef(0);
    const isSwipeTracking = useRef(false);
    const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);

    // Track interactions
    const [likedUsers, setLikedUsers] = useState<Set<string>>(() => {
        try {
            const saved = localStorage.getItem('crew_liked_users');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch { return new Set(); }
    });
    const [messagedUsers, setMessagedUsers] = useState<Set<string>>(() => {
        try {
            const saved = localStorage.getItem('crew_messaged_users');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch { return new Set(); }
    });

    // --- INIT ---
    useEffect(() => {
        const init = async () => {
            await LonelyHeartsService.init();
            await Promise.all([loadMatches(), loadProfile()]);
            setLoading(false);
        };
        init();
    }, []);

    const loadListings = useCallback(async (f?: CrewSearchFilters) => {
        const applied = f || filters;
        const data = await LonelyHeartsService.getCrewListings(applied);
        setListings(data);
    }, [filters]);

    const loadMatches = async () => {
        const m = await LonelyHeartsService.getMatches();
        setMatches(m);
    };

    const loadProfile = async () => {
        const dp = await LonelyHeartsService.getCrewProfile();
        if (dp) {
            setProfile(dp);
            setEditListingType(dp.listing_type || '');
            setEditFirstName(dp.first_name || '');
            setEditGender(dp.gender || '');
            setEditAge(dp.age_range || '');
            setEditHasPartner(dp.has_partner || false);
            setEditPartnerDetails(dp.partner_details || '');
            setEditSkills(dp.skills || []);
            setEditExperience(dp.sailing_experience || '');
            setEditRegion(dp.sailing_region || '');
            setEditAvailFrom(dp.available_from || '');
            setEditAvailTo(dp.available_to || '');
            setEditBio(dp.bio || '');
            setEditPhotos(dp.photos?.length ? dp.photos : dp.photo_url ? [dp.photo_url] : []);
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
        setFilters(f);
        setLoading(true);
        await loadListings(f);
        setLoading(false);
        setShowFilters(false);
        setHasSearched(true);
    };

    const clearFilters = async () => {
        setFilterListingType('');
        setFilterGender('');
        setFilterAgeRanges([]);
        setFilterSkills([]);
        setFilterExperience('');
        setFilterRegion('');
        setFilters({});
        setLoading(true);
        await loadListings({});
        setLoading(false);
        setShowFilters(false);
    };

    const toggleFilterSkill = (skill: string) => {
        setFilterSkills(prev =>
            prev.includes(skill) ? prev.filter(s => s !== skill) : [...prev, skill]
        );
    };

    // --- SAVE PROFILE ---
    const handleSaveProfile = async () => {
        setSaving(true);
        await LonelyHeartsService.updateCrewProfile({
            listing_type: editListingType as ListingType || null,
            first_name: editFirstName.trim() || null,
            gender: editGender || null,
            age_range: editAge || null,
            has_partner: editHasPartner,
            partner_details: editHasPartner ? editPartnerDetails.trim() || null : null,
            skills: editSkills,
            sailing_experience: editExperience || null,
            sailing_region: editRegion.trim() || null,
            available_from: editAvailFrom || null,
            available_to: editAvailTo || null,
            bio: editBio.trim() || null,
            photo_url: editPhotos[0] || null,
        });
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
    };

    const toggleEditSkill = (skill: string) => {
        setEditSkills(prev =>
            prev.includes(skill) ? prev.filter(s => s !== skill) : [...prev, skill]
        );
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
            setEditPhotos(prev => {
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
        setEditPhotos(prev => prev.filter((_, i) => i !== idx));
    };

    // --- LIKE / INTEREST ---
    const handleLike = async (card: CrewCard) => {
        const alreadyLiked = likedUsers.has(card.user_id);

        if (alreadyLiked) {
            // Unstar
            setLikedUsers(prev => {
                const next = new Set(prev);
                next.delete(card.user_id);
                try { localStorage.setItem('crew_liked_users', JSON.stringify([...next])); } catch { }
                return next;
            });
            await LonelyHeartsService.recordLike(card.user_id, false);
            await loadMatches();
        } else {
            // Star
            setLikedUsers(prev => {
                const next = new Set(prev);
                next.add(card.user_id);
                try { localStorage.setItem('crew_liked_users', JSON.stringify([...next])); } catch { }
                return next;
            });
            const result = await LonelyHeartsService.recordLike(card.user_id, true);
            if (result.matched) {
                await loadMatches();
                window.alert(`⭐ It's a Match!\n\nYou and ${card.display_name} starred each other! You can now send them a message.`);
            }
        }
    };
    // Track messaged users
    const trackMessagedUser = useCallback((userId: string) => {
        setMessagedUsers(prev => {
            const next = new Set(prev);
            next.add(userId);
            try { localStorage.setItem('crew_messaged_users', JSON.stringify([...next])); } catch { }
            return next;
        });
    }, []);

    // --- CARD STACK NAVIGATION ---
    const goToNextCard = useCallback(() => {
        if (isAnimating || listings.length === 0) return;
        setIsAnimating(true);
        setSwipeDirection('left');
        setTimeout(() => {
            setCurrentCardIndex(prev => Math.min(prev + 1, listings.length));
            setCardPhotoIndex(0);
            setSwipeDirection(null);
            setSwipeX(0);
            setIsAnimating(false);
        }, 250);
    }, [listings.length, isAnimating]);

    const goToPrevCard = useCallback(() => {
        if (isAnimating || currentCardIndex <= 0) return;
        setIsAnimating(true);
        setSwipeDirection('right');
        setTimeout(() => {
            setCurrentCardIndex(prev => Math.max(prev - 1, 0));
            setCardPhotoIndex(0);
            setSwipeDirection(null);
            setSwipeX(0);
            setIsAnimating(false);
        }, 250);
    }, [currentCardIndex, isAnimating]);

    const goToStart = useCallback(() => {
        setCurrentCardIndex(0);
        setCardPhotoIndex(0);
        setSwipeDirection(null);
        setSwipeX(0);
    }, []);

    // Reset card index when listings change
    useEffect(() => {
        setCurrentCardIndex(0);
        setCardPhotoIndex(0);
    }, [filters]);

    // Swipe gesture handlers
    const handleCardTouchStart = useCallback((e: React.TouchEvent) => {
        if (isAnimating) return;
        swipeStartX.current = e.touches[0].clientX;
        swipeStartY.current = e.touches[0].clientY;
        isSwipeTracking.current = true;
        directionLocked.current = null;
    }, [isAnimating]);

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
        } catch (e) { console.warn('[LonelyHeartsPage]', e); return iso; }
    };

    /** Detect sentinel end dates (2038+) that mean "open-ended" */
    const isOpenEnded = (iso: string | null) => {
        if (!iso) return true;
        try { return new Date(iso).getFullYear() >= 2038; } catch (e) { console.warn('[LonelyHeartsPage]', e); return false; }
    };

    // --- DELETE LISTING ---
    const handleDeleteProfile = useCallback(async () => {
        setDeleting(true);
        triggerHaptic('medium');
        const success = await LonelyHeartsService.deleteCrewProfile();
        if (success) {
            // Reset all form state
            setProfile({});
            setEditListingType('');
            setEditFirstName('');
            setEditGender('');
            setEditAge('');
            setEditHasPartner(false);
            setEditPartnerDetails('');
            setEditSkills([]);
            setEditExperience('');
            setEditRegion('');
            setEditAvailFrom('');
            setEditAvailTo('');
            setEditBio('');
            setEditPhotos([]);
            toast.success('Listing removed from board');
            setView('board');
            await loadListings();
        } else {
            toast.error('Failed to delete listing');
        }
        setDeleting(false);
        setShowDeleteConfirm(false);
    }, [loadListings]);

    /** Get the current user's ID from the service (for own-card detection) */
    const currentUserId = (LonelyHeartsService as any).currentUserId as string | null;

    const activeFilterCount = (filterListingType ? 1 : 0) + (filterSkills.length > 0 ? 1 : 0) + (filterExperience ? 1 : 0) + (filterRegion ? 1 : 0);
    const matchedUserIds = new Set(matches.map(m => m.user_id));

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
        <div className="flex flex-col h-full">
            {/* Tab bar */}
            <div className="flex-shrink-0 flex border-b border-white/[0.04]">
                {([
                    { key: 'my_profile' as FCView, label: '� My Listing' },
                    { key: 'board' as FCView, label: '� Browse' },
                    { key: 'matches' as FCView, label: `🤝 Connections${matches.length > 0 ? ` (${matches.length})` : ''}` },
                ] as const).map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => {
                            if (tab.key === 'board' && !profile?.listing_type) {
                                setView('my_profile');
                                window.alert('Please create your listing first before browsing profiles.');
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
            <div className="flex-1 overflow-y-auto overscroll-contain pb-24" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>

                {/* ══════ BROWSE BOARD ══════ */}
                {view === 'board' && (
                    <div className="px-4 py-4 pb-44 flex flex-col min-h-full">
                        {/* Filters — hidden after search */}
                        {!hasSearched && (
                            <>
                                {/* Captain / Crew toggle */}
                                <div className="flex gap-3 mb-4">
                                    <button
                                        onClick={() => setFilterListingType(filterListingType === 'seeking_crew' ? '' : 'seeking_crew')}
                                        className={`flex-1 py-4 rounded-2xl text-center transition-all border ${filterListingType === 'seeking_crew'
                                            ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10'
                                            : 'bg-white/[0.02] border-white/[0.06]'
                                            }`}
                                    >
                                        <span className="text-2xl block mb-1">⚓</span>
                                        <span className={`text-sm font-bold block ${filterListingType === 'seeking_crew' ? 'text-emerald-300' : 'text-white/70'}`}>Captain</span>
                                        <span className="text-[11px] text-white/30 block mt-0.5">Looking for crew</span>
                                    </button>
                                    <button
                                        onClick={() => setFilterListingType(filterListingType === 'seeking_berth' ? '' : 'seeking_berth')}
                                        className={`flex-1 py-4 rounded-2xl text-center transition-all border ${filterListingType === 'seeking_berth'
                                            ? 'bg-emerald-500/15 border-emerald-400/25 shadow-lg shadow-emerald-500/10'
                                            : 'bg-white/[0.02] border-white/[0.06]'
                                            }`}
                                    >
                                        <span className="text-2xl block mb-1">🧭</span>
                                        <span className={`text-sm font-bold block ${filterListingType === 'seeking_berth' ? 'text-emerald-300' : 'text-white/70'}`}>Crew</span>
                                        <span className="text-[11px] text-white/30 block mt-0.5">Looking for a captain</span>
                                    </button>
                                </div>

                                {/* Gender & Age filters — only shown after selection */}
                                {filterListingType && (
                                    <div className="mb-4 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-4 fade-slide-down">
                                        {/* Gender filter */}
                                        <div>
                                            <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 mb-2">Gender</p>
                                            <div className="flex gap-2">
                                                {['Male', 'Female'].map(g => (
                                                    <button
                                                        key={g}
                                                        onClick={() => setFilterGender(filterGender === g ? '' : g)}
                                                        className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-all ${filterGender === g
                                                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/25'
                                                            : 'bg-white/[0.03] text-white/60 border border-white/[0.05]'
                                                            }`}
                                                    >
                                                        {g}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Age bracket filter — multi-select */}
                                        <div>
                                            <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 mb-2">Age Bracket</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {AGE_RANGES.map(age => (
                                                    <button
                                                        key={age}
                                                        onClick={() => {
                                                            setFilterAgeRanges(prev =>
                                                                prev.includes(age)
                                                                    ? prev.filter(a => a !== age)
                                                                    : [...prev, age]
                                                            );
                                                        }}
                                                        className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${filterAgeRanges.includes(age)
                                                            ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/30'
                                                            : 'bg-white/[0.03] text-white/60 border border-white/[0.05]'
                                                            }`}
                                                    >
                                                        {age}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Pinned Search CTA */}
                                <div className="fixed left-0 right-0 px-4 z-20" style={{ bottom: 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                                    <button
                                        onClick={applyFilters}
                                        disabled={!filterListingType}
                                        className={`w-full py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-2xl ${filterListingType
                                            ? 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'
                                            : 'bg-white/[0.06] text-white/25 cursor-not-allowed'
                                            }`}
                                    >
                                        🔍 Search
                                    </button>
                                </div>
                            </>
                        )}

                        {/* ═══════ CARD STACK ═══════ */}
                        {listings.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-center">
                                {!filterListingType ? (
                                    /* Welcome state — no search yet */
                                    <div>
                                        <span className="text-5xl block mb-4">🌊</span>
                                        <h3 className="text-xl font-black text-white/60 mb-2">Find Your Sea Mate</h3>
                                        <p className="text-sm text-white/25 max-w-[240px] mx-auto leading-relaxed">
                                            Choose Captain or Crew above to start browsing. Your next adventure is waiting.
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
                                    That's all {listings.length} {listings.length === 1 ? 'listing' : 'listings'} for now. Check back later for new crew.
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
                                    <span className="text-xs text-white/30 font-medium">{currentCardIndex + 1} of {listings.length}</span>
                                </div>

                                {/* Swipeable Card */}
                                {(() => {
                                    const card = listings[currentCardIndex];
                                    const allPhotos = card.photos?.length > 0
                                        ? card.photos
                                        : (card.photo_url || card.avatar_url)
                                            ? [card.photo_url || card.avatar_url || '']
                                            : [];
                                    const isLiked = likedUsers.has(card.user_id);
                                    const isMatched = matchedUserIds.has(card.user_id);
                                    const isMessaged = messagedUsers.has(card.user_id);
                                    const cardRotation = swipeX * 0.03;
                                    const cardOpacity = 1 - Math.abs(swipeX) / 400;
                                    const exitTransform = swipeDirection === 'left' ? 'translateX(-120%) rotate(-8deg)'
                                        : swipeDirection === 'right' ? 'translateX(120%) rotate(8deg)' : `translateX(${swipeX}px) rotate(${cardRotation}deg)`;

                                    return (
                                        <div
                                            key={card.user_id}
                                            onTouchStart={handleCardTouchStart}
                                            onTouchMove={handleCardTouchMove}
                                            onTouchEnd={handleCardTouchEnd}
                                            style={{
                                                transform: swipeDirection ? exitTransform : `translateX(${swipeX}px) rotate(${cardRotation}deg)`,
                                                opacity: swipeDirection ? 0 : cardOpacity,
                                                transition: swipeDirection || swipeX === 0 ? 'transform 0.25s ease-out, opacity 0.25s ease-out' : 'none',
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
                                                                    onClick={(e) => { e.stopPropagation(); setCardPhotoIndex(prev => Math.max(0, prev - 1)); }}
                                                                />
                                                                <div
                                                                    className="absolute top-0 right-0 w-1/2 h-full z-10 cursor-pointer"
                                                                    onClick={(e) => { e.stopPropagation(); setCardPhotoIndex(prev => Math.min(allPhotos.length - 1, prev + 1)); }}
                                                                />
                                                            </>
                                                        )}
                                                        {/* Photo dots */}
                                                        {allPhotos.length > 1 && (
                                                            <div className="absolute top-3 left-0 right-0 flex justify-center gap-1.5 z-20">
                                                                {allPhotos.map((_, i) => (
                                                                    <div
                                                                        key={i}
                                                                        className={`rounded-full transition-all ${i === (cardPhotoIndex % allPhotos.length)
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
                                                        <span className="text-7xl">{card.listing_type === 'seeking_crew' ? '⚓' : '🧭'}</span>
                                                    </div>
                                                )}

                                                {/* Gradient overlay */}
                                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

                                                {/* Name + type overlay */}
                                                <div className="absolute bottom-0 left-0 right-0 p-5">
                                                    <div className="flex items-end justify-between">
                                                        <div>
                                                            <h2 className="text-2xl font-black text-white mb-1">{card.display_name}</h2>
                                                            <div className="flex items-center gap-2">
                                                                {card.listing_type && (
                                                                    <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider ${card.listing_type === 'seeking_crew'
                                                                        ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-400/20'
                                                                        : 'bg-amber-500/25 text-amber-300 border border-amber-400/20'
                                                                        }`}>
                                                                        {card.listing_type === 'seeking_crew' ? '⚓ Captain' : '🧭 Crew'}
                                                                    </span>
                                                                )}
                                                                {card.age_range && <span className="text-sm text-white/50">{card.age_range}</span>}
                                                            </div>
                                                        </div>
                                                        {/* Interaction badges */}
                                                        <div className="flex gap-1.5">
                                                            {isLiked && (
                                                                <span className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-sm" title="Interested">⭐</span>
                                                            )}
                                                            {isMessaged && (
                                                                <span className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-400/30 flex items-center justify-center text-sm" title="Messaged">💬</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Card body */}
                                            <div className="p-5 space-y-4">
                                                {/* Quick facts grid */}
                                                <div className="flex flex-wrap gap-2">

                                                    {card.sailing_region && (
                                                        <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">📍 {card.sailing_region}</span>
                                                    )}
                                                    {card.sailing_experience && (
                                                        <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">🧭 {card.sailing_experience}</span>
                                                    )}
                                                    {card.gender && (
                                                        <span className="px-3 py-1.5 rounded-xl bg-white/[0.04] text-xs text-white/60 border border-white/[0.06]">{card.gender}</span>
                                                    )}
                                                </div>



                                                {/* Skills */}
                                                {card.skills.length > 0 && (
                                                    <div>
                                                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/30 mb-1.5">Skills</p>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {card.skills.map(skill => (
                                                                <span key={skill} className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-xs text-emerald-200/70 border border-emerald-500/15">{skill}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Availability */}
                                                {(card.available_from || (card.available_to && !isOpenEnded(card.available_to))) && (
                                                    <div className="flex items-center gap-1.5 text-xs text-emerald-400/60">
                                                        <span>📅</span>
                                                        {card.available_from && isOpenEnded(card.available_to) ? (
                                                            <span>Available from {formatDate(card.available_from)}</span>
                                                        ) : (
                                                            <>
                                                                {card.available_from && <span>From {formatDate(card.available_from)}</span>}
                                                                {card.available_from && card.available_to && <span>—</span>}
                                                                {card.available_to && <span>{formatDate(card.available_to)}</span>}
                                                            </>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Bio */}
                                                {card.bio && (
                                                    <p className="text-sm text-white/40 leading-relaxed">
                                                        {card.bio}
                                                    </p>
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
                                                        className={`flex-1 py-3.5 rounded-2xl font-bold text-sm transition-all active:scale-[0.97] ${messagedUsers.has(card.user_id)
                                                            ? 'bg-white/[0.04] text-white/25 cursor-not-allowed'
                                                            : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-xl shadow-emerald-500/15'
                                                            }`}
                                                    >
                                                        {messagedUsers.has(card.user_id) ? '✓ Message Sent' : '💬 Message'}
                                                    </button>
                                                ) : (
                                                    <div className="flex-1 py-3.5 rounded-2xl text-center bg-white/[0.03] border border-white/[0.06]">
                                                        <span className="text-xs text-white/30 font-medium">
                                                            {isLiked ? '⏳ Waiting for them to star you back' : '⭐ Star to connect'}
                                                        </span>
                                                    </div>
                                                )}
                                                <button
                                                    onClick={() => handleLike(card)}
                                                    className={`w-14 rounded-2xl flex items-center justify-center text-xl transition-all active:scale-90 border ${isLiked
                                                        ? 'bg-amber-500/20 border-amber-400/30 text-amber-300'
                                                        : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:bg-amber-500/10'
                                                        }`}
                                                >
                                                    ⭐
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Navigation buttons — pinned above CTA */}
                                <div className="fixed left-0 right-0 bottom-0 z-10">
                                    {/* Fade-out gradient to mask content */}
                                    <div className="h-8 bg-gradient-to-t from-[#0c1220] to-transparent" />
                                    <div className="bg-[#0c1220] px-4" style={{ paddingBottom: 'calc(64px + env(safe-area-inset-bottom) + 72px)' }}>
                                        <div className="flex justify-between items-center">
                                            <button
                                                onClick={goToPrevCard}
                                                disabled={currentCardIndex <= 0}
                                                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${currentCardIndex <= 0
                                                    ? 'text-white/15 cursor-not-allowed'
                                                    : 'text-white/50 bg-white/[0.03] border border-white/[0.06] active:scale-95'
                                                    }`}
                                            >
                                                ‹ Previous
                                            </button>
                                            {/* Progress dots */}
                                            <div className="flex gap-1 items-center">
                                                {listings.slice(
                                                    Math.max(0, currentCardIndex - 3),
                                                    Math.min(listings.length, currentCardIndex + 4)
                                                ).map((_, idx) => {
                                                    const actualIdx = Math.max(0, currentCardIndex - 3) + idx;
                                                    return (
                                                        <div
                                                            key={actualIdx}
                                                            className={`rounded-full transition-all ${actualIdx === currentCardIndex
                                                                ? 'w-2.5 h-2.5 bg-emerald-400'
                                                                : 'w-1.5 h-1.5 bg-white/15'
                                                                }`}
                                                        />
                                                    );
                                                })}
                                                {currentCardIndex + 4 < listings.length && (
                                                    <span className="text-[10px] text-white/20 ml-0.5">…</span>
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
                                    <img src={selectedCard.avatar_url} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-emerald-500/15 to-sky-500/15 flex items-center justify-center">
                                        <span className="text-3xl">{selectedCard.listing_type === 'seeking_crew' ? '🚢' : '⛵'}</span>
                                    </div>
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-white/90 mb-0.5">{selectedCard.display_name}</h2>
                            {selectedCard.age_range && (
                                <p className="text-sm text-white/35 mb-1">{selectedCard.age_range}</p>
                            )}
                            {selectedCard.listing_type && (
                                <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${selectedCard.listing_type === 'seeking_crew'
                                    ? 'bg-emerald-500/15 text-emerald-300/80'
                                    : 'bg-amber-500/15 text-amber-300/80'
                                    }`}>
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
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Home Port</p>
                                        <p className="text-sm text-white/70">🏠 {selectedCard.home_port}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_region && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Region</p>
                                        <p className="text-sm text-white/70">📍 {selectedCard.sailing_region}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_experience && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Experience</p>
                                        <p className="text-sm text-white/70">🧭 {selectedCard.sailing_experience}</p>
                                    </div>
                                )}
                                {selectedCard.gender && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Gender</p>
                                        <p className="text-sm text-white/70">{selectedCard.gender}</p>
                                    </div>
                                )}
                                {selectedCard.age_range && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Age</p>
                                        <p className="text-sm text-white/70">{selectedCard.age_range}</p>
                                    </div>
                                )}
                            </div>



                            {/* Availability — smart date display */}
                            {(selectedCard.available_from || (selectedCard.available_to && !isOpenEnded(selectedCard.available_to))) && (
                                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300/40 mb-1">Availability</p>
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
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-2">Seeking:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedCard.skills.map(skill => (
                                            <span key={skill} className="px-3 py-1.5 rounded-full bg-emerald-500/10 text-xs text-emerald-200/70 border border-emerald-500/15">
                                                {skill}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Bio */}
                            {selectedCard.bio && (
                                <div>
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-2">📝 About</h3>
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
                                    className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all active:scale-[0.97] shadow-xl ${messagedUsers.has(selectedCard.user_id)
                                        ? 'bg-white/[0.04] text-white/25 cursor-not-allowed shadow-none'
                                        : 'bg-gradient-to-r from-emerald-500 to-sky-600 text-white shadow-emerald-500/20'
                                        }`}
                                >
                                    {messagedUsers.has(selectedCard.user_id) ? '✓ Message Sent' : '💬 Send Message'}
                                </button>
                            ) : (
                                <div className="flex-1 py-4 rounded-2xl text-center bg-white/[0.03] border border-white/[0.06]">
                                    <span className="text-sm text-white/30 font-medium">
                                        {likedUsers.has(selectedCard.user_id) ? '⏳ Waiting for them to star you back' : '⭐ Star them to connect'}
                                    </span>
                                </div>
                            )}
                            <button
                                onClick={() => handleLike(selectedCard)}
                                className={`w-16 rounded-2xl flex items-center justify-center text-2xl transition-all active:scale-90 border ${likedUsers.has(selectedCard.user_id)
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
                    <div className="px-5 py-6 pb-32 space-y-5">
                        <div className="text-center mb-2">
                            <span className="text-3xl block mb-1">{editListingType === 'seeking_crew' ? '⚓' : editListingType === 'seeking_berth' ? '🧭' : '🌊'}</span>
                            <p className="text-xs text-white/25">
                                {editListingType === 'seeking_crew'
                                    ? 'Your Captain profile — tell crew about your vessel & plans'
                                    : editListingType === 'seeking_berth'
                                        ? 'Your Crew profile — tell captains what you bring aboard'
                                        : 'Your Crew Finder profile is separate from your chat profile'}
                            </p>
                        </div>

                        {/* First Name */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                                Your First Name
                            </label>
                            <input
                                value={editFirstName}
                                onChange={e => setEditFirstName(e.target.value)}
                                placeholder="What should people call you?"
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors"
                                maxLength={30}
                            />
                        </div>

                        {/* Listing Type */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                                I am
                            </label>
                            <div className="space-y-2">
                                {LISTING_TYPES.map(lt => (
                                    <button
                                        key={lt.key}
                                        onClick={() => setEditListingType(editListingType === lt.key ? '' : lt.key)}
                                        className={`w-full py-3.5 px-4 rounded-2xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${editListingType === lt.key
                                            ? 'bg-gradient-to-r from-emerald-500/20 to-sky-500/20 text-emerald-200 border border-emerald-400/25'
                                            : 'bg-white/[0.02] text-white/60 border border-white/[0.05] hover:bg-white/[0.04]'
                                            }`}
                                    >
                                        <span className="text-2xl">{lt.icon}</span>
                                        {lt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Photos — up to 6 */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                                📸 Your Photos ({editPhotos.length}/6)
                            </label>
                            <p className="text-[11px] text-white/15 mb-3">
                                Add up to 6 photos — moderated by AI for safety
                            </p>
                            <div className="grid grid-cols-3 gap-2">
                                {Array.from({ length: 6 }).map((_, idx) => {
                                    const url = editPhotos[idx];
                                    const isUploading = uploadingPhotoIdx === idx;
                                    return (
                                        <div key={idx} className="aspect-square rounded-2xl border border-white/[0.06] overflow-hidden relative group">
                                            {isUploading ? (
                                                <div className="w-full h-full bg-emerald-500/5 flex items-center justify-center">
                                                    <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-teal-500 rounded-full animate-spin" />
                                                </div>
                                            ) : url ? (
                                                <>
                                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                                    <button
                                                        onClick={() => handlePhotoRemove(idx)}
                                                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-red-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity"
                                                    >
                                                        ✕
                                                    </button>
                                                </>
                                            ) : (
                                                <button
                                                    onClick={() => { setPendingPhotoIdx(idx); fileInputRef.current?.click(); }}
                                                    className="w-full h-full bg-white/[0.02] hover:bg-white/[0.04] flex flex-col items-center justify-center transition-colors"
                                                >
                                                    <span className="text-2xl text-white/20">➕</span>
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {photoError && (
                                <p className="text-xs text-red-400 mt-2 text-center">❌ {photoError}</p>
                            )}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handlePhotoUpload}
                                className="hidden"
                            />
                        </div>

                        {/* Gender */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">Gender</label>
                            <div className="flex flex-wrap gap-2">
                                {GENDER_OPTIONS.map(g => (
                                    <button
                                        key={g}
                                        onClick={() => setEditGender(editGender === g ? '' : g)}
                                        className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${editGender === g
                                            ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 text-emerald-200 border border-emerald-400/25'
                                            : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                            }`}
                                    >
                                        {g}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Age Range */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">Age Range</label>
                            <div className="flex gap-2 flex-wrap">
                                {AGE_RANGES.map(age => (
                                    <button
                                        key={age}
                                        onClick={() => {
                                            const current = editAge ? editAge.split(', ') : [];
                                            const next = current.includes(age)
                                                ? current.filter(a => a !== age)
                                                : [...current, age];
                                            setEditAge(next.join(', '));
                                        }}
                                        className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${editAge.split(', ').includes(age)
                                            ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 text-emerald-200 border border-emerald-400/25'
                                            : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                            }`}
                                    >
                                        {age}
                                    </button>
                                ))}
                            </div>
                        </div>



                        {/* Skills — Crew only */}
                        {editListingType === 'seeking_berth' && (
                            <div>
                                <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                                    Skills & Prepared To Do
                                </label>
                                <div className="flex flex-wrap gap-2">
                                    {SKILL_OPTIONS.map(skill => {
                                        const selected = editSkills.includes(skill);
                                        return (
                                            <button
                                                key={skill}
                                                onClick={() => toggleEditSkill(skill)}
                                                className={`px-3 py-2 rounded-full text-sm font-medium transition-all active:scale-95 ${selected
                                                    ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 text-emerald-200 border border-emerald-400/25'
                                                    : 'bg-white/[0.03] text-white/35 border border-white/[0.05] hover:bg-white/[0.05]'
                                                    }`}
                                            >
                                                {skill}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Experience */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                                {editListingType === 'seeking_crew' ? 'Your Sailing Experience' : 'Sailing Experience'}
                            </label>
                            <div className="space-y-2">
                                {EXPERIENCE_LEVELS.map(level => (
                                    <button
                                        key={level}
                                        onClick={() => setEditExperience(editExperience === level ? '' : level)}
                                        className={`w-full py-3 px-4 rounded-xl text-left text-sm font-medium transition-all ${editExperience === level
                                            ? 'bg-gradient-to-r from-emerald-500/15 to-sky-500/15 text-emerald-200 border border-emerald-400/15'
                                            : 'bg-white/[0.02] text-white/35 border border-white/[0.04] hover:bg-white/[0.04]'
                                            }`}
                                    >
                                        {level}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Sailing Region */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                                {editListingType === 'seeking_crew' ? '📍 Sailing / Cruising Area' : '📍 Preferred Sailing Region'}
                            </label>
                            <input
                                value={editRegion}
                                onChange={e => setEditRegion(e.target.value)}
                                placeholder={editListingType === 'seeking_crew'
                                    ? 'Where will you be sailing? e.g. East Coast, Med...'
                                    : 'Where would you like to sail? e.g. Caribbean, Pacific...'}
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors"
                                maxLength={80}
                            />
                        </div>

                        {/* Availability */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                                {editListingType === 'seeking_crew' ? '📅 When Are You Sailing?' : '📅 When Are You Available?'}
                            </label>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <p className="text-[11px] text-white/60 uppercase mb-1">From</p>
                                    <input
                                        type="date"
                                        value={editAvailFrom}
                                        onChange={e => setEditAvailFrom(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/30 transition-colors [color-scheme:dark]"
                                    />
                                </div>
                                <div className="flex-1">
                                    <p className="text-[11px] text-white/60 uppercase mb-1">To (optional)</p>
                                    <input
                                        type="date"
                                        value={isOpenEnded(editAvailTo) ? '' : editAvailTo}
                                        onChange={e => setEditAvailTo(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/30 transition-colors [color-scheme:dark]"
                                    />
                                    {editAvailTo && (
                                        <button
                                            onClick={() => setEditAvailTo('')}
                                            className="text-[11px] text-emerald-400/50 hover:text-emerald-400/80 mt-1 transition-colors"
                                        >
                                            ✕ Clear end date
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Bio */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                                About You
                            </label>
                            <textarea
                                value={editBio}
                                onChange={e => setEditBio(e.target.value)}
                                placeholder={editListingType === 'seeking_crew'
                                    ? "Tell crew about your vessel, planned passages, what you're looking for..."
                                    : "Tell skippers about yourself, your experience, what you can bring to the crew..."
                                }
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors resize-none"
                                rows={4}
                                maxLength={500}
                            />
                            <p className="text-xs text-white/15 text-right mt-1">{editBio.length}/500</p>
                        </div>

                        {/* Save */}
                        {(() => {
                            const isComplete = !!editListingType && !!editFirstName.trim() && !!editGender && !!editAge && editBio.trim().length >= 20;
                            const missing: string[] = [];
                            if (!editListingType) missing.push('listing type');
                            if (!editFirstName.trim()) missing.push('first name');
                            if (!editGender) missing.push('gender');
                            if (!editAge) missing.push('age bracket');
                            if (editBio.trim().length < 20) missing.push(`bio (${20 - editBio.trim().length} more chars)`);
                            return (
                                <>
                                    {!isComplete && (
                                        <p className="text-xs text-amber-400/60 text-center mb-2">
                                            Still needed: {missing.join(', ')}
                                        </p>
                                    )}
                                    <button
                                        onClick={handleSaveProfile}
                                        disabled={saving || !isComplete}
                                        className={`w-full py-4 rounded-2xl text-base font-bold transition-all active:scale-[0.98] shadow-xl ${isComplete
                                            ? 'bg-gradient-to-r from-emerald-500 to-sky-600 hover:from-emerald-400 hover:to-sky-500 text-white shadow-emerald-500/15'
                                            : 'bg-white/[0.06] text-white/25 cursor-not-allowed shadow-none'
                                            }`}
                                    >
                                        {saved ? '✓ Listing Saved!' : saving ? 'Saving...' : '💾 Save My Listing'}
                                    </button>
                                </>
                            );
                        })()}

                        <p className="text-[11px] text-white/15 text-center">
                            Your listing is visible to other Crew Talk members who have opted in
                        </p>

                        {/* Delete Listing — only show if profile exists */}
                        {profile?.user_id && (
                            <button
                                onClick={() => setShowDeleteConfirm(true)}
                                className="w-full mt-6 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-bold hover:bg-red-500/15 transition-all active:scale-[0.98]"
                            >
                                🗑️ Delete My Listing
                            </button>
                        )}
                    </div>
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
                                {matches.map(match => (
                                    <button
                                        key={match.user_id}
                                        onClick={() => onOpenDM(match.user_id, match.display_name)}
                                        className="w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-emerald-400/10 transition-all active:scale-[0.98]"
                                    >
                                        <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-emerald-400/20 flex-shrink-0">
                                            {match.avatar_url ? (
                                                <img src={match.avatar_url} alt="" className="w-full h-full object-cover" />
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
                                            <p className="text-xs text-emerald-400/50 mt-0.5">
                                                Connected {new Date(match.matched_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                        <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-emerald-500/20 to-sky-500/20 flex items-center justify-center flex-shrink-0">
                                            <span className="text-sm">💬</span>
                                        </div>
                                    </button>
                                ))}
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
        </div >
    );
};
