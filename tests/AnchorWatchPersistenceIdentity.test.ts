import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watchMocks = vi.hoisted(() => ({
    keepAwake: vi.fn().mockResolvedValue(undefined),
    allowSleep: vi.fn().mockResolvedValue(undefined),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    isNativeTrackingEnabled: vi.fn().mockResolvedValue(true),
    nativeLocationCallback: null as
        | null
        | ((position: {
              latitude: number;
              longitude: number;
              accuracy: number;
              heading?: number;
              speed: number;
              timestamp: number;
          }) => void),
    nmeaLocationCallback: null as
        | null
        | ((position: {
              latitude: number;
              longitude: number;
              accuracy: number;
              heading?: number;
              speed: number;
              timestamp: number;
          }) => void),
    geofenceCallback: null as null | ((event: { identifier: string; action: string }) => void),
    unsubscribeLocation: vi.fn(),
    unsubscribeNmea: vi.fn(),
    unsubscribeGeofence: vi.fn(),
    subscribeLocation: vi.fn(),
    subscribeGeofence: vi.fn(),
    removeGeofence: vi.fn().mockResolvedValue(undefined),
    addGeofence: vi.fn().mockResolvedValue(undefined),
    // Mirrors the real delegation: the arm path's best-effort removal still
    // goes THROUGH removeGeofence, so every existing call-count assertion here
    // keeps meaning what it meant — it just no longer aborts the arm.
    geofenceExists: vi.fn().mockResolvedValue(true),
    requestStart: vi.fn().mockResolvedValue({
        supported: true,
        active: true,
        activeLeaseCount: 1,
        nativeTrackingEnabled: true,
    }),
    requestStop: vi.fn().mockResolvedValue(undefined),
    requireAlwaysLocation: vi.fn().mockResolvedValue(undefined),
    requireNotificationReadiness: vi.fn().mockResolvedValue({
        ready: true,
        authorizationStatus: 'authorized',
        timeSensitiveEnabled: true,
        availableSlots: 64,
    }),
    cancelSafetyNotifications: vi.fn().mockResolvedValue(true),
    checkNotifications: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestNotifications: vi.fn().mockResolvedValue({ display: 'granted' }),
    nmeaPosition: vi.fn().mockReturnValue(null),
    acquireAlarm: vi.fn().mockResolvedValue('anchor-token'),
    releaseAlarm: vi.fn().mockResolvedValue(undefined),
    forceStopAlarm: vi.fn().mockResolvedValue(undefined),
    scheduleSafetyNotifications: vi.fn().mockResolvedValue(true),
}));

const recoveryMocks = vi.hoisted(() => ({
    failWrite: false,
    failClear: false,
}));

vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: {
        keepAwake: watchMocks.keepAwake,
        allowSleep: watchMocks.allowSleep,
    },
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        checkPermissions: watchMocks.checkNotifications,
        requestPermissions: watchMocks.requestNotifications,
        schedule: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: watchMocks.ensureReady,
        requireAlwaysLocationAuthorization: watchMocks.requireAlwaysLocation,
        isNativeTrackingEnabled: watchMocks.isNativeTrackingEnabled,
        subscribeLocation: watchMocks.subscribeLocation,
        subscribeGeofence: watchMocks.subscribeGeofence,
        removeGeofence: watchMocks.removeGeofence,
        tryRemoveGeofence: async (id: string) => {
            try {
                await watchMocks.removeGeofence(id);
                return true;
            } catch {
                return false;
            }
        },
        geofenceExists: watchMocks.geofenceExists,
        addGeofence: watchMocks.addGeofence,
        requestStart: watchMocks.requestStart,
        requestStop: watchMocks.requestStop,
    },
}));

vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: {
        requireReadiness: watchMocks.requireNotificationReadiness,
        scheduleAlarm: watchMocks.scheduleSafetyNotifications,
        cancelAlarm: watchMocks.cancelSafetyNotifications,
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        sendAlarmPush: vi.fn(),
    },
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        acquire: watchMocks.acquireAlarm,
        release: watchMocks.releaseAlarm,
        forceStop: watchMocks.forceStopAlarm,
    },
}));

vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        getFeedStatus: () => 'unavailable' as const,
        getPosition: watchMocks.nmeaPosition,
        onPosition: vi.fn((callback) => {
            watchMocks.nmeaLocationCallback = callback;
            return watchMocks.unsubscribeNmea;
        }),
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getQuality: vi.fn().mockReturnValue('standard'),
        getAdaptedThresholds: vi.fn().mockReturnValue({
            qualityLabel: 'Standard GPS',
            jitterFilterWindow: 5,
        }),
        feed: vi.fn(),
    },
}));

vi.mock('../services/GuardianService', () => ({
    GuardianService: {
        arm: vi.fn().mockResolvedValue(true),
        disarm: vi.fn().mockResolvedValue(true),
        getStatus: vi.fn().mockReturnValue({ status: 'idle' }),
    },
}));

// Keep this service-level suite focused on Anchor Watch transition semantics.
// The real iOS Keychain adapter and its migration/failure paths have a
// dedicated suite; this adapter preserves the historical observable store so
// the existing identity and crash-recovery assertions stay readable.
vi.mock('../services/anchorWatchRecoveryStorage', () => {
    const stateKey = 'thalassa_anchor_watch_state';
    const deviceKey = 'thalassa_anchor_watch_device_recovery_v1';
    const scopedKey = (identityKey: string) => `${stateKey}::${encodeURIComponent(identityKey)}`;
    return {
        ANCHOR_WATCH_DEVICE_RECOVERY_KEY: deviceKey,
        readAnchorWatchRecovery: vi.fn(async (scope: { key: string }) => {
            const device = localStorage.getItem(deviceKey);
            if (device !== null) return { raw: device, deviceRecovery: true };
            const scoped = localStorage.getItem(scopedKey(scope.key));
            return scoped === null ? null : { raw: scoped, deviceRecovery: false };
        }),
        hasAnchorWatchRecovery: vi.fn(
            async (scope: { key: string }) =>
                localStorage.getItem(deviceKey) !== null || localStorage.getItem(scopedKey(scope.key)) !== null,
        ),
        writeAnchorWatchRecovery: vi.fn(async (scope: { key: string }, raw: string) => {
            if (recoveryMocks.failWrite) throw new Error('secure recovery write failed');
            localStorage.setItem(deviceKey, raw);
            localStorage.setItem(scopedKey(scope.key), raw);
        }),
        clearAnchorWatchRecovery: vi.fn(async (scope: { key: string }) => {
            if (recoveryMocks.failClear) throw new Error('secure recovery clear failed');
            localStorage.removeItem(scopedKey(scope.key));
            localStorage.removeItem(deviceKey);
        }),
    };
});

import { ANCHOR_WATCH_DEVICE_RECOVERY_KEY, AnchorWatchService } from '../services/AnchorWatchService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { Capacitor } from '@capacitor/core';

const WATCH_KEY = 'thalassa_anchor_watch_state';
const CONFIG = {
    rodeLength: 30,
    waterDepth: 5,
    scopeRatio: 6,
    rodeType: 'chain' as const,
    safetyMargin: 10,
};

const activeLeaseState = () => ({
    supported: true,
    active: true,
    activeLeaseCount: 1,
    nativeTrackingEnabled: true,
});

function persistedWatch(identityKey: string) {
    return {
        anchorPosition: { latitude: -27.4, longitude: 153.1, timestamp: Date.now() },
        config: CONFIG,
        state: 'watching',
        watchStartedAt: Date.now(),
        alarmTriggeredAt: null,
        alarmCause: null,
        identityKey,
        savedAt: Date.now(),
    };
}

