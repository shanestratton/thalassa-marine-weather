/**
 * GpsSubscriptionManager — owns the BgGeo + NMEA + browser-geolocation
 * subscription lifecycle and the per-fix gating logic.
 *
 * Responsibilities (all of which were previously inlined into
 * ShipLogService.wireGpsSubscriptions):
 *
 *   1. Subscribe to the right GPS source for the platform — native uses
 *      BgGeoManager (Transistorsoft); web uses navigator.geolocation.
 *   2. Subscribe to NmeaGpsProvider on every platform (chartplotters can
 *      feed in over Bluetooth on iOS / serial on Android).
 *   3. Subscribe to the appropriate heartbeat — native via
 *      BgGeoManager.subscribeHeartbeat (background-friendly); web via
 *      setInterval (background-locked, but better than nothing).
 *   4. Apply the **fix-acceptance gate** uniformly to BgGeo and NMEA so
 *      neither bypasses the filters (this was historically a bug — NMEA
 *      bypassed everything and was the dominant source of GPS hops on
 *      external chartplotters).
 *   5. Run **speed-tier debouncing** so the orchestrator's adaptive
 *      interval doesn't flip-flop on borderline readings.
 *   6. Apply the **GPS cold-start warm-up** — the first 5s of fixes
 *      after engine start can be teleport-stale fixes from the last
 *      session; we still publish them via `onFix` (the UI wants to
 *      display *something*) but we don't buffer them for thinning.
 *
 * The manager doesn't read `TrackingState` directly. Instead the
 * orchestrator passes accessor callbacks. Same pattern as the other
 * shiplog modules — keeps coupling one-way.
 */
import { createLogger } from '../../utils/createLogger';
import { BgGeoManager } from '../BgGeoManager';
import type { CachedPosition } from '../BgGeoManager';
import { EnvironmentService } from '../EnvironmentService';
import { NmeaGpsProvider } from '../NmeaGpsProvider';
import { GpsPrecision } from './GpsPrecisionTracker';
import type { GpsTrackBuffer } from './GpsTrackBuffer';
import { haversineMeters, headingDelta } from './GpsTrackBuffer';
import {
    getIntervalForSpeed,
    NEARSHORE_INTERVAL_MS,
    type LoggingZone,
    type PlottingProfile,
    type SpeedTier,
} from './helpers';

const log = createLogger('ShipLog.GpsSub');

const MS_TO_KTS = 1.94384;
// Absolute speed cap for GPS-reported speed sanity. Raised 25 → 100
// on 2026-05-19: at 25 kn the app rejected ALL highway/driving fixes
// (50 km/h ≈ 27 kn) as "GPS spikes", which left a 10-minute drive
// showing 7 stored points and 0 NM. 100 kn covers every reasonable
// scenario (cars, fast power boats, sail at any wind). Real GPS
// teleports look like 500+ kn deltas, so 100 kn still catches them.
// The acceleration gate (Layer 3 below + CapturePipeline) is what
// actually catches the common spike pattern.
const MAX_PLAUSIBLE_SPEED_KTS = 100;
const GPS_WARMUP_MS = 5_000;
const SPEED_TIER_DEBOUNCE = 3;
const WEB_HEARTBEAT_MS = 60_000;
// A held first fix must be corroborated promptly. Keeping it indefinitely
// lets a stale cold-start point pair with a much later reading and become the
// beginning of the voyage.
const FIRST_FIX_MAX_GAP_MS = 15_000;
// GPS accuracy is a radius, so two valid readings can legitimately differ by
// roughly the sum of their radii. Add a small floor for normal receiver
// noise, then allow actual travel implied by either reading's reported SOG.
const FIRST_FIX_MIN_ENVELOPE_M = 25;
const FIRST_FIX_ENVELOPE_PADDING_M = 10;
// Consecutive non-monotonic corroborators that DEMOTE the held first fix
// instead of waiting for one that outruns it. A re-stamped engine-start
// replay — what the monotonic check exists for — is a burst of one or two
// stale points. A PERSISTENT stream of fixes stamped behind the held fix
// means the held fix's clock base is the outlier, not the stream: a Bad Elf
// Pro+ supplies Core Location with fixes stamped from the RECEIVER's clock,
// which can sit whole seconds behind a phone-clock-stamped fix. Field
// failure 2026-08-03: the held (phone-stamped) fix outran every accessory
// fix forever, the gate never opened, and the Log badge read "Acquiring GPS
// fix…" indefinitely while the Bad Elf supplied perfect positions — the
// non-positive delta could never trip the too-old restart, so the gate had
// NO escape. Three in a row = skew, not replay; demote and let the
// accessory stream corroborate itself (its own timestamps are ordered).
const FIRST_FIX_SKEW_DEMOTE_COUNT = 3;

