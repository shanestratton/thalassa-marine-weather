/**
 * GalleyCard — Collapsible "Passage Planning" card for the Chat screen.
 *
 * Minimised by default to keep chat clear. Expands to reveal:
 *   A) The Food Thing: Active meal, recipe info, scaling, Cook Now
 *   B) Galley Chat: Dedicated sub-thread for passage meal coordination
 *
 * Hard-wired to Ship's Stores: "Cook Now" triggers DELTA subtractions.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
    getMealsByStatus,
    startCooking,
    completeMeal,
    scheduleMeal,
    todayUTC,
    type MealPlan,
} from '../../services/MealPlanService';
import { getStoresAvailability } from '../../services/MealPlanService';
import { getShoppingList, type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { scaleIngredient } from '../../services/GalleyRecipeService';

interface GalleyCardProps {
    onOpenCookingMode?: (meal: MealPlan) => void;
}

export const GalleyCard: React.FC<GalleyCardProps> = ({ onOpenCookingMode }) => {
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<'food' | 'chat'>('food');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [galleyMessages, setGalleyMessages] = useState<{ id: string; text: string; sender: string; time: string }[]>(
        [],
    );
    const [galleyInput, setGalleyInput] = useState('');
    const [cookingMealId, setCookingMealId] = useState<string | null>(null);

    // Load active meals and shopping status
    useEffect(() => {
        if (!expanded) return;
        const reserved = getMealsByStatus('reserved');
        const cooking = getMealsByStatus('cooking');
        setActiveMeals([...cooking, ...reserved]);
        setShoppingSummary(getShoppingList());

        // Load cached galley messages
        try {
            const raw = localStorage.getItem('thalassa_galley_chat');
            if (raw) setGalleyMessages(JSON.parse(raw));
        } catch {
            /* ignore */
        }
    }, [expanded]);

    const handleToggle = useCallback(() => {
        setExpanded((v) => !v);
        triggerHaptic('light');
    }, []);

    const handleCookNow = useCallback(
        async (meal: MealPlan) => {
            setCookingMealId(meal.id);
            triggerHaptic('medium');

            if (onOpenCookingMode) {
                // Open full cooking mode if available
                onOpenCookingMode(meal);
            } else {
                // Quick cook: start + complete in one action
                await startCooking(meal.id);
                await completeMeal(meal.id);
            }
            setCookingMealId(null);

            // Refresh
            const reserved = getMealsByStatus('reserved');
            const cooking = getMealsByStatus('cooking');
            setActiveMeals([...cooking, ...reserved]);
        },
        [onOpenCookingMode],
    );

    const handleSendGalleyMsg = useCallback(() => {
        if (!galleyInput.trim()) return;
        const msg = {
            id: Date.now().toString(),
            text: galleyInput.trim(),
            sender: 'Skipper',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        const updated = [...galleyMessages, msg];
        setGalleyMessages(updated);
        setGalleyInput('');
        triggerHaptic('light');

        try {
            localStorage.setItem('thalassa_galley_chat', JSON.stringify(updated.slice(-50)));
        } catch {
            /* full */
        }
    }, [galleyInput, galleyMessages]);

    // Store availability for visual flags
    const storesAvail = expanded ? getStoresAvailability() : [];
    const reservedCount = storesAvail.filter((s) => s.reserved > 0).length;

    return (
        <div className="mx-4 mt-3 mb-2">
            {/* ── Minimised Bar ── */}
            <button
                onClick={handleToggle}
                className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all ${
                    expanded
                        ? 'bg-gradient-to-r from-amber-500/10 to-orange-500/10 border-amber-500/20'
                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                }`}
                aria-expanded={expanded}
                aria-label="Passage Planning"
            >
                <div className="p-2 rounded-xl bg-sky-500/10 flex-shrink-0">
                    <span className="text-base">🧭</span>
                </div>
                <div className="flex-1 text-left">
                    <p className="text-xs font-bold text-white">Passage Planning</p>
                    <p className="text-[10px] text-amber-400/70">
                        {activeMeals.length > 0
                            ? `${activeMeals.length} meal${activeMeals.length !== 1 ? 's' : ''} planned`
                            : 'No active meals'}
                        {reservedCount > 0 && ` · ${reservedCount} reserved`}
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

            {/* ── Expanded Content ── */}
            {expanded && (
                <div className="mt-2 rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden animate-in slide-in-from-top-2 duration-200">
                    {/* Tab switcher */}
                    <div className="flex border-b border-white/[0.06]">
                        <button
                            onClick={() => setActiveTab('food')}
                            className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                                activeTab === 'food'
                                    ? 'text-amber-400 border-b-2 border-amber-400'
                                    : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            🍽️ Food
                        </button>
                        <button
                            onClick={() => setActiveTab('chat')}
                            className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                                activeTab === 'chat'
                                    ? 'text-sky-400 border-b-2 border-sky-400'
                                    : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            💬 Galley Chat
                        </button>
                    </div>

                    {/* ── Tab A: Chef's Plate ── */}
                    {activeTab === 'food' && (
                        <div className="max-h-[420px] overflow-y-auto">
                            {activeMeals.length === 0 ? (
                                <QuickMealForm
                                    onScheduled={() => {
                                        const reserved = getMealsByStatus('reserved');
                                        const cooking = getMealsByStatus('cooking');
                                        setActiveMeals([...cooking, ...reserved]);
                                    }}
                                />
                            ) : (
                                activeMeals.map((meal) => {
                                    const baseServings = meal.servings_planned || 4;
                                    return (
                                        <ChefPlate
                                            key={meal.id}
                                            meal={meal}
                                            baseServings={baseServings}
                                            cooking={cookingMealId === meal.id}
                                            onCook={() => handleCookNow(meal)}
                                            shoppingSummary={shoppingSummary}
                                        />
                                    );
                                })
                            )}
                        </div>
                    )}

                    {/* ── Tab B: Galley Chat ── */}
                    {activeTab === 'chat' && (
                        <div className="flex flex-col max-h-[280px]">
                            {/* Messages */}
                            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[120px]">
                                {galleyMessages.length === 0 ? (
                                    <div className="text-center py-4">
                                        <span className="text-2xl">💬</span>
                                        <p className="text-[11px] text-gray-500 mt-1">
                                            Coordinate meal prep with the crew
                                        </p>
                                    </div>
                                ) : (
                                    galleyMessages.map((msg) => (
                                        <div key={msg.id} className="flex items-start gap-2">
                                            <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center text-[10px] text-amber-400 font-bold flex-shrink-0">
                                                {msg.sender[0]}
                                            </div>
                                            <div className="flex-1">
                                                <div className="flex items-baseline gap-2">
                                                    <span className="text-[11px] font-bold text-white">
                                                        {msg.sender}
                                                    </span>
                                                    <span className="text-[9px] text-gray-600">{msg.time}</span>
                                                </div>
                                                <p className="text-xs text-gray-300 leading-relaxed">{msg.text}</p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            {/* Compose */}
                            <div className="border-t border-white/[0.06] p-2 flex gap-2">
                                <input
                                    value={galleyInput}
                                    onChange={(e) => setGalleyInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSendGalleyMsg()}
                                    placeholder="Message the galley crew…"
                                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                                />
                                <button
                                    onClick={handleSendGalleyMsg}
                                    disabled={!galleyInput.trim()}
                                    className="px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400 font-bold disabled:opacity-30 hover:bg-amber-500/20 transition-colors"
                                >
                                    Send
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ── Quick Meal Planning Form ──
const SLOT_OPTIONS: { value: 'breakfast' | 'lunch' | 'dinner'; label: string; emoji: string }[] = [
    { value: 'breakfast', label: 'Breakfast', emoji: '🌅' },
    { value: 'lunch', label: 'Lunch', emoji: '☀️' },
    { value: 'dinner', label: 'Dinner', emoji: '🌙' },
];

const QUICK_MEALS = [
    '🍳 Eggs & Toast',
    '🥗 Fresh Salad',
    '🍝 Pasta Marinara',
    '🐟 Grilled Fish',
    '🍛 Curry & Rice',
    '🌮 Tacos',
    '🍔 Burgers',
    '🥘 Stew',
];

const QuickMealForm: React.FC<{ onScheduled: () => void }> = ({ onScheduled }) => {
    const [mealName, setMealName] = useState('');
    const [slot, setSlot] = useState<'breakfast' | 'lunch' | 'dinner'>('dinner');
    const [servings, setServings] = useState(2);
    const [date, setDate] = useState(todayUTC());
    const [scheduling, setScheduling] = useState(false);

    const handleSchedule = async () => {
        if (!mealName.trim()) return;
        setScheduling(true);
        try {
            const galleyMeal = {
                id: Date.now(),
                title: mealName.trim(),
                readyInMinutes: 45,
                servings,
                image: '',
                sourceUrl: '',
                ingredients: [],
            };
            await scheduleMeal(galleyMeal, date, slot, null, servings);
            triggerHaptic('medium');
            onScheduled();
        } catch {
            /* handled by service */
        }
        setScheduling(false);
    };

    return (
        <div className="p-4 space-y-4">
            <div className="text-center pb-1">
                <span className="text-3xl">🍽️</span>
                <p className="text-sm font-bold text-white mt-2">Plan a Meal</p>
                <p className="text-[10px] text-gray-500">What's on the menu?</p>
            </div>

            {/* Quick pick buttons */}
            <div className="flex flex-wrap gap-1.5 justify-center">
                {QUICK_MEALS.map((name) => (
                    <button
                        key={name}
                        onClick={() => setMealName(name)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                            mealName === name
                                ? 'bg-amber-500/20 border-amber-500/30 text-amber-300 border'
                                : 'bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:bg-white/[0.08]'
                        }`}
                    >
                        {name}
                    </button>
                ))}
            </div>

            {/* Custom name */}
            <input
                value={mealName}
                onChange={(e) => setMealName(e.target.value)}
                placeholder="Or type a meal name…"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
            />

            {/* Slot picker */}
            <div className="flex gap-2">
                {SLOT_OPTIONS.map((s) => (
                    <button
                        key={s.value}
                        onClick={() => setSlot(s.value)}
                        className={`flex-1 py-2 rounded-xl text-[11px] font-bold transition-all ${
                            slot === s.value
                                ? 'bg-amber-500/15 border-amber-500/25 text-amber-300 border'
                                : 'bg-white/[0.03] border border-white/[0.06] text-gray-500 hover:text-gray-300'
                        }`}
                    >
                        {s.emoji} {s.label}
                    </button>
                ))}
            </div>

            {/* Date + servings row */}
            <div className="flex gap-2">
                <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500/30 [color-scheme:dark]"
                />
                <div className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3">
                    <button
                        onClick={() => setServings((s) => Math.max(1, s - 1))}
                        className="text-gray-400 hover:text-white text-lg leading-none"
                    >
                        −
                    </button>
                    <span className="text-sm font-bold text-amber-400 w-5 text-center tabular-nums">{servings}</span>
                    <button
                        onClick={() => setServings((s) => Math.min(20, s + 1))}
                        className="text-gray-400 hover:text-white text-lg leading-none"
                    >
                        +
                    </button>
                    <span className="text-[10px] text-gray-500">👥</span>
                </div>
            </div>

            {/* Schedule button */}
            <button
                onClick={handleSchedule}
                disabled={!mealName.trim() || scheduling}
                className="w-full py-3 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
            >
                {scheduling ? '⏳ Scheduling…' : '📋 Schedule This Meal'}
            </button>
        </div>
    );
};

