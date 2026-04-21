/**
 * Vercel serverless proxy for CMEMS-waves binary assets.
 *
 * Sister function to api/currents/[file].ts — same pattern, different
 * GitHub Release. The client fetches /api/waves/manifest.json and
 * /api/waves/hNN.bin as same-origin requests; this function follows
 * the GitHub Release 302 chain server-side and streams bytes back to
 * the browser with a clean content-type and aggressive cache.
 *
 * Uses /api/waves/ (not /waves/) for the same reason as currents:
 * Vercel's Attack Challenge Mode 403s non-API paths.
 *
 * Allowlist sized to 17 snapshots — the waves pipeline publishes a
 * 48-hour forecast at 3-hour native cadence (48/3 + 1 = 17 files).
 */

export const config = {
    // Edge runtime — lower latency + stream support.
    runtime: 'edge',
};

const RELEASE_BASE = 'https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-waves-latest';

// Allowlist to prevent this function being abused as an open proxy.
const ALLOWED = new Set<string>([
    'manifest.json',
    ...Array.from({ length: 17 }, (_, i) => `h${String(i).padStart(2, '0')}.bin`),
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
            // 10-min CDN cache — pipeline only updates once a day.
            'cache-control': 'public, max-age=600, s-maxage=600',
        },
    });
}
