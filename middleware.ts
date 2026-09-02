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
 */

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
    // 'www' is excluded explicitly so a www subdomain stays pointed at the
    // marketing site, not the voyage log. A port suffix is tolerated because
    // `host` carries one on non-standard ports and an exact-anchor match
    // would silently fall through to the catch-all.
    const match = host.match(/^([a-z0-9-]+)\.thalassawx\.(?:app|com)(?::\d+)?$/i);
    if (!match || match[1].toLowerCase() === 'www') {
        // Apex / unknown host → let normal Vercel routing handle it
        // (catch-all rewrite in vercel.json serves /index.html).
        return; // undefined = pass through
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
