/**
 * Planned meals and Galley recipes reach the server (126-B2a, binder audit
 * GAL-02 and GAL-03; Shane 2026-10-09: "check all of the binders to make sure
 * that they are at the same standard as the rest of the app").
 *
 * A meal planned from a searched recipe used to carry the search result's
 * fake numeric id (Date.now() + Math.random()) into meal_plans.spoonacular_id,
 * an INTEGER column. Postgres refused it, the outbox retried it every cycle,
 * and the meal never left the phone. Now a meal stores `spoonacular_id` only
 * for a real Spoonacular recipe, and `recipe_id` is the library row it cooks
 * from: the community recipe's own twin when this phone has it, else a
 * deterministic v8 copy queued ahead of the meal.
 *
 * The real chain: the real LocalDatabase over the in-memory filesystem, the
 * real galley services, the real SyncService push, and the REAL supabase-js
 * client, with only fetch faked. The fake PostgREST refuses a fractional or
 * out-of-range INTEGER the way Postgres does (22P02 / 22003, HTTP 400) and
 * applies the recipes / meal_plans insert policies.
 *
 * Fictional boats and sailors only: 'Kestrel' (skipper 'skipper-1'),
 * 'Albatross' (crew 'crew-1'), community cook 'sailor-9'; passages
 * 'Horta → Ponta Delgada' and 'Lyttelton → Akaroa'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

function base64Url(value: unknown): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

const h = vi.hoisted(() => {
    const INTEGER_COLUMNS: Record<string, string[]> = {
        recipes: ['spoonacular_id', 'ready_in_minutes', 'servings'],
        meal_plans: ['spoonacular_id', 'servings_planned'],
    };
    const UUID_COLUMNS: Record<string, string[]> = {
        recipes: ['id'],
        meal_plans: ['id', 'recipe_id'],
    };
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const state = {
        /** auth storage: the persisted session */
        storage: new Map<string, string>(),
        /** access token → user id */
        tokens: new Map<string, string>(),
        /** table → id → row: what the server holds */
        tables: new Map<string, Map<string, Row>>(),
        /** every write the server was sent, as sent */
        writes: [] as { method: string; table: string; body: unknown; user: string }[],
        /** every refusal, with its Postgres code */
        refusals: [] as { table: string; code: string }[],
        /** crew → skippers who let them write their Galley (the share policies) */
        galleyWriters: new Map<string, Set<string>>(),
        /** crew → passages they cook for (can_access_passage) */
        passageCrew: new Map<string, Set<string>>(),
        requests: [] as { method: string; path: string }[],
    };

    const json = (status: number, body: unknown) =>
        new Response(body === undefined ? '' : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        });
    const table = (name: string) => {
        let rows = state.tables.get(name);
        if (!rows) {
            rows = new Map();
            state.tables.set(name, rows);
        }
        return rows;
    };

    /** The check Postgres makes before any policy: does the value fit the column? */
    function typeError(name: string, row: Row): { code: string; message: string } | null {
        for (const column of INTEGER_COLUMNS[name] ?? []) {
            const value = row[column];
            if (value === null || value === undefined) continue;
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return { code: '22P02', message: `invalid input syntax for type integer: "${String(value)}"` };
            }
            if (value > 2147483647 || value < -2147483648) {
                return { code: '22003', message: `value "${value}" is out of range for type integer` };
            }
        }
        for (const column of UUID_COLUMNS[name] ?? []) {
            const value = row[column];
            if (value === null || value === undefined) continue;
            if (typeof value !== 'string' || !UUID.test(value)) {
                return { code: '22P02', message: `invalid input syntax for type uuid: "${String(value)}"` };
            }
        }
        return null;
    }

    /** recipes / meal_plans INSERT policies, as far as these tests need them. */
    function mayInsert(name: string, row: Row, user: string): boolean {
        const owner = String(row.user_id ?? '');
        if (owner === user) return true;
        if (name === 'meal_plans' && typeof row.voyage_id === 'string') {
            return state.passageCrew.get(user)?.has(row.voyage_id) === true;
        }
        return state.galleyWriters.get(user)?.has(owner) === true;
    }

    function matches(row: Row, params: URLSearchParams): boolean {
        for (const [key, raw] of params) {
            if (['select', 'order', 'limit', 'offset', 'on_conflict', 'or'].includes(key)) continue;
            const dot = raw.indexOf('.');
            const op = raw.slice(0, dot);
            const expected = raw.slice(dot + 1);
            const actual = row[key];
            if (op === 'eq' && String(actual) !== expected) return false;
            if (op === 'neq' && String(actual) === expected) return false;
            if (op === 'is' && expected === 'null' && actual !== null && actual !== undefined) return false;
            if (op === 'ilike') {
                const pattern = expected
                    .split(/[%*]/)
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('.*');
                if (!new RegExp(`^${pattern}$`, 'i').test(String(actual ?? ''))) return false;
            }
        }
        return true;
    }

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const headers = new Headers(init?.headers);
        const bearer = (headers.get('Authorization') ?? '').replace(/^Bearer /, '');
        const user = state.tokens.get(bearer) ?? '';
        state.requests.push({ method, path: url.pathname });

        if (url.pathname === '/auth/v1/user') {
            if (!user) return json(401, { message: 'invalid JWT' });
            return json(200, {
                id: user,
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            });
        }
        if (url.pathname === '/rest/v1/rpc/get_sync_watermark') return json(200, new Date().toISOString());
        if (!url.pathname.startsWith('/rest/v1/')) return json(404, { message: `unexpected ${url.pathname}` });
        if (!user) return json(401, { code: 'PGRST301', message: 'JWT required' });

        const name = url.pathname.slice('/rest/v1/'.length);
        const rows = table(name);

        if (method === 'GET') {
            // An incremental pull: these tests are about the push.
            if (url.searchParams.has('updated_at')) return json(200, []);
            return json(
                200,
                [...rows.values()].filter((row) => matches(row, url.searchParams)),
            );
        }

        if (method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '[]')) as Row | Row[];
            state.writes.push({ method, table: name, body, user });
            const incoming = Array.isArray(body) ? body : [body];
            const ignoreDuplicates = (headers.get('Prefer') ?? '').includes('resolution=ignore-duplicates');
            for (const row of incoming) {
                const invalid = typeError(name, row);
                if (invalid) {
                    state.refusals.push({ table: name, code: invalid.code });
                    return json(400, { ...invalid, details: null, hint: null });
                }
                if (!mayInsert(name, row, user)) {
                    state.refusals.push({ table: name, code: '42501' });
                    return json(403, {
                        code: '42501',
                        message: `new row violates row-level security policy for table "${name}"`,
                        details: null,
                        hint: null,
                    });
                }
            }
            const stamp = new Date().toISOString();
            for (const row of incoming) {
                if (rows.has(row.id)) {
                    if (ignoreDuplicates) continue;
                    return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
                }
                rows.set(row.id, {
                    // The column defaults (20260723103000: recipes.is_custom DEFAULT false).
                    ...(name === 'recipes' ? { is_custom: false } : {}),
                    ...row,
                    created_at: stamp,
                    updated_at: stamp,
                });
            }
            return json(201, undefined);
        }

        if (method === 'PATCH') {
            const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            state.writes.push({ method, table: name, body: patch, user });
            const target = [...rows.values()].find(
                (row) => matches(row, url.searchParams) && String(row.user_id ?? '') === user,
            );
            if (!target) {
                return json(406, {
                    code: 'PGRST116',
                    message: 'JSON object requested, multiple (or no) rows returned',
                    details: 'The result contains 0 rows',
                    hint: null,
                });
            }
            Object.assign(target, patch);
            return json(200, { id: target.id });
        }

        return json(500, { message: `unexpected ${method} ${url.pathname}` });
    });

    return { state, fetch };
});

