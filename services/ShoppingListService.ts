/**
 * ShoppingListService — Smart Shopping List from Shortfalls.
 *
 * Features:
 *  1. Pulls from PassageProvisionsService shortfall calculations
 *  2. Groups items by Market Zone (Butcher, Produce, Bottle Shop, Chandlery)
 *  3. "Purchased" action: inserts into Ship's Stores via LocalDatabase + immediate sync
 *  4. Price tracking for voyage budget
 *
 * "Don't buy the same brisket at a different shop!" — sync immediately.
 */

import {
    getAll,
    query,
    insertLocal,
    updateLocal,
    deleteLocal,
    bulkUpsert,
    bulkDelete,
    generateUUID,
} from './vessel/LocalDatabase';
import { syncNow } from './vessel/SyncService';
import { type ProvisionItem } from './PassageProvisionsService';
import { getCachedActiveVoyage } from './VoyageService';
import { triggerHaptic } from '../utils/system';
import { convertQuantity, toPurchasable } from './PurchaseUnits';

// ── Types ──────────────────────────────────────────────────────────────────

export type MarketZone =
    | 'Butcher'
    | 'Produce'
    | 'Bottle Shop'
    | 'Bakery'
    | 'Dairy'
    | 'Chandlery'
    | 'Fuel Dock'
    | 'Pharmacy'
    | 'General';

