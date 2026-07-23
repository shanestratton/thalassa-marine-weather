// NGA Maritime Safety Information proxy
//
// The NGA broadcast-warning API does not send browser CORS headers. Native
// Capacitor clients can reach it directly, but deployed web clients need this
// small server-side hop. It deliberately preserves the API's `broadcast-warn`
// shape consumed by NoticeToMarinersService.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const NGA_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface BroadcastWarningPayload {
    'broadcast-warn': unknown[];
}

let cache: { fetchedAt: number; payload: BroadcastWarningPayload } | null = null;

async function fetchWarnings(): Promise<BroadcastWarningPayload> {
    const response = await fetch(NGA_URL, {
        headers: {
            Accept: 'application/json',
            'User-Agent':
                'Mozilla/5.0 (compatible; ThalassaMarine/1.0; +https://github.com/shanestratton/thalassa-marine-weather)',
        },
    });
    if (!response.ok) throw new Error(`NGA MSI returned ${response.status}`);

    const payload = (await response.json()) as Partial<BroadcastWarningPayload>;
    if (!Array.isArray(payload['broadcast-warn'])) throw new Error('NGA MSI returned an invalid warning payload');
    return { 'broadcast-warn': payload['broadcast-warn'] };
}

function json(payload: object, cacheStatus: 'HIT' | 'MISS' | 'STALE', status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'X-Cache': cacheStatus,
        },
    });
}

serve(async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
            status: 405,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }

    try {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return json(cache.payload, 'HIT');

        const payload = await fetchWarnings();
        cache = { fetchedAt: Date.now(), payload };
        return json(payload, 'MISS');
    } catch (error) {
        if (cache) return json({ ...cache.payload, _stale: true }, 'STALE');
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
        });
    }
});
