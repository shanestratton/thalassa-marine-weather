import { useState, useEffect, useRef, MutableRefObject } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export const useLeafletMap = (
    containerRef: MutableRefObject<HTMLDivElement | null>,
    lat: number,
    lon: number,
    enableZoom: boolean,
    mapboxToken?: string,
    showZoomControl: boolean = true,
    enableWrapping: boolean = false
) => {
    const mapInstance = useRef<L.Map | null>(null);
    const [mapReady, setMapReady] = useState(false);

    // Initialize Map
    useEffect(() => {
        if (!containerRef.current) return;

        if (mapInstance.current) return; // Already initialized

        const map = L.map(containerRef.current, {
            center: [lat, lon],
            zoom: 10,
            minZoom: 3,
            maxZoom: 20,
            zoomControl: showZoomControl,
            scrollWheelZoom: true,
            doubleClickZoom: enableZoom,
            touchZoom: true,
            dragging: true,
            boxZoom: enableZoom,
            keyboard: enableZoom,
            attributionControl: false,
            preferCanvas: true,
            inertia: true,
            zoomSnap: 0.5,
            wheelDebounceTime: 40,
            bounceAtZoomLimits: true,

            maxBoundsViscosity: 1.0,
            worldCopyJump: enableWrapping, // Loop the world markers
            maxBounds: enableWrapping ? undefined : [[-90, -180], [90, 180]] // Constrain ONLY if wrapping disabled
        });

        // Priority: Prop > Env Var
        const effectiveToken = mapboxToken || import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

        if (effectiveToken && effectiveToken.length > 10) {
            // ENHANCED: Switched to light-v11 for better coastline/land visibility
            L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}?access_token=${effectiveToken}`, {
                tileSize: 512,
                zoomOffset: -1,
                attribution: '© Mapbox',
                maxZoom: 20,
                noWrap: !enableWrapping,
                bounds: enableWrapping ? undefined : [[-90, -180], [90, 180]]
            }).addTo(map);
        } else {
            // Fallback to light CartoDB for coastline visibility
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
                maxZoom: 20,
                attribution: '© OpenStreetMap, © CartoDB',
                noWrap: !enableWrapping,
                bounds: enableWrapping ? undefined : [[-90, -180], [90, 180]]
            }).addTo(map);
        }

        // OpenSeaMap Overlay (always on top)
        L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: 'Map data: © OpenSeaMap contributors'
        }).addTo(map);

        map.setView([lat, lon], 10);
        mapInstance.current = map;
        setMapReady(true);

        // Resize Observer
        const observer = new ResizeObserver(() => {
            map.invalidateSize();
        });
        observer.observe(containerRef.current);

        return () => {
            observer.disconnect();
            map.remove();
            mapInstance.current = null;
            setMapReady(false);
        };
    }, [enableZoom, mapboxToken, showZoomControl]); // Re-init if essential configs change

    // Center Update (if map exists)
    useEffect(() => {
        if (mapInstance.current && !mapInstance.current.getBounds().contains([lat, lon])) {
            mapInstance.current.setView([lat, lon], 10, { animate: true });
        }
    }, [lat, lon]);

    return { mapInstance, mapReady };
};
