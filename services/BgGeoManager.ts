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
// The v9 enums come from the shared types package, NOT from the plugin. The
// plugin's index.d.ts re-exports them for TYPES only — its dist/index.js does
// not, so importing them from there type-checks and then dies at bundle time
// with "DesiredAccuracy is not exported". The types package ships real runtime
// JS for each enum, so this is the import that actually exists in both worlds.
import { ActivityType, DesiredAccuracy, LogLevel } from '@transistorsoft/background-geolocation-types';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('BgGeo');

// Android-only interval keys. iOS TSGeolocationConfig has no such properties
// and logs "received undefined key" for each on every ready()/setConfig() —
// iOS stays distance-driven either way, so send them only where they exist.
const ANDROID_INTERVAL_KEYS =
    Capacitor.getPlatform() === 'android' ? { locationUpdateInterval: 3000, fastestLocationUpdateInterval: 3000 } : {};

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

/**
 * Why the device can or cannot produce a fix. `reason` is what the UI shows
 * instead of an eternal spinner — a permission denial and a cold start look
 * identical to a skipper, and only one of them is worth waiting for.
 */
export type GpsHealthReason = 'ok' | 'not-determined' | 'denied' | 'services-off' | 'no-gps' | 'unknown';
export interface GpsHealth {
    usable: boolean;
    reason: GpsHealthReason;
    /** True when the skipper can fix this in iOS Settings. */
    actionable: boolean;
}

export type LocationCallback = (pos: CachedPosition) => void;
export type GeofenceCallback = (event: { identifier: string; action: string; location: Location }) => void;
export type HeartbeatCallback = (event: { location: Location }) => void;
export type ActivityCallback = (event: { activity: string; confidence: number }) => void;

// ---------- CONSTANTS ----------

// ---------- SINGLETON ----------

class BgGeoManagerClass {
    private ready = false;
    private readyPromise: Promise<void> | null = null; // Prevent duplicate ready() calls
    private startCount = 0; // Ref-count for start/stop balancing
    /** Bumped on every sampling-mode change; see setSamplingMode's token. */
    private samplingModeGeneration = 0;

    // Cached position from the continuous onLocation stream
    private _lastPosition: CachedPosition | null = null;