export interface ShoppingItem {
    id: string;
    /** Vessel/captain owner. Missing only on legacy local rows awaiting reconciliation. */
    user_id?: string | null;
    ingredient_name: string;
    required_qty: number;
    unit: string;
    market_zone: MarketZone;
    actual_cost: number | null;
    currency: string;
    purchased: boolean;
    purchased_at: string | null;
    /** Retailer where the purchase was made. Missing on legacy rows. */
    purchase_retailer?: string | null;
    /** Canonical quantity added to Ship's Stores. Missing on legacy rows. */
    purchased_quantity?: number | null;
    /** Canonical unit added to Ship's Stores. Missing on legacy rows. */
    purchased_unit?: string | null;
    /** Monotonic server-checked purchase transition revision. */
    purchase_revision?: number;
    /** Idempotency key for the current purchase/undo transition. */
    purchase_operation_id?: string | null;
    /** Onboard storage zone, never the retailer name. */
    store_location: string;
    provision_id: string | null;
    voyage_id: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface ShoppingListSummary {
    total: number;
    purchased: number;
    remaining: number;
    totalCost: number;
    currency: string;
    zones: { zone: MarketZone; items: ShoppingItem[] }[];
}

// ── Market Zone Detection ──────────────────────────────────────────────────

const ZONE_KEYWORDS: Record<MarketZone, string[]> = {
    Butcher: [
        'beef',
        'chicken',
        'pork',
        'lamb',
        'sausage',
        'mince',
        'steak',
        'brisket',
        'bacon',
        'ham',
        'turkey',
        'veal',
        'meat',
        'fish',
        'prawn',
        'shrimp',
        'crab',
        'lobster',
        'salmon',
        'tuna',
        'snapper',
    ],
    Produce: [
        'onion',
        'garlic',
        'tomato',
        'potato',
        'carrot',
        'lettuce',
        'spinach',
        'capsicum',
        'pepper',
        'mushroom',
        'broccoli',
        'corn',
        'avocado',
        'lime',
        'lemon',
        'apple',
        'banana',
        'orange',
        'mango',
        'herb',
        'basil',
        'parsley',
        'cilantro',
        'coriander',
        'ginger',
        'chilli',
    ],
    'Bottle Shop': [
        'wine',
        'beer',
        'rum',
        'vodka',
        'whisky',
        'whiskey',
        'gin',
        'tequila',
        'champagne',
        'prosecco',
        'cider',
        'spirit',
        'liqueur',
        'bourbon',
    ],
    Bakery: ['bread', 'roll', 'baguette', 'croissant', 'flour', 'yeast', 'pastry'],
    Dairy: ['milk', 'cheese', 'butter', 'cream', 'yoghurt', 'yogurt', 'egg'],
    Chandlery: [
        'rope',
        'shackle',
        'block',
        'sail',
        'tape',
        'epoxy',
        'antifoul',
        'winch',
        'grease',
        'filter',
        'impeller',
        'zinc',
        'anode',
        'fuse',
    ],
    'Fuel Dock': ['diesel', 'petrol', 'gas', 'propane', 'lpg', 'fuel'],
    Pharmacy: [
        'paracetamol',
        'ibuprofen',
        'bandage',
        'antiseptic',
        'sunscreen',
        'seasick',
        'dramamine',
        'antihistamine',
    ],
    General: [],
};

function detectMarketZone(ingredientName: string): MarketZone {
    const lower = ingredientName.toLowerCase();
    for (const [zone, keywords] of Object.entries(ZONE_KEYWORDS) as [MarketZone, string[]][]) {
        if (zone === 'General') continue;
        for (const kw of keywords) {
            if (lower.includes(kw)) return zone;
        }
    }
    return 'General';
}

// ── Service ────────────────────────────────────────────────────────────────

const TABLE = 'shopping_list';
const INVENTORY_TABLE = 'inventory_items';
const PURCHASE_RECEIPT_PREFIX = '[[thalassa:grocery-purchase:';
const PURCHASE_RECEIPT_SUFFIX = ']]';
const itemMutationQueues = new Map<string, Promise<void>>();

interface PurchaseReceipt {
    version: 1 | 2;
    inventoryItemId: string;
    quantity: number;
    unit: string;
    provenance: string;
    retailer?: string | null;
    actualCost?: number | null;
    currency?: string;
    packageCount?: number;
    packageLabel?: string;
}

interface InventoryEntry {
    id: string;
    /** Vessel/captain owner. Missing only on legacy local receipts. */
    user_id?: string | null;
    item_name: string;
    description?: string | null;
    category?: string;
    quantity: number;
    min_quantity?: number;
    unit: string;
    location_zone?: string;
    location_specific?: string;
    unit_value?: number;
    currency?: string;
    created_at?: string;
    updated_at?: string;
}

interface InventoryPurchase {
    quantity: number;
    unit: string;
    packageCount: number;
    packageLabel: string;
}

function inventoryQuantity(requiredQty: number): number {
    if (!Number.isFinite(requiredQty) || requiredQty <= 0) {
        throw new RangeError('Shopping item quantity must be a finite number greater than zero.');
    }
    return requiredQty;
}

function normalizeUnit(unit: string): string {
    return unit.trim().replace(/\s+/g, ' ').toLowerCase();
}

function inventoryPurchaseFor(item: ShoppingItem): InventoryPurchase {
    const purchasable = toPurchasable(item.ingredient_name, item.required_qty, item.unit);
    if (purchasable.matched) {
        return {
            quantity: inventoryQuantity(purchasable.inventoryQuantity),
            unit: purchasable.inventoryUnit.trim(),
            packageCount: purchasable.packageCount,
            packageLabel: purchasable.packageLabel.trim(),
        };
    }

    return {
        quantity: inventoryQuantity(item.required_qty),
        unit: item.unit.trim() || 'each',
        packageCount: 1,
        packageLabel: `${item.required_qty} ${item.unit.trim() || 'each'}`,
    };
}

function recordedInventoryPurchaseFor(item: ShoppingItem): InventoryPurchase {
    const derived = inventoryPurchaseFor(item);
    if (
        typeof item.purchased_quantity === 'number' &&
        Number.isFinite(item.purchased_quantity) &&
        item.purchased_quantity > 0 &&
        item.purchased_unit?.trim()
    ) {
        return {
            ...derived,
            quantity: item.purchased_quantity,
            unit: item.purchased_unit.trim(),
        };
    }
    return derived;
}

function nextPurchaseRevision(item: ShoppingItem): number {
    const current =
        Number.isSafeInteger(item.purchase_revision) && (item.purchase_revision ?? 0) >= 0
            ? item.purchase_revision!
            : 0;
    return current + 1;
}

function purchaseProvenance(shoppingItemId: string): string {
    return `Added from Grocery List purchase ${shoppingItemId}`;
}

function reversedPurchaseProvenance(shoppingItemId: string): string {
    return `Stock retained after undoing Grocery List purchase ${shoppingItemId}`;
}

function stripPurchaseReceipt(notes: string | null): string | null {
    if (!notes) return null;
    const markerStart = notes.lastIndexOf(PURCHASE_RECEIPT_PREFIX);
    if (markerStart < 0 || !notes.trimEnd().endsWith(PURCHASE_RECEIPT_SUFFIX)) return notes;

    const preserved = notes.slice(0, markerStart).trimEnd();
    return preserved || null;
}

function readPurchaseReceipt(notes: string | null): PurchaseReceipt | null {
    if (!notes) return null;
    const markerStart = notes.lastIndexOf(PURCHASE_RECEIPT_PREFIX);
    if (markerStart < 0) return null;

    const jsonStart = markerStart + PURCHASE_RECEIPT_PREFIX.length;
    const trimmed = notes.trimEnd();
    if (!trimmed.endsWith(PURCHASE_RECEIPT_SUFFIX)) return null;

    try {
        const parsed = JSON.parse(
            trimmed.slice(jsonStart, -PURCHASE_RECEIPT_SUFFIX.length),
        ) as Partial<PurchaseReceipt>;
        if (
            (parsed.version !== 1 && parsed.version !== 2) ||
            typeof parsed.inventoryItemId !== 'string' ||
            !parsed.inventoryItemId ||
            typeof parsed.quantity !== 'number' ||
            !Number.isFinite(parsed.quantity) ||
            parsed.quantity <= 0 ||
            typeof parsed.unit !== 'string' ||
            !parsed.unit ||
            typeof parsed.provenance !== 'string' ||
            !parsed.provenance ||
            (parsed.retailer !== undefined && parsed.retailer !== null && typeof parsed.retailer !== 'string') ||
            (parsed.actualCost !== undefined &&
                parsed.actualCost !== null &&
                (typeof parsed.actualCost !== 'number' || !Number.isFinite(parsed.actualCost))) ||
            (parsed.currency !== undefined && typeof parsed.currency !== 'string') ||
            (parsed.packageCount !== undefined &&
                (typeof parsed.packageCount !== 'number' ||
                    !Number.isFinite(parsed.packageCount) ||
                    parsed.packageCount <= 0)) ||
            (parsed.packageLabel !== undefined && typeof parsed.packageLabel !== 'string')
        ) {
            return null;
        }
        return parsed as PurchaseReceipt;
    } catch {
        return null;
    }
}

function writePurchaseReceipt(notes: string | null, receipt: PurchaseReceipt): string {
    const preserved = stripPurchaseReceipt(notes);
    const marker = `${PURCHASE_RECEIPT_PREFIX}${JSON.stringify(receipt)}${PURCHASE_RECEIPT_SUFFIX}`;
    return preserved ? `${preserved}\n${marker}` : marker;
}

function quantitiesEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9;
}

