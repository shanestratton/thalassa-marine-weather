/**
 * MapboxDirectionsService — road / path-following routing via the
 * Mapbox Directions API.
 *
 * Used when the InshoreRouter and bathymetric paths don't apply —
 * specifically for land routing (directions to a chandlery, customs
 * office, marine store, etc) where you want a Google-Maps-style
 * smooth polyline that hugs roads, not a straight line between two
 * waypoints.
 *
 * Output shape matches InshoreRouter so the same map renderer + the
 * existing detectBends auto-waypoint extractor work without
 * modification:
 *
 *   - polyline: Array<[lon, lat]>   — dense smooth track for the map
 *   - waypoints: Array<{ lat, lon }> — sparse turn points via RDP
 *   - distanceMeters / durationSeconds — Mapbox's estimates
 *
 * The auto-waypoints come from the existing detectBends() helper
 * (services/passage/detectBends.ts) applied to the Mapbox polyline.
 * Bend threshold is tuned looser for land than for water — vehicle
 * routes have lots of sub-100 m direction changes (kerb pulls,
 * roundabouts) that we want to absorb into a single "turn at the
 * intersection" waypoint.
 *
 * Token: reuses VITE_MAPBOX_ACCESS_TOKEN (same one geocoding uses).
 */
import { detectBends } from './passage/detectBends';
import { createLogger } from '../utils/createLogger';

const log = createLogger('MapboxDirections');

export type DirectionsProfile = 'driving' | 'driving-traffic' | 'walking' | 'cycling';

export interface DirectionsOptions {
    profile?: DirectionsProfile;
    /**
     * Bend-detection threshold in degrees. Default 30° for driving
     * (intersection turn) and 45° for walking (looser, since pedestrian
     * paths zigzag through laneways).
     */
    bendThresholdDeg?: number;
    /**
     * Minimum spacing between auto-waypoints, in metres. Default 75m
     * for driving (so we don't double-up on roundabout exits) and
     * 40m for walking.
     */
    minSpacingMeters?: number;
}

export interface DirectionsResult {
    /** [lon, lat] tuples — smooth road-following polyline. */
    polyline: Array<[number, number]>;
    /** Sparse turn-point waypoints (course-change locations only). */
    waypoints: Array<{ lat: number; lon: number; bendDeg: number }>;
    distanceMeters: number;
    durationSeconds: number;
    profile: DirectionsProfile;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined;

/**
 * Fetch a road-following route from Mapbox Directions API.
 *
 * Returns null if no route is possible (e.g. crossing water in
 * `walking` mode, or destination not reachable by road).
 *
 * Throws on transport errors (network, invalid token, 5xx). Callers
 * should catch and surface a friendly error.
 */
export async function getDirections(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    options: DirectionsOptions = {},
): Promise<DirectionsResult | null> {
    if (!MAPBOX_TOKEN) {
        log.warn('VITE_MAPBOX_ACCESS_TOKEN not configured — directions unavailable');
        return null;
    }

    const profile = options.profile ?? 'driving';
    const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
    const url =
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}` +
        `?access_token=${MAPBOX_TOKEN}` +
        `&geometries=geojson` +
        `&overview=full`;

    log.info(`requesting ${profile} route ${coords}`);

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Mapbox Directions HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
        code: string;
        routes?: Array<{
            geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
            distance: number; // metres
            duration: number; // seconds
        }>;
    };

    if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
        log.info(`no route returned — code=${json.code}`);
        return null;
    }

    const route = json.routes[0];
    const polyline = route.geometry.coordinates;

    // ── Auto-waypoint extraction ──
    // Pull "significant turn" points out of the dense polyline using
    // the existing detectBends helper. Defaults tuned for land routes
    // (intersections, exits) — water routes use the inshore router's
    // own waypoint policy.
    const bendThresholdDeg = options.bendThresholdDeg ?? (profile === 'walking' ? 45 : 30);
    const minSpacingMeters = options.minSpacingMeters ?? (profile === 'walking' ? 40 : 75);
    const bends = detectBends(polyline, {
        thresholdDeg: bendThresholdDeg,
        minSpacingNm: minSpacingMeters / 1852, // convert m → nm to match detectBends API
        epsilonMeters: 25, // tight RDP for road geometry — preserves real turns
    });

    return {
        polyline,
        waypoints: bends.map((b) => ({
            lat: b.coordinates.lat,
            lon: b.coordinates.lon,
            bendDeg: b.bendDeg,
        })),
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        profile,
    };
}

/**
 * Convert a Mapbox-style polyline tuple list to a GeoJSON LineString
 * Feature — matches the shape that the existing route renderer
 * (MapHub `route-preview` layer) consumes. Drop-in for InshoreRouter's
 * inshoreRouteToGeoJSON.
 */
export function directionsToGeoJSON(polyline: Array<[number, number]>): GeoJSON.Feature<GeoJSON.LineString> {
    return {
        type: 'Feature',
        properties: { source: 'mapbox-directions' },
        geometry: {
            type: 'LineString',
            coordinates: polyline,
        },
    };
}
