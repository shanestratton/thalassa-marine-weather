/**
 * useLightningLayer — Xweather GLD360 lightning strike tiles.
 *
 * Tactical overlay: additive, can coexist with base weather layers.
 * Shows global lightning strike positions (last 15 min) via Xweather tiles.
 * Auto-refreshes every 5 minutes (302 redirect busts tile cache).
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('LightningLayer');

// ── Layer/Source IDs ──
const LIGHTNING_SOURCE = 'lightning-xweather-source';
const LIGHTNING_LAYER = 'lightning-xweather-layer';

// ── Xweather credentials ──
const XW_ID = import.meta.env.VITE_XWEATHER_CLIENT_ID ?? '';
const XW_SECRET = import.meta.env.VITE_XWEATHER_CLIENT_SECRET ?? '';

function buildLightningTileUrl(): string {
    return `https://maps.api.xweather.com/${XW_ID}_${XW_SECRET}` + `/lightning-strikes-15min/{z}/{x}/{y}/current.png`;
}

export function useLightningLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
) {
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const isSetUp = useRef(false);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // ── Guard: need Xweather credentials ──
        if (!XW_ID || !XW_SECRET) {
            log.warn('Missing Xweather credentials — lightning layer disabled');
            return;
        }

        if (visible && !isSetUp.current) {
            // ── Setup ──
            const tileUrl = buildLightningTileUrl();

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

            // ── Auto-refresh every 5 min (302 redirect busts cache) ──
            refreshTimer.current = setInterval(
                () => {
                    try {
                        const src = map.getSource(LIGHTNING_SOURCE) as mapboxgl.RasterTileSource;
                        if (src && typeof src.setTiles === 'function') {
                            src.setTiles([buildLightningTileUrl()]);
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
            isSetUp.current = false;
            log.info('Lightning layer removed');
        }

        return () => {
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
        };
    }, [mapRef, mapReady, visible]);
}