vi.mock('../services/supabase', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    return {
        supabase: createClient('https://test-project.test.invalid', 'anon-test-key', {
            auth: {
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
                storageKey: 'test-auth',
                storage: {
                    getItem: async (key: string) => h.state.storage.get(key) ?? null,
                    setItem: async (key: string, value: string) => {
                        h.state.storage.set(key, value);
                    },
                    removeItem: async (key: string) => {
                        h.state.storage.delete(key);
                    },
                },
            },
            global: { fetch: h.fetch as unknown as typeof fetch },
        }),
    };
});

// The in-memory filesystem, plus a listing of a folder's root (path ''), which
// the database reads to find its files and the shared helper does not answer.
vi.mock('@capacitor/filesystem', async () => {
    const { memoryFilesystemModule, memoryFs: fs } = await import('./helpers/memoryFilesystem');
    const module = memoryFilesystemModule();
    const readdir: typeof fs.readdir = async (options) => {
        if (options.path) return fs.readdir(options);
        const root = `${options.directory ?? 'DATA'}/`;
        const files = [...fs.files.entries()]
            .filter(([key]) => key.startsWith(root) && !key.slice(root.length).includes('/'))
            .map(([key, file]) => ({
                name: key.slice(root.length),
                type: 'file' as const,
                size: file.data.length,
                ctime: file.mtime,
                mtime: file.mtime,
                uri: `mem://${key}`,
            }));
        return { files };
    };
    return { ...module, Filesystem: { ...fs, readdir } };
});

