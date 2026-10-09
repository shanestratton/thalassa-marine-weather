/**
 * Stuck Galley rows push (126-B2b, binder audit GAL-02 repair; Shane
 * 2026-10-09: "check all of the binders to make sure that they are at the same
 * standard as the rest of the app").
 *
 * Before 126 a meal planned from a searched recipe stored the search result's
 * fake numeric id (Date.now() + Math.random()) in meal_plans.spoonacular_id,
 * and persistRecipe saved an ownerless copy of the recipe under the same fake
 * id, once per scheduling. Postgres refused both on every push, the outbox
 * retried them every cycle, and they never left the phone. repairGalleyOutbox
 * runs once per database load: it nulls the fake ids in the rows and their
 * queued payloads, removes exact duplicate copies that never reached the
 * server, and links each meal to the surviving copy.
 *
 * The real chain: the real LocalDatabase over the in-memory filesystem, the
 * real repair, the real SyncService push and the REAL supabase-js client, with
 * only fetch faked. The fake PostgREST has live's columns (helpers/
 * galleyLiveSchema): it refuses a key the table has no column for the way
 * PostgREST does (PGRST204, HTTP 400), then a fractional or out-of-range
 * INTEGER the way Postgres does (22P02 / 22003), on INSERT and on UPDATE.
 * By default it is live once 20261010145000_recipes_live_schema_alignment is
 * pushed; one test runs on live as it is today.
 *
 * Fictional boats and sailors only: 'Kestrel' (skipper 'skipper-1'),
 * 'Albatross' (crew 'crew-1'); recipes 'Feijoada', '親子丼', 'Ψαρόσουπα'.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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
        storage: new Map<string, string>(),
        tokens: new Map<string, string>(),
        tables: new Map<string, Map<string, Row>>(),
        writes: [] as { method: string; table: string; body: unknown; user: string }[],
        refusals: [] as { table: string; code: string }[],
        /** Called before every filesystem write (the account-switch and crash tests). */
        beforeWrite: null as null | ((path: string, data: string) => void),
        /** Live's Galley columns today, or once the alignment migration is pushed. */
        schema: 'aligned' as 'live' | 'aligned',
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
    function typeError(name: string, row: Record<string, unknown>): { code: string; message: string } | null {
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

    /** PostgREST first (PGRST204: no such column), then Postgres (the value's type). */
    async function writeError(name: string, row: Record<string, unknown>) {
        const { unknownColumnError } = await import('./helpers/galleyLiveSchema');
        return unknownColumnError(name, row, state.schema) ?? typeError(name, row);
    }

    const refuse = (name: string, invalid: { code: string; message: string }) => {
        state.refusals.push({ table: name, code: invalid.code });
        return json(400, { ...invalid, details: null, hint: null });
    };

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const headers = new Headers(init?.headers);
        const bearer = (headers.get('Authorization') ?? '').replace(/^Bearer /, '');
        const user = state.tokens.get(bearer) ?? '';

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

        // An incremental pull: these tests are about the push.
        if (method === 'GET') return json(200, url.searchParams.has('updated_at') ? [] : [...rows.values()]);

        if (method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '[]')) as Row | Row[];
            state.writes.push({ method, table: name, body, user });
            const incoming = Array.isArray(body) ? body : [body];
            for (const row of incoming) {
                const invalid = await writeError(name, row);
                if (invalid) return refuse(name, invalid);
            }
            const stamp = new Date().toISOString();
            for (const row of incoming) {
                if (rows.has(row.id)) continue; // ignoreDuplicates
                rows.set(row.id, {
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
            const invalid = await writeError(name, patch);
            if (invalid) return refuse(name, invalid);
            const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '');
            const target = rows.get(id);
            if (!target || String(target.user_id ?? '') !== user) {
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

// The in-memory filesystem, a listing of a folder's root (path ''), and a hook
// before every write.
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
    const writeFile: typeof fs.writeFile = async (options) => {
        h.state.beforeWrite?.(options.path, String(options.data));
        return fs.writeFile(options);
    };
    return { ...module, Filesystem: { ...fs, readdir, writeFile } };
});

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
    getAll,
    getById,
    getFullQueue,
    initLocalDatabase,
    insertLocal,
    mergePulledRecords,
    updateLocal,
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { syncNow } from '../services/vessel/SyncService';
import { getMealSteps } from '../services/GalleyRecipeService';
import { repairGalleyOutbox } from '../services/galley/galleyOutboxRepair';

const FAKE_A = 1791234567890;
const FAKE_B = 1791234567890.42;
const FAKE_C = 1791234567891.7;
const COPY_1 = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const COPY_2 = '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a';
const COPY_3 = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const MEAL_1 = '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c';
const MEAL_2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const FEIJOADA_INGREDIENTS = [
    { name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Pantry' },
    { name: 'Smoked sausage', amount: 300, unit: 'g', scalable: true, aisle: 'Meat' },
];
const FEIJOADA_STEPS = JSON.stringify([
    { number: 1, step: 'Soak the beans overnight.' },
    { number: 2, step: 'Simmer with the sausage for two hours.' },
]);

/** The ownerless copy the old persistRecipe saved for every scheduling. */
function oldCopy(id: string, fake: number, createdAt: string, overrides: Partial<Row> = {}): Row {
    return {
        id,
        spoonacular_id: fake,
        user_id: null,
        title: 'Feijoada',
        image_url: '',
        ready_in_minutes: 90,
        servings: 4,
        source_url: '',
        instructions: FEIJOADA_STEPS,
        ingredients: FEIJOADA_INGREDIENTS,
        is_favorite: false,
        is_custom: false,
        visibility: 'personal',
        tags: [],
        created_at: createdAt,
        updated_at: createdAt,
        ...overrides,
    };
}

/** A meal the old scheduleMeal planned: recipe_id null, the fake id in spoonacular_id. */
function oldMeal(id: string, fake: number, date: string): Row {
    return {
        id,
        user_id: 'skipper-1',
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: fake,
        title: 'Feijoada',
        planned_date: date,
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: FEIJOADA_INGREDIENTS,
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: `${date}T08:00:00.000Z`,
        updated_at: `${date}T08:00:00.000Z`,
    };
}

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

async function signIn(userId: string): Promise<void> {
    setAuthIdentityScope(userId);
    storeSession(userId);
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({
            version: 1,
            userId,
            confirmedAt: '2026-10-10T00:00:00.000Z',
            galleyLive: true,
            skippers: [],
        }),
    );
    reloadSharedBindersFromStorage();
    await initLocalDatabase(userId);
    const now = new Date().toISOString();
    await updateSyncMeta({
        lastPullTimestamp: now,
        lastFullPullTimestamp: now,
        optionalTablesReadAt: { vessel_engine_hours: now },
    });
}

/**
 * What a phone that ran the old build holds: three copies of the same
 * Feijoada (one per scheduling, each under its own fake id), two meals that
 * name two of them by fake id, and a whole-row recipes UPDATE (the one
 * getRecipeInstructions queued) on the oldest copy.
 */
async function stuckPhone(): Promise<void> {
    await insertLocal('recipes', oldCopy(COPY_1, FAKE_A, '2026-09-20T08:00:00.000Z'));
    await insertLocal('meal_plans', oldMeal(MEAL_1, FAKE_A, '2026-09-21'));
    await insertLocal('recipes', oldCopy(COPY_2, FAKE_B, '2026-09-22T08:00:00.000Z'));
    await insertLocal('meal_plans', oldMeal(MEAL_2, FAKE_B, '2026-09-23'));
    await insertLocal('recipes', oldCopy(COPY_3, FAKE_C, '2026-09-24T08:00:00.000Z'));
    const oldest = getById<Row>('recipes', COPY_1) as Row;
    await updateLocal('recipes', COPY_1, { ...oldest, instructions: FEIJOADA_STEPS });
}

function serverRows(name: string): Row[] {
    return [...(h.state.tables.get(name)?.values() ?? [])];
}

type WarnSpy = MockInstance<typeof console.warn>;

function repairWarnings(warn: WarnSpy): string[] {
    return warn.mock.calls
        .map((call) => call.map((part) => String(part)).join(' '))
        .filter((line) => line.includes('galley-repair:'));
}

let warn: WarnSpy;

beforeEach(() => {
    memoryFs.reset();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    h.state.storage.clear();
    h.state.tokens.clear();
    h.state.tables.clear();
    h.state.writes = [];
    h.state.refusals = [];
    h.state.beforeWrite = null;
    h.state.schema = 'aligned';
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
    h.state.beforeWrite = null;
    await initLocalDatabase(null);
    setAuthIdentityScope(null);
    localStorage.clear();
    warn.mockRestore();
});

describe('stuck Galley rows push after the repair', () => {
    it('before: every stuck row is refused by the server, and stays queued', async () => {
        await signIn('skipper-1');
        await stuckPhone();

        const result = await syncNow();

        expect(h.state.refusals.map((refusal) => refusal.table)).toEqual([
            'recipes',
            'meal_plans',
            'recipes',
            'meal_plans',
            'recipes',
        ]);
        expect(result.errors).toHaveLength(5);
        expect(getFullQueue().map((item) => [item.table_name, item.mutation_type, item.status])).toEqual([
            ['recipes', 'INSERT', 'failed'],
            ['meal_plans', 'INSERT', 'failed'],
            ['recipes', 'INSERT', 'failed'],
            ['meal_plans', 'INSERT', 'failed'],
            ['recipes', 'INSERT', 'failed'],
            // Fenced behind its refused INSERT.
            ['recipes', 'UPDATE', 'pending'],
        ]);
        expect(serverRows('recipes')).toEqual([]);
        expect(serverRows('meal_plans')).toEqual([]);
    });

    it('after: one copy survives, both meals link to it, and one cycle pushes everything', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        await syncNow();
        h.state.refusals = [];

        const outcome = await repairGalleyOutbox();

        expect(outcome).toEqual({ meals: 2, recipes: 1, duplicates: 2 });
        expect(getAll<Row>('recipes').map((row) => [row.id, row.spoonacular_id])).toEqual([[COPY_1, null]]);
        expect(getAll<Row>('meal_plans').map((row) => [row.id, row.recipe_id, row.spoonacular_id])).toEqual([
            [MEAL_1, COPY_1, null],
            [MEAL_2, COPY_1, null],
        ]);
        expect(getFullQueue().map((item) => [item.table_name, item.record_id, item.mutation_type])).toEqual([
            ['recipes', COPY_1, 'INSERT'],
            ['meal_plans', MEAL_1, 'INSERT'],
            ['meal_plans', MEAL_2, 'INSERT'],
            ['recipes', COPY_1, 'UPDATE'],
        ]);
        // Cooking Mode now reads the directions through the link.
        const meal2 = getById<{ recipe_id: string | null; spoonacular_id: number | null }>('meal_plans', MEAL_2);
        expect((await getMealSteps(meal2 ?? {})).map((step) => step.step)).toEqual([
            'Soak the beans overnight.',
            'Simmer with the sausage for two hours.',
        ]);

        const result = await syncNow();

        expect(result.errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('recipes')).toEqual([
            expect.objectContaining({ id: COPY_1, user_id: 'skipper-1', spoonacular_id: null, title: 'Feijoada' }),
        ]);
        expect(serverRows('meal_plans').map((row) => [row.id, row.recipe_id, row.spoonacular_id])).toEqual([
            [MEAL_1, COPY_1, null],
            [MEAL_2, COPY_1, null],
        ]);
    });

    it('on live as it is today, the recipes wait for the alignment migration, the meals push, and nothing is lost', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        await repairGalleyOutbox();
        // Live public.recipes has no spoonacular_id or source_url column until
        // 20261010145000_recipes_live_schema_alignment.sql is pushed.
        h.state.schema = 'live';

        const today = await syncNow();

        // The INSERT is refused by PostgREST; the whole-row UPDATE waits behind it.
        expect(h.state.refusals).toEqual([{ table: 'recipes', code: 'PGRST204' }]);
        expect(today.errors).toEqual([
            expect.stringMatching(/^recipes\/.+: Could not find the '(spoonacular_id|source_url)' column of 'recipes'/),
        ]);
        expect(serverRows('recipes')).toEqual([]);
        expect(serverRows('meal_plans').map((row) => [row.id, row.recipe_id, row.spoonacular_id])).toEqual([
            [MEAL_1, COPY_1, null],
            [MEAL_2, COPY_1, null],
        ]);
        expect(getFullQueue().map((item) => [item.table_name, item.record_id, item.mutation_type])).toEqual([
            ['recipes', COPY_1, 'INSERT'],
            ['recipes', COPY_1, 'UPDATE'],
        ]);

        // The migration is pushed: the next cycle catches up, with no repair needed.
        h.state.schema = 'aligned';
        h.state.refusals = [];
        const next = await syncNow();

        expect(next.errors).toEqual([]);
        expect(h.state.refusals).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('recipes')).toEqual([
            expect.objectContaining({ id: COPY_1, user_id: 'skipper-1', spoonacular_id: null, title: 'Feijoada' }),
        ]);
    });

    it('runs when the database loads, before the sync engine starts, and says so once with counts only', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        // The next launch (126 installed): the database loads from disk.
        await initLocalDatabase(null);
        await initLocalDatabase('skipper-1');

        expect(getAll<Row>('recipes').map((row) => row.id)).toEqual([COPY_1]);
        expect(getAll<Row>('meal_plans').every((row) => row.recipe_id === COPY_1 && row.spoonacular_id === null)).toBe(
            true,
        );
        const lines = repairWarnings(warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('galley-repair: 2 meals, 1 recipes fixed, 2 duplicate copies removed');
        expect(lines[0]).not.toMatch(UUID_ANYWHERE);
        expect(lines[0]).not.toMatch(/Feijoada|1791234567/);
    });

    it('is idempotent: a second run writes nothing and logs nothing', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        await repairGalleyOutbox();
        expect(repairWarnings(warn)).toHaveLength(1);
        const writes = memoryFs.count('writeFile');
        const queue = getFullQueue();

        await expect(repairGalleyOutbox()).resolves.toEqual({ meals: 0, recipes: 0, duplicates: 0 });

        expect(memoryFs.count('writeFile')).toBe(writes);
        expect(getFullQueue()).toEqual(queue);
        expect(repairWarnings(warn)).toHaveLength(1);
    });

    it('a phone with nothing stuck: no writes and no log line', async () => {
        await signIn('skipper-1');
        await insertLocal('recipes', oldCopy(COPY_1, 123456, '2026-09-20T08:00:00.000Z', { title: 'Ψαρόσουπα' }));
        await insertLocal('meal_plans', { ...oldMeal(MEAL_1, 123456, '2026-09-21'), recipe_id: COPY_1 });
        const writes = memoryFs.count('writeFile');

        await expect(repairGalleyOutbox()).resolves.toEqual({ meals: 0, recipes: 0, duplicates: 0 });

        expect(memoryFs.count('writeFile')).toBe(writes);
        expect(repairWarnings(warn)).toEqual([]);
        expect(getById<Row>('recipes', COPY_1)).toMatchObject({ spoonacular_id: 123456 });
    });
});

