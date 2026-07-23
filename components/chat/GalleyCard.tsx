import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    getMealsByStatus,
    calculateMealDays,
    getCrewCount,
    type MealPlan,
    type MealDayInfo,
} from '../../services/MealPlanService';
import { getShoppingList, markPurchased, type ShoppingListSummary } from '../../services/ShoppingListService';
import { triggerHaptic } from '../../utils/system';
import { getCachedActiveVoyage, getVoyageById, type Voyage } from '../../services/VoyageService';
import { toPurchasable } from '../../services/PurchaseUnits';
import { type PassageStatus } from '../../services/PassagePlanService';
import { ChildCard } from './ChildCard';
import { MealCalendar } from './MealCalendar';
import { CaptainsTable } from './CaptainsTable';
import { ZONE_EMOJI } from './galleyTokens';
import { useCrewCount } from '../../contexts/CrewCountContext';
import { DelegationBadge } from '../crew/DelegationBadge';
import { type CrewMember } from '../../services/CrewService';
import { GalleyCookingMode } from '../passage/GalleyCookingMode';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

const provisionedStorageKey = (voyageId: string, scope?: AuthIdentityScope): string =>
    authScopedStorageKey(`thalassa_provisioned:${voyageId}`, scope);
const galleyCrewCountStorageKey = (voyageId: string, scope?: AuthIdentityScope): string =>
    authScopedStorageKey(`thalassa_galley_crew_count:${voyageId}`, scope);

function readProvisioned(voyageId: string): boolean {
    try {
        return localStorage.getItem(provisionedStorageKey(voyageId)) === 'true';
    } catch {
        return false;
    }
}

function readGalleyCrewCount(voyageId: string): number | null {
    try {
        const raw = localStorage.getItem(galleyCrewCountStorageKey(voyageId));
        if (!raw) return null;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : null;
    } catch {
        return null;
    }
}

function writeGalleyCrewCount(voyageId: string, count: number, scope?: AuthIdentityScope): void {
    try {
        localStorage.setItem(galleyCrewCountStorageKey(voyageId, scope), String(count));
    } catch {
        /* storage unavailable */
    }
}

interface GalleyCardProps {
    onOpenCookingMode?: (meal: MealPlan) => void;
    /** Passage permissions — omission fails closed until the caller verifies access. */
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
    // A selected passage ID is navigation state, not proof of ownership.
    // Direct/legacy callsites therefore fail closed until their parent passes
    // the verified PassageStatus.
    const perms = passageStatus ?? {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    };
    const hasMealAccess = perms.visible && perms.canViewMeals;
    const canRecordPurchase = hasMealAccess && perms.canEditStores;
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<'' | 'food' | 'shopping' | 'recipes'>('');
    const [activeMeals, setActiveMeals] = useState<MealPlan[]>([]);
    const [shoppingSummary, setShoppingSummary] = useState<ShoppingListSummary | null>(null);
    const [cookingMealId, setCookingMealId] = useState<string | null>(null);
    const [activeCookingMeal, setActiveCookingMeal] = useState<MealPlan | null>(null);
    const [purchasingItemId, setPurchasingItemId] = useState<string | null>(null);
    const [shoppingActionError, setShoppingActionError] = useState<string | null>(null);
    const [provisioned, setProvisioned] = useState(false);
    const [identityKey, setIdentityKey] = useState(() => getAuthIdentityScope().key);

    // ── Voyage context for meal calendar ──
    const [voyage, setVoyage] = useState<Voyage | null>(null);
    const [mealDays, setMealDays] = useState<MealDayInfo | null>(null);
    const [voyageCrewCount, setVoyageCrewCount] = useState<number | null>(null);
    const { crewCount, setCrewCount: handleSetCrewCount } = useCrewCount();

