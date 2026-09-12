import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
    ensureReady: vi.fn(),
    requestStart: vi.fn(),
    requestStop: vi.fn(),
    subscribeLocation: vi.fn(),
    getLastPosition: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/geolocation', () => ({
    Geolocation: {
        checkPermissions: native.checkPermissions,
        requestPermissions: native.requestPermissions,
        getCurrentPosition: native.getCurrentPosition,
        watchPosition: native.watchPosition,
        clearWatch: native.clearWatch,
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: native.ensureReady,
        requestStart: native.requestStart,
        requestStop: native.requestStop,
        subscribeLocation: native.subscribeLocation,
        getLastPosition: native.getLastPosition,
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GpsService } from '../services/GpsService';

const granted = { location: 'granted', coarseLocation: 'granted' };
const prompt = { location: 'prompt', coarseLocation: 'prompt' };

function nativeFix() {
    return {
        coords: {
            latitude: -27.47,
            longitude: 153.03,
            accuracy: 8,
            altitude: null,
            altitudeAccuracy: null,
            heading: 91,
            speed: 2,
        },
        timestamp: Date.now(),
    };
}

describe('GpsService native privacy boundary', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        native.checkPermissions.mockResolvedValue(prompt);
        native.requestPermissions.mockResolvedValue(granted);
        native.getCurrentPosition.mockImplementation(async () => nativeFix());
        native.watchPosition.mockResolvedValue('native-watch-1');
        native.clearWatch.mockResolvedValue(undefined);
        native.ensureReady.mockResolvedValue(undefined);
        native.requestStart.mockResolvedValue({
            supported: true,
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });
        native.requestStop.mockResolvedValue({
            supported: true,
            active: false,
            activeLeaseCount: 0,
            nativeTrackingEnabled: false,
        });
        native.subscribeLocation.mockReturnValue(vi.fn());
        native.getLastPosition.mockReturnValue(null);
    });

    it('keeps a passive one-shot silent when no foreground grant exists', async () => {
        await expect(GpsService.getCurrentPositionIfGranted()).resolves.toBeNull();

        expect(native.checkPermissions).toHaveBeenCalledOnce();
        expect(native.requestPermissions).not.toHaveBeenCalled();
        expect(native.getCurrentPosition).not.toHaveBeenCalled();
        expect(native.ensureReady).not.toHaveBeenCalled();
    });

    it('keeps a passive watch silent and never imports the background engine path', async () => {
        const unsubscribe = GpsService.watchPosition(vi.fn());
        await vi.waitFor(() => expect(native.checkPermissions).toHaveBeenCalledOnce());

        expect(native.watchPosition).not.toHaveBeenCalled();
        expect(native.ensureReady).not.toHaveBeenCalled();
        expect(native.requestStart).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('uses only an already-granted foreground watch and clears it on teardown', async () => {
        native.checkPermissions.mockResolvedValue(granted);

        const unsubscribe = GpsService.watchPosition(vi.fn());
        await vi.waitFor(() => expect(native.watchPosition).toHaveBeenCalledOnce());
        expect(native.ensureReady).not.toHaveBeenCalled();
        expect(native.requestStart).not.toHaveBeenCalled();

        unsubscribe();
        await vi.waitFor(() => expect(native.clearWatch).toHaveBeenCalledWith({ id: 'native-watch-1' }));
    });

    it('requests coarse foreground location for an ordinary explicit action', async () => {
        await expect(GpsService.requestCurrentForegroundPosition()).resolves.toMatchObject({
            latitude: -27.47,
            longitude: 153.03,
        });

        expect(native.requestPermissions).toHaveBeenCalledWith({ permissions: ['coarseLocation'] });
        expect(native.getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }));
        expect(native.ensureReady).not.toHaveBeenCalled();
        expect(native.requestStart).not.toHaveBeenCalled();
    });

    describe('cold foreground acquisition', () => {
        const requestedAt = new Date('2026-09-11T01:00:00Z').getTime();

        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(requestedAt);
            native.checkPermissions.mockResolvedValue(granted);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('waits for a fresh native fix after a stale first callback without prompting or starting background GPS', async () => {
            native.getCurrentPosition.mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 60_000 });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });
            const settled = vi.fn();
            void position.then(settled);

            await vi.advanceTimersByTimeAsync(249);
            expect(settled).not.toHaveBeenCalled();
            expect(native.getCurrentPosition).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(1);
            await expect(position).resolves.toMatchObject({ latitude: -27.47, timestamp: requestedAt + 250 });
            expect(native.getCurrentPosition).toHaveBeenCalledTimes(2);
            expect(native.requestPermissions).not.toHaveBeenCalled();
            expect(native.ensureReady).not.toHaveBeenCalled();
            expect(native.requestStart).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('throttles repeatedly stale native callbacks and stops at the original deadline', async () => {
            native.getCurrentPosition.mockResolvedValue({ ...nativeFix(), timestamp: requestedAt - 60_000 });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });
            const settled = vi.fn();
            void position.then(settled);

            await vi.advanceTimersByTimeAsync(999);
            expect(settled).not.toHaveBeenCalled();
            expect(native.getCurrentPosition).toHaveBeenCalledTimes(4);
            await vi.advanceTimersByTimeAsync(1);
            await expect(position).resolves.toBeNull();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(native.getCurrentPosition).toHaveBeenCalledTimes(4);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('retries the native position-unavailable code and accepts a subsequent fresh fix', async () => {
            native.getCurrentPosition.mockRejectedValueOnce({ code: 'OS-PLUG-GLOC-0002' });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(249);
            expect(native.getCurrentPosition).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);
            await expect(position).resolves.toMatchObject({ timestamp: requestedAt + 250 });
            expect(native.getCurrentPosition).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('ends repeated native position-unavailable errors at the original deadline', async () => {
            native.getCurrentPosition.mockRejectedValue({ code: 'OS-PLUG-GLOC-0002' });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });
            const settled = vi.fn();
            void position.then(settled);

            await vi.advanceTimersByTimeAsync(999);
            expect(settled).not.toHaveBeenCalled();
            expect(native.getCurrentPosition).toHaveBeenCalledTimes(4);
            await vi.advanceTimersByTimeAsync(1);
            await expect(position).resolves.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('also reacquires a stale fix for an explicit foreground action', async () => {
            native.getCurrentPosition.mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 60_000 });
            const position = GpsService.requestCurrentForegroundPosition({ staleLimitMs: 10_000, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(250);
            await expect(position).resolves.toMatchObject({ timestamp: requestedAt + 250 });
            expect(native.getCurrentPosition).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ enableHighAccuracy: false }),
            );
            expect(native.requestPermissions).not.toHaveBeenCalled();
            expect(native.ensureReady).not.toHaveBeenCalled();
            expect(native.requestStart).not.toHaveBeenCalled();
        });

        it('passes only the remaining timeout to a retry and bounds an unresponsive native request', async () => {
            native.getCurrentPosition
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            setTimeout(() => resolve({ ...nativeFix(), timestamp: requestedAt - 60_000 }), 300);
                        }),
                )
                .mockImplementationOnce(() => new Promise(() => {}));
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });
            const settled = vi.fn();
            void position.then(settled);

            await vi.advanceTimersByTimeAsync(550);
            expect(native.getCurrentPosition).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ timeout: 450, maximumAge: 10_000 }),
            );
            await vi.advanceTimersByTimeAsync(449);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await expect(position).resolves.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('keeps the original request-time freshness boundary across a delayed retry', async () => {
            native.getCurrentPosition
                .mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 60_000 })
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            setTimeout(() => resolve({ ...nativeFix(), timestamp: requestedAt - 10_000 }), 500);
                        }),
                );
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(750);
            await expect(position).resolves.toMatchObject({ timestamp: requestedAt - 10_000 });
        });

        it('accepts a newly acquired fix after a stale callback when maximum age is zero', async () => {
            native.getCurrentPosition
                .mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 1 })
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            setTimeout(() => resolve(nativeFix()), 500);
                        }),
                );
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 0, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(750);
            await expect(position).resolves.toMatchObject({ timestamp: requestedAt + 750 });
        });

        it.each([
            ['invalid timestamp', { timestamp: Number.NaN }],
            ['zero timestamp', { timestamp: 0 }],
            ['future timestamp', { timestamp: requestedAt + 1_001 }],
            ['invalid latitude', { coords: { latitude: Number.NaN, longitude: 153.03 } }],
            ['out-of-range latitude', { coords: { latitude: 91, longitude: 153.03 } }],
            ['out-of-range longitude', { coords: { latitude: -27.47, longitude: 181 } }],
            [
                'invalid coordinates on a stale callback',
                { timestamp: requestedAt - 60_000, coords: { latitude: Number.NaN, longitude: 153.03 } },
            ],
        ])('fails closed without retrying an %s', async (_label, invalid) => {
            native.getCurrentPosition.mockResolvedValueOnce({ ...nativeFix(), ...invalid });

            await expect(GpsService.getCurrentPositionIfGranted()).resolves.toBeNull();
            expect(native.getCurrentPosition).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        });

        it.each([
            { code: 'OS-PLUG-GLOC-0003' },
            { code: 'OS-PLUG-GLOC-0007' },
            { code: 'OS-PLUG-GLOC-0008' },
            { code: 'OS-PLUG-GLOC-0010' },
            { code: 'UNKNOWN' },
            { message: 'There was an error trying to obtain the location.' },
        ])('does not retry a non-transient or unclassified native error: %o', async (error) => {
            native.getCurrentPosition.mockRejectedValueOnce(error);

            await expect(GpsService.getCurrentPositionIfGranted()).resolves.toBeNull();
            expect(native.getCurrentPosition).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('does not start acquisition or retry when permission is denied', async () => {
            native.checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });

            await expect(GpsService.getCurrentPositionIfGranted()).resolves.toBeNull();
            expect(native.getCurrentPosition).not.toHaveBeenCalled();
            expect(native.requestPermissions).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('stops before a retry if the foreground grant has been revoked', async () => {
            native.checkPermissions
                .mockResolvedValueOnce(granted)
                .mockResolvedValueOnce({ location: 'denied', coarseLocation: 'denied' });
            native.getCurrentPosition.mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 60_000 });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(250);
            await expect(position).resolves.toBeNull();
            expect(native.checkPermissions).toHaveBeenCalledTimes(2);
            expect(native.getCurrentPosition).toHaveBeenCalledOnce();
            expect(native.requestPermissions).not.toHaveBeenCalled();
        });

        it('preserves approximate-only permission when reacquiring a fresh fix', async () => {
            native.checkPermissions
                .mockResolvedValueOnce(granted)
                .mockResolvedValueOnce({ location: 'denied', coarseLocation: 'granted' });
            native.getCurrentPosition.mockResolvedValueOnce({ ...nativeFix(), timestamp: requestedAt - 60_000 });
            const position = GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 1 });

            await vi.advanceTimersByTimeAsync(250);
            await expect(position).resolves.toMatchObject({ timestamp: requestedAt + 250 });
            expect(native.getCurrentPosition).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ enableHighAccuracy: false }),
            );
            expect(native.requestPermissions).not.toHaveBeenCalled();
        });
    });

    it('initializes and leases background GPS only for an explicit safety watch', async () => {
        const unsubscribe = GpsService.watchPosition(vi.fn(), { ensureRunning: true });
        await vi.waitFor(() => expect(native.requestStart).toHaveBeenCalledOnce());

        expect(native.ensureReady).toHaveBeenCalledOnce();
        expect(native.subscribeLocation).toHaveBeenCalledOnce();
        expect(native.checkPermissions).not.toHaveBeenCalled();

        unsubscribe();
        await vi.waitFor(() => expect(native.requestStop).toHaveBeenCalledOnce());
    });

    it('releases an inactive retained safety lease without subscribing to positions', async () => {
        native.requestStart.mockResolvedValueOnce({
            supported: true,
            active: false,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });

        GpsService.watchPosition(vi.fn(), { ensureRunning: true });
        await vi.waitFor(() => expect(native.requestStop).toHaveBeenCalledOnce());

        expect(native.subscribeLocation).not.toHaveBeenCalled();
    });
});
