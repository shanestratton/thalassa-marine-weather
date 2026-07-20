/**
 * Vercel edge proxy for the four-city model-spread page.
 *
 * WHY THIS EXISTS
 *   The page is generated hourly on the weather server and pushed to public
 *   Supabase Storage. But Supabase deliberately serves HTML from public
 *   buckets as `text/plain` with `x-content-type-options: nosniff` — a stored
 *   XSS mitigation, so a public bucket can never execute HTML on a
 *   supabase.co origin. Verified: even an explicit `content-type: text/html`
 *   on upload is stored and served as text/plain.
 *
 *   That is Supabase behaving correctly, not a misconfiguration. So the page
 *   is fetched server-side here and re-served with the right content type on
 *   our own origin, exactly as `api/currents/[file].ts` does for the CMEMS
 *   binaries and for the same class of reason.
 *
 * WHY /api/*  (same reasoning as apiBase.ts)
 *   Vercel's Attack Challenge Mode fires on non-API paths and returns 403
 *   with `x-vercel-mitigated: challenge` for fetches without a solved
 *   challenge cookie. `/api/*` is exempt.
 */

export const config = {
    runtime: 'edge',
};

const UPSTREAM = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/assets/spread/index.html';

export default async function handler(): Promise<Response> {
    const upstream = await fetch(UPSTREAM, { redirect: 'follow' });

    if (!upstream.ok) {
        return new Response(`Upstream HTTP ${upstream.status}`, {
            status: upstream.status,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
    }

    const html = await upstream.text();

    // Cheap sanity check. If the upstream object were ever replaced with
    // something unexpected, serving it as executable HTML from our origin
    // would be worse than serving nothing.
    if (!html.startsWith('<title>') && !html.includes('Where the models')) {
        return new Response('Upstream did not look like the expected page', {
            status: 502,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
    }

    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            // The page regenerates hourly; 10 minutes at the edge with a
            // stale-while-revalidate window keeps it fresh without hammering
            // storage on every view.
            'cache-control': 'public, max-age=600, stale-while-revalidate=3600',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
        },
    });
}