async function ensureInventoryReceipt(
    item: ShoppingItem,
    purchase: InventoryPurchase,
    receipt: PurchaseReceipt,
): Promise<void> {
    const existing = query<InventoryEntry>(INVENTORY_TABLE, (candidate) => candidate.id === receipt.inventoryItemId)[0];
    const ownerUserId = item.user_id?.trim() || null;
    if (item.voyage_id && !ownerUserId) {
        throw new Error('The Grocery List receipt has no verified vessel owner.');
    }
    const onboardLocation = item.store_location.trim() || 'Galley';
    const unitValue =
        receipt.actualCost === null || receipt.actualCost === undefined ? 0 : receipt.actualCost / purchase.quantity;

    if (!existing) {
        const now = new Date().toISOString();
        await bulkUpsert(INVENTORY_TABLE, [
            {
                id: receipt.inventoryItemId,
                user_id: ownerUserId,
                description: receipt.provenance,
                item_name: item.ingredient_name,
                category: 'Provisions',
                quantity: purchase.quantity,
                min_quantity: 0,
                unit: purchase.unit,
                location_zone: onboardLocation,
                location_specific: '',
                unit_value: unitValue,
                currency: item.currency,
                created_at: now,
                updated_at: now,
            } satisfies InventoryEntry,
        ]);
        return;
    }

    if (
        existing.description === reversedPurchaseProvenance(item.id) &&
        existing.item_name.trim().toLowerCase() === item.ingredient_name.trim().toLowerCase() &&
        (!ownerUserId || !existing.user_id || existing.user_id === ownerUserId)
    ) {
        const addedQuantity = convertQuantity(purchase.quantity, purchase.unit, existing.unit);
        if (addedQuantity === null) {
            throw new Error('The retained Grocery List stock uses an incompatible unit.');
        }
        await bulkUpsert(INVENTORY_TABLE, [
            {
                ...existing,
                user_id: ownerUserId ?? existing.user_id,
                description: receipt.provenance,
                quantity: existing.quantity + addedQuantity,
                category: 'Provisions',
                min_quantity: 0,
                location_zone: existing.location_zone?.trim() || onboardLocation,
                unit_value: unitValue,
                currency: item.currency,
                updated_at: new Date().toISOString(),
            },
        ]);
        return;
    }

    if (
        existing.description !== receipt.provenance ||
        existing.item_name.trim().toLowerCase() !== item.ingredient_name.trim().toLowerCase() ||
        (ownerUserId && existing.user_id && existing.user_id !== ownerUserId)
    ) {
        throw new Error('The inventory receipt ID is already used by another stores item.');
    }

    const canonicalQuantityMatches =
        normalizeUnit(existing.unit) === normalizeUnit(purchase.unit) &&
        quantitiesEqual(existing.quantity, purchase.quantity);
    const legacyPackageMatches =
        normalizeUnit(existing.unit) === normalizeUnit(purchase.packageLabel) &&
        quantitiesEqual(existing.quantity, purchase.packageCount);

    if (!canonicalQuantityMatches && !legacyPackageMatches) {
        throw new Error('The Grocery List inventory receipt was changed and cannot be repaired safely.');
    }

    const existingLocation = existing.location_zone?.trim() ?? '';
    const legacyRetailerLocation =
        !!receipt.retailer && normalizeUnit(existingLocation) === normalizeUnit(receipt.retailer);
    const repairedLocation = !existingLocation || legacyRetailerLocation ? onboardLocation : existing.location_zone;
    const needsRepair =
        legacyPackageMatches ||
        existing.category !== 'Provisions' ||
        existing.min_quantity !== 0 ||
        repairedLocation !== existing.location_zone ||
        !quantitiesEqual(existing.unit_value ?? 0, unitValue) ||
        existing.currency !== item.currency ||
        (!!ownerUserId && existing.user_id !== ownerUserId);

    if (needsRepair) {
        await bulkUpsert(INVENTORY_TABLE, [
            {
                ...existing,
                user_id: ownerUserId ?? existing.user_id,
                category: 'Provisions',
                quantity: purchase.quantity,
                min_quantity: 0,
                unit: purchase.unit,
                location_zone: repairedLocation,
                unit_value: unitValue,
                currency: item.currency,
                updated_at: new Date().toISOString(),
            },
        ]);
    }
}

