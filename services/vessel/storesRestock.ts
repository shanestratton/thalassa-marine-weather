/**
 * Low stock goes on the shopping list by itself (126-11a).
 *
 * What Shane was told on 2026-10-09: "When you take the last spare filter, it
 * goes on your shopping list automatically". Narrowly:
 *   - only a manual − on a Stores card or the box page (the Galley's meal
 *     deductions have their own shortfall list);
 *   - only when the − takes the item INTO Low (from above its minimum to at or
 *     under it), or takes the last one, and only when it has a minimum;
 *   - only for the account's own Stores (crew restock is a later build);
 *   - onto the list the Galley shows when that is the account's own passage or
 *     its personal list, otherwise its personal list (and the toast says so).
 * The item stays one line on the list, sized against what that unbought line
 * already holds (addManualItem's atLeast): a minimum crossed again, or a last
 * one taken after the crossing, tops the line up to what is needed, and
 * nothing is added (and no toast) when it already holds that many.
 */
import type { InventoryItem } from '../../types';
import { getAuthIdentityScope } from '../authIdentityScope';
import { getCachedActiveVoyage } from '../VoyageService';
import { addManualItem } from '../ShoppingListService';
import { getActivePassageId } from '../PassagePlanService';
import { galleyShareOwner, getBinderSource, isOwnBinderRow } from './sharedBinders';

type Stock = Pick<InventoryItem, 'quantity' | 'min_quantity'>;

/**
 * How many the shopping list should hold after a − from `before` to `after`:
 * enough to bring it back above its minimum, in the item's unit. Null when the
 * − is not one that restocks (no minimum, already Low and not emptied, or not
 * a −).
 */
export function restockFor(before: Stock, after: Stock): number | null {
    const min = after.min_quantity;
    const was = before.quantity;
    const now = after.quantity;
    if (!(min > 0) || !(now < was) || now > min) return null;
    if (was <= min && now > 0) return null;
    return Math.round((min - now + 1) * 1000) / 1000;
}

/**
 * See that the shopping list holds `qty` of the item. Returns the toast line,
 * or null when nothing was added (the line already held that many, a shared
 * Stores, another owner's row, signed out, or a personal list that is a
 * skipper's shared galley).
 */
export async function addRestock(item: InventoryItem, qty: number): Promise<string | null> {
    const me = getAuthIdentityScope().userId;
    if (!me || getBinderSource('stores').mode !== 'own' || !isOwnBinderRow(item) || item.user_id !== me) return null;
    const voyage = getCachedActiveVoyage();
    const shown = getActivePassageId() ?? voyage?.id ?? null;
    const ours = !!shown && voyage?.id === shown && voyage.user_id === me;
    // With no passage of its own, the list is the personal one: never a
    // skipper's shared galley list.
    if (!ours && galleyShareOwner()) return null;
    const added = await addManualItem({
        name: item.item_name,
        qty,
        unit: item.unit,
        voyageId: ours ? shown : null,
        ownerUserId: me,
        atLeast: true,
    });
    return added && `${item.item_name} added to ${shown && !ours ? 'your own' : 'the'} shopping list`;
}
