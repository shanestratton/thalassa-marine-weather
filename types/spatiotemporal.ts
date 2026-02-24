/**
 * Spatiotemporal Track Types
 *
 * These types define the payload returned by the route-weather edge function
 * and consumed by the 4D passage planning UI (scrubber, ghost ship, HUD).
 */

/** A single point on the weather-optimized track with conditions at arrival */
export interface TrackPoint {
    coordinates: [number, number];        // [lng, lat] GeoJSON order
    distance_from_start_nm: number;       // Cumulative distance in nautical miles
    time_offset_hours: number;            // Hours from departure
    name: string;                          // Waypoint name
    lateral_offset_nm: number;             // Lateral deviation from centerline
    conditions: TrackConditions;           // Weather + depth at arrival time
}

/** Environmental conditions at a track point */
export interface TrackConditions {
    depth_m: number | null;               // Depth in meters (negative = below sea level)
    wind_spd_kts: number;                 // True wind speed in knots
    wind_dir_deg: number;                 // True wind direction (degrees FROM)
    wave_ht_m: number;                    // Significant wave height in meters
    swell_period_s: number | null;        // Peak swell period in seconds
}

/** Summary statistics for the routed passage */
export interface RouteSummary {
    total_distance_nm: number;
    total_duration_hours: number;
    cost_score: number;                    // Lower = better route
    computation_ms: number;
    routing_mode: string;                  // e.g. 'stitched_spatiotemporal'
    vessel_type: string;                   // 'sail' | 'power'
    departure_time: string;                // ISO 8601
}

/** Mesh computation metadata */
export interface MeshStats {
    total_nodes: number;
    rows: number;
    cols: number;
    corridor_width_nm: number;
    weather_grid_points: number;
    forecast_hours: number;
}

/** Pilotage channel gate info */
export interface ChannelGateInfo {
    gates: number;
    handshake: { lat: number; lon: number };
    polygon_vertices: number;
}

/** Pilotage metadata from route-weather */
export interface PilotageInfo {
    departure: ChannelGateInfo | null;
    arrival: ChannelGateInfo | null;
}

/** The complete spatiotemporal payload from route-weather */
export interface SpatiotemporalPayload {
    summary: RouteSummary;
    bounding_box: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    track: TrackPoint[];
    mesh_stats: MeshStats;
    pilotage?: PilotageInfo;
    error?: string;
}

/** Ghost ship position interpolated by useGhostShip hook */
export interface GhostShipState {
    position: [number, number];           // [lng, lat]
    bearing: number;                       // Degrees clockwise from north
    conditions: TrackConditions;           // Interpolated weather at current time
    distanceNM: number;                    // Distance from start
    segmentIndex: number;                  // Active track segment
}
