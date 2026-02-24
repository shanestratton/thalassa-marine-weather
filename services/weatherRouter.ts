/**
 * Weather Router Service — Client-side interface to the route-weather Edge Function.
 *
 * Takes a bathymetric-safe route (from bathymetricRouter) and optimizes it through
 * a time-dependent weather corridor, producing an ETA-aware, weather-optimized route.
 *
 * Integration sequence:
 *   1. bathymetricRouter → depth-safe centerline (static, ~400ms)
 *   2. weatherRouter → weather-optimized route along corridor (dynamic, ~3-5s)
 *   3. Result merged back into VoyagePlan
 */

import { VoyagePlan, VesselProfile, PolarData, Waypoint } from '../types';
import { supabase } from './supabase';

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

interface WeatherWaypoint {
    lat: number;
    lon: number;
    name: string;
    depth_m?: number;
    lateral_offset_nm: number;
    weather_at_arrival: {
        windSpeed: number;
        windDir: number;
        waveHeight: number;
        swellPeriod?: number;
    };
}

interface WeatherRouteResponse {
    waypoints: WeatherWaypoint[];
    distance_nm: number;
    eta_hours: number;
    cost_score: number;
    computation_ms: number;
    mesh_stats: {
        total_nodes: number;
        rows: number;
        cols: number;
        corridor_width_nm: number;
        weather_grid_points: number;
        forecast_hours: number;
    };
    vessel_type: string;
    departure_time: string;
    error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

/**
 * Fetch the user's polar data from Supabase (if available).
 * Returns null if no polar data exists or user not logged in.
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
    } catch {
        // No polar data available
    }
    return null;
}

// ── Service ───────────────────────────────────────────────────────

/**
 * Send the bathymetric centerline to the weather router for optimization.
 *
 * Returns null if the service is unavailable (non-critical — the
 * bathymetric route still works without weather optimization).
 */
export async function fetchWeatherRoute(
    centerline: { lat: number; lon: number; depth_m?: number; name?: string }[],
    departureTime: string,
    vessel: VesselProfile,
    polarData?: PolarData | null,
): Promise<WeatherRouteResponse | null> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (!supabaseUrl) {
        console.warn('[WeatherRouter] No Supabase URL configured — skipping weather routing');
        return null;
    }

    const url = `${supabaseUrl}/functions/v1/route-weather`;
    const body: WeatherRouteRequest = {
        centerline,
        departure_time: departureTime,
        vessel: {
            type: vessel.type === 'observer' ? 'power' : vessel.type, // Observer = power
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
        console.log(`[WeatherRouter] Vessel: ${vessel.type} @ ${vessel.cruisingSpeed} kts, departure: ${departureTime}`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(45_000), // 45s timeout (weather fetch is slow)
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            console.error(`[WeatherRouter] Edge function error ${resp.status}:`, errData);
            return null;
        }

        const data: WeatherRouteResponse = await resp.json();
        console.log(`[WeatherRouter] ✓ ${data.waypoints.length} WPs, ${data.distance_nm} NM, ETA: ${data.eta_hours}h (${data.computation_ms}ms)`);
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

/**
 * Merge the weather-optimized route into the voyage plan.
 *
 * Updates waypoints with weather-routed positions, adds per-waypoint
 * weather forecasts, and updates ETA/distance.
 */
export function mergeWeatherRoute(
    voyagePlan: VoyagePlan,
    weatherRoute: WeatherRouteResponse,
): VoyagePlan {
    const merged = { ...voyagePlan };

    // Map weather waypoints to Waypoint type, excluding departure/arrival
    const weatherWPs = weatherRoute.waypoints.slice(1, -1);

    const newWaypoints: Waypoint[] = weatherWPs.map((wwp, i) => ({
        name: wwp.name || `WP-${String(i + 1).padStart(2, '0')}`,
        coordinates: { lat: wwp.lat, lon: wwp.lon },
        depth_m: wwp.depth_m,
        windSpeed: Math.round(wwp.weather_at_arrival.windSpeed),
        waveHeight: Math.round(wwp.weather_at_arrival.waveHeight * 3.281), // m → ft
    }));

    merged.waypoints = newWaypoints;
    merged.distanceApprox = `${weatherRoute.distance_nm} NM`;

    // Update duration with weather-routed ETA
    const etaH = weatherRoute.eta_hours;
    if (etaH < 24) {
        merged.durationApprox = `${Math.round(etaH)} hours`;
    } else {
        const days = Math.floor(etaH / 24);
        const hours = Math.round(etaH % 24);
        merged.durationApprox = `${days} day${days > 1 ? 's' : ''} ${hours}h`;
    }

    // Add weather routing reasoning
    const etaStr = merged.durationApprox;
    const meshInfo = weatherRoute.mesh_stats;
    merged.routeReasoning = (merged.routeReasoning || '') +
        ` Weather-optimized for ${weatherRoute.vessel_type} vessel using ${meshInfo.weather_grid_points} forecast points over ${meshInfo.forecast_hours}h. ` +
        `Corridor: ±${meshInfo.corridor_width_nm} NM, ${meshInfo.total_nodes} mesh nodes evaluated. ` +
        `Weather-adjusted ETA: ${etaStr}. Route cost score: ${weatherRoute.cost_score} (lower is better).`;

    return merged;
}

/**
 * Convenience: fetch weather route and merge into voyage plan.
 * Non-blocking — returns original plan if routing fails.
 *
 * This is the main entry point, called after bathymetric routing.
 */
export async function enhanceVoyagePlanWithWeather(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
    departureTime: string,
): Promise<VoyagePlan> {
    // Need waypoints with coordinates to route
    if (!voyagePlan.waypoints || voyagePlan.waypoints.length < 1) {
        console.warn('[WeatherRouter] No waypoints to route — skipping');
        return voyagePlan;
    }

    // Build centerline from the existing bathymetric waypoints
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

    // Try to fetch user's polar data for sail vessels
    let polarData: PolarData | null = null;
    if (vessel.type === 'sail') {
        try {
            polarData = await fetchUserPolarData();
            if (polarData) {
                console.log('[WeatherRouter] Using user polar data for sail routing');
            }
        } catch {
            // Non-critical
        }
    }

    const weatherRoute = await fetchWeatherRoute(
        centerline,
        departureTime,
        vessel,
        polarData,
    );

    if (!weatherRoute || weatherRoute.error) {
        console.warn('[WeatherRouter] Weather routing unavailable — using bathymetric route');
        return voyagePlan;
    }

    return mergeWeatherRoute(voyagePlan, weatherRoute);
}