// ── Cold-start accuracy ramp ────────────────────────────────────────
// A freshly-woken GPS reports a large accuracy radius and the reported
// position WANDERS while the chip pulls in satellites — the messy first
// 10–20 s of a new track. The steady-state ceiling (100 m) is far too
// loose to catch that drift. So the accuracy bar starts TIGHT and
// relaxes as the chip settles:
//   - the fix that OPENS the track must be ≤ COLD_START_ACCURACY_M,
//   - for the first COLD_START_WINDOW_MS it must be ≤ EARLY_ACCURACY_M,
//   - thereafter the normal MAX_ACCURACY_M applies.
// The "Acquiring GPS fix…" banner covers the few extra seconds this
// adds. SAFETY: past COLD_START_FALLBACK_MS the ramp is abandoned and
// the normal ceiling applies, so a genuinely poor sky view (marina,
// hard bimini) still opens the track rather than waiting forever.
const MAX_ACCURACY_M = 100;
const COLD_START_ACCURACY_M = 35;
const EARLY_ACCURACY_M = 50;
const COLD_START_WINDOW_MS = 30_000;
const COLD_START_FALLBACK_MS = 60_000;
// A selected GPS source gets a short grace window before the other receiver
// can take over. This prevents 10–50m phone/NMEA offsets from alternating
// into a sawtooth, while still letting a 3-second nearshore policy fall back
// to an available phone fix when an otherwise healthy chartplotter reports
// only every 5–10 seconds. Coastal/offshore retain a 15-second maximum so a
// truly silent selected receiver never blocks a live backup indefinitely.
const SOURCE_FALLBACK_MAX_SILENCE_MS = 15_000;
// Five minutes is a useful offshore storage baseline, but a single 5-minute
// chord can hide a meaningful turn at speed. Keep a safety vertex when the
// vessel has covered one nautical mile or made a material change of course.
const OFFSHORE_MAX_SEGMENT_M = 1_852;
const TURN_CAPTURE_DEGREES = 25;
const TURN_CAPTURE_MIN_SPEED_MS = 0.5; // ≈1 kt

type TrackSource = 'phone' | 'nmea';

export interface GpsSubscriptionOptions {
    isNative: boolean;
    /** Track buffer to push accepted fixes into (also used by the position-spike check). */
    trackBuffer: GpsTrackBuffer;
    /** True iff tracking is on and not paused — gates buffering and heartbeats. */
    isActive: () => boolean;
    /** True iff rapid mode is engaged — disables speed-tier debouncing while on. */
    isRapidMode: () => boolean;
    /**
     * True iff Precision Mode is engaged — routes accepted fixes
     * through `pushWithLiveFilter` (collocation + 3-point collinearity
     * decimation) instead of raw push. Lets us safely sample at
     * 2 Hz without ballooning the buffer.
     */
    isPrecisionMode: () => boolean;
    /** Current tracking interval in ms — read by heartbeat to decide if a flush is owed. */
    getIntervalMs: () => number;
    /** ISO timestamp of last saved entry, or undefined if none yet. */
    getLastEntryTime: () => string | undefined;
    /**
     * Returns the active persisted-track detail profile for this exact GPS
     * fix. It must be synchronous: the manager never blocks an incoming fix
     * on a network lookup. Unknown geography should return the dense profile.
     */
    getPlottingProfile?: (pos: CachedPosition) => PlottingProfile;
    /** Called after a retained vertex changes the active geographic profile. */
    onPlottingProfileChanged?: (profile: PlottingProfile) => void;
    /**
     * Called after an accepted fix is actually retained as a plot vertex.
     * The owner can durably flush it immediately; this prevents a point that
     * lands just after a clock-aligned tick from sitting in memory for an
     * entire 30-second or five-minute profile interval.
     */
    onPlotPointBuffered?: (pos: CachedPosition, profile: PlottingProfile) => void;
    /** Called for every incoming fix from any source. Orchestrator updates its `lastBgLocation` here. */
    onFix: (pos: CachedPosition) => void;
    /**
     * Called only after a fix passes the GPS acceptance gate. This stays live
     * even when the plotting profile defers the vertex, making it the right
     * feed for position-sensitive background work such as shore resolution.
     */
    onAcceptedFix?: (pos: CachedPosition) => void;
    /** Called when the debounced speed tier changes — orchestrator reschedules the interval. */
    onSpeedTierChanged: () => void;
    /** Called when the heartbeat detects a missed tick — orchestrator flushes the track. */
    onHeartbeatTick: () => void;
    /**
     * Called once the session has a vetted first track fix. The orchestrator
     * uses this to leave its short high-frequency GPS acquisition mode.
     */
    onTrackOpened?: () => void;
}

