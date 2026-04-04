/**
 * useSeamarkLayer — Interactive sea mark overlay for Mapbox GL.
 *
 * Modes:
 *  - Full:         Renders IALA icons + click-to-identify popups (free basemap)
 *  - Identify-only: Invisible hit targets + popups (when o-charts render icons natively)
 *
 * Loads OpenSeaMap seamark data via the SeamarkService Overpass API client,
 * renders them as a vector layer with proper IALA icons, and handles
 * click-to-identify popups with nautical feature details.
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createRoot, type Root } from 'react-dom/client';
import { SeamarkService, type SeamarkCollection } from '../../services/SeamarkService';
import { registerSeamarkIcons, resolveSeamarkIcon } from './seamarkIcons';
import { SeamarkPopup } from './SeamarkPopup';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SeamarkLayer');

const SOURCE_ID = 'seamark-data';
const LAYER_SYMBOLS = 'seamark-symbols';
const LAYER_HITAREA = 'seamark-hitarea';
const LAYER_ALWAYS_VISIBLE = 'seamark-always-visible'; // anchorages, moorings, harbours — shown even with o-charts
const MIN_ZOOM = 10;

/** Seamark types that should remain visible even when o-charts provide native icons */
const ALWAYS_VISIBLE_TYPES = ['anchorage', 'anchor_berth', 'mooring', 'harbour'];

export type SeamarkMode = 'full' | 'identify';