function receiptForUndo(item: ShoppingItem): PurchaseReceipt {
    const stored = readPurchaseReceipt(item.notes);
    if (stored) return stored;

    const derived = inventoryPurchaseFor(item);
    const explicitQuantity =
        typeof item.purchased_quantity === 'number' &&
        Number.isFinite(item.purchased_quantity) &&
        item.purchased_quantity > 0
            ? item.purchased_quantity
            : derived.quantity;
    const explicitUnit = item.purchased_unit?.trim() || derived.unit;

    return {
        version: 2,
        inventoryItemId: item.id,
        quantity: explicitQuantity,
        unit: explicitUnit,
        provenance: purchaseProvenance(item.id),
        retailer: item.purchase_retailer ?? null,
        actualCost: item.actual_cost,
        currency: item.currency,
        packageCount: derived.packageCount,
        packageLabel: derived.packageLabel,
    };
}

async function reverseInventoryReceipt(item: ShoppingItem, receipt: PurchaseReceipt): Promise<void> {
    const inventoryEntry = query<InventoryEntry>(
        INVENTORY_TABLE,
        (candidate) => candidate.id === receipt.inventoryItemId,
    )[0];
    if (!inventoryEntry) return;

    // A failed shopping-row commit may leave the inventory reversal complete.
    // Recognise that state so retrying can finish instead of subtracting twice.
    if (inventoryEntry.description === reversedPurchaseProvenance(item.id)) return;

    if (
        inventoryEntry.description !== receipt.provenance ||
        inventoryEntry.item_name.trim().toLowerCase() !== item.ingredient_name.trim().toLowerCase() ||
        (item.user_id && inventoryEntry.user_id && inventoryEntry.user_id !== item.user_id)
    ) {
        throw new Error('The Grocery List inventory receipt no longer matches this purchase.');
    }

    const reversibleQuantity = convertQuantity(receipt.quantity, receipt.unit, inventoryEntry.unit);
    if (reversibleQuantity === null || reversibleQuantity < 0) {
        throw new Error('The Grocery List inventory receipt unit was changed and cannot be reversed safely.');
    }

    const currentQuantity =
        Number.isFinite(inventoryEntry.quantity) && inventoryEntry.quantity > 0 ? inventoryEntry.quantity : 0;
    if (currentQuantity <= reversibleQuantity || quantitiesEqual(currentQuantity, reversibleQuantity)) {
        await bulkDelete(INVENTORY_TABLE, [inventoryEntry.id]);
        return;
    }

    // Preserve stock added manually after this purchase. Quantity and
    // provenance change in one local write, making crash retries idempotent.
    await bulkUpsert(INVENTORY_TABLE, [
        {
            ...inventoryEntry,
            user_id: item.user_id ?? inventoryEntry.user_id,
            quantity: currentQuantity - reversibleQuantity,
            description: reversedPurchaseProvenance(item.id),
            updated_at: new Date().toISOString(),
        },
    ]);
}

