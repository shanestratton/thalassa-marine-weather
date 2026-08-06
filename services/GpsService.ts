/**
 * GpsService — Unified GPS access for the entire app
 *
 * On native (iOS/Android): explicit background-safety owners route through
 * BgGeoManager's Transistorsoft plugin. Passive UI subscribers and ordinary
 * foreground location actions use Capacitor Geolocation so opening a screen
 * cannot initialize motion/background machinery or raise permission UI.
 *
 * On web: Falls back to navigator.geolocation for development/PWA.
 *
 * USAGE:
 *   import { GpsService } from '../services/GpsService';
 *
 *   // One-shot position
 *   const pos = await GpsService.getCurrentPosition();
 *   if (pos) log.info(pos.latitude, pos.longitude);
 *
 *   // Watch position (returns unsubscribe function)
 *   const unsub = GpsService.watchPosition((pos) => { ... });
 *   // later: unsub();
 */

import { createLogger } from '../utils/createLogger';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
const log = createLogger('GPS');
const MAX_STALE_LIMIT_MS = 0xffff_ffff; // Web IDL unsigned-long maximum.

// ---------- TYPES ----------

export interface GpsPosition {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    heading: number | null;
    speed: number; // m/s
    timestamp: number; // epoch-ms
}

export type GpsCallback = (pos: GpsPosition) => void;

// ---------- OPTIONS ----------

export interface GetPositionOptions {
    /** Max age of cached position in ms. Default: 30s */
    staleLimitMs?: number;
    /** Timeout in seconds. Default: 15 */
    timeoutSec?: number;
    /** Enable high accuracy (web only — native always high). Default: true */
    enableHighAccuracy?: boolean;
}

/** Android coarse-only grants must never be upgraded by a passive fix. */
export function canUseForegroundHighAccuracy(
    permission: { location: string; coarseLocation: string },
    requested: boolean,
): boolean {
    return requested && permission.location === 'granted';
}

// ---------- SERVICE ----------

class GpsServiceClass {
    private isNative = Capacitor.isNativePlatform();

    /**
     * One-shot position fetch.
     * Native: Uses BgGeoManager cached position → plugin getCurrentPosition.
     * Web: Uses navigator.geolocation.getCurrentPosition.
     * Returns null if GPS unavailable or timed out.
     */
    async getCurrentPosition(options: GetPositionOptions = {}): Promise<GpsPosition | null> {
        const { staleLimitMs = 30_000, timeoutSec = 15, enableHighAccuracy = true } = options;

        // Fail closed on a malformed freshness request. Passing a negative,
        // infinite, or NaN maximum age through to either platform can silently
        // become an effectively unbounded cache allowance.
        if (!Number.isFinite(staleLimitMs) || staleLimitMs < 0 || staleLimitMs > MAX_STALE_LIMIT_MS) {
            log.warn('[GpsService] invalid staleLimitMs; position request rejected');
            return null;
        }
        const validatedStaleLimitMs = Math.floor(staleLimitMs);

        if (this.isNative) {
            return this._nativeGetPosition(validatedStaleLimitMs, timeoutSec);
        }
        return this._webGetPosition(timeoutSec * 1000, enableHighAccuracy, validatedStaleLimitMs);
    }

