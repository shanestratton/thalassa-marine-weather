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
 * Track + telemetry are keyed by the CONFIG OWNER's user_id — ship_logs
 * has no boat_id column, so per-boat tracks (one shared track for a crewed
 * boat) need a boat_id backfill first. For a crew member's personal log,
 * the track is their own recordings, which is the honest reading anyway.
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
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse } from '../_shared/http-security.ts';
import { decimatePublicTrack } from '../_shared/track-decimation.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_ENTRIES = 200;
// Internal fetch envelope: enough raw samples for telemetry, land-voyage
// classification, and passage progress. The public response is separately
// decimated below; never serialize this many records to an unauthenticated
// viewer.
const MAX_TRACK_POINTS = 300_000;
const MAX_PUBLIC_TRACK_POINTS = 10_000;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
    return jsonResponse(body, status, { ...corsHeaders, ...extraHeaders });
}

/** Sign private diary photos only for entries the owner explicitly published. */
async function publicPhotos(
    supabase: ReturnType<typeof createClient>,
    photos: unknown,
    ownerUserId: string,
): Promise<string[]> {
    if (!Array.isArray(photos)) return [];
    const resolved = await Promise.all(
        photos.map(async (photo) => {
            if (typeof photo !== 'string') return null;
            const privatePrefix = 'storage:diary-photos:';
            let path: string | null = null;
            if (photo.startsWith(privatePrefix)) {
                path = photo.slice(privatePrefix.length);
            } else {
                const legacy = photo.match(/diary-photos\/(.+?)(?:\?.*)?$/);
                if (legacy) path = decodeURIComponent(legacy[1]);
            }
            if (!path) return /^https?:\/\//i.test(photo) ? photo : null;
            // The service-role client can sign any object. Bind every path to
            // the public entry's owner so a crafted diary row cannot turn the
            // public-log endpoint into a signer for somebody else's media.
            if (path.split('/')[0] !== ownerUserId) return null;
            const { data, error } = await supabase.storage.from('diary-photos').createSignedUrl(path, 3600);
            return error ? null : data?.signedUrl || null;
        }),
    );
    return resolved.filter((photo): photo is string => Boolean(photo));
}

/**
 * rising / falling / steady from the last hour of barometric pressure.
 * Time-windowed, not sample-count-windowed: underway capture runs every
 * 30-60 s, so "last 5 samples" spanned 2.5-5 minutes — inside a single
 * forecast-cache hour the delta was always 0 and the trend read as a
 * permanent 'steady'.
 */
