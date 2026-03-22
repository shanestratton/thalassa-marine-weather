/**
 * GalleyCard — Collapsible "Galley & Provisions" card for the Chat screen.
 *
 * Minimised by default to keep chat clear. Expands to reveal:
 *   A) The Food Thing: Active meal, recipe info, scaling, Cook Now
 *   B) Galley Chat: Dedicated sub-thread for passage meal coordination
 *
 * Hard-wired to Ship's Stores: "Cook Now" triggers DELTA subtractions.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { getMealsByStatus, startCooking, completeMeal, type MealPlan } from '../../services/MealPlanService';
import { getStoresAvailability } from '../../services/MealPlanService';
import { getShoppingList, type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';

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
                aria-label="Galley & Provisions"
            >
                <div className="p-2 rounded-xl bg-amber-500/10 flex-shrink-0">
                    <span className="text-base">🍳</span>
                </div>
                <div className="flex-1 text-left">
                    <p className="text-xs font-bold text-white">Galley &amp; Provisions</p>
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

                    {/* ── Tab A: Food ── */}
                    {activeTab === 'food' && (
                        <div className="p-4 space-y-3 max-h-[280px] overflow-y-auto">
                            {activeMeals.length === 0 ? (
                                <div className="text-center py-6">
                                    <span className="text-3xl">🥘</span>
                                    <p className="text-xs text-gray-400 mt-2">
                                        No meals scheduled. Use the Meal Planner in Ship&apos;s Office to add one.
                                    </p>
                                </div>
                            ) : (
                                activeMeals.map((meal) => (
                                    <div
                                        key={meal.id}
                                        className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-2"
                                    >
                                        <div className="flex items-start justify-between">
                                            <div>
                                                <p className="text-sm font-bold text-white">{meal.title}</p>
                                                <p className="text-[10px] text-gray-400">
                                                    {meal.planned_date} · {meal.meal_slot} · {meal.servings_planned}{' '}
                                                    serves
                                                </p>
                                            </div>
                                            <span
                                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                                                    meal.status === 'cooking'
                                                        ? 'bg-orange-500/20 text-orange-400'
                                                        : 'bg-amber-500/10 text-amber-400'
                                                }`}
                                            >
                                                {meal.status}
                                            </span>
                                        </div>

                                        {/* Ingredient pills */}
                                        {meal.ingredients.length > 0 && (
                                            <div className="flex flex-wrap gap-1">
                                                {meal.ingredients.slice(0, 6).map((ing, i) => (
                                                    <span
                                                        key={i}
                                                        className="px-2 py-0.5 rounded-full text-[10px] bg-white/[0.04] text-gray-400 border border-white/[0.06]"
                                                    >
                                                        {ing.amount} {ing.unit} {ing.name}
                                                    </span>
                                                ))}
                                                {meal.ingredients.length > 6 && (
                                                    <span className="text-[10px] text-gray-500">
                                                        +{meal.ingredients.length - 6} more
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {/* Cook Now + Share buttons */}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleCookNow(meal)}
                                                disabled={cookingMealId === meal.id}
                                                className="flex-1 py-2.5 bg-gradient-to-r from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold uppercase tracking-widest text-amber-300 hover:from-amber-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
                                            >
                                                {cookingMealId === meal.id ? '⏳ Subtracting…' : '🔥 Cook Now'}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const text = [
                                                        `🍽️ ${meal.title}`,
                                                        `📅 ${meal.planned_date} · ${meal.meal_slot}`,
                                                        `👥 ${meal.servings_planned} serves`,
                                                        meal.ingredients.length > 0
                                                            ? `📦 ${meal.ingredients.map((i) => `${i.amount} ${i.unit} ${i.name}`).join(', ')}`
                                                            : '',
                                                    ]
                                                        .filter(Boolean)
                                                        .join('\n');
                                                    if (navigator.share) {
                                                        navigator.share({ title: meal.title, text }).catch(() => {});
                                                    } else {
                                                        navigator.clipboard
                                                            .writeText(text)
                                                            .then(() => triggerHaptic('light'));
                                                    }
                                                }}
                                                className="w-10 flex-shrink-0 flex items-center justify-center border border-white/[0.08] bg-white/[0.03] rounded-xl text-gray-400 hover:bg-white/[0.06] hover:text-white transition-colors"
                                                aria-label="Share meal"
                                            >
                                                <svg
                                                    className="w-4 h-4"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                                    />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}

                            {/* Shopping summary */}
                            {shoppingSummary && shoppingSummary.remaining > 0 && (
                                <div className="p-3 rounded-xl bg-red-500/[0.04] border border-red-500/[0.08] flex items-center gap-3">
                                    <span className="text-lg">🛒</span>
                                    <div className="flex-1">
                                        <p className="text-xs font-bold text-red-300">
                                            {shoppingSummary.remaining} items still needed
                                        </p>
                                        <p className="text-[10px] text-gray-500">
                                            {shoppingSummary.purchased}/{shoppingSummary.total} purchased
                                        </p>
                                    </div>
                                </div>
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
