/**
 * Bathymetric Routing Service
 *
 * Client-side interface to the route-bathymetric Supabase Edge Function.
 * Fetches depth-safe waypoints that avoid land and shallow water,
 * then merges them into the AI-generated VoyagePlan.
 */

import { VoyagePlan, Waypoint, VesselProfile } from '../types';

// ── Types ─────────────────────────────────────────────────────────

interface BathymetricRequest {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    via?: { lat: number; lon: number };
    vessel_draft: number;
}

interface BathymetricWaypoint {
    lat: number;
    lon: number;
    name: string;
    depth_m?: number;
}

interface BathymetricResponse {
    waypoints: BathymetricWaypoint[];
    distance_nm: number;
    computation_ms: number;
    routing_mode: 'stitched' | 'direct';
    route_reasoning: string;
    error?: string;
}

// ── Service ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

/**
 * Fetch bathymetric-safe waypoints from the edge function.
 *
 * Returns null if the service is unavailable (non-critical — the AI
 * voyage plan still works without it, just with less accurate routing).
 */
export async function fetchBathymetricRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    vesselDraft: number = 2.5,
    via?: { lat: number; lon: number },
): Promise<BathymetricResponse | null> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (!supabaseUrl) {
        console.warn('[BathyRouter] No Supabase URL configured — skipping bathymetric routing');
        return null;
    }

    const url = `${supabaseUrl}/functions/v1/route-bathymetric`;
    const body: BathymetricRequest = {
        origin,
        destination,
        vessel_draft: vesselDraft,
    };
    if (via) body.via = via;

    try {
        console.log(`[BathyRouter] Requesting route: ${origin.lat.toFixed(2)},${origin.lon.toFixed(2)} → ${destination.lat.toFixed(2)},${destination.lon.toFixed(2)}`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000), // 30s timeout
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            console.error(`[BathyRouter] Edge function error ${resp.status}:`, errData);
            return null;
        }

        const data: BathymetricResponse = await resp.json();
        console.log(`[BathyRouter] ✓ ${data.waypoints.length} waypoints, ${data.distance_nm} NM, ${data.computation_ms}ms (${data.routing_mode})`);
        return data;

    } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
            console.warn('[BathyRouter] Request timed out (30s) — skipping');
        } else {
            console.error('[BathyRouter] Error:', err);
        }
        return null;
    }
}

/**
 * Merge bathymetric waypoints into an AI-generated VoyagePlan.
 *
 * Strategy:
 * - Replace AI-generated waypoint coordinates with bathymetric-safe ones
 * - Preserve AI-generated weather data (wind, waves) by interpolating
 *   to the new positions
 * - Add depth_m field from the bathymetric route
 * - Update distance, route reasoning, and coordinate fields
 * - If bathymetric routing fails, the original AI plan is returned unchanged
 */
export function mergeBathymetricRoute(
    voyagePlan: VoyagePlan,
    bathyRoute: BathymetricResponse,
): VoyagePlan {
    const merged = { ...voyagePlan };

    // All bathymetric waypoints except departure/arrival (indices 0 and last)
    const bathyWPs = bathyRoute.waypoints.slice(1, -1);

    // If AI generated waypoints with weather data, try to interpolate
    const aiWaypoints = voyagePlan.waypoints || [];
    const newWaypoints: Waypoint[] = bathyWPs.map((bwp, i) => {
        // Find closest AI waypoint for weather data
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
            depth_m: bwp.depth_m,
            // Inherit weather from nearest AI waypoint (or undefined)
            windSpeed: closestAI?.windSpeed,
            waveHeight: closestAI?.waveHeight,
        };
    });

    merged.waypoints = newWaypoints;

    // Update distance with bathymetric-calculated value
    merged.distanceApprox = `${bathyRoute.distance_nm} NM`;

    // Update route reasoning with bathymetric-derived explanation
    if (bathyRoute.route_reasoning) {
        merged.routeReasoning = bathyRoute.route_reasoning;
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
    // Need both origin and destination coordinates
    if (!voyagePlan.originCoordinates || !voyagePlan.destinationCoordinates) {
        console.warn('[BathyRouter] Missing coordinates — cannot route');
        return voyagePlan;
    }

    const draft = vessel.draft ?? 2.5;

    const bathyRoute = await fetchBathymetricRoute(
        voyagePlan.originCoordinates,
        voyagePlan.destinationCoordinates,
        draft,
    );

    if (!bathyRoute || bathyRoute.error) {
        console.warn('[BathyRouter] Routing unavailable — using AI waypoints');
        return voyagePlan;
    }

    return mergeBathymetricRoute(voyagePlan, bathyRoute);
}
