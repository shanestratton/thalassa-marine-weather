/**
 * Isochrone Router — Turn waypoint detection and GeoJSON output.
 */

import type { IsochroneNode, IsochroneResult, TurnWaypoint } from './types';
import { bearingBetween } from './geodesy';

/**
 * Detect significant course changes in a route to produce turn-by-turn waypoints.
 *
 * Walks the IsochroneNode array looking for bearing deltas > threshold.
 * Includes departure and arrival as first/last waypoints.
 *
 * @param route          IsochroneNode[] from IsochroneResult.route
 * @param departureTime  ISO string for departure time
 * @param threshold      Minimum bearing change in degrees to register a waypoint (default: 15)
 */
export function detectTurnWaypoints(
    route: IsochroneNode[],
    departureTime: string,
    threshold: number = 15,
): TurnWaypoint[] {
    if (route.length < 2) return [];

    const depTime = new Date(departureTime).getTime();
    const waypoints: TurnWaypoint[] = [];
    let wpNumber = 0;

    // Always include departure as first waypoint
    const first = route[0];
    waypoints.push({
        id: 'DEP',
        lat: first.lat,
        lon: first.lon,
        bearingChange: 0,
        bearing: first.bearing,
        timeHours: 0,
        distanceNM: 0,
        speed: first.speed,
        tws: first.tws,
        twa: first.twa,
        eta: departureTime,
    });

    // Walk route looking for significant bearing changes
    for (let i = 1; i < route.length - 1; i++) {
        const prev = route[i - 1];
        const curr = route[i];
        const next = route[i + 1];

        const bearingIn = bearingBetween(prev.lat, prev.lon, curr.lat, curr.lon);
        const bearingOut = bearingBetween(curr.lat, curr.lon, next.lat, next.lon);

        let delta = bearingOut - bearingIn;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;

        if (Math.abs(delta) >= threshold) {
            wpNumber++;
            waypoints.push({
                id: `WP${wpNumber}`,
                lat: curr.lat,
                lon: curr.lon,
                bearingChange: Math.round(delta),
                bearing: Math.round(bearingOut),
                timeHours: curr.timeHours,
                distanceNM: Math.round(curr.distance * 10) / 10,
                speed: curr.speed,
                tws: curr.tws,
                twa: curr.twa,
                eta: new Date(depTime + curr.timeHours * 3600_000).toISOString(),
            });
        }
    }

    // Always include arrival as last waypoint
    const last = route[route.length - 1];
    waypoints.push({
        id: 'ARR',
        lat: last.lat,
        lon: last.lon,
        bearingChange: 0,
        bearing: last.bearing,
        timeHours: last.timeHours,
        distanceNM: Math.round(last.distance * 10) / 10,
        speed: last.speed,
        tws: last.tws,
        twa: last.twa,
        eta: new Date(depTime + last.timeHours * 3600_000).toISOString(),
    });

    return waypoints;
}

/**
 * Convert isochrone result to GeoJSON for Mapbox rendering.
 * Returns both the optimal route line and the isochrone wavefront polygons.
 */
export function isochroneToGeoJSON(result: IsochroneResult): {
    route: GeoJSON.Feature<GeoJSON.LineString>;
    wavefronts: GeoJSON.FeatureCollection;
} {
    // Optimal route as LineString
    const route: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {
            type: 'isochrone_route',
            totalNM: result.totalDistanceNM,
            durationHours: result.totalDurationHours,
        },
        geometry: {
            type: 'LineString',
            coordinates: result.routeCoordinates,
        },
    };

    // Wavefront polygons (connect nodes in each isochrone)
    const features: GeoJSON.Feature[] = result.isochrones
        .filter((iso) => iso.nodes.length >= 3)
        .map((iso) => {
            const coords = iso.nodes.map((n) => [n.lon, n.lat] as [number, number]);
            // Close the polygon
            if (coords.length > 0) coords.push(coords[0]);

            return {
                type: 'Feature' as const,
                properties: {
                    type: 'isochrone_wavefront',
                    timeHours: iso.timeHours,
                    nodeCount: iso.nodes.length,
                },
                geometry: {
                    type: 'LineString' as const,
                    coordinates: coords,
                },
            };
        });

    return {
        route,
        wavefronts: {
            type: 'FeatureCollection',
            features,
        },
    };
}
