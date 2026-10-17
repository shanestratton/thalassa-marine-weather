import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { readJsonObject } from '../_shared/http-security.ts';
import { parseOwnedOsmRequest } from '../../../services/osm/ownedOverpassContract.ts';
import { fetchOwnedOsmFromWx } from '../_shared/owned-osm-upstream.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const reply = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

Deno.serve(async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return reply({ code: 'POST_REQUIRED' }, 405);
    const caller = await requireAuthenticatedOrPublicQuota(request, 'owned_osm', 120, 30, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);
    try {
        const operation = parseOwnedOsmRequest(await readJsonObject(request, 4096));
        if (!operation) return reply({ code: 'OPERATION_REFUSED' }, 400);
        const document = await fetchOwnedOsmFromWx(operation, (name) => Deno.env.get(name), request.signal);
        return reply(document, 200);
    } catch {
        // No positions, raw query, bearer, source body or exception echo/log.
        return reply({ code: 'OWN_OSM_UNAVAILABLE' }, 503);
    }
});
