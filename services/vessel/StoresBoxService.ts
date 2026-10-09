/**
 * StoresBoxService — named boxes in Ship's Stores (126-11a).
 *
 * Shane, 2026-10-09: "boxes in the engine room, that i scan the nfc tag which
 * is stuck on the front of the box and it will show me everything that is in
 * that box." A box is its own synced record (stores_boxes, 20261010153000),
 * shared through the 'stores' register like the items; an item points at its
 * box with inventory_items.box_id. That link is soft (no foreign key: offline
 * pushes do not order across tables), so an unknown box id is "not in a box".
 * The box id is a random lowercase UUID and names nothing: it is what 126-11b
 * writes on the tag.
 *
 * Local-first like LocalInventoryService: every write lands in the local
 * mirror and the outbox, and sends only what changed. Reads honour the
 * shared-binder filter, so a crew phone never shows its own boxes mixed with
 * the skipper's.
 *
 * Deploy order: the build reaches phones before Shane pushes the migration,
 * and an item push carrying box_id to a server without that column would fail
 * and fence every later Stores edit. So nothing here writes until SyncService
 * has read stores_boxes from the server on this device (serverHasBoxes()).
 *
 * Older builds (125 and earlier) know nothing of boxes: putting an item in a
 * box also writes the box's zone and name into the item's Zone and Specific,
 * and renaming or re-zoning a box writes them again. Taking an item out
 * leaves the text.
 */
import {
    atomicLocalTransaction,
    generateUUID,
    getById,
    getLocalDatabaseSession,
    getSyncMeta,
    insertLocal,
    query,
} from './LocalDatabase';
import { assertBinderDeletable, assertBinderWritable, binderInsertOwner, binderRowFilter } from './sharedBinders';
import { LocalInventoryService } from './LocalInventoryService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { changedFields } from '../../utils/changedFields';
import type { InventoryItem, StoresBox } from '../../types';

const TABLE = 'stores_boxes';
const ITEMS = 'inventory_items';
const REGISTER = 'stores' as const;
export const BOXES_NOT_LIVE = 'Boxes arrive with the next server update';
export const BOXES_SIGN_IN = 'Sign in to use boxes';
export const BOX_NOT_HERE = "This box isn't in Ship's Stores on this phone";

/** Why boxes are not on yet: signed out, or the server has not got them (or not synced yet). */
export const boxesNotLive = () => (getAuthIdentityScope().userId ? BOXES_NOT_LIVE : BOXES_SIGN_IN);

/**
 * Has SyncService read stores_boxes from the server on this device, for this
 * account? Only then may a box, or an item's box_id, be written. Any doubt (the
 * database switching accounts, or not open) is "not yet".
 */
export function serverHasBoxes(scope = getAuthIdentityScope()): boolean {
    try {
        return (
            !!scope.userId &&
            isAuthIdentityScopeCurrent(scope) &&
            getLocalDatabaseSession().identity === scope.userId &&
            typeof getSyncMeta().optionalTablesReadAt?.[TABLE] === 'string'
        );
    } catch {
        return false;
    }
}

function requireLive(): void {
    if (!serverHasBoxes()) throw new Error(boxesNotLive());
}

/** A name or zone as the table holds it: trimmed, at most 80 characters, '' as null. */
const text = (value: string | null | undefined) => value?.trim().slice(0, 80).trim() || null;

function named(name: string): string {
    const clean = text(name);
    if (!clean) throw new RangeError('A box needs a name');
    return clean;
}

/** The box to change, refusing (before anything is queued) what the share forbids. */
function writable(id: string): StoresBox {
    requireLive();
    const box = StoresBoxService.get(id);
    if (!box) throw new Error(BOX_NOT_HERE);
    assertBinderWritable(REGISTER, box);
    return box;
}

export const StoresBoxService = {
    /** The boxes in the Stores this page shows, by name. */
    list(): StoresBox[] {
        if (!serverHasBoxes()) return [];
        return query<StoresBox>(TABLE, binderRowFilter(REGISTER)).sort((a, b) => a.name.localeCompare(b.name));
    },

    get(id: string): StoresBox | null {
        const box = getById<StoresBox>(TABLE, id);
        return box && binderRowFilter(REGISTER)(box) ? box : null;
    },

    itemsIn(boxId: string): InventoryItem[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<InventoryItem>(ITEMS, (item) => inBinder(item) && item.box_id === boxId);
    },

    async create(fields: { name: string; location_zone?: string | null }): Promise<StoresBox> {
        requireLive();
        const now = new Date().toISOString();
        return insertLocal<StoresBox>(TABLE, {
            id: generateUUID(),
            // The skipper's id in a shared Stores (refused when view only).
            user_id: binderInsertOwner(REGISTER),
            name: named(fields.name),
            location_zone: text(fields.location_zone),
            notes: null,
            created_at: now,
            updated_at: now,
        });
    },

    /**
     * Rename and re-zone a box, and write the same into every item in it (for
     * older builds), in one local write burst.
     */
    async edit(id: string, name: string, zone: string | null): Promise<StoresBox | null> {
        const box = writable(id);
        const patch = changedFields(box, { name: named(name), location_zone: text(zone) });
        const mirror: Partial<InventoryItem> = {};
        if (patch.name) mirror.location_specific = patch.name;
        if ('location_zone' in patch) mirror.location_zone = patch.location_zone;
        if (!Object.keys(patch).length) return box;
        const items = StoresBoxService.itemsIn(id);
        return atomicLocalTransaction((tx) => {
            for (const item of items) tx.update<InventoryItem>(ITEMS, item.id, mirror);
            return tx.update<StoresBox>(TABLE, id, patch);
        });
    },

    /** Delete a box (the Stores owner only). Its items stay in Stores, not in a box. */
    async delete(id: string): Promise<void> {
        requireLive();
        const box = StoresBoxService.get(id);
        if (!box) return;
        assertBinderDeletable(REGISTER, box);
        const items = StoresBoxService.itemsIn(id);
        await atomicLocalTransaction((tx) => {
            for (const item of items) tx.update<InventoryItem>(ITEMS, item.id, { box_id: null });
            tx.delete(TABLE, id);
        });
    },

    /** Put items in a box, moving them from any other. Returns how many moved. */
    async putItems(boxId: string, itemIds: readonly string[]): Promise<number> {
        const box = writable(boxId);
        const moving = itemIds
            .map((itemId) => LocalInventoryService.getItem(itemId))
            .filter((item): item is InventoryItem => !!item && item.box_id !== box.id);
        for (const item of moving) assertBinderWritable(REGISTER, item);
        if (moving.length) {
            await atomicLocalTransaction((tx) => {
                for (const item of moving) {
                    tx.update<InventoryItem>(ITEMS, item.id, {
                        box_id: box.id,
                        location_zone: box.location_zone,
                        location_specific: box.name,
                    });
                }
            });
        }
        return moving.length;
    },
};
