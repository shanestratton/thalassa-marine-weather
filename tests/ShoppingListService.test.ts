/**
 * ShoppingListService — market zone detection + list building tests.
 *
 * The detectMarketZone function (private) is tested indirectly through
 * generateShoppingList, which assigns zones to each item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LocalDatabase
const store = new Map<string, Map<string, unknown>>();
const databaseControls = vi.hoisted(() => ({
    failPurchaseUpdateOnce: false,
    failUnpurchaseUpdateOnce: false,
    failInventoryUpsertOnce: false,
    failInventoryDeleteOnce: false,
}));
vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: (table: string) => Array.from(store.get(table)?.values() || []),
    query: (table: string, fn: (item: unknown) => boolean) => Array.from(store.get(table)?.values() || []).filter(fn),
    insertLocal: async (table: string, item: { id: string }) => {
        if (!store.has(table)) store.set(table, new Map());
        store.get(table)!.set(item.id, item);
        return item;
    },
    updateLocal: async (table: string, id: string, updates: Record<string, unknown>) => {
        if (table === 'shopping_list' && updates.purchased === true && databaseControls.failPurchaseUpdateOnce) {
            databaseControls.failPurchaseUpdateOnce = false;
            throw new Error('simulated purchase commit failure');
        }
        if (table === 'shopping_list' && updates.purchased === false && databaseControls.failUnpurchaseUpdateOnce) {
            databaseControls.failUnpurchaseUpdateOnce = false;
            throw new Error('simulated unpurchase commit failure');
        }
        const existing = store.get(table)?.get(id) as Record<string, unknown> | undefined;
        if (!existing) return null;
        Object.assign(existing, updates);
        return existing;
    },
    deltaLocal: async (table: string, id: string, field: string, delta: number) => {
        const existing = store.get(table)?.get(id) as Record<string, unknown> | undefined;
        if (!existing) return null;
        existing[field] = Math.max(0, Number(existing[field] ?? 0) + delta);
        return existing;
    },
    deleteLocal: async (table: string, id: string) => {
        store.get(table)?.delete(id);
    },
    bulkUpsert: async (table: string, records: Record<string, unknown>[]) => {
        if (table === 'inventory_items' && databaseControls.failInventoryUpsertOnce) {
            databaseControls.failInventoryUpsertOnce = false;
            throw new Error('simulated inventory mirror failure');
        }
        if (!store.has(table)) store.set(table, new Map());
        for (const record of records) {
            store.get(table)!.set(String(record.id), record);
        }
    },
    bulkDelete: async (table: string, ids: string[]) => {
        if (table === 'inventory_items' && databaseControls.failInventoryDeleteOnce) {
            databaseControls.failInventoryDeleteOnce = false;
            throw new Error('simulated inventory mirror failure');
        }
        for (const id of ids) store.get(table)?.delete(id);
    },
    generateUUID: () => `shop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
}));

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/PassageProvisionsService', () => ({}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
}));

import {
    addManualItem,
    generateShoppingList,
    getShoppingList,
    getVoyageBudget,
    markPurchased,
    reconcileGroceryInventoryMirror,
    unmarkPurchased,
    type MarketZone,
} from '../services/ShoppingListService';

describe('ShoppingListService', () => {
    beforeEach(() => {
        store.clear();
        databaseControls.failPurchaseUpdateOnce = false;
        databaseControls.failUnpurchaseUpdateOnce = false;
        databaseControls.failInventoryUpsertOnce = false;
        databaseControls.failInventoryDeleteOnce = false;
    });

    describe('generateShoppingList', () => {
        it('generates items from shortfalls', async () => {
            const shortfalls = [
                { id: 'p1', ingredient_name: 'Chicken Breast', shortfall_qty: 2, unit: 'kg', status: 'needed' },
                { id: 'p2', ingredient_name: 'Garlic', shortfall_qty: 3, unit: 'whole', status: 'needed' },
            ];

            const items = await generateShoppingList(shortfalls as never[], 'v-1');
            expect(items).toHaveLength(2);
        });

        it('assigns correct market zones', async () => {
            const shortfalls = [
                { id: 'p1', ingredient_name: 'Beef Steak', shortfall_qty: 1, unit: 'kg', status: 'needed' },
                { id: 'p2', ingredient_name: 'Tomatoes', shortfall_qty: 6, unit: 'whole', status: 'needed' },
                { id: 'p3', ingredient_name: 'Red Wine', shortfall_qty: 2, unit: 'bottles', status: 'needed' },
                { id: 'p4', ingredient_name: 'Bread Rolls', shortfall_qty: 6, unit: 'whole', status: 'needed' },
                { id: 'p5', ingredient_name: 'Butter', shortfall_qty: 1, unit: 'pack', status: 'needed' },
                { id: 'p6', ingredient_name: 'Diesel Fuel', shortfall_qty: 200, unit: 'L', status: 'needed' },
                { id: 'p7', ingredient_name: 'Rope 12mm', shortfall_qty: 50, unit: 'm', status: 'needed' },
                { id: 'p8', ingredient_name: 'Paracetamol', shortfall_qty: 1, unit: 'box', status: 'needed' },
                { id: 'p9', ingredient_name: 'Paper Towels', shortfall_qty: 4, unit: 'rolls', status: 'needed' },
            ];

            const items = await generateShoppingList(shortfalls as never[], 'v-1');

            const getZone = (name: string) => items.find((i) => i.ingredient_name === name)?.market_zone;

            expect(getZone('Beef Steak')).toBe('Butcher');
            expect(getZone('Tomatoes')).toBe('Produce');
            expect(getZone('Red Wine')).toBe('Bottle Shop');
            expect(getZone('Bread Rolls')).toBe('Bakery');
            expect(getZone('Butter')).toBe('Dairy');
            expect(getZone('Diesel Fuel')).toBe('Fuel Dock');
            expect(getZone('Rope 12mm')).toBe('Chandlery');
            expect(getZone('Paracetamol')).toBe('Pharmacy');
            expect(getZone('Paper Towels')).toBe('General');
        });

        it('skips items that are not needed', async () => {
            const shortfalls = [
                { id: 'p1', ingredient_name: 'Salt', shortfall_qty: 1, unit: 'kg', status: 'purchased' },
                { id: 'p2', ingredient_name: 'Pepper', shortfall_qty: 0, unit: 'g', status: 'needed' },
            ];

            const items = await generateShoppingList(shortfalls as never[], null);
            expect(items).toHaveLength(0);
        });

        it('sets voyage_id on generated items', async () => {
            const shortfalls = [{ id: 'p1', ingredient_name: 'Milk', shortfall_qty: 2, unit: 'L', status: 'needed' }];

            const items = await generateShoppingList(shortfalls as never[], 'voyage-42');
            expect(items[0].voyage_id).toBe('voyage-42');
        });

        it('retains the authoritative vessel owner on generated shared rows', async () => {
            const shortfalls = [{ id: 'p1', ingredient_name: 'Milk', shortfall_qty: 2, unit: 'L', status: 'needed' }];

            const items = await generateShoppingList(shortfalls as never[], 'voyage-42', 'Galley', 'captain-42');

            expect(items[0]).toMatchObject({
                voyage_id: 'voyage-42',
                user_id: 'captain-42',
            });
        });
    });

    describe('getShoppingList', () => {
        it('returns empty summary when no items', () => {
            const summary = getShoppingList();
            expect(summary.total).toBe(0);
            expect(summary.purchased).toBe(0);
            expect(summary.remaining).toBe(0);
            expect(summary.zones).toHaveLength(0);
        });

        it('groups items by zone', async () => {
            const shortfalls = [
                { id: 'p1', ingredient_name: 'Salmon', shortfall_qty: 1, unit: 'kg', status: 'needed' },
                { id: 'p2', ingredient_name: 'Prawns', shortfall_qty: 0.5, unit: 'kg', status: 'needed' },
                { id: 'p3', ingredient_name: 'Lime', shortfall_qty: 4, unit: 'whole', status: 'needed' },
            ];
            await generateShoppingList(shortfalls as never[], null);
            const summary = getShoppingList();
            expect(summary.total).toBe(3);
            // Salmon and Prawns → Butcher, Lime → Produce
            const butcher = summary.zones.find((z) => z.zone === 'Butcher');
            const produce = summary.zones.find((z) => z.zone === 'Produce');
            expect(butcher?.items.length).toBe(2);
            expect(produce?.items.length).toBe(1);
        });
    });

    describe('getVoyageBudget', () => {
        it('returns zero budget when no items', () => {
            const budget = getVoyageBudget('v-1');
            expect(budget.totalSpent).toBe(0);
            expect(budget.itemCount).toBe(0);
        });
    });

    describe('purchase lifecycle', () => {
        it('keeps list reads and writes inside an explicit owner/voyage scope', async () => {
            const first = await addManualItem({
                name: 'Rice',
                qty: 1,
                unit: 'kg',
                voyageId: 'voyage-a',
                ownerUserId: 'captain-a',
            });
            await addManualItem({
                name: 'Rice',
                qty: 2,
                unit: 'kg',
                voyageId: 'voyage-b',
                ownerUserId: 'captain-b',
            });

            expect(getShoppingList('voyage-a', 'captain-a')).toMatchObject({ total: 1, remaining: 1 });
            expect(getShoppingList('voyage-b', 'captain-b')).toMatchObject({ total: 1, remaining: 1 });
            expect(getShoppingList(null, 'captain-a')).toMatchObject({ total: 0 });

            await expect(markPurchased(first.id, undefined, undefined, 'voyage-b', 'captain-b')).rejects.toThrow(
                /selected voyage/i,
            );
            expect(store.get('shopping_list')?.get(first.id)).toMatchObject({ purchased: false });
            expect(store.get('inventory_items')?.has(first.id) ?? false).toBe(false);

            await markPurchased(first.id, undefined, undefined, 'voyage-a', 'captain-a');
            expect(store.get('inventory_items')?.get(first.id)).toMatchObject({
                user_id: 'captain-a',
                item_name: 'Rice',
            });
        });

        it('rejects a deterministic receipt that belongs to another vessel owner', async () => {
            const item = await addManualItem({
                name: 'Rice',
                qty: 1,
                unit: 'kg',
                voyageId: 'voyage-a',
                ownerUserId: 'captain-a',
            });
            store.set(
                'inventory_items',
                new Map([
                    [
                        item.id,
                        {
                            id: item.id,
                            user_id: 'captain-b',
                            item_name: 'Rice',
                            description: `Added from Grocery List purchase ${item.id}`,
                            quantity: 1000,
                            unit: 'g',
                        },
                    ],
                ]),
            );

            await expect(markPurchased(item.id, undefined, undefined, 'voyage-a', 'captain-a')).rejects.toThrow(
                /another stores item/i,
            );
        });

        it('fails closed when an explicit shared voyage has no verified owner', async () => {
            await expect(
                addManualItem({
                    name: 'Rice',
                    qty: 1,
                    unit: 'kg',
                    voyageId: 'voyage-a',
                }),
            ).rejects.toThrow(/owner must be verified/i);
        });

        it('records the purchasable package and completely reverses a no-voyage purchase', async () => {
            const item = await addManualItem({
                name: '  Rice  ',
                qty: 0.5,
                unit: 'kg',
                zone: 'General',
            });

            await markPurchased(item.id, 8.5, 'Markets');
            await markPurchased(item.id, 8.5, 'Markets');

            expect(getShoppingList()).toMatchObject({
                purchased: 1,
                remaining: 0,
                totalCost: 8.5,
            });
            expect(Array.from(store.get('inventory_items')?.values() ?? [])).toEqual([
                expect.objectContaining({
                    id: item.id,
                    item_name: 'Rice',
                    description: `Added from Grocery List purchase ${item.id}`,
                    quantity: 1000,
                    unit: 'g',
                    location_zone: 'Galley',
                }),
            ]);
            expect(store.get('shopping_list')?.get(item.id)).toMatchObject({
                store_location: 'Galley',
                purchase_retailer: 'Markets',
                purchased_quantity: 1000,
                purchased_unit: 'g',
            });
            expect(String((store.get('shopping_list')?.get(item.id) as { notes: string }).notes)).toContain(
                '"retailer":"Markets"',
            );

            await unmarkPurchased(item.id);

            expect(getShoppingList()).toMatchObject({
                purchased: 0,
                remaining: 1,
                totalCost: 0,
            });
            expect(Array.from(store.get('inventory_items')?.values() ?? [])).toHaveLength(0);
        });

        it('preserves a depleted pre-existing stores row and all of its metadata on undo', async () => {
            const existingStoresRow = {
                id: 'existing-rice',
                item_name: 'Rice',
                description: 'Hand-entered pantry record',
                quantity: 0,
                unit: '1kg bag',
                location_zone: 'Forward locker',
                location_specific: 'Blue crate',
            };
            store.set('inventory_items', new Map([['existing-rice', existingStoresRow]]));
            const item = await addManualItem({ name: 'Rice', qty: 0.5, unit: 'kg' });

            await markPurchased(item.id);
            expect(store.get('inventory_items')?.get('existing-rice')).toEqual(existingStoresRow);
            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({
                quantity: 1000,
                unit: 'g',
            });

            await unmarkPurchased(item.id);
            expect(store.get('inventory_items')?.get('existing-rice')).toEqual(existingStoresRow);
            expect(store.get('inventory_items')?.has(item.id)).toBe(false);
        });

        it('preserves a 0.0001 unmatched quantity without rounding it to zero', async () => {
            const item = await addManualItem({ name: 'Custom test fluid', qty: 0.0001, unit: 'L' });

            await markPurchased(item.id);

            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({
                quantity: 0.0001,
                unit: 'L',
            });
        });

        it('serializes concurrent purchase and undo calls per shopping item', async () => {
            const item = await addManualItem({ name: 'Flour', qty: 750, unit: 'g' });

            await Promise.all([markPurchased(item.id), markPurchased(item.id)]);

            expect(Array.from(store.get('inventory_items')?.values() ?? [])).toEqual([
                expect.objectContaining({
                    id: item.id,
                    quantity: 1000,
                    unit: 'g',
                }),
            ]);
            expect(getShoppingList()).toMatchObject({ purchased: 1, remaining: 0 });

            await Promise.all([unmarkPurchased(item.id), unmarkPurchased(item.id)]);

            expect(Array.from(store.get('inventory_items')?.values() ?? [])).toHaveLength(0);
            expect(getShoppingList()).toMatchObject({ purchased: 0, remaining: 1 });
        });

        it('recovers purchase and undo commits without duplicating or deleting the wrong receipt', async () => {
            const item = await addManualItem({ name: 'Flour', qty: 750, unit: 'g' });
            databaseControls.failPurchaseUpdateOnce = true;

            await expect(markPurchased(item.id)).rejects.toThrow(/simulated purchase commit failure/i);
            expect(getShoppingList()).toMatchObject({ purchased: 0, remaining: 1 });
            expect(store.get('inventory_items')?.has(item.id) ?? false).toBe(false);

            await markPurchased(item.id, undefined, 'Markets');
            expect(Array.from(store.get('inventory_items')?.values() ?? [])).toHaveLength(1);
            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({
                quantity: 1000,
                unit: 'g',
                location_zone: 'Galley',
            });

            databaseControls.failUnpurchaseUpdateOnce = true;
            await expect(unmarkPurchased(item.id)).rejects.toThrow(/simulated unpurchase commit failure/i);
            expect(getShoppingList()).toMatchObject({ purchased: 1, remaining: 0 });
            expect(store.get('inventory_items')?.has(item.id)).toBe(true);

            await unmarkPurchased(item.id);
            expect(getShoppingList()).toMatchObject({ purchased: 0, remaining: 1 });
            expect(store.get('inventory_items')?.has(item.id)).toBe(false);
        });

        it('rebuilds the derived mirror after a crash-window write failure', async () => {
            const item = await addManualItem({ name: 'Flour', qty: 750, unit: 'g' });
            databaseControls.failInventoryUpsertOnce = true;

            await expect(markPurchased(item.id)).rejects.toThrow(/inventory mirror failure/i);
            expect(getShoppingList()).toMatchObject({ purchased: 1, remaining: 0 });
            expect(store.get('inventory_items')?.has(item.id) ?? false).toBe(false);

            await expect(reconcileGroceryInventoryMirror()).resolves.toMatchObject({ repaired: 1, errors: [] });
            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({ quantity: 1000, unit: 'g' });

            databaseControls.failInventoryDeleteOnce = true;
            await expect(unmarkPurchased(item.id)).rejects.toThrow(/inventory mirror failure/i);
            expect(getShoppingList()).toMatchObject({ purchased: 0, remaining: 1 });
            expect(store.get('inventory_items')?.has(item.id)).toBe(true);

            await expect(reconcileGroceryInventoryMirror()).resolves.toMatchObject({ repaired: 1, errors: [] });
            expect(store.get('inventory_items')?.has(item.id)).toBe(false);
        });

        it('preserves stock added to a purchase receipt row when the purchase is undone', async () => {
            const item = await addManualItem({ name: 'Rice', qty: 500, unit: 'g' });
            await markPurchased(item.id);
            Object.assign(store.get('inventory_items')?.get(item.id) as object, { quantity: 1500 });

            await unmarkPurchased(item.id);

            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({
                quantity: 500,
                unit: 'g',
                description: `Stock retained after undoing Grocery List purchase ${item.id}`,
            });
            expect(store.get('shopping_list')?.get(item.id)).toMatchObject({
                purchased: false,
                purchase_retailer: null,
                purchased_quantity: null,
                purchased_unit: null,
            });
        });

        it('can repurchase after an undo retained newer stock without losing that stock', async () => {
            const item = await addManualItem({ name: 'Rice', qty: 500, unit: 'g' });
            await markPurchased(item.id);
            Object.assign(store.get('inventory_items')?.get(item.id) as object, { quantity: 1500 });
            await unmarkPurchased(item.id);

            await markPurchased(item.id, 6, 'IGA');

            expect(store.get('inventory_items')?.get(item.id)).toMatchObject({
                quantity: 1500,
                unit: 'g',
                description: `Added from Grocery List purchase ${item.id}`,
            });
            expect(store.get('shopping_list')?.get(item.id)).toMatchObject({
                purchased: true,
                purchase_retailer: 'IGA',
                purchased_quantity: 1000,
                purchased_unit: 'g',
            });
        });

        it('deduplicates manual items only when their normalized units also match', async () => {
            const first = await addManualItem({ name: 'Rice', qty: 1, unit: ' KG ' });
            const sameUnit = await addManualItem({ name: 'rice', qty: 2, unit: 'kg' });
            const differentUnit = await addManualItem({ name: 'Rice', qty: 500, unit: 'g' });

            expect(sameUnit.id).toBe(first.id);
            expect(sameUnit.required_qty).toBe(3);
            expect(differentUnit.id).not.toBe(first.id);
            expect(getShoppingList()).toMatchObject({ total: 2, remaining: 2 });
        });

        it('rejects invalid manual quantities and purchase costs at the service boundary', async () => {
            await expect(addManualItem({ name: 'Rice', qty: -1, unit: 'kg' })).rejects.toThrow(/quantity/i);

            const item = await addManualItem({ name: 'Rice', qty: 1, unit: 'kg' });
            await expect(markPurchased(item.id, Number.NaN)).rejects.toThrow(/cost/i);
            expect(getShoppingList().purchased).toBe(0);
        });
    });

    describe('MarketZone type', () => {
        it('covers all zones', () => {
            const zones: MarketZone[] = [
                'Butcher',
                'Produce',
                'Bottle Shop',
                'Bakery',
                'Dairy',
                'Chandlery',
                'Fuel Dock',
                'Pharmacy',
                'General',
            ];
            expect(zones).toHaveLength(9);
        });
    });
});