export class GpsSubscriptionManager {
    private unsubscribers: Array<() => void> = [];
    private webWatchId?: number;
    private webHeartbeatId?: ReturnType<typeof setInterval>;

    /**
     * Cold-start window: while `Date.now() - warmupStartTime < GPS_WARMUP_MS`,
     * we publish fixes via `onFix` for UI display but don't buffer them for
     * track thinning. Reset on every `start()` call.
     */
    private warmupStartTime = 0;

    /**
     * Last fix ACCEPTED into the buffer this session. The Layer-3
     * position-spike gate used trackBuffer.peek(), which goes empty on
     * every flush drain — so the first fix after EVERY interval tick was
     * exempt from the jump check (and an accepted outlier then made the
     * next genuine fix look like the spike). This survives drains; reset
     * only on start().
     */
    private lastAcceptedFix: CachedPosition | null = null;

    /** Receiver currently contributing accepted positions to the voyage. */
    private selectedTrackSource: TrackSource | null = null;

    /** Epoch-ms of the last accepted external-GPS fix (whether or not it was retained). */
    private lastNmeaAcceptedAt = 0;

    /** Epoch-ms of the last accepted phone-GPS fix (whether or not it was retained). */
    private lastPhoneAcceptedAt = 0;

    /**
     * Plot-point sampler memory. This deliberately survives buffer drains:
     * a five-minute offshore profile must not reset to every raw fix just
     * because the scheduler persisted the previous batch.
     */
    private lastBufferedAt = 0;
    private lastBufferedFix: CachedPosition | null = null;
    private lastBufferedZone: LoggingZone | null = null;
    private activeOptions: GpsSubscriptionOptions | null = null;

    /**
     * First-fix consistency gate (phone path). The Layer-0 timestamp
     * check assumes the plugin preserves a replayed fix's original
     * timestamp — but engine-start replays can be RE-STAMPED with the
     * current time, defeating every timestamp/receivedAt check. The one
     * thing a stale replay can't fake is agreement with the fix after
     * it: the boat is wherever the NEXT fix says, so the session's
     * first fix is held back until a second fix lands within plausible
     * travel distance of it. Disagreement discards the OLDER fix and
     * holds the newer one. Costs one sample (~5 s) at session start.
     */
    private pendingFirstFix: CachedPosition | null = null;
    /** Consecutive corroborators rejected for non-monotonic timestamps —
     *  the clock-skew demotion trigger (see FIRST_FIX_SKEW_DEMOTE_COUNT). */
    private firstFixNonMonotonicCount = 0;
    private hasBufferedThisSession = false;
    private trackOpenedNotified = false;

    // Speed-tier debounce state. `currentSpeedTier` is the committed tier;
    // `pendingSpeedTier` is the one we've seen recently but not committed
    // until we get SPEED_TIER_DEBOUNCE consecutive readings.
    private currentSpeedTier: SpeedTier | null = null;
    private pendingSpeedTier: SpeedTier | null = null;
    private speedTierConfirmCount = 0;