// The share snapshot is set by each test; the cycle must not fetch another.
vi.mock('../services/vessel/sharedBinders', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/vessel/sharedBinders')>()),
    refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
}));

vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { memoryFs } from './helpers/memoryFilesystem';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getFullQueue,
    initLocalDatabase,
    insertLocal,
    mergePulledRecords,
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { syncNow } from '../services/vessel/SyncService';
import { createCustomRecipe, searchRecipes, updateCustomRecipe } from '../services/GalleyRecipeService';
import { copyMealPlan, scheduleMeal, type MealPlan } from '../services/MealPlanService';

const NOW = '2026-10-10T00:00:00.000Z';
const OYAKODON = '9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6';
const CEVICHE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const HORTA = '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e';
const AKAROA = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

const access = (read: boolean, write = read) => ({ read, write });

function storeSession(userId: string): void {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = [
        base64Url({ alg: 'HS256', typ: 'JWT' }),
        base64Url({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: expiresAt }),
        'test-signature',
    ].join('.');
    h.state.tokens.set(token, userId);
    h.state.storage.set(
        'test-auth',
        JSON.stringify({
            access_token: token,
            refresh_token: `refresh-${userId}`,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: expiresAt,
            user: {
                id: userId,
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            },
        }),
    );
}

/** A signed-in phone: its own local database, its share snapshot, a recent pull. */
async function signIn(userId: string, galley: { read: boolean; write: boolean } | null = null): Promise<void> {
    setAuthIdentityScope(userId);
    storeSession(userId);
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({
            version: 1,
            userId,
            confirmedAt: NOW,
            galleyLive: true,
            skippers: galley
                ? [
                      {
                          ownerId: 'skipper-1',
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
    await initLocalDatabase(userId);
    const now = new Date().toISOString();
    // Pulled a moment ago: the cycle under test pushes, then pulls incrementally.
    await updateSyncMeta({
        lastPullTimestamp: now,
        lastFullPullTimestamp: now,
        optionalTablesReadAt: { vessel_engine_hours: now },
    });
}

/** A second phone for the same account: an empty local database. */
async function freshPhone(userId: string): Promise<void> {
    await initLocalDatabase(null);
    memoryFs.reset();
    await signIn(userId);
}

function communityRecipe(id: string, title: string, steps: string[]): Row {
    return {
        id,
        user_id: 'sailor-9',
        title,
        image_url: 'https://images.example.test/recipes/community.jpg',
        ready_in_minutes: 25,
        servings: 2,
        ingredients: [{ name: 'Chicken thigh', amount: 300, unit: 'g', scalable: true, aisle: 'Meat' }],
        instructions: steps.map((step, index) => ({ number: index + 1, step })),
        visibility: 'community',
        tags: [],
        author_name: 'Sailor Nine',
        rating_avg: 4.5,
        rating_count: 2,
        like_count: 3,
        created_at: NOW,
    };
}

/** The `recipes` twin saveCustomRecipe writes beside a public community recipe. */
function twinOf(community: Row): Row {
    return {
        id: community.id,
        spoonacular_id: null,
        user_id: community.user_id,
        title: community.title,
        image_url: community.image_url,
        ready_in_minutes: community.ready_in_minutes,
        servings: community.servings,
        source_url: '',
        instructions: JSON.stringify(community.instructions),
        ingredients: community.ingredients,
        is_favorite: false,
        is_custom: true,
        visibility: 'shared',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
    };
}

function serverRows(name: string): Row[] {
    return [...(h.state.tables.get(name)?.values() ?? [])];
}

async function searchOne(title: string) {
    const [result] = await searchRecipes(title);
    expect(result?.title).toBe(title);
    return result;
}

beforeEach(() => {
    memoryFs.reset();
    localStorage.clear();
    // The database files already live in Library (LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    h.state.storage.clear();
    h.state.tokens.clear();
    h.state.tables.clear();
    h.state.writes = [];
    h.state.refusals = [];
    h.state.requests = [];
    h.state.galleyWriters.clear();
    h.state.passageCrew.clear();
});

afterEach(async () => {
    await initLocalDatabase(null);
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('the fence: the fake server refuses what Postgres refuses', () => {
    it('a meal row carrying a search result display key is refused (22P02 / 22003) and stays queued', async () => {
        await signIn('skipper-1');
        const stuck = (spoonacularId: number, id: string): MealPlan => ({
            id,
            user_id: 'skipper-1',
            voyage_id: null,
            recipe_id: null,
            spoonacular_id: spoonacularId,
            title: '親子丼',
            planned_date: '2026-10-12',
            meal_slot: 'dinner',
            servings_planned: 2,
            ingredients: [],
            status: 'reserved',
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: NOW,
            updated_at: NOW,
        });
        // What the old searchCommunityRecipes / searchPrivateRecipes ids looked like.
        await insertLocal('meal_plans', stuck(1791234567890.42, '6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b'));
        await insertLocal('meal_plans', stuck(1791234567890, '7f8a9b0c-1d2e-4f3a-9b4c-5d6e7f8a9b0c'));

        const result = await syncNow();

        expect(h.state.refusals).toEqual([
            { table: 'meal_plans', code: '22P02' },
            { table: 'meal_plans', code: '22003' },
        ]);
        expect(result.errors).toHaveLength(2);
        expect(getFullQueue().map((item) => [item.table_name, item.status])).toEqual([
            ['meal_plans', 'failed'],
            ['meal_plans', 'failed'],
        ]);
        expect(serverRows('meal_plans')).toEqual([]);
    });
});

describe('a meal planned from a searched recipe reaches the server (GAL-02)', () => {
    it('親子丼 from the community, with its twin on the phone: spoonacular_id null, recipe_id the twin', async () => {
        const community = communityRecipe(OYAKODON, '親子丼', ['Simmer the dashi.', 'Add chicken and egg.']);
        h.state.tables.set('community_recipes', new Map([[OYAKODON, community]]));
        h.state.tables.set('recipes', new Map([[OYAKODON, twinOf(community)]]));
        await signIn('skipper-1');
        await mergePulledRecords('recipes', [twinOf(community)]);

        const meal = await searchOne('親子丼');
        const plan = await scheduleMeal(meal, '2026-10-12', 'dinner', null, 2, 'skipper-1');

        expect(plan).toMatchObject({ spoonacular_id: null, recipe_id: OYAKODON });
        // The twin is another sailor's row: only read, never written.
        expect(getFullQueue().map((item) => [item.table_name, item.mutation_type])).toEqual([['meal_plans', 'INSERT']]);

        const result = await syncNow();

        expect(result.errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('meal_plans')).toEqual([
            expect.objectContaining({ id: plan.id, title: '親子丼', spoonacular_id: null, recipe_id: OYAKODON }),
        ]);
        expect(serverRows('recipes')).toHaveLength(1);
    });

    it('no twin: a v8 copy is queued ahead of the meal, both push, and two phones make ONE copy', async () => {
        h.state.tables.set(
            'community_recipes',
            new Map([
                [CEVICHE, communityRecipe(CEVICHE, 'Ceviche de corvina', ['Cube the corvina.', 'Cure in lime.'])],
            ]),
        );
        await signIn('skipper-1');

        const first = await scheduleMeal(
            await searchOne('Ceviche de corvina'),
            '2026-10-12',
            'lunch',
            null,
            2,
            'skipper-1',
        );
        const queue = getFullQueue();
        expect(queue.map((item) => [item.table_name, item.mutation_type])).toEqual([
            ['recipes', 'INSERT'],
            ['meal_plans', 'INSERT'],
        ]);
        const copyId = queue[0].record_id;
        expect(copyId[14]).toBe('8');
        expect(first).toMatchObject({ spoonacular_id: null, recipe_id: copyId });
        expect(JSON.parse(queue[0].payload)).toMatchObject({
            id: copyId,
            user_id: 'skipper-1',
            spoonacular_id: null,
            is_custom: false,
            visibility: 'personal',
            instructions: JSON.stringify([
                { number: 1, step: 'Cube the corvina.' },
                { number: 2, step: 'Cure in lime.' },
            ]),
        });

        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);

        // The skipper's iPad plans the same recipe: the same copy id, ignored as a duplicate.
        await freshPhone('skipper-1');
        const second = await scheduleMeal(
            await searchOne('Ceviche de corvina'),
            '2026-10-13',
            'lunch',
            null,
            2,
            'skipper-1',
        );
        expect(second.recipe_id).toBe(copyId);
        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);

        expect(serverRows('recipes')).toEqual([expect.objectContaining({ id: copyId, user_id: 'skipper-1' })]);
        expect(serverRows('meal_plans').map((row) => row.recipe_id)).toEqual([copyId, copyId]);
        expect(h.state.refusals).toEqual([]);
    });

    it('a simple meal, planned then copied to the next day: both rows have null ids and both push', async () => {
        await signIn('skipper-1');
        const planned = await scheduleMeal(
            {
                id: Date.now(),
                title: 'Pizza night',
                readyInMinutes: 45,
                servings: 4,
                image: '',
                sourceUrl: '',
                ingredients: [],
                isSimpleMeal: true,
            },
            '2026-10-14',
            'dinner',
            AKAROA,
            4,
            'skipper-1',
        );
        const copied = await copyMealPlan(planned, '2026-10-15', AKAROA, 'skipper-1');

        expect(copied).toMatchObject({ planned_date: '2026-10-15', recipe_id: null, spoonacular_id: null });
        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('meal_plans').map((row) => [row.title, row.recipe_id, row.spoonacular_id])).toEqual([
            ['Pizza night', null, null],
            ['Pizza night', null, null],
        ]);
        expect(serverRows('recipes')).toEqual([]);
    });
});

describe('crew planning a passage meal from a community recipe (Horta → Ponta Delgada)', () => {
    beforeEach(() => {
        h.state.tables.set(
            'community_recipes',
            new Map([
                [CEVICHE, communityRecipe(CEVICHE, 'Ceviche de corvina', ['Cube the corvina.', 'Cure in lime.'])],
            ]),
        );
        h.state.passageCrew.set('crew-1', new Set([HORTA]));
    });

    it('without the Galley share the copy is the crew member’s own, and nothing is refused', async () => {
        await signIn('crew-1');

        const plan = await scheduleMeal(
            await searchOne('Ceviche de corvina'),
            '2026-10-20',
            'dinner',
            HORTA,
            3,
            'skipper-1',
        );
        const [copy] = getFullQueue();
        expect(JSON.parse(copy.payload)).toMatchObject({ user_id: 'crew-1' });
        expect(plan).toMatchObject({ user_id: 'skipper-1', recipe_id: copy.record_id });

        expect((await syncNow()).errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('recipes')).toEqual([expect.objectContaining({ id: copy.record_id, user_id: 'crew-1' })]);
    });

    it('with the Galley share (write) the copy is the skipper’s', async () => {
        h.state.galleyWriters.set('crew-1', new Set(['skipper-1']));
        await signIn('crew-1', access(true, true));

        const plan = await scheduleMeal(
            await searchOne('Ceviche de corvina'),
            '2026-10-20',
            'dinner',
            HORTA,
            3,
            'skipper-1',
        );
        const [copy] = getFullQueue();
        expect(JSON.parse(copy.payload)).toMatchObject({ user_id: 'skipper-1' });
        expect(plan.recipe_id).toBe(copy.record_id);

        expect((await syncNow()).errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(serverRows('recipes')).toEqual([expect.objectContaining({ id: copy.record_id, user_id: 'skipper-1' })]);
    });
});

describe('crew plan their own private recipe into the skipper’s shared Galley (Lyttelton → Akaroa)', () => {
    it('the meal links to a copy in the skipper’s library, not to the crew member’s personal recipe', async () => {
        const PRIVATE_CEVICHE = '2d3e4f5a-6b7c-4d8e-9f0a-b1c2d3e4f5a6';
        const mine: Row = {
            ...communityRecipe(PRIVATE_CEVICHE, 'Ceviche de corvina', ['Cube the corvina.', 'Cure in lime.']),
            user_id: 'crew-1',
            visibility: 'private',
        };
        // Captain's Table wrote its personal twin; the skipper's devices cannot read it.
        const myTwin: Row = { ...twinOf(mine), visibility: 'personal' };
        h.state.tables.set('community_recipes', new Map([[PRIVATE_CEVICHE, mine]]));
        h.state.tables.set('recipes', new Map([[PRIVATE_CEVICHE, myTwin]]));
        h.state.galleyWriters.set('crew-1', new Set(['skipper-1']));
        await signIn('crew-1', access(true, true));
        await mergePulledRecords('recipes', [myTwin]);

        const plan = await scheduleMeal(await searchOne('Ceviche de corvina'), '2026-10-22', 'dinner', null, 3, null);

        const [copy, meal] = getFullQueue();
        expect([copy.table_name, meal.table_name]).toEqual(['recipes', 'meal_plans']);
        expect(plan).toMatchObject({ user_id: 'skipper-1', recipe_id: copy.record_id, spoonacular_id: null });
        expect(plan.recipe_id).not.toBe(PRIVATE_CEVICHE);
        expect(JSON.parse(copy.payload)).toMatchObject({
            user_id: 'skipper-1',
            instructions: JSON.stringify([
                { number: 1, step: 'Cube the corvina.' },
                { number: 2, step: 'Cure in lime.' },
            ]),
        });

        expect((await syncNow()).errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        // The skipper (and anyone in his Galley) can read the recipe the meal names.
        const linked = serverRows('recipes').find((row) => row.id === plan.recipe_id);
        expect(linked).toMatchObject({ user_id: 'skipper-1' });
        expect(serverRows('meal_plans')).toEqual([
            expect.objectContaining({ user_id: 'skipper-1', recipe_id: plan.recipe_id }),
        ]);
    });
});

describe('a Galley-made recipe keeps is_custom on the server (GAL-03)', () => {
    it('no direct upsert: the outbox INSERT carries is_custom, an edit while queued rides behind it', async () => {
        await signIn('skipper-1');

        const created = await createCustomRecipe({
            title: 'Tarte Tatin',
            instructions: 'Caramelise the sugar.\nAdd the apples.\nBake under pastry.',
            ready_in_minutes: 70,
            servings: 6,
            ingredients: [],
            tags: [],
            visibility: 'personal',
        });
        // Nothing went to the recipes table before the outbox push.
        expect(h.state.writes).toEqual([]);

        const edited = await updateCustomRecipe(created!.id, { title: 'Tarte Tatin aux poires' });
        expect(edited).toMatchObject({ id: created!.id, title: 'Tarte Tatin aux poires', is_custom: true });
        expect(getFullQueue().map((item) => [item.table_name, item.mutation_type])).toEqual([
            ['recipes', 'INSERT'],
            ['recipes', 'UPDATE'],
        ]);

        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);

        const insert = h.state.writes.find((write) => write.method === 'POST' && write.table === 'recipes');
        expect(insert?.body).toMatchObject({ is_custom: true, spoonacular_id: null, user_id: 'skipper-1' });
        // The database clock owns the timestamps.
        expect(insert?.body).not.toHaveProperty('created_at');
        expect(insert?.body).not.toHaveProperty('updated_at');
        expect(serverRows('recipes')).toEqual([
            expect.objectContaining({ id: created!.id, title: 'Tarte Tatin aux poires', is_custom: true }),
        ]);
    });
});
