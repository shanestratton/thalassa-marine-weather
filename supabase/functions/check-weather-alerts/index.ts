/**
 * check-weather-alerts — Server-Side Weather Alert Cron, looking ahead (129-07)
 *
 * Runs every 30 minutes via pg_cron → pg_net HTTP POST (invoke_edge_function,
 * 20261010151900). For each account with ≥1 alert threshold enabled, or
 * "Good window opens" on:
 *   1. Read every page of user_settings (only the six settings the check
 *      uses, by JSON path), and the position: the place the weather is set to
 *      (defaultLocationCoords), else Guardian's last known. An account
 *      mid-deletion is skipped.
 *   2. Fetch Open-Meteo on the commercial customer endpoints (the
 *      OPEN_METEO_API_KEY secret, no free-host fallback), many places to a
 *      request, every request with its models pinned (&models=):
 *        ahead  wind and gusts, hourly, ECMWF + ICON + UKMO;
 *        sea    wave height and period, hourly, ECMWF WAM + MFWAM;
 *        now    visibility, UV, temperature and weather, the hour under way,
 *               hourly per model (a two-model `current` block is the first
 *               model's only), ECMWF + GFS.
 *      There is no silent cap: over the run's ceiling the places rotate run
 *      by run, so each is read within a few runs; the count is logged and
 *      reported, and a skipper whose place waits is told in the status.
 *   3. Decide with _shared/forecast-alerts/lookahead.ts: two of three models
 *      inside the same 3 h, within the skipper's look-ahead (24 h by
 *      default); one named wave model, at its own cell; no UKMO value ever
 *      quoted; an alert an official warning in force there already covers
 *      is dropped (official_alerts_watch_match, 129-06), if this skipper was
 *      sent that warning (official_alert_deliveries); held 22:00-07:00 on the
 *      boat's clock (tz-lookup) unless it starts within 3 h; copy in the
 *      skipper's units and the boat's time, always "Forecast:", never
 *      official.
 *   4. Claim each push once in weather_alerts_log (one per kind, strength and
 *      alert day of the event at the boat, the day turning at 07:00), queue
 *      it in push_notification_queue (→ send-push), and claim the weaker
 *      strengths of that day with it.
 *   5. Write each account's status lines where they changed, and the run's
 *      version and counts (weather_alert_status, weather_alert_runs: held
 *      migration 20261014190000). The app shows the look-ahead choice only
 *      once that answers. Without the tables the run still pushes.
 * A position goes to Open-Meteo and the official match and nowhere else: it
 * is never pushed, stored or logged. Logs carry counts only.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import tzLookup from 'npm:tz-lookup@6.1.25';
import {
    fetchWithTimeout,
    isJsonContentType,
    jsonResponse,
    readResponseTextLimited,
    requireServiceRolePost,
} from '../_shared/http-security.ts';
import { boatZone } from '../_shared/cyclone/watch.ts';
import { matchBoats, readAllRows } from '../_shared/official-alerts/watchReads.ts';
import type { OfficialForCover } from '../_shared/forecast-alerts/cover.ts';
import { FORECAST_ALERTS_VERSION, lookaheadHours } from '../_shared/forecast-alerts/contract.ts';
import {
    type AheadAccount,
    type AheadDecision,
    batchPoints,
    decideForAccount,
    deliveredOfficial,
    estimateCallVolume,
    kindModels,
    kindVariables,
    overCapacityLine,
    parseReplies,
    placesThisRun,
    readHourly,
    readNow,
    type RequestKind,
    requestParams,
    RUN_MINUTES,
    waveChain,
} from '../_shared/forecast-alerts/lookahead.ts';

// Commercial customer endpoints only: the free tier is not licensed for App
// Store apps, so it is never a fallback (127-H). The key rides in the query
// string, so a URL is never logged.
const UPSTREAM: Record<RequestKind, string> = {
    ahead: 'https://customer-api.open-meteo.com/v1/forecast',
    sea: 'https://customer-marine-api.open-meteo.com/v1/marine',
    now: 'https://customer-api.open-meteo.com/v1/forecast',
};
/** One batch's reply: 50 places of six 72-hour series is ~150 KB; bounded well above it. */
const MAX_BATCH_RESPONSE_BYTES = 2_000_000;
/**
 * The run's ceiling on distinct places, against a runaway on the paid key and
 * the cron's 150 s: 40 batches a kind at 4 lanes. Never silent: over it the
 * places rotate (placesThisRun), each read at least every ceil(n / 2000)
 * runs; the count waiting is logged and reported (`skipped`), and their
 * skippers' status says so. Well past it, shard the run.
 */
