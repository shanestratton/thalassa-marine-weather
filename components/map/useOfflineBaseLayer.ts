/** Cached raster fallback, above the opaque basemap and below chart overlays. */
import { useEffect, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { getOfflineTileTemplates } from '../../services/MapOfflineService';
import { cloudOverlayBeforeId } from './imageryOrder';
import { OPENSEAMAP_ATTRIBUTION } from './seamarkCredit';

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
        if (!map || !mapReady || isOnline) return;
        let cancelled = false;
        let templates: Awaited<ReturnType<typeof getOfflineTileTemplates>> | null = null;

        const restore = () => {
            if (cancelled || mapRef.current !== map || !templates || !map.isStyleLoaded()) return;
            try {
                // Placing a raster before layers[0] puts it BELOW an opaque
                // background. Use the imagery/chart boundary instead. Filter
                // our layers out so repeated restoration cannot self-anchor.
                const layers = (map.getStyle()?.layers ?? []).filter(
                    (layer) => layer.id !== LAYER_ID && layer.id !== SEAMARK_LAYER_ID,
                );
                const before = cloudOverlayBeforeId(layers);
                if (!map.getSource(SOURCE_ID))
                    map.addSource(SOURCE_ID, {
                        type: 'raster',
                        tiles: [templates.osm],
                        tileSize: 256,
                        maxzoom: 19,
                        attribution: '© OpenStreetMap',
                    });
                if (!map.getLayer(LAYER_ID))
                    map.addLayer(
                        {
                            id: LAYER_ID,
                            type: 'raster',
                            source: SOURCE_ID,
                            minzoom: 0,
                            maxzoom: 19,
                            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
                        },
                        before,
                    );
                if (!map.getSource(SEAMARK_SOURCE_ID))
                    map.addSource(SEAMARK_SOURCE_ID, {
                        type: 'raster',
                        tiles: [templates.openseamap],
                        tileSize: 256,
                        maxzoom: 18,
                        attribution: OPENSEAMAP_ATTRIBUTION,
                    });
                if (!map.getLayer(SEAMARK_LAYER_ID))
                    map.addLayer(
                        {
                            id: SEAMARK_LAYER_ID,
                            type: 'raster',
                            source: SEAMARK_SOURCE_ID,
                            minzoom: 0,
                            maxzoom: 19,
                            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
                        },
                        before,
                    );
            } catch (error) {
                // A concurrent style replacement can interrupt installation;
                // style.load/idle retries only the missing resources.
                log.warn('Failed to restore persistent offline tiles', error);
            }
        };
        map.on('style.load', restore);
        map.on('idle', restore);
        void getOfflineTileTemplates()
            .then((loaded) => {
                if (cancelled) return;
                templates = loaded;
                restore();
            })
            .catch((error) => {
                if (!cancelled) log.warn('Failed to prepare persistent offline tiles', error);
            });

        return () => {
            cancelled = true;
            map.off('style.load', restore);
            map.off('idle', restore);
            for (const id of [SEAMARK_LAYER_ID, LAYER_ID]) {
                try {
                    if (map.getLayer(id)) map.removeLayer(id);
                } catch {
                    /* removed map or concurrent style replacement */
                }
            }
            for (const id of [SEAMARK_SOURCE_ID, SOURCE_ID]) {
                try {
                    if (map.getSource(id)) map.removeSource(id);
                } catch {
                    /* removed map or concurrent style replacement */
                }
            }
        };
    }, [mapRef, mapReady, isOnline]);
}
