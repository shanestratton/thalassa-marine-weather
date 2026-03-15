/**
 * useMapInit — Map initialisation hook.
 *
 * Creates the Mapbox GL instance, adds base layers (GEBCO bathymetry,
 * OpenSeaMap, route/isochrone/waypoint sources, coastline overlays,
 * nav markers), and wires up long-press/right-click pin drop + resize.
 */

import { useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useMapInit');
import mapboxgl from 'mapbox-gl';
import { LocationStore } from '../../stores/LocationStore';
import { triggerHaptic } from '../../utils/system';
import { GpsService } from '../../services/GpsService';

interface UseMapInitOptions {
    containerRef: MutableRefObject<HTMLDivElement | null>;
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    pinMarkerRef: MutableRefObject<mapboxgl.Marker | null>;
    locationDotRef: MutableRefObject<mapboxgl.Marker | null>;
    mapboxToken?: string;
    mapStyle: string;
    initialZoom: number;
    minimalLabels: boolean;
    embedded: boolean;
    center?: { lat: number; lon: number };
    location: { lat: number; lon: number };
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
    pickerMode?: boolean;
    settingPoint: 'departure' | 'arrival' | null;
    showPassage: boolean;
    departure: { lat: number; lon: number; name: string } | null;
    arrival: { lat: number; lon: number; name: string } | null;
    setMapReady: (ready: boolean) => void;
    setActiveLayer: (layer: any) => void;
    setDeparture: (v: { lat: number; lon: number; name: string } | null) => void;
    setArrival: (v: { lat: number; lon: number; name: string } | null) => void;
    setSettingPoint: (v: 'departure' | 'arrival' | null) => void;
    /** Called when the user taps a point on the map (for weather inspect popup) */
    onMapTap?: (lat: number, lon: number) => void;
}

/**
 * Initialises the Mapbox map and manages its lifecycle.
 * Returns the `dropPin` callback for imperative pin drops.
 */
export function useMapInit(opts: UseMapInitOptions) {
    const {
        containerRef,
        mapRef,
        pinMarkerRef,
        locationDotRef,
        mapboxToken,
        mapStyle,
        initialZoom,
        minimalLabels,
        embedded,
        center,
        location,
        onLocationSelect,
        pickerMode,
        settingPoint,
        showPassage,
        departure,
        arrival,
        setMapReady,
        setActiveLayer,
        setDeparture,
        setArrival,
        setSettingPoint,
        onMapTap,
    } = opts;

    const longPressTimer = useRef<NodeJS.Timeout | null>(null);

    // ── Pin Drop Logic ──
    const dropPin = useCallback(
        (map: mapboxgl.Map, lat: number, lon: number) => {
            triggerHaptic('heavy');

            if (pinMarkerRef.current) {
                pinMarkerRef.current.remove();
            }

            const el = document.createElement('div');
            el.className = 'mapbox-pin-marker';
            el.innerHTML = `
            <div style="
                width: 24px; height: 24px; background: #38bdf8;
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg); box-shadow: 0 4px 12px rgba(56,189,248,0.4);
                animation: pinBounce 0.4s ease-out;
            "></div>
        `;

            const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);

            pinMarkerRef.current = marker;

            // If setting a departure or arrival point for passage
            if (settingPoint) {
                const fallbackName = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
                // Set immediately with fallback coords name, then upgrade with reverse geocode
                const setter = settingPoint === 'departure' ? setDeparture : setArrival;
                setter({ lat, lon, name: fallbackName });
                setSettingPoint(null);
                LocationStore.setFromMapPin(lat, lon);
                // Async: reverse geocode for a proper place name
                import('../../services/weatherService')
                    .then(({ reverseGeocode }) =>
                        reverseGeocode(lat, lon).then((name) => {
                            if (name) setter({ lat, lon, name });
                        }),
                    )
                    .catch(() => {
                        /* keep fallback name */
                    });
                return;
            }

            // If passage planner is open, auto-fill the first empty field
            if (showPassage) {
                const fallbackName = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
                const setter = !departure ? setDeparture : setArrival;
                setter({ lat, lon, name: fallbackName });
                LocationStore.setFromMapPin(lat, lon);
                // Async: reverse geocode for a proper place name
                import('../../services/weatherService')
                    .then(({ reverseGeocode }) =>
                        reverseGeocode(lat, lon).then((name) => {
                            if (name) setter({ lat, lon, name });
                        }),
                    )
                    .catch(() => {
                        /* keep fallback name */
                    });
                return;
            }

            // Default: Update global LocationStore + navigate to WX
            LocationStore.setFromMapPin(lat, lon);
            onLocationSelect?.(lat, lon);
        },
        [
            settingPoint,
            showPassage,
            departure,
            arrival,
            onLocationSelect,
            pinMarkerRef,
            setDeparture,
            setArrival,
            setSettingPoint,
        ],
    );

    // ── Initialize Map ──
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;
        if (!mapboxToken) return;

        mapboxgl.accessToken = mapboxToken;

        // ── Windy-style: world fills screen, no duplicates, free panning ──
        const map = new mapboxgl.Map({
            container: containerRef.current,
            style: mapStyle,
            center: center ? [center.lon, center.lat] : [location.lon, location.lat],
            zoom: initialZoom,
            attributionControl: false,
            maxZoom: 18,
            minZoom: embedded ? initialZoom : 1,
            renderWorldCopies: true,
            projection: 'mercator' as any,
            interactive: true,
            dragPan: true,
            scrollZoom: true,
            dragRotate: false,
        });

        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();

        // Measure actual world width via map.project(), set minZoom so
        // one world copy fills the container. No tile-size guessing.
        const calcFillMinZoom = () => {
            if (embedded || !containerRef.current) return;
            const cw = containerRef.current.clientWidth;
            const z = map.getZoom();
            const worldPx = map.project([180, 0]).x - map.project([-180, 0]).x;
            const target = z + Math.log2(cw / worldPx);
            map.setMinZoom(Math.max(target, 0.5));
        };
        map.once('idle', calcFillMinZoom);

        map.on('load', () => {
            const style = map.getStyle();
            if (style?.layers) {
                for (const layer of style.layers) {
                    if (
                        minimalLabels &&
                        layer.type === 'symbol' &&
                        layer.id.match(/country-label|state-label|continent-label|place-label|settlement/)
                    ) {
                        map.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                    if (layer.type === 'symbol' && layer.id.match(/road|motorway|highway|shield|trunk/i)) {
                        map.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                    // Boost place labels so they're readable under wind particles
                    if (
                        layer.type === 'symbol' &&
                        layer.id.match(/country-label|state-label|continent-label|place-label|settlement|water-point/)
                    ) {
                        map.setPaintProperty(layer.id, 'text-color', '#ffffff');
                        map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(0, 0, 0, 0.9)');
                        map.setPaintProperty(layer.id, 'text-halo-width', 2);
                    }
                }
            }

            setMapReady(true);

            // ── Coastline outline — always on top of weather layers ──
            // Uses the built-in 'water' source-layer from the composite vector tileset
            // to draw a thin white line at land/sea boundaries. This ensures geographic
            // context is never lost under heavy rain/cloud overlays.
            if (!map.getLayer('coastline-outline')) {
                map.addLayer({
                    id: 'coastline-outline',
                    type: 'line',
                    source: 'composite',
                    'source-layer': 'water',
                    paint: {
                        'line-color': 'rgba(255, 255, 255, 0.45)',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 5, 0.8, 8, 1.2, 12, 1.5],
                    },
                });
            }

            const styleLayers = map.getStyle()?.layers || [];
            let firstSymbolId: string | undefined;
            for (const l of styleLayers) {
                if (l.type === 'symbol') {
                    firstSymbolId = l.id;
                    break;
                }
            }

            // GEBCO Bathymetry removed — WMS service now returns 'Zoom Level Not Supported'
            // tiles at most useful zoom levels. Mapbox dark-v11 base style provides ocean styling.

            // ── OpenSeaMap overlay ──
            if (!map.getSource('openseamap-permanent')) {
                map.addSource('openseamap-permanent', {
                    type: 'raster',
                    tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    maxzoom: 18,
                });
                map.addLayer(
                    {
                        id: 'openseamap-permanent',
                        type: 'raster',
                        source: 'openseamap-permanent',
                        minzoom: 6,
                        maxzoom: 18,
                        paint: { 'raster-opacity': 0.85 },
                    },
                    firstSymbolId,
                );
            }

            // ── Skip heavy sources in embedded mode ──
            if (embedded) {
                setMapReady(true);
                return;
            }

            // ── Route line source + layers ──
            map.addSource('route-line', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'safety'],
                        'safe',
                        '#00e676',
                        'caution',
                        '#ff9100',
                        'danger',
                        '#ff1744',
                        'harbour',
                        '#38bdf8',
                        '#00f2fe',
                    ],
                    'line-width': 12,
                    'line-blur': 10,
                    'line-opacity': ['match', ['get', 'safety'], 'harbour', 0.3, 0.6],
                },
                filter: ['!=', ['get', 'dashed'], true],
            });

            map.addLayer({
                id: 'route-line-layer',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'safety'],
                        'safe',
                        '#00e676',
                        'caution',
                        '#ff9100',
                        'danger',
                        '#ff1744',
                        'harbour',
                        '#38bdf8',
                        '#00f2fe',
                    ],
                    'line-width': 3,
                    'line-opacity': 0.9,
                },
                filter: ['!=', ['get', 'dashed'], true],
            });

            map.addLayer({
                id: 'route-harbour-dash',
                type: 'line',
                source: 'route-line',
                filter: ['==', ['get', 'dashed'], true],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#38bdf8',
                    'line-width': 2,
                    'line-opacity': 0.6,
                    'line-dasharray': [4, 4],
                },
            });

            map.addLayer({
                id: 'route-core',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'safety'],
                        'safe',
                        '#b9f6ca',
                        'caution',
                        '#ffe0b2',
                        'danger',
                        '#ffcdd2',
                        'harbour',
                        '#bae6fd',
                        '#ffffff',
                    ],
                    'line-width': 1.5,
                },
            });

            // ── Harbour Seamarks (IALA Navigation Aids) ──
            map.addSource('harbour-seamarks', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            // Seamark circle markers — colour-coded by IALA classification
            map.addLayer({
                id: 'harbour-seamarks-circle',
                type: 'circle',
                source: 'harbour-seamarks',
                paint: {
                    'circle-radius': ['match', ['get', '_class'], 'light_major', 6, 'safe_water', 5, 4],
                    'circle-color': [
                        'match',
                        ['get', '_class'],
                        'port',
                        '#ef4444', // Red — port lateral
                        'starboard',
                        '#22c55e', // Green — starboard lateral
                        'cardinal_n',
                        '#facc15', // Yellow — cardinal
                        'cardinal_s',
                        '#facc15',
                        'cardinal_e',
                        '#facc15',
                        'cardinal_w',
                        '#facc15',
                        'cardinal',
                        '#facc15',
                        'safe_water',
                        '#ffffff', // White — safe water
                        'danger',
                        '#f97316', // Orange — danger
                        'light_major',
                        '#fbbf24', // Amber — major light
                        'light_minor',
                        '#fde68a', // Light amber — minor light
                        'fairway',
                        '#38bdf8', // Sky blue — fairway
                        '#94a3b8', // Grey — other
                    ],
                    'circle-stroke-width': 1.5,
                    'circle-stroke-color': 'rgba(0,0,0,0.6)',
                    'circle-opacity': 0.9,
                },
            });

            // Seamark labels (visible at higher zoom)
            map.addLayer({
                id: 'harbour-seamarks-label',
                type: 'symbol',
                source: 'harbour-seamarks',
                minzoom: 14,
                layout: {
                    'text-field': ['coalesce', ['get', 'name'], ['get', '_type']],
                    'text-size': 10,
                    'text-offset': [0, 1.2],
                    'text-anchor': 'top',
                    'text-font': ['Open Sans Bold'],
                },
                paint: {
                    'text-color': '#e2e8f0',
                    'text-halo-color': 'rgba(0,0,0,0.8)',
                    'text-halo-width': 1,
                },
            });

            // ── Confidence Braid: Multi-Model Route Comparison ──
            // GFS route (cyan) — visible only when models diverge
            map.addSource('confidence-route-gfs', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            map.addLayer({
                id: 'confidence-gfs-glow',
                type: 'line',
                source: 'confidence-route-gfs',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#22d3ee', 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.5 },
            });
            map.addLayer({
                id: 'confidence-gfs-core',
                type: 'line',
                source: 'confidence-route-gfs',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-opacity': 0.9 },
            });

            // ECMWF route (magenta) — visible only when models diverge
            map.addSource('confidence-route-ecmwf', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            map.addLayer({
                id: 'confidence-ecmwf-glow',
                type: 'line',
                source: 'confidence-route-ecmwf',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#e879f9', 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.5 },
            });
            map.addLayer({
                id: 'confidence-ecmwf-core',
                type: 'line',
                source: 'confidence-route-ecmwf',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#e879f9', 'line-width': 2, 'line-opacity': 0.9 },
            });

            // ── Seamark Navigation Markers ──
            const seamarkBaseUrl =
                (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
                'https://pcisdplnodrphauixcau.supabase.co';
            const markersUrl = `${seamarkBaseUrl}/storage/v1/object/public/regions/australia_se_qld/nav_markers.geojson`;
            fetch(markersUrl)
                .then((r) => r.json())
                .then((geojson: any) => {
                    if (!map.getSource('nav-markers')) {
                        map.addSource('nav-markers', { type: 'geojson', data: geojson });

                        const markerColors = [
                            'match',
                            ['get', '_class'],
                            'port',
                            '#ff1744',
                            'starboard',
                            '#00e676',
                            'cardinal_n',
                            '#ffd600',
                            'cardinal_s',
                            '#ffd600',
                            'cardinal_e',
                            '#ffd600',
                            'cardinal_w',
                            '#ffd600',
                            'cardinal',
                            '#ffd600',
                            'danger',
                            '#ff6d00',
                            'safe_water',
                            '#ff1744',
                            'light',
                            '#ffffff',
                            'special',
                            '#ffab00',
                            'mooring',
                            '#40c4ff',
                            'anchorage',
                            '#40c4ff',
                            '#888888',
                        ] as any;

                        map.addLayer({
                            id: 'nav-markers-glow',
                            type: 'circle',
                            source: 'nav-markers',
                            minzoom: 10,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 10, 18, 20],
                                'circle-blur': 0.8,
                                'circle-opacity': 0.7,
                                'circle-color': markerColors,
                            },
                        });

                        map.addLayer({
                            id: 'nav-markers-dot',
                            type: 'circle',
                            source: 'nav-markers',
                            minzoom: 10,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 5, 18, 10],
                                'circle-color': markerColors,
                                'circle-stroke-width': 1,
                                'circle-stroke-color': '#000000',
                                'circle-stroke-opacity': 0.5,
                            },
                        });
                    }
                })
                .catch(() => {});

            // ── Isochrone source ──
            map.addSource('isochrones', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            map.addLayer({
                id: 'isochrone-fills',
                type: 'fill',
                source: 'isochrones',
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
            });
            map.addLayer({
                id: 'isochrone-lines',
                type: 'line',
                source: 'isochrones',
                paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.6 },
            });

            // ── Waypoint markers ──
            map.addSource('waypoints', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            map.addLayer({
                id: 'waypoint-circles',
                type: 'circle',
                source: 'waypoints',
                paint: {
                    'circle-radius': 8,
                    'circle-color': ['get', 'color'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                },
            });
            map.addLayer({
                id: 'waypoint-labels',
                type: 'symbol',
                source: 'waypoints',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-size': 11,
                    'text-offset': [0, 1.8],
                    'text-anchor': 'top',
                    'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                },
                paint: { 'text-color': '#ffffff', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
            });

            // ── GRIB bounds ──
            map.addSource('grib-bounds', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            map.addLayer({
                id: 'grib-bounds-fill',
                type: 'fill',
                source: 'grib-bounds',
                paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.08 },
            });
            map.addLayer({
                id: 'grib-bounds-line',
                type: 'line',
                source: 'grib-bounds',
                paint: { 'line-color': '#8b5cf6', 'line-width': 2, 'line-dasharray': [4, 4], 'line-opacity': 0.5 },
            });

            // ── Coastline overlays (brighter for visibility under weather layers) ──
            map.addLayer({
                id: 'coastline-stroke',
                type: 'line',
                source: 'composite',
                'source-layer': 'water',
                paint: {
                    'line-color': 'rgba(255, 255, 255, 0.55)',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 5, 0.8, 10, 1.2, 14, 1.5],
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 6, 0.8, 12, 0.9],
                },
            });

            map.addLayer({
                id: 'country-borders-overlay',
                type: 'line',
                source: 'composite',
                'source-layer': 'admin',
                filter: ['all', ['==', ['get', 'admin_level'], 0], ['==', ['get', 'maritime'], 0]],
                paint: {
                    'line-color': '#64748b',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.3, 5, 0.6, 10, 1.0],
                    'line-opacity': 0.5,
                    'line-dasharray': [6, 2],
                },
            });
        });

        // ── Long-Press Handler (pin drop) ──
        const handleTouchStart = (e: mapboxgl.MapTouchEvent) => {
            if (e.originalEvent.touches.length > 1) return;
            longPressTimer.current = setTimeout(() => {
                const { lng, lat } = e.lngLat;
                dropPin(map, lat, lng);
            }, 500);
        };

        const cancelLongPress = () => {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
            }
        };

        map.on('touchstart', handleTouchStart);
        map.on('touchend', cancelLongPress);
        map.on('touchmove', cancelLongPress);
        map.on('dragstart', cancelLongPress);

        map.on('contextmenu', (e) => {
            const { lng, lat } = e.lngLat;
            dropPin(map, lat, lng);
        });

        // ── Single-tap inspect handler ──
        // Fires onMapTap for weather popup if not in picker/passage/embedded mode.
        // Uses wasDragged to ignore tap-after-drag.
        let wasDragged = false;
        map.on('dragstart', () => {
            wasDragged = true;
        });
        map.on('click', (e) => {
            if (wasDragged) {
                wasDragged = false;
                return;
            }
            // Don't fire while long-press timer is still running (pin drop takes priority)
            if (longPressTimer.current) return;
            if (opts.pickerMode || opts.embedded) return;
            if (opts.settingPoint || opts.showPassage) return;
            opts.onMapTap?.(e.lngLat.lat, e.lngLat.lng);
        });
        map.on('moveend', () => {
            wasDragged = false;
        });

        mapRef.current = map;

        // Recenter listener
        const handleRecenter = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const lat = detail?.lat ?? center?.lat ?? location.lat;
            const lon = detail?.lon ?? center?.lon ?? location.lon;
            const zoom = detail?.zoom ?? initialZoom;
            map.flyTo({ center: [lon, lat], zoom, duration: 800 });
        };
        window.addEventListener('map-recenter', handleRecenter);

        // ResizeObserver — recalculate fill-width minZoom on resize
        const resizeObserver = new ResizeObserver(() => {
            map.resize();
            calcFillMinZoom();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            window.removeEventListener('map-recenter', handleRecenter);
            resizeObserver.disconnect();
            cancelLongPress();
            map.remove();
            mapRef.current = null;
        };
    }, [mapboxToken, mapStyle, initialZoom, minimalLabels]);

    return { dropPin };
}

