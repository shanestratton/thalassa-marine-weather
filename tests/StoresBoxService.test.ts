/**
 * Boxes in Ship's Stores (126-11a): the box record, items put in boxes, and
 * the place mirrored into the item for older builds.
 *
 * Shane, 2026-10-09: "i would like to add them ... so that we can have boxes
 * in the engine room, that i scan the nfc tag which is stuck on the front of
 * the box and it will show me everything that is in that box."
 *
 * The real LocalDatabase on the mocked (memory) filesystem: every write goes
 * to the local mirror first and queues for sync. Nothing is written until the
 * server is known to have stores_boxes (SyncMeta.optionalTablesReadAt): an
 * item push carrying box_id to a server without that column would fail and
 * fence every Stores edit behind it.
 *
 * Fictional and global: 'Engine room spares 3', 'Lazarette bin B' and
 * 'Coffre avant'; a raw-water impeller, a Racor filter and a pump belt.
 */
import { Filesystem } from '@capacitor/filesystem';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    query,
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { LocalInventoryService } from '../services/vessel/LocalInventoryService';
import { StoresBoxService, boxesNotLive, serverHasBoxes } from '../services/vessel/StoresBoxService';

const NOW = '2026-10-10T01:00:00.000Z';
const WATERMARK = '2026-10-10T02:00:00.000Z';
let counter = 0;
let me = '';

function stores(id: string, name: string, quantity: number, min: number, extra: Partial<InventoryItem> = {}) {
    return {
        id,
        user_id: me,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Engine',
        quantity,
        min_quantity: min,
        unit: 'whole',
        location_zone: null,
        location_specific: null,
        expiry_date: null,
        created_at: NOW,
        updated_at: NOW,
        ...extra,
    } as InventoryItem;
}

const IMPELLER = 'a1b2c3d4-0001-4a5b-8c6d-7e8f9a0b1c01';
const RACOR = 'a1b2c3d4-0002-4a5b-8c6d-7e8f9a0b1c02';
const BELT = 'a1b2c3d4-0003-4a5b-8c6d-7e8f9a0b1c03';

const item = (id: string) => query<InventoryItem>('inventory_items', (row) => row.id === id)[0];
const queued = (table: string, id?: string) =>
    getFullQueue()
        .filter((entry) => entry.table_name === table && (!id || entry.record_id === id))
        .map((entry) => ({ type: entry.mutation_type, payload: JSON.parse(entry.payload) as Record<string, unknown> }));

async function signIn(live: boolean): Promise<void> {
    counter += 1;
    me = `0c1d2e3f-4a5b-4c6d-8e7f-${String(counter).padStart(12, '0')}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    await mergePulledRecords('inventory_items', [
        stores(IMPELLER, 'Raw-water impeller', 3, 2),
        stores(RACOR, 'Racor 2010PM filter', 1, 1),
        stores(BELT, '冷却水ポンプ ベルト', 2, 0),
    ]);
    if (live) await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: WATERMARK } });
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('a box is its own synced record', () => {
    beforeEach(() => signIn(true));

    it('create, rename and zone changes write locally and queue', async () => {
        expect(serverHasBoxes()).toBe(true);
        const box = await StoresBoxService.create({ name: '  Engine room spares 3 ', location_zone: 'Engine room' });

        expect(box).toMatchObject({ name: 'Engine room spares 3', location_zone: 'Engine room', user_id: me });
        expect(StoresBoxService.list().map((b) => b.name)).toEqual(['Engine room spares 3']);
        expect(queued('stores_boxes', box.id)).toEqual([
            {
                type: 'INSERT',
                payload: expect.objectContaining({ id: box.id, name: 'Engine room spares 3', user_id: me }),
            },
        ]);

        // Rename, then a zone change: each sends only what changed.
        await StoresBoxService.edit(box.id, 'Engine room spares 4', 'Engine room');
        await StoresBoxService.edit(box.id, 'Engine room spares 4', 'Machine room');
        expect(StoresBoxService.get(box.id)).toMatchObject({
            name: 'Engine room spares 4',
            location_zone: 'Machine room',
        });
        expect(queued('stores_boxes', box.id).slice(1)).toEqual([
            { type: 'UPDATE', payload: { name: 'Engine room spares 4', updated_at: expect.any(String) } },
            { type: 'UPDATE', payload: { location_zone: 'Machine room', updated_at: expect.any(String) } },
        ]);
    });

    it('a box id is a random lowercase UUID, and its tag link fits an NTAG213 with room to spare', async () => {
        const box = await StoresBoxService.create({ name: 'Coffre avant', location_zone: 'Pointe avant' });
        expect(box.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // 126-11b writes https://thalassawx.app/box/<id>: 63 bytes of the 144 an NTAG213 holds.
        expect(new TextEncoder().encode(`https://thalassawx.app/box/${box.id}`).length).toBe(63);
    });

    it('refuses a box with no name, and keeps a name to 80 characters', async () => {
        await expect(StoresBoxService.create({ name: '   ' })).rejects.toThrow(RangeError);
        const long = await StoresBoxService.create({ name: 'Lazarette bin B '.repeat(8) });
        expect(long.name.length).toBeLessThanOrEqual(80);
        expect(long.name).toBe(long.name.trim());
    });

    it('lists boxes by name, sorted for any language', async () => {
        await StoresBoxService.create({ name: 'Lazarette bin B', location_zone: 'Lazarette' });
        await StoresBoxService.create({ name: 'Coffre avant', location_zone: 'Pointe avant' });
        await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        expect(StoresBoxService.list().map((b) => b.name)).toEqual([
            'Coffre avant',
            'Engine room spares 3',
            'Lazarette bin B',
        ]);
    });
});

