/**
 * InventoryService — CRUD operations for ship's inventory items.
 *
 * Wraps Supabase queries with typed responses.
 * Supports barcode lookup, full-text search, and category filtering.
 */
import { supabase } from './supabase';
import type { InventoryItem, InventoryCategory } from '../types';

const TABLE = 'inventory_items';

function getClient() {
    if (!supabase) throw new Error('Supabase not configured');
    return supabase;
}

export class InventoryService {
    // ── READ ──

    /** Fetch all inventory items for the current user */
    static async getAll(): Promise<InventoryItem[]> {
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) throw new Error(`Failed to load inventory: ${error.message}`);
        return (data || []) as InventoryItem[];
    }

    /** Fetch items filtered by category */
    static async getByCategory(category: InventoryCategory): Promise<InventoryItem[]> {
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .eq('category', category)
            .order('item_name');

        if (error) throw new Error(`Failed to load category: ${error.message}`);
        return (data || []) as InventoryItem[];
    }

    /** Look up an item by barcode (returns first match or null) */
    static async findByBarcode(barcode: string): Promise<InventoryItem | null> {
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .eq('barcode', barcode)
            .limit(1)
            .maybeSingle();

        if (error) throw new Error(`Barcode lookup failed: ${error.message}`);
        return data as InventoryItem | null;
    }

    /** Search items by name or location (case-insensitive partial match) */
    static async search(query: string): Promise<InventoryItem[]> {
        const pattern = `%${query}%`;
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .or(`item_name.ilike.${pattern},location_zone.ilike.${pattern},location_specific.ilike.${pattern},description.ilike.${pattern}`)
            .order('item_name')
            .limit(50);

        if (error) throw new Error(`Search failed: ${error.message}`);
        return (data || []) as InventoryItem[];
    }

    /** Get items that are at or below their minimum quantity threshold */
    static async getLowStock(): Promise<InventoryItem[]> {
        const { data, error } = await getClient()
            .from(TABLE)
            .select('*')
            .filter('quantity', 'lte', 'min_quantity') // quantity <= min_quantity
            .order('item_name');

        // Fallback: if the filter doesn't work server-side, do it client-side
        if (error) {
            const all = await InventoryService.getAll();
            return all.filter(item => item.quantity <= item.min_quantity);
        }
        return (data || []) as InventoryItem[];
    }

    // ── CREATE ──

    /** Add a new inventory item */
    static async create(item: Omit<InventoryItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<InventoryItem> {
        const { data: { user } } = await getClient().auth.getUser();
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
        return data as InventoryItem;
    }

    // ── UPDATE ──

    /** Update an existing inventory item */
    static async update(id: string, updates: Partial<Omit<InventoryItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<InventoryItem> {
        const { data, error } = await getClient()
            .from(TABLE)
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw new Error(`Failed to update item: ${error.message}`);
        return data as InventoryItem;
    }

    /** Quick quantity adjustment (increment/decrement) */
    static async adjustQuantity(id: string, delta: number): Promise<InventoryItem> {
        // Fetch current, apply delta, clamp to 0
        const { data: current, error: fetchErr } = await getClient()
            .from(TABLE)
            .select('quantity')
            .eq('id', id)
            .single();

        if (fetchErr || !current) throw new Error('Item not found');

        const newQty = Math.max(0, (current.quantity as number) + delta);
        return InventoryService.update(id, { quantity: newQty });
    }

    // ── DELETE ──

    /** Delete an inventory item */
    static async delete(id: string): Promise<void> {
        const { error } = await getClient()
            .from(TABLE)
            .delete()
            .eq('id', id);

        if (error) throw new Error(`Failed to delete item: ${error.message}`);
    }

    // ── STATS ──

    /** Get inventory summary stats */
    static async getStats(): Promise<{ totalItems: number; totalQuantity: number; categories: Record<string, number>; lowStock: number }> {
        const items = await InventoryService.getAll();
        const stats = {
            totalItems: items.length,
            totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
            categories: {} as Record<string, number>,
            lowStock: items.filter(i => i.quantity <= i.min_quantity && i.min_quantity > 0).length,
        };

        for (const item of items) {
            stats.categories[item.category] = (stats.categories[item.category] || 0) + 1;
        }

        return stats;
    }
}
