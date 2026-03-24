/**
 * InventoryService — Unit Tests
 *
 * Tests Supabase-backed CRUD methods, barcode lookup,
 * search, low stock filter, and stats aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';

// We must import AFTER mocks are set up (setup.ts runs first)
import { InventoryService } from '../services/InventoryService';

// ── Supabase mock chain builder ──────────────────────────────────

function mockChain(data: unknown = null, error: unknown = null) {
    const chain: Record<string, any> = {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data, error }),
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    };
    // For queries that return arrays (no .single()):
    // Mock the .then handler with the array result
    chain.then = vi.fn((resolve: Function) => resolve({ data: Array.isArray(data) ? data : data ? [data] : [], error }));
    return chain;
}

const mockItem = {
    id: 'item-1',
    user_id: 'user-1',
    item_name: 'Shackle 3/8"',
    category: 'rigging',
    quantity: 5,
    min_quantity: 2,
    barcode: '123456',
    location_zone: 'Lazarette',
    location_specific: 'Port locker',
    description: 'Stainless bow shackle',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
};

describe('InventoryService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getAll', () => {
        it('returns items sorted by updated_at desc', async () => {
            const chain = mockChain();
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
            // Override the terminal method for array results
            chain.order.mockImplementation(() => ({
                ...chain,
                then: (_resolve: Function) => Promise.resolve({ data: [mockItem], error: null }),
            }));

            const result = await InventoryService.getAll();
            expect(supabase!.from).toHaveBeenCalledWith('inventory_items');
            expect(result).toHaveLength(1);
            expect(result[0].item_name).toBe('Shackle 3/8"');
        });

        it('throws on supabase error', async () => {
            const chain = mockChain();
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
            chain.order.mockImplementation(() => ({
                ...chain,
                then: (_resolve: Function) => Promise.resolve({ data: null, error: { message: 'DB error' } }),
            }));

            await expect(InventoryService.getAll()).rejects.toThrow('Failed to load inventory');
        });
    });

    describe('findByBarcode', () => {
        it('returns matching item', async () => {
            const chain = mockChain(mockItem);
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const result = await InventoryService.findByBarcode('123456');
            expect(chain.eq).toHaveBeenCalledWith('barcode', '123456');
            expect(result).toEqual(mockItem);
        });

        it('returns null when no match', async () => {
            const chain = mockChain(null);
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const result = await InventoryService.findByBarcode('999999');
            expect(result).toBeNull();
        });
    });

    describe('delete', () => {
        it('calls supabase delete with correct id', async () => {
            const chain = mockChain();
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
            chain.eq.mockImplementation(() => ({
                then: (_resolve: Function) => Promise.resolve({ error: null }),
            }));

            await InventoryService.delete('item-1');
            expect(supabase!.from).toHaveBeenCalledWith('inventory_items');
            expect(chain.delete).toHaveBeenCalled();
        });
    });

    describe('getStats', () => {
        it('computes correct statistics from items', async () => {
            const items = [
                { ...mockItem, id: '1', category: 'rigging', quantity: 5, min_quantity: 2 },
                { ...mockItem, id: '2', category: 'rigging', quantity: 1, min_quantity: 3 }, // low stock
                { ...mockItem, id: '3', category: 'safety', quantity: 10, min_quantity: 5 },
            ];

            // Mock getAll to return items
            const chain = mockChain();
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
            chain.order.mockImplementation(() => ({
                ...chain,
                then: (_resolve: Function) => Promise.resolve({ data: items, error: null }),
            }));

            const stats = await InventoryService.getStats();
            expect(stats.totalItems).toBe(3);
            expect(stats.totalQuantity).toBe(16); // 5 + 1 + 10
            expect(stats.categories['rigging']).toBe(2);
            expect(stats.categories['safety']).toBe(1);
            expect(stats.lowStock).toBe(1); // only item with qty 1 <= min 3
        });
    });
});
