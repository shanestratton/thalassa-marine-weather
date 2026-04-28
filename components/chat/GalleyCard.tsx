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
import { getCachedActiveVoyage, getActiveVoyage, getDraftVoyages, type Voyage } from '../../services/VoyageService';
import { toPurchasable } from '../../services/PurchaseUnits';
import { type PassageStatus } from '../../services/PassagePlanService';
import { ChildCard } from './ChildCard';
import { MealCalendar } from './MealCalendar';
import { CaptainsTable } from './CaptainsTable';
import { ZONE_EMOJI } from './galleyTokens';
import { useCrewCount } from '../../contexts/CrewCountContext';
import { DelegationBadge } from '../crew/DelegationBadge';
import { type CrewMember } from '../../services/CrewService';

interface GalleyCardProps {
    onOpenCookingMode?: (meal: MealPlan) => void;
    /** Passage permissions — if omitted, all child cards are visible (owner mode) */
    passageStatus?: PassageStatus;
    /** Outer wrapper className override */
    className?: string;
    /** Number of registered crew members (excluding captain). When set, crew count = max(settings, this + 1) */
    registeredCrewCount?: number;
    /** Delegation props — when provided, shows an Assign badge on the header */
    cardDelegations?: Record<string, string>;
    delegationMenuOpen?: string | null;
    onDelegationMenuToggle?: (key: string | null) => void;
    onAssignCard?: (cardKey: string, crewEmail: string | null) => void;
    crewList?: CrewMember[];
}

