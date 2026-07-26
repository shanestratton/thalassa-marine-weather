/**
 * Tests for EnvironmentPoller — verifies the 60s loop calls the right
 * callbacks and survives an exception in the water-detection check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentPoller } from '../services/shiplog/EnvironmentPoller';
import type { CachedPosition } from '../services/BgGeoManager';
import type { WaterCheckResult } from '../services/shiplog/waterDetection';

let waterCheck: (lat: number, lon: number) => Promise<WaterCheckResult>;

vi.mock('../services/shiplog/waterDetection', () => ({
    checkWaterStatus: (lat: number, lon: number) => waterCheck(lat, lon),
}));

const POLL_INTERVAL_MS = 60_000;

function makePos(lat: number, lon: number): CachedPosition {
    return {
        latitude: lat,
        longitude: lon,
        accuracy: 5,
        altitude: null,
        heading: 0,
        speed: 0,
        timestamp: Date.now(),
        receivedAt: Date.now(),
    } as CachedPosition;
}

describe('EnvironmentPoller', () => {
    let poller: EnvironmentPoller;

    beforeEach(() => {
        vi.useFakeTimers();
        poller = new EnvironmentPoller();
        waterCheck = async (lat, lon) => ({
            isWater: true,
            feature: 'OCEAN',
            lat,
            lon,
            failedOpen: false,
        });
    });

    afterEach(() => {
        poller.stop();
        vi.useRealTimers();
    });

    it('fires both callbacks once per interval tick', async () => {
        const onWater = vi.fn<(status: WaterCheckResult) => void>();
        const onZone = vi.fn<(position: CachedPosition, status: WaterCheckResult) => Promise<void>>(async () => {});
        const position = makePos(-27.5, 153);
        const status: WaterCheckResult = {
            isWater: true,
            feature: 'OCEAN',
            lat: position.latitude,
            lon: position.longitude,
            failedOpen: false,
        };
        waterCheck = async () => status;
        poller.start({
            getPos: () => position,
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: onZone,
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(onWater).toHaveBeenCalledTimes(1);
        expect(onWater).toHaveBeenCalledWith(status);
        expect(onWater.mock.calls[0][0]).toBe(status);
        expect(onZone).toHaveBeenCalledTimes(1);
        expect(onZone).toHaveBeenCalledWith(position, status);
        expect(onZone.mock.calls[0][0]).toBe(position);
        expect(onZone.mock.calls[0][1]).toBe(status);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(onWater).toHaveBeenCalledTimes(2);
    });

    it('checks immediately when the first vetted GPS fix opens a track, without bypassing the one-minute cap', async () => {
        const onWater = vi.fn();
        const onZone = vi.fn(async () => {});
        const position = makePos(-27.5, 153);
        poller.start({
            getPos: () => position,
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: onZone,
        });

        poller.requestCheck();
        await vi.advanceTimersByTimeAsync(0);
        expect(onWater).toHaveBeenCalledTimes(1);
        expect(onZone).toHaveBeenCalledWith(position, expect.objectContaining({ feature: 'OCEAN' }));

        // Consecutive accepted raw fixes must not turn this into a network
        // request per GPS update.
        poller.requestCheck();
        await vi.advanceTimersByTimeAsync(0);
        expect(onWater).toHaveBeenCalledTimes(1);
    });

    it('skips when isActive returns false', async () => {
        const onWater = vi.fn();
        poller.start({
            getPos: () => makePos(0, 0),
            isActive: () => false,
            onWaterStatus: onWater,
            onZoneRecheck: async () => {},
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
        expect(onWater).toHaveBeenCalledTimes(0);
    });

    it('skips when getPos returns null', async () => {
        const onWater = vi.fn();
        poller.start({
            getPos: () => null,
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: async () => {},
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
        expect(onWater).toHaveBeenCalledTimes(0);
    });

    it('keeps running if the water-check throws', async () => {
        const onWater = vi.fn();
        const onZone = vi.fn(async () => {});
        let firstTick = true;
        waterCheck = async () => {
            if (firstTick) {
                firstTick = false;
                throw new Error('tile fetch failed');
            }
            return {
                isWater: false,
                feature: 'LAND',
                lat: -27.5,
                lon: 153,
                failedOpen: false,
            };
        };
        poller.start({
            getPos: () => makePos(0, 0),
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: onZone,
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // tick 1 throws
        expect(onWater).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // tick 2 ok
        expect(onWater).toHaveBeenCalledTimes(1);
        expect(onWater).toHaveBeenCalledWith(
            expect.objectContaining({ isWater: false, feature: 'LAND', failedOpen: false }),
        );
    });

    it('stop() halts further ticks', async () => {
        const onWater = vi.fn();
        poller.start({
            getPos: () => makePos(0, 0),
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: async () => {},
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        poller.stop();
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
        expect(onWater).toHaveBeenCalledTimes(1);
    });

    it('start() clears any prior timer (re-call safe)', async () => {
        const onWater = vi.fn();
        poller.start({
            getPos: () => makePos(0, 0),
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: async () => {},
        });
        // Re-start before any tick fires
        poller.start({
            getPos: () => makePos(0, 0),
            isActive: () => true,
            onWaterStatus: onWater,
            onZoneRecheck: async () => {},
        });
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        // Should fire only once even though start was called twice.
        expect(onWater).toHaveBeenCalledTimes(1);
    });
});
