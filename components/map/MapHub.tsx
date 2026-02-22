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
    formatDistance,
    formatDuration,
    formatETA,
    type RouteWaypoint,
    type RouteAnalysis,
} from '../../services/WeatherRoutingService';
import { SynopticScrubber } from './SynopticScrubber';

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
}

type WeatherLayer = 'none' | 'rain' | 'wind' | 'temperature' | 'clouds' | 'pressure' | 'sea' | 'satellite';

// ── Free tile sources (no API key required) ──
const STATIC_TILES: Record<string, string> = {
    sea: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    satellite: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
};

// OWM key for wind/temperature tiles
function getOwmKey(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_OWM_API_KEY) {
        return import.meta.env.VITE_OWM_API_KEY as string;
    }
    return localStorage.getItem('owm_api_key') || '';
}

// Wind speed → nautical color (matches GLSL palette in WindGLEngine)
function getWindColor(kts: number): string {
    if (kts < 5) return 'rgba(38, 70, 130, 0.85)';   // Calm - deep blue
    if (kts < 10) return 'rgba(40, 120, 140, 0.85)';   // Light - teal
    if (kts < 15) return 'rgba(50, 160, 100, 0.85)';   // Gentle - green
    if (kts < 20) return 'rgba(120, 190, 50, 0.85)';   // Moderate - lime
    if (kts < 25) return 'rgba(220, 200, 30, 0.85)';   // Fresh - yellow
    if (kts < 34) return 'rgba(240, 140, 0, 0.90)';    // Strong - orange
    if (kts < 48) return 'rgba(220, 40, 30, 0.90)';    // Gale - red
    return 'rgba(200, 50, 200, 0.90)';                  // Storm+ - magenta
}

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({ mapboxToken, homePort, onLocationSelect, initialZoom = 6, mapStyle = 'mapbox://styles/mapbox/navigation-night-v1', minimalLabels = false }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const longPressTimer = useRef<NodeJS.Timeout | null>(null);

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
    const [activeLayer, setActiveLayer] = useState<WeatherLayer>('none');
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

    // ── Initialize Map ──
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;
        if (!mapboxToken) return;

        mapboxgl.accessToken = mapboxToken;

        const map = new mapboxgl.Map({
            container: containerRef.current,
            style: mapStyle,
            center: [location.lon, location.lat],
            zoom: initialZoom,
            attributionControl: false,
            maxZoom: 18,
            minZoom: 0,
            projection: 'mercator' as any,
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

            // ── Add route line source (empty initially) ──
            map.addSource('route-line', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'route-line-layer',
                type: 'line',
                source: 'route-line',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#38bdf8',
                    'line-width': 3,
                    'line-opacity': 0.9,
                },
            });

            // ── Add isochrone source ──
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

        // Resize map when container dimensions change (mode switch, layout transitions)
        const resizeObserver = new ResizeObserver(() => {
            map.resize();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            cancelLongPress();
            map.remove();
            mapRef.current = null;
        };
    }, [mapboxToken, mapStyle, initialZoom, minimalLabels]); // eslint-disable-line react-hooks/exhaustive-deps

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
            if (timestamp - lastFrameTimeRef.current >= 300) { // 300ms per frame = ~3.3 fps
                lastFrameTimeRef.current = timestamp;
                setForecastHour(prev => {
                    const max = cachedFramesRef.current.length;
                    const next = prev + 1;
                    if (next >= max || !cachedFramesRef.current[next]) {
                        setIsPlaying(false);
                        return 0;
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
            } catch { /* ignore */ }
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
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            });
        };
        const showIsobars = () => {
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels'].forEach(id => {
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
            // Show OWM pressure color underlay at low opacity for gradient context
            const owmKey = getOwmKey();
            if (owmKey) {
                map.addSource('weather-tiles', {
                    type: 'raster',
                    tiles: [`https://tile.openweathermap.org/map/pressure_new/{z}/{x}/{y}.png?appid=${owmKey}`],
                    tileSize: 256,
                });
                map.addLayer({
                    id: 'weather-tiles',
                    type: 'raster',
                    source: 'weather-tiles',
                    paint: { 'raster-opacity': 0.25 },
                }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
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
                        'symbol-spacing': 250,
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

                    console.log(`[Rain] Loaded ${past.length} past + ${nowcast.length} nowcast = ${allFrames.length} frames`);

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
                .catch(e => console.warn('[Rain] RainViewer fetch failed:', e));
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
                        console.warn('[Wind GL] Controller finished but no grid in store');
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
                        windEngineRef.current = engine;
                        setWindMaxSpeed(engine.getMaxSpeed());
                        console.log(`[Wind GL] Custom layer added — ${currentGrid.width}×${currentGrid.height} grid, max ${engine.getMaxSpeed().toFixed(0)}kt`);
                    } catch (err) {
                        console.error('[Wind GL] Engine init failed:', err);
                    }
                }).catch(err => console.warn('[Wind GL] Controller error:', err));
            };
            map.on('moveend', onFlyEnd);
        }

        // OWM weather layers — temperature, clouds (wind now uses WebGL)
        const OWM_LAYERS: Record<string, string> = {
            temperature: 'temp_new',
            clouds: 'clouds_new',
        };

        const owmLayer = OWM_LAYERS[activeLayer];
        if (owmLayer) {
            const owmKey = getOwmKey();
            if (owmKey) {
                map.addSource('weather-tiles', {
                    type: 'raster',
                    tiles: [`https://tile.openweathermap.org/map/${owmLayer}/{z}/{x}/{y}.png?appid=${owmKey}`],
                    tileSize: 256,
                });
                map.addLayer({
                    id: 'weather-tiles',
                    type: 'raster',
                    source: 'weather-tiles',
                    paint: { 'raster-opacity': 0.65 },
                }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
            }
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
    const computePassage = useCallback(() => {
        if (!departure || !arrival) return;
        triggerHaptic('medium');

        const waypoints: RouteWaypoint[] = [
            { id: 'dep', lat: departure.lat, lon: departure.lon, name: departure.name },
            { id: 'arr', lat: arrival.lat, lon: arrival.lon, name: arrival.name },
        ];

        const result = computeRoute(waypoints, {
            speed,
            departureTime: departureTime ? new Date(departureTime) : new Date(),
        });

        setRouteAnalysis(result);

        // Update map sources
        const map = mapRef.current;
        if (!map) return;

        // Route line
        const routeSource = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSource && result.routeCoordinates.length > 1) {
            routeSource.setData({
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: result.routeCoordinates.map(([lat, lon]) => [lon, lat]),
                },
            });
        }

        // Waypoint markers
        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) {
            wpSource.setData({
                type: 'FeatureCollection',
                features: result.waypoints.map((wp, i) => ({
                    type: 'Feature' as const,
                    properties: {
                        name: wp.name,
                        color: i === 0 ? '#10b981' : '#ef4444',
                    },
                    geometry: { type: 'Point' as const, coordinates: [wp.lon, wp.lat] },
                })),
            });
        }

        // Fit bounds
        if (result.routeCoordinates.length > 1) {
            const bounds = new mapboxgl.LngLatBounds();
            for (const [lat, lon] of result.routeCoordinates) {
                bounds.extend([lon, lat]);
            }
            map.fitBounds(bounds, { padding: 80, duration: 1000 });
        }
    }, [departure, arrival, speed, departureTime]);

    // ── Clear Route ──
    const clearRoute = useCallback(() => {
        setDeparture(null);
        setArrival(null);
        setRouteAnalysis(null);
        setDepartureTime('');

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

            {/* Pin bounce animation */}
            <style>{`
                @keyframes pinBounce {
                    0% { transform: rotate(-45deg) translateY(-20px) scale(0.5); opacity: 0; }
                    60% { transform: rotate(-45deg) translateY(2px) scale(1.1); }
                    100% { transform: rotate(-45deg) translateY(0) scale(1); opacity: 1; }
                }
            `}</style>

            {/* ═══ LAYER LEGEND STRIP ═══ */}
            {activeLayer !== 'none' && activeLayer !== 'sea' && activeLayer !== 'satellite' && (() => {
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

            {/* ═══ LAYER FAB MENU ═══ */}
            <div className="absolute top-14 right-4 z-10 flex flex-col gap-2">
                <button
                    onClick={() => { setShowLayerMenu(!showLayerMenu); triggerHaptic('light'); }}
                    className="w-12 h-12 bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                >
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
                    </svg>
                </button>

                {showLayerMenu && (
                    <div className="bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
                        {([
                            { key: 'none', label: 'None', icon: '🗺️' },
                            { key: 'rain', label: 'Rain', icon: '🌧️' },
                            { key: 'wind', label: 'Wind', icon: '💨' },
                            { key: 'temperature', label: 'Temp', icon: '🌡️' },
                            { key: 'clouds', label: 'Clouds', icon: '☁️' },
                            { key: 'pressure', label: 'Synoptic', icon: '🌀' },
                            { key: 'sea', label: 'Sea Marks', icon: '⚓' },
                            { key: 'satellite', label: 'Satellite', icon: '🛰️' },
                        ] as const).map(layer => (
                            <button
                                key={layer.key}
                                onClick={() => { setActiveLayer(layer.key); setShowLayerMenu(false); triggerHaptic('light'); }}
                                className={`w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors ${activeLayer === layer.key ? 'bg-sky-500/20 text-sky-400' : 'text-gray-400 hover:bg-white/5'
                                    }`}
                            >
                                <span className="text-base">{layer.icon}</span>
                                <span className="text-xs font-bold">{layer.label}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* ═══ ACTION FABS ═══ */}
            <div className="absolute bottom-28 right-4 z-10 flex flex-col gap-2">
                <button
                    onClick={() => { setShowPassage(!showPassage); triggerHaptic('light'); }}
                    className={`w-12 h-12 backdrop-blur-xl border rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${showPassage
                        ? 'bg-sky-600/90 border-sky-500/30'
                        : 'bg-slate-900/90 border-white/[0.08] hover:bg-slate-800/90'
                        }`}
                >
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
                    </svg>
                </button>

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
                            ? 'bg-cyan-600/90 border-cyan-500/30'
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
                                console.log(`[GRIB] POST ${url}`, body);
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
                                console.log(`[GRIB] Response: ${resp.status} ${resp.statusText}`);

                                if (!resp.ok) {
                                    let errDetail = `Server ${resp.status}`;
                                    try {
                                        const errJson = await resp.json();
                                        errDetail = errJson.error || errJson.detail || errDetail;
                                    } catch {
                                        errDetail = await resp.text().catch(() => errDetail);
                                    }
                                    throw new Error(errDetail);
                                }

                                const buffer = await resp.arrayBuffer();
                                console.log(`[GRIB] Received ${buffer.byteLength} bytes`);
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
                                    windEngineRef.current = engine;
                                    console.log('[GRIB] Created wind-particles layer on-the-fly');
                                }

                                engine.setWindData(grib.u, grib.v, grib.width, grib.height, {
                                    north: grib.north,
                                    south: grib.south,
                                    east: grib.east,
                                    west: grib.west,
                                });
                                setWindMaxSpeed(engine.getMaxSpeed());

                                console.log(`[GRIB] Loaded ${grib.width}×${grib.height} grid (${buffer.byteLength} bytes)`);
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
                        <p className="text-[10px] font-bold text-red-300 leading-tight">{gribError}</p>
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
                            (err) => console.warn('GPS error:', err.message),
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

            {/* ═══ PASSAGE PLANNER PANEL ═══ */}
            {
                showPassage && (
                    <div className="absolute bottom-16 left-0 right-0 z-20 mx-2 bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-t-3xl shadow-2xl shadow-black/50 max-h-[50vh] overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 duration-300">

                        {/* Header */}
                        <div className="px-5 pt-4 pb-2 flex items-center gap-3 shrink-0">
                            <div className="w-8 h-1 bg-white/20 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
                            <svg className="w-5 h-5 text-sky-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
                            </svg>
                            <h3 className="text-sm font-black text-white flex-1">Passage Planner</h3>
                            {routeAnalysis && (
                                <button onClick={clearRoute} className="text-[10px] text-red-400 font-bold uppercase tracking-widest mr-2">
                                    Clear
                                </button>
                            )}
                            <button
                                onClick={() => { setShowPassage(false); setSettingPoint(null); }}
                                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                            >
                                <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="px-5 pb-5 overflow-y-auto flex-1">
                            {/* Departure + Arrival inputs */}
                            <div className="space-y-2 mb-4">
                                <PointInput
                                    label="Departure"
                                    point={departure}
                                    color="emerald"
                                    isActive={settingPoint === 'departure'}
                                    onSet={() => { setSettingPoint(settingPoint === 'departure' ? null : 'departure'); triggerHaptic('light'); }}
                                    onUseCurrent={() => {
                                        setDeparture({ lat: location.lat, lon: location.lon, name: location.name });
                                        triggerHaptic('light');
                                    }}
                                />
                                <PointInput
                                    label="Arrival"
                                    point={arrival}
                                    color="red"
                                    isActive={settingPoint === 'arrival'}
                                    onSet={() => { setSettingPoint(settingPoint === 'arrival' ? null : 'arrival'); triggerHaptic('light'); }}
                                    onUseCurrent={() => {
                                        setArrival({ lat: location.lat, lon: location.lon, name: location.name });
                                        triggerHaptic('light');
                                    }}
                                />
                            </div>

                            {/* Time + Speed */}
                            <div className="flex gap-2 mb-4">
                                <div className="flex-1">
                                    <label className="text-[9px] text-gray-600 font-bold uppercase tracking-widest block mb-1">Departure Time</label>
                                    <input
                                        type="datetime-local"
                                        value={departureTime}
                                        onChange={e => setDepartureTime(e.target.value)}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-sky-500/30 [color-scheme:dark]"
                                    />
                                </div>
                                <div className="w-20">
                                    <label className="text-[9px] text-gray-600 font-bold uppercase tracking-widest block mb-1">Speed</label>
                                    <input
                                        type="number"
                                        value={speed}
                                        onChange={e => setSpeed(Math.max(1, parseInt(e.target.value) || 6))}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2 text-xs text-white font-mono outline-none focus:border-sky-500/30"
                                    />
                                </div>
                            </div>

                            {/* Compute button */}
                            <button
                                onClick={computePassage}
                                disabled={!departure || !arrival}
                                className="w-full py-3 bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500 transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed mb-4"
                            >
                                Compute Route
                            </button>

                            {settingPoint && (
                                <div className="px-3 py-2 bg-sky-600/20 border border-sky-500/20 rounded-xl mb-4 text-center animate-pulse">
                                    <p className="text-[10px] text-sky-400 font-black uppercase tracking-widest">
                                        Long-press map to set {settingPoint}
                                    </p>
                                </div>
                            )}

                            {/* Route results */}
                            {routeAnalysis && routeAnalysis.totalDistance > 0 && (
                                <div className="space-y-3">
                                    <div className="grid grid-cols-3 gap-2">
                                        <ResultCard label="Distance" value={formatDistance(routeAnalysis.totalDistance)} />
                                        <ResultCard label="Duration" value={formatDuration(routeAnalysis.estimatedDuration)} />
                                        <ResultCard label="Arrival" value={formatETA(routeAnalysis.arrivalTime)} />
                                    </div>

                                    <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-[10px] text-gray-500 font-bold">Route:</span>
                                        <span className="text-xs text-white font-bold">{routeAnalysis.segments.length} segments</span>
                                        <span className="text-xs text-gray-400">@ {routeAnalysis.averageSpeed} kts</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )
            }

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
                <div className="absolute left-4 right-4 z-20" style={{ bottom: 90 }}>
                    <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { setWindPlaying(!windPlaying); triggerHaptic('light'); }}
                            className="shrink-0 w-8 h-8 rounded-full bg-white/10 flex items-center justify-center active:scale-90 transition-transform"
                        >
                            <span className="text-white text-xs font-black">
                                {windPlaying ? '⏸' : '▶'}
                            </span>
                        </button>

                        <div className="flex-1 relative h-8 flex items-center" style={{ touchAction: 'none' }}>
                            <input
                                type="range"
                                min={0}
                                max={windTotalHours - 1}
                                step={0.1}
                                value={windHour}
                                onChange={e => { setWindPlaying(false); setWindHour(parseFloat(e.target.value)); }}
                                className="w-full h-1.5 appearance-none bg-white/10 rounded-full cursor-pointer"
                                style={{ accentColor: '#38bdf8' }}
                            />
                        </div>

                        <div className="shrink-0 text-right min-w-[52px]">
                            <p className="text-xs font-black text-white">+{windHour.toFixed(1)}h</p>
                            <p className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">
                                {windHour < 24 ? 'Today' : windHour < 48 ? 'Tomorrow' : `+${Math.floor(windHour / 24)}d`}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ RAIN TIMELINE SCRUBBER ═══ */}
            {activeLayer === 'rain' && rainFrameCount > 1 && (
                <div className="absolute left-4 right-4 z-20" style={{ bottom: 90 }}>
                    <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { setRainPlaying(!rainPlaying); triggerHaptic('light'); }}
                            className="shrink-0 w-8 h-8 rounded-full bg-white/10 flex items-center justify-center active:scale-90 transition-transform"
                        >
                            <span className="text-white text-xs font-black">
                                {rainPlaying ? '⏸' : '▶'}
                            </span>
                        </button>

                        <div className="flex-1 relative h-8 flex items-center" style={{ touchAction: 'none' }}>
                            <input
                                type="range"
                                min={0}
                                max={rainFrameCount - 1}
                                value={rainFrameIndex}
                                onChange={e => { setRainPlaying(false); setRainFrameIndex(parseInt(e.target.value)); }}
                                className="w-full h-1.5 appearance-none bg-white/10 rounded-full cursor-pointer"
                                style={{ accentColor: '#22c55e' }}
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
                            <p className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">Radar</p>
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
            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">{label}</p>
            <p className="text-xs text-white font-bold truncate">
                {point ? point.name : 'Not set'}
            </p>
        </div>
        <button
            onClick={onUseCurrent}
            className="text-[8px] text-sky-400 font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg hover:bg-sky-500/10"
        >
            📍 Here
        </button>
        <button
            onClick={onSet}
            className={`text-[8px] font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg ${isActive
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
        <p className="text-[8px] text-gray-600 font-bold uppercase tracking-widest">{label}</p>
    </div>
);
