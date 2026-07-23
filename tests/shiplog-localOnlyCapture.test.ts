/**
 * Tests for local-only capture mode — while a voyage records, every entry
 * goes to the device (offline queue) with ZERO network on the capture path;
 * the rolling-waypoint demotion happens in-queue instead of via a DB UPDATE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Spies for queue ops ----
const mockQueueOfflineEntry = vi.fn(async (_e: unknown, _options?: unknown) => 'queued-operation');
const mockDemoteInQueue = vi.fn(async (_v: string) => {});
// The capture-local-only flag lives in OfflineQueue (EntrySave re-exports
// it); mirror its real behaviour so the round-trip tests stay meaningful.
const mockLocalOnlyFlag = { value: false };
vi.mock('../services/shiplog/OfflineQueue', () => ({
    queueOfflineEntry: (e: unknown, options?: unknown) => mockQueueOfflineEntry(e, options),
    demoteLatestPositionInQueue: (v: string) => mockDemoteInQueue(v),
    runVoyageCloudMutation: async <T>(
        _voyageId: string,
        _scope: unknown,
        timeoutMs: number,
        operation: (signal: AbortSignal) => PromiseLike<T>,
    ): Promise<T | null> => {
        const controller = new AbortController();
        return Promise.race([
            Promise.resolve(operation(controller.signal)),
            new Promise<null>((resolve) => {
                setTimeout(() => {
                    controller.abort();
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    },
    setCaptureLocalOnly: (enabled: boolean) => {
        mockLocalOnlyFlag.value = enabled;
    },
    isCaptureLocalOnly: () => mockLocalOnlyFlag.value,
}));

// ---- Supabase mock: track whether the network path was touched ----
const mockSingle = vi.fn(async () => ({
    data: { id: 'db-1', voyage_id: 'v1', timestamp: '2026-06-01T00:00:00Z' },
    error: null,
}));
const mockUpsert = vi.fn((_row: unknown, _options?: unknown) => {
    const query = {
        abortSignal: vi.fn(),
        select: vi.fn(),
    };
    query.abortSignal.mockReturnValue(query);
    query.select.mockReturnValue({
        single: mockSingle,
    });
    return query;
});
const mockFrom = vi.fn(() => ({
    upsert: mockUpsert,
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
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getCurrentUser } from '../services/supabase';

const mockGetCurrentUser = vi.mocked(getCurrentUser);
type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;

beforeEach(() => {
    setAuthIdentityScope('user-1');
    mockGetCurrentUser.mockReset().mockResolvedValue({ id: 'user-1' } as CurrentUser);
    setCaptureLocalOnly(false);
    mockQueueOfflineEntry.mockClear();
    mockDemoteInQueue.mockClear();
    mockFrom.mockClear();
    mockUpsert.mockClear();
    mockSingle.mockReset().mockResolvedValue({
        data: { id: 'db-1', voyage_id: 'v1', timestamp: '2026-06-01T00:00:00Z' },
        error: null,
    });
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

    it('requests one atomic demote+append for a new rolling Latest Position', async () => {
        setCaptureLocalOnly(true);
        await saveEntryOnlineOrOffline({
            voyageId: 'v1',
            entryType: 'waypoint',
            waypointName: 'Latest Position',
            timestamp: '2026-06-01T00:00:01Z',
        });

        expect(mockQueueOfflineEntry).toHaveBeenCalledWith(
            expect.objectContaining({ voyageId: 'v1', waypointName: 'Latest Position' }),
            expect.objectContaining({ demotePreviousLatestForVoyage: 'v1' }),
        );
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

    it('drops a deferred A online save when auth switches to B', async () => {
        let release!: (user: CurrentUser) => void;
        mockGetCurrentUser.mockImplementationOnce(
            () =>
                new Promise<CurrentUser>((resolve) => {
                    release = resolve;
                }),
        );

        const pending = saveEntryOnlineOrOffline({
            voyageId: 'voyage-a',
            timestamp: '2026-06-01T00:00:00Z',
        });
        await Promise.resolve();
        setAuthIdentityScope('user-2');
        release({ id: 'user-1' } as CurrentUser);

        await expect(pending).resolves.toMatchObject({ saved: null, entryId: null });
        expect(mockFrom).not.toHaveBeenCalled();
        expect(mockQueueOfflineEntry).not.toHaveBeenCalled();
    });

    it('preserves one operation id when a timed-out insert commits late and is queued for replay', async () => {
        vi.useFakeTimers();
        let release!: (value: { data: { id: string; voyage_id: string; timestamp: string }; error: null }) => void;
        mockSingle.mockReturnValueOnce(
            new Promise((resolve) => {
                release = resolve;
            }),
        );

        const pending = saveEntryOnlineOrOffline({
            voyageId: 'v1',
            timestamp: '2026-06-01T00:00:00Z',
        });
        await vi.advanceTimersByTimeAsync(5000);
        await expect(pending).resolves.toMatchObject({ wasOffline: true });

        const sentRow = mockUpsert.mock.calls[0][0] as Record<string, unknown>;
        const queueOptions = mockQueueOfflineEntry.mock.calls[0][1] as { operationId: string };
        expect(sentRow.client_operation_id).toBe(queueOptions.operationId);

        // Simulate the request completing after the timeout. Its unique
        // operation key is identical to replay's, so the DB cannot duplicate.
        release({
            data: { id: 'db-late', voyage_id: 'v1', timestamp: '2026-06-01T00:00:00Z' },
            error: null,
        });
        await Promise.resolve();
        vi.useRealTimers();
    });
});
