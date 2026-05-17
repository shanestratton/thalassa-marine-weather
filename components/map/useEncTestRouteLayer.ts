/**
 * useEncTestRouteLayer — renders a single LineString on the Mapbox map for
 * the on-chart "Plan ENC Route" demo button. Independent of the passage-
 * planner pipeline so we can demo `tryInshoreRoute` straight from the chart
 * view without booting the planner UI.
 *
 * Idempotent: re-renders the source data on every polyline change, only adds
 * the source/layer once.
 */
import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('useEncTestRouteLayer');

const SOURCE_ID = 'thalassa-enc-test-route';
const LINE_LAYER_ID = 'thalassa-enc-test-route-line';
const CAUTION_LAYER_ID = 'thalassa-enc-test-route-caution';

export interface EncTestRoute {
    /** lon, lat — GeoJSON convention */
    polyline: [number, number][];
    /** length polyline.length - 1; true segments are flagged shallow */
    cautionMask?: boolean[];
}

export function useEncTestRouteLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    route: EncTestRoute | null,
): void {
    const mountedRef = useRef(false);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        const featureCollection = (r: EncTestRoute | null): GeoJSON.FeatureCollection => {
            if (!r || r.polyline.length < 2) {
                return { type: 'FeatureCollection', features: [] };
            }
            const features: GeoJSON.Feature[] = [];
            // Walk segment-by-segment so caution segments can render as their own colour.
            for (let i = 1; i < r.polyline.length; i++) {
                const caution = r.cautionMask?.[i - 1] === true;
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [r.polyline[i - 1], r.polyline[i]],
                    },
                    properties: { caution },
                });
            }
            return { type: 'FeatureCollection', features };
        };

        const data = featureCollection(route);

        if (!mountedRef.current) {
            try {
                if (!map.getSource(SOURCE_ID)) {
                    map.addSource(SOURCE_ID, { type: 'geojson', data });
                }
                if (!map.getLayer(LINE_LAYER_ID)) {
                    map.addLayer({
                        id: LINE_LAYER_ID,
                        type: 'line',
                        source: SOURCE_ID,
                        filter: ['!=', ['get', 'caution'], true],
                        paint: {
                            'line-color': '#a78bfa', // violet — matches FAB ENC accent
                            'line-width': 4,
                            'line-opacity': 0.9,
                        },
                    });
                }
                if (!map.getLayer(CAUTION_LAYER_ID)) {
                    map.addLayer({
                        id: CAUTION_LAYER_ID,
                        type: 'line',
                        source: SOURCE_ID,
                        filter: ['==', ['get', 'caution'], true],
                        paint: {
                            'line-color': '#f87171', // red — caution segments
                            'line-width': 4,
                            'line-dasharray': [2, 2],
                            'line-opacity': 0.9,
                        },
                    });
                }
                mountedRef.current = true;
            } catch (err) {
                log.warn('mount failed', err);
                return;
            }
        } else {
            const src = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
            if (src) src.setData(data);
        }
    }, [mapRef, mapReady, route]);

    // Cleanup on full unmount (rare — MapHub stays mounted for the session).
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            if (!map || !mountedRef.current) return;
            try {
                if (map.getLayer(CAUTION_LAYER_ID)) map.removeLayer(CAUTION_LAYER_ID);
                if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            } catch {
                // Map may already be torn down on app exit — ignore.
            }
            mountedRef.current = false;
        };
    }, [mapRef]);
}
