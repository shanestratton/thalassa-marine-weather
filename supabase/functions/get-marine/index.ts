// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, parseCoordinate, readResponseJsonObjectLimited } from '../_shared/http-security.ts';

/**
 * get-marine — waves, swell, sea temperature and current.
 *
 * The Supabase HALF of the marine pipeline. The Pi serves this from the boat
 * LAN (pi-cache/src/routes/weather.ts `/api/weather/marine`); this function is
 * the identical upstream from a second machine, for when there is no Pi, the
 * Pi is unreachable, or its copy is stale. Client order is Pi → here → null
 * (services/weather/api/marine.ts).
 *
 * Upstream is Open-Meteo's marine grid on the commercial key, which this
 * project already uses for atmospheric data — so consolidating marine here
 * REMOVES StormGlass as a third party rather than adding one, and keeps the
 * commercial key off the client.
 *
 * Request:  GET ?lat=X&lon=Y
 * Response: the Open-Meteo marine payload, unmodified.
 *
 * DELIBERATELY A PASS-THROUGH. The client maps and converts units in ONE
 * place (services/weather/api/marine.ts) so the Pi and this function cannot
 * drift apart into two subtly different mappers — this codebase has been
 * bitten by hand-mirrored pairs before. Two traps live in that mapper:
 * ocean_current_velocity is km/h where the app wants m/s, and wave heights
 * cross the report boundary in FEET.
 *
 * THE RESPONSE ALWAYS ECHOES latitude/longitude, and the client compares them
 * against the request. The marine grid is ocean-only: an inshore point is not
 * rejected, it is silently SNAPPED to the nearest wet cell and answered
 * confidently. Measured at Newport 2026-07-22 — a request inside Moreton Bay
 * came back from a cell 10.7 km east with wave_height 0.58 m and no warning.
 * Never strip those coordinates from this response.
 *
 * Required Supabase Secret: OPEN_METEO_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const BASE_URL = 'https://customer-marine-api.open-meteo.com/v1/marine';
const MAX_UPSTREAM_BYTES = 2_000_000;

/** Kept in lockstep with the Pi route so both machines answer identically. */
const HOURLY =
    'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,wind_wave_period,' +
    'swell_wave_height,swell_wave_direction,swell_wave_period,secondary_swell_wave_height,secondary_swell_wave_period,' +
    'sea_surface_temperature,ocean_current_velocity,ocean_current_direction';

const CURRENT =
    'wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height,swell_wave_period,' +
    'sea_surface_temperature,ocean_current_velocity,ocean_current_direction';

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidMarinePayload(value: Record<string, unknown>): boolean {
    if (
        typeof value.latitude !== 'number' ||
        !Number.isFinite(value.latitude) ||
        typeof value.longitude !== 'number' ||
        !Number.isFinite(value.longitude) ||
        !isRecord(value.current) ||
        !isRecord(value.hourly)
    ) {
        return false;
    }

    if (
        typeof value.current.time !== 'string' ||
        value.current.time.length > 64 ||
        (value.current.wave_height !== null &&
            (typeof value.current.wave_height !== 'number' || !Number.isFinite(value.current.wave_height)))
    ) {
        return false;
    }

    const times = value.hourly.time;
    if (
        !Array.isArray(times) ||
        times.length === 0 ||
        times.length > 192 ||
        !times.every((time) => typeof time === 'string' && time.length <= 64)
    ) {
        return false;
    }
    if (
        !Array.isArray(value.hourly.wave_height) ||
        value.hourly.wave_height.length === 0 ||
        value.hourly.wave_height.length > 192 ||
        !value.hourly.wave_height.every((item) => item === null || (typeof item === 'number' && Number.isFinite(item)))
    ) {
        return false;
    }

    for (const [key, series] of Object.entries(value.hourly)) {
        if (key === 'time') continue;
        if (
            !Array.isArray(series) ||
            series.length > 192 ||
            series.length !== times.length ||
            !series.every((item) => item === null || (typeof item === 'number' && Number.isFinite(item)))
        ) {
            return false;
        }
    }
    return true;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return json({ error: 'GET required' }, 405);

    const caller = await requireAuthenticatedOrPublicQuota(req, 'marine', 120, 20, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const url = new URL(req.url);
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat');
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon');
        if (lat === null || lon === null) return json({ error: 'lat/lon must be valid coordinates' }, 400);

        // 2dp — matches the Pi's cache key granularity (~1 km), so the two
        // machines answer for the same grid point rather than one of them
        // quietly serving a neighbouring cell.
        const rlat = Number(lat.toFixed(2));
        const rlon = Number(lon.toFixed(2));

        const key = Deno.env.get('OPEN_METEO_API_KEY') ?? '';
        if (!key) return json({ error: 'Marine service is not configured' }, 500);
        const params = new URLSearchParams({
            latitude: String(rlat),
            longitude: String(rlon),
            hourly: HOURLY,
            current: CURRENT,
            timezone: 'auto',
        });
        params.set('apikey', key);

        const upstream = await fetchWithTimeout(`${BASE_URL}?${params.toString()}`, {}, 12_000);
        if (!upstream.ok) {
            await upstream.body?.cancel().catch(() => undefined);
            return json({ error: 'Marine upstream failed', status: upstream.status }, 502);
        }

        const data = await readResponseJsonObjectLimited(upstream, MAX_UPSTREAM_BYTES);
        if (!data || !isValidMarinePayload(data)) {
            return json({ error: 'Marine upstream returned an invalid response' }, 502);
        }
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: {
                ...CORS,
                'Content-Type': 'application/json',
                // 15 min: the marine grid updates far slower than this, and it
                // spares the commercial quota on a boat re-opening the app.
                'Cache-Control': 'public, max-age=900',
            },
        });
    } catch {
        console.error('[get-marine] upstream request failed');
        return json({ error: 'Marine fetch failed' }, 502);
    }
});
