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

import { getAll, query, insertLocal, updateLocal, deleteLocal, generateUUID } from './vessel/LocalDatabase';
import { syncNow } from './vessel/SyncService';
import { type ProvisionItem } from './PassageProvisionsService';
import { getCachedActiveVoyage } from './VoyageService';
import { triggerHaptic } from '../utils/system';

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
    ingredient_name: string;
    required_qty: number;
    unit: string;
    market_zone: MarketZone;
    actual_cost: number | null;
    currency: string;
    purchased: boolean;
    purchased_at: string | null;
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

/**
 * Generate a shopping list from passage provision shortfalls.
 */
export async function generateShoppingList(
    shortfalls: ProvisionItem[],
    voyageId: string | null,
    defaultLocation: string = 'Galley',
): Promise<ShoppingItem[]> {
    const now = new Date().toISOString();
    const items: ShoppingItem[] = [];

    for (const sf of shortfalls) {
        if (sf.status !== 'needed' || sf.shortfall_qty <= 0) continue;

        const item: ShoppingItem = {
            id: generateUUID(),
            ingredient_name: sf.ingredient_name,
            required_qty: sf.shortfall_qty,
            unit: sf.unit,
            market_zone: detectMarketZone(sf.ingredient_name),
            actual_cost: null,
            currency: 'AUD',
            purchased: false,
            purchased_at: null,
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
): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;

    for (const ing of ingredients) {
        if (ing.totalQty <= 0) continue;

        // Check for existing unpurchased item with same name to avoid duplicates
        const existing = query<ShoppingItem>(TABLE, (i) =>
            i.ingredient_name.toLowerCase() === ing.name.toLowerCase() &&
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
                ingredient_name: ing.name,
                required_qty: Math.round(ing.totalQty * 10) / 10,
                unit: ing.unit,
                market_zone: detectMarketZone(ing.name),
                actual_cost: null,
                currency: 'AUD',
                purchased: false,
                purchased_at: null,
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
    syncNow().catch(() => { /* offline */ });

    return count;
}

/**
 * Mark an item as purchased — inserts into Ship's Stores + immediate sync.
 * This prevents Robin buying the same brisket at a different shop!
 */
export async function markPurchased(
    shoppingItemId: string,
    actualCost?: number,
    storeLocation?: string,
): Promise<void> {
    const items = query<ShoppingItem>(TABLE, (i) => i.id === shoppingItemId);
    const item = items[0];
    if (!item) return;

    // 1. Update shopping list item
    await updateLocal<ShoppingItem>(TABLE, shoppingItemId, {
        purchased: true,
        purchased_at: new Date().toISOString(),
        actual_cost: actualCost ?? null,
        store_location: storeLocation || item.store_location,
    } as Partial<ShoppingItem>);

    // 2. Insert into Ship's Stores (inventory_items)
    const storesEntry = {
        id: generateUUID(),
        item_name: item.ingredient_name,
        category: 'Provisions' as const,
        quantity: item.required_qty,
        min_quantity: 0,
        unit: item.unit,
        location_zone: storeLocation || item.store_location,
        location_specific: '',
        unit_value: actualCost ?? 0,
        currency: item.currency,
        notes: `Purchased for passage ${item.voyage_id || ''}`.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    await insertLocal('inventory_items', storesEntry);

    // 3. Haptic + immediate sync so crew sees update instantly
    triggerHaptic('medium');
    syncNow().catch(() => {
        /* offline — will sync later */
    });
}

/**
 * Manually add an item to the shopping list (non-recipe items like soap, parts, etc.)
 */
export async function addManualItem(opts: {
    name: string;
    qty: number;
    unit: string;
    zone?: MarketZone;
    notes?: string;
}): Promise<ShoppingItem> {
    const voyage = getCachedActiveVoyage?.();
    const now = new Date().toISOString();
    const item: ShoppingItem = {
        id: generateUUID(),
        ingredient_name: opts.name,
        required_qty: opts.qty,
        unit: opts.unit || 'each',
        market_zone: opts.zone || detectMarketZone(opts.name),
        actual_cost: null,
        currency: 'AUD',
        purchased: false,
        purchased_at: null,
        store_location: '',
        provision_id: null,
        voyage_id: voyage?.id || null,
        notes: opts.notes || null,
        created_at: now,
        updated_at: now,
    };
    await insertLocal(TABLE, item);
    triggerHaptic('medium');
    syncNow().catch(() => { /* offline */ });
    return item;
}

/**
 * Unmark a purchased item — reverts to "needs buying".
 * Also removes the corresponding Ship's Stores entry that was auto-created.
 */
export async function unmarkPurchased(shoppingItemId: string): Promise<void> {
    const items = query<ShoppingItem>(TABLE, (i) => i.id === shoppingItemId);
    const item = items[0];
    if (!item || !item.purchased) return;

    // 1. Revert shopping list item
    await updateLocal<ShoppingItem>(TABLE, shoppingItemId, {
        purchased: false,
        purchased_at: null,
        actual_cost: null,
    } as Partial<ShoppingItem>);

    // 2. Remove the auto-created inventory entry (best-effort match by name + voyage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storesEntries = query<any>('inventory_items', (i: any) =>
        i.item_name === item.ingredient_name &&
        (i.notes || '').includes(item.voyage_id || '___'),
    );
    for (const entry of storesEntries) {
        await deleteLocal('inventory_items', entry.id);
    }

    // 3. Sync
    triggerHaptic('light');
    syncNow().catch(() => {
        /* offline */
    });
}

/**
 * Get the current shopping list grouped by market zone.
 */
export function getShoppingList(voyageId?: string): ShoppingListSummary {
    let items: ShoppingItem[];
    if (voyageId) {
        items = query<ShoppingItem>(TABLE, (i) => i.voyage_id === voyageId);
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