describe('only exact duplicates that never reached the server are removed', () => {
    it('Feijoada with different directions is its own recipe: both survive and both push', async () => {
        await signIn('skipper-1');
        await insertLocal('recipes', oldCopy(COPY_1, FAKE_A, '2026-09-20T08:00:00.000Z'));
        await insertLocal(
            'recipes',
            oldCopy(COPY_2, FAKE_B, '2026-09-22T08:00:00.000Z', {
                instructions: JSON.stringify([{ number: 1, step: 'Pressure-cook the beans for forty minutes.' }]),
            }),
        );
        await insertLocal('meal_plans', oldMeal(MEAL_2, FAKE_B, '2026-09-23'));

        await expect(repairGalleyOutbox()).resolves.toEqual({ meals: 1, recipes: 2, duplicates: 0 });

        expect(getAll<Row>('recipes').map((row) => [row.id, row.spoonacular_id])).toEqual([
            [COPY_1, null],
            [COPY_2, null],
        ]);
        // The meal links to the copy it was planned from.
        expect(getById<Row>('meal_plans', MEAL_2)).toMatchObject({ recipe_id: COPY_2, spoonacular_id: null });
        expect((await syncNow()).errors).toEqual([]);
        expect(serverRows('recipes').map((row) => row.id)).toEqual([COPY_1, COPY_2]);
    });

    it('a copy owned by another account, or titled differently, is not merged', async () => {
        await signIn('skipper-1');
        await insertLocal('recipes', oldCopy(COPY_1, FAKE_A, '2026-09-20T08:00:00.000Z'));
        await insertLocal('recipes', oldCopy(COPY_2, FAKE_B, '2026-09-22T08:00:00.000Z', { user_id: 'crew-1' }));
        await insertLocal('recipes', oldCopy(COPY_3, FAKE_C, '2026-09-24T08:00:00.000Z', { title: '親子丼' }));

        await expect(repairGalleyOutbox()).resolves.toEqual({ meals: 0, recipes: 3, duplicates: 0 });
        expect(getAll<Row>('recipes').map((row) => row.id)).toEqual([COPY_1, COPY_2, COPY_3]);
    });

    it('a row whose first queued item is an UPDATE (it reached the server) is never removed', async () => {
        await signIn('skipper-1');
        // On the server already, then edited here with a whole-row UPDATE.
        await mergePulledRecords('recipes', [oldCopy(COPY_1, FAKE_A, '2026-09-20T08:00:00.000Z')]);
        h.state.tables.set(
            'recipes',
            new Map([
                [
                    COPY_1,
                    {
                        ...oldCopy(COPY_1, FAKE_A, '2026-09-20T08:00:00.000Z'),
                        spoonacular_id: null,
                        user_id: 'skipper-1',
                    },
                ],
            ]),
        );
        const pulled = getById<Row>('recipes', COPY_1) as Row;
        await updateLocal('recipes', COPY_1, { ...pulled });
        // An exact, unsent duplicate of it, made later.
        await insertLocal('recipes', oldCopy(COPY_2, FAKE_B, '2026-09-22T08:00:00.000Z'));

        await repairGalleyOutbox();

        expect(getById<Row>('recipes', COPY_1)).toMatchObject({ spoonacular_id: null });
        expect(getFullQueue().map((item) => [item.record_id, item.mutation_type])).toEqual([
            [COPY_1, 'UPDATE'],
            [COPY_2, 'INSERT'],
        ]);
        expect(JSON.parse(getFullQueue()[0].payload)).toMatchObject({ spoonacular_id: null });
        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);
    });
});