function serializeItemMutation(shoppingItemId: string, mutation: () => Promise<void>): Promise<void> {
    const previous = itemMutationQueues.get(shoppingItemId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(mutation);
    itemMutationQueues.set(shoppingItemId, queued);

    return queued.finally(() => {
        if (itemMutationQueues.get(shoppingItemId) === queued) {
            itemMutationQueues.delete(shoppingItemId);
        }
    });
}

function notifyStoresChanged(): void {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('thalassa:stores-changed'));
    }
}

/**
 * Generate a shopping list from passage provision shortfalls.
 */
export async function generateShoppingList(
    shortfalls: ProvisionItem[],
    voyageId: string | null,
    defaultLocation: string = 'Galley',
    ownerUserId?: string | null,
): Promise<ShoppingItem[]> {
    const now = new Date().toISOString();
    const items: ShoppingItem[] = [];

    for (const sf of shortfalls) {
        if (sf.status !== 'needed' || sf.shortfall_qty <= 0) continue;

        const item: ShoppingItem = {
            id: generateUUID(),
            user_id: ownerUserId ?? null,
            ingredient_name: sf.ingredient_name,
            required_qty: sf.shortfall_qty,
            unit: sf.unit,
            market_zone: detectMarketZone(sf.ingredient_name),
            actual_cost: null,
            currency: 'AUD',
            purchased: false,
            purchased_at: null,
            purchase_retailer: null,
            purchased_quantity: null,
            purchased_unit: null,
            purchase_revision: 0,
            purchase_operation_id: null,
            store_location: defaultLocation,
            provision_id: sf.id,
            voyage_id: voyageId,
            notes: null,
            created_at: now,
            updated_at: now,
        };

        items.push(item);
        await insertLocal(TABLE, item);
    }

    return items;
}

/**
 * Bulk-add aggregated meal ingredients to the shopping list.
 * Used by the "Add All to Shopping List" flow in the Meal Calendar.
 */
export async function bulkAddToShoppingList(
    ingredients: { name: string; totalQty: number; unit: string }[],
    voyageId: string | null,
    ownerUserId?: string | null,
): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;

    for (const ing of ingredients) {
        if (ing.totalQty <= 0) continue;

        // Check for existing unpurchased item with same name to avoid duplicates
        const existing = query<ShoppingItem>(
            TABLE,
            (i) =>
                i.ingredient_name.toLowerCase() === ing.name.toLowerCase() &&
                normalizeUnit(i.unit) === normalizeUnit(ing.unit) &&
                i.voyage_id === voyageId &&
                !i.purchased,
        );

        if (existing.length > 0) {
            // Update quantity instead of creating duplicate
            await updateLocal<ShoppingItem>(TABLE, existing[0].id, {
                required_qty: existing[0].required_qty + ing.totalQty,
            } as Partial<ShoppingItem>);
        } else {
            const item: ShoppingItem = {
                id: generateUUID(),
                user_id: ownerUserId ?? null,
                ingredient_name: ing.name,
                required_qty: Math.round(ing.totalQty * 10) / 10,
                unit: ing.unit,
                market_zone: detectMarketZone(ing.name),
                actual_cost: null,
                currency: 'AUD',
                purchased: false,
                purchased_at: null,
                purchase_retailer: null,
                purchased_quantity: null,
                purchased_unit: null,
                purchase_revision: 0,
                purchase_operation_id: null,
                store_location: 'Galley',
                provision_id: null,
                voyage_id: voyageId,
                notes: null,
                created_at: now,
                updated_at: now,
            };
            await insertLocal(TABLE, item);
        }
        count++;
    }

    // Immediate sync so crew sees updates
    triggerHaptic('medium');
    syncNow().catch(() => {
        /* offline */
    });

    return count;
}

/**
 * Mark an item as purchased — inserts into Ship's Stores + immediate sync.
 * This prevents Robin buying the same brisket at a different shop!
 */
