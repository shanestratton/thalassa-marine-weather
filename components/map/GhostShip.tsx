/**
 * GhostShip — Semi-transparent ship icon that interpolates along the
 * passage route as the user scrubs the wind forecast time-slider.
 *
 * Receives the route coordinates and wind hour, computes position
 * by walking route segments based on vessel speed, and renders
 * a rotated SVG Tayana silhouette as a Mapbox marker.
 */

import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { createGhostShipEl } from '../../utils/createMarkerEl';

interface GhostShipProps {
    map: mapboxgl.Map | null;
    /** Route coordinates as [lon, lat][] from the passage planner */
    routeCoords: number[][] | null;
    /** ISO departure time string */
    departureTime: string;
    /** Vessel speed in knots */
    speed: number;
    /** Current wind forecast hour (fractional float from time-slider) */
    windHour: number;
    /** Wind forecast hours array — maps slider index to actual GFS hours */
    windForecastHours: number[];
    /** Index that represents "now" in the wind slider */
    windNowIdx: number;
    /** Whether to show the ghost ship */
    visible: boolean;
}

/** Haversine distance between two [lon, lat] points in nautical miles */
function haversineNM(a: number[], b: number[]): number {
    const R_NM = 3440.065;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return R_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Compute bearing from point a to point b in degrees */
function bearing(a: number[], b: number[]): number {
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Linearly interpolate between two [lon, lat] points */
function lerpCoord(a: number[], b: number[], t: number): number[] {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** SVG sailboat silhouette — pointing UP (north=0°) */
const SHIP_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <!-- Hull -->
  <path d="M8 22 L16 28 L24 22 Z" fill="rgba(255,255,255,0.7)" stroke="rgba(255,255,255,0.9)" stroke-width="0.8"/>
  <!-- Mast -->
  <line x1="16" y1="6" x2="16" y2="22" stroke="rgba(255,255,255,0.8)" stroke-width="1"/>
  <!-- Mainsail -->
  <path d="M16 6 L16 20 L22 18 Z" fill="rgba(100,180,255,0.5)" stroke="rgba(100,180,255,0.7)" stroke-width="0.5"/>
  <!-- Headsail -->
  <path d="M16 6 L16 16 L11 14 Z" fill="rgba(100,180,255,0.4)" stroke="rgba(100,180,255,0.6)" stroke-width="0.5"/>
</svg>`;

/**
 * Interpolate position along route given elapsed time.
 * Returns { coord: [lon, lat], bearing: degrees } or null if off-route.
 */
function interpolateRoute(
    coords: number[][],
    elapsedHours: number,
    speedKts: number,
): { coord: number[]; heading: number } | null {
    if (!coords || coords.length < 2 || elapsedHours < 0) return null;

    const distanceTraveled = elapsedHours * speedKts; // NM
    let accumulated = 0;

    for (let i = 0; i < coords.length - 1; i++) {
        const segDist = haversineNM(coords[i], coords[i + 1]);
        if (accumulated + segDist >= distanceTraveled) {
            // We're within this segment
            const remaining = distanceTraveled - accumulated;
            const t = segDist > 0 ? remaining / segDist : 0;
            const coord = lerpCoord(coords[i], coords[i + 1], Math.max(0, Math.min(1, t)));
            const heading = bearing(coords[i], coords[i + 1]);
            return { coord, heading };
        }
        accumulated += segDist;
    }

    // Past the end — return arrival point
    const last = coords[coords.length - 1];
    const prevLast = coords[coords.length - 2];
    return { coord: last, heading: bearing(prevLast, last) };
}

export function GhostShip({
    map,
    routeCoords,
    departureTime,
    speed,
    windHour,
    windForecastHours,
    windNowIdx,
    visible,
}: GhostShipProps) {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const elRef = useRef<HTMLDivElement | null>(null);

    // Create marker element once
    const getOrCreateMarker = useCallback(() => {
        if (markerRef.current) return markerRef.current;
        if (!map) return null;

        const el = createGhostShipEl(SHIP_SVG);
        elRef.current = el;

        const marker = new mapboxgl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map' })
            .setLngLat([0, 0])
            .addTo(map);
        markerRef.current = marker;
        return marker;
    }, [map]);

    // Update position on windHour change
    useEffect(() => {
        if (!map || !routeCoords || routeCoords.length < 2 || !visible) {
            // Hide marker
            if (elRef.current) elRef.current.style.display = 'none';
            return;
        }

        const marker = getOrCreateMarker();
        if (!marker || !elRef.current) return;

        // Compute elapsed hours since departure
        // windHour is a slider index, windForecastHours maps it to actual GFS forecast hours
        const roundedIdx = Math.round(windHour);
        const actualForecastHour = windForecastHours[roundedIdx] ?? roundedIdx;
        const nowForecastHour = windForecastHours[windNowIdx] ?? 0;
        const hoursFromNow = actualForecastHour - nowForecastHour;

        // Compute elapsed time from departure
        const depTime = departureTime ? new Date(departureTime).getTime() : Date.now();
        const nowMs = Date.now();
        const hoursSinceDeparture = (nowMs - depTime) / 3_600_000;
        const elapsedHours = hoursSinceDeparture + hoursFromNow;

        if (elapsedHours < 0) {
            // Before departure — hide
            elRef.current.style.display = 'none';
            return;
        }

        const result = interpolateRoute(routeCoords, elapsedHours, speed);
        if (!result) {
            elRef.current.style.display = 'none';
            return;
        }

        elRef.current.style.display = '';
        marker.setLngLat([result.coord[0], result.coord[1]]);
        // Rotate the SVG to heading (CSS rotation, clockwise from north)
        elRef.current.style.transform = `rotate(${result.heading}deg)`;
    }, [map, routeCoords, departureTime, speed, windHour, windForecastHours, windNowIdx, visible, getOrCreateMarker]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
            }
        };
    }, []);

    return null; // Renders via Mapbox marker, not React DOM
}
