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
import type { GpsSubscriptionOptions } from '../services/shiplog/GpsSubscriptionManager';
import { GpsTrackBuffer } from '../services/shiplog/GpsTrackBuffer';
import type { CachedPosition } from '../services/BgGeoManager';
import type { NmeaGpsPosition } from '../services/NmeaGpsProvider';
import type { PlottingProfile } from '../services/shiplog/helpers';

let capturedLocationHandler: ((pos: CachedPosition) => void) | null = null;
let capturedNmeaHandler: ((pos: NmeaGpsPosition) => void) | null = null;

const NEARSHORE_PLOTTING_PROFILE: PlottingProfile = { zone: 'nearshore', intervalMs: 3_000 };
const COASTAL_PLOTTING_PROFILE: PlottingProfile = { zone: 'coastal', intervalMs: 30_000 };
const OFFSHORE_PLOTTING_PROFILE: PlottingProfile = { zone: 'offshore', intervalMs: 5 * 60_000 };

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
        onPosition: (cb: (pos: NmeaGpsPosition) => void) => {
            capturedNmeaHandler = cb;
            return () => {
                capturedNmeaHandler = null;
            };
        },
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

function makeNmeaFix(overrides: Partial<NmeaGpsPosition> = {}): NmeaGpsPosition {
    return {
        latitude: -27.5,
        longitude: 153.0,
        accuracy: 5,
        heading: 0,
        speed: 0,
        timestamp: Date.now(),
        source: 'nmea',
        satellites: 12,
        hdop: 0.8,
        fixQuality: 2,
        ...overrides,
    };
}

