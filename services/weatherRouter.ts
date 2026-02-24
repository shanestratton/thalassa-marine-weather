/**
 * Weather Router Service — Client-side interface to the route-weather Edge Function.
 *
 * Takes a bathymetric-safe route (from bathymetricRouter) and optimizes it through
 * a time-dependent weather corridor, producing an ETA-aware, weather-optimized route.
 *
 * Returns both:
 *   1. Updated VoyagePlan (for the traditional results view)
 *   2. SpatiotemporalPayload (for the 4D canvas visualization)
 */

import { VoyagePlan, VesselProfile, PolarData, Waypoint } from '../types';
import { supabase } from './supabase';
import type { SpatiotemporalPayload } from '../types/spatiotemporal';

// Re-export the type for convenience
export type { SpatiotemporalPayload };

// ── Types ─────────────────────────────────────────────────────────

interface WeatherRouteRequest {
    centerline: { lat: number; lon: number; depth_m?: number; name?: string }[];
    departure_time: string;
    vessel: {
        type: 'sail' | 'power';
        cruising_speed_kts: number;
        max_wind_kts: number;
        max_wave_m: number;
        polar_data?: PolarData | null;
    };
    corridor_width_nm?: number;
    lateral_steps?: number;
}

/** The result of a weather routing call — both the updated plan and raw payload */
export interface WeatherRouteResult {
    plan: VoyagePlan;
    payload: SpatiotemporalPayload;
}

// ── Helpers ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

/**
 * Fetch the user's polar data from Supabase (if available).
 */
async function fetchUserPolarData(): Promise<PolarData | null> {
    if (!supabase) return null;
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;
        const { data, error } = await supabase
            .from('vessel_polars')
            .select('polar_data')
            .eq('user_id', user.id)
            .single();
        if (data && !error && data.polar_data) {
            return data.polar_data as PolarData;
        }
    } catch { /* No polar data */ }
    return null;
}

// ── Core Fetch ────────────────────────────────────────────────────

/**
 * Fetch the spatiotemporal weather route from the edge function.
 */
export async function fetchWeatherRoute(
    centerline: { lat: number; lon: number; depth_m?: number; name?: string }[],
    departureTime: string,
    vessel: VesselProfile,
    polarData?: PolarData | null,
): Promise<SpatiotemporalPayload | null> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (!supabaseUrl) {
        console.warn('[WeatherRouter] No Supabase URL configured — skipping');
        return null;
    }

    const url = `${supabaseUrl}/functions/v1/route-weather`;
    const body: WeatherRouteRequest = {
        centerline,
        departure_time: departureTime,
        vessel: {
            type: vessel.type === 'observer' ? 'power' : vessel.type,
            cruising_speed_kts: vessel.cruisingSpeed || 6,
            max_wind_kts: vessel.maxWindSpeed || 30,
            max_wave_m: vessel.maxWaveHeight || 3,
            polar_data: polarData || null,
        },
        corridor_width_nm: 30,
        lateral_steps: 2,
    };

    try {
        console.log(`[WeatherRouter] Requesting weather-optimized route for ${centerline.length} waypoints`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(45_000),
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            console.error(`[WeatherRouter] Edge function error ${resp.status}:`, errData);
            return null;
        }

        const data: SpatiotemporalPayload = await resp.json();

        if (data.error) {
            console.error(`[WeatherRouter] Routing error:`, data.error);
            return null;
        }

        console.log(
            `[WeatherRouter] ✓ ${data.track?.length} track points, ` +
            `${data.summary?.total_distance_nm} NM, ` +
            `ETA: ${data.summary?.total_duration_hours}h ` +
            `(${data.summary?.computation_ms}ms)`
        );
        return data;

    } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
            console.warn('[WeatherRouter] Request timed out (45s) — skipping');
        } else {
            console.error('[WeatherRouter] Error:', err);
        }
        return null;
    }
}

// ── Merge into VoyagePlan ─────────────────────────────────────────

/**
 * Merge the spatiotemporal payload into a VoyagePlan for legacy UI.
 */
