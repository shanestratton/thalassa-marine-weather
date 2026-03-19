/**
 * useChokepointLayer — Global Hotspot Overlay
 *
 * Toggleable overlay for major maritime chokepoints:
 *   - Strait of Hormuz
 *   - Bab el-Mandeb
 *   - Panama Canal
 *
 * Features:
 *   - Zone polygons with gradient fills
 *   - "Dark" vessel detection (no AIS update >4hrs)
 *   - Vessel count badges per zone
 */
import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { supabase } from '../../services/supabase';

// ── Chokepoint definitions ──────────────────────────────────────

interface Chokepoint {
    id: string;
    name: string;
    center: [number, number]; // [lon, lat]
    zoom: number;
    color: string;
    polygon: [number, number][]; // Simplified zone boundary
}

const CHOKEPOINTS: Chokepoint[] = [
    {
        id: 'hormuz',
        name: 'Strait of Hormuz',
        center: [56.25, 26.56],
        zoom: 8,
        color: '#ef4444', // red
        polygon: [
            [55.5, 27.0],
            [57.2, 27.0],
            [57.2, 25.8],
            [56.5, 25.5],
            [55.0, 26.0],
            [55.5, 27.0],
        ],
    },
    {
        id: 'bab-el-mandeb',
        name: 'Bab el-Mandeb',
        center: [43.33, 12.58],
        zoom: 8,
        color: '#f59e0b', // amber
        polygon: [
            [42.5, 13.2],
            [44.0, 13.2],
            [44.0, 11.8],
            [43.0, 11.5],
            [42.0, 12.0],
            [42.5, 13.2],
        ],
    },
    {
        id: 'panama',
        name: 'Panama Canal',
        center: [-79.68, 9.08],
        zoom: 9,
        color: '#22c55e', // green
        polygon: [
            [-80.2, 9.5],
            [-79.2, 9.5],
            [-79.2, 8.7],
            [-79.5, 8.5],
            [-80.2, 8.7],
            [-80.2, 9.5],
        ],
    },
];

const SOURCE_PREFIX = 'chokepoint-zone-';
const DARK_SOURCE = 'chokepoint-dark-vessels';
const DARK_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

