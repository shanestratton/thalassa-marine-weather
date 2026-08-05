/**
 * Retired public float-plan endpoint.
 *
 * Float plans are now composed and shared on-device with one recipient chosen
 * by the skipper. The historical endpoint used a public vessel handle plus the
 * service role to expose a saved planned route. Keep this deployable tombstone
 * in source control so old clients and guessed URLs fail closed instead of
 * depending on an untracked function remaining configured correctly.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RETIRED_RESPONSE_HEADERS: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
};

Deno.serve((req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    return new Response(JSON.stringify({ error: 'Public float-plan links are retired for this beta' }), {
        status: 410,
        headers: RETIRED_RESPONSE_HEADERS,
    });
});
