// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    hasPngSignature,
    hasWebpSignature,
    parseBoundedInteger,
    parseBoundedNumber,
    parseCoordinate,
    readResponseArrayBufferLimited,
    readResponseJsonObjectLimited,
} from '../_shared/http-security.ts';

/**
 * proxy-rainbow — Rainbow.ai API Proxy (Tiles + Nowcast)
 *
 * Five modes:
 *   1. Snapshot:  GET /proxy-rainbow?action=snapshot&layer=precip|precip-global|clouds
 *                 → Fetches current snapshot ID from Rainbow.ai
 *   2. Tile:     GET /proxy-rainbow?action=tile&snapshot=<id>&forecast=<secs>&z=<z>&x=<x>&y=<y>&layer=precip|precip-global|clouds
 *                 → Proxies tile PNG with token injected server-side
 *   3. Nowcast:  GET /proxy-rainbow?action=nowcast&lat=<lat>&lon=<lon>
 *                 → Direct JSON precipitation forecast via Rainbow Global Nowcast API
 *                 → Returns minute-by-minute precipRate + precipType for 4 hours
 *   4. Point:    GET /proxy-rainbow?action=point&lat=<lat>&lon=<lon>
 *                 → Legacy alias for nowcast (backward compatible)
 *
 * Required Supabase Secret:
 *   RAINBOW_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const RAINBOW_TILES = 'https://api.rainbow.ai/tiles/v1';
const RAINBOW_NOWCAST = 'https://api.rainbow.ai/nowcast/v1';
const MAX_JSON_BYTES = 512_000;
const MAX_TILE_BYTES = 2_000_000;
const MAX_FORECAST_ITEMS = 300;
const TILE_LAYERS = new Set(['precip', 'precip-global', 'clouds']);
const TILE_COLORS = new Set(['', '6', 'dbz_u8']);

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...extraHeaders,
        },
    });
}

function hasOnlyQueryParameters(url: URL, allowed: ReadonlySet<string>): boolean {
    const names = [...url.searchParams.keys()];
    return names.every((name) => allowed.has(name) && url.searchParams.getAll(name).length === 1);
}

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
    if (typeof value === 'string') return value.length <= 2_048;
    if (Array.isArray(value)) {
        return (
            value.length <= MAX_FORECAST_ITEMS && value.every((item) => hasBoundedJsonShape(item, budget, depth + 1))
        );
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

function isValidSnapshotResponse(value: Record<string, unknown>): boolean {
    return (
        value.error == null &&
        typeof value.snapshot === 'number' &&
        Number.isSafeInteger(value.snapshot) &&
        value.snapshot > 0 &&
        hasBoundedJsonShape(value, { remaining: 1_000 })
    );
}

function isValidForecastEntry(value: unknown): boolean {
    if (!isPlainRecord(value)) return false;
    const timestampBegin = parseBoundedInteger(value.timestampBegin, 946_684_800, 4_102_444_800);
    const timestampEnd = parseBoundedInteger(value.timestampEnd, 946_684_800, 4_102_444_800);
    const precipRate = parseBoundedNumber(value.precipRate, 0, 1_000);
    const precipTypeIsValid =
        value.precipType === undefined ||
        (typeof value.precipType === 'string' &&
            value.precipType.length <= 64 &&
            !hasControlCharacters(value.precipType));
    return (
        timestampBegin !== null &&
        timestampEnd !== null &&
        timestampEnd >= timestampBegin &&
        timestampEnd - timestampBegin <= 3_600 &&
        precipRate !== null &&
        precipTypeIsValid
    );
}

function isValidNowcastResponse(value: Record<string, unknown>): boolean {
    if (
        value.error != null ||
        !Array.isArray(value.forecast) ||
        value.forecast.length > MAX_FORECAST_ITEMS ||
        !value.forecast.every(isValidForecastEntry) ||
        !hasBoundedJsonShape(value, { remaining: 25_000 })
    ) {
        return false;
    }

    if (value.summary === undefined) return true;
    if (!isPlainRecord(value.summary)) return false;
    const intensity = value.summary.intensity;
    return (
        intensity === undefined ||
        (typeof intensity === 'string' && intensity.length <= 100 && !hasControlCharacters(intensity))
    );
}

function parseTileContentType(value: string | null): 'image/png' | 'image/webp' | null {
    if (!value) return null;
    const mediaType = value.split(';', 1)[0].trim().toLowerCase();
    return mediaType === 'image/png' || mediaType === 'image/webp' ? mediaType : null;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'GET') {
        return jsonResponse({ error: 'GET required' }, 405, { Allow: 'GET' });
    }

    const key = Deno.env.get('RAINBOW_API_KEY');
    if (!key) {
        return jsonResponse({ error: 'Rainbow service is not configured' }, 500);
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    if (url.searchParams.getAll('action').length !== 1) {
        return jsonResponse({ error: 'Invalid action' }, 400);
    }
    const quota =
        action === 'tile'
            ? await requireAuthenticatedOrPublicQuota(req, 'rainbow_tile', 4000, 1200, 3600, true)
            : await requireAuthenticatedOrPublicQuota(req, 'rainbow', 240, 30, 3600, true);
    if (quota instanceof Response) return withCors(quota, CORS);

    try {
        // ═══ ACTION: SNAPSHOT ═══
        if (action === 'snapshot') {
            if (!hasOnlyQueryParameters(url, new Set(['action', 'layer']))) {
                return jsonResponse({ error: 'Invalid snapshot params' }, 400);
            }
            const layer = url.searchParams.get('layer') || 'precip';
            if (!TILE_LAYERS.has(layer)) {
                return jsonResponse({ error: 'Invalid layer' }, 400);
            }
            const res = await fetchWithTimeout(
                `${RAINBOW_TILES}/snapshot?token=${key}&layer=${encodeURIComponent(layer)}`,
                {},
                10_000,
            );
            if (!res.ok) {
                await res.body?.cancel().catch(() => undefined);
                console.error(`[proxy-rainbow] snapshot upstream status ${res.status}`);
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            const data = await readResponseJsonObjectLimited(res, 32_000);
            if (!data || !isValidSnapshotResponse(data)) {
                console.error('[proxy-rainbow] invalid snapshot response');
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            return jsonResponse(data, 200, { 'Cache-Control': 'public, max-age=300' });
        }

        // ═══ ACTION: NOWCAST (new Nowcast API — direct JSON) ═══
        if (action === 'nowcast') {
            if (!hasOnlyQueryParameters(url, new Set(['action', 'lat', 'lon']))) {
                return jsonResponse({ error: 'Invalid nowcast params' }, 400);
            }
            const lat = parseCoordinate(url.searchParams.get('lat'), 'lat');
            const lon = parseCoordinate(url.searchParams.get('lon'), 'lon');

            if (lat === null || lon === null) {
                return jsonResponse({ error: 'Invalid coordinates' }, 400);
            }

            // Nowcast API: /nowcast/v1/precip-global/{longitude}/{latitude}
            // NOTE: longitude comes FIRST in the path!
            const nowcastUrl = `${RAINBOW_NOWCAST}/precip-global/${lon.toFixed(4)}/${lat.toFixed(4)}?token=${key}`;
            const res = await fetchWithTimeout(nowcastUrl, {}, 12_000);
            if (!res.ok) {
                await res.body?.cancel().catch(() => undefined);
                console.error(`[proxy-rainbow] nowcast upstream status ${res.status}`);
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            const data = await readResponseJsonObjectLimited(res, MAX_JSON_BYTES);
            if (!data || !isValidNowcastResponse(data)) {
                console.error('[proxy-rainbow] invalid nowcast response');
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            return jsonResponse(data, 200, { 'Cache-Control': 'public, max-age=300' });
        }

        // ═══ ACTION: TILE ═══
        if (action === 'tile') {
            if (
                !hasOnlyQueryParameters(
                    url,
                    new Set(['action', 'snapshot', 'forecast', 'z', 'x', 'y', 'color', 'layer']),
                )
            ) {
                return jsonResponse({ error: 'Invalid tile params' }, 400);
            }
            const snapshot = url.searchParams.get('snapshot');
            const forecast = parseBoundedInteger(url.searchParams.get('forecast'), 0, 14_400);
            const z = parseBoundedInteger(url.searchParams.get('z'), 0, 14);
            const x = parseBoundedInteger(url.searchParams.get('x'), 0, z === null ? 0 : 2 ** z - 1);
            const y = parseBoundedInteger(url.searchParams.get('y'), 0, z === null ? 0 : 2 ** z - 1);
            const color = url.searchParams.get('color') || '';
            const layer = url.searchParams.get('layer') || 'precip'; // precip | precip-global | clouds

            if (
                !snapshot ||
                !/^\d{1,16}$/.test(snapshot) ||
                z === null ||
                x === null ||
                y === null ||
                !TILE_LAYERS.has(layer) ||
                !TILE_COLORS.has(color) ||
                (url.searchParams.has('forecast') && forecast === null)
            ) {
                return jsonResponse({ error: 'Invalid tile params' }, 400);
            }

            // Cloud tiles don't have a forecast time parameter
            let tileUrl: string;
            if (layer === 'clouds') {
                tileUrl = `${RAINBOW_TILES}/clouds/${snapshot}/${z}/${x}/${y}?token=${key}`;
            } else {
                if (forecast === null) {
                    return jsonResponse({ error: 'forecast param required for precip tiles' }, 400);
                }
                tileUrl = `${RAINBOW_TILES}/${layer}/${snapshot}/${forecast}/${z}/${x}/${y}?token=${key}`;
                if (color) tileUrl += `&color=${color}`;
            }

            const res = await fetchWithTimeout(tileUrl, {}, 12_000);

            if (!res.ok) {
                await res.body?.cancel().catch(() => undefined);
                console.error(`[proxy-rainbow] tile upstream status ${res.status}`);
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }

            const contentType = parseTileContentType(res.headers.get('content-type'));
            if (!contentType) {
                await res.body?.cancel().catch(() => undefined);
                console.error('[proxy-rainbow] invalid tile content type');
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            const body = await readResponseArrayBufferLimited(res, MAX_TILE_BYTES);
            const signatureIsValid =
                body !== null &&
                ((contentType === 'image/png' && hasPngSignature(body)) ||
                    (contentType === 'image/webp' && hasWebpSignature(body)));
            if (!body || !signatureIsValid) {
                console.error('[proxy-rainbow] invalid tile response');
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }
            return new Response(body, {
                status: 200,
                headers: {
                    ...CORS,
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=300',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }

        // ═══ ACTION: POINT (legacy — redirects to nowcast) ═══
        if (action === 'point') {
            if (!hasOnlyQueryParameters(url, new Set(['action', 'lat', 'lon']))) {
                return jsonResponse({ error: 'Invalid point params' }, 400);
            }
            const lat = parseCoordinate(url.searchParams.get('lat'), 'lat');
            const lon = parseCoordinate(url.searchParams.get('lon'), 'lon');

            if (lat === null || lon === null) {
                return jsonResponse({ error: 'Invalid coordinates' }, 400);
            }

            // Use the Nowcast API directly — much faster than tile decoding
            const nowcastUrl = `${RAINBOW_NOWCAST}/precip-global/${lon.toFixed(4)}/${lat.toFixed(4)}?token=${key}`;
            const res = await fetchWithTimeout(nowcastUrl, {}, 12_000);

            if (!res.ok) {
                await res.body?.cancel().catch(() => undefined);
                console.error(`[proxy-rainbow] point upstream status ${res.status}`);
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }

            const nowcastData = await readResponseJsonObjectLimited(res, MAX_JSON_BYTES);
            if (!nowcastData || !isValidNowcastResponse(nowcastData)) {
                console.error('[proxy-rainbow] invalid point response');
                return jsonResponse({ error: 'Rainbow upstream failed' }, 502);
            }

            // Map to legacy point format for backward compatibility
            const forecast = nowcastData.forecast as {
                precipRate: number;
                precipType?: string;
                timestampBegin: number;
                timestampEnd: number;
            }[];
            const data = forecast
                .filter((_: unknown, i: number) => i % 10 === 0 || i < 60) // Sample: every minute for 1h, every 10m after
                .map((f: { precipRate: number; precipType?: string; timestampBegin: number }) => ({
                    forecastMinutes: Math.round(
                        (f.timestampBegin - (forecast[0]?.timestampBegin ?? f.timestampBegin)) / 60,
                    ),
                    intensity: Math.round((f.precipRate ?? 0) * 100) / 100,
                    precipType: f.precipType || undefined,
                }));

            return jsonResponse(
                {
                    lat,
                    lon,
                    data,
                    nowcast: nowcastData, // Also include the raw Nowcast API response
                },
                200,
                { 'Cache-Control': 'public, max-age=300' },
            );
        }

        return jsonResponse({ error: 'Unknown action' }, 400);
    } catch {
        console.error('[proxy-rainbow] request failed');
        return jsonResponse({ error: 'Rainbow request failed' }, 502);
    }
});

// PNG pixel extraction and dBZ conversion removed — the Nowcast API
// now returns precipitation data directly as JSON. The tile endpoint
// still serves PNG images for map visualization, but point queries
// use /nowcast/v1/precip-global/{lon}/{lat} which is orders of
// magnitude faster and returns precipType (rain/snow/mixed) too.
