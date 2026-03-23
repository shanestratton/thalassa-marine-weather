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
import { scaleIngredient, getRecipeImageUrl } from '../../services/GalleyRecipeService';

import { type PassageStatus } from '../../services/PassagePlanService';

interface GalleyCardProps {
    onOpenCookingMode?: (meal: MealPlan) => void;
    /** Passage permissions — if omitted, all child cards are visible (owner mode) */
    passageStatus?: PassageStatus;
}

export const GalleyCard: React.FC<GalleyCardProps> = ({ onOpenCookingMode, passageStatus }) => {
    // Default: owner sees everything
    const perms = passageStatus ?? {
        visible: true,
        isOwner: true,
        canViewMeals: true,
        canViewChat: true,
        canViewRoute: true,
        canViewChecklist: true,
    };
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<'' | 'food' | 'chat' | 'route' | 'checklist'>('food');
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
                        ? 'bg-gradient-to-r from-sky-500/10 to-indigo-500/10 border-sky-500/20'
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
                    <p className="text-[10px] text-sky-400/70">
                        {activeMeals.length > 0
                            ? `${activeMeals.length} meal${activeMeals.length !== 1 ? 's' : ''} planned`
                            : 'Meals · Chat · Route · Checklist'}
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

            {/* ── Expanded Content: 4 Child Cards ── */}
            {expanded && (
                <div className="mt-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
                    {/* ── 1. Meal Planner ── */}
                    {perms.canViewMeals && (
                        <ChildCard
                            icon="🍽️"
                            title="Meal Planner"
                            subtitle={
                                activeMeals.length > 0
                                    ? `${activeMeals.length} meal${activeMeals.length !== 1 ? 's' : ''} planned`
                                    : 'No active meals'
                            }
                            color="amber"
                            defaultOpen={activeTab === 'food'}
                            onToggle={() => setActiveTab(activeTab === 'food' ? '' : 'food')}
                            isOpen={activeTab === 'food'}
                        >
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
                        </ChildCard>
                    )}

                    {/* ── 2. Group Chat ── */}
                    {perms.canViewChat && (
                        <ChildCard
                            icon="💬"
                            title="Group Chat"
                            subtitle={
                                galleyMessages.length > 0
                                    ? `${galleyMessages.length} message${galleyMessages.length !== 1 ? 's' : ''}`
                                    : 'Coordinate with crew'
                            }
                            color="sky"
                            defaultOpen={false}
                            onToggle={() => setActiveTab(activeTab === 'chat' ? '' : 'chat')}
                            isOpen={activeTab === 'chat'}
                        >
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
                                                <div className="w-6 h-6 rounded-full bg-sky-500/20 flex items-center justify-center text-[10px] text-sky-400 font-bold flex-shrink-0">
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
                                        placeholder="Message the crew…"
                                        className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-sky-500/30"
                                    />
                                    <button
                                        onClick={handleSendGalleyMsg}
                                        disabled={!galleyInput.trim()}
                                        className="px-3 py-2 bg-sky-500/10 border border-sky-500/20 rounded-lg text-xs text-sky-400 font-bold disabled:opacity-30 hover:bg-sky-500/20 transition-colors"
                                    >
                                        Send
                                    </button>
                                </div>
                            </div>
                        </ChildCard>
                    )}

                    {/* ── 3. Passage Route ── */}
                    {perms.canViewRoute && (
                        <ChildCard
                            icon="🗺️"
                            title="Passage Route"
                            subtitle="Plan your route"
                            color="emerald"
                            defaultOpen={false}
                            onToggle={() => setActiveTab(activeTab === 'route' ? '' : 'route')}
                            isOpen={activeTab === 'route'}
                        >
                            <div className="p-4 text-center">
                                <span className="text-3xl">🗺️</span>
                                <p className="text-sm font-bold text-white mt-2">Passage Route</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Set waypoints, plan your passage, and view weather routing
                                </p>
                                <div className="mt-3 px-4">
                                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-base">📍</span>
                                        <div className="flex-1 text-left">
                                            <p className="text-[11px] text-gray-400">
                                                Use the Route Planner from the main menu to set your passage route. Your
                                                active route will appear here.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </ChildCard>
                    )}

                    {/* ── 4. Checklist ── */}
                    {perms.canViewChecklist && (
                        <ChildCard
                            icon="✅"
                            title="Checklist"
                            subtitle="Pre-departure checks"
                            color="violet"
                            defaultOpen={false}
                            onToggle={() => setActiveTab(activeTab === 'checklist' ? '' : 'checklist')}
                            isOpen={activeTab === 'checklist'}
                        >
                            <div className="p-4 text-center">
                                <span className="text-3xl">✅</span>
                                <p className="text-sm font-bold text-white mt-2">Pre-Departure Checklist</p>
                                <p className="text-[11px] text-gray-500 mt-1">
                                    Run through your safety and departure checks before casting off
                                </p>
                                <div className="mt-3 px-4">
                                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-base">📋</span>
                                        <div className="flex-1 text-left">
                                            <p className="text-[11px] text-gray-400">
                                                Manage your checklists from the Vessel Hub. Your active checklist will
                                                appear here for quick access.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </ChildCard>
                    )}
                </div>
            )}
        </div>
    );
};

