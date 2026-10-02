import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueueItem {
    id: string;
    table_name: string;
    record_id: string;
    mutation_type: 'INSERT' | 'UPDATE' | 'DELETE' | 'DELTA';
    payload: string;
    created_at: string;
    status: 'pending' | 'syncing' | 'failed';
    retry_count: number;
    error_message?: string;
    owner_user_id: string | null;
}

const harness = vi.hoisted(() => {
    const state = {
        queue: [] as QueueItem[],
        meta: {
            lastPullTimestamp: null as string | null,
            lastPushTimestamp: null as string | null,
            lastFullPullTimestamp: null as string | null,
            deviceId: 'test-device',
            ownerUserId: 'user-1',
        },
        events: [] as string[],
        updatePayloads: [] as Record<string, unknown>[],
        upsertPayloads: [] as Record<string, unknown>[],
        upsertOptions: [] as Record<string, unknown>[],
        missingUpdates: new Set<string>(),
        pullErrors: new Map<string, string>(),
        pullRows: new Map<string, Record<string, unknown>[]>(),
        pullGate: null as Promise<void> | null,
        gatedPullUsed: false,
        sessionCurrent: true,
        visibleRows: new Set<string>(),
        deniedDeletes: new Set<string>(),
        storageEntries: [] as string[],
        /** The local mirror, as getById sees it: `${table}:${id}` → row. */
        localRows: new Map<string, Record<string, unknown>>(),
    };

    return {
        state,
        from: vi.fn(),
        rpc: vi.fn(),
        getUser: vi.fn(),
        storageUpload: vi.fn(async () => ({ error: null as { message: string } | null })),
        storageList: vi.fn(),
        storageRemove: vi.fn(),
        storageSign: vi.fn(async () => ({
            data: { signedUrl: 'https://storage.test/signed-file' } as { signedUrl: string } | null,
            error: null as { message: string } | null,
        })),
        markSyncing: vi.fn(async (ids: string[]) => {
            state.queue = state.queue.map((item) =>
                ids.includes(item.id) ? { ...item, status: 'syncing' as const } : item,
            );
        }),
        removeSynced: vi.fn(async (ids: string[]) => {
            state.queue = state.queue.filter((item) => !ids.includes(item.id));
        }),
        markFailed: vi.fn(async (ids: string[], error: string) => {
            state.queue = state.queue.map((item) =>
                ids.includes(item.id)
                    ? {
                          ...item,
                          status: 'failed' as const,
                          retry_count: item.retry_count + 1,
                          error_message: error,
                      }
                    : item,
            );
        }),
        retryFailed: vi.fn(async () => {
            state.queue = state.queue.map((item) =>
                item.status === 'failed' ? { ...item, status: 'pending' as const, error_message: undefined } : item,
            );
        }),
        updateSyncMeta: vi.fn(async (updates: Record<string, string | null>) => {
            Object.assign(state.meta, updates);
        }),
        mergePulledRecords: vi.fn(async (_table: string, records: Record<string, unknown>[]) => records.length),
        prunePulledTable: vi.fn(async () => 0),
        bulkDelete: vi.fn(async (table: string, ids: string[]) => {
            for (const id of ids) state.localRows.delete(`${table}:${id}`);
        }),
        // Shared binders (2026-10-02): the per-cycle share snapshot.
        refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
        binderWriteGranted: vi.fn((_register: string, _ownerId: string) => true),
        anySkipperGrantsWrite: vi.fn((_register: string) => false),
        rewriteQueuedInsert: vi.fn(async (queueItemId: string, changes: Record<string, unknown>) => {
            const index = state.queue.findIndex((item) => item.id === queueItemId && item.mutation_type === 'INSERT');
            if (index < 0) return null;
            const item = state.queue[index];
            const rewritten = {
                ...item,
                payload: JSON.stringify({ ...JSON.parse(item.payload), ...changes }),
            };
            state.queue[index] = rewritten;
            const key = `${item.table_name}:${item.record_id}`;
            const row = state.localRows.get(key);
            if (row) state.localRows.set(key, { ...row, ...changes });
            return { ...rewritten };
        }),
    };
});

