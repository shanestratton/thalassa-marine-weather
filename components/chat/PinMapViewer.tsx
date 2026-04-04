/**
 * PinMapViewer — Fullscreen nautical map overlay showing a single pin location.
 * Opens when a user taps a pin's static map image in chat.
 *
 * Clean map view: GEBCO bathymetry + OpenSeaMap sea marks + coastline,
 * but NO FABs, NO scrubber, NO wind/rain layers.
 */
import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { createGradientPinMarker } from '../../utils/createMarkerEl';
import { exportPinAsGPX } from './chatUtils';

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

    return (
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

            {/* Footer with coords + GPX export */}
            <div className="relative z-10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
                <div className="flex items-center justify-between bg-white/[0.04] border border-white/[0.06] rounded-2xl px-4 py-3">
                    <div>
                        <p className="text-xs font-semibold text-white/70">{caption}</p>
                        <p className="text-[11px] text-white/30 tabular-nums mt-0.5">
                            📍 {formattedLat}, {formattedLng}
                        </p>
                    </div>
                    <button
                        aria-label="Pin drop marker"
                        onClick={() => exportPinAsGPX(lat, lng, caption)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-500/10 border border-sky-500/20 active:scale-95 transition-transform"
                    >
                        <span className="text-sm">📥</span>
                        <span className="text-[11px] font-bold text-sky-300 uppercase tracking-wider">GPX</span>
                    </button>
                </div>
            </div>
        </div>
    );
});

PinMapViewer.displayName = 'PinMapViewer';
