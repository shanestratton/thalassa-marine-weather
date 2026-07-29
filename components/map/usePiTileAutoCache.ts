/**
 * usePiTileAutoCache — silently fill a 1000 NM tiered shell of raster tiles
 * around the boat while a Bosun Pi is on the network and the connection is
 * strong, so the map keeps working the moment you drop offline.
 *
 * Extracted from MapHub verbatim, including the whole gating rationale below
 * — it is the record of what the skipper actually asked for ("only if they
 * have a strong connection", no prompts, no confirmations).
 *
 * THE DEP ARRAY AND ITS SUPPRESSION ARE LOAD-BEARING, and not for the reason
 * they look like. The effect reads the `weatherCoords` OBJECT, but the deps
 * name `weatherCoords?.lat` and `weatherCoords?.lon` — the PRIMITIVES —
 * deliberately. weatherCoords is `weatherData?.coordinates`, a fresh object on
 * every weather refresh even when the numbers are identical. Depping on the
 * object would tear down and restart this effect on every refresh, aborting an
 * in-flight multi-tier download that can take minutes. Keep the disable and
 * the array exactly as they are; do NOT "complete" them by adding
 * weatherCoords.
 *
 * Planning mode is deliberately NOT a gate. It is a visual-isolation concern
 * and this job is non-visual, so aborting on Chart → Plan could stop it ever
 * retrying.
 *
 * It re-evaluates on three triggers — the Pi appearing, the connection
 * improving to high, or the location changing — so a phone that started on
 * weak cellular and later joins the marina WiFi picks the cache up on its own.
 */

import { useEffect, useRef } from 'react';
import { piCache } from '../../services/PiCacheService';
import { MapOfflineService } from '../../services/MapOfflineService';
import { getConnectionState, onConnectionChange } from '../../services/ConnectionPriorityService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

export interface PiTileAutoCacheDeps {
    /** weatherData?.coordinates — a NEW object on every refresh, which is why
     *  the effect deps on its lat/lon primitives rather than on this. */
    weatherCoords: { lat: number; lon: number } | undefined;
    embedded: boolean;
    pickerMode: boolean;
    isPinView: boolean;
}

export function usePiTileAutoCache({ weatherCoords, embedded, pickerMode, isPinView }: PiTileAutoCacheDeps): void {
    // ── Auto-cache tiles around the user when a Pi is in play ──
    // When the boat has a Pi on the network AND the user has a strong
    // internet connection, silently download a 1000 NM tiered shell of
    // raster tiles around the user so the map keeps working the moment
    // they drop offline. Tier breakdown lives in MapOfflineService:
    //   1000 NM @ z4-7   (ocean-wide)
    //   500 NM  @ z8-9   (regional)
    //   150 NM  @ z10-11 (coastal approach)
    //   40 NM   @ z12-13 (harbour detail)
    //
    // Conditions for firing:
    //   - Pi is reachable (piCache.isAvailable())
    //   - Connection quality is 'high' (WiFi / good 4G — NOT cellular
    //     2G/3G, NOT satellite, NOT save-data mode). User explicitly
    //     asked for "only if they have a strong connection".
    //   - User has a valid weatherCoords
    //   - User has moved > 100 NM since the last auto-cache (tracked
    //     in localStorage by MapOfflineService)
    //   - Pi's SQLite cache isn't already gigantic (>10 GB)
    //
    // Re-evaluates on three triggers — Pi appearing, connection
    // improving to 'high', or location changing — so a phone that
    // started on weak cellular and later joined a marina WiFi will
    // pick up the cache automatically without the user having to do
    // anything. No prompts, no confirmations.
    const autoCacheRanRef = useRef(false);
    useEffect(() => {
        // Planning mode is a visual-isolation concern. This silent Pi cache
        // job is non-visual, and aborting it on Chart → Plan after setting the
        // session guard could prevent it from ever retrying.
        if (embedded || pickerMode || isPinView) return;
        if (!weatherCoords) return;
        if (autoCacheRanRef.current) return;

        let cancelled = false;
        const ctrl = new AbortController();
        const tryRun = async () => {
            if (!piCache.isAvailable()) return; // wait for Pi
            // Connection-quality gate — only auto-cache when the user
            // actually has the bandwidth to spare. Strong = WiFi or
            // 4G+ with > 0.5 Mbps downlink + saveData off. Weak = 2G,
            // 3G with low downlink, satellite, or saveData enabled.
            const conn = getConnectionState();
            if (conn.quality !== 'high') {
                log.info(
                    `Auto-cache: skipping — connection quality '${conn.quality}' (type=${conn.type}, downlink=${conn.effectiveDownlink}). Will retry when it improves.`,
                );
                return;
            }
            autoCacheRanRef.current = true;
            const outcome = await MapOfflineService.autoDownloadAroundUser({
                centerLat: weatherCoords.lat,
                centerLon: weatherCoords.lon,
                signal: ctrl.signal,
                // Toast progress callback removed — Shane found the
                // "Auto-caching 1000 NM…" + "Pi cached N tiles…"
                // toasts unannounced/distracting on the Charts page.
                // The cache fills silently in the background; if the
                // user wants to verify, the Pi cache status badge in
                // settings shows tile counts.
                onProgress: () => {},
            });
            if (cancelled) return;
            if (outcome.status === 'error') {
                // Reset the guard so a later weatherCoords change can retry.
                autoCacheRanRef.current = false;
                log.warn('Auto-cache failed:', outcome.message);
            } else if (outcome.status === 'skipped') {
                // Skipped for a legitimate reason (no Pi, not moved, cache full) —
                // don't toast the user, but leave the guard open so Pi arriving
                // later or movement over the threshold can still kick it off.
                autoCacheRanRef.current = false;
                log.info('Auto-cache skipped:', outcome.reason);
            }
        };

        // Run once now, then subscribe so we fire the moment EITHER
        //   (a) the Pi is found, or
        //   (b) the connection upgrades to high quality
        // — whichever was the missing condition the first time.
        tryRun();
        const unsubPi = piCache.onStatusChange(() => {
            if (!autoCacheRanRef.current && piCache.isAvailable()) tryRun();
        });
        const unsubConn = onConnectionChange((state) => {
            if (!autoCacheRanRef.current && state.quality === 'high' && piCache.isAvailable()) {
                log.info(`Auto-cache: connection upgraded to high (${state.type}) — kicking off`);
                tryRun();
            }
        });

        return () => {
            cancelled = true;
            ctrl.abort();
            unsubPi();
            unsubConn();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherCoords?.lat, weatherCoords?.lon, embedded, pickerMode, isPinView]);
}