// ── Collapsible Child Card ──
const COLOR_MAP: Record<string, { bg: string; border: string; text: string; iconBg: string }> = {
    amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400', iconBg: 'bg-amber-500/15' },
    sky: { bg: 'bg-sky-500/10', border: 'border-sky-500/20', text: 'text-sky-400', iconBg: 'bg-sky-500/15' },
    emerald: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
        text: 'text-emerald-400',
        iconBg: 'bg-emerald-500/15',
    },
    violet: {
        bg: 'bg-violet-500/10',
        border: 'border-violet-500/20',
        text: 'text-violet-400',
        iconBg: 'bg-violet-500/15',
    },
};

const ChildCard: React.FC<{
    icon: string;
    title: string;
    subtitle: string;
    color: string;
    isOpen: boolean;
    onToggle: () => void;
    defaultOpen?: boolean;
    children: React.ReactNode;
}> = ({ icon, title, subtitle, color, isOpen, onToggle, children }) => {
    const c = COLOR_MAP[color] || COLOR_MAP.amber;
    return (
        <div
            className={`rounded-2xl border overflow-hidden transition-all ${isOpen ? c.border + ' ' + c.bg : 'border-white/[0.06] bg-white/[0.02]'}`}
        >
            <button onClick={onToggle} className="w-full flex items-center gap-3 p-3 text-left" aria-expanded={isOpen}>
                <div className={`p-1.5 rounded-lg ${c.iconBg} flex-shrink-0`}>
                    <span className="text-sm">{icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-white">{title}</p>
                    <p className={`text-[10px] ${c.text} opacity-70`}>{subtitle}</p>
                </div>
                <svg
                    className={`w-3.5 h-3.5 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
            </button>
            {isOpen && <div className="border-t border-white/[0.06]">{children}</div>}
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

/** The "Chef's Plate" — Phase 6.1 Visual-First recipe card */
const ChefPlate: React.FC<{
    meal: MealPlan;
    baseServings: number;
    cooking: boolean;
    onCook: () => void;
    shoppingSummary: ShoppingListSummary | null;
}> = ({ meal, baseServings, cooking, onCook, shoppingSummary }) => {
    const [crewCount, setCrewCount] = useState(baseServings);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [prepStarted, setPrepStarted] = useState(meal.status === 'cooking');
    const [addedItems, setAddedItems] = useState<Set<string>>(new Set());
    const ratio = crewCount / baseServings;

    // Scale ingredients in real-time
    const scaledIngredients = meal.ingredients.map((ing) => ({
        ...ing,
        scaledAmount: Math.round(scaleIngredient(ing.amount, ing.scalable, baseServings, crewCount) * 10) / 10,
    }));

    // Get stores availability for per-ingredient shortfall
    const storesAvail = getStoresAvailability();
    const storesMap = new Map(storesAvail.map((s) => [s.item_name.toLowerCase(), s]));

    // Shortfall count
    const shortfallIngredients = scaledIngredients.filter((ing) => {
        const store = storesMap.get(ing.name.toLowerCase());
        return !store || store.available < ing.scaledAmount;
    });

    // Recipe image — cache-first
    const recipeImageUrl = getRecipeImageUrl(
        meal.spoonacular_id,
        meal.spoonacular_id ? `https://img.spoonacular.com/recipes/${meal.spoonacular_id}-556x370.jpg` : '',
    );

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
        'via SupaSpoon™',
    ].join('\n');

    // ── Start Prep broadcast ──
    const handleStartPrep = async () => {
        setPrepStarted(true);
        triggerHaptic('heavy');

        // Start cooking lifecycle
        await startCooking(meal.id);

        // Broadcast to galley chat
        const broadcastMsg = {
            id: Date.now().toString(),
            text: `🔥 Started preparing: ${meal.title}!\n👥 ${crewCount} serves · ⏱️ ${readyInLabel}`,
            sender: '⚓ Galley Bot',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };

        try {
            const existingRaw = localStorage.getItem('thalassa_galley_chat');
            const existing = existingRaw ? JSON.parse(existingRaw) : [];
            const updated = [...existing, broadcastMsg].slice(-50);
            localStorage.setItem('thalassa_galley_chat', JSON.stringify(updated));
        } catch {
            /* full */
        }

        // Dispatch event so galley chat tab updates
        window.dispatchEvent(new CustomEvent('thalassa:galley-prep', { detail: { meal: meal.title, crewCount } }));
    };

    // ── Add shortfall to provision list ──
    const handleAddToList = async (ing: (typeof scaledIngredients)[0]) => {
        const { addShortfallItem } = await import('../../services/MealPlanService');
        const store = storesMap.get(ing.name.toLowerCase());
        const shortfall = store ? Math.max(0, ing.scaledAmount - store.available) : ing.scaledAmount;
        const success = await addShortfallItem(ing.name, shortfall, ing.unit, meal.title, meal.voyage_id);
        if (success) {
            setAddedItems((prev) => new Set(prev).add(ing.name.toLowerCase()));
            triggerHaptic('medium');
        }
    };

    return (
        <div className="rounded-2xl overflow-hidden border border-white/[0.06] bg-slate-950">
            {/* ═══════ 1. HERO IMAGE (top 40%) ═══════ */}
            <div className="relative h-52 overflow-hidden">
                {/* Recipe photo — edge-to-edge */}
                {recipeImageUrl && (
                    <img
                        src={recipeImageUrl}
                        alt={meal.title}
                        loading="lazy"
                        onLoad={() => setImgLoaded(true)}
                        className={`absolute inset-0 w-full h-full object-cover transition-all duration-700 ${
                            imgLoaded ? 'opacity-100 scale-100 blur-0' : 'opacity-0 scale-105 blur-sm'
                        }`}
                    />
                )}
                {/* Placeholder gradient while loading */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br from-amber-900/80 via-orange-800/60 to-red-900/80 transition-opacity duration-700 ${
                        imgLoaded ? 'opacity-0' : 'opacity-100'
                    }`}
                />

                {/* Bottom shadow gradient for text legibility */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

                {/* Title + Ready In overlay */}
                <div className="absolute bottom-0 left-0 right-0 p-4">
                    <p className="text-lg font-black text-white leading-tight drop-shadow-lg">{meal.title}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                        <span className="px-2 py-0.5 rounded-full bg-white/15 backdrop-blur-sm text-[10px] font-bold text-amber-200 border border-white/10">
                            ⏱️ {readyInLabel}
                        </span>
                        <span className="text-[11px] text-white/60">
                            {meal.planned_date} · {meal.meal_slot}
                        </span>
                    </div>
                </div>

                {/* SupaSpoon watermark */}
                <div className="absolute top-3 right-3 px-2 py-1 rounded-md bg-black/40 backdrop-blur-sm">
                    <span className="text-[9px] font-bold text-white/40 tracking-widest uppercase">SupaSpoon™</span>
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

            {/* ═══════ 2. CREW SCALER (right below hero) ═══════ */}
            <div className="p-4 bg-slate-950/80 border-b border-white/[0.06]">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Crew Count</p>
                        <p className="text-[10px] text-gray-600 mt-0.5">Ingredients scale live</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.max(1, c - 1));
                                triggerHaptic('light');
                            }}
                            className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-all active:scale-90"
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
                        >
                            {crewCount}
                        </span>
                        <button
                            onClick={() => {
                                setCrewCount((c) => Math.min(20, c + 1));
                                triggerHaptic('light');
                            }}
                            className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] transition-all active:scale-90"
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
                        shortfallIngredients.length === 0 ? 'bg-emerald-950/30' : 'bg-red-950/30'
                    }`}
                >
                    <span className="text-base">{shortfallIngredients.length === 0 ? '✅' : '⚠️'}</span>
                    <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest">Stores</p>
                        <p
                            className={`text-sm font-black ${shortfallIngredients.length === 0 ? 'text-emerald-400' : 'text-red-400'}`}
                        >
                            {shortfallIngredients.length === 0 ? 'READY' : `SHORTFALL (${shortfallIngredients.length})`}
                        </p>
                    </div>
                </div>
            </div>

            {/* ═══════ 4. INGREDIENT LIST with per-item shortfall ═══════ */}
            <div className="p-4 space-y-1.5">
                {scaledIngredients.map((ing, i) => {
                    const store = storesMap.get(ing.name.toLowerCase());
                    const available = store?.available ?? 0;
                    const hasEnough = available >= ing.scaledAmount;
                    const isLow = store && !hasEnough;
                    const isMissing = !store;
                    const alreadyAdded = addedItems.has(ing.name.toLowerCase());

                    return (
                        <div
                            key={i}
                            className={`flex items-center gap-3 p-2.5 rounded-xl border transition-colors ${
                                hasEnough
                                    ? 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.04]'
                                    : 'bg-red-500/[0.04] border-red-500/10'
                            }`}
                        >
                            {/* Status indicator */}
                            <span className="text-base w-6 text-center flex-shrink-0">
                                {hasEnough ? '✅' : isLow ? '⚠️' : '🔴'}
                            </span>

                            {/* Ingredient info */}
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-white truncate">
                                    {ing.scaledAmount} {ing.unit} {ing.name}
                                </p>
                                <p className="text-[10px] text-gray-500">
                                    {hasEnough
                                        ? `📍 ${getStorageLocation(ing.aisle)} · ${available} on hand`
                                        : isMissing
                                          ? 'Not in stores'
                                          : `Only ${available} ${ing.unit} on hand`}
                                </p>
                            </div>

                            {/* Scale indicator */}
                            {ing.scalable && crewCount !== baseServings && (
                                <span className="text-[9px] text-amber-400/50 flex-shrink-0 hidden sm:block">
                                    was {ing.amount}
                                </span>
                            )}

                            {/* ADD TO LIST button for shortfalls */}
                            {!hasEnough && !alreadyAdded && (
                                <button
                                    onClick={() => handleAddToList(ing)}
                                    className="flex-shrink-0 px-2 py-1 rounded-lg bg-red-500/15 border border-red-500/25 text-[9px] font-bold text-red-300 uppercase tracking-wider hover:bg-red-500/25 transition-all active:scale-95"
                                >
                                    + List
                                </button>
                            )}
                            {alreadyAdded && <span className="text-[9px] text-emerald-400 flex-shrink-0">✓ Added</span>}
                        </div>
                    );
                })}
            </div>

            {/* ═══════ 5. ACTIONS: Start Prep + Share ═══════ */}
            <div className="px-4 pb-4 flex gap-2">
                {!prepStarted ? (
                    <button
                        onClick={handleStartPrep}
                        disabled={cooking}
                        className="flex-1 py-3.5 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-40 shadow-lg shadow-amber-500/5"
                    >
                        {cooking ? '⏳ Starting…' : '🔥 Start Prep'}
                    </button>
                ) : (
                    <button
                        onClick={onCook}
                        disabled={cooking}
                        className="flex-1 py-3.5 bg-gradient-to-r from-emerald-500/15 to-teal-500/15 border border-emerald-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-emerald-300 hover:from-emerald-500/25 hover:to-teal-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
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