/**
 * useLocationDot — Pulsing blue "You Are Here" GPS marker.
 */
export function useLocationDot(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    locationDotRef: MutableRefObject<mapboxgl.Marker | null>,
    mapReady: boolean,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const unsub = GpsService.watchPosition((pos) => {
            const { latitude, longitude } = pos;
            if (!locationDotRef.current) {
                const el = document.createElement('div');
                el.className = 'loc-dot';
                locationDotRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
            } else {
                locationDotRef.current.setLngLat([longitude, latitude]);
            }
        });

        return () => {
            unsub();
            if (locationDotRef.current) {
                locationDotRef.current.remove();
                locationDotRef.current = null;
            }
        };
    }, [mapReady]);
}

/**
 * usePickerMode — Tap-to-select with reverse geocode in picker mode.
 */
export function usePickerMode(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    pinMarkerRef: MutableRefObject<mapboxgl.Marker | null>,
    pickerMode: boolean,
    onLocationSelect?: (lat: number, lon: number, name?: string) => void,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !pickerMode) return;

        const handleClick = async (e: mapboxgl.MapMouseEvent) => {
            const { lng, lat } = e.lngLat;
            triggerHaptic('medium');

            if (pinMarkerRef.current) pinMarkerRef.current.remove();
            const el = document.createElement('div');
            el.innerHTML = `<div style="
                width: 28px; height: 28px; background: #38bdf8;
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg); box-shadow: 0 4px 12px rgba(56,189,248,0.5);
                animation: pinBounce 0.3s ease-out;
            "></div>`;
            pinMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                .setLngLat([lng, lat])
                .addTo(map);

            try {
                const { reverseGeocode } = await import('../../services/weatherService');
                const name = await reverseGeocode(lat, lng);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
                onLocationSelect?.(lat, lng, name || fallback);
            } catch (e) {
                log.warn('[MapHub]', e);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
                onLocationSelect?.(lat, lng, fallback);
            }
        };

        map.on('click', handleClick);
        return () => {
            map.off('click', handleClick);
        };
    }, [pickerMode, onLocationSelect]);
}
