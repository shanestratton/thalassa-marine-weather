/**
 * Tests for GpsSubscriptionManager — focuses on the per-fix gating
 * logic (cold-start warm-up, speed-tier debounce, fix-acceptance gate)
 * since the BgGeo / NMEA / web-geolocation subscriptions are external
 * stubs we don't try to drive end-to-end.
 *
 * The strategy: capture the BgGeo location callback registered in
 * `start()` and call it directly with synthetic positions. That gives
 * us tight control over the gating logic without owning the platform
 * stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpsSubscriptionManager } from '../services/shiplog/GpsSubscriptionManager';
import { GpsTrackBuffer } from '../services/shiplog/GpsTrackBuffer';
import type { CachedPosition } from '../services/BgGeoManager';

let capturedLocationHandler: ((pos: CachedPosition) => void) | null = null;

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        subscribeLocation: (cb: (pos: CachedPosition) => void) => {
            capturedLocationHandler = cb;
            return () => {
                capturedLocationHandler = null;
            };
        },
        subscribeHeartbeat: () => () => {},
        subscribeActivity: () => () => {},
    },
}));

vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        onPosition: () => () => {},
    },
}));

vi.mock('../services/EnvironmentService', () => ({
    EnvironmentService: {
        updateFromGPS: vi.fn(),
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        feed: vi.fn(),
        getAdaptedThresholds: () => ({ courseChangeMinMovementM: 1 }),
        reset: vi.fn(),
    },
}));

function makeFix(overrides: Partial<CachedPosition> = {}): CachedPosition {
    return {
        latitude: -27.5,
        longitude: 153.0,
        accuracy: 5,
        altitude: 0,
        heading: 0,
        speed: 5, // m/s ≈ 9.7 kts
        timestamp: Date.now(),
        receivedAt: Date.now(),
        ...overrides,
    } as CachedPosition;
}

describe('GpsSubscriptionManager', () => {
    let mgr: GpsSubscriptionManager;
    let trackBuffer: GpsTrackBuffer;
    let onFix: ReturnType<typeof vi.fn>;
    let onSpeedTierChanged: ReturnType<typeof vi.fn>;
    let onHeartbeatTick: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
        mgr = new GpsSubscriptionManager();
        trackBuffer = new GpsTrackBuffer();
        onFix = vi.fn();
        onSpeedTierChanged = vi.fn();
        onHeartbeatTick = vi.fn();
    });

    afterEach(() => {
        mgr.stop();
        capturedLocationHandler = null;
        vi.useRealTimers();
    });

    function startMgr(opts: Partial<{ active: boolean; rapid: boolean }> = {}) {
        mgr.start({
            isNative: true,
            trackBuffer,
            isActive: () => opts.active ?? true,
            isRapidMode: () => opts.rapid ?? false,
            getIntervalMs: () => 60_000,
            getLastEntryTime: () => undefined,
            // Cast through unknown to match the manager's strict signatures —
            // vi.fn() returns a Mock<...> which structurally satisfies the
            // call shape but TS won't narrow without help.
            onFix: onFix as unknown as (pos: CachedPosition) => void,
            onSpeedTierChanged: onSpeedTierChanged as unknown as () => void,
            onHeartbeatTick: onHeartbeatTick as unknown as () => void,
        });
    }

    describe('cold-start warm-up', () => {
        it('publishes via onFix during warm-up but does not buffer', () => {
            startMgr();
            // Warm-up window is 5s; we're at t=0
            capturedLocationHandler!(makeFix({ timestamp: Date.now() }));
            expect(onFix).toHaveBeenCalledTimes(1);
            expect(trackBuffer.length).toBe(0);
        });

        it('starts buffering after 5s', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);
            capturedLocationHandler!(makeFix({ timestamp: Date.now() }));
            expect(trackBuffer.length).toBe(1);
        });
    });

    describe('fix-acceptance gate', () => {
        beforeEach(() => {
            startMgr();
            vi.advanceTimersByTime(5_001); // exit warm-up
        });

        it('rejects fixes with accuracy > 100m', () => {
            capturedLocationHandler!(makeFix({ accuracy: 150 }));
            expect(trackBuffer.length).toBe(0);
        });

        it('rejects fixes with GPS speed > 25 kts', () => {
            capturedLocationHandler!(makeFix({ speed: 14 })); // 14 m/s ≈ 27 kts
            expect(trackBuffer.length).toBe(0);
        });

        it('rejects fixes implying > 37.5 kts via Haversine ÷ Δt', () => {
            // First fix: seed the buffer at lat 0, lon 0, t=now
            capturedLocationHandler!(makeFix({ latitude: 0, longitude: 0, timestamp: Date.now(), speed: 0 }));
            expect(trackBuffer.length).toBe(1);
            // Second fix 1s later, but at lat 0.1 (≈11.1km away) → ~20,000 kts implied
            const t1 = Date.now() + 1_000;
            capturedLocationHandler!(makeFix({ latitude: 0.1, longitude: 0, timestamp: t1, receivedAt: t1, speed: 0 }));
            expect(trackBuffer.length).toBe(1); // rejected
        });

        it('skips position-spike check on <100ms duplicate fixes', () => {
            const t0 = Date.now();
            capturedLocationHandler!(makeFix({ latitude: 0, longitude: 0, timestamp: t0, speed: 0 }));
            // Same fix replayed 50ms later — would imply teleport speed but
            // the dt-too-small guard skips the check.
            capturedLocationHandler!(makeFix({ latitude: 0.001, longitude: 0, timestamp: t0 + 50, speed: 0 }));
            expect(trackBuffer.length).toBe(2);
        });

        it('skips buffering entirely when isActive() returns false', () => {
            mgr.stop();
            startMgr({ active: false });
            vi.advanceTimersByTime(5_001);
            capturedLocationHandler!(makeFix());
            expect(trackBuffer.length).toBe(0);
            expect(onFix).toHaveBeenCalled(); // still publishes for UI
        });
    });

    describe('speed-tier debounce', () => {
        beforeEach(() => {
            startMgr();
            vi.advanceTimersByTime(5_001); // exit warm-up
        });

        it('only fires onSpeedTierChanged after SPEED_TIER_DEBOUNCE confirmations', () => {
            // Walk speed (1 m/s ≈ 1.94 kts) → moored tier
            capturedLocationHandler!(makeFix({ speed: 1, timestamp: Date.now() }));
            expect(onSpeedTierChanged).not.toHaveBeenCalled();
            // Same tier 2 more times — still no commit (we need 3 in a row)
            capturedLocationHandler!(makeFix({ speed: 1, timestamp: Date.now() + 1 }));
            capturedLocationHandler!(makeFix({ speed: 1, timestamp: Date.now() + 2 }));
            expect(onSpeedTierChanged).toHaveBeenCalledTimes(1);
        });

        it('does not fire while rapid mode is engaged', () => {
            mgr.stop();
            startMgr({ rapid: true });
            vi.advanceTimersByTime(5_001);
            for (let i = 0; i < 5; i++) {
                capturedLocationHandler!(makeFix({ speed: 1, timestamp: Date.now() + i }));
            }
            expect(onSpeedTierChanged).not.toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('clears the location handler reference', () => {
            startMgr();
            expect(capturedLocationHandler).not.toBeNull();
            mgr.stop();
            expect(capturedLocationHandler).toBeNull();
        });

        it('is idempotent', () => {
            startMgr();
            expect(() => {
                mgr.stop();
                mgr.stop();
            }).not.toThrow();
        });

        it('start re-call replaces prior subscription cleanly', () => {
            startMgr();
            const first = capturedLocationHandler;
            startMgr();
            expect(capturedLocationHandler).not.toBeNull();
            // The first capture handle was unsubscribed (replaced).
            expect(capturedLocationHandler).not.toBe(first);
        });
    });
});
