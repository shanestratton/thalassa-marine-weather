/**
 * useChartCatalog — Map hook for rendering free nautical chart tile overlays.
 *
 * Manages adding/removing raster tile layers from the Chart Catalog
 * (NOAA NCDS, NOAA ECDIS, LINZ) onto the Mapbox map.
 *
 * Layers are inserted below sea marks and above the satellite base
 * (same z-ordering as AvNav charts).
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { ChartCatalogService, type ChartSource, type ChartSourceId } from '../../services/ChartCatalogService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('ChartCatalog-Map');

const SOURCE_PREFIX = 'chart-catalog-';
const LAYER_PREFIX = 'chart-catalog-layer-';

export function useChartCatalog(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean) {
    const [sources, setSources] = useState<ChartSource[]>([]);
    const addedLayersRef = useRef<Set<string>>(new Set());

    // Initialize service and subscribe to changes
    useEffect(() => {
        ChartCatalogService.initialize();
        setSources(ChartCatalogService.getSources());

        const unsub = ChartCatalogService.onChange((newSources) => {
            setSources([...newSources]);
        });

        return unsub;
    }, []);

    // Sync enabled chart layers with the map
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const enabledIds = new Set(sources.filter((s) => s.enabled && s.tileUrl).map((s) => s.id));

        // Add new layers
        for (const src of sources) {
            const sourceId = `${SOURCE_PREFIX}${src.id}`;
            const layerId = `${LAYER_PREFIX}${src.id}`;

            if (src.enabled && src.tileUrl) {
                if (!map.getSource(sourceId)) {
                    // Add raster tile source
                    map.addSource(sourceId, {
                        type: 'raster',
                        tiles: [src.tileUrl],
                        tileSize: 256,
                        minzoom: src.minZoom,
                        maxzoom: src.maxZoom,
                        bounds: src.bounds,
                        attribution: src.attribution,
                    });

                    // Insert below sea marks layer if it exists
                    let beforeLayer: string | undefined;
                    if (map.getLayer('sea-marks-tiles')) {
                        beforeLayer = 'sea-marks-tiles';
                    } else {
                        const layers = map.getStyle()?.layers || [];
                        const firstSymbol = layers.find((l) => l.type === 'symbol');
                        beforeLayer = firstSymbol?.id;
                    }

                    map.addLayer(
                        {
                            id: layerId,
                            type: 'raster',
                            source: sourceId,
                            paint: {
                                'raster-opacity': src.opacity,
                                'raster-fade-duration': 0,
                                'raster-resampling': 'nearest',
                            },
                        },
                        beforeLayer,
                    );

                    addedLayersRef.current.add(src.id);
                    log.info(`Added chart layer: ${src.name}`);
                } else {
                    // Update opacity if layer already exists
                    if (map.getLayer(layerId)) {
                        map.setPaintProperty(layerId, 'raster-opacity', src.opacity);
                    }
                }
            } else {
                // Remove disabled layers
                if (map.getLayer(layerId)) {
                    map.removeLayer(layerId);
                    log.info(`Removed chart layer: ${src.name}`);
                }
                if (map.getSource(sourceId)) {
                    map.removeSource(sourceId);
                }
                addedLayersRef.current.delete(src.id);
            }
        }

        // Remove orphaned layers
        for (const id of addedLayersRef.current) {
            if (!enabledIds.has(id as ChartSourceId)) {
                const layerId = `${LAYER_PREFIX}${id}`;
                const sourceId = `${SOURCE_PREFIX}${id}`;
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
                addedLayersRef.current.delete(id);
            }
        }
    }, [mapRef, mapReady, sources]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            if (!map) return;
            for (const id of addedLayersRef.current) {
                const layerId = `${LAYER_PREFIX}${id}`;
                const sourceId = `${SOURCE_PREFIX}${id}`;
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            }
            addedLayersRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fly to a chart's coverage area
    const flyToSource = useCallback(
        (src: ChartSource) => {
            const map = mapRef.current;
            if (!map || !src.bounds) return;
            map.fitBounds(
                [
                    [src.bounds[0], src.bounds[1]],
                    [src.bounds[2], src.bounds[3]],
                ],
                { padding: 40, duration: 1500 },
            );
        },
        [mapRef],
    );

    // Toggle a source
    const toggleSource = useCallback((id: ChartSourceId) => {
        ChartCatalogService.toggleSource(id);
    }, []);

    // Set opacity
    const setOpacity = useCallback((id: ChartSourceId, opacity: number) => {
        ChartCatalogService.setOpacity(id, opacity);
    }, []);

    // Update LINZ key
    const updateLinzKey = useCallback((key: string) => {
        ChartCatalogService.updateLinzKey(key);
    }, []);

    const hasEnabledCharts = sources.some((s) => s.enabled && s.tileUrl);

    return {
        sources,
        hasEnabledCharts,
        toggleSource,
        setOpacity,
        flyToSource,
        updateLinzKey,
    };
}
