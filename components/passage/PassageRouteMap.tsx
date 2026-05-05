/**
 * PassageRouteMap -- Mini route map showing the passage route line
 * on a dark, non-interactive Mapbox GL map.
 */
import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

interface PassageRouteMapProps {
    routeCoordinates: [number, number][]; // [lon, lat] GeoJSON order
    departLat: number;
    departLon: number;
    arriveLat: number;
    arriveLon: number;
    turnWaypoints?: { id: string; name: string; lat: number; lon: number }[];
    /** Height in pixels, defaults to 200 */
    height?: number;
    className?: string;
}

export const PassageRouteMap: React.FC<PassageRouteMapProps> = React.memo(
    ({ routeCoordinates, departLat, departLon, arriveLat, arriveLon, turnWaypoints, height = 200, className = '' }) => {
        const containerRef = useRef<HTMLDivElement>(null);
        const mapRef = useRef<mapboxgl.Map | null>(null);

        useEffect(() => {
            if (!containerRef.current || routeCoordinates.length < 2) return;

            const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
            if (!token) return;

            mapboxgl.accessToken = token;

            const map = new mapboxgl.Map({
                container: containerRef.current,
                style: 'mapbox://styles/mapbox/dark-v11',
                attributionControl: false,
                logoPosition: 'bottom-left',
                interactive: false,
                dragPan: false,
                dragRotate: false,
                scrollZoom: false,
                touchZoomRotate: false,
                doubleClickZoom: false,
                keyboard: false,
            });

            // Validate a coord before extending bounds. Defensive: a
            // single (0, 0) sneaking into routeCoordinates or a null
            // departLat/Lon defaulting to 0 forces fitBounds to include
            // the equator/Greenwich-meridian intersection — which then
            // zooms the camera all the way out to globe view because
            // the bounds now span half the world. Skip any coord that's
            // exactly 0,0, NaN, or out-of-range.
            const isValidCoord = (lon: number | null | undefined, lat: number | null | undefined): boolean => {
                if (lon == null || lat == null) return false;
                if (typeof lon !== 'number' || typeof lat !== 'number') return false;
                if (isNaN(lon) || isNaN(lat)) return false;
                if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return false;
                // Reject the (0,0) sentinel in the Atlantic — almost
                // never a real route point, almost always a default-
                // initialised null coordinate that slipped through.
                if (Math.abs(lon) < 0.0001 && Math.abs(lat) < 0.0001) return false;
                return true;
            };

            const bounds = new mapboxgl.LngLatBounds();
            if (isValidCoord(departLon, departLat)) bounds.extend([departLon, departLat]);
            if (isValidCoord(arriveLon, arriveLat)) bounds.extend([arriveLon, arriveLat]);
            for (const coord of routeCoordinates) {
                if (isValidCoord(coord[0], coord[1])) bounds.extend(coord);
            }
            // If we ended up with no valid coordinates at all, don't
            // call fitBounds — Mapbox would throw or keep its default
            // globe view. Caller's conditional render should have
            // prevented this, but belt-and-suspenders.
            if (bounds.isEmpty()) {
                return;
            }
            map.fitBounds(bounds, { padding: 40, animate: false });

            // Mapbox needs the container to have non-zero dimensions to
            // render correctly; cards that mount mid-animation can give
            // it a zero-height container at construction time. resize()
            // after the next frame ensures the map paints to the
            // correct size once the card layout settles.
            requestAnimationFrame(() => map.resize());

            map.on('load', () => {
                // -- Route GeoJSON source --
                map.addSource('passage-route', {
                    type: 'geojson',
                    data: {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: routeCoordinates,
                        },
                    },
                });

                // -- Triple-layer route line --
                // Outer glow
                map.addLayer({
                    id: 'route-glow',
                    type: 'line',
                    source: 'passage-route',
                    paint: {
                        'line-color': '#0ea5e9',
                        'line-width': 6,
                        'line-opacity': 0.15,
                        'line-blur': 4,
                    },
                });
                // Mid
                map.addLayer({
                    id: 'route-mid',
                    type: 'line',
                    source: 'passage-route',
                    paint: {
                        'line-color': '#0ea5e9',
                        'line-width': 3,
                        'line-opacity': 0.4,
                    },
                });
                // Core
                map.addLayer({
                    id: 'route-core',
                    type: 'line',
                    source: 'passage-route',
                    paint: {
                        'line-color': '#38bdf8',
                        'line-width': 1.5,
                        'line-opacity': 0.9,
                    },
                });

                // -- Waypoint markers (small white dots) --
                if (turnWaypoints?.length) {
                    for (const wp of turnWaypoints) {
                        const el = document.createElement('div');
                        el.className = 'passage-route-map-wp';
                        Object.assign(el.style, {
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            backgroundColor: '#ffffff',
                            opacity: '0.7',
                            boxShadow: '0 0 4px rgba(255,255,255,0.3)',
                        });
                        new mapboxgl.Marker({ element: el }).setLngLat([wp.lon, wp.lat]).addTo(map);
                    }
                }

                // -- Departure marker (green) --
                const departEl = document.createElement('div');
                departEl.className = 'passage-route-map-depart';
                Object.assign(departEl.style, {
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: '#22c55e',
                    border: '2px solid rgba(255,255,255,0.6)',
                    boxShadow: '0 0 6px rgba(34,197,94,0.5)',
                });
                new mapboxgl.Marker({ element: departEl }).setLngLat([departLon, departLat]).addTo(map);

                // -- Arrival marker (red/amber) --
                const arriveEl = document.createElement('div');
                arriveEl.className = 'passage-route-map-arrive';
                Object.assign(arriveEl.style, {
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: '#f59e0b',
                    border: '2px solid rgba(255,255,255,0.6)',
                    boxShadow: '0 0 6px rgba(245,158,11,0.5)',
                });
                new mapboxgl.Marker({ element: arriveEl }).setLngLat([arriveLon, arriveLat]).addTo(map);
            });

            mapRef.current = map;

            return () => {
                map.remove();
                mapRef.current = null;
            };
        }, [routeCoordinates, departLat, departLon, arriveLat, arriveLon, turnWaypoints]);

        return (
            <div
                className={`rounded-xl overflow-hidden border border-white/10 bg-slate-900/80 ${className}`}
                style={{ height }}
            >
                <div ref={containerRef} className="w-full h-full" />
            </div>
        );
    },
);

PassageRouteMap.displayName = 'PassageRouteMap';
