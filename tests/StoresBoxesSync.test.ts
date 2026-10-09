/**
 * stores_boxes syncs like a binder table, through the binders' untouchable
 * rails (126-11a): the pinned bearer and the collapse guard.
 *
 * The REAL @supabase/supabase-js client, with only fetch faked, as
 * SyncServicePinnedBearer.test.ts does. The app reaches phones before Shane
 * pushes 20261010153000_stores_boxes.sql, so:
 *   - while PostgREST answers PGRST205 ("not in the schema cache"), the table
 *     is skipped quietly: no error, no held watermark, no prune, no listing;
 *   - the first time a device finds it, it reads it in full and records that
 *     (SyncMeta.optionalTablesReadAt), which is what lets the app write boxes;
 *   - every pull and sweep page carries the signed-in user's token: a token
 *     refresh that fails mid-cycle must never fall back to anon and prune;
 *   - a sweep that would empty the boxes is held for a second read.
 *
 * No real accounts or projects: 'user-1', test.invalid URLs, fake tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TABLE = 'stores_boxes';

function base64Url(value: unknown): string {
    return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const h = vi.hoisted(() => {
    const state = {
        storage: new Map<string, string>(),
        userToken: '',
        /** table → ids the server lists for the signed-in user */
        serverIds: new Map<string, string[]>(),
        /** tables PostgREST has not got (PGRST205) */
        missing: new Set<string>(),
        clockJumpOnWatermark: 0,
        tokenEndpointDown: false,
        restLog: [] as { table: string; select: string; since: string | null; bearer: 'USER' | 'ANON' | 'OTHER' }[],
        meta: {} as Record<string, unknown>,
        /** table → the clean rows this device holds */
        local: new Map<string, string[]>(),
        prunes: [] as { table: string; removed: string[] }[],
        held: [] as string[],
    };

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const authorization = new Headers(init?.headers).get('Authorization') ?? '';
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
            state.restLog.push({ table, select, since: url.searchParams.get('updated_at'), bearer });
            if (state.missing.has(table)) {
                return json(404, {
                    code: 'PGRST205',
                    details: null,
                    hint: null,
                    message: `Could not find the table 'public.${table}' in the schema cache`,
                });
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
    App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

// The real table → register map: stores_boxes must be registered to be swept.
vi.mock('../services/vessel/sharedBinders', async () => {
    const actual = await vi.importActual<typeof import('../services/vessel/sharedBinders')>(
        '../services/vessel/sharedBinders',
    );
    return {
        refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
        binderWriteGranted: () => true,
        anySkipperGrantsWrite: () => false,
        TABLE_REGISTER: actual.TABLE_REGISTER,
        binderRegisterForRow: actual.binderRegisterForRow,
        isGalleyShareLive: () => false,
    };
});

vi.mock('../services/vessel/LocalEngineHoursService', () => ({
    LocalEngineHoursService: { carryOverDeviceReading: vi.fn(async () => false) },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => [],
    markSyncing: vi.fn(async () => undefined),
    removeSynced: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    retryFailed: vi.fn(async () => undefined),
    getSyncMeta: () => ({ ...h.state.meta }),
    updateSyncMeta: vi.fn(async (updates: Record<string, unknown>) => {
        Object.assign(h.state.meta, updates);
    }),
    mergePulledRecords: vi.fn(async (_table: string, rows: unknown[]) => rows.length),
    // The real prune's arithmetic over this device's clean rows, under the
    // caller's veto (the collapse guard).
    prunePulledTable: vi.fn(
        async (
            table: string,
            ids: ReadonlySet<string>,
            options: { allowPrune?: (plan: { visible: number; eligible: number; removing: number }) => boolean } = {},
        ) => {
            const local = h.state.local.get(table) ?? [];
            const removing = local.filter((id) => !ids.has(id));
            const plan = { visible: ids.size, eligible: local.length, removing: removing.length };
            if (options.allowPrune && !options.allowPrune(plan)) {
                if (removing.length > 0) h.state.held.push(table);
                return 0;
            }
            if (removing.length > 0) {
                h.state.local.set(
                    table,
                    local.filter((id) => ids.has(id)),
                );
                h.state.prunes.push({ table, removed: removing });
            }
            return removing.length;
        },
    ),
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

const START = Date.parse('2026-10-10T02:00:00.000Z');
const LAST_PULL = '2026-10-10T01:59:00.000Z';
const BOXES = ['0a1b2c3d-4e5f-4a6b-8c7d-000000000001', '0a1b2c3d-4e5f-4a6b-8c7d-000000000002'];

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

async function untilCycles(count: number): Promise<void> {
    for (let step = 0; step < 2000 && completions.length < count; step += 1) {
        await vi.advanceTimersByTimeAsync(1000);
    }
    expect(completions).toHaveLength(count);
}

const boxRequests = () => h.state.restLog.filter((entry) => entry.table === TABLE);
const boxListings = () => boxRequests().filter((entry) => entry.select === 'id');

beforeEach(async () => {
    vi.useFakeTimers({
        now: START,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    h.state.storage.clear();
    h.state.serverIds.clear();
    h.state.missing.clear();
    h.state.clockJumpOnWatermark = 0;
    h.state.tokenEndpointDown = false;
    h.state.restLog = [];
    h.state.local.clear();
    h.state.prunes = [];
    h.state.held = [];
    h.state.meta = {
        lastPullTimestamp: LAST_PULL,
        lastFullPullTimestamp: LAST_PULL,
        lastPushTimestamp: null,
        deviceId: 'test-device',
        ownerUserId: 'user-1',
    };
    storeSession(3600);
    sync = await import('../services/vessel/SyncService');
    completions = [];
    sync.onSyncComplete((result) => completions.push(result));
});

afterEach(() => {
    sync.stopSyncEngine();
    vi.useRealTimers();
});

describe('before the migration is pushed (PGRST205 on stores_boxes)', () => {
    it('is skipped quietly: no error, the watermark advances, nothing is listed or pruned, nothing is live', async () => {
        h.state.missing.add(TABLE);
        h.state.local.set(TABLE, [...BOXES]);
        sync.startSyncEngine();
        await untilCycles(1);
        sync.requestCatchUpSync(); // a sweep cycle
        await untilCycles(2);

        expect(completions.map((result) => result.errors)).toEqual([[], []]);
        expect(h.state.meta.lastPullTimestamp).not.toBe(LAST_PULL);
        expect(boxRequests().length).toBeGreaterThan(0); // it was asked for
        expect(boxListings()).toEqual([]); // and never swept
        expect(h.state.prunes.filter((p) => p.table === TABLE)).toEqual([]);
        expect(h.state.held).toEqual([]);
        expect((h.state.meta.optionalTablesReadAt as Record<string, string> | undefined)?.[TABLE]).toBeUndefined();
        // The other binders swept as ever.
        expect(h.state.restLog.some((entry) => entry.table === 'inventory_items' && entry.select === 'id')).toBe(true);
    });
});

describe('once the server has it', () => {
    it('is read in full the first time, recorded, then read incrementally and swept with the binders', async () => {
        sync.startSyncEngine();
        await untilCycles(1);

        const first = boxRequests().filter((entry) => entry.select === '*');
        expect(first.map((entry) => entry.since)).toEqual(['gt.1970-01-01T00:00:00.000Z']);
        const items = h.state.restLog.filter((entry) => entry.table === 'inventory_items' && entry.select === '*');
        expect(items[0].since).not.toBe('gt.1970-01-01T00:00:00.000Z');
        expect((h.state.meta.optionalTablesReadAt as Record<string, string>)[TABLE]).toEqual(expect.any(String));
        // Boxes are pulled before the items that point at them.
        const order = h.state.restLog.filter((entry) => entry.select === '*').map((entry) => entry.table);
        expect(order.indexOf(TABLE)).toBeLessThan(order.indexOf('inventory_items'));

        h.state.restLog = [];
        sync.requestCatchUpSync();
        await untilCycles(2);
        expect(boxRequests().filter((entry) => entry.select === '*')[0].since).not.toBe('gt.1970-01-01T00:00:00.000Z');
        expect(boxListings()).toHaveLength(1);
        expect(completions[1].errors).toEqual([]);
    });

    it('every pull and sweep page carries the user token, never anon', async () => {
        sync.startSyncEngine();
        await untilCycles(1);
        h.state.serverIds.set(TABLE, [BOXES[0]]);
        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(boxRequests().length).toBeGreaterThan(1);
        expect(boxRequests().every((entry) => entry.bearer === 'USER')).toBe(true);
    });

    it('a token refresh failing mid-cycle sends nothing as anon and prunes no box', async () => {
        storeSession(100); // outside auth-js's 90 s margin when the cycle starts
        h.state.local.set(TABLE, [...BOXES]);
        h.state.serverIds.set(TABLE, [...BOXES]);
        sync.startSyncEngine();
        await untilCycles(1);

        // The catch-up's watermark RPC takes 15 s: the token now has under
        // 90 s left, and the refresh it triggers meets a 503 every time.
        h.state.tokenEndpointDown = true;
        h.state.clockJumpOnWatermark = 15_000;
        h.state.restLog = [];
        sync.requestCatchUpSync();
        await untilCycles(2);

        expect(h.state.restLog.filter((entry) => entry.bearer !== 'USER')).toEqual([]);
        expect(h.state.prunes).toEqual([]);
        expect(h.state.local.get(TABLE)).toEqual(BOXES);
        expect(completions[1].errors.length).toBeGreaterThan(0);
    });

    it('a sweep that would empty the boxes is held for a second read', async () => {
        h.state.meta.optionalTablesReadAt = { [TABLE]: LAST_PULL };
        h.state.local.set(TABLE, [...BOXES]);
        sync.startSyncEngine();
        await untilCycles(1);

        // The server lists no boxes at all: one reading never empties a table.
        // The catch-up's sweep holds them and asks for a full read straight
        // after; only that second, agreeing read (its own cycle and token)
        // lets them go.
        h.state.serverIds.set(TABLE, []);
        let localAfterFirstRead: string[] | undefined;
        h.state.held = [];
        const prune = vi.mocked((await import('../services/vessel/LocalDatabase')).prunePulledTable);
        const real = prune.getMockImplementation()!;
        prune.mockImplementation(async (table, ids, options) => {
            const removed = await real(table, ids, options);
            if (table === TABLE && localAfterFirstRead === undefined) localAfterFirstRead = h.state.local.get(TABLE);
            return removed;
        });
        sync.requestCatchUpSync();
        for (let step = 0; step < 2000 && completions.length < 3; step += 1) {
            await vi.advanceTimersByTimeAsync(1000);
        }

        expect(h.state.held).toEqual([TABLE]);
        expect(localAfterFirstRead).toEqual(BOXES);
        expect(completions.length).toBeGreaterThanOrEqual(3);
        expect(h.state.prunes.filter((p) => p.table === TABLE)).toEqual([{ table: TABLE, removed: BOXES }]);
    });
});