describe('a meal linked to a duplicate that is removed follows it to the survivor (B2a review must-do)', () => {
    it('an unsent meal: its queued INSERT is rewritten, and it pushes the survivor', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        // Copied (copyMealPlan's legacy link) before the repair ran: linked to the newest copy.
        const copied = { ...oldMeal(MEAL_2, FAKE_C, '2026-09-30'), id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e' };
        await insertLocal('meal_plans', { ...copied, spoonacular_id: null, recipe_id: COPY_3 });

        await repairGalleyOutbox();

        expect(getById<Row>('recipes', COPY_3)).toBeNull();
        expect(getById<Row>('meal_plans', copied.id)).toMatchObject({ recipe_id: COPY_1 });
        expect((await syncNow()).errors).toEqual([]);
        expect(serverRows('meal_plans').find((row) => row.id === copied.id)).toMatchObject({ recipe_id: COPY_1 });
        expect(serverRows('recipes').map((row) => row.id)).toEqual([COPY_1]);
    });

    it('a meal already on the server: an UPDATE moves its link to the survivor', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        const onServer = {
            ...oldMeal(MEAL_2, FAKE_C, '2026-09-30'),
            id: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
            spoonacular_id: null,
            recipe_id: COPY_3,
        };
        h.state.tables.set('meal_plans', new Map([[onServer.id, { ...onServer }]]));
        await mergePulledRecords('meal_plans', [onServer]);

        await repairGalleyOutbox();

        expect(getById<Row>('recipes', COPY_3)).toBeNull();
        expect(getById<Row>('meal_plans', onServer.id)).toMatchObject({ recipe_id: COPY_1 });
        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('meal_plans').find((row) => row.id === onServer.id)).toMatchObject({ recipe_id: COPY_1 });
    });
    it('killed between the relink and its UPDATE: the next launch still moves the server’s link', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        const onServer = {
            ...oldMeal(MEAL_2, FAKE_C, '2026-09-30'),
            id: 'ad1e2f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a',
            spoonacular_id: null,
            recipe_id: COPY_3,
        };
        h.state.tables.set('meal_plans', new Map([[onServer.id, { ...onServer }]]));
        await mergePulledRecords('meal_plans', [onServer]);
        // iOS kills the app as the repair queues this meal's UPDATE: the
        // outbox write never lands, and nothing after it runs.
        let killed = false;
        h.state.beforeWrite = (path, data) => {
            if (killed || !path.includes('sync_queue') || !data.includes(onServer.id)) return;
            killed = true;
            throw new Error('killed');
        };

        await expect(repairGalleyOutbox()).rejects.toThrow('killed');
        h.state.beforeWrite = null;
        expect(killed).toBe(true);

        // The next launch: the database loads from disk and the repair runs again.
        await initLocalDatabase(null);
        await initLocalDatabase('skipper-1');
        expect(getById<Row>('recipes', COPY_3)).toBeNull();
        expect(getById<Row>('meal_plans', onServer.id)).toMatchObject({ recipe_id: COPY_1 });

        expect((await syncNow()).errors).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        expect(serverRows('meal_plans').find((row) => row.id === onServer.id)).toMatchObject({ recipe_id: COPY_1 });
        expect(serverRows('recipes').map((row) => row.id)).toEqual([COPY_1]);
    });
});