function baroTrend(track: { pressure: number | null; timestamp?: unknown }[]): 'rising' | 'falling' | 'steady' {
    const readings = track.filter((t) => typeof t.pressure === 'number');
    if (readings.length < 2) return 'steady';
    const lastTs = Date.parse(String(readings[readings.length - 1].timestamp ?? ''));
    const hourAgo = Number.isFinite(lastTs) ? lastTs - 3600_000 : NaN;
    const windowed = Number.isFinite(hourAgo)
        ? readings.filter((t) => {
              const ts = Date.parse(String(t.timestamp ?? ''));
              return Number.isFinite(ts) && ts >= hourAgo;
          })
        : readings.slice(-5);
    if (windowed.length < 2) return 'steady';
    const delta = (windowed[windowed.length - 1].pressure as number) - (windowed[0].pressure as number);
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

    const caller = await requireAuthenticatedOrPublicQuota(req, 'voyage_log', 360, 120, 3600, true);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    try {
        const url = new URL(req.url);
        const handle = (url.searchParams.get('handle') || '').trim().toLowerCase();

        if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(handle)) {
            return json({ error: 'A valid handle is required' }, 400);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Service unavailable' }, 503);
        const supabase = createClient(supabaseUrl, serviceRoleKey);

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
            'air_temp, water_temp, wave_height, entry_type, waypoint_name, notes, voyage_id, ' +
            'cumulative_distance_nm, is_on_water';

        // Owner's per-voyage exclusion list — voyages hidden from the public
        // page (the app's "Public tracks" list). Filters BOTH the durable
        // track and the live tail. Fail-open on error: a transient read
        // failure shouldn't blank a page the owner expects to be live.
        const hiddenVoyageIds = new Set<string>();
        // Voyages that are majority-LAND — a car drive, not a passage (Shane
        // 2026-07-19: "it also has some older test tracks there on land as
        // well"; his M1 run from Redcliffe to Logan City was drawing on the
        // public page as a voyage). Populated by fetchTrack from the rows it
        // already pages in, then reused by the live tail. Unlike
        // hiddenVoyageIds this is a HEURISTIC, so every choice below is made to
        // fail toward publishing rather than hiding.
        const landVoyageIds = new Set<string>();
        {
            const { data: hiddenRows, error: hiddenErr } = await supabase
                .from('voyage_log_hidden_voyages')
                .select('voyage_id')
                .eq('user_id', ownerId);
            if (hiddenErr) console.warn('voyage-log: hidden-voyages read failed:', hiddenErr.message);
            for (const r of hiddenRows ?? []) {
                if (typeof r.voyage_id === 'string') hiddenVoyageIds.add(r.voyage_id);
            }
        }
        const fetchTrack = async (): Promise<{ data: Record<string, unknown>[]; error: unknown }> => {
            const rows: Record<string, unknown>[] = [];
            const PAGE = 1000;
            while (rows.length < MAX_TRACK_POINTS) {
                const { data, error } = await supabase
                    .from('ship_logs')
                    .select(TRACK_SELECT)
                    .eq('user_id', ownerId)
                    .neq('entry_type', 'manual')
                    // Binned voyages are soft-archived (archived=true) and
                    // hidden from every in-app read — the public page must
                    // hide them too.
                    .or('archived.is.null,archived.eq.false')
                    .gte('timestamp', trackSince)
                    .order('timestamp', { ascending: true })
                    .range(rows.length, rows.length + PAGE - 1);
                if (error) return { data: rows, error };
                const page = (data ?? []) as Record<string, unknown>[];
                rows.push(...page);
                if (page.length < PAGE) break;
            }
            // LAND VERDICT, per VOYAGE — never per point. Mirrors the app's
            // isLandVoyage()/LAND_VOYAGE_FRACTION majority vote
            // (services/shiplog/VoyageSummary.ts:205-209); keep the threshold in
            // step with it and with get_voyage_summaries_rpc.sql.
            //
            // Per-voyage is the safety-critical part. MapContainer only starts a
            // new segment when voyage_id CHANGES, so dropping individual points
            // would not leave a gap — it would bridge them with a straight chord
            // and quietly redraw the passage. A voyage is kept or dropped whole.
            //
            // Untagged rows cast no vote, and a voyage with no tagged rows never
            // enters the tally, so it stays published: same fail-open shape as
            // isLandVoyage's `landFraction != null` guard. The water detector
            // also returns true on any error/offline, so poor connectivity biases
            // toward KEEPING a track. The realistic failure is under-filtering —
            // a drive recorded offline survives — never blanking a real passage.
            const LAND_VOYAGE_FRACTION = 0.6;
            const landTally = new Map<string, { land: number; total: number }>();
            for (const p of rows) {
                if (typeof p.is_on_water !== 'boolean') continue;
                const vid = (p.voyage_id as string | null) ?? '';
                const c = landTally.get(vid) ?? { land: 0, total: 0 };
                c.total += 1;
                if (p.is_on_water === false) c.land += 1;
                landTally.set(vid, c);
            }
            for (const [vid, c] of landTally) {
                if (c.total > 0 && c.land / c.total >= LAND_VOYAGE_FRACTION) landVoyageIds.add(vid);
            }

            // Trackworthy filter, mirroring the app's isTrackworthyEntry():
            // manual entries excluded above (their fix can be a cached
            // position up to 60 s behind the boat); COG turn pins are
            // course-change annotations, not track geometry; and implausible
            // (0,0)-ish fixes never render.
            const trackworthy = rows.filter((p) => {
                if (hiddenVoyageIds.has((p.voyage_id as string | null) ?? '')) return false;
                // …and the car drives (see landVoyageIds above).
                if (landVoyageIds.has((p.voyage_id as string | null) ?? '')) return false;
                // SAVED/PLANNED routes leak in as ship_logs rows keyed
                // 'planned_…' (savePassagePlanToLogbook) — they used to draw
                // as a separate line + amber pins for EVERY route the boat
                // ever saved (Shane 2026-07-17: "shows all of our saved
                // routes… clean it up"). The ONE route being followed is
                // surfaced separately as `passage.plan_line`; drop the planned
                // rows from both the track AND the derived waypoint pins here.
                if (String((p.voyage_id as string | null) ?? '').startsWith('planned_')) return false;
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
            // Pagination offset must count FETCHED rows, not kept rows — the
            // hidden-voyage filter shrinks the kept set and would otherwise
            // make successive .range() windows overlap.
            let fetched = 0;
            while (fetched < LIVE_CAP) {
                const { data, error } = await supabase
                    .from('live_track')
                    .select('latitude, longitude, timestamp, speed_kts, course_deg, source, voyage_id')
                    .eq('user_id', ownerId)
                    .gt('timestamp', afterTs)
                    .order('timestamp', { ascending: true })
                    .range(fetched, fetched + PAGE - 1);
                if (error) {
                    console.warn('voyage-log: live_track fetch failed:', (error as { message?: string }).message);
                    return rows;
                }
                const page = (data ?? []) as Record<string, unknown>[];
                fetched += page.length;
                rows.push(
                    ...page.filter((p) => {
                        const vid = (p.voyage_id as string | null) ?? '';
                        // live_track has voyage_id but no is_on_water, so the
                        // verdict fetchTrack already reached is the only signal
                        // here — another reason it is computed per voyage.
                        return !hiddenVoyageIds.has(vid) && !landVoyageIds.has(vid);
                    }),
                );
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
                        'weather_summary, weather_data, tags, created_at, voyage_id',
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

        // Destination — FULLY DYNAMIC (owner call 2026-07-04: "we will make
        // it all dynamic"). Set below ONLY when a fresh voyage is linked to a
        // passage plan; otherwise null and the page shows no passage HUD.
        // The static voyage_log_configs destination_* columns are deliberately
        // ignored — the old always-on "Newport to Nouméa" header was a stale
        // set-once value, not a real passage.
        let destination: { name: string | null; lat: number; lon: number } | null = null;

        // Hiding a voyage hides its diary entries (and their photos) too —
        // the whole passage disappears from the page as one unit. Entries
        // with no voyage_id (dockside musings) are unaffected.
        const entries = await Promise.all(
            (entriesRes.data || [])
                .filter((e) => !hiddenVoyageIds.has((e.voyage_id as string | null) ?? ''))
                .map(async (e) => ({
                    id: e.id,
                    title: e.title,
                    body: e.body,
                    mood: e.mood,
                    photos: await publicPhotos(supabase, e.photos, e.user_id as string),
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
                })),
        );

        const durableTrack = (trackRes.data || []).map((p) => ({
            lat: p.latitude,
            lon: p.longitude,
            timestamp: p.timestamp,
            // Which voyage this fix belongs to — the page splits the track
            // per voyage so separate passages never join up with a stray
            // line across the map.
            voyage_id: (p.voyage_id as string | null) ?? null,
            speed_kts: p.speed_kts,
            course_deg: p.course_deg,
            heading_deg: null,
            pressure: p.pressure,
            // ship_logs carries a weather-snapshot wind (numeric speed/gust +
            // compass-rose direction STRING like 'NE'), not an instrument
            // apparent/true split. Speed maps to the legacy *_true key
            // (numeric, compatible); direction does NOT — wind_direction_true
            // is contracted as integer degrees and the snapshot only has the
            // cardinal string, so it ships under its own key instead of
            // corrupting the typed one.
            wind_speed_apparent: null,
            wind_angle_apparent: null,
            wind_speed_true: p.wind_speed ?? null,
            wind_direction_true: null,
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
            voyage_id: (p.voyage_id as string | null) ?? null,
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
        const fullTrack = [...durableTrack, ...liveTail];
        const track = decimatePublicTrack(fullTrack, MAX_PUBLIC_TRACK_POINTS);

        // Named waypoints — the marks the skipper deliberately dropped and
        // named under way (entry_type 'waypoint'), as distinct from the auto
        // breadcrumb fixes. The public map shows JUST these as labelled pins
        // (owner ask 2026-07-04: "just the markers that we interact with").
        // rawDurable is already the trackworthy set (hidden voyages, manual
        // entries and COG turn-pins filtered out in fetchTrack).
        //
        // 'Latest Position' is the app's rolling live-marker bookkeeping (it
        // promotes the newest fix to a waypoint each tick and demotes the
        // prior one — demotion doesn't always fire offline, so several leak
        // through). It's never a mark the skipper interacted with — drop it.
        // Voyage Start/End and any custom names stay.
        const SYSTEM_WAYPOINT_NAMES = new Set(['Latest Position']);
        const waypoints = ((trackRes.data || []) as Record<string, unknown>[])
            .filter(
                (p) =>
                    p.entry_type === 'waypoint' &&
                    typeof p.waypoint_name === 'string' &&
                    (p.waypoint_name as string).trim().length > 0 &&
                    !SYSTEM_WAYPOINT_NAMES.has((p.waypoint_name as string).trim()),
            )
            .map((p) => ({
                lat: p.latitude as number,
                lon: p.longitude as number,
                name: p.waypoint_name as string,
                timestamp: p.timestamp as string,
            }));

        // ── Passage: linked plan → dynamic destination + progress ──
        // The newest track point's voyage, when FRESH (<48 h) and linked to
        // a saved passage plan (voyage_plan_links), overrides the static
        // destination with the plan's endpoint and adds a `passage` object:
        // planned vs done distance, percent, ETA at recent average SOG, and
        // a decimated plan line the page can draw under the actual track.
        const NM_PER_M = 1 / 1852;
        const havNM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
            const R = 6_371_000;
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLon = ((lon2 - lon1) * Math.PI) / 180;
            const a =
                Math.sin(dLat / 2) ** 2 +
                Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a)) * NM_PER_M;
        };

        let passage: Record<string, unknown> | null = null;
        const rawDurable = (trackRes.data || []) as Record<string, unknown>[];
        const lastRaw = liveRows[liveRows.length - 1] ?? rawDurable[rawDurable.length - 1] ?? null;
        const lastRawTs = lastRaw ? Date.parse(String(lastRaw.timestamp)) : NaN;
        const voyageFresh = Number.isFinite(lastRawTs) && Date.now() - lastRawTs < 48 * 3600_000;
        const currentVoyageId = (lastRaw?.voyage_id as string | null) ?? null;
        if (voyageFresh && currentVoyageId) {
            const { data: linkRow } = await supabase
                .from('voyage_plan_links')
                .select('plan_voyage_id')
                .eq('user_id', ownerId)
                .eq('voyage_id', currentVoyageId)
                .maybeSingle();
            const planId = (linkRow?.plan_voyage_id as string | undefined) ?? null;
            if (planId) {
                const { data: planRows } = await supabase
                    .from('ship_logs')
                    .select('latitude, longitude, cumulative_distance_nm, waypoint_name, notes, timestamp')
                    .eq('user_id', ownerId)
                    .eq('voyage_id', planId)
                    .order('timestamp', { ascending: true })
                    .limit(1000);
                const plan = (planRows ?? []) as Record<string, unknown>[];
                if (plan.length >= 2) {
                    // Name from the first entry's "Planned: X → Y" line (it
                    // may sit below an embedded route-geometry JSON line).
                    let passageName: string | null = null;
                    const firstNotes = String(plan[0].notes ?? '');
                    const m = firstNotes.match(/^Planned:\s*(.+)$/m);
                    if (m) passageName = m[1].trim();
                    const destName = passageName?.split('→').pop()?.trim() ?? null;

                    const plannedNM = Math.max(
                        0,
                        ...plan.map((p) =>
                            typeof p.cumulative_distance_nm === 'number' ? (p.cumulative_distance_nm as number) : 0,
                        ),
                    );
                    const planEnd = plan[plan.length - 1];

                    // Done = the voyage's own cumulative log (durable rows),
                    // plus live-tail geometry captured since the last upload.
                    const voyageDurable = rawDurable.filter((p) => p.voyage_id === currentVoyageId);
                    let doneNM = Math.max(
                        0,
                        ...voyageDurable.map((p) =>
                            typeof p.cumulative_distance_nm === 'number' ? (p.cumulative_distance_nm as number) : 0,
                        ),
                    );
                    const liveOfVoyage = liveRows.filter((p) => (p.voyage_id ?? currentVoyageId) === currentVoyageId);
                    let prev = voyageDurable[voyageDurable.length - 1] ?? null;
                    for (const p of liveOfVoyage) {
                        if (prev) {
                            doneNM += havNM(
                                prev.latitude as number,
                                prev.longitude as number,
                                p.latitude as number,
                                p.longitude as number,
                            );
                        }
                        prev = p;
                    }

                    // Recent average SOG (last 2 h of this voyage's points,
                    // segment-summed) → ETA. Null when drifting/anchored.
                    const voyagePts = [...voyageDurable, ...liveOfVoyage];
                    const windowStart = lastRawTs - 2 * 3600_000;
                    const recent = voyagePts.filter((p) => Date.parse(String(p.timestamp)) >= windowStart);
                    let recentNM = 0;
                    for (let i = 1; i < recent.length; i++) {
                        recentNM += havNM(
                            recent[i - 1].latitude as number,
                            recent[i - 1].longitude as number,
                            recent[i].latitude as number,
                            recent[i].longitude as number,
                        );
                    }
                    const recentHours =
                        recent.length >= 2
                            ? (Date.parse(String(recent[recent.length - 1].timestamp)) -
                                  Date.parse(String(recent[0].timestamp))) /
                              3600_000
                            : 0;
                    const avgSog = recentHours > 0.1 ? recentNM / recentHours : 0;
                    const remainingNM = Math.max(0, plannedNM - doneNM);
                    const etaIso =
                        avgSog > 0.5 && plannedNM > 0
                            ? new Date(lastRawTs + (remainingNM / avgSog) * 3600_000).toISOString()
                            : null;

                    // Decimate the plan line for the page (≤200 points).
                    const step = Math.max(1, Math.ceil(plan.length / 200));
                    const planLine = plan
                        .filter((_, i) => i % step === 0 || i === plan.length - 1)
                        .map((p) => [p.longitude, p.latitude]);

                    destination = {
                        name: destName,
                        lat: planEnd.latitude as number,
                        lon: planEnd.longitude as number,
                    };
                    passage = {
                        plan_id: planId,
                        name: passageName,
                        planned_nm: Math.round(plannedNM * 10) / 10,
                        done_nm: Math.round(doneNM * 10) / 10,
                        pct: plannedNM > 0 ? Math.min(100, Math.round((doneNM / plannedNM) * 1000) / 10) : null,
                        avg_sog_kts: Math.round(avgSog * 10) / 10,
                        eta: etaIso,
                        plan_line: planLine,
                    };
                }
            }
        }

        // ── Nearby AIS contacts (200 nm around the latest fix) ─────
        // Uses the same `vessels_nearby` RPC the iOS app calls. 200 nm is
        // wide for coastal use but a fair "what's around me" radius on
        // open ocean — AIS coverage and the "in your shipping lane"
        // sense both reach further than line-of-sight out at sea. The
        // 60-result cap keeps coastal density from cluttering. Returns
        // an empty list if no data / no current position / RPC error —
        // never blocks the rest of the response.
        // LAST KNOWN POSITION fallback (Shane 2026-07-19: "we need it to default
        // to our location if there is no track"). With no recent voyage the page
        // had nothing to centre on and drew no boat at all — the map opened on
        // nowhere in particular, which reads as broken rather than as "moored".
        //
        // Deliberately NOT a one-point track: a position is not a passage, and
        // feeding it through the track array would put it inside the land-voyage
        // vote — where a boat sitting at its berth can read as majority-land and
        // get filtered out, i.e. the fix would delete itself. It rides as
        // telemetry instead, which already carries lat/lon/updated_at, and the
        // client centres on that when the track is empty.
        //
        // No new data flow and nothing extra from the phone: this is the last fix
        // the device already recorded. It is also not window-limited — the whole
        // point is that it answers when the 30-day track cannot.
        let last = fullTrack[fullTrack.length - 1] ?? null;
        let lastIsStale = false;
        if (!last) {
            const { data: fallbackRows } = await supabase
                .from('ship_logs')
                .select(
                    'latitude, longitude, timestamp, speed_kts, course_deg, pressure, wind_speed, ' +
                        'wind_direction, air_temp, water_temp, wave_height',
                )
                .eq('user_id', ownerId)
                .or('archived.is.null,archived.eq.false')
                .not('latitude', 'is', null)
                .not('longitude', 'is', null)
                // PLANNED routes are stored as ship_logs rows whose timestamps are
                // ETAs — i.e. in the FUTURE. Ordering by timestamp desc without
                // this happily returned a waypoint the boat has not reached yet and
                // presented it as "where we are" (caught 2026-07-19: the fallback
                // resolved to a fix stamped six hours ahead of real time).
                // NULL voyage_id must survive: `NOT (col LIKE …)` is NULL for NULL,
                // which would silently drop those rows.
                .or('voyage_id.is.null,voyage_id.not.like.planned_%')
                // Belt and braces — any future stamp is not a position we hold.
                .lte('timestamp', new Date().toISOString())
                .order('timestamp', { ascending: false })
                .limit(1);
            const f = (fallbackRows ?? [])[0] as Record<string, unknown> | undefined;
            const fLat = f?.latitude as number | undefined;
            const fLon = f?.longitude as number | undefined;
            // Same plausibility rules the track filter applies — a null-island
            // row would otherwise park the public page in the Gulf of Guinea.
            const plausible =
                typeof fLat === 'number' &&
                typeof fLon === 'number' &&
                Math.abs(fLat) <= 90 &&
                Math.abs(fLon) <= 180 &&
                !(Math.abs(fLat) < 0.001 && Math.abs(fLon) < 0.001);
            if (f && plausible) {
                lastIsStale = true; // the page labels it rather than passing it off as live
                last = {
                    lat: fLat,
                    lon: fLon,
                    timestamp: f.timestamp,
                    voyage_id: null,
                    speed_kts: f.speed_kts ?? null,
                    course_deg: f.course_deg ?? null,
                    heading_deg: null,
                    pressure: f.pressure ?? null,
                    wind_speed_apparent: null,
                    wind_angle_apparent: null,
                    wind_speed_true: f.wind_speed ?? null,
                    wind_direction_true: null,
                    wind_direction: f.wind_direction ?? null,
                    depth_m: null,
                    air_temp: f.air_temp ?? null,
                    water_temp: f.water_temp ?? null,
                    wave_height: f.wave_height ?? null,
                } as unknown as typeof last;
            }
        }
        let nearbyVessels: unknown[] = [];
        // AIS TARGETS PARKED off the public page (Shane 2026-07-19: "can we
        // remove the ais targets from the public page"). Gated here rather than
        // hidden in the client, because that also drops the work: the
        // vessels_nearby RPC (200 nm, up to 60 rows) plus the follow-up MMSI
        // metadata lookup ran on EVERY page load, and the page polls every two
        // minutes per viewer. Nothing was going to be drawn with it.
        //
        // The payload keeps `nearby_vessels: []`, so the client contract is
        // unchanged and its map-over renders nothing — no dead flag needed over
        // there. Flip this to bring the targets back.
        const PUBLIC_AIS_ENABLED = false;
        if (PUBLIC_AIS_ENABLED && last) {
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
                    flag_emoji: null as string | null,
                    flag_country: null as string | null,
                    loa: null as number | null,
                    thumbnail_url: null as string | null,
                }));

                // Enrich with our vessel registry (vessel_metadata, keyed by
                // MMSI): AIS position reports rarely carry the name — the
                // static report that does is infrequent, so most live targets
                // arrive as bare MMSIs. Backfill name / type / call-sign where
                // the feed left them null, and add flag + length + thumbnail.
                const mmsiList = (nearbyVessels as { mmsi: string }[])
                    .map((v) => Number(v.mmsi))
                    .filter((n) => Number.isFinite(n) && n > 0);
                if (mmsiList.length > 0) {
                    const { data: meta, error: metaErr } = await supabase.rpc('lookup_vessel_metadata', {
                        mmsi_list: mmsiList,
                    });
                    if (metaErr) {
                        console.warn('voyage-log: vessel_metadata lookup failed:', metaErr.message);
                    } else if (Array.isArray(meta)) {
                        const byMmsi = new Map(meta.map((m) => [String((m as { mmsi: unknown }).mmsi), m]));
                        nearbyVessels = (nearbyVessels as Record<string, unknown>[]).map((v) => {
                            const m = byMmsi.get(v.mmsi as string) as Record<string, unknown> | undefined;
                            if (!m) return v;
                            return {
                                ...v,
                                name: v.name ?? (m.vessel_name as string | null) ?? null,
                                ship_type: v.ship_type ?? (m.vessel_type as string | null) ?? null,
                                call_sign: v.call_sign ?? (m.call_sign as string | null) ?? null,
                                flag_emoji: (m.flag_emoji as string | null) ?? null,
                                flag_country: (m.flag_country as string | null) ?? null,
                                loa: (m.loa as number | null) ?? null,
                                thumbnail_url: (m.thumbnail_url as string | null) ?? null,
                            };
                        });
                    }
                }
            }
        }

        // ── Latest telemetry = most recent track point ─────────────
        const telemetry = last
            ? {
                  sog: last.speed_kts,
                  cog: last.course_deg,
                  heading: last.heading_deg,
                  baro: last.pressure,
                  baro_trend: baroTrend(fullTrack),
                  aws: last.wind_speed_apparent,
                  awa: last.wind_angle_apparent,
                  tws: last.wind_speed_true,
                  twd: last.wind_direction_true,
                  wind_direction: (last as { wind_direction?: string | null }).wind_direction ?? null,
                  depth: last.depth_m,
                  air_temp: last.air_temp,
                  water_temp: last.water_temp,
                  wave_height: last.wave_height,
                  lat: last.lat,
                  lon: last.lon,
                  updated_at: last.timestamp,
                  // TRUE when this is the last-known-position fallback rather
                  // than a live/recent track fix. The page must say so — a month
                  // -old berth position presented as current is the kind of thing
                  // someone could plan a rendezvous around.
                  is_last_known: lastIsStale,
              }
            : null;

        return json(
            {
                vessel,
                scope,
                destination,
                passage,
                entries,
                track,
                track_meta: {
                    total_points: fullTrack.length,
                    returned_points: track.length,
                    decimated: track.length < fullTrack.length,
                },
                waypoints,
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
