/**
 * The shared galley at the service layer (Shane 2026-10-03: "can we share the
 * galley as well with invitees (as an option)").
 *
 * The real LocalDatabase (Filesystem mocked) holds the crew member's own
 * galley rows AND the skipper's; while the skipper shares the Galley, every
 * galley read shows the skipper's, every add lands in the skipper's, and a
 * tick that would also write Ship's Stores leaves Stores alone where Stores is
 * not the crew member's to edit. Passage rows (voyage_id set) are untouched.
 * No real accounts or boats: 'skipper-1', 'crew-<n>', 'sailor-9', 'Test Boat'.
 */
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({
    recipeUpserts: [] as Record<string, unknown>[],
    /** A fresh crew account per test: the local database is per account. */
    crewId: 'crew-1',
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => ({
            upsert: async (row: Record<string, unknown>) => {
                if (table === 'recipes') cloud.recipeUpserts.push(row);
                return { error: null };
            },
        }),
        auth: {
            getSession: async () => ({ data: { session: { user: { id: cloud.crewId } } }, error: null }),
            getUser: async () => ({ data: { user: { id: cloud.crewId } }, error: null }),
        },
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../services/ProfilePhotoService', () => ({ compressImage: vi.fn() }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { getAll, getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { isGalleyShareLive, reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { getStoredRecipes, createCustomRecipe, type StoredRecipe } from '../services/GalleyRecipeService';
import {
    getMealsByStatus,
    getStoresAvailability,
    saveLeftovers,
    scheduleMeal,
    startCooking,
    type MealPlan,
} from '../services/MealPlanService';
import {
    addManualItem,
    getShoppingList,
    markPurchased,
    reconcileGroceryInventoryMirror,
    unmarkPurchased,
    type ShoppingItem,
} from '../services/ShoppingListService';

const NOW = '2026-10-03T00:00:00.000Z';
let accountCounter = 0;
let CREW = 'crew-1';
const snapshotKey = () => authScopedStorageKey('thalassa_shared_binders_v1');
const access = (read: boolean, write = read) => ({ read, write });

function share(options: { galley: boolean; live?: boolean; stores?: { read: boolean; write: boolean } }): void {
    localStorage.setItem(
        snapshotKey(),
        JSON.stringify({
            version: 1,
            userId: CREW,
            confirmedAt: NOW,
            ...(options.live === false ? {} : { galleyLive: true }),
            skippers: [
                {
                    ownerId: 'skipper-1',
                    vesselName: 'Test Boat',
                    lastAcceptedAt: '2026-10-02T21:00:00.000Z',
                    registers: {
                        stores: options.stores ?? access(false),
                        equipment: access(true),
                        maintenance: access(false),
                        documents: access(false),
                        galley: access(options.galley),
                    },
                },
            ],
        }),
    );
    reloadSharedBindersFromStorage();
}

function noShares(): void {
    localStorage.setItem(
        snapshotKey(),
        JSON.stringify({ version: 1, userId: CREW, confirmedAt: NOW, galleyLive: true, skippers: [] }),
    );
    reloadSharedBindersFromStorage();
}

function recipe(id: string, owner: string, title: string, visibility: 'personal' | 'shared' = 'personal') {
    return {
        id,
        spoonacular_id: null,
        user_id: owner,
        title,
        image_url: '',
        ready_in_minutes: 20,
        servings: 2,
        source_url: '',
        instructions: '',
        ingredients: [],
        is_favorite: false,
        is_custom: true,
        visibility,
        tags: [],
        created_at: NOW,
        updated_at: NOW,
    } satisfies StoredRecipe;
}

function meal(id: string, owner: string, title: string, overrides: Partial<MealPlan> = {}): MealPlan {
    return {
        id,
        user_id: owner,
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: null,
        title,
        planned_date: '2026-10-04',
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: [{ name: 'Rice', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' }],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function grocery(id: string, owner: string, name: string, overrides: Partial<ShoppingItem> = {}): ShoppingItem {
    return {
        id,
        user_id: owner,
        ingredient_name: name,
        required_qty: 2,
        unit: 'each',
        market_zone: 'Produce',
        actual_cost: null,
        currency: 'AUD',
        purchased: false,
        purchased_at: null,
        purchase_retailer: null,
        purchased_quantity: null,
        purchased_unit: null,
        purchase_revision: 0,
        purchase_operation_id: null,
        store_location: 'Galley',
        provision_id: null,
        voyage_id: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

/** The local mirror after a pull: the crew member's own galley and the skipper's. */
async function pullBothGalleys(): Promise<void> {
    await mergePulledRecords('recipes', [
        recipe('r-skipper', 'skipper-1', 'Skipper chowder'),
        recipe('r-crew', CREW, 'Crew curry'),
        recipe('r-community', 'sailor-9', 'Community damper', 'shared'),
    ]);
    await mergePulledRecords('meal_plans', [
        meal('m-skipper', 'skipper-1', 'Skipper stew'),
        meal('m-crew', CREW, 'Crew noodles'),
        meal('m-passage', 'skipper-1', 'Passage pasta', { voyage_id: 'voyage-1' }),
    ]);
    await mergePulledRecords('shopping_list', [
        grocery('g-skipper', 'skipper-1', 'Limes'),
        grocery('g-crew', CREW, 'Chillies'),
        grocery('g-passage', 'skipper-1', 'Bread', { voyage_id: 'voyage-1' }),
    ]);
}

const titles = (rows: { title: string }[]) => rows.map((row) => row.title).sort();
const names = (summary: ReturnType<typeof getShoppingList>) =>
    summary.zones.flatMap((zone) => zone.items.map((item) => item.ingredient_name)).sort();
const queued = (table: string) => getFullQueue().filter((item) => item.table_name === table);

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    cloud.recipeUpserts = [];
    accountCounter += 1;
    CREW = `crew-${accountCounter}`;
    cloud.crewId = CREW;
    setAuthIdentityScope(CREW);
    await initLocalDatabase(CREW);
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('a shared galley shows the skipper’s galley in place of the crew member’s own', () => {
    it('shows only the skipper’s recipes, meals and grocery list; the crew’s own stay on the device', async () => {
        await pullBothGalleys();
        share({ galley: true });

        expect(titles(getStoredRecipes())).toEqual(['Skipper chowder']);
        expect(titles(getMealsByStatus('reserved', null))).toEqual(['Skipper stew']);
        expect(names(getShoppingList(null, 'skipper-1'))).toEqual(['Limes']);

        // Hidden, not deleted.
        expect(getById('recipes', 'r-crew')).not.toBeNull();
        expect(getById('meal_plans', 'm-crew')).not.toBeNull();
        expect(getById('shopping_list', 'g-crew')).not.toBeNull();

        // A passage's rows keep the passage rules.
        expect(titles(getMealsByStatus('reserved', 'voyage-1'))).toEqual(['Passage pasta']);
        expect(names(getShoppingList('voyage-1', 'skipper-1'))).toEqual(['Bread']);
    });

    it('reserves the skipper’s stores for the skipper’s meals, not a mix of both galleys', async () => {
        await pullBothGalleys();
        await mergePulledRecords('inventory_items', [
            {
                id: 'i-rice',
                user_id: 'skipper-1',
                item_name: 'Rice',
                quantity: 2000,
                unit: 'g',
                created_at: NOW,
                updated_at: NOW,
            },
        ]);
        share({ galley: true, stores: access(true, false) });

        // Two owners' meals with no passage used to fail closed (no owner).
        expect(getStoresAvailability(null, 'skipper-1')).toEqual([
            expect.objectContaining({ item_id: 'i-rice', reserved: 500, available: 1500 }),
        ]);
    });

    it('unshared, the crew member’s own galley shows as before, and it comes back when a share ends', async () => {
        await pullBothGalleys();
        noShares();
        expect(titles(getStoredRecipes())).toEqual(['Community damper', 'Crew curry']);
        expect(titles(getMealsByStatus('reserved', null))).toContain('Crew noodles');
        expect(names(getShoppingList(null, CREW))).toEqual(['Chillies']);

        share({ galley: true });
        expect(titles(getStoredRecipes())).toEqual(['Skipper chowder']);

        noShares();
        expect(titles(getStoredRecipes())).toEqual(['Community damper', 'Crew curry']);
        expect(names(getShoppingList(null, CREW))).toEqual(['Chillies']);
    });

    it('before the server can share a galley, a ticked Galley shares nothing (the app behaves as before)', async () => {
        await pullBothGalleys();
        share({ galley: true, live: false });

        expect(isGalleyShareLive()).toBe(false);
        expect(titles(getStoredRecipes())).toEqual(['Community damper', 'Crew curry']);
        expect(names(getShoppingList(null, CREW))).toEqual(['Chillies']);
        await addManualItem({ name: 'Mint', qty: 1, unit: 'bunch', voyageId: null, ownerUserId: CREW });
        expect(JSON.parse(queued('shopping_list')[0].payload)).toMatchObject({ user_id: CREW });
    });
});

describe('a crew write in a shared galley goes to the skipper’s galley', () => {
    it('adds grocery items, meals and recipes under the skipper, and edits the skipper’s rows', async () => {
        await pullBothGalleys();
        share({ galley: true });

        // A new item: the skipper's, though the page passed the crew's own id.
        await addManualItem({ name: 'Mint', qty: 1, unit: 'bunch', voyageId: null, ownerUserId: CREW });
        // The same name as an item in BOTH galleys: it tops up the skipper's,
        // never the crew member's hidden one.
        await mergePulledRecords('shopping_list', [grocery('g-crew-limes', CREW, 'Limes')]);
        await addManualItem({ name: 'Limes', qty: 3, unit: 'each', voyageId: null, ownerUserId: 'skipper-1' });

        const shopping = queued('shopping_list');
        expect(shopping.map((item) => [item.mutation_type, item.record_id])).toEqual([
            ['INSERT', expect.any(String)],
            ['UPDATE', 'g-skipper'],
        ]);
        expect(JSON.parse(shopping[0].payload)).toMatchObject({ ingredient_name: 'Mint', user_id: 'skipper-1' });
        expect(getById<ShoppingItem>('shopping_list', 'g-skipper')?.required_qty).toBe(5);
        expect(getById<ShoppingItem>('shopping_list', 'g-crew-limes')?.required_qty).toBe(2);

        const planned = await scheduleMeal(
            {
                id: 77,
                title: 'Fish tacos',
                readyInMinutes: 20,
                servings: 2,
                image: '',
                sourceUrl: '',
                ingredients: [],
                isSimpleMeal: true,
            } as unknown as Parameters<typeof scheduleMeal>[0],
            '2026-10-05',
            'lunch',
            null,
            2,
            CREW,
        );
        expect(planned.user_id).toBe('skipper-1');

        const added = await createCustomRecipe({
            title: 'Galley bread',
            instructions: 'Knead. Bake.',
            ready_in_minutes: 60,
            servings: 4,
            ingredients: [],
            tags: [],
            visibility: 'shared',
        });
        // The skipper's library, and personal: the community is the skipper's call.
        expect(added).toMatchObject({ user_id: 'skipper-1', visibility: 'personal' });
        expect(cloud.recipeUpserts).toEqual([
            expect.objectContaining({ user_id: 'skipper-1', visibility: 'personal', title: 'Galley bread' }),
        ]);
        expect(titles(getStoredRecipes())).toEqual(['Galley bread', 'Skipper chowder']);

        await startCooking('m-skipper');
        expect(queued('meal_plans').map((item) => [item.mutation_type, item.record_id])).toEqual([
            ['INSERT', planned.id],
            ['UPDATE', 'm-skipper'],
        ]);
    });
});

describe('ticking a grocery item bought in a shared galley respects the Stores share', () => {
    async function purchaseLimes(): Promise<{ storesSkipped: boolean }> {
        await pullBothGalleys();
        return markPurchased('g-skipper', 4.5, 'Market', null, 'skipper-1');
    }

    it('with Stores not shared: the item is bought, and no Stores row is written anywhere', async () => {
        share({ galley: true, stores: access(false) });
        const outcome = await purchaseLimes();

        expect(outcome).toEqual({ storesSkipped: true });
        const item = getById<ShoppingItem>('shopping_list', 'g-skipper');
        expect(item).toMatchObject({ purchased: true, user_id: 'skipper-1', purchase_revision: 1 });
        expect(item?.notes ?? '').not.toContain('[[thalassa:grocery-purchase:');
        expect(getAll('inventory_items')).toEqual([]);
        expect(queued('inventory_items')).toEqual([]);
        expect(queued('shopping_list')).toHaveLength(1);

        const undone = await unmarkPurchased('g-skipper', null, 'skipper-1');
        expect(undone).toEqual({ storesSkipped: true });
        expect(getById<ShoppingItem>('shopping_list', 'g-skipper')?.purchased).toBe(false);
        expect(getAll('inventory_items')).toEqual([]);
    });

    it('with Stores view-only: the same, the skipper’s stores are left as they are', async () => {
        share({ galley: true, stores: access(true, false) });
        const outcome = await purchaseLimes();

        expect(outcome.storesSkipped).toBe(true);
        expect(getAll('inventory_items')).toEqual([]);
    });

    it('with Stores editable: the receipt goes into the skipper’s stores, as it always did', async () => {
        share({ galley: true, stores: access(true, true) });
        const outcome = await purchaseLimes();

        expect(outcome.storesSkipped).toBe(false);
        expect(getById('inventory_items', 'g-skipper')).toMatchObject({ user_id: 'skipper-1', item_name: 'Limes' });
    });

    it('the startup mirror repair adds no Stores row for a skipper’s purchase the crew may not store', async () => {
        share({ galley: true, stores: access(true, false) });
        const marker = `[[thalassa:grocery-purchase:${JSON.stringify({
            version: 2,
            inventoryItemId: 'g-bought',
            quantity: 2,
            unit: 'each',
            provenance: 'Added from Grocery List purchase g-bought',
        })}]]`;
        await mergePulledRecords('shopping_list', [
            grocery('g-bought', 'skipper-1', 'Lemons', {
                purchased: true,
                purchased_at: NOW,
                purchased_quantity: 2,
                purchased_unit: 'each',
                purchase_revision: 1,
                notes: marker,
            }),
        ]);

        await reconcileGroceryInventoryMirror();
        expect(getAll('inventory_items')).toEqual([]);
    });

    it('leftovers, a Stores entry, are not saved where Stores is not the crew’s to edit', async () => {
        share({ galley: true, stores: access(true, false) });
        await mergePulledRecords('meal_plans', [
            meal('m-done', 'skipper-1', 'Skipper stew', { status: 'completed', completed_at: NOW }),
        ]);

        await saveLeftovers('m-done', 2);
        expect(getAll('inventory_items')).toEqual([]);
        expect(getById<MealPlan>('meal_plans', 'm-done')?.leftovers_saved).toBe(false);
        expect(queued('inventory_items')).toEqual([]);
    });
});

describe('a galley tick without Stores never makes another device change Ship’s Stores', () => {
    /** The marker a Stores tick writes into notes; an untick keeps it until the next tick. */
    const receiptMarker = (id: string, quantity = 2) =>
        `[[thalassa:grocery-purchase:${JSON.stringify({
            version: 2,
            inventoryItemId: id,
            quantity,
            unit: 'each',
            provenance: `Added from Grocery List purchase ${id}`,
        })}]]`;
    const MARKER = '[[thalassa:grocery-purchase:';

    /** Switch this test to the skipper's own device: own account, nothing shared with him. */
    let skipperDevices = 0;
    async function asSkipper(): Promise<string> {
        skipperDevices += 1;
        const skipper = `skipper-own-${accountCounter}-${skipperDevices}`;
        setAuthIdentityScope(skipper);
        cloud.crewId = skipper;
        await initLocalDatabase(skipper);
        localStorage.setItem(
            snapshotKey(),
            JSON.stringify({ version: 1, userId: skipper, confirmedAt: NOW, galleyLive: true, skippers: [] }),
        );
        reloadSharedBindersFromStorage();
        return skipper;
    }

    /** The crew member ticks, then unticks, an item the skipper once ticked and unticked himself. */
    async function crewTicksThenUnticks(): Promise<ShoppingItem[]> {
        share({ galley: true, stores: access(true, false) });
        await mergePulledRecords('shopping_list', [
            grocery('g-milk', 'skipper-1', 'Milk', {
                purchase_revision: 2,
                notes: `Long life\n${receiptMarker('g-milk')}`,
            }),
        ]);

        expect(await markPurchased('g-milk', undefined, undefined, null, 'skipper-1')).toEqual({
            storesSkipped: true,
        });
        const ticked = getById<ShoppingItem>('shopping_list', 'g-milk')!;
        expect(await unmarkPurchased('g-milk', null, 'skipper-1')).toEqual({ storesSkipped: true });
        const unticked = getById<ShoppingItem>('shopping_list', 'g-milk')!;

        const payloads = queued('shopping_list').map((item) => JSON.parse(item.payload) as Partial<ShoppingItem>);
        for (const row of [ticked, unticked, ...payloads]) {
            if ('notes' in row) expect(row.notes ?? '').not.toContain(MARKER);
        }
        // The sailor's own words in the note are kept.
        expect(ticked.notes).toBe('Long life');
        expect(unticked).toMatchObject({ purchased: false, notes: 'Long life' });
        return [ticked, unticked];
    }

    it('crew side: neither the tick nor the untick carries a Stores receipt marker', async () => {
        await crewTicksThenUnticks();
        expect(getAll('inventory_items')).toEqual([]);
        expect(queued('inventory_items')).toEqual([]);
    });

    it('skipper side: pulling the crew’s tick and untick leaves his Stores as they are', async () => {
        const [ticked, unticked] = await crewTicksThenUnticks();

        for (const retained of [true, false]) {
            const skipper = await asSkipper();
            const stock = {
                id: 'g-milk',
                user_id: skipper,
                item_name: 'Milk',
                description: 'Stock retained after undoing Grocery List purchase g-milk',
                category: 'Provisions',
                quantity: 1,
                min_quantity: 0,
                unit: 'each',
                location_zone: 'Galley',
                created_at: NOW,
                updated_at: NOW,
            };
            if (retained) await mergePulledRecords('inventory_items', [stock]);
            const before = getAll('inventory_items');

            for (const pulled of [ticked, unticked]) {
                await mergePulledRecords('shopping_list', [{ ...pulled, user_id: skipper }]);
                await reconcileGroceryInventoryMirror();
                expect(getAll('inventory_items')).toEqual(before);
            }
            expect(queued('inventory_items')).toEqual([]);
        }
    });

    it('crew without Stores edit cannot untick a purchase the skipper put in Ship’s Stores', async () => {
        for (const stores of [access(false), access(true, false)]) {
            share({ galley: true, stores });
            await mergePulledRecords('shopping_list', [
                grocery('g-eggs', 'skipper-1', 'Eggs', {
                    purchased: true,
                    purchased_at: NOW,
                    purchased_quantity: 2,
                    purchased_unit: 'each',
                    purchase_revision: 1,
                    notes: receiptMarker('g-eggs'),
                }),
            ]);

            expect(await unmarkPurchased('g-eggs', null, 'skipper-1')).toEqual({
                storesSkipped: true,
                needsStoresEditor: true,
            });
            expect(getById<ShoppingItem>('shopping_list', 'g-eggs')).toMatchObject({
                purchased: true,
                purchase_revision: 1,
            });
            expect(queued('shopping_list')).toEqual([]);
        }
    });

    it('the same when only the skipper’s Stores row shows the purchase (a receipt with no marker)', async () => {
        share({ galley: true, stores: access(true, false) });
        await mergePulledRecords('inventory_items', [
            {
                id: 'g-oats',
                user_id: 'skipper-1',
                item_name: 'Oats',
                description: 'Added from Grocery List purchase g-oats',
                quantity: 1,
                unit: 'each',
                created_at: NOW,
                updated_at: NOW,
            },
        ]);
        await mergePulledRecords('shopping_list', [
            grocery('g-oats', 'skipper-1', 'Oats', {
                purchased: true,
                purchased_at: NOW,
                purchased_quantity: 1,
                purchased_unit: 'each',
                purchase_revision: 1,
            }),
        ]);

        expect(await unmarkPurchased('g-oats', null, 'skipper-1')).toMatchObject({ needsStoresEditor: true });
        expect(getById<ShoppingItem>('shopping_list', 'g-oats')?.purchased).toBe(true);
        expect(getById('inventory_items', 'g-oats')).toMatchObject({ quantity: 1 });
        expect(queued('shopping_list')).toEqual([]);
    });
});
