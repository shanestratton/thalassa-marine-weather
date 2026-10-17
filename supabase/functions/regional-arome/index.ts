import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { parseCoordinate, readJsonObject } from '../_shared/http-security.ts';
import { fetchAromeFromStatic } from '../_shared/arome-upstream.ts';
import { aromeDomain } from '../../../services/weather/aromeDomains.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const reply = (value: unknown, status: number) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

Deno.serve(async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    const caller = await requireAuthenticatedOrPublicQuota(request, 'regional_arome', 120, 30, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);
    try {
        const body = await readJsonObject(request, 4096);
        const lat = parseCoordinate(body?.lat, 'lat');
        const lon = parseCoordinate(body?.lon, 'lon');
        const model = typeof body?.model === 'string' ? body.model : '';
        if (lat === null || lon === null || !aromeDomain(model)) return reply({ error: 'Invalid regional point' }, 400);
        const data = await fetchAromeFromStatic(model, { lat, lon }, (name) => Deno.env.get(name));
        return reply(data, 200);
    } catch {
        // Do not log positions, credentials, upstream bodies or error strings
        // which may contain those values. Missing coverage is not empty data.
        return reply({ error: 'Original regional sea-cell cohort unavailable' }, 503);
    }
});
