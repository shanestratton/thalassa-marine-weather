/**
 * GalleyCard — Collapsible "Passage Planning" card for the Chat screen.
 *
 * Contains a multi-day meal calendar grid powered by voyage dates,
 * per-slot Spoonacular recipe search, and crew coordination chat.
 *
 * Hard-wired to Ship's Stores: "Cook Now" triggers DELTA subtractions.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    getMealsByStatus,
    startCooking,
    completeMeal,
    scheduleMeal,
    unscheduleMeal,
    calculateMealDays,
    getCrewCount,

    type MealPlan,
    type MealSlot,
    type MealDayInfo,

} from '../../services/MealPlanService';
import { getStoresAvailability } from '../../services/MealPlanService';
import { getShoppingList, markPurchased, type ShoppingItem, type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { scaleIngredient, getRecipeImageUrl, searchRecipes, getGalleyDifficulty, type GalleyMeal } from '../../services/GalleyRecipeService';
import { getCachedActiveVoyage, type Voyage } from '../../services/VoyageService';
import { toPurchasable } from '../../services/PurchaseUnits';


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
    const [crewCount, setCrewCount] = useState(() => {
        const stored = localStorage.getItem('thalassa_crew_count');
        return stored ? parseInt(stored) || 2 : 2;
    });

    // Update crew count + persist + broadcast
    const handleSetCrewCount = useCallback((n: number) => {
        const clamped = Math.max(1, Math.min(20, n));
        setCrewCount(clamped);
        localStorage.setItem('thalassa_crew_count', String(clamped));
        window.dispatchEvent(new CustomEvent('thalassa:crew-changed', { detail: clamped }));
    }, []);

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
            }).catch(() => {});
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

            {/* ── Expanded Content: 4 Child Cards ── */}
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

                    {/* ── 1b. Shopping List ── */}
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
                                        const ZONE_EMOJI: Record<string, string> = {
                                            Butcher: '🥩', Produce: '🥬', 'Bottle Shop': '🍷', Bakery: '🥖',
                                            Dairy: '🧀', Chandlery: '⚓', 'Fuel Dock': '⛽', Pharmacy: '💊', General: '🛒',
                                        };
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
        <>
            {/* ── Tappable Row (always visible in the passage planning list) ── */}
            <button
                onClick={onToggle}
                className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all active:scale-[0.98] ${
                    isOpen ? c.border + ' ' + c.bg : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
                aria-expanded={isOpen}
            >
                <div className={`w-11 h-11 rounded-xl ${c.iconBg} border ${c.border} flex items-center justify-center text-xl flex-shrink-0`}>
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-white">{title}</p>
                    <p className={`text-[10px] ${c.text} opacity-70`}>{subtitle}</p>
                </div>
                <svg
                    className="w-3.5 h-3.5 text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
            </button>

            {/* ── Full-Screen Overlay (portal to escape will-change-transform) ── */}
            {isOpen && createPortal(
                <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
                    {/* Header with back chevron */}
                    <div className={`flex items-center gap-3 px-4 py-3 border-b ${c.border} bg-slate-950/95 backdrop-blur-xl flex-shrink-0`}>
                        <button
                            onClick={onToggle}
                            className="p-2 -ml-2 rounded-xl hover:bg-white/5 transition-colors active:scale-90"
                            aria-label="Back to passage planning"
                        >
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div className={`w-11 h-11 rounded-xl ${c.iconBg} border ${c.border} flex items-center justify-center text-xl flex-shrink-0`}>
                            {icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white">{title}</p>
                            <p className={`text-[10px] ${c.text} opacity-70`}>{subtitle}</p>
                        </div>
                    </div>

                    {/* Scrollable content */}
                    <div className="flex-1 overflow-y-auto overscroll-contain" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>
                        {children}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
};

// ── Meal Calendar Grid ──
const SLOT_CONFIG: { slot: MealSlot; label: string; emoji: string }[] = [
    { slot: 'breakfast', label: 'Brekky', emoji: '🌅' },
    { slot: 'lunch', label: 'Lunch', emoji: '☀️' },
    { slot: 'dinner', label: 'Dinner', emoji: '🌙' },
];

interface MealCalendarProps {
    mealDays: MealDayInfo | null;
    crewCount: number;
    voyageId: string | null;
    voyageName: string | null;
    activeMeals: MealPlan[];
    onMealsChanged: () => void;
    onOpenCookingMode?: (meal: MealPlan) => void;
    cookingMealId: string | null;
    onCookNow: (meal: MealPlan) => void;
    shoppingSummary: ShoppingListSummary | null;
    onCrewCountChange?: (n: number) => void;
    onShoppingChanged?: () => void;
}

const MealCalendar: React.FC<MealCalendarProps> = ({
    mealDays,
    crewCount,
    voyageId,
    voyageName,
    activeMeals,
    onMealsChanged,
    onOpenCookingMode,
    cookingMealId,
    onCookNow,
    shoppingSummary,
    onCrewCountChange,
    onShoppingChanged,
}) => {
    const [slotPicker, setSlotPicker] = useState<{ date: string; slot: MealSlot } | null>(null);
    const [expandedMeal, setExpandedMeal] = useState<string | null>(null);

    // Context menu for meal card actions (copy/move)
    const [contextMenu, setContextMenu] = useState<{ meal: MealPlan; action: 'copy' | 'move' } | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Delete meal ──
    const handleDeleteMeal = useCallback(async (meal: MealPlan, e: React.MouseEvent) => {
        e.stopPropagation();
        await unscheduleMeal(meal.id);
        triggerHaptic('medium');
        onMealsChanged();
        // Dispatch stores-changed so stores UI updates
        window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
    }, [onMealsChanged]);

    // ── Copy/Move meal to target date ──
    const handleCopyToDate = useCallback(async (targetDate: string) => {
        if (!contextMenu || !voyageId) return;
        const meal = contextMenu.meal;
        const isMove = contextMenu.action === 'move';

        // Construct GalleyMeal from MealPlan for scheduleMeal
        const galleyMeal: GalleyMeal = {
            id: meal.spoonacular_id || Date.now(),
            title: meal.title,
            readyInMinutes: 30,
            servings: meal.servings_planned,
            image: '',
            sourceUrl: '',
            ingredients: meal.ingredients,
        };

        await scheduleMeal(galleyMeal, targetDate, meal.meal_slot, voyageId, meal.servings_planned);

        // If move, delete original
        if (isMove) {
            await unscheduleMeal(meal.id);
        }

        triggerHaptic('medium');
        setContextMenu(null);
        onMealsChanged();
        window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
    }, [contextMenu, voyageId, onMealsChanged]);

    // Long-press handlers
    const startLongPress = useCallback((meal: MealPlan) => {
        longPressTimer.current = setTimeout(() => {
            triggerHaptic('heavy');
            setContextMenu({ meal, action: 'copy' });
        }, 500);
    }, []);
    const cancelLongPress = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);


    // ── Provision Passage: aggregate all shortfalls at once ──
    const [provisioning, setProvisioning] = useState(false);
    const handleProvisionPassage = useCallback(async () => {
        if (!mealDays || activeMeals.length === 0) return;
        setProvisioning(true);
        try {
            const { addManualItem } = await import('../../services/ShoppingListService');
            const storesAvail = getStoresAvailability();

            // Fuzzy match helper (same as ChefPlate)
            const STRIP = new Set(['large', 'small', 'medium', 'fresh', 'dried', 'ground', 'whole', 'raw', 'cooked', 'chopped', 'diced', 'sliced', 'minced', 'grated', 'shredded', 'crushed', 'melted', 'softened', 'unsalted', 'salted', 'sharp', 'mild', 'extra', 'fine', 'thick', 'thin', 'hot', 'cold', 'frozen', 'canned', 'tinned']);
            const fuzzyMatch = (name: string) => {
                const lower = name.toLowerCase().trim();
                const exact = storesAvail.find((s) => s.item_name.toLowerCase() === lower);
                if (exact) return exact;
                const core = lower.split(/\s+/).filter((w) => !STRIP.has(w) && w.length > 2).join(' ');
                if (!core) return undefined;
                return storesAvail.find((s) => {
                    const sl = s.item_name.toLowerCase();
                    return sl.includes(core) || core.includes(sl);
                });
            };

            // Aggregate required quantities across all meals
            const needs = new Map<string, { qty: number; unit: string; name: string }>();
            for (const meal of activeMeals) {
                const servings = meal.servings_planned || crewCount;
                for (const ing of (meal.ingredients || [])) {
                    const scaled = scaleIngredient(ing.amount, ing.scalable, ing.amount, servings);
                    const key = ing.name.toLowerCase();
                    const prev = needs.get(key);
                    if (prev) {
                        prev.qty += scaled;
                    } else {
                        needs.set(key, { qty: scaled, unit: ing.unit, name: ing.name });
                    }
                }
            }

            // Compute shortfalls against stores and add to shopping list
            let added = 0;
            for (const [, need] of needs) {
                const store = fuzzyMatch(need.name);
                const available = store ? store.available : 0;
                const shortfall = Math.round((need.qty - available) * 10) / 10;
                if (shortfall > 0) {
                    await addManualItem({
                        name: need.name,
                        qty: shortfall,
                        unit: need.unit,
                        notes: 'Passage provision',
                    });
                    added++;
                }
            }

            triggerHaptic('medium');
            window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));

            // Refresh shopping list state so the inline card appears immediately
            onShoppingChanged?.();

            // Brief success feedback
            if (added === 0) {
                alert('✅ All ingredients are already in your stores!');
            }
        } catch (e) {
            console.error('Provision passage error:', e);
        }
        setProvisioning(false);
    }, [mealDays, activeMeals, crewCount]);


    // No dates set — prompt user
    if (!mealDays) {
        return (
            <div className="p-6 text-center">
                <span className="text-4xl">📅</span>
                <p className="text-sm font-bold text-white mt-3">Set Voyage Dates</p>
                <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                    Add departure and arrival dates to your passage plan to unlock the meal calendar.
                </p>
                <div className="mt-3 px-4">
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <span className="text-base">🧭</span>
                        <p className="text-[11px] text-gray-400 text-left">
                            Go to Vessel Hub → select your passage → set departure {'&'} ETA dates
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // Build a map of existing meals by date+slot for quick lookup
    const mealMap = new Map<string, MealPlan>();
    for (const m of activeMeals) {
        mealMap.set(`${m.planned_date}_${m.meal_slot}`, m);
    }

    return (
        <div className="p-3 space-y-1">
            {/* Calendar header */}
            <div className="flex items-center justify-between px-1 pb-2">
                <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">
                        {voyageName || 'Passage'} · {mealDays.passageDays}d + {mealDays.emergencyDays}d buffer
                    </p>
                </div>
                <div className="flex items-center gap-1.5">
                    {/* Crew count stepper */}
                    <div className="flex items-center gap-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 px-1 py-0.5">
                        <button
                            onClick={() => onCrewCountChange?.(crewCount - 1)}
                            disabled={crewCount <= 1}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-sky-400 text-xs font-bold hover:bg-sky-500/20 disabled:opacity-30 active:scale-90 transition-all"
                        >
                            −
                        </button>
                        <span className="text-[10px] font-bold text-sky-400 min-w-[28px] text-center">
                            👥 {crewCount}
                        </span>
                        <button
                            onClick={() => onCrewCountChange?.(crewCount + 1)}
                            disabled={crewCount >= 20}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-sky-400 text-xs font-bold hover:bg-sky-500/20 disabled:opacity-30 active:scale-90 transition-all"
                        >
                            +
                        </button>
                    </div>
                </div>
            </div>

            {/* Provision Passage CTA */}
            {activeMeals.length > 0 && (
                <button
                    onClick={handleProvisionPassage}
                    disabled={provisioning}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold active:scale-[0.98] disabled:opacity-50 transition-all mb-1"
                >
                    {provisioning ? (
                        <div className="w-3.5 h-3.5 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
                    ) : (
                        '🛒'
                    )}
                    {provisioning ? 'Building list…' : `Provision Passage (${activeMeals.length} meals)`}
                </button>
            )}

            {/* Day rows */}
            {mealDays.dates.map((date, dayIdx) => {
                const isEmergency = mealDays.emergencyDates.has(date);
                const dayLabel = `Day ${dayIdx + 1}`;
                const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                });

                return (
                    <div
                        key={date}
                        className={`rounded-xl border p-2 transition-all ${
                            isEmergency
                                ? 'border-amber-500/25 border-dashed bg-amber-500/[0.03]'
                                : 'border-white/[0.06] bg-white/[0.02]'
                        }`}
                    >
                        {/* Day label */}
                        <div className="flex items-center gap-2 px-1 pb-1.5">
                            <span className={`text-[10px] font-black uppercase tracking-widest ${isEmergency ? 'text-amber-400' : 'text-gray-500'}`}>
                                {isEmergency ? '📦 ' : ''}{dayLabel}
                            </span>
                            <span className="text-[10px] text-gray-600">{dateLabel}</span>
                            {isEmergency && (
                                <span className="ml-auto text-[9px] font-bold text-amber-400/60 uppercase tracking-wider">
                                    Buffer
                                </span>
                            )}
                        </div>

                        {/* 3-column slot grid */}
                        <div className="grid grid-cols-3 gap-1.5">
                            {SLOT_CONFIG.map(({ slot, label, emoji }) => {
                                const meal = mealMap.get(`${date}_${slot}`);
                                const isExpanded = expandedMeal === meal?.id;

                                if (meal) {
                                    return (
                                        <div
                                            key={slot}
                                            className={`relative p-2 rounded-lg text-left transition-all select-none ${
                                                isExpanded
                                                    ? 'bg-amber-500/15 border border-amber-500/25'
                                                    : 'bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08]'
                                            }`}
                                            onClick={() => setExpandedMeal(isExpanded ? null : meal.id)}
                                            onTouchStart={() => startLongPress(meal)}
                                            onTouchEnd={cancelLongPress}
                                            onTouchMove={cancelLongPress}
                                        >
                                            {/* ✕ Delete button */}
                                            <button
                                                onClick={(e) => handleDeleteMeal(meal, e)}
                                                className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-gray-600/90 text-white text-[8px] leading-none flex items-center justify-center z-10 active:scale-90 opacity-60 hover:opacity-100 transition-opacity"
                                                aria-label={`Remove ${meal.title}`}
                                            >
                                                ✕
                                            </button>
                                            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">
                                                {emoji} {label}
                                            </p>
                                            <p className="text-[11px] font-bold text-white truncate mt-0.5 pr-3">
                                                {meal.title.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F?\s]+/u, '')}
                                            </p>
                                            {(() => {
                                                const diff = getGalleyDifficulty(meal.title, undefined, meal.ingredients?.length);
                                                return (
                                                    <p className={`text-[8px] font-bold mt-0.5 ${
                                                        diff.score <= 2 ? 'text-emerald-400/60' :
                                                        diff.score === 3 ? 'text-amber-400/60' :
                                                        diff.score === 4 ? 'text-orange-400/70' :
                                                        'text-red-400/70'
                                                    }`}>
                                                        {diff.emoji} {diff.label}
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    );
                                }

                                // Empty slot — "+" button
                                return (
                                    <button
                                        key={slot}
                                        onClick={() => {
                                            setSlotPicker({ date, slot });
                                            triggerHaptic('light');
                                        }}
                                        className="p-2 rounded-lg border border-dashed border-white/[0.08] hover:border-amber-500/30 hover:bg-amber-500/[0.04] transition-all flex flex-col items-center justify-center min-h-[48px] group"
                                    >
                                        <span className="text-[9px] text-gray-600 font-bold uppercase tracking-wider group-hover:text-gray-400">
                                            {emoji} {label}
                                        </span>
                                        <span className="text-lg text-gray-600 group-hover:text-amber-400 transition-colors leading-none mt-0.5">
                                            +
                                        </span>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Expanded ChefPlate for selected meal */}
                        {expandedMeal && mealMap.get(`${date}_breakfast`)?.id === expandedMeal && (
                            <div className="mt-2">
                                <ChefPlate
                                    meal={activeMeals.find((m) => m.id === expandedMeal)!}
                                    baseServings={activeMeals.find((m) => m.id === expandedMeal)?.servings_planned || crewCount}
                                    cooking={cookingMealId === expandedMeal}
                                    onCook={() => onCookNow(activeMeals.find((m) => m.id === expandedMeal)!)}
                                    shoppingSummary={shoppingSummary}
                                />
                            </div>
                        )}
                        {expandedMeal && mealMap.get(`${date}_lunch`)?.id === expandedMeal && (
                            <div className="mt-2">
                                <ChefPlate
                                    meal={activeMeals.find((m) => m.id === expandedMeal)!}
                                    baseServings={activeMeals.find((m) => m.id === expandedMeal)?.servings_planned || crewCount}
                                    cooking={cookingMealId === expandedMeal}
                                    onCook={() => onCookNow(activeMeals.find((m) => m.id === expandedMeal)!)}
                                    shoppingSummary={shoppingSummary}
                                />
                            </div>
                        )}
                        {expandedMeal && mealMap.get(`${date}_dinner`)?.id === expandedMeal && (
                            <div className="mt-2">
                                <ChefPlate
                                    meal={activeMeals.find((m) => m.id === expandedMeal)!}
                                    baseServings={activeMeals.find((m) => m.id === expandedMeal)?.servings_planned || crewCount}
                                    cooking={cookingMealId === expandedMeal}
                                    onCook={() => onCookNow(activeMeals.find((m) => m.id === expandedMeal)!)}
                                    shoppingSummary={shoppingSummary}
                                />
                            </div>
                        )}
                    </div>
                );
            })}



            {slotPicker && (
                <SlotPicker
                    date={slotPicker.date}
                    slot={slotPicker.slot}
                    crewCount={crewCount}
                    voyageId={voyageId}
                    onScheduled={() => {
                        setSlotPicker(null);
                        onMealsChanged();
                    }}
                    onClose={() => setSlotPicker(null)}
                />
            )}

            {/* ── Copy/Move Context Menu ── */}
            {contextMenu && mealDays && createPortal(
                <div
                    className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70"
                    onClick={() => setContextMenu(null)}
                >
                    <div
                        className="w-full max-w-lg bg-slate-950 border-t border-amber-500/20 rounded-t-3xl shadow-2xl p-5 space-y-4"
                        onClick={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label={`${contextMenu.action === 'copy' ? 'Copy' : 'Move'} ${contextMenu.meal.title}`}
                    >
                        {/* Header */}
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-lg">
                                {contextMenu.action === 'copy' ? '📋' : '↗️'}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-white truncate">{contextMenu.meal.title}</p>
                                <p className="text-[10px] text-amber-400/70">
                                    {contextMenu.meal.planned_date} · {contextMenu.meal.meal_slot}
                                </p>
                            </div>
                        </div>

                        {/* Action toggle */}
                        <div className="flex gap-2">
                            <button
                                onClick={() => setContextMenu({ ...contextMenu, action: 'copy' })}
                                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                    contextMenu.action === 'copy'
                                        ? 'bg-amber-500/20 border border-amber-500/30 text-amber-400'
                                        : 'bg-white/[0.04] border border-white/[0.06] text-gray-400'
                                }`}
                            >
                                📋 Copy
                            </button>
                            <button
                                onClick={() => setContextMenu({ ...contextMenu, action: 'move' })}
                                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                    contextMenu.action === 'move'
                                        ? 'bg-sky-500/20 border border-sky-500/30 text-sky-400'
                                        : 'bg-white/[0.04] border border-white/[0.06] text-gray-400'
                                }`}
                            >
                                ↗️ Move
                            </button>
                        </div>

                        {/* Day picker */}
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-wider">
                            Select target day
                        </p>
                        <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                            {mealDays.dates.map((date, idx) => {
                                const isSource = date === contextMenu.meal.planned_date;
                                const existing = mealMap.get(`${date}_${contextMenu.meal.meal_slot}`);
                                const occupied = !!existing && existing.id !== contextMenu.meal.id;
                                const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
                                    weekday: 'short', month: 'short', day: 'numeric',
                                });
                                return (
                                    <button
                                        key={date}
                                        onClick={() => handleCopyToDate(date)}
                                        disabled={isSource || occupied}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                                            isSource
                                                ? 'border-white/[0.06] bg-white/[0.02] opacity-40 cursor-not-allowed'
                                                : occupied
                                                  ? 'border-red-500/10 bg-red-500/[0.03] opacity-50 cursor-not-allowed'
                                                  : 'border-white/[0.06] bg-white/[0.03] hover:bg-amber-500/10 hover:border-amber-500/20 active:scale-[0.98]'
                                        }`}
                                    >
                                        <span className="text-[11px] font-black text-gray-500 w-12">Day {idx + 1}</span>
                                        <span className="text-xs text-white flex-1 text-left">{dateLabel}</span>
                                        {isSource && <span className="text-[9px] text-gray-600">current</span>}
                                        {occupied && <span className="text-[9px] text-red-400">occupied</span>}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Cancel */}
                        <button
                            onClick={() => setContextMenu(null)}
                            className="w-full py-3 rounded-xl bg-white/[0.04] text-sm text-gray-400 font-medium"
                        >
                            Cancel
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

// ── Slot Picker Modal ──
const SlotPicker: React.FC<{
    date: string;
    slot: MealSlot;
    crewCount: number;
    voyageId: string | null;
    onScheduled: () => void;
    onClose: () => void;
}> = ({ date, slot, crewCount, voyageId, onScheduled, onClose }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [results, setResults] = useState<GalleyMeal[]>([]);
    const [searching, setSearching] = useState(false);
    const [scheduling, setScheduling] = useState(false);
    const [customName, setCustomName] = useState('');
    const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    const slotLabel = SLOT_CONFIG.find((s) => s.slot === slot);
    const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    });

    // Debounced search
    const handleSearch = useCallback(
        (q: string) => {
            setSearchQuery(q);
            if (searchTimeout.current) clearTimeout(searchTimeout.current);
            if (!q.trim()) {
                setResults([]);
                return;
            }
            searchTimeout.current = setTimeout(async () => {
                setSearching(true);
                const r = await searchRecipes(q, slot === 'breakfast' ? 'breakfast' : undefined);
                setResults(r);
                setSearching(false);
            }, 400);
        },
        [slot],
    );

    const handleSelectRecipe = async (meal: GalleyMeal) => {
        setScheduling(true);
        try {
            await scheduleMeal(meal, date, slot, voyageId, crewCount);
            triggerHaptic('medium');
            onScheduled();
        } catch {
            /* handled */
        }
        setScheduling(false);
    };

    const handleCustomMeal = async () => {
        if (!customName.trim()) return;
        setScheduling(true);
        try {
            const meal: GalleyMeal = {
                id: Date.now(),
                title: customName.trim(),
                readyInMinutes: 45,
                servings: crewCount,
                image: '',
                sourceUrl: '',
                ingredients: [],
            };
            await scheduleMeal(meal, date, slot, voyageId, crewCount);
            triggerHaptic('medium');
            onScheduled();
        } catch {
            /* handled */
        }
        setScheduling(false);
    };

    return (
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
            <div
                className="w-[calc(100%-2rem)] max-w-lg bg-slate-900 border border-white/[0.1] rounded-3xl max-h-[80vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
                    <div>
                        <p className="text-sm font-bold text-white">
                            {slotLabel?.emoji} {slotLabel?.label}
                        </p>
                        <p className="text-[10px] text-gray-500">{dateLabel}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                    >
                        ✕
                    </button>
                </div>

                {/* Search */}
                <div className="p-3">
                    <input
                        value={searchQuery}
                        onChange={(e) => handleSearch(e.target.value)}
                        placeholder="🔍 Search recipes…"
                        autoFocus
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                    />
                </div>

                {/* Results */}
                <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
                    {/* Quick suggestions when search is empty */}
                    {!searchQuery && results.length === 0 && !searching && (
                        <div className="space-y-2 pb-2">
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider px-1">
                                💡 Suggestions for {slotLabel?.label || 'this meal'}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {(slot === 'breakfast'
                                    ? ['Scrambled Eggs', 'Pancakes', 'Porridge', 'French Toast', 'Omelette', 'Baked Beans on Toast', 'Smoothie Bowl', 'Eggs Benedict']
                                    : slot === 'lunch'
                                      ? ['Chicken Wrap', 'Tuna Salad', 'Fried Rice', 'BLT Sandwich', 'Soup', 'Quesadilla', 'Fish Tacos', 'Pasta Salad']
                                      : ['Spaghetti Bolognese', 'Grilled Chicken', 'Beef Stew', 'Fish Curry', 'Stir Fry', 'Lamb Chops', 'Chilli Con Carne', 'Pad Thai']
                                ).map((suggestion) => (
                                    <button
                                        key={suggestion}
                                        onClick={() => {
                                            setSearchQuery(suggestion);
                                            handleSearch(suggestion);
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/15 text-[11px] text-amber-400/80 font-medium hover:bg-amber-500/15 hover:text-amber-300 transition-all active:scale-95"
                                    >
                                        {suggestion}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {searching && (
                        <p className="text-center text-[11px] text-gray-500 py-4">⏳ Searching recipes…</p>
                    )}

                    {results.map((meal) => (
                        <button
                            key={meal.id}
                            onClick={() => handleSelectRecipe(meal)}
                            disabled={scheduling}
                            className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-amber-500/[0.06] hover:border-amber-500/20 transition-all text-left disabled:opacity-40"
                        >
                            {meal.image && (
                                <img
                                    src={meal.image}
                                    alt=""
                                    className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                                    loading="lazy"
                                    onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                />
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-white truncate">{meal.title}</p>
                                <p className="text-[10px] text-gray-500">
                                    ⏱️ {meal.readyInMinutes}min · {meal.ingredients.length} ingredients
                                </p>
                            </div>
                        </button>
                    ))}

                    {!searching && results.length === 0 && searchQuery.trim() && (
                        <p className="text-center text-[11px] text-gray-500 py-4">
                            No recipes found. Try a different search or add a custom meal below.
                        </p>
                    )}
                </div>

                {/* Custom meal fallback */}
                <div className="p-3 border-t border-white/[0.06]">
                    <div className="flex gap-2">
                        <input
                            value={customName}
                            onChange={(e) => setCustomName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCustomMeal()}
                            placeholder="Or type a custom meal…"
                            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/30"
                        />
                        <button
                            onClick={handleCustomMeal}
                            disabled={!customName.trim() || scheduling}
                            className="px-4 py-2.5 bg-amber-500/15 border border-amber-500/20 rounded-xl text-[11px] font-bold text-amber-300 disabled:opacity-30 hover:bg-amber-500/25 transition-all"
                        >
                            {scheduling ? '⏳' : '+ Add'}
                        </button>
                    </div>
                </div>
            </div>
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
    const [imgError, setImgError] = useState(false);
    const [prepStarted, setPrepStarted] = useState(meal.status === 'cooking');
    const [addedItems, setAddedItems] = useState<Set<string>>(new Set());
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [storesVersion, setStoresVersion] = useState(0);
    const ratio = crewCount / baseServings;

    // Refresh stores data when items are purchased
    useEffect(() => {
        const handler = () => setStoresVersion((v) => v + 1);
        window.addEventListener('thalassa:stores-changed', handler);
        return () => window.removeEventListener('thalassa:stores-changed', handler);
    }, []);

    // Scale ingredients in real-time
    const scaledIngredients = meal.ingredients.map((ing) => ({
        ...ing,
        scaledAmount: Math.round(scaleIngredient(ing.amount, ing.scalable, baseServings, crewCount) * 10) / 10,
    }));

    // Get stores availability for per-ingredient shortfall (re-reads on storesVersion change)
    const storesAvail = getStoresAvailability();

    // Fuzzy match: recipe name "large eggs" should match store item "eggs"
    const STRIP_WORDS = new Set(['large', 'small', 'medium', 'fresh', 'dried', 'ground', 'whole', 'raw', 'cooked', 'chopped', 'diced', 'sliced', 'minced', 'grated', 'shredded', 'crushed', 'melted', 'softened', 'unsalted', 'salted', 'sharp', 'mild', 'extra', 'fine', 'thick', 'thin', 'hot', 'cold', 'frozen', 'canned', 'tinned']);
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

    // Shortfall count — add back THIS meal's own reservation to avoid circular logic
    // available = on_hand - all_reservations, so available + this_meal's_amount = on_hand - other_meals' reservations
    const shortfallIngredients = scaledIngredients.filter((ing) => {
        const store = findStoreMatch(ing.name);
        if (!store) return true;
        const effectiveAvailable = Math.round((store.available + ing.amount) * 10) / 10;
        return effectiveAvailable < ing.scaledAmount;
    });

    // Recipe image — cache-first
    // Filter out fake spoonacular IDs (QuickMealForm uses Date.now() which is 13+ digits)
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

    // ── Start Prep broadcast ──
    const handleStartPrep = async () => {
        setPrepStarted(true);
        triggerHaptic('heavy');

        // Start cooking lifecycle
        await startCooking(meal.id);
    };

    // ── Add shortfall directly to shopping list (no middleman) ──
    const handleAddToList = async (ing: (typeof scaledIngredients)[0]) => {
        try {
            const { addManualItem } = await import('../../services/ShoppingListService');
            const store = findStoreMatch(ing.name);
            const effectiveAvailable = store ? Math.round((store.available + ing.amount) * 10) / 10 : 0;
            const shortfall = Math.max(0, ing.scaledAmount - effectiveAvailable);
            if (shortfall <= 0) return;
            await addManualItem({
                name: ing.name,
                qty: Math.round(shortfall * 10) / 10,
                unit: ing.unit,
                notes: `For ${meal.title}`,
            });
            setAddedItems((prev) => new Set(prev).add(ing.name.toLowerCase()));
        } catch { /* failed */ }
    };

    return (
        <div className="rounded-2xl overflow-hidden border border-white/[0.06] bg-slate-950">
            {/* ═══════ 1. HERO IMAGE (compact 50%) ═══════ */}
            <div className="relative h-28 overflow-hidden">
                {/* Recipe photo — edge-to-edge */}
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
                {/* Premium gradient fallback — always visible until image loads */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br from-amber-900/90 via-orange-800/70 to-red-900/90 transition-opacity duration-700 ${
                        imgLoaded && showImage ? 'opacity-0' : 'opacity-100'
                    }`}
                >
                    {/* Decorative pattern */}
                    <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjAzKSIvPjwvc3ZnPg==')] opacity-50" />
                    {/* Centered meal emoji when no photo */}
                    {(!showImage || !imgLoaded) && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-6xl opacity-30 select-none">{mealEmoji}</span>
                        </div>
                    )}
                </div>

                {/* Bottom shadow gradient for text legibility */}
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
                            const diffColors = diff.score <= 2 ? 'text-emerald-300 border-emerald-500/20 bg-emerald-500/15'
                                : diff.score === 3 ? 'text-amber-300 border-amber-500/20 bg-amber-500/15'
                                : diff.score === 4 ? 'text-orange-300 border-orange-500/20 bg-orange-500/15'
                                : 'text-red-300 border-red-500/20 bg-red-500/15';
                            return (
                                <span className={`px-2 py-0.5 rounded-full backdrop-blur-sm text-[10px] font-bold border ${diffColors}`}>
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
                    const store = findStoreMatch(ing.name);
                    const available = store ? Math.round((store.available + ing.amount) * 10) / 10 : 0;
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
                        </div>
                    );
                })}

                {/* ═══ Master "Add All Shortfall" button ═══ */}
                {shortfallIngredients.length > 0 && (
                    <button
                        onClick={async () => {
                            for (const ing of shortfallIngredients) {
                                if (!addedItems.has(ing.name.toLowerCase())) {
                                    await handleAddToList(ing);
                                }
                            }
                        }}
                        disabled={shortfallIngredients.every((ing) => addedItems.has(ing.name.toLowerCase()))}
                        className="w-full mt-2 py-3 rounded-xl bg-gradient-to-r from-red-500/15 to-orange-500/15 border border-red-500/20 text-[11px] font-bold uppercase tracking-widest text-red-300 hover:from-red-500/25 hover:to-orange-500/25 transition-all active:scale-[0.97] disabled:opacity-30"
                    >
                        {shortfallIngredients.every((ing) => addedItems.has(ing.name.toLowerCase()))
                            ? '✅ All Shortfall Added'
                            : `🛒 Add ${shortfallIngredients.filter((ing) => !addedItems.has(ing.name.toLowerCase())).length} Shortfall to List`}
                    </button>
                )}
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
