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
import {
    assertBinderDeletable,
    assertBinderWritable,
    binderInsertOwner,
    binderRowFilter,
    isOwnBinderRow,
    isRowInBinder,
} from './sharedBinders';
import type { InventoryItem, InventoryCategory } from '../../types';
import { inventoryStats, isLowStock, type InventoryStats } from './inventoryStats';
import { groceryProvenance } from './storesProvenance';

const TABLE = 'inventory_items';
// Whose stores these are: the skipper's while the sailor is crew on a boat
// that shares Ship's Stores, otherwise the sailor's own (sharedBinders.ts).
const REGISTER = 'stores' as const;

/** The row to change, refusing (before anything is queued) an edit the share forbids. */
function writableRow(id: string): InventoryItem | null {
    const row = getById<InventoryItem>(TABLE, id);
    assertBinderWritable(REGISTER, row);
    return row;
}

function requireNonNegativeAmount(amount: number, label: string): void {
    if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`${label} must be a finite number greater than or equal to zero.`);
    }
}

/**
 * A minimum is a whole number, as the server's min_quantity column is: a
 * decimal one would fail its push and hold up every later change to the row
 * (131-B14). The forms round a typed minimum up before it gets here.
 */
function requireMinimum(amount: number): void {
    requireNonNegativeAmount(amount, 'Minimum quantity');
    if (!Number.isInteger(amount)) throw new RangeError('Minimum quantity must be a whole number.');
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
        return query<InventoryItem>(TABLE, binderRowFilter(REGISTER));
    }

    /** Get a single item by ID */
    static getItem(id: string): InventoryItem | null {
        const row = getById<InventoryItem>(TABLE, id);
        return row && isRowInBinder(REGISTER, row) ? row : null;
    }

    /** Search items by name (fuzzy) */
    static search(term: string): InventoryItem[] {
        const lower = term.toLowerCase();
        const inBinder = binderRowFilter(REGISTER);
        return query<InventoryItem>(
            TABLE,
            (item) =>
                inBinder(item) &&
                (item.item_name.toLowerCase().includes(lower) ||
                    (item.description || '').toLowerCase().includes(lower) ||
                    (item.barcode || '').includes(term)),
        );
    }

    /** Find an item by barcode (first match or null) */
    static findByBarcode(barcode: string): InventoryItem | null {
        const inBinder = binderRowFilter(REGISTER);
        const results = query<InventoryItem>(TABLE, (item) => inBinder(item) && item.barcode === barcode);
        return results.length > 0 ? results[0] : null;
    }

    /** Get items by category */
    static getByCategory(category: InventoryCategory): InventoryItem[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<InventoryItem>(TABLE, (item) => inBinder(item) && item.category === category);
    }

    /** Get items at or under a minimum that is set: the one low-stock rule (131-B14) */
    static getLowStock(): InventoryItem[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<InventoryItem>(TABLE, (item) => inBinder(item) && isLowStock(item));
    }

    /**
     * Create a new inventory item. A count or minimum below nothing is refused
     * (131-B13), and a minimum that isn't whole (131-B14).
     */
    static async create(
        item: Omit<InventoryItem, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<InventoryItem> {
        requireNonNegativeAmount(item.quantity, 'Quantity');
        requireMinimum(item.min_quantity);
        // The skipper's id in a shared binder (refused when it is view only),
        // the sailor's own otherwise; '' only while signed out.
        const owner = binderInsertOwner(REGISTER);
        const now = new Date().toISOString();
        const record: InventoryItem = {
            ...item,
            id: generateUUID(),
            user_id: owner,
            created_at: now,
            updated_at: now,
        };

        return await insertLocal<InventoryItem>(TABLE, record);
    }

    /**
     * Update an existing item. A count or minimum below nothing is refused
     * (131-B13), and a minimum that isn't whole (131-B14).
     */
    static async update(id: string, updates: Partial<InventoryItem>): Promise<InventoryItem | null> {
        if (updates.quantity !== undefined) requireNonNegativeAmount(updates.quantity, 'Quantity');
        if (updates.min_quantity !== undefined) requireMinimum(updates.min_quantity);
        writableRow(id);
        return await updateLocal<InventoryItem>(TABLE, id, updates);
    }

    /** Increment quantity */
    static async incrementQuantity(id: string, amount: number = 1): Promise<InventoryItem | null> {
        requireNonNegativeAmount(amount, 'Increment amount');
        const row = writableRow(id);
        if (amount === 0) return row;
        return await deltaLocal<InventoryItem>(TABLE, id, 'quantity', amount);
    }

    /** Decrement quantity (floor at 0) */
    static async decrementQuantity(id: string, amount: number = 1): Promise<InventoryItem | null> {
        requireNonNegativeAmount(amount, 'Decrement amount');
        const row = writableRow(id);
        if (amount === 0) return row;
        return await deltaLocal<InventoryItem>(TABLE, id, 'quantity', -amount);
    }

    /** Delete an item */
    static async delete(id: string): Promise<void> {
        assertBinderDeletable(REGISTER, getById<InventoryItem>(TABLE, id));
        return await deleteLocal(TABLE, id);
    }

    /** Get inventory stats (the same sum the Stores header makes of its visible rows) */
    static getStats(): InventoryStats {
        return inventoryStats(LocalInventoryService.getItems());
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
        const row = writableRow(id);
        if (delta !== 0) return deltaLocal<InventoryItem>(TABLE, id, 'quantity', delta);
        return row;
    }

    /**
     * Merge only semantically identical duplicate rows.
     *
     * Name-only merging destroys storage, expiry, unit, and receipt identity.
     * Grocery receipt rows are always kept separate so undo can address the
     * deterministic inventory row created for that exact purchase.
     */
    static async deduplicateByName(): Promise<number> {
        // The sailor's own rows only: a crew device must never merge, and so
        // delete, rows in a skipper's stores (deletes there are owner-only).
        const items = getAll<InventoryItem>(TABLE).filter(isOwnBinderRow);
        const seen = new Map<string, InventoryItem>();
        let merged = 0;

        for (const item of items) {
            if (groceryProvenance(item) === 'bought' || !Number.isFinite(item.quantity) || item.quantity < 0) {
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
