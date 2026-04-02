/**
 * useSignalKCharts — Map hook for rendering Signal K chart tile layers.
 *
 * Listens for chart availability from SignalKService and adds/removes
 * raster tile sources + layers on the Mapbox map. Charts render below
 * sea marks and above the satellite base with configurable opacity.
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { SignalKService, type SignalKChart } from '../../services/SignalKService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SK-Charts');

const SK_SOURCE_PREFIX = 'sk-chart-';
const SK_LAYER_PREFIX = 'sk-chart-layer-';

export function useSignalKCharts(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabledChartIds: Set<string>,
    opacity: number,
) {
    const [availableCharts, setAvailableCharts] = useState<SignalKChart[]>([]);
    const [connectionStatus, setConnectionStatus] = useState(SignalKService.getStatus());
    const addedLayersRef = useRef<Set<string>>(new Set());

    // Subscribe to chart + status changes
    useEffect(() => {
        const unsubCharts = SignalKService.onChartsChange((charts) => {
            setAvailableCharts(charts);
        });
        const unsubStatus = SignalKService.onStatusChange((status) => {
            setConnectionStatus(status);
        });

        // Load current state
        setAvailableCharts(SignalKService.getCharts());
        setConnectionStatus(SignalKService.getStatus());

        return () => {
            unsubCharts();
            unsubStatus();
        };
    }, []);

    // Add/remove chart layers when enabledChartIds or available charts change
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const currentLayerIds = new Set(addedLayersRef.current);

        // Add new chart layers
        for (const chart of availableCharts) {
            const sourceId = `${SK_SOURCE_PREFIX}${chart.id}`;
            const layerId = `${SK_LAYER_PREFIX}${chart.id}`;

            if (enabledChartIds.has(chart.id)) {
                // Should be visible
                if (!map.getSource(sourceId)) {
                    // Add source
                    map.addSource(sourceId, {
                        type: 'raster',
                        tiles: [chart.tilesUrl],
                        tileSize: 256,
                        minzoom: chart.minZoom,
                        maxzoom: chart.maxZoom,
                        ...(chart.bounds ? { bounds: chart.bounds } : {}),
                    });

                    // Add layer — insert below 'sea-marks' if it exists,
                    // otherwise before the first symbol layer
                    let beforeLayer: string | undefined;
                    if (map.getLayer('sea-marks-tiles')) {
                        beforeLayer = 'sea-marks-tiles';
                    } else {
                        // Find first symbol layer to insert before
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
                                'raster-fade-duration': 300,
                            },
                        },
                        beforeLayer,
                    );

                    addedLayersRef.current.add(chart.id);
                    log.info(`Added chart layer: ${chart.name}`);
                } else {
                    // Already exists — update opacity
                    if (map.getLayer(layerId)) {
                        map.setPaintProperty(layerId, 'raster-opacity', opacity);
                    }
                }
                currentLayerIds.delete(chart.id);
            } else {
                // Should NOT be visible — remove if it exists
                if (map.getLayer(layerId)) {
                    map.removeLayer(layerId);
                    log.info(`Removed chart layer: ${chart.name}`);
                }
                if (map.getSource(sourceId)) {
                    map.removeSource(sourceId);
                }
                addedLayersRef.current.delete(chart.id);
                currentLayerIds.delete(chart.id);
            }
        }

        // Remove orphaned layers (charts that are no longer available)
        for (const orphanId of currentLayerIds) {
            const layerId = `${SK_LAYER_PREFIX}${orphanId}`;
            const sourceId = `${SK_SOURCE_PREFIX}${orphanId}`;
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
            addedLayersRef.current.delete(orphanId);
        }
    }, [mapRef, mapReady, availableCharts, enabledChartIds, opacity]);

    // Update opacity on all active chart layers when it changes
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        for (const chartId of addedLayersRef.current) {
            const layerId = `${SK_LAYER_PREFIX}${chartId}`;
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
            for (const chartId of addedLayersRef.current) {
                const layerId = `${SK_LAYER_PREFIX}${chartId}`;
                const sourceId = `${SK_SOURCE_PREFIX}${chartId}`;
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            }
            addedLayersRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fly to chart bounds
    const flyToChart = useCallback(
        (chart: SignalKChart) => {
            const map = mapRef.current;
            if (!map || !chart.bounds) return;
            map.fitBounds(
                [
                    [chart.bounds[0], chart.bounds[1]],
                    [chart.bounds[2], chart.bounds[3]],
                ],
                { padding: 40, duration: 1500 },
            );
        },
        [mapRef],
    );

    return {
        availableCharts,
        connectionStatus,
        flyToChart,
    };
}
