/**
 * Vercel serverless proxy for CMEMS-currents binary assets.
 *
 * The Thalassa client fetches `/currents/manifest.json` and
 * `/currents/h00.bin` .. `/currents/h12.bin` as same-origin requests.
 * Vercel routes those through this function, which follows the
 * GitHub Release 302 → objects.githubusercontent.com redirect chain
 * server-side and streams the bytes back to the browser with a
 * consistent content-type and aggressive cache.
 *
 * A plain `rewrites` entry in vercel.json passes the 302 response
 * through to the browser instead of following it, which then fails
 * CORS on objects.githubusercontent.com — hence this proxy function.
 */

export const config = {
    // Edge runtime — lower latency + stream support.
    runtime: 'edge',
};

const RELEASE_BASE = 'https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-currents-latest';

// Allowlist to prevent this function being abused as an open proxy.
const ALLOWED = new Set<string>([
    'manifest.json',
    ...Array.from({ length: 13 }, (_, i) => `h${String(i).padStart(2, '0')}.bin`),
]);

export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Vercel maps /currents/:file → this function with the file segment
    // in the path; pull the last segment.
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
            // 10-min CDN cache — pipeline only updates once a day.
            'cache-control': 'public, max-age=600, s-maxage=600',
        },
    });
}
