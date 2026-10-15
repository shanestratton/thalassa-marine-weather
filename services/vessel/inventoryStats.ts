/**
 * inventoryStats — the Ship's Stores header numbers, from a list of rows.
 *
 * Pure, so Stores counts what is on screen: a row waiting out its undo
 * window is hidden from the list and from these numbers alike (126-B10a).
 * LocalInventoryService.getStats() is the same sum over the stored rows. A
 * module of its own, so the suites that replace LocalInventoryService
 * wholesale keep the real arithmetic.
 *
 * One low-stock rule (131-B14): at or under a minimum that is set. The header,
 * the box page, a scanned item's sheet, the PDF and each Stores card (131-B12)
 * ask isLowStock. The header used to count every empty row with no minimum as
 * low, while the cards did not.
 */
import type { InventoryItem } from '../../types';

/** Low: at or under a minimum that is set. */
export const isLowStock = (item: Pick<InventoryItem, 'quantity' | 'min_quantity'>): boolean =>
    item.min_quantity > 0 && item.quantity <= item.min_quantity;

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
        if (isLowStock(item)) lowStock++;
    }
    return { totalItems: items.length, totalQuantity, lowStock, categories };
}
