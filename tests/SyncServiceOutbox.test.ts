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
    };

    return {
        state,
        from: vi.fn(),
        rpc: vi.fn(),
        getUser: vi.fn(),
        storageUpload: vi.fn(async () => ({ error: null as { message: string } | null })),
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
    };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        from: harness.from,
        rpc: harness.rpc,
        auth: {
            getUser: harness.getUser,
        },
        storage: {
            from: vi.fn(() => ({
                upload: harness.storageUpload,
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
        harness.storageUpload.mockResolvedValue({ error: null });
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
        expect(harness.storageUpload).toHaveBeenLastCalledWith(
            'user-1/documents/document-1.pdf',
            expect.any(Blob),
            expect.objectContaining({ contentType: 'application/pdf', upsert: true }),
        );
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
        // One pull for each configured table, not one set per caller.
        expect(harness.from).toHaveBeenCalledTimes(12);
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
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(12);
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
        expect(harness.prunePulledTable).toHaveBeenCalledTimes(12);
    });
});
