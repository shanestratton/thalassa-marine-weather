/**
 * useOfflineBaseLayer — Raster OSM fallback that shows when the device is offline.
 *
 * Mapbox's vector base style (`mapbox/dark-v11`) needs fresh glyph/sprite
 * fetches and fails to render cleanly offline even when tiles are cached.
 * This hook adds a cheap OSM raster source underneath everything, but
 * only while the device is offline — so it costs zero bandwidth online.
 *
 * Tiles come from the service worker cache (see `public/sw.js`) and/or
 * the boat Pi cache (via the `transformRequest` passthrough in
 * `useMapInit`). If the user pre-downloaded the area they're in with the
 * "Download Offline Area" button, those cached tiles now render here.
 */
import { useEffect, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('OfflineBaseLayer');

const SOURCE_ID = 'osm-offline-fallback';
const LAYER_ID = 'osm-offline-fallback';

export function useOfflineBaseLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    isOnline: boolean,
): void {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!isOnline) {
            // Add the OSM raster source/layer only when offline.
            if (!map.getSource(SOURCE_ID)) {
                try {
                    map.addSource(SOURCE_ID, {
                        type: 'raster',
                        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        maxzoom: 19,
                        attribution: '© OpenStreetMap',
                    });

                    // Insert at the very bottom so it sits under every other layer.
                    const firstLayer = map.getStyle()?.layers?.[0]?.id;
                    map.addLayer(
                        {
                            id: LAYER_ID,
                            type: 'raster',
                            source: SOURCE_ID,
                            minzoom: 0,
                            maxzoom: 19,
                            paint: {
                                'raster-opacity': 1,
                                'raster-fade-duration': 0,
                            },
                        },
                        firstLayer,
                    );
                    log.info('Offline base layer added');
                } catch (err) {
                    log.warn('Failed to add offline base layer', err);
                }
            }
        } else {
            // Back online — tear down to let the vector style take over again.
            if (map.getLayer(LAYER_ID)) {
                try {
                    map.removeLayer(LAYER_ID);
                } catch (err) {
                    log.warn('removeLayer failed', err);
                }
            }
            if (map.getSource(SOURCE_ID)) {
                try {
                    map.removeSource(SOURCE_ID);
                } catch (err) {
                    log.warn('removeSource failed', err);
                }
            }
        }
    }, [mapRef, mapReady, isOnline]);
}
