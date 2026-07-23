/**
 * Tests for the rewritten syncOfflineQueue — the upload half of local-first
 * capture. The previous implementation inserted raw camelCase objects with
 * no user_id (every batch rejected, queue never drained); these tests pin
 * down the fixed contract: snake_case mapping, user stamping, id stripping,
 * chunking, partial-failure retention, and rolling-waypoint normalisation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- In-memory Preferences ----
const store: Record<string, string> = {};
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: store[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete store[key];
        }),
    },
}));

// ---- Supabase mock: capture idempotent upserts, controllable failure ----
const insertCalls: Record<string, unknown>[][] = [];
let failOnInsertCall = -1; // index of insert call to fail (-1 = never)
const upsertOptions: Record<string, unknown>[] = [];
interface MockUploadError {
    message: string;
    code?: string;
    status?: number;
}
let pendingUpsertResult: Promise<{ error: MockUploadError | null; status?: number }> | null = null;
let permanentPoisonOperationId: string | null = null;
let permanentPoisonErrorCode: string | undefined = '22007';
let permanentPoisonHttpStatus: number | undefined;
let uploadAbortCount = 0;
const mockUpsert = vi.fn(async (rows: Record<string, unknown>[], options?: Record<string, unknown>) => {
    const callIdx = insertCalls.length;
    insertCalls.push(rows);
    upsertOptions.push(options ?? {});
    if (callIdx === failOnInsertCall) return { error: { message: 'boom' } };
    if (pendingUpsertResult) return pendingUpsertResult;
    if (permanentPoisonOperationId && rows.some((row) => row.client_operation_id === permanentPoisonOperationId)) {
        return {
            error: { message: 'invalid row payload', code: permanentPoisonErrorCode },
            status: permanentPoisonHttpStatus,
        };
    }
    return { error: null };
});
const cloudDeleteCalls: string[][] = [];
let failCloudDelete = false;
let cloudVerificationRows: Record<string, unknown>[] = [];
let failCloudVerification = false;
let voyageSelectResults: Record<string, unknown>[][] = [];
const archiveUpdateCalls: Array<{
    table: string;
    values: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
    filters: string[];
}> = [];
let failArchiveUpdate = false;
let archiveUpdateCount = 1;

function deleteQuery(table: string) {
    const filters: string[] = [`table=${table}`];
    const result = () => ({ error: failCloudDelete ? { message: 'delete failed' } : null });
    const query = {
        eq: vi.fn((column: string, value: string) => {
            filters.push(`${column}=${value}`);
            return query;
        }),
        or: vi.fn((filter: string) => {
            filters.push(filter);
            return query;
        }),
        lte: vi.fn((column: string, value: string) => {
            filters.push(`${column}<=${value}`);
            return query;
        }),
        in: vi.fn((column: string, values: string[]) => {
            filters.push(`${column}=in.(${values.join(',')})`);
            return query;
        }),
        abortSignal: vi.fn(() => query),
        then: (
            onFulfilled: (value: { error: { message: string } | null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => {
            cloudDeleteCalls.push(filters.slice());
            return Promise.resolve(result()).then(onFulfilled, onRejected);
        },
    };
    return query;
}

function selectQuery(table: string) {
    const result = () => ({
        data: table === 'voyages' ? (voyageSelectResults.shift() ?? []) : cloudVerificationRows,
        error: failCloudVerification ? { message: 'verification failed' } : null,
    });
    const query = {
        eq: vi.fn(() => query),
        or: vi.fn(() => query),
        lte: vi.fn(() => query),
        in: vi.fn(() => query),
        abortSignal: vi.fn(() => query),
        limit: vi.fn(async () => result()),
        then: (onFulfilled: (value: ReturnType<typeof result>) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(result()).then(onFulfilled, onRejected),
    };
    return query;
}

function archiveUpdateQuery(table: string, values: Record<string, unknown>, options?: Record<string, unknown>) {
    const filters: string[] = [];
    const result = () => ({
        error: failArchiveUpdate ? { message: 'archive failed' } : null,
        count: archiveUpdateCount,
    });
    const query = {
        eq: vi.fn((column: string, value: string) => {
            filters.push(`${column}=${value}`);
            return query;
        }),
        or: vi.fn((filter: string) => {
            filters.push(filter);
            return query;
        }),
        lte: vi.fn((column: string, value: string) => {
            filters.push(`${column}<=${value}`);
            return query;
        }),
        abortSignal: vi.fn(() => query),
        then: (
            onFulfilled: (value: ReturnType<typeof result>) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => {
            archiveUpdateCalls.push({ table, values, options, filters: filters.slice() });
            return Promise.resolve(result()).then(onFulfilled, onRejected);
        },
    };
    return query;
}
let mockUser: { id: string } | null = { id: 'user-1' };

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => ({
            upsert: (rows: Record<string, unknown>[], options?: Record<string, unknown>) => {
                const result = mockUpsert(rows, options);
                const query = {
                    abortSignal: vi.fn((signal: AbortSignal) => {
                        signal.addEventListener('abort', () => {
                            uploadAbortCount++;
                        });
                        return query;
                    }),
                    then: (
                        onFulfilled: (value: { error: { message: string } | null }) => unknown,
                        onRejected?: (reason: unknown) => unknown,
                    ) => result.then(onFulfilled, onRejected),
                };
                return query;
            },
            delete: () => deleteQuery(table),
            update: (values: Record<string, unknown>, options?: Record<string, unknown>) =>
                archiveUpdateQuery(table, values, options),
            select: () => selectQuery(table),
        }),
    },
    getCurrentUser: vi.fn(async () => mockUser),
    getCurrentUserId: vi.fn(async () => mockUser?.id ?? null),
}));

vi.mock('../utils/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    queueOfflineEntry,
    syncOfflineQueue,
    getOfflineQueueCount,
    normalizeLatestPositions,
    demoteLatestPositionInQueue,
    getOfflineEntries,
    getOfflineQueueDeadLetters,
    flushOfflineQueueToDisk,
    addVoyageTombstone,
    deleteVoyageFromOfflineQueue,
    deleteEntryFromOfflineQueue,
    recreateVoyageWithFence,
    recordVoyageDeletionCascadeMetadata,
    runShipLogCloudTransaction,
    runVoyageCloudMutation,
    setVoyageArchivedInOfflineQueue,
    __resetOfflineQueueForTests,
} from '../services/shiplog/OfflineQueue';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import type { ShipLogEntry } from '../types';

const entry = (o: Partial<ShipLogEntry> = {}): Partial<ShipLogEntry> => ({
    userId: 'user-1',
    voyageId: 'v1',
    timestamp: '2026-06-01T00:00:00.000Z',
    latitude: -27.5,
    longitude: 153.0,
    entryType: 'auto',
    ...o,
});

function readPersistedQueue(queueKey: string): Record<string, unknown>[] {
    const root = JSON.parse(store[queueKey]) as
        | Record<string, unknown>[]
        | { version: number; generation: string; segment_count: number };
    if (Array.isArray(root)) return root;
    const entries: Record<string, unknown>[] = [];
    for (let index = 0; index < root.segment_count; index++) {
        entries.push(...(JSON.parse(store[`${queueKey}:v${root.version}:${root.generation}:${index}`]) as []));
    }
    return entries;
}

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    // Module-level queue cache (c516385f) — must drop it so tests that
    // seed the mocked Preferences store directly are actually re-read.
    __resetOfflineQueueForTests();
    insertCalls.length = 0;
    upsertOptions.length = 0;
    cloudDeleteCalls.length = 0;
    archiveUpdateCalls.length = 0;
    failOnInsertCall = -1;
    pendingUpsertResult = null;
    permanentPoisonOperationId = null;
    permanentPoisonErrorCode = '22007';
    permanentPoisonHttpStatus = undefined;
    uploadAbortCount = 0;
    failCloudDelete = false;
    cloudVerificationRows = [];
    failCloudVerification = false;
    failArchiveUpdate = false;
    archiveUpdateCount = 1;
    voyageSelectResults = [];
    mockUser = { id: 'user-1' };
    setAuthIdentityScope(null);
    setAuthIdentityScope('user-1');
});

describe('syncOfflineQueue (rewritten)', () => {
    it('maps entries to snake_case, stamps user_id, strips ids', async () => {
        await queueOfflineEntry(entry({ cumulativeDistanceNM: 12.5, id: 'offline_0' as string }));
        const synced = await syncOfflineQueue();

        expect(synced).toBe(1);
        const row = insertCalls[0][0];
        expect(row.user_id).toBe('user-1');
        expect(row.voyage_id).toBe('v1');
        expect(row.cumulative_distance_nm).toBe(12.5);
        expect(row.id).toBeUndefined(); // synthetic id never shipped
        expect(row.client_operation_id).toEqual(expect.any(String));
        expect(upsertOptions[0]).toMatchObject({
            onConflict: 'user_id,client_operation_id',
            ignoreDuplicates: true,
        });
        expect((row as Record<string, unknown>).voyageId).toBeUndefined(); // no camelCase leakage
        expect(await getOfflineQueueCount()).toBe(0); // queue drained
    });

    it('chunks large queues into 500-row inserts', async () => {
        const batch = Array.from({ length: 501 }, (_, i) =>
            entry({ timestamp: `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.${i}Z` }),
        );
        store['ship_log_offline_queue'] = JSON.stringify(batch);

        const synced = await syncOfflineQueue();
        expect(synced).toBe(501);
        expect(insertCalls.length).toBe(2);
        expect(insertCalls[0].length).toBe(500);
        expect(insertCalls[1].length).toBe(1);
    });

    it('keeps the unsynced remainder when a chunk fails', async () => {
        const batch = Array.from({ length: 501 }, () => entry());
        store['ship_log_offline_queue'] = JSON.stringify(batch);
        failOnInsertCall = 1; // first chunk OK, second fails

        const synced = await syncOfflineQueue();
        expect(synced).toBe(500);
        expect(await getOfflineQueueCount()).toBe(1); // remainder retained for retry
    });

    it('dead-letters one permanent poison row and continues syncing valid rows behind it', async () => {
        permanentPoisonOperationId = 'poison-operation';
        await queueOfflineEntry(entry({ notes: 'valid before' }), { operationId: 'valid-before' });
        await queueOfflineEntry(entry({ timestamp: 'not-a-timestamp', notes: 'poison' }), {
            operationId: 'poison-operation',
        });
        await queueOfflineEntry(entry({ notes: 'valid after' }), { operationId: 'valid-after' });

        await expect(syncOfflineQueue()).resolves.toBe(2);
        expect(await getOfflineQueueCount()).toBe(0);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                queueId: 'poison-operation',
                errorCode: '22007',
                errorMessage: 'invalid row payload',
                entry: expect.objectContaining({ notes: 'poison' }),
            }),
        ]);
        expect(insertCalls.some((rows) => rows.some((row) => row.client_operation_id === 'valid-after'))).toBe(true);
    });

    it('bisects an HTTP 413 response using the response status and retains the oversized row', async () => {
        permanentPoisonOperationId = 'oversized-operation';
        permanentPoisonErrorCode = undefined;
        permanentPoisonHttpStatus = 413;
        await queueOfflineEntry(entry({ notes: 'oversized payload' }), {
            operationId: 'oversized-operation',
        });
        await queueOfflineEntry(entry({ notes: 'valid after 413' }), {
            operationId: 'valid-after-413',
        });

        await expect(syncOfflineQueue()).resolves.toBe(1);
        await expect(getOfflineQueueDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                queueId: 'oversized-operation',
                errorMessage: 'invalid row payload',
            }),
        ]);
        expect(await getOfflineQueueCount()).toBe(0);
    });

    it('aborts a hung upload, releases the cloud FIFO, and retries the retained point', async () => {
        vi.useFakeTimers();
        pendingUpsertResult = new Promise(() => {
            /* intentionally never settles */
        });
        await queueOfflineEntry(entry({ notes: 'hung upload' }), { operationId: 'hung-upload-operation' });

        const firstSync = syncOfflineQueue();
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(firstSync).resolves.toBe(0);
        expect(uploadAbortCount).toBe(1);
        expect(await getOfflineQueueCount()).toBe(1);

        pendingUpsertResult = null;
        await expect(syncOfflineQueue()).resolves.toBe(1);
        expect(await getOfflineQueueCount()).toBe(0);
        vi.useRealTimers();
    });

    it('serializes a voyage archive mutation after an in-flight queue upload', async () => {
        let releaseUpsert!: (value: { error: null }) => void;
        pendingUpsertResult = new Promise((resolve) => {
            releaseUpsert = resolve;
        });
        await queueOfflineEntry(entry({ voyageId: 'archive-race' }), {
            operationId: 'archive-race-operation',
        });

        const syncing = syncOfflineQueue();
        await vi.waitFor(() => expect(insertCalls).toHaveLength(1));

        let archiveStarted = false;
        const archiveMutation = runVoyageCloudMutation('archive-race', getAuthIdentityScope(), 1000, async () => {
            archiveStarted = true;
            return { data: [{ id: 'archive-race-operation' }], error: null };
        });
        await Promise.resolve();
        expect(archiveStarted).toBe(false);

        releaseUpsert({ error: null });
        await expect(syncing).resolves.toBe(1);
        await expect(archiveMutation).resolves.toEqual({
            data: [{ id: 'archive-race-operation' }],
            error: null,
        });
        expect(archiveStarted).toBe(true);
    });

    it('persists queued archive state so later replay cannot split the voyage', async () => {
        await queueOfflineEntry(entry({ voyageId: 'archive-queued' }), {
            operationId: 'archive-queued-operation',
        });
        await setVoyageArchivedInOfflineQueue('archive-queued', true, getAuthIdentityScope());
        await queueOfflineEntry(entry({ voyageId: 'archive-queued', timestamp: '2026-06-01T00:00:01Z' }), {
            operationId: 'archive-queued-operation-2',
        });

        __resetOfflineQueueForTests();
        await expect(syncOfflineQueue()).resolves.toBe(2);
        expect(insertCalls[0]).toHaveLength(2);
        expect(insertCalls[0]).toEqual([
            expect.objectContaining({ voyage_id: 'archive-queued', archived: true }),
            expect.objectContaining({ voyage_id: 'archive-queued', archived: true }),
        ]);
    });

    it('retries a zero-row archive outbox after restart until cloud state verifies', async () => {
        const scope = getAuthIdentityScope();
        await setVoyageArchivedInOfflineQueue('archive-pending', true, scope);
        const intentKey = authScopedStorageKey('ship_log_voyage_archive_intents', scope);

        archiveUpdateCount = 0; // RLS/no-match: not proof of convergence
        await expect(syncOfflineQueue()).resolves.toBe(0);
        let intents = JSON.parse(store[intentKey]) as Record<string, Record<string, unknown>>;
        expect(intents['archive-pending'].cloud_applied_at).toBeUndefined();

        __resetOfflineQueueForTests(); // process death / cold start
        archiveUpdateCount = 1;
        await expect(syncOfflineQueue()).resolves.toBe(0);
        intents = JSON.parse(store[intentKey]) as Record<string, Record<string, unknown>>;
        expect(intents['archive-pending'].cloud_applied_at).toEqual(expect.any(Number));
        // Confirmed intents are deliberately reasserted for a bounded race
        // horizon: an aborted older PATCH may still commit late server-side.
        await expect(syncOfflineQueue()).resolves.toBe(0);
        expect(archiveUpdateCalls).toHaveLength(3);
        expect(archiveUpdateCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    values: { archived: true },
                    options: { count: 'exact' },
                    filters: expect.arrayContaining(['user_id=user-1', 'voyage_id=archive-pending']),
                }),
            ]),
        );
        expect(archiveUpdateCalls.at(-1)).toEqual(
            expect.objectContaining({
                values: { archived: true },
                options: { count: 'exact' },
                filters: expect.arrayContaining(['user_id=user-1', 'voyage_id=archive-pending']),
            }),
        );
    });

    it('reconciles a row queued after restart from the independent archive outbox', async () => {
        const scope = getAuthIdentityScope();
        await setVoyageArchivedInOfflineQueue('archive-cold-start', true, scope);
        __resetOfflineQueueForTests();

        await queueOfflineEntry(entry({ voyageId: 'archive-cold-start', archived: false }), {
            operationId: 'archive-cold-start-operation',
        });
        await expect(syncOfflineQueue()).resolves.toBe(1);
        expect(insertCalls[0][0]).toEqual(
            expect.objectContaining({
                voyage_id: 'archive-cold-start',
                archived: true,
            }),
        );
    });

    it('does not invert the cloud and entry-ledger locks during deletion retry', async () => {
        await queueOfflineEntry(entry(), { operationId: 'retry-delete-operation' });
        await deleteEntryFromOfflineQueue('offline_retry-delete-operation');

        let releaseTransaction!: () => void;
        const transactionGate = new Promise<void>((resolve) => {
            releaseTransaction = resolve;
        });
        let transactionStarted = false;
        const transaction = runShipLogCloudTransaction(getAuthIdentityScope(), async () => {
            transactionStarted = true;
            await transactionGate;
            return deleteEntryFromOfflineQueue('offline_second-delete-operation');
        });
        await vi.waitFor(() => expect(transactionStarted).toBe(true));

        const syncing = syncOfflineQueue();
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseTransaction();

        await expect(Promise.all([transaction, syncing])).resolves.toEqual([true, 0]);
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_entries', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])).toMatchObject({
            'retry-delete-operation': expect.any(Object),
            'second-delete-operation': expect.any(Object),
        });
    });

    it('returns 0 and keeps the queue when signed out', async () => {
        setAuthIdentityScope(null);
        mockUser = null;
        await queueOfflineEntry(entry());
        const synced = await syncOfflineQueue();
        expect(synced).toBe(0);
        expect(insertCalls.length).toBe(0);
        expect(await getOfflineQueueCount()).toBe(1);
    });

    it('isolates durable queues across A → B → A and uploads only the captured owner', async () => {
        setAuthIdentityScope('account-a');
        mockUser = { id: 'account-a' };
        await queueOfflineEntry(entry({ voyageId: 'voyage-a' }));
        await flushOfflineQueueToDisk();
        const accountAKey = authScopedStorageKey('ship_log_offline_queue', getAuthIdentityScope());

        setAuthIdentityScope('account-b');
        mockUser = { id: 'account-b' };
        await queueOfflineEntry(entry({ voyageId: 'voyage-b' }));
        await flushOfflineQueueToDisk();
        const accountBKey = authScopedStorageKey('ship_log_offline_queue', getAuthIdentityScope());
        expect(await getOfflineQueueCount()).toBe(1);

        setAuthIdentityScope('account-a');
        mockUser = { id: 'account-a' };
        expect(await getOfflineQueueCount()).toBe(1);
        expect(await syncOfflineQueue()).toBe(1);
        expect(insertCalls[0][0]).toMatchObject({
            user_id: 'account-a',
            voyage_id: 'voyage-a',
        });
        expect(store[accountAKey]).toBeUndefined();
        expect(readPersistedQueue(accountBKey)).toMatchObject([
            {
                owner_user_id: 'account-b',
                voyageId: 'voyage-b',
            },
        ]);

        insertCalls.length = 0;
        setAuthIdentityScope('account-b');
        mockUser = { id: 'account-b' };
        expect(await syncOfflineQueue()).toBe(1);
        expect(insertCalls[0][0]).toMatchObject({
            user_id: 'account-b',
            voyage_id: 'voyage-b',
        });
    });

    it('keeps voyage tombstones in their owner scope', async () => {
        setAuthIdentityScope('account-a');
        await addVoyageTombstone('same-voyage-id');
        const accountATombstones = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[accountATombstones])).toMatchObject({
            'same-voyage-id': {
                owner_user_id: 'account-a',
            },
        });

        setAuthIdentityScope('account-b');
        mockUser = { id: 'account-b' };
        await queueOfflineEntry(entry({ voyageId: 'same-voyage-id' }));
        expect(await syncOfflineQueue()).toBe(1);
        expect(insertCalls[0][0]).toMatchObject({
            user_id: 'account-b',
            voyage_id: 'same-voyage-id',
        });
    });

    it('quarantines ambiguous legacy points instead of assigning them to the next account', async () => {
        store.ship_log_offline_queue = JSON.stringify([
            {
                voyageId: 'unknown-owner',
                timestamp: '2026-06-01T00:00:00Z',
                latitude: -27.5,
                longitude: 153,
                entryType: 'auto',
            },
        ]);

        expect(await syncOfflineQueue()).toBe(0);
        expect(insertCalls).toEqual([]);
        expect(store.ship_log_offline_queue).toBeUndefined();
        expect(store.ship_log_offline_queue_quarantine_v2).toContain('unknown-owner');
    });

    it('adopts a legacy point only when its explicit owner matches', async () => {
        store.ship_log_offline_queue = JSON.stringify([
            entry({ userId: 'user-1', voyageId: 'provable-owner' }),
            entry({ userId: 'account-b', voyageId: 'other-owner' }),
        ]);

        expect(await syncOfflineQueue()).toBe(1);
        expect(insertCalls[0][0]).toMatchObject({
            user_id: 'user-1',
            voyage_id: 'provable-owner',
        });
        expect(store.ship_log_offline_queue).toContain('other-owner');
    });

    it('deduplicates a repeated local operation id before replay', async () => {
        await queueOfflineEntry(entry({ notes: 'same logical fix' }), { operationId: 'stable-capture-id' });
        await queueOfflineEntry(entry({ notes: 'same logical fix' }), { operationId: 'stable-capture-id' });

        expect(await getOfflineQueueCount()).toBe(1);
        expect(await syncOfflineQueue()).toBe(1);
        expect(insertCalls[0][0]).toMatchObject({
            client_operation_id: 'stable-capture-id',
            notes: 'same logical fix',
        });
    });

    it('retries failed cloud voyage deletions even when there are no queued points', async () => {
        await addVoyageTombstone('delete-me');
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());

        failCloudDelete = true;
        expect(await syncOfflineQueue()).toBe(0);
        expect(cloudDeleteCalls).toHaveLength(1);
        expect(JSON.parse(store[tombstoneKey])['delete-me'].cloud_deleted_at).toBeUndefined();

        failCloudDelete = false;
        expect(await syncOfflineQueue()).toBe(0);
        expect(cloudDeleteCalls).toHaveLength(2);
        expect(JSON.parse(store[tombstoneKey])['delete-me'].cloud_deleted_at).toEqual(expect.any(Number));

        // A confirmed tombstone remains as an in-flight-upload fence but is
        // actively re-deleted during its TTL, so a crash after a late
        // reinsertion cannot leave the voyage resurrected.
        expect(await syncOfflineQueue()).toBe(0);
        expect(cloudDeleteCalls).toHaveLength(3);
    });

    it('durably retries and verifies only an exactly linked planned voyage cascade', async () => {
        await addVoyageTombstone('planned_1750000000000_route');
        await recordVoyageDeletionCascadeMetadata(
            'planned_1750000000000_route',
            'Brisbane → Moreton',
            '2025-06-15',
            getAuthIdentityScope(),
            'draft-1',
        );
        voyageSelectResults = [
            [
                {
                    id: 'draft-1',
                    user_id: 'user-1',
                    status: 'planning',
                },
            ],
            [],
        ];

        expect(await syncOfflineQueue()).toBe(0);
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])['planned_1750000000000_route']).toMatchObject({
            planned_route_name: 'Brisbane → Moreton',
            planned_route_day: '2025-06-15',
            planned_voyage_id: 'draft-1',
            draft_cascade_completed_at: expect.any(Number),
            active_cascade_completed_at: expect.any(Number),
        });
        expect(
            cloudDeleteCalls.some((filters) => filters.includes('table=voyages') && filters.includes('id=draft-1')),
        ).toBe(true);
    });

    it('never performs a destructive name/day cascade without an exact voyage link', async () => {
        await addVoyageTombstone('planned_1750000000000_unlinked');
        await recordVoyageDeletionCascadeMetadata('planned_1750000000000_unlinked', 'Brisbane → Moreton', '2025-06-15');

        expect(await syncOfflineQueue()).toBe(0);
        expect(cloudDeleteCalls.some((filters) => filters.includes('table=voyages'))).toBe(false);
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])['planned_1750000000000_unlinked']).toMatchObject({
            cascade_link_unavailable_at: expect.any(Number),
        });
    });

    it('re-deletes an entry removed while its upload snapshot is in flight', async () => {
        let releaseUpsert!: (value: { error: null }) => void;
        pendingUpsertResult = new Promise((resolve) => {
            releaseUpsert = resolve;
        });
        await queueOfflineEntry(entry({ notes: 'delete during upload' }), {
            operationId: 'inflight-entry-operation',
        });
        const [displayEntry] = await getOfflineEntries();

        const syncing = syncOfflineQueue();
        await vi.waitFor(() => expect(insertCalls).toHaveLength(1));

        expect(await deleteEntryFromOfflineQueue(displayEntry.id)).toBe(true);
        expect(await getOfflineQueueCount()).toBe(0);
        releaseUpsert({ error: null });
        await expect(syncing).resolves.toBe(1);

        expect(
            cloudDeleteCalls.some((filters) => filters.includes('client_operation_id=inflight-entry-operation')),
        ).toBe(true);

        // The ledger remains for the race-fence TTL and repeats the delete on
        // a later sync, covering a request that committed after the first one.
        const deletesBeforeRetry = cloudDeleteCalls.length;
        expect(await syncOfflineQueue()).toBe(0);
        expect(cloudDeleteCalls.length).toBeGreaterThan(deletesBeforeRetry);
    });

    it('waits out an in-flight old upload, sweeps it, then commits stable-id recreation', async () => {
        let releaseUpsert!: (value: { error: null }) => void;
        pendingUpsertResult = new Promise((resolve) => {
            releaseUpsert = resolve;
        });
        await queueOfflineEntry(entry({ voyageId: 'shared-track-a', notes: 'old point' }), {
            operationId: 'old-shared-point',
        });

        const syncing = syncOfflineQueue();
        await vi.waitFor(() => expect(insertCalls).toHaveLength(1));
        await deleteVoyageFromOfflineQueue('shared-track-a');

        let recreated = false;
        const recreation = recreateVoyageWithFence('shared-track-a', getAuthIdentityScope(), async () => {
            recreated = true;
            return 'new-track';
        });
        await Promise.resolve();
        expect(recreated).toBe(false);

        releaseUpsert({ error: null });
        await expect(syncing).resolves.toBe(1);
        await expect(recreation).resolves.toBe('new-track');
        expect(recreated).toBe(true);
        expect(cloudDeleteCalls.some((filters) => filters.includes('voyage_id=shared-track-a'))).toBe(true);

        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey] || '{}')).not.toHaveProperty('shared-track-a');
    });

    it('rolls back a failed stable-id recreation and retains its durable fence', async () => {
        await addVoyageTombstone('shared-track-failure');

        await expect(
            recreateVoyageWithFence('shared-track-failure', getAuthIdentityScope(), async () => {
                throw new Error('import chunk failed');
            }),
        ).rejects.toThrow('import chunk failed');

        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])).toHaveProperty('shared-track-failure');
        await expect(queueOfflineEntry(entry({ voyageId: 'shared-track-failure' }))).rejects.toThrow(
            'has been deleted',
        );
    });
});

