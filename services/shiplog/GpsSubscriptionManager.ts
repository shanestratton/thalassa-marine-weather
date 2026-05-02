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
import { createLogger } from '../../utils/logger';
import { BgGeoManager } from '../BgGeoManager';
import type { CachedPosition } from '../BgGeoManager';
import { EnvironmentService } from '../EnvironmentService';
import { NmeaGpsProvider } from '../NmeaGpsProvider';
import { GpsPrecision } from './GpsPrecisionTracker';
import type { GpsTrackBuffer } from './GpsTrackBuffer';
import { haversineMeters } from './GpsTrackBuffer';
import { getIntervalForSpeed, type SpeedTier } from './helpers';

const log = createLogger('ShipLog.GpsSub');

const MS_TO_KTS = 1.94384;
const MAX_PLAUSIBLE_SPEED_KTS = 25;
const GPS_WARMUP_MS = 5_000;
const SPEED_TIER_DEBOUNCE = 3;
const WEB_HEARTBEAT_MS = 60_000;

export interface GpsSubscriptionOptions {
    isNative: boolean;
    /** Track buffer to push accepted fixes into (also used by the position-spike check). */
    trackBuffer: GpsTrackBuffer;
    /** True iff tracking is on and not paused — gates buffering and heartbeats. */
    isActive: () => boolean;
    /** True iff rapid mode is engaged — disables speed-tier debouncing while on. */
    isRapidMode: () => boolean;
    /** Current tracking interval in ms — read by heartbeat to decide if a flush is owed. */
    getIntervalMs: () => number;
    /** ISO timestamp of last saved entry, or undefined if none yet. */
    getLastEntryTime: () => string | undefined;
    /** Called for every incoming fix from any source. Orchestrator updates its `lastBgLocation` here. */
    onFix: (pos: CachedPosition) => void;
    /** Called when the debounced speed tier changes — orchestrator reschedules the interval. */
    onSpeedTierChanged: () => void;
    /** Called when the heartbeat detects a missed tick — orchestrator flushes the track. */
    onHeartbeatTick: () => void;
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
                        heading: geoPos.coords.heading ?? 0,
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
            if (opts.isActive() && this.acceptFix(cached, opts.trackBuffer)) {
                opts.trackBuffer.push(cached);
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

        // ── 4. Activity changes — native only ──
        // The legacy code subscribed but did nothing on each event. We
        // still subscribe in case a future iteration wants a hook, but
        // a no-op handler is fine here.
        if (opts.isNative) {
            const unsubAct = BgGeoManager.subscribeActivity(() => {
                /* reserved for future use */
            });
            this.unsubscribers.push(unsubAct);
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
        if (opts.isActive() && this.acceptFix(pos, opts.trackBuffer)) {
            opts.trackBuffer.push(pos);
        }

        // Altitude → EnvironmentService for on-water/on-land detection.
        if (pos.altitude !== null && pos.altitude !== undefined) {
            EnvironmentService.updateFromGPS({ altitude: pos.altitude });
        }
    }

    /**
     * Three-layer fix-acceptance gate. Returns true to push the fix into
     * the buffer (and therefore eventually onto the polyline).
     *
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
        // Layer 1 — accuracy. Don't log; fringe-coverage rejections are
        // routine and would flood the log.
        if ((pos.accuracy ?? 999) > 100) return false;

        // Layer 2 — GPS-reported speed.
        const gpsSpeedKts = (pos.speed ?? 0) * MS_TO_KTS;
        if (gpsSpeedKts > MAX_PLAUSIBLE_SPEED_KTS) {
            log.warn(`GPS rejected: device speed ${gpsSpeedKts.toFixed(1)}kn > ${MAX_PLAUSIBLE_SPEED_KTS}kn cap`);
            return false;
        }

        // Layer 3 — position-spike vs last buffered fix.
        const lastFix = trackBuffer.peek();
        if (lastFix) {
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