const MAX_PLACES_PER_RUN = 2_000;
const FETCH_LANES = 4;
const FETCH_TIMEOUT_MS = 20_000;
const STATUS_LINES_MAX = 12;
const STATUS_BYTES_MAX = 4_000;

type JsonRecord = Record<string, unknown>;

// ── Round coordinates to 0.1° for dedup (nearby users share weather) ──
function roundCoord(v: number): number {
    return Math.round(v * 10) / 10;
}

interface AlertPreference {
    enabled: boolean;
    threshold?: number;
}

interface AlertLocation {
    lat: number;
    lon: number;
    name: string;
}

/**
 * Only the settings the check reads, by JSON path (PostgREST's
 * `alias:column->key`, as settingsStore reads settings->skipperDevice): not
 * every account's whole settings blob into the function's memory.
 */
const SETTINGS_COLUMNS =
    'user_id, notifications:settings->notifications, units:settings->units, coords:settings->defaultLocationCoords, place:settings->defaultLocation, hours:settings->alertLookaheadHours, good_window:settings->goodWindowAlerts';

interface UserSettingsRow {
    user_id: string;
    notifications: unknown;
    units: unknown;
    coords: unknown;
    place: unknown;
    hours: unknown;
    good_window: unknown;
}

/** The row in the settings shape the rest of the check reads. */
function settingsOf(row: UserSettingsRow): JsonRecord {
    return {
        notifications: row.notifications,
        units: row.units,
        defaultLocationCoords: row.coords,
        defaultLocation: row.place,
        alertLookaheadHours: row.hours,
        goodWindowAlerts: row.good_window,
    };
}

/**
 * Partial schema declaration covering only what the Guardian fallback lookup
 * selects. Without it the client is schema-less and PostgREST rows resolve to
 * `never`, so the column names below would go unchecked. The shape mirrors the
 * guardian_profiles migration: user_id is the NOT NULL primary key, while the
 * last-known position columns are nullable until the app posts a GPS heartbeat.
 */
interface GuardianSchema {
    public: {
        Tables: {
            guardian_profiles: {
                Row: {
                    user_id: string;
                    last_known_lat: number | null;
                    last_known_lon: number | null;
                };
                Insert: { user_id: string };
                Update: { user_id?: string };
                Relationships: [];
            };
        };
        Views: Record<string, never>;
        Functions: Record<string, never>;
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
}

function asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function finiteCoordinate(value: unknown, axis: 'lat' | 'lon'): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const bound = axis === 'lat' ? 90 : 180;
    return Math.abs(value) <= bound ? value : null;
}

/**
 * Alert configuration is user preference data, so malformed or stale JSON must
 * be ignored rather than taking the cron down. Only enabled alerts with finite
 * numeric thresholds are retained; precipitation is threshold-free.
 */
function parseAlertPreferences(value: unknown): Record<string, AlertPreference> | null {
    const notifications = asRecord(value);
    if (!notifications) return null;

    const parsed: Record<string, AlertPreference> = {};
    for (const [key, rawPreference] of Object.entries(notifications)) {
        const preference = asRecord(rawPreference);
        if (!preference || preference.enabled !== true) continue;
        const threshold = preference.threshold;
        parsed[key] = {
            enabled: true,
            ...(typeof threshold === 'number' && Number.isFinite(threshold) ? { threshold } : {}),
        };
    }

    return Object.keys(parsed).length > 0 ? parsed : null;
}