export function markPurchased(
    shoppingItemId: string,
    actualCost?: number,
    purchaseRetailer?: string,
    expectedVoyageId?: string | null,
    expectedOwnerUserId?: string | null,
): Promise<void> {
    if (actualCost !== undefined && (!Number.isFinite(actualCost) || actualCost < 0)) {
        return Promise.reject(new RangeError('Purchase cost must be a finite number greater than or equal to zero.'));
    }

    return serializeItemMutation(shoppingItemId, async () => {
        const item = query<ShoppingItem>(TABLE, (candidate) => candidate.id === shoppingItemId)[0];
        if (!item) return;
        if (expectedVoyageId !== undefined && item.voyage_id !== expectedVoyageId) {
            throw new Error('The shopping item does not belong to the selected voyage.');
        }
        if (expectedOwnerUserId && item.user_id && item.user_id !== expectedOwnerUserId) {
            throw new Error('The shopping item does not belong to the selected vessel.');
        }

        // A prior attempt may have durably committed the shopping outbox before
        // the derived local Stores mirror. Repair that mirror on retry.
        if (item.purchased) {
            const storedReceipt = readPurchaseReceipt(item.notes);
            if (!storedReceipt) return;
            const purchase = recordedInventoryPurchaseFor(item);
            await ensureInventoryReceipt(
                {
                    ...item,
                    user_id: expectedOwnerUserId ?? item.user_id,
                },
                purchase,
                storedReceipt,
            );
            notifyStoresChanged();
            return;
        }

        const purchase = inventoryPurchaseFor(item);
        const provenance = purchaseProvenance(shoppingItemId);
        const retailer = purchaseRetailer?.trim() || null;
        const receipt: PurchaseReceipt = {
            version: 2,
            // A shopping row and its inventory receipt deliberately share an
            // ID across separate tables. This makes inserts idempotent across
            // retries, app restarts, and two crew devices acting concurrently.
            inventoryItemId: shoppingItemId,
            quantity: purchase.quantity,
            unit: purchase.unit,
            provenance,
            retailer,
            actualCost: actualCost ?? null,
            currency: item.currency,
            packageCount: purchase.packageCount,
            packageLabel: purchase.packageLabel,
        };
        const purchaseOperationId = generateUUID();
        const updatedItem: ShoppingItem = {
            ...item,
            user_id: expectedOwnerUserId ?? item.user_id,
            purchased: true,
            purchased_at: new Date().toISOString(),
            actual_cost: actualCost ?? null,
            purchase_retailer: retailer,
            purchased_quantity: purchase.quantity,
            purchased_unit: purchase.unit,
            notes: writePurchaseReceipt(item.notes, receipt),
            purchase_revision: nextPurchaseRevision(item),
            purchase_operation_id: purchaseOperationId,
            updated_at: new Date().toISOString(),
        };

        // Persist the canonical shopping transition/outbox first. If the app
        // dies before the derived local mirror is written, startup
        // reconciliation can deterministically rebuild it from this receipt.
        await updateLocal<ShoppingItem>(TABLE, shoppingItemId, updatedItem);

        let mirrorError: unknown;
        try {
            await ensureInventoryReceipt(updatedItem, purchase, receipt);
        } catch (error) {
            mirrorError = error;
        }

        triggerHaptic('medium');
        syncNow().catch(() => {
            /* offline — will sync later */
        });
        notifyStoresChanged();
        if (mirrorError) throw mirrorError;
    });
}

/**
 * Manually add an item to the shopping list (non-recipe items like soap, parts, etc.)
 * If an unpurchased item with the same name already exists, updates its quantity.
 */
