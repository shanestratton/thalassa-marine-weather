
import { useState, useEffect, useRef, MutableRefObject } from 'react';

export const useLeafletMap = (
    containerRef: MutableRefObject<HTMLDivElement | null>,
    lat: number,
    lon: number,
    enableZoom: boolean,
    mapboxToken?: string,
    showZoomControl: boolean = true
) => {
    const mapInstance = useRef<any>(null);
    const [mapReady, setMapReady] = useState(false);
    const [leafletLoaded, setLeafletLoaded] = useState(false);

    // Wait for Leaflet global
    useEffect(() => {
        if (window.L) {
            setLeafletLoaded(true);
            return;
        }
        const i = setInterval(() => {
            if (window.L) {
                setLeafletLoaded(true);
                clearInterval(i);
            }
        }, 100);
        return () => clearInterval(i);
    }, []);

    // Initialize Map
    useEffect(() => {
        if (!containerRef.current || !leafletLoaded) return;
        const L = window.L;

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
            tap: false,
            maxBoundsViscosity: 1.0
        });

        // Priority: Prop > Env Var
        const effectiveToken = mapboxToken || process.env.MAPBOX_ACCESS_TOKEN;

        if (effectiveToken && effectiveToken.length > 10) {
            L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=${effectiveToken}`, {
                tileSize: 512,
                zoomOffset: -1,
                attribution: '© Mapbox',
                maxZoom: 20
            }).addTo(map);
        } else {
            // Fallback to free CartoDB Dark Matter if no valid Mapbox token
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
                maxZoom: 20,
                attribution: '© OpenStreetMap, © CartoDB'
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
    }, [leafletLoaded, enableZoom, mapboxToken, showZoomControl]); // Re-init if essential configs change

    // Center Update (if map exists)
    useEffect(() => {
        if (mapInstance.current && !mapInstance.current.getBounds().contains([lat, lon])) {
             mapInstance.current.setView([lat, lon], 10, { animate: true });
        }
    }, [lat, lon]);

    return { mapInstance, mapReady };
};
