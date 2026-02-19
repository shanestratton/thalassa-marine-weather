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

interface LonelyHeartsPageProps {
    onOpenDM: (userId: string, name: string) => void;
}

type FCView = 'board' | 'detail' | 'my_profile' | 'matches';

export const LonelyHeartsPage: React.FC<LonelyHeartsPageProps> = ({ onOpenDM }) => {
    const [view, setView] = useState<FCView>('board');
    const [loading, setLoading] = useState(true);

    // Board
    const [listings, setListings] = useState<CrewCard[]>([]);
    const [filters, setFilters] = useState<CrewSearchFilters>({});
    const [filterListingType, setFilterListingType] = useState<ListingType | ''>('');
    const [filterSkills, setFilterSkills] = useState<string[]>([]);
    const [filterExperience, setFilterExperience] = useState('');
    const [filterRegion, setFilterRegion] = useState('');
    const [showFilters, setShowFilters] = useState(false);

    // Detail
    const [selectedCard, setSelectedCard] = useState<CrewCard | null>(null);

    // Matches
    const [matches, setMatches] = useState<SailorMatch[]>([]);

    // My Profile form
    const [profile, setProfile] = useState<Partial<CrewProfile>>({});
    const [editListingType, setEditListingType] = useState<ListingType | ''>('');
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
    // Photo
    const [editPhoto, setEditPhoto] = useState<string | null>(null);
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const [photoError, setPhotoError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- INIT ---
    useEffect(() => {
        const init = async () => {
            await LonelyHeartsService.init();
            await Promise.all([loadListings(), loadMatches(), loadProfile()]);
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
            setEditPhoto(dp.photo_url || null);
        }
    };

    // --- SEARCH ---
    const applyFilters = async () => {
        const f: CrewSearchFilters = {};
        if (filterListingType) f.listing_type = filterListingType;
        if (filterSkills.length > 0) f.skills = filterSkills;
        if (filterExperience) f.experience = filterExperience;
        if (filterRegion) f.region = filterRegion;
        setFilters(f);
        setLoading(true);
        await loadListings(f);
        setLoading(false);
        setShowFilters(false);
    };

    const clearFilters = async () => {
        setFilterListingType('');
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
        setPhotoError('');
        setUploadingPhoto(true);
        const result = await LonelyHeartsService.uploadCrewPhoto(file);
        if (result.success && result.url) {
            setEditPhoto(result.url);
        } else {
            setPhotoError(result.error || 'Upload failed');
        }
        setUploadingPhoto(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handlePhotoRemove = async () => {
        const success = await LonelyHeartsService.removeCrewPhoto();
        if (success) setEditPhoto(null);
    };

    // --- LIKE / INTEREST ---
    const handleLike = async (card: CrewCard) => {
        const result = await LonelyHeartsService.recordLike(card.user_id, true);
        if (result.matched) {
            await loadMatches();
        }
    };

    // --- HELPERS ---
    const formatDate = (iso: string | null) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch { return iso; }
    };

    /** Detect sentinel end dates (2038+) that mean "open-ended" */
    const isOpenEnded = (iso: string | null) => {
        if (!iso) return true;
        try { return new Date(iso).getFullYear() >= 2038; } catch { return false; }
    };

    /** Get the current user's ID from the service (for own-card detection) */
    const currentUserId = (LonelyHeartsService as any).currentUserId as string | null;

    const activeFilterCount = (filterListingType ? 1 : 0) + (filterSkills.length > 0 ? 1 : 0) + (filterExperience ? 1 : 0) + (filterRegion ? 1 : 0);

    // --- LOADING ---
    if (loading && listings.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <div className="w-10 h-10 mx-auto mb-4 border-2 border-teal-500/30 border-t-teal-500 rounded-full animate-spin" />
                    <p className="text-sm text-white/50">Finding crew nearby...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Tab bar */}
            <div className="flex-shrink-0 flex border-b border-white/[0.04]">
                {([
                    { key: 'board' as FCView, label: '🔍 Browse' },
                    { key: 'my_profile' as FCView, label: '📋 My Listing' },
                    { key: 'matches' as FCView, label: `💬 Matches${matches.length > 0 ? ` (${matches.length})` : ''}` },
                ] as const).map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setView(tab.key)}
                        className={`flex-1 py-3 text-sm font-semibold transition-colors relative ${view === tab.key ? 'text-teal-400' : 'text-white/50 hover:text-white/50'}`}
                    >
                        {tab.label}
                        {view === tab.key && (
                            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-teal-500 to-cyan-500 rounded-full" />
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain pb-24">

                {/* ══════ BROWSE BOARD ══════ */}
                {view === 'board' && (
                    <div className="px-4 py-4">
                        {/* Filter bar */}
                        <div className="flex items-center gap-2 mb-4">
                            {/* Listing type quick toggle */}
                            <div className="flex-1 flex bg-white/[0.03] rounded-xl border border-white/[0.06] overflow-hidden">
                                <button
                                    onClick={() => { setFilterListingType(''); applyFilters(); }}
                                    className={`flex-1 py-2 text-xs font-semibold transition-all ${!filterListingType ? 'bg-teal-500/20 text-teal-300' : 'text-white/50'}`}
                                >
                                    All
                                </button>
                                <button
                                    onClick={() => { setFilterListingType('seeking_crew'); }}
                                    className={`flex-1 py-2 text-xs font-semibold transition-all ${filterListingType === 'seeking_crew' ? 'bg-teal-500/20 text-teal-300' : 'text-white/50'}`}
                                >
                                    🚢 Want Crew
                                </button>
                                <button
                                    onClick={() => { setFilterListingType('seeking_berth'); }}
                                    className={`flex-1 py-2 text-xs font-semibold transition-all ${filterListingType === 'seeking_berth' ? 'bg-teal-500/20 text-teal-300' : 'text-white/50'}`}
                                >
                                    🙋 I am Crew
                                </button>
                            </div>

                            <button
                                onClick={() => setShowFilters(!showFilters)}
                                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all relative ${showFilters || activeFilterCount > 0 ? 'bg-teal-500/20 border border-teal-500/30 text-teal-300' : 'bg-white/[0.03] border border-white/[0.06] text-white/50'}`}
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                    <line x1="4" y1="6" x2="20" y2="6" />
                                    <line x1="7" y1="12" x2="17" y2="12" />
                                    <line x1="10" y1="18" x2="14" y2="18" />
                                </svg>
                                {activeFilterCount > 0 && (
                                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-teal-500 text-[9px] text-white font-bold flex items-center justify-center">{activeFilterCount}</span>
                                )}
                            </button>
                        </div>

                        {/* Expanded filters */}
                        {showFilters && (
                            <div className="mb-4 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-4">
                                {/* Skills filter */}
                                <div>
                                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 mb-2">Skills</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {SKILL_OPTIONS.map(skill => (
                                            <button
                                                key={skill}
                                                onClick={() => toggleFilterSkill(skill)}
                                                className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${filterSkills.includes(skill)
                                                    ? 'bg-teal-500/25 text-teal-200 border border-teal-400/30'
                                                    : 'bg-white/[0.03] text-white/50 border border-white/[0.04]'
                                                    }`}
                                            >
                                                {skill}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Experience filter */}
                                <div>
                                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 mb-2">Experience</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {EXPERIENCE_LEVELS.map(level => (
                                            <button
                                                key={level}
                                                onClick={() => setFilterExperience(filterExperience === level ? '' : level)}
                                                className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${filterExperience === level
                                                    ? 'bg-teal-500/25 text-teal-200 border border-teal-400/30'
                                                    : 'bg-white/[0.03] text-white/50 border border-white/[0.04]'
                                                    }`}
                                            >
                                                {level}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Region filter */}
                                <div>
                                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 mb-2">Region</p>
                                    <input
                                        value={filterRegion}
                                        onChange={e => setFilterRegion(e.target.value)}
                                        placeholder="e.g. Caribbean, Med, Australia..."
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-teal-500/30 transition-colors"
                                    />
                                </div>

                                {/* Apply / Clear */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={applyFilters}
                                        className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-teal-500/30 to-cyan-500/30 text-teal-200 font-semibold text-sm transition-all active:scale-[0.97]"
                                    >
                                        Apply Filters
                                    </button>
                                    <button
                                        onClick={clearFilters}
                                        className="px-4 py-2.5 rounded-xl bg-white/[0.04] text-white/40 font-medium text-sm transition-all"
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Own listing preview — pinned at top */}
                        {profile?.user_id && (
                            <div className="mb-3 rounded-2xl bg-teal-500/[0.04] border border-teal-400/15 overflow-hidden relative">
                                <div className="flex gap-3.5 p-4">
                                    <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-teal-400/20 flex-shrink-0">
                                        {editPhoto ? (
                                            <img src={editPhoto} alt="" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full bg-gradient-to-br from-teal-500/10 to-cyan-500/10 flex items-center justify-center">
                                                <span className="text-xl">{editListingType === 'seeking_crew' ? '🚢' : '⛵'}</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-teal-400/50 mb-0.5">Your Listing</p>
                                        <h4 className="text-sm font-bold text-white/80 truncate">{profile.first_name || 'You'}</h4>
                                        {editListingType && (
                                            <span className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider mt-0.5 ${editListingType === 'seeking_crew'
                                                ? 'bg-teal-500/15 text-teal-300/80'
                                                : 'bg-amber-500/15 text-amber-300/80'
                                                }`}>
                                                {editListingType === 'seeking_crew' ? '🚢 Want Crew' : '🙋 I am Crew'}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={() => setView('my_profile')}
                                    className="absolute top-3 right-3 w-8 h-8 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 border border-teal-400/20 flex items-center justify-center transition-all active:scale-90"
                                    title="Edit listing"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-teal-300">
                                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    </svg>
                                </button>
                            </div>
                        )}

                        {/* Listings */}
                        {listings.length === 0 ? (
                            <div className="text-center py-16">
                                <span className="text-5xl block mb-4">🌊</span>
                                <h3 className="text-lg font-bold text-white/50 mb-2">No Listings Found</h3>
                                <p className="text-sm text-white/25">
                                    {activeFilterCount > 0
                                        ? 'Try adjusting your filters or check back later.'
                                        : 'No crew or skippers listed yet. Be the first — create your listing!'}
                                </p>
                                {activeFilterCount > 0 && (
                                    <button onClick={clearFilters} className="mt-4 px-5 py-2.5 rounded-xl bg-teal-500/20 text-teal-300 text-sm font-medium">
                                        Clear Filters
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {listings.map(card => (
                                    <button
                                        key={card.user_id}
                                        onClick={() => { setSelectedCard(card); setView('detail'); }}
                                        className="w-full text-left rounded-2xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] hover:border-teal-400/15 transition-all active:scale-[0.99] overflow-hidden"
                                    >
                                        <div className="flex gap-3.5 p-4">
                                            {/* Avatar */}
                                            <div className="w-16 h-16 rounded-2xl overflow-hidden border-2 border-white/[0.06] flex-shrink-0">
                                                {card.avatar_url ? (
                                                    <img src={card.avatar_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                                                ) : (
                                                    <div className="w-full h-full bg-gradient-to-br from-teal-500/10 to-cyan-500/10 flex items-center justify-center">
                                                        <span className="text-2xl">{card.listing_type === 'seeking_crew' ? '🚢' : '⛵'}</span>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <h4 className="text-[17px] font-bold text-white/90 truncate">{card.display_name}</h4>
                                                    {card.age_range && (
                                                        <span className="text-[11px] text-white/35 bg-white/[0.04] px-1.5 py-0.5 rounded-md flex-shrink-0">{card.age_range}</span>
                                                    )}
                                                </div>

                                                {/* Type badge */}
                                                {card.listing_type && (
                                                    <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider mb-1.5 ${card.listing_type === 'seeking_crew'
                                                        ? 'bg-teal-500/15 text-teal-300/80'
                                                        : 'bg-amber-500/15 text-amber-300/80'
                                                        }`}>
                                                        {card.listing_type === 'seeking_crew' ? '🚢 Want Crew' : '🙋 I am Crew'}
                                                    </span>
                                                )}

                                                {/* Meta row — vessel promoted */}
                                                <div className="flex items-center gap-2 text-xs mb-1.5">
                                                    {card.vessel_name && <span className="text-white/55 font-medium">⛵ {card.vessel_name}</span>}
                                                    {card.sailing_region && <span className="text-white/35">📍 {card.sailing_region}</span>}
                                                    {card.sailing_experience && <span className="text-white/35">🧭 {card.sailing_experience}</span>}
                                                </div>

                                                {/* Skills preview — with SEEKING label */}
                                                {card.skills.length > 0 && (
                                                    <div>
                                                        <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/20 mb-0.5">Seeking:</p>
                                                        <div className="flex flex-wrap gap-1">
                                                            {card.skills.slice(0, 4).map(skill => (
                                                                <span key={skill} className="px-2 py-0.5 rounded-full bg-white/[0.04] text-[10px] text-white/40">{skill}</span>
                                                            ))}
                                                            {card.skills.length > 4 && (
                                                                <span className="text-[10px] text-white/25">+{card.skills.length - 4}</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Bio preview */}
                                                {card.bio && (
                                                    <p className="text-[13px] text-white/25 line-clamp-2 leading-relaxed mt-1">
                                                        {card.bio}
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Availability bar — smart date display */}
                                        {(card.available_from || (card.available_to && !isOpenEnded(card.available_to))) && (
                                            <div className="px-4 pb-3">
                                                <div className="flex items-center gap-1.5 text-[10px] text-teal-400/60">
                                                    <span>📅</span>
                                                    {card.available_from && isOpenEnded(card.available_to) ? (
                                                        <span>Starts {formatDate(card.available_from)}</span>
                                                    ) : (
                                                        <>
                                                            {card.available_from && <span>From {formatDate(card.available_from)}</span>}
                                                            {card.available_from && card.available_to && <span>—</span>}
                                                            {card.available_to && <span>{formatDate(card.available_to)}</span>}
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </button>
                                ))}
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
                            className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white/60 mb-4 transition-colors"
                        >
                            ← Back to listings
                        </button>

                        {/* Profile header */}
                        <div className="text-center mb-6">
                            <div className="w-28 h-28 mx-auto rounded-3xl overflow-hidden border-3 border-white/[0.08] shadow-2xl mb-4">
                                {selectedCard.avatar_url ? (
                                    <img src={selectedCard.avatar_url} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-teal-500/15 to-cyan-500/15 flex items-center justify-center">
                                        <span className="text-5xl">{selectedCard.listing_type === 'seeking_crew' ? '🚢' : '⛵'}</span>
                                    </div>
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-white/90 mb-0.5">{selectedCard.display_name}</h2>
                            {selectedCard.age_range && (
                                <p className="text-sm text-white/35 mb-1">{selectedCard.age_range}</p>
                            )}
                            {selectedCard.listing_type && (
                                <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${selectedCard.listing_type === 'seeking_crew'
                                    ? 'bg-teal-500/15 text-teal-300/80'
                                    : 'bg-amber-500/15 text-amber-300/80'
                                    }`}>
                                    {selectedCard.listing_type === 'seeking_crew' ? '🚢 Want Crew' : '🙋 I am Crew'}
                                </span>
                            )}
                        </div>

                        {/* Info cards */}
                        <div className="space-y-4">
                            {/* Quick facts */}
                            <div className="grid grid-cols-2 gap-2">
                                {selectedCard.vessel_name && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Vessel</p>
                                        <p className="text-sm text-white/70">⛵ {selectedCard.vessel_name}</p>
                                    </div>
                                )}
                                {selectedCard.home_port && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Home Port</p>
                                        <p className="text-sm text-white/70">🏠 {selectedCard.home_port}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_region && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Region</p>
                                        <p className="text-sm text-white/70">📍 {selectedCard.sailing_region}</p>
                                    </div>
                                )}
                                {selectedCard.sailing_experience && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Experience</p>
                                        <p className="text-sm text-white/70">🧭 {selectedCard.sailing_experience}</p>
                                    </div>
                                )}
                                {selectedCard.gender && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Gender</p>
                                        <p className="text-sm text-white/70">{selectedCard.gender}</p>
                                    </div>
                                )}
                                {selectedCard.age_range && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-0.5">Age</p>
                                        <p className="text-sm text-white/70">{selectedCard.age_range}</p>
                                    </div>
                                )}
                            </div>

                            {/* Partner */}
                            {selectedCard.has_partner && (
                                <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/10">
                                    <p className="text-xs text-amber-300/70 font-medium">
                                        👫 Has a partner{selectedCard.partner_details ? `: ${selectedCard.partner_details}` : ''}
                                    </p>
                                </div>
                            )}

                            {/* Availability — smart date display */}
                            {(selectedCard.available_from || (selectedCard.available_to && !isOpenEnded(selectedCard.available_to))) && (
                                <div className="p-3 rounded-xl bg-teal-500/5 border border-teal-500/10">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-teal-300/40 mb-1">Availability</p>
                                    <p className="text-sm text-teal-200/70">
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
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-2">Seeking:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedCard.skills.map(skill => (
                                            <span key={skill} className="px-3 py-1.5 rounded-full bg-teal-500/10 text-xs text-teal-200/70 border border-teal-500/15">
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
                                    <p className="text-sm text-white/50 leading-relaxed whitespace-pre-wrap">
                                        {selectedCard.bio}
                                    </p>
                                </div>
                            )}



                        </div>

                        {/* Action bar */}
                        <div className="flex gap-3 mt-6 sticky bottom-4">
                            <button
                                onClick={() => onOpenDM(selectedCard.user_id, selectedCard.display_name)}
                                className="flex-1 py-4 rounded-2xl bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-400 hover:to-cyan-500 text-white font-bold text-base transition-all active:scale-[0.97] shadow-xl shadow-teal-500/20"
                            >
                                💬 Send Message
                            </button>
                            <button
                                onClick={() => handleLike(selectedCard)}
                                className="w-16 rounded-2xl bg-gradient-to-br from-pink-500/20 to-rose-500/20 hover:from-pink-500/30 hover:to-rose-500/30 border border-pink-400/20 flex items-center justify-center text-2xl transition-all active:scale-90"
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
                            <span className="text-3xl block mb-1">⚓</span>
                            <p className="text-xs text-white/25">Create your listing to connect with skippers and crew</p>
                        </div>

                        {/* Listing Type */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
                                I Am A...
                            </label>
                            <div className="space-y-2">
                                {LISTING_TYPES.map(lt => (
                                    <button
                                        key={lt.key}
                                        onClick={() => setEditListingType(editListingType === lt.key ? '' : lt.key)}
                                        className={`w-full py-3.5 px-4 rounded-2xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${editListingType === lt.key
                                            ? 'bg-gradient-to-r from-teal-500/20 to-cyan-500/20 text-teal-200 border border-teal-400/25'
                                            : 'bg-white/[0.02] text-white/40 border border-white/[0.05] hover:bg-white/[0.04]'
                                            }`}
                                    >
                                        <span className="text-2xl">{lt.icon}</span>
                                        {lt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Crew Photo — single */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
                                📸 Your Crew Photo
                            </label>
                            <p className="text-[11px] text-white/15 mb-3">
                                Add a nice photo — moderated by AI for safety
                            </p>
                            <div className="flex justify-center">
                                <div className="w-32 h-32 rounded-2xl border border-white/[0.06] overflow-hidden relative group">
                                    {uploadingPhoto ? (
                                        <div className="w-full h-full bg-teal-500/5 flex items-center justify-center">
                                            <div className="w-6 h-6 border-2 border-teal-500/30 border-t-teal-500 rounded-full animate-spin" />
                                        </div>
                                    ) : editPhoto ? (
                                        <>
                                            <img src={editPhoto} alt="" className="w-full h-full object-cover" />
                                            <button
                                                onClick={handlePhotoRemove}
                                                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-red-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                ✕
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={() => fileInputRef.current?.click()}
                                            className="w-full h-full bg-white/[0.02] hover:bg-white/[0.04] flex flex-col items-center justify-center transition-colors"
                                        >
                                            <span className="text-3xl text-white/10">📷</span>
                                            <span className="text-[10px] text-white/10 mt-1">Add Photo</span>
                                        </button>
                                    )}
                                </div>
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
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">Gender</label>
                            <div className="flex flex-wrap gap-2">
                                {GENDER_OPTIONS.map(g => (
                                    <button
                                        key={g}
                                        onClick={() => setEditGender(editGender === g ? '' : g)}
                                        className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${editGender === g
                                            ? 'bg-gradient-to-r from-teal-500/25 to-cyan-500/25 text-teal-200 border border-teal-400/25'
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
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">Age Range</label>
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
                                            ? 'bg-gradient-to-r from-teal-500/25 to-cyan-500/25 text-teal-200 border border-teal-400/25'
                                            : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                            }`}
                                    >
                                        {age}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Partner */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
                                👫 Bringing a Partner?
                            </label>
                            <div className="flex gap-2 mb-3">
                                <button
                                    onClick={() => setEditHasPartner(false)}
                                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!editHasPartner
                                        ? 'bg-gradient-to-r from-teal-500/25 to-cyan-500/25 text-teal-200 border border-teal-400/25'
                                        : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                        }`}
                                >
                                    Solo
                                </button>
                                <button
                                    onClick={() => setEditHasPartner(true)}
                                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${editHasPartner
                                        ? 'bg-gradient-to-r from-teal-500/25 to-cyan-500/25 text-teal-200 border border-teal-400/25'
                                        : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                        }`}
                                >
                                    With Partner
                                </button>
                            </div>
                            {editHasPartner && (
                                <input
                                    value={editPartnerDetails}
                                    onChange={e => setEditPartnerDetails(e.target.value)}
                                    placeholder="Partner's skills or notes..."
                                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-teal-500/30 transition-colors"
                                    maxLength={100}
                                />
                            )}
                        </div>

                        {/* Skills */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
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
                                                ? 'bg-gradient-to-r from-teal-500/25 to-cyan-500/25 text-teal-200 border border-teal-400/25'
                                                : 'bg-white/[0.03] text-white/35 border border-white/[0.05] hover:bg-white/[0.05]'
                                                }`}
                                        >
                                            {skill}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Experience */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
                                Sailing Experience
                            </label>
                            <div className="space-y-2">
                                {EXPERIENCE_LEVELS.map(level => (
                                    <button
                                        key={level}
                                        onClick={() => setEditExperience(editExperience === level ? '' : level)}
                                        className={`w-full py-3 px-4 rounded-xl text-left text-sm font-medium transition-all ${editExperience === level
                                            ? 'bg-gradient-to-r from-teal-500/15 to-cyan-500/15 text-teal-200 border border-teal-400/15'
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
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-2">
                                📍 Sailing Region / Area
                            </label>
                            <input
                                value={editRegion}
                                onChange={e => setEditRegion(e.target.value)}
                                placeholder="East Coast Australia, Mediterranean, Caribbean..."
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-teal-500/30 transition-colors"
                                maxLength={80}
                            />
                        </div>

                        {/* Availability */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-3">
                                📅 Availability
                            </label>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <p className="text-[10px] text-white/20 uppercase mb-1">From</p>
                                    <input
                                        type="date"
                                        value={editAvailFrom}
                                        onChange={e => setEditAvailFrom(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-teal-500/30 transition-colors [color-scheme:dark]"
                                    />
                                </div>
                                <div className="flex-1">
                                    <p className="text-[10px] text-white/20 uppercase mb-1">To (optional)</p>
                                    <input
                                        type="date"
                                        value={isOpenEnded(editAvailTo) ? '' : editAvailTo}
                                        onChange={e => setEditAvailTo(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-teal-500/30 transition-colors [color-scheme:dark]"
                                    />
                                    {editAvailTo && (
                                        <button
                                            onClick={() => setEditAvailTo('')}
                                            className="text-[10px] text-teal-400/50 hover:text-teal-400/80 mt-1 transition-colors"
                                        >
                                            ✕ Clear end date
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Bio */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/50 block mb-2">
                                About You
                            </label>
                            <textarea
                                value={editBio}
                                onChange={e => setEditBio(e.target.value)}
                                placeholder={editListingType === 'seeking_crew'
                                    ? "Tell crew about your vessel, planned passages, what you're looking for..."
                                    : "Tell skippers about yourself, your experience, what you can bring to the crew..."
                                }
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-teal-500/30 transition-colors resize-none"
                                rows={4}
                                maxLength={500}
                            />
                            <p className="text-xs text-white/15 text-right mt-1">{editBio.length}/500</p>
                        </div>

                        {/* Save */}
                        <button
                            onClick={handleSaveProfile}
                            disabled={saving}
                            className="w-full py-4 rounded-2xl bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-400 hover:to-cyan-500 text-base text-white font-bold transition-all disabled:opacity-30 active:scale-[0.98] shadow-xl shadow-teal-500/15"
                        >
                            {saved ? '✓ Listing Saved!' : saving ? 'Saving...' : '💾 Save My Listing'}
                        </button>

                        <p className="text-[10px] text-white/15 text-center">
                            Your listing is visible to other Crew Talk members who have opted in
                        </p>
                    </div>
                )}

                {/* ══════ MATCHES ══════ */}
                {view === 'matches' && (
                    <div className="px-4 py-5">
                        {matches.length === 0 ? (
                            <div className="text-center py-16">
                                <span className="text-5xl block mb-4">🤝</span>
                                <h3 className="text-lg font-bold text-white/50 mb-2">No Connections Yet</h3>
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
                                        className="w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-teal-400/10 transition-all active:scale-[0.98]"
                                    >
                                        <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-teal-400/20 flex-shrink-0">
                                            {match.avatar_url ? (
                                                <img src={match.avatar_url} alt="" className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full bg-gradient-to-br from-teal-500/10 to-cyan-500/10 flex items-center justify-center">
                                                    <span className="text-xl">⛵</span>
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 text-left min-w-0">
                                            <p className="text-base font-semibold text-white/80 truncate">
                                                {match.display_name}
                                            </p>
                                            <p className="text-xs text-white/50 truncate">
                                                {match.vessel_name ? `⛵ ${match.vessel_name}` : ''}
                                                {match.vessel_name && match.home_port ? ' • ' : ''}
                                                {match.home_port ? `📍 ${match.home_port}` : ''}
                                            </p>
                                            <p className="text-xs text-teal-400/50 mt-0.5">
                                                Connected {new Date(match.matched_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                        <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-teal-500/20 to-cyan-500/20 flex items-center justify-center flex-shrink-0">
                                            <span className="text-sm">💬</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};