    /**
     * Start all GPS subscriptions. Idempotent — calling twice will tear
     * down the prior subscriptions first.
     */
    start(opts: GpsSubscriptionOptions): void {
        this.stop();
        this.warmupStartTime = Date.now();
        this.currentSpeedTier = null;
        this.pendingSpeedTier = null;
        this.speedTierConfirmCount = 0;
        this.lastAcceptedFix = null;
        this.selectedTrackSource = null;
        this.lastNmeaAcceptedAt = 0;
        this.lastPhoneAcceptedAt = 0;
        this.lastBufferedAt = 0;
        this.lastBufferedFix = null;
        this.lastBufferedZone = null;
        this.activeOptions = opts;
        this.pendingFirstFix = null;
        this.firstFixNonMonotonicCount = 0;
        this.hasBufferedThisSession = false;
        this.trackOpenedNotified = false;

        const onAnyFix = (pos: CachedPosition) => this.handleIncomingFix(pos, opts);

        // ── 1. Phone GPS — native or web ──
        if (opts.isNative) {
            const unsub = BgGeoManager.subscribeLocation(onAnyFix);
            this.unsubscribers.push(unsub);
        } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
            this.webWatchId = navigator.geolocation.watchPosition(
                (geoPos) => {
                    onAnyFix({
                        latitude: geoPos.coords.latitude,
                        longitude: geoPos.coords.longitude,
                        accuracy: geoPos.coords.accuracy,
                        altitude: geoPos.coords.altitude,
                        // Heading is nullable in the browser API. Preserve
                        // that distinction: a missing value is not north.
                        heading: geoPos.coords.heading,
                        speed: geoPos.coords.speed ?? 0,
                        timestamp: geoPos.timestamp,
                        receivedAt: Date.now(),
                    } as CachedPosition);
                },
                (err) => log.warn('web GPS error', err.message),
                { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
            );
            this.unsubscribers.push(() => {
                if (this.webWatchId != null) {
                    navigator.geolocation.clearWatch(this.webWatchId);
                    this.webWatchId = undefined;
                }
            });
        }

        // ── 2. NMEA / external GPS — every platform ──
        const unsubNmea = NmeaGpsProvider.onPosition((nmeaPos) => {
            const cached: CachedPosition = {
                latitude: nmeaPos.latitude,
                longitude: nmeaPos.longitude,
                accuracy: nmeaPos.accuracy,
                heading: nmeaPos.heading,
                speed: nmeaPos.speed / MS_TO_KTS, // NMEA SOG (kts) → m/s (BgGeo convention)
                timestamp: nmeaPos.timestamp,
                receivedAt: Date.now(),
                altitude: null,
            } as CachedPosition;

            // Always publish for the UI (precision tracker + lastBgLocation).
            opts.onFix(cached);
            GpsPrecision.feed(nmeaPos.accuracy);

            // Apply the same fix-acceptance gate as phone GPS.
            // (Previously NMEA bypassed all filters — historical biggest
            // source of polyline hops when an external chartplotter glitched.)
            if (
                opts.isActive() &&
                this.sourceCanContribute('nmea', cached, opts) &&
                this.acceptFix(cached, opts.trackBuffer)
            ) {
                this.lastAcceptedFix = cached;
                this.noteAcceptedSource('nmea');
                opts.onAcceptedFix?.(cached);

                // This externally sourced fix has cleared the same acceptance
                // gate, so the session counts as opened and any held phone
                // candidate is moot. Retain the opening point even when the
                // current geographic cadence would otherwise defer it.
                const opensTrack = !this.hasBufferedThisSession;
                this.hasBufferedThisSession = true;
                this.pendingFirstFix = null;
                this.firstFixNonMonotonicCount = 0;
                if (opensTrack) this.notifyTrackOpened(opts);
                this.bufferPlotPoint(cached, opts, opensTrack);
            }
        });
        this.unsubscribers.push(unsubNmea);

        // ── 3. Heartbeat — flush owed entries on a steady cadence ──
        const heartbeatTick = () => {
            if (!opts.isActive()) return;
            const last = opts.getLastEntryTime();
            if (!last) return;
            const elapsed = Date.now() - new Date(last).getTime();
            const interval = opts.getIntervalMs();
            if (elapsed >= interval) opts.onHeartbeatTick();
        };
        if (opts.isNative) {
            const unsubHb = BgGeoManager.subscribeHeartbeat(heartbeatTick);
            this.unsubscribers.push(unsubHb);
        } else {
            this.webHeartbeatId = setInterval(heartbeatTick, WEB_HEARTBEAT_MS);
            this.unsubscribers.push(() => {
                if (this.webHeartbeatId) {
                    clearInterval(this.webHeartbeatId);
                    this.webHeartbeatId = undefined;
                }
            });
        }
    }

    /** Tear down every subscription and reset internal state. */
    stop(): void {
        for (const unsub of this.unsubscribers) {
            try {
                unsub();
            } catch (e) {
                log.warn('unsubscribe threw — already torn down?', e);
            }
        }
        this.unsubscribers = [];
        this.webWatchId = undefined;
        this.webHeartbeatId = undefined;
        this.activeOptions = null;
    }

