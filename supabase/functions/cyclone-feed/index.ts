// deno-lint-ignore-file
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * cyclone-feed — every active tropical cyclone, direct from the warning
 * centres (129-09b). Replaces the app's calls to knackwx (the storm list) and
 * to Esri's Living Atlas "Active Hurricanes" item (the tracks and cones).
 *
 * GET, public: CycloneTrackingService calls it with a bare fetch(url), and the
 * Pi's /api/misc/cyclone-feed proxies it for the boat. The answer is
 * _shared/cyclone/feed.ts's CycloneFeed:
 *   storms   the union of NHC's CurrentStorms.json, JTWC's RSS and NCEP's TC
 *            vitals, keyed by basin and number; each with NHC's or CPHC's
 *            official track and cone from NOAA's MapServer (the issuer read
 *            from the product's office), or JTWC's advisory track and danger
 *            area wherever NHC and CPHC are not advising
 *   sources  each list and track source, 'ok', 'unavailable' or 'none'
 *   unplaced JTWC warnings whose product did not come and that no other list
 *            places: named, so the app and the watcher say part of the feed
 *            is missing instead of showing an empty sea
 * When no storm list answers it is a 503 ("Cyclone data unavailable"), never
 * an empty list. The feed is kept 10 minutes per isolate
 * (sources.ts fetchCycloneFeed), so the centres are asked at most that often
 * per isolate, not once per user. Public storm positions; nothing about the
 * caller is read or logged.
 */
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchCycloneFeed } from '../_shared/cyclone/sources.ts';

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...extra },
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });

    const caller = await requireAuthenticatedOrPublicQuota(req, 'cyclone_feed', 240, 120, 3600, true);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const feed = await fetchCycloneFeed(Date.now());
        if (!feed) return json({ error: 'Cyclone data unavailable' }, 503, { 'Cache-Control': 'no-store' });
        const down = Object.entries(feed.sources)
            .filter(([, status]) => status === 'unavailable')
            .map(([name]) => name);
        console.info(`[cyclone-feed] storms=${feed.storms.length} unavailable=${down.join(',') || 'none'}`);
        return json(feed, 200, { 'Cache-Control': 'public, max-age=300' });
    } catch (err) {
        console.error('[cyclone-feed] failed:', err instanceof Error ? err.message : 'unknown');
        return json({ error: 'Cyclone data unavailable' }, 503, { 'Cache-Control': 'no-store' });
    }
});
