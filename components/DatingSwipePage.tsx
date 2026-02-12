/**
 * DatingSwipePage — Tinder-style Sailor Dating
 * 
 * Privacy-first swipe cards for the Lonely Hearts channel:
 * - First name only (no last names, no emails)
 * - Separate dating photos (NOT the main pirate profile photo)
 * - Swipe right = Like, left = Pass
 * - Mutual match celebration
 * - DM only for mutual matches (safety)
 * - Profile editing with first name, bio, interests, photos
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    LonelyHeartsService,
    DatingCard,
    SailorMatch,
    INTEREST_OPTIONS,
    AGE_RANGES,
    EXPERIENCE_LEVELS,
    SEEKING_OPTIONS,
} from '../services/LonelyHeartsService';

interface DatingSwipePageProps {
    onOpenDM: (userId: string, name: string) => void;
}

type DatingView = 'browse' | 'matches' | 'edit_profile' | 'match_celebration';

export const DatingSwipePage: React.FC<DatingSwipePageProps> = ({ onOpenDM }) => {
    const [view, setView] = useState<DatingView>('browse');
    const [loading, setLoading] = useState(true);

    // Browse
    const [cards, setCards] = useState<DatingCard[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [photoIndex, setPhotoIndex] = useState(0); // gallery position on current card

    // Matches
    const [matches, setMatches] = useState<SailorMatch[]>([]);

    // Swipe
    const [swipeX, setSwipeX] = useState(0);
    const [swiping, setSwiping] = useState(false);
    const startXRef = useRef(0);

    // Match celebration
    const [newMatch, setNewMatch] = useState<DatingCard | null>(null);

    // Edit profile
    const [editFirstName, setEditFirstName] = useState('');
    const [editBio, setEditBio] = useState('');
    const [editInterests, setEditInterests] = useState<string[]>([]);
    const [editAge, setEditAge] = useState('');
    const [editSeeking, setEditSeeking] = useState('');
    const [editExperience, setEditExperience] = useState('');
    const [editLocation, setEditLocation] = useState('');
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [uploadingPhoto, setUploadingPhoto] = useState<number | null>(null);
    const [photoError, setPhotoError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [pendingPhotoSlot, setPendingPhotoSlot] = useState<number>(0);

    // --- INIT ---
    useEffect(() => {
        const init = async () => {
            await LonelyHeartsService.init();
            await Promise.all([loadCards(), loadMatches(), loadProfile()]);
            setLoading(false);
        };
        init();
    }, []);

    const loadCards = async () => {
        const data = await LonelyHeartsService.getDatingProfilesToBrowse(30);
        setCards(data);
        setCurrentIndex(0);
        setPhotoIndex(0);
    };

    const loadMatches = async () => {
        const m = await LonelyHeartsService.getMatches();
        setMatches(m);
    };

    const loadProfile = async () => {
        const dp = await LonelyHeartsService.getDatingProfile();
        if (dp) {
            setEditFirstName(dp.first_name || '');
            setEditBio(dp.bio || '');
            setEditAge(dp.age_range || '');
            setEditInterests(dp.interests || []);
            setEditExperience(dp.sailing_experience || '');
            setEditSeeking(dp.seeking || '');
            setEditLocation(dp.location_text || '');
            setEditPhotos(dp.photos?.filter((p: string) => p) || []);
        }
    };

    // --- HELPERS ---
    /** Strip emails and identifiable info from text */
    const sanitizeText = (text: string): string => {
        return text
            .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]')
            .replace(/(?:^|\s)@[\w]+/g, ' [handle removed]');
    };

    /** Get display name for dating context — first name only */
    const getDatingName = (card: DatingCard): string => {
        return card.first_name || card.display_name.split(' ')[0] || 'Sailor';
    };

    /** Get dating photos or fallback */
    const getDatingPhotos = (card: DatingCard): string[] => {
        const photos = card.photos?.filter(p => p) || [];
        return photos;
    };

    // --- SWIPE ---
    const currentCard = currentIndex < cards.length ? cards[currentIndex] : null;
    const currentPhotos = currentCard ? getDatingPhotos(currentCard) : [];

    const handleSwipeAction = async (isLike: boolean) => {
        if (!currentCard) return;

        if (isLike) {
            const result = await LonelyHeartsService.recordLike(currentCard.user_id, true);
            if (result.matched) {
                setNewMatch(currentCard);
                setView('match_celebration');
                await loadMatches();
            }
        } else {
            await LonelyHeartsService.recordLike(currentCard.user_id, false);
        }

        setSwipeX(0);
        setPhotoIndex(0);
        setCurrentIndex(prev => prev + 1);
    };

    // Touch handlers
    const handleTouchStart = (e: React.TouchEvent) => {
        startXRef.current = e.touches[0].clientX;
        setSwiping(true);
    };
    const handleTouchMove = (e: React.TouchEvent) => {
        if (!swiping) return;
        const diff = e.touches[0].clientX - startXRef.current;
        setSwipeX(diff);
    };
    const handleTouchEnd = () => {
        setSwiping(false);
        if (swipeX > 100) {
            handleSwipeAction(true); // Like
        } else if (swipeX < -100) {
            handleSwipeAction(false); // Pass
        } else {
            setSwipeX(0);
        }
    };

    // --- PHOTO UPLOAD ---
    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setPhotoError('');
        setUploadingPhoto(pendingPhotoSlot);

        const result = await LonelyHeartsService.uploadDatingPhoto(file, pendingPhotoSlot);
        if (result.success && result.url) {
            setEditPhotos(prev => {
                const next = [...prev];
                while (next.length <= pendingPhotoSlot) next.push('');
                next[pendingPhotoSlot] = result.url!;
                return next;
            });
        } else {
            setPhotoError(result.error || 'Upload failed');
        }
        setUploadingPhoto(null);
        // Reset file input
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handlePhotoRemove = async (position: number) => {
        const success = await LonelyHeartsService.removeDatingPhoto(position);
        if (success) {
            setEditPhotos(prev => prev.filter((_, i) => i !== position));
        }
    };

    // --- SAVE PROFILE ---
    const handleSaveProfile = async () => {
        setSaving(true);
        await LonelyHeartsService.updateDatingProfile({
            first_name: editFirstName.trim() || null,
            bio: sanitizeText(editBio.trim()) || null,
            interests: editInterests,
            age_range: editAge || null,
            seeking: editSeeking || null,
            sailing_experience: editExperience || null,
            location_text: editLocation.trim() || null,
        });
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
    };

    const toggleInterest = (interest: string) => {
        setEditInterests(prev =>
            prev.includes(interest) ? prev.filter(i => i !== interest) : [...prev, interest]
        );
    };

    // --- LOADING ---
    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <div className="w-10 h-10 mx-auto mb-4 border-2 border-pink-500/30 border-t-pink-500 rounded-full animate-spin" />
                    <p className="text-sm text-white/30">Finding sailors nearby...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Tab bar */}
            <div className="flex-shrink-0 flex border-b border-white/[0.04]">
                {([
                    { key: 'browse' as DatingView, label: '💕 Browse' },
                    { key: 'matches' as DatingView, label: `🤝 Matches${matches.length > 0 ? ` (${matches.length})` : ''}` },
                    { key: 'edit_profile' as DatingView, label: '✏️ Profile' },
                ] as const).map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setView(tab.key)}
                        className={`flex-1 py-3 text-sm font-semibold transition-colors relative ${view === tab.key || (view === 'match_celebration' && tab.key === 'browse')
                            ? 'text-pink-400' : 'text-white/30 hover:text-white/50'
                            }`}
                    >
                        {tab.label}
                        {(view === tab.key || (view === 'match_celebration' && tab.key === 'browse')) && (
                            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-pink-500 to-rose-500 rounded-full" />
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain">

                {/* ══════ SWIPE CARDS ══════ */}
                {view === 'browse' && (
                    <div className="flex flex-col items-center justify-center h-full px-6 py-4">
                        {!currentCard ? (
                            <div className="text-center">
                                <span className="text-5xl block mb-4">⛵</span>
                                <h3 className="text-lg font-bold text-white/50 mb-2">No More Sailors</h3>
                                <p className="text-sm text-white/25 max-w-[240px] mx-auto">
                                    You've seen everyone nearby. Check back later —
                                    new sailors join every day!
                                </p>
                                <button
                                    onClick={() => { setLoading(true); loadCards().then(() => setLoading(false)); }}
                                    className="mt-6 px-6 py-3 rounded-2xl bg-pink-500/15 text-pink-300 text-sm font-semibold border border-pink-400/20 transition-all active:scale-95"
                                >
                                    ♻️ Refresh
                                </button>
                            </div>
                        ) : (
                            <>
                                {/* Card */}
                                <div
                                    className="relative w-full max-w-[340px] rounded-3xl overflow-hidden border border-white/[0.06] shadow-2xl transition-transform touch-pan-y"
                                    style={{
                                        transform: `translateX(${swipeX}px) rotate(${swipeX * 0.05}deg)`,
                                        transition: swiping ? 'none' : 'transform 0.3s ease-out',
                                    }}
                                    onTouchStart={handleTouchStart}
                                    onTouchMove={handleTouchMove}
                                    onTouchEnd={handleTouchEnd}
                                >
                                    {/* Swipe indicators */}
                                    {swipeX > 30 && (
                                        <div className="absolute top-6 left-6 z-10 px-4 py-2 rounded-xl bg-green-500/30 border-2 border-green-400 -rotate-12">
                                            <span className="text-green-300 font-black text-xl">LIKE 💚</span>
                                        </div>
                                    )}
                                    {swipeX < -30 && (
                                        <div className="absolute top-6 right-6 z-10 px-4 py-2 rounded-xl bg-red-500/30 border-2 border-red-400 rotate-12">
                                            <span className="text-red-300 font-black text-xl">PASS 👋</span>
                                        </div>
                                    )}

                                    {/* Photo gallery / Avatar header */}
                                    <div className="h-64 bg-gradient-to-br from-pink-500/15 via-purple-500/10 to-blue-500/15 flex items-center justify-center relative">
                                        {currentPhotos.length > 0 ? (
                                            <>
                                                <img
                                                    src={currentPhotos[photoIndex] || currentPhotos[0]}
                                                    alt=""
                                                    className="w-full h-full object-cover"
                                                />
                                                {/* Photo dots */}
                                                {currentPhotos.length > 1 && (
                                                    <div className="absolute top-3 inset-x-3 flex gap-1 z-10">
                                                        {currentPhotos.map((_, i) => (
                                                            <div
                                                                key={i}
                                                                className={`flex-1 h-1 rounded-full transition-all ${i === photoIndex ? 'bg-white/80' : 'bg-white/20'}`}
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                                {/* Tap zones for photo navigation */}
                                                {currentPhotos.length > 1 && (
                                                    <>
                                                        <button
                                                            className="absolute left-0 top-0 w-1/3 h-full z-5"
                                                            onClick={(e) => { e.stopPropagation(); setPhotoIndex(prev => Math.max(0, prev - 1)); }}
                                                        />
                                                        <button
                                                            className="absolute right-0 top-0 w-1/3 h-full z-5"
                                                            onClick={(e) => { e.stopPropagation(); setPhotoIndex(prev => Math.min(currentPhotos.length - 1, prev + 1)); }}
                                                        />
                                                    </>
                                                )}
                                            </>
                                        ) : (
                                            <span className="text-7xl opacity-50">⛵</span>
                                        )}
                                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-[#0a0f1e] to-transparent h-20" />
                                    </div>

                                    {/* Info — first name only */}
                                    <div className="bg-[#0a0f1e] p-5 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xl font-black text-white/90">
                                                {getDatingName(currentCard)}
                                            </h3>
                                            {currentCard.age_range && (
                                                <span className="text-sm text-white/35 font-medium">{currentCard.age_range}</span>
                                            )}
                                        </div>

                                        {/* Quick meta — NO identifiable info (no vessel name, no full location) */}
                                        <div className="flex flex-wrap gap-2 text-xs text-white/40">
                                            {currentCard.sailing_experience && <span>🧭 {currentCard.sailing_experience}</span>}
                                            {currentCard.sailing_region && <span>📍 {currentCard.sailing_region}</span>}
                                        </div>

                                        {currentCard.seeking && (
                                            <p className="text-xs text-pink-300/60">
                                                Looking for: <span className="font-semibold">{currentCard.seeking}</span>
                                            </p>
                                        )}

                                        {/* Bio — sanitized */}
                                        {currentCard.bio && (
                                            <p className="text-sm text-white/35 mt-3 leading-relaxed italic line-clamp-3">
                                                {sanitizeText(currentCard.bio)}
                                            </p>
                                        )}

                                        {/* Interests */}
                                        {currentCard.interests.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {currentCard.interests.slice(0, 6).map(tag => (
                                                    <span key={tag} className="px-2.5 py-1 rounded-full bg-pink-500/10 text-[11px] text-pink-200/60 border border-pink-400/10">
                                                        {tag}
                                                    </span>
                                                ))}
                                                {currentCard.interests.length > 6 && (
                                                    <span className="text-[10px] text-white/20">+{currentCard.interests.length - 6}</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Action buttons */}
                                <div className="flex items-center gap-6 mt-6">
                                    <button
                                        onClick={() => handleSwipeAction(false)}
                                        className="w-16 h-16 rounded-full bg-gradient-to-br from-red-500/10 to-orange-500/10 border-2 border-red-400/20 flex items-center justify-center text-3xl transition-all active:scale-90 hover:border-red-400/40 shadow-lg shadow-red-500/5"
                                    >
                                        👋
                                    </button>
                                    <button
                                        onClick={() => handleSwipeAction(true)}
                                        className="w-20 h-20 rounded-full bg-gradient-to-br from-pink-500/20 to-rose-500/20 border-2 border-pink-400/30 flex items-center justify-center text-4xl transition-all active:scale-90 hover:border-pink-400/50 shadow-xl shadow-pink-500/10"
                                    >
                                        💚
                                    </button>
                                </div>

                                {/* Progress */}
                                <p className="text-[10px] text-white/15 mt-4">
                                    {currentIndex + 1} of {cards.length}
                                </p>
                            </>
                        )}
                    </div>
                )}

                {/* ══════ MATCH CELEBRATION ══════ */}
                {view === 'match_celebration' && newMatch && (
                    <div className="flex flex-col items-center justify-center h-full px-6">
                        <div className="text-center animate-bounce">
                            <span className="text-6xl block mb-4">🎉</span>
                            <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-pink-400 to-rose-400 mb-2">
                                It's a Match!
                            </h2>
                            <p className="text-base text-white/50 mb-1">
                                You and <span className="font-bold text-white/70">{getDatingName(newMatch)}</span> liked each other
                            </p>
                            <p className="text-sm text-white/30">
                                You can now send them a message 💬
                            </p>
                        </div>

                        <div className="flex gap-4 mt-8">
                            <button
                                onClick={() => onOpenDM(newMatch.user_id, getDatingName(newMatch))}
                                className="px-8 py-4 rounded-2xl bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 text-white font-bold text-base transition-all active:scale-95 shadow-xl shadow-pink-500/20"
                            >
                                💬 Send Message
                            </button>
                            <button
                                onClick={() => { setNewMatch(null); setView('browse'); }}
                                className="px-6 py-4 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-white/40 font-medium text-base transition-all active:scale-95"
                            >
                                Keep swiping
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════ MATCHES ══════ */}
                {view === 'matches' && (
                    <div className="px-4 py-5">
                        <p className="text-xs text-white/20 text-center mb-4">
                            Both sailors must like each other to connect — your safety matters ⚓
                        </p>

                        {matches.length === 0 ? (
                            <div className="text-center py-16">
                                <span className="text-5xl block mb-4">💕</span>
                                <h3 className="text-lg font-bold text-white/50 mb-2">No Matches Yet</h3>
                                <p className="text-sm text-white/25 max-w-[260px] mx-auto">
                                    When you and another sailor both swipe right, you'll match and can message each other.
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {matches.map(match => {
                                    const matchName = match.dating_first_name || match.display_name.split(' ')[0] || 'Sailor';
                                    const matchPhoto = match.dating_photos?.filter((p: string) => p)?.[0];
                                    return (
                                        <button
                                            key={match.user_id}
                                            onClick={() => onOpenDM(match.user_id, matchName)}
                                            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-pink-400/10 transition-all active:scale-[0.98]"
                                        >
                                            <div className="w-14 h-14 rounded-2xl overflow-hidden border-2 border-pink-400/20 flex-shrink-0">
                                                {matchPhoto ? (
                                                    <img src={matchPhoto} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="w-full h-full bg-gradient-to-br from-pink-500/10 to-rose-500/10 flex items-center justify-center">
                                                        <span className="text-xl">⛵</span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex-1 text-left min-w-0">
                                                <p className="text-base font-semibold text-white/80 truncate">
                                                    {matchName}
                                                </p>
                                                <p className="text-xs text-pink-400/50 mt-0.5">
                                                    Matched {new Date(match.matched_at).toLocaleDateString()}
                                                </p>
                                            </div>
                                            <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-pink-500/20 to-rose-500/20 flex items-center justify-center flex-shrink-0">
                                                <span className="text-sm">💬</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* ══════ EDIT PROFILE ══════ */}
                {view === 'edit_profile' && (
                    <div className="px-5 py-6 pb-32 space-y-5">
                        <div className="text-center mb-2">
                            <span className="text-3xl block mb-1">💕</span>
                            <p className="text-xs text-white/25">Your dating profile is separate from your pirate profile</p>
                        </div>

                        {/* Dating Photos — 6 slots */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-3">
                                📸 Your Dating Photos
                            </label>
                            <p className="text-[11px] text-white/15 mb-3">
                                Add up to 6 photos — moderated by AI for safety. First photo is your main pic.
                            </p>
                            <div className="grid grid-cols-3 gap-2">
                                {Array.from({ length: 6 }).map((_, idx) => (
                                    <div key={idx} className="aspect-square rounded-2xl border border-white/[0.06] overflow-hidden relative group">
                                        {uploadingPhoto === idx ? (
                                            <div className="w-full h-full bg-pink-500/5 flex items-center justify-center">
                                                <div className="w-6 h-6 border-2 border-pink-500/30 border-t-pink-500 rounded-full animate-spin" />
                                            </div>
                                        ) : editPhotos[idx] ? (
                                            <>
                                                <img src={editPhotos[idx]} alt="" className="w-full h-full object-cover" />
                                                <button
                                                    onClick={() => handlePhotoRemove(idx)}
                                                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-red-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity"
                                                >
                                                    ✕
                                                </button>
                                                {idx === 0 && (
                                                    <span className="absolute bottom-1 left-1 text-[8px] font-bold bg-pink-500/80 text-white px-1.5 py-0.5 rounded-full uppercase tracking-wider">Main</span>
                                                )}
                                            </>
                                        ) : (
                                            <button
                                                onClick={() => {
                                                    setPendingPhotoSlot(idx);
                                                    fileInputRef.current?.click();
                                                }}
                                                className="w-full h-full bg-white/[0.02] hover:bg-white/[0.04] flex flex-col items-center justify-center transition-colors"
                                            >
                                                <span className="text-2xl text-white/10">📷</span>
                                                <span className="text-[9px] text-white/10 mt-1">{idx === 0 ? 'Main Photo' : `Photo ${idx + 1}`}</span>
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {photoError && (
                                <p className="text-xs text-red-400 mt-2">❌ {photoError}</p>
                            )}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handlePhotoUpload}
                                className="hidden"
                            />
                        </div>

                        {/* First name only */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-2">
                                💕 First Name Only
                            </label>
                            <input
                                value={editFirstName}
                                onChange={e => setEditFirstName(e.target.value.replace(/\s+/g, ' '))}
                                placeholder="Just your first name"
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-pink-500/30 transition-colors"
                                maxLength={20}
                            />
                            <p className="text-[11px] text-white/15 mt-1">
                                ⚠️ No last names, emails, or handles — protect your privacy
                            </p>
                        </div>

                        {/* Seeking */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-3">
                                Looking For
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {SEEKING_OPTIONS.map(opt => (
                                    <button
                                        key={opt}
                                        onClick={() => setEditSeeking(editSeeking === opt ? '' : opt)}
                                        className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${editSeeking === opt
                                            ? 'bg-gradient-to-r from-pink-500/25 to-rose-500/25 text-pink-200 border border-pink-400/25'
                                            : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                            }`}
                                    >
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Age */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-3">Age Range</label>
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
                                            ? 'bg-gradient-to-r from-pink-500/25 to-rose-500/25 text-pink-200 border border-pink-400/25'
                                            : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                            }`}
                                    >
                                        {age}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Experience */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-3">
                                Sailing Experience
                            </label>
                            <div className="space-y-2">
                                {EXPERIENCE_LEVELS.map(level => (
                                    <button
                                        key={level}
                                        onClick={() => setEditExperience(editExperience === level ? '' : level)}
                                        className={`w-full py-3 px-4 rounded-xl text-left text-sm font-medium transition-all ${editExperience === level
                                            ? 'bg-gradient-to-r from-pink-500/15 to-rose-500/15 text-pink-200 border border-pink-400/15'
                                            : 'bg-white/[0.02] text-white/35 border border-white/[0.04] hover:bg-white/[0.04]'
                                            }`}
                                    >
                                        {level}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Location */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-2">
                                📍 General Area (be vague!)
                            </label>
                            <input
                                value={editLocation}
                                onChange={e => setEditLocation(e.target.value)}
                                placeholder="East Coast, Med, Caribbean..."
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-pink-500/30 transition-colors"
                                maxLength={60}
                            />
                        </div>

                        {/* Interests */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-3">
                                Interests & Passions
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {INTEREST_OPTIONS.map(interest => {
                                    const selected = editInterests.includes(interest);
                                    return (
                                        <button
                                            key={interest}
                                            onClick={() => toggleInterest(interest)}
                                            className={`px-3 py-2 rounded-full text-sm font-medium transition-all active:scale-95 ${selected
                                                ? 'bg-gradient-to-r from-pink-500/25 to-rose-500/25 text-pink-200 border border-pink-400/25'
                                                : 'bg-white/[0.03] text-white/35 border border-white/[0.05] hover:bg-white/[0.05]'
                                                }`}
                                        >
                                            {interest}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Bio */}
                        <div>
                            <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/30 block mb-2">
                                About You
                            </label>
                            <textarea
                                value={editBio}
                                onChange={e => setEditBio(e.target.value)}
                                placeholder="Tell other sailors about yourself..."
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-pink-500/30 transition-colors resize-none"
                                rows={4}
                                maxLength={300}
                            />
                            <p className="text-xs text-white/15 text-right mt-1">{editBio.length}/300</p>
                        </div>

                        {/* Save */}
                        <button
                            onClick={handleSaveProfile}
                            disabled={saving}
                            className="w-full py-4 rounded-2xl bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 text-base text-white font-bold transition-all disabled:opacity-30 active:scale-[0.98] shadow-xl shadow-pink-500/15"
                        >
                            {saved ? '✓ Profile Saved!' : saving ? 'Saving...' : '💕 Save Profile'}
                        </button>

                        <p className="text-[10px] text-white/15 text-center">
                            Your dating profile is only visible to other opted-in Lonely Hearts members.
                            Your main pirate profile photo is never shown here.
                        </p>
                    </div>
                )}

            </div>
        </div>
    );
};
