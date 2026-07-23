import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state = {
        prefs: new Map<string, string>(),
        schedulerTick: null as null | (() => unknown),
        trackBuffer: null as null | {
            push: (position: unknown) => void;
            drain: () => unknown[];
            clear: () => void;
            readonly length: number;
        },
        blockStoppedStateWrite: false,
        releaseStoppedStateWrite: null as null | (() => void),
        gpsOptions: null as null | {
            onFix: (position: unknown) => void;
            onSpeedTierChanged: () => void;
            onHeartbeatTick: () => void;
        },
    };
    return {
        state,
        schedulerStop: vi.fn(),
        gpsStop: vi.fn(),
        nativeStop: vi.fn(async () => undefined),
        captureImmediate: vi.fn(async () => null),
        flushBuffered: vi.fn(async () => 'complete'),
        syncQueue: vi.fn(async () => 0),
        purge: vi.fn(async () => true),
        cache: vi.fn(async () => undefined),
        disarmTrickle: vi.fn(),
        stopTrickle: vi.fn(async () => undefined),
    };
});

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: mocks.state.prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            if (
                mocks.state.blockStoppedStateWrite &&
                key.startsWith('ship_log_tracking_state') &&
                value.includes('"voyageEndTime"')
            ) {
                await new Promise<void>((resolve) => {
                    mocks.state.releaseStoppedStateWrite = resolve;
                });
            }
            mocks.state.prefs.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            mocks.state.prefs.delete(key);
        },
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/app', () => ({
    App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: vi.fn(async () => undefined),
        requestStart: vi.fn(async () => undefined),
        requestStop: mocks.nativeStop,
        isNativeTrackingEnabled: vi.fn(async () => false),
        setSamplingMode: vi.fn(async () => undefined),
    },
}));

vi.mock('../services/EnvironmentService', () => ({
    EnvironmentService: { updateWaterStatus: vi.fn() },
}));

vi.mock('../services/shiplog/AdaptiveScheduler', () => ({
    AdaptiveScheduler: class {
        scheduleClockAligned(_interval: number, callback: () => unknown) {
            mocks.state.schedulerTick = callback;
        }
        scheduleEvery(_interval: number, callback: () => unknown) {
            mocks.state.schedulerTick = callback;
        }
        stop() {
            mocks.schedulerStop();
        }
        isRunning() {
            return false;
        }
    },
}));

vi.mock('../services/shiplog/GpsSubscriptionManager', () => ({
    GpsSubscriptionManager: class {
        start(options: typeof mocks.state.gpsOptions) {
            mocks.state.gpsOptions = options;
        }
        stop() {
            mocks.gpsStop();
        }
    },
}));

vi.mock('../services/shiplog/GpsTrackBuffer', () => ({
    GpsTrackBuffer: class {
        private points: unknown[] = [];
        constructor() {
            mocks.state.trackBuffer = this;
        }
        push(position: unknown) {
            this.points.push(position);
        }
        drain() {
            const points = this.points;
            this.points = [];
            return points;
        }
        clear() {
            this.points = [];
        }
        get length() {
            return this.points.length;
        }
    },
}));

vi.mock('../services/shiplog/CourseChangeDetector', () => ({
    CourseChangeDetector: class {
        start = vi.fn();
        stop = vi.fn();
        reset = vi.fn();
    },
}));

