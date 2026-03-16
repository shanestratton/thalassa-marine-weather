/**
 * CrewProfileForm — My Profile / Listing form for the Crew Finder
 *
 * Extracted from LonelyHeartsPage (~590 lines → standalone component).
 * Receives state + dispatch from useCrewFinderState for clean prop interface.
 */

import React, { useCallback } from 'react';
import { type CrewFinderState, type CrewFinderAction } from '../../hooks/useCrewFinderState';
import { type ListingType } from '../../services/LonelyHeartsService';
import {
    SKILL_OPTIONS,
    GENDER_OPTIONS,
    AGE_RANGES,
    EXPERIENCE_LEVELS,
    LISTING_TYPES,
    VIBE_OPTIONS,
    LANGUAGE_OPTIONS,
    SMOKING_OPTIONS,
    DRINKING_OPTIONS,
    PET_OPTIONS,
    INTEREST_OPTIONS,
} from '../../services/LonelyHeartsService';
import { COUNTRIES, getStatesForCountry } from '../../data/locationData';

// ── Helper functions (used in preview and date fields) ──

const formatDate = (iso: string | null) => {
    if (!iso) return '';
    try {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    } catch {
        return iso;
    }
};

const isOpenEnded = (iso: string | null) => {
    if (!iso) return true;
    return iso === '9999-12-31';
};

// ── Props ──

interface CrewProfileFormProps {
    state: CrewFinderState;
    dispatch: React.Dispatch<CrewFinderAction>;
    // Handler callbacks
    onSaveProfile: () => void;
    onPhotoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onPhotoRemove: (idx: number) => void;
    onDeleteProfile: () => void;
    // Refs forwarded from parent
    myProfileScrollRef: React.RefObject<HTMLDivElement>;
    fileInputRef: React.RefObject<HTMLInputElement>;
}

