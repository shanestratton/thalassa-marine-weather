/**
 * Engine hours sync like a binder table, and an app build that reaches a
 * phone before its migration is pushed must behave exactly as before
 * (2026-10-02). While PostgREST answers "no such table" (PGRST205: it is
 * not in the schema cache) the table is skipped quietly: no sync error, the
 * other tables' watermark advances, nothing is pruned, no collapse is held,
 * and a queued change waits unmarked. A Postgres 42P01 can only come from
 * inside the database once the table is there (a policy or trigger reading a
 * relation that drifted away), so it is a real error.
 * No real accounts: 'user-1', 'skipper-1'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface QueueItem {
    id: string;
    table_name: string;
    record_id: string;
    mutation_type: 'INSERT' | 'UPDATE' | 'DELETE' | 'DELTA';
    payload: string;
    created_at: string;
    status: 'pending' | 'syncing' | 'failed';
    retry_count: number;
    owner_user_id: string | null;
}

const WATERMARK = '2026-10-02T02:00:00.000Z';
const TABLE = 'vessel_engine_hours';
const PGRST205 = {
    code: 'PGRST205',
    message: "Could not find the table 'public.vessel_engine_hours' in the schema cache",
};
const PG_42P01 = { code: '42P01', message: 'relation "public.vessel_engine_hours" does not exist' };

const h = vi.hoisted(() => ({
    state: {
        queue: [] as QueueItem[],
        meta: {} as Record<string, unknown>,
        upserts: [] as { table: string; row: Record<string, unknown> }[],
        serverRows: new Map<string, Record<string, unknown>[]>(),
        serverIds: new Map<string, string[]>(),
        /** table → the error the server answers every request with */
        missing: new Map<string, { code: string; message: string }>(),
        pullSince: [] as { table: string; since: string }[],
        writeGranted: (_owner: string): boolean => true,
    },
    rpc: vi.fn(),
    getUser: vi.fn(),
    getSession: vi.fn(),
    prunePulledTable: vi.fn(async (_table: string, _ids: Set<string>, _options?: unknown) => 0),
    mergePulledRecords: vi.fn(async (_table: string, rows: unknown[], _options?: unknown) => rows.length),
    markFailed: vi.fn(async (_ids: string[], _message: string) => undefined),
    removeSynced: vi.fn(),
    bulkDelete: vi.fn(async (_table: string, _ids: string[]) => undefined),
    idListings: [] as string[],
    carryOver: vi.fn(async () => false),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/vessel/sharedBinders', () => ({
    refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
    binderWriteGranted: (_register: string, owner: string) => h.state.writeGranted(owner),
    anySkipperGrantsWrite: () => false,
    TABLE_REGISTER: {
        inventory_items: 'stores',
        equipment_register: 'equipment',
        maintenance_tasks: 'maintenance',
        maintenance_history: 'maintenance',
        vessel_engine_hours: 'maintenance',
        ship_documents: 'documents',
    },
}));

vi.mock('../services/vessel/LocalEngineHoursService', () => ({
    LocalEngineHoursService: { carryOverDeviceReading: h.carryOver },
}));

function builder(table: string) {
    let columns = '*';
    let after: string | null = null;
    const missing = () => h.state.missing.get(table) ?? null;
    const api = {
        select: vi.fn((selected: string) => {
            columns = selected;
            return api;
        }),
        setHeader: vi.fn(() => api),
        gt: vi.fn((column: string, value: string) => {
            if (column === 'id') after = value;
            if (column === 'updated_at') h.state.pullSince.push({ table, since: value });
            return api;
        }),
        lte: vi.fn(() => api),
        order: vi.fn(() => api),
        or: vi.fn(() => api),
        eq: vi.fn(() => api),
        limit: vi.fn(async (count: number) => {
            if (missing()) return { data: null, error: missing() };
            if (columns === 'id') {
                h.idListings.push(table);
                const ids = (h.state.serverIds.get(table) ?? []).filter((id) => after === null || id > after);
                return { data: ids.slice(0, count).map((id) => ({ id })), error: null };
            }
            return { data: (h.state.serverRows.get(table) ?? []).slice(0, count), error: null };
        }),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
            if (missing()) return { data: null, error: missing() };
            h.state.upserts.push({ table, row });
            return { data: null, error: null };
        }),
    };
    return api;
}

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => builder(table),
        rpc: h.rpc,
        auth: { getUser: h.getUser, getSession: h.getSession },
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => h.state.queue.map((item) => ({ ...item })),
    markSyncing: vi.fn(async (ids: string[]) => {
        h.state.queue = h.state.queue.map((item) => (ids.includes(item.id) ? { ...item, status: 'syncing' } : item));
    }),
    removeSynced: h.removeSynced,
    markFailed: h.markFailed,
    retryFailed: vi.fn(async () => undefined),
    getSyncMeta: () => ({ ...h.state.meta }),
    updateSyncMeta: vi.fn(async (updates: Record<string, unknown>) => {
        Object.assign(h.state.meta, updates);
    }),
    mergePulledRecords: h.mergePulledRecords,
    prunePulledTable: h.prunePulledTable,
    getLocalDatabaseSession: () => ({ identity: 'user-1', generation: 1 }),
    isLocalDatabaseSessionCurrent: () => true,
    getById: () => null,
    bulkDelete: h.bulkDelete,
    rewriteQueuedInsert: vi.fn(async () => null),
    onOutboxAppended: () => () => undefined,
}));