export async function addManualItem(opts: {
    name: string;
    qty: number;
    unit: string;
    zone?: MarketZone;
    notes?: string;
    /** Explicit selected voyage. `null` means the user's personal list. */
    voyageId?: string | null;
    /** Authoritative captain/vessel owner for a shared voyage. */
    ownerUserId?: string | null;
}): Promise<ShoppingItem> {
    const name = opts.name.trim();
    if (!name) throw new RangeError('A shopping item name is required.');
    if (!Number.isFinite(opts.qty) || opts.qty <= 0) {
        throw new RangeError('Shopping item quantity must be a finite number greater than zero.');
    }

    const unit = opts.unit.trim() || 'each';
    const voyage = getCachedActiveVoyage?.();
    const hasExplicitVoyage = Object.prototype.hasOwnProperty.call(opts, 'voyageId');
    const voyageId = hasExplicitVoyage ? (opts.voyageId ?? null) : (voyage?.id ?? null);
    const ownerUserId = opts.ownerUserId ?? (voyage?.id === voyageId ? voyage.user_id : null);
    if (hasExplicitVoyage && voyageId && !ownerUserId) {
        throw new Error('The selected voyage owner must be verified before adding shared shopping items.');
    }
    const now = new Date().toISOString();

    // Check for existing unpurchased item with same name to avoid duplicates
    const existing = query<ShoppingItem>(
        TABLE,
        (i) =>
            i.ingredient_name.toLowerCase() === name.toLowerCase() &&
            normalizeUnit(i.unit) === normalizeUnit(unit) &&
            i.voyage_id === voyageId &&
            (!ownerUserId || !i.user_id || i.user_id === ownerUserId) &&
            !i.purchased,
    );

    if (existing.length > 0) {
        // Update quantity on existing item
        const updated = { ...existing[0], required_qty: existing[0].required_qty + opts.qty, updated_at: now };
        await updateLocal<ShoppingItem>(TABLE, existing[0].id, {
            required_qty: updated.required_qty,
            updated_at: now,
            notes: opts.notes
                ? `${existing[0].notes ? existing[0].notes + ' · ' : ''}${opts.notes}`
                : existing[0].notes,
        } as Partial<ShoppingItem>);
        triggerHaptic('medium');
        syncNow().catch(() => {
            /* offline */
        });
        return updated;
    }

    const item: ShoppingItem = {
        id: generateUUID(),
        user_id: ownerUserId,
        ingredient_name: name,
        required_qty: opts.qty,
        unit,
        market_zone: opts.zone || detectMarketZone(name),
        actual_cost: null,
        currency: 'AUD',
        purchased: false,
        purchased_at: null,
        purchase_retailer: null,
        purchased_quantity: null,
        purchased_unit: null,
        purchase_revision: 0,
        purchase_operation_id: null,
        store_location: 'Galley',
        provision_id: null,
        voyage_id: voyageId,
        notes: opts.notes || null,
        created_at: now,
        updated_at: now,
    };
    await insertLocal(TABLE, item);
    triggerHaptic('medium');
    syncNow().catch(() => {
        /* offline */
    });
    return item;
}

/**
 * Unmark a purchased item — reverts to "needs buying".
 * Also reverses the exact quantity that the purchase added to Ship's Stores.
 */
export function unmarkPurchased(
    shoppingItemId: string,
    expectedVoyageId?: string | null,
    expectedOwnerUserId?: string | null,
): Promise<void> {
    return serializeItemMutation(shoppingItemId, async () => {
        const item = query<ShoppingItem>(TABLE, (candidate) => candidate.id === shoppingItemId)[0];
        if (!item) return;
        if (expectedVoyageId !== undefined && item.voyage_id !== expectedVoyageId) {
            throw new Error('The shopping item does not belong to the selected voyage.');
        }
        if (expectedOwnerUserId && item.user_id && item.user_id !== expectedOwnerUserId) {
            throw new Error('The shopping item does not belong to the selected vessel.');
        }
        const scopedItem: ShoppingItem = {
            ...item,
            user_id: expectedOwnerUserId ?? item.user_id,
        };
        if (!scopedItem.purchased) {
            const possibleGhost = query<InventoryEntry>(
                INVENTORY_TABLE,
                (candidate) =>
                    candidate.id === scopedItem.id && candidate.description === purchaseProvenance(scopedItem.id),
            )[0];
            if (possibleGhost) {
                await reverseInventoryReceipt(scopedItem, receiptForUndo(scopedItem));
                notifyStoresChanged();
            }
            return;
        }

        const receipt = receiptForUndo(scopedItem);
        await updateLocal<ShoppingItem>(TABLE, shoppingItemId, {
            user_id: scopedItem.user_id,
            purchased: false,
            purchased_at: null,
            actual_cost: null,
            purchase_retailer: null,
            purchased_quantity: null,
            purchased_unit: null,
            // Retain the machine-readable receipt until the next purchase so a
            // crash before local mirror reversal is recoverable offline.
            notes: scopedItem.notes,
            purchase_revision: nextPurchaseRevision(scopedItem),
            purchase_operation_id: generateUUID(),
        } as Partial<ShoppingItem>);

        let mirrorError: unknown;
        try {
            await reverseInventoryReceipt(scopedItem, receipt);
        } catch (error) {
            mirrorError = error;
        }

        triggerHaptic('light');
        syncNow().catch(() => {
            /* offline */
        });
        notifyStoresChanged();
        if (mirrorError) throw mirrorError;
    });
}

/**
 * Rebuild the local-only Stores mirror from durable shopping transitions.
 * Called after LocalDatabase initialization so a crash between the canonical
 * shopping write and its derived inventory write cannot leave a permanent
 * ghost or omission while offline.
 */
