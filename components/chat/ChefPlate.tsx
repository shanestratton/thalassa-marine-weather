/**
 * ChefPlate — Visual-first recipe card ("Chef's Plate").
 *
 * Shows recipe hero image, crew scaler, ingredient list with
 * per-item stores shortfall badges, and cooking CTAs.
 */
import React, { useState, useEffect } from 'react';
import { startCooking, getStoresAvailability, type MealPlan } from '../../services/MealPlanService';
import {
    scaleIngredient,
    getRecipeImageUrl,
    getGalleyDifficulty,
    getRecipeInstructions,
    type RecipeStep,
} from '../../services/GalleyRecipeService';
import { type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { getIngredientEmoji, getStorageLocation, STRIP_WORDS } from './galleyTokens';

interface ChefPlateProps {
    meal: MealPlan;
    baseServings: number;
    cooking: boolean;
    onCook: () => void;
    shoppingSummary: ShoppingListSummary | null;
    /** Names of ingredients that are short across ALL meals (aggregate). */
    aggregateShortfallNames?: Set<string>;
}

export const ChefPlate: React.FC<ChefPlateProps> = ({
    meal,
    baseServings,
    cooking,
    onCook,
    shoppingSummary: _shoppingSummary,
    aggregateShortfallNames,
}) => {
    const [crewCount, setCrewCount] = useState(baseServings);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [imgError, setImgError] = useState(false);
    const [prepStarted, setPrepStarted] = useState(meal.status === 'cooking');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [storesVersion, setStoresVersion] = useState(0);
    const ratio = crewCount / baseServings;

    // Cooking directions state
    const [activeTab, setActiveTab] = useState<'ingredients' | 'directions'>('ingredients');
    const [instructions, setInstructions] = useState<RecipeStep[]>([]);
    const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
    const [loadingInstructions, setLoadingInstructions] = useState(false);

    // Refresh stores data when items are purchased
    useEffect(() => {
        const handler = () => setStoresVersion((v) => v + 1);
        window.addEventListener('thalassa:stores-changed', handler);
        return () => window.removeEventListener('thalassa:stores-changed', handler);
    }, []);

    // Scale ingredients in real-time
    const scaledIngredients = meal.ingredients.map((ing) => ({
        ...ing,
        scaledAmount:
            Math.round(scaleIngredient(ing.amount, ing.scalable, baseServings, crewCount, ing.unit) * 10) / 10,
    }));

    // Get stores availability for per-ingredient shortfall (re-reads on storesVersion change)
    const storesAvail = getStoresAvailability();

    // Fuzzy match: recipe name "large eggs" should match store item "eggs"
    const findStoreMatch = (ingredientName: string) => {
        const lower = ingredientName.toLowerCase().trim();
        // 1. Exact match
        const exact = storesAvail.find((s) => s.item_name.toLowerCase() === lower);
        if (exact) return exact;
        // 2. Strip qualifiers and try contains match
        const coreWords = lower.split(/\s+/).filter((w) => !STRIP_WORDS.has(w) && w.length > 2);
        const corePhrase = coreWords.join(' ');
        if (!corePhrase) return undefined;
        // Check if store name contains core phrase or vice versa
        return storesAvail.find((s) => {
            const storeLower = s.item_name.toLowerCase();
            return storeLower.includes(corePhrase) || corePhrase.includes(storeLower);
        });
    };

    // Per-recipe shortfall: items missing or insufficient for THIS recipe
    const shortfallIngredients = scaledIngredients.filter((ing) => {
        const store = findStoreMatch(ing.name);
        if (!store) return true;
        const effectiveAvailable = Math.round((store.available + ing.amount) * 10) / 10;
        return effectiveAvailable < ing.scaledAmount;
    });

    // Aggregate shortfall: items OK for this recipe but short across ALL meals
    const aggregateShortfallCount = aggregateShortfallNames
        ? scaledIngredients.filter((ing) => {
              // Only count items that are green per-recipe but amber aggregate
              const store = findStoreMatch(ing.name);
              const effectiveAvailable = store ? Math.round((store.available + ing.amount) * 10) / 10 : 0;
              const hasEnoughHere = effectiveAvailable >= ing.scaledAmount;
              return hasEnoughHere && aggregateShortfallNames.has(ing.name.toLowerCase());
          }).length
        : 0;

    // Total shortfall = red (per-recipe) + amber (aggregate)
    const totalShortfallCount = shortfallIngredients.length + aggregateShortfallCount;

    // Recipe image — cache-first
    const realSpoonacularId = meal.spoonacular_id && meal.spoonacular_id < 10_000_000 ? meal.spoonacular_id : null;
    const recipeImageUrl = realSpoonacularId
        ? getRecipeImageUrl(realSpoonacularId, `https://img.spoonacular.com/recipes/${realSpoonacularId}-480x360.jpg`)
        : '';
    const showImage = recipeImageUrl && !imgError;

    // Detect meal emoji from title
    const mealEmoji = (() => {
        const t = meal.title;
        const match = t.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)/u);
        if (match && match[0].trim()) return match[0];
        const slot = meal.meal_slot;
        if (slot === 'breakfast') return '🍳';
        if (slot === 'lunch') return '🥗';
        if (slot === 'dinner') return '🍽️';
        return '🍴';
    })();

    // Prep time estimate
    const readyInLabel = (() => {
        const title = meal.title.toLowerCase();
        if (title.includes('smoked') || title.includes('brisket')) return '12-Hour Slow Smoke';
        if (title.includes('roast')) return '4-Hour Roast';
        if (title.includes('stew') || title.includes('braise')) return '3-Hour Braise';
        return `${Math.max(30, (meal.ingredients?.length || 4) * 8)} Min`;
    })();

    const shareText = [
        `🍽️ ${meal.title}`,
        `📅 ${meal.planned_date} · ${meal.meal_slot}`,
        `👥 ${crewCount} serves`,
        '',
        '📦 Ingredients:',
        ...scaledIngredients.map((i) => `${getIngredientEmoji(i.aisle)} ${i.scaledAmount} ${i.unit} ${i.name}`),
        '',
        `⏱️ ${readyInLabel}`,
        `🔧 Stores: ${shortfallIngredients.length === 0 ? 'READY' : `SHORTFALL (${shortfallIngredients.length} ITEMS)`}`,
        '',
    ].join('\n');

    // ── Start Prep: fetch instructions + switch to directions tab ──
    const handleStartPrep = async () => {
        setPrepStarted(true);
        triggerHaptic('heavy');
        await startCooking(meal.id);

        // Fetch instructions if we don't have them yet
        if (instructions.length === 0) {
            setLoadingInstructions(true);
            try {
                const steps = await getRecipeInstructions(meal.spoonacular_id);
                setInstructions(steps);
            } catch (e) {
                console.warn('Failed to load instructions:', e);
            }
            setLoadingInstructions(false);
        }

        // Switch to directions view
        setActiveTab('directions');
    };

    const toggleStep = (stepNum: number) => {
        setCompletedSteps((prev) => {
            const next = new Set(prev);
            if (next.has(stepNum)) next.delete(stepNum);
            else next.add(stepNum);
            return next;
        });
        triggerHaptic('light');
    };

    return (
        <div
            className="rounded-2xl overflow-hidden border border-white/[0.06] bg-slate-950"
            role="article"
            aria-label={`Recipe: ${meal.title}`}
        >
            {/* ═══════ 1. HERO IMAGE (compact 50%) ═══════ */}
            <div className="relative h-28 overflow-hidden">
                {showImage && (
                    <img
                        src={recipeImageUrl}
                        alt={meal.title}
                        loading="lazy"
                        onLoad={() => setImgLoaded(true)}
                        onError={() => setImgError(true)}
                        className={`absolute inset-0 w-full h-full object-cover transition-all duration-700 ${
                            imgLoaded ? 'opacity-100 scale-100 blur-0' : 'opacity-0 scale-105 blur-sm'
                        }`}
                    />
                )}
                {/* Premium gradient fallback */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br from-amber-900/90 via-orange-800/70 to-red-900/90 transition-opacity duration-700 ${
                        imgLoaded && showImage ? 'opacity-0' : 'opacity-100'
                    }`}
                >
                    <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjAzKSIvPjwvc3ZnPg==')] opacity-50" />
                    {(!showImage || !imgLoaded) && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-6xl opacity-30 select-none">{mealEmoji}</span>
                        </div>
                    )}
                </div>

                {/* Bottom shadow gradient */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

                {/* Title + Ready In overlay */}
                <div className="absolute bottom-0 left-0 right-0 p-4">
                    <p className="text-lg font-black text-white leading-tight drop-shadow-lg">{meal.title}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="px-2 py-0.5 rounded-full bg-white/15 backdrop-blur-sm text-[10px] font-bold text-amber-200 border border-white/10">
                            ⏱️ {readyInLabel}
                        </span>
                        {(() => {
                            const diff = getGalleyDifficulty(meal.title, undefined, meal.ingredients?.length);
                            const diffColors =
                                diff.score <= 2
                                    ? 'text-emerald-300 border-emerald-500/20 bg-emerald-500/15'
                                    : diff.score === 3
                                      ? 'text-amber-300 border-amber-500/20 bg-amber-500/15'
                                      : diff.score === 4
                                        ? 'text-orange-300 border-orange-500/20 bg-orange-500/15'
                                        : 'text-red-300 border-red-500/20 bg-red-500/15';
                            return (
                                <span
                                    className={`px-2 py-0.5 rounded-full backdrop-blur-sm text-[10px] font-bold border ${diffColors}`}
                                >
                                    {diff.emoji} {diff.label}
                                </span>
                            );
                        })()}
                        <span className="text-[11px] text-white/60">
                            {meal.planned_date} · {meal.meal_slot}
                        </span>
                    </div>
                </div>

                {/* Status badge */}
                <div className="absolute top-3 left-3">
                    <span
                        className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase backdrop-blur-sm ${
                            prepStarted
                                ? 'bg-orange-500/30 text-orange-300 border border-orange-500/30'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/20'
                        }`}
                    >
                        {prepStarted ? '🔥 Cooking' : '📋 Reserved'}
                    </span>
                </div>
            </div>

            {/* ═══════ 2. CREW SCALER ═══════ */}
            <div className="p-4 bg-slate-950/80 border-b border-white/[0.06]">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Crew Count</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">Ingredients scale live</p>
                    </div>
                    <div className="flex items-center gap-3" role="group" aria-label="Crew count for recipe scaling">
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.max(1, c - 1));
                                triggerHaptic('light');
                            }}
                            className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-all active:scale-90"
                            aria-label="Decrease servings"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" d="M5 12h14" />
                            </svg>
                        </button>
                        <span
                            className={`text-3xl font-black w-10 text-center tabular-nums transition-colors duration-300 ${
                                crewCount !== baseServings ? 'text-amber-400' : 'text-white'
                            }`}
                            aria-live="polite"
                            aria-label={`${crewCount} servings`}
                        >
                            {crewCount}
                        </span>
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.min(20, c + 1));
                                triggerHaptic('light');
                            }}
                            className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-all active:scale-90"
                            aria-label="Increase servings"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
                            </svg>
                        </button>
                    </div>
                </div>
                {crewCount !== baseServings && (
                    <p className="text-[10px] text-amber-400/60 mt-2 text-right">
                        Scaled from {baseServings} → {crewCount} serves (×{ratio.toFixed(1)})
                    </p>
                )}
            </div>

            {/* ═══════ 3. STORES STATUS BAR ═══════ */}
            <div className="flex">
                <div className="flex-1 p-3 bg-slate-900 border-b border-r border-white/[0.06] flex items-center gap-2">
                    <span className="text-base">📦</span>
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Ingredients</p>
                        <p className="text-sm font-black text-white">{scaledIngredients.length}</p>
                    </div>
                </div>
                <div
                    className={`flex-1 p-3 border-b border-white/[0.06] flex items-center gap-2 ${
                        totalShortfallCount === 0
                            ? 'bg-emerald-950/30'
                            : shortfallIngredients.length > 0
                              ? 'bg-red-950/30'
                              : 'bg-amber-950/30'
                    }`}
                >
                    <span className="text-base">{totalShortfallCount === 0 ? '✅' : '⚠️'}</span>
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Stores</p>
                        <p
                            className={`text-sm font-black ${
                                totalShortfallCount === 0
                                    ? 'text-emerald-400'
                                    : shortfallIngredients.length > 0
                                      ? 'text-red-400'
                                      : 'text-amber-400'
                            }`}
                        >
                            {totalShortfallCount === 0 ? 'READY' : `SHORTFALL (${totalShortfallCount})`}
                        </p>
                    </div>
                </div>
            </div>

            {/* ═══════ 4. TABS: Ingredients / Directions ═══════ */}
            {prepStarted && (
                <div className="flex border-b border-white/[0.06]">
                    <button
                        onClick={() => setActiveTab('ingredients')}
                        className={`flex-1 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-all ${
                            activeTab === 'ingredients'
                                ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-500/[0.05]'
                                : 'text-gray-500 hover:text-gray-400'
                        }`}
                    >
                        📦 Ingredients
                    </button>
                    <button
                        onClick={async () => {
                            setActiveTab('directions');
                            if (instructions.length === 0 && !loadingInstructions) {
                                setLoadingInstructions(true);
                                try {
                                    const steps = await getRecipeInstructions(meal.spoonacular_id);
                                    setInstructions(steps);
                                } catch (e) {
                                    console.warn('Failed to load instructions:', e);
                                }
                                setLoadingInstructions(false);
                            }
                        }}
                        className={`flex-1 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-all ${
                            activeTab === 'directions'
                                ? 'text-orange-400 border-b-2 border-orange-400 bg-orange-500/[0.05]'
                                : 'text-gray-500 hover:text-gray-400'
                        }`}
                    >
                        👨‍🍳 Directions
                        {instructions.length > 0 && (
                            <span className="ml-1.5 text-[11px] opacity-60">
                                ({completedSteps.size}/{instructions.length})
                            </span>
                        )}
                    </button>
                </div>
            )}

            {/* ═══════ 4a. INGREDIENT LIST ═══════ */}
            {(!prepStarted || activeTab === 'ingredients') && (
                <div className="p-4 space-y-1.5" role="list" aria-label="Ingredients">
                    {scaledIngredients.map((ing, i) => {
                        const store = findStoreMatch(ing.name);
                        const available = store ? Math.round((store.available + ing.amount) * 10) / 10 : 0;
                        const hasEnough = available >= ing.scaledAmount;
                        const isLow = store && !hasEnough;
                        const isMissing = !store;
                        // Check if this ingredient is short across ALL meals (aggregate)
                        const isAggregateShort = hasEnough && aggregateShortfallNames?.has(ing.name.toLowerCase());

                        return (
                            <div
                                key={i}
                                className={`flex items-center gap-3 p-2.5 rounded-xl border transition-colors ${
                                    !hasEnough
                                        ? 'bg-red-500/[0.04] border-red-500/10'
                                        : isAggregateShort
                                          ? 'bg-amber-500/[0.04] border-amber-500/10'
                                          : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.04]'
                                }`}
                                role="listitem"
                            >
                                {/* Status indicator */}
                                <span className="text-base w-6 text-center flex-shrink-0">
                                    {hasEnough ? (isAggregateShort ? '⚠️' : '✅') : isLow ? '⚠️' : '🔴'}
                                </span>

                                {/* Ingredient info */}
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-white truncate">
                                        {ing.scaledAmount} {ing.unit} {ing.name}
                                    </p>
                                    <p className="text-[10px] text-gray-500">
                                        {hasEnough
                                            ? isAggregateShort
                                                ? `⚠️ Enough here, short across all meals · ${available} on hand`
                                                : `📍 ${getStorageLocation(ing.aisle)} · ${available} on hand`
                                            : isMissing
                                              ? 'Not in stores'
                                              : `Only ${available} ${ing.unit} on hand`}
                                    </p>
                                </div>

                                {/* Scale indicator */}
                                {ing.scalable && crewCount !== baseServings && (
                                    <span className="text-[11px] text-amber-400/50 flex-shrink-0 hidden sm:block">
                                        was {ing.amount}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ═══════ 4b. DIRECTIONS (Step-by-Step) ═══════ */}
            {prepStarted && activeTab === 'directions' && (
                <div className="p-4 space-y-2" role="list" aria-label="Cooking directions">
                    {loadingInstructions ? (
                        <div className="flex items-center justify-center py-8 gap-3">
                            <div className="w-4 h-4 border-2 border-orange-400/30 border-t-orange-400 rounded-full animate-spin" />
                            <p className="text-xs text-gray-400">Loading directions…</p>
                        </div>
                    ) : instructions.length === 0 ? (
                        <div className="text-center py-8">
                            <p className="text-2xl mb-2">📝</p>
                            <p className="text-xs text-gray-400">No directions available for this recipe.</p>
                            {meal.spoonacular_id && meal.spoonacular_id < 10_000_000 && (
                                <a
                                    href={`https://spoonacular.com/recipes/${meal.title.toLowerCase().replace(/\s+/g, '-')}-${meal.spoonacular_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block mt-3 px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] text-[10px] font-bold text-sky-400 hover:bg-white/[0.1] transition-all"
                                >
                                    🔗 View on Spoonacular
                                </a>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Progress bar */}
                            <div className="mb-3">
                                <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">
                                        Progress
                                    </p>
                                    <p className="text-[10px] text-orange-400 font-bold">
                                        {completedSteps.size}/{instructions.length} steps
                                    </p>
                                </div>
                                <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-500"
                                        style={{ width: `${(completedSteps.size / instructions.length) * 100}%` }}
                                    />
                                </div>
                            </div>

                            {/* Steps */}
                            {instructions.map((step) => {
                                const done = completedSteps.has(step.number);
                                return (
                                    <button
                                        key={step.number}
                                        onClick={() => toggleStep(step.number)}
                                        className={`w-full flex gap-3 p-3 rounded-xl border text-left transition-all active:scale-[0.99] ${
                                            done
                                                ? 'bg-emerald-500/[0.06] border-emerald-500/15'
                                                : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
                                        }`}
                                        role="listitem"
                                        aria-label={`Step ${step.number}: ${step.step}`}
                                    >
                                        {/* Step number / check */}
                                        <div
                                            className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[11px] font-black transition-all ${
                                                done
                                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                    : 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                                            }`}
                                        >
                                            {done ? '✓' : step.number}
                                        </div>

                                        {/* Step text */}
                                        <p
                                            className={`text-xs leading-relaxed flex-1 transition-all ${
                                                done ? 'text-gray-500 line-through' : 'text-gray-200'
                                            }`}
                                        >
                                            {step.step}
                                        </p>
                                    </button>
                                );
                            })}

                            {/* All done message */}
                            {completedSteps.size === instructions.length && (
                                <div className="text-center py-4 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/15">
                                    <p className="text-lg mb-1">🎉</p>
                                    <p className="text-xs font-bold text-emerald-400">All steps complete!</p>
                                    <p className="text-[10px] text-gray-500 mt-0.5">
                                        Tap ‘Complete Meal’ to subtract from stores
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* ═══════ 5. ACTIONS: Start Prep + Share ═══════ */}
            <div className="px-4 pb-4 flex gap-2">
                {!prepStarted ? (
                    <button
                        onClick={handleStartPrep}
                        disabled={cooking}
                        className="flex-1 py-3.5 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-40 shadow-lg shadow-amber-500/5"
                        aria-label="Start cooking this meal"
                    >
                        {cooking ? '⏳ Starting…' : '🔥 Start Prep'}
                    </button>
                ) : (
                    <button
                        onClick={onCook}
                        disabled={cooking}
                        className="flex-1 py-3.5 bg-gradient-to-r from-emerald-500/15 to-teal-500/15 border border-emerald-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-emerald-300 hover:from-emerald-500/25 hover:to-teal-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
                        aria-label="Complete this meal"
                    >
                        {cooking ? '⏳ Subtracting from Stores…' : '✅ Complete Meal'}
                    </button>
                )}
                <button
                    onClick={() => {
                        if (navigator.share) {
                            navigator.share({ title: meal.title, text: shareText }).catch(() => {});
                        } else {
                            navigator.clipboard.writeText(shareText).then(() => triggerHaptic('light'));
                        }
                    }}
                    className="w-11 flex-shrink-0 flex items-center justify-center border border-white/[0.08] bg-white/[0.03] rounded-xl text-gray-400 hover:bg-white/[0.06] hover:text-white transition-colors"
                    aria-label="Share recipe"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                        />
                    </svg>
                </button>
            </div>
        </div>
    );
};
