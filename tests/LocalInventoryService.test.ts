import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

const database = vi.hoisted(() => {
    const rows = new Map<string, InventoryItem>();
    return {
        rows,
        deltaLocal: vi.fn(async (_table: string, id: string, field: string, delta: number) => {
            const item = rows.get(id);
            if (!item) return null;
            const updated = {
                ...item,
                [field]: Math.max(0, Number(item[field as keyof InventoryItem]) + delta),
            };
            rows.set(id, updated);
            return updated;
        }),
        deleteLocal: vi.fn(async (_table: string, id: string) => {
            rows.delete(id);
        }),
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: () => Array.from(database.rows.values()),
    getById: (_table: string, id: string) => database.rows.get(id) ?? null,
    query: (_table: string, predicate: (item: InventoryItem) => boolean) =>
        Array.from(database.rows.values()).filter(predicate),
    insertLocal: vi.fn(),
    updateLocal: vi.fn(),
    deltaLocal: database.deltaLocal,
    deleteLocal: database.deleteLocal,
    generateUUID: vi.fn(),
}));

import { LocalInventoryService } from '../services/vessel/LocalInventoryService';

function inventoryItem(id: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id,
        user_id: 'user-1',
        barcode: null,
        item_name: 'Rice',
        description: 'Dry stores',
        category: 'Provisions',
        quantity: 2,
        min_quantity: 0,
        unit: 'kg',
        location_zone: 'Galley',
        location_specific: 'Pantry',
        expiry_date: null,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
        ...overrides,
    };
}

describe('LocalInventoryService quantity integrity', () => {
    beforeEach(() => {
        database.rows.clear();
        database.deltaLocal.mockClear();
        database.deleteLocal.mockClear();
    });

    it('routes signed quantity changes through DELTA mutations', async () => {
        database.rows.set('rice', inventoryItem('rice'));

        await LocalInventoryService.incrementQuantity('rice', 0.5);
        await LocalInventoryService.decrementQuantity('rice', 1);
        const result = await LocalInventoryService.adjustQuantity('rice', -5);

        expect(database.deltaLocal.mock.calls.map((call) => call.slice(2))).toEqual([
            ['quantity', 0.5],
            ['quantity', -1],
            ['quantity', -5],
        ]);
        expect(result?.quantity).toBe(0);
    });

    it('rejects non-finite and directionally invalid amounts', async () => {
        database.rows.set('rice', inventoryItem('rice'));

        await expect(LocalInventoryService.incrementQuantity('rice', -1)).rejects.toThrow(/increment amount/i);
        await expect(LocalInventoryService.decrementQuantity('rice', Number.NaN)).rejects.toThrow(/decrement amount/i);
        await expect(LocalInventoryService.adjustQuantity('rice', Number.POSITIVE_INFINITY)).rejects.toThrow(/finite/i);
        expect(database.deltaLocal).not.toHaveBeenCalled();
    });

    it('merges only semantically identical rows and preserves purchase receipts', async () => {
        database.rows.set('manual-a', inventoryItem('manual-a', { quantity: 2 }));
        database.rows.set('manual-b', inventoryItem('manual-b', { quantity: 3 }));
        database.rows.set(
            'different-unit',
            inventoryItem('different-unit', {
                quantity: 500,
                unit: 'g',
            }),
        );
        database.rows.set(
            'different-locker',
            inventoryItem('different-locker', {
                quantity: 1,
                location_specific: 'Starboard locker',
            }),
        );
        database.rows.set(
            'receipt',
            inventoryItem('receipt', {
                quantity: 1000,
                unit: 'g',
                description: 'Added from Grocery List purchase receipt',
            }),
        );

        await expect(LocalInventoryService.deduplicateByName()).resolves.toBe(1);

        expect(database.rows.get('manual-a')?.quantity).toBe(5);
        expect(database.rows.has('manual-b')).toBe(false);
        expect(database.rows.get('different-unit')?.quantity).toBe(500);
        expect(database.rows.get('different-locker')?.quantity).toBe(1);
        expect(database.rows.get('receipt')?.quantity).toBe(1000);
    });
});
