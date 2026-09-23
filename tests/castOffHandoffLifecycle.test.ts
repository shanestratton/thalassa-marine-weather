import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    start: vi.fn(),
    status: vi.fn(),
    stop: vi.fn(),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { startTracking: harness.start, getTrackingStatus: harness.status, stopTracking: harness.stop },
}));

import {
    clearCastOffHandoff,
    peekCastOffHandoff,
    stashCastOffHandoff,
    startHandoffGps,
} from '../services/castOffHandoff';

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    clearCastOffHandoff();
    harness.status.mockReturnValue({ isTracking: false });
});
afterEach(() => {
    clearCastOffHandoff();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('Cast Off departure intent', () => {
    it('preserves fresh departure through a failed GPS start and consumes it after confirmation', async () => {
        stashCastOffHandoff({
            voyageId: 'new-cast-off',
            voyageName: 'New passage',
            caution: null,
            publishRoute: false,
        });
        harness.start.mockRejectedValueOnce(new Error('GPS not ready'));
        await startHandoffGps();
        expect(peekCastOffHandoff()).toMatchObject({ gps: 'failed', freshDeparture: true });
        harness.start.mockImplementationOnce(async () => {
            harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'new-cast-off' });
        });
        await startHandoffGps(true);
        expect(harness.start).toHaveBeenLastCalledWith(true, 'new-cast-off', expect.anything(), true);
        expect(peekCastOffHandoff()).toMatchObject({ gps: 'confirmed', freshDeparture: false });
    });

    it('keeps reattachment to an existing voyage distinct from a new Cast Off', async () => {
        stashCastOffHandoff({
            voyageId: 'existing',
            voyageName: 'Existing passage',
            caution: null,
            publishRoute: false,
            freshDeparture: false,
        });
        harness.start.mockImplementationOnce(async () => {
            harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'existing' });
        });
        await startHandoffGps(true);
        expect(harness.start).toHaveBeenLastCalledWith(true, 'existing', expect.anything(), false);
    });

    it('restores departure intent when the WebView died before GPS confirmed', async () => {
        stashCastOffHandoff({
            voyageId: 'interrupted-cast-off',
            voyageName: 'Interrupted departure',
            caution: null,
            publishRoute: false,
        });
        vi.resetModules();
        const restored = await import('../services/castOffHandoff');
        expect(restored.peekCastOffHandoff()).toMatchObject({ gps: 'failed', freshDeparture: true });
        harness.start.mockImplementationOnce(async () => {
            harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'interrupted-cast-off' });
        });
        await restored.startHandoffGps(true);
        expect(harness.start).toHaveBeenLastCalledWith(true, 'interrupted-cast-off', expect.anything(), true);
        restored.clearCastOffHandoff();
    });
});