describe('the identity guard', () => {
    it('an account switch mid-repair writes nothing into the new account’s files', async () => {
        await signIn('skipper-1');
        await stuckPhone();
        let switched: Promise<void> | null = null;
        h.state.beforeWrite = () => {
            if (switched) return;
            // The first write of the repair: crew-1 signs in on this phone.
            setAuthIdentityScope('crew-1');
            storeSession('crew-1');
            switched = initLocalDatabase('crew-1');
        };

        // It stops after the write in progress (the first meal), without throwing.
        await expect(repairGalleyOutbox()).resolves.toEqual({ meals: 1, recipes: 0, duplicates: 0 });
        h.state.beforeWrite = null;
        expect(switched).not.toBeNull();
        await switched;

        expect(getAll('recipes')).toEqual([]);
        expect(getAll('meal_plans')).toEqual([]);
        expect(getFullQueue()).toEqual([]);
        const crewFiles = [...memoryFs.files.keys()].filter((key) => key.includes('_user_637265772d31_'));
        for (const key of crewFiles) {
            expect(memoryFs.files.get(key)?.data ?? '').not.toMatch(/Feijoada|1791234567/);
        }

        // Back on the skipper's account, the next load finishes the repair.
        setAuthIdentityScope('skipper-1');
        storeSession('skipper-1');
        await initLocalDatabase('skipper-1');
        expect(getAll<Row>('recipes').map((row) => [row.id, row.spoonacular_id])).toEqual([[COPY_1, null]]);
        expect(getAll<Row>('meal_plans').every((row) => row.recipe_id === COPY_1 && row.spoonacular_id === null)).toBe(
            true,
        );
    });
});