const CrewProfileFormInner: React.FC<CrewProfileFormProps> = ({
    state,
    dispatch,
    onSaveProfile,
    onPhotoUpload,
    onPhotoRemove,
    onDeleteProfile,
    myProfileScrollRef,
    fileInputRef,
}) => {
    // ── Destructure state ──
    const {
        editListingType,
        editFirstName,
        editGender,
        editAge,
        editBio,
        editRegion,
        editExperience,
        editSkills,
        editAvailFrom,
        editAvailTo,
        editVibe,
        editLanguages,
        editSmoking,
        editDrinking,
        editPets,
        editInterests,
        editLocationCity,
        editLocationState,
        editLocationCountry,
        editHasPartner,
        editPartnerDetails,
        editPhotos,
        uploadingPhotoIdx,
        photoError,
        pendingPhotoIdx,
        kbHeight,
        saving,
        saved,
        showPreview,
        showDeleteConfirm,
        deleting,
        profile,
    } = state;

    // ── Inline setters (dispatch wrappers) ──
    const set = useCallback(
        <T,>(type: CrewFinderAction['type'], payload: T) => dispatch({ type, payload } as CrewFinderAction),
        [dispatch],
    );

    const setEditListingType = (v: ListingType | '') => set('SET_EDIT_LISTING_TYPE', v);
    const setEditFirstName = (v: string) => set('SET_EDIT_FIRST_NAME', v);
    const setEditGender = (v: string) => set('SET_EDIT_GENDER', v);
    const setEditAge = (v: string) => set('SET_EDIT_AGE', v);
    const setEditBio = (v: string) => set('SET_EDIT_BIO', v);
    const setEditRegion = (v: string) => set('SET_EDIT_REGION', v);
    const setEditExperience = (v: string) => set('SET_EDIT_EXPERIENCE', v);
    const setEditAvailFrom = (v: string) => set('SET_EDIT_AVAIL_FROM', v);
    const setEditAvailTo = (v: string) => set('SET_EDIT_AVAIL_TO', v);
    const setEditSmoking = (v: string) => set('SET_EDIT_SMOKING', v);
    const setEditDrinking = (v: string) => set('SET_EDIT_DRINKING', v);
    const setEditPets = (v: string) => set('SET_EDIT_PETS', v);
    const setEditLocationCity = (v: string) => set('SET_EDIT_LOCATION_CITY', v);
    const setEditLocationState = (v: string) => set('SET_EDIT_LOCATION_STATE', v);
    const setEditLocationCountry = (v: string) => set('SET_EDIT_LOCATION_COUNTRY', v);
    const setEditHasPartner = (v: boolean) => set('SET_EDIT_HAS_PARTNER', v);
    const setEditPartnerDetails = (v: string) => set('SET_EDIT_PARTNER_DETAILS', v);
    const setShowPreview = (v: boolean) => set('SET_SHOW_PREVIEW', v);
    const setShowDeleteConfirm = (v: boolean) => set('SET_SHOW_DELETE_CONFIRM', v);
    const setPendingPhotoIdx = (v: number) => set('SET_PENDING_PHOTO_IDX', v);

    // Array toggle helpers
    const toggleEditSkill = (skill: string) =>
        dispatch({
            type: 'SET_EDIT_SKILLS',
            payload: editSkills.includes(skill) ? editSkills.filter((s) => s !== skill) : [...editSkills, skill],
        });
    const toggleVibe = (v: string) =>
        dispatch({
            type: 'SET_EDIT_VIBE',
            payload: editVibe.includes(v) ? editVibe.filter((x) => x !== v) : [...editVibe, v],
        });
    const toggleLanguage = (lang: string) =>
        dispatch({
            type: 'SET_EDIT_LANGUAGES',
            payload: editLanguages.includes(lang) ? editLanguages.filter((l) => l !== lang) : [...editLanguages, lang],
        });
    const toggleInterest = (interest: string) =>
        dispatch({
            type: 'SET_EDIT_INTERESTS',
            payload: editInterests.includes(interest)
                ? editInterests.filter((i) => i !== interest)
                : [...editInterests, interest],
        });

    return (
        <div
            className="flex flex-col"
            style={{
                height: 'calc(100dvh - 12.5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
            }}
        >
            {/* Scrollable form area */}
            <div
                ref={myProfileScrollRef as any}
                className="flex-1 overflow-y-auto overscroll-contain px-5 py-6 space-y-5"
                style={{
                    paddingBottom: kbHeight > 0 ? `${kbHeight}px` : '1rem',
                    WebkitOverflowScrolling: 'touch' as any,
                }}
            >
                <div className="text-center mb-2">
                    <span className="text-3xl block mb-1">
                        {editListingType === 'seeking_crew' ? '⚓' : editListingType === 'seeking_berth' ? '🧭' : '🌊'}
                    </span>
                    <p className="text-xs text-white/25">
                        {editListingType === 'seeking_crew'
                            ? 'Your Captain profile — tell crew about your vessel & plans'
                            : editListingType === 'seeking_berth'
                              ? 'Your Crew profile — tell captains what you bring aboard'
                              : 'Your Crew Finder profile is separate from your chat profile'}
                    </p>
                </div>

                {/* 1. First Name */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                        Your First Name
                    </label>
                    <input
                        value={editFirstName}
                        onChange={(e) => setEditFirstName(e.target.value)}
                        placeholder="What should people call you?"
                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors"
                        maxLength={30}
                    />
                </div>

                {/* 2. I Am + Gender — same row */}
                <div className="grid grid-cols-2 gap-4">
                    {/* Listing Type */}
                    <div>
                        <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                            I am
                        </label>
                        <div className="flex gap-2">
                            {LISTING_TYPES.map((lt) => (
                                <button
                                    key={lt.key}
                                    onClick={() => setEditListingType(editListingType === lt.key ? '' : lt.key)}
                                    className={`flex-1 py-3 px-3 rounded-2xl text-center text-sm font-semibold transition-all flex flex-col items-center gap-1 ${
                                        editListingType === lt.key
                                            ? 'bg-gradient-to-r from-emerald-500/20 to-sky-500/20 text-emerald-200 border border-emerald-400/25'
                                            : 'bg-white/[0.02] text-white/60 border border-white/[0.05] hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <span className="text-lg">{lt.icon}</span>
                                    <span className="text-xs">{lt.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Gender */}
                    <div>
                        <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                            Gender
                        </label>
                        <div className="flex gap-2">
                            {GENDER_OPTIONS.map((g) => (
                                <button
                                    key={g}
                                    onClick={() => setEditGender(editGender === g ? '' : g)}
                                    className={`flex-1 py-3 px-3 rounded-2xl text-center text-sm font-semibold transition-all flex flex-col items-center gap-1 ${
                                        editGender === g
                                            ? 'bg-gradient-to-r from-emerald-500/20 to-sky-500/20 text-emerald-200 border border-emerald-400/25'
                                            : 'bg-white/[0.02] text-white/60 border border-white/[0.05] hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <span className="text-lg">{g === 'Male' ? '♂️' : '♀️'}</span>
                                    <span className="text-xs">{g}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* 3. Age Range */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        Age Range
                    </label>
                    <div className="flex gap-2 flex-wrap">
                        {AGE_RANGES.map((age) => (
                            <button
                                key={age}
                                onClick={() => {
                                    setEditAge(editAge === age ? '' : age);
                                }}
                                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                                    editAge === age
                                        ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 text-emerald-200 border border-emerald-400/25'
                                        : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                }`}
                            >
                                {age}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 4. About You (Bio) */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                        About You
                    </label>
                    <textarea
                        value={editBio}
                        onChange={(e) => setEditBio(e.target.value)}
                        placeholder={
                            editListingType === 'seeking_crew'
                                ? "Tell crew about your vessel, planned passages, what you're looking for..."
                                : 'Tell skippers about yourself, your experience, what you can bring to the crew...'
                        }
                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors resize-none"
                        rows={4}
                        maxLength={500}
                    />
                    <p className="text-xs text-white/15 text-right mt-1">{editBio.length}/500</p>
                </div>

                {/* 6. Preferred Sailing Region */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                        {editListingType === 'seeking_crew'
                            ? '📍 Sailing / Cruising Area'
                            : '📍 Preferred Sailing Region'}
                    </label>
                    <input
                        value={editRegion}
                        onChange={(e) => setEditRegion(e.target.value)}
                        placeholder={
                            editListingType === 'seeking_crew'
                                ? 'Where will you be sailing? e.g. East Coast, Med...'
                                : 'Where would you like to sail? e.g. Caribbean, Pacific...'
                        }
                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors"
                        maxLength={80}
                    />
                </div>

                {/* 7. Sailing Experience */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        {editListingType === 'seeking_crew' ? 'Your Sailing Experience' : 'Sailing Experience'}
                    </label>
                    <div className="space-y-2">
                        {EXPERIENCE_LEVELS.map((level) => (
                            <button
                                key={level}
                                onClick={() => setEditExperience(editExperience === level ? '' : level)}
                                className={`w-full py-3 px-4 rounded-xl text-left text-sm font-medium transition-all ${
                                    editExperience === level
                                        ? 'bg-gradient-to-r from-emerald-500/15 to-sky-500/15 text-emerald-200 border border-emerald-400/15'
                                        : 'bg-white/[0.02] text-white/35 border border-white/[0.04] hover:bg-white/[0.04]'
                                }`}
                            >
                                {level}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 8. Skills — Crew only */}
                {editListingType === 'seeking_berth' && (
                    <div>
                        <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                            Skills & Prepared To Do
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {SKILL_OPTIONS.map((skill) => {
                                const selected = editSkills.includes(skill);
                                return (
                                    <button
                                        key={skill}
                                        onClick={() => toggleEditSkill(skill)}
                                        className={`px-3 py-2 rounded-full text-sm font-medium transition-all active:scale-95 ${
                                            selected
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

                {/* 9. When Are You Available */}
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
                                onChange={(e) => setEditAvailFrom(e.target.value)}
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500/30 transition-colors [color-scheme:dark]"
                            />
                        </div>
                        <div className="flex-1">
                            <p className="text-[11px] text-white/60 uppercase mb-1">To (optional)</p>
                            <input
                                type="date"
                                value={isOpenEnded(editAvailTo) ? '' : editAvailTo}
                                onChange={(e) => setEditAvailTo(e.target.value)}
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

                {/* 10. Your Location */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-2">
                        📍 Your Location
                    </label>
                    <div className="space-y-2.5">
                        <select
                            value={editLocationCountry}
                            onChange={(e) => {
                                setEditLocationCountry(e.target.value);
                                setEditLocationState('');
                            }}
                            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-base text-white focus:outline-none focus:border-emerald-500/30 transition-colors appearance-none"
                            style={{
                                backgroundImage:
                                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")",
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: 'right 12px center',
                                backgroundSize: '20px',
                            }}
                        >
                            <option value="" className="bg-[#1a1d2e]">
                                Select Country
                            </option>
                            {COUNTRIES.map((c) => (
                                <option key={c} value={c} className="bg-[#1a1d2e]">
                                    {c}
                                </option>
                            ))}
                        </select>
                        {editLocationCountry && getStatesForCountry(editLocationCountry).length > 0 && (
                            <select
                                value={editLocationState}
                                onChange={(e) => setEditLocationState(e.target.value)}
                                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-base text-white focus:outline-none focus:border-emerald-500/30 transition-colors appearance-none"
                                style={{
                                    backgroundImage:
                                        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")",
                                    backgroundRepeat: 'no-repeat',
                                    backgroundPosition: 'right 12px center',
                                    backgroundSize: '20px',
                                }}
                            >
                                <option value="" className="bg-[#1a1d2e]">
                                    Select State / Province
                                </option>
                                {getStatesForCountry(editLocationCountry).map((s) => (
                                    <option key={s} value={s} className="bg-[#1a1d2e]">
                                        {s}
                                    </option>
                                ))}
                            </select>
                        )}
                        <input
                            value={editLocationCity}
                            onChange={(e) => setEditLocationCity(e.target.value)}
                            placeholder="City / Town"
                            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-colors"
                            maxLength={60}
                        />
                    </div>
                    <p className="text-[11px] text-white/25 mt-1.5 ml-1">
                        Auto-detected from your GPS — edit if needed
                    </p>
                </div>

                {/* 11. Your Vibe */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        ⚡ Your Vibe
                    </label>
                    <div className="flex gap-2 flex-wrap">
                        {VIBE_OPTIONS.map((v) => (
                            <button
                                key={v}
                                onClick={() => toggleVibe(v)}
                                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                                    editVibe.includes(v)
                                        ? 'bg-gradient-to-r from-purple-500/25 to-pink-500/25 text-purple-200 border border-purple-400/25'
                                        : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                }`}
                            >
                                {v}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 12. Languages */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        🗣️ Languages
                    </label>
                    <div className="flex gap-2 flex-wrap">
                        {LANGUAGE_OPTIONS.map((lang) => (
                            <button
                                key={lang}
                                onClick={() => toggleLanguage(lang)}
                                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                                    editLanguages.includes(lang)
                                        ? 'bg-gradient-to-r from-sky-500/25 to-emerald-500/25 text-sky-200 border border-sky-400/25'
                                        : 'bg-white/[0.03] text-white/35 border border-white/[0.05]'
                                }`}
                            >
                                {lang}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 13. Onboard Lifestyle — Smoking / Drinking / Pets */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        🚢 Onboard Lifestyle
                    </label>
                    <div className="space-y-3">
                        {/* Smoking */}
                        <div>
                            <p className="text-[11px] text-white/30 mb-1.5">🚬 Smoking</p>
                            <div className="flex gap-1.5 flex-wrap">
                                {SMOKING_OPTIONS.map((opt) => (
                                    <button
                                        key={opt}
                                        onClick={() => setEditSmoking(editSmoking === opt ? '' : opt)}
                                        className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                                            editSmoking === opt
                                                ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/20'
                                                : 'bg-white/[0.03] text-white/30 border border-white/[0.05]'
                                        }`}
                                    >
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {/* Drinking */}
                        <div>
                            <p className="text-[11px] text-white/30 mb-1.5">🍷 Drinking</p>
                            <div className="flex gap-1.5 flex-wrap">
                                {DRINKING_OPTIONS.map((opt) => (
                                    <button
                                        key={opt}
                                        onClick={() => setEditDrinking(editDrinking === opt ? '' : opt)}
                                        className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                                            editDrinking === opt
                                                ? 'bg-amber-500/20 text-amber-200 border border-amber-400/20'
                                                : 'bg-white/[0.03] text-white/30 border border-white/[0.05]'
                                        }`}
                                    >
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {/* Pets */}
                        <div>
                            <p className="text-[11px] text-white/30 mb-1.5">🐾 Pets</p>
                            <div className="flex gap-1.5 flex-wrap">
                                {PET_OPTIONS.map((opt) => (
                                    <button
                                        key={opt}
                                        onClick={() => setEditPets(editPets === opt ? '' : opt)}
                                        className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                                            editPets === opt
                                                ? 'bg-sky-500/20 text-sky-200 border border-sky-400/20'
                                                : 'bg-white/[0.03] text-white/30 border border-white/[0.05]'
                                        }`}
                                    >
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* 14. Interests & Hobbies (match-only) */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-1">
                        🎭 Interests & Hobbies
                    </label>
                    <p className="text-[11px] text-amber-400/50 mb-3">
                        🔒 Only shared with your matches — not visible on your public listing
                    </p>
                    <div className="flex gap-2 flex-wrap">
                        {INTEREST_OPTIONS.map((interest) => (
                            <button
                                key={interest}
                                onClick={() => toggleInterest(interest)}
                                className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                                    editInterests.includes(interest)
                                        ? 'bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-200 border border-amber-400/20'
                                        : 'bg-white/[0.03] text-white/30 border border-white/[0.05]'
                                }`}
                            >
                                {interest}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 15. Photos — up to 6 */}
                <div>
                    <label className="text-xs font-bold uppercase tracking-[0.15em] text-white/60 block mb-3">
                        📸 Your Photos ({editPhotos.length}/6)
                    </label>
                    <p className="text-[11px] text-white/15 mb-3">Add up to 6 photos — moderated by AI for safety</p>
                    <div className="grid grid-cols-3 gap-2">
                        {Array.from({ length: 6 }).map((_, idx) => {
                            const url = editPhotos[idx];
                            const isUploading = uploadingPhotoIdx === idx;
                            return (
                                <div
                                    key={idx}
                                    className="aspect-square rounded-2xl border border-white/[0.06] overflow-hidden relative group"
                                >
                                    {isUploading ? (
                                        <div className="w-full h-full bg-emerald-500/5 flex items-center justify-center">
                                            <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-teal-500 rounded-full animate-spin" />
                                        </div>
                                    ) : url ? (
                                        <>
                                            <img src={url} loading="lazy" alt="" className="w-full h-full object-cover" />
                                            <button
                                                onClick={() => onPhotoRemove(idx)}
                                                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-red-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity"
                                            >
                                                ✕
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={() => {
                                                setPendingPhotoIdx(idx);
                                                fileInputRef.current?.click();
                                            }}
                                            className="w-full h-full bg-white/[0.02] hover:bg-white/[0.04] flex flex-col items-center justify-center transition-colors"
                                        >
                                            <span className="text-2xl text-white/20">➕</span>
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {photoError && <p className="text-xs text-red-400 mt-2 text-center">❌ {photoError}</p>}
                    <input
                        ref={fileInputRef as any}
                        type="file"
                        accept="image/*"
                        onChange={onPhotoUpload}
                        className="hidden"
                    />
                </div>

                <p className="text-[11px] text-white/15 text-center">
                    Your listing is visible to other Crew Talk members who have opted in
                </p>

                {/* Preview My Listing Button */}
                {editFirstName && (
                    <button
                        onClick={() => setShowPreview(!showPreview)}
                        className="w-full py-3 rounded-2xl text-sm font-semibold transition-all active:scale-[0.98] bg-white/[0.04] border border-white/[0.06] text-white/60 hover:bg-white/[0.08]"
                    >
                        {showPreview ? '✕ Hide Preview' : '👁 Preview My Listing'}
                    </button>
                )}

                {/* Preview Card — mirrors the detail view exactly */}
                {showPreview && (
                    <div className="px-1 py-2">
                        {/* Profile header */}
                        <div className="text-center mb-6">
                            <div className="w-28 h-28 mx-auto rounded-2xl overflow-hidden border-3 border-white/[0.08] shadow-2xl mb-4">
                                {editPhotos[0] ? (
                                    <img src={editPhotos[0]} loading="lazy" alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-emerald-500/15 to-sky-500/15 flex items-center justify-center">
                                        <span className="text-3xl">
                                            {editListingType === 'seeking_crew' ? '🚢' : '⛵'}
                                        </span>
                                    </div>
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-white/90 mb-0.5">{editFirstName || 'Your Name'}</h2>
                            {editAge && <p className="text-sm text-white/35 mb-1">{editAge}</p>}
                            {editListingType && (
                                <span
                                    className={`inline-block px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${
                                        editListingType === 'seeking_crew'
                                            ? 'bg-emerald-500/15 text-emerald-300/80'
                                            : 'bg-amber-500/15 text-amber-300/80'
                                    }`}
                                >
                                    {editListingType === 'seeking_crew' ? '⚓ Captain' : '🧭 Crew'}
                                </span>
                            )}
                        </div>

                        {/* Info cards */}
                        <div className="space-y-4">
                            {/* Quick facts */}
                            <div className="grid grid-cols-2 gap-2">
                                {(editLocationCity || editLocationState || editLocationCountry) && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Home Port
                                        </p>
                                        <p className="text-sm text-white/70">
                                            🏠{' '}
                                            {[editLocationCity, editLocationState, editLocationCountry]
                                                .filter(Boolean)
                                                .join(', ')}
                                        </p>
                                    </div>
                                )}
                                {editRegion && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Region
                                        </p>
                                        <p className="text-sm text-white/70">📍 {editRegion}</p>
                                    </div>
                                )}
                                {editExperience && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Experience
                                        </p>
                                        <p className="text-sm text-white/70">🧭 {editExperience}</p>
                                    </div>
                                )}
                                {editGender && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Gender
                                        </p>
                                        <p className="text-sm text-white/70">{editGender}</p>
                                    </div>
                                )}
                                {editAge && (
                                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                                        <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
                                            Age
                                        </p>
                                        <p className="text-sm text-white/70">{editAge}</p>
                                    </div>
                                )}
                            </div>

                            {/* Availability */}
                            {(editAvailFrom || editAvailTo) && (
                                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300/40 mb-1">
                                        Availability
                                    </p>
                                    <p className="text-sm text-emerald-200/70">
                                        📅 {editAvailFrom ? formatDate(editAvailFrom) : 'Flexible'}
                                        {!isOpenEnded(editAvailTo) && editAvailTo
                                            ? ` — ${formatDate(editAvailTo)}`
                                            : ' onwards'}
                                    </p>
                                </div>
                            )}

                            {/* Skills */}
                            {editSkills.length > 0 && (
                                <div>
                                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/25 mb-2">
                                        Seeking:
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {editSkills.map((skill) => (
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
                            {editBio && (
                                <div>
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-white/25 mb-2">
                                        📝 About
                                    </h3>
                                    <p className="text-sm text-white/60 leading-relaxed whitespace-pre-wrap">
                                        {editBio}
                                    </p>
                                </div>
                            )}
                        </div>

                        <p className="text-[11px] text-white/20 text-center pt-4 mt-4 border-t border-white/[0.04]">
                            This is how your listing appears to others
                        </p>
                    </div>
                )}

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
            {/* Save — pinned CTA footer outside scroll */}
            <div className="shrink-0 px-5 py-3 border-t border-white/[0.06] bg-slate-950">
                {(() => {
                    const isComplete =
                        !!editListingType &&
                        !!editFirstName.trim() &&
                        !!editGender &&
                        !!editAge &&
                        editBio.trim().length >= 20;
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
                                onClick={onSaveProfile}
                                disabled={saving || !isComplete}
                                className={`w-full py-4 rounded-2xl text-base font-bold transition-all active:scale-[0.98] shadow-xl ${
                                    isComplete
                                        ? 'bg-gradient-to-r from-emerald-500 to-sky-600 hover:from-emerald-400 hover:to-sky-500 text-white shadow-emerald-500/15'
                                        : 'bg-white/[0.06] text-white/25 cursor-not-allowed shadow-none'
                                }`}
                            >
                                {saved ? '✓ Listing Saved!' : saving ? 'Saving...' : '💾 Save My Listing'}
                            </button>
                        </>
                    );
                })()}
            </div>
        </div>
    );
};

export const CrewProfileForm = React.memo(CrewProfileFormInner);
