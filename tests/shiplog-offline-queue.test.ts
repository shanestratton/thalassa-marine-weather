/**
 * Unit Tests for Offline Queue Manager
 * Tests queue operations with mocked @capacitor/preferences (in-memory store)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import {
    queueOfflineEntry,
    getOfflineQueueCount,
    getOfflineEntries,
    deleteEntryFromOfflineQueue,
    deleteVoyageFromOfflineQueue,
    flushOfflineQueueToDisk,
    assertOfflineQueueCapacity,
    OFFLINE_QUEUE_CAPACITY,
    OfflineQueueCapacityError,
    addVoyageTombstone,
    filterEntryTombstonedRows,
    applyVoyageArchiveIntentOverlay,
    setVoyageArchivedInOfflineQueue,
    __resetOfflineQueueForTests,
} from '../services/shiplog/OfflineQueue';
import { authScopedStorageKey, getAuthIdentityScope } from '../services/authIdentityScope';

// ---- Mock @capacitor/preferences as in-memory store ----
const store: Record<string, string> = {};

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({
            value: store[key] ?? null,
        })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete store[key];
        }),
    },
}));

// Mock supabase (not used in offline queue tests, but imported by module)
vi.mock('../services/supabase', () => ({
    supabase: null,
    getCurrentUser: vi.fn(async () => null),
    getCurrentUserId: vi.fn(async () => null),
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

beforeEach(() => {
    // Clear the in-memory store between tests
    for (const key of Object.keys(store)) {
        delete store[key];
    }
    // The queue lives in a module-level cache since c516385f — clearing
    // the mocked Preferences store alone no longer resets it.
    __resetOfflineQueueForTests();
    vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        store[key] = value;
    });
});

describe('queueOfflineEntry', () => {
    it('queues a single entry', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1', timestamp: '2025-01-01T00:00:00Z' });
        const count = await getOfflineQueueCount();
        expect(count).toBe(1);
    });

    it('queues multiple entries', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1' });
        await queueOfflineEntry({ id: 'e2', voyageId: 'v1' });
        await queueOfflineEntry({ id: 'e3', voyageId: 'v2' });
        const count = await getOfflineQueueCount();
        expect(count).toBe(3);
    });

    it('rejects explicitly on durable storage failure without evicting the in-memory point', async () => {
        vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('device storage full'));

        await expect(
            queueOfflineEntry({ id: 'e1', voyageId: 'v1', timestamp: '2025-01-01T00:00:00Z' }),
        ).rejects.toThrow('device storage full');
        expect(await getOfflineQueueCount()).toBe(1);

        // Once storage recovers, the exact retained point can be flushed.
        await flushOfflineQueueToDisk();
        expect(await getOfflineQueueCount()).toBe(1);
    });

    it('serializes simultaneous durable appends so segment manifests cannot race', async () => {
        let releaseFirst!: () => void;
        const firstWriteBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let writes = 0;
        let activeWrites = 0;
        let maximumActiveWrites = 0;
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            writes++;
            activeWrites++;
            maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
            if (writes === 1) await firstWriteBlocked;
            store[key] = value;
            activeWrites--;
        });

        const firstAppend = queueOfflineEntry({ id: 'e1', voyageId: 'v1' });
        await vi.waitFor(() => expect(writes).toBe(1));
        const secondAppend = queueOfflineEntry({ id: 'e2', voyageId: 'v1' });
        await Promise.resolve();
        expect(writes).toBe(1);

        releaseFirst();
        await Promise.all([firstAppend, secondAppend]);
        expect(maximumActiveWrites).toBe(1);
        expect(await getOfflineQueueCount()).toBe(2);
    });

    it('serializes whole-ledger voyage tombstone mutations without losing either delete', async () => {
        let releaseFirst!: () => void;
        const firstWriteBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let tombstoneWrites = 0;
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            if (key.includes('ship_log_deleted_voyages')) {
                tombstoneWrites++;
                if (tombstoneWrites === 1) await firstWriteBlocked;
            }
            store[key] = value;
        });

        const firstDelete = addVoyageTombstone('voyage-a');
        await vi.waitFor(() => expect(tombstoneWrites).toBe(1));
        const secondDelete = addVoyageTombstone('voyage-b');
        await Promise.resolve();
        expect(tombstoneWrites).toBe(1);

        releaseFirst();
        await Promise.all([firstDelete, secondDelete]);
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])).toMatchObject({
            'voyage-a': expect.any(Object),
            'voyage-b': expect.any(Object),
        });
    });

    it('persists voyage ids that collide with Object prototype property names', async () => {
        await addVoyageTombstone('constructor');
        await addVoyageTombstone('__proto__');

        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        const persisted = JSON.parse(store[tombstoneKey]) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(persisted, 'constructor')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(persisted, '__proto__')).toBe(true);
        await expect(queueOfflineEntry({ voyageId: 'constructor' })).rejects.toThrow('has been deleted');
    });

    it('persists queue operation ids that collide with Object prototype property names', async () => {
        await queueOfflineEntry({ voyageId: 'v1', timestamp: '2025-01-01T00:00:00Z' }, { operationId: '__proto__' });

        await expect(deleteEntryFromOfflineQueue('offline___proto__')).resolves.toBe(true);
        const tombstoneKey = authScopedStorageKey('ship_log_deleted_entries', getAuthIdentityScope());
        const persisted = JSON.parse(store[tombstoneKey]) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(persisted, '__proto__')).toBe(true);
        expect(await getOfflineQueueCount()).toBe(0);
    });

    it('hides a cloud row while its durable entry deletion is still retrying', async () => {
        await queueOfflineEntry({ voyageId: 'v1' }, { operationId: 'cloud-visible-operation' });
        await deleteEntryFromOfflineQueue('offline_cloud-visible-operation');

        await expect(
            filterEntryTombstonedRows([
                { id: 'deleted-row', client_operation_id: 'cloud-visible-operation' },
                { id: 'visible-row', client_operation_id: 'other-operation' },
            ]),
        ).resolves.toEqual([{ id: 'visible-row', client_operation_id: 'other-operation' }]);
    });

    it('hides a deleted voyage after a crash between tombstone and queue rewrite', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'deleted-voyage' });
        await queueOfflineEntry({ id: 'e2', voyageId: 'kept-voyage' });

        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            if (key.includes('ship_log_offline_queue') && key.includes(':v3:')) {
                throw new Error('simulated crash during queue rewrite');
            }
            store[key] = value;
        });
        await expect(deleteVoyageFromOfflineQueue('deleted-voyage')).resolves.toBe(true);

        // A restart reloads the old queue generation, but the tombstone was
        // committed first and must keep that voyage out of both UI and count.
        __resetOfflineQueueForTests();
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        });
        expect(await getOfflineQueueCount()).toBe(1);
        expect((await getOfflineEntries()).map((entry) => entry.voyageId)).toEqual(['kept-voyage']);
    });
});

describe('voyage archive intent overlay', () => {
    it('projects the latest durable command onto opposite-state cloud rows', async () => {
        await setVoyageArchivedInOfflineQueue('voyage-1', true);
        await expect(
            applyVoyageArchiveIntentOverlay([
                { id: 'entry-1', voyageId: 'voyage-1', timestamp: '2026-07-23T00:00:00.000Z', archived: false },
            ]),
        ).resolves.toEqual([expect.objectContaining({ id: 'entry-1', archived: true })]);

        await setVoyageArchivedInOfflineQueue('voyage-1', false);
        await expect(
            applyVoyageArchiveIntentOverlay([
                { id: 'entry-1', voyageId: 'voyage-1', timestamp: '2026-07-23T00:00:00.000Z', archived: true },
            ]),
        ).resolves.toEqual([expect.objectContaining({ id: 'entry-1', archived: false })]);
    });

    it('rejects an archive command queued after a stable voyage deletion', async () => {
        await deleteVoyageFromOfflineQueue('deleted-voyage');

        await expect(setVoyageArchivedInOfflineQueue('deleted-voyage', true)).rejects.toThrow(
            'has been deleted and cannot be archived',
        );
    });

    it('recovers queue state from the outbox when the large generation rewrite fails', async () => {
        await queueOfflineEntry(
            { id: 'entry-1', voyageId: 'voyage-1', timestamp: '2026-07-23T00:00:00.000Z', archived: false },
            { operationId: 'archive-recovery-entry' },
        );
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            if (key.includes('ship_log_offline_queue') && key.includes(':v3:')) {
                throw new Error('simulated queue rewrite failure');
            }
            store[key] = value;
        });

        await expect(setVoyageArchivedInOfflineQueue('voyage-1', true)).resolves.toEqual(
            expect.objectContaining({ voyageId: 'voyage-1', archived: true }),
        );

        __resetOfflineQueueForTests();
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        });
        await expect(getOfflineEntries()).resolves.toEqual([
            expect.objectContaining({ id: 'offline_archive-recovery-entry', archived: true }),
        ]);
    });
});

describe('getOfflineEntries', () => {
    it('returns entries with temporary IDs', async () => {
        await queueOfflineEntry({ voyageId: 'v1', latitude: -27.47 });
        const entries = await getOfflineEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toMatch(/^offline_[A-Za-z0-9_-]+$/);
        expect(entries[0].latitude).toBe(-27.47);
    });

    it('uses a stable queue-addressable display id across reloads', async () => {
        await queueOfflineEntry({ voyageId: 'v1', latitude: -27.47 });
        await flushOfflineQueueToDisk();
        const beforeReload = await getOfflineEntries();

        __resetOfflineQueueForTests();
        const afterReload = await getOfflineEntries();
        expect(afterReload[0].id).toBe(beforeReload[0].id);

        expect(await deleteEntryFromOfflineQueue(afterReload[0].id)).toBe(true);
        expect(await getOfflineQueueCount()).toBe(0);
    });

    it('persists a segmented manifest instead of one unbounded queue value', async () => {
        await queueOfflineEntry({ voyageId: 'v1', latitude: -27.47 });
        await flushOfflineQueueToDisk();

        const queueKey = authScopedStorageKey('ship_log_offline_queue', getAuthIdentityScope());
        const manifest = JSON.parse(store[queueKey]) as {
            version: number;
            generation: string;
            segment_count: number;
            entry_count: number;
        };
        expect(manifest).toMatchObject({ version: 3, segment_count: 1, entry_count: 1 });
        expect(store[`${queueKey}:v3:${manifest.generation}:0`]).toContain('"voyageId":"v1"');
    });

    it('retains every point across a segment boundary and process reload', async () => {
        for (let index = 0; index < 501; index++) {
            await queueOfflineEntry({
                voyageId: 'long-voyage',
                notes: `point-${index}`,
                timestamp: new Date(1_750_000_000_000 + index * 1000).toISOString(),
            });
        }
        await flushOfflineQueueToDisk();

        __resetOfflineQueueForTests();
        const restored = await getOfflineEntries();
        expect(restored).toHaveLength(501);
        expect(restored[0].notes).toBe('point-0');
        expect(restored[500].notes).toBe('point-500');
    });

    it('returns empty array when queue is empty', async () => {
        const entries = await getOfflineEntries();
        expect(entries).toEqual([]);
    });
});

describe('getOfflineQueueCount', () => {
    it('returns 0 when queue is empty', async () => {
        const count = await getOfflineQueueCount();
        expect(count).toBe(0);
    });

    it('never overwrites an unreadable scoped queue while adopting legacy data', async () => {
        const scopedKey = authScopedStorageKey('ship_log_offline_queue', getAuthIdentityScope());
        store[scopedKey] = '{corrupt scoped queue';
        store.ship_log_offline_queue = JSON.stringify([
            {
                owner_user_id: null,
                queue_id: 'legacy-operation',
                voyageId: 'legacy-voyage',
            },
        ]);

        await expect(getOfflineQueueCount()).rejects.toThrow();
        expect(store[scopedKey]).toBe('{corrupt scoped queue');
        expect(store.ship_log_offline_queue).toContain('legacy-operation');
    });

    it('deduplicates owner-known legacy adoption after a partial migration failure', async () => {
        store.ship_log_offline_queue = JSON.stringify([
            {
                owner_user_id: null,
                voyageId: 'legacy-voyage',
                timestamp: '2025-01-01T00:00:00.000Z',
            },
        ]);
        let failLegacyRemoval = true;
        vi.mocked(Preferences.remove).mockImplementation(async ({ key }: { key: string }) => {
            if (key === 'ship_log_offline_queue' && failLegacyRemoval) {
                failLegacyRemoval = false;
                throw new Error('simulated interruption after scoped adoption');
            }
            delete store[key];
        });

        await expect(getOfflineQueueCount()).rejects.toThrow('simulated interruption');
        __resetOfflineQueueForTests();
        await expect(getOfflineQueueCount()).resolves.toBe(1);

        const entries = await getOfflineEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toMatch(/^offline_legacy_/);
    });
});

describe('offline queue capacity', () => {
    it('rejects the new append explicitly instead of evicting retained history', () => {
        expect(() => assertOfflineQueueCapacity(OFFLINE_QUEUE_CAPACITY - 1)).not.toThrow();
        expect(() => assertOfflineQueueCapacity(OFFLINE_QUEUE_CAPACITY)).toThrow(OfflineQueueCapacityError);
    });
});

describe('deleteEntryFromOfflineQueue', () => {
    it('removes entry by ID', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1' });
        await queueOfflineEntry({ id: 'e2', voyageId: 'v1' });

        const deleted = await deleteEntryFromOfflineQueue('e1');
        expect(deleted).toBe(true);

        const count = await getOfflineQueueCount();
        expect(count).toBe(1);

        const entries = await getOfflineEntries();
        expect(entries[0].voyageId).toBe('v1');
    });

    it('returns false for non-existent entry', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1' });
        const deleted = await deleteEntryFromOfflineQueue('non-existent');
        expect(deleted).toBe(false);
    });

    it('keeps a delete accepted when queue compaction fails after the durable tombstone', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1' }, { operationId: 'durable-delete' });
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            if (key.includes('ship_log_offline_queue') && key.includes(':v3:')) {
                throw new Error('simulated queue rewrite failure');
            }
            store[key] = value;
        });

        await expect(deleteEntryFromOfflineQueue('offline_durable-delete')).resolves.toBe(true);

        // The old queue generation survives the failed rewrite, but a cold
        // start still hides it and sync will never replay it.
        __resetOfflineQueueForTests();
        vi.mocked(Preferences.set).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            store[key] = value;
        });
        expect(await getOfflineQueueCount()).toBe(0);
        expect(await getOfflineEntries()).toEqual([]);
    });
});

describe('deleteVoyageFromOfflineQueue', () => {
    it('removes all entries for a voyage', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: 'v1' });
        await queueOfflineEntry({ id: 'e2', voyageId: 'v1' });
        await queueOfflineEntry({ id: 'e3', voyageId: 'v2' });

        const deleted = await deleteVoyageFromOfflineQueue('v1');
        expect(deleted).toBe(true);

        const count = await getOfflineQueueCount();
        expect(count).toBe(1);

        const entries = await getOfflineEntries();
        expect(entries[0].voyageId).toBe('v2');
    });

    it('handles default_voyage by removing entries with empty/null voyageId', async () => {
        await queueOfflineEntry({ id: 'e1', voyageId: '' });
        await queueOfflineEntry({ id: 'e2', voyageId: 'v1' });

        const deleted = await deleteVoyageFromOfflineQueue('default_voyage');
        expect(deleted).toBe(true);

        const count = await getOfflineQueueCount();
        expect(count).toBe(1);
    });

    it('treats default_voyage deletion as a time boundary so future ungrouped captures remain possible', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime('2026-07-24T00:00:00.000Z');
            await queueOfflineEntry({ id: 'old', voyageId: '', timestamp: '2025-01-01T00:00:00.000Z' });
            await setVoyageArchivedInOfflineQueue('default_voyage', true);
            await deleteVoyageFromOfflineQueue('default_voyage');
            const archiveIntentKey = authScopedStorageKey('ship_log_voyage_archive_intents', getAuthIdentityScope());
            expect(JSON.parse(store[archiveIntentKey])['default_voyage']).toBeUndefined();

            vi.advanceTimersByTime(1000);
            await queueOfflineEntry({
                id: 'new',
                voyageId: '',
                timestamp: new Date().toISOString(),
            });

            expect(await getOfflineQueueCount()).toBe(1);
            const futureEntry = (await getOfflineEntries())[0];
            expect(futureEntry.id).toContain('offline_');
            expect(futureEntry.archived).not.toBe(true);

            vi.advanceTimersByTime(1000);
            await deleteVoyageFromOfflineQueue('default_voyage');
            expect(await getOfflineQueueCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('infers and preserves planned-route cascade metadata from the durable local track', async () => {
        const voyageId = 'planned_1750000000000_route';
        await queueOfflineEntry({
            voyageId,
            waypointName: 'Brisbane',
            timestamp: '2025-06-15T00:00:00.000Z',
        });
        await queueOfflineEntry({
            voyageId,
            waypointName: 'Moreton',
            timestamp: '2025-06-15T01:00:00.000Z',
        });

        await deleteVoyageFromOfflineQueue(voyageId);
        await deleteVoyageFromOfflineQueue(voyageId); // idempotent retry must not erase metadata

        const tombstoneKey = authScopedStorageKey('ship_log_deleted_voyages', getAuthIdentityScope());
        expect(JSON.parse(store[tombstoneKey])[voyageId]).toMatchObject({
            planned_route_name: 'Brisbane → Moreton',
            planned_route_day: '2025-06-15',
        });
    });

    it('durably accepts an idempotent delete even when no local entries remain', async () => {
        const deleted = await deleteVoyageFromOfflineQueue('nonexistent');
        expect(deleted).toBe(true);
    });
});
