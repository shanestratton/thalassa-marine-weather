import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CaptureContext, FlushBufferedTrackResult } from '../services/shiplog/CapturePipeline';

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
        failNextActiveStateWrite: false,
        failPendingTeardownWrites: 0,
        gpsStartError: null as Error | null,
        captureLocalOnly: false,
        gpsOptions: null as null | {
            onFix: (position: unknown) => void;
            onAcceptedFix?: (position: unknown) => void;
            onSpeedTierChanged: () => void;
            onHeartbeatTick: () => void;
            onTrackOpened?: () => void;
        },
    };
    return {
        state,
        schedulerStop: vi.fn(),
        gpsStop: vi.fn(),
        nativeStop: vi.fn<() => Promise<void>>(async () => undefined),
        nativeStart: vi.fn(async () => ({
            supported: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
            active: true,
        })),
        getLeaseState: vi.fn(async () => ({
            supported: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
            active: true,
        })),
        revalidateExistingLease: vi.fn(async () => ({
            supported: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
            active: true,
        })),
        requireAlwaysLocation: vi.fn(async () => undefined),
        nativeTrackingEnabled: vi.fn(async () => false),
        strictNativeTrackingEnabled: vi.fn(async () => false),
        setSamplingMode: vi.fn(async () => undefined),
        captureImmediate: vi.fn<(ctx: CaptureContext, voyageId?: string, waypointLabel?: string) => Promise<null>>(
            async () => null,
        ),
        captureLog: vi.fn(async () => null),
        addManual: vi.fn(async () => null),
        flushBuffered: vi.fn<(ctx: CaptureContext) => Promise<FlushBufferedTrackResult>>(async () => 'complete'),
        syncQueue: vi.fn(async () => 0),
        purge: vi.fn(async () => true),
        cache: vi.fn(async () => undefined),
        disarmTrickle: vi.fn(),
        stopTrickle: vi.fn(async () => undefined),
        retireTrickle: vi.fn(async () => undefined),
        setCaptureLocalOnly: vi.fn((enabled: boolean) => {
            state.captureLocalOnly = enabled;
        }),
    };
});

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: mocks.state.prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            if (
                mocks.state.failPendingTeardownWrites > 0 &&
                key.startsWith('ship_log_tracking_state') &&
                value.includes('"nativeTeardownPending":"release-only"')
            ) {
                mocks.state.failPendingTeardownWrites -= 1;
                throw new Error('Pending teardown Preferences write failed');
            }
            if (
                mocks.state.failNextActiveStateWrite &&
                key.startsWith('ship_log_tracking_state') &&
                value.includes('"isTracking":true')
            ) {
                mocks.state.failNextActiveStateWrite = false;
                throw new Error('Preferences write failed');
            }
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
vi.mock('../services/piTls', () => ({
    piRequest: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    piPairingFetch: async () => ({ status: 599, headers: {}, data: '', peerSpki: '' }),
    isPinnedTransportAvailable: () => false,
}));

vi.mock('@capacitor/app', () => ({
    App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: vi.fn(async () => undefined),
        requireAlwaysLocationAuthorization: mocks.requireAlwaysLocation,
        requestStart: mocks.nativeStart,
        requestStop: mocks.nativeStop,
        getLeaseState: mocks.getLeaseState,
        revalidateExistingLease: mocks.revalidateExistingLease,
        isNativeTrackingEnabled: mocks.nativeTrackingEnabled,
        getNativeTrackingEnabledStrict: mocks.strictNativeTrackingEnabled,
        setSamplingMode: mocks.setSamplingMode,
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
        isScheduled() {
            return false;
        }
    },
}));

