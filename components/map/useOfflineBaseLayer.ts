/**
 * useOfflineBaseLayer — Raster OSM fallback that shows when the device is offline.
 *
 * Mapbox's vector base style (`mapbox/dark-v11`) needs fresh glyph/sprite
 * fetches and fails to render cleanly offline even when tiles are cached.
 * This hook adds a cheap OSM raster source underneath everything, but
 * only while the device is offline — so it costs zero bandwidth online.
 *
 * Web tiles come from CacheStorage through public/sw.js. Native tiles use
 * persistent Directory.Data files through Capacitor's local-file bridge.
 */
import { useEffect, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { getOfflineTileTemplates } from '../../services/MapOfflineService';

const log = createLogger('OfflineBaseLayer');

const SOURCE_ID = 'osm-offline-fallback';
const LAYER_ID = 'osm-offline-fallback';
const SEAMARK_SOURCE_ID = 'seamark-offline-fallback';
const SEAMARK_LAYER_ID = 'seamark-offline-fallback';

export function useOfflineBaseLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    isOnline: boolean,
): void {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        let cancelled = false;

        const addOfflineLayers = async () => {
            const templates = await getOfflineTileTemplates();
            if (cancelled || mapRef.current !== map) return;

            // Add the OSM raster source/layer only when offline.
            if (!map.getSource(SOURCE_ID)) {
                try {
                    map.addSource(SOURCE_ID, {
                        type: 'raster',
                        tiles: [templates.osm],
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

            if (!map.getSource(SEAMARK_SOURCE_ID)) {
                try {
                    map.addSource(SEAMARK_SOURCE_ID, {
                        type: 'raster',
                        tiles: [templates.openseamap],
                        tileSize: 256,
                        maxzoom: 18,
                        attribution: '© OpenSeaMap contributors',
                    });
                    map.addLayer({
                        id: SEAMARK_LAYER_ID,
                        type: 'raster',
                        source: SEAMARK_SOURCE_ID,
                        minzoom: 0,
                        maxzoom: 19,
                        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
                    });
                    log.info(`Offline seamarks added from ${templates.storage}`);
                } catch (err) {
                    log.warn('Failed to add offline seamarks', err);
                }
            }
        };

        if (!isOnline) {
            void addOfflineLayers().catch((err) => log.warn('Failed to prepare persistent offline tiles', err));
        } else {
            // Back online — tear down to let the vector style take over again.
            if (map.getLayer(SEAMARK_LAYER_ID)) {
                try {
                    map.removeLayer(SEAMARK_LAYER_ID);
                } catch (err) {
                    log.warn('remove seamark layer failed', err);
                }
            }
            if (map.getSource(SEAMARK_SOURCE_ID)) {
                try {
                    map.removeSource(SEAMARK_SOURCE_ID);
                } catch (err) {
                    log.warn('remove seamark source failed', err);
                }
            }
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

        return () => {
            cancelled = true;
        };
    }, [mapRef, mapReady, isOnline]);
}