describe('normalizeLatestPositions', () => {
    it('keeps only the newest Latest Position per voyage, demotes older ones', () => {
        const q = [
            entry({ entryType: 'waypoint', waypointName: 'Latest Position', timestamp: '2026-06-01T00:00:00Z' }),
            entry({ entryType: 'waypoint', waypointName: 'Latest Position', timestamp: '2026-06-01T01:00:00Z' }),
            entry({ entryType: 'waypoint', waypointName: 'Turn Point', timestamp: '2026-06-01T00:30:00Z' }),
        ];
        const out = normalizeLatestPositions(q);
        expect(out[0].entryType).toBe('auto');
        expect(out[0].waypointName).toBeUndefined();
        expect(out[1].waypointName).toBe('Latest Position'); // newest survives
        expect(out[2].waypointName).toBe('Turn Point'); // named waypoints untouched
    });

    it('treats voyages independently', () => {
        const q = [
            entry({
                voyageId: 'a',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:00Z',
            }),
            entry({
                voyageId: 'b',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:01Z',
            }),
        ];
        const out = normalizeLatestPositions(q);
        expect(out[0].waypointName).toBe('Latest Position');
        expect(out[1].waypointName).toBe('Latest Position');
    });
});

describe('demoteLatestPositionInQueue', () => {
    it('keeps the newest timestamp when atomic rolling appends arrive out of order', async () => {
        await queueOfflineEntry(
            entry({
                voyageId: 'a',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:02Z',
            }),
            {
                operationId: 'newer-fix',
                demotePreviousLatestForVoyage: 'a',
            },
        );
        await queueOfflineEntry(
            entry({
                voyageId: 'a',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:01Z',
            }),
            {
                operationId: 'delayed-older-fix',
                demotePreviousLatestForVoyage: 'a',
            },
        );

        const entries = await getOfflineEntries();
        expect(entries.map(({ timestamp, waypointName }) => ({ timestamp, waypointName }))).toEqual([
            { timestamp: '2026-06-01T00:00:02Z', waypointName: 'Latest Position' },
            { timestamp: '2026-06-01T00:00:01Z', waypointName: undefined },
        ]);
    });

    it('demotes older matches while preserving a newer point appended before delayed demotion resolves', async () => {
        await queueOfflineEntry(
            entry({
                voyageId: 'a',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:00Z',
            }),
        );
        await queueOfflineEntry(
            entry({
                voyageId: 'a',
                entryType: 'waypoint',
                waypointName: 'Latest Position',
                timestamp: '2026-06-01T00:00:01Z',
            }),
        );
        await queueOfflineEntry(entry({ voyageId: 'b', entryType: 'waypoint', waypointName: 'Latest Position' }));

        await demoteLatestPositionInQueue('a');

        const entries = await getOfflineEntries();
        const a = entries.filter((e) => e.voyageId === 'a');
        const b = entries.find((e) => e.voyageId === 'b')!;
        expect(a.map((value) => value.entryType)).toEqual(['auto', 'waypoint']);
        expect(a.map((value) => value.waypointName)).toEqual([undefined, 'Latest Position']);
        expect(b.waypointName).toBe('Latest Position');
    });
});