// ── Ingredient category emoji mapping ──
const AISLE_EMOJI: Record<string, string> = {
    meat: '🥩',
    produce: '🥬',
    dairy: '🧈',
    spices: '🧂',
    bakery: '🍞',
    'canned goods': '🥫',
    frozen: '🧊',
    seafood: '🐟',
    condiments: '🫙',
    beverages: '🍺',
    baking: '🧁',
};

function getIngredientEmoji(aisle: string): string {
    const lower = aisle.toLowerCase();
    for (const [key, emoji] of Object.entries(AISLE_EMOJI)) {
        if (lower.includes(key)) return emoji;
    }
    return '📦';
}

// ── Location mapping from aisle ──
function getStorageLocation(aisle: string): string {
    const lower = aisle.toLowerCase();
    if (lower.includes('meat') || lower.includes('seafood') || lower.includes('frozen')) return 'Freezer 1';
    if (lower.includes('dairy') || lower.includes('produce')) return 'Fridge';
    if (lower.includes('spice') || lower.includes('baking') || lower.includes('condiment')) return 'Pantry';
    if (lower.includes('canned') || lower.includes('beverage')) return 'Dry Locker 2';
    return 'Galley';
}

/** The "Chef's Plate" — premium recipe card */
const ChefPlate: React.FC<{
    meal: MealPlan;
    baseServings: number;
    cooking: boolean;
    onCook: () => void;
    shoppingSummary: ShoppingListSummary | null;
}> = ({ meal, baseServings, cooking, onCook, shoppingSummary }) => {
    const [crewCount, setCrewCount] = useState(baseServings);
    const ratio = crewCount / baseServings;

    // Scale ingredients in real-time
    const scaledIngredients = meal.ingredients.map((ing) => ({
        ...ing,
        scaledAmount: Math.round(scaleIngredient(ing.amount, ing.scalable, baseServings, crewCount) * 10) / 10,
    }));

    // Stores status
    const shortfallCount = shoppingSummary?.remaining || 0;
    const storesReady = shortfallCount === 0;

    // Prep time estimate (rough: 30 min base + 15 min per 2 extra serves)
    const prepHours =
        meal.title.toLowerCase().includes('smoked') || meal.title.toLowerCase().includes('brisket')
            ? 12
            : meal.title.toLowerCase().includes('roast')
              ? 4
              : 1;

    const shareText = [
        `🍽️ ${meal.title}`,
        `📅 ${meal.planned_date} · ${meal.meal_slot}`,
        `👥 ${crewCount} serves`,
        '',
        '📦 Ingredients:',
        ...scaledIngredients.map((i) => `${getIngredientEmoji(i.aisle)} ${i.scaledAmount} ${i.unit} ${i.name}`),
        '',
        `⏱️ Prep: ${prepHours}${prepHours >= 2 ? ' Hours' : ' Hour'}`,
        `🔧 Stores: ${storesReady ? 'READY' : `SHORTFALL (${shortfallCount} ITEMS)`}`,
        '',
        'via SupaSpoon™',
    ].join('\n');

    return (
        <div className="space-y-0">
            {/* 1. Hero Shot */}
            <div className="relative h-40 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-900/80 via-orange-800/60 to-red-900/80" />
                <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjAzKSIvPjwvc3ZnPg==')] opacity-50" />
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
                    <p className="text-lg font-black text-white leading-tight">{meal.title}</p>
                    <p className="text-[11px] text-amber-300/80 mt-0.5">
                        {meal.planned_date} · {meal.meal_slot}
                    </p>
                </div>
                {/* SupaSpoon watermark */}
                <div className="absolute top-3 right-3 px-2 py-1 rounded-md bg-black/40 backdrop-blur-sm">
                    <span className="text-[9px] font-bold text-white/50 tracking-widest uppercase">SupaSpoon™</span>
                </div>
                {/* Status badge */}
                <div className="absolute top-3 left-3">
                    <span
                        className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase backdrop-blur-sm ${
                            meal.status === 'cooking'
                                ? 'bg-orange-500/30 text-orange-300 border border-orange-500/30'
                                : 'bg-amber-500/20 text-amber-300 border border-amber-500/20'
                        }`}
                    >
                        {meal.status}
                    </span>
                </div>
            </div>

            {/* 2. Status Bar */}
            <div className="flex">
                <div className="flex-1 p-3 bg-slate-900 border-b border-r border-white/[0.06] flex items-center gap-2">
                    <span className="text-base">⏱️</span>
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Preparation</p>
                        <p className="text-sm font-black text-white">
                            {prepHours} {prepHours >= 2 ? 'Hours' : 'Hour'}
                        </p>
                    </div>
                </div>
                <div
                    className={`flex-1 p-3 border-b border-white/[0.06] flex items-center gap-2 ${
                        storesReady ? 'bg-emerald-950/30' : 'bg-red-950/30'
                    }`}
                >
                    <span className="text-base">{storesReady ? '✅' : '⚠️'}</span>
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Stores</p>
                        <p className={`text-sm font-black ${storesReady ? 'text-emerald-400' : 'text-red-400'}`}>
                            {storesReady ? 'READY' : `SHORTFALL (${shortfallCount})`}
                        </p>
                    </div>
                </div>
            </div>

            {/* 3. Crew Slider */}
            <div className="p-4 bg-slate-950 border-b border-white/[0.06]">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Crew Count</p>
                        <p className="text-xs text-gray-400 mt-0.5">Ingredients scale live</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.max(1, c - 1));
                                triggerHaptic('light');
                            }}
                            className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-colors active:scale-90"
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
                        <span className="text-2xl font-black text-amber-400 w-8 text-center tabular-nums">
                            {crewCount}
                        </span>
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.min(20, c + 1));
                                triggerHaptic('light');
                            }}
                            className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-colors active:scale-90"
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
                    <p className="text-[10px] text-amber-400/60 mt-2">
                        Scaled from {baseServings} → {crewCount} serves (×{ratio.toFixed(1)})
                    </p>
                )}
            </div>

            {/* 4. Ingredient Toggles */}
            <div className="p-4 space-y-1.5">
                {scaledIngredients.map((ing, i) => (
                    <div
                        key={i}
                        className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-colors"
                    >
                        <span className="text-base w-6 text-center flex-shrink-0">{getIngredientEmoji(ing.aisle)}</span>
                        <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-white truncate">
                                {ing.scaledAmount} {ing.unit} {ing.name}
                            </p>
                            <p className="text-[10px] text-gray-500">📍 {getStorageLocation(ing.aisle)}</p>
                        </div>
                        {ing.scalable && crewCount !== baseServings && (
                            <span className="text-[9px] text-amber-400/50 flex-shrink-0">was {ing.amount}</span>
                        )}
                    </div>
                ))}
            </div>

            {/* Actions: Cook Now + Share */}
            <div className="px-4 pb-4 flex gap-2">
                <button
                    onClick={onCook}
                    disabled={cooking}
                    className="flex-1 py-3 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
                >
                    {cooking ? '⏳ Subtracting from Stores…' : '🔥 Cook Now'}
                </button>
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
