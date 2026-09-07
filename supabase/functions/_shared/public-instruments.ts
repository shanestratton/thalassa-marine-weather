/** Public instruments never carry location, device identifiers or arbitrary extra fields. */
export function publicInstrumentSnapshot(
    row: Record<string, unknown> | null,
    boatId: string,
    nowMs = Date.now(),
) {
    if (!row || row.boat_id !== boatId) return null;
    const reportedAt = typeof row.reported_at === 'string' ? Date.parse(row.reported_at) : NaN;
    if (!Number.isFinite(reportedAt) || reportedAt > nowMs + 60_000 || nowMs - reportedAt >= 10 * 60_000) {
        return null;
    }
    const number = (key: string): number | null =>
        typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] as number : null;
    return {
        updated_at: new Date(reportedAt).toISOString(),
        source: row.source === 'device' ? 'device' as const : 'pi' as const,
        sog: number('sog_kts'),
        cog: number('cog_deg'),
        heading: number('heading_deg'),
        stw: number('stw_kts'),
        tws: number('tws_kts'),
        twa: number('twa_deg'),
        twd: number('twd_deg'),
        aws: number('aws_kts'),
        awa: number('awa_deg'),
        depth: number('depth_m'),
        water_temp: number('water_temp_c'),
        baro: number('pressure_hpa'),
        voltage: number('voltage_v'),
        rpm: number('rpm'),
        heel: number('heel_deg'),
        pitch: number('pitch_deg'),
        rudder: number('rudder_deg'),
    };
}

export function canPublishInstruments(options: {
    enabled: unknown;
    boatId: string | null;
    requestedTrip: string | null;
    visibilityReadable: boolean;
    activeVoyageAllowed: boolean;
}): boolean {
    return options.enabled === true && !!options.boatId && options.visibilityReadable &&
        options.activeVoyageAllowed &&
        (options.requestedTrip === null || options.requestedTrip === '' || options.requestedTrip === 'latest');
}

/** Removing the dials alone would leave the same readings in the public track JSON. */
export function redactPublicTrackPoint(point: Record<string, unknown>) {
    return {
        lat: point.lat,
        lon: point.lon,
        timestamp: point.timestamp,
        voyage_id: point.voyage_id ?? null,
        cumulative_distance_nm: point.cumulative_distance_nm ?? null,
        live: point.live === true,
        speed_kts: null,
        course_deg: null,
        heading_deg: null,
        pressure: null,
        wind_speed_apparent: null,
        wind_angle_apparent: null,
        wind_speed_true: null,
        wind_direction_true: null,
        wind_speed: null,
        wind_gust: null,
        wind_direction: null,
        depth_m: null,
        air_temp: null,
        water_temp: null,
        wave_height: null,
    };
}

export function redactPublicTelemetry(point: Record<string, unknown> | null) {
    if (!point) return null;
    return {
        lat: point.lat,
        lon: point.lon,
        updated_at: point.updated_at,
        is_last_known: point.is_last_known,
        sog: null,
        cog: null,
        heading: null,
        baro: null,
        baro_trend: null,
        aws: null,
        awa: null,
        tws: null,
        twd: null,
        depth: null,
        air_temp: null,
        water_temp: null,
        wave_height: null,
    };
}