    /**
     * Per-fix path for phone GPS. Splits into:
     *   1. Always publish via `onFix` (UI state stays fresh during warm-up too).
     *   2. Skip buffering during warm-up.
     *   3. Run speed-tier debounce (unless rapid mode).
     *   4. Apply fix-acceptance gate; push to buffer if accepted.
     *   5. Forward altitude to EnvironmentService for the on-water heuristic.
     */
    private handleIncomingFix(pos: CachedPosition, opts: GpsSubscriptionOptions): void {
        opts.onFix(pos);

        GpsPrecision.feed(pos.accuracy);

        // Cold-start guard.
        if (Date.now() - this.warmupStartTime < GPS_WARMUP_MS) {
            return;
        }

        // Speed-tier debounce.
        if (pos.speed != null && pos.speed >= 0 && !opts.isRapidMode()) {
            const { tier } = getIntervalForSpeed(pos.speed);
            if (tier !== this.currentSpeedTier) {
                if (tier === this.pendingSpeedTier) {
                    this.speedTierConfirmCount++;
                    if (this.speedTierConfirmCount >= SPEED_TIER_DEBOUNCE) {
                        this.currentSpeedTier = tier;
                        this.pendingSpeedTier = null;
                        this.speedTierConfirmCount = 0;
                        opts.onSpeedTierChanged();
                    }
                } else {
                    this.pendingSpeedTier = tier;
                    this.speedTierConfirmCount = 1;
                }
            } else {
                this.pendingSpeedTier = null;
                this.speedTierConfirmCount = 0;
            }
        }

        // Fix-acceptance gate + buffer push.
        //
        // 2026-05-19: removed the precision-mode branch that routed
        // through pushWithLiveFilter (collocation drop + 3-point
        // collinearity). At driving speeds the collinearity filter
        // killed straight-road runs because three consecutive 10 m
        // points on a 1 km straight road ARE collinear within tolerance.
        // Geographic plotting now retains safe, explicit vertices rather
        // than applying a generic speed-based cadence. isPrecisionMode() is
        // still called by callers but no longer changes ingest behaviour.
        //
        // Single-source arbitration: do not interleave two receivers into
        // one polyline. The selected source may yield after its profile-sized
        // silence window, so a 5–10s NMEA feed cannot block an available
        // 3-second nearshore phone fix forever.
        if (opts.isActive() && this.sourceCanContribute('phone', pos, opts) && this.acceptFix(pos, opts.trackBuffer)) {
            if (this.hasBufferedThisSession) {
                this.lastAcceptedFix = pos;
                this.noteAcceptedSource('phone');
                opts.onAcceptedFix?.(pos);
                this.bufferPlotPoint(pos, opts);
            } else if (!this.pendingFirstFix) {
                // First candidate of the session — hold it until a second
                // fix corroborates (re-stamped engine-start replays pass
                // every timestamp check; they only fail agreement with
                // the fix that follows them).
                this.pendingFirstFix = pos;
            } else {
                const pending = this.pendingFirstFix;
                const elapsedMs = pos.timestamp - pending.timestamp;
                if (elapsedMs <= 0) {
                    // A backwards/duplicate timestamp cannot be safely
                    // replayed into a timestamp-sorted polyline. Keep the
                    // original candidate and wait for a chronological fix —
                    // but only for so long. If fix after fix arrives stamped
                    // behind the held one, the held fix's clock base is the
                    // suspect (external-receiver skew, 2026-08-03 Bad Elf
                    // wedge) and holding it would jam the gate FOREVER: a
                    // non-positive delta can never trip the too-old restart
                    // below. Demote to the newest ARRIVAL — arrival order is
                    // the one clock all sources share.
                    this.firstFixNonMonotonicCount += 1;
                    if (this.firstFixNonMonotonicCount >= FIRST_FIX_SKEW_DEMOTE_COUNT) {
                        log.warn(
                            `GPS first-fix gate: held fix outruns the whole stream (Δ${elapsedMs}ms) — demoting to newest arrival (clock-base skew)`,
                        );
                        this.pendingFirstFix = pos;
                        this.firstFixNonMonotonicCount = 0;
                        return;
                    }
                    log.warn(`GPS first-fix gate: ignoring non-monotonic corroborating timestamp (Δ${elapsedMs}ms)`);
                    return;
                }
                this.firstFixNonMonotonicCount = 0;
                if (elapsedMs > FIRST_FIX_MAX_GAP_MS) {
                    // The held point is too old to prove a cold-start lock;
                    // start a fresh, bounded confirmation window instead.
                    // WARN, because a starved stream loops here silently
                    // forever (every fix >15 s apart restarts the window) —
                    // this was the one first-fix path with no log line, and
                    // an invisible infinite loop is how the 2026-08-03 wedge
                    // stayed undiagnosed until a field console dump.
                    log.warn(`GPS first-fix gate: held fix expired unconfirmed (Δ${elapsedMs}ms) — restarting window`);
                    this.pendingFirstFix = pos;
                    return;
                }

                const dtSec = elapsedMs / 1000;
                const distM = haversineMeters(pending.latitude, pending.longitude, pos.latitude, pos.longitude);
                const impliedKts = (distM / dtSec) * MS_TO_KTS;
                const reportedTravelM = Math.max(0, pending.speed ?? 0, pos.speed ?? 0) * dtSec;
                const accuracyEnvelopeM =
                    Math.max(0, pending.accuracy ?? 0) + Math.max(0, pos.accuracy ?? 0) + FIRST_FIX_ENVELOPE_PADDING_M;
                const maxCoherentDistanceM = Math.max(FIRST_FIX_MIN_ENVELOPE_M, reportedTravelM + accuracyEnvelopeM);

                if (impliedKts <= MAX_PLAUSIBLE_SPEED_KTS * 1.5 && distM <= maxCoherentDistanceM) {
                    // Agreement. The held point exists only to corroborate
                    // the opening fix — never replay it into the saved track.
                    // Releasing A+B used to let captureImmediate stamp a
                    // Voyage Start from B then later replay A→B, producing the
                    // very visible cold-start out-and-back spur.
                    this.lastAcceptedFix = pos;
                    this.noteAcceptedSource('phone');
                    this.hasBufferedThisSession = true;
                    this.pendingFirstFix = null;
                    opts.onAcceptedFix?.(pos);
                    this.notifyTrackOpened(opts);
                    this.bufferPlotPoint(pos, opts, true);
                } else {
                    // Teleport/settling disagreement — the OLDER fix is the
                    // suspect (stale replay); the newer one becomes the held
                    // candidate and needs its own corroboration.
                    log.warn(
                        `GPS first-fix gate: replacing held fix ${distM.toFixed(0)}m / ${impliedKts.toFixed(0)}kn from successor (coherence envelope ${maxCoherentDistanceM.toFixed(0)}m)`,
                    );
                    this.pendingFirstFix = pos;
                }
            }
        }

        // Altitude → EnvironmentService for on-water/on-land detection.
        if (pos.altitude !== null && pos.altitude !== undefined) {
            EnvironmentService.updateFromGPS({ altitude: pos.altitude });
        }
    }

