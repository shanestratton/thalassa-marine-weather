// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseBoundedInteger,
    parseBoundedNumber,
    parseCoordinate,
    readJsonObject,
    readResponseJsonObjectLimited,
} from '../_shared/http-security.ts';

/**
 * proxy-tides — WorldTides API Proxy
 *
 * Proxies tide requests through Supabase Edge so the WorldTides API key
 * never leaves the server. The client sends lat/lon/days; this function
 * appends the secret key and forwards to WorldTides, returning the response.
 *
 * Request: POST with JSON body:
 *   { lat: number, lon: number, days?: number, stations?: boolean, stationDistance?: number }
 *
 * When `stations: true` → returns nearby tide stations (discovery).
 * Otherwise → returns tide extremes (high/low times + heights).
 *
 * Required Supabase Secret:
 *   WORLDTIDES_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, {
        status,
        headers: {
            ...CORS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...extra,
        },
    });
}

const WORLDTIDES_URL = 'https://www.worldtides.info/api/v3';
const MAX_UPSTREAM_BYTES = 512_000;
const MAX_STATIONS = 500;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

function hasBoundedJsonShape(value: unknown, budget: { remaining: number }, depth = 0): boolean {
    if (--budget.remaining < 0 || depth > 5) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 4_096;
    if (Array.isArray(value)) {
        return value.length <= MAX_STATIONS && value.every((item) => hasBoundedJsonShape(item, budget, depth + 1));
    }
    if (!isPlainRecord(value)) return false;
    const entries = Object.entries(value);
    return (
        entries.length <= 96 &&
        entries.every(
            ([name, item]) =>
                name.length <= 100 && !hasControlCharacters(name) && hasBoundedJsonShape(item, budget, depth + 1),
        )
    );
}

function isValidStation(value: unknown): boolean {
    if (!isPlainRecord(value)) return false;
    const lat = parseCoordinate(value.lat, 'lat');
    const lon = parseCoordinate(value.lon, 'lon');
    const distance = value.distance === undefined ? 0 : parseBoundedNumber(value.distance, 0, 1_000);
    const idIsValid =
        (typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200) ||
        (typeof value.id === 'number' && Number.isSafeInteger(value.id));
    return (
        lat !== null &&
        lon !== null &&
        distance !== null &&
        idIsValid &&
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        value.name.length <= 300
    );
}

function isValidExtreme(value: unknown): boolean {
    if (!isPlainRecord(value)) return false;
    const timestamp = parseBoundedInteger(value.dt, 946_684_800, 4_102_444_800);
    const height = parseBoundedNumber(value.height, -100, 100);
    return (
        timestamp !== null &&
        height !== null &&
        typeof value.date === 'string' &&
        value.date.length <= 64 &&
        Number.isFinite(Date.parse(value.date)) &&
        (value.type === 'High' || value.type === 'Low')
    );
}

function isValidWorldTidesResponse(value: Record<string, unknown>, stations: boolean, days: number): boolean {
    if (value.status !== 200 || value.error != null || !hasBoundedJsonShape(value, { remaining: 25_000 })) {
        return false;
    }

    if (stations) {
        return (
            Array.isArray(value.stations) &&
            value.stations.length <= MAX_STATIONS &&
            value.stations.every(isValidStation)
        );
    }

    const maxExtremes = days * 8 + 16;
    return (
        Array.isArray(value.extremes) && value.extremes.length <= maxExtremes && value.extremes.every(isValidExtreme)
    );
}

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
        return corsResponse(JSON.stringify({ error: 'GET or POST required' }), 405);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'tides', 60, 12, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    const key = Deno.env.get('WORLDTIDES_API_KEY');
    if (!key) {
        return corsResponse(JSON.stringify({ error: 'Tide service is not configured' }), 500);
    }

    try {
        // Support both GET (query params) and POST (JSON body)
        let rawLat: unknown;
        let rawLon: unknown;
        let rawDays: unknown;
        let rawStations: unknown;
        let rawDist: unknown;
        if (req.method === 'GET') {
            const url = new URL(req.url);
            rawLat = url.searchParams.get('lat');
            rawLon = url.searchParams.get('lon');
            rawDays = url.searchParams.get('days') ?? 14;
            rawStations = url.searchParams.get('stations') ?? false;
            rawDist = url.searchParams.get('stationDistance') ?? 100;
        } else {
            const body = await readJsonObject(req, 4096);
            if (!body) return corsResponse(JSON.stringify({ error: 'Invalid JSON request body' }), 400);
            rawLat = body.lat;
            rawLon = body.lon;
            rawDays = body.days ?? 14;
            rawStations = body.stations ?? false;
            rawDist = body.stationDistance ?? 100;
        }

        const lat = parseCoordinate(rawLat, 'lat');
        const lon = parseCoordinate(rawLon, 'lon');
        const days = parseBoundedInteger(rawDays, 1, 14);
        const stationDistance = parseBoundedNumber(rawDist, 1, 100);
        const stations = rawStations === true || rawStations === 'true';
        if (
            lat === null ||
            lon === null ||
            days === null ||
            stationDistance === null ||
            ![true, false, 'true', 'false'].includes(rawStations as boolean | string)
        ) {
            return corsResponse(JSON.stringify({ error: 'Invalid tide request bounds' }), 400);
        }

        const upstreamUrl = new URL(WORLDTIDES_URL);
        upstreamUrl.searchParams.set('lat', String(lat));
        upstreamUrl.searchParams.set('lon', String(lon));
        upstreamUrl.searchParams.set('stationDistance', String(stationDistance));
        upstreamUrl.searchParams.set('key', key);

        if (stations) {
            // Station discovery — return nearby tide stations within radius
            upstreamUrl.searchParams.set('stations', '');
        } else {
            // Tide extremes — high/low tide times + heights
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            today.setDate(today.getDate() - 1); // Go back 24h for graph interpolation
            const start = Math.floor(today.getTime() / 1000);
            upstreamUrl.searchParams.set('extremes', '');
            upstreamUrl.searchParams.set('days', String(days));
            upstreamUrl.searchParams.set('datum', 'LAT');
            upstreamUrl.searchParams.set('start', String(start));
        }

        const res = await fetchWithTimeout(upstreamUrl, {}, 12_000);
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            console.error(`[proxy-tides] upstream status ${res.status}`);
            return corsResponse(JSON.stringify({ error: 'Tide upstream failed' }), 502);
        }

        const data = await readResponseJsonObjectLimited(res, MAX_UPSTREAM_BYTES);
        if (!data || !isValidWorldTidesResponse(data, stations, days)) {
            console.error('[proxy-tides] invalid upstream response');
            return corsResponse(JSON.stringify({ error: 'Tide upstream failed' }), 502);
        }

        return corsResponse(JSON.stringify(data), 200, { 'Cache-Control': 'public, max-age=900' });
    } catch {
        console.error('[proxy-tides] request failed');
        return corsResponse(JSON.stringify({ error: 'Tide request failed' }), 502);
    }
});