export function mergeWeatherRoute(
    voyagePlan: VoyagePlan,
    payload: SpatiotemporalPayload,
): VoyagePlan {
    const merged = { ...voyagePlan };
    const { summary, track, mesh_stats } = payload;

    // Map track points to Waypoints (skip departure/arrival endpoints)
    const innerTrack = track.slice(1, -1);
    const newWaypoints: Waypoint[] = innerTrack.map((pt, i) => ({
        name: pt.name || `WP-${String(i + 1).padStart(2, '0')}`,
        coordinates: { lat: pt.coordinates[1], lon: pt.coordinates[0] }, // GeoJSON → lat/lon
        depth_m: pt.conditions.depth_m ?? undefined,
        windSpeed: Math.round(pt.conditions.wind_spd_kts),
        waveHeight: Math.round(pt.conditions.wave_ht_m * 3.281), // m → ft
    }));

    merged.waypoints = newWaypoints;
    merged.distanceApprox = `${summary.total_distance_nm} NM`;

    // Duration formatting
    const etaH = summary.total_duration_hours;
    if (etaH < 24) {
        merged.durationApprox = `${Math.round(etaH)} hours`;
    } else {
        const days = Math.floor(etaH / 24);
        const hours = Math.round(etaH % 24);
        merged.durationApprox = `${days} day${days > 1 ? 's' : ''} ${hours}h`;
    }

    // Routing reasoning
    merged.routeReasoning = (merged.routeReasoning || '') +
        ` Weather-optimized for ${summary.vessel_type} vessel using ${mesh_stats.weather_grid_points} forecast points over ${mesh_stats.forecast_hours}h. ` +
        `Corridor: ±${mesh_stats.corridor_width_nm} NM, ${mesh_stats.total_nodes} mesh nodes evaluated. ` +
        `Weather-adjusted ETA: ${merged.durationApprox}. Route cost score: ${summary.cost_score} (lower is better).`;

    return merged;
}

// ── Main Entry Point ──────────────────────────────────────────────

/**
 * Fetch weather route, merge into voyage plan, and return both.
 *
 * Returns { plan, payload } so the UI can show both:
 *   - Traditional VoyageResults (from plan)
 *   - 4D Passage Canvas (from payload)
 *
 * Non-blocking — returns original plan if routing fails.
 */
export async function enhanceVoyagePlanWithWeather(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
    departureTime: string,
): Promise<VoyagePlan> {
    if (!voyagePlan.waypoints || voyagePlan.waypoints.length < 1) {
        console.warn('[WeatherRouter] No waypoints to route — skipping');
        return voyagePlan;
    }

    // Build centerline
    const centerline: { lat: number; lon: number; depth_m?: number; name?: string }[] = [];

    if (voyagePlan.originCoordinates) {
        centerline.push({
            lat: voyagePlan.originCoordinates.lat,
            lon: voyagePlan.originCoordinates.lon,
            name: voyagePlan.origin,
        });
    }

    for (const wp of voyagePlan.waypoints) {
        if (wp.coordinates) {
            centerline.push({
                lat: wp.coordinates.lat,
                lon: wp.coordinates.lon,
                depth_m: wp.depth_m,
                name: wp.name,
            });
        }
    }

    if (voyagePlan.destinationCoordinates) {
        centerline.push({
            lat: voyagePlan.destinationCoordinates.lat,
            lon: voyagePlan.destinationCoordinates.lon,
            name: voyagePlan.destination,
        });
    }

    if (centerline.length < 2) {
        console.warn('[WeatherRouter] Not enough coordinates to route');
        return voyagePlan;
    }

    // Polar data for sail vessels
    let polarData: PolarData | null = null;
    if (vessel.type === 'sail') {
        try {
            polarData = await fetchUserPolarData();
            if (polarData) console.log('[WeatherRouter] Using user polar data');
        } catch { /* Non-critical */ }
    }

    const payload = await fetchWeatherRoute(centerline, departureTime, vessel, polarData);

    if (!payload) {
        console.warn('[WeatherRouter] Weather routing unavailable — using bathymetric route');
        return voyagePlan;
    }

    // Store the payload on the plan for the 4D canvas to pick up
    const merged = mergeWeatherRoute(voyagePlan, payload);
    (merged as any).__spatiotemporalPayload = payload;
    return merged;
}

/**
 * Extract the spatiotemporal payload from an enhanced voyage plan
 * (stashed by enhanceVoyagePlanWithWeather).
 */
export function getSpatiotemporalPayload(plan: VoyagePlan): SpatiotemporalPayload | null {
    return (plan as any).__spatiotemporalPayload ?? null;
}