describe('items in boxes', () => {
    beforeEach(() => signIn(true));

    it('putItems sets box_id and mirrors the zone and name into the item for older builds', async () => {
        const engine = await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        const moved = await StoresBoxService.putItems(engine.id, [IMPELLER, RACOR]);

        expect(moved).toBe(2);
        expect(item(IMPELLER)).toMatchObject({
            box_id: engine.id,
            location_zone: 'Engine room',
            location_specific: 'Engine room spares 3',
        });
        expect(
            StoresBoxService.itemsIn(engine.id)
                .map((row) => row.id)
                .sort(),
        ).toEqual([IMPELLER, RACOR].sort());
        expect(queued('inventory_items', IMPELLER)).toEqual([
            {
                type: 'UPDATE',
                payload: {
                    box_id: engine.id,
                    location_zone: 'Engine room',
                    location_specific: 'Engine room spares 3',
                    updated_at: expect.any(String),
                },
            },
        ]);
        // The count is never part of it: two phones' −1s still add up.
        expect(queued('inventory_items', IMPELLER)[0].payload).not.toHaveProperty('quantity');
    });

    it("rename and a zone change re-mirror only that box's items", async () => {
        const engine = await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        const laz = await StoresBoxService.create({ name: 'Lazarette bin B', location_zone: 'Lazarette' });
        await StoresBoxService.putItems(engine.id, [IMPELLER, RACOR]);
        await StoresBoxService.putItems(laz.id, [BELT]);
        const beltQueue = queued('inventory_items', BELT).length;

        await StoresBoxService.edit(engine.id, 'Engine room spares 4', 'Engine room');
        await StoresBoxService.edit(engine.id, 'Engine room spares 4', 'Machine room');

        for (const id of [IMPELLER, RACOR]) {
            expect(item(id)).toMatchObject({
                location_zone: 'Machine room',
                location_specific: 'Engine room spares 4',
            });
        }
        expect(item(BELT)).toMatchObject({
            box_id: laz.id,
            location_zone: 'Lazarette',
            location_specific: 'Lazarette bin B',
        });
        expect(queued('inventory_items', BELT)).toHaveLength(beltQueue);
        expect(queued('inventory_items', IMPELLER).slice(-2)).toEqual([
            { type: 'UPDATE', payload: { location_specific: 'Engine room spares 4', updated_at: expect.any(String) } },
            { type: 'UPDATE', payload: { location_zone: 'Machine room', updated_at: expect.any(String) } },
        ]);
    });

    it('moving an item to another box re-mirrors it; taking it out leaves the old place text', async () => {
        const engine = await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        const bow = await StoresBoxService.create({ name: 'Coffre avant', location_zone: 'Pointe avant' });
        await StoresBoxService.putItems(engine.id, [BELT]);
        await StoresBoxService.putItems(bow.id, [BELT]);
        expect(item(BELT)).toMatchObject({
            box_id: bow.id,
            location_zone: 'Pointe avant',
            location_specific: 'Coffre avant',
        });
        expect(StoresBoxService.itemsIn(engine.id)).toEqual([]);

        // Out of the box, as the Edit sheet's "Not in a box" saves it.
        await LocalInventoryService.update(BELT, { box_id: null });
        expect(item(BELT)).toMatchObject({
            box_id: null,
            location_zone: 'Pointe avant',
            location_specific: 'Coffre avant',
        });
        expect(queued('inventory_items', BELT).at(-1)).toEqual({
            type: 'UPDATE',
            payload: { box_id: null, updated_at: expect.any(String) },
        });
    });

    it('putting an item in the box it is already in queues nothing', async () => {
        const engine = await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        await StoresBoxService.putItems(engine.id, [IMPELLER]);
        const before = getFullQueue().length;
        expect(await StoresBoxService.putItems(engine.id, [IMPELLER])).toBe(0);
        expect(getFullQueue()).toHaveLength(before);
    });

    it('deleting a box un-boxes its items and never deletes them', async () => {
        const engine = await StoresBoxService.create({ name: 'Engine room spares 3', location_zone: 'Engine room' });
        await StoresBoxService.putItems(engine.id, [IMPELLER, RACOR]);

        await StoresBoxService.delete(engine.id);

        expect(StoresBoxService.list()).toEqual([]);
        expect(StoresBoxService.get(engine.id)).toBeNull();
        for (const id of [IMPELLER, RACOR]) {
            expect(item(id)).toMatchObject({ box_id: null, location_specific: 'Engine room spares 3' });
        }
        const tail = getFullQueue().slice(-3);
        // Items first, then the box, in one burst.
        expect(tail.map((entry) => [entry.table_name, entry.mutation_type])).toEqual([
            ['inventory_items', 'UPDATE'],
            ['inventory_items', 'UPDATE'],
            ['stores_boxes', 'DELETE'],
        ]);
        expect(
            getFullQueue().some((entry) => entry.table_name === 'inventory_items' && entry.mutation_type === 'DELETE'),
        ).toBe(false);
    });

    it('an unknown box id is "not in a box"', async () => {
        await mergePulledRecords('inventory_items', [
            stores(IMPELLER, 'Raw-water impeller', 3, 2, { box_id: 'f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f' } as never),
        ]);
        expect(StoresBoxService.get('f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f')).toBeNull();
        expect(StoresBoxService.itemsIn('f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f')).toHaveLength(1);
        expect(StoresBoxService.list()).toEqual([]);
    });
});

