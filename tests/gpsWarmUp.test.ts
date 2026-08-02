import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The launch GPS warm-up (Shane 2026-08-02: "the acquiring GPS fix sits there
 * for hours... maybe we could do the warm up as soon as we kick the app off").
 *
 * It is a convenience wrapped around a shared, safety-critical resource, so its
 * three invariants matter more than the feature:
 *   1. never raises a permission prompt (bail unless already granted);
 *   2. never fights the engine ref-count (exactly one lease, one release);
 *   3. never outlives its welcome (fix | time box | backgrounded).
 */

const h = vi.hoisted(() => ({
    getGpsHealth: vi.fn(),
    getLastPosition: vi.fn(),
    requestStart: vi.fn(async () => {}),
    requestStop: vi.fn(async () => {}),
    setSamplingMode: vi.fn(async () => 7),
    restoreSamplingModeIfCurrent: vi.fn(async () => {}),
    locationCb: null as null | ((p: { accuracy?: number }) => void),
    unsubscribe: vi.fn(),
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getGpsHealth: h.getGpsHealth,
        getLastPosition: h.getLastPosition,
        requestStart: h.requestStart,
        requestStop: h.requestStop,
        setSamplingMode: h.setSamplingMode,
        restoreSamplingModeIfCurrent: h.restoreSamplingModeIfCurrent,
        subscribeLocation: (cb: (p: { accuracy?: number }) => void) => {
            h.locationCb = cb;
            return h.unsubscribe;
        },
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (e: unknown) => String(e),
}));

import { warmUpGps, resetGpsWarmUpForTest } from '../services/gpsWarmUp';

const setVisibility = (value: 'visible' | 'hidden') =>
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });

beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetGpsWarmUpForTest();
    h.locationCb = null;
    setVisibility('visible');
    h.getGpsHealth.mockResolvedValue({ usable: true, reason: 'ok' });
    h.getLastPosition.mockReturnValue(null);
});

afterEach(() => {
    // Release any warm-up this test left running. Production calls warmUpGps
    // ONCE per launch and every exit releases, so this is test-suite hygiene
    // rather than a leak: without it a listener from an earlier test also
    // answers the next test's visibilitychange and double-counts requestStop.
    setVisibility('hidden');
    window.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
});

describe('warmUpGps — invariant 1: never prompt', () => {
    it.each([
        ['not-determined', 'a first-ever launch, before onboarding explains itself'],
        ['denied', 'the skipper said no'],
        ['services-off', 'Location Services off device-wide'],
    ])('does not start the engine when permission is %s (%s)', async (reason) => {
        h.getGpsHealth.mockResolvedValue({ usable: false, reason });
        await warmUpGps();
        expect(h.requestStart).not.toHaveBeenCalled();
    });

    it('starts only when permission is already granted', async () => {
        await warmUpGps();
        expect(h.requestStart).toHaveBeenCalledTimes(1);
    });
});

describe('warmUpGps — invariant 2: one lease, one release', () => {
    it('releases exactly once even if several exits fire', async () => {
        await warmUpGps();
        expect(h.requestStart).toHaveBeenCalledTimes(1);

        // A good fix releases…
        h.locationCb?.({ accuracy: 8 });
        // …and further fixes, plus a backgrounding, must NOT release again.
        // requestStop clamps at zero, so a double release would stop the
        // engine out from under a live anchor watch or MOB.
        h.locationCb?.({ accuracy: 6 });
        setVisibility('hidden');
        window.dispatchEvent(new Event('visibilitychange'));

        expect(h.requestStop).toHaveBeenCalledTimes(1);
        expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('runs once per launch — a second call is a no-op', async () => {
        await warmUpGps();
        await warmUpGps();
        expect(h.requestStart).toHaveBeenCalledTimes(1);
    });
});

describe('warmUpGps — invariant 3: exits', () => {
    it('holds on for a poor fix and releases on a good one', async () => {
        await warmUpGps();
        h.locationCb?.({ accuracy: 400 }); // still hunting — worse than the marine-usable bar
        expect(h.requestStop).not.toHaveBeenCalled();

        h.locationCb?.({ accuracy: 12 });
        expect(h.requestStop).toHaveBeenCalledTimes(1);
    });

    it('releases when the app goes to the background', async () => {
        await warmUpGps();
        setVisibility('hidden');
        window.dispatchEvent(new Event('visibilitychange'));
        expect(h.requestStop).toHaveBeenCalledTimes(1);
    });

    it('releases on the time box when no fix ever arrives', async () => {
        vi.useFakeTimers();
        await warmUpGps();
        expect(h.requestStop).not.toHaveBeenCalled();
        vi.advanceTimersByTime(45_000);
        expect(h.requestStop).toHaveBeenCalledTimes(1);
    });
});

describe('warmUpGps — costs nothing when there is nothing to gain', () => {
    it('skips entirely when a recent fix is already cached', async () => {
        h.getLastPosition.mockReturnValue({ receivedAt: Date.now() - 30_000 });
        await warmUpGps();
        expect(h.requestStart).not.toHaveBeenCalled();
    });

    it('DOES warm up when the cached fix is stale', async () => {
        h.getLastPosition.mockReturnValue({ receivedAt: Date.now() - 10 * 60_000 });
        await warmUpGps();
        expect(h.requestStart).toHaveBeenCalledTimes(1);
    });

    it('asks for fast-lock — at the 1 m filter a moored boat emits nothing', async () => {
        await warmUpGps();
        expect(h.setSamplingMode).toHaveBeenCalledWith('fastlock');
    });

    it('PUTS THE ENGINE BACK on release — distanceFilter 0 is maximum battery', async () => {
        // The engine is shared. If any other consumer still holds a lease when
        // the warm-up lets go (the Glass page does), the engine keeps running —
        // and without this it would run at distanceFilter 0 for the rest of the
        // session, flattening the phone mid-passage.
        await warmUpGps();
        h.locationCb?.({ accuracy: 9 });
        expect(h.restoreSamplingModeIfCurrent).toHaveBeenCalledWith(7, 'default');
    });

    it('restores through a TOKEN, so casting off mid-warm-up is not overridden', async () => {
        // Token semantics live in BgGeoManager (a no-op when someone else has
        // since set the mode). What this pins is that the warm-up passes the
        // token it was given rather than blindly forcing 'default' — which
        // would cancel the ship's log fast-lock and restore the original hang.
        await warmUpGps();
        h.locationCb?.({ accuracy: 9 });
        const [token] = h.restoreSamplingModeIfCurrent.mock.calls[0] as [number, string];
        expect(token).toBe(await h.setSamplingMode.mock.results[0].value);
    });
});
