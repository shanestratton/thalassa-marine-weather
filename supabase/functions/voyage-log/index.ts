/**
 * voyage-log — Public Voyage Log API
 *
 * Serves a vessel's published voyage log as JSON: vessel info, published
 * diary entries, recent track breadcrumb, and latest telemetry. This is
 * the public product surface — punters point their own front-end at it,
 * and the default renderer at thalassawx.app/logs consumes the same thing.
 *
 * Public, read-only. Gated by a per-vessel publishable key (an identifier
 * for rate-limiting / revocation, not a secret — the data is public by
 * publication).
 *
 *   GET /functions/v1/voyage-log?handle=<handle>&key=<api_key>
 *
 * Response 200:
 *   {
 *     vessel:    { name, type, model },
 *     entries:   [{ id, title, body, mood, photos[], location_name,
 *                   latitude, longitude, weather_summary, weather_data,
 *                   tags[], created_at }],
 *     track:     [{ lat, lon, timestamp, speed_kts, course_deg, pressure }],
 *     telemetry: { sog, cog, baro, baro_trend, lat, lon, updated_at } | null,
 *     generated_at: <ISO string>
 *   }
 *
 * Errors: 400 missing params · 401 bad key · 403 disabled · 404 unknown handle.
 *
 * Deploy with JWT verification OFF (public function), same as vessels-nearby.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_ENTRIES = 200;
const MAX_TRACK_POINTS = 5000;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
    });
}

/** Keep only real http(s) photo URLs — drop offline data: URIs / idb refs. */
function publicPhotos(photos: unknown): string[] {
    if (!Array.isArray(photos)) return [];
    return photos.filter((p): p is string => typeof p === 'string' && /^https?:\/\//i.test(p));
}

/** rising / falling / steady from the last ~hour of barometric pressure. */
function baroTrend(track: { pressure: number | null }[]): 'rising' | 'falling' | 'steady' {
    const readings = track.filter((t) => typeof t.pressure === 'number').slice(-5);
    if (readings.length < 2) return 'steady';
    const delta = (readings[readings.length - 1].pressure as number) - (readings[0].pressure as number);
    if (delta > 1) return 'rising';
    if (delta < -1) return 'falling';
    return 'steady';
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
    }

    try {
        const url = new URL(req.url);
        const handle = (url.searchParams.get('handle') || '').trim().toLowerCase();
        const key = (url.searchParams.get('key') || '').trim();

        if (!handle || !key) {
            return json({ error: 'handle and key are required query parameters' }, 400);
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // ── Resolve + authenticate the vessel ──────────────────────
        const { data: config, error: configErr } = await supabase
            .from('voyage_log_configs')
            .select('owner_id, api_key, enabled, track_days')
            .eq('handle', handle)
            .maybeSingle();

        if (configErr) {
            console.error('voyage-log: config lookup failed:', configErr);
            return json({ error: 'Internal server error' }, 500);
        }
        if (!config) {
            return json({ error: 'Unknown voyage log handle' }, 404);
        }
        if (config.api_key !== key) {
            return json({ error: 'Invalid API key' }, 401);
        }
        if (!config.enabled) {
            return json({ error: 'This voyage log is not currently public' }, 403);
        }

        const ownerId = config.owner_id as string;
        const trackDays = (config.track_days as number) ?? 30;
        const trackSince = new Date(Date.now() - trackDays * 86400_000).toISOString();

        // ── Fetch vessel identity, published entries, track ────────
        const [vesselRes, entriesRes, trackRes] = await Promise.all([
            supabase
                .from('vessel_identity')
                .select('vessel_name, vessel_type, model')
                .eq('owner_id', ownerId)
                .maybeSingle(),
            supabase
                .from('diary_entries')
                .select(
                    'id, title, body, mood, photos, location_name, latitude, longitude, weather_summary, weather_data, tags, created_at',
                )
                .eq('user_id', ownerId)
                .eq('is_public', true)
                .order('created_at', { ascending: false })
                .limit(MAX_ENTRIES),
            supabase
                .from('ship_log')
                .select('latitude, longitude, timestamp, speed_kts, course_deg, pressure')
                .eq('user_id', ownerId)
                .gte('timestamp', trackSince)
                .order('timestamp', { ascending: true })
                .limit(MAX_TRACK_POINTS),
        ]);

        if (vesselRes.error || entriesRes.error || trackRes.error) {
            console.error('voyage-log: data fetch failed:', {
                vessel: vesselRes.error,
                entries: entriesRes.error,
                track: trackRes.error,
            });
            return json({ error: 'Internal server error' }, 500);
        }

        const vessel = {
            name: vesselRes.data?.vessel_name ?? 'Unnamed Vessel',
            type: vesselRes.data?.vessel_type ?? 'sail',
            model: vesselRes.data?.model ?? null,
        };

        const entries = (entriesRes.data || []).map((e) => ({
            id: e.id,
            title: e.title,
            body: e.body,
            mood: e.mood,
            photos: publicPhotos(e.photos),
            location_name: e.location_name,
            latitude: e.latitude,
            longitude: e.longitude,
            weather_summary: e.weather_summary,
            weather_data: e.weather_data ?? null,
            tags: Array.isArray(e.tags) ? e.tags : [],
            created_at: e.created_at,
        }));

        const track = (trackRes.data || []).map((p) => ({
            lat: p.latitude,
            lon: p.longitude,
            timestamp: p.timestamp,
            speed_kts: p.speed_kts,
            course_deg: p.course_deg,
            pressure: p.pressure,
        }));

        // ── Latest telemetry = most recent track point ─────────────
        const last = track[track.length - 1] ?? null;
        const telemetry = last
            ? {
                  sog: last.speed_kts,
                  cog: last.course_deg,
                  baro: last.pressure,
                  baro_trend: baroTrend(track),
                  lat: last.lat,
                  lon: last.lon,
                  updated_at: last.timestamp,
              }
            : null;

        return json(
            {
                vessel,
                entries,
                track,
                telemetry,
                generated_at: new Date().toISOString(),
            },
            200,
            // Cheap to serve under load; data only moves every ~15 min anyway.
            { 'Cache-Control': 'public, max-age=60' },
        );
    } catch (e) {
        console.error('voyage-log: unhandled error:', e);
        return json({ error: 'Internal server error' }, 500);
    }
});
