import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        vi.clearAllMocks();
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
