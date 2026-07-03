/**
 * voyage-log — Public Voyage Log API
 *
 * Serves a vessel's published voyage log as JSON: vessel info, published
 * diary entries, recent track breadcrumb, and latest telemetry. This is
 * the public product surface — punters point their own front-end at it,
 * and the default renderer at thalassawx.app/logs consumes the same thing.
 *
 * Public, read-only. No API key — the data is public by publication, and
 * revocation is the per-config `enabled` flag.
 *
 *   GET /functions/v1/voyage-log?handle=<handle>
 *
 * Scope handling:
 *   • scope = 'personal'  → entries from the config's owner only.
 *   • scope = 'combined'  → entries from every member of the boat,
 *                           each tagged with author { user_id, display_name }.
 * Track + telemetry are always per-boat (one boat → one track).
 *
 * Response 200:
 *   {
 *     vessel:      { name, type, model },
 *     scope:       'personal' | 'combined',
 *     destination: { name, lat, lon } | null,
 *     entries:   [{ id, title, body, mood, photos[], location_name,
 *                   latitude, longitude, weather_summary, weather_data,
 *                   tags[], created_at,
 *                   author: { user_id, display_name } | null }],
 *     track:     [...], telemetry: {...} | null, nearby_vessels: [...],
 *     generated_at: <ISO string>
 *   }
 *
 * Errors: 400 missing handle · 403 disabled · 404 unknown handle.
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
// Raised 5_000 → 200_000 → 300_000 on 2026-05-19 alongside the 5 s GPS
// sampling switch. At the new cadence a 4-day passage = ~72k fixes;
// 300k covers a comfortable 14 days without truncation. Pacific
// crossings (20+ days) would still need server-side decimation, but
// 14 days is the working envelope for most blue-water legs.
const MAX_TRACK_POINTS = 300_000;

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

        if (!handle) {
            return json({ error: 'handle is required' }, 400);
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // ── Resolve the config (boat + scope) ──────────────────────
        const { data: config, error: configErr } = await supabase
            .from('voyage_log_configs')
            .select(
                'owner_id, boat_id, scope, enabled, track_days, ' +
                    'destination_name, destination_lat, destination_lon',
            )
            .eq('handle', handle)
            .maybeSingle();

        if (configErr) {
            console.error('voyage-log: config lookup failed:', configErr);
            return json({ error: 'Internal server error' }, 500);
        }
        if (!config) {
            return json({ error: 'Unknown voyage log handle' }, 404);
        }
        if (!config.enabled) {
            return json({ error: 'This voyage log is not currently public' }, 403);
        }

        const ownerId = config.owner_id as string;
        const boatId = config.boat_id as string | null;
        const scope = (config.scope as 'personal' | 'combined') ?? 'personal';
        const trackDays = (config.track_days as number) ?? 30;
        const trackSince = new Date(Date.now() - trackDays * 86400_000).toISOString();

        // Combined scope → which users feed this log? (boat crew, with bylines)
        let combinedAuthors: Map<string, string> | null = null;
        if (scope === 'combined' && boatId) {
            const { data: members } = await supabase
                .from('boat_members')
                .select('user_id, display_name')
                .eq('boat_id', boatId);
            combinedAuthors = new Map(
                (members ?? []).map((m) => [m.user_id as string, (m.display_name as string) || 'Crew']),
            );
        }

        // ── Build the entries query — personal = owner only, combined = all members ─
        const entryUserIds: string[] =
            scope === 'combined' && combinedAuthors ? Array.from(combinedAuthors.keys()) : [ownerId];

        // ── Fetch vessel info, entries, track ──────────────────────
        // TABLE FIX (2026-07-04): the app has always uploaded voyages to
        // `ship_logs` (plural — services/shiplog/helpers.ts SHIP_LOGS_TABLE);
        // this function was reading the abandoned original `ship_log` table
        // from the 20260201 migration, so the public track was permanently
        // empty. ship_logs is keyed by user_id only (no boat_id column) and
        // carries the app's weather-snapshot columns, not the aspirational
        // NMEA set (heading/depth/apparent-true wind) the old select named.
        //
        // PAGINATED: PostgREST clamps ANY single request to its max-rows
        // setting (default 1000) regardless of .limit() — the old
        // .limit(MAX_TRACK_POINTS) call silently truncated an 8-hour
        // passage's public track to its first ~17 minutes (audit
        // 2026-07-03). Page ascending in 1000-row steps up to the
        // declared envelope.
        const TRACK_SELECT =
            'latitude, longitude, timestamp, speed_kts, course_deg, pressure, ' +
            'wind_speed, wind_gust, wind_direction, ' +
            'air_temp, water_temp, wave_height, entry_type, waypoint_name, notes';
        const fetchTrack = async (): Promise<{ data: Record<string, unknown>[]; error: unknown }> => {
            const rows: Record<string, unknown>[] = [];
            const PAGE = 1000;
            while (rows.length < MAX_TRACK_POINTS) {
                const { data, error } = await supabase
                    .from('ship_logs')
                    .select(TRACK_SELECT)
                    .eq('user_id', ownerId)
                    .neq('entry_type', 'manual')
                    .gte('timestamp', trackSince)
                    .order('timestamp', { ascending: true })
                    .range(rows.length, rows.length + PAGE - 1);
                if (error) return { data: rows, error };
                const page = (data ?? []) as Record<string, unknown>[];
                rows.push(...page);
                if (page.length < PAGE) break;
            }
            // Trackworthy filter, mirroring the app's isTrackworthyEntry():
            // manual entries excluded above (their fix can be a cached
            // position up to 60 s behind the boat); COG turn pins are
            // course-change annotations, not track geometry; and implausible
            // (0,0)-ish fixes never render.
            const trackworthy = rows.filter((p) => {
                const lat = p.latitude as number | null;
                const lon = p.longitude as number | null;
                if (typeof lat !== 'number' || typeof lon !== 'number') return false;
                if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return false;
                if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false; // null island
                const name = (p.waypoint_name as string | null) ?? '';
                const notes = (p.notes as string | null) ?? '';
                if (name.startsWith('COG ') || notes.startsWith('Auto: COG')) return false;
                return true;
            });
            return { data: trackworthy, error: null };
        };

        // Live tail — points the device trickled into `live_track` while a
        // voyage is STILL RECORDING (the durable track only lands in
        // ship_logs when the voyage stops). Fetched after the durable track
        // so only rows NEWER than the last durable point are appended: once
        // the at-stop upload arrives, it supersedes the trickle by
        // construction. Capped generously — a multi-day trickle at the
        // device's 30 s decimation floor is ~3k rows/day.
        const fetchLiveTail = async (afterTs: string): Promise<Record<string, unknown>[]> => {
            const rows: Record<string, unknown>[] = [];
            const PAGE = 1000;
            const LIVE_CAP = 10_000;
            while (rows.length < LIVE_CAP) {
                const { data, error } = await supabase
                    .from('live_track')
                    .select('latitude, longitude, timestamp, speed_kts, course_deg, source')
                    .eq('user_id', ownerId)
                    .gt('timestamp', afterTs)
                    .order('timestamp', { ascending: true })
                    .range(rows.length, rows.length + PAGE - 1);
                if (error) {
                    console.warn('voyage-log: live_track fetch failed:', (error as { message?: string }).message);
                    return rows;
                }
                const page = (data ?? []) as Record<string, unknown>[];
                rows.push(...page);
                if (page.length < PAGE) break;
            }
            return rows;
        };

        const [vesselRes, entriesRes, trackRes] = await Promise.all([
            boatId
                ? supabase.from('boats').select('name, vessel_type, model').eq('id', boatId).maybeSingle()
                : supabase
                      .from('vessel_identity')
                      .select('vessel_name, vessel_type, model')
                      .eq('owner_id', ownerId)
                      .maybeSingle(),
            supabase
                .from('diary_entries')
                .select(
                    'id, user_id, title, body, mood, photos, location_name, latitude, longitude, ' +
                        'weather_summary, weather_data, tags, created_at',
                )
                .in('user_id', entryUserIds)
                .eq('is_public', true)
                .order('created_at', { ascending: false })
                .limit(MAX_ENTRIES),
            fetchTrack(),
        ]);

        if (vesselRes.error || entriesRes.error || trackRes.error) {
            console.error('voyage-log: data fetch failed:', {
                vessel: vesselRes.error,
                entries: entriesRes.error,
                track: trackRes.error,
            });
            return json({ error: 'Internal server error' }, 500);
        }

        // boats has columns (name, vessel_type, model); vessel_identity has
        // (vessel_name, vessel_type, model). Normalise to the same shape.
        const vData = vesselRes.data as Record<string, unknown> | null;
        const vessel = {
            name: (vData?.name as string) ?? (vData?.vessel_name as string) ?? 'Unnamed Vessel',
            type: (vData?.vessel_type as string) ?? 'sail',
            model: (vData?.model as string) ?? null,
        };

        // Destination — null if the skipper hasn't set one. Drives the
        // public progress HUD (DTG / ETA / Newport → here → there).
        const destination =
            config.destination_lat != null && config.destination_lon != null
                ? {
                      name: (config.destination_name as string | null) ?? null,
                      lat: config.destination_lat as number,
                      lon: config.destination_lon as number,
                  }
                : null;

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
            // Byline only in combined scope. Personal scope omits it
            // (renderer hides the chip — single voice, no need to attribute).
            author:
                combinedAuthors && combinedAuthors.has(e.user_id as string)
                    ? { user_id: e.user_id, display_name: combinedAuthors.get(e.user_id as string) }
                    : null,
        }));

        const durableTrack = (trackRes.data || []).map((p) => ({
            lat: p.latitude,
            lon: p.longitude,
            timestamp: p.timestamp,
            speed_kts: p.speed_kts,
            course_deg: p.course_deg,
            heading_deg: null,
            pressure: p.pressure,
            // ship_logs carries a weather-snapshot wind (numeric speed/gust +
            // compass-rose direction string), not an instrument apparent/true
            // split. Expose it under both the legacy *_true keys (page
            // compat) and its own names.
            wind_speed_apparent: null,
            wind_angle_apparent: null,
            wind_speed_true: p.wind_speed ?? null,
            wind_direction_true: p.wind_direction ?? null,
            wind_speed: p.wind_speed ?? null,
            wind_gust: p.wind_gust ?? null,
            wind_direction: p.wind_direction ?? null,
            depth_m: null,
            air_temp: p.air_temp ?? null,
            water_temp: p.water_temp ?? null,
            wave_height: p.wave_height ?? null,
            live: false,
        }));

        // Append the live trickle tail (recording voyage, not yet uploaded).
        const lastDurableTs = (durableTrack[durableTrack.length - 1]?.timestamp as string | undefined) ?? trackSince;
        const liveRows = await fetchLiveTail(lastDurableTs);
        const liveTail = liveRows.map((p) => ({
            lat: p.latitude,
            lon: p.longitude,
            timestamp: p.timestamp,
            speed_kts: p.speed_kts ?? null,
            course_deg: p.course_deg ?? null,
            heading_deg: null,
            pressure: null,
            wind_speed_apparent: null,
            wind_angle_apparent: null,
            wind_speed_true: null,
            wind_direction_true: null,
            wind_speed: null,
            wind_gust: null,
            wind_direction: null,
            depth_m: null,
            air_temp: null,
            water_temp: null,
            wave_height: null,
            live: true,
        }));
        const track = [...durableTrack, ...liveTail];

        // ── Nearby AIS contacts (200 nm around the latest fix) ─────
        // Uses the same `vessels_nearby` RPC the iOS app calls. 200 nm is
        // wide for coastal use but a fair "what's around me" radius on
        // open ocean — AIS coverage and the "in your shipping lane"
        // sense both reach further than line-of-sight out at sea. The
        // 60-result cap keeps coastal density from cluttering. Returns
        // an empty list if no data / no current position / RPC error —
        // never blocks the rest of the response.
        const last = track[track.length - 1] ?? null;
        let nearbyVessels: unknown[] = [];
        if (last) {
            const { data: aisData, error: aisErr } = await supabase.rpc('vessels_nearby', {
                query_lat: last.lat,
                query_lon: last.lon,
                radius_m: 200 * 1852, // 200 nm
                max_results: 60,
            });
            if (aisErr) {
                console.warn('voyage-log: AIS lookup failed:', aisErr.message);
            } else if (Array.isArray(aisData)) {
                nearbyVessels = aisData.map((v) => ({
                    mmsi: String((v as { mmsi: unknown }).mmsi ?? ''),
                    name: (v as { name?: string | null }).name ?? null,
                    lat: (v as { lat: number }).lat,
                    lon: (v as { lon: number }).lon,
                    cog: (v as { cog?: number | null }).cog ?? null,
                    sog: (v as { sog?: number | null }).sog ?? null,
                    heading: (v as { heading?: number | null }).heading ?? null,
                    ship_type: (v as { ship_type?: string | null }).ship_type ?? null,
                    call_sign: (v as { call_sign?: string | null }).call_sign ?? null,
                    destination: (v as { destination?: string | null }).destination ?? null,
                    nav_status: (v as { nav_status?: string | null }).nav_status ?? null,
                    updated_at: (v as { updated_at?: string | null }).updated_at ?? null,
                }));
            }
        }

        // ── Latest telemetry = most recent track point ─────────────
        const telemetry = last
            ? {
                  sog: last.speed_kts,
                  cog: last.course_deg,
                  heading: last.heading_deg,
                  baro: last.pressure,
                  baro_trend: baroTrend(track),
                  aws: last.wind_speed_apparent,
                  awa: last.wind_angle_apparent,
                  tws: last.wind_speed_true,
                  twd: last.wind_direction_true,
                  depth: last.depth_m,
                  air_temp: last.air_temp,
                  water_temp: last.water_temp,
                  wave_height: last.wave_height,
                  lat: last.lat,
                  lon: last.lon,
                  updated_at: last.timestamp,
              }
            : null;

        return json(
            {
                vessel,
                scope,
                destination,
                entries,
                track,
                telemetry,
                nearby_vessels: nearbyVessels,
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
