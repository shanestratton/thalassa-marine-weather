import React, { useState, useRef, useEffect } from 'react';
import L from 'leaflet';
import {
    WindIcon, CrosshairIcon, MapIcon, RadioTowerIcon, MapPinIcon, CompassIcon
} from './Icons';
import { WeatherMetrics, GridPoint, Waypoint, BuoyStation } from '../types';
import { MapLegend, StopDetailView, MapLayer } from './map/MapUI';
import { useLeafletMap } from '../hooks/useLeafletMap';
import { useWeatherOverlay } from '../hooks/useWeatherOverlay';
import { useMapMarkers } from '../hooks/useMapMarkers';
import { fetchActiveBuoys } from '../services/weatherService';



interface WeatherMapProps {
    lat?: number;
    lon?: number;
    locationName: string;
    currentWeather?: WeatherMetrics;
    synopticMap?: GridPoint[];
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
    routeCoordinates?: { lat: number, lon: number }[];
    waypoints?: Waypoint[];
    onWaypointSelect?: (index: number | null) => void;
    highlightedWaypointIndex?: number | null;
    minimal?: boolean;
    enableZoom?: boolean;
    showWeather?: boolean;
    mapboxToken?: string;
    initialLayer?: MapLayer | 'buoys';
    hideLayerControls?: boolean;
    restrictBounds?: boolean;
    isConfirmMode?: boolean;
    showZoomControl?: boolean;
    confirmLabel?: string;
}

// EMPTY STATE (Nulls) to ensure no fake data is shown
const EMPTY_WEATHER: WeatherMetrics = {
    windSpeed: null,
    windDirection: '',
    windDegree: 0,
    waveHeight: null,
    swellPeriod: null,
    airTemperature: null,
    condition: '',
    description: '',
    uvIndex: 0,
    humidity: null,
    precipitation: 0,
    pressure: null,
    visibility: null,
    day: '',
    date: '',
    isEstimated: true
};

