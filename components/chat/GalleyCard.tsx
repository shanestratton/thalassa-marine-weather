import React, { useState, useCallback, useEffect } from 'react';
import {
    getMealsByStatus,
    completeMeal,
    startCooking,
    calculateMealDays,
    getCrewCount,
    type MealPlan,
    type MealDayInfo,
} from '../../services/MealPlanService';
import { getShoppingList, markPurchased, type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { getCachedActiveVoyage, type Voyage } from '../../services/VoyageService';
import { toPurchasable } from '../../services/PurchaseUnits';
import { type PassageStatus } from '../../services/PassagePlanService';
import { ChildCard } from './ChildCard';
import { MealCalendar } from './MealCalendar';
import { ZONE_EMOJI } from './galleyTokens';
import { useCrewCount } from '../../contexts/CrewCountContext';


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
    const [activeTab, setActiveTab] = useState<'' | 'food' | 'chat' | 'route' | 'checklist' | 'shopping'>('food');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [galleyMessages, setGalleyMessages] = useState<{ id: string; text: string; sender: string; time: string }[]>(
        [],
    );
    const [galleyInput, setGalleyInput] = useState('');
    const [cookingMealId, setCookingMealId] = useState<string | null>(null);

    // ── Voyage context for meal calendar ──
    const [voyage, setVoyage] = useState<Voyage | null>(null);
    const [mealDays, setMealDays] = useState<MealDayInfo | null>(null);
    const { crewCount, setCrewCount: handleSetCrewCount } = useCrewCount();

    // Load voyage data and compute calendar dimensions
    useEffect(() => {
        if (!expanded) return;
        const v = getCachedActiveVoyage();
        setVoyage(v);
        if (v?.departure_time && v?.eta) {
            setMealDays(calculateMealDays(v.departure_time, v.eta));
        }
        // If no stored crew count, try loading from Supabase
        if (!localStorage.getItem('thalassa_crew_count') && v?.id) {
            getCrewCount(v.id).then((count) => {
                handleSetCrewCount(count);
            }).catch(() => { /* supabase unavailable */ });
        }
    }, [expanded, handleSetCrewCount]);

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
        } catch (e) {
            console.warn('Failed to load galley chat cache:', e);
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
                onOpenCookingMode(meal);
            } else {
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
        } catch (e) {
            console.warn('Failed to save galley chat:', e);
        }
    }, [galleyInput, galleyMessages]);

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
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/10 border border-sky-500/20 flex items-center justify-center text-xl flex-shrink-0">
                    ⛵
                </div>
                <div className="flex-1 text-left">
                    <p className="text-xs font-bold text-white">Passage Planning</p>
                    <p className="text-[10px] text-sky-400/70">
                        Meals · Chat · Route · Checklist
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

            {/* ── Expanded Content: Child Cards ── */}
            {expanded && (
                <div className="mt-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
                    {/* ── 1. Meal Planner ── */}
                    {perms.canViewMeals && (
                        <ChildCard
                            icon="🍽️"
                            title="Meal Planner"
                            subtitle={
                                mealDays
                                    ? `${mealDays.totalDays} days · ${crewCount} crew`
                                    : activeMeals.length > 0
                                      ? `${activeMeals.length} meal${activeMeals.length !== 1 ? 's' : ''} planned`
                                      : 'Set voyage dates to plan'
                            }
                            color="amber"
                            defaultOpen={activeTab === 'food'}
                            onToggle={() => setActiveTab(activeTab === 'food' ? '' : 'food')}
                            isOpen={activeTab === 'food'}
                        >
                            <div>
                                <MealCalendar
                                    mealDays={mealDays}
                                    crewCount={crewCount}
                                    voyageId={voyage?.id || null}
                                    voyageName={voyage?.voyage_name || null}
                                    activeMeals={activeMeals}
                                    onMealsChanged={() => {
                                        const reserved = getMealsByStatus('reserved');
                                        const cooking = getMealsByStatus('cooking');
                                        setActiveMeals([...cooking, ...reserved]);
                                    }}
                                    onOpenCookingMode={onOpenCookingMode}
                                    cookingMealId={cookingMealId}
                                    onCookNow={handleCookNow}
                                    shoppingSummary={shoppingSummary}
                                    onCrewCountChange={handleSetCrewCount}
                                    onShoppingChanged={() => setShoppingSummary(getShoppingList())}
                                />
                            </div>
                        </ChildCard>
                    )}

                    {/* ── 1b. Shopping List (only when items to buy) ── */}
                    {shoppingSummary && shoppingSummary.remaining > 0 && (
                        <ChildCard
                            icon="🛒"
                            title="Shopping List"
                            subtitle={`${shoppingSummary.remaining} item${shoppingSummary.remaining !== 1 ? 's' : ''} to buy`}
                            color="emerald"
                            defaultOpen={false}
                            onToggle={() => setActiveTab(activeTab === 'shopping' ? '' : 'shopping')}
                            isOpen={activeTab === 'shopping'}
                        >
                            <div className="p-3 space-y-3">
                                {/* Progress bar */}
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[10px] font-bold">
                                        <span className="text-gray-500 uppercase tracking-wider">Progress</span>
                                        <span className="text-emerald-400">
                                            {shoppingSummary.purchased}/{shoppingSummary.total}
                                        </span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                                            style={{ width: `${shoppingSummary.total > 0 ? (shoppingSummary.purchased / shoppingSummary.total) * 100 : 0}%` }}
                                        />
                                    </div>
                                </div>

                                {/* Zone-grouped items */}
                                {shoppingSummary.zones
                                    .filter((z) => z.items.some((i) => !i.purchased))
                                    .map((zone) => {
                                        const unpurchased = zone.items.filter((i) => !i.purchased);
                                        if (unpurchased.length === 0) return null;
                                        return (
                                            <div key={zone.zone}>
                                                <div className="flex items-center gap-1.5 mb-1.5">
                                                    <span className="text-xs">{ZONE_EMOJI[zone.zone] || '🛒'}</span>
                                                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">
                                                        {zone.zone}
                                                    </span>
                                                    <span className="text-[9px] text-gray-600 font-bold">({unpurchased.length})</span>
                                                </div>
                                                <div className="space-y-1">
                                                    {unpurchased.map((item) => {
                                                        const purchase = toPurchasable(item.ingredient_name, item.required_qty, item.unit);
                                                        return (
                                                            <button
                                                                key={item.id}
                                                                onClick={async () => {
                                                                    triggerHaptic('medium');
                                                                    await markPurchased(item.id);
                                                                    setShoppingSummary(getShoppingList());
                                                                    window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
                                                                }}
                                                                className="w-full flex items-center gap-2.5 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-emerald-500/[0.06] hover:border-emerald-500/20 transition-all active:scale-[0.98] text-left"
                                                                aria-label={`Mark ${item.ingredient_name} as purchased`}
                                                            >
                                                                <div className="w-5 h-5 rounded-md border-2 border-gray-600 flex items-center justify-center flex-shrink-0" />
                                                                <span className="text-[11px] font-bold text-white flex-1 truncate">
                                                                    {item.ingredient_name}
                                                                </span>
                                                                <span className="text-[10px] font-bold text-emerald-400 tabular-nums flex-shrink-0">
                                                                    {purchase.matched
                                                                        ? `${purchase.packageCount} × ${purchase.packageLabel}`
                                                                        : `${Math.round(item.required_qty * 10) / 10} ${item.unit}`}
                                                                </span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}

                                {/* All done state */}
                                {shoppingSummary.remaining === 0 && (
                                    <div className="text-center py-4">
                                        <span className="text-2xl">✅</span>
                                        <p className="text-[11px] font-bold text-emerald-400 mt-1">All provisioned!</p>
                                    </div>
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
                            <div className="flex flex-col flex-1">
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
                                        aria-label="Chat message"
                                    />
                                    <button
                                        onClick={handleSendGalleyMsg}
                                        disabled={!galleyInput.trim()}
                                        className="px-3 py-2 bg-sky-500/10 border border-sky-500/20 rounded-lg text-xs text-sky-400 font-bold disabled:opacity-30 hover:bg-sky-500/20 transition-colors"
                                        aria-label="Send message"
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
