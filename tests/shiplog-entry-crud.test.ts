/**
 * Unit Tests for Entry CRUD Operations
 * Tests database read/write/delete with mocked Supabase client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getLogEntries,
    deleteVoyage,
    deleteEntry,
    importGPXVoyage,
} from '../services/shiplog/EntryCrud';

// ---- Mock Supabase ----
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const mockEq = vi.fn();
const mockOr = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

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
}));

// ---- Helpers ----

function setupChainedQuery(data: unknown[] | null, error: unknown = null) {
    const chain = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data, error }),
        delete: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockResolvedValue({ error }),
    };
    mockFrom.mockReturnValue(chain);
    return chain;
}

function mockAuthUser(userId: string | null) {
    if (userId) {
        mockGetUser.mockResolvedValue({ data: { user: { id: userId } } });
    } else {
        mockGetUser.mockResolvedValue({ data: { user: null } });
    }
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ---- getLogEntries ----

describe('getLogEntries', () => {
    it('returns mapped entries when authenticated', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery([
            { id: 'e1', user_id: 'user-1', voyage_id: 'v1', timestamp: '2025-01-01T00:00:00Z', entry_type: 'auto', source: 'device' },
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

// ---- deleteVoyage ----

describe('deleteVoyage', () => {
    it('calls delete with correct voyage_id', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery(null);
        chain.eq.mockReturnValue(chain);
        chain.eq.mockResolvedValueOnce({ error: null }); // for user_id eq

        const result = await deleteVoyage('v1');
        expect(result).toBe(true);
        expect(mockFrom).toHaveBeenCalledWith('ship_logs');
    });
});

// ---- deleteEntry ----

describe('deleteEntry', () => {
    it('calls delete with correct entry_id', async () => {
        mockAuthUser('user-1');
        const chain = setupChainedQuery(null);
        chain.eq.mockResolvedValue({ error: null });

        const result = await deleteEntry('e1');
        expect(result).toBe(true);
        expect(mockFrom).toHaveBeenCalledWith('ship_logs');
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
        chain.insert.mockResolvedValue({ error: null });

        // Mock crypto.randomUUID
        vi.stubGlobal('crypto', { randomUUID: () => 'mock-uuid' });

        const result = await importGPXVoyage([
            { latitude: -27.47, longitude: 153.02, timestamp: '2025-01-01T00:00:00Z' },
        ]);

        expect(result.savedCount).toBe(1);
        expect(result.voyageId).toBe('mock-uuid');

        // Check insert was called with gpx_import source
        const insertCall = chain.insert.mock.calls[0][0];
        expect(insertCall[0].source).toBe('gpx_import');

        vi.unstubAllGlobals();
    });
});
