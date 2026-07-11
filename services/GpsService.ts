/**
 * GpsService — Unified GPS access for the entire app
 *
 * On native (iOS/Android): Routes through BgGeoManager's Transistorsoft plugin
 * which coalesces GPS requests through a single CLLocationManager, uses cached
 * positions, and is dramatically more battery-efficient than raw navigator.geolocation.
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
const log = createLogger('GPS');

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
    /** Max age of cached position in ms (native only). Default: 30s */
    staleLimitMs?: number;
    /** Timeout in seconds. Default: 15 */
    timeoutSec?: number;
    /** Enable high accuracy (web only — native always high). Default: true */
    enableHighAccuracy?: boolean;
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

        if (this.isNative) {
            return this._nativeGetPosition(staleLimitMs, timeoutSec);
        }
        return this._webGetPosition(timeoutSec * 1000, enableHighAccuracy);
    }

    /**
     * Watch position continuously.
     * Native: Subscribes to BgGeoManager's onLocation stream (single CLLocationManager).
     * Web: Uses navigator.geolocation.watchPosition.
     * Returns an unsubscribe function.
     *
     * @param opts.ensureRunning  Native only. When true, the watcher
     *   ref-count-STARTS the GPS engine for the lifetime of the watch
     *   (and releases on unsubscribe). Use it for a screen that must show
     *   a LIVE position even when nothing else is tracking — e.g. The
     *   Glass location label. Without it the plugin is merely configured,
     *   so `onLocation` only fires if some OTHER consumer (anchor watch /
     *   ship log / MOB) already started the engine, and the stream is
     *   silent otherwise. Defaults to false to keep passive watchers
     *   (status indicators) from spinning GPS up app-wide.
     */
    watchPosition(callback: GpsCallback, opts: { ensureRunning?: boolean } = {}): () => void {
        if (this.isNative) {
            return this._nativeWatch(callback, opts.ensureRunning === true);
        }
        return this._webWatch(callback);
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
        // We need to lazy-import to avoid loading Transistorsoft on web
        let unsubscribe: (() => void) | null = null;
        let releaseEngine: (() => void) | null = null;
        let cancelled = false;

        void (async () => {
            try {
                const { BgGeoManager } = await import('./BgGeoManager');
                if (cancelled) return;

                // Ensure the engine is ready (idempotent — configures only).
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
                    await BgGeoManager.requestStart();
                    releaseEngine = () => void BgGeoManager.requestStop();
                    if (cancelled) {
                        releaseEngine();
                        releaseEngine = null;
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
            }
        })();

        return () => {
            cancelled = true;
            if (unsubscribe) unsubscribe();
            if (releaseEngine) {
                releaseEngine();
                releaseEngine = null;
            }
        };
    }

    // ---------- WEB FALLBACK ----------

    private _webGetPosition(timeoutMs: number, enableHighAccuracy: boolean): Promise<GpsPosition | null> {
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
            navigator.geolocation.getCurrentPosition(
                (pos) =>
                    resolve({
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy: pos.coords.accuracy,
                        altitude: pos.coords.altitude,
                        heading: pos.coords.heading,
                        speed: pos.coords.speed ?? 0,
                        timestamp: pos.timestamp,
                    }),
                () => resolve(null),
                { enableHighAccuracy, timeout: timeoutMs, maximumAge: 30000 },
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
            (err) => log.warn('[GpsService] web watch error:', err),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
        );
        return () => navigator.geolocation.clearWatch(id);
    }
}

// Export singleton
export const GpsService = new GpsServiceClass();
