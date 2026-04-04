/**
 * CaptainsTable — Community recipe hub card for the chat page.
 *
 * "The Captain's Table" — where sailors share their best galley recipes.
 * Features:
 *  - Browse community recipes (top rated / newest)
 *  - Ship's wheel (☸) rating system (1-5)
 *  - Recipe detail modal with ingredients, directions, photo
 *  - Upload new recipes via CustomRecipeForm
 *  - Quality gate: poorly-rated recipes naturally sink
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    browseCommunityRecipes,
    rateRecipe,
    getUserRating,
    reportRecipeImage,
    bilgeDiveSearch,
    toggleFavourite,
    getFavouriteIds,
    NAUTICAL_TAG_DEFS,
    type CommunityRecipe,
    type CaptainsTableSort,
    type NauticalTag,
    type BilgeDiveResult,
    type RecipeIngredient,
    type RecipeStep,
} from '../../services/GalleyRecipeService';
import { triggerHaptic } from '../../utils/system';
import { CustomRecipeForm } from './CustomRecipeForm';
import { toast } from '../Toast';

// ── Fallback Food Icons ────────────────────────────────────────────────────
// Deterministic selection based on recipe ID hash — adds variety when no photo
const FALLBACK_FOOD_ICONS = ['🍲', '🍳', '🐟', '🥗', '🍞', '🫕'] as const;

/** Pick a food emoji deterministically from the recipe ID so it's stable across renders */
const getFallbackIcon = (recipeId: string): string => {
    let hash = 0;
    for (let i = 0; i < recipeId.length; i++) {
        hash = ((hash << 5) - hash + recipeId.charCodeAt(i)) | 0;
    }
    return FALLBACK_FOOD_ICONS[Math.abs(hash) % FALLBACK_FOOD_ICONS.length];
};

// ── Ship's Wheel Rating Component ──────────────────────────────────────────

const ShipWheelIcon: React.FC<{ filled: boolean; size?: number }> = ({ filled, size = 16 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.5}
        className={`transition-colors ${filled ? 'text-amber-400' : 'text-gray-500'}`}
    >
        {/* Outer ring */}
        <circle cx="12" cy="12" r="10" fill="none" strokeWidth={1.5} />
        {/* Inner hub */}
        <circle cx="12" cy="12" r="3" fill={filled ? 'currentColor' : 'none'} strokeWidth={1.5} />
        {/* Spokes — 8 directions */}
        <line x1="12" y1="2" x2="12" y2="9" strokeWidth={filled ? 2 : 1.5} />
        <line x1="12" y1="15" x2="12" y2="22" strokeWidth={filled ? 2 : 1.5} />
        <line x1="2" y1="12" x2="9" y2="12" strokeWidth={filled ? 2 : 1.5} />
        <line x1="15" y1="12" x2="22" y2="12" strokeWidth={filled ? 2 : 1.5} />
        <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" strokeWidth={filled ? 2 : 1.5} />
        <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" strokeWidth={filled ? 2 : 1.5} />
        <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" strokeWidth={filled ? 2 : 1.5} />
        <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" strokeWidth={filled ? 2 : 1.5} />
        {/* Handle pegs on outer ring */}
        {filled && (
            <>
                <circle cx="12" cy="2" r="1.2" fill="currentColor" />
                <circle cx="12" cy="22" r="1.2" fill="currentColor" />
                <circle cx="2" cy="12" r="1.2" fill="currentColor" />
                <circle cx="22" cy="12" r="1.2" fill="currentColor" />
                <circle cx="4.93" cy="4.93" r="1.2" fill="currentColor" />
                <circle cx="19.07" cy="19.07" r="1.2" fill="currentColor" />
                <circle cx="4.93" cy="19.07" r="1.2" fill="currentColor" />
                <circle cx="19.07" cy="4.93" r="1.2" fill="currentColor" />
            </>
        )}
    </svg>
);

interface WheelRatingProps {
    rating: number; // 0-5
    count?: number;
    interactive?: boolean;
    onRate?: (rating: number) => void;
    size?: number;
}

