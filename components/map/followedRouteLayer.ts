import L from 'leaflet';
import { sanitizeRouteCoordinates, type RouteCoordinate } from '../../utils/routeCoordinates';

export const FOLLOWED_ROUTE_GLOW = '#a78bfa';
export const FOLLOWED_ROUTE_CORE = '#c4b5fd';
export const FOLLOWED_ROUTE_PANE = 'followed-route-pane';

/**
 * Draw the route currently being followed beneath the recorded vessel track.
 * The returned coordinates are the sanitized geometry used by Leaflet and can
 * be included in the caller's fit bounds.
 */
export function addFollowedRouteLayer(
    layerGroup: L.LayerGroup,
    coordinates: readonly RouteCoordinate[] | null | undefined,
): [number, number][] {
    const route = sanitizeRouteCoordinates(coordinates).map(
        (coordinate) => [coordinate.lat, coordinate.lon] as [number, number],
    );
    if (route.length < 2) return route;

    L.polyline(route, {
        pane: FOLLOWED_ROUTE_PANE,
        color: FOLLOWED_ROUTE_GLOW,
        weight: 10,
        opacity: 0.28,
        lineCap: 'round',
        lineJoin: 'round',
    }).addTo(layerGroup);
    L.polyline(route, {
        pane: FOLLOWED_ROUTE_PANE,
        color: FOLLOWED_ROUTE_CORE,
        weight: 3,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
    }).addTo(layerGroup);

    return route;
}