    // Effective crew count: max(settings count, registered crew + 1 captain)
    const plannedCrewCount = voyageCrewCount ?? crewCount;
    const effectiveCrewCount =
        registeredCrewCount !== undefined && registeredCrewCount > 0
            ? Math.max(plannedCrewCount, registeredCrewCount + 1)
            : plannedCrewCount;

    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                setIdentityKey(next.key);
            }),
        [],
    );

    useEffect(() => {
        if (!hasMealAccess || !perms.voyageId) {
            setProvisioned(false);
            setVoyageCrewCount(null);
            return;
        }
        setProvisioned(readProvisioned(perms.voyageId));
        setVoyageCrewCount(readGalleyCrewCount(perms.voyageId));
    }, [hasMealAccess, identityKey, perms.voyageId]);

    const handleVoyageCrewCountChange = useCallback(
        (count: number) => {
            if (getAuthIdentityScope().key !== identityKey) return;
            const clamped = Math.max(1, Math.min(20, count));
            if (perms.voyageId) {
                setVoyageCrewCount(clamped);
                writeGalleyCrewCount(perms.voyageId, clamped);
                return;
            }
            handleSetCrewCount(clamped);
        },
        [handleSetCrewCount, identityKey, perms.voyageId],
    );

    // Load voyage data and compute calendar dimensions
    useEffect(() => {
        if (!hasMealAccess || !expanded || !perms.voyageId || !perms.ownerUserId) {
            setVoyage(null);
            setMealDays(null);
            return;
        }

        let disposed = false;
        let generation = 0;
        const selectedVoyageId = perms.voyageId;
        const selectedOwnerUserId = perms.ownerUserId;

        const loadVoyage = async () => {
            const requestGeneration = ++generation;
            const requestIdentity = getAuthIdentityScope();
            const cached = getCachedActiveVoyage();
            let selected: Voyage | null =
                cached?.id === selectedVoyageId && cached.user_id === selectedOwnerUserId ? cached : null;

            try {
                const fetched = await getVoyageById(selectedVoyageId);
                if (fetched?.id === selectedVoyageId && fetched.user_id === selectedOwnerUserId) {
                    selected = fetched;
                }
            } catch {
                /* offline — retain only an exact, owner-matching cache */
            }

            if (disposed || requestGeneration !== generation || !isAuthIdentityScopeCurrent(requestIdentity)) return;
            if (!selected) {
                setVoyage(null);
                setMealDays(null);
                return;
            }

            let effectiveDeparture = selected.departure_time;
            let effectiveEta = selected.eta;
            if (!effectiveDeparture || !effectiveEta) {
                try {
                    const { fetchRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                    const routeData = await fetchRoutesAndTracks();
                    const normalizedName = selected.voyage_name.trim().toLowerCase();
                    const matchingRoute = routeData.routes.find(
                        (route) => route.label.trim().toLowerCase() === normalizedName,
                    );
                    if (matchingRoute) {
                        if (!effectiveDeparture && matchingRoute.timestamp) {
                            effectiveDeparture = new Date(matchingRoute.timestamp).toISOString();
                        }
                        if (
                            effectiveDeparture &&
                            !effectiveEta &&
                            matchingRoute.durationHours &&
                            matchingRoute.durationHours > 0
                        ) {
                            effectiveEta = new Date(
                                Date.parse(effectiveDeparture) + matchingRoute.durationHours * 3_600_000,
                            ).toISOString();
                        }
                    }
                } catch {
                    /* route cache unavailable */
                }
            }

            if (effectiveDeparture && !effectiveEta) {
                effectiveEta = new Date(Date.parse(effectiveDeparture) + 7 * 24 * 3_600_000).toISOString();
            }

            if (disposed || requestGeneration !== generation || !isAuthIdentityScopeCurrent(requestIdentity)) return;
            const voyageWithDates =
                effectiveDeparture !== selected.departure_time || effectiveEta !== selected.eta
                    ? { ...selected, departure_time: effectiveDeparture, eta: effectiveEta }
                    : selected;
            setVoyage(voyageWithDates);
            setMealDays(
                effectiveDeparture && effectiveEta ? calculateMealDays(effectiveDeparture, effectiveEta) : null,
            );

            if (readGalleyCrewCount(selectedVoyageId) === null) {
                void getCrewCount(selectedVoyageId)
                    .then((count) => {
                        if (
                            !disposed &&
                            requestGeneration === generation &&
                            isAuthIdentityScopeCurrent(requestIdentity)
                        ) {
                            const clamped = Math.max(1, Math.min(20, count));
                            setVoyageCrewCount(clamped);
                            writeGalleyCrewCount(selectedVoyageId, clamped, requestIdentity);
                        }
                    })
                    .catch(() => {
                        /* unavailable */
                    });
            }
        };

        void loadVoyage();
        const onPassageChange = () => void loadVoyage();
        window.addEventListener('thalassa:passage-changed', onPassageChange);
        window.addEventListener('thalassa:passage-plan-saved', onPassageChange);
        return () => {
            disposed = true;
            generation += 1;
            window.removeEventListener('thalassa:passage-changed', onPassageChange);
            window.removeEventListener('thalassa:passage-plan-saved', onPassageChange);
        };
    }, [expanded, hasMealAccess, identityKey, perms.ownerUserId, perms.voyageId]);

    const refreshActiveMeals = useCallback(() => {
        const reserved = getMealsByStatus('reserved', perms.voyageId ?? undefined);
        const cooking = getMealsByStatus('cooking', perms.voyageId ?? undefined);
        setActiveMeals([...cooking, ...reserved]);
    }, [perms.voyageId]);

    // Load active meals and shopping status
    useEffect(() => {
        if (!hasMealAccess || !expanded) return;
        refreshActiveMeals();
        setShoppingSummary(getShoppingList(perms.voyageId ?? undefined, perms.ownerUserId));
    }, [expanded, hasMealAccess, perms.ownerUserId, perms.voyageId, refreshActiveMeals]);

    const handleToggle = useCallback(() => {
        setExpanded((v) => !v);
        triggerHaptic('light');
    }, []);

    const handleCookNow = useCallback(
        (meal: MealPlan) => {
            setCookingMealId(meal.id);
            triggerHaptic('medium');

            if (onOpenCookingMode) {
                onOpenCookingMode(meal);
                setCookingMealId(null);
            } else {
                setActiveCookingMeal(meal);
            }
        },
        [onOpenCookingMode],
    );

    const closeCookingMode = useCallback(() => {
        setActiveCookingMeal(null);
        setCookingMealId(null);
        refreshActiveMeals();
    }, [refreshActiveMeals]);

    const handleQuickPurchase = useCallback(
        async (itemId: string) => {
            if (!canRecordPurchase || purchasingItemId) return;

            setPurchasingItemId(itemId);
            setShoppingActionError(null);
            triggerHaptic('medium');
            try {
                await markPurchased(itemId, undefined, undefined, perms.voyageId, perms.ownerUserId);
                setShoppingSummary(getShoppingList(perms.voyageId ?? undefined, perms.ownerUserId));
                window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
            } catch {
                setShoppingActionError('That purchase could not be recorded. Your shopping list was left unchanged.');
            } finally {
                setPurchasingItemId(null);
            }
        },
        [canRecordPurchase, perms.ownerUserId, perms.voyageId, purchasingItemId],
    );

    if (!hasMealAccess) return null;

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
                                    voyageId={perms.voyageId}
                                    ownerUserId={perms.ownerUserId}
                                    voyageName={voyage?.id === perms.voyageId ? voyage.voyage_name : null}
                                    activeMeals={activeMeals}
                                    onMealsChanged={() => {
                                        const reserved = getMealsByStatus('reserved', perms.voyageId ?? undefined);
                                        const cooking = getMealsByStatus('cooking', perms.voyageId ?? undefined);
                                        setActiveMeals([...cooking, ...reserved]);
                                    }}
                                    cookingMealId={cookingMealId}
                                    onCookNow={handleCookNow}
                                    shoppingSummary={shoppingSummary}
                                    onCrewCountChange={handleVoyageCrewCountChange}
                                    onShoppingChanged={() =>
                                        setShoppingSummary(
                                            getShoppingList(perms.voyageId ?? undefined, perms.ownerUserId),
                                        )
                                    }
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
                                {!canRecordPurchase && (
                                    <p
                                        id="galley-shopping-permission-note"
                                        role="note"
                                        className="rounded-lg border border-sky-500/20 bg-sky-500/[0.08] px-3 py-2 text-[11px] font-semibold text-sky-100"
                                    >
                                        Ship&apos;s Stores are read-only. Open the Grocery List to review what is
                                        needed.
                                    </p>
                                )}
                                {shoppingActionError && (
                                    <p
                                        role="alert"
                                        className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200"
                                    >
                                        {shoppingActionError}
                                    </p>
                                )}

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
                                                                type="button"
                                                                key={item.id}
                                                                onClick={() => void handleQuickPurchase(item.id)}
                                                                disabled={
                                                                    !canRecordPurchase || purchasingItemId !== null
                                                                }
                                                                aria-describedby={
                                                                    canRecordPurchase
                                                                        ? undefined
                                                                        : 'galley-shopping-permission-note'
                                                                }
                                                                className="w-full flex items-center gap-2.5 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:bg-emerald-500/[0.06] hover:border-emerald-500/20 transition-all active:scale-[0.98] text-left disabled:cursor-not-allowed disabled:opacity-50"
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
                        type="button"
                        onClick={() => {
                            if (getAuthIdentityScope().key !== identityKey) return;
                            const next = !provisioned;
                            setProvisioned(next);
                            try {
                                if (perms.voyageId) {
                                    localStorage.setItem(provisionedStorageKey(perms.voyageId), String(next));
                                }
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
            {activeCookingMeal &&
                typeof document !== 'undefined' &&
                createPortal(
                    <GalleyCookingMode
                        meal={activeCookingMeal}
                        onClose={closeCookingMode}
                        onComplete={closeCookingMode}
                    />,
                    document.body,
                )}
        </div>
    );
};
