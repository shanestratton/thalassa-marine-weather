/**
 * Edge Middleware — wildcard-subdomain router for the public vessel
 * surfaces.
 *
 * Pattern: <handle>.thalassawx.app/plan[/…]  → /index.html  (the planner SPA)
 *          <handle>.thalassawx.app/float[/…] → /plan.html   (float plan)
 *          <handle>.thalassawx.app/*         → /logs.html   (voyage log)
 *
 * /plan serves the INTERACTIVE planner (Shane 2026-07-17: "the planning
 * page… serene-summer.thalassawx.app/plan — i will not be the only person
 * using the app"): every vessel gets its own bookmarkable planner address,
 * same SPA, deepLink boots it straight into the tracer. The read-only
 * shore-crew float plan that used to hold /plan moved to /float.
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

export default function middleware(request: Request) {
    const host = request.headers.get('host') ?? '';

    // <handle>.thalassawx.app — exactly one label before the apex.
    // 'www' is excluded explicitly so a future www subdomain stays
    // pointed at the marketing app, not the voyage log.
    const match = host.match(/^([a-z0-9-]+)\.thalassawx\.app$/i);
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
    url.pathname =
        p === '/plan' || p.startsWith('/plan/')
            ? '/index.html' // the interactive planner (Shane 2026-07-17)
            : p === '/float' || p.startsWith('/float/')
              ? '/plan.html' // shore-crew float plan (moved off /plan)
              : '/logs.html';
    return fetch(url, request);
}
