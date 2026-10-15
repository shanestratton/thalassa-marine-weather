/**
 * Galley saved recipes you can open, edit offline and delete, and one recipe
 * store (132-B18; binder audit GAL-04, GAL-06, GAL-08, GAL-16; Shane 15 Oct:
 * one store for your own and shared recipes).
 *
 * The real recipe services over the real LocalDatabase (Filesystem mocked, a
 * fresh account per test) and a small fake Supabase that answers the way
 * PostgREST does, with no network: `oneStore` says whether the held migration
 * is pushed (the probe of recipes.rating_avg), `offline` makes every request
 * fail as fetch does at sea. Fictional sailors only: the 'Kestrel' galley of
 * 'skipper-<n>', crew 'crew-<n>', community cook 'sailor-9'.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

const server = vi.hoisted(() => {
    const state = {
        tables: new Map<string, Row[]>(),
        oneStore: false,
        offline: false,
        user: '',
        calls: [] as string[],
        updates: [] as { table: string; patch: Record<string, unknown> }[],
        inserts: [] as { table: string; row: Row }[],
    };
    const rows = (table: string) => {
        if (!state.tables.has(table)) state.tables.set(table, []);
        return state.tables.get(table)!;
    };

    function from(table: string) {
        const filters: Array<(row: Row) => boolean> = [];
        let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
        let columns = '*';
        let payload: Row = { id: '' };
        const run = async (): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => {
            state.calls.push(`${op} ${table}${op === 'select' && columns !== '*' ? `(${columns})` : ''}`);
            if (state.offline) throw new TypeError('Failed to fetch');
            if (op === 'select' && table === 'recipes' && columns === 'rating_avg' && !state.oneStore) {
                return { data: null, error: { code: '42703', message: 'column recipes.rating_avg does not exist' } };
            }
            const matching = rows(table).filter((row) => filters.every((keep) => keep(row)));
            if (op === 'update') {
                state.updates.push({ table, patch: payload });
                for (const row of matching) Object.assign(row, payload);
                return { data: matching.map((row) => ({ ...row })), error: null };
            }
            if (op === 'insert') {
                const row: Row = { ...payload, created_at: '2026-10-15T00:00:00.000Z' };
                state.inserts.push({ table, row });
                rows(table).push(row);
                return { data: [{ ...row }], error: null };
            }
            if (op === 'delete') {
                state.tables.set(
                    table,
                    rows(table).filter((row) => !matching.includes(row)),
                );
                return { data: matching.map((row) => ({ ...row })), error: null };
            }
            return { data: matching.map((row) => ({ ...row })), error: null };
        };
        const single = async () => {
            const result = await run();
            return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: result.error };
        };
        const api: Record<string, unknown> = {
            select: (value = '*') => {
                if (op === 'select') columns = value;
                return api;
            },
            eq: (key: string, value: unknown) => {
                filters.push((row) => row[key] === value);
                return api;
            },
            neq: (key: string, value: unknown) => {
                filters.push((row) => row[key] !== value);
                return api;
            },
            ilike: (key: string, pattern: string) => {
                const needle = pattern.replace(/%/g, '').toLowerCase();
                filters.push((row) =>
                    String(row[key] ?? '')
                        .toLowerCase()
                        .includes(needle),
                );
                return api;
            },
            order: () => api,
            range: () => api,
            limit: () => api,
            update: (patch: Row) => {
                op = 'update';
                payload = patch;
                return api;
            },
            insert: (row: Row) => {
                op = 'insert';
                payload = row;
                return api;
            },
            delete: () => {
                op = 'delete';
                return api;
            },
            maybeSingle: single,
            single,
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                run().then(resolve, reject),
        };
        return api;
    }

    const auth = {
        getSession: async () => {
            if (state.offline) throw new TypeError('Failed to fetch');
            return {
                data: { session: state.user ? { access_token: 'test-token', user: { id: state.user } } : null },
                error: null,
            };
        },
        getUser: async () => {
            if (state.offline) return { data: { user: null }, error: { message: 'Failed to fetch' } };
            return { data: { user: state.user ? { id: state.user } : null }, error: null };
        },
    };
    return { state, from, auth };
});

vi.mock('../services/supabase', () => ({
    supabase: { from: server.from, auth: server.auth, storage: { from: vi.fn() } },
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
import { getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import {
    browseCommunityRecipes,
    createCustomRecipe,
    crewMayEditRecipe,
    deleteSavedRecipe,
    getFavouriteIds as serviceFavourites,
    getStoredRecipes,
    saveCustomRecipe,
    searchRecipes,
    storedRecipeToMeal,
    toggleFavourite as serviceToggle,
    updateCustomRecipe,
    type StoredRecipe,
} from '../services/GalleyRecipeService';
import { getFavouriteIds, toggleFavourite } from '../services/galley/recipeFavourites';
import {
    __resetRecipeStoreColumnForTests,
    recipesOneStore,
    recipesOneStoreKnown,
} from '../services/galley/recipeStoreColumn';
import {
    communityCopyPatch,
    flushCommunityCopies,
    pendingCommunityCopies,
} from '../services/galley/recipeCommunityCopy';
import { savedRecipeRights } from '../services/galley/recipeRights';
import type { BinderSource } from '../services/vessel/sharedBinders';

const NOW = '2026-10-15T00:00:00.000Z';
let accounts = 0;
let SKIPPER = 'skipper-1';
let CREW = 'crew-1';

const access = (read: boolean, write = read) => ({ read, write });

function shareGalley(galley: { read: boolean; write: boolean } | null): void {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({
            version: 1,
            userId: CREW,
            confirmedAt: NOW,
            galleyLive: true,
            skippers: galley
                ? [
                      {
                          ownerId: SKIPPER,
                          vesselName: 'Kestrel',
                          lastAcceptedAt: NOW,
                          registers: {
                              stores: access(false),
                              equipment: access(false),
                              maintenance: access(false),
                              documents: access(false),
                              galley,
                          },
                      },
                  ]
                : [],
        }),
    );
    reloadSharedBindersFromStorage();
}

function recipe(id: string, owner: string, title: string, overrides: Partial<StoredRecipe> = {}): StoredRecipe {
    return {
        id,
        spoonacular_id: null,
        user_id: owner,
        title,
        image_url: '',
        ready_in_minutes: 40,
        servings: 4,
        source_url: '',
        instructions: 'Soak the beans.\nSimmer two hours.',
        ingredients: [{ name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' }],
        is_favorite: false,
        is_custom: true,
        visibility: 'personal',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

const queued = (table: string) => getFullQueue().filter((item) => item.table_name === table);

async function signIn(userId: string): Promise<void> {
    server.state.user = userId;
    setAuthIdentityScope(userId);
    await initLocalDatabase(userId);
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    __resetRecipeStoreColumnForTests();
    server.state.tables.clear();
    server.state.oneStore = false;
    server.state.offline = false;
    server.state.calls = [];
    server.state.updates = [];
    server.state.inserts = [];
    accounts += 1;
    SKIPPER = `skipper-${accounts}`;
    CREW = `crew-${accounts}`;
    await signIn(SKIPPER);
});

afterEach(async () => {
    await initLocalDatabase(null);
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe("'Your recipe library' is the sailor's own (GAL-16)", () => {
    it("lists the recipes they wrote and the copies they saved, never another sailor's shared recipe", async () => {
        await mergePulledRecords('recipes', [
            recipe('r-feijoada', SKIPPER, 'Feijoada'),
            recipe('r-copy', SKIPPER, 'Ceviche de corvina', { is_custom: false }),
            recipe('r-shared-mine', SKIPPER, 'Moqueca', { visibility: 'shared' }),
            recipe('r-community', 'sailor-9', 'Community damper', { visibility: 'shared' }),
        ]);

        expect(
            getStoredRecipes()
                .map((row) => row.title)
                .sort(),
        ).toEqual(['Ceviche de corvina', 'Feijoada', 'Moqueca']);
        // Still on the phone: a planned meal may cook from it.
        expect(getById('recipes', 'r-community')).not.toBeNull();
    });

    it('a library recipe plans as a meal linked to its row', () => {
        const meal = storedRecipeToMeal(recipe('r-feijoada', SKIPPER, 'Feijoada'));
        expect(meal).toMatchObject({ title: 'Feijoada', recipeId: 'r-feijoada', source: 'private' });
        expect(meal.instructions).toEqual([
            { number: 1, step: 'Soak the beans.' },
            { number: 2, step: 'Simmer two hours.' },
        ]);
    });
});

describe('an edit saves on the phone first and syncs later (GAL-04)', () => {
    it('offline: the owner’s edit saves, queues one UPDATE, and its Captain’s Table copy waits', async () => {
        await mergePulledRecords('recipes', [recipe('r-feijoada', SKIPPER, 'Feijoada', { visibility: 'shared' })]);
        server.state.offline = true;

        const saved = await updateCustomRecipe('r-feijoada', {
            title: 'Feijoada completa',
            instructions: 'Soak the beans.\nBrown the pork.\nSimmer two hours.',
            visibility: 'shared',
        });

        expect(saved).toMatchObject({ title: 'Feijoada completa', visibility: 'shared' });
        expect(getById<StoredRecipe>('recipes', 'r-feijoada')?.title).toBe('Feijoada completa');
        expect(queued('recipes').map((item) => item.mutation_type)).toEqual(['UPDATE']);
        expect(JSON.parse(queued('recipes')[0].payload)).toMatchObject({ title: 'Feijoada completa' });
        await flushCommunityCopies();
        expect(pendingCommunityCopies()).toEqual(['r-feijoada']);
        expect(server.state.updates).toEqual([]);
    });

    it('back online, the waiting copy is sent: text, steps and visibility, never a stored photo', async () => {
        const photo = `https://project.example.test/storage/v1/object/public/recipe-photos/${SKIPPER}/r-feijoada.jpg`;
        await mergePulledRecords('recipes', [
            recipe('r-feijoada', SKIPPER, 'Feijoada', { visibility: 'shared', image_url: photo }),
        ]);
        server.state.tables.set('community_recipes', [
            { id: 'r-feijoada', user_id: SKIPPER, title: 'Feijoada', visibility: 'community', image_url: photo },
        ]);
        server.state.offline = true;
        await updateCustomRecipe('r-feijoada', { title: 'Feijoada completa' });
        await flushCommunityCopies();
        expect(pendingCommunityCopies()).toEqual(['r-feijoada']);

        server.state.offline = false;
        await expect(flushCommunityCopies()).resolves.toBe(0);

        expect(server.state.updates).toEqual([
            {
                table: 'community_recipes',
                patch: expect.objectContaining({
                    title: 'Feijoada completa',
                    visibility: 'community',
                    instructions: [
                        { number: 1, step: 'Soak the beans.' },
                        { number: 2, step: 'Simmer two hours.' },
                    ],
                }),
            },
        ]);
        expect(server.state.updates[0].patch).not.toHaveProperty('image_url');
        expect(pendingCommunityCopies()).toEqual([]);
    });

    it('a recipe written in the Galley has no copy: nothing is written, and it stops waiting', async () => {
        const created = await createCustomRecipe({
            title: 'Bobó de camarão',
            instructions: 'Cook the cassava.',
            ready_in_minutes: 50,
            servings: 4,
            ingredients: [],
            tags: [],
            visibility: 'personal',
        });
        // Offline, while its INSERT still waits: the edit saves behind it.
        server.state.offline = true;
        await expect(updateCustomRecipe(created!.id, { title: 'Bobó de camarão da Bahia' })).resolves.toMatchObject({
            title: 'Bobó de camarão da Bahia',
        });
        expect(queued('recipes').map((item) => item.mutation_type)).toEqual(['INSERT', 'UPDATE']);
        await flushCommunityCopies();
        expect(pendingCommunityCopies()).toEqual([created!.id]);

        server.state.offline = false;
        await flushCommunityCopies();
        expect(server.state.updates).toEqual([]);
        expect(pendingCommunityCopies()).toEqual([]);
    });

    it('the copy takes a photo link only when neither side is a stored photo', () => {
        const stored = 'https://project.example.test/storage/v1/object/public/recipe-photos/a/b.jpg';
        const row = recipe('r', SKIPPER, 'Feijoada', { image_url: 'https://images.example.test/f.jpg' });
        expect(communityCopyPatch(row, null)).toMatchObject({ image_url: 'https://images.example.test/f.jpg' });
        expect(communityCopyPatch(row, stored)).not.toHaveProperty('image_url');
        expect(communityCopyPatch({ ...row, image_url: stored }, null)).not.toHaveProperty('image_url');
        expect(communityCopyPatch({ ...row, visibility: 'personal' }, null)).toMatchObject({ visibility: 'private' });
    });
});

describe('crew change a recipe they added to the skipper’s galley (GAL-08), once the one store is live', () => {
    async function crewInKestrel(galley: { read: boolean; write: boolean }) {
        await signIn(CREW);
        shareGalley(galley);
        await mergePulledRecords('recipes', [
            recipe('r-skipper', SKIPPER, 'Skipper chowder'),
            recipe('r-skipper-shared', SKIPPER, 'Skipper paella', { visibility: 'shared' }),
        ]);
    }

    it('before the push: not offered, and nothing is queued', async () => {
        await crewInKestrel(access(true, true));
        await recipesOneStore({ from: server.from });
        expect(recipesOneStoreKnown()).toBe(false);

        expect(crewMayEditRecipe(getById<StoredRecipe>('recipes', 'r-skipper')!)).toBe(false);
        await expect(updateCustomRecipe('r-skipper', { title: 'Crew chowder' })).resolves.toBeNull();
        expect(queued('recipes')).toEqual([]);
    });

    it('after the push: a personal recipe saves on the phone and queues, kept personal; a shared one does not', async () => {
        server.state.oneStore = true;
        await crewInKestrel(access(true, true));
        await expect(recipesOneStore({ from: server.from })).resolves.toBe(true);

        await expect(
            updateCustomRecipe('r-skipper', { title: 'Crew chowder', visibility: 'shared' }),
        ).resolves.toMatchObject({ title: 'Crew chowder', visibility: 'personal', user_id: SKIPPER });
        expect(queued('recipes').map((item) => [item.mutation_type, item.record_id])).toEqual([
            ['UPDATE', 'r-skipper'],
        ]);
        expect(JSON.parse(queued('recipes')[0].payload)).toMatchObject({ visibility: 'personal' });
        // Crew never send the skipper's Captain's Table copy.
        expect(pendingCommunityCopies()).toEqual([]);

        await expect(updateCustomRecipe('r-skipper-shared', { title: 'Crew paella' })).resolves.toBeNull();
        expect(queued('recipes')).toHaveLength(1);
    });

    it('a galley shared to look at only: no change', async () => {
        server.state.oneStore = true;
        await crewInKestrel(access(true, false));
        await recipesOneStore({ from: server.from });

        await expect(updateCustomRecipe('r-skipper', { title: 'Crew chowder' })).resolves.toBeNull();
        expect(queued('recipes')).toEqual([]);
    });
});

describe('who may edit and delete a saved recipe from the Galley', () => {
    const own: BinderSource = { mode: 'own' };
    const kestrel = (canWrite: boolean): BinderSource => ({
        mode: 'shared',
        ownerId: 'skipper-x',
        vesselName: 'Kestrel',
        canWrite,
        canDelete: false,
        skipperCount: 1,
    });
    const row = (overrides: Partial<StoredRecipe>) => recipe('r', 'skipper-x', 'Feijoada', overrides);

    it('the owner edits what they wrote and deletes anything of theirs', () => {
        expect(savedRecipeRights(row({}), 'skipper-x', own, false)).toEqual({
            edit: true,
            delete: true,
            editNote: null,
        });
        expect(savedRecipeRights(row({ is_custom: false }), 'skipper-x', own, false)).toMatchObject({
            edit: false,
            delete: true,
        });
        expect(savedRecipeRights(row({ user_id: null }), null, own, false)).toMatchObject({ edit: true, delete: true });
        expect(savedRecipeRights(row({ user_id: 'sailor-9' }), 'skipper-x', own, true)).toMatchObject({
            edit: false,
            delete: false,
        });
    });

    it('crew edit a personal recipe only with Galley write and the one store, and never delete', () => {
        expect(savedRecipeRights(row({}), 'crew-x', kestrel(true), true)).toEqual({
            edit: true,
            delete: false,
            editNote: null,
        });
        expect(savedRecipeRights(row({}), 'crew-x', kestrel(true), false)).toMatchObject({
            edit: false,
            editNote: 'Only the skipper can change their recipes for now.',
        });
        expect(savedRecipeRights(row({}), 'crew-x', kestrel(false), true)).toMatchObject({
            edit: false,
            editNote: 'The galley is shared with you to look at, not change.',
        });
        expect(savedRecipeRights(row({ visibility: 'shared' }), 'crew-x', kestrel(true), true)).toMatchObject({
            edit: false,
            delete: false,
        });
    });
});

describe('Delete has a button now (GAL-08), and says what really happened', () => {
    it('a copy saved when a meal was planned goes from the phone now and from the server through the outbox, offline too', async () => {
        await mergePulledRecords('recipes', [recipe('r-copy', SKIPPER, 'Ceviche de corvina', { is_custom: false })]);
        server.state.offline = true;

        await expect(deleteSavedRecipe('r-copy')).resolves.toEqual({
            status: 'deleted',
            scope: 'queued',
            message: 'Recipe deleted. It goes from your other devices once this phone syncs.',
        });
        expect(getById('recipes', 'r-copy')).toBeNull();
        expect(queued('recipes').map((item) => [item.mutation_type, item.record_id])).toEqual([['DELETE', 'r-copy']]);
    });

    it('a recipe they wrote, offline: nothing deleted, and it says the server could not be reached (not "only the owner")', async () => {
        await mergePulledRecords('recipes', [recipe('r-feijoada', SKIPPER, 'Feijoada')]);
        server.state.offline = true;

        const result = await deleteSavedRecipe('r-feijoada');

        expect(result).toMatchObject({ status: 'pending' });
        expect(result.message).toMatch(/server could not be reached, so nothing was deleted/);
        expect(getById('recipes', 'r-feijoada')).not.toBeNull();
        expect(queued('recipes')).toEqual([]);
    });

    it('online, a recipe with no photo is deleted everywhere, and the message does not mention a photo', async () => {
        await mergePulledRecords('recipes', [recipe('r-feijoada', SKIPPER, 'Feijoada')]);
        server.state.tables.set('recipes', [
            { id: 'r-feijoada', user_id: SKIPPER, image_url: null, visibility: 'personal' },
        ]);

        await expect(deleteSavedRecipe('r-feijoada')).resolves.toEqual({
            status: 'deleted',
            scope: 'cloud-and-local',
            message: 'Recipe deleted everywhere.',
        });
        expect(server.state.tables.get('recipes')).toEqual([]);
        expect(getById('recipes', 'r-feijoada')).toBeNull();
    });

    it("crew cannot delete the skipper's recipe", async () => {
        await signIn(CREW);
        shareGalley(access(true, true));
        await mergePulledRecords('recipes', [recipe('r-copy', SKIPPER, 'Skipper copy', { is_custom: false })]);

        await expect(deleteSavedRecipe('r-copy')).resolves.toMatchObject({ status: 'not-owner' });
        expect(getById('recipes', 'r-copy')).not.toBeNull();
    });
});

describe('the Favourite badge works (GAL-08): one list for the Galley and the Captain’s Table', () => {
    it('the recipe service hands out the same list the Galley reads', () => {
        expect(serviceToggle).toBe(toggleFavourite);
        expect(serviceFavourites).toBe(getFavouriteIds);
        expect(toggleFavourite('r-feijoada')).toBe(true);
        expect(getFavouriteIds()).toEqual(new Set(['r-feijoada']));
        expect(toggleFavourite('r-feijoada')).toBe(false);
        expect(getFavouriteIds()).toEqual(new Set());
    });
});

describe('one recipe shows in the Galley and on the Captain’s Table (GAL-06)', () => {
    const community = (id: string, owner: string, title: string): Row => ({
        id,
        user_id: owner,
        title,
        image_url: null,
        ready_in_minutes: 30,
        servings: 1,
        ingredients: [],
        instructions: [{ number: 1, step: 'Mix.' }],
        visibility: 'community',
        tags: [],
        author_name: 'Sailor Nine',
        rating_avg: 4.5,
        rating_count: 2,
        created_at: NOW,
    });

    it('before the push: the Captain’s Table rows, then the Galley’s shared recipes without ratings', async () => {
        server.state.tables.set('community_recipes', [community('c-damper', 'sailor-9', 'Damper')]);
        server.state.tables.set('recipes', [
            { ...recipe('c-damper', 'sailor-9', 'Damper twin', { visibility: 'shared' }) },
            { ...recipe('g-moqueca', SKIPPER, 'Moqueca', { visibility: 'shared' }) },
            { ...recipe('g-stew', 'sailor-9', 'Galley stew', { visibility: 'shared' }) },
            { ...recipe('g-private', SKIPPER, 'Private pie') },
        ]);

        const table = await browseCommunityRecipes();

        expect(table.map((row) => [row.title, row.authorName, row.canRate])).toEqual([
            ['Damper', 'Sailor Nine', true],
            ['Moqueca', 'You', false],
            ['Galley stew', 'A Fellow Sailor', false],
        ]);
        expect(table[1].instructions).toEqual([
            { number: 1, step: 'Soak the beans.' },
            { number: 2, step: 'Simmer two hours.' },
        ]);
    });

    it('after the push: the shared recipes rows only, rated, with their author', async () => {
        server.state.oneStore = true;
        server.state.tables.set('community_recipes', [community('c-old', 'sailor-9', 'Legacy only')]);
        server.state.tables.set('recipes', [
            { ...recipe('g-moqueca', SKIPPER, 'Moqueca', { visibility: 'shared' }), author_name: 'Kestrel cook' },
            { ...recipe('g-private', SKIPPER, 'Private pie') },
        ]);

        const table = await browseCommunityRecipes();

        expect(table.map((row) => [row.title, row.authorName, row.canRate])).toEqual([
            ['Moqueca', 'Kestrel cook', true],
        ]);
    });

    it('after the push, sharing from the Captain’s Table writes one recipes row, shared, steps as JSON text', async () => {
        server.state.oneStore = true;
        server.state.tables.set('chat_profiles', [{ id: 'p', user_id: SKIPPER, display_name: 'Kestrel cook' }]);

        const meal = await saveCustomRecipe({
            title: 'Pão de queijo',
            readyInMinutes: 40,
            servings: 1,
            ingredients: [],
            instructions: [{ number: 1, step: 'Bake.' }],
            visibility: 'community',
        });

        expect(server.state.inserts.map((insert) => insert.table)).toEqual(['recipes']);
        expect(server.state.inserts[0].row).toMatchObject({
            user_id: SKIPPER,
            visibility: 'shared',
            is_custom: true,
            author_name: 'Kestrel cook',
            instructions: JSON.stringify([{ number: 1, step: 'Bake.' }]),
        });
        expect(meal).toMatchObject({ title: 'Pão de queijo', instructions: [{ number: 1, step: 'Bake.' }] });
        // The phone's twin is the same row: the outbox INSERT lands as a duplicate.
        expect(getById<StoredRecipe>('recipes', meal!.supabaseId!)).toMatchObject({ visibility: 'shared' });
    });

    it('after the push, a meal search finds a shared Galley recipe of another sailor', async () => {
        server.state.oneStore = true;
        server.state.tables.set('recipes', [
            { ...recipe('g-stew', 'sailor-9', 'Galley stew', { visibility: 'shared' }), author_name: 'Sailor Nine' },
        ]);

        const [found] = await searchRecipes('galley stew');

        expect(found).toMatchObject({ title: 'Galley stew', source: 'community', supabaseId: 'g-stew' });
    });
});

describe('the one-store probe (recipes.rating_avg)', () => {
    it('reads the column and no rows; present is remembered, absent is asked again after an hour', async () => {
        server.state.oneStore = false;
        const now = Date.parse(NOW);
        await expect(recipesOneStore({ from: server.from }, now)).resolves.toBe(false);
        await expect(recipesOneStore({ from: server.from }, now + 59 * 60_000)).resolves.toBe(false);
        expect(server.state.calls.filter((call) => call === 'select recipes(rating_avg)')).toHaveLength(1);

        server.state.oneStore = true;
        await expect(recipesOneStore({ from: server.from }, now + 61 * 60_000)).resolves.toBe(true);
        expect(recipesOneStoreKnown()).toBe(true);
        await expect(recipesOneStore({ from: server.from })).resolves.toBe(true);
        expect(server.state.calls.filter((call) => call === 'select recipes(rating_avg)')).toHaveLength(2);
    });

    it('offline, signed out or no client: unknown, asked again next time (a client that throws at once does not stick)', async () => {
        server.state.offline = true;
        await expect(recipesOneStore({ from: server.from })).resolves.toBe(false);
        await expect(recipesOneStore(null)).resolves.toBe(false);
        server.state.offline = false;
        server.state.oneStore = true;
        await expect(recipesOneStore({ from: server.from })).resolves.toBe(true);
    });
});

describe('the dead provisions code that wrote without an owner is gone (GAL-16)', () => {
    it('no client code writes passage_provisions, and the old writers are not exported', async () => {
        const provisions = await import('../services/PassageProvisionsService');
        const meals = await import('../services/MealPlanService');
        expect(provisions).not.toHaveProperty('saveProvisions');
        expect(provisions).not.toHaveProperty('getProvisions');
        expect(meals).not.toHaveProperty('addShortfallItem');

        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
            }
        };
        walk(join(process.cwd(), 'services'));
        walk(join(process.cwd(), 'components'));
        const writers = files.filter((file) =>
            /\b(insertLocal|updateLocal|bulkUpsert|ins|insert)\(\s*['"]passage_provisions['"]/.test(
                readFileSync(file, 'utf8'),
            ),
        );
        expect(writers).toEqual([]);
    });
});
