/**
 * BgGeoManager — Shared BackgroundGeolocation initialization & coordination
 *
 * PROBLEM: Both ShipLogService and AnchorWatchService independently call
 * BackgroundGeolocation.ready() with different configs. Transistorsoft only
 * applies the FIRST ready() call's config — subsequent calls are ignored.
 *
 * SOLUTION: Single point of initialization with a merged, battle-hardened
 * config. Both services call BgGeoManager.ensureReady() instead of their own.
 *
 * Also provides:
 *  - Cached last-known position (from onLocation stream)
 *  - Subscription helpers for location, geofence, heartbeat, activity changes
 *  - Safe start/stop coordination when multiple consumers are active
 */

import BackgroundGeolocation, {
    Location,
    Subscription as BGSubscription,
} from '@transistorsoft/capacitor-background-geolocation';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('BgGeo');

// ---------- TYPES ----------

export interface CachedPosition {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    heading: number | null;
    speed: number;
    timestamp: number; // epoch-ms
    receivedAt: number; // epoch-ms — when WE received it (for staleness checks)
}

export type LocationCallback = (pos: CachedPosition) => void;
export type GeofenceCallback = (event: { identifier: string; action: string; location: Location }) => void;
export type HeartbeatCallback = (event: { location: Location }) => void;
export type ActivityCallback = (event: { activity: string; confidence: number }) => void;

// ---------- CONSTANTS ----------

const _TRANSISTOR_LICENSE_KEY = import.meta.env.VITE_TRANSISTOR_LICENSE_KEY || '';

// ---------- SINGLETON ----------

class BgGeoManagerClass {
    private ready = false;
    private readyPromise: Promise<void> | null = null; // Prevent duplicate ready() calls
    private startCount = 0; // Ref-count for start/stop balancing

    // Cached position from the continuous onLocation stream
    private _lastPosition: CachedPosition | null = null;

    // Subscription management
    private coreSubscriptions: BGSubscription[] = [];
    private locationListeners = new Set<LocationCallback>();
    private geofenceListeners = new Set<GeofenceCallback>();
    private heartbeatListeners = new Set<HeartbeatCallback>();
    private activityListeners = new Set<ActivityCallback>();

    // ---- PUBLIC API ----