    /** Notify the owner exactly once when a vetted initial fix opens the track. */
    private notifyTrackOpened(opts: GpsSubscriptionOptions): void {
        if (this.trackOpenedNotified) return;
        this.trackOpenedNotified = true;
        opts.onTrackOpened?.();
    }

    /**
     * Keep one receiver on the track at a time, but do not allow its cadence
     * to be slower than the active profile when a vetted backup is available.
     * The profile resolver uses the candidate vessel coordinate, never the
     * dashboard's selected weather location.
     */
    private sourceCanContribute(source: TrackSource, pos: CachedPosition, opts: GpsSubscriptionOptions): boolean {
        if (!this.selectedTrackSource || this.selectedTrackSource === source) return true;

        const selectedAt = this.selectedTrackSource === 'nmea' ? this.lastNmeaAcceptedAt : this.lastPhoneAcceptedAt;
        const profile = this.resolvePlottingProfile(pos, opts);
        const fallbackAfterMs = Math.min(
            Math.max(profile.intervalMs, NEARSHORE_INTERVAL_MS),
            SOURCE_FALLBACK_MAX_SILENCE_MS,
        );
        return Date.now() - selectedAt >= fallbackAfterMs;
    }

    /** Record an accepted-source handover only after the common GPS gate passes. */
    private noteAcceptedSource(source: TrackSource): void {
        this.selectedTrackSource = source;
        if (source === 'nmea') this.lastNmeaAcceptedAt = Date.now();
        else this.lastPhoneAcceptedAt = Date.now();
    }

    /**
     * Preserve the latest accepted raw fix when a voyage stops. It closes the
     * final leg even if that fix arrived just before the current zone cadence
     * was due. Returns false when there is nothing newer than the last vertex.
     */
    bufferFinalPoint(): boolean {
        const opts = this.activeOptions;
        const pos = this.lastAcceptedFix;
        if (!opts || !pos || !opts.isActive()) return false;
        if (this.lastBufferedAt >= pos.timestamp) return false;
        // Stopping owns the final flush synchronously. Do not let a last-metre
        // zone transition re-arm the scheduler while stopTracking is draining.
        return this.bufferPlotPoint(pos, opts, true, false, false);
    }

