import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watchMocks = vi.hoisted(() => ({
    keepAwake: vi.fn().mockResolvedValue(undefined),
    allowSleep: vi.fn().mockResolvedValue(undefined),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    subscribeLocation: vi.fn(() => vi.fn()),
    subscribeGeofence: vi.fn(() => vi.fn()),
    removeGeofence: vi.fn().mockResolvedValue(undefined),
    addGeofence: vi.fn().mockResolvedValue(undefined),
    requestStart: vi.fn().mockResolvedValue(undefined),
    requestStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: {
        keepAwake: watchMocks.keepAwake,
        allowSleep: watchMocks.allowSleep,
    },
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
        requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
        schedule: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: watchMocks.ensureReady,
        subscribeLocation: watchMocks.subscribeLocation,
        subscribeGeofence: watchMocks.subscribeGeofence,
        removeGeofence: watchMocks.removeGeofence,
        addGeofence: watchMocks.addGeofence,
        requestStart: watchMocks.requestStart,
        requestStop: watchMocks.requestStop,
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        sendAlarmPush: vi.fn(),
    },
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        startAlarm: vi.fn().mockResolvedValue(undefined),
        stopAlarm: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        getPosition: vi.fn().mockReturnValue(null),
        onPosition: vi.fn(() => vi.fn()),
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

import { AnchorWatchService } from '../services/AnchorWatchService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const WATCH_KEY = 'thalassa_anchor_watch_state';
const CONFIG = {
    rodeLength: 30,
    waterDepth: 5,
    scopeRatio: 5,
    rodeType: 'chain' as const,
    safetyMargin: 10,
};

function persistedWatch(identityKey: string) {
    return {
        anchorPosition: { latitude: -27.4, longitude: 153.1, timestamp: Date.now() },
        config: CONFIG,
        state: 'watching',
        watchStartedAt: Date.now(),
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
        watchMocks.keepAwake.mockResolvedValue(undefined);
        watchMocks.allowSleep.mockResolvedValue(undefined);
        watchMocks.ensureReady.mockResolvedValue(undefined);
        watchMocks.removeGeofence.mockResolvedValue(undefined);
        watchMocks.addGeofence.mockResolvedValue(undefined);
        watchMocks.requestStart.mockResolvedValue(undefined);
        watchMocks.requestStop.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('keeps an armed physical watch running but persists it only under the arming account', async () => {
        const accountAScope = setAuthIdentityScope('account-a');
        expect(await AnchorWatchService.setAnchorAt(-27.4, 153.1, CONFIG)).toBe(true);
        const accountAKey = authScopedStorageKey(WATCH_KEY, accountAScope);
        const original = JSON.parse(localStorage.getItem(accountAKey) ?? '{}');
        expect(original.identityKey).toBe('user:account-a');

        const accountBScope = setAuthIdentityScope('account-b');
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'watching',
            anchorPosition: { latitude: -27.4, longitude: 153.1 },
        });

        AnchorWatchService.updateConfig({ safetyMargin: 18 });

        expect(JSON.parse(localStorage.getItem(accountAKey) ?? '{}').config.safetyMargin).toBe(18);
        expect(localStorage.getItem(authScopedStorageKey(WATCH_KEY, accountBScope))).toBeNull();

        // B can explicitly stop the still-running physical safety watch, but
        // that clears the captured A namespace rather than B's namespace.
        await AnchorWatchService.stopWatch();
        expect(localStorage.getItem(accountAKey)).toBeNull();
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
        await Promise.resolve();

        setAuthIdentityScope('account-b');
        resolveKeepAwake();

        expect(await restoring).toBe(false);
        expect(watchMocks.allowSleep).toHaveBeenCalledOnce();
        expect(AnchorWatchService.getSnapshot()).toMatchObject({
            state: 'idle',
            anchorPosition: null,
        });
    });
});