    /**
     * Read a foreground position only when Location permission was already
     * granted before this call.
     *
     * Passive weather startup/follow/refresh uses this path. On native it
     * deliberately bypasses BgGeoManager: even though the safety engine is
     * configured not to request Motion & Fitness, a passive read must not
     * initialize background-capable machinery merely because a persisted
     * "Current Location" setting was restored. On the web, an unavailable
     * Permissions API fails closed instead of risking a browser prompt.
     */
    async getCurrentPositionIfGranted(options: GetPositionOptions = {}): Promise<GpsPosition | null> {
        const { staleLimitMs = 30_000, timeoutSec = 15, enableHighAccuracy = true } = options;
        if (!Number.isFinite(staleLimitMs) || staleLimitMs < 0 || staleLimitMs > MAX_STALE_LIMIT_MS) {
            log.warn('[GpsService] invalid passive staleLimitMs; position request rejected');
            return null;
        }
        const validatedStaleLimitMs = Math.floor(staleLimitMs);

        if (!this.isNative) {
            if (typeof window !== 'undefined' && window.isSecureContext === false) return null;
            if (!navigator.permissions?.query) return null;
            try {
                const permission = await navigator.permissions.query({ name: 'geolocation' });
                if (permission.state !== 'granted') return null;
            } catch {
                return null;
            }
            return this._webGetPosition(timeoutSec * 1000, enableHighAccuracy, validatedStaleLimitMs);
        }

        try {
            const permission = await Geolocation.checkPermissions();
            if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') return null;
            return await this._nativeForegroundPosition(
                permission,
                validatedStaleLimitMs,
                timeoutSec,
                enableHighAccuracy,
            );
        } catch (error) {
            log.info('[GpsService] passive native location unavailable:', error);
            return null;
        }
    }

