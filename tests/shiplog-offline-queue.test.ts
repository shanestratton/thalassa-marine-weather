/**
 * Unit Tests for Offline Queue Manager
 * Tests queue operations with mocked @capacitor/preferences (in-memory store)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    queueOfflineEntry,
    getOfflineQueueCount,
    getOfflineEntries,
    deleteEntryFromOfflineQueue,
    deleteVoyageFromOfflineQueue,
} from '../services/shiplog/OfflineQueue';

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
});

describe('getOfflineEntries', () => {
    it('returns entries with temporary IDs', async () => {
        await queueOfflineEntry({ voyageId: 'v1', latitude: -27.47 });
        const entries = await getOfflineEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toMatch(/^offline_/);
        expect(entries[0].latitude).toBe(-27.47);
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

    it('returns false when no entries to delete', async () => {
        const deleted = await deleteVoyageFromOfflineQueue('nonexistent');
        expect(deleted).toBe(false);
    });
});
