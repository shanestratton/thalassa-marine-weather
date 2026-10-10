// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';
import { isOperation, UPSTREAMS, validateRequest } from './validation.ts';

/**
 * Commercial Open-Meteo trust boundary.
 *
 * Clients choose one of three fixed operations (forecast, marine, geocode) and
 * a deliberately small query vocabulary. The upstream host, path and
 * commercial key are server-owned.
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

function response(error: string | null, status: number, body?: string): Response {
    return new Response(body ?? JSON.stringify(error ? { error } : {}), {
        status,
        headers: JSON_HEADERS,
    });
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
        !isOperation(operation) ||
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