describe('before the server has stores_boxes', () => {
    beforeEach(() => signIn(false));

    it('nothing is written and no row carries box_id', async () => {
        expect(serverHasBoxes()).toBe(false);
        await expect(StoresBoxService.create({ name: 'Engine room spares 3' })).rejects.toThrow(
            'Boxes arrive with the next server update',
        );
        await expect(StoresBoxService.putItems('b0c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e', [IMPELLER])).rejects.toThrow(
            'Boxes arrive with the next server update',
        );
        expect(StoresBoxService.list()).toEqual([]);
        expect(getFullQueue().filter((entry) => entry.table_name === 'stores_boxes')).toEqual([]);
        expect(getFullQueue().some((entry) => entry.payload.includes('box_id'))).toBe(false);
        expect(query<InventoryItem>('inventory_items', (row) => 'box_id' in row)).toEqual([]);
    });

    it('signed out, the words say to sign in, not to wait for an update that will not help', async () => {
        expect(boxesNotLive()).toBe('Boxes arrive with the next server update');
        act(() => setAuthIdentityScope(null));
        expect(serverHasBoxes()).toBe(false);
        expect(boxesNotLive()).toBe('Sign in to use boxes');
        await expect(StoresBoxService.create({ name: 'Engine room spares 3' })).rejects.toThrow('Sign in to use boxes');
    });

    it('a table that went missing again on the server is not live here either', async () => {
        await updateSyncMeta({ optionalTablesReadAt: {} });
        expect(serverHasBoxes()).toBe(false);
    });

    it('another account on this phone is not live because this one was', async () => {
        await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: WATERMARK } });
        expect(serverHasBoxes()).toBe(true);
        const other = { ...getAuthIdentityScope(), userId: 'someone-else', key: 'user:someone-else' };
        expect(serverHasBoxes(other)).toBe(false);
    });
});

describe('shared Stores: a crew phone shows only the skipper’s boxes', () => {
    const SKIPPER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    function share(write: boolean): void {
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1', getAuthIdentityScope()),
            JSON.stringify({
                version: 1,
                userId: me,
                confirmedAt: NOW,
                skippers: [
                    {
                        ownerId: SKIPPER,
                        vesselName: 'Kestrel',
                        lastAcceptedAt: NOW,
                        registers: {
                            stores: { read: true, write },
                            equipment: { read: false, write: false },
                            maintenance: { read: false, write: false },
                            documents: { read: false, write: false },
                        },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    }

    const box = (id: string, owner: string, name: string) => ({
        id,
        user_id: owner,
        name,
        location_zone: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
    });

    beforeEach(async () => {
        await signIn(true);
        await mergePulledRecords('stores_boxes', [
            box('11111111-2222-4333-8444-555555555551', SKIPPER, 'Lazarette bin B'),
            box('11111111-2222-4333-8444-555555555552', me, 'My own crate'),
        ]);
    });

    it('never mixes the crew member’s own boxes with the skipper’s', () => {
        share(true);
        expect(StoresBoxService.list().map((b) => b.name)).toEqual(['Lazarette bin B']);
        expect(StoresBoxService.get('11111111-2222-4333-8444-555555555552')).toBeNull();
    });

    it('a crew editor’s new box goes into the skipper’s Stores; only the skipper deletes one', async () => {
        share(true);
        const made = await StoresBoxService.create({ name: 'Coffre avant', location_zone: 'Pointe avant' });
        expect(made.user_id).toBe(SKIPPER);
        await expect(StoresBoxService.delete('11111111-2222-4333-8444-555555555551')).rejects.toThrow(
            'Only the skipper can delete',
        );
    });

    it('view-only Stores: boxes are read, never written', async () => {
        share(false);
        expect(StoresBoxService.list().map((b) => b.name)).toEqual(['Lazarette bin B']);
        await expect(StoresBoxService.create({ name: 'Coffre avant' })).rejects.toThrow('view only');
        await expect(StoresBoxService.edit('11111111-2222-4333-8444-555555555551', 'Bin C', null)).rejects.toThrow(
            'view only',
        );
    });
});