describe('AnchorWatchService local safety persistence', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        localStorage.clear();
        vi.clearAllMocks();
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        watchMocks.keepAwake.mockResolvedValue(undefined);
        watchMocks.allowSleep.mockResolvedValue(undefined);
        watchMocks.ensureReady.mockResolvedValue(undefined);
        watchMocks.isNativeTrackingEnabled.mockResolvedValue(true);
        watchMocks.subscribeLocation.mockImplementation((callback) => {
            watchMocks.nativeLocationCallback = callback;
            return watchMocks.unsubscribeLocation;
        });
        watchMocks.subscribeGeofence.mockImplementation((callback) => {
            watchMocks.geofenceCallback = callback;
            return watchMocks.unsubscribeGeofence;
        });
        watchMocks.nativeLocationCallback = null;
        watchMocks.nmeaLocationCallback = null;
        watchMocks.geofenceCallback = null;
        watchMocks.removeGeofence.mockResolvedValue(undefined);
        watchMocks.addGeofence.mockResolvedValue(undefined);
        watchMocks.requestStart.mockResolvedValue(activeLeaseState());
        watchMocks.requestStop.mockResolvedValue(undefined);
        watchMocks.requireAlwaysLocation.mockResolvedValue(undefined);
        watchMocks.requireNotificationReadiness.mockResolvedValue({
            ready: true,
            authorizationStatus: 'authorized',
            timeSensitiveEnabled: true,
            availableSlots: 64,
        });
        watchMocks.cancelSafetyNotifications.mockResolvedValue(true);
        watchMocks.checkNotifications.mockResolvedValue({ display: 'granted' });
        watchMocks.requestNotifications.mockResolvedValue({ display: 'granted' });
        watchMocks.nmeaPosition.mockReturnValue(null);
        watchMocks.acquireAlarm.mockResolvedValue('anchor-token');
        watchMocks.releaseAlarm.mockResolvedValue(undefined);
        watchMocks.forceStopAlarm.mockResolvedValue(undefined);
        watchMocks.scheduleSafetyNotifications.mockResolvedValue(true);
        recoveryMocks.failWrite = false;
        recoveryMocks.failClear = false;
    });

    afterEach(async () => {
        recoveryMocks.failWrite = false;
        recoveryMocks.failClear = false;
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.useRealTimers();
    });

    it('keeps an armed physical watch running with scoped provenance and device recovery', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        const accountAKey = authScopedStorageKey(WATCH_KEY, accountAScope);
        const original = JSON.parse(localStorage.getItem(accountAKey) ?? '{}');
        expect(original.identityKey).toBe('user:account-a');
        expect(JSON.parse(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY) ?? '{}').identityKey).toBe(
            'user:account-a',
        );

        const accountBScope = setAuthIdentityScope('account-b');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
        });

        expect(await AnchorWatchService.updateConfig({ safetyMargin: 18 })).toBe(true);

        expect(JSON.parse(localStorage.getItem(accountAKey) ?? '{}').config.safetyMargin).toBe(18);
        expect(JSON.parse(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY) ?? '{}').config.safetyMargin).toBe(18);
        expect(localStorage.getItem(authScopedStorageKey(WATCH_KEY, accountBScope))).toBeNull();

        // B can explicitly stop the still-running physical safety watch, but
        // that clears the captured A namespace rather than B's namespace.
        await AnchorWatchService.stopWatch();
        expect(localStorage.getItem(accountAKey)).toBeNull();
        expect(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)).toBeNull();
    });

    it('restores and clears an active device watch after involuntary sign-out', async () => {
        localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, JSON.stringify(persistedWatch('user:account-a')));
        setAuthIdentityScope(null);

        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
        });

        await AnchorWatchService.stopWatch();
        expect(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)).toBeNull();
        expect(
            localStorage.getItem(
                authScopedStorageKey(WATCH_KEY, { key: 'user:account-a', userId: 'account-a', generation: 0 }),
            ),
        ).toBeNull();
    });

    it('never restores another account or an unattributable legacy anchor position', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        localStorage.setItem(
            authScopedStorageKey(WATCH_KEY, accountAScope),
            JSON.stringify(persistedWatch(accountAScope.key)),
        );
        localStorage.setItem(WATCH_KEY, JSON.stringify(persistedWatch(accountAScope.key)));

        setAuthIdentityScope('account-b');
        expect(await AnchorWatchService.restoreWatchState()).toBe(false);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
        });

        setAuthIdentityScope('account-a');
        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
        });
    });

    it('abandons stale restore preflight before exposing A coordinates to B', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        localStorage.setItem(
            authScopedStorageKey(WATCH_KEY, accountAScope),
            JSON.stringify(persistedWatch(accountAScope.key)),
        );

        let resolveKeepAwake!: () => void;
        watchMocks.keepAwake.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                resolveKeepAwake = resolve;
            }),
        );
        const restoring = AnchorWatchService.restoreWatchState();
        for (let attempt = 0; attempt < 10 && watchMocks.keepAwake.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(watchMocks.keepAwake).toHaveBeenCalledOnce();

        setAuthIdentityScope('account-b');
        resolveKeepAwake();

        expect(await restoring).toBe(false);
        expect(watchMocks.allowSleep).toHaveBeenCalledOnce();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
        });
    });

    it('retains a foreign paused cleanup owner when auth changes after native GPS starts', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        const accountAKey = authScopedStorageKey(WATCH_KEY, accountAScope);
        localStorage.setItem(accountAKey, JSON.stringify(persistedWatch(accountAScope.key)));

        let resolveNativeStart!: (state: ReturnType<typeof activeLeaseState>) => void;
        watchMocks.requestStart.mockReturnValueOnce(
            new Promise<ReturnType<typeof activeLeaseState>>((resolve) => {
                resolveNativeStart = resolve;
            }),
        );
        watchMocks.requestStop.mockRejectedValueOnce(new Error('native identity cleanup still active'));

        const restoring = AnchorWatchService.restoreWatchState();
        await vi.waitFor(() => expect(watchMocks.requestStart).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        resolveNativeStart(activeLeaseState());

        expect(await restoring).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            vesselPosition: null,
            setupError: expect.stringContaining('native identity cleanup still active'),
        });
        expect(localStorage.getItem(accountAKey)).not.toBeNull();
        expect(watchMocks.unsubscribeLocation).not.toHaveBeenCalled();

        // A page/bootstrap retry under B must preserve A's pending ownership
        // instead of starting or adopting a second watch.
        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(watchMocks.requestStart).toHaveBeenCalledOnce();

        watchMocks.requestStop.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        expect(watchMocks.requestStop).toHaveBeenCalledTimes(2);
        expect(watchMocks.unsubscribeLocation).toHaveBeenCalledOnce();
        expect(localStorage.getItem(accountAKey)).toBeNull();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
    });

    it('keeps identity-fenced cleanup retryable when the native geofence cannot be removed', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        const accountAKey = authScopedStorageKey(WATCH_KEY, accountAScope);
        localStorage.setItem(accountAKey, JSON.stringify(persistedWatch(accountAScope.key)));

        let resolveNativeStart!: (state: ReturnType<typeof activeLeaseState>) => void;
        watchMocks.requestStart.mockReturnValueOnce(
            new Promise<ReturnType<typeof activeLeaseState>>((resolve) => {
                resolveNativeStart = resolve;
            }),
        );
        // First removal is the clean replacement before add; the second is the
        // identity-fenced teardown that must remain owned when it fails.
        watchMocks.removeGeofence
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('native fence still registered'));

        const restoring = AnchorWatchService.restoreWatchState();
        await vi.waitFor(() => expect(watchMocks.requestStart).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        resolveNativeStart(activeLeaseState());

        expect(await restoring).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('native fence still registered'),
        });
        expect(localStorage.getItem(accountAKey)).not.toBeNull();
        expect(watchMocks.unsubscribeLocation).not.toHaveBeenCalled();

        watchMocks.removeGeofence.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        expect(watchMocks.removeGeofence).toHaveBeenCalledTimes(3);
        expect(localStorage.getItem(accountAKey)).toBeNull();
    });

    it('fails closed and preserves the exact native GPS startup error', async () => {
        const scope = setAuthIdentityScope('account-a');
        watchMocks.requestStart.mockRejectedValueOnce(new Error('Location permission is denied forever'));

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
            watchStartedAt: null,
            setupError: 'Location permission is denied forever',
        });
        expect(localStorage.getItem(authScopedStorageKey(WATCH_KEY, scope))).toBeNull();
    });

    it('does not report an armed watch before secure recovery persistence succeeds', async () => {
        setAuthIdentityScope('account-a');
        recoveryMocks.failWrite = true;

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(watchMocks.requestStop).toHaveBeenCalledOnce();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
            setupError: 'secure recovery write failed',
        });
    });

    it('keeps Weigh Anchor retryable when strict secure clear is not confirmed', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        const accountAKey = authScopedStorageKey(WATCH_KEY, accountAScope);
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        recoveryMocks.failClear = true;

        await expect(AnchorWatchService.stopWatch()).rejects.toThrow('secure recovery clear failed');

        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('crash-recovery state could not be cleared'),
        });
        expect(localStorage.getItem(accountAKey)).not.toBeNull();

        recoveryMocks.failClear = false;
        await AnchorWatchService.stopWatch();
        expect(localStorage.getItem(accountAKey)).toBeNull();
    });

    it('does not silently return to idle when failed setup recovery cannot be cleared', async () => {
        setAuthIdentityScope('account-a');
        recoveryMocks.failWrite = true;
        recoveryMocks.failClear = true;

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('secure recovery clear failed'),
        });
    });

    it('rolls back when native tracking resolves but cannot be verified active', async () => {
        const scope = setAuthIdentityScope('account-a');
        watchMocks.requestStart.mockResolvedValueOnce({
            supported: true,
            active: false,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(AnchorWatchService.getLastSetupError()).toBe(
            'Background GPS did not start. Enable Always Location access for Thalassa and try again.',
        );
        expect(watchMocks.requestStop).toHaveBeenCalledOnce();
        expect(localStorage.getItem(authScopedStorageKey(WATCH_KEY, scope))).toBeNull();
    });

    it('refuses to arm when locked-screen notification permission is denied', async () => {
        watchMocks.checkNotifications.mockResolvedValueOnce({ display: 'denied' });

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(watchMocks.requestStart).not.toHaveBeenCalled();
        expect(AnchorWatchService.getLastSetupError()).toContain('Locked-screen notifications are denied');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
    });

    it('refuses to arm when Time Sensitive notifications are disabled', async () => {
        watchMocks.requireNotificationReadiness.mockRejectedValueOnce(
            new Error('Time Sensitive Notifications are off for Thalassa.'),
        );

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(watchMocks.requireAlwaysLocation).not.toHaveBeenCalled();
        expect(watchMocks.requestStart).not.toHaveBeenCalled();
        expect(AnchorWatchService.getLastSetupError()).toContain('Time Sensitive Notifications are off');
    });

    it('refuses to arm when iOS location remains When In Use', async () => {
        watchMocks.requireAlwaysLocation.mockRejectedValueOnce(
            new Error('Anchor Watch needs Always Location access for locked-screen operation.'),
        );

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(watchMocks.requireAlwaysLocation).toHaveBeenCalledWith('anchor-watch');
        expect(watchMocks.requestStart).not.toHaveBeenCalled();
        expect(AnchorWatchService.getLastSetupError()).toContain('Always Location access');
    });

    it('does not treat live NMEA as an iOS locked-screen monitoring path', async () => {
        watchMocks.nmeaPosition.mockReturnValue({
            latitude: -27.4,
            longitude: 153.1,
            timestamp: Date.now(),
            accuracy: 2,
            heading: 0,
            speed: 0,
        });
        watchMocks.requestStart.mockRejectedValueOnce(new Error('native background path unavailable'));

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(false);

        expect(AnchorWatchService.getLastSetupError()).toContain('native background path unavailable');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
    });

    it('serializes duplicate restore calls and acquires one native GPS lease', async () => {
        const scope = setAuthIdentityScope('account-a');
        localStorage.setItem(authScopedStorageKey(WATCH_KEY, scope), JSON.stringify(persistedWatch(scope.key)));

        const [bootstrapRestore, pageRestore] = await Promise.all([
            AnchorWatchService.restoreWatchState(),
            AnchorWatchService.restoreWatchState(),
        ]);

        expect(bootstrapRestore).toBe(true);
        expect(pageRestore).toBe(true);
        expect(watchMocks.requestStart).toHaveBeenCalledOnce();
        expect(watchMocks.subscribeLocation).toHaveBeenCalledOnce();
    });

    it('restores a multi-day anchorage instead of silently expiring it', async () => {
        const scope = setAuthIdentityScope('account-a');
        const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
        localStorage.setItem(
            authScopedStorageKey(WATCH_KEY, scope),
            JSON.stringify({
                ...persistedWatch(scope.key),
                watchStartedAt: threeDaysAgo,
                savedAt: threeDaysAgo,
            }),
        );

        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            watchStartedAt: threeDaysAgo,
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
        });
    });

    it('retains a valid recovery record and coordinates when restore preflight fails transiently', async () => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        localStorage.setItem(key, JSON.stringify(persistedWatch(scope.key)));
        watchMocks.requireNotificationReadiness.mockRejectedValueOnce(
            new Error('Time Sensitive notification settings are temporarily unavailable.'),
        );

        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('temporarily unavailable'),
        });
        expect(localStorage.getItem(key)).not.toBeNull();
        expect(watchMocks.requestStart).not.toHaveBeenCalled();
        expect(watchMocks.removeGeofence).not.toHaveBeenCalled();
    });

    it('recovers a persisted alarm with its cause and restarts independent warning paths', async () => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        const alarmTriggeredAt = Date.now() - 60_000;
        localStorage.setItem(
            key,
            JSON.stringify({
                ...persistedWatch(scope.key),
                state: 'alarm',
                alarmCause: 'gps-lost',
                alarmTriggeredAt,
            }),
        );

        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'alarm',
            alarmCause: 'gps-lost',
            alarmTriggeredAt,
        });
        expect(watchMocks.forceStopAlarm).not.toHaveBeenCalled();
        expect(watchMocks.acquireAlarm).toHaveBeenCalledWith('anchor-watch');
        expect(watchMocks.scheduleSafetyNotifications).toHaveBeenCalledOnce();
        expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({
            state: 'alarm',
            alarmCause: 'gps-lost',
            alarmTriggeredAt,
        });
    });

    it('keeps its GPS lease and subscriptions when stop cannot be confirmed', async () => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        watchMocks.requestStop.mockRejectedValueOnce(new Error('native stop not confirmed'));

        await expect(AnchorWatchService.stopWatch()).rejects.toThrow('native stop not confirmed');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('stop is not confirmed'),
        });
        expect(watchMocks.unsubscribeLocation).not.toHaveBeenCalled();
        expect(localStorage.getItem(key)).not.toBeNull();

        watchMocks.requestStop.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        expect(watchMocks.requestStop).toHaveBeenCalledTimes(2);
        expect(watchMocks.unsubscribeLocation).toHaveBeenCalledOnce();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
        expect(localStorage.getItem(key)).toBeNull();
    });

    it('keeps geofence ownership and recovery state when native removal cannot be confirmed', async () => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        watchMocks.removeGeofence.mockRejectedValueOnce(new Error('native fence remained registered'));

        await expect(AnchorWatchService.stopWatch()).rejects.toThrow('native fence remained registered');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            setupError: expect.stringContaining('stop is not confirmed'),
        });
        expect(watchMocks.unsubscribeLocation).not.toHaveBeenCalled();
        expect(localStorage.getItem(key)).not.toBeNull();

        watchMocks.removeGeofence.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        expect(watchMocks.unsubscribeLocation).toHaveBeenCalledOnce();
        expect(localStorage.getItem(key)).toBeNull();
    });

    it('keeps an alarm active and persisted until audio and notification cancellation both confirm', async () => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        localStorage.setItem(
            key,
            JSON.stringify({
                ...persistedWatch(scope.key),
                state: 'alarm',
                alarmCause: 'drag',
                alarmTriggeredAt: Date.now() - 5_000,
            }),
        );
        expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        watchMocks.cancelSafetyNotifications.mockRejectedValueOnce(new Error('pending requests still present'));

        await expect(AnchorWatchService.acknowledgeAlarm()).rejects.toThrow('silence is not confirmed');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'alarm',
            alarmCause: 'drag',
            setupError: expect.stringContaining('pending requests still present'),
        });
        expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
        expect(watchMocks.acquireAlarm).toHaveBeenCalledTimes(2);

        watchMocks.cancelSafetyNotifications.mockResolvedValue(true);
        await AnchorWatchService.acknowledgeAlarm();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            alarmCause: null,
            alarmTriggeredAt: null,
        });
        expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({
            state: 'watching',
            alarmCause: null,
            alarmTriggeredAt: null,
        });
    });

    it('uses one fresh primary GPS source and resets filtering when receivers change', async () => {
        setAuthIdentityScope('account-a');
        vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        expect(watchMocks.nativeLocationCallback).not.toBeNull();
        expect(watchMocks.nmeaLocationCallback).not.toBeNull();

        watchMocks.nativeLocationCallback?.({
            latitude: -27.4,
            longitude: 153.1,
            accuracy: 8,
            speed: 0,
            timestamp: Date.now(),
        });
        watchMocks.nmeaLocationCallback?.({
            latitude: -27.401,
            longitude: 153.101,
            accuracy: 2,
            speed: 0,
            timestamp: Date.now(),
        });
        expect(AnchorWatchService.getSnapshot().vesselPosition).toMatchObject({
            latitude: -27.401,
            longitude: 153.101,
        });

        // Native updates are supplemental while NMEA is fresh and must not be
        // averaged with the external receiver's offset.
        watchMocks.nativeLocationCallback?.({
            latitude: -27.399,
            longitude: 153.099,
            accuracy: 8,
            speed: 0,
            timestamp: Date.now(),
        });
        expect(AnchorWatchService.getSnapshot().vesselPosition).toMatchObject({
            latitude: -27.401,
            longitude: 153.101,
        });

        // The takeover fix has to be somewhere the BOAT could be. It used to
        // be 149 m from the last NMEA position, which is a fine way to prove
        // the source changed but is not two receivers on one hull — and the
        // cross-source guard now refuses that, because ashore it is exactly
        // how the watch ends up measuring the wrong object. ~30 m offset
        // keeps the test's intent (source switches after the freshness
        // window, filtering resets) with a physically possible separation.
        vi.advanceTimersByTime(12_001);
        watchMocks.nativeLocationCallback?.({
            latitude: -27.4012,
            longitude: 153.1008,
            accuracy: 8,
            speed: 0,
            timestamp: Date.now(),
        });
        expect(AnchorWatchService.getSnapshot().vesselPosition).toMatchObject({
            latitude: -27.4012,
            longitude: 153.1008,
        });
        expect(AnchorWatchService.getSnapshot().state).toBe('watching');
    });

    it('rolls back a failed geofence radius update before publishing new config', async () => {
        setAuthIdentityScope('account-a');
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        watchMocks.addGeofence.mockRejectedValueOnce(new Error('new radius rejected')).mockResolvedValueOnce(undefined);

        expect(await AnchorWatchService.updateConfig({ safetyMargin: 25 })).toBe(false);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            config: { safetyMargin: 10 },
            setupError: expect.stringContaining('previous verified radius remains active'),
        });
    });

    it.each([
        ['negative rode', { rodeLength: -1 }],
        ['zero rode', { rodeLength: 0 }],
        ['zero depth', { waterDepth: 0 }],
        ['zero safety margin', { safetyMargin: 0 }],
        ['NaN water depth', { waterDepth: Number.NaN }],
        ['huge rode', { rodeLength: 1_000_000 }],
        ['huge safety margin', { safetyMargin: 1_000_000 }],
        ['inconsistent scope ratio', { scopeRatio: 5 }],
    ])('rejects %s before any native arming effect', async (_label, invalidConfig) => {
        setAuthIdentityScope('account-a');

        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, invalidConfig)).toBe(false);

        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
            setupError: expect.stringMatching(/invalid|rejected/i),
        });
        expect(watchMocks.checkNotifications).not.toHaveBeenCalled();
        expect(watchMocks.requireAlwaysLocation).not.toHaveBeenCalled();
        expect(watchMocks.addGeofence).not.toHaveBeenCalled();
        expect(watchMocks.requestStart).not.toHaveBeenCalled();
    });

    it('rejects invalid current-position setup before requesting GPS or permissions', async () => {
        setAuthIdentityScope('account-a');

        expect(await AnchorWatchService.setAnchor({ waterDepth: 0 })).toBe(false);

        expect(AnchorWatchService.getLastSetupError()).toContain('Water depth');
        expect(watchMocks.nmeaPosition).not.toHaveBeenCalled();
        expect(watchMocks.checkNotifications).not.toHaveBeenCalled();
        expect(watchMocks.requireAlwaysLocation).not.toHaveBeenCalled();
        expect(watchMocks.addGeofence).not.toHaveBeenCalled();
    });

    it.each([
        ['an impossibly large margin', { ...CONFIG, safetyMargin: 1_000_000 }],
        ['an inconsistent scope ratio', { ...CONFIG, scopeRatio: 5 }],
    ])('keeps corrupt persisted config visibly blocked for recovery: %s', async (_label, config) => {
        const scope = setAuthIdentityScope('account-a');
        const key = authScopedStorageKey(WATCH_KEY, scope);
        localStorage.setItem(key, JSON.stringify({ ...persistedWatch(scope.key), config }));

        expect(await AnchorWatchService.restoreWatchState()).toBe(true);

        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'paused',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
            swingRadius: 0,
            setupError: expect.stringContaining('blocked and was not armed'),
        });
        expect(localStorage.getItem(key)).not.toBeNull();
        expect(watchMocks.checkNotifications).not.toHaveBeenCalled();
        expect(watchMocks.requireAlwaysLocation).not.toHaveBeenCalled();
        expect(watchMocks.addGeofence).not.toHaveBeenCalled();
        expect(watchMocks.requestStart).not.toHaveBeenCalled();
    });

    it('never replaces a verified native fence with an invalid update', async () => {
        setAuthIdentityScope('account-a');
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        const addCount = watchMocks.addGeofence.mock.calls.length;
        const removeCount = watchMocks.removeGeofence.mock.calls.length;

        expect(await AnchorWatchService.updateConfig({ safetyMargin: Number.POSITIVE_INFINITY })).toBe(false);

        expect(watchMocks.addGeofence).toHaveBeenCalledTimes(addCount);
        expect(watchMocks.removeGeofence).toHaveBeenCalledTimes(removeCount);
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            config: { safetyMargin: 10, scopeRatio: 6 },
            setupError: expect.stringContaining('rejected'),
        });
        for (const [nativeConfig] of watchMocks.addGeofence.mock.calls) {
            expect(nativeConfig.radius).toBeGreaterThanOrEqual(20);
            expect(nativeConfig.radius).toBeLessThanOrEqual(400);
            expect(Number.isFinite(nativeConfig.radius)).toBe(true);
        }
    });
});
