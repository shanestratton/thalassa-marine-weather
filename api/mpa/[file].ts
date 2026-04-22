/**
 * Vercel edge proxy for the Australian Marine Protected Areas
 * GeoJSON archive (CAPAD).
 *
 * Sister to api/currents, api/sst, api/chl, api/waves — but ships a
 * single static GeoJSON instead of per-hour binaries. Cached
 * aggressively at the edge since the upstream pipeline only refreshes
 * weekly.
 *
 * Why `/api/mpa` and not `/mpa`: same Vercel Attack Challenge Mode
 * reasoning as the rest — non-API paths get challenged.
 */

export const config = {
    runtime: 'edge',
};

const RELEASE_BASE = 'https://github.com/shanestratton/thalassa-marine-weather/releases/download/mpa-aus-latest';

const ALLOWED = new Set<string>(['manifest.json', 'mpa.geojson']);

export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const file = url.pathname.split('/').pop() ?? '';

    if (!ALLOWED.has(file)) {
        return new Response('Not allowed', { status: 400 });
    }

    const upstream = await fetch(`${RELEASE_BASE}/${file}`, {
        redirect: 'follow',
    });

    if (!upstream.ok) {
        return new Response(`Upstream HTTP ${upstream.status}`, { status: upstream.status });
    }

    // GeoJSON gets the standard JSON content-type so Mapbox parses
    // it directly. Cache for an hour at the edge, 5 min in the
    // browser — the underlying file refreshes weekly so this is
    // safe and keeps toggle-on responsiveness sharp.
    const contentType = file.endsWith('.geojson')
        ? 'application/geo+json; charset=utf-8'
        : 'application/json; charset=utf-8';

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': contentType,
            'cache-control': 'public, max-age=300, s-maxage=3600',
        },
    });
}
