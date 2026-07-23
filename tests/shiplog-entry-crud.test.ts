/**
 * Unit Tests for Entry CRUD Operations
 * Tests database read/write/delete with mocked Supabase client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    archiveVoyage,
    getLogEntries,
    getVoyageEntriesSince,
    getArchivedEntries,
    getAllEntriesForCareer,
    deleteVoyage,
    deleteEntry,
    importGPXVoyage,
    unarchiveVoyage,
} from '../services/shiplog/EntryCrud';
import { setAuthIdentityScope } from '../services/authIdentityScope';

// ---- Mock Supabase ----
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const _mockEq = vi.fn();
const _mockOr = vi.fn();
const _mockOrder = vi.fn();
const _mockLimit = vi.fn();

const mockFrom = vi.fn((_tableName: string) => ({
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
}));

const mockGetUser = vi.fn();

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (tableName: string) => mockFrom(tableName),
        auth: {
            getUser: () => mockGetUser(),
        },
    },
    // EntryCrud now resolves the user via the fast local helpers (getSession-
    // backed) instead of auth.getUser(). Derive them from the same mock so
    // existing per-test mockGetUser setups keep driving behaviour.
    getCurrentUser: async () => {
        const res = await mockGetUser();
        return res?.data?.user ?? null;
    },
    getCurrentUserId: async () => {
        const res = await mockGetUser();
        return res?.data?.user?.id ?? null;
    },
}));

// Mock logger
vi.mock('../utils/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// Mock OfflineQueue (to isolate EntryCrud tests)
vi.mock('../services/shiplog/OfflineQueue', () => ({
    deleteVoyageFromOfflineQueue: vi.fn(async () => false),
    deleteEntryFromOfflineQueue: vi.fn(async () => false),
    attemptVoyageCloudDeletion: vi.fn(async () => true),
    recreateVoyageWithFence: vi.fn(
        async <T>(_voyageId: string, _scope: unknown, recreate: () => Promise<T>): Promise<T> => recreate(),
    ),
    filterVoyageTombstonedEntries: vi.fn(async <T>(entries: T[]): Promise<T[]> => entries),
    filterEntryTombstonedRows: vi.fn(async <T>(rows: T[]): Promise<T[]> => rows),
    applyVoyageArchiveIntentOverlay: vi.fn(async <T>(entries: T[]): Promise<T[]> => entries),
    getVoyageArchiveIntentSnapshot: vi.fn(async () => []),
    recordVoyageDeletionCascadeMetadata: vi.fn(async () => undefined),
    runShipLogCloudTransaction: vi.fn(
        async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => operation(),
    ),
    runVoyageCloudMutation: vi.fn(
        async <T>(
            _voyageId: string,
            _scope: unknown,
            _timeoutMs: number,
            operation: (signal: AbortSignal) => PromiseLike<T>,
        ): Promise<T> => operation(new AbortController().signal),
    ),
    setVoyageArchivedInOfflineQueue: vi.fn(async (voyageId: string, archived: boolean) => ({
        voyageId,
        archived,
        requestId: 'archive-request',
        requestedAt: Date.parse('2026-07-24T00:00:00.000Z'),
    })),
    isVoyageArchiveIntentCurrent: vi.fn(async () => true),
    markVoyageArchiveIntentCloudApplied: vi.fn(async () => true),
}));

import {
    attemptVoyageCloudDeletion,
    applyVoyageArchiveIntentOverlay,
    getVoyageArchiveIntentSnapshot,
    deleteEntryFromOfflineQueue,
    deleteVoyageFromOfflineQueue,
    recreateVoyageWithFence,
} from '../services/shiplog/OfflineQueue';

const mockDeleteEntryOffline = vi.mocked(deleteEntryFromOfflineQueue);
const mockDeleteVoyageOffline = vi.mocked(deleteVoyageFromOfflineQueue);
const mockAttemptVoyageCloudDeletion = vi.mocked(attemptVoyageCloudDeletion);
const mockApplyVoyageArchiveIntentOverlay = vi.mocked(applyVoyageArchiveIntentOverlay);
const mockGetVoyageArchiveIntentSnapshot = vi.mocked(getVoyageArchiveIntentSnapshot);
const mockRecreateVoyageWithFence = vi.mocked(recreateVoyageWithFence);

// ---- Helpers ----

function setupChainedQuery(data: unknown[] | null, error: unknown = null, count: number | null = data?.length ?? 0) {
    const result = { data, error, count };
    const chain = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(result),
        range: vi.fn().mockResolvedValue(result),
        delete: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        abortSignal: vi.fn().mockReturnThis(),
        then: (
            onFulfilled: (value: { data: unknown[] | null; error: unknown; count: number | null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    mockFrom.mockReturnValue(chain);
    return chain;
}

function mockAuthUser(userId: string | null) {
    setAuthIdentityScope(userId);
    if (userId) {
        mockGetUser.mockResolvedValue({ data: { user: { id: userId } } });
    } else {
        mockGetUser.mockResolvedValue({ data: { user: null } });
    }
}

beforeEach(() => {
    setAuthIdentityScope(null);
    vi.clearAllMocks();
    mockApplyVoyageArchiveIntentOverlay.mockImplementation(async <T>(entries: T[]): Promise<T[]> => entries);
    mockGetVoyageArchiveIntentSnapshot.mockResolvedValue([]);
});

// ---- getLogEntries ----

describe('getLogEntries', () => {
    it('returns mapped entries when authenticated', async () => {
        mockAuthUser('user-1');
        const _chain = setupChainedQuery([
            {
                id: 'e1',
                user_id: 'user-1',
                voyage_id: 'v1',
                timestamp: '2025-01-01T00:00:00Z',
                entry_type: 'auto',
                source: 'device',
            },
        ]);

        const entries = await getLogEntries(10);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('e1');
        expect(entries[0].userId).toBe('user-1');
        expect(entries[0].voyageId).toBe('v1');
        expect(entries[0].entryType).toBe('auto');
    });

    it('returns empty array when not authenticated', async () => {
        mockAuthUser(null);
        const entries = await getLogEntries();
        expect(entries).toEqual([]);
    });
});

describe('getVoyageEntriesSince', () => {
    it('maps the default_voyage sentinel to null/empty database voyage ids', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery([]);

        await expect(getVoyageEntriesSince('default_voyage', '2026-01-01T00:00:00.000Z')).resolves.toEqual([]);
        expect(chain.or).toHaveBeenCalledWith('voyage_id.is.null,voyage_id.eq.');
        expect(chain.eq).not.toHaveBeenCalledWith('voyage_id', 'default_voyage');
    });

    it('paginates through more than 1000 rows sharing the same timestamp with a stable id tie-break', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery([]);
        chain.range.mockImplementation(async (from: number) => ({
            data:
                from === 0
                    ? Array.from({ length: 1000 }, (_, index) => ({
                          id: `entry-${String(index).padStart(4, '0')}`,
                          user_id: 'user-1',
                          voyage_id: 'voyage-1',
                          timestamp: '2026-01-01T00:15:00.000Z',
                      }))
                    : [
                          {
                              id: 'entry-1000',
                              user_id: 'user-1',
                              voyage_id: 'voyage-1',
                              timestamp: '2026-01-01T00:15:00.000Z',
                          },
                      ],
            error: null,
        }));

        await expect(getVoyageEntriesSince('voyage-1', '2026-01-01T00:00:00.000Z')).resolves.toHaveLength(1001);
        expect(chain.range).toHaveBeenCalledTimes(2);
        expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    });
});

describe('getAllEntriesForCareer', () => {
    it('paginates beyond the former 10,000-row ceiling', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery([]);
        chain.range.mockImplementation(async (from: number) => ({
            data:
                from < 10_000
                    ? Array.from({ length: 1000 }, (_, index) => ({
                          voyage_id: `v-${from + index}`,
                          timestamp: '2025-01-01T00:00:00Z',
                          source: 'device',
                      }))
                    : [
                          {
                              voyage_id: 'v-10000',
                              timestamp: '2025-01-01T00:00:00Z',
                              source: 'device',
                          },
                      ],
            error: null,
        }));

        const entries = await getAllEntriesForCareer();
        expect(entries).toHaveLength(10_001);
        expect(chain.range).toHaveBeenCalledTimes(11);
    });
});

describe('archive state mutations', () => {
    it('requires an owner-scoped affected row for archive and unarchive', async () => {
        mockAuthUser('user-1');
        const archived = setupChainedQuery(null, null, 1);
        const archiveVerification = setupChainedQuery([]);
        mockFrom.mockReturnValueOnce(archived).mockReturnValueOnce(archiveVerification);

        await expect(archiveVoyage('voyage-1')).resolves.toBe(true);
        expect(archived.update).toHaveBeenCalledWith({ archived: true }, { count: 'exact' });

        const unarchived = setupChainedQuery(null, null, 1);
        const unarchiveVerification = setupChainedQuery([]);
        mockFrom.mockReturnValueOnce(unarchived).mockReturnValueOnce(unarchiveVerification);
        await expect(unarchiveVoyage('voyage-1')).resolves.toBe(true);
        expect(unarchived.update).toHaveBeenCalledWith({ archived: false }, { count: 'exact' });
    });

    it('accepts an RLS/zero-row archive into the durable retry outbox', async () => {
        mockAuthUser('user-1');
        setupChainedQuery([]);

        await expect(archiveVoyage('voyage-1')).resolves.toBe(true);
    });

    it('overlays failed archive and unarchive PATCHes onto both read lists', async () => {
        mockAuthUser('user-1');
        let desiredArchived = true;
        mockApplyVoyageArchiveIntentOverlay.mockImplementation(async (entries) =>
            entries.map((entry) => ({ ...entry, archived: desiredArchived })),
        );
        mockGetVoyageArchiveIntentSnapshot.mockImplementation(async () => [
            {
                voyageId: 'voyage-1',
                archived: desiredArchived,
                requestedAt: Date.parse('2026-07-24T00:00:00.000Z'),
            },
        ]);
        const cloudRow = {
            id: 'entry-1',
            user_id: 'user-1',
            voyage_id: 'voyage-1',
            timestamp: '2026-07-23T00:00:00.000Z',
            source: 'device',
        };

        const failedArchive = setupChainedQuery(null, null, 0);
        const activeReadAfterArchive = setupChainedQuery([{ ...cloudRow, archived: false }]);
        const archivedReadAfterArchive = setupChainedQuery([]);
        const archiveOppositeStateRead = setupChainedQuery([{ ...cloudRow, archived: false }]);
        const failedUnarchive = setupChainedQuery(null, null, 0);
        const activeReadAfterUnarchive = setupChainedQuery([]);
        const unarchiveOppositeStateRead = setupChainedQuery([{ ...cloudRow, archived: true }]);
        const archivedReadAfterUnarchive = setupChainedQuery([{ ...cloudRow, archived: true }]);
        mockFrom
            .mockReturnValueOnce(failedArchive)
            .mockReturnValueOnce(activeReadAfterArchive)
            .mockReturnValueOnce(archivedReadAfterArchive)
            .mockReturnValueOnce(archiveOppositeStateRead)
            .mockReturnValueOnce(failedUnarchive)
            .mockReturnValueOnce(activeReadAfterUnarchive)
            .mockReturnValueOnce(unarchiveOppositeStateRead)
            .mockReturnValueOnce(archivedReadAfterUnarchive);

        await expect(archiveVoyage('voyage-1')).resolves.toBe(true);
        await expect(getLogEntries()).resolves.toEqual([]);
        await expect(getArchivedEntries()).resolves.toEqual([
            expect.objectContaining({ id: 'entry-1', archived: true }),
        ]);

        desiredArchived = false;
        await expect(unarchiveVoyage('voyage-1')).resolves.toBe(true);
        await expect(getLogEntries()).resolves.toEqual([expect.objectContaining({ id: 'entry-1', archived: false })]);
        await expect(getArchivedEntries()).resolves.toEqual([]);

        expect(activeReadAfterArchive.or).toHaveBeenCalledWith('archived.is.null,archived.eq.false');
        expect(archivedReadAfterArchive.eq).toHaveBeenCalledWith('archived', true);
        expect(archiveOppositeStateRead.in).toHaveBeenCalledWith('voyage_id', ['voyage-1']);
        expect(unarchiveOppositeStateRead.in).toHaveBeenCalledWith('voyage_id', ['voyage-1']);
    });

    it('archives the default voyage through its null/empty database representation', async () => {
        mockAuthUser('user-1');
        const mutation = setupChainedQuery(null, null, 1);
        const verification = setupChainedQuery([]);
        mockFrom.mockReturnValueOnce(mutation).mockReturnValueOnce(verification);

        await expect(archiveVoyage('default_voyage')).resolves.toBe(true);
        expect(mutation.or).toHaveBeenCalledWith('voyage_id.is.null,voyage_id.eq.');
        expect(mutation.lte).toHaveBeenCalledWith('timestamp', '2026-07-24T00:00:00.000Z');
        expect(verification.lte).toHaveBeenCalledWith('timestamp', '2026-07-24T00:00:00.000Z');
        expect(mutation.eq).not.toHaveBeenCalledWith('voyage_id', 'default_voyage');
    });
});

// ---- deleteVoyage ----

describe('deleteVoyage', () => {
    it('calls delete with correct voyage_id', async () => {
        mockAuthUser('user-1');

        const result = await deleteVoyage('v1');
        expect(result).toBe(true);
        expect(mockAttemptVoyageCloudDeletion).toHaveBeenCalledWith(
            'v1',
            expect.objectContaining({ userId: 'user-1' }),
        );
    });

    it('accepts a durable delete when the immediate cloud attempt remains pending', async () => {
        mockAuthUser('user-1');
        mockAttemptVoyageCloudDeletion.mockResolvedValueOnce(false);

        await expect(deleteVoyage('v1')).resolves.toBe(true);
        expect(mockDeleteVoyageOffline).toHaveBeenCalledWith('v1');
    });

    it('keeps a zero-row/RLS no-op in the durable retry ledger', async () => {
        mockAuthUser('user-1');
        mockAttemptVoyageCloudDeletion.mockResolvedValueOnce(false);

        await expect(deleteVoyage('v1')).resolves.toBe(true);
    });

    it('accepts deletion of a malformed planned timestamp without throwing after the durable stone', async () => {
        mockAuthUser('user-1');

        await expect(deleteVoyage('planned_9999999999999999_bad')).resolves.toBe(true);
        expect(mockDeleteVoyageOffline).toHaveBeenCalledWith('planned_9999999999999999_bad');
    });
});

// ---- deleteEntry ----

describe('deleteEntry', () => {
    it('calls delete with correct entry_id', async () => {
        mockAuthUser('user-1');
        setupChainedQuery(null);

        const result = await deleteEntry('e1');
        expect(result).toBe(true);
        expect(mockFrom).toHaveBeenCalledWith('ship_logs');
    });

    it('deletes a stable offline display id locally without sending it to the UUID column', async () => {
        mockAuthUser('user-1');
        mockDeleteEntryOffline.mockResolvedValueOnce(true);

        await expect(deleteEntry('offline_stable-operation')).resolves.toBe(true);
        expect(mockFrom).not.toHaveBeenCalled();
    });

    it('returns false when a stable offline display id no longer maps to a queued entry', async () => {
        mockAuthUser('user-1');
        mockDeleteEntryOffline.mockResolvedValueOnce(false);

        await expect(deleteEntry('offline_missing-operation')).resolves.toBe(false);
        expect(mockFrom).not.toHaveBeenCalled();
    });

    it('returns false when an entry still exists after a nominally successful delete', async () => {
        mockAuthUser('user-1');
        setupChainedQuery([{ id: 'e1' }]);

        await expect(deleteEntry('e1')).resolves.toBe(false);
    });

    it('maps a visible database UUID back to its durable queue operation before deleting', async () => {
        mockAuthUser('user-1');
        const lookup = setupChainedQuery([{ id: 'e1', client_operation_id: 'late-operation' }]);
        const deletion = setupChainedQuery(null);
        const verification = setupChainedQuery([]);
        mockFrom.mockReturnValueOnce(lookup).mockReturnValueOnce(deletion).mockReturnValueOnce(verification);

        await expect(deleteEntry('e1')).resolves.toBe(true);
        expect(mockDeleteEntryOffline).toHaveBeenCalledWith('offline_late-operation');
        expect(deletion.delete).toHaveBeenCalledOnce();
        expect(verification.select).toHaveBeenCalledWith('id');
    });

    it('accepts a durable operation-id deletion when the immediate cloud delete fails', async () => {
        mockAuthUser('user-1');
        mockDeleteEntryOffline.mockResolvedValueOnce(true);
        const lookup = setupChainedQuery([{ id: 'e1', client_operation_id: 'retry-operation' }]);
        const deletion = setupChainedQuery(null, { message: 'offline' });
        mockFrom.mockReturnValueOnce(lookup).mockReturnValueOnce(deletion);

        await expect(deleteEntry('e1')).resolves.toBe(true);
        expect(mockDeleteEntryOffline).toHaveBeenCalledWith('offline_retry-operation');
    });
});

// ---- importGPXVoyage ----

describe('importGPXVoyage', () => {
    it('throws on empty entries', async () => {
        await expect(importGPXVoyage([])).rejects.toThrow('No entries to import');
    });

    it('throws when user not authenticated', async () => {
        mockAuthUser(null);
        await expect(importGPXVoyage([{ latitude: -27 }])).rejects.toThrow('Login required');
    });

    it('stamps entries with gpx_import source', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery(null);

        // Mock crypto.randomUUID
        vi.stubGlobal('crypto', { randomUUID: () => 'mock-uuid' });

        const result = await importGPXVoyage([
            { latitude: -27.47, longitude: 153.02, timestamp: '2025-01-01T00:00:00Z' },
        ]);

        expect(result.savedCount).toBe(1);
        expect(result.voyageId).toBe('mock-uuid');
        expect(mockRecreateVoyageWithFence).toHaveBeenCalledWith(
            'mock-uuid',
            expect.objectContaining({ userId: 'user-1' }),
            expect.any(Function),
        );

        // Check insert was called with gpx_import source
        const insertCall = chain.upsert.mock.calls[0][0];
        expect(insertCall[0].source).toBe('gpx_import');
        expect(chain.upsert.mock.calls[0][1]).toMatchObject({
            onConflict: 'user_id,client_operation_id',
            ignoreDuplicates: true,
        });

        vi.unstubAllGlobals();
    });

    it('uses an explicit stable voyage id and community provenance without trusting entry source', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery(null);
        vi.stubGlobal('crypto', { randomUUID: () => 'entry-uuid' });

        const result = await importGPXVoyage(
            [
                {
                    source: 'device',
                    voyageId: 'hostile-voyage',
                    latitude: -27.47,
                    longitude: 153.02,
                    timestamp: '2025-01-01T00:00:00Z',
                },
            ],
            {
                source: 'community_download',
                voyageId: 'shared-track-a',
            },
        );

        expect(result).toEqual({ savedCount: 1, voyageId: 'shared-track-a' });
        const insertCall = chain.upsert.mock.calls[0][0];
        expect(insertCall[0]).toMatchObject({
            id: 'entry-uuid',
            voyage_id: 'shared-track-a',
            source: 'community_download',
        });
        expect(insertCall[0].client_operation_id).toMatch(/^import_[a-f0-9]{16}_0$/);

        await importGPXVoyage(
            [
                {
                    latitude: -27.47,
                    longitude: 153.02,
                    timestamp: '2025-01-01T00:00:00Z',
                },
            ],
            {
                source: 'community_download',
                voyageId: 'shared-track-a',
            },
        );
        expect(chain.upsert.mock.calls[1][0][0].client_operation_id).toBe(insertCall[0].client_operation_id);
        expect(mockRecreateVoyageWithFence).toHaveBeenCalledWith(
            'shared-track-a',
            expect.objectContaining({ userId: 'user-1' }),
            expect.any(Function),
        );
        expect(mockRecreateVoyageWithFence.mock.invocationCallOrder[0]).toBeLessThan(
            chain.upsert.mock.invocationCallOrder[0],
        );

        vi.unstubAllGlobals();
    });

    it('clamps an invalid runtime provenance option to gpx_import', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery(null);
        vi.stubGlobal('crypto', { randomUUID: () => 'runtime-source-id' });

        await importGPXVoyage([{ latitude: -27.47, longitude: 153.02 }], {
            voyageId: 'runtime-source-voyage',
            source: 'device',
        } as unknown as Parameters<typeof importGPXVoyage>[1]);

        expect(chain.upsert.mock.calls[0][0][0].source).toBe('gpx_import');
        vi.unstubAllGlobals();
    });

    it('rejects unsafe caller-supplied voyage ids', async () => {
        mockAuthUser('user-1');
        setupChainedQuery(null);

        await expect(
            importGPXVoyage([{ latitude: -27.47 }], {
                source: 'community_download',
                voyageId: 'bad/id<script>',
            }),
        ).rejects.toThrow('Invalid import voyage id');
        await expect(
            importGPXVoyage([{ latitude: -27.47 }], {
                source: 'community_download',
                voyageId: 'default_voyage',
            }),
        ).rejects.toThrow('Invalid import voyage id');
    });
});
