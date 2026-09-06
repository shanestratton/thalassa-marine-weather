/**
 * The telemetry snapshot the Pi posts, checked field by field.
 *
 * Every number is bounded to what an instrument can physically say, so a bad
 * sensor cannot write a 4,000-knot boat into the cloud; anything outside its
 * bound is dropped to null rather than rejected, because one sick transducer
 * must not black out the rest of the panel. `extra` carries small named
 * numbers the fixed columns do not have (a second battery, an engine
 * temperature) and is capped so it cannot become a dumping ground.
 */
export interface TelemetryRow {
    source: 'pi' | 'device';
    device_label: string | null;
    reported_at: string;
    lat: number | null;
    lon: number | null;
    sog_kts: number | null;
    cog_deg: number | null;
    heading_deg: number | null;
    stw_kts: number | null;
    tws_kts: number | null;
    twa_deg: number | null;
    twd_deg: number | null;
    aws_kts: number | null;
    awa_deg: number | null;
    depth_m: number | null;
    heel_deg: number | null;
    pitch_deg: number | null;
    water_temp_c: number | null;
    pressure_hpa: number | null;
    rudder_deg: number | null;
    rpm: number | null;
    voltage_v: number | null;
    extra: Record<string, number | string>;
}

export const MAX_REPORT_AGE_MS = 15 * 60_000;
export const MAX_REPORT_FUTURE_MS = 2 * 60_000;
export const MAX_EXTRA_KEYS = 40;
export const MAX_EXTRA_BYTES = 4_096;

const BOUNDS: Record<
    Exclude<keyof TelemetryRow, 'source' | 'device_label' | 'reported_at' | 'extra'>,
    [number, number]
> = {
    lat: [-90, 90],
    lon: [-180, 180],
    sog_kts: [0, 100],
    cog_deg: [0, 360],
    heading_deg: [0, 360],
    stw_kts: [0, 100],
    tws_kts: [0, 150],
    twa_deg: [-180, 180],
    twd_deg: [0, 360],
    aws_kts: [0, 150],
    awa_deg: [-180, 180],
    depth_m: [-5, 2_000],
    heel_deg: [-90, 90],
    pitch_deg: [-90, 90],
    water_temp_c: [-5, 50],
    pressure_hpa: [850, 1_100],
    rudder_deg: [-90, 90],
    rpm: [0, 20_000],
    voltage_v: [0, 100],
};

function bounded(value: unknown, [min, max]: [number, number]): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < min || value > max) return null;
    return value;
}

function parseExtra(value: unknown): Record<string, number | string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, number | string> = {};
    let keys = 0;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (keys >= MAX_EXTRA_KEYS) break;
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
        if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
        else if (typeof raw === 'string' && raw.length <= 120) out[key] = raw;
        else continue;
        keys += 1;
    }
    return JSON.stringify(out).length <= MAX_EXTRA_BYTES ? out : {};
}

export type ParsedTelemetry = { ok: true; row: TelemetryRow } | { ok: false; error: string };

export function parseTelemetryBody(body: Record<string, unknown>, nowMs = Date.now()): ParsedTelemetry {
    const reportedMs = typeof body.reported_at === 'string' ? Date.parse(body.reported_at) : Number.NaN;
    if (!Number.isFinite(reportedMs)) return { ok: false, error: 'reported_at must be an ISO timestamp' };
    if (nowMs - reportedMs > MAX_REPORT_AGE_MS) return { ok: false, error: 'reported_at is too old to be live' };
    if (reportedMs - nowMs > MAX_REPORT_FUTURE_MS) return { ok: false, error: 'reported_at is in the future' };

    const source = body.source === 'device'
        ? 'device'
        : body.source === 'pi' || body.source === undefined
        ? 'pi'
        : null;
    if (!source) return { ok: false, error: "source must be 'pi' or 'device'" };

    const label = typeof body.device_label === 'string' ? body.device_label.trim().slice(0, 60) : '';

    const lat = bounded(body.lat, BOUNDS.lat);
    const lon = bounded(body.lon, BOUNDS.lon);
    const hasPosition = lat !== null && lon !== null && !(lat === 0 && lon === 0);

    const row: TelemetryRow = {
        source,
        device_label: label || null,
        reported_at: new Date(reportedMs).toISOString(),
        lat: hasPosition ? lat : null,
        lon: hasPosition ? lon : null,
        sog_kts: bounded(body.sog_kts, BOUNDS.sog_kts),
        cog_deg: bounded(body.cog_deg, BOUNDS.cog_deg),
        heading_deg: bounded(body.heading_deg, BOUNDS.heading_deg),
        stw_kts: bounded(body.stw_kts, BOUNDS.stw_kts),
        tws_kts: bounded(body.tws_kts, BOUNDS.tws_kts),
        twa_deg: bounded(body.twa_deg, BOUNDS.twa_deg),
        twd_deg: bounded(body.twd_deg, BOUNDS.twd_deg),
        aws_kts: bounded(body.aws_kts, BOUNDS.aws_kts),
        awa_deg: bounded(body.awa_deg, BOUNDS.awa_deg),
        depth_m: bounded(body.depth_m, BOUNDS.depth_m),
        heel_deg: bounded(body.heel_deg, BOUNDS.heel_deg),
        pitch_deg: bounded(body.pitch_deg, BOUNDS.pitch_deg),
        water_temp_c: bounded(body.water_temp_c, BOUNDS.water_temp_c),
        pressure_hpa: bounded(body.pressure_hpa, BOUNDS.pressure_hpa),
        rudder_deg: bounded(body.rudder_deg, BOUNDS.rudder_deg),
        rpm: bounded(body.rpm, BOUNDS.rpm),
        voltage_v: bounded(body.voltage_v, BOUNDS.voltage_v),
        extra: parseExtra(body.extra),
    };
    return { ok: true, row };
}
