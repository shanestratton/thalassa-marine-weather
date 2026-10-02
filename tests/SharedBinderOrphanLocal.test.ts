/**
 * The local half of the shared-binder orphan rule (2026-10-02), on the real
 * LocalDatabase over an in-memory filesystem:
 *  - a queued add moved into the sailor's own binder keeps its outbox id and
 *    place, and the move survives a restart (outbox replay);
 *  - a view-only deckhand completing a shared-voyage meal queues no stock
 *    DELTA against the skipper's stores.
 * No real accounts: 'skipper-1', 'crew-1'.
 */
import { Filesystem } from '@capacitor/filesystem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ShoppingListService', () => ({
    reconcileGroceryInventoryMirror: vi.fn().mockResolvedValue(undefined),
}));

const CREW = 'crew-1';
const SKIPPER = 'skipper-1';

function installFilesystem(disk: Map<string, string>): void {
    vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
        files: Array.from(disk.keys()).map((name) => ({
            name,
            type: 'file',
            size: disk.get(name)?.length ?? 0,
            ctime: 0,
            mtime: 0,
            uri: `mock://${name}`,
        })),
    }));
    vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({ data: disk.get(path) ?? '' }));
    vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
        disk.set(path, String(data));
        return { uri: `mock://${path}` };
    });
    vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
        disk.delete(path);
    });
    vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
        const contents = disk.get(from);
        if (contents === undefined) throw new Error(`Missing ${from}`);
        disk.set(to, contents);
        disk.delete(from);
    });
}

async function loadDatabase(disk: Map<string, string>) {
    installFilesystem(disk);
    const database = await import('../services/vessel/LocalDatabase');
    await database.initLocalDatabase(CREW);
    return database;
}

/** Crew on skipper-1's boat with Ship's Stores shared VIEW ONLY. */
async function crewWithViewOnlyStores() {
    const { setAuthIdentityScope } = await import('../services/authIdentityScope');
    setAuthIdentityScope(CREW);
    localStorage.setItem(
        'thalassa_shared_binders_v1::user%3Acrew-1',
        JSON.stringify({
            version: 1,
            userId: CREW,
            confirmedAt: '2026-10-02T00:00:00.000Z',
            skippers: [
                {
                    ownerId: SKIPPER,
                    vesselName: 'Test Boat',
                    lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                    registers: {
                        stores: { read: true, write: false },
                        equipment: { read: false, write: false },
                        maintenance: { read: false, write: false },
                        documents: { read: false, write: false },
                    },
                },
            ],
        }),
    );
    const { reloadSharedBindersFromStorage } = await import('../services/vessel/sharedBinders');
    reloadSharedBindersFromStorage();
}

describe('shared binder orphans, locally', () => {
    let disk: Map<string, string>;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        localStorage.clear();
        disk = new Map();
        installFilesystem(disk);
    });

    it('re-stamps a queued add and its row in place, and the move survives a restart', async () => {
        let database = await loadDatabase(disk);
        await database.insertLocal('inventory_items', {
            id: 'stores-new',
            user_id: SKIPPER,
            item_name: 'Tea',
            quantity: 1,
        });
        await database.updateLocal<{ id: string; updated_at?: string; item_name: string }>(
            'inventory_items',
            'stores-new',
            { item_name: 'Green tea' },
        );
        const before = database.getFullQueue();
        expect(before.map((item) => item.mutation_type)).toEqual(['INSERT', 'UPDATE']);

        const rewritten = await database.rewriteQueuedInsert(before[0].id, { user_id: CREW });
        expect(rewritten).toMatchObject({ id: before[0].id, mutation_type: 'INSERT' });
        expect(JSON.parse(rewritten!.payload)).toMatchObject({ user_id: CREW, item_name: 'Tea' });
        // Same ids, same order: the UPDATE still follows its INSERT.
        expect(database.getFullQueue().map((item) => item.id)).toEqual(before.map((item) => item.id));
        expect(database.getById<{ user_id: string; item_name: string }>('inventory_items', 'stores-new')).toMatchObject(
            { user_id: CREW, item_name: 'Green tea' },
        );
        // Only a queued INSERT can be re-stamped.
        expect(await database.rewriteQueuedInsert(before[1].id, { user_id: CREW })).toBeNull();

        // Restart: the outbox replay rebuilds the row from the re-stamped add.
        vi.resetModules();
        database = await loadDatabase(disk);
        expect(database.getById<{ user_id: string; item_name: string }>('inventory_items', 'stores-new')).toMatchObject(
            { user_id: CREW, item_name: 'Green tea' },
        );
    });

    it("a view-only deckhand completing a shared-voyage meal queues no DELTA on the skipper's stores", async () => {
        const database = await loadDatabase(disk);
        await crewWithViewOnlyStores();
        await database.bulkUpsert('inventory_items', [
            { id: 'rice-store', user_id: SKIPPER, item_name: 'Rice', quantity: 2, unit: 'kg' },
        ]);
        await database.bulkUpsert('meal_plans', [
            {
                id: '22222222-2222-4222-8222-222222222222',
                user_id: SKIPPER,
                voyage_id: 'voyage-shared',
                recipe_id: null,
                spoonacular_id: null,
                title: 'Rice bowl',
                planned_date: '2026-10-02',
                meal_slot: 'dinner',
                servings_planned: 2,
                ingredients: [{ name: 'Rice', amount: 0.5, unit: 'kg', scalable: true, aisle: 'Dry' }],
                status: 'reserved',
                cook_started_at: null,
                completed_at: null,
                leftovers_saved: false,
                notes: null,
                created_at: '2026-10-02T00:00:00.000Z',
                updated_at: '2026-10-02T00:00:00.000Z',
            },
        ]);
        const { completeMeal } = await import('../services/MealPlanService');

        const meal = await completeMeal('22222222-2222-4222-8222-222222222222', 2);

        expect(meal?.status).toBe('completed');
        expect(database.getFullQueue().filter((item) => item.mutation_type === 'DELTA')).toEqual([]);
        expect(database.getById<{ quantity: number }>('inventory_items', 'rice-store')?.quantity).toBe(2);
    });
});
