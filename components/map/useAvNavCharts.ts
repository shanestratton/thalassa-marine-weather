/**
 * useAvNavCharts — Map hook for rendering AvNav chart tile layers.
 *
 * Listens for chart availability from AvNavService and adds/removes
 * raster tile sources + layers on the Mapbox map. Charts render below
 * sea marks and above the satellite base with configurable opacity.
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { AvNavService, type AvNavChart } from '../../services/AvNavService';
import { LocationStore } from '../../stores/LocationStore';
import { createLogger } from '../../utils/createLogger';
import { Preferences } from '@capacitor/preferences';

let _chartLogSeq = 0;
async function chartLog(msg: string) {
    const val = `[CHART-${++_chartLogSeq}] ${msg}`;
    try {
        await Preferences.set({ key: 'CHART_LOG', value: val });
        await Preferences.get({ key: 'CHART_LOG' });
    } catch {
        /* ignore */
    }
}

const log = createLogger('AvNav-Charts');

const SK_SOURCE_PREFIX = 'avnav-chart-';
const SK_LAYER_PREFIX = 'avnav-chart-layer-';

export function useAvNavCharts(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabledChartIds: Set<string>,
    opacity: number,
) {
    const [availableCharts, setAvailableCharts] = useState<AvNavChart[]>([]);
    const [connectionStatus, setConnectionStatus] = useState(AvNavService.getStatus());
    const addedLayersRef = useRef<Set<string>>(new Set());

    // Subscribe to chart + status changes
    useEffect(() => {
        const unsubCharts = AvNavService.onChartsChange((charts) => {
            setAvailableCharts(charts);
        });
        const unsubStatus = AvNavService.onStatusChange((status) => {
            setConnectionStatus(status);
        });

        // Load current state
        setAvailableCharts(AvNavService.getCharts());
        setConnectionStatus(AvNavService.getStatus());

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
        chartLog(
            `sync: ${availableCharts.length} avail, ${enabledChartIds.size} enabled, mapReady=${mapReady} [${[...enabledChartIds].join(',')}]`,
        );
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
                    chartLog(
                        `Added source: ${sourceId}, tilesUrl=${chart.tilesUrl}, zoom=${chart.minZoom}-${chart.maxZoom}, bounds=${JSON.stringify(chart.bounds)}`,
                    );

                    // Add layer — insert below 'sea-marks' if it exists,
                    // otherwise before the first symbol layer
                    let beforeLayer: string | undefined;
                    if (map.getLayer('sea-marks-tiles')) {
                        beforeLayer = 'sea-marks-tiles';
                    } else if (map.isStyleLoaded()) {
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
                                'raster-fade-duration': 0,
                                'raster-resampling': 'nearest',
                            },
                        },
                        beforeLayer,
                    );

                    addedLayersRef.current.add(chart.id);
                    chartLog(`Added layer: ${chart.name} (id=${chart.id})`);
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

        // One-time error listener for debugging
        const mapWithFlag = map as mapboxgl.Map & { __chartErrorListening?: boolean };
        if (addedLayersRef.current.size > 0 && !mapWithFlag.__chartErrorListening) {
            mapWithFlag.__chartErrorListening = true;
            map.on('error', (e: mapboxgl.ErrorEvent) => {
                // Extract actual error info from Mapbox's cyclic event object
                const evt = e as mapboxgl.ErrorEvent & {
                    error?: { message?: string; url?: string };
                    source?: { url?: string };
                    message?: string;
                };
                const msg = evt?.error?.message || evt?.message || 'unknown';
                const url = evt?.error?.url || evt?.source?.url || '';
                if (url.includes(SK_SOURCE_PREFIX) || url.includes('192.168')) {
                    chartLog(`MAP ERROR: ${msg} | url=${url}`);
                }
            });
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

    // Fly to chart bounds — or fall back to the user's current location
    // when bounds are missing (common for o-charts DRM charts).
    const flyToChart = useCallback(
        (chart: AvNavChart) => {
            const map = mapRef.current;
            if (!map) return;
            if (chart.bounds) {
                map.fitBounds(
                    [
                        [chart.bounds[0], chart.bounds[1]],
                        [chart.bounds[2], chart.bounds[3]],
                    ],
                    { padding: 40, duration: 1500 },
                );
                return;
            }
            // No bounds — centre on the in-app location box at a chart-friendly
            // zoom so the user at least sees tiles render near where they are.
            const loc = LocationStore.getState();
            const fallbackZoom = Math.min(Math.max((chart.maxZoom ?? 14) - 4, 6), 12);
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
        connectionStatus,
        flyToChart,
    };
}
