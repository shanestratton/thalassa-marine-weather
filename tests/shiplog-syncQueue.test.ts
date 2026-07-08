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

// ---- Supabase mock: capture inserts, controllable failure ----
const insertCalls: Record<string, unknown>[][] = [];
let failOnInsertCall = -1; // index of insert call to fail (-1 = never)
const mockInsert = vi.fn(async (rows: Record<string, unknown>[]) => {
    const callIdx = insertCalls.length;
    insertCalls.push(rows);
    if (callIdx === failOnInsertCall) return { error: { message: 'boom' } };
    return { error: null };
});
let mockUser: { id: string } | null = { id: 'user-1' };

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => ({ insert: (rows: Record<string, unknown>[]) => mockInsert(rows) }),
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
    __resetOfflineQueueForTests,
} from '../services/shiplog/OfflineQueue';
import type { ShipLogEntry } from '../types';

const entry = (o: Partial<ShipLogEntry> = {}): Partial<ShipLogEntry> => ({
    voyageId: 'v1',
    timestamp: '2026-06-01T00:00:00.000Z',
    latitude: -27.5,
    longitude: 153.0,
    entryType: 'auto',
    ...o,
});

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    // Module-level queue cache (c516385f) — must drop it so tests that
    // seed the mocked Preferences store directly are actually re-read.
    __resetOfflineQueueForTests();
    insertCalls.length = 0;
    failOnInsertCall = -1;
    mockUser = { id: 'user-1' };
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

    it('returns 0 and keeps the queue when signed out', async () => {
        mockUser = null;
        await queueOfflineEntry(entry());
        const synced = await syncOfflineQueue();
        expect(synced).toBe(0);
        expect(insertCalls.length).toBe(0);
        expect(await getOfflineQueueCount()).toBe(1);
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
    it('demotes only the matching voyage, in place', async () => {
        await queueOfflineEntry(entry({ voyageId: 'a', entryType: 'waypoint', waypointName: 'Latest Position' }));
        await queueOfflineEntry(entry({ voyageId: 'b', entryType: 'waypoint', waypointName: 'Latest Position' }));

        await demoteLatestPositionInQueue('a');

        const entries = await getOfflineEntries();
        const a = entries.find((e) => e.voyageId === 'a')!;
        const b = entries.find((e) => e.voyageId === 'b')!;
        expect(a.entryType).toBe('auto');
        expect(a.waypointName).toBeUndefined();
        expect(b.waypointName).toBe('Latest Position');
    });
});
