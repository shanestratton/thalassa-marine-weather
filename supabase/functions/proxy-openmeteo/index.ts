// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseBoundedInteger,
    readJsonObject,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

/**
 * Commercial Open-Meteo trust boundary.
 *
 * Clients choose one of two fixed operations and a deliberately small query
 * vocabulary. The upstream host, path and commercial key are server-owned.
 */
const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const JSON_HEADERS = {
    ...CORS,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

const UPSTREAMS = {
    forecast: 'https://customer-api.open-meteo.com/v1/forecast',
    marine: 'https://customer-marine-api.open-meteo.com/v1/marine',
} as const;

type Operation = keyof typeof UPSTREAMS;
type QueryRecord = Record<string, string>;

const COMMON_PARAMETERS = new Set([
    'latitude',
    'longitude',
    'current',
    'hourly',
    'daily',
    'models',
    'forecast_days',
    'forecast_hours',
    'past_days',
    'start_date',
    'end_date',
    'timezone',
    'timeformat',
    'wind_speed_unit',
    'temperature_unit',
    'precipitation_unit',
    'cell_selection',
    'elevation',
]);

const FORECAST_CURRENT = new Set([
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'is_day',
    'precipitation',
    'rain',
    'showers',
    'snowfall',
    'weather_code',
    'cloud_cover',
    'pressure_msl',
    'surface_pressure',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
]);

const FORECAST_HOURLY = new Set([
    ...FORECAST_CURRENT,
    'dew_point_2m',
    'precipitation_probability',
    'visibility',
    'uv_index',
    'cape',
]);

const FORECAST_DAILY = new Set([
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'sunrise',
    'sunset',
    'uv_index_max',
    'precipitation_sum',
    'precipitation_hours',
    'wind_speed_10m_max',
    'wind_gusts_10m_max',
    'wind_direction_10m_dominant',
]);

const MARINE_CURRENT = new Set([
    'wave_height',
    'wave_direction',
    'wave_period',
    'wind_wave_height',
    'wind_wave_direction',
    'wind_wave_period',
    'wind_wave_peak_period',
    'swell_wave_height',
    'swell_wave_direction',
    'swell_wave_period',
    'swell_wave_peak_period',
    'secondary_swell_wave_height',
    'secondary_swell_wave_direction',
    'secondary_swell_wave_period',
    'secondary_swell_wave_peak_period',
    'ocean_current_velocity',
    'ocean_current_direction',
    'sea_surface_temperature',
]);

const MARINE_HOURLY = new Set(MARINE_CURRENT);
const MARINE_DAILY = new Set([
    'wave_height_max',
    'wave_direction_dominant',
    'wave_period_max',
    'wind_wave_height_max',
    'wind_wave_direction_dominant',
    'wind_wave_period_max',
    'wind_wave_peak_period_max',
    'swell_wave_height_max',
    'swell_wave_direction_dominant',
    'swell_wave_period_max',
    'swell_wave_peak_period_max',
]);

const FORECAST_MODELS = new Set([
    'best_match',
    'gfs_seamless',
    'ncep_gfs025',
    'ecmwf_ifs025',
    'ecmwf_aifs025_single',
    'icon_seamless',
    'dwd_icon',
    'bom_access_global',
    'gem_seamless',
    'ukmo_global_deterministic_10km',
    'jma_gsm',
]);

const MARINE_MODELS = new Set(['best_match', 'ecmwf_wam025', 'dwd_gwam', 'meteofrance_wave', 'ncep_gfswave025']);

function response(error: string | null, status: number, body?: string): Response {
    return new Response(body ?? JSON.stringify(error ? { error } : {}), {
        status,
        headers: JSON_HEADERS,
    });
}

function asString(value: unknown, maxLength = 2_000): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const result = String(value);
    if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) return null;
    return result;
}

function parseCsv(value: unknown, allowed: ReadonlySet<string>, maxItems: number): string | null {
    const raw = asString(value);
    if (!raw) return null;
    const items = raw.split(',');
    if (items.length < 1 || items.length > maxItems || new Set(items).size !== items.length) return null;
    if (items.some((item) => !item || item.trim() !== item || !allowed.has(item))) return null;
    return items.join(',');
}

function parseCoordinates(value: unknown, axis: 'lat' | 'lon'): string[] | null {
    const raw = asString(value, 1_200);
    if (!raw) return null;
    const values = raw.split(',');
    if (values.length < 1 || values.length > 50) return null;
    const bound = axis === 'lat' ? 90 : 180;
    for (const value of values) {
        if (!value || value.trim() !== value) return null;
        const number = Number(value);
        if (!Number.isFinite(number) || Math.abs(number) > bound) return null;
    }
    return values;
}

function parseDate(value: unknown): Date | null {
    const raw = asString(value, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const date = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : date;
}

function validateDates(params: Record<string, unknown>): boolean {
    const hasStart = params.start_date !== undefined;
    const hasEnd = params.end_date !== undefined;
    if (!hasStart && !hasEnd) return true;
    if (!hasStart || !hasEnd) return false;

    const start = parseDate(params.start_date);
    const end = parseDate(params.end_date);
    if (!start || !end || end < start) return false;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const day = 86_400_000;
    return (
        start.getTime() >= today.getTime() - 92 * day &&
        end.getTime() <= today.getTime() + 16 * day &&
        end.getTime() - start.getTime() <= 16 * day
    );
}

function validateTimezone(value: unknown): string | null {
    const timezone = asString(value, 64);
    if (!timezone) return null;
    if (timezone === 'auto' || timezone === 'UTC') return timezone;
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timezone) ? timezone : null;
}

