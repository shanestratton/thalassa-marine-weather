// LINZ / Maritime NZ MSI Proxy
//
// Serves NAVAREA XIV (South Pacific) + NZ coastal warnings to the
// iOS app in the same RawBroadcastWarn shape NoticeToMarinersService
// already consumes for NGA / AMSA / UKHO.
//
// Why this isn't a live scrape
// ----------------------------
// Maritime NZ's public page at
//   https://www.maritimenz.govt.nz/navigational-warnings/
// is gated by Cloudflare's JS challenge. A plain `fetch()` from Deno
// gets the "Just a moment…" interstitial and a 403. To get past it you
// need a real browser running real JS — which neither Deno edge
// runtimes nor pg_net can provide.
//
// The workaround: a GitHub Actions cron (.github/workflows/
// linz-msi-scrape.yml) runs Playwright in headless Chromium every 6
// hours, lets Cloudflare clear naturally, scrapes the warnings, and
// upserts them into the `linz_warnings` Supabase table. This edge
// function just reads from that table and shapes the rows into the
// existing wire format.
//
// Endpoint:
//   GET /proxy-linz-msi
//
// Response: same shape as NGA's broadcast-warn (no client-side change
// required to consume — see services/NoticeToMarinersService.ts):
//   { "broadcast-warn": [ { msgYear, msgNumber, navArea, … }, … ] }
//
// Edge-cached in-isolate for 5 minutes; the underlying table only
// changes every 6 hours so we don't need to hit Postgres every call.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse } from '../_shared/http-security.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { fetchedAt: number; payload: unknown } | null = null;

interface RawBroadcastWarn {
    msgYear: number;
    msgNumber: number;
    navArea: string;
    subregion: string;
    text: string;
    status: string;
    issueDate: string;
    authority: string;
}

interface LinzWarningRow {
    id: string;
    msg_year: number;
    msg_number: number;
    nav_area: string;
    subregion: string;
    text: string;
    status: string;
    issue_date: string;
    authority: string;
    fetched_at: string;
}

async function fetchFromDb(): Promise<{ 'broadcast-warn': RawBroadcastWarn[]; fetchedAt: number }> {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
        throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    }
    const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase
        .from('linz_warnings')
        .select('id, msg_year, msg_number, nav_area, subregion, text, status, issue_date, authority, fetched_at')
        .order('msg_year', { ascending: false })
        .order('msg_number', { ascending: false })
        .limit(500);

    if (error) throw new Error(`linz_warnings select failed: ${error.message}`);

    const rows = (data ?? []) as LinzWarningRow[];
    const warns: RawBroadcastWarn[] = rows.map((r) => ({
        msgYear: r.msg_year,
        msgNumber: r.msg_number,
        navArea: r.nav_area,
        subregion: r.subregion ?? '',
        text: typeof r.text === 'string' ? r.text.slice(0, 20_000) : '',
        status: r.status ?? 'A',
        issueDate: r.issue_date ?? '',
        authority: r.authority ?? 'MARITIME NZ',
    }));

    // Most-recent scrape time across the rows — useful for the client
    // to surface "last updated" alongside the existing NGA / AMSA /
    // UKHO times. Falls back to 0 if the table is empty.
    let latest = 0;
    for (const r of rows) {
        const t = Date.parse(r.fetched_at);
        if (Number.isFinite(t) && t > latest) latest = t;
    }

    return { 'broadcast-warn': warns, fetchedAt: latest };
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }
    if (req.method !== 'GET') {
        return jsonResponse({ error: 'GET required' }, 405, CORS_HEADERS);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'linz_msi', 240, 60, 3600);
    if (caller instanceof Response) return withCors(caller, CORS_HEADERS);

    try {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
            return new Response(JSON.stringify(cache.payload), {
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'X-Cache': 'HIT',
                    'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }
        const payload = await fetchFromDb();
        cache = { fetchedAt: Date.now(), payload };
        return new Response(JSON.stringify(payload), {
            headers: {
                ...CORS_HEADERS,
                'Content-Type': 'application/json',
                'X-Cache': 'MISS',
                'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (err) {
        console.error('[proxy-linz-msi] Refresh failed:', err);
        // Serve stale cache on transient DB errors rather than failing
        // the whole notices page — same pattern as the AMSA / UKHO
        // proxies.
        if (cache) {
            return new Response(JSON.stringify({ ...(cache.payload as object), _stale: true }), {
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'X-Cache': 'STALE',
                    'Cache-Control': 'public, max-age=60, stale-while-revalidate=3600',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }
        return jsonResponse({ error: 'LINZ notices are temporarily unavailable' }, 502, CORS_HEADERS);
    }
});
