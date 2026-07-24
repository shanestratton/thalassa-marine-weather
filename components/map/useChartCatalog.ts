/**
 * useChartCatalog — Map hook for rendering free nautical chart tile overlays.
 *
 * Manages adding/removing raster tile layers from the Chart Catalog
 * (NOAA NCDS, NOAA ECDIS, LINZ) onto the Mapbox map.
 *
 * Layers are inserted below sea marks and above the satellite base
 * (same z-ordering as AvNav charts).
 */
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useCallback,
    useMemo,
    useState,
    useSyncExternalStore,
    type MutableRefObject,
} from 'react';
import mapboxgl from 'mapbox-gl';
import { ChartCatalogService, type ChartSource, type ChartSourceId } from '../../services/ChartCatalogService';
import { LocationStore } from '../../stores/LocationStore';
import { createLogger } from '../../utils/createLogger';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

const log = createLogger('ChartCatalog-Map');

const SOURCE_PREFIX = 'chart-catalog-';
const LAYER_PREFIX = 'chart-catalog-layer-';

const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

interface ScopedSources {
    scope: AuthIdentityScope;
    sources: ChartSource[];
}

export function useChartCatalog(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible = true) {
    const identityScope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const hydratedSources = useMemo(() => {
        ChartCatalogService.initialize(identityScope);
        return ChartCatalogService.getSources(identityScope);
    }, [identityScope]);
    const [storedSources, setStoredSources] = useState<ScopedSources>(() => ({
        scope: identityScope,
        sources: hydratedSources,
    }));
    const sources = sameScope(storedSources.scope, identityScope) ? storedSources.sources : hydratedSources;
    const addedLayersRef = useRef<Set<string>>(new Set());
    const sourceUrlsRef = useRef<Map<string, string>>(new Map());

    useLayoutEffect(() => {
        setStoredSources((current) =>
            sameScope(current.scope, identityScope)
                ? current
                : {
                      scope: identityScope,
                      sources: hydratedSources,
                  },
        );
    }, [hydratedSources, identityScope]);

    // Subscribe to current-account catalog changes.
    useEffect(() => {
        const scope = identityScope;
        ChartCatalogService.initialize(scope);

        const unsub = ChartCatalogService.onChange((newSources) => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoredSources({ scope, sources: [...newSources] });
        });

        return unsub;
    }, [identityScope]);

    // Mapbox retains raster source URLs independently of React. Remove the
    // old account's sources synchronously at the identity fence so a source
    // with the same logical id cannot keep account A's key in account B.
    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                const map = mapRef.current;
                if (!map) {
                    addedLayersRef.current.clear();
                    sourceUrlsRef.current.clear();
                    return;
                }
                for (const id of addedLayersRef.current) {
                    const layerId = `${LAYER_PREFIX}${id}`;
                    const sourceId = `${SOURCE_PREFIX}${id}`;
                    if (map.getLayer(layerId)) map.removeLayer(layerId);
                    if (map.getSource(sourceId)) map.removeSource(sourceId);
                }
                addedLayersRef.current.clear();
                sourceUrlsRef.current.clear();
            }),
        [mapRef],
    );

    // Sync enabled chart layers with the map
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const enabledIds = new Set(sources.filter((s) => visible && s.enabled && s.tileUrl).map((s) => s.id));

        // Add new layers
        for (const src of sources) {
            const sourceId = `${SOURCE_PREFIX}${src.id}`;
            const layerId = `${LAYER_PREFIX}${src.id}`;

            if (visible && src.enabled && src.tileUrl) {
                // Mapbox sources are immutable. A key rotation changes the
                // tile URL, so remove the old source before adding its safe
                // replacement.
                if (map.getSource(sourceId) && sourceUrlsRef.current.get(src.id) !== src.tileUrl) {
                    if (map.getLayer(layerId)) map.removeLayer(layerId);
                    map.removeSource(sourceId);
                    addedLayersRef.current.delete(src.id);
                    sourceUrlsRef.current.delete(src.id);
                }
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
                                'raster-opacity': src.opacity,
                                'raster-fade-duration': 0,
                                'raster-resampling': 'nearest',
                            },
                        },
                        beforeLayer,
                    );

                    addedLayersRef.current.add(src.id);
                    sourceUrlsRef.current.set(src.id, src.tileUrl);
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
                sourceUrlsRef.current.delete(src.id);
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
                sourceUrlsRef.current.delete(id);
            }
        }
    }, [mapRef, mapReady, sources, visible]);

    // Cleanup on unmount
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        const addedLayers = addedLayersRef.current;
        const sourceUrls = sourceUrlsRef.current;
        return () => {
            if (!map) return;
            for (const id of addedLayers) {
                const layerId = `${LAYER_PREFIX}${id}`;
                const sourceId = `${SOURCE_PREFIX}${id}`;
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            }
            addedLayers.clear();
            sourceUrls.clear();
        };
    }, [mapRef, mapReady]);

    // Fly to a chart's coverage area — or fall back to the user's current
    // location when bounds are missing.
    const flyToSource = useCallback(
        (src: ChartSource) => {
            const map = mapRef.current;
            if (!map) return;
            if (src.bounds) {
                map.fitBounds(
                    [
                        [src.bounds[0], src.bounds[1]],
                        [src.bounds[2], src.bounds[3]],
                    ],
                    { padding: 40, duration: 1500 },
                );
                return;
            }
            const loc = LocationStore.getState();
            const fallbackZoom = Math.min(Math.max((src.maxZoom ?? 14) - 4, 6), 12);
            map.flyTo({
                center: [loc.lon, loc.lat],
                zoom: fallbackZoom,
                duration: 1500,
            });
        },
        [mapRef],
    );

    // Toggle a source
    const toggleSource = useCallback(
        (id: ChartSourceId) => {
            ChartCatalogService.toggleSource(id, identityScope);
        },
        [identityScope],
    );

    // Disable every source — used by the single-select chart picker.
    const disableAll = useCallback(() => {
        ChartCatalogService.disableAll(identityScope);
    }, [identityScope]);

    // Set opacity
    const setOpacity = useCallback(
        (id: ChartSourceId, opacity: number) => {
            ChartCatalogService.setOpacity(id, opacity, identityScope);
        },
        [identityScope],
    );

    // Update LINZ key
    const updateLinzKey = useCallback(
        (key: string) => {
            ChartCatalogService.updateLinzKey(key, identityScope);
        },
        [identityScope],
    );

    const hasEnabledCharts = visible && sources.some((s) => s.enabled && s.tileUrl);

    return {
        sources,
        hasEnabledCharts,
        toggleSource,
        disableAll,
        setOpacity,
        flyToSource,
        updateLinzKey,
    };
}
