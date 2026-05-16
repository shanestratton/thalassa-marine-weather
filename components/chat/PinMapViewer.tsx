/**
 * PinMapViewer — Fullscreen nautical map overlay showing a single pin location.
 * Opens when a user taps a pin's static map image in chat.
 *
 * Clean map view: GEBCO bathymetry + OpenSeaMap sea marks + coastline,
 * but NO FABs, NO scrubber, NO wind/rain layers.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import { createGradientPinMarker } from '../../utils/createMarkerEl';
import { exportPinAsGPX } from './chatUtils';
import { piCache } from '../../services/PiCacheService';
import { GpsService } from '../../services/GpsService';
import { buildDirectionsVoyagePlan } from '../../services/MapboxDirectionsService';
import { useWeather } from '../../context/WeatherContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';

interface PinMapViewerProps {
    lat: number;
    lng: number;
    caption: string;
    onClose: () => void;
}

export const PinMapViewer: React.FC<PinMapViewerProps> = React.memo(({ lat, lng, caption, onClose }) => {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const [mapReady, setMapReady] = useState(false);
    const { saveVoyagePlan } = useWeather();
    const { setPage } = useUI();
    const [routing, setRouting] = useState(false);
    const [routeError, setRouteError] = useState<string | null>(null);

    // "Get Directions" — current GPS → this pin via Mapbox Directions.
    // Drops a road-following polyline + auto-turn waypoints on the
    // main map and navigates to it. Closes the viewer when ready.
    const handleDirections = useCallback(async () => {
        if (routing) return;
        setRouting(true);
        setRouteError(null);
        triggerHaptic('medium');
        try {
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 });
            if (!pos) {
                setRouteError('Could not get your GPS position.');
                return;
            }
            const plan = await buildDirectionsVoyagePlan(
                { lat: pos.latitude, lon: pos.longitude, name: 'My Location' },
                { lat, lon: lng, name: caption },
                'driving',
            );
            if (!plan) {
                setRouteError('No driving route found.');
                return;
            }
            saveVoyagePlan(plan);
            // Hand off to the main map view. The route renderer there
            // picks up VoyagePlan.routeGeoJSON automatically.
            setPage('map');
            onClose();
        } catch (e) {
            setRouteError(e instanceof Error ? e.message : 'Directions failed.');
        } finally {
            setRouting(false);
        }
    }, [routing, lat, lng, caption, saveVoyagePlan, setPage, onClose]);

    useEffect(() => {
        if (!mapContainer.current) return;

        const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
        if (!token) return;

        mapboxgl.accessToken = token;

        const map = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/dark-v11',
            center: [lng, lat],
            zoom: 13,
            attributionControl: false,
            logoPosition: 'bottom-left',
            dragRotate: false,
            // Route raster tiles through Pi Cache when available (offline support)
            transformRequest: (url: string, resourceType?: string) => {
                if (
                    resourceType === 'Tile' &&
                    piCache.isAvailable() &&
                    url.startsWith('http') &&
                    !url.includes('api.mapbox.com')
                ) {
                    const piUrl = piCache.passthroughTileUrl(url);
                    if (piUrl) return { url: piUrl };
                }
                return { url };
            },
        });

        map.touchZoomRotate.disableRotation();

        map.on('load', () => {
            // ── Nautical chart layers (same as main MapHub) ──

            const styleLayers = map.getStyle()?.layers || [];
            let firstSymbolId: string | undefined;
            for (const l of styleLayers) {
                if (l.type === 'symbol') {
                    firstSymbolId = l.id;
                    break;
                }
            }

            // GEBCO Bathymetry removed — WMS now returns 'Zoom Level Not Supported' tiles

            // OpenSeaMap overlay
            map.addSource('openseamap', {
                type: 'raster',
                tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                tileSize: 256,
                maxzoom: 18,
            });
            map.addLayer(
                {
                    id: 'openseamap',
                    type: 'raster',
                    source: 'openseamap',
                    minzoom: 6,
                    maxzoom: 18,
                    paint: { 'raster-opacity': 0.85 },
                },
                firstSymbolId,
            );

            // Coastline stroke
            map.addLayer({
                id: 'coastline-stroke',
                type: 'line',
                source: 'composite',
                'source-layer': 'water',
                paint: {
                    'line-color': '#94a3b8',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 5, 0.8, 10, 1.2, 14, 1.5],
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.7, 12, 0.85],
                },
            });

            // ── Pin marker ──
            const el = createGradientPinMarker();
            new mapboxgl.Marker(el).setLngLat([lng, lat]).addTo(map);

            setMapReady(true);
        });

        mapRef.current = map;

        return () => {
            map.remove();
            mapRef.current = null;
        };
    }, [lat, lng]);

    // Block body scroll when open
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    const formattedLat = `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}`;
    const formattedLng = `${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'W' : 'E'}`;

    // Portal to document.body so ancestor transforms / overflow
    // (PageTransition wrappers, chat scroll containers, animation
    // classes, etc) can't trap this fullscreen modal inside the
    // chat content area. Without the portal, the Get Directions
    // button at the bottom could land BEHIND the bottom nav — which
    // is what Shane saw ("the how to get there is not showing.
    // maybe it is below the menu bar"). Same pattern used by the
    // RoutePlanner's map modal.
    return createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/95 flex flex-col">
            {/* Header */}
            <div className="relative z-10 flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
                <button
                    aria-label="Close pin drop map"
                    onClick={onClose}
                    className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center active:scale-90 transition-transform"
                >
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="white"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                    >
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </button>
                <h2 className="text-sm font-semibold text-white/80 truncate max-w-[60%]">{caption}</h2>
                <div className="w-10" /> {/* spacer */}
            </div>

            {/* Map */}
            <div className="flex-1 relative">
                {!mapReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900 z-10">
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                )}
                <div ref={mapContainer} className="absolute inset-0" />
            </div>

            {/* Footer — coords, Directions CTA, GPX export */}
            <div className="relative z-10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 space-y-2">
                {routeError && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        {routeError}
                    </div>
                )}
                <div className="flex items-center justify-between bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3">
                    <div className="min-w-0 flex-1 pr-2">
                        <p className="text-xs font-semibold text-white/70 truncate">{caption}</p>
                        <p className="text-[11px] text-white/30 tabular-nums mt-0.5">
                            📍 {formattedLat}, {formattedLng}
                        </p>
                    </div>
                    <button
                        aria-label="Export pin as GPX"
                        onClick={() => exportPinAsGPX(lat, lng, caption)}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-500/10 border border-sky-500/20 active:scale-95 transition-transform"
                    >
                        <span className="text-sm">📥</span>
                        <span className="text-[11px] font-bold text-sky-300 uppercase tracking-wider">GPX</span>
                    </button>
                </div>
                <button
                    aria-label={`Get driving directions to ${caption}`}
                    onClick={() => void handleDirections()}
                    disabled={routing}
                    className="w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] transition-all text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {routing ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>Routing…</span>
                        </>
                    ) : (
                        <>
                            <span>🧭</span>
                            <span>Get Directions</span>
                        </>
                    )}
                </button>
            </div>
        </div>,
        document.body,
    );
});

PinMapViewer.displayName = 'PinMapViewer';
