/**
 * Vercel serverless proxy for CMEMS mixed-layer depth binaries.
 * Sister to api/currents, api/waves, api/sst, api/chl, api/seaice.
 */

export const config = {
    runtime: 'edge',
};

const RELEASE_BASE = 'https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-mld-latest';

const ALLOWED = new Set<string>([
    'manifest.json',
    ...Array.from({ length: 6 }, (_, i) => `h${String(i).padStart(2, '0')}.bin`),
]);

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

    const contentType = file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': contentType,
            'cache-control': 'public, max-age=600, s-maxage=600',
        },
    });
}
