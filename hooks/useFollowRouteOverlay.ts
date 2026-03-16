/**
 * useFollowRouteOverlay — Renders the "Follow Route" polyline(s) on a Leaflet map.
 *
 * When following a route:
 * - Draws the active route as a dashed sky-blue polyline
 * - If route has changed, also draws the previous route as a gray dashed line
 * - Adds waypoint circle markers along the route
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useFollowRoute } from '../context/FollowRouteContext';

export const useFollowRouteOverlay = (
    mapInstance: React.MutableRefObject<L.Map | null>,
    enabled: boolean = true,
) => {
    const { isFollowing, routeCoords, previousRouteCoords, voyagePlan } = useFollowRoute();
    const activeLineRef = useRef<L.Polyline | null>(null);
    const previousLineRef = useRef<L.Polyline | null>(null);
    const markersRef = useRef<L.LayerGroup | null>(null);

    useEffect(() => {
        const map = mapInstance.current;

        // Clean up previous layers
        const cleanup = () => {
            if (activeLineRef.current && map) {
                map.removeLayer(activeLineRef.current);
                activeLineRef.current = null;
            }
            if (previousLineRef.current && map) {
                map.removeLayer(previousLineRef.current);
                previousLineRef.current = null;
            }
            if (markersRef.current && map) {
                map.removeLayer(markersRef.current);
                markersRef.current = null;
            }
        };

        cleanup();

        if (!map || !isFollowing || !enabled || routeCoords.length < 2) return;

        // 1. Draw previous route (gray, if changed)
        if (previousRouteCoords.length >= 2) {
            previousLineRef.current = L.polyline(
                previousRouteCoords.map((c) => [c.lat, c.lon] as L.LatLngExpression),
                {
                    color: '#94a3b8',       // slate-400
                    weight: 3,
                    opacity: 0.5,
                    dashArray: '8, 8',
                    lineCap: 'round',
                    lineJoin: 'round',
                },
            ).addTo(map);
        }

        // 2. Draw active route (sky-blue dashed line)
        activeLineRef.current = L.polyline(
            routeCoords.map((c) => [c.lat, c.lon] as L.LatLngExpression),
            {
                color: '#38bdf8',           // sky-400
                weight: 3.5,
                opacity: 0.85,
                dashArray: '10, 6',
                lineCap: 'round',
                lineJoin: 'round',
            },
        ).addTo(map);

        // 3. Add waypoint markers (origin, destination, plus plan waypoints)
        markersRef.current = L.layerGroup().addTo(map);

        if (voyagePlan) {
            const allPoints: { lat: number; lon: number; label: string }[] = [];

            if (voyagePlan.originCoordinates) {
                allPoints.push({
                    ...voyagePlan.originCoordinates,
                    label: voyagePlan.origin?.split(',')[0] || 'DEP',
                });
            }

            if (voyagePlan.waypoints) {
                voyagePlan.waypoints.forEach((wp, i) => {
                    if (wp?.coordinates) {
                        allPoints.push({
                            ...wp.coordinates,
                            label: wp.name || `WP${i + 1}`,
                        });
                    }
                });
            }

            if (voyagePlan.destinationCoordinates) {
                allPoints.push({
                    ...voyagePlan.destinationCoordinates,
                    label: voyagePlan.destination?.split(',')[0] || 'ARR',
                });
            }

            allPoints.forEach((pt, i) => {
                const isEndpoint = i === 0 || i === allPoints.length - 1;
                const marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: isEndpoint ? 7 : 5,
                    fillColor: isEndpoint ? '#38bdf8' : '#a78bfa',
                    fillOpacity: 0.9,
                    color: '#ffffff',
                    weight: 2,
                    opacity: 0.8,
                });

                marker.bindTooltip(pt.label, {
                    direction: 'top',
                    offset: [0, -10],
                    className: 'follow-route-tooltip',
                    permanent: false,
                });

                markersRef.current?.addLayer(marker);
            });
        }

        return cleanup;
    }, [mapInstance.current, isFollowing, enabled, routeCoords, previousRouteCoords, voyagePlan]);
};
