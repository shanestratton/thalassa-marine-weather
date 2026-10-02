/**
 * The binder sweep and every pull carry the signed-in user's token, never the
 * anon key (review, 2026-10-02).
 *
 * The REAL @supabase/supabase-js client, with only fetch faked. The path that
 * emptied a device's binders: getUser passes at the start of a cycle; later in
 * the same cycle the token falls inside auth-js's 90 s expiry margin and the
 * refresh fails with a retryable error (a dropped link, a 503). auth-js then
 * hands getSession() a null session WITHOUT signing out, supabase-js sends
 * the anon key instead, and RLS answers anon with [] and HTTP 200. The sweep
 * read that as "every row was deleted elsewhere".
 *
 * No real accounts or projects: 'user-1', test.invalid URLs, fake tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BINDER_TABLES = [
    'inventory_items',
    'maintenance_tasks',
    'maintenance_history',
    'equipment_register',
    'ship_documents',
];

function base64Url(value: unknown): string {
    return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const h = vi.hoisted(() => {
    const state = {
        /** auth storage: the persisted session */
        storage: new Map<string, string>(),
        userToken: '',
        /** table → ids the server lists for the signed-in user */
        serverIds: new Map<string, string[]>(),
        /** the next watermark RPC moves the clock this far (the cycle took a while) */
        clockJumpOnWatermark: 0,
        /** the token endpoint is down (retryable 503) */
        tokenEndpointDown: false,
        /** PostgREST rejects the user's token (401) on id listings */
        rejectUserToken: false,
        restLog: [] as { table: string; select: string; bearer: 'USER' | 'ANON' | 'OTHER' }[],
        meta: {} as Record<string, string | null>,
        prunes: [] as { table: string; ids: string[] }[],
        appStateListener: null as unknown,
    };

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const headers = new Headers(init?.headers);
        const authorization = headers.get('Authorization') ?? '';
        const bearer =
            authorization === `Bearer ${state.userToken}`
                ? ('USER' as const)
                : authorization === 'Bearer anon-test-key'
                  ? ('ANON' as const)
                  : ('OTHER' as const);

        if (url.pathname === '/auth/v1/user') {
            if (bearer !== 'USER') return json(401, { message: 'invalid JWT' });
            return json(200, {
                id: 'user-1',
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            });
        }
        if (url.pathname === '/auth/v1/token') {
            if (state.tokenEndpointDown) return json(503, { message: 'upstream unavailable' });
            return json(400, { message: 'refresh not expected in this test' });
        }
        if (url.pathname === '/rest/v1/rpc/get_sync_watermark') {
            if (state.clockJumpOnWatermark > 0) {
                vi.setSystemTime(Date.now() + state.clockJumpOnWatermark);
                state.clockJumpOnWatermark = 0;
            }
            return json(200, new Date(Date.now()).toISOString());
        }
        if (url.pathname.startsWith('/rest/v1/')) {
            const table = url.pathname.slice('/rest/v1/'.length);
            const select = url.searchParams.get('select') ?? '';
            state.restLog.push({ table, select, bearer });
            if (bearer === 'USER' && state.rejectUserToken && select === 'id') {
                return json(401, { code: 'PGRST301', message: 'JWT expired' });
            }
            // RLS: the binder SELECT policies are TO authenticated, so anon
            // reads an empty table with HTTP 200 and no error.
            if (bearer !== 'USER') return json(200, []);
            if (select === 'id')
                return json(
                    200,
                    (state.serverIds.get(table) ?? []).map((id) => ({ id })),
                );
            return json(200, []);
        }
        return json(404, { message: `unexpected ${url.pathname}` });
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

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (_event: string, listener: unknown) => {
            h.state.appStateListener = listener;
            return { remove: vi.fn() };
        }),
    },
}));

const galley = vi.hoisted(() => ({ live: false }));

