/**
 * GalleyMealPlanner — Spoonacular-powered meal plan for passage provisioning.
 *
 * Generates real recipes for each day of a passage, with:
 *  - Recipe cards (image, cook time, servings)
 *  - Provisioning check against Ship's Stores
 *  - Shortfall alerts for missing ingredients
 *  - Consolidated shopping list
 *  - Offline fallback to static meal ideas
 */
import React, { useState, useCallback } from 'react';
import {
    generateGalleyPlan,
    getShoppingList,
    type GalleyPlan,
    type GalleyDayPlan,
    type ShoppingItem,
} from '../../services/GalleyRecipeService';
import { calculateProvisions, type ProvisionSummary } from '../../services/PassageProvisionsService';
import { triggerHaptic } from '../../utils/system';

interface GalleyMealPlannerProps {
    days: number;
    crew: number;
    /** Fallback static meal plan rendered when API is unavailable */
    fallbackContent: React.ReactNode;
}

export const GalleyMealPlanner: React.FC<GalleyMealPlannerProps> = ({ days, crew, fallbackContent }) => {
    const [plan, setPlan] = useState<GalleyPlan | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showFallback, setShowFallback] = useState(false);
    const [shoppingList, setShoppingList] = useState<ShoppingItem[] | null>(null);
    const [loadingShop, setLoadingShop] = useState(false);
    const [activeDay, setActiveDay] = useState(0);
    const [provisions, setProvisions] = useState<ProvisionSummary | null>(null);

    const handleGenerate = useCallback(async () => {
        triggerHaptic('medium');
        setLoading(true);
        setError(null);
        setShowFallback(false);

        try {
            const result = await generateGalleyPlan(days, crew);
            if (result) {
                setPlan(result);
                // Auto-calculate provisions against Ship's Stores
                try {
                    const provResult = calculateProvisions(result, crew);
                    setProvisions(provResult);
                } catch (e) { console.warn("Suppressed:", e);
                    /* non-critical — stores may be empty */
                }
            } else {
                setShowFallback(true);
            }
        } catch (e) { console.warn("Suppressed:", e);
            setError('Failed to generate meal plan');
            setShowFallback(true);
        } finally {
            setLoading(false);
        }
    }, [days, crew]);

    const handleShoppingList = useCallback(async () => {
        if (!plan) return;
        triggerHaptic('light');
        setLoadingShop(true);

        const allRecipeIds = plan.days.flatMap((d) => d.meals.map((m) => m.id));
        const uniqueIds = [...new Set(allRecipeIds)];
        const list = await getShoppingList(uniqueIds);

        // Scale amounts by crew/servings ratio
        const scaled = list.map((item) => ({
            ...item,
            amount: Math.ceil(item.amount * (crew / 2)), // Base is ~2 servings
        }));

        setShoppingList(scaled);
        setLoadingShop(false);
    }, [plan, crew]);

    const handleCopyShoppingList = useCallback(() => {
        if (!shoppingList) return;
        triggerHaptic('light');

        // Group by aisle
        const grouped = new Map<string, ShoppingItem[]>();
        for (const item of shoppingList) {
            const aisle = item.aisle || 'Other';
            if (!grouped.has(aisle)) grouped.set(aisle, []);
            grouped.get(aisle)!.push(item);
        }

        let text = `🛒 Galley Shopping List — ${days} day passage, ${crew} crew\n\n`;
        for (const [aisle, items] of grouped) {
            text += `── ${aisle} ──\n`;
            for (const item of items) {
                const amt = item.amount > 0 ? `${item.amount} ${item.unit}`.trim() : '';
                text += `  □ ${item.name}${amt ? ` — ${amt}` : ''}\n`;
            }
            text += '\n';
        }

        navigator.clipboard.writeText(text);
    }, [shoppingList, days, crew]);

    // ── No plan yet — show generate button ──
    if (!plan && !showFallback) {
        return (
            <div className="space-y-3">
                <button
                    aria-label="Generate Galley Plan"
                    onClick={handleGenerate}
                    disabled={loading}
                    className="w-full py-3 px-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/30 rounded-xl text-xs font-bold uppercase tracking-widest text-amber-300 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {loading ? (
                        <>
                            <span className="animate-spin">⏳</span>
                            Generating {days}-day plan…
                        </>
                    ) : (
                        <>
                            🍳 Generate Galley Meal Plan
                            <span className="text-[11px] text-amber-400/60 font-normal normal-case">
                                ({days} day{days > 1 ? 's' : ''} × {crew} crew)
                            </span>
                        </>
                    )}
                </button>

                {error && <p className="text-xs text-red-400 text-center">{error}</p>}

                {/* Always offer the static fallback */}
                <button
                    aria-label="Show Static Meal Ideas"
                    onClick={() => setShowFallback(true)}
                    className="w-full py-2 text-[11px] text-gray-400 hover:text-gray-300 transition-colors text-center"
                >
                    Or view offline meal ideas →
                </button>
            </div>
        );
    }

    // ── Static fallback ──
    if (showFallback) {
        return <>{fallbackContent}</>;
    }

    // ── Render the generated plan ──
    const currentDay = plan!.days[activeDay];

    return (
        <div className="animate-in fade-in slide-in-from-top-4 duration-300 space-y-4">
            <div className="bg-gradient-to-br from-amber-500/5 via-orange-500/5 to-red-500/5 border border-amber-500/20 rounded-2xl p-5 relative overflow-hidden">
                <div className="absolute bottom-0 right-0 w-40 h-40 bg-orange-400/5 rounded-full translate-y-12 translate-x-12 blur-3xl" />

                {/* Header */}
                <div className="flex items-center justify-between mb-4 relative z-10">
                    <h3 className="text-sm font-bold text-amber-300 uppercase tracking-widest flex items-center gap-2">
                        🍳 Galley Meal Plan
                    </h3>
                    <div className="flex items-center gap-2">
                        <button
                            aria-label="Regenerate"
                            onClick={handleGenerate}
                            disabled={loading}
                            className="text-[11px] text-gray-400 hover:text-amber-300 transition-colors px-2 py-1 rounded-lg hover:bg-white/5"
                        >
                            {loading ? '⏳' : '🔄'} Refresh
                        </button>
                    </div>
                </div>

                {/* Day selector tabs */}
                <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 relative z-10 scrollbar-none">
                    {plan!.days.map((day, i) => (
                        <button
                            key={i}
                            aria-label={`Day ${day.day}`}
                            onClick={() => setActiveDay(i)}
                            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                                i === activeDay
                                    ? 'bg-amber-500/25 text-amber-300 border border-amber-500/30'
                                    : 'bg-white/5 text-gray-400 border border-white/5 hover:bg-white/10'
                            }`}
                        >
                            Day {day.day}
                        </button>
                    ))}
                </div>

                {/* Day's meals */}
                <DayCard day={currentDay} crew={crew} />

                {/* Nutrition badge */}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-gray-400 relative z-10">
                    <span>🔥 {currentDay.nutrients.calories} cal</span>
                    <span>💪 {currentDay.nutrients.protein}g protein</span>
                    <span>🧈 {currentDay.nutrients.fat}g fat</span>
                    <span>🍞 {currentDay.nutrients.carbohydrates}g carbs</span>
                </div>
            </div>

            {/* Shopping List section */}
            <div className="flex gap-2">
                <button
                    aria-label="Generate Shopping List"
                    onClick={handleShoppingList}
                    disabled={loadingShop}
                    className="flex-1 py-2.5 px-4 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-xl text-xs font-bold uppercase tracking-widest text-emerald-300 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {loadingShop ? '⏳ Building…' : '🛒 Shopping List'}
                </button>
                {shoppingList && (
                    <button
                        aria-label="Copy Shopping List"
                        onClick={handleCopyShoppingList}
                        className="py-2.5 px-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-bold text-gray-300 transition-all active:scale-[0.98]"
                    >
                        📋 Copy
                    </button>
                )}
            </div>

            {/* Provision shortfall summary */}
            {provisions && provisions.shortfalls > 0 && <ProvisionAlert provisions={provisions} />}

            {/* Shopping list display */}
            {shoppingList && <ShoppingListView items={shoppingList} crew={crew} days={days} />}
        </div>
    );
};

// ── Day Card ───────────────────────────────────────────────────────────────

const MEAL_LABELS = ['Breakfast', 'Lunch', 'Dinner'] as const;
const MEAL_EMOJIS = ['🌅', '☀️', '🌙'] as const;

const DayCard: React.FC<{ day: GalleyDayPlan; crew: number }> = ({ day, crew }) => (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 relative z-10">
        {day.meals.map((meal, i) => (
            <div key={meal.id} className="bg-black/20 rounded-xl overflow-hidden border border-white/5 group">
                {/* Recipe image */}
                <div className="relative h-28 overflow-hidden">
                    <img
                        src={meal.image}
                        alt={meal.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                    <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/50 backdrop-blur-sm rounded-full text-[10px] font-bold text-amber-300 uppercase tracking-wider">
                        {MEAL_EMOJIS[i]} {MEAL_LABELS[i]}
                    </div>
                    <div
                        className={`absolute top-2 right-2 px-2 py-0.5 bg-black/50 backdrop-blur-sm rounded-full text-[10px] font-bold ${
                            meal.readyInMinutes >= 120 ? 'text-red-400' : 'text-gray-300'
                        }`}
                    >
                        {meal.readyInMinutes >= 120
                            ? `🔥 ${Math.round(meal.readyInMinutes / 60)}hr ${meal.readyInMinutes % 60}m`
                            : `⏱ ${meal.readyInMinutes}min`}
                    </div>
                </div>

                {/* Recipe info */}
                <div className="p-3 space-y-1.5">
                    <h5 className="text-xs font-bold text-white leading-tight line-clamp-2">{meal.title}</h5>
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                        <span>× {crew} serves</span>
                        {meal.sourceUrl && (
                            <a
                                href={meal.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-amber-400/60 hover:text-amber-300 transition-colors"
                                onClick={(e) => e.stopPropagation()}
                            >
                                Recipe →
                            </a>
                        )}
                    </div>
                </div>
            </div>
        ))}
    </div>
);

// ── Shopping List View ─────────────────────────────────────────────────────

const ShoppingListView: React.FC<{ items: ShoppingItem[]; crew: number; days: number }> = ({ items, crew, days }) => {
    // Group by aisle
    const grouped = new Map<string, ShoppingItem[]>();
    for (const item of items) {
        const aisle = item.aisle || 'Other';
        if (!grouped.has(aisle)) grouped.set(aisle, []);
        grouped.get(aisle)!.push(item);
    }

    const aisles = Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));

    return (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-3 animate-in fade-in duration-300">
            <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-emerald-300 uppercase tracking-widest flex items-center gap-2">
                    🛒 Shopping List
                </h4>
                <span className="text-[11px] text-gray-400">
                    {items.length} items • {days}d × {crew} crew
                </span>
            </div>

            {aisles.map(([aisle, aisleItems]) => (
                <div key={aisle}>
                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.15em] mb-1.5 flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-emerald-500/30" />
                        {aisle}
                    </div>
                    <div className="space-y-0.5 ml-3.5">
                        {aisleItems.map((item, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs text-gray-300 py-0.5">
                                <span className="text-gray-500">□</span>
                                <span className="flex-1">{item.name}</span>
                                {item.amount > 0 && (
                                    <span className="text-gray-500 font-mono text-[11px]">
                                        {item.amount} {item.unit}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

// ── Provision Alert ────────────────────────────────────────────────────────

const ProvisionAlert: React.FC<{ provisions: ProvisionSummary }> = ({ provisions }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-2 animate-in fade-in duration-300">
            <button
                aria-label="Toggle Provision Details"
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between"
            >
                <div className="flex items-center gap-2">
                    <span className="text-amber-400 text-sm">⚠️</span>
                    <h4 className="text-xs font-bold text-amber-300 uppercase tracking-widest">Ship's Stores Check</h4>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-emerald-400">{provisions.fullyStocked} stocked</span>
                    <span className="text-amber-400">
                        {provisions.shortfalls} shortfall{provisions.shortfalls !== 1 ? 's' : ''}
                    </span>
                    <span className="text-gray-400">
                        {provisions.matched}/{provisions.totalIngredients} matched
                    </span>
                    <span className="text-gray-500">{expanded ? '▲' : '▼'}</span>
                </div>
            </button>

            {expanded && (
                <div className="space-y-1 mt-2 max-h-60 overflow-y-auto">
                    {provisions.items.map((item) => (
                        <div
                            key={item.id}
                            className={`flex items-center gap-2 text-xs py-1 px-2 rounded-lg ${
                                item.status === 'needed'
                                    ? 'bg-red-500/10 text-red-300'
                                    : 'bg-emerald-500/5 text-gray-300'
                            }`}
                        >
                            <span className="text-[10px]">{item.status === 'needed' ? '🔴' : '🟢'}</span>
                            <span className="flex-1 truncate">{item.ingredient_name}</span>
                            {item.status === 'needed' ? (
                                <span className="font-mono text-[11px] text-red-400">
                                    need {item.shortfall_qty} {item.unit}
                                </span>
                            ) : (
                                <span className="font-mono text-[11px] text-emerald-400/60">
                                    ✓ {item.on_hand_qty} {item.unit}
                                </span>
                            )}
                            {item.store_item_name && (
                                <span className="text-[10px] text-gray-500 truncate max-w-[80px]">
                                    → {item.store_item_name}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
