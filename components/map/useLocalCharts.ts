/**
 * useLocalCharts — Map hook for rendering MBTiles charts stored on the phone.
 *
 * Opens MBTiles files via MBTilesService (sql.js WASM), then creates
 * Mapbox GL raster tile sources with fake "mbtiles.local" URLs. The
 * `transformRequest` in useMapInit intercepts these and returns blob
 * URLs from the in-memory SQLite database — all synchronous.
 *
 * This lets users view free NOAA/LINZ/community charts directly on
 * their phone without needing an AvNav server running.
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { MBTilesService, type OpenChart } from '../../services/MBTilesService';
import { ChartLockerService } from '../../services/ChartLockerService';
import { LocationStore } from '../../stores/LocationStore';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('LocalCharts');

const SOURCE_PREFIX = 'local-mbtiles-';
const LAYER_PREFIX = 'local-mbtiles-layer-';

/** Only .mbtiles files can be rendered locally (not .oesenc, .gemf, .kap) */
const RENDERABLE_EXTENSIONS = ['.mbtiles'];

function isRenderable(fileName: string): boolean {
    return RENDERABLE_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));
}

export function useLocalCharts(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabledChartIds: Set<string>,
    opacity: number,
) {
    const [availableCharts, setAvailableCharts] = useState<OpenChart[]>([]);
    const [loading, setLoading] = useState(false);
    const addedLayersRef = useRef(new Set<string>());

    // Scan chart_downloads/ for renderable .mbtiles files
    const refreshAvailable = useCallback(async () => {
        try {
            const localFiles = await ChartLockerService.getLocalCharts();
            const renderableFiles = localFiles.filter((f) => isRenderable(f.name));

            // Open any new .mbtiles files that aren't already loaded
            const toOpen = renderableFiles.filter((f) => !MBTilesService.isOpen(f.name));

            if (toOpen.length > 0) {
                setLoading(true);
                for (const file of toOpen) {
                    try {
                        await MBTilesService.open(file.name);
                    } catch (err) {
                        log.warn(`Failed to open ${file.name}:`, err);
                    }
                }
                setLoading(false);
            }

            setAvailableCharts(MBTilesService.getOpenCharts());
        } catch (err) {
            log.warn('Failed to scan local charts:', err);
        }
    }, []);

    // Subscribe to MBTilesService changes + initial scan
    useEffect(() => {
        const unsub = MBTilesService.subscribe(() => {
            setAvailableCharts(MBTilesService.getOpenCharts());
        });

        refreshAvailable();

        return () => {
            unsub();
        };
    }, [refreshAvailable]);

    // Add/remove chart layers when enabled set or available charts change
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const currentLayerIds = new Set(addedLayersRef.current);

        for (const chart of availableCharts) {
            const sourceId = `${SOURCE_PREFIX}${chart.fileName}`;
            const layerId = `${LAYER_PREFIX}${chart.fileName}`;

            if (enabledChartIds.has(chart.fileName)) {
                // Should be visible
                if (!map.getSource(sourceId)) {
                    // Tile URL uses fake mbtiles.local host — intercepted by transformRequest
                    const tileUrl = `http://mbtiles.local/${encodeURIComponent(chart.fileName)}/{z}/{x}/{y}`;

                    map.addSource(sourceId, {
                        type: 'raster',
                        tiles: [tileUrl],
                        tileSize: 256,
                        minzoom: chart.metadata.minzoom ?? 0,
                        maxzoom: chart.metadata.maxzoom ?? 18,
                        ...(chart.metadata.bounds ? { bounds: chart.metadata.bounds } : {}),
                    });

                    // Insert below sea marks (same pattern as useAvNavCharts)
                    let beforeLayer: string | undefined;
                    if (map.getLayer('sea-marks-tiles')) {
                        beforeLayer = 'sea-marks-tiles';
                    } else if (map.isStyleLoaded()) {
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
                                'raster-opacity': opacity,
                                'raster-fade-duration': 0,
                                'raster-resampling': 'nearest',
                            },
                        },
                        beforeLayer,
                    );

                    addedLayersRef.current.add(chart.fileName);
                    log.info(`Added chart layer: ${chart.name} (${chart.memoryMB} MB)`);
                } else {
                    // Already exists — update opacity
                    if (map.getLayer(layerId)) {
                        map.setPaintProperty(layerId, 'raster-opacity', opacity);
                    }
                }
                currentLayerIds.delete(chart.fileName);
            } else {
                // Should NOT be visible — remove if exists
                if (map.getLayer(layerId)) {
                    map.removeLayer(layerId);
                    log.info(`Removed chart layer: ${chart.name}`);
                }
                if (map.getSource(sourceId)) {
                    map.removeSource(sourceId);
                }
                addedLayersRef.current.delete(chart.fileName);
                currentLayerIds.delete(chart.fileName);
            }
        }

        // Remove orphaned layers
        for (const orphanId of currentLayerIds) {
            const layerId = `${LAYER_PREFIX}${orphanId}`;
            const sourceId = `${SOURCE_PREFIX}${orphanId}`;
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
            addedLayersRef.current.delete(orphanId);
        }
    }, [mapRef, mapReady, availableCharts, enabledChartIds, opacity]);

    // Update opacity on all active layers
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        for (const chartFile of addedLayersRef.current) {
            const layerId = `${LAYER_PREFIX}${chartFile}`;
            if (map.getLayer(layerId)) {
                map.setPaintProperty(layerId, 'raster-opacity', opacity);
            }
        }
    }, [mapRef, mapReady, opacity]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            if (!map) return;
            for (const chartFile of addedLayersRef.current) {
                const layerId = `${LAYER_PREFIX}${chartFile}`;
                const sourceId = `${SOURCE_PREFIX}${chartFile}`;
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            }
            addedLayersRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fly to chart bounds — or fall back to the user's current location
    // when bounds are missing from the MBTiles metadata.
    const flyToChart = useCallback(
        (chart: OpenChart) => {
            const map = mapRef.current;
            if (!map) return;
            if (chart.metadata.bounds) {
                const [west, south, east, north] = chart.metadata.bounds;
                map.fitBounds(
                    [
                        [west, south],
                        [east, north],
                    ],
                    { padding: 40, duration: 1500 },
                );
                return;
            }
            const loc = LocationStore.getState();
            const fallbackZoom = Math.min(Math.max((chart.metadata.maxzoom ?? 14) - 4, 6), 12);
            map.flyTo({
                center: [loc.lon, loc.lat],
                zoom: fallbackZoom,
                duration: 1500,
            });
        },
        [mapRef],
    );

    return {
        availableCharts,
        loading,
        flyToChart,
        refreshAvailable,
    };
}
