/**
 * vessels-nearby — Supabase Edge Function
 *
 * Returns AIS vessels within a radius of a given point.
 * Used by the Thalassa app to populate the map with server-side AIS data.
 *
 * Query params:
 *   lat    — latitude (required)
 *   lon    — longitude (required)
 *   radius — radius in nautical miles (default: 25)
 *   limit  — max results (default: 500)
 *
 * Returns: GeoJSON FeatureCollection
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, parseBoundedInteger, parseBoundedNumber, parseCoordinate } from '../_shared/http-security.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

interface NormalizedVessel {
    mmsi: number;
    name: string | null;
    callSign: string | null;
    shipType: number | null;
    destination: string | null;
    lat: number;
    lon: number;
    cog: number | null;
    sog: number | null;
    heading: number | null;
    navStatus: number | null;
    updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function optionalNumber(value: unknown, min: number, max: number): number | null | undefined {
    if (value === null || value === undefined) return null;
    return finiteNumber(value, min, max) ?? undefined;
}

function optionalInteger(value: unknown, min: number, max: number): number | null | undefined {
    const parsed = optionalNumber(value, min, max);
    return parsed === null || (parsed !== undefined && Number.isInteger(parsed)) ? parsed : undefined;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.length > maxLength) return undefined;
    const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    return cleaned || null;
}

function normalizeMmsi(value: unknown): number | null {
    const parsed =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && /^[1-9]\d{8}$/.test(value)
              ? Number(value)
              : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 100_000_000 && parsed <= 999_999_999 ? parsed : null;
}

function normalizeVessel(value: unknown, nowMs: number): NormalizedVessel | null {
    if (!isRecord(value)) return null;

    const mmsi = normalizeMmsi(value.mmsi);
    const lat = finiteNumber(value.lat, -90, 90);
    const lon = finiteNumber(value.lon, -180, 180);
    const name = optionalText(value.name, 120);
    const callSign = optionalText(value.call_sign, 32);
    const destination = optionalText(value.destination, 200);
    const shipType = optionalInteger(value.ship_type, 0, 99);
    const cog = optionalNumber(value.cog, 0, 360);
    const sog = optionalNumber(value.sog, 0, 102.3);
    const heading = optionalInteger(value.heading, 0, 511);
    const navStatus = optionalInteger(value.nav_status, 0, 15);
    const updatedAtMs = typeof value.updated_at === 'string' ? Date.parse(value.updated_at) : NaN;
    const freshTimestamp =
        Number.isFinite(updatedAtMs) &&
        updatedAtMs > nowMs - 2 * 60 * 60 * 1_000 &&
        updatedAtMs <= nowMs + 2 * 60 * 1_000;

    if (
        mmsi === null ||
        lat === null ||
        lon === null ||
        name === undefined ||
        callSign === undefined ||
        destination === undefined ||
        shipType === undefined ||
        cog === undefined ||
        sog === undefined ||
        heading === undefined ||
        navStatus === undefined ||
        !freshTimestamp
    ) {
        return null;
    }

    return {
        mmsi,
        name,
        callSign,
        shipType,
        destination,
        lat,
        lon,
        cog,
        sog,
        heading,
        navStatus,
        updatedAt: new Date(updatedAtMs).toISOString(),
    };
}

function respond(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return withCors(jsonResponse(body, status, extraHeaders), corsHeaders);
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== 'GET') {
        return respond({ error: 'GET required' }, 405, { Allow: 'GET' });
    }

    const caller = await requireAuthenticatedQuota(req, 'vessels_nearby', 360, 3600);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    try {
        const url = new URL(req.url);
        const lat = parseCoordinate(url.searchParams.get('lat'), 'lat');
        const lon = parseCoordinate(url.searchParams.get('lon'), 'lon');
        const radiusNm = parseBoundedNumber(url.searchParams.get('radius') ?? '25', 0.5, 100);
        const limit = parseBoundedInteger(url.searchParams.get('limit') ?? '250', 1, 250);

        if (lat === null || lon === null || radiusNm === null || limit === null) {
            return respond({ error: 'Invalid coordinate, radius, or limit bounds' }, 400);
        }

        // Convert nautical miles to meters (1 NM = 1852 m)
        const radiusMeters = radiusNm * 1852;

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
        const authorization = req.headers.get('authorization');
        if (!supabaseUrl || !publicKey || !authorization) {
            return respond({ error: 'Server database is not configured' }, 500);
        }
        const supabase = createClient(supabaseUrl, publicKey, {
            global: { headers: { Authorization: authorization } },
            auth: { persistSession: false, autoRefreshToken: false },
        });

        // Spatial query using ST_DWithin on geography column
        const { data, error } = await supabase.rpc('vessels_nearby', {
            query_lat: lat,
            query_lon: lon,
            radius_m: radiusMeters,
            max_results: limit,
        });

        if (error) {
            console.error('vessels_nearby RPC error:', error);
            return respond({ error: 'Vessel query failed' }, 500);
        }

        if (!Array.isArray(data) || data.length > limit) {
            console.error('vessels_nearby RPC returned an invalid result envelope');
            return respond({ error: 'Invalid vessel data received' }, 502);
        }

        const nowMs = Date.now();
        const normalized = data.map((row: unknown) => normalizeVessel(row, nowMs));
        if (normalized.some((row) => row === null)) {
            console.error('vessels_nearby RPC returned an invalid vessel row');
            return respond({ error: 'Invalid vessel data received' }, 502);
        }

        const features = (normalized as NormalizedVessel[]).map((v) => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [v.lon, v.lat],
            },
            properties: {
                mmsi: v.mmsi,
                name: v.name || `MMSI ${v.mmsi}`,
                callSign: v.callSign,
                shipType: v.shipType,
                destination: v.destination,
                cog: v.cog,
                sog: v.sog,
                heading: v.heading,
                navStatus: v.navStatus,
                updatedAt: v.updatedAt,
                source: 'aisstream', // Distinguishes from local NMEA AIS
            },
        }));

        const geojson = {
            type: 'FeatureCollection',
            features,
        };

        return respond(geojson, 200, {
            'Cache-Control': 'private, max-age=5',
            Vary: 'Authorization',
        });
    } catch (e) {
        console.error('Edge function error:', e);
        return respond({ error: 'Internal server error' }, 500);
    }
});
