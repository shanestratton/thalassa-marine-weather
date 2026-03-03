/**
 * MapHub — WebGL-powered map tab using Mapbox GL JS.
 *
 * Architecture pillars:
 *   1. Zero React overlay clutter — all data rendered as native map layers
 *   2. Long-press pin → LocationStore (global state)
 *   3. Weather tile layers: wind + rain (raster tiles, GPU-rendered)
 *   4. Passage planner: GeoJSON source layers for routes/isochrones
 *
 * Performance targets: 60fps pan/zoom on iPhone 16.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { generateIsobars, generateIsobarsFromGrid, FORECAST_HOURS } from '../../services/weather/isobars';
import { LocationStore, useLocationStore } from '../../stores/LocationStore';
import { WindStore, useWindStore } from '../../stores/WindStore';
import { WindParticleLayer } from './WindParticleLayer';
import { type WindGrid } from '../../services/weather/windField';
import { WindDataController } from '../../services/weather/WindDataController';
import { triggerHaptic } from '../../utils/system';
import {
    computeRoute,
    enhanceRouteWithDepth,
    formatDistance,
    formatDuration,
    formatETA,
    type RouteWaypoint,
    type RouteAnalysis,
} from '../../services/WeatherRoutingService';
import { SynopticScrubber } from './SynopticScrubber';
import { computeIsochrones, isochroneToGeoJSON, detectTurnWaypoints, type IsochroneResult, type TurnWaypoint } from '../../services/IsochroneRouter';
import { preloadBathymetry } from '../../services/BathymetryCache';
import { createWindFieldFromGrid } from '../../services/weather/WindFieldAdapter';
import { DEFAULT_CRUISING_POLAR, DEFAULT_MOTOR_POLAR } from '../../services/defaultPolar';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { findSeaBuoy } from '../../services/seaBuoyFinder';
import { exportPassageAsGPX } from '../../services/passageGpxExport';
import { shareGPXFile } from '../../services/gpxService';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';

// ── Types ──────────────────────────────────────────────────────

interface MapHubProps {
    mapboxToken?: string;
    homePort?: string;
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
    /** Override default zoom level (default: 8) */
    initialZoom?: number;
    /** Override map style URL (default: navigation-night-v1) */
    mapStyle?: string;
    /** Remove large country/place labels for a cleaner look */
    minimalLabels?: boolean;
    /** Embedded mode: no overlays, no interactions, static centered view */
    embedded?: boolean;
    /** Override center coordinates (for embedded mode) */
    center?: { lat: number; lon: number };
    /** Picker mode: single tap selects a location, reverse geocodes, and calls onLocationSelect */
    pickerMode?: boolean;
    /** Label shown in the picker banner (e.g. "Select Origin") */
    pickerLabel?: string;
}

type WeatherLayer = 'none' | 'rain' | 'wind' | 'temperature' | 'clouds' | 'pressure' | 'sea' | 'satellite' | 'velocity';

// ── Free tile sources (no API key required) ──
const STATIC_TILES: Record<string, string> = {
    sea: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    satellite: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
};


