import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    from: vi.fn(),
    deleteVoyageOffline: vi.fn(),
    deleteEntryOffline: vi.fn(),
    attemptVoyageCloudDeletion: vi.fn(),
    recreateVoyageWithFence: vi.fn(),
    filterVoyageTombstonedEntries: vi.fn(),
    filterEntryTombstonedRows: vi.fn(),
    applyVoyageArchiveIntentOverlay: vi.fn(),
    getVoyageArchiveIntentSnapshot: vi.fn(),
    recordVoyageDeletionCascadeMetadata: vi.fn(),
    runShipLogCloudTransaction: vi.fn(),
    runVoyageCloudMutation: vi.fn(),
    setVoyageArchivedInOfflineQueue: vi.fn(),
    isVoyageArchiveIntentCurrent: vi.fn(),
    markVoyageArchiveIntentCloudApplied: vi.fn(),
    invalidateRoutes: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: mocks.from,
    },
    getCurrentUser: mocks.getCurrentUser,
}));

vi.mock('../services/shiplog/OfflineQueue', () => ({
    deleteVoyageFromOfflineQueue: mocks.deleteVoyageOffline,
    deleteEntryFromOfflineQueue: mocks.deleteEntryOffline,
    attemptVoyageCloudDeletion: mocks.attemptVoyageCloudDeletion,
    recreateVoyageWithFence: mocks.recreateVoyageWithFence,
    filterVoyageTombstonedEntries: mocks.filterVoyageTombstonedEntries,
    filterEntryTombstonedRows: mocks.filterEntryTombstonedRows,
    applyVoyageArchiveIntentOverlay: mocks.applyVoyageArchiveIntentOverlay,
    getVoyageArchiveIntentSnapshot: mocks.getVoyageArchiveIntentSnapshot,
    recordVoyageDeletionCascadeMetadata: mocks.recordVoyageDeletionCascadeMetadata,
    runShipLogCloudTransaction: mocks.runShipLogCloudTransaction,
    runVoyageCloudMutation: mocks.runVoyageCloudMutation,
    setVoyageArchivedInOfflineQueue: mocks.setVoyageArchivedInOfflineQueue,
    isVoyageArchiveIntentCurrent: mocks.isVoyageArchiveIntentCurrent,
    markVoyageArchiveIntentCloudApplied: mocks.markVoyageArchiveIntentCloudApplied,
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    invalidateRoutesAndTracks: mocks.invalidateRoutes,
}));