vi.mock('../services/vessel/sharedBinders', async () => {
    const actual = await vi.importActual<typeof import('../services/vessel/sharedBinders')>(
        '../services/vessel/sharedBinders',
    );
    return {
        refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
        binderWriteGranted: () => true,
        anySkipperGrantsWrite: () => false,
        TABLE_REGISTER: {
            inventory_items: 'stores',
            equipment_register: 'equipment',
            maintenance_tasks: 'maintenance',
            maintenance_history: 'maintenance',
            ship_documents: 'documents',
            // The galley's tables (2026-10-03).
            recipes: 'galley',
            meal_plans: 'galley',
            shopping_list: 'galley',
        },
        binderRegisterForRow: actual.binderRegisterForRow,
        isGalleyShareLive: () => galley.live,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => [],
    markSyncing: vi.fn(async () => undefined),
    removeSynced: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    retryFailed: vi.fn(async () => undefined),
    getSyncMeta: () => ({ ...h.state.meta }),
    updateSyncMeta: vi.fn(async (updates: Record<string, string | null>) => {
        Object.assign(h.state.meta, updates);
    }),
    mergePulledRecords: vi.fn(async (_table: string, rows: unknown[]) => rows.length),
    prunePulledTable: vi.fn(async (table: string, ids: ReadonlySet<string>) => {
        h.state.prunes.push({ table, ids: [...ids].sort() });
        return 0;
    }),
    getLocalDatabaseSession: () => ({ identity: 'user-1', generation: 1 }),
    isLocalDatabaseSessionCurrent: () => true,
    getById: () => null,
    bulkDelete: vi.fn(async () => undefined),
    rewriteQueuedInsert: vi.fn(async () => null),
    onOutboxAppended: () => () => undefined,
}));

type SyncModule = typeof import('../services/vessel/SyncService');
let sync: SyncModule;
let completions: { pulled: number; pruned?: number; errors: string[] }[];

const START = Date.parse('2026-10-02T02:00:00.000Z');
const LAST_PULL = '2026-10-02T01:59:00.000Z';

/** A stored session whose token has `lifeSeconds` left. */
function storeSession(lifeSeconds: number): void {
    const expiresAt = Math.floor(Date.now() / 1000) + lifeSeconds;
    h.state.userToken = [
        base64Url({ alg: 'HS256', typ: 'JWT' }),
        base64Url({ sub: 'user-1', role: 'authenticated', aud: 'authenticated', exp: expiresAt }),
        'test-signature',
    ].join('.');
    h.state.storage.set(
        'test-auth',
        JSON.stringify({
            access_token: h.state.userToken,
            refresh_token: 'refresh-test-token',
            token_type: 'bearer',
            expires_in: lifeSeconds,
            expires_at: expiresAt,
            user: {
                id: 'user-1',
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            },
        }),
    );
}

/** Advance fake time until `count` cycles have completed (auth retries sleep in it). */
async function untilCycles(count: number): Promise<void> {
    for (let step = 0; step < 2000 && completions.length < count; step += 1) {
        await vi.advanceTimersByTimeAsync(1000);
    }
    expect(completions).toHaveLength(count);
}

const binderListings = () => h.state.restLog.filter((entry) => entry.select === 'id');

