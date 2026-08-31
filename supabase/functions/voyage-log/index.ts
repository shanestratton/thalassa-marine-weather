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
 *   GET /functions/v1/voyage-log?handle=<handle>&trip=latest
 *
 * Scope handling:
 *   • scope = 'personal'  → entries from the config's owner only.
 *   • scope = 'combined'  → entries from every member of the boat,
 *                           each tagged with author { user_id, display_name }.
 * Track + telemetry are pinned to the config's `boat_id` when available.
 * Legacy rows without a boat assignment remain readable only for legacy
 * configs, never mixed into a modern multi-vessel public page.
 *
 * Response 200:
 *   {
 *     vessel:      { name, type, model },
 *     scope:       'personal' | 'combined',
 *     destination: { name, lat, lon } | null,
 *     trips:     [{ id, kind, label, started_at, ended_at, active, ... }],
 *     selected_trip: <trip id | "all-diary" | null>,
 *     entries:   [{ id, title, body, mood, photos[], location_name,
 *                   latitude, longitude, weather_summary, weather_data,
 *                   voyage_id | null, tags[], created_at,
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
import {
    allDiaryPublicTrip,
    buildPublicTripCatalogue,
    resolvePublicTripSelection,
} from '../_shared/public-trip-selector.ts';

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

/**
 * The only capability publicPhotos needs is a storage signer, so it asks for
 * exactly that shape. Naming the whole client here instead pinned the helper to
 * the default schema generics of `createClient`, which are not the generics the
 * handler's own client is constructed with — a mismatch that says nothing about
 * this function's actual requirements.
 */
type DiaryPhotoSigner = {
    storage: {
        from(bucket: string): {
            createSignedUrl(
                path: string,
                expiresIn: number,
            ): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
        };
    };
};

/** Sign private diary photos only for entries the owner explicitly published. */
async function publicPhotos(supabase: DiaryPhotoSigner, photos: unknown, ownerUserId: string): Promise<string[]> {
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
 *
 * `pressure` is accepted as unknown because the track rows arrive straight from
 * the database with no column typing; the `typeof … === 'number'` filter below
 * is the guard that establishes the numbers this function relies on.
 */
function baroTrend(track: { pressure: unknown; timestamp?: unknown }[]): 'rising' | 'falling' | 'steady' {
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

/**
 * Saved route plans keep their dense, chart-aware geometry in the first
 * log row's notes. The waypoint rows are still useful for names and
 * distances, but joining only those points redraws a curved route as a
 * misleading straight chord on the public chart.
 */
function recoverPublicRouteGeometry(notes: unknown): Array<[number, number]> | null {
    const prefix = '__route_geometry__::';
    const MAX_ROUTE_GEOMETRY_CHARS = 250_000;
    const MAX_ROUTE_GEOMETRY_POINTS = 5_000;
    if (typeof notes !== 'string' || notes.length > MAX_ROUTE_GEOMETRY_CHARS || !notes.startsWith(prefix)) {
        return null;
    }
    const encoded = notes.slice(prefix.length);
    const newline = encoded.indexOf('\n');
    const json = newline === -1 ? encoded : encoded.slice(0, newline);
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return null;
        const points: Array<[number, number]> = [];
        for (const candidate of parsed) {
            if (points.length >= MAX_ROUTE_GEOMETRY_POINTS) break;
            if (!Array.isArray(candidate) || candidate.length < 2) continue;
            const [lon, lat] = candidate;
            if (
                typeof lon !== 'number' ||
                typeof lat !== 'number' ||
                !Number.isFinite(lon) ||
                !Number.isFinite(lat) ||
                Math.abs(lat) > 90 ||
                Math.abs(lon) > 180
            ) {
                continue;
            }
            points.push([lon, lat]);
        }
        return points.length >= 2 ? points : null;
    } catch {
        return null;
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
    }

    // Public bucket 600/hr per IP hash (was 120): the official page polls
    // every 60 s, so 120 was barely 2 tabs' worth — one household NAT (or a
    // marina's guest Wi-Fi, or carrier CGNAT) following one boat exhausted
    // the bucket and the family got "Request quota exceeded" while the boat
    // was at sea (audit 2026-08-02). 600 covers ~10 worst-case tabs behind
    // one IP while still bounding a scraper to 10 req/min sustained.
    const caller = await requireAuthenticatedOrPublicQuota(req, 'voyage_log', 360, 600, 3600, true);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    try {
        const url = new URL(req.url);
        const handle = (url.searchParams.get('handle') || '').trim().toLowerCase();
        // Omitted `trip` retains the long-standing full-feed API contract for
        // third-party consumers. The official public page explicitly asks for
        // `latest`, `all-diary`, or one catalogue id.
        const requestedTrip = url.searchParams.has('trip') ? (url.searchParams.get('trip') || '').trim() : null;

        if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(handle)) {
            return json({ error: 'A valid handle is required' }, 400);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Service unavailable' }, 503);
        const supabase = createClient(supabaseUrl, serviceRoleKey);

        // ── Resolve the config (boat + scope) ──────────────────────
        // The row shape is named explicitly because postgrest-js can only infer
        // columns from a select written as one string literal, and these lists
        // are assembled from concatenated fragments.
        type VoyageLogConfigRow = {
            owner_id: string;
            boat_id: string | null;
            scope: string | null;
            enabled: boolean | null;
            track_days: number | null;
            destination_name: string | null;
            destination_lat: number | null;
            destination_lon: number | null;
        };
        const { data: config, error: configErr } = await supabase
            .from('voyage_log_configs')
            .select<string, VoyageLogConfigRow>(
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

        // TEMPORARY DIAGNOSTIC (2026-08-26, remove after boat-pin audit):
        // gated by a random token, reports why a boat-pinned page is empty.
        const scope = (config.scope as 'personal' | 'combined') ?? 'personal';
        const trackDays = (config.track_days as number) ?? 30;
        const trackSince = new Date(Date.now() - trackDays * 86400_000).toISOString();

        // Combined scope → which users feed this log? (boat crew, with bylines)
        let combinedAuthors: Map<string, string> | null = null;
        if (scope === 'combined' && boatId) {
            const { data: members, error: membersError } = await supabase
                .from('boat_members')
                .select('user_id, display_name')
                .eq('boat_id', boatId);
            if (membersError) {
                // Owner entries remain usable (and visible) if a crew lookup
                // is transiently unavailable; never replace the feed with an
                // unsafe empty `.in()` query.
                console.warn('voyage-log: boat-members fetch failed:', membersError.message);
            }
            combinedAuthors = new Map(
                (members ?? []).map((m) => [m.user_id as string, (m.display_name as string) || 'Crew']),
            );
            // The owner normally appears in boat_members, but do not let a
            // partially repaired membership row hide the skipper's own public
            // diary from a combined log.
            if (!combinedAuthors.has(ownerId)) combinedAuthors.set(ownerId, 'Skipper');
        }

        // ── Build the entries query — personal = owner only, combined = all members ─
        const entryUserIds: string[] = scope === 'combined' && combinedAuthors
            ? Array.from(combinedAuthors.keys())
            : [ownerId];

        // ── Fetch vessel info, entries, track ──────────────────────
        // TABLE FIX (2026-07-04): the app has always uploaded voyages to
        // `ship_logs` (plural — services/shiplog/helpers.ts SHIP_LOGS_TABLE);
        // this function was reading the abandoned original `ship_log` table
        // from the 20260201 migration, so the public track was permanently
        // empty. ship_logs carries an explicit boat_id after the fleet
        // migration, plus the app's weather-snapshot columns rather than the aspirational
        // NMEA set (heading/depth/apparent-true wind) the old select named.
        //
        // PAGINATED: PostgREST clamps ANY single request to its max-rows
        // setting (default 1000) regardless of .limit() — the old
        // .limit(MAX_TRACK_POINTS) call silently truncated an 8-hour
        // passage's public track to its first ~17 minutes (audit
        // 2026-07-03). Page ascending in 1000-row steps up to the
        // declared envelope.
        const TRACK_SELECT = 'latitude, longitude, timestamp, speed_kts, course_deg, pressure, ' +
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
        // A hidden-voyage list is an explicit skipper privacy decision, not a
        // cosmetic enhancement. If that authority cannot be read, suppress
        // track-derived data rather than accidentally revealing a hidden trip
        // (diary visibility remains independently governed by is_public).
        let trackVisibilityReadable = true;
        {
            const { data: hiddenRows, error: hiddenErr } = await supabase
                .from('voyage_log_hidden_voyages')
                .select('voyage_id')
                .eq('user_id', ownerId);
            if (hiddenErr) {
                trackVisibilityReadable = false;
                console.error('voyage-log: hidden-voyages read failed; suppressing track data:', hiddenErr.message);
            }
            for (const r of hiddenRows ?? []) {
                if (typeof r.voyage_id === 'string') hiddenVoyageIds.add(r.voyage_id);
            }
        }
        const fetchTrack = async ({
            voyageId,
            since,
        }: {
            voyageId?: string;
            since?: string;
        } = {}): Promise<{ data: Record<string, unknown>[]; error: unknown }> => {
            if (!trackVisibilityReadable) return { data: [], error: null };
            const rows: Record<string, unknown>[] = [];
            const PAGE = 1000;
            while (rows.length < MAX_TRACK_POINTS) {
                let query = supabase
                    .from('ship_logs')
                    // Rows are declared as untyped column bags to match how they
                    // are consumed: every reader below re-checks the column it
                    // needs, because a logbook row can predate any of them.
                    .select<string, Record<string, unknown>>(TRACK_SELECT)
                    .eq('user_id', ownerId)
                    .neq('entry_type', 'manual')
                    // Binned voyages are soft-archived (archived=true) and
                    // hidden from every in-app read — the public page must
                    // hide them too.
                    .or('archived.is.null,archived.eq.false');
                if (boatId) query = query.eq('boat_id', boatId);
                if (voyageId) query = query.eq('voyage_id', voyageId);
                else if (since) query = query.gte('timestamp', since);
                const { data, error } = await query
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
        const fetchLiveTail = async (afterTs: string, voyageId?: string): Promise<Record<string, unknown>[]> => {
            const rows: Record<string, unknown>[] = [];
            const PAGE = 1000;
            const LIVE_CAP = 10_000;
            // Pagination offset must count FETCHED rows, not kept rows — the
            // hidden-voyage filter shrinks the kept set and would otherwise
            // make successive .range() windows overlap.
            let fetched = 0;
            while (fetched < LIVE_CAP) {
                let query = supabase
                    .from('live_track')
                    .select('latitude, longitude, timestamp, speed_kts, course_deg, source, voyage_id, is_on_water')
                    .eq('user_id', ownerId)
                    .gt('timestamp', afterTs);
                if (boatId) query = query.eq('boat_id', boatId);
                if (voyageId) query = query.eq('voyage_id', voyageId);
                const { data, error } = await query
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
                        // New live-track rows preserve the capture-time water
                        // verdict. Older rows can be unknown, so retaining
                        // their null verdict is deliberately less destructive
                        // than inventing a land classification.
                        const lat = p.latitude as number | null;
                        const lon = p.longitude as number | null;
                        return (
                            !hiddenVoyageIds.has(vid) &&
                            !landVoyageIds.has(vid) &&
                            !vid.startsWith('planned_') &&
                            // New live rows carry the capture-time water
                            // verdict. Older rows may be unknown, so retain
                            // them until the seven-day live-tail expiry rather
                            // than inventing a false land classification.
                            p.is_on_water !== false &&
                            typeof lat === 'number' &&
                            typeof lon === 'number' &&
                            Math.abs(lat) <= 90 &&
                            Math.abs(lon) <= 180 &&
                            !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001)
                        );
                    }),
                );
                if (page.length < PAGE) break;
            }
            return rows;
        };

        const vesselRes = await (boatId
            ? supabase.from('boats').select('name, vessel_type, model').eq('id', boatId).maybeSingle()
            : supabase
                .from('vessel_identity')
                .select('vessel_name, vessel_type, model')
                .eq('owner_id', ownerId)
                .maybeSingle());

        if (vesselRes.error) {
            console.error('voyage-log: vessel fetch failed:', vesselRes.error);
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

        type CatalogueRow = {
            voyage_id?: unknown;
            started_at?: unknown;
            ended_at?: unknown;
            point_count?: unknown;
            distance_nm?: unknown;
            land_fraction?: unknown;
            plan_voyage_id?: unknown;
        };
        type CatalogueMetadata = {
            pointCount: number;
            distanceNm: number | null;
            planVoyageId: string | null;
        };

        // The selector catalogue is an aggregate query, deliberately separate
        // from track geometry. It stays correct for dense logbooks (where an
        // ascending point scan used to hit its cap before the newest passage)
        // and fetches a selected old trip at full detail only when requested.
        let catalogueRows: CatalogueRow[] = [];
        let catalogueFallbackRows: Record<string, unknown>[] = [];
        let catalogueLiveRows: Record<string, unknown>[] = [];
        if (trackVisibilityReadable) {
            const [catalogueResult, liveResult] = await Promise.all([
                supabase.rpc('public_voyage_log_trip_catalog', {
                    p_owner_id: ownerId,
                    p_since: trackSince,
                    p_boat_id: boatId,
                }),
                fetchLiveTail(trackSince),
            ]);
            catalogueLiveRows = liveResult;
            if (catalogueResult.error) {
                // Keep currently deployed installations usable while the
                // catalogue migration rolls out. The fallback honours the
                // same public retention window; it is intentionally not the
                // normal selector path because it cannot outscale the RPC.
                console.warn(
                    'voyage-log: trip-catalogue RPC unavailable; using bounded fallback:',
                    catalogueResult.error.message,
                );
                const fallback = await fetchTrack({ since: trackSince });
                if (fallback.error) {
                    console.error('voyage-log: fallback track catalogue failed:', fallback.error);
                    return json({ error: 'Internal server error' }, 500);
                }
                catalogueFallbackRows = fallback.data;
            } else {
                catalogueRows = (catalogueResult.data ?? []) as CatalogueRow[];
            }
        }

        // "Live" is a fresh trickled GPS point, never merely the newest
        // durable row. This prevents a completed voyage from wearing a live
        // badge for the next two days.
        const latestCatalogueLive = catalogueLiveRows[catalogueLiveRows.length - 1] ?? null;
        const latestCatalogueLiveTs = latestCatalogueLive
            ? Date.parse(String(latestCatalogueLive.timestamp))
            : Number.NaN;
        const liveNow = Date.now();
        const LIVE_VOYAGE_FRESH_MS = 10 * 60_000;
        const latestCatalogueVoyageId = typeof latestCatalogueLive?.voyage_id === 'string'
            ? latestCatalogueLive.voyage_id.trim()
            : '';

        // THE PICKER MUST NOT DEPEND ON THE LIVE TRICKLE. Cast Off writes
        // the voyage row server-side the moment a passage starts, so it is a
        // trip from that moment — live sharing off, GPS still acquiring, or
        // a start path that forgot to arm the trickle included (Shane,
        // 2026-09-01: "the route shows, but the viewing box says no trip
        // started yet" — a Cast-Off departure; a Log-page start was fine).
        // Zombie guard: an 'active' row is trusted only while its departure
        // is recent — a crashed voyage's stale status must not resurrect as
        // a live trip a week later.
        const ACTIVE_ROW_FRESH_MS = 7 * 24 * 3_600_000;
        let activeRowVoyageId: string | null = null;
        let activeRowStartedAtIso: string | null = null;
        {
            const { data: activeRow, error: activeRowError } = await supabase
                .from('voyages')
                .select('id, departure_time, created_at')
                .eq('user_id', ownerId)
                .eq('status', 'active')
                .maybeSingle();
            if (activeRowError) {
                console.warn('voyage-log: active-voyage row fetch failed:', activeRowError.message);
            }
            const id = typeof activeRow?.id === 'string' ? activeRow.id : '';
            const startedIso = typeof activeRow?.departure_time === 'string'
                ? activeRow.departure_time
                : typeof activeRow?.created_at === 'string'
                ? activeRow.created_at
                : null;
            const startedTs = startedIso ? Date.parse(startedIso) : Number.NaN;
            if (
                id && !hiddenVoyageIds.has(id) && startedIso &&
                Number.isFinite(startedTs) && liveNow - startedTs < ACTIVE_ROW_FRESH_MS
            ) {
                activeRowVoyageId = id;
                activeRowStartedAtIso = startedIso;
            }
        }

        const currentVoyageId = latestCatalogueVoyageId &&
                Number.isFinite(latestCatalogueLiveTs) &&
                latestCatalogueLiveTs <= liveNow + 60_000 &&
                liveNow - latestCatalogueLiveTs < LIVE_VOYAGE_FRESH_MS
            ? latestCatalogueVoyageId
            : activeRowVoyageId;

        const planIdByVoyageId = new Map<string, string>();
        const catalogueMetadataByVoyageId = new Map<string, CatalogueMetadata>();
        const cataloguePoints: Array<{ voyage_id: string; timestamp: string; cumulative_distance_nm: number | null }> =
            [];
        const suppressedCatalogueVoyageIds = new Set<string>();
        for (const row of catalogueRows) {
            const voyageId = typeof row.voyage_id === 'string' ? row.voyage_id.trim() : '';
            const landFraction = typeof row.land_fraction === 'number' ? row.land_fraction : null;
            if (!voyageId || hiddenVoyageIds.has(voyageId) || (landFraction !== null && landFraction >= 0.6)) {
                if (voyageId) {
                    suppressedCatalogueVoyageIds.add(voyageId);
                }
                continue;
            }
            const startedAt = typeof row.started_at === 'string' ? row.started_at : null;
            const endedAt = typeof row.ended_at === 'string' ? row.ended_at : null;
            const pointCount =
                typeof row.point_count === 'number' && Number.isFinite(row.point_count) && row.point_count > 0
                    ? Math.floor(row.point_count)
                    : 0;
            const distanceNm =
                typeof row.distance_nm === 'number' && Number.isFinite(row.distance_nm) && row.distance_nm >= 0
                    ? row.distance_nm
                    : null;
            const planVoyageId = typeof row.plan_voyage_id === 'string' && row.plan_voyage_id.trim()
                ? row.plan_voyage_id.trim()
                : null;
            catalogueMetadataByVoyageId.set(voyageId, { pointCount, distanceNm, planVoyageId });
            if (planVoyageId) {
                planIdByVoyageId.set(voyageId, planVoyageId);
            }
            if (startedAt) {
                cataloguePoints.push({ voyage_id: voyageId, timestamp: startedAt, cumulative_distance_nm: 0 });
            }
            if (endedAt && endedAt !== startedAt) {
                cataloguePoints.push({ voyage_id: voyageId, timestamp: endedAt, cumulative_distance_nm: distanceNm });
            }
        }
        // A just-cast-off live trip has no durable ship_logs row for the
        // catalogue RPC to join yet. Resolve only that one link so its picker
        // label accurately says a passage route is available.
        if (currentVoyageId && !planIdByVoyageId.has(currentVoyageId)) {
            const { data: liveLink, error: liveLinkError } = await supabase
                .from('voyage_plan_links')
                .select('plan_voyage_id')
                .eq('user_id', ownerId)
                .eq('voyage_id', currentVoyageId)
                .maybeSingle();
            if (liveLinkError) {
                console.warn('voyage-log: live passage-link fetch failed:', liveLinkError.message);
            }
            const livePlanVoyageId = liveLink?.plan_voyage_id;
            if (typeof livePlanVoyageId === 'string' && livePlanVoyageId.trim()) {
                planIdByVoyageId.set(currentVoyageId, livePlanVoyageId.trim());
            }
        }
        // Compatibility for an Edge deployment that arrives slightly before
        // its migration. This path is retention-bounded and never issues an
        // unbounded plan-link IN query.
        for (const row of catalogueFallbackRows) {
            const voyageId = typeof row.voyage_id === 'string' ? row.voyage_id.trim() : '';
            const timestamp = typeof row.timestamp === 'string' ? row.timestamp : '';
            if (!voyageId || !timestamp) {
                continue;
            }
            cataloguePoints.push({
                voyage_id: voyageId,
                timestamp,
                cumulative_distance_nm: typeof row.cumulative_distance_nm === 'number'
                    ? row.cumulative_distance_nm
                    : null,
            });
        }

        // A current voyage has no durable rows until stop/upload. Add its
        // fresh trickle points so it enters the picker at the first vetted GPS
        // fix, while old/stale tails cannot invent phantom passages.
        const activeLivePoints =
            currentVoyageId && !suppressedCatalogueVoyageIds.has(currentVoyageId) && !landVoyageIds.has(currentVoyageId)
                ? catalogueLiveRows.filter((row) =>
                    row.voyage_id === currentVoyageId
                )
                : [];
        for (const row of activeLivePoints) {
            const timestamp = typeof row.timestamp === 'string' ? row.timestamp : '';
            if (!timestamp || !currentVoyageId) continue;
            cataloguePoints.push({ voyage_id: currentVoyageId, timestamp, cumulative_distance_nm: null });
        }
        const activeLiveCounts = new Map<string, number>();
        if (currentVoyageId) activeLiveCounts.set(currentVoyageId, activeLivePoints.length);
        // A passage with no vetted fix yet (or no live sharing) still enters
        // the picker: seed it with its own departure moment.
        if (
            currentVoyageId && activeRowStartedAtIso &&
            !cataloguePoints.some((point) => point.voyage_id === currentVoyageId)
        ) {
            cataloguePoints.push({
                voyage_id: currentVoyageId,
                timestamp: activeRowStartedAtIso,
                cumulative_distance_nm: null,
            });
        }
        const trips = [
            ...buildPublicTripCatalogue(cataloguePoints, currentVoyageId, new Set(planIdByVoyageId.keys())).map(
                (trip) => {
                    const metadata = catalogueMetadataByVoyageId.get(trip.id);
                    if (!metadata) return trip;
                    return {
                        ...trip,
                        point_count: metadata.pointCount + (activeLiveCounts.get(trip.id) ?? 0),
                        distance_nm: metadata.distanceNm === null
                            ? trip.distance_nm
                            : Math.round(metadata.distanceNm * 10) / 10,
                    };
                },
            ),
            allDiaryPublicTrip(),
        ];
        const tripSelection = resolvePublicTripSelection(trips, requestedTrip);
        if (!tripSelection) {
            // Do not distinguish a malformed id from a hidden/deleted trip.
            // The catalogue itself is the public authority.
            return json({ error: 'Trip unavailable' }, 404);
        }
        const selectedTrackId = tripSelection.mode === 'track' ? (tripSelection.trip?.id ?? null) : null;

        // Geometry is fetched only for the chosen trip. That gives each old
        // passage its own decimation budget and keeps a historical dropdown
        // from turning the public endpoint into an all-tracks bulk export.
        const trackRes = selectedTrackId !== null
            ? await fetchTrack({ voyageId: selectedTrackId })
            : tripSelection.mode === 'legacy'
            ? await fetchTrack({ since: trackSince })
            : { data: [] as Record<string, unknown>[], error: null };
        if (trackRes.error) {
            console.error('voyage-log: selected track fetch failed:', trackRes.error);
            return json({ error: 'Internal server error' }, 500);
        }

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
            cumulative_distance_nm: p.cumulative_distance_nm ?? null,
            live: false,
        }));

        // Append the selected live trickle tail (recording voyage, not yet
        // uploaded). All-diary intentionally has neither geometry nor a boat
        // position; it is a diary-only view.
        const lastDurableTs = (durableTrack[durableTrack.length - 1]?.timestamp as string | undefined) ?? trackSince;
        const liveRows = trackVisibilityReadable && tripSelection.mode !== 'all-diary'
            ? await fetchLiveTail(lastDurableTs, selectedTrackId ?? undefined)
            : [];
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
            cumulative_distance_nm: null,
            live: true,
        }));
        const fullTrack = [...durableTrack, ...liveTail];
        const rawDurable = (trackRes.data || []) as Record<string, unknown>[];
        const selectedFullTrack = tripSelection.mode === 'all-diary' ? [] : fullTrack;
        // Each chosen trip gets its own decimation budget; slicing a globally
        // decimated history makes an old passage unnecessarily sparse.
        const track = decimatePublicTrack(selectedFullTrack, MAX_PUBLIC_TRACK_POINTS);
        const selectedRawDurable = tripSelection.mode === 'all-diary' ? [] : rawDurable;
        const selectedLiveRows = tripSelection.mode === 'all-diary' ? [] : liveRows;

        // The normal RPC supplies the linked route id as part of catalogue
        // metadata. The rollout fallback resolves just the one displayed
        // voyage, never a massive IN query over every historical point.
        const passageVoyageId = selectedTrackId ?? (tripSelection.mode === 'legacy' ? currentVoyageId : null);
        if (passageVoyageId && !planIdByVoyageId.has(passageVoyageId)) {
            const { data: linkRow, error: linkError } = await supabase
                .from('voyage_plan_links')
                .select('plan_voyage_id')
                .eq('user_id', ownerId)
                .eq('voyage_id', passageVoyageId)
                .maybeSingle();
            if (linkError) console.warn('voyage-log: selected passage-link fetch failed:', linkError.message);
            const planVoyageId = linkRow?.plan_voyage_id;
            if (typeof planVoyageId === 'string' && planVoyageId.trim()) {
                planIdByVoyageId.set(passageVoyageId, planVoyageId.trim());
            }
        }

        // A public Diary entry is always opt-in. A selected owner track
        // filters *before* the 200-row cap; combined crew entries stay in the
        // All diary entries view because their local voyage ids are not a
        // trustworthy shared boat identity.
        const diarySelect = 'id, user_id, title, body, mood, photos, video_url, location_name, latitude, longitude, ' +
            'weather_summary, weather_data, tags, created_at, voyage_id';
        // Named for the same reason as the config row above: a concatenated
        // select string carries no column information for postgrest-js to infer.
        type PublicDiaryRow = {
            id: string;
            user_id: string;
            title: string | null;
            body: string | null;
            mood: string | null;
            photos: unknown;
            video_url: string | null;
            location_name: string | null;
            latitude: number | null;
            longitude: number | null;
            weather_summary: string | null;
            weather_data: unknown;
            tags: unknown;
            created_at: string;
            voyage_id: string | null;
        };
        let diaryQuery = selectedTrackId
            ? supabase
                .from('diary_entries')
                .select<string, PublicDiaryRow>(diarySelect)
                .eq('user_id', ownerId)
                .eq('voyage_id', selectedTrackId)
            : supabase.from('diary_entries').select<string, PublicDiaryRow>(diarySelect).in('user_id', entryUserIds);
        if (boatId) diaryQuery = diaryQuery.eq('boat_id', boatId);
        const entriesRes = await diaryQuery
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .limit(MAX_ENTRIES);
        if (entriesRes.error) {
            console.error('voyage-log: diary fetch failed:', entriesRes.error);
            return json({ error: 'Internal server error' }, 500);
        }

        const entries = await Promise.all(
            (entriesRes.data || []).map(async (e) => ({
                id: e.id,
                title: e.title,
                body: e.body,
                mood: e.mood,
                photos: await publicPhotos(supabase, e.photos, e.user_id as string),
                // The video bucket is public (like photos before the signing
                // change), and this query is already fenced to is_public rows —
                // the URL passes through untouched.
                video_url: typeof e.video_url === 'string' && e.video_url.startsWith('https://') ? e.video_url : null,
                location_name: e.location_name,
                latitude: e.latitude,
                longitude: e.longitude,
                weather_summary: e.weather_summary,
                weather_data: e.weather_data ?? null,
                voyage_id: (e.voyage_id as string | null) ?? null,
                tags: Array.isArray(e.tags) ? e.tags : [],
                created_at: e.created_at,
                // Byline only in combined scope. Personal scope omits it
                // (renderer hides the chip — single voice, no need to attribute).
                author: combinedAuthors && combinedAuthors.has(e.user_id as string)
                    ? { user_id: e.user_id, display_name: combinedAuthors.get(e.user_id as string) }
                    : null,
            })),
        );

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
        const waypoints = selectedRawDurable
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

        // ── Passage: linked plan → destination + progress ──────────
        // A selected public trip may be historical. It still gets its linked
        // route and honest recorded progress; only the legacy no-selector
        // response limits this enhancement to the fresh current voyage.
        const NM_PER_M = 1 / 1852;
        const havNM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
            const R = 6_371_000;
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLon = ((lon2 - lon1) * Math.PI) / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a)) * NM_PER_M;
        };

        let passage: Record<string, unknown> | null = null;
        const displayedVoyageId = selectedTrackId ?? (tripSelection.mode === 'legacy' ? currentVoyageId : null);
        const planId = displayedVoyageId ? (planIdByVoyageId.get(displayedVoyageId) ?? null) : null;
        if (displayedVoyageId && planId) {
            let planQuery = supabase
                .from('ship_logs')
                .select('latitude, longitude, cumulative_distance_nm, waypoint_name, notes, timestamp')
                .eq('user_id', ownerId)
                .eq('voyage_id', planId)
                .eq('source', 'planned_route')
                .or('archived.is.null,archived.eq.false');
            if (boatId) planQuery = planQuery.eq('boat_id', boatId);
            const { data: planRows, error: planError } = await planQuery
                .order('timestamp', { ascending: true })
                .limit(1000);
            if (planError) {
                console.warn('voyage-log: linked-plan fetch failed:', planError.message);
            }
            const plan = (planRows ?? []) as Record<string, unknown>[];
            const planPoints = plan.filter((point) => {
                const lat = point.latitude;
                const lon = point.longitude;
                return (
                    typeof lat === 'number' &&
                    typeof lon === 'number' &&
                    Number.isFinite(lat) &&
                    Number.isFinite(lon) &&
                    Math.abs(lat) <= 90 &&
                    Math.abs(lon) <= 180
                );
            });
            if (planPoints.length >= 2) {
                // Name from the first entry's "Planned: X → Y" line (it may
                // sit below the embedded route-geometry JSON line).
                let passageName: string | null = null;
                const firstNotes = String(plan[0]?.notes ?? '');
                const nameMatch = firstNotes.match(/^Planned:\s*(.+)$/m);
                if (nameMatch) passageName = nameMatch[1].trim();
                const destName = passageName?.split('→').pop()?.trim() ?? null;

                const plannedNM = Math.max(
                    0,
                    ...plan.map((point) =>
                        typeof point.cumulative_distance_nm === 'number' ? point.cumulative_distance_nm : 0
                    ),
                );
                const planEnd = planPoints[planPoints.length - 1];

                // Done = the selected voyage's durable cumulative log plus
                // any live-tail geometry received after its last upload.
                const voyageDurable = selectedRawDurable.filter((point) => point.voyage_id === displayedVoyageId);
                const liveOfVoyage = selectedLiveRows.filter((point) => point.voyage_id === displayedVoyageId);
                let doneNM = Math.max(
                    0,
                    ...voyageDurable.map((point) =>
                        typeof point.cumulative_distance_nm === 'number' ? point.cumulative_distance_nm : 0
                    ),
                );
                let previous = voyageDurable[voyageDurable.length - 1] ?? null;
                for (const point of liveOfVoyage) {
                    if (previous) {
                        doneNM += havNM(
                            previous.latitude as number,
                            previous.longitude as number,
                            point.latitude as number,
                            point.longitude as number,
                        );
                    }
                    previous = point;
                }

                // Recent average SOG (last two hours of this trip) gives an
                // ETA while it is under way. A historic trip's ETA is simply
                // not used by the public page, but its progress remains useful.
                const voyagePoints = [...voyageDurable, ...liveOfVoyage];
                const voyageLast = voyagePoints[voyagePoints.length - 1] ?? null;
                const voyageLastTs = voyageLast ? Date.parse(String(voyageLast.timestamp)) : NaN;
                const windowStart = voyageLastTs - 2 * 3600_000;
                const recent = voyagePoints.filter((point) => Date.parse(String(point.timestamp)) >= windowStart);
                let recentNM = 0;
                for (let index = 1; index < recent.length; index++) {
                    recentNM += havNM(
                        recent[index - 1].latitude as number,
                        recent[index - 1].longitude as number,
                        recent[index].latitude as number,
                        recent[index].longitude as number,
                    );
                }
                const recentHours = recent.length >= 2
                    ? (Date.parse(String(recent[recent.length - 1].timestamp)) -
                        Date.parse(String(recent[0].timestamp))) /
                        3600_000
                    : 0;
                const avgSog = recentHours > 0.1 ? recentNM / recentHours : 0;
                const remainingNM = Math.max(0, plannedNM - doneNM);
                const etaIso = avgSog > 0.5 && plannedNM > 0 && Number.isFinite(voyageLastTs)
                    ? new Date(voyageLastTs + (remainingNM / avgSog) * 3600_000).toISOString()
                    : null;

                // Prefer the saved dense curve rather than rebuilding a
                // straight line from waypoints. Decimate independently for
                // the selected passage so historical curves remain legible.
                const routeGeometry = recoverPublicRouteGeometry(firstNotes);
                const planStart = planPoints[0];
                const routeGeometryMatchesPlan = routeGeometry !== null &&
                    havNM(
                            planStart.latitude as number,
                            planStart.longitude as number,
                            routeGeometry[0][1],
                            routeGeometry[0][0],
                        ) <= 2 &&
                    havNM(
                            planEnd.latitude as number,
                            planEnd.longitude as number,
                            routeGeometry[routeGeometry.length - 1][1],
                            routeGeometry[routeGeometry.length - 1][0],
                        ) <= 2;
                const routeLine: Array<[number, number]> = (routeGeometryMatchesPlan ? routeGeometry : null) ??
                    planPoints.map(
                        (point) => [point.longitude as number, point.latitude as number] as [number, number],
                    );
                const step = Math.max(1, Math.ceil(routeLine.length / 200));
                const planLine = routeLine.filter((_, index) => index % step === 0 || index === routeLine.length - 1);

                destination = {
                    name: destName,
                    lat: planEnd.latitude as number,
                    lon: planEnd.longitude as number,
                };
                passage = {
                    voyage_id: displayedVoyageId,
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

        // ── ACTIVE-VOYAGE PLAN FALLBACK (Shane 2026-08-26) ──────────
        // A passage cast off moments ago has an active voyage and a checked
        // plan but zero uploaded fixes (GPS still acquiring — or the skipper
        // is testing from the saloon). The page used to show NOTHING until
        // the first fix uploaded, which reads as broken: "i pressed show on
        // the public page, but it is not showing". Resolve the planned
        // mirror through every server-side link we hold and draw the plan
        // with zero progress — the track catches up when fixes arrive.
        if (!passage) {
            const { data: activeVoyage } = await supabase
                .from('voyages')
                .select('id, voyage_name, saved_route_id')
                .eq('user_id', ownerId)
                .eq('status', 'active')
                .maybeSingle();
            if (activeVoyage) {
                let fallbackPlanId: string | null = null;
                const { data: activeLink } = await supabase
                    .from('voyage_plan_links')
                    .select('plan_voyage_id')
                    .eq('user_id', ownerId)
                    .eq('voyage_id', activeVoyage.id as string)
                    .maybeSingle();
                if (typeof activeLink?.plan_voyage_id === 'string') fallbackPlanId = activeLink.plan_voyage_id;
                if (!fallbackPlanId && typeof activeVoyage.saved_route_id === 'string') {
                    const { data: routeRow } = await supabase
                        .from('saved_routes')
                        .select('planned_route_id')
                        .eq('id', activeVoyage.saved_route_id)
                        .maybeSingle();
                    if (typeof routeRow?.planned_route_id === 'string') fallbackPlanId = routeRow.planned_route_id;
                }
                if (!fallbackPlanId) {
                    const { data: backLink } = await supabase
                        .from('saved_routes')
                        .select('planned_route_id')
                        .eq('passage_voyage_id', activeVoyage.id as string)
                        .maybeSingle();
                    if (typeof backLink?.planned_route_id === 'string') fallbackPlanId = backLink.planned_route_id;
                }
                if (fallbackPlanId) {
                    let planQuery = supabase
                        .from('ship_logs')
                        .select('latitude, longitude, cumulative_distance_nm, notes, timestamp')
                        .eq('user_id', ownerId)
                        .eq('voyage_id', fallbackPlanId)
                        .eq('source', 'planned_route')
                        .or('archived.is.null,archived.eq.false');
                    if (boatId) planQuery = planQuery.eq('boat_id', boatId);
                    const { data: planRows } = await planQuery.order('timestamp', { ascending: true }).limit(1000);
                    const plan = (planRows ?? []) as Record<string, unknown>[];
                    const planPoints = plan.filter(
                        (point) =>
                            typeof point.latitude === 'number' &&
                            typeof point.longitude === 'number' &&
                            Number.isFinite(point.latitude) &&
                            Number.isFinite(point.longitude),
                    );
                    if (planPoints.length >= 2) {
                        const plannedNM = Math.max(
                            0,
                            ...plan.map((point) =>
                                typeof point.cumulative_distance_nm === 'number' ? point.cumulative_distance_nm : 0
                            ),
                        );
                        const planEnd = planPoints[planPoints.length - 1];
                        const routeGeometry = recoverPublicRouteGeometry(String(plan[0]?.notes ?? ''));
                        const routeLine: Array<[number, number]> = routeGeometry ??
                            planPoints.map(
                                (point) => [point.longitude as number, point.latitude as number] as [number, number],
                            );
                        const step = Math.max(1, Math.ceil(routeLine.length / 200));
                        const passageName = (activeVoyage.voyage_name as string | null) ?? null;
                        destination = destination ?? {
                            name: passageName?.split(/[→-]/).pop()?.trim() ?? null,
                            lat: planEnd.latitude as number,
                            lon: planEnd.longitude as number,
                        };
                        passage = {
                            voyage_id: activeVoyage.id,
                            plan_id: fallbackPlanId,
                            name: passageName,
                            planned_nm: Math.round(plannedNM * 10) / 10,
                            done_nm: 0,
                            pct: 0,
                            avg_sog_kts: 0,
                            eta: null,
                            plan_line: routeLine.filter(
                                (_, index) => index % step === 0 || index === routeLine.length - 1,
                            ),
                        };
                    }
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
        // A historical selection must never fall through to the boat's
        // present position. The fallback belongs solely to the legacy page
        // with no explicit trip view.
        let last = selectedFullTrack[selectedFullTrack.length - 1] ?? null;
        let lastIsStale = false;
        if (!last && tripSelection.mode === 'legacy' && trackVisibilityReadable) {
            let fallbackQuery = supabase
                .from('ship_logs')
                // Untyped column bag again — the candidate below is vetted field
                // by field before any of it reaches the public payload.
                .select<string, Record<string, unknown>>(
                    'latitude, longitude, timestamp, speed_kts, course_deg, pressure, wind_speed, ' +
                        'wind_direction, air_temp, water_temp, wave_height, voyage_id, is_on_water',
                )
                .eq('user_id', ownerId)
                .or('archived.is.null,archived.eq.false')
                .not('latitude', 'is', null)
                .not('longitude', 'is', null);
            if (boatId) fallbackQuery = fallbackQuery.eq('boat_id', boatId);
            const { data: fallbackRows } = await fallbackQuery
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
                .limit(100);
            const f = ((fallbackRows ?? []) as Record<string, unknown>[]).find((candidate) => {
                const voyageId = typeof candidate.voyage_id === 'string' ? candidate.voyage_id.trim() : '';
                // Never let a location fallback defeat an explicit hidden-trip
                // choice. A known land fix is also not a public boat position.
                return (
                    !hiddenVoyageIds.has(voyageId) &&
                    !landVoyageIds.has(voyageId) &&
                    !voyageId.startsWith('planned_') &&
                    candidate.is_on_water !== false
                );
            });
            const fLat = f?.latitude as number | undefined;
            const fLon = f?.longitude as number | undefined;
            // Same plausibility rules the track filter applies — a null-island
            // row would otherwise park the public page in the Gulf of Guinea.
            const plausible = typeof fLat === 'number' &&
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

        // ── Live telemetry ─────────────────────────────────────────
        // A selected historic track can use its final point for map framing,
        // but it must not masquerade as the vessel's current instruments to
        // other consumers of this public API.
        const telemetryBelongsToView = tripSelection.mode === 'legacy' ||
            (selectedTrackId !== null && selectedTrackId === currentVoyageId);
        const telemetry = telemetryBelongsToView && last
            ? {
                sog: last.speed_kts,
                cog: last.course_deg,
                heading: last.heading_deg,
                baro: last.pressure,
                baro_trend: baroTrend(selectedFullTrack),
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
                trips,
                selected_trip: tripSelection.mode === 'legacy' ? null : (tripSelection.trip?.id ?? null),
                entries,
                track,
                track_meta: {
                    total_points: selectedFullTrack.length,
                    returned_points: track.length,
                    decimated: track.length < selectedFullTrack.length,
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
