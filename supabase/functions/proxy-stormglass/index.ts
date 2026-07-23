// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseCoordinate,
    readJsonObject,
    readResponseJsonObjectLimited,
} from '../_shared/http-security.ts';

/**
 * proxy-stormglass — StormGlass API Proxy
 *
 * Proxies weather requests through Supabase Edge so the StormGlass API key
 * never leaves the server. The client sends the path and params; this function
 * appends the Authorization header and forwards to StormGlass.
 *
 * Request: POST with JSON body:
 *   { path: string, params: Record<string, string> }
 *   e.g. { path: "weather/point", params: { lat: "-27.4", lng: "153.1", params: "windSpeed,windDirection" } }
 *
 * Required Supabase Secret:
 *   STORMGLASS_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

const BASE_URL = 'https://api.stormglass.io/v2';
const DAY_MS = 86_400_000;
const MAX_UPSTREAM_BYTES = 3_000_000;

const WEATHER_PARAMETERS: ReadonlySet<string> = new Set([
    'airTemperature',
    'cloudCover',
    'currentDirection',
    'currentSpeed',
    'dewPointTemperature',
    'gust',
    'humidity',
    'iceCover',
    'precipitation',
    'pressure',
    'seaLevel',
    'secondarySwellDirection',
    'secondarySwellHeight',
    'secondarySwellPeriod',
    'snowDepth',
    'swellDirection',
    'swellHeight',
    'swellPeriod',
    'visibility',
    'waterTemperature',
    'waveDirection',
    'waveHeight',
    'wavePeriod',
    'windDirection',
    'windSpeed',
    'windWaveDirection',
    'windWaveHeight',
    'windWavePeriod',
]);

const BIO_PARAMETERS: ReadonlySet<string> = new Set([
    'chlorophyll',
    'dissolvedOxygen',
    'iron',
    'nitrate',
    'phosphate',
    'phytoplankton',
]);

const STORMGLASS_SOURCES: ReadonlySet<string> = new Set(['sg', 'ecmwf', 'gfs', 'icon']);

const PATH_RULES = {
    'weather/point': {
        allowedKeys: new Set<string>(['lat', 'lng', 'params', 'start', 'end', 'source']),
        requiredKeys: ['lat', 'lng', 'params', 'start', 'end'],
        metrics: WEATHER_PARAMETERS,
        maxWindowDays: 11,
        maxItems: 300,
        responseArray: 'hours',
    },
    'bio/point': {
        allowedKeys: new Set<string>(['lat', 'lng', 'params', 'start', 'end', 'source']),
        requiredKeys: ['lat', 'lng', 'params', 'start', 'end'],
        metrics: BIO_PARAMETERS,
        maxWindowDays: 11,
        maxItems: 300,
        responseArray: 'hours',
    },
    'tide/extremes/point': {
        allowedKeys: new Set<string>(['lat', 'lng', 'start', 'end']),
        requiredKeys: ['lat', 'lng', 'start', 'end'],
        metrics: null,
        maxWindowDays: 31,
        maxItems: 256,
        responseArray: 'data',
    },
    'tide/sea-level/point': {
        allowedKeys: new Set<string>(['lat', 'lng', 'start', 'end']),
        requiredKeys: ['lat', 'lng', 'start', 'end'],
        metrics: null,
        maxWindowDays: 31,
        maxItems: 800,
        responseArray: 'data',
    },
    'astronomy/point': {
        allowedKeys: new Set<string>(['lat', 'lng', 'start', 'end']),
        requiredKeys: ['lat', 'lng', 'start', 'end'],
        metrics: null,
        maxWindowDays: 31,
        maxItems: 64,
        responseArray: 'data',
    },
} as const;

type StormGlassPath = keyof typeof PATH_RULES;

interface NormalizedStormGlassRequest {
    query: URLSearchParams;
    requestedMetrics: ReadonlySet<string> | null;
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

function parseStormGlassDate(value: unknown): number | null {
    if (
        typeof value !== 'string' ||
        value.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStormGlassRequest(
    path: StormGlassPath,
    params: Record<string, unknown>,
): NormalizedStormGlassRequest | null {
    const rule = PATH_RULES[path];
    const keys = Object.keys(params);
    if (
        keys.length > rule.allowedKeys.size ||
        keys.some((name) => !rule.allowedKeys.has(name)) ||
        rule.requiredKeys.some((name) => !Object.prototype.hasOwnProperty.call(params, name))
    ) {
        return null;
    }

    const lat = parseCoordinate(params.lat, 'lat');
    const lng = parseCoordinate(params.lng, 'lon');
    const start = parseStormGlassDate(params.start);
    const end = parseStormGlassDate(params.end);
    if (lat === null || lng === null || start === null || end === null || end < start) return null;

    const now = Date.now();
    const maxWindowMs = rule.maxWindowDays * DAY_MS;
    if (start < now - 31 * DAY_MS || start > now + DAY_MS || end > now + 32 * DAY_MS || end - start > maxWindowMs) {
        return null;
    }

    const query = new URLSearchParams({
        lat: String(lat),
        lng: String(lng),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
    });

    let requestedMetrics: ReadonlySet<string> | null = null;
    if (rule.metrics) {
        if (typeof params.params !== 'string' || params.params.length > 800) return null;
        const metricList = params.params.split(',');
        if (
            metricList.length < 1 ||
            metricList.length > rule.metrics.size ||
            metricList.some((metric) => !rule.metrics.has(metric))
        ) {
            return null;
        }
        const uniqueMetrics = [...new Set(metricList)];
        if (uniqueMetrics.length !== metricList.length) return null;
        requestedMetrics = new Set(uniqueMetrics);
        query.set('params', uniqueMetrics.join(','));
    }

    if (Object.prototype.hasOwnProperty.call(params, 'source')) {
        if (typeof params.source !== 'string' || !STORMGLASS_SOURCES.has(params.source)) return null;
        query.set('source', params.source);
    }

    return { query, requestedMetrics };
}

function hasBoundedJsonShape(value: unknown, budget: { remaining: number }, depth = 0): boolean {
    if (--budget.remaining < 0 || depth > 5) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 2_048;
    if (Array.isArray(value)) {
        return value.length <= 1_000 && value.every((item) => hasBoundedJsonShape(item, budget, depth + 1));
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

function isValidStormGlassResponse(
    path: StormGlassPath,
    value: Record<string, unknown>,
    requestedMetrics: ReadonlySet<string> | null,
): boolean {
    if (value.error != null || !hasBoundedJsonShape(value, { remaining: 100_000 })) return false;
    const rule = PATH_RULES[path];
    const items = value[rule.responseArray];
    if (!Array.isArray(items) || items.length > rule.maxItems) return false;

    if (rule.responseArray !== 'hours') {
        return items.every((item) => isPlainRecord(item));
    }

    if (!requestedMetrics) return false;
    return items.every((item) => {
        if (!isPlainRecord(item) || Object.keys(item).length > requestedMetrics.size + 1) return false;
        if (typeof item.time !== 'string' || item.time.length > 40 || !Number.isFinite(Date.parse(item.time))) {
            return false;
        }
        return Object.entries(item).every(([name, metricValue]) => {
            if (name === 'time') return true;
            if (!requestedMetrics.has(name)) return false;
            if (metricValue === null || typeof metricValue === 'number')
                return metricValue === null || Number.isFinite(metricValue);
            if (!isPlainRecord(metricValue) || Object.keys(metricValue).length > 16) return false;
            return Object.entries(metricValue).every(
                ([source, reading]) =>
                    /^[A-Za-z0-9_-]{1,32}$/.test(source) &&
                    (reading === null || (typeof reading === 'number' && Number.isFinite(reading))),
            );
        });
    });
}

function copyQuotaHeader(response: Response, name: string, output: Record<string, string>) {
    const value = response.headers.get(name);
    if (value && /^\d{1,10}$/.test(value)) output[name] = value;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405);
    }

    const caller = await requireAuthenticatedQuota(req, 'stormglass', 40, 86400);
    if (caller instanceof Response) {
        return withCors(caller, CORS);
    }

    const key = Deno.env.get('STORMGLASS_API_KEY');
    if (!key) {
        return corsResponse(JSON.stringify({ error: 'StormGlass is not configured' }), 500);
    }

    try {
        const body = await readJsonObject(req, 12_000);
        if (!body) return corsResponse(JSON.stringify({ error: 'Invalid JSON request body' }), 400);
        const { path, params } = body;

        if (!path || typeof path !== 'string') {
            return corsResponse(JSON.stringify({ error: 'path is required' }), 400);
        }

        if (!Object.prototype.hasOwnProperty.call(PATH_RULES, path)) {
            return corsResponse(JSON.stringify({ error: 'Invalid path' }), 400);
        }
        if (!isPlainRecord(params)) {
            return corsResponse(JSON.stringify({ error: 'Invalid query parameters' }), 400);
        }
        const stormGlassPath = path as StormGlassPath;
        const normalized = normalizeStormGlassRequest(stormGlassPath, params);
        if (!normalized) {
            return corsResponse(JSON.stringify({ error: 'Invalid query parameters' }), 400);
        }

        const url = new URL(`${BASE_URL}/${stormGlassPath}`);
        url.search = normalized.query.toString();
        const res = await fetchWithTimeout(url, { headers: { Authorization: key } }, 12_000);

        // Forward rate limit headers so the client can track quota
        const extraHeaders: Record<string, string> = {};
        copyQuotaHeader(res, 'x-quota-remaining', extraHeaders);
        copyQuotaHeader(res, 'x-quota-total', extraHeaders);

        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            console.error(`[proxy-stormglass] upstream status ${res.status}`);
            return corsResponse(JSON.stringify({ error: 'StormGlass upstream failed' }), 502, extraHeaders);
        }

        const data = await readResponseJsonObjectLimited(res, MAX_UPSTREAM_BYTES);
        if (!data || !isValidStormGlassResponse(stormGlassPath, data, normalized.requestedMetrics)) {
            console.error('[proxy-stormglass] invalid upstream response');
            return corsResponse(JSON.stringify({ error: 'StormGlass upstream failed' }), 502, extraHeaders);
        }

        return corsResponse(JSON.stringify(data), 200, extraHeaders);
    } catch {
        console.error('[proxy-stormglass] request failed');
        return corsResponse(JSON.stringify({ error: 'StormGlass request failed' }), 502);
    }
});