    /**
     * Initialize BackgroundGeolocation exactly once.
     * Safe to call from multiple services — only the first call configures the plugin.
     */
    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.readyPromise) return this.readyPromise;

        // The Transistorsoft plugin has no web implementation. Treat the web
        // build as a supported no-op rather than invoking the proxy and
        // emitting a rejected promise on every log-page mount.
        if (!this.isNativeSupported()) {
            this.ready = true;
            return;
        }

        this.readyPromise = this._doReady();
        return this.readyPromise;
    }

    /**
     * Get the most recent cached position, or null if never received.
     * The `receivedAt` field lets callers decide if it's stale.
     */
    getLastPosition(): CachedPosition | null {
        return this._lastPosition;
    }

    /**
     * Whether the native background-geolocation engine is currently ENABLED
     * (actively tracking). This state persists natively across app
     * suspension and termination (stopOnTerminate:false), so on a fresh
     * JS-context reload it's the source of truth for "is a voyage's GPS
     * capture genuinely still live?" — unlike any in-memory JS flag, which
     * resets on reload. Returns false on web or if the plugin errors.
     */
    async isNativeTrackingEnabled(): Promise<boolean> {
        if (!this.isNativeSupported()) return false;
        try {
            const state = await BackgroundGeolocation.getState();
            return state?.enabled === true;
        } catch {
            return false;
        }
    }

    /**
     * Ref-counted start. Multiple callers can request start; the engine only
     * stops when ALL callers have called `requestStop()`.
     */
    async requestStart(): Promise<void> {
        if (!this.isNativeSupported()) return;
        await this.ensureReady();
        this.startCount++;
        if (this.startCount === 1) {
            await BackgroundGeolocation.start();
        }
    }

    /**
     * Ref-counted stop. Only actually stops the engine when no consumers remain.
     */
    async requestStop(): Promise<void> {
        if (!this.isNativeSupported()) return;
        this.startCount = Math.max(0, this.startCount - 1);
        if (this.startCount === 0) {
            try {
                await BackgroundGeolocation.stop();
            } catch (e) {
                log.warn('may not be running:', e);
            }
        }
    }

    /**
     * Force-stop regardless of ref count (e.g., app shutdown).
     */
    async forceStop(): Promise<void> {
        this.startCount = 0;
        if (!this.isNativeSupported()) return;
        try {
            await BackgroundGeolocation.stop();
        } catch (e) {
            log.warn('ok:', e);
        }
    }

    /**
     * Runtime-reconfigure the Transistor GPS sampling rate.
     *
     * Model history:
     *   2026-05-17: introduced two-tier sampling — DEFAULT (1 m/1 Hz)
     *      vs PRECISION (distanceFilter 0, 2 Hz, with live decimation
     *      in pushWithLiveFilter to keep storage sane).
     *   2026-05-19: collapsed to a single 5 s cadence with NO live
     *      decimation and NO RDP at flush. The 2 Hz + smart-cull model
     *      cut too much detail at driving speeds (the 3-point
     *      collinearity filter killed straight-road runs). 5 s ×
     *      4-day passage ≈ 72k fixes — large but tractable: ~3.5 MB
     *      stored, Mapbox handles the polyline, battery is BETTER than
     *      the old 2 Hz precision mode. Predictability > compression.
     *
     * Modes:
     *   - 'default'   — distanceFilter 1 m (steady state)
     *   - 'precision' — distanceFilter 1 m (same; kept for back-compat
     *                   with callers that still pass 'precision')
     *   - 'fastlock'  — distanceFilter 0 — emit on EVERY chip update.
     *
     * The 1 m distanceFilter is what stops stationary GPS jitter from
     * generating fixes at anchor. During real movement at any speed
     * above ~0.2 m/s, every 5 s tick produces a fix.
     *
     * FAST-LOCK (2026-06-17): on iOS, CLLocationManager delivers fixes
     * by DISTANCE, not time — `locationUpdateInterval` /
     * `fastestLocationUpdateInterval` are Android-only and inert here.
     * The only iOS fix-rate lever is `distanceFilter`. At the dock,
     * stationary, distanceFilter:1 emits almost nothing (no 1 m of
     * movement to cross), which STARVES the ship-log first-fix
     * consistency gate — it needs a 2nd corroborating fix before it
     * opens the track, so "Acquiring GPS fix…" lingers. distanceFilter:0
     * emits on every chip update regardless of movement, delivering that
     * 2nd fix in seconds. (This does NOT make the GPS lock or converge
     * faster — TTFF is satellite-bound — it just unblocks the gate.)
     * ShipLogService arms this for ~30 s at the start of a genuinely new
     * voyage, then reverts to 'default'.
     *
     * Calling `setConfig` on a running BgGeo session applies live,
     * no restart needed.
     */
    async setSamplingMode(mode: 'default' | 'precision' | 'fastlock'): Promise<void> {
        if (!this.isNativeSupported()) return;
        try {
            await this.ensureReady();
            await BackgroundGeolocation.setConfig({
                distanceFilter: mode === 'fastlock' ? 0 : 1,
                locationUpdateInterval: 5000,
                fastestLocationUpdateInterval: 5000,
            });
            log.info(`GPS sampling → ${mode.toUpperCase()} (distanceFilter ${mode === 'fastlock' ? 0 : 1})`);
        } catch (e) {
            log.warn('setSamplingMode failed (engine may not be running):', e);
        }
    }

    // ---- SUBSCRIBE HELPERS ----

    subscribeLocation(cb: LocationCallback): () => void {
        this.locationListeners.add(cb);
        return () => this.locationListeners.delete(cb);
    }

    subscribeGeofence(cb: GeofenceCallback): () => void {
        this.geofenceListeners.add(cb);
        return () => this.geofenceListeners.delete(cb);
    }

    subscribeHeartbeat(cb: HeartbeatCallback): () => void {
        this.heartbeatListeners.add(cb);
        return () => this.heartbeatListeners.delete(cb);
    }

    subscribeActivity(cb: ActivityCallback): () => void {
        this.activityListeners.add(cb);
        return () => this.activityListeners.delete(cb);
    }

    /**
     * One-shot position fetch. Uses cached position if fresh (<staleLimitMs),
     * otherwise falls back to getCurrentPosition with timeout.
     */
    async getFreshPosition(staleLimitMs: number = 30_000, timeoutSec: number = 15): Promise<CachedPosition | null> {
        // Try cached first
        if (this._lastPosition) {
            const age = Date.now() - this._lastPosition.receivedAt;
            if (age < staleLimitMs) return this._lastPosition;
        }

        if (!this.isNativeSupported()) return this._lastPosition;

        // Fallback to on-demand fetch
        try {
            await this.ensureReady();
            const loc = await BackgroundGeolocation.getCurrentPosition({
                samples: 1,
                persist: false,
                desiredAccuracy: 10,
                timeout: timeoutSec,
            });
            return this._locationToCache(loc);
        } catch (e) {
            log.warn('getFreshPosition failed:', String(e));
            // If getCurrentPosition fails, return stale cache as last resort
            return this._lastPosition;
        }
    }

    // ---- Geofence pass-through ----

    async addGeofence(params: {
        identifier: string;
        latitude: number;
        longitude: number;
        radius: number;
        notifyOnEntry?: boolean;
        notifyOnExit?: boolean;
        notifyOnDwell?: boolean;
    }): Promise<void> {
        if (!this.isNativeSupported()) return;
        await this.ensureReady();
        await BackgroundGeolocation.addGeofence(params);
    }

    async removeGeofence(id: string): Promise<void> {
        if (!this.isNativeSupported()) return;
        try {
            await BackgroundGeolocation.removeGeofence(id);
        } catch (e) {
            log.warn('may not exist:', e);
        }
    }

    // ---- INTERNAL ----

    private isNativeSupported(): boolean {
        return Capacitor.getPlatform() !== 'web';
    }

    private async _doReady(): Promise<void> {
        try {
            await BackgroundGeolocation.ready({
                // Geolocation — high accuracy for marine navigation
                desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
                // 5 s cadence with 1 m gate — matches setSamplingMode().
                // See the long-form rationale on that method. Stationary
                // jitter is gated out by distanceFilter; during movement
                // every 5 s tick produces a kept fix.
                distanceFilter: 1,
                locationUpdateInterval: 5000,
                fastestLocationUpdateInterval: 5000,

                // Activity recognition
                stopTimeout: 0, // NEVER auto-stop — vessel may be anchored
                isMoving: true, // Start in moving mode for immediate GPS

                // Background behavior — the premium features
                stopOnTerminate: false, // Keep tracking if app is killed
                startOnBoot: false, // Don't auto-start on device reboot
                preventSuspend: true, // iOS: prevent app suspension
                heartbeatInterval: 60, // Heartbeat every 60s when stationary

                // Geofencing — high-accuracy mode is REQUIRED for the
                // 20–50 m anchor swing-radius use case. Without this
                // flag, iOS may fall back to the low-power Significant
                // Location Changes API (~500 m resolution) for fence
                // checks, which means a vessel can drift 500 m
                // off-anchor before the EXIT event fires. Set to true
                // 2026-05-17 as part of the anchor-watch reliability
                // pass; battery cost is acceptable because the watch
                // is only ever armed when the user explicitly drops
                // anchor (not during normal sailing).
                geofenceProximityRadius: 5000,
                geofenceInitialTriggerEntry: false,
                geofenceModeHighAccuracy: true,

                // iOS-specific — CRITICAL for background GPS
                activityType: BackgroundGeolocation.ACTIVITY_TYPE_OTHER_NAVIGATION,
                showsBackgroundLocationIndicator: true,
                // iOS: Request 'WhenInUse' first — iOS will auto-promote to 'Always'
                // via its provisional flow when background tracking starts.
                // Requesting 'Always' directly in ready() blocks the main thread with
                // a synchronous CLLocationManager.authorizationStatus check.
                locationAuthorizationRequest: 'WhenInUse',

                // Logging
                logLevel: BackgroundGeolocation.LOG_LEVEL_WARNING,
                debug: false,

                // No HTTP — we handle data locally via Supabase
                autoSync: false,
            });

            // Wire up core event subscriptions (once, globally)
            this._wireSubscriptions();
            this.ready = true;
        } catch (error) {
            this.readyPromise = null; // Allow retry on failure
            throw error;
        }
    }

    private _wireSubscriptions(): void {
        // Cleanup any previous (shouldn't exist, but defensive)
        this.coreSubscriptions.forEach((s) => s.remove());
        this.coreSubscriptions = [];

        // Location updates → cache + fan-out
        const locSub = BackgroundGeolocation.onLocation(
            (location) => {
                const cached = this._locationToCache(location);
                this._lastPosition = cached;
                this.locationListeners.forEach((cb) => {
                    try {
                        cb(cached);
                    } catch (e) {
                        log.warn('listener error:', e);
                    }
                });
            },
            (error) => {
                // Location error — log but don't crash
                log.warn('Location error:', error);
            },
        );
        this.coreSubscriptions.push(locSub);

        // Geofence events → fan-out
        const geoSub = BackgroundGeolocation.onGeofence((event) => {
            this.geofenceListeners.forEach((cb) => {
                try {
                    cb(event);
                } catch (e) {
                    log.warn('listener error:', e);
                }
            });
        });
        this.coreSubscriptions.push(geoSub);

        // Heartbeat → fan-out (fires every heartbeatInterval when stationary)
        const hbSub = BackgroundGeolocation.onHeartbeat((event) => {
            // Also update cached position from heartbeat
            if (event.location) {
                const cached = this._locationToCache(event.location);
                this._lastPosition = cached;
            }
            this.heartbeatListeners.forEach((cb) => {
                try {
                    cb(event);
                } catch (e) {
                    log.warn('listener error:', e);
                }
            });
        });
        this.coreSubscriptions.push(hbSub);

        // Activity change → fan-out (moving ↔ stationary transitions)
        const actSub = BackgroundGeolocation.onActivityChange((event) => {
            this.activityListeners.forEach((cb) => {
                try {
                    cb(event);
                } catch (e) {
                    log.warn('listener error:', e);
                }
            });
        });
        this.coreSubscriptions.push(actSub);
    }

    private _locationToCache(loc: Location): CachedPosition {
        return {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? 99,
            altitude: loc.coords.altitude ?? null,
            heading: loc.coords.heading ?? null,
            speed: loc.coords.speed ?? 0,
            timestamp: loc.timestamp ? new Date(loc.timestamp).getTime() : Date.now(),
            receivedAt: Date.now(),
        };
    }
}

// Export singleton
export const BgGeoManager = new BgGeoManagerClass();
