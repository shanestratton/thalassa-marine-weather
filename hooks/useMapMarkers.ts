
import React, { useState, useEffect } from 'react';
import { Waypoint } from '../types';

export const useMapMarkers = (
    mapInstance: React.MutableRefObject<any>,
    centerLat: number,
    centerLon: number,
    rawTargetPos: { lat: number, lon: number } | null,
    routeCoordinates?: { lat: number, lon: number }[],
    waypoints?: Waypoint[]
) => {
    const [vesselPos, setVesselPos] = useState<{ x: number, y: number } | null>(null);
    const [targetPos, setTargetPos] = useState<{ x: number, y: number } | null>(null);
    const [waypointPositions, setWaypointPositions] = useState<{ x: number, y: number, idx: number, name: string, wp: Waypoint }[]>([]);
    const [routePath, setRoutePath] = useState<string>('');

    const updatePositions = () => {
        const map = mapInstance.current;
        if (!map) return;

        // 1. Vessel
        const vPt = map.latLngToContainerPoint([centerLat, centerLon]);
        setVesselPos({ x: vPt.x, y: vPt.y });

        // 2. Target
        if (rawTargetPos) {
            const tPt = map.latLngToContainerPoint([rawTargetPos.lat, rawTargetPos.lon]);
            setTargetPos({ x: tPt.x, y: tPt.y });
        }

        // 3. Route Line
        if (routeCoordinates && routeCoordinates.length > 1) {
            const points = routeCoordinates.map(c => {
                const pt = map.latLngToContainerPoint([c.lat, c.lon]);
                return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
            });
            setRoutePath(`M${points.join('L')}`);
        } else {
            setRoutePath('');
        }

        // 4. Waypoints
        if (waypoints && waypoints.length > 0) {
            const pts = waypoints.map((wp, i) => {
                if (!wp.coordinates) return null;
                const pt = map.latLngToContainerPoint([wp.coordinates.lat, wp.coordinates.lon]);
                return { x: pt.x, y: pt.y, idx: i, name: wp.name, wp };
            }).filter(Boolean) as { x: number; y: number; idx: number; name: string; wp: Waypoint }[];
            setWaypointPositions(pts);
        } else {
            setWaypointPositions([]);
        }
    };

    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;

        let animationFrameId: number;

        const onMapMove = () => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = requestAnimationFrame(updatePositions);
        };

        updatePositions(); // Initial

        map.on('move', onMapMove);
        map.on('zoom', onMapMove);
        map.on('resize', onMapMove);

        return () => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            map.off('move', onMapMove);
            map.off('zoom', onMapMove);
            map.off('resize', onMapMove);
        };
    }, [mapInstance.current, centerLat, centerLon, rawTargetPos, routeCoordinates, waypoints]);

    return { vesselPos, targetPos, routePath, waypointPositions };
};