describe('GpsSubscriptionManager', () => {
    let mgr: GpsSubscriptionManager;
    let trackBuffer: GpsTrackBuffer;
    let onFix: ReturnType<typeof vi.fn>;
    let onSpeedTierChanged: ReturnType<typeof vi.fn>;
    let onHeartbeatTick: ReturnType<typeof vi.fn>;
    let onTrackOpened: ReturnType<typeof vi.fn>;
    let onPlottingProfileChanged: ReturnType<typeof vi.fn>;
    let onPlotPointBuffered: ReturnType<typeof vi.fn>;
    let onAcceptedFix: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
        mgr = new GpsSubscriptionManager();
        trackBuffer = new GpsTrackBuffer();
        onFix = vi.fn();
        onSpeedTierChanged = vi.fn();
        onHeartbeatTick = vi.fn();
        onTrackOpened = vi.fn();
        onPlottingProfileChanged = vi.fn();
        onPlotPointBuffered = vi.fn();
        onAcceptedFix = vi.fn();
    });

    afterEach(() => {
        mgr.stop();
        capturedLocationHandler = null;
        capturedNmeaHandler = null;
        vi.useRealTimers();
    });

    function startMgr(
        opts: {
            active?: boolean;
            rapid?: boolean;
            precision?: boolean;
            getPlottingProfile?: GpsSubscriptionOptions['getPlottingProfile'];
            onPlottingProfileChanged?: GpsSubscriptionOptions['onPlottingProfileChanged'];
            onPlotPointBuffered?: GpsSubscriptionOptions['onPlotPointBuffered'];
            onAcceptedFix?: GpsSubscriptionOptions['onAcceptedFix'];
        } = {},
    ) {
        const plottingProfileOptions: Pick<GpsSubscriptionOptions, 'getPlottingProfile' | 'onPlottingProfileChanged'> =
            opts.getPlottingProfile
                ? {
                      getPlottingProfile: opts.getPlottingProfile,
                      onPlottingProfileChanged:
                          opts.onPlottingProfileChanged ??
                          (onPlottingProfileChanged as unknown as NonNullable<
                              GpsSubscriptionOptions['onPlottingProfileChanged']
                          >),
                  }
                : {};
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
            onAcceptedFix: opts.onAcceptedFix ?? (onAcceptedFix as unknown as (pos: CachedPosition) => void),
            onSpeedTierChanged: onSpeedTierChanged as unknown as () => void,
            onHeartbeatTick: onHeartbeatTick as unknown as () => void,
            onTrackOpened: onTrackOpened as unknown as () => void,
            onPlotPointBuffered:
                opts.onPlotPointBuffered ??
                (onPlotPointBuffered as unknown as (pos: CachedPosition, profile: PlottingProfile) => void),
            ...plottingProfileOptions,
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
            // A nearby second fix corroborates. The first candidate is
            // evidence only; the track begins at the confirming fix so a
            // delayed Voyage Start cannot replay a backwards A → B leg.
            capturedLocationHandler!(makeFix({ timestamp: Date.now() + 5_000, receivedAt: Date.now() + 5_000 }));
            expect(trackBuffer.length).toBe(1);
            expect(onTrackOpened).toHaveBeenCalledTimes(1);
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
            expect(trackBuffer.length).toBe(1);
            expect(trackBuffer.peek()!.latitude).toBeCloseTo(0.0001);
        });

        it('escapes the Bad Elf clock-skew wedge: a stream stamped behind the held fix demotes it and opens', () => {
            // Field failure 2026-08-03: the held first fix carried a phone
            // clock timestamp; every Bad Elf Pro+ fix that followed was
            // stamped seconds BEHIND it (receiver clock base). The
            // non-monotonic branch rejected each one while KEEPING the held
            // fix — and a non-positive delta can never trip the too-old
            // restart — so the gate wedged forever: "Acquiring GPS fix…"
            // indefinitely with a perfect receiver attached. Three
            // consecutive non-monotonic corroborators must demote the held
            // fix to the newest arrival, after which the accessory stream
            // corroborates itself.
            startMgr();
            vi.advanceTimersByTime(5_001);
            const phoneT = Date.now();
            // Held first fix, phone clock base.
            capturedLocationHandler!(makeFix({ timestamp: phoneT }));
            expect(trackBuffer.length).toBe(0);
            // Bad Elf stream: internally ordered at 1 Hz, clock 8 s behind.
            const elfT = phoneT - 8_000;
            for (let i = 0; i < 3; i++) {
                capturedLocationHandler!(
                    makeFix({ timestamp: elfT + i * 1_000, receivedAt: phoneT + (i + 1) * 1_000 }),
                );
            }
            // Third rejection demotes the held fix to the newest accessory
            // fix; nothing has been buffered yet.
            expect(trackBuffer.length).toBe(0);
            expect(onTrackOpened).not.toHaveBeenCalled();
            // The next accessory fix is monotonic AGAINST ITS OWN STREAM and
            // agrees spatially → the gate finally opens.
            capturedLocationHandler!(makeFix({ timestamp: elfT + 3_000, receivedAt: phoneT + 4_000 }));
            expect(trackBuffer.length).toBe(1);
            expect(onTrackOpened).toHaveBeenCalledTimes(1);
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
            expect(trackBuffer.length).toBe(1);
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
            expect(trackBuffer.length).toBe(1);
        });

        it('rejects a low-speed GPS settling leap until a tight later pair corroborates the real position', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);
            const t0 = Date.now();
            // 150 m in 5 s is ~58 kt, but both fixes report no movement and
            // 5 m accuracy. The opening envelope rightly treats it as a
            // settling/replay disagreement instead of the beginning of a
            // passage.
            capturedLocationHandler!(makeFix({ latitude: -27.5, speed: 0, accuracy: 5, timestamp: t0 }));
            capturedLocationHandler!(
                makeFix({ latitude: -27.49865, speed: 0, accuracy: 5, timestamp: t0 + 5_000, receivedAt: t0 + 5_000 }),
            );
            expect(trackBuffer.length).toBe(0);
            // The next good fix returns to the real berth, displacing the
            // bad candidate. A final nearby fix opens the track cleanly.
            capturedLocationHandler!(
                makeFix({ latitude: -27.5, speed: 0, accuracy: 5, timestamp: t0 + 10_000, receivedAt: t0 + 10_000 }),
            );
            capturedLocationHandler!(
                makeFix({
                    latitude: -27.49999,
                    speed: 0,
                    accuracy: 5,
                    timestamp: t0 + 15_000,
                    receivedAt: t0 + 15_000,
                }),
            );
            expect(trackBuffer.length).toBe(1);
            expect(trackBuffer.peek()!.latitude).toBeCloseTo(-27.49999);
            expect(onTrackOpened).toHaveBeenCalledTimes(1);
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
            expect(trackBuffer.length).toBe(1);
            // Cap raised 25 → 100 kn (commit 1dfc7fad): the 25 kn cap
            // rejected every driving fix above ~46 km/h. Real GPS speed
            // glitches look like 500+ kn, so 100 kn still catches them.
            capturedLocationHandler!(makeFix({ speed: 60, timestamp: t0 + 10_000, receivedAt: t0 + 10_000 })); // ≈117 kts → rejected
            expect(trackBuffer.length).toBe(1);
            // Driving speed is ACCEPTED — the regression that motivated
            // raising the cap. (Fix placed near the session anchor so the
            // Layer-3 jump check passes too.)
            capturedLocationHandler!(
                makeFix({ latitude: 0.0001, longitude: 0, speed: 14, timestamp: t0 + 15_000, receivedAt: t0 + 15_000 }),
            ); // ≈27 kts
            expect(trackBuffer.length).toBe(2);
        });

        it('rejects fixes implying > 150 kts via Haversine ÷ Δt', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(1);
            // Next fix 1s later at lat 0.1 (≈11.1km away) → ~20,000 kts implied
            const t1 = t0 + 6_000;
            capturedLocationHandler!(makeFix({ latitude: 0.1, longitude: 0, timestamp: t1, receivedAt: t1, speed: 0 }));
            expect(trackBuffer.length).toBe(1); // rejected
        });

        it('skips position-spike check on <100ms duplicate fixes', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(1);
            // Near-duplicate fix 50ms after the last accepted one — would
            // imply teleport speed but the dt-too-small guard skips the check.
            capturedLocationHandler!(
                makeFix({ latitude: 0.001, longitude: 0, timestamp: t0 + 5_050, receivedAt: t0 + 5_050, speed: 0 }),
            );
            // The GPS gate accepts the near-duplicate, but the default
            // nearshore sampler correctly waits for its 3-second cadence
            // before making it a persisted vertex.
            expect(onAcceptedFix).toHaveBeenCalledTimes(2);
            expect(trackBuffer.length).toBe(1);
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

        it('rejects an out-of-order fix before it can replace the accepted tail or notify zone consumers', () => {
            const t0 = Date.now();
            openSession(t0);
            expect(trackBuffer.length).toBe(1);

            // Accepted but still inside the default three-second sampling
            // window, so it remains available only as the latest tail.
            capturedLocationHandler!(
                makeFix({ latitude: 0.00002, longitude: 0, timestamp: t0 + 6_000, receivedAt: t0 + 6_000, speed: 0 }),
            );
            expect(onAcceptedFix).toHaveBeenCalledTimes(2);

            // A delayed provider replay must not overwrite that accepted
            // tail, the resolver's position, or the final stop vertex.
            capturedLocationHandler!(
                makeFix({ latitude: 0.000015, longitude: 0, timestamp: t0 + 5_500, receivedAt: t0 + 6_500, speed: 0 }),
            );
            expect(onAcceptedFix).toHaveBeenCalledTimes(2);

            expect(mgr.bufferFinalPoint()).toBe(true);
            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 5_000, t0 + 6_000]);
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

    describe('zone-aware plotting cadence', () => {
        it('uses the 3-second nearshore policy when no geographic resolver is supplied', () => {
            startMgr();
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000); // vetted opening point
            emitPhoneFix(t0 + 3_999);
            emitPhoneFix(t0 + 4_000);

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000, t0 + 4_000]);
        });

        it('keeps the 3-second nearshore policy if a geographic resolver throws', () => {
            startMgr({
                getPlottingProfile: () => {
                    throw new Error('shore lookup unavailable');
                },
            });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000);
            emitPhoneFix(t0 + 3_999);
            emitPhoneFix(t0 + 4_000);

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000, t0 + 4_000]);
        });

        it('notifies accepted-fix consumers even when the geographic sampler defers a vertex', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            capturedLocationHandler!(makeFix({ timestamp: t0, receivedAt: t0, speed: 0 }));
            // Held first candidate is not yet trustworthy enough for a
            // coastline lookup or a persisted track vertex.
            expect(onAcceptedFix).not.toHaveBeenCalled();

            capturedLocationHandler!(makeFix({ timestamp: t0 + 1_000, receivedAt: t0 + 1_000, speed: 0 }));
            expect(onAcceptedFix).toHaveBeenCalledTimes(1);
            expect(trackBuffer.length).toBe(1);

            // Accepted raw position remains available to the resolver even
            // though the five-minute profile does not retain it yet.
            capturedLocationHandler!(makeFix({ timestamp: t0 + 2_000, receivedAt: t0 + 2_000, speed: 0 }));
            expect(onAcceptedFix).toHaveBeenCalledTimes(2);
            expect(trackBuffer.length).toBe(1);
        });

        it('notifies durability consumers for each retained vertex, including one that lands just after a timer tick', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000); // opening vertex → flush wake-up now
            emitPhoneFix(t0 + 2_000); // accepted but not due → no wake-up
            emitPhoneFix(t0 + 301_000); // five-minute vertex → wake-up now

            expect(onPlotPointBuffered.mock.calls.map(([point]) => point.timestamp)).toEqual([
                t0 + 1_000,
                t0 + 301_000,
            ]);
        });

        it('retains a mixed nearshore → coastal → offshore → coastal voyage at each zone cadence', () => {
            let profile = NEARSHORE_PLOTTING_PROFILE;
            startMgr({ getPlottingProfile: () => profile });
            vi.advanceTimersByTime(5_001); // exit the GPS warm-up window

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            // Opening is special: the confirming fix must always be retained,
            // even if the profile's normal interval has not elapsed yet.
            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000);
            expect(trackBuffer.length).toBe(1);

            // Nearshore (land/inshore): retain at 3 s, not sooner.
            emitPhoneFix(t0 + 3_999);
            emitPhoneFix(t0 + 4_000);

            // Moving into coastal water records the boundary point straight
            // away; it must not inherit the old nearshore timer.
            profile = COASTAL_PLOTTING_PROFILE;
            emitPhoneFix(t0 + 5_000);
            emitPhoneFix(t0 + 34_999);
            emitPhoneFix(t0 + 35_000);

            // Then the same passage goes offshore. The first offshore point
            // is retained immediately, then the 5-minute cadence takes over.
            profile = OFFSHORE_PLOTTING_PROFILE;
            emitPhoneFix(t0 + 36_000);
            emitPhoneFix(t0 + 335_999);
            emitPhoneFix(t0 + 336_000);

            // The return toward shore is just as important: do not leave the
            // plot sparse for another five minutes after crossing coastal.
            profile = COASTAL_PLOTTING_PROFILE;
            emitPhoneFix(t0 + 337_000);

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([
                t0 + 1_000,
                t0 + 4_000,
                t0 + 5_000,
                t0 + 35_000,
                t0 + 36_000,
                t0 + 336_000,
                t0 + 337_000,
            ]);
            expect(onPlottingProfileChanged).toHaveBeenCalledTimes(4);
            expect(onPlottingProfileChanged.mock.calls.map(([changed]) => changed)).toEqual([
                NEARSHORE_PLOTTING_PROFILE,
                COASTAL_PLOTTING_PROFILE,
                OFFSHORE_PLOTTING_PROFILE,
                COASTAL_PLOTTING_PROFILE,
            ]);
        });

        it('keeps offshore cadence memory after a buffer flush', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000); // opening point, retained
            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000]);

            // A scheduler flush must not make the next raw GPS point look like
            // a new first point. It is still inside the same 5-minute offshore
            // window, even though the in-memory buffer is empty.
            emitPhoneFix(t0 + 300_999);
            expect(trackBuffer.length).toBe(0);

            emitPhoneFix(t0 + 301_000);
            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 301_000]);
        });

        it('does not let a coastal turn override the fixed 30-second plotting cadence', () => {
            startMgr({ getPlottingProfile: () => COASTAL_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number, heading: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 5, heading }));
            };

            emitPhoneFix(t0, 0);
            emitPhoneFix(t0 + 1_000, 0); // vetted opening vertex
            emitPhoneFix(t0 + 10_000, 35); // material turn, but coastal cadence still owns it
            emitPhoneFix(t0 + 31_000, 35); // exactly 30s since the opening vertex

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000, t0 + 31_000]);
        });

        it('preserves the latest vetted offshore fix when a voyage stops before its five-minute tick', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 0 }));
            };

            emitPhoneFix(t0);
            emitPhoneFix(t0 + 1_000); // opening vertex
            emitPhoneFix(t0 + 60_000); // accepted but deferred by offshore cadence
            expect(trackBuffer.length).toBe(1);

            expect(mgr.bufferFinalPoint()).toBe(true);
            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000, t0 + 60_000]);
        });

        it('adds offshore safety vertices for a material turn or a one-nautical-mile leg before cadence is due', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            const emitPhoneFix = (timestamp: number, overrides: Partial<CachedPosition> = {}) => {
                capturedLocationHandler!(makeFix({ timestamp, receivedAt: timestamp, speed: 5, ...overrides }));
            };

            emitPhoneFix(t0, { latitude: 0, longitude: 0, heading: 0 });
            emitPhoneFix(t0 + 1_000, { latitude: 0.00001, longitude: 0, heading: 0 }); // opening vertex

            // 30° course change after 10s: preserve geometry immediately.
            emitPhoneFix(t0 + 10_000, { latitude: 0.0001, longitude: 0, heading: 30 });
            // ~1.05 nm farther, still well inside the five-minute normal cadence.
            emitPhoneFix(t0 + 70_000, { latitude: 0.0176, longitude: 0, heading: 30 });

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0 + 1_000, t0 + 10_000, t0 + 70_000]);
        });

        it('does not invent an offshore turn when NMEA heading was temporarily unavailable', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });

            const t0 = Date.now();
            capturedNmeaHandler!(makeNmeaFix({ timestamp: t0, heading: null, speed: 5 }));
            // A real 90° COG after an unavailable reading is not evidence of
            // a 90° course change from north; wait for two real headings.
            capturedNmeaHandler!(makeNmeaFix({ timestamp: t0 + 10_000, heading: 90, speed: 5 }));

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0]);
        });

        it('applies the same zone cadence and boundary capture to NMEA fixes', () => {
            let profile = NEARSHORE_PLOTTING_PROFILE;
            startMgr({ getPlottingProfile: () => profile });

            const t0 = Date.now();
            const emitNmeaFix = (timestamp: number) => {
                capturedNmeaHandler!(makeNmeaFix({ timestamp }));
            };

            // NMEA is already a vetted external source, so its first valid
            // point opens the session immediately — but it must still use the
            // very same plotting limiter as phone GPS afterwards.
            emitNmeaFix(t0);
            emitNmeaFix(t0 + 2_000);

            profile = COASTAL_PLOTTING_PROFILE;
            emitNmeaFix(t0 + 2_001); // immediate nearshore → coastal boundary
            emitNmeaFix(t0 + 32_000);
            emitNmeaFix(t0 + 32_001);

            profile = OFFSHORE_PLOTTING_PROFILE;
            emitNmeaFix(t0 + 32_002); // immediate coastal → offshore boundary
            profile = COASTAL_PLOTTING_PROFILE;
            emitNmeaFix(t0 + 32_003); // immediate offshore → coastal boundary

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([
                t0,
                t0 + 2_001,
                t0 + 32_001,
                t0 + 32_002,
                t0 + 32_003,
            ]);
            expect(onPlottingProfileChanged.mock.calls.map(([changed]) => changed)).toEqual([
                NEARSHORE_PLOTTING_PROFILE,
                COASTAL_PLOTTING_PROFILE,
                OFFSHORE_PLOTTING_PROFILE,
                COASTAL_PLOTTING_PROFILE,
            ]);
        });

        it('does not mistake a slow but healthy NMEA feed for repeated source handovers offshore', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });

            const t0 = Date.now();
            const emitNmeaFix = (timestamp: number) => {
                capturedNmeaHandler!(makeNmeaFix({ timestamp }));
            };

            emitNmeaFix(t0); // opening point
            // A 10-second chartplotter cadence is legitimate. It must not
            // force a new vertex every time just because it exceeds the
            // five-second phone-vs-NMEA arbitration window.
            emitNmeaFix(t0 + 10_000);
            emitNmeaFix(t0 + 20_000);
            emitNmeaFix(t0 + 300_000);

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0, t0 + 300_000]);
        });

        it('lets the boat GPS reclaim the track the moment it speaks, even mid-cadence', () => {
            // POLICY REVERSED, 2026-09-05. This test used to assert the
            // opposite: that once NMEA missed the nearshore three-second
            // target, the phone became "the stable selected source" and a
            // healthy-but-slower NMEA update could not displace it. The stated
            // reason was to avoid receiver sawtooth and a sparse berth track,
            // and against two receivers bolted to the same boat that reasoning
            // holds.
            //
            // The phone is not bolted to the boat. Shane, standing 2.3 km away
            // from Serene Summer while the log rejected his own handset twice
            // at exactly 2321 m: "we need to ensure that the phone does not cut
            // in unless we have a dead gps. killed, murdered. dead."
            //
            // So a slow chartplotter now costs track DENSITY, which is the
            // cheap failure, instead of risking track TRUTH, which is not.
            startMgr({ getPlottingProfile: () => NEARSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            capturedNmeaHandler!(makeNmeaFix({ timestamp: t0, speed: 0 })); // opens from external GPS

            // With no gateway configured this manager has no vessel GPS to
            // wait for, so the phone may contribute — the punter-without-a-boat
            // branch. It fills the gaps while NMEA is quiet.
            vi.advanceTimersByTime(3_000);
            capturedLocationHandler!(makeFix({ timestamp: Date.now(), receivedAt: Date.now(), speed: 0 }));
            vi.advanceTimersByTime(3_000);
            capturedLocationHandler!(makeFix({ timestamp: Date.now(), receivedAt: Date.now(), speed: 0 }));
            vi.advanceTimersByTime(3_000);
            capturedLocationHandler!(makeFix({ timestamp: Date.now(), receivedAt: Date.now(), speed: 0 }));

            // The boat's receiver speaks again. It is never suppressed, so it
            // takes the selection straight back — the fix itself is deferred
            // by the three-second cadence, one second after the last point.
            vi.advanceTimersByTime(1_000);
            capturedNmeaHandler!(makeNmeaFix({ timestamp: Date.now(), speed: 0 }));

            // ...and the phone two seconds later is now the one suppressed,
            // because the vessel's GPS has just proved it is alive.
            vi.advanceTimersByTime(2_000);
            capturedLocationHandler!(makeFix({ timestamp: Date.now(), receivedAt: Date.now(), speed: 0 }));

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([
                t0,
                t0 + 3_000,
                t0 + 6_000,
                t0 + 9_000,
            ]);
            expect(onAcceptedFix).toHaveBeenCalledTimes(5);
        });

        it('keeps the offshore cap when NMEA falls quiet long enough for a genuine phone handover', () => {
            startMgr({ getPlottingProfile: () => OFFSHORE_PLOTTING_PROFILE });
            vi.advanceTimersByTime(5_001);

            const t0 = Date.now();
            capturedNmeaHandler!(makeNmeaFix({ timestamp: t0, speed: 0 })); // opening point

            // NMEA has genuinely been silent for >15s, so the phone is
            // allowed to become the accepted source. A source handover alone
            // must not force a five-minute offshore vertex.
            vi.advanceTimersByTime(16_000);
            capturedLocationHandler!(makeFix({ timestamp: Date.now(), receivedAt: Date.now(), speed: 0 }));

            // The NMEA receiver returns four seconds later. This second
            // handover is also an accepted live fix, but neither change may
            // turn a sparse voyage into 4–20 second plotted points.
            vi.advanceTimersByTime(4_000);
            capturedNmeaHandler!(makeNmeaFix({ timestamp: Date.now(), speed: 0 }));

            expect(trackBuffer.drain().map((point) => point.timestamp)).toEqual([t0]);
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