    /**
     * Explicit foreground-only location request for weather/location-picker
     * actions. It requests coarse Location when needed and never initializes
     * the background engine, so a simple Current Location tap remains an
     * ordinary foreground permission action. Browsers prompt through their
     * normal foreground geolocation API because this method is direct intent.
     */
    async requestCurrentForegroundPosition(options: GetPositionOptions = {}): Promise<GpsPosition | null> {
        const { staleLimitMs = 30_000, timeoutSec = 15, enableHighAccuracy = false } = options;
        if (!Number.isFinite(staleLimitMs) || staleLimitMs < 0 || staleLimitMs > MAX_STALE_LIMIT_MS) {
            log.warn('[GpsService] invalid foreground staleLimitMs; position request rejected');
            return null;
        }
        const validatedStaleLimitMs = Math.floor(staleLimitMs);
        if (!this.isNative) {
            return this._webGetPosition(timeoutSec * 1000, enableHighAccuracy, validatedStaleLimitMs);
        }

        try {
            let permission = await Geolocation.checkPermissions();
            if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
                permission = await Geolocation.requestPermissions({ permissions: ['coarseLocation'] });
            }
            if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') return null;
            return await this._nativeForegroundPosition(
                permission,
                validatedStaleLimitMs,
                timeoutSec,
                enableHighAccuracy,
            );
        } catch (error) {
            log.info('[GpsService] foreground location unavailable:', error);
            return null;
        }
    }

    private async _nativeForegroundPosition(
        permission: { location: string; coarseLocation: string },
        staleLimitMs: number,
        timeoutSec: number,
        enableHighAccuracy: boolean,
    ): Promise<GpsPosition | null> {
        const requestedAt = Date.now();
        const fix = await Geolocation.getCurrentPosition({
            // Android maps a high-accuracy request to the fine-location alias
            // and auto-requests it when missing. Approximate-only permission
            // must therefore stay approximate on passive and foreground
            // weather paths instead of surfacing a surprise precision prompt.
            enableHighAccuracy: canUseForegroundHighAccuracy(permission, enableHighAccuracy),
            timeout: timeoutSec * 1000,
            maximumAge: staleLimitMs,
        });
        const receivedAt = Date.now();
        const timestamp = fix.timestamp;
        const timestampIsInvalid = !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedAt + 1_000;
        if (timestampIsInvalid || requestedAt - timestamp > staleLimitMs) {
            log.warn('[GpsService] foreground native geolocation returned an out-of-bound timestamp');
            return null;
        }

        const { latitude, longitude, accuracy, altitude, heading, speed } = fix.coords;
        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            log.warn('[GpsService] foreground native geolocation returned invalid coordinates');
            return null;
        }
        return {
            latitude,
            longitude,
            accuracy,
            altitude,
            heading,
            speed: speed ?? 0,
            timestamp,
        };
    }

    /**
     * Watch position continuously.
     * Native: defaults to an already-granted Capacitor foreground watch.
     * Web: defaults to an already-granted browser foreground watch.
     * Returns an unsubscribe function.
     *
     * @param opts.ensureRunning  Native only. When true, the watcher
     *   ref-count-STARTS the GPS engine for the lifetime of the watch
     *   (and releases on unsubscribe). Reserve it for an explicit safety
     *   feature such as MOB that genuinely owns background-capable tracking.
     *   Defaults to foreground, already-granted-only operation so passive
     *   status/map subscribers cannot raise Location or Motion permission UI.
     */
    /**
     * The most recent fix seen by ANY watcher, or null.
     *
     * Free: the location dot, vessel tracker, destination flag, system status
     * and Vessel hub all subscribe already, so fixes flow continuously
     * whenever any of them is mounted — this only stops throwing them away.
     *
     * Added for MOB (Shane 2026-08-07: "still taking 8 seconds ... we need it
     * instant"). Marking from cache only helps if a cache exists, and
     * LocationStore is written on explicit user actions rather than by the
     * live stream, so it was usually empty at the moment of need and MOB fell
     * back to a blocking acquisition. Callers MUST check the timestamp: this
     * is deliberately un-aged, so the consumer decides what "too old" means.
     */
    getLastKnownPosition(): GpsPosition | null {
        return this._lastKnownFix ? { ...this._lastKnownFix } : null;
    }
    private _lastKnownFix: GpsPosition | null = null;

    watchPosition(callback: GpsCallback, opts: { ensureRunning?: boolean } = {}): () => void {
        // Tap every delivery so the newest fix is always retained, whoever
        // asked for it and whichever platform lane served it.
        const retaining: GpsCallback = (pos) => {
            if (Number.isFinite(pos?.latitude) && Number.isFinite(pos?.longitude)) {
                this._lastKnownFix = { ...pos };
            }
            callback(pos);
        };
        if (this.isNative) {
            return this._nativeWatch(retaining, opts.ensureRunning === true);
        }
        return opts.ensureRunning === true ? this._webWatch(retaining) : this._webWatchIfGranted(retaining);
    }

    // ---------- NATIVE (Transistorsoft) ----------

    private async _nativeGetPosition(staleLimitMs: number, timeoutSec: number): Promise<GpsPosition | null> {
        try {
            const { BgGeoManager } = await import('./BgGeoManager');
            const cached = await BgGeoManager.getFreshPosition(staleLimitMs, timeoutSec);
            if (!cached) return null;
            return {
                latitude: cached.latitude,
                longitude: cached.longitude,
                accuracy: cached.accuracy,
                altitude: cached.altitude,
                heading: cached.heading,
                speed: cached.speed,
                timestamp: cached.timestamp,
            };
        } catch (e) {
            log.warn('[GpsService] native getCurrentPosition failed:', e);
            return null;
        }
    }

    private _nativeWatch(callback: GpsCallback, ensureRunning: boolean): () => void {
        if (!ensureRunning) return this._nativeForegroundWatchIfGranted(callback);

        // We need to lazy-import to avoid loading Transistorsoft on web
        let unsubscribe: (() => void) | null = null;
        let releaseEngine: (() => void) | null = null;
        let cancelled = false;

        void (async () => {
            try {
                const { BgGeoManager } = await import('./BgGeoManager');
                if (cancelled) return;

                // Only an explicit background-capable owner reaches this
                // branch. Passive subscribers use Capacitor Geolocation above
                // and never initialize the Transistorsoft engine.
                await BgGeoManager.ensureReady();
                if (cancelled) return;

                // `ensureReady` does NOT start location updates. A watcher
                // that opts into `ensureRunning` actively needs a live fix
                // stream, so ref-count-START the engine (coexists with
                // anchor watch / ship log / MOB; the engine stops only when
                // the last consumer releases). Race-safe: after the await,
                // the cancelled-check + assignment run synchronously, so an
                // unsubscribe that landed during the await still releases.
                if (ensureRunning) {
                    const leaseState = await BgGeoManager.requestStart();
                    let releaseComplete = false;
                    let releaseInFlight = false;
                    let releaseAttempts = 0;
                    const releaseLease = () => {
                        if (releaseComplete || releaseInFlight) return;
                        releaseInFlight = true;
                        void BgGeoManager.requestStop()
                            .then(() => {
                                releaseComplete = true;
                                releaseInFlight = false;
                                releaseEngine = null;
                            })
                            .catch((error) => {
                                // A final-stop failure retains this lease by
                                // design. Keep the release closure live and
                                // retry with a bounded backoff rather than
                                // orphaning an enabled engine.
                                releaseInFlight = false;
                                releaseAttempts += 1;
                                const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(releaseAttempts - 1, 5));
                                log.error(
                                    `[GpsService] native watch GPS release failed; retrying in ${retryMs}ms:`,
                                    error,
                                );
                                setTimeout(releaseLease, retryMs);
                            });
                    };
                    if (leaseState.activeLeaseCount > 0) releaseEngine = releaseLease;
                    if (!leaseState.active || !leaseState.nativeTrackingEnabled) {
                        releaseEngine?.();
                        throw new Error('The background GPS safety watch could not verify continuous tracking.');
                    }
                    if (cancelled) {
                        releaseEngine?.();
                        return;
                    }
                }

                unsubscribe = BgGeoManager.subscribeLocation((cached) => {
                    callback({
                        latitude: cached.latitude,
                        longitude: cached.longitude,
                        accuracy: cached.accuracy,
                        altitude: cached.altitude,
                        heading: cached.heading,
                        speed: cached.speed,
                        timestamp: cached.timestamp,
                    });
                });

                // Also emit the current cached position immediately if available
                const last = BgGeoManager.getLastPosition();
                if (last) {
                    callback({
                        latitude: last.latitude,
                        longitude: last.longitude,
                        accuracy: last.accuracy,
                        altitude: last.altitude,
                        heading: last.heading,
                        speed: last.speed,
                        timestamp: last.timestamp,
                    });
                }
            } catch (e) {
                log.warn('[GpsService] native watch setup failed:', e);
                unsubscribe?.();
                releaseEngine?.();
            }
        })();

        return () => {
            cancelled = true;
            if (unsubscribe) unsubscribe();
            if (releaseEngine) {
                releaseEngine();
            }
        };
    }

    private _nativeForegroundWatchIfGranted(callback: GpsCallback): () => void {
        let watchId: string | null = null;
        let cancelled = false;

        void (async () => {
            try {
                const permission = await Geolocation.checkPermissions();
                if (cancelled) return;
                if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') return;

                watchId = await Geolocation.watchPosition(
                    {
                        enableHighAccuracy: canUseForegroundHighAccuracy(permission, true),
                        timeout: 15_000,
                        maximumAge: 5_000,
                        minimumUpdateInterval: 3_000,
                    },
                    (position) => {
                        if (cancelled || !position) return;
                        const { latitude, longitude, accuracy, altitude, heading, speed } = position.coords;
                        if (
                            !Number.isFinite(latitude) ||
                            !Number.isFinite(longitude) ||
                            latitude < -90 ||
                            latitude > 90 ||
                            longitude < -180 ||
                            longitude > 180 ||
                            !Number.isFinite(position.timestamp) ||
                            position.timestamp <= 0 ||
                            position.timestamp > Date.now() + 1_000
                        ) {
                            return;
                        }
                        callback({
                            latitude,
                            longitude,
                            accuracy,
                            altitude,
                            heading,
                            speed: speed ?? 0,
                            timestamp: position.timestamp,
                        });
                    },
                );
                if (cancelled && watchId !== null) {
                    const id = watchId;
                    watchId = null;
                    await Geolocation.clearWatch({ id });
                }
            } catch (error) {
                log.info('[GpsService] passive native watch unavailable:', error);
            }
        })();

        return () => {
            cancelled = true;
            if (watchId !== null) {
                const id = watchId;
                watchId = null;
                void Geolocation.clearWatch({ id }).catch((error) => {
                    log.warn('[GpsService] passive native watch cleanup failed:', error);
                });
            }
        };
    }

    // ---------- WEB FALLBACK ----------

    private _webGetPosition(
        timeoutMs: number,
        enableHighAccuracy: boolean,
        staleLimitMs: number,
    ): Promise<GpsPosition | null> {
        return new Promise((resolve) => {
            if (!navigator.geolocation) {
                resolve(null);
                return;
            }
            // Plain-http origins (the Pi at calypso.local:3001) are not
            // secure contexts — Chrome rejects geolocation outright. Fail
            // FAST instead of burning the caller's 10 s timeout on a
            // request that can never succeed; callers fall back to the
            // home-port coords.
            if (typeof window !== 'undefined' && window.isSecureContext === false) {
                log.warn('[GpsService] insecure context (http) — geolocation unavailable, skipping');
                resolve(null);
                return;
            }
            const requestedAt = Date.now();
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    // `maximumAge` asks the browser not to serve an older cache,
                    // but verify the returned timestamp as well. Compare its age
                    // at request time so a newly acquired fix remains valid even
                    // when the provider takes time to call back (including when
                    // the caller requested maximumAge: 0).
                    const timestamp = pos.timestamp;
                    const receivedAt = Date.now();
                    const wasTooOldWhenRequested = requestedAt - timestamp > staleLimitMs;
                    const timestampIsInvalid =
                        !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedAt + 1_000;
                    if (timestampIsInvalid || wasTooOldWhenRequested) {
                        log.warn('[GpsService] web geolocation returned an out-of-bound timestamp');
                        resolve(null);
                        return;
                    }

                    resolve({
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy: pos.coords.accuracy,
                        altitude: pos.coords.altitude,
                        heading: pos.coords.heading,
                        speed: pos.coords.speed ?? 0,
                        timestamp,
                    });
                },
                () => resolve(null),
                { enableHighAccuracy, timeout: timeoutMs, maximumAge: staleLimitMs },
            );
        });
    }

    private _webWatch(callback: GpsCallback): () => void {
        if (!navigator.geolocation) return () => {};
        const id = navigator.geolocation.watchPosition(
            (pos) =>
                callback({
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    altitude: pos.coords.altitude,
                    heading: pos.coords.heading,
                    speed: pos.coords.speed ?? 0,
                    timestamp: pos.timestamp,
                }),
            (err) => {
                // Permission denial is an ordinary web/PWA state (the app can
                // continue with a selected port), not a runtime fault. Keep
                // genuine provider/time-out failures visible without flooding
                // the console when location permission has not been granted.
                if (err.code === err.PERMISSION_DENIED) {
                    log.info('[GpsService] web location permission not granted');
                } else {
                    log.warn(`[GpsService] web watch failed (${err.code}): ${err.message}`);
                }
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
        );
        return () => navigator.geolocation.clearWatch(id);
    }

    private _webWatchIfGranted(callback: GpsCallback): () => void {
        let unsubscribe: (() => void) | null = null;
        let cancelled = false;
        void (async () => {
            if (typeof window !== 'undefined' && window.isSecureContext === false) return;
            if (!navigator.permissions?.query) return;
            try {
                const permission = await navigator.permissions.query({ name: 'geolocation' });
                if (cancelled || permission.state !== 'granted') return;
                unsubscribe = this._webWatch(callback);
                if (cancelled) unsubscribe();
            } catch {
                // Permission state cannot be proven without risking a prompt.
            }
        })();
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }
}

// Export singleton
export const GpsService = new GpsServiceClass();