export const WeatherMap: React.FC<WeatherMapProps> = ({
    lat,
    lon,
    locationName,
    currentWeather,
    onLocationSelect,
    routeCoordinates,
    waypoints,
    minimal = false,
    enableZoom = false,
    showWeather = true,
    mapboxToken,
    initialLayer = 'wind',
    hideLayerControls = false,
    restrictBounds = true,
    isConfirmMode = false,
    showZoomControl = false,
    confirmLabel
}) => {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const weatherCanvasRef = useRef<HTMLCanvasElement>(null);

    // Add 'buoys' to the activeLayer state
    const [activeLayer, setActiveLayer] = useState<MapLayer | 'buoys'>(initialLayer);
    const [selectedStop, setSelectedStop] = useState<Waypoint | null>(null);
    const [rawTargetPos, setRawTargetPos] = useState<{ lat: number, lon: number } | null>(null);
    const [buoys, setBuoys] = useState<BuoyStation[]>([]);

    // Pending selection for Confirm Mode
    const [pendingSelection, setPendingSelection] = useState<{ lat: number, lon: number, name: string } | null>(null);

    // Ref to track markers so we can remove them when layer changes
    // Optimization: Use LayerGroup instead of array of markers for bulk operations
    const buoyLayerGroupRef = useRef<L.LayerGroup | null>(null);

    const centerLat = lat ?? -27.47;
    const centerLon = lon ?? 153.02;
    const activeMetrics = currentWeather || EMPTY_WEATHER;

    // --- HOOKS ---
    // Enable wrapping ONLY if on Buoys layer (and not specifically restricted for another reason)
    const enableWrapping = activeLayer === 'buoys' || !restrictBounds;
    const { mapInstance, mapReady } = useLeafletMap(mapContainerRef, centerLat, centerLon, enableZoom, mapboxToken, showZoomControl, enableWrapping);

    // DEBUG LOGGING
    useEffect(() => {

    }, [isConfirmMode, activeLayer, showWeather, minimal, enableWrapping]);

    // Only enable weather overlay if NOT on Buoys layer
    const isWeatherVisible = showWeather && activeLayer !== 'buoys';

    useWeatherOverlay(
        weatherCanvasRef,
        mapInstance,
        activeLayer === 'buoys' ? 'wind' : activeLayer,
        activeMetrics,
        isWeatherVisible
    );

    const { vesselPos, targetPos, routePath, waypointPositions } = useMapMarkers(
        mapInstance,
        centerLat,
        centerLon,
        rawTargetPos,
        routeCoordinates,
        waypoints
    );

    // Fetch Buoys - Triggered on center change to get local dynamic buoys
    useEffect(() => {
        // Fetch broadly to allow global discovery
        fetchActiveBuoys(centerLat, centerLon).then(setBuoys);
    }, [centerLat, centerLon]);

    // Handle Buoy Markers
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !mapReady) return;

        // Init LayerGroup if needed
        if (!buoyLayerGroupRef.current) {
            buoyLayerGroupRef.current = L.layerGroup().addTo(map);
        }

        // Clear existing markers immediately
        buoyLayerGroupRef.current.clearLayers();

        if (activeLayer === 'buoys') {
            // Static SVG string for the icon
            const iconHtml = `
                <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" class="drop-shadow-lg">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#f59e0b" fill-opacity="0.9" stroke="white" stroke-width="1.5" />
                    <circle cx="12" cy="10" r="3" fill="#fff" />
                    <path d="M12 2v4" stroke="black" stroke-width="2" />
                </svg>
            `;

            const buoyIcon = L.divIcon({
                html: iconHtml,
                className: 'custom-buoy-icon',
                iconSize: [30, 30],
                iconAnchor: [15, 30],
            });

            // Batch add to layer group
            buoys.forEach(buoy => {
                const marker = L.marker([buoy.lat, buoy.lon], { icon: buoyIcon })
                    .bindTooltip(buoy.name, {
                        direction: 'top',
                        offset: [0, -25],
                        className: 'bg-black/80 text-white border border-white/20 px-2 py-1 rounded text-xs font-bold'
                    });

                // Click to Select
                marker.on('click', () => {
                    if (isConfirmMode) {
                        setPendingSelection({ lat: buoy.lat, lon: buoy.lon, name: buoy.name });
                        setRawTargetPos({ lat: buoy.lat, lon: buoy.lon });
                        map.flyTo([buoy.lat, buoy.lon], 12);
                    } else if (onLocationSelect) {
                        onLocationSelect(buoy.lat, buoy.lon, buoy.name);
                        map.flyTo([buoy.lat, buoy.lon], 12);
                    }
                });

                buoyLayerGroupRef.current?.addLayer(marker);
            });
        }

    }, [activeLayer, buoys, mapReady, onLocationSelect, isConfirmMode]);

    // Landscape Orientation Logic for Map View
    useEffect(() => {
        // Unlock orientation when Map is mounted (Allows Landscape)
        try {
            if (screen.orientation && typeof (screen.orientation as any).unlock === 'function') {
                (screen.orientation as any).unlock();
            }
        } catch (e) { /* Ignore */ }

        return () => {
            // Re-lock to Portrait when leaving Map
            try {
                if (screen.orientation && typeof (screen.orientation as any).lock === 'function') {
                    (screen.orientation as any).lock('portrait').catch(() => { });
                }
            } catch (e) { /* Ignore */ }
        };
    }, []);

    // Dynamic Bounds & Interaction Logic
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !mapReady) return;

        // 1. Calculate Data Bounds (Always needed for 'wind'/'rain' locking)
        let bounds;
        if (routeCoordinates && routeCoordinates.length > 1) {
            const latLngs = routeCoordinates.map(c => [c.lat, c.lon]);
            bounds = L.latLngBounds(latLngs as L.LatLngExpression[]);
        } else if (lat !== undefined && lon !== undefined) {
            const span = 0.5;
            bounds = L.latLngBounds(L.latLng(lat - span, lon - span), L.latLng(lat + span, lon + span));
        }

        // Unlocked Mode: Active if on Buoys layer OR explicitly unrestricted
        if (activeLayer === 'buoys' || !restrictBounds) {
            // --- UNLOCKED MODE (Global Selection) ---
            // Infinite Wrapping: MaxBounds is NULL (disabled)
            map.setMaxBounds(undefined); // Allow infinite scroll
            map.setMinZoom(2);
            map.setMaxZoom(18);

            // Enable Interactions
            map.dragging.enable();
            map.touchZoom.enable();
            // DISABLE DoubleClickZoom to ensure single clicks are instant and "bulletproof"
            map.doubleClickZoom.disable();
            map.scrollWheelZoom.enable();
            map.boxZoom.enable();
            map.keyboard.enable();
            if ((map as any).tap) (map as any).tap.enable();

            // Auto-fit route in passage view even if unrestricted
            if (routeCoordinates && routeCoordinates.length > 1 && bounds && bounds.isValid()) {
                map.fitBounds(bounds, { animate: true, padding: [30, 30] });
            } else if (activeLayer === 'buoys') {
                // FIX: Start Station Map zoomed out (World View)
                // Use setView to center on user but at Zoom 2
                map.setView([centerLat, centerLon], 2, { animate: true });
            }

        } else {
            // --- LOCKED MODE (Weather Data) ---
            // Prevent zooming interactions as requested
            map.touchZoom.disable();
            map.doubleClickZoom.disable();
            map.scrollWheelZoom.disable();
            map.boxZoom.disable();
            map.keyboard.disable();

            if (bounds && bounds.isValid()) {
                const paddedBounds = bounds.pad(0.1);

                // Constrain panning to the data area
                map.setMaxBounds(paddedBounds);

                // Lock Zoom to the bounds fit
                const fitZoom = map.getBoundsZoom(paddedBounds);
                map.setMinZoom(fitZoom);
                map.setMaxZoom(fitZoom);

                // Ensure we are centered and fit
                map.fitBounds(paddedBounds, { animate: true, padding: [20, 20] });
            }
        }
    }, [activeLayer, mapReady, restrictBounds]); // Removed lat/lon/route deps to prevent snapping during GPS updates

    // Force activeLayer to 'buoys' if in Confirm Mode to ensure selection context
    useEffect(() => {
        if (isConfirmMode) {
            setActiveLayer('buoys');
        }
    }, [isConfirmMode]);

    // Click Handler for Target Selection
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;

        const handleClick = (e: any) => {
            if (minimal) return;
            // Prevent interference with marker clicks
            if ((e.originalEvent?.target as HTMLElement).closest('.leaflet-marker-icon')) return;

            // Allow selection if in Confirm Mode OR clearly on Stations map
            if (isConfirmMode || activeLayer === 'buoys') {
                if (isConfirmMode) {
                    const name = `WP ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
                    setPendingSelection({ lat: e.latlng.lat, lon: e.latlng.lng, name });
                    setRawTargetPos({ lat: e.latlng.lat, lon: e.latlng.lng });
                } else if (onLocationSelect) {
                    setRawTargetPos({ lat: e.latlng.lat, lon: e.latlng.lng });
                    onLocationSelect(e.latlng.lat, e.latlng.lng);
                }
            }
        };

        map.on('click', handleClick);
        return () => { map.off('click', handleClick); };
    }, [mapInstance.current, minimal, onLocationSelect, activeLayer, isConfirmMode]);

    const handleConfirm = () => {
        if (pendingSelection && onLocationSelect) {
            onLocationSelect(pendingSelection.lat, pendingSelection.lon, pendingSelection.name);
            setPendingSelection(null);
        }
    };

    return (
        <div className="w-full h-full flex flex-col bg-[#0f172a] overflow-hidden relative touch-none overscroll-none" style={{ touchAction: 'none' }}>
            <style>{`
                .vessel-dot { width: 8px; height: 8px; background: #fff; border-radius: 50%; box-shadow: 0 0 10px #38bdf8; position: relative; z-index: 10; }
                .vessel-pulse { position: absolute; width: 30px; height: 30px; left: -11px; top: -11px; border: 1px solid rgba(56, 189, 248, 0.5); border-radius: 50%; animation: pulse-out 2s infinite; }
                @keyframes pulse-out { 0% { transform: scale(0.5); opacity: 0.8; } 100% { transform: scale(1.5); opacity: 0; } }
            `}</style>

            <div className="absolute top-0 left-0 right-0 z-[800] px-4 pb-4 pt-[calc(3.5rem+env(safe-area-inset-top))] bg-gradient-to-b from-slate-900/90 to-transparent pointer-events-none">
                <div className="flex flex-col items-start gap-4 max-w-7xl mx-auto w-full">
                    <div className="pointer-events-auto">
                        <div className="flex items-center gap-3 mb-1">
                            <div className="p-2 bg-slate-800 border border-white/10 rounded text-sky-400">
                                <MapIcon className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-white font-bold text-lg leading-none shadow-black drop-shadow-md">{locationName}</h2>
                                <div className="flex gap-3 text-[10px] font-mono text-gray-400 mt-1">
                                    <span>{Math.abs(centerLat).toFixed(4)}° {centerLat > 0 ? 'N' : 'S'}</span>
                                    <span>{Math.abs(centerLon).toFixed(4)}° {centerLon > 0 ? 'E' : 'W'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {!minimal && !hideLayerControls && (
                        <div className="pointer-events-auto bg-slate-900/80 backdrop-blur-md border border-white/10 rounded-full p-1 flex shadow-xl self-start">
                            <button
                                onClick={() => { setActiveLayer('wind'); setPendingSelection(null); }}
                                className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all ${activeLayer === 'wind' ? 'bg-sky-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                            >
                                Wind
                            </button>
                            <button
                                onClick={() => { setActiveLayer('rain'); setPendingSelection(null); }}
                                className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all ${activeLayer === 'rain' ? 'bg-sky-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                            >
                                Rain
                            </button>
                            <button
                                onClick={() => setActiveLayer('buoys')}
                                className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1 ${activeLayer === 'buoys' ? 'bg-amber-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                            >
                                <RadioTowerIcon className="w-3 h-3" /> Stations
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-grow relative w-full h-full bg-[#0f172a]">
                <div ref={mapContainerRef} className="absolute inset-0 z-0 bg-[#0f172a]" style={{ width: '100%', height: '100%' }}></div>

                <canvas
                    ref={weatherCanvasRef}
                    className="absolute inset-0 z-10 pointer-events-none"
                    role="img"
                    aria-label={`Live wind and weather particle animation for ${locationName}. Current wind: ${activeMetrics.windSpeed || 0} knots.`}
                >
                    Your browser does not support HTML5 Canvas. Weather data is available in text format above.
                </canvas>

                <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden">
                    {/* Route Line */}
                    {routePath && (
                        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 1 }}>
                            <path d={routePath} fill="none" stroke="#fbbf24" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md opacity-90" />
                        </svg>
                    )}

                    {/* Vessel Marker */}
                    {vesselPos && (
                        <div
                            className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-pointer hover:scale-125 transition-transform"
                            style={{ left: vesselPos.x, top: vesselPos.y, zIndex: 20 }}
                        >
                            <div className="vessel-dot"></div>
                            <div className="vessel-pulse"></div>
                        </div>
                    )}

                    {/* Target Crosshair - Only show on Map if needed */}
                    {activeLayer === 'buoys' && targetPos && (
                        <div
                            className="absolute transform -translate-x-1/2 -translate-y-1/2 z-30 animate-in fade-in zoom-in-95 duration-300"
                            style={{ left: targetPos.x, top: targetPos.y }}
                        >
                            <div className="w-8 h-8 relative">
                                <div className="absolute inset-0 border-2 border-red-500 rounded-full animate-ping opacity-50"></div>
                                <div className="absolute inset-0 border-2 border-white rounded-full flex items-center justify-center bg-black/30 shadow-lg">
                                    <div className="w-1 h-1 bg-red-500 rounded-full"></div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Waypoints */}
                    {waypointPositions.map((wpObj) => (
                        <div
                            key={wpObj.idx}
                            className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-auto group"
                            style={{ left: wpObj.x, top: wpObj.y, zIndex: 15 }}
                            onClick={() => setSelectedStop(wpObj.wp)}
                        >
                            <div className="flex flex-col items-center">
                                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 border-2 border-amber-500 shadow-lg text-[10px] font-bold text-amber-500 hover:bg-amber-500 hover:text-white transition-colors cursor-pointer">
                                    {wpObj.idx + 1}
                                </div>
                                <div className={`mt-1 bg-black/70 backdrop-blur-sm px-2 py-1 rounded text-[10px] text-white whitespace-nowrap border border-white/10 ${enableZoom ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                                    {wpObj.name}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {!minimal && activeLayer !== 'buoys' && <MapLegend layer={activeLayer} />}

                {selectedStop && (<StopDetailView waypoint={selectedStop} onClose={() => setSelectedStop(null)} />)}

                {/* Reset View Button - Always visible or at least when map is interactive/unlocked */}

                <div className="absolute bottom-0 left-0 right-0 z-[9000] p-4 pb-24 pointer-events-none">

                    {/* Container for GPS/Reset (Right Aligned) */}
                    <div className="flex flex-col items-end gap-3 mb-4 pointer-events-auto">
                        {/* 1. RESET / GPS STACK - Only show on Station Map or Confirm Mode */}
                        {(activeLayer === 'buoys' || isConfirmMode) && (
                            <>
                                {/* GPS Snap Button */}
                                <button
                                    onClick={() => {
                                        if ('geolocation' in navigator) {
                                            navigator.geolocation.getCurrentPosition((pos) => {
                                                if (mapInstance.current) {
                                                    const { latitude, longitude } = pos.coords;
                                                    mapInstance.current.flyTo([latitude, longitude], 12);

                                                    // Trigger selection if in confirm mode
                                                    if (isConfirmMode || onLocationSelect) {
                                                        // If confirm mode, stage it. If instant, select it?
                                                        // Actually logic below says:
                                                        if (isConfirmMode) {
                                                            setActiveLayer('buoys');
                                                            setPendingSelection({ lat: latitude, lon: longitude, name: 'Current Location' });
                                                            setRawTargetPos({ lat: latitude, lon: longitude });
                                                        } else if (onLocationSelect) {
                                                            // Just move map, user can click to confirm or maybe we auto-select?
                                                            // The original logic didn't auto-select on GPS snap unless confirm mode.
                                                            // Let's keep it just move map unless confirm mode.
                                                        }
                                                    }
                                                }
                                            }, (err) => alert("GPS Error: " + err.message));
                                        }
                                    }}
                                    className="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-full border border-white/10 shadow-xl transition-all active:scale-95 mb-2"
                                    title="Snap to GPS"
                                >
                                    <CompassIcon rotation={0} className="w-6 h-6 text-sky-400" />
                                </button>

                                {/* Reset Center Button */}
                                <button
                                    onClick={() => {
                                        if (mapInstance.current) {
                                            mapInstance.current.setView([centerLat, centerLon], 10, { animate: true });
                                        }
                                    }}
                                    className="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-full border border-white/10 shadow-xl transition-all active:scale-95"
                                    title="Reset Center"
                                >
                                    <CrosshairIcon className="w-6 h-6" />
                                </button>
                            </>
                        )}
                    </div>

                    {/* 2. CONFIRM BUTTON (Center Aligned, Full Width) - Only on Station Map */}
                    {(isConfirmMode && activeLayer === 'buoys') && (
                        <div className="w-full max-w-sm mx-auto pointer-events-auto flex justify-center">
                            <button
                                onClick={handleConfirm}
                                disabled={!pendingSelection}
                                className={`w-full font-bold py-4 px-6 rounded-xl shadow-2xl flex items-center justify-center gap-2 border transition-all ${pendingSelection ? 'bg-sky-500 hover:bg-sky-400 text-white border-transparent scale-105' : 'bg-slate-800/90 backdrop-blur-md text-gray-500 border-white/10 cursor-not-allowed'}`}
                            >
                                <MapPinIcon className={`w-5 h-5 ${pendingSelection ? 'text-white' : 'text-gray-600'}`} />
                                {pendingSelection ? (confirmLabel || "Confirm Location") : "Tap Map to Select Point"}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};