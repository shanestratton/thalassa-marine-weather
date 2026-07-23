// NGA Maritime Safety Information proxy
//
// The NGA broadcast-warning API does not send browser CORS headers. Native
// Capacitor clients can reach it directly, but deployed web clients need this
// small server-side hop. It deliberately preserves the API's `broadcast-warn`
// shape consumed by NoticeToMarinersService.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, jsonResponse, readResponseTextLimited } from '../_shared/http-security.ts';

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
    const response = await fetchWithTimeout(
        NGA_URL,
        {
            headers: {
                Accept: 'application/json',
                'User-Agent':
                    'Mozilla/5.0 (compatible; ThalassaMarine/1.0; +https://github.com/shanestratton/thalassa-marine-weather)',
            },
        },
        15_000,
    );
    if (!response.ok) throw new Error(`NGA MSI returned ${response.status}`);

    const text = await readResponseTextLimited(response, 8_000_000);
    if (text === null) throw new Error('NGA MSI response exceeded the safety limit');
    const payload = JSON.parse(text) as Partial<BroadcastWarningPayload>;
    if (!Array.isArray(payload['broadcast-warn'])) throw new Error('NGA MSI returned an invalid warning payload');
    return { 'broadcast-warn': payload['broadcast-warn'].slice(0, 5_000) };
}

function json(payload: object, cacheStatus: 'HIT' | 'MISS' | 'STALE', status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'X-Cache': cacheStatus,
            'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

serve(async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'GET') {
        return jsonResponse({ error: 'GET required' }, 405, CORS_HEADERS);
    }

    const caller = await requireAuthenticatedOrPublicQuota(request, 'nga_msi', 240, 60, 3600);
    if (caller instanceof Response) return withCors(caller, CORS_HEADERS);

    try {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return json(cache.payload, 'HIT');

        const payload = await fetchWarnings();
        cache = { fetchedAt: Date.now(), payload };
        return json(payload, 'MISS');
    } catch (error) {
        if (cache) return json({ ...cache.payload, _stale: true }, 'STALE');
        console.error('[proxy-nga-msi] Refresh failed:', error);
        return jsonResponse({ error: 'NGA notices are temporarily unavailable' }, 502, {
            ...CORS_HEADERS,
            'X-Cache': 'MISS',
        });
    }
});
