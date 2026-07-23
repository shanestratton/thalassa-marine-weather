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

import { createLogger } from '../utils/createLogger';
import { mToFt } from '../utils/units';
import { VoyagePlan, VesselProfile, PolarData, Waypoint } from '../types';
import { supabase } from './supabase';
import { vesselDraftMetres } from './units';
import type { SpatiotemporalPayload } from '../types/spatiotemporal';
const log = createLogger('WxRouter');

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
        draft_m: number;
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

const getSupabaseUrl = (): string => (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' &&
        (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
    '';

const MAX_WEATHER_ROUTE_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > maxBytes) return null;
    if (!response.body) return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            return null;
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

function validateWeatherRoutePayload(
    value: unknown,
    requestedCenterline: { lat: number; lon: number }[],
    requestedDeparture: string,
    requestedVessel: WeatherRouteRequest['vessel'],
): SpatiotemporalPayload | null {
    if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.mesh_stats)) return null;
    const { summary, mesh_stats: meshStats } = value;
    if (
        !finiteInRange(summary.total_distance_nm, 0, 5_000) ||
        !finiteInRange(summary.total_duration_hours, 0, 120) ||
        !finiteInRange(summary.cost_score, 0, 1_000_000) ||
        !finiteInRange(summary.computation_ms, 0, 30 * 60 * 1000) ||
        summary.routing_mode !== 'verified_weather_corridor' ||
        summary.vessel_type !== requestedVessel.type ||
        typeof summary.departure_time !== 'string' ||
        Date.parse(summary.departure_time) !== Date.parse(requestedDeparture)
    ) {
        return null;
    }

    if (
        !Array.isArray(value.bounding_box) ||
        value.bounding_box.length !== 4 ||
        !finiteInRange(value.bounding_box[0], -180, 180) ||
        !finiteInRange(value.bounding_box[1], -90, 90) ||
        !finiteInRange(value.bounding_box[2], -180, 180) ||
        !finiteInRange(value.bounding_box[3], -90, 90) ||
        value.bounding_box[0] > value.bounding_box[2] ||
        value.bounding_box[1] > value.bounding_box[3]
    ) {
        return null;
    }

    if (!Array.isArray(value.track) || value.track.length < 2 || value.track.length > 1_800) return null;
    let previousDistance = -1;
    let previousTime = -1;
    let trackMinLon = Infinity;
    let trackMinLat = Infinity;
    let trackMaxLon = -Infinity;
    let trackMaxLat = -Infinity;
    for (const point of value.track) {
        if (
            !isRecord(point) ||
            !Array.isArray(point.coordinates) ||
            point.coordinates.length !== 2 ||
            !finiteInRange(point.coordinates[0], -180, 180) ||
            !finiteInRange(point.coordinates[1], -90, 90) ||
            !finiteInRange(point.distance_from_start_nm, 0, 5_000) ||
            !finiteInRange(point.time_offset_hours, 0, 120) ||
            point.distance_from_start_nm + 0.001 < previousDistance ||
            point.time_offset_hours + 0.001 < previousTime ||
            typeof point.name !== 'string' ||
            point.name.length > 120 ||
            (point.leg_type !== undefined && point.leg_type !== 'harbour' && point.leg_type !== 'ocean') ||
            !finiteInRange(point.lateral_offset_nm, -120, 120) ||
            !isRecord(point.conditions)
        ) {
            return null;
        }
        const conditions = point.conditions;
        if (
            !finiteInRange(conditions.depth_m, -12_000, -0.1) ||
            !finiteInRange(conditions.wind_spd_kts, 0, 220) ||
            !finiteInRange(conditions.wind_gust_kts, 0, 270) ||
            conditions.wind_gust_kts + 0.1 < conditions.wind_spd_kts ||
            conditions.wind_gust_kts > requestedVessel.max_wind_kts + 0.1 ||
            !finiteInRange(conditions.wind_dir_deg, 0, 360) ||
            !finiteInRange(conditions.wave_ht_m, 0, 40) ||
            conditions.wave_ht_m > requestedVessel.max_wave_m + 0.01 ||
            !finiteInRange(conditions.wave_dir_deg, 0, 360) ||
            !finiteInRange(conditions.swell_period_s, 0.1, 40)
        ) {
            return null;
        }
        trackMinLon = Math.min(trackMinLon, point.coordinates[0]);
        trackMinLat = Math.min(trackMinLat, point.coordinates[1]);
        trackMaxLon = Math.max(trackMaxLon, point.coordinates[0]);
        trackMaxLat = Math.max(trackMaxLat, point.coordinates[1]);
        previousDistance = point.distance_from_start_nm;
        previousTime = point.time_offset_hours;
    }

    const first = value.track[0].coordinates;
    const last = value.track[value.track.length - 1].coordinates;
    const requestedFirst = requestedCenterline[0];
    const requestedLast = requestedCenterline[requestedCenterline.length - 1];
    if (
        Math.abs(value.track[0].distance_from_start_nm) > 0.01 ||
        Math.abs(value.track[0].time_offset_hours) > 0.01 ||
        Math.abs(first[0] - requestedFirst.lon) > 0.01 ||
        Math.abs(first[1] - requestedFirst.lat) > 0.01 ||
        Math.abs(last[0] - requestedLast.lon) > 0.01 ||
        Math.abs(last[1] - requestedLast.lat) > 0.01 ||
        Math.abs(previousDistance - summary.total_distance_nm) > 0.2 ||
        Math.abs(previousTime - summary.total_duration_hours) > 0.2 ||
        value.bounding_box[0] > trackMinLon ||
        value.bounding_box[1] > trackMinLat ||
        value.bounding_box[2] < trackMaxLon ||
        value.bounding_box[3] < trackMaxLat
    ) {
        return null;
    }

    if (
        !Number.isInteger(meshStats.total_nodes) ||
        !finiteInRange(meshStats.total_nodes, 2, 1_800) ||
        !Number.isInteger(meshStats.rows) ||
        !finiteInRange(meshStats.rows, 2, 1_800) ||
        !Number.isInteger(meshStats.cols) ||
        !finiteInRange(meshStats.cols, 3, 9) ||
        meshStats.rows * meshStats.cols !== meshStats.total_nodes ||
        !finiteInRange(meshStats.corridor_width_nm, 1, 120) ||
        !Number.isInteger(meshStats.weather_grid_points) ||
        !finiteInRange(meshStats.weather_grid_points, 1, 200) ||
        !Number.isInteger(meshStats.forecast_hours) ||
        !finiteInRange(meshStats.forecast_hours, 1, 120)
    ) {
        return null;
    }

    const sources = value.weather_sources;
    if (!isRecord(sources) || !isRecord(sources.wind) || !isRecord(sources.waves) || !isRecord(sources.land_mask)) {
        return null;
    }
    const waveValidFrom = typeof sources.waves.valid_from === 'string' ? Date.parse(sources.waves.valid_from) : NaN;
    const waveValidTo = typeof sources.waves.valid_to === 'string' ? Date.parse(sources.waves.valid_to) : NaN;
    const requestedDepartureMs = Date.parse(requestedDeparture);
    const requiredForecastEndMs = requestedDepartureMs + meshStats.forecast_hours * 60 * 60 * 1000;
    if (
        sources.wind.model !== 'Apple WeatherKit forecastHourly' ||
        typeof sources.wind.aligned_from !== 'string' ||
        Date.parse(sources.wind.aligned_from) !== requestedDepartureMs ||
        sources.wind.horizon_hours !== meshStats.forecast_hours ||
        sources.waves.model !== 'NOAA WaveWatch III' ||
        typeof sources.waves.cycle !== 'string' ||
        !/^\d{10}$/.test(sources.waves.cycle) ||
        !Number.isFinite(waveValidFrom) ||
        !Number.isFinite(waveValidTo) ||
        waveValidFrom > requestedDepartureMs + 60_000 ||
        waveValidTo + 60_000 < requiredForecastEndMs ||
        sources.land_mask.model !== 'GEBCO' ||
        !finiteInRange(sources.land_mask.max_cell_nm, 0.01, 1.25) ||
        !finiteInRange(sources.land_mask.minimum_safe_depth_m, 1.1, 31) ||
        Math.abs(sources.land_mask.minimum_safe_depth_m - (requestedVessel.draft_m + 1)) > 0.001
    ) {
        return null;
    }
    return value as unknown as SpatiotemporalPayload;
}