import {
    archiveVoyage,
    deleteEntry,
    deleteVoyage,
    getLogEntries,
    importGPXVoyage,
} from '../services/shiplog/EntryCrud';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function readQuery(result: Promise<{ data: unknown[]; error: null }> | { data: unknown[]; error: null }) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        or: vi.fn(),
        order: vi.fn(),
        range: vi.fn(),
        abortSignal: vi.fn(),
        then: (
            onFulfilled: (value: { data: unknown[]; error: null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.range.mockReturnValue(result);
    query.abortSignal.mockReturnValue(query);
    return query;
}

function mutationQuery(result: Promise<{ data?: unknown[]; error: null }> | { data?: unknown[]; error: null }) {
    const query = {
        update: vi.fn(),
        delete: vi.fn(),
        eq: vi.fn(),
        or: vi.fn(),
        select: vi.fn(),
        limit: vi.fn(),
        abortSignal: vi.fn(),
        then: (
            onFulfilled: (value: { data?: unknown[]; error: null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    query.update.mockReturnValue(query);
    query.delete.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.select.mockReturnValue(query);
    query.limit.mockReturnValue(result);
    query.abortSignal.mockReturnValue(query);
    return query;
}

describe('EntryCrud identity boundary', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.getCurrentUser.mockResolvedValue({ id: 'account-a' });
        mocks.deleteVoyageOffline.mockResolvedValue(false);
        mocks.deleteEntryOffline.mockResolvedValue(false);
        mocks.attemptVoyageCloudDeletion.mockResolvedValue(true);
        mocks.recreateVoyageWithFence.mockImplementation(
            async (_voyageId: string, _scope: unknown, recreate: () => Promise<unknown>) => recreate(),
        );
        mocks.filterVoyageTombstonedEntries.mockImplementation(async (entries: unknown[]) => entries);
        mocks.filterEntryTombstonedRows.mockImplementation(async (rows: unknown[]) => rows);
        mocks.applyVoyageArchiveIntentOverlay.mockImplementation(async (entries: unknown[]) => entries);
        mocks.getVoyageArchiveIntentSnapshot.mockResolvedValue([]);
        mocks.recordVoyageDeletionCascadeMetadata.mockResolvedValue(undefined);
        mocks.runShipLogCloudTransaction.mockImplementation(
            async (_scope: unknown, operation: () => Promise<unknown>) => operation(),
        );
        mocks.runVoyageCloudMutation.mockImplementation(
            async (
                _voyageId: string,
                _scope: unknown,
                _timeoutMs: number,
                operation: (signal: AbortSignal) => PromiseLike<unknown>,
            ) => operation(new AbortController().signal),
        );
        mocks.setVoyageArchivedInOfflineQueue.mockImplementation(async (voyageId: string, archived: boolean) => ({
            voyageId,
            archived,
            requestId: 'archive-request',
            requestedAt: Date.parse('2026-07-24T00:00:00.000Z'),
        }));
        mocks.isVoyageArchiveIntentCurrent.mockResolvedValue(true);
        mocks.markVoyageArchiveIntentCloudApplied.mockResolvedValue(true);
    });

    it('drops an A page that resolves after B becomes current', async () => {
        const page = deferred<{ data: unknown[]; error: null }>();
        const query = readQuery(page.promise);
        mocks.from.mockReturnValue(query);
        const pending = getLogEntries(10);
        await vi.waitFor(() => expect(query.range).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        page.resolve({
            data: [
                {
                    id: 'a-entry',
                    user_id: 'account-a',
                    voyage_id: 'voyage-a',
                    timestamp: '2026-07-23T00:00:00.000Z',
                },
            ],
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(query.eq).toHaveBeenCalledWith('user_id', 'account-a');
    });

    it('does not query when the authenticated session disagrees with the captured scope', async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: 'account-b' });

        await expect(getLogEntries()).resolves.toEqual([]);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('returns false when an archive mutation completes after an account switch', async () => {
        const mutation = deferred<{ error: null }>();
        const query = mutationQuery(mutation.promise);
        mocks.from.mockReturnValue(query);
        const pending = archiveVoyage('voyage-a');
        await vi.waitFor(() => expect(query.eq).toHaveBeenCalledWith('voyage_id', 'voyage-a'));

        setAuthIdentityScope('account-b');
        mutation.resolve({ error: null });

        await expect(pending).resolves.toBe(false);
        expect(query.eq).toHaveBeenCalledWith('user_id', 'account-a');
    });

    it('does not continue an A voyage deletion into B after the offline stage', async () => {
        const offline = deferred<boolean>();
        mocks.deleteVoyageOffline.mockReturnValueOnce(offline.promise);
        const pending = deleteVoyage('voyage-a');

        setAuthIdentityScope('account-b');
        offline.resolve(true);

        await expect(pending).resolves.toBe(false);
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.invalidateRoutes).not.toHaveBeenCalled();
    });

    it('persists a planned-voyage tombstone before its optional cloud name lookup resolves', async () => {
        const lookup = deferred<{ data: unknown[]; error: null }>();
        const query = readQuery(lookup.promise);
        mocks.from.mockReturnValue(query);

        const pending = deleteVoyage('planned_1750000000000_route');
        await vi.waitFor(() => expect(query.order).toHaveBeenCalledOnce());
        expect(mocks.deleteVoyageOffline).toHaveBeenCalledWith('planned_1750000000000_route');

        setAuthIdentityScope('account-b');
        lookup.resolve({ data: [], error: null });
        await expect(pending).resolves.toBe(false);
    });

    it('does not continue an A entry deletion into B after the operation-id lookup', async () => {
        const lookup = deferred<{ data?: unknown[]; error: null }>();
        const query = mutationQuery(lookup.promise);
        mocks.from.mockReturnValue(query);
        const pending = deleteEntry('entry-a');
        await vi.waitFor(() => expect(query.limit).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        lookup.resolve({
            data: [{ id: 'entry-a', client_operation_id: 'operation-a' }],
            error: null,
        });

        await expect(pending).resolves.toBe(false);
        expect(mocks.deleteEntryOffline).not.toHaveBeenCalled();
    });

    it('pins GPX chunks to A, forces imported provenance, and aborts a late completion', async () => {
        const insertResult = deferred<{ error: null }>();
        const upsertQuery = {
            abortSignal: vi.fn(),
            then: (onFulfilled: (value: { error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
                insertResult.promise.then(onFulfilled, onRejected),
        };
        upsertQuery.abortSignal.mockReturnValue(upsertQuery);
        const upsert = vi.fn().mockReturnValue(upsertQuery);
        mocks.from.mockReturnValue({ upsert });
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });

        const pending = importGPXVoyage([
            {
                id: 'hostile-id',
                userId: 'account-b',
                voyageId: 'voyage-b',
                source: 'device',
                latitude: -27.47,
                longitude: 153.02,
                timestamp: '2026-07-23T00:00:00.000Z',
            },
        ]);
        await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
        const payload = upsert.mock.calls[0][0][0];
        expect(payload).toMatchObject({
            id: 'generated-id',
            user_id: 'account-a',
            voyage_id: 'generated-id',
            source: 'gpx_import',
        });

        setAuthIdentityScope('account-b');
        insertResult.resolve({ error: null });

        await expect(pending).rejects.toThrow('Account changed during import');
        vi.unstubAllGlobals();
    });

    it('rejects a caller-captured A import before auth lookup when B is already current', async () => {
        const accountA = getAuthIdentityScope();
        setAuthIdentityScope('account-b');

        await expect(
            importGPXVoyage([{ latitude: -27.47, longitude: 153.02 }], {
                expectedScope: accountA,
                source: 'community_download',
                voyageId: 'shared-track-a',
            }),
        ).rejects.toThrow('Account changed during import');

        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });
});
