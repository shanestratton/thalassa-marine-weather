/**
 * Low stock goes on the shopping list by itself (126-11a, decision 5).
 *
 * Shane was told on 2026-10-09: "When you take the last spare filter, it goes
 * on your shopping list automatically". Narrowly: only a manual − that takes
 * an item INTO Low (before above its minimum, after at or under it, with a
 * minimum set), only for the account's own Stores, and only onto the list the
 * Galley shows when that is the account's own passage or its personal list.
 *
 * Fictional stores, on no particular coast: a raw-water impeller, a Racor
 * filter, a Japanese-labelled pump belt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

const h = vi.hoisted(() => ({
    addManualItem: vi.fn(async (_opts: Record<string, unknown>) => ({ id: 'grocery-1' })),
    activePassageId: null as string | null,
    cachedVoyage: null as { id: string; user_id: string } | null,
    storesSource: { mode: 'own' } as Record<string, unknown>,
    galleyOwner: null as string | null,
}));

vi.mock('../services/ShoppingListService', () => ({ addManualItem: h.addManualItem }));
vi.mock('../services/PassagePlanService', () => ({ getActivePassageId: () => h.activePassageId }));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => h.cachedVoyage }));
vi.mock('../services/vessel/sharedBinders', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/vessel/sharedBinders')>()),
    getBinderSource: () => h.storesSource,
    galleyShareOwner: () => h.galleyOwner,
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { addRestock, restockFor } from '../services/vessel/storesRestock';

const ME = '0b9e6a52-4d1c-4f3e-9a7b-2c8d1e5f6a01';
const SKIPPER = '7c2f9d14-8e3a-4b6c-a1d5-3f9e2b7c4d02';

function item(extra: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id: 'b1f4c2d8-3e5a-4c7b-9d1e-6f2a8b4c0e11',
        user_id: ME,
        barcode: null,
        item_name: 'Raw-water impeller',
        description: null,
        category: 'Engine',
        quantity: 2,
        min_quantity: 2,
        unit: 'whole',
        location_zone: 'Engine room',
        location_specific: 'Engine room spares 3',
        expiry_date: null,
        created_at: '2026-10-10T00:00:00.000Z',
        updated_at: '2026-10-10T00:00:00.000Z',
        ...extra,
    } as InventoryItem;
}

const level = (quantity: number, min_quantity: number) => ({ quantity, min_quantity });

beforeEach(() => {
    h.addManualItem.mockClear();
    h.activePassageId = null;
    h.cachedVoyage = null;
    h.storesSource = { mode: 'own' };
    h.galleyOwner = null;
    setAuthIdentityScope(ME);
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('restockFor: only a step INTO Low, enough to bring it back above the minimum', () => {
    it('3 → 2 with a minimum of 2 crosses into Low: buy 1', () => {
        expect(restockFor(level(3, 2), level(2, 2))).toBe(1);
    });

    it('2 → 1 with a minimum of 2 was already Low: nothing', () => {
        expect(restockFor(level(2, 2), level(1, 2))).toBeNull();
    });

    it('no minimum set (0): never', () => {
        expect(restockFor(level(2, 0), level(1, 0))).toBeNull();
        expect(restockFor(level(1, 0), level(0, 0))).toBeNull();
    });

    it('1 → 0 with a minimum of 1 (the last spare Racor filter): buy 2', () => {
        // Shane was promised exactly this: "When you take the last spare
        // filter, it goes on your shopping list automatically", even when the
        // filter already sat at its minimum.
        expect(restockFor(level(1, 1), level(0, 1))).toBe(2);
        expect(restockFor(level(2, 1), level(1, 1))).toBe(1);
        expect(restockFor(level(2, 1), level(0, 1))).toBe(2);
    });

    it('the last one taken goes on again, topped up to above the minimum', () => {
        // 3 → 2 put one impeller on; 2 → 1 added nothing; taking the last one
        // asks for three (the list merges it into the same line).
        expect(restockFor(level(1, 2), level(0, 2))).toBe(3);
    });

    it('a + never adds anything', () => {
        expect(restockFor(level(1, 2), level(2, 2))).toBeNull();
        expect(restockFor(level(2, 2), level(3, 2))).toBeNull();
    });

    it('a fractional count is bought in the item’s unit without float noise', () => {
        expect(restockFor(level(2.5, 2), level(1.5, 2))).toBe(1.5);
    });
});

describe('addRestock: the list the Galley shows, when it is this account’s own', () => {
    it('no passage selected: the personal list, in the item’s unit', async () => {
        const line = await addRestock(item({ quantity: 2 }), 1);
        expect(h.addManualItem).toHaveBeenCalledTimes(1);
        expect(h.addManualItem).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Raw-water impeller', qty: 1, unit: 'whole', voyageId: null }),
        );
        expect(line).toBe('Raw-water impeller added to the shopping list');
    });

    it('sizes against the unbought line: it asks for "at least", and says nothing when the line holds enough', async () => {
        await addRestock(item({ quantity: 2 }), 1);
        expect(h.addManualItem).toHaveBeenCalledWith(expect.objectContaining({ qty: 1, atLeast: true }));
        // The list already holds that many (a minimum crossed again): no toast.
        h.addManualItem.mockResolvedValueOnce(null as never);
        expect(await addRestock(item({ quantity: 2 }), 1)).toBeNull();
    });

    it("the Galley's own passage: that passage's list", async () => {
        h.activePassageId = 'f3a9c1e7-2b4d-4f6a-8c0e-1d3b5a7c9e21';
        h.cachedVoyage = { id: 'f3a9c1e7-2b4d-4f6a-8c0e-1d3b5a7c9e21', user_id: ME };
        const line = await addRestock(item({ item_name: 'Racor 2010PM filter', quantity: 0, min_quantity: 1 }), 2);
        expect(h.addManualItem).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Racor 2010PM filter',
                qty: 2,
                voyageId: 'f3a9c1e7-2b4d-4f6a-8c0e-1d3b5a7c9e21',
                ownerUserId: ME,
            }),
        );
        expect(line).toBe('Racor 2010PM filter added to the shopping list');
    });

    it("the cached voyage with no passage picked is the Galley's list too, when it is ours", async () => {
        h.cachedVoyage = { id: 'a4b6c8d0-1e3f-4a5b-9c7d-2e4f6a8b0c31', user_id: ME };
        await addRestock(item(), 1);
        expect(h.addManualItem).toHaveBeenCalledWith(
            expect.objectContaining({ voyageId: 'a4b6c8d0-1e3f-4a5b-9c7d-2e4f6a8b0c31' }),
        );
    });

    it("someone else's passage: the personal list instead, and the toast says so", async () => {
        h.activePassageId = 'c5d7e9f1-3a5b-4c7d-8e9f-4a6b8c0d2e41';
        h.cachedVoyage = { id: 'c5d7e9f1-3a5b-4c7d-8e9f-4a6b8c0d2e41', user_id: SKIPPER };
        const line = await addRestock(item({ item_name: '冷却水ポンプ ベルト' }), 1);
        expect(h.addManualItem).toHaveBeenCalledWith(
            expect.objectContaining({ name: '冷却水ポンプ ベルト', voyageId: null }),
        );
        expect(line).toBe('冷却水ポンプ ベルト added to your own shopping list');
    });

    it('never fires for a shared Stores binder (crew restock is a later build)', async () => {
        h.storesSource = { mode: 'shared', ownerId: SKIPPER, vesselName: 'Kestrel', canWrite: true, canDelete: false };
        expect(await addRestock(item({ user_id: SKIPPER }), 1)).toBeNull();
        expect(h.addManualItem).not.toHaveBeenCalled();
    });

    it("never fires for another owner's row", async () => {
        expect(await addRestock(item({ user_id: SKIPPER }), 1)).toBeNull();
        expect(h.addManualItem).not.toHaveBeenCalled();
    });

    it("never puts it on a skipper's shared galley list (the personal list there is his)", async () => {
        h.galleyOwner = SKIPPER;
        expect(await addRestock(item(), 1)).toBeNull();
        expect(h.addManualItem).not.toHaveBeenCalled();
    });

    it('never fires signed out', async () => {
        setAuthIdentityScope(null);
        expect(await addRestock(item({ user_id: '' }), 1)).toBeNull();
        expect(h.addManualItem).not.toHaveBeenCalled();
    });
});
