/**
 * useFollowRouteMapbox — Renders the "Follow Route" polyline(s) on a Mapbox GL map.
 *
 * Companion to useFollowRouteOverlay (Leaflet) — this one is for the MapHub
 * which uses Mapbox GL JS.
 *
 * When following a route:
 * - Draws the active route as a dashed sky-blue line
 * - If route has changed, also draws the previous route as a gray dashed line
 * - Adds waypoint circle markers along the route
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { useFollowRoute } from '../context/FollowRouteContext';

const SOURCE_ACTIVE = 'follow-route-active';
const SOURCE_PREVIOUS = 'follow-route-previous';
const SOURCE_MARKERS = 'follow-route-markers';
const LAYER_ACTIVE = 'follow-route-active-line';
const LAYER_PREVIOUS = 'follow-route-previous-line';
const LAYER_MARKERS = 'follow-route-markers-circle';
const LAYER_MARKER_LABELS = 'follow-route-markers-labels';

export const useFollowRouteMapbox = (
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
) => {
    const { isFollowing, routeCoords, previousRouteCoords, voyagePlan } = useFollowRoute();
    const addedRef = useRef(false);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Clean up any existing layers/sources
        const cleanup = () => {
            [LAYER_MARKER_LABELS, LAYER_MARKERS, LAYER_ACTIVE, LAYER_PREVIOUS].forEach((id) => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            [SOURCE_ACTIVE, SOURCE_PREVIOUS, SOURCE_MARKERS].forEach((id) => {
                if (map.getSource(id)) map.removeSource(id);
            });
            addedRef.current = false;
        };

        cleanup();

        if (!isFollowing || routeCoords.length < 2) return;

        // Build GeoJSON for the active route
        const activeGeoJSON: GeoJSON.Feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: routeCoords.map((c) => [c.lon, c.lat]),
            },
        };

        map.addSource(SOURCE_ACTIVE, { type: 'geojson', data: activeGeoJSON });
        map.addLayer({
            id: LAYER_ACTIVE,
            type: 'line',
            source: SOURCE_ACTIVE,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#38bdf8',
                'line-width': 3.5,
                'line-opacity': 0.85,
                'line-dasharray': [2, 1.5],
            },
        });

        // Previous route (if changed)
        if (previousRouteCoords.length >= 2) {
            const prevGeoJSON: GeoJSON.Feature = {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: previousRouteCoords.map((c) => [c.lon, c.lat]),
                },
            };

            map.addSource(SOURCE_PREVIOUS, { type: 'geojson', data: prevGeoJSON });
            map.addLayer(
                {
                    id: LAYER_PREVIOUS,
                    type: 'line',
                    source: SOURCE_PREVIOUS,
                    layout: { 'line-cap': 'round', 'line-join': 'round' },
                    paint: {
                        'line-color': '#94a3b8',
                        'line-width': 2.5,
                        'line-opacity': 0.5,
                        'line-dasharray': [2, 2],
                    },
                },
                LAYER_ACTIVE, // Draw behind the active line
            );
        }

        // Waypoint markers
        if (voyagePlan) {
            const markerFeatures: GeoJSON.Feature[] = [];

            if (voyagePlan.originCoordinates) {
                markerFeatures.push({
                    type: 'Feature',
                    properties: {
                        label: voyagePlan.origin?.split(',')[0] || 'DEP',
                        isEndpoint: true,
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [voyagePlan.originCoordinates.lon, voyagePlan.originCoordinates.lat],
                    },
                });
            }

            if (voyagePlan.waypoints) {
                voyagePlan.waypoints.forEach((wp, i) => {
                    if (wp?.coordinates) {
                        markerFeatures.push({
                            type: 'Feature',
                            properties: {
                                label: wp.name || `WP${i + 1}`,
                                isEndpoint: false,
                            },
                            geometry: {
                                type: 'Point',
                                coordinates: [wp.coordinates.lon, wp.coordinates.lat],
                            },
                        });
                    }
                });
            }

            if (voyagePlan.destinationCoordinates) {
                markerFeatures.push({
                    type: 'Feature',
                    properties: {
                        label: voyagePlan.destination?.split(',')[0] || 'ARR',
                        isEndpoint: true,
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [voyagePlan.destinationCoordinates.lon, voyagePlan.destinationCoordinates.lat],
                    },
                });
            }

            if (markerFeatures.length > 0) {
                map.addSource(SOURCE_MARKERS, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: markerFeatures },
                });

                map.addLayer({
                    id: LAYER_MARKERS,
                    type: 'circle',
                    source: SOURCE_MARKERS,
                    paint: {
                        'circle-radius': ['case', ['get', 'isEndpoint'], 7, 5],
                        'circle-color': ['case', ['get', 'isEndpoint'], '#38bdf8', '#a78bfa'],
                        'circle-stroke-color': '#ffffff',
                        'circle-stroke-width': 2,
                        'circle-opacity': 0.9,
                    },
                });

                map.addLayer({
                    id: LAYER_MARKER_LABELS,
                    type: 'symbol',
                    source: SOURCE_MARKERS,
                    layout: {
                        'text-field': ['get', 'label'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                        'text-anchor': 'bottom',
                        'text-offset': [0, -1],
                    },
                    paint: {
                        'text-color': '#ffffff',
                        'text-halo-color': '#000000',
                        'text-halo-width': 1,
                    },
                });
            }
        }

        addedRef.current = true;
        return cleanup;
    }, [mapRef.current, mapReady, isFollowing, routeCoords, previousRouteCoords, voyagePlan]);
};
