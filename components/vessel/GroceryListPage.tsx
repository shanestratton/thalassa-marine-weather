/**
 * GroceryListPage — Full-page shopping list accessible from the Galley.
 *
 * Shows all shopping items grouped by aisle (Butcher, Produce…), each with its
 * line icon. Tap to mark as purchased → auto-inserts into Ship's Stores +
 * immediate sync. Prices are kept in each row's own currency for the voyage
 * budget.
 *
 * "Check off items as you walk the aisles — your crew sees updates instantly."
 *
 * The clean-up (132-B17, Shane 2026-10-15: "definitely needs a good clean
 * up"): Ship's Stores' recipe (components/vessel/InventoryList) for the
 * header, cards, group headings and the Add item bar; clear of the status bar
 * and the home indicator (GAL-10); prices in each row's currency, written the
 * phone's way, and quick picks from the shops this phone has used (GAL-09); a
 * list that cannot be read says so, apart from an empty one.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    getShoppingList,
    markPurchased,
    unmarkPurchased,
    addManualItem,
    recentRetailers,
    type ShoppingItem,
    type ShoppingListSummary,
    type MarketZone,
} from '../../services/ShoppingListService';
import { detectMarketZone } from '../../services/galley/marketZones';
import { toPurchasable } from '../../services/PurchaseUnits';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { OfflineBadge } from '../ui/OfflineBadge';
import { TapToAction } from '../ui/TapToAction';
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

import { groceryZoneIcon } from './groceryZoneIcons';
import { useBinderSource } from '../../hooks/useBinderSource';
import { SharedBinderLine, SKIPPER_BOAT_FALLBACK } from './SharedBinderLine';
import { CartIcon, CheckCircleIcon, CheckIcon, ClipboardIcon, ClockIcon, XIcon } from '../Icons';
import { createLogger, getErrorMessage } from '../../utils/createLogger';
import { currencyName, currencySymbol, formatMoney, formatSpend, spendByCurrency } from '../../utils/money';

// A device-log trace for each failure the page shows (GAL-13): a reason and
// the error message, never an item name or id.
const log = createLogger('Galley');

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

/**
 * The page covers the whole screen, the app's header and tab bar included, so
 * it clears the status bar and the Dynamic Island itself (GAL-10): with the
 * header's own 1rem, its top sits where App's header starts, max(1rem, inset).
 */
const SAFE_TOP = 'max(0px, calc(env(safe-area-inset-top) - 1rem))';
/** Its last row clears the home indicator (GAL-10); no tab bar shows under it. */
const SAFE_BOTTOM = 'max(0.75rem, env(safe-area-inset-bottom))';

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

