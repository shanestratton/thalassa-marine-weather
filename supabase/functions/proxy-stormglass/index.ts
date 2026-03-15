// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

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
    return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

const BASE_URL = 'https://api.stormglass.io/v2';

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405);
    }

    const key = Deno.env.get('STORMGLASS_API_KEY');
    if (!key) {
        return corsResponse(JSON.stringify({ error: 'STORMGLASS_API_KEY not configured' }), 500);
    }

    try {
        const { path, params } = await req.json();

        if (!path || typeof path !== 'string') {
            return corsResponse(JSON.stringify({ error: 'path is required' }), 400);
        }

        // Sanitize: only allow known StormGlass paths
        const allowedPaths = [
            'weather/point',
            'bio/point',
            'tide/extremes/point',
            'tide/sea-level/point',
            'astronomy/point',
        ];
        if (!allowedPaths.some((p) => path.startsWith(p))) {
            return corsResponse(JSON.stringify({ error: 'Invalid path' }), 400);
        }

        // Build query string from params
        const queryString = params
            ? Object.entries(params)
                  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
                  .join('&')
            : '';

        const url = `${BASE_URL}/${path}${queryString ? `?${queryString}` : ''}`;

        const res = await fetch(url, {
            headers: { Authorization: key },
        });

        // Forward rate limit headers so the client can track quota
        const quotaRemaining = res.headers.get('x-quota-remaining');
        const quotaTotal = res.headers.get('x-quota-total');
        const extraHeaders: Record<string, string> = {};
        if (quotaRemaining) extraHeaders['x-quota-remaining'] = quotaRemaining;
        if (quotaTotal) extraHeaders['x-quota-total'] = quotaTotal;

        const data = await res.json();

        if (res.status !== 200) {
            console.error(`[proxy-stormglass] StormGlass error: ${res.status}`, data);
        }

        return corsResponse(JSON.stringify(data), res.status, extraHeaders);
    } catch (e) {
        console.error('[proxy-stormglass] Error:', e);
        return corsResponse(JSON.stringify({ error: 'Internal proxy error' }), 500);
    }
});