vi.mock('../services/shiplog/EnvironmentPoller', () => ({
    EnvironmentPoller: class {
        start = vi.fn();
        stop = vi.fn();
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: { reset: vi.fn() },
}));

vi.mock('../services/shiplog/CapturePipeline', () => ({
    captureImmediate: mocks.captureImmediate,
    captureLog: vi.fn(async () => null),
    addManual: vi.fn(async () => null),
    flushBufferedTrack: mocks.flushBuffered,
    drainBufferedTrackForHandoff: (buffer: { drain: () => unknown[] }) => buffer.drain(),
}));

vi.mock('../services/shiplog/PositionResolver', () => ({
    getGpsStatus: vi.fn(() => 'none'),
    getGpsNavData: vi.fn(() => ({ sogKts: null, cogDeg: null })),
}));

vi.mock('../services/shiplog/EntrySave', () => ({
    setCaptureLocalOnly: vi.fn(),
}));

vi.mock('../services/shiplog/LiveTrickle', () => ({
    startLiveTrickle: vi.fn(),
    stopLiveTrickle: mocks.stopTrickle,
    purgeLiveTrack: mocks.purge,
    disarmLiveTrickleForIdentityChange: mocks.disarmTrickle,
}));

vi.mock('../services/shiplog/OfflineQueue', () => ({
    syncOfflineQueue: mocks.syncQueue,
    getOfflineQueueCount: vi.fn(async () => 0),
    getOfflineEntries: vi.fn(async () => []),
    deleteVoyageFromOfflineQueue: vi.fn(async () => false),
    flushOfflineQueueToDisk: vi.fn(async () => undefined),
}));

vi.mock('../services/shiplog/VoyageTrackCache', () => ({
    setCachedVoyageTrack: mocks.cache,
}));

vi.mock('../services/shiplog/EntryCrud', () => ({
    getLogEntries: vi.fn(async () => []),
    getArchivedEntries: vi.fn(async () => []),
    getAllEntriesForCareer: vi.fn(async () => []),
    archiveVoyage: vi.fn(async () => true),
    unarchiveVoyage: vi.fn(async () => true),
    deleteVoyage: vi.fn(async () => true),
    deleteEntry: vi.fn(async () => true),
    importGPXVoyage: vi.fn(async () => ({ voyageId: 'v', savedCount: 0 })),
}));

vi.mock('../services/shiplog/VoyageSummary', () => ({
    getVoyageSummaries: vi.fn(async () => []),
    getCachedVoyageSummaries: vi.fn(async () => []),
    getVoyageEntries: vi.fn(async () => []),
    EMPTY_TRACK_NM: 0.01,
}));

vi.mock('../services/shiplog/PassagePlanSave', () => ({
    savePassagePlanToLogbook: vi.fn(async () => null),
}));

import { ShipLogService } from '../services/ShipLogService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

beforeAll(() => {
    vi.useFakeTimers();
});

afterAll(() => {
    vi.useRealTimers();
});

describe('ShipLogService tracking owner fence', () => {
    it('synchronously disarms A on A→B, rejects stale callbacks/B stop, and resumes A as paused', async () => {
        setAuthIdentityScope('ship-owner-a');
        await ShipLogService.initialize();
        await ShipLogService.startTracking(false);

        const activeA = ShipLogService.getTrackingStatus();
        expect(activeA.isTracking).toBe(true);
        expect(activeA.currentVoyageId).toMatch(/^voyage_/);
        const staleSchedulerTick = mocks.state.schedulerTick;
        const staleGpsOptions = mocks.state.gpsOptions;
        const flushesBeforeSwitch = mocks.flushBuffered.mock.calls.length;
        const endCapturesBeforeSwitch = mocks.captureImmediate.mock.calls.length;
        mocks.state.trackBuffer?.push({
            latitude: -27.5,
            longitude: 153,
            accuracy: 5,
            altitude: null,
            heading: 0,
            speed: 2,
            timestamp: Date.now(),
            receivedAt: Date.now(),
        });

        setAuthIdentityScope('ship-owner-b');
        for (let i = 0; i < 8; i++) await Promise.resolve();

        expect(ShipLogService.getTrackingStatus()).toEqual({
            isTracking: false,
            isPaused: false,
            isRapidMode: false,
        });
        expect(mocks.schedulerStop).toHaveBeenCalled();
        expect(mocks.gpsStop).toHaveBeenCalled();
        expect(mocks.disarmTrickle).toHaveBeenCalled();
        expect(mocks.nativeStop).toHaveBeenCalled();
        const handoff = [...mocks.state.prefs.entries()].find(([key]) =>
            key.startsWith('ship_log_capture_handoff::user%3Aship-owner-a'),
        );
        expect(handoff).toBeDefined();
        expect(JSON.parse(handoff![1])).toMatchObject({
            ownerKey: 'user:ship-owner-a',
            ownerUserId: 'ship-owner-a',
            batches: [{ voyageId: activeA.currentVoyageId }],
        });

        await staleSchedulerTick?.();
        staleGpsOptions?.onHeartbeatTick();
        staleGpsOptions?.onSpeedTierChanged();
        await Promise.resolve();
        expect(mocks.flushBuffered).toHaveBeenCalledTimes(flushesBeforeSwitch);

        await ShipLogService.stopTracking();
        expect(mocks.captureImmediate).toHaveBeenCalledTimes(endCapturesBeforeSwitch);
        expect(mocks.stopTrickle).not.toHaveBeenCalled();
        expect(mocks.purge).not.toHaveBeenCalled();
        expect(mocks.cache).not.toHaveBeenCalled();

        // Let the transition-only A persistence write settle, then return.
        await Promise.resolve();
        setAuthIdentityScope('ship-owner-a');
        await ShipLogService.initialize();

        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            currentVoyageId: activeA.currentVoyageId,
            voyageStartTime: activeA.voyageStartTime,
        });
        expect(ShipLogService.getTrackingStatus().voyageEndTime).toBeUndefined();
    });

    it('rejects an old scheduler callback after pause/resume in the same account generation', async () => {
        const voyageId = ShipLogService.getTrackingStatus().currentVoyageId;
        await ShipLogService.startTracking(true, voyageId);
        const staleTick = mocks.state.schedulerTick;

        await ShipLogService.pauseTracking();
        await ShipLogService.startTracking(true, voyageId);
        const before = mocks.flushBuffered.mock.calls.length;
        await staleTick?.();

        expect(mocks.flushBuffered).toHaveBeenCalledTimes(before);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: true,
            currentVoyageId: voyageId,
        });
    });

    it('does not let a delayed same-account stop tear down a concurrent resume', async () => {
        const voyageId = ShipLogService.getTrackingStatus().currentVoyageId;
        mocks.state.blockStoppedStateWrite = true;
        const stopping = ShipLogService.stopTracking();

        for (let i = 0; i < 100 && ShipLogService.getTrackingStatus().isTracking; i++) {
            await Promise.resolve();
        }
        expect(ShipLogService.getTrackingStatus().isTracking).toBe(false);

        const restarting = ShipLogService.startTracking(true, voyageId);
        await Promise.resolve();
        mocks.state.blockStoppedStateWrite = false;
        mocks.state.releaseStoppedStateWrite?.();
        await Promise.all([stopping, restarting]);

        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: true,
            currentVoyageId: voyageId,
        });
        expect(mocks.state.gpsOptions).not.toBeNull();
    });
});