    // Subscription management
    private coreSubscriptions: BGSubscription[] = [];
    private locationListeners = new Set<LocationCallback>();
    private geofenceListeners = new Set<GeofenceCallback>();
    private heartbeatListeners = new Set<HeartbeatCallback>();
    private activityListeners = new Set<ActivityCallback>();
    private healthListeners = new Set<(h: GpsHealth) => void>();
    /** Last known provider health, seeded at ready() and kept current by
     *  onProviderChange. Null until the first read. */
    private _lastHealth: GpsHealth | null = null;

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
            try {
                await BackgroundGeolocation.start();
            } catch (e) {
                // GIVE THE LEASE BACK. The count is incremented before this
                // await, so a rejection here — permission revoked between a
                // caller's check and its start, or the OS refusing — used to
                // leave the count permanently at 1. Every later requestStop()
                // then clamped at 1 and stop() was NEVER reached, so the engine
                // and the iOS location indicator stayed on for the rest of the
                // session after the skipper had explicitly stopped recording.
                // The caller still sees the rejection and decides what to say.
                this.startCount = Math.max(0, this.startCount - 1);
                throw e;
            }
            // REPLACES v8's `isMoving: true` in ready(). v9 removed isMoving
            // from Config and made it runtime state (State.isMoving), so
            // without this the engine starts STATIONARY and waits for motion
            // detection before delivering fixes — precisely the cold-start
            // stall the fast-lock work exists to avoid, and it would have
            // regressed silently since nothing type-checks a missing default.
            try {
                await BackgroundGeolocation.changePace(true);
            } catch (e) {
                // Non-fatal: motion detection still promotes to moving on its
                // own, just later. Never let it block a track starting.
                log.warn('changePace(true) failed on start; engine will detect motion itself:', e);
            }
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
     *   2026-07-26: intake target moved to 3 s so land/inshore plotting can
     *      preserve every available eligible fix. The app-level geographic
     *      sampler now controls durable track density (3 s / 30 s / 5 min),
     *      while this native stream remains live for safety alarms, UI, and
     *      detecting a zone transition.
     *
     * Modes:
     *   - 'default'   — distanceFilter 1 m (steady state)
     *   - 'precision' — distanceFilter 1 m (same; kept for back-compat
     *                   with callers that still pass 'precision')
     *   - 'fastlock'  — distanceFilter 0 — emit on EVERY chip update.
     *
     * The 1 m distanceFilter is what stops stationary GPS jitter from
     * generating fixes at anchor. During real movement at any speed
     * above ~0.2 m/s, available movement fixes are delivered continuously.
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
    /**
     * Can this device actually produce a fix right now, and if not, WHY?
     *
     * Reads the OS provider state WITHOUT prompting — `getProviderState()` is a
     * query, not a request — which is what lets the launch warm-up decide
     * whether to start the engine without raising an iOS permission dialog on a
     * first-ever launch, before onboarding has explained itself.
     *
     * It also exists so the app can stop showing a spinner over a permission
     * problem it already knows about: `status` is CLLocationManager's
     * authorization enum (0 notDetermined, 1/2 restricted/denied, 3 always,
     * 4 whenInUse) and `enabled` is device-wide Location Services.
     */
    async getGpsHealth(): Promise<GpsHealth> {
        if (!this.isNativeSupported()) return { usable: false, reason: 'unknown', actionable: false };
        try {
            await this.ensureReady();
            const health = this._healthFromProviderState(await BackgroundGeolocation.getProviderState());
            this._lastHealth = health;
            return health;
        } catch (e) {
            log.warn('getProviderState failed:', String(e));
            return { usable: false, reason: 'unknown', actionable: false };
        }
    }

    /** Synchronous last-known health — null before the first read. */
    getLastGpsHealth(): GpsHealth | null {
        return this._lastHealth;
    }

    /** Live authorization/provider changes. Fires whenever the OS revokes
     *  permission or Location Services is switched off mid-session. */
    subscribeGpsHealth(cb: (h: GpsHealth) => void): () => void {
        this.healthListeners.add(cb);
        return () => this.healthListeners.delete(cb);
    }

    private _healthFromProviderState(state: { enabled: boolean; status: number; gps: boolean }): GpsHealth {
        // `status` is CLLocationManager's authorization enum: 0 notDetermined,
        // 1 restricted, 2 denied, 3 always, 4 whenInUse.
        if (!state.enabled) return { usable: false, reason: 'services-off', actionable: true };
        if (state.status === 0) return { usable: false, reason: 'not-determined', actionable: true };
        if (state.status === 1 || state.status === 2) return { usable: false, reason: 'denied', actionable: true };
        // An MFi receiver (Bad Elf GPS Pro+ and friends) feeds Core Location
        // system-wide, so it presents here exactly like the internal chip —
        // there is deliberately nothing receiver-specific to check.
        if (!state.gps) return { usable: false, reason: 'no-gps', actionable: false };
        return { usable: true, reason: 'ok', actionable: false };
    }

