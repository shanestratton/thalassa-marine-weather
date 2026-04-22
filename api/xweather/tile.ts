/**
 * Vercel edge proxy for Xweather raster tiles — query-string variant.
 *
 * Why two files for one job:
 *   - The original `[...path].ts` catch-all (still alongside this) maps
 *     a path like `/api/xweather/lightning-strikes:15/3/4/5/current.png`
 *     directly to the upstream Xweather URL. That worked locally but
 *     Vercel didn't route the multi-segment catch-all in production
 *     (returned HTML 404, never reached the function).
 *   - This file uses query-params instead — `/api/xweather/tile?layer=...&z=...&x=...&y=...`
 *     which is a normal single-file route Vercel reliably handles.
 *
 * Mapbox-GL substitutes {z}/{x}/{y} into URL templates regardless of
 * whether they appear in the path or query string, so the client URLs
 * just become `?z={z}&x={x}&y={y}`.
 *
 * Why this exists at all: prior to any proxy, the Xweather client_id
 * + client_secret were baked into the JS bundle and embedded in tile
 * URLs — anyone with `View Source` could lift them and exhaust quota.
 * The proxy keeps the secret server-side.
 */

export const config = {
    runtime: 'edge',
};

const UPSTREAM_BASE = 'https://maps.api.xweather.com';

// Allowlist of Xweather layer codes we'll proxy. Refusing arbitrary
// layer strings keeps an attacker from probing the upstream catalog
// or burning quota on layers we don't surface.
const ALLOWED_LAYERS = new Set<string>([
    'wave-heights',
    'ocean-currents',
    'sst',
    'wind-gusts',
    'visibility',
    'cape',
    'lightning-strikes:15',
    'satellite-infrared-color,radar-global', // squall combined layer
]);

export default async function handler(req: Request): Promise<Response> {
    const id = process.env.XWEATHER_CLIENT_ID;
    const secret = process.env.XWEATHER_CLIENT_SECRET;
    if (!id || !secret) {
        return new Response('Xweather credentials not configured on server', {
            status: 503,
        });
    }

    const url = new URL(req.url);
    const layer = url.searchParams.get('layer');
    const z = url.searchParams.get('z');
    const x = url.searchParams.get('x');
    const y = url.searchParams.get('y');

    if (!layer || !z || !x || !y) {
        return new Response('Missing layer / z / x / y query params', {
            status: 400,
        });
    }
    if (!ALLOWED_LAYERS.has(layer)) {
        return new Response('Layer not allowed', { status: 400 });
    }
    // Numeric tile coordinates only — keeps the upstream URL clean.
    if (!/^[0-9]+$/.test(z) || !/^[0-9]+$/.test(x) || !/^[0-9]+$/.test(y)) {
        return new Response('Invalid tile coordinates', { status: 400 });
    }

    // Optional cache-buster passes through to the upstream (Xweather's
    // 302 redirect to the timestamped tile bypasses Mapbox's cache).
    const ts = url.searchParams.get('_ts');
    const upstreamUrl =
        `${UPSTREAM_BASE}/${id}_${secret}/${layer}/${z}/${x}/${y}/current.png` + (ts ? `?_ts=${ts}` : '');

    const upstream = await fetch(upstreamUrl, { redirect: 'follow' });
    if (!upstream.ok) {
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
