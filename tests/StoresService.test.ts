/**
 * StoresService — Unit Tests
 *
 * Tests CRUD operations and statistics aggregation
 * with mocked Supabase chains.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';
import { StoresService } from '../services/StoresService';

const mockItem = {
    id: 'store-1',
    user_id: 'user-1',
    item_name: 'Anchor Chain',
    category: 'rigging',
    quantity: 2,
    min_quantity: 1,
    barcode: '',
    location_zone: 'Forepeak',
    location_specific: 'Chain locker',
    description: '10mm galvanized',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
};

describe('StoresService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getAll', () => {
        it('calls from(inventory_items) and returns array', async () => {
            const chain = {
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockImplementation(() =>
                    Promise.resolve({ data: [mockItem], error: null })
                ),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const items = await StoresService.getAll();
            expect(supabase!.from).toHaveBeenCalledWith('inventory_items');
            expect(items).toHaveLength(1);
            expect(items[0].item_name).toBe('Anchor Chain');
        });

        it('throws on error', async () => {
            const chain = {
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockImplementation(() =>
                    Promise.resolve({ data: null, error: { message: 'Failed' } })
                ),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            await expect(StoresService.getAll()).rejects.toThrow('Failed to load stores');
        });
    });

    describe('getByCategory', () => {
        it('filters by category', async () => {
            const chain = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                order: vi.fn().mockImplementation(() =>
                    Promise.resolve({ data: [mockItem], error: null })
                ),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const items = await StoresService.getByCategory('rigging' as any);
            expect(chain.eq).toHaveBeenCalledWith('category', 'rigging');
            expect(items).toHaveLength(1);
        });
    });

    describe('findByBarcode', () => {
        it('returns matched item', async () => {
            const chain = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: mockItem, error: null }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const item = await StoresService.findByBarcode('123');
            expect(item).toEqual(mockItem);
        });

        it('returns null when not found', async () => {
            const chain = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const item = await StoresService.findByBarcode('unknown');
            expect(item).toBeNull();
        });
    });

    describe('delete', () => {
        it('calls delete with correct id', async () => {
            const chain = {
                delete: vi.fn().mockReturnThis(),
                eq: vi.fn().mockImplementation(() => Promise.resolve({ error: null })),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            await StoresService.delete('store-1');
            expect(chain.delete).toHaveBeenCalled();
            expect(chain.eq).toHaveBeenCalledWith('id', 'store-1');
        });

        it('throws on delete error', async () => {
            const chain = {
                delete: vi.fn().mockReturnThis(),
                eq: vi.fn().mockImplementation(() =>
                    Promise.resolve({ error: { message: 'RLS error' } })
                ),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            await expect(StoresService.delete('bad-id')).rejects.toThrow('Failed to delete item');
        });
    });

    describe('getStats', () => {
        it('computes correct aggregation', async () => {
            const items = [
                { ...mockItem, id: '1', category: 'rigging', quantity: 5, min_quantity: 2 },
                { ...mockItem, id: '2', category: 'safety', quantity: 0, min_quantity: 1 },
                { ...mockItem, id: '3', category: 'rigging', quantity: 3, min_quantity: 0 },
            ];

            const chain = {
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockImplementation(() =>
                    Promise.resolve({ data: items, error: null })
                ),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);

            const stats = await StoresService.getStats();
            expect(stats.totalItems).toBe(3);
            expect(stats.totalQuantity).toBe(8);
            expect(stats.categories['rigging']).toBe(2);
            expect(stats.categories['safety']).toBe(1);
            expect(stats.lowStock).toBe(1); // item 2: qty 0 <= min 1, min > 0
        });
    });
});
