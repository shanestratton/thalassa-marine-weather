/**
 * Bathymetric Routing Service
 *
 * Client-side interface to the route-bathymetric Supabase Edge Function.
 * Fetches depth-safe waypoints via OSM graph Dijkstra routing,
 * then merges them into the AI-generated VoyagePlan.
 *
 * The edge function returns:
 *   - waypoints: detailed route waypoints with depth/safety
 *   - geojson: full LineString for backwards-compat rendering
 *   - trafficGeoJSON: segmented FeatureCollection for traffic light rendering
 */

import { VoyagePlan, Waypoint, VesselProfile } from '../types';

// ── Types ─────────────────────────────────────────────────────────

interface BathymetricRequest {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    via?: { lat: number; lon: number };
    vessel_draft: number;
    region?: string;
}

interface BathymetricWaypoint {
    lat: number;
    lon: number;
    name: string;
    depth_m?: number | null;
    safety?: 'safe' | 'caution' | 'danger';
}

interface BathymetricResponse {
    waypoints: BathymetricWaypoint[];
    totalNM: number;
    elapsed_ms: number;
    router: string;
    region: string;
    vessel_draft: number;
    safety?: {
        safe: number;
        caution: number;
        danger: number;
    };
    /** Full route as a single GeoJSON LineString */
    geojson?: GeoJSON.Feature<GeoJSON.LineString>;
    /** Traffic light segmented FeatureCollection (green/orange/red) */
    trafficGeoJSON?: GeoJSON.FeatureCollection<GeoJSON.LineString>;
}

// ── Service ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL)
    || 'https://pcisdplnodrphauixcau.supabase.co';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

/**
 * Fetch bathymetric-safe waypoints using the client-side Route Orchestrator.
 *
 * Uses geofence-based routing:
 *   - Marina zones → Turf.js grid router (10m resolution)
 *   - River/open water → OfflineRouter (OSM graph A* with bathymetry penalties)
 *
 * Returns null if routing fails (non-critical — AI voyage plan still works).
 */
export async function fetchBathymetricRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    vesselDraft: number = 2.5,
    via?: { lat: number; lon: number },
    region?: string,
): Promise<BathymetricResponse | null> {
    try {
        console.log(`[BathyRouter] Requesting route: ${origin.lat.toFixed(2)},${origin.lon.toFixed(2)} → ${destination.lat.toFixed(2)},${destination.lon.toFixed(2)}`);

        const { orchestrateRoute } = await import('./RouteOrchestrator');

        const result = await orchestrateRoute(
            origin.lat, origin.lon,
            destination.lat, destination.lon,
            vesselDraft,
            region || 'se_queensland',
        );

        if (!result) {
            console.warn('[BathyRouter] Orchestrator returned no route');
            return null;
        }

        // Convert orchestrator result to BathymetricResponse interface
        const waypoints: BathymetricWaypoint[] = result.coordinates.map((coord, i) => ({
            lat: coord[1],
            lon: coord[0],
            name: `WP-${String(i + 1).padStart(3, '0')}`,
            depth_m: null,
            safety: 'safe' as const,
        }));

        const response: BathymetricResponse = {
            waypoints,
            totalNM: result.totalNM,
            elapsed_ms: result.computeMs,
            router: `orchestrator:${result.engines.join('+')}`,
            region: region || 'australia_se_qld',
            vessel_draft: vesselDraft,
            geojson: result.geojson,
        };

        console.log(`[BathyRouter] ✓ ${waypoints.length} waypoints, ${result.totalNM} NM, ${result.computeMs}ms [${result.engines.join(' → ')}]`);
        return response;

    } catch (err) {
        console.error('[BathyRouter] Orchestrator error:', err);
        return null;
    }
}

/**
 * Merge bathymetric route into an AI-generated VoyagePlan.
 *
 * Strategy:
 * - Replace AI waypoint coordinates with the detailed graph route
 * - Store the full GeoJSON for direct Mapbox rendering
 * - The trafficGeoJSON provides traffic-light colored segments
 */
export function mergeBathymetricRoute(
    voyagePlan: VoyagePlan,
    bathyRoute: BathymetricResponse,
): VoyagePlan {
    const merged = { ...voyagePlan };

    // ── Store full waypoints from graph routing ──
    // These include 100s of points following the actual waterway
    const newWaypoints: Waypoint[] = bathyRoute.waypoints.map((bwp, i) => {
        // Find closest AI waypoint for weather data
        const aiWaypoints = voyagePlan.waypoints || [];
        let closestAI: Waypoint | undefined;
        let closestDist = Infinity;

        for (const awp of aiWaypoints) {
            if (awp.coordinates) {
                const dist = Math.hypot(
                    awp.coordinates.lat - bwp.lat,
                    awp.coordinates.lon - bwp.lon,
                );
                if (dist < closestDist) {
                    closestDist = dist;
                    closestAI = awp;
                }
            }
        }

        return {
            name: bwp.name || `WP-${String(i + 1).padStart(2, '0')}`,
            coordinates: { lat: bwp.lat, lon: bwp.lon },
            depth_m: bwp.depth_m ?? undefined,
            safety: bwp.safety,
            windSpeed: closestAI?.windSpeed,
            waveHeight: closestAI?.waveHeight,
        };
    });

    merged.waypoints = newWaypoints;

    // ── Store the full GeoJSON from the edge function ──
    // This is the key fix: the geojson has ALL graph waypoints
    // so the map renders smooth curves following waterways
    if (bathyRoute.geojson) {
        (merged as any).routeGeoJSON = bathyRoute.geojson;
    }
    if (bathyRoute.trafficGeoJSON) {
        (merged as any).trafficGeoJSON = bathyRoute.trafficGeoJSON;
    }

    // ── Update metadata ──
    merged.distanceApprox = `${bathyRoute.totalNM} NM`;
    if (bathyRoute.safety) {
        (merged as any).safety = bathyRoute.safety;
    }

    return merged;
}

/**
 * Convenience: fetch bathymetric route and merge into voyage plan.
 * Non-blocking — returns original plan if routing fails.
 */
export async function enhanceVoyagePlanWithBathymetry(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
): Promise<VoyagePlan> {
    if (!voyagePlan.originCoordinates || !voyagePlan.destinationCoordinates) {
        console.warn('[BathyRouter] Missing coordinates — cannot route');
        return voyagePlan;
    }

    const draft = vessel.draft ?? 2.5;

    const bathyRoute = await fetchBathymetricRoute(
        voyagePlan.originCoordinates,
        voyagePlan.destinationCoordinates,
        draft,
        undefined,
        'australia_se_qld',
    );

    if (!bathyRoute) {
        console.warn('[BathyRouter] Routing unavailable — using AI waypoints');
        return voyagePlan;
    }

    return mergeBathymetricRoute(voyagePlan, bathyRoute);
}