    /**
     * Apply the per-fix plotting profile after a position clears the full GPS
     * acceptance gate. GPS remains continuously observed; this only decides
     * whether the fix becomes a persisted polyline vertex.
     */
    private bufferPlotPoint(
        pos: CachedPosition,
        opts: GpsSubscriptionOptions,
        force = false,
        notifyProfileChange = true,
        notifyPointBuffered = true,
    ): boolean {
        const profile = this.resolvePlottingProfile(pos, opts);
        const previous = this.lastBufferedFix;
        const firstPoint = previous === null;
        const zoneChanged = this.lastBufferedZone !== null && this.lastBufferedZone !== profile.zone;
        const elapsedMs = firstPoint ? Number.POSITIVE_INFINITY : pos.timestamp - this.lastBufferedAt;

        // Track entries must remain chronological. The first-fix gate already
        // enforces this for its opening pair; later raw provider duplicates can
        // still arrive out of order.
        if (!firstPoint && elapsedMs <= 0) return false;

        const dueByCadence = firstPoint || profile.intervalMs <= 0 || elapsedMs >= profile.intervalMs;
        const preserveNavigationDetail = this.needsNavigationDetail(pos, profile);
        if (!force && !zoneChanged && !dueByCadence && !preserveNavigationDetail) {
            return false;
        }

        opts.trackBuffer.push(pos);
        this.lastBufferedAt = pos.timestamp;
        this.lastBufferedFix = pos;
        const profileChanged = this.lastBufferedZone !== profile.zone;
        this.lastBufferedZone = profile.zone;

        if (profileChanged && notifyProfileChange) {
            try {
                opts.onPlottingProfileChanged?.(profile);
            } catch (error) {
                // A UI/state listener must never take down GPS intake.
                log.warn('plotting-profile listener threw', error);
            }
        }
        if (notifyPointBuffered) {
            try {
                opts.onPlotPointBuffered?.(pos, profile);
            } catch (error) {
                // Durability wake-ups are best effort; a listener failure
                // must never interrupt GPS intake or lose this buffered point.
                log.warn('plot-point listener threw', error);
            }
        }
        return true;
    }

    /** Resolve a safe compatibility profile for callers not yet opting in. */
    private resolvePlottingProfile(pos: CachedPosition, opts: GpsSubscriptionOptions): PlottingProfile {
        try {
            const profile = opts.getPlottingProfile?.(pos);
            if (
                profile &&
                (profile.zone === 'nearshore' || profile.zone === 'coastal' || profile.zone === 'offshore') &&
                Number.isFinite(profile.intervalMs) &&
                profile.intervalMs >= 0
            ) {
                return profile;
            }
        } catch (error) {
            // A resolver failure must retain the dense, backwards-compatible
            // behaviour rather than silently reducing coastal detail.
            log.warn('plotting-profile resolver threw; retaining 3-second nearshore cadence', error);
        }
        // Missing or failed geographic evidence is deliberately dense, but
        // still honours the documented 3-second land/inshore policy rather
        // than silently persisting every raw provider update.
        return { zone: 'nearshore', intervalMs: NEARSHORE_INTERVAL_MS };
    }

    /** Extra vertices that protect offshore geometry between five-minute ticks. */
    private needsNavigationDetail(pos: CachedPosition, profile: PlottingProfile): boolean {
        const previous = this.lastBufferedFix;
        if (!previous) return false;

        // Nearshore and coastal have deliberately dense fixed cadences. Turn
        // vertices are an offshore-only safeguard against hiding geometry in
        // a five-minute chord; applying them here would silently make a
        // manoeuvring coastal track much denser than its stated 30s policy.
        if (profile.zone !== 'offshore') return false;

        const speed = Math.max(0, pos.speed ?? 0, previous.speed ?? 0);
        const previousHeading = previous.heading;
        const currentHeading = pos.heading;
        if (
            speed >= TURN_CAPTURE_MIN_SPEED_MS &&
            typeof previousHeading === 'number' &&
            typeof currentHeading === 'number' &&
            headingDelta(previousHeading, currentHeading) >= TURN_CAPTURE_DEGREES
        ) {
            return true;
        }

        const distanceM = haversineMeters(previous.latitude, previous.longitude, pos.latitude, pos.longitude);
        return distanceM >= OFFSHORE_MAX_SEGMENT_M;
    }