beforeEach(async () => {
    galley.live = false;
    vi.useFakeTimers({
        now: START,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    h.state.storage.clear();
    h.state.serverIds.clear();
    h.state.clockJumpOnWatermark = 0;
    h.state.tokenEndpointDown = false;
    h.state.rejectUserToken = false;
    h.state.restLog = [];
    h.state.prunes = [];
    h.state.meta = {
        lastPullTimestamp: LAST_PULL,
        lastFullPullTimestamp: LAST_PULL,
        lastPushTimestamp: null,
        deviceId: 'test-device',
        ownerUserId: 'user-1',
    };
    // 100 s left: outside auth-js's 90 s margin when the cycle starts.
    storeSession(100);
    sync = await import('../services/vessel/SyncService');
    completions = [];
    sync.onSyncComplete((result) => completions.push(result));
});

afterEach(() => {
    sync.stopSyncEngine();
    vi.useRealTimers();
});

describe('the binder sweep never reads the server as anon', () => {
    it('a token refresh failing mid-cycle prunes nothing, sends nothing as anon, and keeps the watermark', async () => {
        sync.startSyncEngine();
        await untilCycles(1); // the boot cycle, healthy
        const pulledUpTo = h.state.meta.lastPullTimestamp;
        h.state.serverIds.set('inventory_items', ['stores-1', 'stores-2']);

        // The catch-up's watermark RPC takes 15 s: the token now has under
        // 90 s left, and the refresh it triggers meets a 503 every time.
        h.state.tokenEndpointDown = true;
        h.state.clockJumpOnWatermark = 15_000;
        h.state.restLog = [];
        sync.requestCatchUpSync();
        await untilCycles(2);

        // Nothing went out with the anon key, so RLS never answered "empty".
        expect(h.state.restLog.filter((entry) => entry.bearer !== 'USER')).toEqual([]);
        // Nothing was pruned from any binder.
        expect(h.state.prunes).toEqual([]);
        // The cycle failed loudly, and the pull is replayed, not skipped.
        expect(completions[1].errors.length).toBeGreaterThan(0);
        expect(h.state.meta.lastPullTimestamp).toBe(pulledUpTo);
    });

    it('the sweep is still owed: the next healthy cycle lists with the user token and prunes then', async () => {
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.tokenEndpointDown = true;
        h.state.clockJumpOnWatermark = 15_000;
        sync.requestCatchUpSync();
        await untilCycles(2);
        expect(h.state.prunes).toEqual([]);

        // Signed in again with a fresh token (the refresh came good).
        storeSession(3600);
        h.state.tokenEndpointDown = false;
        h.state.serverIds.set('inventory_items', ['stores-1']);
        h.state.restLog = [];
        sync.requestCatchUpSync();
        await untilCycles(3);

        expect(binderListings().map((entry) => entry.table)).toEqual(BINDER_TABLES);
        expect(binderListings().every((entry) => entry.bearer === 'USER')).toBe(true);
        expect(h.state.prunes).toContainEqual({ table: 'inventory_items', ids: ['stores-1'] });
    });

    it('a healthy catch-up lists every binder with the user token and prunes against what it lists', async () => {
        storeSession(3600);
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.serverIds.set('maintenance_tasks', ['task-a', 'task-b']);
        h.state.restLog = [];

        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(binderListings().map((entry) => entry.table)).toEqual(BINDER_TABLES);
        expect(h.state.restLog.every((entry) => entry.bearer === 'USER')).toBe(true);
        expect(h.state.prunes).toContainEqual({ table: 'maintenance_tasks', ids: ['task-a', 'task-b'] });
        expect(completions[1].errors).toEqual([]);
    });

    it('a token the server rejects (401) fails the listing: nothing is pruned', async () => {
        storeSession(3600);
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.rejectUserToken = true;

        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(binderListings().length).toBeGreaterThan(0);
        expect(h.state.prunes).toEqual([]);
    });
});

describe('the galley tables (2026-10-03) join the sweep only once the server can share a galley', () => {
    it('before the galley migration is pushed, a catch-up lists exactly the binder tables it always did', async () => {
        storeSession(3600);
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.restLog = [];

        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(binderListings().map((entry) => entry.table)).toEqual(BINDER_TABLES);
        expect(completions[1].errors).toEqual([]);
    });

    it('once it is, recipes, meal plans and the grocery list are swept too, with the user token', async () => {
        galley.live = true;
        storeSession(3600);
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.serverIds.set('shopping_list', ['grocery-1']);
        h.state.restLog = [];

        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(binderListings().map((entry) => entry.table)).toEqual([
            ...BINDER_TABLES,
            'recipes',
            'meal_plans',
            'shopping_list',
        ]);
        expect(binderListings().every((entry) => entry.bearer === 'USER')).toBe(true);
        expect(h.state.prunes).toContainEqual({ table: 'shopping_list', ids: ['grocery-1'] });
        expect(completions[1].errors).toEqual([]);
    });
});
