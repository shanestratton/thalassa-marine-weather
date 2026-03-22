/**
 * StoresService — CRUD operations for Ship's Stores items.
 *
 * Wraps Supabase queries with typed responses.
 * Supports barcode lookup, full-text search, and category filtering.
 *
 * NOTE: Queries the 'inventory_items' table directly (the 'ships_stores'
 * view is for new code / direct SQL). Same data, same RLS.
 */
import { supabase } from './supabase';
import type { StoresItem, StoresCategory } from '../types';

const TABLE = 'inventory_items'; // Underlying table (ships_stores view points here)

function getClient() {
    if (!supabase) throw new Error('Supabase not configured');
    return supabase;
}

export class StoresService {
    // ── READ ──

    /** Fetch all stores items for the current user */
    static async getAll(): Promise<StoresItem[]> {
        const { data, error } = await getClient().from(TABLE).select('*').order('updated_at', { ascending: false });

        if (error) throw new Error(`Failed to load stores: ${error.message}`);
        return (data || []) as StoresItem[];
    }

    /** Fetch items filtered by category */
    static async getByCategory(category: StoresCategory): Promise<StoresItem[]> {
        const { data, error } = await getClient().from(TABLE).select('*').eq('category', category).order('item_name');

        if (error) throw new Error(`Failed to load category: ${error.message}`);
        return (data || []) as StoresItem[];
    }

    /** Look up an item by barcode (returns first match or null) */
    static async findByBarcode(barcode: string): Promise<StoresItem | null> {
        const { data, error } = await getClient().from(TABLE).select('*').eq('barcode', barcode).limit(1).maybeSingle();

        if (error) throw new Error(`Barcode lookup failed: ${error.message}`);
        return data as StoresItem | null;
    }

    /** Search items by name or location (case-insensitive partial match) */
    static async search(query: string): Promise<StoresItem[]> {
        const pattern = `%${query}%`;
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .or(
                `item_name.ilike.${pattern},location_zone.ilike.${pattern},location_specific.ilike.${pattern},description.ilike.${pattern}`,
            )
            .order('item_name')
            .limit(50);

        if (error) throw new Error(`Search failed: ${error.message}`);
        return (data || []) as StoresItem[];
    }

    /** Get items that are at or below their minimum quantity threshold */
    static async getLowStock(): Promise<StoresItem[]> {
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .filter('quantity', 'lte', 'min_quantity')
            .order('item_name');

        if (error) {
            const all = await StoresService.getAll();
            return all.filter((item) => item.quantity <= item.min_quantity);
        }
        return (data || []) as StoresItem[];
    }

    // ── CREATE ──

    /** Add a new stores item */
    static async create(item: Omit<StoresItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<StoresItem> {
        const {
            data: { user },
        } = await getClient().auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const { data, error } = await getClient()
            .from(TABLE)
            .insert({
                ...item,
                user_id: user.id,
            })
            .select()
            .single();

        if (error) throw new Error(`Failed to add item: ${error.message}`);
        return data as StoresItem;
    }

    // ── UPDATE ──

    /** Update an existing stores item */
    static async update(
        id: string,
        updates: Partial<Omit<StoresItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>>,
    ): Promise<StoresItem> {
        const { data, error } = await getClient().from(TABLE).update(updates).eq('id', id).select().single();

        if (error) throw new Error(`Failed to update item: ${error.message}`);
        return data as StoresItem;
    }

    /** Quick quantity adjustment (increment/decrement) */
    static async adjustQuantity(id: string, delta: number): Promise<StoresItem> {
        const { data: current, error: fetchErr } = await getClient()
            .from(TABLE)
            .select('quantity')
            .eq('id', id)
            .single();

        if (fetchErr || !current) throw new Error('Item not found');

        const newQty = Math.max(0, (current.quantity as number) + delta);
        return StoresService.update(id, { quantity: newQty });
    }

    // ── DELETE ──

    /** Delete a stores item */
    static async delete(id: string): Promise<void> {
        const { error } = await getClient().from(TABLE).delete().eq('id', id);

        if (error) throw new Error(`Failed to delete item: ${error.message}`);
    }

    // ── STATS ──

    /** Get stores summary stats */
    static async getStats(): Promise<{
        totalItems: number;
        totalQuantity: number;
        categories: Record<string, number>;
        lowStock: number;
    }> {
        const items = await StoresService.getAll();
        const stats = {
            totalItems: items.length,
            totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
            categories: {} as Record<string, number>,
            lowStock: items.filter((i) => i.quantity <= i.min_quantity && i.min_quantity > 0).length,
        };

        for (const item of items) {
            stats.categories[item.category] = (stats.categories[item.category] || 0) + 1;
        }

        return stats;
    }
}

/** @deprecated Use StoresService */
export const InventoryService = StoresService;
