/**
 * GroceryListPage — Full-page shopping list accessible from the Galley.
 *
 * Shows all shopping items grouped by Market Zone (🥩 Butcher, 🥬 Produce, etc.)
 * Tap to mark as purchased → auto-inserts into Ship's Stores + immediate sync.
 * Price tracking for voyage budget.
 *
 * "Check off items as you walk the aisles — your crew sees updates instantly."
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    getShoppingList,
    markPurchased,
    unmarkPurchased,
    addManualItem,
    getVoyageBudget,
    type ShoppingItem,
    type ShoppingListSummary,
    type MarketZone,
} from '../../services/ShoppingListService';
import { toPurchasable } from '../../services/PurchaseUnits';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuthStore } from '../../stores/authStore';
import { type PassageStatus } from '../../services/PassagePlanService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

import { ZONE_EMOJI } from '../chat/galleyTokens';

interface GroceryListPageProps {
    onBack: () => void;
    /** Verified selected-voyage authority. Omission intentionally scopes to the user's personal list. */
    passageStatus?: PassageStatus;
    /** False while the parent is resolving `passageStatus`. */
    accessLoaded?: boolean;
}

const ALL_ZONES: MarketZone[] = [
    'General',
    'Produce',
    'Butcher',
    'Dairy',
    'Bakery',
    'Bottle Shop',
    'Pharmacy',
    'Chandlery',
    'Fuel Dock',
];

const FILTERS = ['remaining', 'purchased', 'all'] as const;

function formatQuantity(quantity: number): string {
    return quantity.toLocaleString(undefined, {
        maximumFractionDigits: 8,
        useGrouping: false,
    });
}

function purchaseQuantityLabel(item: ShoppingItem): { primary: string; required: string | null } {
    const purchase = toPurchasable(item.ingredient_name, item.required_qty, item.unit);
    const required = `${formatQuantity(item.required_qty)} ${item.unit}`;

    return purchase.matched
        ? {
              primary: `${formatQuantity(purchase.packageCount)} × ${purchase.packageLabel}`,
              required,
          }
        : {
              primary: required,
              required: null,
          };
}

