import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

interface MiniOverviewMapProps {
    mainMap: mapboxgl.Map | null;
    mapboxToken: string;
}

/**
 * Interactive world-overview inset showing the current viewport as a cyan rectangle.
 * Tap/click anywhere on the mini map to jump the main map to that location.
 * Drag to quickly reposition. Appears bottom-left when velocity layer is active.
 */
export const MiniOverviewMap: React.FC<MiniOverviewMapProps> = ({ mainMap, mapboxToken }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const miniMapRef = useRef<mapboxgl.Map | null>(null);
    const isDragging = useRef(false);

    useEffect(() => {
        if (!containerRef.current || !mainMap) return;

        mapboxgl.accessToken = mapboxToken;
        const mainCenter = mainMap.getCenter();
        const mini = new mapboxgl.Map({
            container: containerRef.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [0, 15],
            zoom: 0.3,
            interactive: false,
            attributionControl: false,
            logoPosition: 'top-left' as any,
            projection: 'mercator' as any,
        });
        miniMapRef.current = mini;

        // Hide Mapbox logo (links to their site)
        mini.on('load', () => {
            const logo = mini.getContainer().querySelector('.mapboxgl-ctrl-logo');
            if (logo) (logo as HTMLElement).style.display = 'none';
        });

        mini.on('load', () => {
            // Viewport rectangle source
            mini.addSource('viewport-box', {
                type: 'geojson',
                data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[]] }, properties: {} },
            });

            // Fill (more visible for dragging)
            mini.addLayer({
                id: 'viewport-fill',
                type: 'fill',
                source: 'viewport-box',
                paint: {
                    'fill-color': '#22d3ee',
                    'fill-opacity': 0.2,
                },
            });

            // Border
            mini.addLayer({
                id: 'viewport-border',
                type: 'line',
                source: 'viewport-box',
                paint: {
                    'line-color': '#22d3ee',
                    'line-width': 2,
                    'line-opacity': 0.9,
                },
            });

            // Sync viewport rectangle AND mini map center
            const syncBox = () => {
                if (isDragging.current) return; // Don't update while user is dragging
                const src = mini.getSource('viewport-box') as mapboxgl.GeoJSONSource;
                if (!src) return;
                const bounds = mainMap.getBounds();
                if (!bounds) return;
                const sw = bounds.getSouthWest();
                const ne = bounds.getNorthEast();
                src.setData({
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [sw.lng, sw.lat],
                            [ne.lng, sw.lat],
                            [ne.lng, ne.lat],
                            [sw.lng, ne.lat],
                            [sw.lng, sw.lat],
                        ]],
                    },
                });

            };

            syncBox();
            mainMap.on('move', syncBox);

            // ── Interactive: click/tap/drag to move main map ──
            const container = mini.getContainer();
            let startPos: { x: number; y: number } | null = null;

            const getGeoFromEvent = (e: MouseEvent | Touch) => {
                const rect = container.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                return mini.unproject([x, y]);
            };

            const moveMainMap = (e: MouseEvent | Touch) => {
                const lngLat = getGeoFromEvent(e);
                mainMap.setCenter([lngLat.lng, lngLat.lat]);
            };

            // Mouse events
            const onMouseDown = (e: MouseEvent) => {
                isDragging.current = true;
                startPos = { x: e.clientX, y: e.clientY };
                moveMainMap(e);
                container.style.cursor = 'grabbing';
            };
            const onMouseMove = (e: MouseEvent) => {
                if (!isDragging.current) return;
                moveMainMap(e);
            };
            const onMouseUp = () => {
                isDragging.current = false;
                container.style.cursor = 'pointer';
                // Sync the box back after drag
                setTimeout(syncBox, 50);
            };

            // Touch events
            const onTouchStart = (e: TouchEvent) => {
                if (e.touches.length !== 1) return;
                isDragging.current = true;
                const t = e.touches[0];
                startPos = { x: t.clientX, y: t.clientY };
                moveMainMap(t);
            };
            const onTouchMove = (e: TouchEvent) => {
                if (!isDragging.current || e.touches.length !== 1) return;
                e.preventDefault(); // Prevent page scroll
                moveMainMap(e.touches[0]);
            };
            const onTouchEnd = () => {
                isDragging.current = false;
                setTimeout(syncBox, 50);
            };

            container.style.cursor = 'pointer';
            container.addEventListener('mousedown', onMouseDown);
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
            container.addEventListener('touchstart', onTouchStart, { passive: false });
            container.addEventListener('touchmove', onTouchMove, { passive: false });
            container.addEventListener('touchend', onTouchEnd);

            mini.once('remove', () => {
                mainMap.off('move', syncBox);
                container.removeEventListener('mousedown', onMouseDown);
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                container.removeEventListener('touchstart', onTouchStart);
                container.removeEventListener('touchmove', onTouchMove);
                container.removeEventListener('touchend', onTouchEnd);
            });
        });

        return () => {
            mini.remove();
            miniMapRef.current = null;
        };
    }, [mainMap, mapboxToken]);

    return (
        <div
            ref={containerRef}
            style={{
                position: 'absolute',
                bottom: 100,
                left: 12,
                width: 180,
                height: 90,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1.5px solid rgba(255,255,255,0.12)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                zIndex: 500, // Above velocity particles (z-400)
                touchAction: 'none', // Prevent browser gestures on the mini map
            }}
        />
    );
};
