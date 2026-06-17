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

    function startMgr(opts: Partial<{ active: boolean; rapid: boolean; precision: boolean }> = {}) {
        mgr.start({
            isNative: true,
            trackBuffer,
            isActive: () => opts.active ?? true,
            isRapidMode: () => opts.rapid ?? false,
            isPrecisionMode: () => opts.precision ?? false,
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

        it('starts buffering after 5s once a second fix corroborates the first', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);
            // First-fix consistency gate: the session's first candidate is
            // HELD (engine-start replays can be re-stamped with a current
            // timestamp — only disagreement with the NEXT fix exposes them).
            capturedLocationHandler!(makeFix({ timestamp: Date.now() }));
            expect(trackBuffer.length).toBe(0);
            // A nearby second fix corroborates — both release, in order.
            capturedLocationHandler!(makeFix({ timestamp: Date.now() + 5_000, receivedAt: Date.now() + 5_000 }));
            expect(trackBuffer.length).toBe(2);
        });

        it('discards a held first fix that the next fix contradicts (re-stamped stale replay)', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);
            const t0 = Date.now();
            // Replayed last-session fix, re-stamped "now" — 11km from reality.
            capturedLocationHandler!(makeFix({ latitude: 0.1, longitude: 0, timestamp: t0, speed: 0 }));
            expect(trackBuffer.length).toBe(0);
            // Real fix 5s later, far away → pair disagrees → replay discarded.
            capturedLocationHandler!(
                makeFix({ latitude: 0, longitude: 0, timestamp: t0 + 5_000, receivedAt: t0 + 5_000, speed: 0 }),
            );
            expect(trackBuffer.length).toBe(0);
            // Next real fix agrees with the held one → session opens at reality.
            capturedLocationHandler!(
                makeFix({ latitude: 0.0001, longitude: 0, timestamp: t0 + 10_000, receivedAt: t0 + 10_000, speed: 0 }),
            );
            expect(trackBuffer.length).toBe(2);
            expect(trackBuffer.peek()!.latitude).toBeCloseTo(0.0001);
        });

        it('rejects wide-accuracy cold fixes until the chip settles, then opens on a tight pair', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);
            const t0 = Date.now();
            // Cold/wandering fixes: 60 m accuracy is over the 35 m opener
            // bar — dropped, nothing held.
            capturedLocationHandler!(makeFix({ accuracy: 60, timestamp: t0 }));
            capturedLocationHandler!(makeFix({ accuracy: 60, timestamp: t0 + 5_000 }));
            expect(trackBuffer.length).toBe(0);
            // Chip settles to a tight fix — two corroborate → track opens.
            capturedLocationHandler!(
                makeFix({ accuracy: 20, latitude: -27.5, timestamp: t0 + 10_000, receivedAt: t0 + 10_000 }),
            );
            capturedLocationHandler!(
                makeFix({ accuracy: 18, latitude: -27.5001, timestamp: t0 + 15_000, receivedAt: t0 + 15_000 }),
            );
            expect(trackBuffer.length).toBe(2);
        });

        it('abandons the accuracy ramp after the fallback window (poor sky view still records)', () => {
            startMgr();
            vi.advanceTimersByTime(61_000); // past COLD_START_FALLBACK_MS
            const t = Date.now();
            // 60 m fixes were too wide to open the track in the first
            // minute; past the fallback the normal 100 m ceiling applies.
            capturedLocationHandler!(makeFix({ accuracy: 60, latitude: -27.5, timestamp: t }));
            capturedLocationHandler!(
                makeFix({ accuracy: 60, latitude: -27.5001, timestamp: t + 5_000, receivedAt: t + 5_000 }),
            );
            expect(trackBuffer.length).toBe(2);
        });
    });

    describe('fix-acceptance gate', () => {
        // Open the first-fix consistency gate with two agreeing fixes so
        // each test exercises its own layer, not the pair gate.
        function openSession(t0: number) {
            capturedLocationHandler!(makeFix({ latitude: 0, longitude: 0, timestamp: t0, receivedAt: t0, speed: 0 }));
            capturedLocationHandler!(
                makeFix({ latitude: 0.00001, longitude: 0, timestamp: t0 + 5_000, receivedAt: t0 + 5_000, speed: 0 }),
            );
        }

        beforeEach(() => {
            startMgr();
            vi.advanceTimersByTime(5_001); // exit warm-up
        });

        it('rejects fixes with accuracy > 100m', () => {
            capturedLocationHandler!(makeFix({ accuracy: 150 }));
            expect(trackBuffer.length).toBe(0);
        });

        it('rejects fixes with GPS speed > 100 kts', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(2);
            // Cap raised 25 → 100 kn (commit 1dfc7fad): the 25 kn cap
            // rejected every driving fix above ~46 km/h. Real GPS speed
            // glitches look like 500+ kn, so 100 kn still catches them.
            capturedLocationHandler!(makeFix({ speed: 60, timestamp: t0 + 10_000, receivedAt: t0 + 10_000 })); // ≈117 kts → rejected
            expect(trackBuffer.length).toBe(2);
            // Driving speed is ACCEPTED — the regression that motivated
            // raising the cap. (Fix placed near the session anchor so the
            // Layer-3 jump check passes too.)
            capturedLocationHandler!(
                makeFix({ latitude: 0.0001, longitude: 0, speed: 14, timestamp: t0 + 15_000, receivedAt: t0 + 15_000 }),
            ); // ≈27 kts
            expect(trackBuffer.length).toBe(3);
        });

        it('rejects fixes implying > 150 kts via Haversine ÷ Δt', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(2);
            // Next fix 1s later at lat 0.1 (≈11.1km away) → ~20,000 kts implied
            const t1 = t0 + 6_000;
            capturedLocationHandler!(makeFix({ latitude: 0.1, longitude: 0, timestamp: t1, receivedAt: t1, speed: 0 }));
            expect(trackBuffer.length).toBe(2); // rejected
        });

        it('skips position-spike check on <100ms duplicate fixes', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(2);
            // Near-duplicate fix 50ms after the last accepted one — would
            // imply teleport speed but the dt-too-small guard skips the check.
            capturedLocationHandler!(
                makeFix({ latitude: 0.001, longitude: 0, timestamp: t0 + 5_050, receivedAt: t0 + 5_050, speed: 0 }),
            );
            expect(trackBuffer.length).toBe(3);
        });

        it('spike-gate memory survives a buffer drain (no post-flush amnesia)', () => {
            const t0 = Date.now();
            openSession(t0);
            trackBuffer.drain(); // interval flush empties the buffer
            expect(trackBuffer.length).toBe(0);
            // Teleport fix right after the drain — the old peek()-based
            // gate had no reference and accepted it; lastAcceptedFix
            // keeps the memory.
            const t1 = t0 + 6_000;
            capturedLocationHandler!(makeFix({ latitude: 0.1, longitude: 0, timestamp: t1, receivedAt: t1, speed: 0 }));
            expect(trackBuffer.length).toBe(0);
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
