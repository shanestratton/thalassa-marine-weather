/**
 * ShoppingListService — market zone detection + list building tests.
 *
 * The detectMarketZone function (private) is tested indirectly through
 * generateShoppingList, which assigns zones to each item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LocalDatabase
const store = new Map<string, Map<string, unknown>>();
vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: (table: string) => Array.from(store.get(table)?.values() || []),
    query: (table: string, fn: (item: unknown) => boolean) => Array.from(store.get(table)?.values() || []).filter(fn),
    insertLocal: async (table: string, item: { id: string }) => {
        if (!store.has(table)) store.set(table, new Map());
        store.get(table)!.set(item.id, item);
        return item;
    },
    updateLocal: async (table: string, id: string, updates: Record<string, unknown>) => {
        const existing = store.get(table)?.get(id) as Record<string, unknown> | undefined;
        if (!existing) return null;
        Object.assign(existing, updates);
        return existing;
    },
    generateUUID: () => `shop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
}));

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/PassageProvisionsService', () => ({}));

import {
    generateShoppingList,
    getShoppingList,
    getVoyageBudget,
    type MarketZone,
} from '../services/ShoppingListService';

describe('ShoppingListService', () => {
    beforeEach(() => {
        store.clear();
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