/** A stored threshold, armed or not: "Good window opens" scores against the High wind and High seas limits. */
function storedThreshold(notifications: unknown, key: string): number | null {
    const value = asRecord(asRecord(notifications)?.[key])?.threshold;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `defaultLocationCoords` is the current app setting. The object-shaped
 * `defaultLocation` fallback keeps already-synchronised legacy settings
 * working while clients update to the dedicated user_settings table.
 */
function configuredLocation(settings: JsonRecord): AlertLocation | null {
    const currentCoords = asRecord(settings.defaultLocationCoords);
    const legacyLocation = asRecord(settings.defaultLocation);
    const coords = currentCoords ?? legacyLocation;
    if (!coords) return null;

    const lat = finiteCoordinate(coords.lat, 'lat');
    const lon = finiteCoordinate(coords.lon, 'lon');
    if (lat === null || lon === null) return null;

    const currentName = typeof settings.defaultLocation === 'string' ? settings.defaultLocation.trim() : '';
    const legacyName = typeof legacyLocation?.name === 'string' ? legacyLocation.name.trim() : '';
    return { lat, lon, name: currentName || legacyName || 'Your location' };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
    return chunks;
}

/**
 * Fetch the Guardian fallback positions in bounded batches. This replaces the
 * previous N+1 `.single()` lookup and deliberately treats Guardian as a
 * fallback: a transient Guardian failure must not suppress users who supplied
 * a saved default location in user_settings.
 */
async function guardianLocationsForUsers(
    supabase: SupabaseClient<GuardianSchema>,
    userIds: readonly string[],
): Promise<Map<string, AlertLocation>> {
    const locations = new Map<string, AlertLocation>();
    for (const ids of chunk([...new Set(userIds)], 200)) {
        if (ids.length === 0) continue;
        const { data, error } = await supabase
            .from('guardian_profiles')
            .select('user_id, last_known_lat, last_known_lon')
            .in('user_id', ids);
        if (error) {
            console.warn('Guardian fallback lookup failed:', error.message);
            continue;
        }

        for (const row of data ?? []) {
            const lat = finiteCoordinate(row.last_known_lat, 'lat');
            const lon = finiteCoordinate(row.last_known_lon, 'lon');
            if (lat === null || lon === null || typeof row.user_id !== 'string') continue;
            locations.set(row.user_id, { lat, lon, name: 'Your location' });
        }
    }
    return locations;
}

/** Run `work` over `items`, `lanes` at a time. */
async function eachInLanes<T>(items: readonly T[], lanes: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(lanes, items.length) }, async () => {
            while (next < items.length) await work(items[next++]);
        }),
    );
}

interface Place {
    key: string;
    lat: number;
    lon: number;
    needs: Set<RequestKind>;
}

/** One batch of places, one request: each place's reply, or null when the batch got no usable answer. */
async function fetchBatch(
    kind: RequestKind,
    batch: readonly Place[],
    apiKey: string,
): Promise<(JsonRecord | null)[] | null> {
    try {
        const query = new URLSearchParams({ ...requestParams(kind, batch), apikey: apiKey });
        const res = await fetchWithTimeout(`${UPSTREAM[kind]}?${query}`, {}, FETCH_TIMEOUT_MS);
        if (!res.ok || !isJsonContentType(res.headers.get('content-type'))) {
            console.warn(`Open-Meteo ${kind} batch error: ${res.status}`);
            await res.body?.cancel().catch(() => undefined);
            return null;
        }
        const text = await readResponseTextLimited(res, MAX_BATCH_RESPONSE_BYTES);
        if (!text) return null;
        return parseReplies(JSON.parse(text), batch.length);
    } catch {
        console.error(`Open-Meteo ${kind} batch failed`);
        return null;
    }
}

interface Checked {
    account: AheadAccount;
    place: Place;
    basis: 'saved' | 'last-known';
}