    /**
     * Four-layer fix-acceptance gate. Returns true to push the fix into
     * the buffer (and therefore eventually onto the polyline).
     *
     *   0. The fix's OWN timestamp must postdate this session's start —
     *      BgGeo replays the previous session's location on engine start
     *      with a fresh receivedAt, so receivedAt-based checks (and the
     *      5 s wall-clock warm-up, if the replay arrives late) can't
     *      catch it. That replay anchored voyages at a teleport-stale
     *      position and drew the cold-start straight line.
     *   1. Accuracy ≤ 100m — drop fixes the device flags as fuzzy.
     *   2. GPS-self-reported speed ≤ MAX_PLAUSIBLE_SPEED_KTS — catches
     *      device glitches where the speed channel goes haywire.
     *   3. Position-spike sanity (Haversine ÷ Δt) — catches POSITION
     *      teleports where lat/lon spiked but the device's own speed
     *      channel stayed normal. This is the gate the previous
     *      pipeline was missing — speed-channel filters can't catch it
     *      because GPS-reported speed can stay normal while lat/lon
     *      spikes.
     */
    private acceptFix(pos: CachedPosition, trackBuffer: GpsTrackBuffer): boolean {
        // Layer 0 — last-session replay. Allow a small slack for fixes
        // produced moments before Start was tapped (NMEA stamps arrival
        // time, so external fixes always pass).
        if (pos.timestamp < this.warmupStartTime - 10_000) {
            log.warn(
                `GPS rejected: fix timestamp ${new Date(pos.timestamp).toISOString()} predates session start — last-session replay`,
            );
            return false;
        }

        // Layer 1 — accuracy, with a cold-start ramp (see the constants
        // above). Tight while the chip settles so the wandering early
        // fixes are dropped; relaxes to the steady ceiling once warmed,
        // and abandons the ramp entirely past the fallback window so a
        // poor sky view still opens the track. Don't log; fringe-coverage
        // rejections are routine and would flood the log.
        const sinceStart = Date.now() - this.warmupStartTime;
        let accuracyLimit = MAX_ACCURACY_M;
        if (sinceStart < COLD_START_FALLBACK_MS) {
            if (!this.hasBufferedThisSession) accuracyLimit = COLD_START_ACCURACY_M;
            else if (sinceStart < COLD_START_WINDOW_MS) accuracyLimit = EARLY_ACCURACY_M;
        }
        if ((pos.accuracy ?? 999) > accuracyLimit) return false;

        // Layer 2 — GPS-reported speed.
        const gpsSpeedKts = (pos.speed ?? 0) * MS_TO_KTS;
        if (gpsSpeedKts > MAX_PLAUSIBLE_SPEED_KTS) {
            log.warn(`GPS rejected: device speed ${gpsSpeedKts.toFixed(1)}kn > ${MAX_PLAUSIBLE_SPEED_KTS}kn cap`);
            return false;
        }

        // Layer 3 — position-spike vs last ACCEPTED fix. (peek() falls
        // back to the session-persistent lastAcceptedFix: the buffer
        // empties on every flush drain, which used to exempt the first
        // fix after each tick from this check.)
        const lastFix = this.lastAcceptedFix ?? trackBuffer.peek();
        if (lastFix) {
            // Never let a provider replay an older or duplicate timestamp
            // into the accepted stream. bufferPlotPoint() also protects the
            // persisted polyline, but this earlier guard prevents an
            // out-of-order fix from overwriting lastAcceptedFix, moving the
            // shore resolver, or becoming the stop-time tail.
            if (pos.timestamp <= lastFix.timestamp) {
                log.warn('GPS rejected: non-monotonic accepted-fix timestamp');
                return false;
            }
            const dtSec = (pos.timestamp - lastFix.timestamp) / 1000;
            if (dtSec > 0.1) {
                // Skip <100ms duplicate / same-tick fixes
                const distM = haversineMeters(lastFix.latitude, lastFix.longitude, pos.latitude, pos.longitude);
                const impliedKts = (distM / dtSec) * MS_TO_KTS;
                if (impliedKts > MAX_PLAUSIBLE_SPEED_KTS * 1.5) {
                    log.warn(
                        `GPS rejected: position spike ${distM.toFixed(0)}m in ${dtSec.toFixed(1)}s = ${impliedKts.toFixed(0)}kn implied`,
                    );
                    return false;
                }
            }
        }

        return true;
    }
}
