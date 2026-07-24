import type { VoyagePlan } from '../../types';
import type { RouteOrTrack } from './RoutesAndTracks';
import { sanitizeRouteCoordinates, type RouteCoordinate } from '../../utils/routeCoordinates';

export interface FollowRoutePlanInput {
    label?: string;
    points: readonly RouteCoordinate[];
    distanceNm?: number;
    durationHours?: number;
    timestamp?: number | string;
}

function routeNames(label: string | undefined): { origin: string; destination: string } {
    const [rawOrigin, ...rawDestination] = (label ?? '').split('→');
    const origin = rawOrigin?.trim() || 'Departure';
    const destination = rawDestination.join('→').trim() || 'Destination';
    return { origin, destination };
}

/**
 * Build the lightweight VoyagePlan required by follow mode while preserving
 * the exact saved polyline separately. Dense route points deliberately do not
 * become thousands of "waypoint" markers.
 */
export function buildFollowRoutePlan(input: FollowRoutePlanInput): VoyagePlan | null {
    const points = sanitizeRouteCoordinates(input.points);
    if (points.length < 2) return null;

    const { origin, destination } = routeNames(input.label);
    const rawDeparture = input.timestamp == null ? new Date() : new Date(input.timestamp);
    const departureDate = Number.isFinite(rawDeparture.getTime())
        ? rawDeparture.toISOString()
        : new Date().toISOString();
    const distanceNm = Number.isFinite(input.distanceNm) ? Math.max(0, input.distanceNm ?? 0) : 0;
    const durationHours =
        Number.isFinite(input.durationHours) && (input.durationHours ?? 0) > 0 ? input.durationHours : undefined;

    return {
        origin,
        destination,
        departureDate,
        originCoordinates: points[0],
        destinationCoordinates: points[points.length - 1],
        waypoints: [],
        distanceApprox: `${distanceNm.toFixed(1)} NM`,
        durationApprox: durationHours ? `${durationHours.toFixed(1)} hours` : '',
        overview: `Following ${origin} to ${destination}`,
        routeGeoJSON: {
            type: 'Feature',
            properties: { _source: 'saved-logbook-route' },
            geometry: {
                type: 'LineString',
                coordinates: points.map((point) => [point.lon, point.lat]),
            },
        },
    };
}

export function buildFollowRoutePlanFromRoute(route: RouteOrTrack): VoyagePlan | null {
    return buildFollowRoutePlan({
        label: route.label,
        points: route.points,
        distanceNm: route.distanceNm,
        durationHours: route.durationHours,
        timestamp: route.timestamp,
    });
}