const WheelRating: React.FC<WheelRatingProps> = ({ rating, count, interactive, onRate, size = 14 }) => (
    <div className="flex items-center gap-1">
        <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((i) => (
                <button
                    key={i}
                    onClick={() => interactive && onRate?.(i)}
                    disabled={!interactive}
                    className={`${interactive ? 'cursor-pointer hover:scale-125 active:scale-90' : 'cursor-default'} transition-transform`}
                    aria-label={`Rate ${i} wheel${i !== 1 ? 's' : ''}`}
                >
                    <ShipWheelIcon filled={i <= Math.round(rating)} size={size} />
                </button>
            ))}
        </div>
        {count !== undefined && count > 0 && (
            <span className="text-[11px] text-gray-500 font-medium ml-0.5">({count})</span>
        )}
    </div>
);

// ── Recipe Detail Modal ────────────────────────────────────────────────────

interface RecipeDetailProps {
    recipe: CommunityRecipe;
    onClose: () => void;
    onRated: () => void;
}

const RecipeDetail: React.FC<RecipeDetailProps> = ({ recipe, onClose, onRated }) => {
    const [userRating, setUserRating] = useState<number | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [reportSent, setReportSent] = useState(false);

    useEffect(() => {
        if (recipe.supabaseId) {
            getUserRating(recipe.supabaseId).then(setUserRating);
        }
    }, [recipe.supabaseId]);

    const handleRate = async (rating: number) => {
        setSubmitting(true);
        triggerHaptic('medium');
        const success = await rateRecipe(recipe.supabaseId, rating);
        if (success) {
            setUserRating(rating);
            onRated();
        }
        setSubmitting(false);
    };

    const handleReportImage = async () => {
        triggerHaptic('medium');
        const ok = await reportRecipeImage(recipe.supabaseId, 'inappropriate_image');
        if (ok) {
            setReportSent(true);
            toast.success('Image reported — our crew will review it');
        } else {
            toast.error('Sign in to report images');
        }
    };

    const ingredients = (recipe.ingredients || []) as RecipeIngredient[];
    const instructions = (recipe.instructions || []) as RecipeStep[];

    return (
        <div
            className="fixed inset-0 z-[950] flex items-start justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200 pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
        >
            <div
                className="w-[calc(100%-1.5rem)] max-w-lg bg-slate-900 border border-white/[0.1] rounded-3xl max-h-[90vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Hero image or fallback */}
                {recipe.image ? (
                    <div className="relative">
                        <img
                            src={recipe.image}
                            alt={recipe.title}
                            className="w-full h-48 object-cover rounded-t-3xl"
                            style={{ filter: 'brightness(1.05) contrast(1.05) saturate(1.15)' }}
                        />
                        {/* Galley light vignette — smooths out harsh galley lighting */}
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-black/10 rounded-t-3xl" />
                        <button
                            onClick={onClose}
                            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white text-xs"
                            aria-label="Close captain table"
                        >
                            ✕
                        </button>
                    </div>
                ) : (
                    <div className="relative flex items-center justify-center h-32 bg-gradient-to-br from-amber-500/10 to-orange-500/10 rounded-t-3xl">
                        <span className="text-5xl">{getFallbackIcon(recipe.supabaseId)}</span>
                        <button
                            onClick={onClose}
                            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white text-xs"
                            aria-label="Close captain table"
                        >
                            ✕
                        </button>
                    </div>
                )}

                {/* Scrollable content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Title & meta */}
                    <div>
                        <h3 className="text-lg font-bold text-white leading-tight">{recipe.title}</h3>
                        <div className="flex items-center gap-3 mt-1.5">
                            <WheelRating rating={recipe.ratingAvg} count={recipe.ratingCount} size={12} />
                            <span className="text-[11px] text-gray-500">·</span>
                            <span className="text-[11px] text-gray-500">⏱️ {recipe.readyInMinutes}min</span>
                            <span className="text-[11px] text-gray-500">·</span>
                            <span className="text-[11px] text-gray-500">👤 {recipe.authorName}</span>
                        </div>
                    </div>

                    {/* Your rating */}
                    <div className="p-3 rounded-xl bg-amber-500/[0.05] border border-amber-500/15">
                        <p className="text-[11px] text-amber-400/80 font-bold uppercase tracking-wider mb-2">
                            Your Rating
                        </p>
                        <WheelRating rating={userRating ?? 0} interactive={!submitting} onRate={handleRate} size={22} />
                        {userRating && (
                            <p className="text-[11px] text-amber-400/60 mt-1">
                                You gave this {userRating} helm{userRating !== 1 ? 's' : ''} ☸
                            </p>
                        )}
                    </div>

                    {/* Ingredients */}
                    {ingredients.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">
                                    Ingredients
                                </p>
                                <span className="text-[11px] text-sky-400/60 bg-sky-500/10 px-1.5 py-0.5 rounded-full">
                                    per person
                                </span>
                            </div>
                            <div className="space-y-1">
                                {ingredients.map((ing, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center gap-2 py-1.5 border-b border-white/[0.04] last:border-0"
                                    >
                                        <span className="text-[11px] text-amber-400">•</span>
                                        <span className="text-xs text-white flex-1">{ing.name}</span>
                                        <span className="text-[11px] text-gray-400 tabular-nums">
                                            {ing.amount > 0 && `${ing.amount} ${ing.unit}`}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Directions */}
                    {instructions.length > 0 && (
                        <div>
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider mb-2">
                                Directions
                            </p>
                            <div className="space-y-2.5">
                                {instructions.map((step) => (
                                    <div key={step.number} className="flex gap-2.5">
                                        <span className="w-6 h-6 rounded-full bg-amber-500/15 text-amber-400 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                                            {step.number}
                                        </span>
                                        <p className="text-xs text-gray-300 leading-relaxed flex-1">{step.step}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Report image — only show if recipe has a user-uploaded image */}
                    {recipe.image && (
                        <div className="pt-2 border-t border-white/[0.04]">
                            <button
                                onClick={handleReportImage}
                                disabled={reportSent}
                                className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-red-400/70 transition-colors disabled:opacity-40"
                                aria-label="Report image"
                            >
                                <span>⚑</span>
                                <span>{reportSent ? 'Image reported' : 'Report image'}</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ── Captain's Table Card ───────────────────────────────────────────────────

interface CaptainsTableProps {
    className?: string;
    /** When true, renders as a full-page view (no collapse toggle) */
    fullPage?: boolean;
}

export const CaptainsTable: React.FC<CaptainsTableProps> = ({ className, fullPage }) => {
    const [expanded, setExpanded] = useState(!!fullPage);
    const [allRecipes, setAllRecipes] = useState<CommunityRecipe[]>([]);
    const [loading, setLoading] = useState(false);
    const [sortBy, setSortBy] = useState<CaptainsTableSort>('top_rated');
    const [selectedRecipe, setSelectedRecipe] = useState<CommunityRecipe | null>(null);
    const [showUploadForm, setShowUploadForm] = useState(false);

    // Search & Filters
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [activeFilters, setActiveFilters] = useState<Set<NauticalTag>>(new Set());
    const [showFavouritesOnly, setShowFavouritesOnly] = useState(false);
    const [favouriteIds, setFavouriteIds] = useState<Set<string>>(new Set());

    // Bilge Dive mode
    const [bilgeDiveMode, setBilgeDiveMode] = useState(false);
    const [bilgeIngredients, setBilgeIngredients] = useState<string[]>([]);
    const [bilgeExclusions, setBilgeExclusions] = useState<string[]>([]);
    const [bilgeInput, setBilgeInput] = useState('');
    const bilgeInputRef = useRef<HTMLInputElement>(null);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(searchQuery), 250);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Load favourites from localStorage
    useEffect(() => {
        if (expanded) setFavouriteIds(getFavouriteIds());
    }, [expanded]);

    const loadRecipes = useCallback(async () => {
        setLoading(true);
        const results = await browseCommunityRecipes(50, 0, sortBy);
        setAllRecipes(results);
        setLoading(false);
    }, [sortBy]);

    useEffect(() => {
        if (expanded) loadRecipes();
    }, [expanded, loadRecipes]);

    // ── Client-Side Filtering Pipeline ──────────────────────────────────
    const filteredRecipes = useMemo(() => {
        let results = [...allRecipes];

        // Text search
        if (debouncedQuery.trim()) {
            const q = debouncedQuery.toLowerCase();
            results = results.filter((r) => r.title.toLowerCase().includes(q));
        }

        // Nautical tag filters (AND within active set)
        if (activeFilters.size > 0) {
            results = results.filter((r) => [...activeFilters].every((tag) => r.nauticalTags.includes(tag)));
        }

        // Favourites only
        if (showFavouritesOnly) {
            results = results.filter((r) => favouriteIds.has(r.supabaseId));
        }

        // Sort client-side (server already sorted, but re-sort after filtering)
        switch (sortBy) {
            case 'prep_time':
                results.sort((a, b) => a.readyInMinutes - b.readyInMinutes);
                break;
            case 'newest':
                results.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                break;
            case 'top_rated':
            default:
                results.sort((a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount);
                break;
        }

        return results;
    }, [allRecipes, debouncedQuery, activeFilters, showFavouritesOnly, favouriteIds, sortBy]);

    // ── Bilge Dive Results ──────────────────────────────────────────────
    const bilgeDiveResults = useMemo<BilgeDiveResult[]>(() => {
        if (!bilgeDiveMode || bilgeIngredients.length === 0) return [];
        return bilgeDiveSearch(allRecipes, bilgeIngredients, bilgeExclusions);
    }, [bilgeDiveMode, bilgeIngredients, bilgeExclusions, allRecipes]);

    // ── Handlers ────────────────────────────────────────────────────────
    const handleToggle = () => {
        setExpanded((v) => !v);
        triggerHaptic('light');
    };

    const handleToggleFilter = (tag: NauticalTag) => {
        setActiveFilters((prev) => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
        triggerHaptic('light');
    };

    const handleAddBilgeIngredient = () => {
        const raw = bilgeInput.trim();
        if (!raw) return;
        if (raw.startsWith('-')) {
            const exc = raw.slice(1).trim();
            if (exc && !bilgeExclusions.includes(exc)) {
                setBilgeExclusions((prev) => [...prev, exc]);
            }
        } else {
            if (!bilgeIngredients.includes(raw)) {
                setBilgeIngredients((prev) => [...prev, raw]);
            }
        }
        setBilgeInput('');
        bilgeInputRef.current?.focus();
        triggerHaptic('light');
    };

    const handleBilgeKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddBilgeIngredient();
        }
    };

    const handleToggleFavourite = (recipeId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const nowFav = toggleFavourite(recipeId);
        setFavouriteIds(getFavouriteIds());
        triggerHaptic(nowFav ? 'medium' : 'light');
    };

    // Which recipes to display
    const displayRecipes = bilgeDiveMode ? bilgeDiveResults.map((r) => r.recipe) : filteredRecipes;

    // Filter tag groups
    const tagGroups = [
        { label: '⚓ Sea State', tags: NAUTICAL_TAG_DEFS.filter((t) => t.group === 'sea_state') },
        { label: '🧭 Provisions', tags: NAUTICAL_TAG_DEFS.filter((t) => t.group === 'provisioning') },
        { label: '🍳 Gear', tags: NAUTICAL_TAG_DEFS.filter((t) => t.group === 'gear') },
    ];

    const sortOptions: { key: CaptainsTableSort; label: string; emoji: string }[] = [
        { key: 'top_rated', label: 'Top Rated', emoji: '☸' },
        { key: 'prep_time', label: 'Prep Time', emoji: '⏱️' },
        { key: 'newest', label: 'Newest', emoji: '🆕' },
    ];

    const isOpen = fullPage || expanded;

    return (
        <div className={fullPage ? 'px-4 pt-3 pb-28' : (className ?? 'mx-4 mt-3 mb-2')}>
            {/* ── Collapsed Bar (hidden in full-page mode) ── */}
            {!fullPage && (
                <button
                    onClick={handleToggle}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-2xl border transition-all active:scale-[0.98] ${
                        expanded
                            ? 'bg-white/[0.05] border-white/[0.08]'
                            : 'bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.03] hover:border-white/[0.08]'
                    }`}
                    aria-expanded={expanded}
                    aria-label="The Captain's Table — Community Recipe Hub"
                >
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.05] flex items-center justify-center text-xl flex-shrink-0">
                        ☸
                    </div>
                    <div className="flex-1 text-left">
                        <p className="text-lg font-semibold text-white/85">The Captain's Table</p>
                        <p className="text-sm text-white/60">
                            {allRecipes.length > 0
                                ? `${allRecipes.length} recipes shared by sailors`
                                : 'Community recipes · Share & rate'}
                        </p>
                    </div>
                    <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
            )}

            {/* ── Content ── */}
            {isOpen && (
                <div className="mt-2 space-y-3 animate-in slide-in-from-top-2 duration-200">
                    {/* ── Search Bar + Bilge Dive Toggle ── */}
                    <div className="flex gap-2">
                        {!bilgeDiveMode ? (
                            <div className="flex-1 relative">
                                <input
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search recipes…"
                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                                    data-no-keyboard-scroll
                                />
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
                                    🔍
                                </span>
                            </div>
                        ) : (
                            <div className="flex-1 relative">
                                <input
                                    ref={bilgeInputRef}
                                    value={bilgeInput}
                                    onChange={(e) => setBilgeInput(e.target.value)}
                                    onKeyDown={handleBilgeKeyDown}
                                    placeholder="Type ingredient, press Enter… (prefix - to exclude)"
                                    className="w-full bg-white/[0.04] border border-sky-500/20 rounded-xl pl-9 pr-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-sky-500/40"
                                    data-no-keyboard-scroll
                                />
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sky-400 text-xs">
                                    🧭
                                </span>
                            </div>
                        )}
                        <button
                            onClick={() => {
                                setBilgeDiveMode((v) => !v);
                                setSearchQuery('');
                                setBilgeIngredients([]);
                                setBilgeExclusions([]);
                                setBilgeInput('');
                                triggerHaptic('medium');
                            }}
                            className={`px-3 py-2 rounded-xl text-[11px] font-bold transition-all active:scale-95 whitespace-nowrap ${
                                bilgeDiveMode
                                    ? 'bg-sky-500/15 text-sky-300 border border-sky-500/25'
                                    : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.06]'
                            }`}
                            title="Bilge Dive — search by ingredients you have"
                        >
                            🧭 Bilge Dive
                        </button>
                    </div>

                    {/* ── Bilge Dive Ingredient Tags ── */}
                    {bilgeDiveMode && (bilgeIngredients.length > 0 || bilgeExclusions.length > 0) && (
                        <div className="flex flex-wrap gap-1.5">
                            {bilgeIngredients.map((ing) => (
                                <button
                                    key={`have-${ing}`}
                                    onClick={() => {
                                        setBilgeIngredients((prev) => prev.filter((i) => i !== ing));
                                        triggerHaptic('light');
                                    }}
                                    className="px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-300 text-[11px] font-bold border border-sky-500/20 hover:bg-sky-500/25 transition-all flex items-center gap-1"
                                >
                                    {ing} <span className="text-sky-400/60">✕</span>
                                </button>
                            ))}
                            {bilgeExclusions.map((ing) => (
                                <button
                                    key={`exc-${ing}`}
                                    onClick={() => {
                                        setBilgeExclusions((prev) => prev.filter((i) => i !== ing));
                                        triggerHaptic('light');
                                    }}
                                    className="px-2.5 py-1 rounded-lg bg-red-500/15 text-red-300 text-[11px] font-bold border border-red-500/20 hover:bg-red-500/25 transition-all flex items-center gap-1"
                                >
                                    −{ing} <span className="text-red-400/60">✕</span>
                                </button>
                            ))}
                        </div>
                    )}

                    {/* ── Quick Filter Tags ── */}
                    {!bilgeDiveMode && (
                        <div className="space-y-2">
                            {tagGroups.map((group) => (
                                <div
                                    key={group.label}
                                    className="flex items-center gap-1.5 overflow-x-auto no-scrollbar"
                                >
                                    <span className="text-[11px] text-gray-500 font-bold uppercase tracking-wider whitespace-nowrap shrink-0 w-16">
                                        {group.label}
                                    </span>
                                    {group.tags.map((tag) => (
                                        <button
                                            key={tag.id}
                                            onClick={() => handleToggleFilter(tag.id)}
                                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap active:scale-95 ${
                                                activeFilters.has(tag.id)
                                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                                                    : 'bg-white/[0.03] text-gray-400 border border-white/[0.06] hover:bg-white/[0.06]'
                                            }`}
                                        >
                                            {tag.emoji} {tag.label}
                                        </button>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ── Sort + Actions Row ── */}
                    <div className="flex items-center gap-2">
                        <div className="flex gap-1 flex-1 overflow-x-auto no-scrollbar">
                            {sortOptions.map((opt) => (
                                <button
                                    key={opt.key}
                                    onClick={() => {
                                        setSortBy(opt.key);
                                        triggerHaptic('light');
                                    }}
                                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap ${
                                        sortBy === opt.key
                                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                                            : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.06]'
                                    }`}
                                >
                                    {opt.emoji} {opt.label}
                                </button>
                            ))}
                            {/* Favourites filter */}
                            <button
                                onClick={() => {
                                    setShowFavouritesOnly((v) => !v);
                                    triggerHaptic('light');
                                }}
                                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap ${
                                    showFavouritesOnly
                                        ? 'bg-rose-500/15 text-rose-300 border border-rose-500/25'
                                        : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.06]'
                                }`}
                            >
                                {showFavouritesOnly ? '♥' : '♡'} Favourites
                            </button>
                        </div>
                        <button
                            onClick={() => setShowUploadForm(true)}
                            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/25 text-[11px] font-bold text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-95 whitespace-nowrap"
                        >
                            📝 Share
                        </button>
                    </div>

                    {/* ── Active Filter Summary ── */}
                    {activeFilters.size > 0 && !bilgeDiveMode && (
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] text-gray-500">Filtering:</span>
                            <div className="flex gap-1 flex-wrap flex-1">
                                {[...activeFilters].map((tag) => {
                                    const def = NAUTICAL_TAG_DEFS.find((d) => d.id === tag);
                                    return def ? (
                                        <span
                                            key={tag}
                                            className="px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-400 text-[11px] font-bold"
                                        >
                                            {def.emoji} {def.label}
                                        </span>
                                    ) : null;
                                })}
                            </div>
                            <button
                                onClick={() => {
                                    setActiveFilters(new Set());
                                    triggerHaptic('light');
                                }}
                                className="text-[11px] text-gray-500 hover:text-white transition-colors"
                            >
                                Clear
                            </button>
                        </div>
                    )}

                    {/* ── Loading State ── */}
                    {loading && (
                        <div className="flex items-center justify-center py-8">
                            <div className="animate-spin text-2xl">☸</div>
                            <span className="text-xs text-gray-500 ml-2">Loading recipes…</span>
                        </div>
                    )}

                    {/* ── Empty State ── */}
                    {!loading && displayRecipes.length === 0 && (
                        <div className="text-center py-8 space-y-3">
                            <span className="text-4xl block">
                                {bilgeDiveMode
                                    ? '🧭'
                                    : debouncedQuery || activeFilters.size > 0 || showFavouritesOnly
                                      ? '🔍'
                                      : '🍽️'}
                            </span>
                            <div>
                                <p className="text-sm font-bold text-white">
                                    {bilgeDiveMode
                                        ? bilgeIngredients.length === 0
                                            ? 'Type your ingredients above'
                                            : 'No matching recipes found'
                                        : showFavouritesOnly
                                          ? 'No favourites saved yet'
                                          : debouncedQuery || activeFilters.size > 0
                                            ? 'No recipes match your filters'
                                            : 'The table is set, but empty!'}
                                </p>
                                <p className="text-xs text-gray-500 mt-1">
                                    {bilgeDiveMode
                                        ? 'Try adding more ingredients or removing exclusions'
                                        : showFavouritesOnly
                                          ? 'Tap the heart on recipes you love'
                                          : 'Be the first to share a recipe with the fleet.'}
                                </p>
                            </div>
                            {!bilgeDiveMode && !showFavouritesOnly && !debouncedQuery && activeFilters.size === 0 && (
                                <button
                                    onClick={() => setShowUploadForm(true)}
                                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-xs font-bold text-black shadow-lg shadow-amber-500/20 active:scale-95 transition-transform"
                                >
                                    📝 Share Your First Recipe
                                </button>
                            )}
                        </div>
                    )}

                    {/* ── Recipe Cards ── */}
                    {!loading && displayRecipes.length > 0 && (
                        <div className="space-y-2">
                            {displayRecipes.map((recipe) => {
                                const isFav = favouriteIds.has(recipe.supabaseId);
                                const bilgeResult = bilgeDiveMode
                                    ? bilgeDiveResults.find((r) => r.recipe.supabaseId === recipe.supabaseId)
                                    : null;
                                return (
                                    <button
                                        key={recipe.supabaseId}
                                        onClick={() => {
                                            setSelectedRecipe(recipe);
                                            triggerHaptic('light');
                                        }}
                                        className="w-full flex items-stretch gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-amber-500/[0.04] hover:border-amber-500/15 transition-all text-left active:scale-[0.98]"
                                    >
                                        {/* Thumbnail with galley light filter */}
                                        {recipe.image ? (
                                            <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden relative">
                                                <img
                                                    src={recipe.image}
                                                    alt=""
                                                    className="w-full h-full object-cover"
                                                    style={{ filter: 'brightness(1.05) contrast(1.05) saturate(1.15)' }}
                                                    loading="lazy"
                                                    onError={(e) => {
                                                        (e.target as HTMLImageElement).style.display = 'none';
                                                    }}
                                                />
                                                <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-black/5 rounded-lg pointer-events-none" />
                                            </div>
                                        ) : (
                                            <div className="w-16 h-16 rounded-lg bg-amber-500/10 flex items-center justify-center text-2xl flex-shrink-0">
                                                {getFallbackIcon(recipe.supabaseId)}
                                            </div>
                                        )}

                                        {/* Content */}
                                        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                                            <div>
                                                <p className="text-xs font-bold text-white truncate">{recipe.title}</p>
                                                <p className="text-[11px] text-gray-500 mt-0.5">
                                                    by {recipe.authorName} · ⏱️ {recipe.readyInMinutes}min
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 mt-1">
                                                <WheelRating
                                                    rating={recipe.ratingAvg}
                                                    count={recipe.ratingCount}
                                                    size={11}
                                                />
                                                {bilgeResult && (
                                                    <span
                                                        className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                                                            bilgeResult.matchPercent >= 80
                                                                ? 'bg-emerald-500/15 text-emerald-400'
                                                                : bilgeResult.matchPercent >= 50
                                                                  ? 'bg-amber-500/15 text-amber-400'
                                                                  : 'bg-gray-500/15 text-gray-400'
                                                        }`}
                                                    >
                                                        {bilgeResult.matchedIngredients.length}/
                                                        {bilgeResult.totalSearched} match
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {/* Favourite heart + Chevron */}
                                        <div className="flex flex-col items-center justify-between py-0.5">
                                            <button
                                                onClick={(e) => handleToggleFavourite(recipe.supabaseId, e)}
                                                className={`w-7 h-7 rounded-full flex items-center justify-center text-sm transition-all active:scale-90 ${
                                                    isFav
                                                        ? 'text-rose-400 bg-rose-500/10'
                                                        : 'text-gray-500 hover:text-gray-400'
                                                }`}
                                                aria-label={isFav ? 'Remove from favourites' : 'Add to favourites'}
                                            >
                                                {isFav ? '♥' : '♡'}
                                            </button>
                                            <svg
                                                className="w-3.5 h-3.5 text-gray-500"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M8.25 4.5l7.5 7.5-7.5 7.5"
                                                />
                                            </svg>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ── Recipe Detail Modal ── */}
            {selectedRecipe && (
                <RecipeDetail
                    recipe={selectedRecipe}
                    onClose={() => setSelectedRecipe(null)}
                    onRated={() => loadRecipes()}
                />
            )}

            {/* ── Upload Form Modal ── */}
            {showUploadForm && (
                <CustomRecipeForm
                    onSaved={() => {
                        setShowUploadForm(false);
                        loadRecipes();
                    }}
                    onClose={() => setShowUploadForm(false)}
                />
            )}
        </div>
    );
};