/** The day it was bought, plainly: '10 Oct', with the year once it is not this one. */
function boughtDay(iso: string): string {
    const day = new Date(iso);
    if (Number.isNaN(day.getTime())) return '';
    return day.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        ...(day.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    });
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
    /** What a purchase, undo or add could not do. */
    const [pageError, setPageError] = useState<string | null>(null);
    /**
     * The list could not be read (132-B17): with nothing on screen yet, the
     * house LoadErrorState, never the empty list's words.
     */
    const [loadError, setLoadError] = useState(false);
    /** A quiet word after a tick in a shared galley that left Ship's Stores alone. */
    const [storesNote, setStoresNote] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [focusRequest, setFocusRequest] = useState(0);
    /** The shops this phone's purchases name, for the price sheet's quick picks (GAL-09). */
    const [recentShops, setRecentShops] = useState<string[]>([]);

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
    /**
     * The aisle the sailor tapped, or null while the name picks it (132-B17,
     * GAL-15): typing 'Eggplant' lights Produce, as a meal's eggplant goes
     * there. A tapped aisle stays put whatever the name becomes.
     */
    const [addZoneChoice, setAddZoneChoice] = useState<MarketZone | null>(null);
    const addZone = useMemo(() => addZoneChoice ?? detectMarketZone(addName), [addName, addZoneChoice]);
    const [isAdding, setIsAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const [addQuantityInvalid, setAddQuantityInvalid] = useState(false);
    const addNameRef = useRef<HTMLInputElement>(null);
    /** Holds the Add item bar: TapToAction takes no ref, and focus returns to its button. */
    const addBarRef = useRef<HTMLDivElement>(null);
    const listPanelRef = useRef<HTMLDivElement>(null);
    const focusListAfterMutationRef = useRef(false);

    const stateOwnsRenderedScope = loadedDataScopeKey === dataScopeKey && renderIdentityScope.userId === currentUserId;
    const visibleSummary = stateOwnsRenderedScope ? summary : null;
    const visiblePageError = stateOwnsRenderedScope ? pageError : null;
    const visibleLoadError = stateOwnsRenderedScope && loadError;
    const visibleStoresNote = stateOwnsRenderedScope ? storesNote : null;
    const visibleIsLoading = stateOwnsRenderedScope ? isLoading : true;
    const visibleRecentShops = stateOwnsRenderedScope ? recentShops : [];
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
            setLoadError(false);
            setPageError(null);
            setLoadedDataScopeKey(operationDataScopeKey);
        } catch (error) {
            log.warn('galley: load-list', getErrorMessage(error));
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setLoadError(true);
                setLoadedDataScopeKey(operationDataScopeKey);
            }
        } finally {
            if (operationIsCurrent(operationScope, operationDataScopeKey)) {
                setIsLoading(false);
            }
        }
        // The quick picks on their own: a failure here costs the chips, never the list.
        try {
            const shops = recentRetailers();
            if (operationIsCurrent(operationScope, operationDataScopeKey)) setRecentShops(shops);
        } catch (error) {
            log.warn('galley: recent-shops', getErrorMessage(error));
        }
    }, [currentUserId, dataScopeKey, operationIsCurrent, scopeOwnerUserId, scopeVoyageId]);

    const retryLoad = useCallback(() => {
        setIsLoading(true);
        loadList();
    }, [loadList]);

    // The grocery list kept with no passage is the galley's: the skipper's
    // while they share their galley (ShoppingListService filters and stamps).
    const { source: galley } = useBinderSource('galley', { reload: loadList });
    const galleyBoat = galley.mode === 'shared' ? (galley.vesselName ?? SKIPPER_BOAT_FALLBACK) : null;
    const storesSkippedNote = useCallback(
        (bought: boolean) =>
            `${bought ? 'Bought' : 'Back on the list'} — Ship's Stores on ${galleyBoat ?? SKIPPER_BOAT_FALLBACK} ${
                bought ? "isn't shared with you to edit, so it wasn't added there" : 'was left as it is'
            }.`,
        [galleyBoat],
    );

    useEffect(() => {
        setLoadedDataScopeKey(null);
        setSummary(null);
        setPageError(null);
        setLoadError(false);
        setStoresNote(null);
        setRecentShops([]);
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
        setAddZoneChoice(null);
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

    // One pass per visible list, not one per item per render: toPurchasable()
    // scans a 250-row keyword table and normalises every keyword it looks at.
    const purchaseLabels = useMemo(() => {
        const labels = new Map<string, ReturnType<typeof purchaseQuantityLabel>>();
        for (const zone of filteredZones) {
            for (const item of zone.items) labels.set(item.id, purchaseQuantityLabel(item));
        }
        return labels;
    }, [filteredZones]);

    // What was spent, per currency (GAL-09): rows in two currencies are never
    // added together, and the voyage's spend by aisle comes from the same rows.
    const spent = useMemo(
        () => spendByCurrency(visibleSummary?.zones.flatMap((zone) => zone.items) ?? []),
        [visibleSummary],
    );
    const spentByZone = useMemo(
        () =>
            (visibleSummary?.zones ?? [])
                .map((zone) => ({ zone: zone.zone, spend: spendByCurrency(zone.items) }))
                .filter((entry) => entry.spend.length > 0)
                .sort((a, b) => b.spend[0].total - a.spend[0].total),
        [visibleSummary],
    );

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
        setAddZoneChoice(null);
        setAddError(null);
        setAddQuantityInvalid(false);
    }, []);

    const closeAddDialog = useCallback(() => {
        if (isAdding) return;
        resetAddDialog();
    }, [isAdding, resetAddDialog]);

    const openAddDialog = useCallback(() => {
        if (!canManageShoppingList) return;
        setAddError(null);
        setAddQuantityInvalid(false);
        setShowAddForm(true);
    }, [canManageShoppingList]);

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
        (nextItem ?? addBarRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
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
        setStoresNote(null);
        try {
            const outcome = await markPurchased(purchasedItem.id, cost, store, scopeVoyageId, scopeOwnerUserId);
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            if (outcome?.storesSkipped) setStoresNote(storesSkippedNote(true));
            focusListAfterMutationRef.current = filter === 'remaining';
            resetPriceDialog();
            loadList();
            setFocusRequest((request) => request + 1);
        } catch (error) {
            log.warn('galley: purchase-confirm', getErrorMessage(error));
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
        storesSkippedNote,
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
        setStoresNote(null);
        try {
            const outcome = await markPurchased(
                purchasedItem.id,
                undefined,
                storeName.trim() || undefined,
                scopeVoyageId,
                scopeOwnerUserId,
            );
            if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
            if (outcome?.storesSkipped) setStoresNote(storesSkippedNote(true));
            focusListAfterMutationRef.current = filter === 'remaining';
            resetPriceDialog();
            loadList();
            setFocusRequest((request) => request + 1);
        } catch (error) {
            log.warn('galley: purchase-skip-price', getErrorMessage(error));
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
        storesSkippedNote,
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
            setStoresNote(null);
            triggerHaptic('light');
            try {
                const outcome = await unmarkPurchased(item.id, scopeVoyageId, scopeOwnerUserId);
                if (!operationIsCurrent(operationScope, operationDataScopeKey)) return;
                // The skipper's tick put it in Ship's Stores, which this crew
                // member may not edit: it stays bought, nothing queued.
                if (outcome?.needsStoresEditor) {
                    setStoresNote("Only someone who can edit Ship's Stores can put this back on the list.");
                } else if (outcome?.storesSkipped) {
                    setStoresNote(storesSkippedNote(false));
                }
                focusListAfterMutationRef.current = filter === 'purchased';
                loadList();
                setFocusRequest((request) => request + 1);
            } catch (error) {
                log.warn('galley: purchase-untick', getErrorMessage(error));
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
            storesSkippedNote,
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
        } catch (error) {
            log.warn('galley: add-item', getErrorMessage(error));
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

    const purchaseControlsDisabled = !!purchasingId || !permissionsLoadedForScope || !permissions.canEditStores;

    return (
        <div
            ref={pageDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Shopping list"
            className="fixed inset-0 z-1100 bg-slate-950 overflow-hidden slide-up-enter"
            style={{ paddingTop: SAFE_TOP }}
        >
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Grocery list"
                    onBack={onBack}
                    // Its place in the app, as its binder siblings show theirs:
                    // Boat Binder › Galley, and Back goes to the Galley.
                    breadcrumbs={['Boat Binder', 'Galley', 'Grocery list']}
                    status={
                        <>
                            <OfflineBadge />
                            {scopeVoyageId === null && <SharedBinderLine register="galley" source={galley} />}
                        </>
                    }
                    subtitle={
                        visibleSummary ? (
                            // Ship's Stores' bold tracked count. Each count is one
                            // unbreakable unit and the '·' binds to the one before
                            // it, so a wrap never starts a line with it.
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                                <span className="whitespace-nowrap tabular-nums">
                                    {visibleSummary.remaining} to buy&nbsp;·
                                </span>{' '}
                                <span className="whitespace-nowrap tabular-nums">
                                    {visibleSummary.purchased} bought
                                    {spent.length > 0 && <>&nbsp;·</>}
                                </span>
                                {spent.length > 0 && (
                                    <>
                                        {' '}
                                        {/* Each amount whole; the line may break between currencies. */}
                                        <span className="tabular-nums text-emerald-400">
                                            {spent.map((entry, i) => (
                                                <React.Fragment key={entry.currency}>
                                                    {i > 0 && ' + '}
                                                    <span className="whitespace-nowrap">
                                                        {formatMoney(entry.total, entry.currency)}
                                                    </span>
                                                </React.Fragment>
                                            ))}{' '}
                                            spent
                                        </span>
                                    </>
                                )}
                            </p>
                        ) : visibleIsLoading ? (
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">Loading…</p>
                        ) : undefined
                    }
                />

                {/* Filter tabs */}
                <div
                    className="shrink-0 flex border-b border-white/6"
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
                            // The house tab accent and line icons, like the Galley tabs it
                            // opens from (UX scorecard run 7: 🛒 ✅ 📋 were emoji).
                            className={`min-h-[44px] flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                                filter === f
                                    ? 'text-sky-400 border-b-2 border-sky-400'
                                    : 'text-gray-400 hover:text-gray-200'
                            }`}
                        >
                            <span className="inline-flex items-center justify-center gap-1.5 tabular-nums">
                                {f === 'remaining' ? (
                                    <>
                                        <CartIcon className="h-3.5 w-3.5 shrink-0" />
                                        Need ({visibleSummary?.remaining ?? 0})
                                    </>
                                ) : f === 'purchased' ? (
                                    <>
                                        <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                                        Done ({visibleSummary?.purchased ?? 0})
                                    </>
                                ) : (
                                    <>
                                        <ClipboardIcon className="h-3.5 w-3.5 shrink-0" />
                                        All ({visibleSummary?.total ?? 0})
                                    </>
                                )}
                            </span>
                        </button>
                    ))}
                </div>

                {visibleSummary && visibleLoadError && (
                    // A reload that failed with the list already on screen: the
                    // list stays, and says it may be behind.
                    <div
                        role="alert"
                        className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 py-1 pl-3 pr-1 text-xs font-semibold text-red-200"
                    >
                        <span className="min-w-0 flex-1">
                            The grocery list could not be refreshed, so it may be out of date.
                        </span>
                        <button
                            type="button"
                            onClick={retryLoad}
                            className="min-h-[44px] shrink-0 rounded-lg px-3 font-bold text-red-100 hover:bg-red-500/10"
                        >
                            Try again
                        </button>
                    </div>
                )}

                {visiblePageError && (
                    <div
                        role="alert"
                        className="mx-4 mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200"
                    >
                        {visiblePageError}
                    </div>
                )}

                {visibleStoresNote && (
                    <p
                        role="status"
                        className="mx-4 mt-3 rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-xs font-semibold text-gray-300"
                    >
                        {visibleStoresNote}
                    </p>
                )}

                {!permissionsLoadedForScope ? (
                    <div
                        id="grocery-permission-note"
                        role="status"
                        className="mx-4 mt-3 rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs font-semibold text-amber-100"
                    >
                        Checking your grocery access. Purchase, undo, and list-edit actions are unavailable for now.
                    </div>
                ) : !permissions.canEditStores ? (
                    <div
                        id="grocery-permission-note"
                        role="note"
                        className="mx-4 mt-3 rounded-xl border border-sky-500/20 bg-sky-500/8 px-3 py-2 text-xs font-semibold text-sky-100"
                    >
                        Ship&apos;s Stores are read-only. Only the skipper or crew with Stores edit access can record or
                        undo purchases.
                        {canManageShoppingList
                            ? ' You can still add items to the shopping list.'
                            : ' Ask the skipper for Galley or Stores access to edit this list.'}
                    </div>
                ) : null}

                {/* Item list: Ship's Stores' scroller, group headings and cards */}
                <div
                    ref={listPanelRef}
                    id="grocery-filter-panel"
                    role="tabpanel"
                    aria-labelledby={`grocery-filter-${filter}`}
                    className="flex-1 overflow-y-auto px-4 pt-3 pb-4 min-h-0 space-y-4 no-scrollbar"
                >
                    {!visibleSummary ? (
                        visibleIsLoading ? (
                            <div role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                                Loading the grocery list…
                            </div>
                        ) : (
                            // Not the empty list's words: nothing says the list is
                            // empty when it could not be read (132-B17).
                            <LoadErrorState
                                what="the grocery list"
                                onRetry={retryLoad}
                                description="This is a loading problem, not an empty list. Nothing has been removed. Try again."
                            />
                        )
                    ) : visibleSummary.total === 0 ? (
                        <EmptyState
                            icon={<CartIcon className="h-8 w-8" />}
                            title="No grocery items yet"
                            subtitle="Tap Add item below, or add missing ingredients from the Meal Calendar."
                            className="py-16"
                        />
                    ) : filteredZones.length === 0 ? (
                        <EmptyState
                            icon={<CheckCircleIcon className="h-8 w-8" />}
                            title={filter === 'remaining' ? 'All done' : 'No purchased items'}
                            subtitle={
                                filter === 'remaining'
                                    ? "All items have been purchased and added to Ship's Stores"
                                    : 'Items will appear here once purchased'
                            }
                            className="py-16"
                        />
                    ) : (
                        filteredZones.map((zone) => {
                            const ZoneIcon = groceryZoneIcon(zone.zone);
                            const headingId = `grocery-zone-${zone.zone.replace(/\s+/g, '-').toLowerCase()}`;
                            return (
                                <section key={zone.zone} aria-labelledby={headingId}>
                                    {/* The aisle: its line icon, name and count, as Stores' categories */}
                                    <h2 id={headingId} className="flex items-center gap-2 mb-2">
                                        <ZoneIcon className="h-4 w-4 shrink-0 text-gray-400" />
                                        <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                            {zone.zone}
                                        </span>
                                        <span className="text-micro text-gray-400 font-bold tabular-nums">
                                            ({zone.items.length})
                                        </span>
                                    </h2>

                                    <ul className="space-y-2">
                                        {zone.items.map((item) => {
                                            const purchaseQuantity =
                                                purchaseLabels.get(item.id) ?? purchaseQuantityLabel(item);
                                            const isPurchasing = purchasingId === item.id;
                                            const hasCost =
                                                typeof item.actual_cost === 'number' &&
                                                Number.isFinite(item.actual_cost);

                                            return (
                                                <li
                                                    key={item.id}
                                                    className={`flex items-center gap-2 rounded-lg border py-1 pl-1 pr-3 transition-colors ${
                                                        item.purchased
                                                            ? 'bg-emerald-500/5 border-emerald-500/10'
                                                            : 'bg-slate-800/40 border-white/5'
                                                    }`}
                                                >
                                                    {/* The tick: a whole 44 pt button around its box */}
                                                    <button
                                                        type="button"
                                                        data-grocery-item-action
                                                        onClick={() =>
                                                            item.purchased ? handleUntick(item) : handleCheckbox(item)
                                                        }
                                                        disabled={purchaseControlsDisabled}
                                                        aria-describedby={
                                                            !permissionsLoadedForScope || !permissions.canEditStores
                                                                ? 'grocery-permission-note'
                                                                : undefined
                                                        }
                                                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-transform active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
                                                        aria-label={
                                                            item.purchased
                                                                ? `Undo ${item.ingredient_name}`
                                                                : `Mark ${item.ingredient_name} as purchased`
                                                        }
                                                    >
                                                        <span
                                                            aria-hidden="true"
                                                            className={`flex h-6 w-6 items-center justify-center rounded-md border-2 transition-colors ${
                                                                item.purchased
                                                                    ? 'bg-emerald-500 border-emerald-500 text-slate-950'
                                                                    : isPurchasing
                                                                      ? 'border-amber-400 animate-pulse'
                                                                      : 'border-gray-500'
                                                            }`}
                                                        >
                                                            {item.purchased && <CheckIcon className="h-3.5 w-3.5" />}
                                                            {isPurchasing && (
                                                                <ClockIcon className="h-3 w-3 text-gray-400" />
                                                            )}
                                                        </span>
                                                    </button>

                                                    {/* Name + purchase info: wraps, never clipped */}
                                                    <div className="min-w-0 flex-1 py-1.5">
                                                        <p
                                                            className={`text-sm font-bold [overflow-wrap:anywhere] ${
                                                                item.purchased
                                                                    ? 'text-gray-400 line-through'
                                                                    : 'text-white'
                                                            }`}
                                                        >
                                                            {item.ingredient_name}
                                                        </p>
                                                        {item.purchased && item.purchased_at && (
                                                            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-label text-emerald-300/90">
                                                                <CheckIcon className="h-3 w-3 shrink-0" />
                                                                <span>{boughtDay(item.purchased_at)}</span>
                                                                {item.purchase_retailer && (
                                                                    <span className="[overflow-wrap:anywhere]">
                                                                        · {item.purchase_retailer}
                                                                    </span>
                                                                )}
                                                                {hasCost && (
                                                                    <span className="whitespace-nowrap tabular-nums">
                                                                        ·{' '}
                                                                        {formatMoney(item.actual_cost!, item.currency)}
                                                                    </span>
                                                                )}
                                                            </p>
                                                        )}
                                                    </div>

                                                    {/* What to buy, and what the meals need when that differs */}
                                                    <div className="max-w-[45%] shrink-0 text-right">
                                                        <p
                                                            className={`text-sm font-black tabular-nums ${
                                                                item.purchased ? 'text-gray-400' : 'text-emerald-300'
                                                            }`}
                                                        >
                                                            {purchaseQuantity.primary}
                                                        </p>
                                                        {purchaseQuantity.required && (
                                                            <p className="text-label text-gray-400 tabular-nums">
                                                                need {purchaseQuantity.required}
                                                            </p>
                                                        )}
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            );
                        })
                    )}

                    {/* Voyage spend, per aisle, at the end of the list: it scrolls
                        with the list instead of taking a phone's height from it. */}
                    {visibleSummary && scopeVoyageId && spent.length > 0 && (
                        <section
                            aria-labelledby="grocery-voyage-spend"
                            className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3"
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <h2
                                    id="grocery-voyage-spend"
                                    className="text-label font-black uppercase tracking-widest text-emerald-400"
                                >
                                    Voyage spend
                                </h2>
                                <p className="text-sm font-black tabular-nums text-emerald-300">{formatSpend(spent)}</p>
                            </div>
                            <ul className="mt-2 space-y-1">
                                {spentByZone.map(({ zone, spend }) => {
                                    const ZoneIcon = groceryZoneIcon(zone);
                                    return (
                                        <li key={zone} className="flex items-center gap-2 text-label text-gray-400">
                                            <ZoneIcon className="h-3.5 w-3.5 shrink-0" />
                                            <span className="min-w-0 flex-1">{zone}</span>
                                            <span className="text-right font-bold tabular-nums text-gray-300">
                                                {formatSpend(spend)}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )}
                </div>

                {/* Progress and Add item, Ship's Stores' bottom bar in place of a
                    floating button that sat over the list's last row. */}
                {visibleSummary && (
                    <div
                        className="shrink-0 space-y-3 border-t border-white/6 bg-slate-950 px-4 pt-3"
                        style={{ paddingBottom: SAFE_BOTTOM }}
                    >
                        {visibleSummary.total > 0 && (
                            <div className="flex items-center gap-3">
                                <div
                                    className="flex-1 h-2 bg-white/6 rounded-full overflow-hidden"
                                    role="progressbar"
                                    aria-label="Shopping progress"
                                    aria-valuemin={0}
                                    aria-valuemax={visibleSummary.total}
                                    aria-valuenow={visibleSummary.purchased}
                                    aria-valuetext={`${visibleSummary.purchased} of ${visibleSummary.total} items purchased`}
                                >
                                    <div
                                        className="h-full bg-linear-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                        style={{
                                            width: `${Math.round(
                                                (visibleSummary.purchased / visibleSummary.total) * 100,
                                            )}%`,
                                        }}
                                    />
                                </div>
                                <span className="text-label font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                                    {visibleSummary.purchased}/{visibleSummary.total}
                                </span>
                            </div>
                        )}
                        <div ref={addBarRef}>
                            <TapToAction
                                label="Add item"
                                icon={
                                    <svg
                                        className="w-4 h-4"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                    </svg>
                                }
                                onConfirm={openAddDialog}
                                disabled={!!purchasingId || !canManageShoppingList}
                                theme="emerald"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ Price Input Modal ═══ */}
            {stateOwnsRenderedScope && priceItem && (
                <div
                    className="fixed inset-0 z-1200 flex items-start justify-center overflow-y-auto overscroll-contain p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom)+1rem)] sm:items-center"
                    onClick={closePriceDialog}
                    role="presentation"
                >
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" aria-hidden="true" />
                    <div
                        ref={priceDialogRef}
                        className="relative my-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-white/8 bg-slate-900 p-5 shadow-2xl animate-in slide-in-from-bottom duration-200"
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
                            <XIcon className="w-5 h-5 text-gray-400" />
                        </button>
                        <h3 id="grocery-purchase-title" className="text-sm font-black text-white mb-1 pr-10">
                            Mark as purchased
                        </h3>
                        <p id="grocery-purchase-item" className="text-xs text-gray-400 mb-4 [overflow-wrap:anywhere]">
                            {priceItem.ingredient_name}
                        </p>
                        <p className="mb-4 rounded-lg border border-emerald-500/15 bg-emerald-500/6 px-3 py-2 text-xs text-emerald-200">
                            Adds {(purchaseLabels.get(priceItem.id) ?? purchaseQuantityLabel(priceItem)).primary} to
                            Ship&apos;s Stores.
                        </p>

                        {/* Price, in the row's own currency: a stored row keeps
                            the one it was added in (GAL-09). */}
                        <label
                            htmlFor="grocery-purchase-price"
                            className="text-[11px] font-bold text-gray-400 uppercase tracking-widest"
                        >
                            Price (optional)
                        </label>
                        <div className="flex items-center gap-2 mt-1 mb-4">
                            <span aria-hidden="true" className="text-lg font-bold text-gray-400">
                                {currencySymbol(priceItem.currency)}
                            </span>
                            <span id="grocery-purchase-currency" className="sr-only">
                                In {currencyName(priceItem.currency)}
                            </span>
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
                                disabled={purchaseControlsDisabled}
                                aria-invalid={priceInvalid}
                                aria-describedby={
                                    priceError
                                        ? 'grocery-purchase-currency grocery-purchase-error'
                                        : 'grocery-purchase-currency'
                                }
                                placeholder="0.00"
                                className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-lg font-bold tabular-nums outline-hidden focus:border-emerald-500/50 transition-colors placeholder-gray-500"
                            />
                        </div>

                        {/* The shop, with quick picks from the shops used lately */}
                        <label
                            htmlFor="grocery-purchase-store"
                            className="text-[11px] font-bold text-gray-400 uppercase tracking-widest"
                        >
                            Shop (optional)
                        </label>
                        <input
                            id="grocery-purchase-store"
                            type="text"
                            value={storeName}
                            onChange={(e) => setStoreName(e.target.value)}
                            disabled={purchaseControlsDisabled}
                            placeholder="Where did you buy it?"
                            className={`w-full mt-1 ${visibleRecentShops.length > 0 ? '' : 'mb-4'} bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-hidden focus:border-emerald-500/50 transition-colors placeholder-gray-500`}
                        />
                        {visibleRecentShops.length > 0 && (
                            <div
                                className="flex flex-wrap gap-1.5 mt-2 mb-4"
                                role="group"
                                aria-label="Shops used lately"
                            >
                                {visibleRecentShops.map((shop) => (
                                    <button
                                        key={shop}
                                        type="button"
                                        onClick={() => setStoreName(shop)}
                                        disabled={purchaseControlsDisabled}
                                        aria-pressed={storeName === shop}
                                        className={`min-h-[44px] max-w-full px-3 py-1 rounded-lg text-xs font-bold transition-all active:scale-95 [overflow-wrap:anywhere] ${
                                            storeName === shop
                                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                : 'bg-white/4 text-gray-300 border border-white/6 hover:text-white'
                                        }`}
                                    >
                                        {shop}
                                    </button>
                                ))}
                            </div>
                        )}

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
                                disabled={purchaseControlsDisabled}
                                aria-label={`Skip price and mark ${priceItem.ingredient_name} as purchased`}
                                className="flex-1 min-h-[44px] py-3 rounded-xl bg-white/5 border border-white/8 text-sm font-bold text-gray-300 active:scale-[0.97] disabled:opacity-40"
                            >
                                Skip price
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmPurchase}
                                disabled={purchaseControlsDisabled}
                                aria-label={`Confirm purchase of ${priceItem.ingredient_name}`}
                                className="flex-1 min-h-[44px] py-3 rounded-xl bg-linear-to-r from-emerald-600 to-emerald-500 text-sm font-black text-white active:scale-[0.97] disabled:opacity-40"
                            >
                                {purchasingId ? 'Saving…' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ Add Item Modal ═══ */}
            {stateOwnsRenderedScope && showAddForm && (
                <div
                    className="fixed inset-0 z-1200 flex items-start justify-center overflow-y-auto overscroll-contain p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
                    onClick={closeAddDialog}
                    role="presentation"
                >
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" aria-hidden="true" />
                    <div
                        ref={addDialogRef}
                        className="relative my-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-white/8 bg-slate-900 p-5 shadow-2xl animate-in slide-in-from-bottom duration-200"
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
                            <XIcon className="w-5 h-5 text-gray-400" />
                        </button>
                        <h3 id="grocery-add-title" className="text-sm font-black text-white mb-4 pr-10">
                            Add to shopping list
                        </h3>

                        {/* Item name */}
                        <label
                            htmlFor="grocery-add-name"
                            className="text-[11px] font-bold text-gray-400 uppercase tracking-widest"
                        >
                            Item name
                        </label>
                        <input
                            id="grocery-add-name"
                            ref={addNameRef}
                            type="text"
                            value={addName}
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                            disabled={isAdding || !canManageShoppingList}
                            placeholder="Shampoo, dish soap, shackle pins…"
                            className="w-full mt-1 mb-3 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-hidden focus:border-emerald-500/50 transition-colors placeholder-gray-500"
                        />

                        {/* Quantity + Unit row */}
                        <div className="flex gap-2 mb-3">
                            <div className="min-w-0 flex-1">
                                <label
                                    htmlFor="grocery-add-quantity"
                                    className="text-[11px] font-bold text-gray-400 uppercase tracking-widest"
                                >
                                    Quantity
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
                                    className="w-full min-h-[44px] mt-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-bold tabular-nums outline-hidden focus:border-emerald-500/50"
                                />
                            </div>
                            <div className="min-w-0 flex-1">
                                <label
                                    htmlFor="grocery-add-unit"
                                    className="text-[11px] font-bold text-gray-400 uppercase tracking-widest"
                                >
                                    Unit
                                </label>
                                <select
                                    id="grocery-add-unit"
                                    value={addUnit}
                                    onChange={(e) => setAddUnit(e.target.value)}
                                    disabled={isAdding || !canManageShoppingList}
                                    className="thalassa-select w-full min-h-[44px] mt-1 bg-black/40 border border-white/10 rounded-xl pl-3 pr-9 py-2.5 text-white text-sm outline-hidden focus:border-emerald-500/50 appearance-none"
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

                        {/* Aisle picker: the same line icons as the list's headings */}
                        <fieldset>
                            <legend className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">
                                Aisle
                            </legend>
                            <div className="flex flex-wrap gap-1.5 mt-1 mb-4">
                                {ALL_ZONES.map((z) => {
                                    const ZoneIcon = groceryZoneIcon(z);
                                    return (
                                        <button
                                            key={z}
                                            type="button"
                                            onClick={() => setAddZoneChoice(z)}
                                            disabled={isAdding || !canManageShoppingList}
                                            aria-pressed={addZone === z}
                                            className={`inline-flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
                                                addZone === z
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                    : 'bg-white/4 text-gray-300 border border-white/6 hover:text-white'
                                            }`}
                                        >
                                            <ZoneIcon className="h-3.5 w-3.5 shrink-0" />
                                            {z}
                                        </button>
                                    );
                                })}
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
                            className="w-full min-h-[44px] py-3 rounded-xl bg-linear-to-r from-emerald-600 to-emerald-500 text-sm font-black text-white active:scale-[0.97] disabled:opacity-30 transition-all"
                        >
                            {isAdding ? 'Adding…' : 'Add to list'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
