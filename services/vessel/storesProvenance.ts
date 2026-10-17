/**
 * Stores rows the Grocery List made (131-B14).
 *
 * Ticking an item bought on the Grocery List adds it to Ship's Stores under
 * the purchase's own id, with a machine line for its notes: 'Added from
 * Grocery List purchase <id>' ('Stock retained after undoing …' once it is
 * un-ticked with stock added by hand since). Un-ticking, and ticking again,
 * find the row by that line, its name and its unit (ShoppingListService, and
 * the server's trigger for a tick on another phone).
 *
 * So the skipper sees a small chip instead of the line, and on these rows the
 * name, unit and notes stay as the Grocery List wrote them. Moving the line
 * into a column of its own needs a database change, not in this build.
 */
import type { InventoryItem } from '../../types';

export const GROCERY_BOUGHT_PREFIX = 'Added from Grocery List purchase ';
export const GROCERY_RETAINED_PREFIX = 'Stock retained after undoing Grocery List purchase ';

export type GroceryProvenance = 'bought' | 'retained';

/** Whether the Grocery List made this row, and how it stands. */
export function groceryProvenance(item: Pick<InventoryItem, 'description'>): GroceryProvenance | null {
    const notes = item.description ?? '';
    if (notes.startsWith(GROCERY_BOUGHT_PREFIX)) return 'bought';
    if (notes.startsWith(GROCERY_RETAINED_PREFIX)) return 'retained';
    return null;
}

/** The chip's words. */
export const GROCERY_CHIP: Record<GroceryProvenance, string> = {
    bought: 'Bought on the Grocery List',
    // Un-ticked, with stock added by hand since: what is left came that way.
    retained: 'From the Grocery List',
};

/** Why the name, unit and notes can't be changed on such a row. */
export const GROCERY_LOCKED =
    'Its name, unit and notes stay as the Grocery List wrote them, so ticking or un-ticking it there still works.';

/** The notes a person wrote: none on a Grocery List row (its machine line is the chip). */
export function storesNotes(item: Pick<InventoryItem, 'description'>): string | null {
    if (groceryProvenance(item)) return null;
    return item.description?.trim() || null;
}
