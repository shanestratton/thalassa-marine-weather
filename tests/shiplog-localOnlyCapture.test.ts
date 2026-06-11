/**
 * Tests for local-only capture mode — while a voyage records, every entry
 * goes to the device (offline queue) with ZERO network on the capture path;
 * the rolling-waypoint demotion happens in-queue instead of via a DB UPDATE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Spies for queue ops ----
const mockQueueOfflineEntry = vi.fn(async (_e: unknown) => {});
const mockDemoteInQueue = vi.fn(async (_v: string) => {});
// The capture-local-only flag lives in OfflineQueue (EntrySave re-exports
// it); mirror its real behaviour so the round-trip tests stay meaningful.
const mockLocalOnlyFlag = { value: false };
vi.mock('../services/shiplog/OfflineQueue', () => ({
    queueOfflineEntry: (e: unknown) => mockQueueOfflineEntry(e),
    demoteLatestPositionInQueue: (v: string) => mockDemoteInQueue(v),
    setCaptureLocalOnly: (enabled: boolean) => {
        mockLocalOnlyFlag.value = enabled;
    },
    isCaptureLocalOnly: () => mockLocalOnlyFlag.value,
}));

// ---- Supabase mock: track whether the network path was touched ----
const mockFrom = vi.fn(() => ({
    insert: vi.fn(() => ({
        select: vi.fn(() => ({
            single: vi.fn(async () => ({
                data: { id: 'db-1', voyage_id: 'v1', timestamp: '2026-06-01T00:00:00Z' },
                error: null,
            })),
        })),
    })),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => ({ data: [] })),
}));
vi.mock('../services/supabase', () => ({
    supabase: { from: () => mockFrom() },
    getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
    getCurrentUserId: vi.fn(async () => 'user-1'),
}));

// Native deps EntrySave pulls in — irrelevant here
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getFreshPosition: vi.fn(async () => null) } }));
vi.mock('../services/GpsService', () => ({ GpsService: { getCurrentPosition: vi.fn(async () => null) } }));
vi.mock('../utils/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    setCaptureLocalOnly,
    isCaptureLocalOnly,
    saveEntryOnlineOrOffline,
    demotePreviousAutoWaypoint,
} from '../services/shiplog/EntrySave';

beforeEach(() => {
    setCaptureLocalOnly(false);
    mockQueueOfflineEntry.mockClear();
    mockDemoteInQueue.mockClear();
    mockFrom.mockClear();
});

describe('local-only capture mode', () => {
    it('flag round-trips', () => {
        expect(isCaptureLocalOnly()).toBe(false);
        setCaptureLocalOnly(true);
        expect(isCaptureLocalOnly()).toBe(true);
    });

    it('queues to device and NEVER touches Supabase while recording', async () => {
        setCaptureLocalOnly(true);
        const result = await saveEntryOnlineOrOffline({ voyageId: 'v1', timestamp: '2026-06-01T00:00:00Z' });

        expect(result.wasOffline).toBe(true);
        expect(result.entryId).toBeNull();
        expect(mockQueueOfflineEntry).toHaveBeenCalledTimes(1);
        expect(mockFrom).not.toHaveBeenCalled(); // zero network on capture path
    });

    it('uses the normal online path when not recording', async () => {
        setCaptureLocalOnly(false);
        const result = await saveEntryOnlineOrOffline({ voyageId: 'v1', timestamp: '2026-06-01T00:00:00Z' });

        expect(result.wasOffline).toBe(false);
        expect(result.entryId).toBe('db-1');
        expect(mockQueueOfflineEntry).not.toHaveBeenCalled();
    });

    it('demotes rolling waypoints IN-QUEUE (no DB UPDATE) while recording', async () => {
        setCaptureLocalOnly(true);
        await demotePreviousAutoWaypoint('v1');

        expect(mockDemoteInQueue).toHaveBeenCalledWith('v1');
        expect(mockFrom).not.toHaveBeenCalled();
    });

    it('demotes via the DB when not recording', async () => {
        setCaptureLocalOnly(false);
        await demotePreviousAutoWaypoint('v1');

        expect(mockDemoteInQueue).not.toHaveBeenCalled();
        expect(mockFrom).toHaveBeenCalled();
    });
});