export const GroceryListPage: React.FC<GroceryListPageProps> = ({ onBack, passageStatus, accessLoaded = true }) => {
    const personalPermissions = usePermissions();
    const currentUserId = useAuthStore((state) => state.user?.id ?? null);
    const renderIdentityScope = getAuthIdentityScope();
    const permissions = passageStatus
        ? {
              loaded: accessLoaded,
              canEditStores: passageStatus.visible && passageStatus.canEditStores,
              canViewGalley: passageStatus.visible && passageStatus.canViewMeals,
              permissions: {
                  can_view_passage_meals: passageStatus.visible && passageStatus.canViewMeals,
              },
          }
        : personalPermissions;
    const scopeVoyageId = passageStatus ? passageStatus.voyageId : null;
    const scopeOwnerUserId = passageStatus?.ownerUserId ?? currentUserId;
    const dataScopeKey = [renderIdentityScope.key, scopeVoyageId ?? 'personal', scopeOwnerUserId ?? 'no-owner'].join(
        '|',
    );
    const activeDataScopeKeyRef = useRef(dataScopeKey);
    activeDataScopeKeyRef.current = dataScopeKey;
    const [summary, setSummary] = useState<ShoppingListSummary | null>(null);
    const [loadedDataScopeKey, setLoadedDataScopeKey] = useState<string | null>(null);
    const [filter, setFilter] = useState<'all' | 'remaining' | 'purchased'>('remaining');
    const [purchasingId, setPurchasingId] = useState<string | null>(null);
    const [pageError, setPageError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [focusRequest, setFocusRequest] = useState(0);

    // Price input modal state
    const [priceItem, setPriceItem] = useState<ShoppingItem | null>(null);
    const [priceValue, setPriceValue] = useState('');
    const [storeName, setStoreName] = useState('');
    const [priceError, setPriceError] = useState<string | null>(null);
    const [priceInvalid, setPriceInvalid] = useState(false);
    const priceInputRef = useRef<HTMLInputElement>(null);

    // Manual item modal state
    const [showAddForm, setShowAddForm] = useState(false);
    const [addName, setAddName] = useState('');
    const [addQty, setAddQty] = useState('1');
    const [addUnit, setAddUnit] = useState('each');
    const [addZone, setAddZone] = useState<MarketZone>('General');
    const [isAdding, setIsAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const [addQuantityInvalid, setAddQuantityInvalid] = useState(false);
    const addNameRef = useRef<HTMLInputElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const listPanelRef = useRef<HTMLDivElement>(null);
    const focusListAfterMutationRef = useRef(false);

    // Budget summary
    const [budget, setBudget] = useState<{ total: number; byZone: Record<string, number> } | null>(null);
    const stateOwnsRenderedScope = loadedDataScopeKey === dataScopeKey && renderIdentityScope.userId === currentUserId;
    const visibleSummary = stateOwnsRenderedScope ? summary : null;
    const visibleBudget = stateOwnsRenderedScope ? budget : null;
    const visiblePageError = stateOwnsRenderedScope ? pageError : null;
    const visibleIsLoading = stateOwnsRenderedScope ? isLoading : true;
    const permissionsLoadedForScope = stateOwnsRenderedScope && permissions.loaded;
    const canManageShoppingList =
        permissionsLoadedForScope &&
        (permissions.canEditStores || permissions.canViewGalley || permissions.permissions.can_view_passage_meals);

    const operationIsCurrent = useCallback(
        (operationScope: AuthIdentityScope, operationDataScopeKey: string) =>
            isAuthIdentityScopeCurrent(operationScope) &&
            operationScope.userId === currentUserId &&
            activeDataScopeKeyRef.current === operationDataScopeKey,
        [currentUserId],
    );

    const loadList = useCallback(() => {
        const operationScope = getAuthIdentityScope();
        const operationDataScopeKey = dataScopeKey;
        if (operationScope.userId !== currentUserId || !operationIsCurrent(operationScope, operationDataScopeKey)) {
            return;
        }
        try {
            const s = getShoppingList(scopeVoyageId, scopeOwnerUserId);
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            setSummary(s);
            setBudget(null);

            if (scopeVoyageId) {
                const b = getVoyageBudget(scopeVoyageId);
                const byZoneMap: Record<string, number> = {};
                for (const z of b.byZone) byZoneMap[z.zone] = z.spent;
                setBudget({ total: b.totalSpent, byZone: byZoneMap });
            }
            setPageError(null);
            setLoadedDataScopeKey(operationDataScopeKey);
        } catch {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setPageError('The shopping list could not be loaded. Please try again.');
                setLoadedDataScopeKey(operationDataScopeKey);
            }
        } finally {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setIsLoading(false);
            }
        }
    }, [currentUserId, dataScopeKey, operationIsCurrent, scopeOwnerUserId, scopeVoyageId]);

    useEffect(() => {
        setLoadedDataScopeKey(null);
        setSummary(null);
        setBudget(null);
        setPageError(null);
        setIsLoading(true);
        setPurchasingId(null);
        setPriceItem(null);
        setPriceValue('');
        setStoreName('');
        setPriceError(null);
        setPriceInvalid(false);
        setShowAddForm(false);
        setAddName('');
        setAddQty('1');
        setAddUnit('each');
        setAddZone('General');
        setIsAdding(false);
        setAddError(null);
        setAddQuantityInvalid(false);
        loadList();
    }, [loadList]);

    // Realtime sync — crew purchase updates appear instantly
    useRealtimeSync('shopping_list', loadList);

    // Filtered items
    const filteredZones = useMemo(() => {
        if (!visibleSummary) return [];
        return visibleSummary.zones
            .map((z) => ({
                ...z,
                items: z.items.filter((i) => {
                    if (filter === 'remaining') return !i.purchased;
                    if (filter === 'purchased') return i.purchased;
                    return true;
                }),
            }))
            .filter((z) => z.items.length > 0);
    }, [visibleSummary, filter]);

    const handleFilterKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % FILTERS.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + FILTERS.length) % FILTERS.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = FILTERS.length - 1;
        if (nextIndex === null) return;

        event.preventDefault();
        setFilter(FILTERS[nextIndex]);
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        tabs?.[nextIndex]?.focus();
    }, []);

    // Open price prompt instead of immediately marking purchased
    const handleCheckbox = useCallback(
        (item: ShoppingItem) => {
            if (item.purchased || !permissionsLoadedForScope || !permissions.canEditStores) return;
            setPriceItem(item);
            setPriceValue('');
            setStoreName('');
            setPriceError(null);
            setPriceInvalid(false);
        },
        [permissions.canEditStores, permissionsLoadedForScope],
    );

    const resetPriceDialog = useCallback(() => {
        setPriceItem(null);
        setPriceValue('');
        setStoreName('');
        setPriceError(null);
        setPriceInvalid(false);
    }, []);

    const closePriceDialog = useCallback(() => {
        if (purchasingId) return;
        resetPriceDialog();
    }, [purchasingId, resetPriceDialog]);

    const resetAddDialog = useCallback(() => {
        setShowAddForm(false);
        setAddName('');
        setAddQty('1');
        setAddUnit('each');
        setAddZone('General');
        setAddError(null);
        setAddQuantityInvalid(false);
    }, []);

    const closeAddDialog = useCallback(() => {
        if (isAdding) return;
        resetAddDialog();
    }, [isAdding, resetAddDialog]);

    useEffect(() => {
        if (permissionsLoadedForScope && permissions.canEditStores) return;
        resetPriceDialog();
    }, [permissions.canEditStores, permissionsLoadedForScope, resetPriceDialog]);

    useEffect(() => {
        if (canManageShoppingList) return;
        resetAddDialog();
    }, [canManageShoppingList, resetAddDialog]);

    const pageDialogRef = useFocusTrap<HTMLDivElement>(true, {
        onEscape: stateOwnsRenderedScope && (priceItem || showAddForm) ? undefined : onBack,
    });
    const priceDialogRef = useFocusTrap<HTMLDivElement>(stateOwnsRenderedScope && !!priceItem, {
        initialFocusRef: priceInputRef,
        onEscape: closePriceDialog,
    });
    const addDialogRef = useFocusTrap<HTMLDivElement>(stateOwnsRenderedScope && showAddForm, {
        initialFocusRef: addNameRef,
        onEscape: closeAddDialog,
    });

    useEffect(() => {
        if (!focusListAfterMutationRef.current) return;
        focusListAfterMutationRef.current = false;
        const nextItem = listPanelRef.current?.querySelector<HTMLButtonElement>(
            '[data-grocery-item-action]:not([disabled])',
        );
        (nextItem ?? addButtonRef.current)?.focus();
    }, [focusRequest]);

    // Confirm purchase with optional price + store
    const handleConfirmPurchase = useCallback(async () => {
        if (!priceItem || purchasingId || !permissionsLoadedForScope || !permissions.canEditStores) return;
        const operationScope = getAuthIdentityScope();
        const operationDataScopeKey = dataScopeKey;
        if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
        const purchasedItem = priceItem;
        const cost = priceValue.trim() ? Number(priceValue) : undefined;
        if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
            setPriceError('Enter a valid price of zero or more.');
            setPriceInvalid(true);
            return;
        }

        setPurchasingId(purchasedItem.id);
        setPriceError(null);
        setPriceInvalid(false);
        setPageError(null);
        triggerHaptic('medium');
        const store = storeName.trim() || undefined;
        try {
            await markPurchased(purchasedItem.id, cost, store, scopeVoyageId, scopeOwnerUserId);
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            focusListAfterMutationRef.current = filter === 'remaining';
            resetPriceDialog();
            loadList();
            setFocusRequest((request) => request + 1);
        } catch {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setPriceError(`${purchasedItem.ingredient_name} could not be marked as purchased. Please try again.`);
            }
        } finally {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setPurchasingId(null);
            }
        }
    }, [
        filter,
        loadList,
        dataScopeKey,
        operationIsCurrent,
        permissions.canEditStores,
        permissionsLoadedForScope,
        priceItem,
        priceValue,
        purchasingId,
        resetPriceDialog,
        scopeOwnerUserId,
        scopeVoyageId,
        storeName,
    ]);

    // Skip price → just mark purchased
    const handleSkipPrice = useCallback(async () => {
        if (!priceItem || purchasingId || !permissionsLoadedForScope || !permissions.canEditStores) return;
        const operationScope = getAuthIdentityScope();
        const operationDataScopeKey = dataScopeKey;
        if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
        const purchasedItem = priceItem;
        setPurchasingId(purchasedItem.id);
        setPriceError(null);
        setPriceInvalid(false);
        setPageError(null);
        triggerHaptic('medium');
        try {
            await markPurchased(
                purchasedItem.id,
                undefined,
                storeName.trim() || undefined,
                scopeVoyageId,
                scopeOwnerUserId,
            );
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            focusListAfterMutationRef.current = filter === 'remaining';
            resetPriceDialog();
            loadList();
            setFocusRequest((request) => request + 1);
        } catch {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setPriceError(`${purchasedItem.ingredient_name} could not be marked as purchased. Please try again.`);
            }
        } finally {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setPurchasingId(null);
            }
        }
    }, [
        filter,
        loadList,
        dataScopeKey,
        operationIsCurrent,
        permissions.canEditStores,
        permissionsLoadedForScope,
        priceItem,
        purchasingId,
        resetPriceDialog,
        scopeOwnerUserId,
        scopeVoyageId,
        storeName,
    ]);

    // Untick — revert a purchased item back to "needs buying"
    const handleUntick = useCallback(
        async (item: ShoppingItem) => {
            if (purchasingId || !permissionsLoadedForScope || !permissions.canEditStores) return;
            const operationScope = getAuthIdentityScope();
            const operationDataScopeKey = dataScopeKey;
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            setPurchasingId(item.id);
            setPageError(null);
            triggerHaptic('light');
            try {
                await unmarkPurchased(item.id, scopeVoyageId, scopeOwnerUserId);
                if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
                focusListAfterMutationRef.current = filter === 'purchased';
                loadList();
                setFocusRequest((request) => request + 1);
            } catch {
                if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                    setPageError(
                        `${item.ingredient_name} could not be returned to the shopping list. Please try again.`,
                    );
                }
            } finally {
                if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                    setPurchasingId(null);
                }
            }
        },
        [
            filter,
            loadList,
            dataScopeKey,
            operationIsCurrent,
            permissions.canEditStores,
            permissionsLoadedForScope,
            purchasingId,
            scopeOwnerUserId,
            scopeVoyageId,
        ],
    );

    const handleAddItem = useCallback(async () => {
        if (!addName.trim() || isAdding || !canManageShoppingList) return;
        const operationScope = getAuthIdentityScope();
        const operationDataScopeKey = dataScopeKey;
        if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
        const itemName = addName.trim();
        const quantity = Number(addQty);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            setAddError('Enter a quantity greater than zero.');
            setAddQuantityInvalid(true);
            return;
        }

        setIsAdding(true);
        setAddError(null);
        setAddQuantityInvalid(false);
        setPageError(null);
        try {
            await addManualItem({
                name: itemName,
                qty: quantity,
                unit: addUnit || 'each',
                zone: addZone,
                voyageId: scopeVoyageId,
                ownerUserId: scopeOwnerUserId,
            });
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            resetAddDialog();
            loadList();
        } catch {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setAddError(`${itemName} could not be added. Please try again.`);
            }
        } finally {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setIsAdding(false);
            }
        }
    }, [
        addName,
        addQty,
        addUnit,
        addZone,
        canManageShoppingList,
        dataScopeKey,
        isAdding,
        loadList,
        operationIsCurrent,
        resetAddDialog,
        scopeOwnerUserId,
        scopeVoyageId,
    ]);

    return (
        <div
            ref={pageDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Shopping list"
            className="fixed inset-0 z-[1100] bg-slate-950 overflow-hidden slide-up-enter"
        >
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Grocery List"
                    onBack={onBack}
                    breadcrumbs={['Galley', 'Grocery List']}
                    subtitle={
                        visibleSummary ? (
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                                {visibleSummary.remaining} remaining · {visibleSummary.purchased} purchased
                                {visibleSummary.totalCost > 0 && (
                                    <span className="text-emerald-400"> · ${visibleSummary.totalCost.toFixed(2)}</span>
                                )}
                            </p>
                        ) : visibleIsLoading ? (
                            <p className="text-label text-gray-400">Loading…</p>
                        ) : (
                            <p className="text-label text-red-300">Unavailable</p>
                        )
                    }
                />

                {/* Filter tabs */}
                <div
                    className="shrink-0 flex border-b border-white/[0.06]"
                    role="tablist"
                    aria-label="Shopping list filters"
                >
                    {FILTERS.map((f, index) => (
                        <button
                            key={f}
                            type="button"
                            role="tab"
                            id={`grocery-filter-${f}`}
                            aria-controls="grocery-filter-panel"
                            aria-selected={filter === f}
                            tabIndex={filter === f ? 0 : -1}
                            onClick={() => setFilter(f)}
                            onKeyDown={(event) => handleFilterKeyDown(event, index)}
                            className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                                filter === f
                                    ? 'text-emerald-400 border-b-2 border-emerald-400'
                                    : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {f === 'remaining'
                                ? `🛒 Need (${visibleSummary?.remaining ?? 0})`
                                : f === 'purchased'
                                  ? `✅ Done (${visibleSummary?.purchased ?? 0})`
                                  : `📋 All (${visibleSummary?.total ?? 0})`}
                        </button>
                    ))}
                </div>

                {visiblePageError && (
                    <div
                        role="alert"
                        className="mx-4 mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200"
                    >
                        {visiblePageError}
                    </div>
                )}

                {!permissionsLoadedForScope ? (
                    <div
                        id="grocery-permission-note"
                        role="status"
                        className="mx-4 mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-xs font-semibold text-amber-100"
                    >
                        Checking your grocery access. Purchase, undo, and list-edit actions are unavailable for now.
                    </div>
                ) : !permissions.canEditStores ? (
                    <div
                        id="grocery-permission-note"
                        role="note"
                        className="mx-4 mt-3 rounded-xl border border-sky-500/20 bg-sky-500/[0.08] px-3 py-2 text-xs font-semibold text-sky-100"
                    >
                        Ship&apos;s Stores are read-only. Only the skipper or crew with Stores edit access can record or
                        undo purchases.
                        {canManageShoppingList
                            ? ' You can still add items to the shopping list.'
                            : ' Ask the skipper for Galley or Stores access to edit this list.'}
                    </div>
                ) : null}

                {/* Item list */}
                <div
                    ref={listPanelRef}
                    id="grocery-filter-panel"
                    role="tabpanel"
                    aria-labelledby={`grocery-filter-${filter}`}
                    className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0 no-scrollbar"
                >
                    {!visibleSummary ? (
                        visibleIsLoading ? (
                            <div role="status" className="py-16 text-center text-xs font-semibold text-gray-400">
                                Loading shopping list…
                            </div>
                        ) : (
                            <EmptyState
                                title="Shopping List Unavailable"
                                subtitle="Your saved list could not be read from this device."
                                actionLabel="Try Again"
                                onAction={() => {
                                    setIsLoading(true);
                                    loadList();
                                }}
                                className="py-16"
                            />
                        )
                    ) : visibleSummary.total === 0 ? (
                        <EmptyState
                            icon={
                                <svg
                                    className="w-8 h-8"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                    aria-hidden="true"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                                    />
                                </svg>
                            }
                            title="No Grocery Items Yet"
                            subtitle="Use the + button, or add missing ingredients from the Meal Calendar"
                            className="py-16"
                        />
                    ) : filteredZones.length === 0 ? (
                        <EmptyState
                            icon={<span className="text-3xl">✅</span>}
                            title={filter === 'remaining' ? 'All Done!' : 'No Purchased Items'}
                            subtitle={
                                filter === 'remaining'
                                    ? "All items have been purchased and added to Ship's Stores"
                                    : 'Items will appear here once purchased'
                            }
                            className="py-16"
                        />
                    ) : (
                        filteredZones.map((zone) => (
                            <div key={zone.zone}>
                                {/* Zone header */}
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-sm">{ZONE_EMOJI[zone.zone] || '🛒'}</span>
                                    <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                        {zone.zone}
                                    </span>
                                    <span className="text-micro text-gray-500 font-bold">({zone.items.length})</span>
                                </div>

                                {/* Items */}
                                <div className="space-y-1.5">
                                    {zone.items.map((item) => {
                                        const purchaseQuantity = purchaseQuantityLabel(item);
                                        const isPurchasing = purchasingId === item.id;

                                        return (
                                            <div
                                                key={item.id}
                                                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                                                    item.purchased
                                                        ? 'bg-emerald-500/[0.04] border-emerald-500/10 opacity-60'
                                                        : 'bg-white/[0.02] border-white/[0.06]'
                                                }`}
                                            >
                                                {/* Checkbox */}
                                                <button
                                                    type="button"
                                                    data-grocery-item-action
                                                    onClick={() =>
                                                        item.purchased ? handleUntick(item) : handleCheckbox(item)
                                                    }
                                                    disabled={
                                                        !!purchasingId ||
                                                        !permissionsLoadedForScope ||
                                                        !permissions.canEditStores
                                                    }
                                                    aria-describedby={
                                                        !permissionsLoadedForScope || !permissions.canEditStores
                                                            ? 'grocery-permission-note'
                                                            : undefined
                                                    }
                                                    className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center flex-shrink-0 transition-all active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 ${
                                                        item.purchased
                                                            ? 'bg-emerald-500 border-emerald-500'
                                                            : isPurchasing
                                                              ? 'border-amber-400 animate-pulse'
                                                              : 'border-gray-600 hover:border-emerald-400'
                                                    }`}
                                                    aria-label={
                                                        item.purchased
                                                            ? `Undo ${item.ingredient_name}`
                                                            : `Mark ${item.ingredient_name} as purchased`
                                                    }
                                                >
                                                    {item.purchased && (
                                                        <svg
                                                            className="w-3.5 h-3.5 text-black"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                            strokeWidth={3}
                                                            aria-hidden="true"
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                d="M4.5 12.75l6 6 9-13.5"
                                                            />
                                                        </svg>
                                                    )}
                                                    {isPurchasing && <span className="text-[11px]">⏳</span>}
                                                </button>

                                                {/* Name + purchase info */}
                                                <div className="flex-1 min-w-0">
                                                    <p
                                                        className={`text-xs font-bold truncate ${
                                                            item.purchased ? 'text-gray-500 line-through' : 'text-white'
                                                        }`}
                                                    >
                                                        {item.ingredient_name}
                                                    </p>
                                                    {item.purchased && item.purchased_at && (
                                                        <p className="text-[11px] text-emerald-500/60">
                                                            ✅ {new Date(item.purchased_at).toLocaleDateString()}
                                                            {item.purchase_retailer
                                                                ? ` · ${item.purchase_retailer}`
                                                                : ''}
                                                            {item.actual_cost
                                                                ? ` · $${item.actual_cost.toFixed(2)}`
                                                                : ''}
                                                        </p>
                                                    )}
                                                </div>

                                                {/* Purchase quantity */}
                                                <div className="text-right flex-shrink-0">
                                                    <span
                                                        className={`text-[11px] font-bold tabular-nums ${item.purchased ? 'text-gray-500' : 'text-emerald-400'}`}
                                                    >
                                                        {purchaseQuantity.primary}
                                                    </span>
                                                    {purchaseQuantity.required && (
                                                        <p className="text-[11px] text-gray-500 line-through tabular-nums">
                                                            {purchaseQuantity.required}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* ═══ Voyage Budget Summary ═══ */}
                {visibleBudget && visibleBudget.total > 0 && (
                    <div className="shrink-0 mx-4 mb-3 p-3 rounded-xl bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.04] border border-emerald-500/10">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-black text-emerald-400 uppercase tracking-widest">
                                💰 Voyage Spend
                            </span>
                            <span className="text-sm font-black text-emerald-400 tabular-nums">
                                ${visibleBudget.total.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {Object.entries(visibleBudget.byZone)
                                .filter(([, v]) => v > 0)
                                .sort(([, a], [, b]) => b - a)
                                .map(([zone, cost]) => (
                                    <span key={zone} className="text-[11px] text-gray-500">
                                        {ZONE_EMOJI[zone as MarketZone] || '🛒'} {zone}:{' '}
                                        <span className="text-gray-400 font-bold">${cost.toFixed(2)}</span>
                                    </span>
                                ))}
                        </div>
                    </div>
                )}

                {/* Progress bar at bottom */}
                {visibleSummary && visibleSummary.total > 0 && (
                    <div
                        className="shrink-0 px-4 py-3 border-t border-white/[0.06] bg-slate-950"
                        style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden"
                                role="progressbar"
                                aria-label="Shopping progress"
                                aria-valuemin={0}
                                aria-valuemax={visibleSummary.total}
                                aria-valuenow={visibleSummary.purchased}
                                aria-valuetext={`${visibleSummary.purchased} of ${visibleSummary.total} items purchased`}
                            >
                                <div
                                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                    style={{
                                        width: `${Math.round(
                                            (visibleSummary.purchased / visibleSummary.total) * 100,
                                        )}%`,
                                    }}
                                />
                            </div>
                            <span className="text-[11px] font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                                {visibleSummary.purchased}/{visibleSummary.total}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ Add Item FAB ═══ */}
            {visibleSummary && (
                <button
                    ref={addButtonRef}
                    type="button"
                    onClick={() => {
                        if (!canManageShoppingList) return;
                        setAddError(null);
                        setAddQuantityInvalid(false);
                        setShowAddForm(true);
                    }}
                    disabled={!!purchasingId || !canManageShoppingList}
                    aria-describedby={!canManageShoppingList ? 'grocery-permission-note' : undefined}
                    className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-[1130] w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg shadow-emerald-500/30 flex items-center justify-center active:scale-90 transition-transform disabled:opacity-40"
                    aria-label="Add item to shopping list"
                >
                    <svg
                        className="w-7 h-7 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                </button>
            )}

            {/* ═══ Price Input Modal ═══ */}
            {stateOwnsRenderedScope && priceItem && (
                <div
                    className="fixed inset-0 z-[1200] flex items-start justify-center overflow-y-auto overscroll-contain p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom)+1rem)] sm:items-center"
                    onClick={closePriceDialog}
                    role="presentation"
                >
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
                    <div
                        ref={priceDialogRef}
                        className="relative my-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.08] bg-slate-900 p-5 shadow-2xl animate-in slide-in-from-bottom duration-200"
                        style={{
                            maxHeight: 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 6rem)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="grocery-purchase-title"
                        aria-describedby="grocery-purchase-item"
                        aria-busy={!!purchasingId}
                    >
                        <button
                            type="button"
                            onClick={closePriceDialog}
                            disabled={!!purchasingId}
                            className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors"
                            aria-label={`Cancel marking ${priceItem.ingredient_name} as purchased`}
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 id="grocery-purchase-title" className="text-sm font-black text-white mb-1 pr-10">
                            ✅ Mark as Purchased
                        </h3>
                        <p id="grocery-purchase-item" className="text-[11px] text-gray-400 mb-4">
                            {priceItem.ingredient_name}
                        </p>
                        <p className="mb-4 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-200">
                            Adds {purchaseQuantityLabel(priceItem).primary} to Ship&apos;s Stores.
                        </p>

                        {/* Price input */}
                        <label
                            htmlFor="grocery-purchase-price"
                            className="text-[11px] font-bold text-gray-500 uppercase tracking-widest"
                        >
                            Price (optional)
                        </label>
                        <div className="flex items-center gap-2 mt-1 mb-4">
                            <span className="text-lg font-bold text-gray-500">$</span>
                            <input
                                id="grocery-purchase-price"
                                ref={priceInputRef}
                                type="number"
                                inputMode="decimal"
                                step="0.01"
                                min="0"
                                value={priceValue}
                                onChange={(e) => {
                                    setPriceValue(e.target.value);
                                    if (priceInvalid) {
                                        setPriceInvalid(false);
                                        setPriceError(null);
                                    }
                                }}
                                onKeyDown={(e) => e.key === 'Enter' && handleConfirmPurchase()}
                                disabled={!!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores}
                                aria-invalid={priceInvalid}
                                aria-describedby={priceError ? 'grocery-purchase-error' : undefined}
                                placeholder="0.00"
                                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-lg font-bold tabular-nums outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                            />
                        </div>

                        {/* Retailer name */}
                        <label
                            htmlFor="grocery-purchase-store"
                            className="text-[11px] font-bold text-gray-500 uppercase tracking-widest"
                        >
                            Retailer (optional)
                        </label>
                        <input
                            id="grocery-purchase-store"
                            type="text"
                            value={storeName}
                            onChange={(e) => setStoreName(e.target.value)}
                            disabled={!!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores}
                            placeholder="Where did you buy it?"
                            className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                        />
                        <div className="flex flex-wrap gap-1.5 mt-2 mb-4">
                            {['Coles', 'Woolworths', 'Aldi', 'IGA', 'Markets'].map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => setStoreName(s)}
                                    disabled={
                                        !!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores
                                    }
                                    aria-pressed={storeName === s}
                                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${
                                        storeName === s
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-white/[0.04] text-gray-500 border border-white/[0.06] hover:text-gray-300'
                                    }`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>

                        {priceError && (
                            <p
                                id="grocery-purchase-error"
                                role="alert"
                                className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200"
                            >
                                {priceError}
                            </p>
                        )}

                        {/* Buttons */}
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSkipPrice}
                                disabled={!!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores}
                                aria-label={`Mark ${priceItem.ingredient_name} as purchased without a price`}
                                className="flex-1 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[11px] font-bold text-gray-400 uppercase tracking-widest active:scale-[0.97] disabled:opacity-40"
                            >
                                Skip Price
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmPurchase}
                                disabled={!!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores}
                                aria-label={`Confirm purchase of ${priceItem.ingredient_name}`}
                                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-[11px] font-black text-white uppercase tracking-widest active:scale-[0.97] disabled:opacity-40"
                            >
                                {purchasingId ? '⏳ Saving…' : '✅ Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ Add Item Modal ═══ */}
            {stateOwnsRenderedScope && showAddForm && (
                <div
                    className="fixed inset-0 z-[1200] flex items-start justify-center overflow-y-auto overscroll-contain p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
                    onClick={closeAddDialog}
                    role="presentation"
                >
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
                    <div
                        ref={addDialogRef}
                        className="relative my-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.08] bg-slate-900 p-5 shadow-2xl animate-in slide-in-from-bottom duration-200"
                        style={{
                            maxHeight: 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2rem)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="grocery-add-title"
                        aria-busy={isAdding}
                    >
                        <button
                            type="button"
                            onClick={closeAddDialog}
                            disabled={isAdding}
                            className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors"
                            aria-label="Cancel adding grocery item"
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 id="grocery-add-title" className="text-sm font-black text-white mb-4 pr-10">
                            ➕ Add to Shopping List
                        </h3>

                        {/* Item name */}
                        <label
                            htmlFor="grocery-add-name"
                            className="text-[11px] font-bold text-gray-500 uppercase tracking-widest"
                        >
                            Item Name
                        </label>
                        <input
                            id="grocery-add-name"
                            ref={addNameRef}
                            type="text"
                            value={addName}
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                            disabled={isAdding || !canManageShoppingList}
                            placeholder="Shampoo, dish soap, shackle pins..."
                            className="w-full mt-1 mb-3 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                        />

                        {/* Qty + Unit row */}
                        <div className="flex gap-2 mb-3">
                            <div className="flex-1">
                                <label
                                    htmlFor="grocery-add-quantity"
                                    className="text-[11px] font-bold text-gray-500 uppercase tracking-widest"
                                >
                                    Qty
                                </label>
                                <input
                                    id="grocery-add-quantity"
                                    type="number"
                                    inputMode="decimal"
                                    min="0.0001"
                                    step="any"
                                    value={addQty}
                                    onChange={(e) => {
                                        setAddQty(e.target.value);
                                        if (addQuantityInvalid) {
                                            setAddQuantityInvalid(false);
                                            setAddError(null);
                                        }
                                    }}
                                    disabled={isAdding || !canManageShoppingList}
                                    aria-invalid={addQuantityInvalid}
                                    aria-describedby={addQuantityInvalid ? 'grocery-add-error' : undefined}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-bold tabular-nums outline-none focus:border-emerald-500/50"
                                />
                            </div>
                            <div className="flex-1">
                                <label
                                    htmlFor="grocery-add-unit"
                                    className="text-[11px] font-bold text-gray-500 uppercase tracking-widest"
                                >
                                    Unit
                                </label>
                                <select
                                    id="grocery-add-unit"
                                    value={addUnit}
                                    onChange={(e) => setAddUnit(e.target.value)}
                                    disabled={isAdding || !canManageShoppingList}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-emerald-500/50 appearance-none"
                                >
                                    <option value="each">each</option>
                                    <option value="pack">pack</option>
                                    <option value="bottle">bottle</option>
                                    <option value="box">box</option>
                                    <option value="kg">kg</option>
                                    <option value="L">litres</option>
                                    <option value="m">metres</option>
                                    <option value="roll">roll</option>
                                    <option value="bag">bag</option>
                                    <option value="can">can</option>
                                    <option value="tube">tube</option>
                                </select>
                            </div>
                        </div>

                        {/* Zone picker */}
                        <fieldset>
                            <legend className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                                Aisle / Zone
                            </legend>
                            <div className="flex flex-wrap gap-1.5 mt-1 mb-4">
                                {ALL_ZONES.map((z) => (
                                    <button
                                        key={z}
                                        type="button"
                                        onClick={() => setAddZone(z)}
                                        disabled={isAdding || !canManageShoppingList}
                                        aria-pressed={addZone === z}
                                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${
                                            addZone === z
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'bg-white/[0.04] text-gray-500 border border-white/[0.06] hover:text-gray-300'
                                        }`}
                                    >
                                        {ZONE_EMOJI[z]} {z}
                                    </button>
                                ))}
                            </div>
                        </fieldset>

                        {addError && (
                            <p
                                id="grocery-add-error"
                                role="alert"
                                className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200"
                            >
                                {addError}
                            </p>
                        )}

                        {/* Add button */}
                        <button
                            type="button"
                            onClick={handleAddItem}
                            disabled={!addName.trim() || isAdding || !canManageShoppingList}
                            aria-label="Add item to grocery list"
                            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-[11px] font-black text-white uppercase tracking-widest active:scale-[0.97] disabled:opacity-30 transition-all"
                        >
                            {isAdding ? '⏳ Adding…' : '➕ Add to List'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
