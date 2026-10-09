/**
 * inventoryStats — the Ship's Stores header numbers, from a list of rows.
 *
 * Pure, so Stores counts what is on screen: a row waiting out its undo
 * window is hidden from the list and from these numbers alike (126-B10a).
 * LocalInventoryService.getStats() is the same sum over the stored rows. A
 * module of its own, so the suites that replace LocalInventoryService
 * wholesale keep the real arithmetic.
 */
import type { InventoryItem } from '../../types';

export interface InventoryStats {
    totalItems: number;
    totalQuantity: number;
    lowStock: number;
    categories: Record<string, number>;
}

export function inventoryStats(
    items: readonly Pick<InventoryItem, 'category' | 'quantity' | 'min_quantity'>[],
): InventoryStats {
    const categories: Record<string, number> = {};
    let totalQuantity = 0;
    let lowStock = 0;
    for (const item of items) {
        categories[item.category] = (categories[item.category] || 0) + 1;
        totalQuantity += item.quantity;
        if (item.quantity <= item.min_quantity) lowStock++;
    }
    return { totalItems: items.length, totalQuantity, lowStock, categories };
}