export const GalleyCard: React.FC<GalleyCardProps> = ({
    onOpenCookingMode,
    passageStatus,
    className,
    registeredCrewCount,
    cardDelegations,
    delegationMenuOpen,
    onDelegationMenuToggle,
    onAssignCard,
    crewList,
}) => {
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
    const [activeTab, setActiveTab] = useState<'' | 'food' | 'shopping' | 'recipes'>('');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [cookingMealId, setCookingMealId] = useState<string | null>(null);
    const [provisioned, setProvisioned] = useState(() => {
        try {
            return localStorage.getItem('thalassa_provisioned') === 'true';
        } catch {
            return false;
        }
    });

    // ── Voyage context for meal calendar ──
    const [voyage, setVoyage] = useState<Voyage | null>(null);
    const [mealDays, setMealDays] = useState<MealDayInfo | null>(null);
    const { crewCount, setCrewCount: handleSetCrewCount } = useCrewCount();

    // Effective crew count: max(settings count, registered crew + 1 captain)
    const effectiveCrewCount =
        registeredCrewCount !== undefined && registeredCrewCount > 0
            ? Math.max(crewCount, registeredCrewCount + 1)
            : crewCount;

    // Load voyage data and compute calendar dimensions
    useEffect(() => {
        if (!expanded) return;

        const loadVoyage = async () => {
            // 1. Try cached first for instant render
            let v: Voyage | null = getCachedActiveVoyage();

            // 2. Then try fetching active voyage from Supabase (also updates cache)
            try {
                const active = await getActiveVoyage();
                if (active) v = active;
            } catch {
                /* offline — use cached */
            }

            // 3. If no active voyage, check drafts for one with dates
            if (!v || (!v.departure_time && !v.eta)) {
                try {
                    const drafts = await getDraftVoyages();
                    const withDates = drafts.find((d) => d.departure_time && d.eta);
                    if (withDates) v = withDates;
                } catch {
                    /* offline */
                }
            }

            setVoyage(v);
            if (v?.departure_time && v?.eta) {
                setMealDays(calculateMealDays(v.departure_time, v.eta));
            }

            // If no stored crew count, try loading from Supabase
            if (!localStorage.getItem('thalassa_crew_count') && v?.id) {
                getCrewCount(v.id)
                    .then((count) => {
                        handleSetCrewCount(count);
                    })
                    .catch(() => {
                        /* supabase unavailable */
                    });
            }
        };

        loadVoyage();
    }, [expanded, handleSetCrewCount]);

    // Load active meals and shopping status
    useEffect(() => {
        if (!expanded) return;
        const reserved = getMealsByStatus('reserved');
        const cooking = getMealsByStatus('cooking');
        setActiveMeals([...cooking, ...reserved]);
        setShoppingSummary(getShoppingList());
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

    return (
        <div className={className ?? 'mx-4 mt-3 mb-2'}>
            {/* ── Minimised Bar ── */}
            <button
                onClick={handleToggle}
                className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all ${
                    expanded
                        ? provisioned
                            ? 'bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20'
                            : 'bg-gradient-to-r from-red-500/10 to-orange-500/10 border-red-500/20'
                        : provisioned
                          ? 'bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] border-emerald-500/15 hover:from-emerald-500/[0.1] hover:to-teal-500/[0.06]'
                          : 'bg-gradient-to-r from-red-500/[0.06] to-orange-500/[0.03] border-red-500/15 hover:from-red-500/[0.1] hover:to-orange-500/[0.06]'
                }`}
                aria-expanded={expanded}
                aria-label="Voyage Provisioning"
            >
                <div
                    className={`w-11 h-11 rounded-xl bg-gradient-to-br ${provisioned ? 'from-emerald-500/20 to-teal-600/10 border-emerald-500/20' : 'from-red-500/20 to-orange-500/10 border-red-500/20'} border flex items-center justify-center text-xl flex-shrink-0`}
                >
                    {provisioned ? '✅' : '⛵'}
                </div>
                <div className="flex-1 text-left">
                    <p className="text-lg font-semibold text-white inline-flex items-center">
                        Voyage Provisioning
                        {cardDelegations && onDelegationMenuToggle && onAssignCard && crewList && (
                            <DelegationBadge
                                cardKey="voyage_provisioning"
                                delegations={cardDelegations}
                                crewList={crewList}
                                menuOpen={delegationMenuOpen ?? null}
                                onMenuToggle={onDelegationMenuToggle}
                                onAssign={onAssignCard}
                            />
                        )}
                    </p>
                    <p className={`text-sm ${provisioned ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                        {provisioned ? '✅ Provisioned' : 'Meals · Shopping'}
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
                                    ? `${mealDays.totalDays} days · ${effectiveCrewCount} crew`
                                    : activeMeals.length > 0
                                      ? `${activeMeals.length} meal${activeMeals.length !== 1 ? 's' : ''} planned`
                                      : 'Plan your meals'
                            }
                            color="amber"
                            onToggle={() => setActiveTab(activeTab === 'food' ? '' : 'food')}
                            isOpen={activeTab === 'food'}
                        >
                            <div>
                                <MealCalendar
                                    mealDays={mealDays}
                                    crewCount={effectiveCrewCount}
                                    voyageId={voyage?.id || null}
                                    voyageName={voyage?.voyage_name || null}
                                    activeMeals={activeMeals}
                                    onMealsChanged={() => {
                                        const reserved = getMealsByStatus('reserved');
                                        const cooking = getMealsByStatus('cooking');
                                        setActiveMeals([...cooking, ...reserved]);
                                    }}
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
                            onToggle={() => setActiveTab(activeTab === 'shopping' ? '' : 'shopping')}
                            isOpen={activeTab === 'shopping'}
                        >
                            <div className="p-3 space-y-3">
                                {/* Progress bar */}
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[11px] font-bold">
                                        <span className="text-gray-500 uppercase tracking-wider">Progress</span>
                                        <span className="text-emerald-400">
                                            {shoppingSummary.purchased}/{shoppingSummary.total}
                                        </span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                                            style={{
                                                width: `${shoppingSummary.total > 0 ? (shoppingSummary.purchased / shoppingSummary.total) * 100 : 0}%`,
                                            }}
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
                                                    <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest">
                                                        {zone.zone}
                                                    </span>
                                                    <span className="text-[11px] text-gray-500 font-bold">
                                                        ({unpurchased.length})
                                                    </span>
                                                </div>
                                                <div className="space-y-1">
                                                    {unpurchased.map((item) => {
                                                        const purchase = toPurchasable(
                                                            item.ingredient_name,
                                                            item.required_qty,
                                                            item.unit,
                                                        );
                                                        return (
                                                            <button
                                                                key={item.id}
                                                                onClick={async () => {
                                                                    triggerHaptic('medium');
                                                                    await markPurchased(item.id);
                                                                    setShoppingSummary(getShoppingList());
                                                                    window.dispatchEvent(
                                                                        new CustomEvent('thalassa:stores-changed'),
                                                                    );
                                                                }}
                                                                className="w-full flex items-center gap-2.5 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-emerald-500/[0.06] hover:border-emerald-500/20 transition-all active:scale-[0.98] text-left"
                                                                aria-label={`Mark ${item.ingredient_name} as purchased`}
                                                            >
                                                                <div className="w-5 h-5 rounded-md border-2 border-gray-600 flex items-center justify-center flex-shrink-0" />
                                                                <span className="text-xs font-bold text-white flex-1 truncate">
                                                                    {item.ingredient_name}
                                                                </span>
                                                                <span className="text-[11px] font-bold text-emerald-400 tabular-nums flex-shrink-0">
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
                                        <p className="text-xs font-bold text-emerald-400 mt-1">All provisioned!</p>
                                    </div>
                                )}
                            </div>
                        </ChildCard>
                    )}

                    {/* ── Recipe Library — always available, opens Captain's Table fullscreen ── */}
                    <ChildCard
                        icon="☸"
                        title="Recipe Library"
                        subtitle="Browse community recipes · save favourites"
                        color="sky"
                        onToggle={() => setActiveTab(activeTab === 'recipes' ? '' : 'recipes')}
                        isOpen={activeTab === 'recipes'}
                    >
                        <CaptainsTable fullPage />
                    </ChildCard>

                    {/* ── Provisioned Toggle ── */}
                    <button
                        onClick={() => {
                            const next = !provisioned;
                            setProvisioned(next);
                            try {
                                localStorage.setItem('thalassa_provisioned', String(next));
                            } catch {
                                /* ignore */
                            }
                            triggerHaptic(next ? 'medium' : 'light');
                        }}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                            provisioned
                                ? 'bg-emerald-500/10 border-emerald-500/20'
                                : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
                        }`}
                    >
                        <div
                            className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                                provisioned ? 'bg-emerald-500 border-emerald-500' : 'border-gray-500 bg-transparent'
                            }`}
                        >
                            {provisioned && (
                                <svg
                                    className="w-3.5 h-3.5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={3}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                            )}
                        </div>
                        <span className={`text-sm font-semibold ${provisioned ? 'text-emerald-400' : 'text-gray-400'}`}>
                            All meals provisioned for this voyage
                        </span>
                    </button>
                </div>
            )}
        </div>
    );
};