type SyncModule = typeof import('../services/vessel/SyncService');
let sync: SyncModule;

function queueInsert(table: string, recordId: string, row: Record<string, unknown>): void {
    h.state.queue.push({
        id: `op-${h.state.queue.length + 1}`,
        table_name: table,
        record_id: recordId,
        mutation_type: 'INSERT',
        payload: JSON.stringify({ id: recordId, ...row }),
        created_at: '2026-10-02T01:00:00.000Z',
        status: 'pending',
        retry_count: 0,
        owner_user_id: 'user-1',
    });
}

const prunedTables = () => h.prunePulledTable.mock.calls.map(([table]) => table);
const sinceFor = (table: string) => h.state.pullSince.filter((entry) => entry.table === table).map((e) => e.since);
const watermarkReads = () => h.rpc.mock.calls.filter(([name]) => name === 'get_sync_watermark').length;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    h.state.queue = [];
    // Incremental by default: a full pull ran a minute ago.
    h.state.meta = {
        lastPullTimestamp: '2026-10-02T01:59:00.000Z',
        lastFullPullTimestamp: '2026-10-02T01:59:00.000Z',
        lastPushTimestamp: null,
        deviceId: 'test-device',
        ownerUserId: 'user-1',
    };
    h.state.upserts = [];
    h.state.serverRows.clear();
    h.state.serverIds.clear();
    h.state.missing.clear();
    h.state.pullSince = [];
    h.state.writeGranted = () => true;
    h.idListings.length = 0;
    h.removeSynced.mockImplementation(async (ids: string[]) => {
        h.state.queue = h.state.queue.filter((item) => !ids.includes(item.id));
    });
    h.prunePulledTable.mockReset().mockResolvedValue(0);
    h.mergePulledRecords.mockReset().mockImplementation(async (_table: string, rows: unknown[]) => rows.length);
    h.rpc
        .mockReset()
        .mockImplementation(async (name: string) =>
            name === 'get_sync_watermark' ? { data: WATERMARK, error: null } : { data: null, error: null },
        );
    h.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.getSession.mockReset().mockResolvedValue({
        data: { session: { access_token: 'token-user-1', user: { id: 'user-1' } } },
        error: null,
    });
    sync = await import('../services/vessel/SyncService');
});

afterEach(() => {
    sync.stopSyncEngine();
});

describe('before the migration is pushed (the server has no vessel_engine_hours)', () => {
    it('PGRST205: the pull skips it quietly, the watermark advances for the other tables, nothing is pruned', async () => {
        h.state.missing.set(TABLE, PGRST205);

        const result = await sync.syncNow();

        expect(result.errors).toEqual([]);
        expect(sync.getSyncStatus()).toBe('idle');
        expect(h.state.meta.lastPullTimestamp).toBe(WATERMARK);
        expect(prunedTables()).not.toContain(TABLE);
        expect(h.state.meta.optionalTablesReadAt).toBeUndefined();
        expect(h.carryOver).not.toHaveBeenCalled();
    });

    it('PGRST205 on a full reconciliation: no error, no prune, no held collapse and no second read', async () => {
        h.state.missing.set(TABLE, PGRST205);
        h.state.meta.lastPullTimestamp = null; // a full snapshot

        const result = await sync.syncNow();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.errors).toEqual([]);
        expect(h.state.meta.lastFullPullTimestamp).toBe(WATERMARK);
        expect(prunedTables()).toContain('maintenance_tasks');
        expect(prunedTables()).not.toContain(TABLE);
        expect(sync.isFullReconciliationPending()).toBe(false);
        expect(watermarkReads()).toBe(1);
    });

    it('the deletion sweep passes it by too, and is not left owing', async () => {
        vi.useFakeTimers();
        try {
            h.state.missing.set(TABLE, PGRST205);
            sync.startSyncEngine();
            await vi.advanceTimersByTimeAsync(2000); // the boot cycle
            h.idListings.length = 0;

            sync.requestCatchUpSync();
            await vi.advanceTimersByTimeAsync(1500);
            expect(watermarkReads()).toBe(2);
            expect(h.idListings).toContain('maintenance_tasks');
            expect(h.idListings).not.toContain(TABLE);

            // A plain cycle afterwards does not sweep again: nothing was owed.
            h.idListings.length = 0;
            const result = await sync.syncNow();
            expect(result.errors).toEqual([]);
            expect(h.idListings).toEqual([]);
        } finally {
            sync.stopSyncEngine();
            vi.useRealTimers();
        }
    });

    it('a change queued for it waits, unmarked and not an error, while the other tables push', async () => {
        h.state.missing.set(TABLE, PGRST205);
        queueInsert(TABLE, 'hours-row', { user_id: 'user-1', hours: 1250 });
        queueInsert('inventory_items', 'stores-1', { user_id: 'user-1', item_name: 'Rice' });

        const result = await sync.syncNow();

        expect(result.errors).toEqual([]);
        expect(result.pushed).toBe(1);
        expect(h.markFailed).not.toHaveBeenCalled();
        expect(h.state.upserts.map((upsert) => upsert.table)).toEqual(['inventory_items']);
        expect(h.state.queue.map((item) => item.table_name)).toEqual([TABLE]);

        // Pushed once the table is there.
        h.state.missing.clear();
        const later = await sync.syncNow();
        expect(later.errors).toEqual([]);
        expect(h.state.upserts.map((upsert) => upsert.table)).toEqual(['inventory_items', TABLE]);
        expect(h.state.queue).toEqual([]);
    });
});