export function useSeamarkLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    /** 'full' renders icons; 'identify' loads data + invisible click targets only */
    mode: SeamarkMode = 'full',
) {
    const [featureCount, setFeatureCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const iconsRegistered = useRef(false);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const popupRootRef = useRef<Root | null>(null);
    const moveEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // The layer we attach click events to depends on mode
    const activeLayerId = mode === 'full' ? LAYER_SYMBOLS : LAYER_HITAREA;

    // Register IALA icons once (needed even in identify mode for potential switch)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || iconsRegistered.current) return;

        registerSeamarkIcons(map).then(() => {
            iconsRegistered.current = true;
            log.info('IALA icons registered');
        });
    }, [mapRef, mapReady]);

    // Add/remove source + layers based on visibility + mode
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (visible) {
            // Add source if missing
            if (!map.getSource(SOURCE_ID)) {
                map.addSource(SOURCE_ID, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
            }

            if (mode === 'full') {
                // ── Full mode: visible IALA icon symbols ──
                // Remove identify-mode layers if they exist from previous mode
                if (map.getLayer(LAYER_HITAREA)) map.removeLayer(LAYER_HITAREA);
                if (map.getLayer(LAYER_ALWAYS_VISIBLE)) map.removeLayer(LAYER_ALWAYS_VISIBLE);

                if (!map.getLayer(LAYER_SYMBOLS)) {
                    map.addLayer({
                        id: LAYER_SYMBOLS,
                        type: 'symbol',
                        source: SOURCE_ID,
                        minzoom: MIN_ZOOM,
                        layout: {
                            'icon-image': ['get', 'icon'],
                            'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.65, 18, 0.9],
                            'icon-allow-overlap': true,
                            'icon-ignore-placement': false,
                            'icon-padding': 2,
                            'symbol-sort-key': ['get', 'priority'],
                        },
                        paint: {
                            'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 13, 0.9, 16, 1.0],
                        },
                    });
                }
            } else {
                // ── Identify mode: invisible circle hit targets + visible anchorages ──
                // Remove full-mode symbol layer if it exists from previous mode
                if (map.getLayer(LAYER_SYMBOLS)) map.removeLayer(LAYER_SYMBOLS);

                // Invisible hit targets for ALL features (click-to-identify)
                if (!map.getLayer(LAYER_HITAREA)) {
                    map.addLayer({
                        id: LAYER_HITAREA,
                        type: 'circle',
                        source: SOURCE_ID,
                        minzoom: MIN_ZOOM,
                        paint: {
                            // Invisible but generous touch target
                            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 16, 18, 20],
                            'circle-color': 'transparent',
                            'circle-opacity': 0,
                            // Invisible stroke — but still clickable
                            'circle-stroke-width': 0,
                            'circle-stroke-opacity': 0,
                        },
                    });
                }

                // Visible icons for anchorages, moorings, harbours
                // O-charts typically don't render these or render them poorly
                if (!map.getLayer(LAYER_ALWAYS_VISIBLE)) {
                    map.addLayer({
                        id: LAYER_ALWAYS_VISIBLE,
                        type: 'symbol',
                        source: SOURCE_ID,
                        minzoom: MIN_ZOOM,
                        filter: ['in', ['get', 'seamarkType'], ['literal', ALWAYS_VISIBLE_TYPES]],
                        layout: {
                            'icon-image': ['get', 'icon'],
                            'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 14, 0.7, 18, 1.0],
                            'icon-allow-overlap': true,
                            'icon-ignore-placement': false,
                            'icon-padding': 2,
                        },
                        paint: {
                            'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 13, 0.9, 16, 1.0],
                        },
                    });
                }
            }

            // Initial load for current viewport
            loadCurrentViewport(map);
        } else {
            // Remove popup
            closePopup();
            // Remove all layers + source
            if (map.getLayer(LAYER_SYMBOLS)) map.removeLayer(LAYER_SYMBOLS);
            if (map.getLayer(LAYER_HITAREA)) map.removeLayer(LAYER_HITAREA);
            if (map.getLayer(LAYER_ALWAYS_VISIBLE)) map.removeLayer(LAYER_ALWAYS_VISIBLE);
            if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible, mode]);

    // Listen for map moveend to load new seamarks
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) return;

        const onMoveEnd = () => {
            if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
            moveEndTimer.current = setTimeout(() => loadCurrentViewport(map), 500);
        };

        map.on('moveend', onMoveEnd);
        return () => {
            map.off('moveend', onMoveEnd);
            if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible]);

    // Subscribe to SeamarkService updates
    useEffect(() => {
        if (!visible) return;

        const unsub = SeamarkService.onUpdate((data) => {
            updateMapSource(data);
        });

        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // Click handler for feature identification
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) return;

        // Determine which layers to attach click events to
        const clickLayers: string[] = [];
        if (map.getLayer(activeLayerId)) clickLayers.push(activeLayerId);
        if (mode === 'identify' && map.getLayer(LAYER_ALWAYS_VISIBLE)) {
            clickLayers.push(LAYER_ALWAYS_VISIBLE);
        }
        if (clickLayers.length === 0) return;

        const onClick = (e: mapboxgl.MapMouseEvent) => {
            const features = map.queryRenderedFeatures(e.point, { layers: clickLayers });
            if (!features || features.length === 0) return;

            const feature = features[0];
            const props = feature.properties;
            if (!props) return;

            // Parse tags (they're serialized as JSON string from GeoJSON properties)
            let tags: Record<string, string> = {};
            try {
                tags = typeof props.tags === 'string' ? JSON.parse(props.tags) : props.tags || {};
            } catch {
                /* ignore */
            }

            // Close existing popup
            closePopup();

            // Create popup
            const container = document.createElement('div');
            container.style.minWidth = '220px';
            const root = createRoot(container);
            popupRootRef.current = root;

            root.render(
                SeamarkPopup({
                    seamarkType: props.seamarkType || 'unknown',
                    name: props.name || '',
                    tags,
                    coordinates: (feature.geometry as GeoJSON.Point).coordinates as [number, number],
                }),
            );

            const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
            const popup = new mapboxgl.Popup({
                closeButton: true,
                closeOnClick: true,
                className: 'seamark-popup',
                maxWidth: '300px',
                offset: 12,
            })
                .setLngLat(coords)
                .setDOMContent(container)
                .addTo(map);

            popupRef.current = popup;
            popup.on('close', () => {
                if (popupRootRef.current) {
                    popupRootRef.current.unmount();
                    popupRootRef.current = null;
                }
                popupRef.current = null;
            });
        };

        // Attach to all click layers
        for (const layerId of clickLayers) {
            map.on('click', layerId, onClick);
        }

        // Cursor styling
        const onEnter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const onLeave = () => {
            map.getCanvas().style.cursor = '';
        };
        for (const layerId of clickLayers) {
            map.on('mouseenter', layerId, onEnter);
            map.on('mouseleave', layerId, onLeave);
        }

        return () => {
            for (const layerId of clickLayers) {
                map.off('click', layerId, onClick);
                map.off('mouseenter', layerId, onEnter);
                map.off('mouseleave', layerId, onLeave);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible, activeLayerId, mode]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            closePopup();
            const map = mapRef.current;
            if (!map) return;
            if (map.getLayer(LAYER_SYMBOLS)) map.removeLayer(LAYER_SYMBOLS);
            if (map.getLayer(LAYER_HITAREA)) map.removeLayer(LAYER_HITAREA);
            if (map.getLayer(LAYER_ALWAYS_VISIBLE)) map.removeLayer(LAYER_ALWAYS_VISIBLE);
            if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Helpers ──────────────────────────────────────────────────────────

    const loadCurrentViewport = useCallback(async (map: mapboxgl.Map) => {
        const zoom = map.getZoom();
        if (zoom < MIN_ZOOM) return;

        const bounds = map.getBounds();
        if (!bounds) return;

        setLoading(true);
        await SeamarkService.loadViewport(
            {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest(),
            },
            zoom,
        );
        setLoading(false);
    }, []);

    const updateMapSource = useCallback(
        (data: SeamarkCollection) => {
            const map = mapRef.current;
            if (!map) return;

            const source = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
            if (!source) return;

            // Enrich features with icon + priority
            const enriched = {
                type: 'FeatureCollection' as const,
                features: data.features.map((f) => ({
                    ...f,
                    properties: {
                        ...f.properties,
                        icon: resolveSeamarkIcon(f.properties.seamarkType, f.properties.tags),
                        priority: getSeamarkPriority(f.properties.seamarkType),
                    },
                })),
            };

            source.setData(enriched);
            setFeatureCount(enriched.features.length);
        },
        [mapRef],
    );

    const closePopup = useCallback(() => {
        if (popupRef.current) {
            popupRef.current.remove();
            popupRef.current = null;
        }
        if (popupRootRef.current) {
            popupRootRef.current.unmount();
            popupRootRef.current = null;
        }
    }, []);

    return { featureCount, loading, mode };
}

/** Priority for symbol-sort-key (lower = drawn on top) */
function getSeamarkPriority(type: string): number {
    if (type === 'light_major') return 1;
    if (type === 'buoy_isolated_danger') return 2;
    if (type.startsWith('buoy_cardinal')) return 3;
    if (type === 'buoy_safe_water') return 4;
    if (type.startsWith('buoy_')) return 5;
    if (type.startsWith('beacon_')) return 6;
    if (type === 'light_minor' || type === 'light') return 7;
    if (type === 'anchorage') return 8;
    return 10;
}