// Wind speed → monochrome color (matches GLSL palette in WindGLEngine)
function getWindColor(kts: number): string {
    if (kts < 5) return 'rgba(30, 35, 45, 0.85)';     // Calm - near-black
    if (kts < 10) return 'rgba(50, 55, 65, 0.85)';    // Light - dark slate
    if (kts < 15) return 'rgba(75, 78, 85, 0.85)';    // Gentle - mid slate
    if (kts < 20) return 'rgba(100, 103, 108, 0.85)';  // Moderate - grey
    if (kts < 25) return 'rgba(130, 130, 133, 0.85)';  // Fresh - light grey
    if (kts < 34) return 'rgba(140, 102, 76, 0.90)';   // Strong - muted amber
    if (kts < 48) return 'rgba(166, 76, 71, 0.90)';    // Gale - muted coral
    return 'rgba(178, 64, 76, 0.90)';                   // Storm+ - warm red
}

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({ mapboxToken, homePort, onLocationSelect, initialZoom = 6, mapStyle = 'mapbox://styles/mapbox/dark-v11', minimalLabels = false, embedded = false, center, pickerMode = false, pickerLabel }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const longPressTimer = useRef<NodeJS.Timeout | null>(null);
    const { settings } = useSettings();

    // Wind GL engine ref
    const windEngineRef = useRef<WindParticleLayer | null>(null);
    const windGridRef = useRef<WindGrid | null>(null);
    // Rain scrubber refs
    const rainFramesRef = useRef<{ path: string; time: number }[]>([]);
    const [rainFrameIndex, setRainFrameIndex] = useState(0);
    const [rainFrameCount, setRainFrameCount] = useState(0);
    const [rainPlaying, setRainPlaying] = useState(false);
    // Wind scrubber state
    const [windHour, setWindHour] = useState(0);
    const [windTotalHours, setWindTotalHours] = useState(48);
    const [windPlaying, setWindPlaying] = useState(false);
    const [windReady, setWindReady] = useState(false);
    const [windMaxSpeed, setWindMaxSpeed] = useState(30);

    // GRIB download state
    const [isGribDownloading, setIsGribDownloading] = useState(false);
    const [gribProgress, setGribProgress] = useState(0);
    const [gribError, setGribError] = useState<string | null>(null);

    // Wind label markers (HTML overlays, sit on top of WebGL canvas)
    const windMarkersRef = useRef<mapboxgl.Marker[]>([]);

    // State
    const location = useLocationStore();
    const windState = useWindStore();
    const { setPage } = useUI();
    const [activeLayer, setActiveLayer] = useState<WeatherLayer>('velocity');
    const [showLayerMenu, setShowLayerMenu] = useState(false);
    const [showPassage, setShowPassage] = useState(false);
    const [mapReady, setMapReady] = useState(false);

    // Passage planner state
    const [departure, setDeparture] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [arrival, setArrival] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [departureTime, setDepartureTime] = useState('');
    const [speed, setSpeed] = useState(6);
    const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysis | null>(null);
    const [settingPoint, setSettingPoint] = useState<'departure' | 'arrival' | null>(null);
    const isoResultRef = useRef<IsochroneResult | null>(null);
    const turnWaypointsRef = useRef<TurnWaypoint[]>([]);

    // ── Passage mode activation (from Ship's Office / RoutePlanner → MAP tab) ──
    useEffect(() => {
        const handlePassageMode = (e: Event) => {
            setShowPassage(true);
            // If coordinates were passed (from RoutePlanner "View on Map" button), pre-fill them
            const detail = (e as CustomEvent)?.detail;
            if (detail?.departure) {
                setDeparture(detail.departure);
            } else {
                setDeparture(null);
            }
            if (detail?.arrival) {
                setArrival(detail.arrival);
            } else {
                setArrival(null);
            }
            setRouteAnalysis(null);
        };
        window.addEventListener('thalassa:passage-mode', handlePassageMode);
        return () => window.removeEventListener('thalassa:passage-mode', handlePassageMode);
    }, []);

    // ── Initialize Map ──
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;
        if (!mapboxToken) return;

        mapboxgl.accessToken = mapboxToken;

        const map = new mapboxgl.Map({
            container: containerRef.current,
            style: mapStyle,
            center: center ? [center.lon, center.lat] : [location.lon, location.lat],
            zoom: initialZoom,
            attributionControl: false,
            maxZoom: embedded ? 18 : 18,
            minZoom: embedded ? initialZoom : 1,
            projection: 'mercator' as any,
            interactive: true,      // Always interactive (zoom/pan disabled selectively below)
            dragPan: true,          // Allow dragging everywhere (including embedded)
            dragRotate: false,
        });

        // Disable rotation for mobile UX
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();

        map.on('load', () => {
            const style = map.getStyle();
            if (style?.layers) {
                for (const layer of style.layers) {
                    // Strip large labels for embedded/minimal mode
                    if (minimalLabels && layer.type === 'symbol' && layer.id.match(/country-label|state-label|continent-label|place-label|settlement/)) {
                        map.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                    // Always hide road/motorway/highway symbols for cleaner marine map
                    if (layer.type === 'symbol' && layer.id.match(/road|motorway|highway|shield|trunk/i)) {
                        map.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                }
            }

            setMapReady(true);

            // Find first symbol/label layer ID — used to insert overlays below labels
            const styleLayers = map.getStyle()?.layers || [];
            let firstSymbolId: string | undefined;
            for (const l of styleLayers) {
                if (l.type === 'symbol') { firstSymbolId = l.id; break; }
            }

            // ── GEBCO Bathymetry overlay — Seabed 2030 / GEBCO 2024 Grid ──
            // Uses GEBCO_LATEST_2: colour-shaded for elevation (rich depth blues
            // in water, topographic greens/browns on land). Updated annually.
            if (!map.getSource('gebco-bathymetry')) {
                map.addSource('gebco-bathymetry', {
                    type: 'raster',
                    tiles: ['https://wms.gebco.net/mapserv?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=GEBCO_LATEST_2&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&SRS=EPSG:3857&FORMAT=image/png&TRANSPARENT=TRUE'],
                    tileSize: 256,
                    maxzoom: 12,
                    attribution: '© GEBCO / Seabed 2030',
                });
                map.addLayer({
                    id: 'gebco-bathymetry-tiles',
                    type: 'raster',
                    source: 'gebco-bathymetry',
                    minzoom: 0,
                    maxzoom: 12,
                    paint: {
                        'raster-opacity': 0.55,
                        'raster-saturation': -0.7,   // Heavily muted — subtle depth tones, no bright green
                        'raster-brightness-max': 0.85,
                        'raster-contrast': 0.15,
                    },
                }, firstSymbolId);
            }

            // ── OpenSeaMap — Always-on seamark overlay (buoys, lights, channels) ──
            // Visible at zoom ≥8 when coastal detail matters.
            // Sits above bathymetry, below route lines.
            if (!map.getSource('openseamap-permanent')) {
                map.addSource('openseamap-permanent', {
                    type: 'raster',
                    tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    maxzoom: 18,
                });
                map.addLayer({
                    id: 'openseamap-permanent',
                    type: 'raster',
                    source: 'openseamap-permanent',
                    minzoom: 8,
                    maxzoom: 18,
                    paint: {
                        'raster-opacity': 0.85,
                    },
                }, firstSymbolId);
            }

            // ── Skip heavy sources in embedded mode ──
            if (embedded) {
                setMapReady(true);

                // Defer velocity layer to after first paint
                setTimeout(() => setActiveLayer('velocity'), 800);
                return;
            }
            // ── Add route line source (empty initially) ──
            map.addSource('route-line', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            // ── Traffic Light route glow (outer neon tube) ──
            map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match', ['get', 'safety'],
                        'safe', '#00e676',
                        'caution', '#ff9100',
                        'danger', '#ff1744',
                        'harbour', '#38bdf8',
                        '#00f2fe', // default cyan (before graph loads)
                    ],
                    'line-width': 12,
                    'line-blur': 10,
                    'line-opacity': ['match', ['get', 'safety'], 'harbour', 0.3, 0.6],
                },
                filter: ['!=', ['get', 'dashed'], true],
            });

            // ── Route line (main visible track) ──
            map.addLayer({
                id: 'route-line-layer',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match', ['get', 'safety'],
                        'safe', '#00e676',
                        'caution', '#ff9100',
                        'danger', '#ff1744',
                        'harbour', '#38bdf8',
                        '#00f2fe',
                    ],
                    'line-width': 3,
                    'line-opacity': 0.9,
                },
                filter: ['!=', ['get', 'dashed'], true],
            });

            // ── Dashed harbour connector lines ──
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

            // ── Route core (sharp bright center) ──
            map.addLayer({
                id: 'route-core',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': [
                        'match', ['get', 'safety'],
                        'safe', '#b9f6ca',
                        'caution', '#ffe0b2',
                        'danger', '#ffcdd2',
                        'harbour', '#bae6fd',
                        '#ffffff',
                    ],
                    'line-width': 1.5,
                },
            });

            // ── Seamark Navigation Markers (bioluminescent) ──
            const seamarkBaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL)
                || 'https://pcisdplnodrphauixcau.supabase.co';
            const markersUrl = `${seamarkBaseUrl}/storage/v1/object/public/regions/australia_se_qld/nav_markers.geojson`;
            fetch(markersUrl)
                .then(r => r.json())
                .then((geojson: any) => {
                    if (!map.getSource('nav-markers')) {
                        map.addSource('nav-markers', { type: 'geojson', data: geojson });

                        // Outer glow (bioluminescent blur)
                        map.addLayer({
                            id: 'nav-markers-glow',
                            type: 'circle',
                            source: 'nav-markers',
                            minzoom: 10,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 10, 18, 20],
                                'circle-blur': 0.8,
                                'circle-opacity': 0.7,
                                'circle-color': [
                                    'match', ['get', '_class'],
                                    'port', '#ff1744',
                                    'starboard', '#00e676',
                                    'cardinal_n', '#ffd600',
                                    'cardinal_s', '#ffd600',
                                    'cardinal_e', '#ffd600',
                                    'cardinal_w', '#ffd600',
                                    'cardinal', '#ffd600',
                                    'danger', '#ff6d00',
                                    'safe_water', '#ff1744',
                                    'light', '#ffffff',
                                    'special', '#ffab00',
                                    'mooring', '#40c4ff',
                                    'anchorage', '#40c4ff',
                                    '#888888',
                                ],
                            },
                        });

                        // Inner crisp dot
                        map.addLayer({
                            id: 'nav-markers-dot',
                            type: 'circle',
                            source: 'nav-markers',
                            minzoom: 10,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 5, 18, 10],
                                'circle-color': [
                                    'match', ['get', '_class'],
                                    'port', '#ff1744',
                                    'starboard', '#00e676',
                                    'cardinal_n', '#ffd600',
                                    'cardinal_s', '#ffd600',
                                    'cardinal_e', '#ffd600',
                                    'cardinal_w', '#ffd600',
                                    'cardinal', '#ffd600',
                                    'danger', '#ff6d00',
                                    'safe_water', '#ff1744',
                                    'light', '#ffffff',
                                    'special', '#ffab00',
                                    'mooring', '#40c4ff',
                                    'anchorage', '#40c4ff',
                                    '#888888',
                                ],
                                'circle-stroke-width': 1,
                                'circle-stroke-color': '#000000',
                                'circle-stroke-opacity': 0.5,
                            },
                        });

                    }
                })
                .catch(() => { });
            // ── Isochrone source ──
            map.addSource('isochrones', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'isochrone-fills',
                type: 'fill',
                source: 'isochrones',
                paint: {
                    'fill-color': ['get', 'color'],
                    'fill-opacity': 0.15,
                },
            });

            map.addLayer({
                id: 'isochrone-lines',
                type: 'line',
                source: 'isochrones',
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': 1.5,
                    'line-opacity': 0.6,
                },
            });

            // ── Add waypoint markers source ──
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
                paint: {
                    'text-color': '#ffffff',
                    'text-halo-color': '#0f172a',
                    'text-halo-width': 1.5,
                },
            });

            // ── GRIB overlay bounding box source ──
            map.addSource('grib-bounds', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'grib-bounds-fill',
                type: 'fill',
                source: 'grib-bounds',
                paint: {
                    'fill-color': '#8b5cf6',
                    'fill-opacity': 0.08,
                },
            });

            map.addLayer({
                id: 'grib-bounds-line',
                type: 'line',
                source: 'grib-bounds',
                paint: {
                    'line-color': '#8b5cf6',
                    'line-width': 2,
                    'line-dasharray': [4, 4],
                    'line-opacity': 0.5,
                },
            });

            // ── Premium coastline overlay using Mapbox native vector tiles ──
            // These layers sit on TOP of all weather overlays (heatmap, particles)
            // to provide crisp, high-resolution coastline contours at every zoom.

            // 1. Coastline stroke — traces the exact land/water boundary
            //    from Mapbox's native 'water' vector tile source-layer.
            map.addLayer({
                id: 'coastline-stroke',
                type: 'line',
                source: 'composite',
                'source-layer': 'water',
                paint: {
                    'line-color': '#94a3b8',       // slate-400 — visible but not harsh
                    'line-width': [
                        'interpolate', ['linear'], ['zoom'],
                        0, 0.4,    // hair-thin at global zoom
                        5, 0.8,    // subtle at regional zoom
                        10, 1.2,   // crisp at local zoom
                        14, 1.5,   // defined at street zoom
                    ],
                    'line-opacity': [
                        'interpolate', ['linear'], ['zoom'],
                        0, 0.5,
                        6, 0.7,
                        12, 0.85,
                    ],
                },
            });

            // 2. Admin-0 country boundaries — geopolitical context
            map.addLayer({
                id: 'country-borders-overlay',
                type: 'line',
                source: 'composite',
                'source-layer': 'admin',
                filter: [
                    'all',
                    ['==', ['get', 'admin_level'], 0],
                    ['==', ['get', 'maritime'], 0],
                ],
                paint: {
                    'line-color': '#64748b',       // slate-500
                    'line-width': [
                        'interpolate', ['linear'], ['zoom'],
                        0, 0.3,
                        5, 0.6,
                        10, 1.0,
                    ],
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

        // Desktop: right-click = pin drop
        map.on('contextmenu', (e) => {
            const { lng, lat } = e.lngLat;
            dropPin(map, lat, lng);
        });

        mapRef.current = map;

        // Listen for recenter requests (e.g., from embedded map FAB button)
        const handleRecenter = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const lat = detail?.lat ?? center?.lat ?? location.lat;
            const lon = detail?.lon ?? center?.lon ?? location.lon;
            map.flyTo({ center: [lon, lat], zoom: initialZoom, duration: 800 });
        };
        window.addEventListener('map-recenter', handleRecenter);

        // Resize map when container dimensions change (mode switch, layout transitions)
        const resizeObserver = new ResizeObserver(() => {
            map.resize();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            window.removeEventListener('map-recenter', handleRecenter);
            resizeObserver.disconnect();
            cancelLongPress();
            map.remove();
            mapRef.current = null;
        };
    }, [mapboxToken, mapStyle, initialZoom, minimalLabels]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Pulsing blue "You Are Here" dot (actual device GPS) ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!navigator.geolocation) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (!locationDotRef.current) {
                    const el = document.createElement('div');
                    el.className = 'loc-dot';
                    locationDotRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                        .setLngLat([longitude, latitude])
                        .addTo(map);
                } else {
                    locationDotRef.current.setLngLat([longitude, latitude]);
                }
            },
            (err) => console.warn('[LocationDot] GPS error:', err.message),
            { enableHighAccuracy: true, maximumAge: 10_000 },
        );

        return () => {
            navigator.geolocation.clearWatch(watchId);
            if (locationDotRef.current) {
                locationDotRef.current.remove();
                locationDotRef.current = null;
            }
        };
    }, [mapReady]);

    // ── Picker Mode: tap-to-select with reverse geocode ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !pickerMode) return;

        const handleClick = async (e: mapboxgl.MapMouseEvent) => {
            const { lng, lat } = e.lngLat;
            triggerHaptic('medium');

            // Drop visual pin
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

            // Reverse geocode then callback
            try {
                const { reverseGeocode } = await import('../../services/weatherService');
                const name = await reverseGeocode(lat, lng);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
                onLocationSelect?.(lat, lng, name || fallback);
            } catch (e) {
                console.warn('[MapHub]', e);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
                onLocationSelect?.(lat, lng, fallback);
            }
        };

        map.on('click', handleClick);
        return () => { map.off('click', handleClick); };
    }, [pickerMode, onLocationSelect]);

    // ── Embedded rain radar with scrubber ──
    const embeddedRainFrames = useRef<{ path: string; time: number }[]>([]);
    const embRainNowIdx = useRef(0); // Index of the 'NOW' frame
    const [embRainIdx, setEmbRainIdx] = useState(-1); // -1 = uninitialised, set to NOW after frames load
    const [embRainCount, setEmbRainCount] = useState(0);
    const [embRainPlaying, setEmbRainPlaying] = useState(false);

    // Load rain frames
    useEffect(() => {
        if (!embedded || !mapReady || !mapRef.current) return;
        // Defer rain radar load to avoid competing with base map + velocity
        const delayTimer = setTimeout(() => {
            const m = mapRef.current;
            (async () => {
                try {
                    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
                    const data = await res.json();
                    const past = (data?.radar?.past ?? []).map((f: any) => ({ path: f.path, time: f.time }));
                    const forecast = (data?.radar?.nowcast ?? []).map((f: any) => ({ path: f.path, time: f.time }));
                    const allFrames = [...past, ...forecast];
                    embeddedRainFrames.current = allFrames;
                    setEmbRainCount(allFrames.length);
                    // Start at last past frame (current/NOW)
                    const nowIdx = Math.max(0, past.length - 1);
                    embRainNowIdx.current = nowIdx;
                    setEmbRainIdx(nowIdx);
                } catch (err) {
                }
            })();
        }, 1200); // 1.2s delay — velocity loads at 800ms, rain after
        return () => {
            clearTimeout(delayTimer);
            try {
                const mx = mapRef.current;
                if (mx?.getLayer('embedded-rain')) mx.removeLayer('embedded-rain');
                if (mx?.getSource('embedded-rain')) mx.removeSource('embedded-rain');
            } catch (_) { /* ok */ }
        };
    }, [embedded, mapReady]);

    // Swap rain tile on frame change
    useEffect(() => {
        if (!embedded || !mapRef.current) return;
        const m = mapRef.current;
        const frames = embeddedRainFrames.current;
        if (!frames.length || embRainIdx < 0 || embRainIdx >= frames.length) return;
        const frame = frames[embRainIdx];
        if (m.getSource('embedded-rain')) {
            try { m.removeLayer('embedded-rain'); m.removeSource('embedded-rain'); } catch (e) { console.warn('[MapHub] ok:', e); }
        }
        m.addSource('embedded-rain', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/1_1.png`],
            tileSize: 256,
        });
        m.addLayer({
            id: 'embedded-rain',
            type: 'raster',
            source: 'embedded-rain',
            paint: { 'raster-opacity': 0.75, 'raster-contrast': 0.3, 'raster-brightness-min': 0.1 },
        });
    }, [embedded, embRainIdx]);

    // Auto-play
    useEffect(() => {
        if (!embRainPlaying) return;
        const timer = setInterval(() => {
            setEmbRainIdx(prev => {
                if (prev + 1 >= embRainCount) { setEmbRainPlaying(false); return embRainNowIdx.current; }
                return prev + 1;
            });
        }, 400);
        return () => clearInterval(timer);
    }, [embRainPlaying, embRainCount]);

    // ── Pin Drop Logic ──
    const dropPin = useCallback((map: mapboxgl.Map, lat: number, lon: number) => {
        triggerHaptic('heavy');

        // Remove existing pin
        if (pinMarkerRef.current) {
            pinMarkerRef.current.remove();
        }

        // Create animated pin
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

        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([lon, lat])
            .addTo(map);

        pinMarkerRef.current = marker;

        // If setting a departure or arrival point for passage
        if (settingPoint) {
            const name = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
            if (settingPoint === 'departure') {
                setDeparture({ lat, lon, name });
            } else {
                setArrival({ lat, lon, name });
            }
            setSettingPoint(null);
            // Don't navigate to WX — stay on map
            LocationStore.setFromMapPin(lat, lon);
            return;
        }

        // If passage planner is open, auto-fill the first empty field
        if (showPassage) {
            const name = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
            if (!departure) {
                setDeparture({ lat, lon, name });
            } else if (!arrival) {
                setArrival({ lat, lon, name });
            } else {
                // Both set — update arrival
                setArrival({ lat, lon, name });
            }
            LocationStore.setFromMapPin(lat, lon);
            return;
        }

        // Default: Update global LocationStore + navigate to WX
        LocationStore.setFromMapPin(lat, lon);
        onLocationSelect?.(lat, lon);
    }, [settingPoint, showPassage, departure, arrival, onLocationSelect]);

    // ── Isobar Layer Management ──
    const isobarFetchRef = useRef<number>(0);
    const cachedFramesRef = useRef<any[]>([]);  // Pre-computed IsobarResult per hour
    const [forecastHour, setForecastHour] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [totalFrames, setTotalFrames] = useState(FORECAST_HOURS);
    const [framesReady, setFramesReady] = useState(0);
    const playRafRef = useRef<number | null>(null);
    const lastFrameTimeRef = useRef(0);

    // Swap pre-computed data into map sources (instant — no computation)
    const applyFrame = useCallback((hour: number) => {
        const map = mapRef.current;
        const frames = cachedFramesRef.current;
        if (!map || !frames[hour]) return;
        const result = frames[hour];
        const contourSrc = map.getSource('isobar-contours') as mapboxgl.GeoJSONSource;
        const centersSrc = map.getSource('isobar-centers') as mapboxgl.GeoJSONSource;
        const barbsSrc = map.getSource('wind-barbs') as mapboxgl.GeoJSONSource;
        const arrowsSrc = map.getSource('circulation-arrows') as mapboxgl.GeoJSONSource;
        const tracksSrc = map.getSource('movement-tracks') as mapboxgl.GeoJSONSource;
        if (contourSrc) contourSrc.setData(result.contours);
        if (centersSrc) centersSrc.setData(result.centers);
        if (barbsSrc) barbsSrc.setData(result.barbs);
        if (arrowsSrc) arrowsSrc.setData(result.arrows);
        if (tracksSrc) tracksSrc.setData(result.tracks);

        // Update pressure gradient heatmap
        if (result.heatmapDataUrl && result.heatmapBounds) {
            const [west, south, east, north] = result.heatmapBounds;
            const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
                [west, north],  // top-left
                [east, north],  // top-right
                [east, south],  // bottom-right
                [west, south],  // bottom-left
            ];

            const existingSrc = map.getSource('pressure-heatmap') as mapboxgl.ImageSource;
            if (existingSrc) {
                existingSrc.updateImage({ url: result.heatmapDataUrl, coordinates });
            } else {
                // Create source + layer on first frame
                map.addSource('pressure-heatmap', {
                    type: 'image',
                    url: result.heatmapDataUrl,
                    coordinates,
                });
                // Add raster layer BELOW isobar lines
                map.addLayer({
                    id: 'pressure-heatmap-layer',
                    type: 'raster',
                    source: 'pressure-heatmap',
                    paint: {
                        'raster-opacity': 0.5,
                        'raster-fade-duration': 0,
                    },
                }, 'isobar-lines'); // Insert below the isobar lines layer
            }
        }
    }, []);

    // Pre-compute all frames in non-blocking batches
    const precomputeFrames = useCallback((grid: any) => {
        const total = grid.totalHours;
        setTotalFrames(total);
        setFramesReady(0);
        cachedFramesRef.current = new Array(total);

        // Batch compute: 4 frames per tick to avoid blocking UI
        let idx = 0;
        const computeBatch = () => {
            const batchEnd = Math.min(idx + 4, total);
            for (let h = idx; h < batchEnd; h++) {
                cachedFramesRef.current[h] = generateIsobarsFromGrid(grid, h);
            }
            setFramesReady(batchEnd);
            idx = batchEnd;
            if (idx < total) {
                setTimeout(computeBatch, 0); // Yield to UI
            }
        };
        computeBatch();
    }, []);

    const updateIsobars = useCallback(async (map: mapboxgl.Map) => {
        const token = ++isobarFetchRef.current;
        const bounds = map.getBounds();
        if (!bounds) return;
        const zoom = map.getZoom();

        const data = await generateIsobars(
            bounds.getNorth(), bounds.getSouth(),
            bounds.getWest(), bounds.getEast(),
            zoom
        );

        if (token !== isobarFetchRef.current) return;
        if (!data) return;

        // Show frame 0 immediately
        setForecastHour(0);
        cachedFramesRef.current = [data.result];
        applyFrame(0);

        // Pre-compute remaining frames in background
        precomputeFrames(data.grid);
    }, [applyFrame, precomputeFrames]);

    // Smooth playback using requestAnimationFrame
    useEffect(() => {
        if (!isPlaying) {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
            playRafRef.current = null;
            return;
        }

        const animate = (timestamp: number) => {
            if (timestamp - lastFrameTimeRef.current >= 350) { // 350ms × 25 frames = 8.75s per 12h loop
                lastFrameTimeRef.current = timestamp;
                setForecastHour(prev => {
                    const max = cachedFramesRef.current.length;
                    const next = prev + 1;
                    if (next >= max || !cachedFramesRef.current[next]) {
                        return 0; // Loop back to start
                    }
                    return next;
                });
            }
            playRafRef.current = requestAnimationFrame(animate);
        };

        lastFrameTimeRef.current = performance.now();
        playRafRef.current = requestAnimationFrame(animate);

        return () => {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
        };
    }, [isPlaying]);

    // Apply cached frame when hour changes (instant swap)
    useEffect(() => {
        if (activeLayer === 'pressure') {
            applyFrame(forecastHour);
        }
    }, [forecastHour, activeLayer, applyFrame]);

    // Wind scrubber: update GL engine when hour changes
    useEffect(() => {
        if (activeLayer !== 'wind' || !windEngineRef.current || !windGridRef.current) return;
        windEngineRef.current.setForecastHour(windHour);
        setWindMaxSpeed(windEngineRef.current.getMaxSpeed());

        // Update wind label markers for the new hour
        const m = mapRef.current;
        const grid = windGridRef.current;
        if (!m || !grid) return;
        const h = Math.min(Math.floor(windHour), grid.totalHours - 1);
        const step = Math.max(2, Math.floor(Math.max(grid.width, grid.height) / 5));

        // Remove old markers
        windMarkersRef.current.forEach(mk => mk.remove());
        windMarkersRef.current = [];

        const sData = grid.speed[h];
        const uData = grid.u[h];
        const vData = grid.v[h];
        for (let r = 0; r < grid.height; r += step) {
            for (let c = 0; c < grid.width; c += step) {
                const idx = r * grid.width + c;
                const speedKts = Math.round(sData[idx] * 1.94384);
                const dir = (Math.atan2(-uData[idx], -vData[idx]) * 180 / Math.PI + 360) % 360;
                const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
                const cardinal = dirs[Math.round(dir / 22.5) % 16];

                const el = document.createElement('div');
                el.className = 'wind-label-marker';
                el.style.cssText = `
                    display: inline-block;
                    background: ${getWindColor(speedKts)};
                    color: ${speedKts > 25 ? '#fff' : '#1a1a2e'};
                    font-size: 10px;
                    font-weight: 800;
                    line-height: 1.2;
                    text-align: center;
                    padding: 3px 6px;
                    border-radius: 6px;
                    white-space: nowrap;
                    pointer-events: none;
                    text-shadow: none;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    border: 1px solid rgba(255,255,255,0.15);
                    position: relative;
                    z-index: 20;
                `;
                el.innerHTML = `${speedKts}kt<br/>${cardinal}`;

                const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([grid.lons[c], grid.lats[r]])
                    .addTo(m);
                windMarkersRef.current.push(marker);
            }
        }
    }, [windHour, activeLayer]);

    // Wind auto-play
    useEffect(() => {
        if (!windPlaying || activeLayer !== 'wind') return;
        const timer = setInterval(() => {
            setWindHour(prev => {
                if (prev + 1 >= windTotalHours) {
                    setWindPlaying(false);
                    return 0;
                }
                return prev + 1;
            });
        }, 500);
        return () => clearInterval(timer);
    }, [windPlaying, activeLayer, windTotalHours]);

    // (Wind dynamic re-fetch now handled by engine.onBoundsChange — see weather toggle effect)

    // Rain auto-play
    useEffect(() => {
        if (!rainPlaying || activeLayer !== 'rain') return;
        const timer = setInterval(() => {
            setRainFrameIndex(prev => {
                if (prev + 1 >= rainFrameCount) {
                    setRainPlaying(false);
                    return 0;
                }
                return prev + 1;
            });
        }, 400);
        return () => clearInterval(timer);
    }, [rainPlaying, activeLayer, rainFrameCount]);

    // Rain frame scrubber: swap tile source
    useEffect(() => {
        if (activeLayer !== 'rain') return;
        const m = mapRef.current;
        if (!m) return;
        const frames = rainFramesRef.current;
        if (rainFrameIndex >= frames.length) return;
        const frame = frames[rainFrameIndex];

        // Swap the raster tile URL
        if (m.getSource('weather-tiles')) {
            try {
                m.removeLayer('weather-tiles');
                m.removeSource('weather-tiles');
            } catch (e) { console.warn('[MapHub] ignore:', e); }
        }
        m.addSource('weather-tiles', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/4/1_1.png`],
            tileSize: 256,
        });
        m.addLayer({
            id: 'weather-tiles',
            type: 'raster',
            source: 'weather-tiles',
            paint: { 'raster-opacity': 0.75 },
        }, m.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
    }, [rainFrameIndex, activeLayer]);

    // ── Weather Layer Toggle ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove existing weather layer
        if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');
        // Remove wind speed labels
        if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
        if (map.getSource('wind-labels')) map.removeSource('wind-labels');
        // Remove wind label HTML markers
        windMarkersRef.current.forEach(mk => mk.remove());
        windMarkersRef.current = [];
        // Remove wind particle custom layer when switching away from wind
        if (activeLayer !== 'wind') {
            try { map.removeLayer('wind-particles'); } catch (_) { /* layer might not exist */ }
            windEngineRef.current = null;
            WindDataController.deactivate(map);
        }
        // Reset rain scrubber
        if (activeLayer !== 'rain') {
            rainFramesRef.current = [];
            setRainFrameCount(0);
            setRainFrameIndex(0);
        }

        // (Road symbols always hidden — done in map.on('load'))

        // Remove isobar layers when switching away from pressure
        const hideIsobars = () => {
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels', 'pressure-heatmap-layer'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            });
        };
        const showIsobars = () => {
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels', 'pressure-heatmap-layer'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
            });
        };

        hideIsobars();

        if (activeLayer === 'none') return;

        // Handle pressure layer specially — isobars instead of color tiles
        if (activeLayer === 'pressure') {
            // Zoom to synoptic scale so the user sees the big picture
            const currentZoom = map.getZoom();
            if (currentZoom > 4 || currentZoom < 2.5) {
                map.flyTo({ zoom: 3, duration: 1200 });
            }


            // Initialize isobar sources if they don't exist yet
            if (!map.getSource('isobar-contours')) {
                map.addSource('isobar-contours', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
                map.addSource('isobar-centers', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });

                // Isobar contour lines
                map.addLayer({
                    id: 'isobar-lines',
                    type: 'line',
                    source: 'isobar-contours',
                    paint: {
                        'line-color': '#ffffff',
                        'line-width': 1.5,
                        'line-opacity': 0.7,
                    },
                });

                // Pressure labels along contour lines
                map.addLayer({
                    id: 'isobar-labels',
                    type: 'symbol',
                    source: 'isobar-contours',
                    layout: {
                        'symbol-placement': 'line',
                        'text-field': ['get', 'label'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'symbol-spacing': 500,
                        'text-keep-upright': true,
                    },
                    paint: {
                        'text-color': '#e2e8f0',
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1.5,
                    },
                });

                // H/L center markers — background circles
                map.addLayer({
                    id: 'isobar-center-circles',
                    type: 'circle',
                    source: 'isobar-centers',
                    paint: {
                        'circle-radius': 18,
                        'circle-color': [
                            'match', ['get', 'type'],
                            'H', 'rgba(239, 68, 68, 0.15)',  // Red tint for high
                            'L', 'rgba(59, 130, 246, 0.15)',  // Blue tint for low
                            'rgba(100, 116, 139, 0.15)'
                        ],
                        'circle-stroke-color': [
                            'match', ['get', 'type'],
                            'H', '#ef4444',
                            'L', '#3b82f6',
                            '#64748b'
                        ],
                        'circle-stroke-width': 2,
                    },
                });

                // H/L labels
                map.addLayer({
                    id: 'isobar-center-labels',
                    type: 'symbol',
                    source: 'isobar-centers',
                    layout: {
                        'text-field': ['get', 'label'],
                        'text-size': 14,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'text-allow-overlap': true,
                    },
                    paint: {
                        'text-color': [
                            'match', ['get', 'type'],
                            'H', '#ef4444',
                            'L', '#3b82f6',
                            '#e2e8f0'
                        ],
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1.5,
                    },
                });

                // ── Wind Barbs ──
                map.addSource('wind-barbs', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });

                // Generate and add wind barb icon to the map
                const barbCanvas = document.createElement('canvas');
                barbCanvas.width = 48;
                barbCanvas.height = 48;
                const ctx = barbCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, 48, 48);
                    ctx.strokeStyle = '#e2e8f0';
                    ctx.lineWidth = 2;
                    ctx.lineCap = 'round';

                    // Draw wind barb pointing up (north). Mapbox rotates it.
                    // Staff: vertical line from center-bottom to center-top
                    const cx = 24, bottom = 40, top = 8;
                    ctx.beginPath();
                    ctx.moveTo(cx, bottom);
                    ctx.lineTo(cx, top);
                    ctx.stroke();

                    // Two full barbs (10kt each) at the top
                    ctx.beginPath();
                    ctx.moveTo(cx, top + 2);
                    ctx.lineTo(cx + 12, top - 2);
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.moveTo(cx, top + 8);
                    ctx.lineTo(cx + 10, top + 4);
                    ctx.stroke();

                    // Half barb
                    ctx.beginPath();
                    ctx.moveTo(cx, top + 14);
                    ctx.lineTo(cx + 6, top + 12);
                    ctx.stroke();

                    // Circle at base
                    ctx.beginPath();
                    ctx.arc(cx, bottom, 3, 0, Math.PI * 2);
                    ctx.fillStyle = '#e2e8f0';
                    ctx.fill();
                }

                const barbImage = new Image(48, 48);
                barbImage.onload = () => {
                    if (!map.hasImage('wind-barb-icon')) {
                        map.addImage('wind-barb-icon', barbImage, { sdf: false });
                    }
                };
                barbImage.src = barbCanvas.toDataURL();

                // Wind barb symbol layer
                map.addLayer({
                    id: 'wind-barb-layer',
                    type: 'symbol',
                    source: 'wind-barbs',
                    layout: {
                        'icon-image': 'wind-barb-icon',
                        'icon-size': 0.7,
                        'icon-rotate': ['get', 'rotation'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                        'text-field': ['concat', ['get', 'label'], ' kt'],
                        'text-size': 9,
                        'text-offset': [0, 2.5],
                        'text-anchor': 'top',
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                        'text-allow-overlap': false,
                    },
                    paint: {
                        'icon-opacity': 0.8,
                        'text-color': '#94a3b8',
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1,
                    },
                });

                // ── Circulation Arrows ──
                map.addSource('circulation-arrows', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });

                // Generate arrow icon (chevron pointing up — Mapbox rotates it)
                const arrowCanvas = document.createElement('canvas');
                arrowCanvas.width = 32;
                arrowCanvas.height = 32;
                const actx = arrowCanvas.getContext('2d');
                if (actx) {
                    actx.clearRect(0, 0, 32, 32);
                    actx.strokeStyle = '#ffffff';
                    actx.lineWidth = 3;
                    actx.lineCap = 'round';
                    actx.lineJoin = 'round';

                    // Chevron arrow pointing up
                    actx.beginPath();
                    actx.moveTo(8, 22);
                    actx.lineTo(16, 10);
                    actx.lineTo(24, 22);
                    actx.stroke();

                    // Stem
                    actx.beginPath();
                    actx.moveTo(16, 10);
                    actx.lineTo(16, 28);
                    actx.stroke();
                }

                // Use SDF so we can tint arrows with color (red H / blue L)
                const arrowImg = new Image(32, 32);
                arrowImg.onload = () => {
                    if (!map.hasImage('circulation-arrow')) {
                        map.addImage('circulation-arrow', arrowImg, { sdf: true });
                    }
                };
                arrowImg.src = arrowCanvas.toDataURL();

                map.addLayer({
                    id: 'circulation-arrow-layer',
                    type: 'symbol',
                    source: 'circulation-arrows',
                    layout: {
                        'icon-image': 'circulation-arrow',
                        'icon-size': 0.6,
                        'icon-rotate': ['get', 'rotation'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                    },
                    paint: {
                        'icon-color': ['get', 'color'], // SDF tinting: red for H, blue for L
                        'icon-opacity': 0.7,
                    },
                });

                // ── Movement Tracks (12h forecast movement) ──
                map.addSource('movement-tracks', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });

                // Bold dashed line showing movement direction
                map.addLayer({
                    id: 'movement-track-lines',
                    type: 'line',
                    source: 'movement-tracks',
                    paint: {
                        'line-color': ['get', 'color'],
                        'line-width': 3,
                        'line-opacity': 0.85,
                        'line-dasharray': [3, 2],
                    },
                });

                // Label at end of track showing direction + speed
                map.addLayer({
                    id: 'movement-track-labels',
                    type: 'symbol',
                    source: 'movement-tracks',
                    layout: {
                        'symbol-placement': 'line',
                        'text-field': ['get', 'label'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'symbol-spacing': 500,
                        'text-anchor': 'center',
                        'text-keep-upright': true,
                    },
                    paint: {
                        'text-color': ['get', 'color'],
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1.5,
                    },
                });
            }

            showIsobars();

            // Fetch and render isobars
            updateIsobars(map);

            // Update on map move
            const onMoveEnd = () => updateIsobars(map);
            map.on('moveend', onMoveEnd);

            return () => { map.off('moveend', onMoveEnd); };
        }

        // ── Rain layer: RainViewer radar with timeline scrubber ──
        if (activeLayer === 'rain') {
            fetch('https://api.rainviewer.com/public/weather-maps.json')
                .then(r => r.json())
                .then(data => {
                    if (!mapRef.current) return;
                    const past = data?.radar?.past || [];
                    const nowcast = data?.radar?.nowcast || [];
                    const allFrames = [...past, ...nowcast];
                    if (!allFrames.length) return;

                    // Store all frames for scrubber
                    rainFramesRef.current = allFrames;
                    setRainFrameCount(allFrames.length);
                    // Start at latest past frame
                    const startIdx = Math.max(0, past.length - 1);
                    setRainFrameIndex(startIdx);


                    // Initial frame render
                    const startFrame = allFrames[startIdx];
                    map.addSource('weather-tiles', {
                        type: 'raster',
                        tiles: [`https://tilecache.rainviewer.com${startFrame.path}/256/{z}/{x}/{y}/4/1_1.png`],
                        tileSize: 256,
                    });
                    map.addLayer({
                        id: 'weather-tiles',
                        type: 'raster',
                        source: 'weather-tiles',
                        paint: { 'raster-opacity': 0.75 },
                    }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
                })
                .catch(() => { });
            return;
        }

        // ── WIND LAYER: WebGL particle animation + heatmap ──
        if (activeLayer === 'wind') {
            // Fly to zoom 8 for wind view
            map.flyTo({ center: [location.lon, location.lat], zoom: 8, duration: 800 });

            // Wait for flyTo to complete, then activate controller
            const onFlyEnd = () => {
                map.off('moveend', onFlyEnd);
                setWindHour(0);

                // Activate the wind data controller (handles online/offline)
                WindDataController.activate(map).then(() => {
                    const m = mapRef.current;
                    if (!m) return;

                    // Read grid IMPERATIVELY from store (not React hook — avoids stale closure)
                    const { grid: currentGrid } = WindStore.getState();
                    if (!currentGrid) {
                        return;
                    }

                    windGridRef.current = currentGrid;
                    setWindTotalHours(currentGrid.totalHours);
                    setWindReady(true);

                    // Create wind GL engine as Mapbox custom layer
                    try {
                        try { m.removeLayer('wind-particles'); } catch (_) { /* ok */ }
                        const engine = new WindParticleLayer();
                        engine.setGrid(currentGrid, windHour);
                        m.addLayer(engine);
                        // Keep coastline overlays on top of weather layers
                        try { m.moveLayer('coastline-stroke'); } catch (_) { /* ok */ }
                        try { m.moveLayer('country-borders-overlay'); } catch (_) { /* ok */ }
                        windEngineRef.current = engine;
                        setWindMaxSpeed(engine.getMaxSpeed());
                    } catch (err) {
                        console.error('[Wind GL] Engine init failed:', err);
                    }
                }).catch(() => { });
            };
            map.on('moveend', onFlyEnd);
        }

        // Temperature/clouds tile layers — removed with OWM.
        // These can be re-implemented with an open tile source if needed.
        if (activeLayer === 'temperature' || activeLayer === 'clouds') {
            // No tile source currently — show the base map only
            return;
        }

        // Static tile layers (sea marks, satellite)
        const tileUrl = STATIC_TILES[activeLayer];
        if (tileUrl) {
            map.addSource('weather-tiles', {
                type: 'raster',
                tiles: [tileUrl],
                tileSize: 256,
            });
            map.addLayer({
                id: 'weather-tiles',
                type: 'raster',
                source: 'weather-tiles',
                paint: { 'raster-opacity': activeLayer === 'satellite' ? 0.8 : 1.0 },
            }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
        }
    }, [activeLayer, mapReady, updateIsobars]);

    // ── Passage Route Computation ──
    const computePassage = useCallback(async () => {
        if (!departure || !arrival) return;
        triggerHaptic('medium');

        const map = mapRef.current;
        if (!map) { console.warn('[Passage] No map ref'); return; }

        // ── Helper: project a point along bearing by distance ──
        const project = (lat: number, lon: number, bearingDeg: number, distNM: number) => {
            const R = 3440.065; // Earth radius NM
            const d = distNM / R;
            const brng = (bearingDeg * Math.PI) / 180;
            const φ1 = (lat * Math.PI) / 180;
            const λ1 = (lon * Math.PI) / 180;
            const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(brng));
            const λ2 = λ1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
            return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
        };

        // ── Forward / reverse bearings for fallback projection ──
        const dLon = ((arrival.lon - departure.lon) * Math.PI) / 180;
        const φ1 = (departure.lat * Math.PI) / 180;
        const φ2 = (arrival.lat * Math.PI) / 180;
        const fwdBearing = (Math.atan2(
            Math.sin(dLon) * Math.cos(φ2),
            Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon)
        ) * 180) / Math.PI;
        const dLonRev = ((departure.lon - arrival.lon) * Math.PI) / 180;
        const revBearing = (Math.atan2(
            Math.sin(dLonRev) * Math.cos(φ1),
            Math.cos(φ2) * Math.sin(φ1) - Math.sin(φ2) * Math.cos(φ1) * Math.cos(dLonRev)
        ) * 180) / Math.PI;

        // ── Find deep-water gates via radial GEBCO search ──
        // findSeaBuoy spirals outward (12 bearings × 2 NM steps) until -50m depth
        const FALLBACK_NM = 5;
        let depGate: { lat: number; lon: number };
        let arrGate: { lat: number; lon: number };

        try {
            const [depBuoy, arrBuoy] = await Promise.all([
                findSeaBuoy(departure.lat, departure.lon, arrival.lat, arrival.lon),
                findSeaBuoy(arrival.lat, arrival.lon, departure.lat, departure.lon),
            ]);
            console.info(
                `[SeaBuoy] Dep: ${depBuoy.alreadyDeep ? 'already deep' : depBuoy.offsetNM > 0 ? `${depBuoy.offsetNM}NM → ${depBuoy.depth_m}m` : 'FAILED'}`,
                `| Arr: ${arrBuoy.alreadyDeep ? 'already deep' : arrBuoy.offsetNM > 0 ? `${arrBuoy.offsetNM}NM → ${arrBuoy.depth_m}m` : 'FAILED'}`,
            );
            // Use sea buoy if it found real deep water, otherwise fallback to bearing projection
            depGate = depBuoy.offsetNM > 0 || depBuoy.alreadyDeep
                ? { lat: depBuoy.lat, lon: depBuoy.lon }
                : project(departure.lat, departure.lon, fwdBearing, FALLBACK_NM);
            arrGate = arrBuoy.offsetNM > 0 || arrBuoy.alreadyDeep
                ? { lat: arrBuoy.lat, lon: arrBuoy.lon }
                : project(arrival.lat, arrival.lon, revBearing, FALLBACK_NM);
        } catch (err) {
            console.warn('[SeaBuoy] Search failed, using geometric fallback:', err);
            depGate = project(departure.lat, departure.lon, fwdBearing, FALLBACK_NM);
            arrGate = project(arrival.lat, arrival.lon, revBearing, FALLBACK_NM);
        }

        console.info(`[Passage] Departure gate: ${depGate.lat.toFixed(3)}, ${depGate.lon.toFixed(3)}`);
        console.info(`[Passage] Arrival gate: ${arrGate.lat.toFixed(3)}, ${arrGate.lon.toFixed(3)}`);
        // ── Great-circle passage (render immediately) ──
        const gcCoords: number[][] = [];
        const NUM_POINTS = 80;
        for (let i = 0; i <= NUM_POINTS; i++) {
            const f = i / NUM_POINTS;
            const lat1R = (depGate.lat * Math.PI) / 180;
            const lon1R = (depGate.lon * Math.PI) / 180;
            const lat2R = (arrGate.lat * Math.PI) / 180;
            const lon2R = (arrGate.lon * Math.PI) / 180;
            const d = Math.acos(
                Math.sin(lat1R) * Math.sin(lat2R) +
                Math.cos(lat1R) * Math.cos(lat2R) * Math.cos(lon2R - lon1R)
            );
            if (d < 1e-10) {
                gcCoords.push([depGate.lon, depGate.lat]);
                continue;
            }
            const A = Math.sin((1 - f) * d) / Math.sin(d);
            const B = Math.sin(f * d) / Math.sin(d);
            const x = A * Math.cos(lat1R) * Math.cos(lon1R) + B * Math.cos(lat2R) * Math.cos(lon2R);
            const y = A * Math.cos(lat1R) * Math.sin(lon1R) + B * Math.cos(lat2R) * Math.sin(lon2R);
            const z = A * Math.sin(lat1R) + B * Math.sin(lat2R);
            const lat = (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI;
            const lon = (Math.atan2(y, x) * 180) / Math.PI;
            gcCoords.push([lon, lat]);
        }

        // Route stats (great-circle baseline)
        const waypoints: RouteWaypoint[] = [
            { id: 'dep', lat: departure.lat, lon: departure.lon, name: departure.name },
            { id: 'arr', lat: arrival.lat, lon: arrival.lon, name: arrival.name },
        ];
        const result = computeRoute(waypoints, {
            speed,
            departureTime: departureTime ? new Date(departureTime) : new Date(),
        });
        setRouteAnalysis(result);

        // Helper to build the 3-leg Trip Sandwich GeoJSON
        const buildFeatures = (passageCoords: number[][]): GeoJSON.Feature<GeoJSON.LineString>[] => [
            {
                type: 'Feature',
                properties: { safety: 'harbour', dashed: true },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [departure.lon, departure.lat],
                        [depGate.lon, depGate.lat],
                    ],
                },
            },
            {
                type: 'Feature',
                properties: { safety: 'safe' },
                geometry: {
                    type: 'LineString',
                    coordinates: passageCoords,
                },
            },
            {
                type: 'Feature',
                properties: { safety: 'harbour', dashed: true },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [arrGate.lon, arrGate.lat],
                        [arrival.lon, arrival.lat],
                    ],
                },
            },
        ];

        // ── RENDER IMMEDIATELY with great-circle ──
        const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSrc) {
            routeSrc.setData({
                type: 'FeatureCollection',
                features: buildFeatures(gcCoords),
            } as any);
            console.info(`[Passage] Trip Sandwich rendered (great-circle)`);
        } else {
            console.warn('[Passage] route-line source not found');
        }

        // ── Waypoint markers ──
        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) {
            wpSource.setData({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature' as const,
                        properties: { name: departure.name || 'Departure', color: '#10b981' },
                        geometry: { type: 'Point' as const, coordinates: [departure.lon, departure.lat] },
                    },
                    {
                        type: 'Feature' as const,
                        properties: { name: arrival.name || 'Arrival', color: '#ef4444' },
                        geometry: { type: 'Point' as const, coordinates: [arrival.lon, arrival.lat] },
                    },
                ],
            });
        }

        // ── Fit bounds ──
        const bounds = new mapboxgl.LngLatBounds();
        bounds.extend([departure.lon, departure.lat]);
        bounds.extend([arrival.lon, arrival.lat]);
        map.fitBounds(bounds, { padding: 80, duration: 1000 });

        // ── Background: attempt isochrone weather routing ──
        // The Trip Sandwich is already visible (great-circle). Now try to enhance
        // the middle passage with wind-optimised routing. If it succeeds, swap in.
        setTimeout(async () => {
            try {
                const windState = WindStore.getState();
                let windGrid = windState.grid;

                if (!windGrid && map) {
                    console.info('[Isochrone BG] Loading wind data...');
                    await WindDataController.activate(map);
                    await new Promise(r => setTimeout(r, 500));
                    windGrid = WindStore.getState().grid;
                }

                if (!windGrid) {
                    console.info('[Isochrone BG] No wind data — keeping great-circle');
                    return;
                }

                const windField = createWindFieldFromGrid(windGrid);
                const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;
                const depTimeStr = departureTime || new Date().toISOString();

                console.info('[Isochrone BG] Preloading bathymetry grid...');
                const bathyGrid = await preloadBathymetry(depGate, arrGate);

                console.info('[Isochrone BG] Running isochrone engine...');
                const isoResult = await computeIsochrones(
                    depGate,
                    arrGate,
                    depTimeStr,
                    polar,
                    windField,
                    {},
                    bathyGrid,
                );

                if (isoResult && isoResult.routeCoordinates.length >= 2) {
                    console.info(
                        `[Isochrone BG] ✓ Route: ${isoResult.totalDistanceNM} NM, ${isoResult.totalDurationHours}h, ${isoResult.routeCoordinates.length} waypoints`
                    );
                    // Store isochrone result for GPX export
                    isoResultRef.current = isoResult;

                    // Swap in the isochrone route
                    const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                    if (src) {
                        src.setData({
                            type: 'FeatureCollection',
                            features: buildFeatures(isoResult.routeCoordinates),
                        } as any);
                    }

                    // Detect turn waypoints and render markers
                    const depTimeStr = departureTime || new Date().toISOString();
                    const wps = detectTurnWaypoints(isoResult.route, depTimeStr);
                    turnWaypointsRef.current = wps;
                    console.info(`[Waypoints] Detected ${wps.length} waypoints (incl. DEP/ARR)`);

                    // Render waypoint markers on map
                    const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
                    if (wpSource) {
                        wpSource.setData({
                            type: 'FeatureCollection',
                            features: wps.map(wp => ({
                                type: 'Feature' as const,
                                properties: {
                                    name: wp.id,
                                    distanceNM: wp.distanceNM,
                                    bearing: wp.bearing,
                                    eta: wp.eta,
                                    color: wp.id === 'DEP' ? '#10b981' : wp.id === 'ARR' ? '#ef4444' : '#f59e0b',
                                },
                                geometry: {
                                    type: 'Point' as const,
                                    coordinates: [wp.lon, wp.lat],
                                },
                            })),
                        });
                    }

                    // Update stats
                    const updatedResult = { ...result };
                    updatedResult.totalDistance = isoResult.totalDistanceNM;
                    updatedResult.estimatedDuration = isoResult.totalDurationHours;
                    setRouteAnalysis(updatedResult);
                } else {
                    console.warn('[Isochrone BG] No route found — keeping great-circle');
                }
            } catch (err) {
                console.warn('[Isochrone BG] Failed — keeping great-circle:', err);
            }
        }, 100); // Small delay to let the UI render first

    }, [departure, arrival, speed, departureTime]);

    // ── Auto-compute passage when both points are set AND map is ready ──
    useEffect(() => {
        if (mapReady && showPassage && departure && arrival) {
            computePassage().catch(err => {
                console.error('[Passage] computePassage failed:', err);
                setRouteAnalysis(null); // reset so banner doesn't show stale "Computing..."
            });
        }
    }, [mapReady, showPassage, departure, arrival, computePassage]);

    // ── Clear Route ──
    const clearRoute = useCallback(() => {
        setDeparture(null);
        setArrival(null);
        setRouteAnalysis(null);
        setDepartureTime('');
        isoResultRef.current = null;
        turnWaypointsRef.current = [];

        const map = mapRef.current;
        if (!map) return;

        const routeSource = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSource) routeSource.setData({ type: 'FeatureCollection', features: [] });

        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) wpSource.setData({ type: 'FeatureCollection', features: [] });
    }, []);

    // ── Render ──
    return (
        <div className="w-full h-full relative">
            {/* Map container */}
            <div ref={containerRef} className="w-full h-full" />

            {/* Pin bounce + location pulse animations */}
            <style>{`
                @keyframes pinBounce {
                    0% { transform: rotate(-45deg) translateY(-20px) scale(0.5); opacity: 0; }
                    60% { transform: rotate(-45deg) translateY(2px) scale(1.1); }
                    100% { transform: rotate(-45deg) translateY(0) scale(1); opacity: 1; }
                }
                @keyframes locPulse {
                    0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
                    70% { box-shadow: 0 0 0 10px rgba(59,130,246,0); }
                    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
                }
                .loc-dot {
                    width: 8px; height: 8px; border-radius: 50%;
                    background: #3b82f6; border: 1.5px solid #fff;
                    animation: locPulse 2s infinite;
                    box-shadow: 0 0 0 0 rgba(59,130,246,0.5);
                }
            `}</style>




            {/* ═══ VELOCITY WIND OVERLAY (Leaflet-velocity-ts on Mapbox) ═══ */}
            <MapboxVelocityOverlay mapboxMap={mapRef.current} visible={activeLayer === 'velocity'} />

            {/* ═══ WIND SPEED LEGEND ═══ */}
            {(activeLayer === 'velocity' || activeLayer === 'wind') && (
                <div
                    className="absolute right-3 z-[600] flex flex-col items-center gap-0.5"
                    style={{ top: '50%', transform: 'translateY(-50%)' }}
                >
                    <span className="text-[8px] font-bold text-white/60 uppercase tracking-wider mb-1">kts</span>
                    <div
                        className="rounded-full border border-white/15 shadow-lg"
                        style={{
                            width: 10,
                            height: 140,
                            background: 'linear-gradient(to bottom, #e05a50, #cc6650, #d9a060, #d9bf80, #a8b08c, #8ca5c7)',
                        }}
                    />
                    {/* Speed labels */}
                    <div className="flex flex-col items-end gap-0 mt-0.5" style={{ position: 'absolute', right: 16, top: 14, height: 140, justifyContent: 'space-between' }}>
                        {['35+', '25', '20', '15', '10', '5'].map((label) => (
                            <span key={label} className="text-[8px] font-semibold text-white/50 leading-none">{label}</span>
                        ))}
                    </div>
                </div>
            )}

            {/* ═══ EMBEDDED RAIN SCRUBBER ═══ */}
            {embedded && embRainCount > 1 && embRainIdx >= 0 && (
                <div
                    className="absolute left-2 right-2 z-[600] flex items-center gap-2 px-2.5 py-1.5 rounded-xl backdrop-blur-xl border border-white/10 shadow-lg"
                    style={{ bottom: 8, background: 'rgba(15, 23, 42, 0.85)' }}
                >
                    <style>{`
                        .emb-rain-slider { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
                        .emb-rain-slider::-webkit-slider-runnable-track { height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; }
                        .emb-rain-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #22c55e; margin-top: -5.5px; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
                    `}</style>
                    <button
                        onClick={() => setEmbRainPlaying(!embRainPlaying)}
                        className="w-6 h-6 flex items-center justify-center shrink-0 text-white/70 active:scale-90 transition-transform"
                    >
                        {embRainPlaying ? (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8" rx="0.5" /><rect x="6" y="1" width="3" height="8" rx="0.5" /></svg>
                        ) : (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9" /></svg>
                        )}
                    </button>
                    <input
                        type="range"
                        min={0}
                        max={embRainCount - 1}
                        value={embRainIdx}
                        onChange={e => { setEmbRainPlaying(false); setEmbRainIdx(parseInt(e.target.value)); }}
                        className="emb-rain-slider flex-1 h-3"
                    />
                    <span className="text-[11px] font-bold text-white/60 min-w-[32px] text-right font-mono">
                        {(() => {
                            const frames = embeddedRainFrames.current;
                            if (!frames.length) return '--';
                            const now = Date.now() / 1000;
                            const ft = frames[embRainIdx]?.time ?? now;
                            const dm = Math.round((ft - now) / 60);
                            if (Math.abs(dm) < 3) return 'NOW';
                            if (Math.abs(dm) >= 60) {
                                const h = Math.round(dm / 60);
                                return `${h > 0 ? '+' : ''}${h}h`;
                            }
                            return `${dm > 0 ? '+' : ''}${dm}m`;
                        })()}
                    </span>
                </div>
            )}


            {/* ═══ LAYER LEGEND STRIP ═══ */}
            {activeLayer !== 'none' && activeLayer !== 'sea' && activeLayer !== 'satellite' && activeLayer !== 'velocity' && (() => {
                const legends: Record<string, { gradient: string; labels: { text: string; pos: string }[] }> = {
                    rain: {
                        gradient: 'linear-gradient(to bottom, #1a1a2e, #ff00ff, #ff0000, #ff8c00, #ffff00, #00ff00, transparent)',
                        labels: [
                            { text: '50+', pos: '2%' },
                            { text: '25', pos: '18%' },
                            { text: '12', pos: '34%' },
                            { text: '4', pos: '50%' },
                            { text: '1', pos: '66%' },
                            { text: '0.5', pos: '82%' },
                        ],
                    },
                    wind: (() => {
                        const maxKt = Math.max(5, Math.ceil(windMaxSpeed / 5) * 5);

                        // Fixed color stops matching GLSL ramp — same hex values always
                        const allStops = [
                            { kt: 0, color: '#66b3ff' },  // light blue
                            { kt: 5, color: '#00d9d9' },  // teal
                            { kt: 15, color: '#33e633' },  // green
                            { kt: 25, color: '#ffff00' },  // yellow
                            { kt: 40, color: '#ff8000' },  // orange
                            { kt: 60, color: '#ff0000' },  // red
                        ];

                        // Only keep stops within observed max range
                        const stops = allStops.filter(s => s.kt <= maxKt);

                        // Position each stop as percentage of maxKt, spread across full legend
                        const gradStops = stops.map(s => {
                            const pct = 100 - (s.kt / maxKt) * 100; // 0kt=bottom(100%), maxKt=top(0%)
                            return `${s.color} ${pct}%`;
                        });

                        // Labels at same positions
                        const labels = stops.map(s => ({
                            text: s.kt === 0 ? '0' : s.kt === stops[stops.length - 1].kt ? `${s.kt}kt` : `${s.kt}`,
                            pos: `${Math.max(2, Math.min(95, 100 - (s.kt / maxKt) * 100))}%`,
                        }));

                        return {
                            gradient: `linear-gradient(to bottom, ${gradStops.join(', ')})`,
                            labels,
                        };
                    })(),
                    temperature: {
                        gradient: 'linear-gradient(to bottom, #4a0000, #ff0000, #ff8c00, #ffff00, #90ee90, #00bfff, #0000cd, #1a0033)',
                        labels: [
                            { text: '40°', pos: '5%' },
                            { text: '30°', pos: '22%' },
                            { text: '20°', pos: '40%' },
                            { text: '10°', pos: '55%' },
                            { text: '0°', pos: '72%' },
                            { text: '-10°', pos: '88%' },
                        ],
                    },
                    clouds: {
                        gradient: 'linear-gradient(to bottom, #e0e0e0, #a0a0a0, #606060, #303030, transparent)',
                        labels: [
                            { text: '100%', pos: '5%' },
                            { text: '75%', pos: '28%' },
                            { text: '50%', pos: '52%' },
                            { text: '25%', pos: '76%' },
                        ],
                    },
                    pressure: {
                        gradient: 'linear-gradient(to bottom, #ef4444, #f87171, #ffffff, #93c5fd, #3b82f6)',
                        labels: [
                            { text: 'H', pos: '5%' },
                            { text: '1030', pos: '20%' },
                            { text: '1013', pos: '48%' },
                            { text: '996', pos: '76%' },
                            { text: 'L', pos: '92%' },
                        ],
                    },
                };
                const legend = legends[activeLayer];
                if (!legend) return null;
                return (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1 pointer-events-none">
                        <div
                            className="w-2 rounded-full border border-white/10"
                            style={{ height: '45%', minHeight: 120, background: legend.gradient }}
                        />
                        <div className="relative" style={{ height: '45%', minHeight: 120 }}>
                            {legend.labels.map((l, i) => (
                                <span
                                    key={i}
                                    className="absolute left-0 text-[7px] font-bold text-white/70 leading-none"
                                    style={{ top: l.pos, textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                                >
                                    {l.text}
                                </span>
                            ))}
                        </div>
                    </div>
                );
            })()}

            {/* ═══ PASSAGE MODE BANNER ═══ */}
            {showPassage && !embedded && (
                <div className="absolute top-24 left-4 right-4 z-[501] animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="bg-slate-900/85 backdrop-blur-xl border border-white/10 rounded-xl px-3 py-2 shadow-lg">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-white/70 uppercase tracking-widest">Passage Planner</p>
                                    <p className="text-[10px] text-gray-500 truncate">
                                        {!departure ? 'Tap map to set Departure' :
                                            !arrival ? 'Tap map to set Arrival' :
                                                routeAnalysis ? `${routeAnalysis.totalDistance.toFixed(0)} NM • ${routeAnalysis.estimatedDuration.toFixed(0)}h` :
                                                    'Computing route…'}
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    setShowPassage(false);
                                    clearRoute();
                                    triggerHaptic('light');
                                }}
                                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                                aria-label="Close passage planner"
                            >
                                <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        {departure && (
                            <div className="mt-1.5 pt-1.5 border-t border-white/5 flex gap-1.5 text-[9px]">
                                <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/15 rounded text-emerald-400/80 font-bold truncate">
                                    ⬤ {departure.name}
                                </span>
                                {arrival && (
                                    <span className="px-1.5 py-0.5 bg-red-500/10 border border-red-500/15 rounded text-red-400/80 font-bold truncate">
                                        ◉ {arrival.name}
                                    </span>
                                )}
                            </div>
                        )}
                        {/* ── Action buttons (GPX export + Save) ── */}
                        {routeAnalysis && departure && arrival && (
                            <div className="mt-1.5 pt-1.5 border-t border-white/5 flex gap-2">
                                <button
                                    onClick={async () => {
                                        if (!isoResultRef.current || !turnWaypointsRef.current.length) return;
                                        try {
                                            const gpx = exportPassageAsGPX(
                                                isoResultRef.current,
                                                turnWaypointsRef.current,
                                                departure.name,
                                                arrival.name,
                                                departureTime || new Date().toISOString(),
                                            );
                                            await shareGPXFile(gpx, `passage_${departure.name}_to_${arrival.name}.gpx`);
                                        } catch (err) {
                                            console.error('[GPX Export]', err);
                                        }
                                    }}
                                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-sky-500/15 border border-sky-500/20 text-sky-400 text-[9px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                                >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    GPX
                                </button>
                                <button
                                    onClick={() => {
                                        if (!isoResultRef.current || !turnWaypointsRef.current.length) return;
                                        // Dispatch route data for LogPage to pick up
                                        window.dispatchEvent(new CustomEvent('thalassa:save-planned-route', {
                                            detail: {
                                                departure,
                                                arrival,
                                                departureTime: departureTime || new Date().toISOString(),
                                                waypoints: turnWaypointsRef.current,
                                                totalDistanceNM: isoResultRef.current.totalDistanceNM,
                                                totalDurationHours: isoResultRef.current.totalDurationHours,
                                                routeCoordinates: isoResultRef.current.routeCoordinates,
                                            },
                                        }));
                                        setPage('voyage');
                                    }}
                                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                                >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                                    </svg>
                                    Save to Log
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ═══ LAYER FAB MENU ═══ */}
            {!showPassage && !embedded && <div className={`absolute z-[500] flex flex-col gap-2 top-14 right-4`}>
                <button
                    onClick={() => { setShowLayerMenu(!showLayerMenu); triggerHaptic('light'); }}
                    className={`backdrop-blur-xl border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 bg-slate-900/90 ${embedded ? 'w-8 h-8 rounded-xl' : 'w-12 h-12'}`}
                >
                    <svg className={`text-white ${embedded ? 'w-3.5 h-3.5' : 'w-5 h-5'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
                    </svg>
                </button>

                {/* Recenter FAB — embedded mode only */}
                {embedded && (
                    <button
                        onClick={() => {
                            const lat = center?.lat ?? location.lat;
                            const lon = center?.lon ?? location.lon;
                            mapRef.current?.flyTo({ center: [lon, lat], zoom: initialZoom, duration: 800 });
                        }}
                        className="w-8 h-8 rounded-xl backdrop-blur-xl border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 bg-slate-900/90"
                        aria-label="Recenter map"
                    >
                        <svg className="w-3.5 h-3.5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <circle cx="12" cy="12" r="3" />
                            <path strokeLinecap="round" d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                        </svg>
                    </button>
                )}

                {showLayerMenu && (
                    <div className="bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
                        {([
                            { key: 'none', label: 'None', icon: '🗺️' },
                            { key: 'rain', label: 'Rain', icon: '🌧️' },
                            { key: 'velocity', label: 'Wind', icon: '💨' },
                            { key: 'temperature', label: 'Temp', icon: '🌡️' },
                            { key: 'clouds', label: 'Clouds', icon: '☁️' },
                            { key: 'pressure', label: 'Synoptic', icon: '🌀' },
                            { key: 'sea', label: 'Sea Marks', icon: '⚓' },
                            { key: 'satellite', label: 'Satellite', icon: '🛰️' },
                        ] as const).map(layer => (
                            <button
                                key={layer.key}
                                onClick={() => { setActiveLayer(layer.key); setShowLayerMenu(false); triggerHaptic('light'); }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${activeLayer === layer.key ? 'bg-sky-500/20 text-sky-400' : 'text-gray-400 hover:bg-white/5'
                                    }`}
                            >
                                <span className="text-xl">{layer.icon}</span>
                                <span className="text-sm font-bold">{layer.label}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>}

            {/* ═══ ACTION FABS ═══ */}
            {!embedded && !showPassage && (
                <div className="absolute bottom-44 right-4 z-[500] flex flex-col gap-2">

                    {/* Wind Mode Toggle: Global vs Passage */}
                    {activeLayer === 'wind' && (
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                const map = mapRef.current;
                                if (!map) return;
                                WindDataController.switchMode(map).then(() => {
                                    const { grid } = windState;
                                    if (grid && windEngineRef.current) {
                                        windEngineRef.current.setGrid(grid, 0);
                                        windGridRef.current = grid;
                                        setWindTotalHours(grid.totalHours);
                                        setWindHour(0);
                                    }
                                });
                            }}
                            className={`w-12 h-12 backdrop-blur-xl border rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${windState.isGlobalMode
                                ? 'bg-sky-600/90 border-sky-500/30'
                                : 'bg-amber-600/90 border-amber-500/30'
                                }`}
                            title={windState.isGlobalMode ? 'Global Live Wind' : 'Passage Wind'}
                        >
                            {windState.isGlobalMode ? (
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <circle cx="12" cy="12" r="9" />
                                    <path strokeLinecap="round" d="M3.5 12h17M12 3c-2 2.5-3 5.5-3 9s1 6.5 3 9c2-2.5 3-5.5 3-9s-1-6.5-3-9" />
                                </svg>
                            ) : (
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <circle cx="12" cy="12" r="9" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.24 7.76l-6.17 2.47-2.47 6.17 6.17-2.47 2.47-6.17z" />
                                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                                </svg>
                            )}
                        </button>
                    )}

                    {/* GRIB Download */}
                    {activeLayer === 'wind' && (
                        <button
                            onClick={async () => {
                                if (isGribDownloading) return;
                                triggerHaptic('medium');
                                setIsGribDownloading(true);
                                setGribProgress(0);
                                setGribError(null);
                                try {
                                    const map = mapRef.current;
                                    if (!map) throw new Error('Map not ready');
                                    const b = map.getBounds();
                                    if (!b) throw new Error('Cannot get map bounds');

                                    const isGlobal = windState.isGlobalMode;
                                    const north = isGlobal ? 90 : b.getNorth();
                                    const south = isGlobal ? -90 : b.getSouth();
                                    const east = isGlobal ? 180 : b.getEast();
                                    const west = isGlobal ? -180 : b.getWest();

                                    // NOAA NOMADS handles subsetting — just send bounds
                                    const body = { north, south, east, west };

                                    // Resolve Supabase project URL
                                    const supabaseUrl =
                                        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
                                    if (!supabaseUrl) throw new Error('Supabase URL not configured');
                                    const supabaseKey =
                                        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

                                    const url = `${supabaseUrl}/functions/v1/fetch-wind-grid`;
                                    setGribProgress(10);

                                    const resp = await fetch(url, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                                        },
                                        body: JSON.stringify(body),
                                    });

                                    setGribProgress(50);

                                    if (!resp.ok) {
                                        let errDetail = `Server ${resp.status}`;
                                        try {
                                            const errJson = await resp.json();
                                            errDetail = errJson.error || errJson.detail || errDetail;
                                        } catch (e) {
                                            console.warn('[MapHub]', e);
                                            errDetail = await resp.text().catch(() => errDetail);
                                        }
                                        throw new Error(errDetail);
                                    }

                                    const buffer = await resp.arrayBuffer();
                                    setGribProgress(80);

                                    // Guard: NOAA sometimes returns HTML error pages
                                    if (buffer.byteLength < 200) {
                                        const text = new TextDecoder().decode(buffer);
                                        throw new Error(`NOAA returned invalid data (${buffer.byteLength}B): ${text.substring(0, 100)}`);
                                    }

                                    // Decode GRIB2 (two messages: UGRD + VGRD)
                                    const { decodeGrib2Wind } = await import('../../services/weather/decodeGrib2Wind');
                                    const grib = decodeGrib2Wind(buffer);

                                    // Feed into wind engine — create it if it doesn't exist yet
                                    let engine = windEngineRef.current;
                                    if (!engine) {
                                        const map = mapRef.current;
                                        if (!map) throw new Error('Map not available for wind layer');
                                        try { map.removeLayer('wind-particles'); } catch (_) { /* ok */ }
                                        engine = new WindParticleLayer();
                                        map.addLayer(engine);
                                        // Keep coastline overlays on top of weather layers
                                        try { map.moveLayer('coastline-stroke'); } catch (_) { /* ok */ }
                                        try { map.moveLayer('country-borders-overlay'); } catch (_) { /* ok */ }
                                        windEngineRef.current = engine;
                                    }

                                    engine.setWindData(grib.u, grib.v, grib.width, grib.height, {
                                        north: grib.north,
                                        south: grib.south,
                                        east: grib.east,
                                        west: grib.west,
                                    });
                                    setWindMaxSpeed(engine.getMaxSpeed());

                                    setGribProgress(100);
                                    triggerHaptic('light');
                                } catch (err) {
                                    const msg = err instanceof Error ? err.message : 'Download failed';
                                    setGribError(msg);
                                    console.error('[GRIB] Error:', msg, err);
                                    triggerHaptic('heavy');
                                    // Auto-clear error after 5 seconds
                                    setTimeout(() => setGribError(null), 5000);
                                } finally {
                                    setIsGribDownloading(false);
                                }
                            }}
                            disabled={isGribDownloading}
                            className={`w-12 h-12 backdrop-blur-xl border rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${isGribDownloading
                                ? 'bg-sky-700/90 border-sky-500/30 cursor-wait'
                                : gribError
                                    ? 'bg-red-800/90 border-red-500/30'
                                    : 'bg-slate-900/90 border-white/[0.08] hover:bg-slate-800/90'
                                }`}
                            title={isGribDownloading ? `Downloading ${gribProgress}%` : gribError ?? 'Download GRIB'}
                        >
                            {isGribDownloading ? (
                                <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            ) : (
                                <svg className={`w-5 h-5 ${gribError ? 'text-red-300' : 'text-sky-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                                </svg>
                            )}
                        </button>
                    )}

                    {/* GRIB Error Tooltip */}
                    {gribError && activeLayer === 'wind' && (
                        <div className="max-w-[200px] bg-red-900/95 backdrop-blur-xl border border-red-500/30 rounded-xl px-3 py-2 shadow-2xl">
                            <p className="text-[11px] font-bold text-red-300 leading-tight">{gribError}</p>
                        </div>
                    )}

                    {/* GPS Locate Me */}
                    <button
                        onClick={() => {
                            triggerHaptic('medium');
                            if (!navigator.geolocation) return;
                            navigator.geolocation.getCurrentPosition(
                                (pos) => {
                                    const { latitude, longitude } = pos.coords;
                                    const map = mapRef.current;
                                    if (map) {
                                        map.flyTo({ center: [longitude, latitude], zoom: 12, duration: 1200 });
                                        dropPin(map, latitude, longitude);
                                    }
                                    LocationStore.setFromGPS(latitude, longitude);
                                    onLocationSelect?.(latitude, longitude);
                                },
                                (err) => void err,
                                { enableHighAccuracy: true, timeout: 10000 }
                            );
                        }}
                        className="w-12 h-12 bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                    >
                        <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <circle cx="12" cy="12" r="3" />
                            <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                        </svg>
                    </button>

                    {/* Recenter on last pin */}
                    <button
                        onClick={() => {
                            if (mapRef.current) {
                                mapRef.current.flyTo({ center: [location.lon, location.lat], zoom: 10, duration: 1000 });
                            }
                            triggerHaptic('light');
                        }}
                        className="w-12 h-12 bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                    >
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                        </svg>
                    </button>
                </div>
            )}


            {/* ═══ SYNOPTIC TIMELINE SCRUBBER ═══ */}
            {activeLayer === 'pressure' && (
                <SynopticScrubber
                    forecastHour={forecastHour}
                    totalFrames={totalFrames}
                    framesReady={framesReady}
                    isPlaying={isPlaying}
                    onHourChange={(h: number) => { setForecastHour(h); }}
                    onPlayToggle={() => { setIsPlaying(!isPlaying); triggerHaptic('light'); }}
                    onScrubStart={() => { setIsPlaying(false); }}
                    applyFrame={applyFrame}
                    triggerHaptic={triggerHaptic}
                />
            )}

            {/* ═══ WIND TIMELINE SCRUBBER ═══ */}
            {activeLayer === 'wind' && windReady && (
                <div className="absolute left-4 right-4 z-[500]" style={{ bottom: embedded ? 8 : 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                    <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { setWindPlaying(!windPlaying); triggerHaptic('light'); }}
                            className="w-8 h-8 flex items-center justify-center rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0 active:scale-90 transition-transform"
                        >
                            <span className="text-sm">{windPlaying ? '⏸' : '▶️'}</span>
                        </button>

                        <div
                            className="flex-1 relative h-10 flex items-center cursor-pointer"
                            style={{ touchAction: 'none' }}
                            onPointerDown={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const hr = ratio * (windTotalHours - 1);
                                setWindPlaying(false);
                                setWindHour(hr);
                                triggerHaptic('light');
                            }}
                            onPointerMove={e => {
                                if (e.buttons === 0) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const hr = ratio * (windTotalHours - 1);
                                setWindPlaying(false);
                                setWindHour(hr);
                            }}
                        >
                            <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                                <div className="absolute inset-y-0 left-0 bg-sky-500/40 rounded-full" style={{ width: `${(windHour / Math.max(1, windTotalHours - 1)) * 100}%` }} />
                            </div>
                            <div
                                className="absolute top-1/2 w-5 h-5 bg-sky-400 rounded-full shadow-lg shadow-sky-400/30 border-2 border-white/40 pointer-events-none"
                                style={{ left: `${(windHour / Math.max(1, windTotalHours - 1)) * 100}%`, transform: 'translate(-50%, -50%)' }}
                            />
                        </div>

                        <div className="shrink-0 text-right min-w-[52px]">
                            <p className="text-xs font-black text-white">+{windHour.toFixed(1)}h</p>
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                                {windHour < 24 ? 'Today' : windHour < 48 ? 'Tomorrow' : `+${Math.floor(windHour / 24)}d`}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ RAIN TIMELINE SCRUBBER ═══ */}
            {activeLayer === 'rain' && rainFrameCount > 1 && (
                <div className="absolute left-4 right-4 z-[500]" style={{ bottom: embedded ? 8 : 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                    <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { setRainPlaying(!rainPlaying); triggerHaptic('light'); }}
                            className="w-8 h-8 flex items-center justify-center rounded-xl bg-emerald-500/20 border border-emerald-500/30 shrink-0 active:scale-90 transition-transform"
                        >
                            <span className="text-sm">{rainPlaying ? '⏸' : '▶️'}</span>
                        </button>

                        <div
                            className="flex-1 relative h-10 flex items-center cursor-pointer"
                            style={{ touchAction: 'none' }}
                            onPointerDown={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const idx = Math.round(ratio * (rainFrameCount - 1));
                                setRainPlaying(false);
                                setRainFrameIndex(idx);
                                triggerHaptic('light');
                            }}
                            onPointerMove={e => {
                                if (e.buttons === 0) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const idx = Math.round(ratio * (rainFrameCount - 1));
                                setRainPlaying(false);
                                setRainFrameIndex(idx);
                            }}
                        >
                            <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                                <div className="absolute inset-y-0 left-0 bg-emerald-500/40 rounded-full" style={{ width: `${(rainFrameIndex / Math.max(1, rainFrameCount - 1)) * 100}%` }} />
                            </div>
                            <div
                                className="absolute top-1/2 w-5 h-5 bg-emerald-400 rounded-full shadow-lg shadow-emerald-400/30 border-2 border-white/40 pointer-events-none"
                                style={{ left: `${(rainFrameIndex / Math.max(1, rainFrameCount - 1)) * 100}%`, transform: 'translate(-50%, -50%)' }}
                            />
                        </div>

                        <div className="shrink-0 text-right min-w-[52px]">
                            <p className="text-xs font-black text-white">
                                {(() => {
                                    const frames = rainFramesRef.current;
                                    if (!frames.length) return '--';
                                    const now = Date.now() / 1000;
                                    const frameTime = frames[rainFrameIndex]?.time ?? now;
                                    const diffMin = Math.round((frameTime - now) / 60);
                                    if (Math.abs(diffMin) < 3) return 'NOW';
                                    return `${diffMin > 0 ? '+' : ''}${diffMin}m`;
                                })()}
                            </p>
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">Radar</p>
                        </div>
                    </div>
                </div>
            )}
        </div >
    );
};

// ── Sub-components ──────────────────────────────────────────────

const PointInput: React.FC<{
    label: string;
    point: { lat: number; lon: number; name: string } | null;
    color: string;
    isActive: boolean;
    onSet: () => void;
    onUseCurrent: () => void;
}> = ({ label, point, color, isActive, onSet, onUseCurrent }) => (
    <div className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all ${isActive
        ? `bg-${color}-500/10 border-${color}-500/30`
        : 'bg-white/[0.03] border-white/[0.06]'
        }`}>
        <div className={`w-3 h-3 rounded-full shrink-0 ${color === 'emerald' ? 'bg-emerald-400' : 'bg-red-400'
            }`} />
        <div className="flex-1 min-w-0">
            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">{label}</p>
            <p className="text-xs text-white font-bold truncate">
                {point ? point.name : 'Not set'}
            </p>
        </div>
        <button
            onClick={onUseCurrent}
            className="text-[11px] text-sky-400 font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg hover:bg-sky-500/10"
        >
            📍 Here
        </button>
        <button
            onClick={onSet}
            className={`text-[11px] font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg ${isActive
                ? 'text-amber-400 bg-amber-500/10'
                : 'text-gray-500 hover:bg-white/5'
                }`}
        >
            🗺️ Map
        </button>
    </div>
);

const ResultCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-center">
        <p className="text-xs font-black text-white truncate">{value}</p>
        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">{label}</p>
    </div>
);
