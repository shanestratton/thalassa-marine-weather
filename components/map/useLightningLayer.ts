/**
 * useLightningLayer — Xweather GLD360 lightning strike tiles.
 *
 * Tactical overlay: additive, can coexist with base weather layers.
 * Shows global lightning strike positions (last 15 min) via Xweather tiles.
 * Pi routing is handled upstream by the map's transformRequest.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('LightningLayer');

// ── Layer/Source IDs ──
const LIGHTNING_SOURCE = 'lightning-xweather-source';
const LIGHTNING_LAYER = 'lightning-xweather-layer';

// ── Xweather feature gate ──
// Credentials live server-side only (XWEATHER_CLIENT_ID / _SECRET on
// Vercel). The client just needs to know whether the proxy is wired
// up — the public CLIENT_ID env var is fine for that since it has no
// auth power on its own.
const XW_ENABLED = Boolean(import.meta.env.VITE_XWEATHER_CLIENT_ID);

// Xweather raster layer code. The `:15` suffix is the valid modifier for
// the 15-minute aggregation — don't drop it, the account isn't entitled to
// the plain `lightning-strikes` layer and it will 403.
//
// Tiles route through our `/api/xweather/` Vercel edge proxy which
// injects the secret server-side; see api/xweather/[...path].ts.
function buildLightningTileUrl(cacheBust?: number): string {
    const suffix = cacheBust ? `?_ts=${cacheBust}` : '';
    return `/api/xweather/lightning-strikes:15/{z}/{x}/{y}/current.png${suffix}`;
}

export function useLightningLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
) {
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const errorHandler = useRef<((e: unknown) => void) | null>(null);
    const isSetUp = useRef(false);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // ── Guard: need Xweather credentials configured server-side ──
        if (!XW_ENABLED) {
            log.warn('Xweather not configured (VITE_XWEATHER_CLIENT_ID missing) — lightning layer disabled');
            return;
        }

        if (visible && !isSetUp.current) {
            // Stamp the initial tile URL so post-refresh `setTiles` with a new
            // stamp is distinguishable — both Mapbox and the Pi passthrough
            // cache key include the query string.
            const tileUrl = buildLightningTileUrl(Date.now());

            try {
                if (!map.getSource(LIGHTNING_SOURCE)) {
                    map.addSource(LIGHTNING_SOURCE, {
                        type: 'raster',
                        tiles: [tileUrl],
                        tileSize: 256,
                        minzoom: 1,
                        maxzoom: 12,
                    });
                }

                if (!map.getLayer(LIGHTNING_LAYER)) {
                    // Insert above base layers but below symbols/routes
                    const styleLayers = map.getStyle()?.layers ?? [];
                    const beforeId =
                        styleLayers.find((l) => l.type === 'symbol')?.id ??
                        (map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);

                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER,
                            type: 'raster',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                'raster-opacity': 0.85,
                                'raster-fade-duration': 200,
                            },
                        },
                        beforeId,
                    );
                }

                isSetUp.current = true;
                log.info('Lightning layer added (Xweather GLD360)');
            } catch (err) {
                log.warn('Failed to add lightning layer:', err);
            }

            // Tile load failures (403/404 from Xweather, CORS, etc.) surface on
            // the map's 'error' event, not the setup try/catch. Scope to our
            // source so we don't spam the console with unrelated errors.
            const handler = (e: mapboxgl.ErrorEvent & { sourceId?: string }) => {
                if (e?.sourceId === LIGHTNING_SOURCE) {
                    log.warn('Lightning tile error:', e.error?.message ?? e);
                }
            };
            errorHandler.current = handler as (e: unknown) => void;
            map.on('error', handler);

            // Refresh every 5 min with a fresh stamp so both Mapbox and the Pi
            // passthrough bypass their caches and fetch a new 15-min aggregate.
            refreshTimer.current = setInterval(
                () => {
                    try {
                        const src = map.getSource(LIGHTNING_SOURCE) as mapboxgl.RasterTileSource;
                        if (src && typeof src.setTiles === 'function') {
                            src.setTiles([buildLightningTileUrl(Date.now())]);
                            log.info('Lightning tiles refreshed');
                        }
                    } catch {
                        /* map may be destroyed */
                    }
                },
                5 * 60 * 1000,
            );
        }

        if (!visible && isSetUp.current) {
            // ── Teardown ──
            try {
                if (map.getLayer(LIGHTNING_LAYER)) map.removeLayer(LIGHTNING_LAYER);
            } catch {
                /* already removed */
            }
            try {
                if (map.getSource(LIGHTNING_SOURCE)) map.removeSource(LIGHTNING_SOURCE);
            } catch {
                /* already removed */
            }
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (errorHandler.current) {
                try {
                    map.off('error', errorHandler.current as never);
                } catch {
                    /* map may be destroyed */
                }
                errorHandler.current = null;
            }
            isSetUp.current = false;
            log.info('Lightning layer removed');
        }

        return () => {
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (errorHandler.current && map) {
                try {
                    map.off('error', errorHandler.current as never);
                } catch {
                    /* map may be destroyed */
                }
                errorHandler.current = null;
            }
        };
    }, [mapRef, mapReady, visible]);
}