vi.mock('../services/vessel/sharedBinders', () => ({
    refreshSharedBinders: harness.refreshSharedBinders,
    binderWriteGranted: harness.binderWriteGranted,
    anySkipperGrantsWrite: harness.anySkipperGrantsWrite,
    TABLE_REGISTER: {
        inventory_items: 'stores',
        equipment_register: 'equipment',
        maintenance_tasks: 'maintenance',
        maintenance_history: 'maintenance',
        ship_documents: 'documents',
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: harness.from,
        rpc: harness.rpc,
        auth: {
            getUser: harness.getUser,
            // Every pull pins the signed-in user's token (review 2026-10-02).
            getSession: vi.fn(async () => ({
                data: { session: { access_token: 'token-user-1', user: { id: 'user-1' } } },
                error: null,
            })),
        },
        storage: {
            from: vi.fn(() => ({
                upload: harness.storageUpload,
                list: harness.storageList,
                remove: harness.storageRemove,
                createSignedUrl: harness.storageSign,
            })),
        },
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => harness.state.queue.map((item) => ({ ...item })),
    markSyncing: harness.markSyncing,
    removeSynced: harness.removeSynced,
    markFailed: harness.markFailed,
    retryFailed: harness.retryFailed,
    getSyncMeta: () => ({ ...harness.state.meta }),
    updateSyncMeta: harness.updateSyncMeta,
    mergePulledRecords: harness.mergePulledRecords,
    prunePulledTable: harness.prunePulledTable,
    getLocalDatabaseSession: () => ({ identity: 'user-1', generation: 1 }),
    isLocalDatabaseSessionCurrent: () => harness.state.sessionCurrent,
    getById: (table: string, id: string) => harness.state.localRows.get(`${table}:${id}`) ?? null,
    bulkDelete: harness.bulkDelete,
    rewriteQueuedInsert: harness.rewriteQueuedInsert,
}));

function queued(
    id: string,
    recordId: string,
    mutationType: QueueItem['mutation_type'],
    payload: Record<string, unknown>,
): QueueItem {
    return {
        id,
        table_name: 'inventory_items',
        record_id: recordId,
        mutation_type: mutationType,
        payload: JSON.stringify(payload),
        created_at: `2026-07-23T10:00:0${id.length}.000Z`,
        status: 'pending',
        retry_count: 0,
        owner_user_id: 'user-1',
    };
}

function makeQueryBuilder(table: string) {
    let mode: 'pull' | 'lookup' | 'update' | 'delete' = 'pull';
    let recordId = '';
    let cursor: { updatedAt: string; id: string } | null = null;

    const result = () => {
        if (mode === 'pull') {
            const error = harness.state.pullErrors.get(table);
            const rows = [...(harness.state.pullRows.get(table) ?? [])]
                .sort((a, b) => {
                    const timeOrder = String(a.updated_at).localeCompare(String(b.updated_at));
                    return timeOrder || String(a.id).localeCompare(String(b.id));
                })
                .filter((row) => {
                    if (!cursor) return true;
                    const updatedAt = String(row.updated_at);
                    return (
                        updatedAt > cursor.updatedAt || (updatedAt === cursor.updatedAt && String(row.id) > cursor.id)
                    );
                });
            return {
                data: error ? null : rows,
                error: error ? { message: error } : null,
            };
        }
        return { data: null, error: null };
    };

    const builder = {
        select: vi.fn((columns: string) => {
            if (mode === 'pull' && columns === 'id') mode = 'lookup';
            return builder;
        }),
        setHeader: vi.fn(() => builder),
        gt: vi.fn(() => builder),
        lte: vi.fn(() => builder),
        order: vi.fn(() => builder),
        or: vi.fn((filter: string) => {
            const match = filter.match(/^updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/);
            if (match) cursor = { updatedAt: match[1], id: match[3] };
            return builder;
        }),
        limit: vi.fn(async (count: number) => {
            if (harness.state.pullGate && !harness.state.gatedPullUsed) {
                harness.state.gatedPullUsed = true;
                await harness.state.pullGate;
            }
            const page = result();
            return {
                ...page,
                data: page.data?.slice(0, count) ?? null,
            };
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
            mode = 'update';
            harness.state.events.push(`update:${table}`);
            harness.state.updatePayloads.push(payload);
            return builder;
        }),
        delete: vi.fn(() => {
            mode = 'delete';
            harness.state.events.push(`delete:${table}`);
            return builder;
        }),
        eq: vi.fn((_column: string, value: string) => {
            recordId = value;
            return builder;
        }),
        maybeSingle: vi.fn(async () => ({
            data:
                mode === 'update'
                    ? harness.state.missingUpdates.has(recordId)
                        ? null
                        : { id: recordId }
                    : mode === 'lookup'
                      ? harness.state.visibleRows.has(recordId)
                          ? { id: recordId }
                          : null
                      : mode === 'delete'
                        ? harness.state.visibleRows.has(recordId) && !harness.state.deniedDeletes.has(recordId)
                            ? (harness.state.visibleRows.delete(recordId), { id: recordId })
                            : null
                        : null,
            error: null,
        })),
        upsert: vi.fn(async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
            harness.state.events.push(`insert:${table}`);
            harness.state.upsertPayloads.push(payload);
            harness.state.upsertOptions.push(options);
            return { data: null, error: null };
        }),
        then: (
            onFulfilled?: (value: { data: null; error: null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
    };
    return builder;
}

async function loadSyncService() {
    return import('../services/vessel/SyncService');
}

describe('SyncService durable outbox', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.state.queue = [];
        harness.state.meta = {
            lastPullTimestamp: null,
            lastPushTimestamp: null,
            lastFullPullTimestamp: null,
            deviceId: 'test-device',
            ownerUserId: 'user-1',
        };
        harness.state.events = [];
        harness.state.updatePayloads = [];
        harness.state.upsertPayloads = [];
        harness.state.upsertOptions = [];
        harness.state.missingUpdates.clear();
        harness.state.pullErrors.clear();
        harness.state.pullRows.clear();
        harness.state.pullGate = null;
        harness.state.gatedPullUsed = false;
        harness.state.sessionCurrent = true;
        harness.state.visibleRows.clear();
        harness.state.deniedDeletes.clear();
        harness.state.storageEntries = [];
        harness.state.localRows.clear();
        harness.refreshSharedBinders.mockReset();
        harness.refreshSharedBinders.mockResolvedValue({ changed: false, fresh: true });
        harness.binderWriteGranted.mockReset();
        harness.binderWriteGranted.mockReturnValue(true);
        harness.anySkipperGrantsWrite.mockReset();
        harness.anySkipperGrantsWrite.mockReturnValue(false);
        // mockReset before mockResolvedValue: clearAllMocks() above resets call
        // records but does NOT drain a mockResolvedValueOnce queue, and a once
        // value that a run never consumed would silently satisfy the FIRST
        // upload of the next test. Only mockReset clears the queue.
        harness.storageUpload.mockReset();
        harness.storageUpload.mockResolvedValue({ error: null });
        harness.storageList.mockReset();
        harness.storageList.mockImplementation(
            async (_directory: string, options: { limit?: number; offset?: number } = {}) => {
                const offset = options.offset ?? 0;
                const limit = options.limit ?? 100;
                return {
                    data: harness.state.storageEntries.slice(offset, offset + limit).map((name) => ({ name })),
                    error: null,
                };
            },
        );
        harness.storageRemove.mockReset();
        harness.storageRemove.mockImplementation(async (paths: string[]) => {
            const removedNames = new Set(paths.map((path) => path.split('/').pop()));
            harness.state.storageEntries = harness.state.storageEntries.filter((name) => !removedNames.has(name));
            return { data: paths, error: null };
        });
        harness.storageSign.mockResolvedValue({
            data: { signedUrl: 'https://storage.test/signed-file' },
            error: null,
        });
        harness.from.mockImplementation((table: string) => makeQueryBuilder(table));
        harness.rpc.mockImplementation(async (name: string) =>
            name === 'get_sync_watermark'
                ? { data: '2026-07-23T12:00:00.000Z', error: null }
                : { data: 3, error: null },
        );
        harness.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    });

    it('pushes an INSERT before its dependent UPDATE', async () => {
        harness.state.queue = [
            queued('insert-op', 'stores-1', 'INSERT', {
                id: 'stores-1',
                item_name: 'Water',
                quantity: 2,
            }),
            queued('update-op', 'stores-1', 'UPDATE', {
                id: 'stores-1',
                user_id: '',
                created_at: '2026-07-23T09:00:00.000Z',
                item_name: 'Fresh water',
                quantity: 2,
            }),
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(2);
        expect(harness.state.events.slice(0, 2)).toEqual(['insert:inventory_items', 'update:inventory_items']);
        expect(harness.from.mock.results[0]?.value.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'stores-1', user_id: 'user-1' }),
            { onConflict: 'id', ignoreDuplicates: true },
        );
        expect(harness.state.updatePayloads[0]).toEqual({
            item_name: 'Fresh water',
            quantity: 2,
        });
        expect(harness.state.queue).toEqual([]);
    });

    it('preserves an explicit shared-register row owner while binding the outbox actor separately', async () => {
        harness.state.queue = [
            {
                ...queued('shared-owner-insert', 'shared-row', 'INSERT', {
                    id: 'shared-row',
                    user_id: 'skipper-owner',
                    item_name: 'Shared stores row',
                    quantity: 2,
                }),
                owner_user_id: 'user-1',
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.state.upsertPayloads[0]).toMatchObject({
            id: 'shared-row',
            user_id: 'skipper-owner',
        });
        expect(harness.state.queue).toEqual([]);
    });

    it('treats a zero-row UPDATE as failure and does not run its dependent delta', async () => {
        harness.state.queue = [
            queued('missing-update', 'stores-2', 'UPDATE', {
                id: 'stores-2',
                quantity: 4,
            }),
            queued('blocked-delta', 'stores-2', 'DELTA', {
                id: 'stores-2',
                field: 'quantity',
                delta: -1,
            }),
            queued('independent-insert', 'stores-3', 'INSERT', {
                id: 'stores-3',
                item_name: 'Rice',
                quantity: 1,
            }),
        ];
        harness.state.missingUpdates.add('stores-2');

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(result.errors[0]).toContain('Record not found or update not authorized');
        expect(harness.rpc.mock.calls.some(([name]) => name === 'apply_inventory_quantity_delta')).toBe(false);
        expect(harness.state.queue).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'missing-update', status: 'failed' }),
                expect.objectContaining({ id: 'blocked-delta', status: 'pending' }),
            ]),
        );

        const nextCycle = await syncNow();
        expect(nextCycle.errors[0]).toContain('Record not found or update not authorized');
        expect(harness.rpc.mock.calls.some(([name]) => name === 'apply_inventory_quantity_delta')).toBe(false);
        expect(harness.state.queue).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'missing-update', status: 'failed' }),
                expect.objectContaining({ id: 'blocked-delta', status: 'pending' }),
            ]),
        );
    });

    it('rejects a corrupted queue entry instead of writing to an arbitrary table', async () => {
        harness.state.queue = [
            {
                ...queued('bad-table', 'row-1', 'DELETE', { id: 'row-1' }),
                table_name: 'private_secrets',
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toContain('Unsupported sync table');
        expect(harness.from).not.toHaveBeenCalledWith('private_secrets');
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed' });
    });

    it('retains and fails a queue entry with an unknown runtime mutation type', async () => {
        harness.state.queue = [
            {
                ...queued('bad-mutation', 'row-1', 'DELETE', { id: 'row-1' }),
                mutation_type: 'UPSERT' as QueueItem['mutation_type'],
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toContain('Unsupported mutation type: UPSERT');
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', id: 'bad-mutation' });
        expect(harness.state.events).not.toContain('delete:inventory_items');
        expect(harness.state.upsertPayloads).toEqual([]);
    });

    it('retries a delta with the same operation UUID', async () => {
        harness.state.queue = [
            queued('delta-operation-id', 'stores-4', 'DELTA', {
                id: 'stores-4',
                field: 'quantity',
                delta: -1.5,
            }),
        ];
        harness.rpc
            .mockResolvedValueOnce({ data: null, error: { message: 'connection lost after commit' } })
            .mockResolvedValueOnce({ data: 2.5, error: null });

        const { syncNow } = await loadSyncService();
        const first = await syncNow();
        expect(first.pushed).toBe(0);
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', retry_count: 1 });

        const second = await syncNow();

        expect(second.pushed).toBe(1);
        const deltaCalls = harness.rpc.mock.calls.filter(([name]) => name === 'apply_inventory_quantity_delta');
        expect(deltaCalls).toHaveLength(2);
        expect(deltaCalls[0]).toEqual([
            'apply_inventory_quantity_delta',
            {
                p_operation_id: 'delta-operation-id',
                p_inventory_item_id: 'stores-4',
                p_delta: -1.5,
            },
        ]);
        expect(deltaCalls[1]).toEqual([
            'apply_inventory_quantity_delta',
            {
                p_operation_id: 'delta-operation-id',
                p_inventory_item_id: 'stores-4',
                p_delta: -1.5,
            },
        ]);
        expect(harness.retryFailed).toHaveBeenCalledTimes(2);
    });

    it('keeps an attachment mutation queued until its file has a durable cloud URL', async () => {
        harness.state.queue = [
            {
                ...queued('document-insert', 'document-1', 'INSERT', {
                    id: 'document-1',
                    document_name: 'Registration',
                    file_uri: 'data:application/pdf;base64,SGVsbG8=',
                    created_at: '2099-01-01T00:00:00.000Z',
                    updated_at: '2099-01-01T00:00:00.000Z',
                }),
                table_name: 'ship_documents',
            },
        ];
        harness.storageUpload.mockResolvedValueOnce({
            error: { message: 'upload unavailable' },
        });

        const { syncNow } = await loadSyncService();
        const failed = await syncNow();

        expect(failed.pushed).toBe(0);
        expect(failed.errors[0]).toContain('File upload failed');
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', retry_count: 1 });
        expect(harness.state.upsertPayloads).toEqual([]);

        const retried = await syncNow();
        expect(retried.pushed).toBe(1);
        // NOT expect.any(Blob). Two Blob constructors exist under vitest —
        // Node's (node:buffer) and jsdom's — and `any` does an instanceof
        // against whichever this file resolved. SyncService builds a Node Blob,
        // so the check passed locally and failed in CI on a realm mismatch, with
        // the diff showing a perfectly good Blob "not matching" Any<Blob>.
        // Assert the properties that actually matter instead; they hold in
        // either realm.
        const lastUpload = harness.storageUpload.mock.calls.at(-1) as unknown as [
            string,
            { size: number; type: string },
            { contentType: string; upsert: boolean },
        ];
        expect(lastUpload, 'storage upload was never called').toBeDefined();
        const [uploadPath, uploadBody, uploadOpts] = lastUpload;
        expect(uploadPath).toBe('user-1/documents/document-1.pdf');
        expect(uploadBody.type).toBe('application/pdf');
        expect(uploadBody.size).toBeGreaterThan(0);
        expect(uploadOpts).toMatchObject({ contentType: 'application/pdf', upsert: true });
        expect(harness.state.upsertPayloads[0]).toMatchObject({
            id: 'document-1',
            user_id: 'user-1',
            file_uri: 'supabase-storage://vessel_vault/user-1/documents/document-1.pdf',
        });
        expect(harness.storageSign).not.toHaveBeenCalled();
        expect(harness.state.upsertPayloads[0]).not.toHaveProperty('created_at');
        expect(harness.state.upsertPayloads[0]).not.toHaveProperty('updated_at');
        expect(harness.state.queue).toEqual([]);
    });

    it('removes a displaced attachment extension only after the replacement row is durable', async () => {
        harness.state.queue = [
            {
                ...queued('document-replace', 'document-1', 'UPDATE', {
                    id: 'document-1',
                    file_uri: 'data:image/png;base64,iVBORw0KGgo=',
                }),
                table_name: 'ship_documents',
            },
        ];
        harness.state.storageEntries = ['document-1.pdf', 'document-1.png', 'document-10.pdf'];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.state.events).toContain('update:ship_documents');
        expect(harness.state.updatePayloads[0]).toMatchObject({
            file_uri: 'supabase-storage://vessel_vault/user-1/documents/document-1.png',
        });
        expect(harness.storageRemove).toHaveBeenCalledWith(['user-1/documents/document-1.pdf']);
        expect(harness.state.storageEntries).toEqual(['document-1.png', 'document-10.pdf']);
        expect(harness.state.queue).toEqual([]);
    });

    it('safely resumes an operation left syncing by an interrupted attempt', async () => {
        harness.state.queue = [
            {
                ...queued('interrupted-delta', 'stores-5', 'DELTA', {
                    id: 'stores-5',
                    field: 'quantity',
                    delta: 2,
                }),
                status: 'syncing',
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.rpc).toHaveBeenCalledWith('apply_inventory_quantity_delta', {
            p_operation_id: 'interrupted-delta',
            p_inventory_item_id: 'stores-5',
            p_delta: 2,
        });
        expect(harness.state.queue).toEqual([]);
    });

    it('returns the same in-flight sync promise to concurrent callers', async () => {
        let releasePull!: () => void;
        harness.state.pullGate = new Promise<void>((resolve) => {
            releasePull = resolve;
        });

        const { syncNow } = await loadSyncService();
        const first = syncNow();
        const second = syncNow();

        expect(second).toBe(first);
        releasePull();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(secondResult).toBe(firstResult);
        // One pull for each configured table (13 with vessel_engine_hours), not one set per caller.
        expect(harness.from).toHaveBeenCalledTimes(13);
    });

    it('does not advance the shared pull watermark after a partial table failure', async () => {
        harness.state.pullErrors.set('maintenance_tasks', 'temporary upstream error');
        harness.state.pullRows.set('inventory_items', [{ id: 'server-row', updated_at: '2026-07-23T11:00:00.000Z' }]);

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pulled).toBe(1);
        expect(result.errors).toContain('maintenance_tasks: temporary upstream error');
        expect(harness.updateSyncMeta).not.toHaveBeenCalledWith(
            expect.objectContaining({ lastPullTimestamp: expect.any(String) }),
        );
        expect(harness.state.meta.lastPullTimestamp).toBeNull();
    });

    it('pulls every page before advancing the server-time watermark', async () => {
        harness.state.pullRows.set(
            'inventory_items',
            Array.from({ length: 501 }, (_, index) => ({
                id: `server-row-${String(index).padStart(3, '0')}`,
                updated_at: '2026-07-23T11:00:00.000Z',
            })),
        );

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pulled).toBe(501);
        expect(harness.mergePulledRecords).toHaveBeenCalledTimes(2);
        expect(harness.mergePulledRecords.mock.calls[0][1]).toHaveLength(500);
        expect(harness.mergePulledRecords.mock.calls[1][1]).toHaveLength(1);
        const inventoryBuilders = harness.from.mock.results
            .filter((_, index) => harness.from.mock.calls[index]?.[0] === 'inventory_items')
            .map((result) => result.value);
        expect(inventoryBuilders[1].or).toHaveBeenCalledWith(
            expect.stringContaining('updated_at.eq.2026-07-23T11:00:00.000Z'),
        );
        expect(harness.state.meta.lastPullTimestamp).toBe('2026-07-23T12:00:00.000Z');
    });

    it('never pushes an outbox mutation owned by another account', async () => {
        harness.state.queue = [
            {
                ...queued('account-a-op', 'stores-private', 'INSERT', {
                    id: 'stores-private',
                    item_name: 'Account A private item',
                }),
                owner_user_id: 'account-a',
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(0);
        expect(result.errors).toContain(
            'inventory_items/stores-private: Outbox mutation belongs to a different authenticated identity',
        );
        expect(harness.state.upsertPayloads).toEqual([]);
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', owner_user_id: 'account-a' });
    });

    it('does not touch the outbox when auth no longer matches the loaded identity', async () => {
        harness.state.queue = [
            queued('identity-mismatch', 'stores-private', 'DELETE', {
                id: 'stores-private',
            }),
        ];
        harness.getUser.mockResolvedValue({ data: { user: { id: 'account-b' } }, error: null });

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(0);
        expect(result.errors).toContain('Authenticated user does not match the local database identity');
        expect(harness.markSyncing).not.toHaveBeenCalled();
        expect(harness.state.queue[0]).toMatchObject({ status: 'pending', owner_user_id: 'user-1' });
    });

    it('retains a visible row DELETE when row policy denies the mutation', async () => {
        harness.state.queue = [
            queued('denied-delete', 'stores-protected', 'DELETE', {
                id: 'stores-protected',
            }),
        ];
        harness.state.visibleRows.add('stores-protected');
        harness.state.deniedDeletes.add('stores-protected');

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toContain('Record is visible but delete is not authorized');
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', id: 'denied-delete' });
        expect(harness.state.visibleRows.has('stores-protected')).toBe(true);
    });

    it('treats an already-absent DELETE as idempotent success', async () => {
        harness.state.queue = [
            queued('absent-delete', 'stores-gone', 'DELETE', {
                id: 'stores-gone',
            }),
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.state.queue).toEqual([]);
        expect(harness.state.events).not.toContain('delete:inventory_items');
    });

    it('deletes every deterministic document extension without touching a neighbouring record', async () => {
        harness.state.queue = [
            {
                ...queued('document-delete', 'document-1', 'DELETE', { id: 'document-1' }),
                table_name: 'ship_documents',
            },
        ];
        harness.state.visibleRows.add('document-1');
        harness.state.storageEntries = ['document-1.pdf', 'document-1.jpg', 'document-10.pdf', 'other.pdf'];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.state.events).toContain('delete:ship_documents');
        expect(harness.storageList).toHaveBeenCalledWith('user-1/documents', { limit: 100, offset: 0 });
        expect(harness.storageRemove).toHaveBeenCalledWith([
            'user-1/documents/document-1.pdf',
            'user-1/documents/document-1.jpg',
        ]);
        expect(harness.state.storageEntries).toEqual(['document-10.pdf', 'other.pdf']);
        expect(harness.state.queue).toEqual([]);
    });

    it('uses the owner equipment folder when deleting manual variants', async () => {
        harness.state.queue = [
            {
                ...queued('equipment-delete', 'engine-1', 'DELETE', { id: 'engine-1' }),
                table_name: 'equipment_register',
            },
        ];
        harness.state.storageEntries = ['engine-1.pdf', 'engine-1.docx'];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.storageList).toHaveBeenCalledWith('user-1/equipment', { limit: 100, offset: 0 });
        expect(harness.storageRemove).toHaveBeenCalledWith([
            'user-1/equipment/engine-1.pdf',
            'user-1/equipment/engine-1.docx',
        ]);
        expect(harness.state.queue).toEqual([]);
    });

    it('keeps an already-absent document DELETE queued when listing Storage fails', async () => {
        harness.state.queue = [
            {
                ...queued('document-list-retry', 'document-gone', 'DELETE', { id: 'document-gone' }),
                table_name: 'ship_documents',
            },
        ];
        harness.storageList.mockResolvedValueOnce({ data: null, error: { message: 'list unavailable' } });

        const { syncNow } = await loadSyncService();
        const first = await syncNow();

        expect(first.pushed).toBe(0);
        expect(first.errors[0]).toContain('Attachment cleanup list failed: list unavailable');
        expect(harness.state.events).not.toContain('delete:ship_documents');
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', retry_count: 1 });

        const retried = await syncNow();
        expect(retried.pushed).toBe(1);
        expect(harness.state.queue).toEqual([]);
    });

    it('retries Storage removal after the document row was already deleted', async () => {
        harness.state.queue = [
            {
                ...queued('document-remove-retry', 'document-2', 'DELETE', { id: 'document-2' }),
                table_name: 'ship_documents',
            },
        ];
        harness.state.visibleRows.add('document-2');
        harness.state.storageEntries = ['document-2.pdf'];
        harness.storageRemove.mockResolvedValueOnce({ data: null, error: { message: 'remove unavailable' } });

        const { syncNow } = await loadSyncService();
        const first = await syncNow();

        expect(first.pushed).toBe(0);
        expect(first.errors[0]).toContain('Attachment cleanup failed: remove unavailable');
        expect(harness.state.visibleRows.has('document-2')).toBe(false);
        expect(harness.state.storageEntries).toEqual(['document-2.pdf']);
        expect(harness.state.queue[0]).toMatchObject({ status: 'failed', retry_count: 1 });

        const retried = await syncNow();
        expect(retried.pushed).toBe(1);
        expect(harness.state.storageEntries).toEqual([]);
        expect(harness.state.queue).toEqual([]);
    });

    it('retries failed idempotent operations beyond the old five-attempt terminal fence', async () => {
        harness.state.queue = [
            {
                ...queued('long-retry', 'stores-retry', 'INSERT', {
                    id: 'stores-retry',
                    item_name: 'Still durable',
                }),
                status: 'failed',
                retry_count: 9,
                error_message: 'temporary outage',
            },
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.state.queue).toEqual([]);
    });

    it('forces an authoritative pull when visibility expands', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:30:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:30:00.000Z';
        harness.state.pullRows.set('inventory_items', [
            { id: 'older-shared-row', updated_at: '2026-07-22T08:00:00.000Z' },
        ]);

        const { requestFullReconciliation } = await loadSyncService();
        const result = await requestFullReconciliation();

        expect(result.pulled).toBe(1);
        const inventoryBuilder = harness.from.mock.results.find(
            (_, index) => harness.from.mock.calls[index]?.[0] === 'inventory_items',
        )?.value;
        expect(inventoryBuilder.gt).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00.000Z');
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(13);
        expect(harness.state.meta.lastFullPullTimestamp).toBe('2026-07-23T12:00:00.000Z');
    });

    it('replays an overlap on incremental pulls so late commits are not stranded', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:30:00.000Z';

        const { syncNow } = await loadSyncService();
        await syncNow();

        const inventoryBuilder = harness.from.mock.results.find(
            (_, index) => harness.from.mock.calls[index]?.[0] === 'inventory_items',
        )?.value;
        expect(inventoryBuilder.gt).toHaveBeenCalledWith('updated_at', '2026-07-23T10:55:00.000Z');
        expect(harness.prunePulledTable).not.toHaveBeenCalled();
    });

    it('periodically runs a full snapshot as a backstop for arbitrarily late commits', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-22T00:00:00.000Z';

        const { syncNow } = await loadSyncService();
        await syncNow();

        const inventoryBuilder = harness.from.mock.results.find(
            (_, index) => harness.from.mock.calls[index]?.[0] === 'inventory_items',
        )?.value;
        expect(inventoryBuilder.gt).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00.000Z');
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(13);
    });

    // ── Shared binders (2026-10-02) ─────────────────────────────────────

    function pullSince(table = 'inventory_items'): unknown {
        const builder = harness.from.mock.results.find(
            (_, index) =>
                harness.from.mock.calls[index]?.[0] === table &&
                harness.from.mock.results[index]?.value.gt.mock.calls.length,
        )?.value;
        return builder?.gt.mock.calls[0]?.[1];
    }

    it('refreshes the share snapshot before pushing, and a changed share forces a full pull (A6/A7)', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.state.queue = [queued('insert-op', 'stores-1', 'INSERT', { id: 'stores-1', item_name: 'Water' })];
        harness.refreshSharedBinders.mockImplementation(async () => {
            // Before the push: nothing has reached the server yet.
            expect(harness.state.events).toEqual([]);
            return { changed: true, fresh: true };
        });

        const { syncNow, isFullReconciliationPending } = await loadSyncService();
        const result = await syncNow();

        expect(result.errors).toEqual([]);
        expect(harness.refreshSharedBinders).toHaveBeenCalledTimes(1);
        expect(pullSince()).toBe('1970-01-01T00:00:00.000Z');
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(13);
        expect(isFullReconciliationPending()).toBe(false);
    });

    it('an unchanged share keeps the incremental pull', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';

        const { syncNow } = await loadSyncService();
        await syncNow();

        expect(pullSince()).toBe('2026-07-23T11:54:00.000Z');
        expect(harness.prunePulledTable).not.toHaveBeenCalled();
    });

    it('a failed forced pull keeps the reconciliation pending, and the next cycle retries it', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.refreshSharedBinders.mockResolvedValueOnce({ changed: true, fresh: true });
        harness.state.pullErrors.set('ship_documents', 'network');

        const { syncNow, isFullReconciliationPending } = await loadSyncService();
        await syncNow();
        expect(isFullReconciliationPending()).toBe(true);

        harness.state.pullErrors.clear();
        harness.from.mockClear();
        await syncNow();
        expect(pullSince()).toBe('1970-01-01T00:00:00.000Z');
        expect(isFullReconciliationPending()).toBe(false);
    });

    it('a failed snapshot fetch keeps the cache: no forced pull and no discards (A8)', async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.refreshSharedBinders.mockRejectedValue(new Error('vessel_crew unreachable'));
        harness.binderWriteGranted.mockReturnValue(false);
        harness.state.localRows.set('inventory_items:stores-s', { id: 'stores-s', user_id: 'skipper-1' });
        harness.state.queue = [queued('update-s', 'stores-s', 'UPDATE', { item_name: 'Rice' })];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.discardedShared).toBe(0);
        expect(harness.bulkDelete).not.toHaveBeenCalled();
        expect(harness.state.events).toContain('update:inventory_items');
        expect(pullSince()).toBe('2026-07-23T11:54:00.000Z');
    });

    it("drops a queued change to a skipper's row once a fresh snapshot shows the share ended (A13)", async () => {
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.binderWriteGranted.mockImplementation((_register: string, ownerId: string) => ownerId !== 'skipper-1');
        // Another skipper still takes stores adds: crew_rewrite_user_id would
        // move a self-stamped add onto THEIR boat, so the add is dropped.
        harness.anySkipperGrantsWrite.mockReturnValue(true);
        harness.state.localRows.set('inventory_items:stores-s', { id: 'stores-s', user_id: 'skipper-1' });
        harness.state.localRows.set('inventory_items:stores-new', { id: 'stores-new', user_id: 'skipper-1' });
        harness.state.localRows.set('inventory_items:stores-own', { id: 'stores-own', user_id: 'user-1' });
        harness.state.queue = [
            queued('update-s', 'stores-s', 'UPDATE', { item_name: 'Rice' }),
            queued('delta-s', 'stores-s', 'DELTA', { id: 'stores-s', field: 'quantity', delta: -1 }),
            queued('insert-gone', 'stores-new', 'INSERT', { id: 'stores-new', user_id: 'skipper-1', item_name: 'Tea' }),
            queued('update-own', 'stores-own', 'UPDATE', { item_name: 'Mine' }),
        ];
        harness.state.missingUpdates.add('stores-own');

        const { syncNow, isFullReconciliationPending } = await loadSyncService();
        const result = await syncNow();

        expect(result.discardedShared).toBe(3);
        expect(result.rehomedShared).toBe(0);
        expect(result.sharedOwnerIds).toEqual(['skipper-1']);
        // The add never reached the server: its local row goes. The edited
        // row stays, and a full pull brings the server's copy back.
        expect(harness.bulkDelete).toHaveBeenCalledTimes(1);
        expect(harness.bulkDelete).toHaveBeenCalledWith('inventory_items', ['stores-new']);
        expect(harness.state.localRows.has('inventory_items:stores-new')).toBe(false);
        expect(harness.state.localRows.has('inventory_items:stores-s')).toBe(true);
        expect(harness.state.localRows.has('inventory_items:stores-own')).toBe(true);
        expect(pullSince()).toBe('1970-01-01T00:00:00.000Z');
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(13);
        expect(isFullReconciliationPending()).toBe(false);
        // Nothing for the skipper's rows reached the server.
        expect(harness.state.upsertPayloads).toEqual([]);
        expect(harness.rpc).not.toHaveBeenCalledWith('apply_inventory_quantity_delta', expect.anything());
        // The sailor's own failing change is kept, failed, for a retry.
        expect(harness.state.queue.map((item) => [item.id, item.status])).toEqual([['update-own', 'failed']]);
    });

    it("keeps a view-only skipper row a dropped DELTA touched, and pulls the server's copy back", async () => {
        // A deckhand (stores view only) completed a shared-voyage meal: the
        // DELTA on the skipper's Rice can never be pushed. The row must not
        // vanish from their view-only Ship's Stores until some later launch.
        harness.state.meta.lastPullTimestamp = '2026-07-23T11:59:00.000Z';
        harness.state.meta.lastFullPullTimestamp = '2026-07-23T11:00:00.000Z';
        harness.binderWriteGranted.mockImplementation((_register: string, ownerId: string) => ownerId !== 'skipper-1');
        harness.state.localRows.set('inventory_items:stores-s', { id: 'stores-s', user_id: 'skipper-1', quantity: 1 });
        harness.state.queue = [
            queued('delta-s', 'stores-s', 'DELTA', { id: 'stores-s', field: 'quantity', delta: -1 }),
        ];

        const { syncNow, isFullReconciliationPending } = await loadSyncService();
        const result = await syncNow();

        expect(result.errors).toEqual([]);
        expect(result.discardedShared).toBe(1);
        expect(harness.bulkDelete).not.toHaveBeenCalled();
        expect(harness.state.localRows.has('inventory_items:stores-s')).toBe(true);
        expect(harness.rpc).not.toHaveBeenCalledWith('apply_inventory_quantity_delta', expect.anything());
        expect(pullSince()).toBe('1970-01-01T00:00:00.000Z');
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(13);
        expect(isFullReconciliationPending()).toBe(false);
        expect(harness.state.queue).toEqual([]);
    });

    it("moves the sailor's own adds into their own binder when no skipper can take them", async () => {
        harness.binderWriteGranted.mockImplementation((_register: string, ownerId: string) => ownerId !== 'skipper-1');
        harness.anySkipperGrantsWrite.mockReturnValue(false);
        harness.state.localRows.set('inventory_items:stores-new', { id: 'stores-new', user_id: 'skipper-1' });
        harness.state.queue = [
            queued('insert-new', 'stores-new', 'INSERT', { id: 'stores-new', user_id: 'skipper-1', item_name: 'Tea' }),
            queued('update-new', 'stores-new', 'UPDATE', { item_name: 'Green tea' }),
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.errors).toEqual([]);
        expect(result.rehomedShared).toBe(1);
        expect(result.discardedShared).toBe(0);
        expect(result.sharedOwnerIds).toEqual(['skipper-1']);
        expect(result.pushed).toBe(2);
        expect(harness.state.upsertPayloads).toEqual([
            expect.objectContaining({ id: 'stores-new', user_id: 'user-1', item_name: 'Tea' }),
        ]);
        expect(harness.state.events).toContain('update:inventory_items');
        expect(harness.state.localRows.get('inventory_items:stores-new')).toMatchObject({ user_id: 'user-1' });
        expect(harness.bulkDelete).not.toHaveBeenCalled();
        expect(harness.state.queue).toEqual([]);
    });

    it('a service log moves only with its task, and a foreign attachment reference is not carried over', async () => {
        harness.binderWriteGranted.mockImplementation((_register: string, ownerId: string) => ownerId !== 'skipper-1');
        harness.anySkipperGrantsWrite.mockReturnValue(false);
        harness.state.localRows.set('maintenance_tasks:task-new', { id: 'task-new', user_id: 'skipper-1' });
        harness.state.localRows.set('maintenance_tasks:task-old', { id: 'task-old', user_id: 'skipper-1' });
        harness.state.localRows.set('maintenance_history:log-new', { id: 'log-new', user_id: 'skipper-1' });
        harness.state.localRows.set('maintenance_history:log-old', { id: 'log-old', user_id: 'skipper-1' });
        harness.state.localRows.set('ship_documents:doc-new', { id: 'doc-new', user_id: 'skipper-1' });
        const entry = (table: string, id: string, recordId: string, payload: Record<string, unknown>) => ({
            ...queued(id, recordId, 'INSERT', payload),
            table_name: table,
        });
        harness.state.queue = [
            entry('maintenance_tasks', 'i-task', 'task-new', { id: 'task-new', user_id: 'skipper-1', title: 'Oil' }),
            entry('maintenance_history', 'i-log-new', 'log-new', {
                id: 'log-new',
                user_id: 'skipper-1',
                task_id: 'task-new',
            }),
            // Logged against a task that stays the skipper's: it cannot follow.
            entry('maintenance_history', 'i-log-old', 'log-old', {
                id: 'log-old',
                user_id: 'skipper-1',
                task_id: 'task-old',
            }),
            entry('ship_documents', 'i-doc', 'doc-new', {
                id: 'doc-new',
                user_id: 'skipper-1',
                document_name: 'Rego',
                file_uri: 'supabase-storage://vessel_vault/skipper-1/documents/rego.pdf',
            }),
        ];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.rehomedShared).toBe(3);
        expect(result.discardedShared).toBe(1);
        expect(harness.bulkDelete).toHaveBeenCalledWith('maintenance_history', ['log-old']);
        expect(harness.state.upsertPayloads).toEqual([
            expect.objectContaining({ id: 'task-new', user_id: 'user-1' }),
            expect.objectContaining({ id: 'log-new', user_id: 'user-1', task_id: 'task-new' }),
            expect.objectContaining({ id: 'doc-new', user_id: 'user-1', file_uri: null }),
        ]);
    });

    it("never drops a skipper's queued change while the share still grants write", async () => {
        harness.binderWriteGranted.mockReturnValue(true);
        harness.state.localRows.set('inventory_items:stores-s', { id: 'stores-s', user_id: 'skipper-1' });
        harness.state.queue = [queued('update-s', 'stores-s', 'UPDATE', { item_name: 'Rice' })];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.discardedShared).toBe(0);
        expect(result.pushed).toBe(1);
        expect(harness.binderWriteGranted).toHaveBeenCalledWith('stores', 'skipper-1');
    });

    it("pushes an add to a skipper's binder with the skipper's user_id, never the crew's (A3)", async () => {
        harness.state.localRows.set('maintenance_tasks:task-new', { id: 'task-new', user_id: 'skipper-1' });
        harness.state.queue = [
            {
                ...queued('insert-task', 'task-new', 'INSERT', { id: 'task-new', user_id: 'skipper-1', title: 'Oil' }),
                table_name: 'maintenance_tasks',
            },
        ];

        const { syncNow } = await loadSyncService();
        await syncNow();

        expect(harness.state.upsertPayloads).toEqual([
            expect.objectContaining({ id: 'task-new', user_id: 'skipper-1' }),
        ]);
    });

    it("does not tidy the crew's own vault folder when the crew edits a skipper's document", async () => {
        harness.state.localRows.set('ship_documents:document-s', { id: 'document-s', user_id: 'skipper-1' });
        harness.state.queue = [
            {
                ...queued('doc-edit', 'document-s', 'UPDATE', {
                    document_name: 'Rego',
                    file_uri: 'supabase-storage://vessel_vault/skipper-1/documents/document-s.pdf',
                }),
                table_name: 'ship_documents',
            },
        ];
        harness.state.storageEntries = ['document-s.png'];

        const { syncNow } = await loadSyncService();
        const result = await syncNow();

        expect(result.pushed).toBe(1);
        expect(harness.storageList).not.toHaveBeenCalled();
        expect(harness.storageRemove).not.toHaveBeenCalled();
    });
});
