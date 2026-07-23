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
    deltaLocal,
    deleteLocal,
    generateUUID,
} from './LocalDatabase';
import type { InventoryItem, InventoryCategory } from '../../types';

const TABLE = 'inventory_items';
const GROCERY_RECEIPT_PREFIX = 'Added from Grocery List purchase ';

function requireNonNegativeAmount(amount: number, label: string): void {
    if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`${label} must be a finite number greater than or equal to zero.`);
    }
}

function normalizedText(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

function deduplicationKey(item: InventoryItem): string {
    return JSON.stringify([
        normalizedText(item.item_name),
        normalizedText(item.unit),
        item.category,
        normalizedText(item.barcode),
        normalizedText(item.description),
        normalizedText(item.location_zone),
        normalizedText(item.location_specific),
        normalizedText(item.expiry_date),
        item.min_quantity,
        item.currency,
        item.unit_value,
    ]);
}

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
        return query<InventoryItem>(
            TABLE,
            (item) =>
                item.item_name.toLowerCase().includes(lower) ||
                (item.description || '').toLowerCase().includes(lower) ||
                (item.barcode || '').includes(term),
        );
    }

    /** Find an item by barcode (first match or null) */
    static findByBarcode(barcode: string): InventoryItem | null {
        const results = query<InventoryItem>(TABLE, (item) => item.barcode === barcode);
        return results.length > 0 ? results[0] : null;
    }

    /** Get items by category */
    static getByCategory(category: InventoryCategory): InventoryItem[] {
        return query<InventoryItem>(TABLE, (item) => item.category === category);
    }

    /** Get items below minimum quantity (alerts) */
    static getLowStock(): InventoryItem[] {
        return query<InventoryItem>(TABLE, (item) => item.quantity <= item.min_quantity);
    }

    /** Create a new inventory item */
    static async create(
        item: Omit<InventoryItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<InventoryItem> {
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
        requireNonNegativeAmount(amount, 'Increment amount');
        if (amount === 0) return getById<InventoryItem>(TABLE, id);
        return await deltaLocal<InventoryItem>(TABLE, id, 'quantity', amount);
    }

    /** Decrement quantity (floor at 0) */
    static async decrementQuantity(id: string, amount: number = 1): Promise<InventoryItem | null> {
        requireNonNegativeAmount(amount, 'Decrement amount');
        if (amount === 0) return getById<InventoryItem>(TABLE, id);
        return await deltaLocal<InventoryItem>(TABLE, id, 'quantity', -amount);
    }

    /** Delete an item */
    static async delete(id: string): Promise<void> {
        return await deleteLocal(TABLE, id);
    }

    /** Get inventory stats */
    static getStats(): {
        totalItems: number;
        totalQuantity: number;
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
            totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
            lowStock: items.filter((i) => i.quantity <= i.min_quantity).length,
            categories,
        };
    }

    // ── Aliases for compatibility with existing inventory consumers ──

    /** Alias for getItems used by the inventory list. */
    static getAll(): InventoryItem[] {
        return LocalInventoryService.getItems();
    }

    /** Adjust quantity with a single signed delta. */
    static async adjustQuantity(id: string, delta: number): Promise<InventoryItem | null> {
        if (!Number.isFinite(delta)) {
            throw new RangeError('Quantity adjustment must be a finite number.');
        }
        if (delta !== 0) return deltaLocal<InventoryItem>(TABLE, id, 'quantity', delta);
        return getById<InventoryItem>(TABLE, id);
    }

    /**
     * Merge only semantically identical duplicate rows.
     *
     * Name-only merging destroys storage, expiry, unit, and receipt identity.
     * Grocery receipt rows are always kept separate so undo can address the
     * deterministic inventory row created for that exact purchase.
     */
    static async deduplicateByName(): Promise<number> {
        const items = getAll<InventoryItem>(TABLE);
        const seen = new Map<string, InventoryItem>();
        let merged = 0;

        for (const item of items) {
            if (
                item.description?.startsWith(GROCERY_RECEIPT_PREFIX) ||
                !Number.isFinite(item.quantity) ||
                item.quantity < 0
            ) {
                continue;
            }

            const key = deduplicationKey(item);
            const existing = seen.get(key);
            if (existing) {
                const updated = await deltaLocal<InventoryItem>(TABLE, existing.id, 'quantity', item.quantity);
                if (!updated) continue;
                existing.quantity = updated.quantity;
                await deleteLocal(TABLE, item.id);
                merged++;
            } else {
                seen.set(key, item);
            }
        }

        return merged;
    }
}
