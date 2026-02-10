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
import { createLogger } from '../utils/logger';

const log = createLogger('BgGeo');

// ---------- TYPES ----------

export interface CachedPosition {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    heading: number;
    speed: number;
    timestamp: number;       // epoch-ms
    receivedAt: number;      // epoch-ms — when WE received it (for staleness checks)
}

export type LocationCallback = (pos: CachedPosition) => void;
export type GeofenceCallback = (event: { identifier: string; action: string; location: Location }) => void;
export type HeartbeatCallback = (event: { location: Location }) => void;
export type ActivityCallback = (event: { activity: string; confidence: number }) => void;

// ---------- CONSTANTS ----------

const TRANSISTOR_LICENSE_KEY = 'a246ce79f5b488b41d12f1c64512e7d795814ba4f9714823d978b7c3c77501b6';

// ---------- SINGLETON ----------

class BgGeoManagerClass {
    private ready = false;
    private readyPromise: Promise<void> | null = null; // Prevent duplicate ready() calls
    private startCount = 0;                            // Ref-count for start/stop balancing

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
     * Ref-counted start. Multiple callers can request start; the engine only
     * stops when ALL callers have called `requestStop()`.
     */
    async requestStart(): Promise<void> {
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
        this.startCount = Math.max(0, this.startCount - 1);
        if (this.startCount === 0) {
            try { await BackgroundGeolocation.stop(); } catch { /* may not be running */ }
        }
    }

    /**
     * Force-stop regardless of ref count (e.g., app shutdown).
     */
    async forceStop(): Promise<void> {
        this.startCount = 0;
        try { await BackgroundGeolocation.stop(); } catch { /* ok */ }
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
        } catch {
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
        await this.ensureReady();
        await BackgroundGeolocation.addGeofence(params);
    }

    async removeGeofence(id: string): Promise<void> {
        try { await BackgroundGeolocation.removeGeofence(id); } catch { /* may not exist */ }
    }

    // ---- INTERNAL ----

    private async _doReady(): Promise<void> {
        try {
            await BackgroundGeolocation.ready({
                // Geolocation — high accuracy for marine navigation
                desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
                distanceFilter: 5,               // Record every 5m of movement
                locationUpdateInterval: 3000,     // 3s preferred (Android)
                fastestLocationUpdateInterval: 1000,

                // Activity recognition
                stopTimeout: 0,                   // NEVER auto-stop — vessel may be anchored
                isMoving: true,                   // Start in moving mode for immediate GPS

                // Background behavior — the premium features
                stopOnTerminate: false,           // Keep tracking if app is killed
                startOnBoot: false,               // Don't auto-start on device reboot
                preventSuspend: true,             // iOS: prevent app suspension
                heartbeatInterval: 60,            // Heartbeat every 60s when stationary

                // Geofencing
                geofenceProximityRadius: 5000,
                geofenceInitialTriggerEntry: false,

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
        this.coreSubscriptions.forEach(s => s.remove());
        this.coreSubscriptions = [];

        // Location updates → cache + fan-out
        const locSub = BackgroundGeolocation.onLocation(
            (location) => {
                const cached = this._locationToCache(location);
                this._lastPosition = cached;
                this.locationListeners.forEach(cb => {
                    try { cb(cached); } catch { /* listener error */ }
                });
            },
            (error) => {
                // Location error — log but don't crash
                log.warn('Location error:', error);
            }
        );
        this.coreSubscriptions.push(locSub);

        // Geofence events → fan-out
        const geoSub = BackgroundGeolocation.onGeofence((event) => {
            this.geofenceListeners.forEach(cb => {
                try { cb(event); } catch { /* listener error */ }
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
            this.heartbeatListeners.forEach(cb => {
                try { cb(event); } catch { /* listener error */ }
            });
        });
        this.coreSubscriptions.push(hbSub);

        // Activity change → fan-out (moving ↔ stationary transitions)
        const actSub = BackgroundGeolocation.onActivityChange((event) => {
            this.activityListeners.forEach(cb => {
                try { cb(event); } catch { /* listener error */ }
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
            heading: loc.coords.heading ?? 0,
            speed: loc.coords.speed ?? 0,
            timestamp: loc.timestamp ? new Date(loc.timestamp).getTime() : Date.now(),
            receivedAt: Date.now(),
        };
    }
}

// Export singleton
export const BgGeoManager = new BgGeoManagerClass();