export function useChokepointLayer(map: mapboxgl.Map | null, enabled: boolean): void {
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const fetchedRef = useRef(false);

    // Add zone layers
    const addZoneLayers = useCallback(() => {
        if (!map) return;

        for (const cp of CHOKEPOINTS) {
            const sourceId = `${SOURCE_PREFIX}${cp.id}`;
            const fillId = `${sourceId}-fill`;
            const lineId = `${sourceId}-line`;

            // Skip if already added
            if (map.getSource(sourceId)) continue;

            map.addSource(sourceId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [cp.polygon],
                    },
                    properties: { name: cp.name },
                },
            });

            map.addLayer({
                id: fillId,
                type: 'fill',
                source: sourceId,
                paint: {
                    'fill-color': cp.color,
                    'fill-opacity': 0.08,
                },
            });

            map.addLayer({
                id: lineId,
                type: 'line',
                source: sourceId,
                paint: {
                    'line-color': cp.color,
                    'line-width': 2,
                    'line-opacity': 0.4,
                    'line-dasharray': [4, 4],
                },
            });

            // Label marker
            const el = document.createElement('div');
            el.style.cssText = `
                padding: 4px 10px;
                background: rgba(15,23,42,0.9);
                border: 1px solid ${cp.color}40;
                border-radius: 8px;
                color: ${cp.color};
                font-size: 10px;
                font-weight: 800;
                letter-spacing: 0.5px;
                white-space: nowrap;
                pointer-events: none;
                text-transform: uppercase;
                backdrop-filter: blur(8px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            `;
            el.textContent = cp.name;

            const marker = new mapboxgl.Marker({
                element: el,
                anchor: 'center',
            })
                .setLngLat(cp.center)
                .addTo(map);

            markersRef.current.push(marker);
        }

        // Dark vessels source
        if (!map.getSource(DARK_SOURCE)) {
            map.addSource(DARK_SOURCE, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            // Dark vessel pulse circles
            map.addLayer({
                id: `${DARK_SOURCE}-pulse`,
                type: 'circle',
                source: DARK_SOURCE,
                paint: {
                    'circle-radius': 8,
                    'circle-color': '#ef4444',
                    'circle-opacity': 0.6,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ef4444',
                    'circle-stroke-opacity': 0.3,
                },
            });

            // Dark vessel labels
            map.addLayer({
                id: `${DARK_SOURCE}-label`,
                type: 'symbol',
                source: DARK_SOURCE,
                layout: {
                    'text-field': ['get', 'label'],
                    'text-size': 9,
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                },
                paint: {
                    'text-color': '#ef4444',
                    'text-halo-color': 'rgba(0,0,0,0.8)',
                    'text-halo-width': 1,
                },
            });
        }
    }, [map]);

    // Fetch dark vessels in chokepoint zones
    const fetchDarkVessels = useCallback(async () => {
        if (!map || !supabase || fetchedRef.current) return;
        fetchedRef.current = true;

        try {
            const cutoff = new Date(Date.now() - DARK_THRESHOLD_MS).toISOString();

            // Query vessels that haven't updated recently (dark vessels)
            const { data, error } = await supabase
                .from('vessels')
                .select('mmsi, name, lat, lon, updated_at, ship_type')
                .lt('updated_at', cutoff)
                .not('lat', 'is', null)
                .not('lon', 'is', null)
                .limit(200);

            if (error || !data) return;

            // Filter to only vessels within chokepoint zones
            const darkFeatures: GeoJSON.Feature[] = [];

            for (const v of data) {
                if (!v.lat || !v.lon) continue;

                // Check if vessel is within any chokepoint zone
                for (const cp of CHOKEPOINTS) {
                    if (isPointInPolygon(v.lon, v.lat, cp.polygon)) {
                        const hoursAgo = Math.floor((Date.now() - new Date(v.updated_at).getTime()) / 3600000);
                        darkFeatures.push({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
                            properties: {
                                mmsi: v.mmsi,
                                name: v.name || `MMSI ${v.mmsi}`,
                                label: `🔴 ${v.name || v.mmsi} (${hoursAgo}h dark)`,
                                zone: cp.id,
                                hoursAgo,
                            },
                        });
                        break;
                    }
                }
            }

            const source = map.getSource(DARK_SOURCE) as mapboxgl.GeoJSONSource;
            if (source) {
                source.setData({ type: 'FeatureCollection', features: darkFeatures });
            }
        } catch (e) {
            console.warn('[Chokepoint] Failed to fetch dark vessels:', e);
        }
    }, [map]);

    // Remove zone layers
    const removeZoneLayers = useCallback(() => {
        if (!map) return;

        for (const cp of CHOKEPOINTS) {
            const sourceId = `${SOURCE_PREFIX}${cp.id}`;
            try {
                if (map.getLayer(`${sourceId}-fill`)) map.removeLayer(`${sourceId}-fill`);
                if (map.getLayer(`${sourceId}-line`)) map.removeLayer(`${sourceId}-line`);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            } catch {
                /* layer might not exist */
            }
        }

        try {
            if (map.getLayer(`${DARK_SOURCE}-pulse`)) map.removeLayer(`${DARK_SOURCE}-pulse`);
            if (map.getLayer(`${DARK_SOURCE}-label`)) map.removeLayer(`${DARK_SOURCE}-label`);
            if (map.getSource(DARK_SOURCE)) map.removeSource(DARK_SOURCE);
        } catch {
            /* source might not exist */
        }

        for (const m of markersRef.current) m.remove();
        markersRef.current = [];
        fetchedRef.current = false;
    }, [map]);

    // Toggle based on enabled state
    useEffect(() => {
        if (!map) return;

        if (enabled) {
            addZoneLayers();
            fetchDarkVessels();
        } else {
            removeZoneLayers();
        }

        return () => {
            if (enabled) removeZoneLayers();
        };
    }, [map, enabled, addZoneLayers, removeZoneLayers, fetchDarkVessels]);
}

// ── Helpers ─────────────────────────────────────────────────────

function isPointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0],
            yi = polygon[i][1];
        const xj = polygon[j][0],
            yj = polygon[j][1];
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}
