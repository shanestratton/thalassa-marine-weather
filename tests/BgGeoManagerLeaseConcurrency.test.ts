import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
    let enabled = false;
    return {
        get enabled() {
            return enabled;
        },
        setEnabled(value: boolean) {
            enabled = value;
        },
        ready: vi.fn(async () => undefined),
        start: vi.fn(async () => {
            enabled = true;
        }),
        stop: vi.fn(async () => {
            enabled = false;
        }),
        // The manager drains the SDK's location table after a verified stop —
        // it is never read by this app, so it is pure storage. Present here
        // because a mock missing it would only prove the guard works, not that
        // the drain runs.
        destroyLocations: vi.fn(async () => undefined),
        changePace: vi.fn(async () => undefined),
        getState: vi.fn(async () => ({ enabled })),
        getProviderState: vi.fn(async () => ({ enabled: true, status: 4, gps: true })),
        setConfig: vi.fn(async () => undefined),
        removeGeofence: vi.fn(async () => undefined),
        geofenceExists: vi.fn(async () => false),
    };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'ios',
    },
}));

vi.mock('@transistorsoft/capacitor-background-geolocation', () => ({
    default: {
        ready: native.ready,
        start: native.start,
        stop: native.stop,
        changePace: native.changePace,
        getState: native.getState,
        getProviderState: native.getProviderState,
        setConfig: native.setConfig,
        removeGeofence: native.removeGeofence,
        geofenceExists: native.geofenceExists,
        onLocation: vi.fn(() => ({ remove: vi.fn() })),
        onGeofence: vi.fn(() => ({ remove: vi.fn() })),
        onHeartbeat: vi.fn(() => ({ remove: vi.fn() })),
        onActivityChange: vi.fn(() => ({ remove: vi.fn() })),
        onProviderChange: vi.fn(() => ({ remove: vi.fn() })),
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BgGeoManager } from '../services/BgGeoManager';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('BgGeoManager native lease serialization', () => {
    beforeEach(async () => {
        native.setEnabled(false);
        await BgGeoManager.forceStop();
        vi.clearAllMocks();
        native.setEnabled(false);
        native.start.mockImplementation(async () => {
            native.setEnabled(true);
        });
        native.stop.mockImplementation(async () => {
            native.setEnabled(false);
        });
        native.getState.mockImplementation(async () => ({ enabled: native.enabled }));
        native.getProviderState.mockResolvedValue({ enabled: true, status: 4, gps: true });
        native.setConfig.mockResolvedValue(undefined);
        native.removeGeofence.mockResolvedValue(undefined);
        native.geofenceExists.mockResolvedValue(false);
    });

    it('reads provider health without initializing the background engine', async () => {
        await expect(BgGeoManager.getGpsHealth()).resolves.toEqual({
            usable: true,
            reason: 'ok',
            actionable: false,
        });

        expect(native.getProviderState).toHaveBeenCalledOnce();
        expect(native.ready).not.toHaveBeenCalled();
        expect(native.start).not.toHaveBeenCalled();
    });

    it('ignores sampling mutations before a safety owner initializes the engine', async () => {
        await expect(BgGeoManager.setSamplingMode('default')).resolves.toEqual(expect.any(Number));

        expect(native.ready).not.toHaveBeenCalled();
        expect(native.setConfig).not.toHaveBeenCalled();
    });

    it('disables motion activity updates when an explicit safety owner initializes tracking', async () => {
        await expect(BgGeoManager.requestStart()).resolves.toMatchObject({ active: true });

        expect(native.ready).toHaveBeenCalledWith(
            expect.objectContaining({
                activity: expect.objectContaining({
                    disableStopDetection: true,
                    disableMotionActivityUpdates: true,
                }),
            }),
        );
        await BgGeoManager.requestStop();
    });

    it('fails closed when the engine cannot enter continuous marine tracking', async () => {
        native.changePace.mockRejectedValueOnce(new Error('pace bridge denied'));

        await expect(BgGeoManager.requestStart()).rejects.toThrow('could not enter continuous marine tracking');
        expect(native.stop).toHaveBeenCalledOnce();
        expect(await BgGeoManager.getLeaseState()).toMatchObject({
            active: false,
            activeLeaseCount: 0,
            nativeTrackingEnabled: false,
        });
    });

    it('returns an inactive owned lease when pace and compensating cleanup both fail', async () => {
        native.changePace.mockRejectedValue(new Error('pace bridge denied'));
        native.stop.mockRejectedValueOnce(new Error('cleanup stop denied'));

        await expect(BgGeoManager.requestStart()).resolves.toMatchObject({
            active: false,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });

        native.changePace.mockResolvedValue(undefined);
        await expect(BgGeoManager.requestStop()).resolves.toMatchObject({
            active: false,
            activeLeaseCount: 0,
        });
    });

    it('makes every concurrent acquirer await the one native start', async () => {
        const gate = deferred();
        native.start.mockImplementationOnce(async () => {
            await gate.promise;
            native.setEnabled(true);
        });

        const first = BgGeoManager.requestStart();
        const second = BgGeoManager.requestStart();
        let secondSettled = false;
        void second.finally(() => {
            secondSettled = true;
        });

        await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        gate.resolve();
        const [firstState, secondState] = await Promise.all([first, second]);
        expect(firstState).toMatchObject({ active: true, activeLeaseCount: 1 });
        expect(secondState).toMatchObject({ active: true, activeLeaseCount: 2 });
        expect(native.start).toHaveBeenCalledOnce();
    });

    it('serializes a strict native-state read behind an in-flight lease transition', async () => {
        const gate = deferred();
        native.start.mockImplementationOnce(async () => {
            await gate.promise;
            native.setEnabled(true);
        });

        const start = BgGeoManager.requestStart();
        await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
        const strictRead = BgGeoManager.getNativeTrackingEnabledStrict();
        let readSettled = false;
        void strictRead.finally(() => {
            readSettled = true;
        });

        await Promise.resolve();
        expect(readSettled).toBe(false);
        gate.resolve();

        await expect(start).resolves.toMatchObject({ active: true, activeLeaseCount: 1 });
        await expect(strictRead).resolves.toBe(true);
    });

    it('propagates an unverifiable strict native-state read instead of reporting off', async () => {
        native.getState.mockRejectedValueOnce(new Error('native state bridge unavailable'));

        await expect(BgGeoManager.getNativeTrackingEnabledStrict()).rejects.toThrow('native state bridge unavailable');
    });

    it('never stops the engine while a concurrent lease remains', async () => {
        const gate = deferred();
        native.start.mockImplementationOnce(async () => {
            await gate.promise;
            native.setEnabled(true);
        });

        const first = BgGeoManager.requestStart();
        const second = BgGeoManager.requestStart();
        const release = BgGeoManager.requestStop();
        gate.resolve();

        await Promise.all([first, second]);
        const state = await release;
        expect(state).toMatchObject({ active: true, activeLeaseCount: 1, nativeTrackingEnabled: true });
        expect(native.stop).not.toHaveBeenCalled();

        const finalState = await BgGeoManager.requestStop();
        expect(finalState).toMatchObject({ active: false, activeLeaseCount: 0, nativeTrackingEnabled: false });
        expect(native.stop).toHaveBeenCalledOnce();
    });

    it('keeps the lease count unchanged when native start fails and permits a clean retry', async () => {
        native.start.mockRejectedValueOnce(new Error('native start denied'));

        await expect(BgGeoManager.requestStart()).rejects.toThrow('native start denied');
        expect(await BgGeoManager.getLeaseState()).toMatchObject({
            active: false,
            activeLeaseCount: 0,
            nativeTrackingEnabled: false,
        });

        await BgGeoManager.requestStop();
        expect(native.stop).not.toHaveBeenCalled();

        const recovered = await BgGeoManager.requestStart();
        expect(recovered).toMatchObject({ active: true, activeLeaseCount: 1 });
        expect(native.start).toHaveBeenCalledTimes(2);
    });

    it('cleans up a bridge start that resolves without an enabled native state', async () => {
        native.start.mockImplementationOnce(async () => undefined);

        await expect(BgGeoManager.requestStart()).rejects.toThrow('did not report an active native engine');
        expect(native.stop).toHaveBeenCalledOnce();
        expect(await BgGeoManager.getLeaseState()).toMatchObject({
            active: false,
            activeLeaseCount: 0,
            nativeTrackingEnabled: false,
        });
    });

    it('retains an inactive retryable lease when unverified-start cleanup rejects', async () => {
        native.start.mockImplementationOnce(async () => undefined);
        native.stop.mockRejectedValueOnce(new Error('cleanup stop denied'));

        const retained = await BgGeoManager.requestStart();

        expect(retained).toMatchObject({
            active: false,
            activeLeaseCount: 1,
            nativeTrackingEnabled: false,
        });
        expect(await BgGeoManager.getLeaseState()).toMatchObject({ active: false, activeLeaseCount: 1 });

        await expect(BgGeoManager.requestStop()).resolves.toMatchObject({ active: false, activeLeaseCount: 0 });
        expect(native.stop).toHaveBeenCalledTimes(2);
    });

    it('claims a now-verified active engine when unverified-start cleanup rejects', async () => {
        native.getState
            .mockResolvedValueOnce({ enabled: false })
            .mockRejectedValueOnce(new Error('post-start readback unavailable'))
            .mockResolvedValueOnce({ enabled: true });
        native.stop.mockRejectedValueOnce(new Error('cleanup stop denied'));

        const retained = await BgGeoManager.requestStart();

        expect(retained).toMatchObject({
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });
        expect(native.changePace).toHaveBeenCalledWith(true);

        await expect(BgGeoManager.requestStop()).resolves.toMatchObject({ active: false, activeLeaseCount: 0 });
    });

    it('retains the final lease and rejects when native stop fails', async () => {
        await BgGeoManager.requestStart();
        native.stop.mockRejectedValueOnce(new Error('native stop failed'));

        await expect(BgGeoManager.requestStop()).rejects.toThrow('native stop failed');
        expect(await BgGeoManager.getLeaseState()).toMatchObject({
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });

        await expect(BgGeoManager.requestStop()).resolves.toMatchObject({ active: false, activeLeaseCount: 0 });
    });

    it('retains ownership when stop resolves but readback remains enabled', async () => {
        await BgGeoManager.requestStart();
        native.stop.mockImplementationOnce(async () => undefined);

        await expect(BgGeoManager.requestStop()).rejects.toThrow('remained enabled');
        expect(await BgGeoManager.getLeaseState()).toMatchObject({ active: true, activeLeaseCount: 1 });

        await BgGeoManager.requestStop();
    });

    it('force-stop rejects and preserves the prior lease count when teardown is not verified', async () => {
        await Promise.all([BgGeoManager.requestStart(), BgGeoManager.requestStart()]);
        native.stop.mockRejectedValueOnce(new Error('force-stop denied'));

        await expect(BgGeoManager.forceStop()).rejects.toThrow('force-stop denied');
        expect(await BgGeoManager.getLeaseState()).toMatchObject({
            active: true,
            activeLeaseCount: 2,
            nativeTrackingEnabled: true,
        });

        await expect(BgGeoManager.forceStop()).resolves.toMatchObject({ active: false, activeLeaseCount: 0 });
    });

    it('revalidates a retained inactive lease without incrementing its logical count', async () => {
        await BgGeoManager.requestStart();
        native.setEnabled(false);

        const recovered = await BgGeoManager.revalidateExistingLease();

        expect(recovered).toMatchObject({ active: true, activeLeaseCount: 1, nativeTrackingEnabled: true });
        expect(native.start).toHaveBeenCalledTimes(2);
        await BgGeoManager.requestStop();
    });

    it('does not report a revalidated lease active when manual moving pace fails', async () => {
        await BgGeoManager.requestStart();
        native.setEnabled(false);
        native.changePace.mockRejectedValueOnce(new Error('pace unavailable'));

        await expect(BgGeoManager.revalidateExistingLease()).rejects.toThrow(
            'could not resume continuous marine tracking',
        );
        expect(await BgGeoManager.getLeaseState()).toMatchObject({ activeLeaseCount: 1 });
        await BgGeoManager.requestStop();
    });

    it('propagates native geofence removal failures', async () => {
        native.removeGeofence.mockRejectedValueOnce(new Error('native fence removal denied'));

        await expect(BgGeoManager.removeGeofence('anchor-swing-radius')).rejects.toThrow('native fence removal denied');
        expect(native.geofenceExists).not.toHaveBeenCalled();
    });

    it('rejects a resolved geofence removal when native readback still finds the fence', async () => {
        native.geofenceExists.mockResolvedValueOnce(true);

        await expect(BgGeoManager.removeGeofence('anchor-swing-radius')).rejects.toThrow(
            'remained registered after removal',
        );
        expect(native.removeGeofence).toHaveBeenCalledWith('anchor-swing-radius');
        expect(native.geofenceExists).toHaveBeenCalledWith('anchor-swing-radius');
    });
});