vi.mock('../services/shiplog/GpsSubscriptionManager', () => ({
    GpsSubscriptionManager: class {
        start(options: typeof mocks.state.gpsOptions) {
            if (mocks.state.gpsStartError) {
                const error = mocks.state.gpsStartError;
                mocks.state.gpsStartError = null;
                throw error;
            }
            mocks.state.gpsOptions = options;
        }
        stop() {
            mocks.gpsStop();
        }
        bufferFinalPoint() {
            return false;
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
        requestCheck = vi.fn();
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: { reset: vi.fn() },
}));

vi.mock('../services/shiplog/CapturePipeline', () => ({
    captureImmediate: mocks.captureImmediate,
    captureLog: mocks.captureLog,
    addManual: mocks.addManual,
    flushBufferedTrack: mocks.flushBuffered,
    drainBufferedTrackForHandoff: (buffer: { drain: () => unknown[] }) => buffer.drain(),
}));

vi.mock('../services/shiplog/PositionResolver', () => ({
    getGpsStatus: vi.fn(() => 'none'),
    getGpsNavData: vi.fn(() => ({ sogKts: null, cogDeg: null })),
}));

vi.mock('../services/shiplog/EntrySave', () => ({
    isCaptureLocalOnly: () => mocks.state.captureLocalOnly,
    setCaptureLocalOnly: mocks.setCaptureLocalOnly,
}));

vi.mock('../services/shiplog/LiveTrickle', () => ({
    startLiveTrickle: vi.fn(),
    stopLiveTrickle: mocks.stopTrickle,
    purgeLiveTrack: mocks.purge,
    disarmLiveTrickleForIdentityChange: mocks.disarmTrickle,
    retireLiveTrackVoyage: mocks.retireTrickle,
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
import { useFollowRouteStore } from '../stores/followRouteStore';

beforeAll(() => {
    vi.useFakeTimers();
});

afterAll(() => {
    vi.useRealTimers();
});

describe('ShipLogService tracking owner fence', () => {
    const seedPersistedTrackingState = (userId: string, value: Record<string, unknown>) => {
        mocks.state.prefs.set(
            `ship_log_tracking_state::${encodeURIComponent(`user:${userId}`)}`,
            JSON.stringify({
                version: 1,
                ownerKey: `user:${userId}`,
                ownerUserId: userId,
                value,
            }),
        );
    };

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

    it('leaves fast-lock as soon as the GPS manager opens a vetted track', async () => {
        if (ShipLogService.getTrackingStatus().isTracking) await ShipLogService.pauseTracking();
        mocks.setSamplingMode.mockClear();

        await ShipLogService.startTracking(false);
        expect(mocks.setSamplingMode).toHaveBeenCalledWith('fastlock');
        const flushesBeforeGate = mocks.flushBuffered.mock.calls.length;
        await mocks.state.schedulerTick?.();
        expect(mocks.flushBuffered).toHaveBeenCalledTimes(flushesBeforeGate);

        mocks.state.gpsOptions?.onTrackOpened?.();
        await Promise.resolve();

        expect(mocks.setSamplingMode).toHaveBeenLastCalledWith('default');
        // Opening the GPS gate alone must not make an empty periodic tick
        // persist the raw UI cache. The real manager will have put a vetted
        // selected vertex in the buffer before a normal flush proceeds.
        await mocks.state.schedulerTick?.();
        expect(mocks.flushBuffered).toHaveBeenCalledTimes(flushesBeforeGate + 1);
        expect(mocks.flushBuffered.mock.calls.at(-1)?.[0]).toMatchObject({ allowEmptyBufferFallback: false });
    });

    it('serialises a manual log entry behind an in-flight selected-point flush', async () => {
        if (!ShipLogService.getTrackingStatus().isTracking) await ShipLogService.startTracking(false);
        mocks.addManual.mockClear();

        let releaseFlush!: (result: 'complete') => void;
        mocks.flushBuffered.mockImplementationOnce(
            () =>
                new Promise<'complete'>((resolve) => {
                    releaseFlush = resolve;
                }),
        );

        mocks.state.gpsOptions?.onTrackOpened?.();
        mocks.state.trackBuffer?.push({ latitude: -27.5, longitude: 153 });
        mocks.state.gpsOptions?.onHeartbeatTick();
        await Promise.resolve();

        const manual = ShipLogService.addManualEntry('Checked rigging');
        await Promise.resolve();
        expect(mocks.addManual).not.toHaveBeenCalled();

        releaseFlush('complete');
        await manual;
        expect(mocks.addManual).toHaveBeenCalledTimes(1);
    });

    it('stops following a route when tracking stops — following is scoped to the passage', async () => {
        // Following was a peer of logging, so ending a passage left the app
        // still following its route: leg grading, ETAs, arrival alerts and the
        // public page all kept computing against a voyage that was over, and
        // the next voyage inherited the stale state.
        if (!ShipLogService.getTrackingStatus().isTracking) await ShipLogService.startTracking(false);
        useFollowRouteStore.setState({ isFollowing: true, voyageId: ShipLogService.getCurrentVoyageId() });
        expect(useFollowRouteStore.getState().isFollowing).toBe(true);

        await ShipLogService.stopTracking();

        expect(useFollowRouteStore.getState().isFollowing).toBe(false);
    });

    it('releases the verified native lease when active-state persistence fails', async () => {
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        const startCapturesBefore = mocks.captureImmediate.mock.calls.filter(
            (call) => call[2] === 'Voyage Start',
        ).length;
        mocks.state.failNextActiveStateWrite = true;

        await expect(ShipLogService.startTracking(false)).rejects.toThrow('Preferences write failed');

        expect(ShipLogService.getTrackingStatus().isTracking).toBe(false);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(mocks.state.captureLocalOnly).toBe(false);
        expect(mocks.captureImmediate.mock.calls.filter((call) => call[2] === 'Voyage Start')).toHaveLength(
            startCapturesBefore,
        );
    });

    it('rolls back subscriptions, local-only capture, live sharing, persistence, and memory on setup failure', async () => {
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        const trickleStopsBefore = mocks.stopTrickle.mock.calls.length;
        const startCapturesBefore = mocks.captureImmediate.mock.calls.filter(
            (call) => call[2] === 'Voyage Start',
        ).length;
        mocks.state.gpsStartError = new Error('GPS subscription failed');

        await expect(ShipLogService.startTracking(false)).rejects.toThrow('GPS subscription failed');

        expect(ShipLogService.getTrackingStatus().isTracking).toBe(false);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(mocks.gpsStop).toHaveBeenCalled();
        expect(mocks.stopTrickle).toHaveBeenCalledTimes(trickleStopsBefore + 1);
        expect(mocks.state.captureLocalOnly).toBe(false);
        expect(mocks.captureImmediate.mock.calls.filter((call) => call[2] === 'Voyage Start')).toHaveLength(
            startCapturesBefore,
        );
        const persisted = [...mocks.state.prefs.entries()].find(([key]) => key.startsWith('ship_log_tracking_state'));
        expect(persisted).toBeDefined();
        expect(JSON.parse(persisted![1]).value.isTracking).toBe(false);
    });

    it('persists a failed-start cleanup as a paused teardown and End Voyage can retry it', async () => {
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        mocks.state.gpsStartError = new Error('GPS subscription failed before release');
        mocks.nativeStop.mockRejectedValueOnce(new Error('native stop remained enabled'));

        await expect(ShipLogService.startTracking(false, 'failed-cast-off-voyage')).rejects.toThrow(
            'GPS subscription failed before release',
        );
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            nativeTeardownPending: 'release-only',
            currentVoyageId: 'failed-cast-off-voyage',
        });

        await ShipLogService.stopTracking();

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore + 1);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 2);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: false,
        });
    });

    it('fails closed in memory when a retained native lease recovery marker cannot be persisted', async () => {
        const voyageId = 'failed-start-undurable-teardown';
        mocks.state.gpsStartError = new Error('GPS subscription failed before durable rollback');
        mocks.nativeStop.mockRejectedValueOnce(new Error('native stop remained enabled'));
        mocks.state.failPendingTeardownWrites = 2;

        await expect(ShipLogService.startTracking(false, voyageId)).rejects.toThrow(
            'recovery state could not be saved',
        );
        expect(mocks.state.failPendingTeardownWrites).toBe(0);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            nativeTeardownPending: 'release-only',
            currentVoyageId: voyageId,
        });

        await ShipLogService.stopTracking(voyageId);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('Retry GPS clears a failed-start native teardown without emitting a false Voyage End', async () => {
        const voyageId = 'failed-start-retry-voyage';
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        const endCapturesBefore = mocks.captureImmediate.mock.calls.filter((call) => call[2] === 'Voyage End').length;
        mocks.state.gpsStartError = new Error('GPS subscription failed before retry');
        mocks.nativeStop.mockRejectedValueOnce(new Error('initial cleanup remained enabled'));

        await expect(ShipLogService.startTracking(false, voyageId)).rejects.toThrow(
            'GPS subscription failed before retry',
        );
        await ShipLogService.startTracking(true, voyageId);

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore + 2);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 2);
        expect(mocks.captureImmediate.mock.calls.filter((call) => call[2] === 'Voyage End')).toHaveLength(
            endCapturesBefore,
        );
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: true,
            currentVoyageId: voyageId,
        });
        await ShipLogService.pauseTracking();
    });

    it('reports a retryable paused state when final native stop fails, then completes on retry', async () => {
        const pausedVoyageId = ShipLogService.getTrackingStatus().currentVoyageId;
        await ShipLogService.startTracking(true, pausedVoyageId);
        mocks.nativeStop.mockRejectedValueOnce(new Error('native engine remained enabled'));

        await expect(ShipLogService.stopTracking()).rejects.toThrow(
            'Voyage recording is paused, but background GPS is still active',
        );
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: pausedVoyageId,
        });

        await ShipLogService.stopTracking();
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: false,
            currentVoyageId: pausedVoyageId,
        });
    });

    it('joins concurrent stops until the one native GPS teardown is verified', async () => {
        const voyageId = ShipLogService.getTrackingStatus().currentVoyageId;
        await ShipLogService.startTracking(true, voyageId);

        let releaseNativeStop!: () => void;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        mocks.nativeStop.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseNativeStop = resolve;
                }),
        );

        let firstSettled = false;
        let secondSettled = false;
        const firstStop = ShipLogService.stopTracking(voyageId).then(() => {
            firstSettled = true;
        });
        const secondStop = ShipLogService.stopTracking(voyageId).then(() => {
            secondSettled = true;
        });

        for (let i = 0; i < 100 && !releaseNativeStop; i++) await Promise.resolve();
        expect(releaseNativeStop).toBeTypeOf('function');
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
        await expect(ShipLogService.stopTracking('different-voyage')).rejects.toThrow(
            'different voyage is already completing GPS teardown',
        );

        releaseNativeStop();
        await Promise.all([firstStop, secondStop]);

        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(firstSettled).toBe(true);
        expect(secondSettled).toBe(true);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('makes an exact-voyage End wait for a matching in-flight Cast Off start and its teardown', async () => {
        const voyageId = 'slow-cast-off-voyage';
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        let releaseNativeStart!: (state: {
            supported: boolean;
            activeLeaseCount: number;
            nativeTrackingEnabled: boolean;
            active: boolean;
        }) => void;
        mocks.nativeStart.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseNativeStart = resolve;
                }),
        );

        const starting = ShipLogService.startTracking(false, voyageId);
        for (let i = 0; i < 50 && !releaseNativeStart; i++) await Promise.resolve();
        expect(releaseNativeStart).toBeTypeOf('function');

        let endSettled = false;
        const ending = ShipLogService.stopTracking(voyageId).then(() => {
            endSettled = true;
        });
        await Promise.resolve();
        expect(endSettled).toBe(false);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore);

        releaseNativeStart({
            supported: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
            active: true,
        });
        await Promise.all([starting, ending]);

        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: false,
            currentVoyageId: voyageId,
        });
    });

    it('makes a plain Log-page Stop wait for an in-flight start instead of no-oping on a null owner', async () => {
        const voyageId = 'slow-log-page-start';
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        let releaseNativeStart!: (state: {
            supported: boolean;
            activeLeaseCount: number;
            nativeTrackingEnabled: boolean;
            active: boolean;
        }) => void;
        mocks.nativeStart.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseNativeStart = resolve;
                }),
        );

        const starting = ShipLogService.startTracking(false, voyageId);
        for (let i = 0; i < 50 && !releaseNativeStart; i++) await Promise.resolve();
        let stopSettled = false;
        const stopping = ShipLogService.stopTracking().then(() => {
            stopSettled = true;
        });
        await Promise.resolve();

        expect(stopSettled).toBe(false);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore);
        releaseNativeStart({
            supported: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
            active: true,
        });
        await Promise.all([starting, stopping]);

        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('retains failed identity-transition lease ownership and releases it before the next account starts', async () => {
        await ShipLogService.startTracking(false);
        const nativeStartsAfterAccountA = mocks.nativeStart.mock.calls.length;
        mocks.nativeStop
            .mockRejectedValueOnce(new Error('account A identity teardown failed'))
            .mockRejectedValueOnce(new Error('account A retained lease retry failed'));

        setAuthIdentityScope('ship-owner-b');
        for (let i = 0; i < 20; i++) await Promise.resolve();

        await expect(ShipLogService.startTracking(false)).rejects.toThrow(
            'could not release background GPS from the previous session',
        );
        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsAfterAccountA);

        await ShipLogService.startTracking(false);
        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsAfterAccountA + 1);
        expect(ShipLogService.getTrackingStatus().isTracking).toBe(true);
        await ShipLogService.pauseTracking();
    });

    it('releases an old-generation lease when the same account returns through A→B→A', async () => {
        const userA = 'returning-ship-owner-a';
        const userB = 'returning-ship-owner-b';
        const voyageId = 'returning-owner-voyage';
        setAuthIdentityScope(userA);
        await ShipLogService.initialize();
        await ShipLogService.startTracking(false, voyageId);
        const nativeStartsAfterInitialCastOff = mocks.nativeStart.mock.calls.length;
        const nativeStopsBeforeTransition = mocks.nativeStop.mock.calls.length;
        mocks.nativeStop.mockRejectedValueOnce(new Error('identity release remained enabled'));

        setAuthIdentityScope(userB);
        const markerKey = `ship_log_tracking_state::${encodeURIComponent(`user:${userA}`)}`;
        for (let i = 0; i < 100; i++) {
            const persisted = mocks.state.prefs.get(markerKey);
            if (persisted?.includes('"nativeTeardownPending":"release-only"')) break;
            await Promise.resolve();
        }
        expect(mocks.state.prefs.get(markerKey)).toContain('"nativeTeardownPending":"release-only"');

        mocks.strictNativeTrackingEnabled.mockResolvedValue(true);
        setAuthIdentityScope(userA);
        await ShipLogService.initialize();
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            nativeTeardownPending: 'release-only',
            currentVoyageId: voyageId,
        });

        await ShipLogService.startTracking(true, voyageId);

        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBeforeTransition + 2);
        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsAfterInitialCastOff + 1);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: true,
            currentVoyageId: voyageId,
        });
        await ShipLogService.pauseTracking();
    });

    it('makes exact End join a retained same-account lease before owner rehydration', async () => {
        const userA = 'fast-return-owner-a';
        const voyageId = 'fast-return-voyage';
        setAuthIdentityScope(userA);
        await ShipLogService.initialize();
        await ShipLogService.startTracking(false, voyageId);

        let rejectTransitionStop!: (error: Error) => void;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        mocks.nativeStop.mockImplementationOnce(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectTransitionStop = reject;
                }),
        );

        setAuthIdentityScope(null);
        const markerKey = `ship_log_tracking_state::${encodeURIComponent(`user:${userA}`)}`;
        for (let i = 0; i < 100; i++) {
            const persisted = mocks.state.prefs.get(markerKey);
            if (persisted?.includes('"isPaused":true')) break;
            await Promise.resolve();
        }
        expect(mocks.state.prefs.get(markerKey)).toContain('"isPaused":true');
        setAuthIdentityScope(userA);
        await expect(ShipLogService.stopTracking('different-fast-return-voyage')).rejects.toThrow(
            'different voyage is currently using GPS logging',
        );
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);

        let endSettled = false;
        const firstEnd = ShipLogService.stopTracking(voyageId).finally(() => {
            endSettled = true;
        });
        for (let i = 0; i < 50 && !rejectTransitionStop; i++) await Promise.resolve();

        expect(rejectTransitionStop).toBeTypeOf('function');
        expect(endSettled).toBe(false);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        rejectTransitionStop(new Error('old-generation native stop failed'));
        await expect(firstEnd).rejects.toThrow('Voyage remains active');

        await ShipLogService.stopTracking(voyageId);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 2);
    });

    it('cannot claim background voyage logging while iOS location is only When In Use', async () => {
        if (ShipLogService.getTrackingStatus().isTracking) await ShipLogService.stopTracking();
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        mocks.requireAlwaysLocation.mockRejectedValueOnce(
            new Error('Voyage logging needs Always Location access for locked-screen operation.'),
        );

        await expect(ShipLogService.startTracking(false)).rejects.toThrow(
            'Voyage logging needs Always Location access',
        );

        expect(mocks.requireAlwaysLocation).toHaveBeenCalledWith('voyage-log');
        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore);
        expect(ShipLogService.getTrackingStatus().isTracking).toBe(false);
    });

    it('reclaims one persisted pending-stop lease after a WebView reload and verifies release before finalizing', async () => {
        const userId = 'ship-owner-reload-pending';
        seedPersistedTrackingState(userId, {
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            isPrecisionMode: false,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: 'reload-pending-voyage',
        });
        mocks.nativeTrackingEnabled.mockResolvedValue(true);
        mocks.strictNativeTrackingEnabled.mockResolvedValue(true);
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;

        setAuthIdentityScope(userId);
        await ShipLogService.initialize();

        // Initialization inspects only; it never holds a speculative claim.
        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isPaused: true,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: 'reload-pending-voyage',
        });

        let releaseNativeStop!: () => void;
        mocks.nativeStop.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseNativeStop = resolve;
                }),
        );
        let settled = false;
        const ending = ShipLogService.stopTracking().then(() => {
            settled = true;
        });
        for (let i = 0; i < 50 && !releaseNativeStop; i++) await Promise.resolve();

        expect(releaseNativeStop).toBeTypeOf('function');
        expect(settled).toBe(false);
        expect(ShipLogService.getTrackingStatus().nativeTeardownPending).toBe('end-voyage');
        releaseNativeStop();
        await ending;

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore + 1);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('keeps a reloaded pending stop fail-closed when strict native state cannot be read', async () => {
        const userId = 'ship-owner-reload-unverifiable';
        seedPersistedTrackingState(userId, {
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: 'reload-unverifiable-voyage',
        });
        mocks.nativeTrackingEnabled.mockResolvedValue(true);
        mocks.strictNativeTrackingEnabled.mockRejectedValue(new Error('native state bridge unavailable'));
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;

        setAuthIdentityScope(userId);
        await ShipLogService.initialize();
        await expect(ShipLogService.stopTracking()).rejects.toThrow('background GPS teardown is still pending');

        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: 'reload-unverifiable-voyage',
        });

        mocks.strictNativeTrackingEnabled.mockResolvedValue(true);
        await ShipLogService.stopTracking();
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('clears the durable teardown marker only after a strict read verifies native GPS is already off', async () => {
        const userId = 'ship-owner-reload-native-off';
        seedPersistedTrackingState(userId, {
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            nativeTeardownPending: 'end-voyage',
            currentVoyageId: 'reload-native-off-voyage',
        });
        mocks.nativeTrackingEnabled.mockResolvedValue(false);
        mocks.strictNativeTrackingEnabled.mockResolvedValue(false);
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;

        setAuthIdentityScope(userId);
        await ShipLogService.initialize();

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            currentVoyageId: 'reload-native-off-voyage',
        });
        expect(ShipLogService.getTrackingStatus().nativeTeardownPending).toBeUndefined();
    });

    it('joins concurrent Pause and End across one persisted native release transaction', async () => {
        const userId = 'ship-owner-release-race';
        const voyageId = 'release-only-race-voyage';
        seedPersistedTrackingState(userId, {
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            nativeTeardownPending: 'release-only',
            currentVoyageId: voyageId,
        });
        mocks.strictNativeTrackingEnabled.mockResolvedValue(true);
        setAuthIdentityScope(userId);
        await ShipLogService.initialize();

        const strictReadsBefore = mocks.strictNativeTrackingEnabled.mock.calls.length;
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;
        let resolveStrictRead!: (enabled: boolean) => void;
        mocks.strictNativeTrackingEnabled.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    resolveStrictRead = resolve;
                }),
        );

        const pausing = ShipLogService.pauseTracking();
        for (let i = 0; i < 50 && mocks.strictNativeTrackingEnabled.mock.calls.length === strictReadsBefore; i++) {
            await Promise.resolve();
        }
        expect(resolveStrictRead).toBeTypeOf('function');

        let endSettled = false;
        const ending = ShipLogService.stopTracking(voyageId).then(() => {
            endSettled = true;
        });
        await Promise.resolve();
        expect(endSettled).toBe(false);

        resolveStrictRead(true);
        await Promise.all([pausing, ending]);

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore + 1);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore + 1);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({ isTracking: false, isPaused: false });
    });

    it('does not claim native GPS for an ordinary reloaded pause owned by another feature', async () => {
        const userId = 'ship-owner-reload-ordinary-pause';
        seedPersistedTrackingState(userId, {
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            currentVoyageId: 'ordinary-paused-voyage',
        });
        mocks.nativeTrackingEnabled.mockResolvedValue(true);
        mocks.strictNativeTrackingEnabled.mockResolvedValue(true);
        const nativeStartsBefore = mocks.nativeStart.mock.calls.length;
        const nativeStopsBefore = mocks.nativeStop.mock.calls.length;

        setAuthIdentityScope(userId);
        await ShipLogService.initialize();

        expect(mocks.nativeStart).toHaveBeenCalledTimes(nativeStartsBefore);
        expect(mocks.nativeStop).toHaveBeenCalledTimes(nativeStopsBefore);
        expect(ShipLogService.getTrackingStatus()).toMatchObject({
            isTracking: false,
            isPaused: true,
            currentVoyageId: 'ordinary-paused-voyage',
        });
        expect(ShipLogService.getTrackingStatus().nativeTeardownPending).toBeUndefined();
    });
});
