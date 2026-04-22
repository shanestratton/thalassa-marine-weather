/**
 * Vercel edge proxy for Xweather raster tiles.
 *
 * Why this exists: prior to this proxy, the Xweather client_id +
 * client_secret were baked into the JS bundle via VITE_-prefixed
 * env vars and concatenated into tile URLs at runtime. Anyone who
 * `View Source`'d the production app could lift the credentials and
 * exhaust our quota / drive up the bill.
 *
 * Under this proxy:
 *   - Client requests `/api/xweather/lightning-strikes:15/3/4/5/current.png`
 *   - Edge fn forwards to `https://maps.api.xweather.com/{ID}_{SECRET}/...`
 *   - Credentials live in Vercel env (XWEATHER_CLIENT_ID + _SECRET,
 *     no VITE_ prefix → never bundled into the client).
 *
 * Catch-all path uses Next.js / Vercel's `[...path].ts` syntax so a
 * single handler covers every Xweather layer (wave-heights, ocean-currents,
 * sst, lightning-strikes:15, wind-gusts, visibility, cape, etc.).
 *
 * Tile cache: 5min browser, 15min edge — Xweather updates most layers
 * sub-hourly but tile content doesn't change often enough to matter
 * within those windows. Lightning-strikes:15 is the chattiest (15min
 * aggregation window) and the layer logic also sets a `?_ts=` cache
 * buster on each refresh, so this cache header is a safe floor.
 */

export const config = {
    runtime: 'edge',
};

const UPSTREAM_BASE = 'https://maps.api.xweather.com';

// Belt-and-braces against tunnelling someone else's URL through us:
// we ONLY proxy requests that look like Xweather tile/layer paths.
// The pattern accepts alphanumerics, hyphens, colons (lightning:15),
// dots (current.png), and forward slashes (z/x/y).
const SAFE_PATH = /^[a-zA-Z0-9_\-:./]+$/;

export default async function handler(req: Request): Promise<Response> {
    const id = process.env.XWEATHER_CLIENT_ID;
    const secret = process.env.XWEATHER_CLIENT_SECRET;
    if (!id || !secret) {
        return new Response('Xweather credentials not configured on server', {
            status: 503,
        });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/xweather\/?/, '');
    if (!path || !SAFE_PATH.test(path)) {
        return new Response('Invalid path', { status: 400 });
    }

    const upstreamUrl = `${UPSTREAM_BASE}/${id}_${secret}/${path}${url.search}`;
    const upstream = await fetch(upstreamUrl, { redirect: 'follow' });

    if (!upstream.ok) {
        // Pass through Xweather's status verbatim — Mapbox-GL handles
        // 403/404/etc by skipping the tile, no need to alarm.
        return new Response(`Upstream HTTP ${upstream.status}`, {
            status: upstream.status,
        });
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': upstream.headers.get('content-type') ?? 'image/png',
            'cache-control': 'public, max-age=300, s-maxage=900',
        },
    });
}
