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
const DIRECTIONS_TIMEOUT_MS = 15_000;

function isValidCoordinate(point: { lat: number; lon: number }): boolean {
    return (
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lat) <= 90 &&
        Math.abs(point.lon) <= 180
    );
}

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
    if (!isValidCoordinate(origin) || !isValidCoordinate(destination)) {
        log.warn('Directions requested with invalid coordinates');
        return null;
    }

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

    let res: Response;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(DIRECTIONS_TIMEOUT_MS) });
    } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
            throw new Error('Mapbox Directions timed out — check your connection and try again.');
        }
        throw error;
    }
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

/**
 * One-shot helper: directions coords in, complete VoyagePlan out.
 * Lets any component with origin + destination coords hand off
 * straight to saveVoyagePlan() + navigate to the map. Used by:
 *   - useVoyageForm.handleRoadDirections (text-input route planner)
 *   - PinMapViewer (Scuttlebutt POI → Get Directions)
 *
 * Returns null on no-route / token-missing. Caller decides UI.
 */
export async function buildDirectionsVoyagePlan(
    origin: { lat: number; lon: number; name?: string },
    destination: { lat: number; lon: number; name?: string },
    profile: DirectionsProfile = 'driving',
): Promise<import('../types').VoyagePlan | null> {
    const result = await getDirections(origin, destination, { profile });
    if (!result) return null;

    const distanceKm = result.distanceMeters / 1000;
    const distanceNM = distanceKm * 0.539957;
    const durationMin = Math.round(result.durationSeconds / 60);
    const durationStr =
        durationMin < 60 ? `${durationMin} min` : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;
    const transportLabel = profile === 'walking' ? 'Walking' : profile === 'cycling' ? 'Cycling' : 'Driving';

    const originLabel = origin.name || `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
    const destLabel = destination.name || `${destination.lat.toFixed(4)}, ${destination.lon.toFixed(4)}`;

    return {
        origin: originLabel,
        destination: destLabel,
        departureDate: new Date().toISOString(),
        originCoordinates: { lat: origin.lat, lon: origin.lon },
        destinationCoordinates: { lat: destination.lat, lon: destination.lon },
        distanceApprox: `${distanceKm.toFixed(1)} km · ${distanceNM.toFixed(1)} NM`,
        durationApprox: durationStr,
        overview: `${transportLabel} directions via Mapbox.`,
        waypoints: [
            { name: originLabel, coordinates: { lat: origin.lat, lon: origin.lon } },
            ...result.waypoints.map((w, i) => ({
                name: `Turn ${i + 1}`,
                coordinates: { lat: w.lat, lon: w.lon },
            })),
            { name: destLabel, coordinates: { lat: destination.lat, lon: destination.lon } },
        ],
        routeGeoJSON: directionsToGeoJSON(result.polyline),
        routeReasoning: `${transportLabel} route from Mapbox Directions, ${result.waypoints.length} auto-waypoint${
            result.waypoints.length === 1 ? '' : 's'
        } at significant turns.`,
    };
}