serve(async (req: Request) => {
    const startTime = Date.now();
    const authorizationFailure = requireServiceRolePost(req, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (authorizationFailure) return authorizationFailure;

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ error: 'Server database is not configured' }, 500);
        }
        const openMeteoKey = Deno.env.get('OPEN_METEO_API_KEY');
        if (!openMeteoKey) {
            // Once per run, and without the URL. No free-host fallback.
            console.error(
                '[check-weather-alerts] OPEN_METEO_API_KEY is not set: no weather fetched, no alerts this run',
            );
            return jsonResponse({ checked: 0, error: 'Weather service unavailable' }, 503);
        }
        const weatherKey: string = openMeteoKey;
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const db = supabase;
        const nowMs = Date.now();

        // ── 1. Every account with at least one alert enabled ──
        // Settings used to live in an undeployed `profiles` table. The
        // user_settings contract is now the cloud authority, so this cron must
        // fail closed (no alert) for rows without a valid opt-in rather than
        // failing the entire scheduled run because a retired table is absent.
        // Every page: PostgREST answers 1000 rows a request and cuts the rest
        // off without an error.
        let settingsRows: UserSettingsRow[];
        try {
            settingsRows = await readAllRows<UserSettingsRow>(
                (from, to) =>
                    db
                        .from('user_settings')
                        .select(SETTINGS_COLUMNS)
                        .order('user_id')
                        .range(from, to),
                'settings',
            );
        } catch {
            console.error('Failed to fetch user settings');
            return jsonResponse({ error: 'Settings fetch failed' }, 500);
        }

        if (settingsRows.length === 0) {
            return jsonResponse({ checked: 0, message: 'No user settings', version: FORECAST_ALERTS_VERSION });
        }

        interface AlertUserCandidate {
            userId: string;
            settings: JsonRecord;
            notifications: Record<string, AlertPreference>;
            location: AlertLocation | null;
        }

        // Filter to users with ≥1 alert enabled, or "Good window opens" on.
        // Resolve Guardian positions in one bounded batch after inspecting the
        // saved location configuration.
        const candidates: AlertUserCandidate[] = [];
        for (const row of settingsRows) {
            if (!row || typeof row.user_id !== 'string') continue;
            const settings = settingsOf(row);
            const notifications = parseAlertPreferences(settings.notifications) ?? {};
            if (Object.keys(notifications).length === 0 && settings.goodWindowAlerts !== true) continue;
            candidates.push({
                userId: row.user_id,
                settings,
                notifications,
                location: configuredLocation(settings),
            });
        }

        // An account mid-deletion is write-fenced: never queue or record for it.
        const deleting = new Set<string>();
        for (const ids of chunk(candidates.map((c) => c.userId), 200)) {
            const { data, error } = await db.from('account_deletion_jobs').select('user_id').in('user_id', ids);
            if (error) {
                console.warn('Account deletion lookup failed');
                continue;
            }
            for (const r of data ?? []) if (typeof r.user_id === 'string') deleting.add(r.user_id);
        }

        const guardianLocations = await guardianLocationsForUsers(
            supabase,
            candidates.filter((candidate) => !candidate.location).map((candidate) => candidate.userId),
        );

        // ── 2. The places, each with what its accounts need fetched ──
        const wanted: { checked: Checked; needs: Set<RequestKind> }[] = [];
        for (const candidate of candidates) {
            if (deleting.has(candidate.userId)) continue;
            const saved = candidate.location;
            const location = saved ?? guardianLocations.get(candidate.userId);
            if (!location) continue; // Can't alert without a configured or Guardian location.
            const n = candidate.notifications;
            const settings = candidate.settings;
            const goodWindow = settings.goodWindowAlerts === true;
            const needs = new Set<RequestKind>();
            if (n.wind || n.gusts || goodWindow) needs.add('ahead');
            if (n.waves || n.swellPeriod || goodWindow) needs.add('sea');
            if (n.visibility || n.uv || n.tempHigh || n.tempLow || n.precipitation) needs.add('now');
            if (needs.size === 0) continue;
            const key = `${roundCoord(location.lat)},${roundCoord(location.lon)}`;
            const place: Place = {
                key,
                lat: roundCoord(location.lat),
                lon: roundCoord(location.lon),
                needs: new Set(),
            };
            wanted.push({
                needs,
                checked: {
                    place,
                    basis: saved ? 'saved' : 'last-known',
                    account: {
                        userId: candidate.userId,
                        place: location.name,
                        zone: boatZone({ lat: location.lat, lon: location.lon }, tzLookup),
                        units: asRecord(settings.units) ?? {},
                        hours: lookaheadHours(settings.alertLookaheadHours),
                        notifications: n,
                        goodWindow,
                        limits: {
                            windKts: storedThreshold(settings.notifications, 'wind'),
                            waveFt: storedThreshold(settings.notifications, 'waves'),
                        },
                    },
                },
            });
        }

        // Over the ceiling, a window of the places moves on each run, so no
        // skipper waits run after run; one who waits this run is told.
        const allPlaces = new Set(wanted.map((w) => w.checked.place.key)).size;
        const runIndex = Math.floor(nowMs / (RUN_MINUTES * 60_000));
        const thisRun = placesThisRun(
            wanted.map((w) => w.checked.place.key),
            MAX_PLACES_PER_RUN,
            runIndex,
        );
        const places = new Map<string, Place>();
        const checked: Checked[] = [];
        const statusRows = new Map<string, { basis: 'saved' | 'last-known'; lines: string[] }>();
        for (const w of wanted) {
            const c = w.checked;
            if (!thisRun.has(c.place.key)) {
                statusRows.set(c.account.userId, {
                    basis: c.basis,
                    lines: [overCapacityLine(allPlaces, MAX_PLACES_PER_RUN)],
                });
                continue;
            }
            const place = places.get(c.place.key) ?? c.place;
            places.set(place.key, place);
            for (const kind of w.needs) place.needs.add(kind);
            checked.push({ ...c, place });
        }
        const skipped = allPlaces - thisRun.size;
        if (skipped > 0) {
            console.warn(
                `[check-weather-alerts] ${skipped} places over the run's ceiling of ${MAX_PLACES_PER_RUN}: they wait for a later run (every place within ${
                    Math.ceil(allPlaces / MAX_PLACES_PER_RUN)
                } runs)`,
            );
        }

        if (checked.length === 0) {
            return jsonResponse({
                checked: 0,
                message: 'No users with alerts + location',
                version: FORECAST_ALERTS_VERSION,
                skipped,
            });
        }

        // ── 3. Fetch, many places a request, models pinned ──
        const replies: Record<RequestKind, Map<string, JsonRecord | null>> = {
            ahead: new Map(),
            sea: new Map(),
            now: new Map(),
        };
        const perKind: Record<RequestKind, number> = { ahead: 0, sea: 0, now: 0 };
        const jobs: { kind: RequestKind; batch: Place[] }[] = [];
        for (const kind of ['ahead', 'sea', 'now'] as const) {
            const list = [...places.values()].filter((p) => p.needs.has(kind));
            perKind[kind] = list.length;
            for (const batch of batchPoints(list)) jobs.push({ kind, batch });
        }
        await eachInLanes(jobs, FETCH_LANES, async ({ kind, batch }) => {
            const got = await fetchBatch(kind, batch, weatherKey);
            if (got) batch.forEach((p, i) => replies[kind].set(p.key, got[i]));
        });
        const volume = estimateCallVolume(perKind);

        const hourlyAt = new Map<string, ReturnType<typeof readHourly>>();
        const seaAt = new Map<string, ReturnType<typeof readHourly>>();
        const nowAt = new Map<string, ReturnType<typeof readNow>>();
        for (const place of places.values()) {
            hourlyAt.set(
                place.key,
                readHourly(replies.ahead.get(place.key) ?? null, kindVariables('ahead'), kindModels('ahead')),
            );
            seaAt.set(
                place.key,
                readHourly(replies.sea.get(place.key) ?? null, kindVariables('sea'), kindModels('sea')),
            );
            nowAt.set(
                place.key,
                readNow(replies.now.get(place.key) ?? null, kindVariables('now'), kindModels('now'), nowMs),
            );
        }

        const decide = (
            c: Checked,
            official: readonly OfficialForCover[],
            officialAtPlace: readonly OfficialForCover[],
        ): AheadDecision =>
            decideForAccount(
                c.account,
                {
                    ahead: hourlyAt.get(c.place.key) ?? null,
                    // At the point asked: a wave cell Open-Meteo reached far from it is not the sea here.
                    sea: waveChain(seaAt.get(c.place.key) ?? null, nowMs, c.account.hours, {
                        lat: c.place.lat,
                        lon: c.place.lon,
                    }),
                    seaAnswered: replies.sea.has(c.place.key) && seaAt.get(c.place.key) !== null,
                    now: nowAt.get(c.place.key) ?? null,
                    official,
                    officialAtPlace,
                },
                nowMs,
            );

        // ── 4. The official warnings in force where an alert is in play ──
        // Decided once without them; only the places with something to send
        // (or hold) are matched. Without 129-06's migration the match is
        // absent, and the alert is sent: nothing is suppressed on a guess.
        // A warning covers an account's alert only if official-alerts-watch
        // sent it to that account (official_alert_deliveries): one muted
        // (official warnings or small craft advisories off), told at the
        // boat's fix elsewhere, or still held overnight covers nothing.
        const first = checked.map((c) => decide(c, [], []));
        const inPlay = [
            ...new Set(checked.filter((_, i) => first[i].pushes.length + first[i].held.length > 0).map((c) => c.place)),
        ];
        const officialAt = new Map<string, OfficialForCover[]>();
        const deliveredTo = new Map<string, Set<number>>();
        if (inPlay.length > 0) {
            try {
                const matched = await matchBoats(
                    inPlay.map((p) => ({ userId: p.key, position: { lat: p.lat, lon: p.lon } })),
                    (points) => db.rpc('official_alerts_watch_match', { p_points: points }),
                );
                const ids = [...new Set([...matched.values()].flatMap((s) => [...s]))];
                const infos = new Map<number, OfficialForCover>();
                for (const part of chunk(ids, 200)) {
                    const { data, error } = await db.from('official_alerts').select('id, provider_id, infos').in(
                        'id',
                        part,
                    );
                    if (error) throw new Error('official read failed');
                    for (const r of data ?? []) {
                        if (typeof r.id === 'number' && typeof r.provider_id === 'string' && Array.isArray(r.infos)) {
                            infos.set(r.id, { id: r.id, provider: r.provider_id, infos: r.infos });
                        }
                    }
                }
                for (const [key, set] of matched) {
                    officialAt.set(key, [...set].map((id) => infos.get(id)).filter((o): o is OfficialForCover => !!o));
                }
                // Which of those warnings each account there was sent.
                const users = [
                    ...new Set(checked.filter((c) => officialAt.has(c.place.key)).map((c) => c.account.userId)),
                ];
                const alertIds = [...infos.keys()];
                for (const userPart of chunk(users, 100)) {
                    for (const idPart of chunk(alertIds, 200)) {
                        const rows = await readAllRows<{ user_id: unknown; alert_id: unknown }>(
                            (from, to) =>
                                db
                                    .from('official_alert_deliveries')
                                    .select('user_id, alert_id')
                                    .eq('channel', 'push')
                                    .in('user_id', userPart)
                                    .in('alert_id', idPart)
                                    .order('user_id')
                                    .order('alert_id')
                                    .range(from, to),
                            'delivery',
                        );
                        for (const r of rows) {
                            if (typeof r.user_id !== 'string' || typeof r.alert_id !== 'number') continue;
                            const told = deliveredTo.get(r.user_id) ?? new Set<number>();
                            told.add(r.alert_id);
                            deliveredTo.set(r.user_id, told);
                        }
                    }
                }
            } catch {
                officialAt.clear();
                deliveredTo.clear();
                console.warn('[check-weather-alerts] official warnings unavailable this run: nothing is suppressed');
            }
        }

        // ── 5. Claim, queue, and keep each account's status ──
        let alertsQueued = 0;
        let held = 0;
        let covered = 0;
        for (const [i, c] of checked.entries()) {
            const atPlace = officialAt.get(c.place.key) ?? [];
            const decision = atPlace.length > 0
                ? decide(c, deliveredOfficial(atPlace, deliveredTo.get(c.account.userId)), atPlace)
                : first[i];
            held += decision.held.length;
            covered += decision.covered.length;
            const lines = decision.lines.slice(0, STATUS_LINES_MAX);
            while (lines.length > 0 && new TextEncoder().encode(JSON.stringify(lines)).length > STATUS_BYTES_MAX) {
                lines.pop();
            }
            statusRows.set(c.account.userId, { basis: c.basis, lines });

            for (const push of decision.pushes) {
                // `weather_alerts_log` has a `(user_id, alert_key)` unique
                // constraint. Claim it before enqueueing the push so two
                // overlapping cron invocations cannot both notify the same
                // skipper after each observed an empty pre-check.
                const { data: claimedAlert, error: claimError } = await db
                    .from('weather_alerts_log')
                    .upsert(
                        { user_id: c.account.userId, alert_type: push.kind, alert_key: push.alertKey },
                        { onConflict: 'user_id,alert_key', ignoreDuplicates: true },
                    )
                    .select('id')
                    .maybeSingle();
                if (claimError) {
                    console.error(`Weather alert dedup claim failed for ${c.account.userId.slice(0, 8)}…`);
                    continue;
                }
                if (!claimedAlert) continue; // Already sent for this day, or an overlapping run owns it.

                const { error: insertError } = await db.from('push_notification_queue').insert({
                    recipient_user_id: c.account.userId,
                    notification_type: push.type,
                    title: push.title,
                    body: push.body,
                    data: push.data,
                });
                if (insertError) {
                    console.error(`Push queue insert failed for ${c.account.userId.slice(0, 8)}…`);
                    continue;
                }
                alertsQueued++;
                // The weaker strengths of the same day, so the forecast easing later today stays quiet.
                if (push.alsoClaims.length > 0) {
                    const { error: lowerError } = await db.from('weather_alerts_log').upsert(
                        push.alsoClaims.map((key) => ({
                            user_id: c.account.userId,
                            alert_type: push.kind,
                            alert_key: key,
                        })),
                        { onConflict: 'user_id,alert_key', ignoreDuplicates: true },
                    );
                    if (lowerError) console.warn('Weather alert weaker-strength claims failed');
                }
            }
        }

        // ── 6. The status the app reads (held migration 20261014190000) ──
        // Only the lines that changed are written, and an account the check no
        // longer reads loses its row, so a quiet account costs no write a run.
        try {
            const prior = await readAllRows<{ user_id: string; basis: unknown; lines: unknown }>(
                (from, to) =>
                    db
                        .from('weather_alert_status')
                        .select('user_id, basis, lines')
                        .order('user_id')
                        .range(from, to),
                'status',
            );
            const before = new Map(prior.map((r) => [r.user_id, JSON.stringify([r.basis, r.lines])]));
            const changed = [...statusRows]
                .filter(([userId, s]) => before.get(userId) !== JSON.stringify([s.basis, s.lines]))
                .map(([userId, s]) => ({
                    user_id: userId,
                    basis: s.basis,
                    lines: s.lines,
                    changed_at: new Date(nowMs).toISOString(),
                }));
            for (const part of chunk(changed, 500)) {
                const { error } = await db.from('weather_alert_status').upsert(part, { onConflict: 'user_id' });
                if (error) throw new Error('status write failed');
            }
            const gone = prior.map((r) => r.user_id).filter((userId) => !statusRows.has(userId));
            for (const part of chunk(gone, 200)) {
                const { error } = await db.from('weather_alert_status').delete().in('user_id', part);
                if (error) throw new Error('status delete failed');
            }
            const { error: runError } = await db.from('weather_alert_runs').upsert({
                id: 1,
                ran_at: new Date(nowMs).toISOString(),
                version: FORECAST_ALERTS_VERSION,
                accounts: checked.length,
                places: places.size,
                requests: volume.requestsPerRun,
                calls: volume.callsPerRun,
                pushes: alertsQueued,
                held,
                covered,
                skipped,
            });
            if (runError) throw new Error('run write failed');
        } catch {
            console.warn(
                '[check-weather-alerts] weather_alert_status is not there yet (held migration 20261014190000), or its write failed: no status this run',
            );
        }

        const elapsed = Date.now() - startTime;
        console.log(
            `Weather check complete: ${checked.length} accounts, ${places.size} places, ${volume.requestsPerRun} requests, ${alertsQueued} alerts (${held} held, ${covered} covered) in ${elapsed}ms`,
        );

        return jsonResponse({
            version: FORECAST_ALERTS_VERSION,
            checked: checked.length,
            locations: places.size,
            requests: volume.requestsPerRun,
            calls: volume.callsPerRun,
            calls_per_30_days: volume.callsPer30Days,
            alerts: alertsQueued,
            held,
            covered,
            skipped,
            elapsed_ms: elapsed,
        });
    } catch {
        console.error('check-weather-alerts failed');
        return jsonResponse({ error: 'Weather alert check failed' }, 500);
    }
});
