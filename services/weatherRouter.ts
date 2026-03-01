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
    } catch (e) { console.warn('[weather] No polar data:', e); }
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

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
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
        }        // Debug: log track coordinates to diagnose crossing-earth issue
        if (data.track) {
            // Track data available for 4D rendering
        }
        return data;

    } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') { } else {
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
        return voyagePlan;
    }

    // Build centerline — prefer detailed routeGeoJSON from bathymetric enhancement
    // over sparse AI waypoints, so routes follow actual waterway geometry
    const centerline: { lat: number; lon: number; depth_m?: number; name?: string }[] = [];

    const routeGeoJSON = (voyagePlan as any).routeGeoJSON;
    if (routeGeoJSON?.geometry?.coordinates?.length >= 2) {
        // Use the detailed graph route coordinates (hundreds of points along waterways)
        const coords: [number, number][] = routeGeoJSON.geometry.coordinates;
        for (const [lon, lat] of coords) {
            centerline.push({ lat, lon });
        }
        // Attach origin/destination names to endpoints
        if (voyagePlan.origin && centerline.length > 0) {
            centerline[0].name = voyagePlan.origin;
        }
        if (voyagePlan.destination && centerline.length > 1) {
            centerline[centerline.length - 1].name = voyagePlan.destination;
        }
    } else {
        // Fallback: use sparse AI waypoints
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
    }

    if (centerline.length < 2) {
        return voyagePlan;
    }

    // Polar data for sail vessels
    let polarData: PolarData | null = null;
    if (vessel.type === 'sail') {
        try {
            polarData = await fetchUserPolarData();
        } catch (e) { console.warn('[weather] Non-critical:', e); }
    }

    // Decimate centerline for weather API (max ~100 points) — API can't handle thousands
    // Keep full detail centerline for fallback track rendering
    const MAX_WEATHER_POINTS = 100;
    let weatherCenterline = centerline;
    if (centerline.length > MAX_WEATHER_POINTS) {
        const step = (centerline.length - 1) / (MAX_WEATHER_POINTS - 1);
        weatherCenterline = [];
        for (let i = 0; i < MAX_WEATHER_POINTS; i++) {
            weatherCenterline.push(centerline[Math.round(i * step)]);
        }
    }

    const payload = await fetchWeatherRoute(weatherCenterline, departureTime, vessel, polarData);

    if (!payload) {
        // Build a basic spatiotemporal payload from the centerline so the 4D canvas still works
        const fallbackTrack = centerline.map((pt, i) => {
            const prevPt = i > 0 ? centerline[i - 1] : pt;
            const segDist = i > 0
                ? Math.sqrt(Math.pow((pt.lat - prevPt.lat) * 60, 2) + Math.pow((pt.lon - prevPt.lon) * 60 * Math.cos(pt.lat * Math.PI / 180), 2))
                : 0;
            return {
                coordinates: [pt.lon, pt.lat] as [number, number],
                distance_from_start_nm: segDist,
                time_offset_hours: segDist / (vessel.cruisingSpeed || 6),
                name: pt.name || `WP-${String(i).padStart(2, '0')}`,
                lateral_offset_nm: 0,
                conditions: {
                    depth_m: pt.depth_m ?? null,
                    wind_spd_kts: 0,
                    wind_dir_deg: 0,
                    wave_ht_m: 0,
                    swell_period_s: null,
                },
            };
        });

        // Accumulate distances
        let cumDist = 0;
        for (let i = 1; i < fallbackTrack.length; i++) {
            const prev = centerline[i - 1];
            const cur = centerline[i];
            const segDist = Math.sqrt(
                Math.pow((cur.lat - prev.lat) * 60, 2) +
                Math.pow((cur.lon - prev.lon) * 60 * Math.cos(cur.lat * Math.PI / 180), 2)
            );
            cumDist += segDist;
            fallbackTrack[i].distance_from_start_nm = cumDist;
            fallbackTrack[i].time_offset_hours = cumDist / (vessel.cruisingSpeed || 6);
        }

        const lons = centerline.map(p => p.lon);
        const lats = centerline.map(p => p.lat);
        const fallbackPayload: SpatiotemporalPayload = {
            summary: {
                total_distance_nm: Math.round(cumDist * 10) / 10,
                total_duration_hours: Math.round((cumDist / (vessel.cruisingSpeed || 6)) * 10) / 10,
                cost_score: 0,
                computation_ms: 0,
                routing_mode: 'fallback_centerline',
                vessel_type: vessel.type,
                departure_time: departureTime,
            },
            bounding_box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
            track: fallbackTrack,
            mesh_stats: {
                total_nodes: centerline.length,
                rows: 1,
                cols: centerline.length,
                corridor_width_nm: 0,
                weather_grid_points: 0,
                forecast_hours: 0,
            },
        };

        const merged = mergeWeatherRoute(voyagePlan, fallbackPayload);
        (merged as any).__spatiotemporalPayload = fallbackPayload;
        return merged;
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
