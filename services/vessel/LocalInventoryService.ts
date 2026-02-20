/**
 * LocalInventoryService — Offline-first CRUD for Ship's Inventory.
 *
 * All reads/writes go to local database. Mutations are queued
 * for background sync to Supabase. UI never touches the network.
 */
import {
    getAll,
    getById,
    query,
    insertLocal,
    updateLocal,
    deleteLocal,
    generateUUID,
} from './LocalDatabase';
import type { InventoryItem, InventoryCategory } from '../../types';

const TABLE = 'inventory_items';

export class LocalInventoryService {

    /** Get all inventory items (from local cache) */
    static getItems(): InventoryItem[] {
        return getAll<InventoryItem>(TABLE);
    }

    /** Get a single item by ID */
    static getItem(id: string): InventoryItem | null {
        return getById<InventoryItem>(TABLE, id);
    }

    /** Search items by name (fuzzy) */
    static search(term: string): InventoryItem[] {
        const lower = term.toLowerCase();
        return query<InventoryItem>(TABLE, item =>
            item.item_name.toLowerCase().includes(lower) ||
            (item.description || '').toLowerCase().includes(lower) ||
            (item.barcode || '').includes(term)
        );
    }

    /** Get items by category */
    static getByCategory(category: InventoryCategory): InventoryItem[] {
        return query<InventoryItem>(TABLE, item => item.category === category);
    }

    /** Get items below minimum quantity (alerts) */
    static getLowStock(): InventoryItem[] {
        return query<InventoryItem>(TABLE, item => item.quantity <= item.min_quantity);
    }

    /** Create a new inventory item */
    static async create(item: Omit<InventoryItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<InventoryItem> {
        const now = new Date().toISOString();
        const record: InventoryItem = {
            ...item,
            id: generateUUID(),
            user_id: '', // Will be set during sync push
            created_at: now,
            updated_at: now,
        };

        return await insertLocal<InventoryItem>(TABLE, record);
    }

    /** Update an existing item */
    static async update(id: string, updates: Partial<InventoryItem>): Promise<InventoryItem | null> {
        return await updateLocal<InventoryItem>(TABLE, id, updates);
    }

    /** Increment quantity */
    static async incrementQuantity(id: string, amount: number = 1): Promise<InventoryItem | null> {
        const item = getById<InventoryItem>(TABLE, id);
        if (!item) return null;
        return await updateLocal<InventoryItem>(TABLE, id, {
            quantity: item.quantity + amount,
        } as Partial<InventoryItem>);
    }

    /** Decrement quantity (floor at 0) */
    static async decrementQuantity(id: string, amount: number = 1): Promise<InventoryItem | null> {
        const item = getById<InventoryItem>(TABLE, id);
        if (!item) return null;
        return await updateLocal<InventoryItem>(TABLE, id, {
            quantity: Math.max(0, item.quantity - amount),
        } as Partial<InventoryItem>);
    }

    /** Delete an item */
    static async delete(id: string): Promise<void> {
        return await deleteLocal(TABLE, id);
    }

    /** Get inventory stats */
    static getStats(): {
        totalItems: number;
        lowStock: number;
        categories: Record<string, number>;
    } {
        const items = getAll<InventoryItem>(TABLE);
        const categories: Record<string, number> = {};

        for (const item of items) {
            categories[item.category] = (categories[item.category] || 0) + 1;
        }

        return {
            totalItems: items.length,
            lowStock: items.filter(i => i.quantity <= i.min_quantity).length,
            categories,
        };
    }
}
