/**
 * Edge Middleware — wildcard-subdomain router for the public vessel
 * surfaces.
 *
 * Pattern: <handle>.thalassawx.{app,com}/plan[/…] → /index.html (planner SPA)
 *          <handle>.thalassawx.{app,com}/*        → /logs.html  (voyage log)
 *
 * BOTH TLDs, because a link a skipper reads out loud has to survive being
 * typed from memory (Shane 2026-09-02: "can we make the public page work at
 * boat-name.thalassawx.com as well as boat-name.thalassawx.app"). .app is
 * still the canonical address the app builds and copies; .com simply also
 * lands, rather than serving a stranger a dead link because they guessed the
 * commoner ending.
 *
 * /plan serves the INTERACTIVE planner (Shane 2026-07-17: "the planning
 * page… serene-summer.thalassawx.app/plan — i will not be the only person
 * using the app"): every vessel gets its own bookmarkable planner address,
 * same SPA, deepLink boots it straight into the tracer. The old public float
 * plan was removed; legacy /float links now land on the backward-looking log.
 *
 * Why this exists as middleware and not as a vercel.json rewrite:
 * Vercel's `has.value` field in vercel.json (which would normally let
 * us route by host) turns out to be literal-string-matching for the
 * host type, not regex. We need pattern matching (any subdomain on
 * thalassawx.app maps to the voyage log renderer) which only Edge
 * Middleware can do cleanly. Tried two iterations of vercel.json
 * regex syntax (commits 3c08c67a, 54389878) — neither fired.
 *
 * Runs on Vercel's edge runtime in front of the static asset layer.
 * The renderer (logs.html → src/logs-main.tsx) reads the handle from
 * window.location.hostname itself, so we don't need to pass it
 * through — we just point the path at the static logs.html.
 *
 * THALASSA'S OWN NAMES (2026-10-06). Not every label is a boat:
 *   ocean.thalassawx.app/*                    → /ocean.html (the public fleet
 *                                               page, Thalassa Ocean; indexable)
 *   ocean.thalassawx.com, watch., sightings.,
 *   seabed. on either TLD                     → 308 to https://ocean.thalassawx.app
 *   thalassawx.app/ocean, www…/ocean[/…]      → 308 to https://ocean.thalassawx.app[/…]
 *   www, api, tiles, app and the rest of
 *   src/publicHosts.ts RESERVED_HANDLES       → normal routing, like www always was
 * No boat can hold a reserved name: the voyage_log_configs CHECK refuses it.
 */
import { classifyPublicHost, OCEAN_CANONICAL, oceanPathRedirect } from './src/publicHosts';

export const config = {
    // Skip any request that already references a file (has a dot in
    // the path: /assets/foo.js, /favicon.ico) so static assets keep
    // serving normally. Skip _next/* (future-proofing for any Next.js
    // adoption). Skip /api/* (no edge functions on this project yet,
    // but defensive).
    matcher: '/((?!_next|api|assets|favicon|.*\\..*).*)',
};

export default async function middleware(request: Request) {
    const host = request.headers.get('host') ?? '';

    // <handle>.thalassawx.app or .com — exactly one label before the apex.
    // Reserved labels (www and the rest of RESERVED_HANDLES) are excluded so
    // they stay pointed at Thalassa's own sites, not a voyage log. A port
    // suffix is tolerated because `host` carries one on non-standard ports
    // and an exact-anchor match would silently fall through to the catch-all.
    // thalassawx.app/ocean and www.thalassawx.app/ocean → the canonical page
    // (its data answers on ocean.thalassawx.app only).
    const oceanHome = oceanPathRedirect(host, new URL(request.url));
    if (oceanHome) return Response.redirect(oceanHome, 308);

    const match = host.match(/^([a-z0-9-]+)\.thalassawx\.(?:app|com)(?::\d+)?$/i);
    const kind = match ? classifyPublicHost(host)?.kind : undefined;
    if (!match || !kind || kind === 'reserved') {
        // Apex / unknown host / www, api, tiles… → let normal Vercel routing
        // handle it (catch-all rewrite in vercel.json serves /index.html).
        return; // undefined = pass through
    }

    if (kind === 'ocean-redirect') {
        // One canonical address to share, index and cache. 308 keeps the
        // method, and the path and query ride along (a species deep link
        // typed with .com still lands on its species).
        const from = new URL(request.url);
        return Response.redirect(`${OCEAN_CANONICAL}${from.pathname}${from.search}`, 308);
    }

    if (kind === 'ocean') {
        // The public fleet page, Thalassa Ocean. It is MEANT to be found, so
        // unlike a voyage log it carries no X-Robots-Tag: everything on it is
        // already delayed and blurred for the public (see the page's Respect
        // section and 20261006120000_ocean_public_read.sql).
        const url = new URL(request.url);
        url.pathname = '/ocean.html';
        return fetch(url, request);
    }

    // Rewrite to the right surface. The standalone renderers read the
    // handle from window.location.hostname so we don't need to pass it
    // in a query param or path segment; the planner SPA is account-
    // scoped (sign in → your boat) and deepLink's /plan handling boots
    // it into the tracer regardless of host. Every other path on a
    // boat subdomain is the voyage log.
    const url = new URL(request.url);
    const p = url.pathname;
    // /float is gone (Shane 2026-07-28). A float plan says "nobody is aboard
    // until Friday and here is exactly where we will be" — on a public URL
    // that is an invitation, and the gap between arriving and leaving is the
    // normal state of cruising, not an edge case. It is now composed on the
    // device and handed to the share sheet, so it reaches one chosen person
    // instead of the internet. The public page stays strictly backward
    // looking: where the boat is and where it has been, never where next.
    url.pathname =
        p === '/plan' || p.startsWith('/plan/')
            ? '/index.html' // the interactive planner (Shane 2026-07-17)
            : '/logs.html';
    const upstream = await fetch(url, request);
    const headers = new Headers(upstream.headers);
    // Voyage logs can contain a vessel's exact live position and history.
    // Sharing is link-scoped; search engines must not turn that link into a
    // discoverable public directory. The HTML meta tag is defence in depth.
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
}