/**
 * Fetch the user's polar data from Supabase (if available).
 */
async function fetchUserPolarData(): Promise<PolarData | null> {
    if (!supabase) return null;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return null;
        const { data, error } = await supabase
            .from('vessel_polars')
            .select('polar_data')
            .eq('user_id', user.id)
            .single();
        if (data && !error && data.polar_data) {
            return data.polar_data as PolarData;
        }
    } catch (e) {
        log.warn('[weather] No polar data:', e);
    }
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
    let authorizationToken = supabaseKey;
    if (supabase) {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            authorizationToken = session?.access_token || supabaseKey;
        } catch (error) {
            log.warn('[weather] Could not read the current session; using the public route quota:', error);
        }
    }
    const body: WeatherRouteRequest = {
        centerline,
        departure_time: departureTime,
        vessel: {
            type: vessel.type === 'observer' ? 'power' : vessel.type,
            cruising_speed_kts: vessel.cruisingSpeed || 6,
            max_wind_kts: vessel.maxWindSpeed || 30,
            max_wave_m: vessel.maxWaveHeight || 3,
            draft_m: vesselDraftMetres(vessel),
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
                ...(supabaseKey ? { apikey: supabaseKey } : {}),
                ...(authorizationToken ? { Authorization: `Bearer ${authorizationToken}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });

        if (!resp.ok) {
            const errorText = await readBoundedResponseText(resp, 64 * 1024);
            log.error(`[WeatherRouter] Edge function error ${resp.status}:`, errorText || 'invalid error response');
            return null;
        }

        const responseText = await readBoundedResponseText(resp, MAX_WEATHER_ROUTE_RESPONSE_BYTES);
        if (responseText === null) {
            log.error('[WeatherRouter] Route response exceeded the safe size limit');
            return null;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(responseText);
        } catch {
            log.error('[WeatherRouter] Route response was not valid JSON');
            return null;
        }
        const data = validateWeatherRoutePayload(parsed, centerline, departureTime, body.vessel);
        if (!data) {
            log.error('[WeatherRouter] Route response failed structural validation');
            return null;
        }
        return data;
    } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
            /* best effort */
        } else {
            log.error('[WeatherRouter] Error:', err);
        }
        return null;
    }
}

// ── Merge into VoyagePlan ─────────────────────────────────────────

/**
 * Merge the spatiotemporal payload into a VoyagePlan for legacy UI.
 */
export function mergeWeatherRoute(voyagePlan: VoyagePlan, payload: SpatiotemporalPayload): VoyagePlan {
    const merged = { ...voyagePlan };
    const { summary, track, mesh_stats } = payload;

    // Map track points to Waypoints (skip departure/arrival endpoints)
    const innerTrack = track.slice(1, -1);
    const newWaypoints: Waypoint[] = innerTrack.map((pt, i) => ({
        name: pt.name || `WP-${String(i + 1).padStart(2, '0')}`,
        coordinates: { lat: pt.coordinates[1], lon: pt.coordinates[0] }, // GeoJSON → lat/lon
        depth_m: pt.conditions.depth_m ?? undefined,
        windSpeed: Math.round(pt.conditions.wind_spd_kts),
        waveHeight: Math.round(mToFt(pt.conditions.wave_ht_m)), // m → ft (canonical 3.28084)
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
    merged.routeReasoning =
        (merged.routeReasoning || '') +
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
    // ── Centerline construction ──
    // Priority order:
    //   1. routeGeoJSON (best — bathymetric router has populated it with
    //      hundreds of depth-safe points hugging real waterways)
    //   2. Named waypoints (AI/user supplied named turn-points)
    //   3. Plain origin → destination great-circle endpoints
    //
    // Previously this function bailed early when waypoints was empty,
    // which prevented weather routing on plans built by the deterministic
    // computeVoyagePlan (which seeds an empty waypoints array). The
    // weather edge function only needs ≥2 centerline points to build a
    // corridor — origin + destination is enough for it to start, and the
    // bathymetric step usually runs first to fill in routeGeoJSON anyway.
    const centerline: { lat: number; lon: number; depth_m?: number; name?: string }[] = [];

    const routeGeoJSON = voyagePlan.routeGeoJSON;
    if (routeGeoJSON?.geometry?.coordinates && routeGeoJSON.geometry.coordinates.length >= 2) {
        // Use the detailed graph route coordinates (hundreds of points along waterways)
        const coords = routeGeoJSON.geometry.coordinates as [number, number][];
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
        // Fallback: build from origin + named waypoints + destination.
        // Works whether waypoints is empty (origin → destination direct)
        // or populated (origin → wp1 → wp2 → destination).
        if (voyagePlan.originCoordinates) {
            centerline.push({
                lat: voyagePlan.originCoordinates.lat,
                lon: voyagePlan.originCoordinates.lon,
                name: voyagePlan.origin,
            });
        }

        for (const wp of voyagePlan.waypoints || []) {
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
        } catch (e) {
            log.warn('[weather] Non-critical:', e);
        }
    }

    // Preserve as much of the bathymetric route as the validated edge
    // contract permits. Any shortcut created here is rechecked against GEBCO.
    const MAX_WEATHER_POINTS = 200;
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
        // A raw centerline with zeroed conditions is not a weather route.
        // Leave the original plan untouched so callers cannot mistake missing
        // model/land coverage for verified calm conditions.
        return voyagePlan;
    }

    // Store the payload on the plan for the 4D canvas to pick up
    const merged = mergeWeatherRoute(voyagePlan, payload);
    merged.__spatiotemporalPayload = payload;
    return merged;
}

/**
 * Extract the spatiotemporal payload from an enhanced voyage plan
 * (stashed by enhanceVoyagePlanWithWeather).
 */
export function getSpatiotemporalPayload(plan: VoyagePlan): SpatiotemporalPayload | null {
    return plan.__spatiotemporalPayload ?? null;
}