function validateRequest(operation: Operation, params: Record<string, unknown>): QueryRecord | null {
    if (Object.keys(params).length < 3 || Object.keys(params).length > 18) return null;
    if (Object.keys(params).some((name) => !COMMON_PARAMETERS.has(name))) return null;

    const latitude = parseCoordinates(params.latitude, 'lat');
    const longitude = parseCoordinates(params.longitude, 'lon');
    if (!latitude || !longitude || latitude.length !== longitude.length) return null;

    const currentAllowed = operation === 'forecast' ? FORECAST_CURRENT : MARINE_CURRENT;
    const hourlyAllowed = operation === 'forecast' ? FORECAST_HOURLY : MARINE_HOURLY;
    const dailyAllowed = operation === 'forecast' ? FORECAST_DAILY : MARINE_DAILY;
    const output: QueryRecord = {
        latitude: latitude.join(','),
        longitude: longitude.join(','),
    };

    let selectorCount = 0;
    for (const [name, allowed, max] of [
        ['current', currentAllowed, 24],
        ['hourly', hourlyAllowed, 32],
        ['daily', dailyAllowed, 24],
    ] as const) {
        if (params[name] === undefined) continue;
        const parsed = parseCsv(params[name], allowed, max);
        if (!parsed) return null;
        output[name] = parsed;
        selectorCount += 1;
    }
    if (selectorCount === 0) return null;

    if (params.models !== undefined) {
        const models = parseCsv(params.models, operation === 'forecast' ? FORECAST_MODELS : MARINE_MODELS, 8);
        if (!models) return null;
        output.models = models;
    }

    for (const [name, min, max] of [
        ['forecast_days', 1, 16],
        ['forecast_hours', 1, 384],
        ['past_days', 0, 5],
    ] as const) {
        if (params[name] === undefined) continue;
        const parsed = parseBoundedInteger(params[name], min, max);
        if (parsed === null) return null;
        output[name] = String(parsed);
    }

    if (!validateDates(params)) return null;
    if (params.start_date !== undefined) {
        output.start_date = asString(params.start_date, 10)!;
        output.end_date = asString(params.end_date, 10)!;
    }

    if (params.timezone !== undefined) {
        const timezone = validateTimezone(params.timezone);
        if (!timezone) return null;
        output.timezone = timezone;
    }

    const enums: Record<string, ReadonlySet<string>> = {
        timeformat: new Set(['iso8601', 'unixtime']),
        wind_speed_unit: new Set(['kmh', 'ms', 'mph', 'kn']),
        temperature_unit: new Set(['celsius', 'fahrenheit']),
        precipitation_unit: new Set(['mm', 'inch']),
        cell_selection: new Set(['land', 'sea', 'nearest']),
        elevation: new Set(['nan']),
    };
    for (const [name, allowed] of Object.entries(enums)) {
        if (params[name] === undefined) continue;
        const value = asString(params[name], 16);
        if (!value || !allowed.has(value)) return null;
        output[name] = value;
    }

    const queryLength = new URLSearchParams(output).toString().length;
    return queryLength <= 8_000 ? output : null;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return response('POST required', 405);

    const caller = await requireAuthenticatedOrPublicQuota(req, 'openmeteo', 1_200, 120, 3_600);
    if (caller instanceof Response) return withCors(caller, CORS);

    const apiKey = Deno.env.get('OPEN_METEO_API_KEY');
    if (!apiKey) return response('Weather service unavailable', 503);

    const body = await readJsonObject(req, 20_000);
    const operation = body?.operation;
    const rawParams = body?.params;
    if (
        (operation !== 'forecast' && operation !== 'marine') ||
        !rawParams ||
        typeof rawParams !== 'object' ||
        Array.isArray(rawParams)
    ) {
        return response('Invalid request', 400);
    }

    const params = validateRequest(operation, rawParams as Record<string, unknown>);
    if (!params) return response('Invalid request', 400);

    const query = new URLSearchParams({ ...params, apikey: apiKey });
    try {
        const upstream = await fetchWithTimeout(
            `${UPSTREAMS[operation]}?${query}`,
            {
                headers: { Accept: 'application/json' },
            },
            15_000,
        );
        if (!upstream.ok) {
            console.error(`[proxy-openmeteo] upstream status ${upstream.status}`);
            return response('Weather upstream unavailable', 502);
        }

        const text = await readResponseTextLimited(upstream, 16_000_000);
        if (text === null) return response('Weather upstream unavailable', 502);
        try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object') throw new Error('invalid payload');
        } catch {
            return response('Weather upstream unavailable', 502);
        }
        return response(null, 200, text);
    } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'AbortError';
        console.error(`[proxy-openmeteo] ${timedOut ? 'upstream timeout' : 'upstream request failed'}`);
        return response('Weather upstream unavailable', timedOut ? 504 : 502);
    }
});