describe('once the server has the table', () => {
    it('the first read is a full one, is recorded, and the next one is incremental', async () => {
        const row = { id: 'hours-row', user_id: 'user-1', hours: 1250, updated_at: '2026-10-01T09:00:00.000Z' };
        h.state.serverRows.set(TABLE, [row]);

        const first = await sync.syncNow();
        expect(first.errors).toEqual([]);
        expect(sinceFor(TABLE)).toEqual(['1970-01-01T00:00:00.000Z']);
        expect(sinceFor('maintenance_tasks')).toEqual(['2026-10-02T01:54:00.000Z']);
        expect(h.mergePulledRecords).toHaveBeenCalledWith(TABLE, [row], { until: WATERMARK });
        // An incremental cycle: the first read prunes nothing.
        expect(prunedTables()).not.toContain(TABLE);
        expect(h.state.meta.optionalTablesReadAt).toEqual({ [TABLE]: WATERMARK });
        expect(h.carryOver).toHaveBeenCalledTimes(1);

        h.state.pullSince = [];
        h.state.meta.lastPullTimestamp = WATERMARK;
        await sync.syncNow();
        expect(sinceFor(TABLE)).toEqual(['2026-10-02T01:55:00.000Z']);
    });

    it('a table that goes missing again is no longer live here', async () => {
        h.state.meta.optionalTablesReadAt = { [TABLE]: '2026-10-01T00:00:00.000Z' };
        h.state.missing.set(TABLE, PGRST205);

        const result = await sync.syncNow();
        expect(result.errors).toEqual([]);
        expect(h.state.meta.optionalTablesReadAt).toEqual({});
        expect(h.carryOver).not.toHaveBeenCalled();
    });

    it('42P01 from inside the database is a real error: the pull reports it and holds the watermark', async () => {
        // e.g. the write fence's account_deletion_jobs or the policy's
        // vessel_crew dropped by drift: PostgREST found the table itself.
        h.state.meta.optionalTablesReadAt = { [TABLE]: '2026-10-01T00:00:00.000Z' };
        h.state.missing.set(TABLE, PG_42P01);

        const result = await sync.syncNow();

        expect(result.errors).toEqual([`${TABLE}: ${PG_42P01.message}`]);
        expect(sync.getSyncStatus()).toBe('error');
        expect(h.state.meta.lastPullTimestamp).toBe('2026-10-02T01:59:00.000Z');
        // Still live here: the table is there, something inside it is not.
        expect(h.state.meta.optionalTablesReadAt).toEqual({ [TABLE]: '2026-10-01T00:00:00.000Z' });
    });

    it('a push that meets 42P01 is marked failed and reported, never left waiting in silence', async () => {
        h.state.meta.optionalTablesReadAt = { [TABLE]: '2026-10-01T00:00:00.000Z' };
        h.state.missing.set(TABLE, PG_42P01);
        queueInsert(TABLE, 'hours-row', { user_id: 'user-1', hours: 1250 });

        const result = await sync.syncNow();

        expect(result.errors).toContain(`${TABLE}/hours-row: ${PG_42P01.message}`);
        expect(h.markFailed).toHaveBeenCalledWith(['op-1'], PG_42P01.message);
    });

    it('a real failure on the table is still an error, and holds the watermark as for any table', async () => {
        h.state.missing.set(TABLE, { code: '57014', message: 'canceling statement due to statement timeout' });
        const result = await sync.syncNow();
        expect(result.errors).toEqual([`${TABLE}: canceling statement due to statement timeout`]);
        expect(h.state.meta.lastPullTimestamp).toBe('2026-10-02T01:59:00.000Z');
    });

    it('a queued add to a skipper’s reading whose share ended is dropped, never moved into the sailor’s own binder', async () => {
        h.state.writeGranted = (owner) => owner !== 'skipper-1';
        queueInsert(TABLE, 'skipper-hours', { user_id: 'skipper-1', hours: 1300 });

        const result = await sync.syncNow();

        expect(result.discardedShared).toBe(1);
        expect(result.rehomedShared).toBe(0);
        expect(h.state.upserts).toEqual([]);
        expect(h.bulkDelete).toHaveBeenCalledWith(TABLE, ['skipper-hours']);
        expect(h.state.queue).toEqual([]);
    });
});