export async function reconcileGroceryInventoryMirror(): Promise<{ repaired: number; errors: string[] }> {
    const items = getAll<ShoppingItem>(TABLE);
    let repaired = 0;
    const errors: string[] = [];

    for (const item of items) {
        try {
            await serializeItemMutation(item.id, async () => {
                const current = query<ShoppingItem>(TABLE, (candidate) => candidate.id === item.id)[0];
                if (!current) return;

                // Old clients wrote inventory through their own outbox and did
                // not persist this receipt marker. Manufacturing a deterministic
                // second row for those purchases would duplicate stock.
                const storedReceipt = readPurchaseReceipt(current.notes);
                if (!storedReceipt) return;

                const before = query<InventoryEntry>(INVENTORY_TABLE, (candidate) => candidate.id === current.id)[0];
                if (current.purchased) {
                    const purchase = recordedInventoryPurchaseFor(current);
                    await ensureInventoryReceipt(current, purchase, storedReceipt);
                } else if (before?.description === purchaseProvenance(item.id)) {
                    await reverseInventoryReceipt(current, storedReceipt);
                } else {
                    return;
                }
                const after = query<InventoryEntry>(INVENTORY_TABLE, (candidate) => candidate.id === current.id)[0];
                if (JSON.stringify(before) !== JSON.stringify(after)) repaired += 1;
            });
        } catch (error) {
            errors.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (repaired > 0) notifyStoresChanged();
    return { repaired, errors };
}

/**
 * Remove all unpurchased items with 'Passage provision' notes.
 * Called before re-running "Add to Shopping List" so quantities are recalculated fresh.
 */
export async function removeUnpurchasedProvisionItems(): Promise<number> {
    const items = query<ShoppingItem>(TABLE, (i) => !i.purchased && (i.notes || '').includes('Passage provision'));
    for (const item of items) {
        await deleteLocal(TABLE, item.id);
    }
    if (items.length > 0) {
        syncNow().catch(() => {
            /* offline */
        });
    }
    return items.length;
}

/**
 * Get the current shopping list grouped by market zone.
 */
export function getShoppingList(voyageId?: string | null, ownerUserId?: string | null): ShoppingListSummary {
    let items: ShoppingItem[];
    if (voyageId !== undefined) {
        items = query<ShoppingItem>(
            TABLE,
            (i) => i.voyage_id === voyageId && (!ownerUserId || !i.user_id || i.user_id === ownerUserId),
        );
    } else {
        items = getAll<ShoppingItem>(TABLE);
    }

    const purchased = items.filter((i) => i.purchased);
    const totalCost = purchased.reduce((sum, i) => sum + (i.actual_cost || 0), 0);

    // Group by zone
    const zoneMap = new Map<MarketZone, ShoppingItem[]>();
    for (const item of items) {
        const arr = zoneMap.get(item.market_zone) || [];
        arr.push(item);
        zoneMap.set(item.market_zone, arr);
    }

    // Sort zones: non-empty first, alphabetical
    const zones = Array.from(zoneMap.entries())
        .map(([zone, zoneItems]) => ({ zone, items: zoneItems }))
        .sort((a, b) => a.zone.localeCompare(b.zone));

    return {
        total: items.length,
        purchased: purchased.length,
        remaining: items.length - purchased.length,
        totalCost: Math.round(totalCost * 100) / 100,
        currency: items[0]?.currency || 'AUD',
        zones,
    };
}

/**
 * Update the actual cost for a purchased item (price tracking).
 */
export async function updateItemCost(shoppingItemId: string, cost: number, currency?: string): Promise<void> {
    await updateLocal<ShoppingItem>(TABLE, shoppingItemId, {
        actual_cost: cost,
        ...(currency ? { currency } : {}),
    } as Partial<ShoppingItem>);
}

/**
 * Get voyage budget summary from shopping list costs.
 */
export function getVoyageBudget(voyageId: string): {
    totalSpent: number;
    itemCount: number;
    currency: string;
    byZone: { zone: MarketZone; spent: number }[];
} {
    const items = query<ShoppingItem>(TABLE, (i) => i.voyage_id === voyageId && i.purchased && i.actual_cost !== null);

    const byZone = new Map<MarketZone, number>();
    let total = 0;

    for (const item of items) {
        const cost = item.actual_cost || 0;
        total += cost;
        byZone.set(item.market_zone, (byZone.get(item.market_zone) || 0) + cost);
    }

    return {
        totalSpent: Math.round(total * 100) / 100,
        itemCount: items.length,
        currency: items[0]?.currency || 'AUD',
        byZone: Array.from(byZone.entries()).map(([zone, spent]) => ({
            zone,
            spent: Math.round(spent * 100) / 100,
        })),
    };
}