    /**
     * Set the sampling mode and return a TOKEN identifying this particular
     * change, for use with restoreSamplingModeIfCurrent.
     *
     * Sampling mode is global to one shared engine but is set by several
     * independent owners (the launch warm-up, the ship's log cold start, the
     * precision toggle). Without a token a late "put it back" from one owner
     * silently cancels a mode another owner has since set deliberately — and
     * the specific collision that matters is cheap to hit: warm up at launch,
     * cast off within 45 s, and the warm-up's release would drop the engine
     * out of the fast-lock the ship's log had just armed, restoring the exact
     * stationary-vessel hang fixed in 00579bf2.
     */
    async setSamplingMode(mode: 'default' | 'precision' | 'fastlock'): Promise<number> {
        const token = ++this.samplingModeGeneration;
        if (!this.isNativeSupported()) return token;
        try {
            await this.ensureReady();
            await BackgroundGeolocation.setConfig({
                geolocation: {
                    distanceFilter: mode === 'fastlock' ? 0 : 1,
                    // Android honours these values. iOS remains distance-driven;
                    // the voyage sampler records each eligible iOS fix no more
                    // often than its active geographic profile permits.
                    ...ANDROID_INTERVAL_KEYS,
                },
            });
            log.info(`GPS sampling → ${mode.toUpperCase()} (distanceFilter ${mode === 'fastlock' ? 0 : 1})`);
        } catch (e) {
            log.warn('setSamplingMode failed (engine may not be running):', e);
        }
        return token;
    }

