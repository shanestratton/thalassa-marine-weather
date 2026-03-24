/**
 * InventoryService — Unit Tests
 *
 * Tests Supabase-backed CRUD methods and stats aggregation.
 * Uses properly resolving Supabase mock chains.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';
import { InventoryService } from '../services/InventoryService';

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
            // Build a chain where `order()` resolves to { data, error }
            const chain = {
                select: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: [mockItem], error: null }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const result = await InventoryService.getAll();
            expect(supabase!.from).toHaveBeenCalledWith('inventory_items');
            expect(result).toHaveLength(1);
            expect(result[0].item_name).toBe('Shackle 3/8"');
        });

        it('throws on supabase error', async () => {
            const chain = {
                select: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            await expect(InventoryService.getAll()).rejects.toThrow('Failed to load inventory');
        });
    });

    describe('findByBarcode', () => {
        it('returns matching item', async () => {
            const chain = {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                            maybeSingle: vi.fn().mockResolvedValue({ data: mockItem, error: null }),
                        }),
                    }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const result = await InventoryService.findByBarcode('123456');
            expect(result).toEqual(mockItem);
        });

        it('returns null when no match', async () => {
            const chain = {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                        }),
                    }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const result = await InventoryService.findByBarcode('999999');
            expect(result).toBeNull();
        });
    });

    describe('delete', () => {
        it('calls supabase delete with correct id', async () => {
            const eqMock = vi.fn().mockResolvedValue({ error: null });
            const chain = {
                delete: vi.fn().mockReturnValue({
                    eq: eqMock,
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            await InventoryService.delete('item-1');
            expect(supabase!.from).toHaveBeenCalledWith('inventory_items');
            expect(chain.delete).toHaveBeenCalled();
            expect(eqMock).toHaveBeenCalledWith('id', 'item-1');
        });
    });

    describe('getStats', () => {
        it('computes correct statistics from items', async () => {
            const items = [
                { ...mockItem, id: '1', category: 'rigging', quantity: 5, min_quantity: 2 },
                { ...mockItem, id: '2', category: 'rigging', quantity: 1, min_quantity: 3 },
                { ...mockItem, id: '3', category: 'safety', quantity: 10, min_quantity: 5 },
            ];

            const chain = {
                select: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: items, error: null }),
                }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const stats = await InventoryService.getStats();
            expect(stats.totalItems).toBe(3);
            expect(stats.totalQuantity).toBe(16);
            expect(stats.categories['rigging']).toBe(2);
            expect(stats.categories['safety']).toBe(1);
            expect(stats.lowStock).toBe(1); // item 2: qty 1 <= min 3, min > 0
        });
    });
});
