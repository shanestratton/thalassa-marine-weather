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

// Build 123, package VL: without Always, iOS will not START While Using
// location from the background. A cast-off whose GPS start was deferred for
// that waits for Thalassa to be in front — it does not burn the 8 s / 30 s
// ladder knocking on a door iOS keeps shut — and starts the moment it is.
describe('a GPS start deferred to the foreground', () => {
    const setVisibility = (state: 'visible' | 'hidden') => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
    };
    afterEach(() => setVisibility('visible'));

    it('spends no ladder rungs in the background and starts on the next foreground', async () => {
        stashCastOffHandoff({
            voyageId: 'deferred-cast-off',
            voyageName: 'Solent passage',
            caution: null,
            publishRoute: false,
        });
        setVisibility('hidden');
        harness.start.mockRejectedValueOnce(
            new Error(
                'Voyage logging will start when Thalassa is open: iOS only starts While Using location in the foreground.',
            ),
        );
        await startHandoffGps();
        expect(peekCastOffHandoff()).toMatchObject({ gps: 'failed', retryCount: 0 });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.start).toHaveBeenCalledTimes(1);

        harness.start.mockImplementationOnce(async () => {
            harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'deferred-cast-off' });
        });
        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.start).toHaveBeenCalledTimes(2);
        expect(harness.start).toHaveBeenLastCalledWith(true, 'deferred-cast-off', expect.anything(), true);
        expect(peekCastOffHandoff()).toMatchObject({ gps: 'confirmed' });
    });

    it('a deferred start restored into an app that opened straight to the front starts without waiting for a visibility change', async () => {
        // iOS ended Thalassa in the background with the start deferred; the
        // skipper reopens it. The page loads visible, so no visibilitychange
        // fires — it used to sit at "will start when Thalassa is open" while
        // Thalassa was open.
        stashCastOffHandoff({
            voyageId: 'deferred-then-killed',
            voyageName: 'Chesapeake passage',
            caution: null,
            publishRoute: false,
        });
        setVisibility('hidden');
        harness.start.mockRejectedValueOnce(
            new Error(
                'Voyage logging will start when Thalassa is open: iOS only starts While Using location in the foreground.',
            ),
        );
        await startHandoffGps();
        expect(peekCastOffHandoff()).toMatchObject({ gps: 'failed' });

        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        vi.resetModules();
        const restored = await import('../services/castOffHandoff');
        expect(restored.peekCastOffHandoff()).toMatchObject({ gps: 'failed', voyageId: 'deferred-then-killed' });
        harness.start.mockImplementationOnce(async () => {
            harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'deferred-then-killed' });
        });
        const callsBefore = harness.start.mock.calls.length;
        await vi.advanceTimersByTimeAsync(8_000);
        expect(harness.start.mock.calls.length).toBe(callsBefore + 1);
        expect(harness.start).toHaveBeenLastCalledWith(true, 'deferred-then-killed', expect.anything(), true);
        expect(restored.peekCastOffHandoff()).toMatchObject({ gps: 'confirmed' });
        restored.clearCastOffHandoff();
    });
});
