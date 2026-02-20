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
import { LocationStore, useLocationStore } from '../../stores/LocationStore';
import { triggerHaptic } from '../../utils/system';
import {
    computeRoute,
    formatDistance,
    formatDuration,
    formatETA,
    type RouteWaypoint,
    type RouteAnalysis,
} from '../../services/WeatherRoutingService';

// ── Types ──────────────────────────────────────────────────────

interface MapHubProps {
    mapboxToken?: string;
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
}

type WeatherLayer = 'none' | 'wind' | 'rain' | 'temperature' | 'waves';

// ── Weather tile endpoints (OpenWeatherMap free tiles) ──
const OWM_KEY = ''; // Falls back to localStorage
const WEATHER_TILES: Record<WeatherLayer, string | null> = {
    none: null,
    wind: 'https://tile.openweathermap.org/map/wind_new/{z}/{x}/{y}.png?appid=',
    rain: 'https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=',
    temperature: 'https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=',
    waves: null, // No free wave tile source
};

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({ mapboxToken, onLocationSelect }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const longPressTimer = useRef<NodeJS.Timeout | null>(null);

    // State
    const location = useLocationStore();
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
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [location.lon, location.lat],
            zoom: 8,
            attributionControl: false,
            maxZoom: 18,
            minZoom: 2,
        });

        // Disable rotation for mobile UX
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();

        map.on('load', () => {
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

        return () => {
            cancelLongPress();
            map.remove();
            mapRef.current = null;
        };
    }, [mapboxToken]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // ── Weather Layer Toggle ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove existing weather layer
        if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');

        const tileUrl = WEATHER_TILES[activeLayer];
        const owmKey = OWM_KEY || localStorage.getItem('owm_api_key') || '';

        if (tileUrl && owmKey) {
            map.addSource('weather-tiles', {
                type: 'raster',
                tiles: [`${tileUrl}${owmKey}`],
                tileSize: 256,
            });

            map.addLayer({
                id: 'weather-tiles',
                type: 'raster',
                source: 'weather-tiles',
                paint: { 'raster-opacity': 0.7 },
            }, 'route-line-layer'); // Insert below route
        }
    }, [activeLayer, mapReady]);

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

            {/* ═══ LOCATION BAR ═══ */}
            <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none">
                <div className="bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3 pointer-events-auto">
                    <div className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-black text-white truncate">
                            {location.isReversGeocoding ? 'Locating...' : location.name}
                        </p>
                        <p className="text-[9px] text-gray-500 font-mono">
                            {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
                        </p>
                    </div>
                    <span className="text-[8px] text-gray-600 font-bold uppercase tracking-widest shrink-0">
                        {location.source === 'map_pin' ? '📍 PIN' : location.source === 'gps' ? '🛰️ GPS' : '🔍'}
                    </span>
                </div>
            </div>

            {/* ═══ LAYER FAB MENU ═══ */}
            <div className="absolute top-20 right-4 z-10 flex flex-col gap-2">
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
                            { key: 'wind', label: 'Wind', icon: '💨' },
                            { key: 'rain', label: 'Rain', icon: '🌧️' },
                            { key: 'temperature', label: 'Temp', icon: '🌡️' },
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
            <div className="absolute bottom-20 right-4 z-10 flex flex-col gap-2">
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
            {showPassage && (
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
            )}
        </div>
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
