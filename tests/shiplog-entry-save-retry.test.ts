import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateResults: Array<Promise<{ error: { message: string } | null }> | { error: { message: string } | null }> = [];
let updateCalls = 0;
let abortCalls = 0;
const updatePayloads: Record<string, unknown>[] = [];

vi.mock('../services/shiplog/OfflineQueue', () => ({
    queueOfflineEntry: vi.fn(),
    demoteLatestPositionInQueue: vi.fn(),
    runVoyageCloudMutation: vi.fn(),
    setCaptureLocalOnly: vi.fn(),
    isCaptureLocalOnly: vi.fn(() => false),
}));

vi.mock('../services/supabase', () => ({
    getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
    supabase: {
        from: () => {
            const query = {
                update: vi.fn(),
                eq: vi.fn(),
                abortSignal: vi.fn(),
                then: (
                    onFulfilled: (value: { error: { message: string } | null }) => unknown,
                    onRejected?: (reason: unknown) => unknown,
                ) => Promise.resolve(updateResults.shift() ?? { error: null }).then(onFulfilled, onRejected),
            };
            query.update.mockImplementation((payload: Record<string, unknown>) => {
                updateCalls++;
                updatePayloads.push(payload);
                return query;
            });
            query.eq.mockReturnValue(query);
            query.abortSignal.mockImplementation((signal: AbortSignal) => {
                signal.addEventListener('abort', () => {
                    abortCalls++;
                });
                return query;
            });
            return query;
        },
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getFreshPosition: vi.fn(async () => ({
            latitude: -27.47,
            longitude: 153.02,
            heading: 90,
        })),
    },
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: vi.fn(async () => null),
    },
}));

vi.mock('../services/shiplog/LiveTrickle', () => ({
    noteLiveTrickleHeartbeat: vi.fn(),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { satelliteMode: false } }),
    },
}));

vi.mock('../utils/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { retryGpsAndUpdateEntry } from '../services/shiplog/EntrySave';
import { BgGeoManager } from '../services/BgGeoManager';
import { setAuthIdentityScope } from '../services/authIdentityScope';

beforeEach(() => {
    updateResults.length = 0;
    updateCalls = 0;
    abortCalls = 0;
    updatePayloads.length = 0;
    setAuthIdentityScope('user-1');
});

describe('retryGpsAndUpdateEntry', () => {
    it('continues after a transient Supabase update error', async () => {
        vi.useFakeTimers();
        updateResults.push({ error: { message: 'temporary failure' } }, { error: null });

        const retrying = retryGpsAndUpdateEntry('entry-1');
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(retrying).resolves.toBeUndefined();

        expect(updateCalls).toBe(2);
        vi.useRealTimers();
    });

    it('aborts a hung update and uses the next retry slot', async () => {
        vi.useFakeTimers();
        updateResults.push(
            new Promise(() => {
                /* intentionally never settles */
            }),
            { error: null },
        );

        const retrying = retryGpsAndUpdateEntry('entry-1');
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(retrying).resolves.toBeUndefined();

        expect(abortCalls).toBe(1);
        expect(updateCalls).toBe(2);
        vi.useRealTimers();
    });

    it('persists a valid due-north heading of zero degrees', async () => {
        vi.useFakeTimers();
        vi.mocked(BgGeoManager.getFreshPosition).mockResolvedValueOnce({
            latitude: -27.47,
            longitude: 153.02,
            heading: 0,
        } as Awaited<ReturnType<typeof BgGeoManager.getFreshPosition>>);

        const retrying = retryGpsAndUpdateEntry('entry-1');
        await vi.advanceTimersByTimeAsync(5000);
        await expect(retrying).resolves.toBeUndefined();

        expect(updatePayloads[0]).toMatchObject({ course_deg: 0 });
        vi.useRealTimers();
    });
});