    /**
     * Undo a sampling-mode change ONLY if nothing else has changed it since.
     * A no-op when another owner has taken over — see setSamplingMode.
     */
    async restoreSamplingModeIfCurrent(token: number, mode: 'default' | 'precision' | 'fastlock'): Promise<void> {
        if (token !== this.samplingModeGeneration) return;
        await this.setSamplingMode(mode);
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

    /** The cache, but ONLY if it is inside the caller's freshness bound. */
    private _cachedWithin(staleLimitMs: number): CachedPosition | null {
        if (!this._lastPosition) return null;
        const age = Date.now() - this._lastPosition.receivedAt;
        return age < staleLimitMs ? this._lastPosition : null;
    }

    /**
     * One-shot position fetch. Uses the cached position if it is inside
     * staleLimitMs, otherwise asks the platform for a new one.
     *
     * FAILS CLOSED. Every path honours staleLimitMs — the two fallbacks used to
     * `return this._lastPosition` unconditionally, handing back the very cache
     * the age check had just rejected, with no bound on how old it was.
     * `_lastPosition` is never cleared, only overwritten, so on a device that
     * had a fix hours ago and has none now, a caller asking for a 15-second
     * position got the hours-old one and no way to tell.
     *
     * That mattered most where it was worst: MobService asks with a 15s bound
     * and marks the result as the man-overboard position, so a stale fix sends
     * the search to the wrong water. AnchorWatchService asks with 5s to set the
     * anchor, which is the datum every drag alarm is measured against.
     *
     * Returning null is safe and is what callers already expect — MobService
     * logs "Cannot activate MOB — no GPS fix available" and refuses,
     * AnchorWatchService throws rather than drop an anchor it cannot locate.
     * A caller that genuinely wants best-effort should pass a larger bound and
     * say so, rather than have every caller silently get one.
     */
    async getFreshPosition(staleLimitMs: number = 30_000, timeoutSec: number = 15): Promise<CachedPosition | null> {
        const cached = this._cachedWithin(staleLimitMs);
        if (cached) return cached;

        if (!this.isNativeSupported()) return this._cachedWithin(staleLimitMs);

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
            // Last resort is still BOUNDED: a fix outside the caller's window is
            // not a fallback, it is wrong data wearing a fresh timestamp.
            return this._cachedWithin(staleLimitMs);
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
            // v9 COMPOUND CONFIG. Every value below is carried over unchanged
            // from the v8 flat config — only the grouping and the enum names
            // moved (v9.0.0 restructured Config into geolocation/app/logger/
            // http and replaced BackgroundGeolocation.DESIRED_ACCURACY_HIGH
            // style constants with DesiredAccuracy/ActivityType/LogLevel).
            // Deliberately no behaviour change in the same commit as an SDK
            // major: if tracking regresses, it is the SDK, not our tuning.
            //
            // `isMoving: true` has NO compound equivalent — v9 made it runtime
            // state rather than config (State.isMoving, set via changePace).
            // It is re-applied in requestStart() right after start().
            await BackgroundGeolocation.ready({
                geolocation: {
                    // High accuracy for marine navigation.
                    desiredAccuracy: DesiredAccuracy.High,
                    // 3 s Android target with a 1 m gate — matches
                    // setSamplingMode(). iOS is distance-driven; its available
                    // fixes feed the same app-level geographic sampler.
                    distanceFilter: 1,
                    ...ANDROID_INTERVAL_KEYS,

                    // Geofencing. geofenceModeHighAccuracy is Android-only
                    // (forces location-based fencing over the low-power
                    // hardware geofence API — the anchor swing-radius case).
                    // TSGeolocationConfig.h has no such iOS property; iOS
                    // fence accuracy comes from CoreLocation region
                    // monitoring plus geofenceProximityRadius, which IS a
                    // real iOS property.
                    geofenceProximityRadius: 5000,
                    geofenceInitialTriggerEntry: false,
                    ...(Capacitor.getPlatform() === 'android' ? { geofenceModeHighAccuracy: true } : {}),

                    // iOS-specific — CRITICAL for background GPS
                    activityType: ActivityType.OtherNavigation,
                    showsBackgroundLocationIndicator: true,
                    // iOS: Request 'WhenInUse' first — iOS will auto-promote to
                    // 'Always' via its provisional flow when background tracking
                    // starts. Requesting 'Always' directly in ready() blocks the
                    // main thread with a synchronous
                    // CLLocationManager.authorizationStatus check.
                    locationAuthorizationRequest: 'WhenInUse',
                },

                activity: {
                    // NEVER auto-stop — vessel may be anchored, and anchor
                    // watch NEEDS fixes precisely when the device reads as
                    // stationary. `stopTimeout: 0` said the opposite of what
                    // it meant (audit follow-up 2026-08-03): stopTimeout is
                    // the number of MINUTES to wait after motion-stop before
                    // turning location OFF, so 0 = off IMMEDIATELY the moment
                    // the motion API called a moored boat "still" — the
                    // silent fix starvation behind days of stale-receiver
                    // symptoms. disableStopDetection is the documented way to
                    // keep location on regardless of the motion API; battery
                    // is governed by this manager's ref-counted leases, which
                    // already stop the engine when nothing needs it.
                    //
                    // v9 home is THIS group (TSActivityConfig on iOS,
                    // ActivityConfig in the JS types). It previously sat
                    // under `geolocation`, where iOS rejected it as an
                    // undefined key — so the never-auto-stop fix was
                    // silently not applied on iOS.
                    disableStopDetection: true,
                },

                app: {
                    stopOnTerminate: false, // Keep tracking if app is killed
                    startOnBoot: false, // Don't auto-start on device reboot
                    preventSuspend: true, // iOS: prevent app suspension
                    heartbeatInterval: 60, // Heartbeat every 60s when stationary
                },

                logger: {
                    logLevel: LogLevel.Warning,
                    debug: false,
                },

                // No HTTP — we handle data locally via Supabase.
                http: {
                    autoSync: false,
                },
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

        // Provider/authorization changes — the ONLY way the app learns that
        // permission was revoked or Location Services switched off while it was
        // running. Without this the UI has no signal at all and a denial is
        // indistinguishable from "still acquiring", which is what let a spinner
        // run for hours over a problem the OS had already decided.
        const provSub = BackgroundGeolocation.onProviderChange((event) => {
            const health = this._healthFromProviderState(event);
            this._lastHealth = health;
            log.warn(`GPS provider changed → ${health.reason} (enabled=${event.enabled} status=${event.status})`);
            this.healthListeners.forEach((cb) => {
                try {
                    cb(health);
                } catch (e) {
                    log.warn('listener error:', e);
                }
            });
        });
        this.coreSubscriptions.push(provSub);
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
