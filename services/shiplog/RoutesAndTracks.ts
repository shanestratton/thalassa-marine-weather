/**
 * RoutesAndTracks — fetcher that turns the user's flat ship-log
 * entries into two distinct lists for the chart layers:
 *
 *   ROUTES  — passage plans saved via savePassagePlanToLogbook().
 *             Their voyageId starts with `planned_`. These are the
 *             "suggested routes" the user generated in the route
 *             planner and saved to the ships log without sailing
 *             them yet.
 *
 *   TRACKS  — actually-sailed passages. Every other voyageId
 *             groups normal log entries (timestamps, GPS positions,
 *             SOG, etc) — the trail of where the boat really went.
 *
 * Each item in the returned lists carries a polyline (lat/lon
 * sequence sorted in passage order) and bounding box so the chart
 * layer can immediately fitBounds without re-walking the points.
 *
 * Cached for 60s to avoid hammering Supabase when both pickers open
 * back-to-back. Refresh forces a re-fetch.
 */
import { getLogEntries } from './EntryCrud';
import { getOfflineEntries } from './OfflineQueue';
import { isTrackworthyEntry } from './helpers';
import { ROUTE_GEOMETRY_NOTES_PREFIX } from './PassagePlanSave';
import { getVoyageSummaries, getVoyageEntries, isLandVoyage, type VoyageSummary } from './VoyageSummary';
import type { ShipLogEntry } from '../../types/navigation';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';

export interface RouteOrTrack {
    /** Stable id matching the underlying voyageId. */
    id: string;
    /** Human label shown in the picker. */
    label: string;
    /** Subtitle shown in the picker — passage stats / date. */
    sublabel: string;
    /** Lat/lon points in passage order. */
    points: Array<{ lat: number; lon: number }>;
    /** Bounding box [west, south, east, north] for fitBounds. */
    bbox: [number, number, number, number];
    /** Earliest timestamp in the group — used to sort the picker by recency. */
    timestamp: number;
    /** Total distance in NM (sum of distanceNM across entries when present). */
    distanceNm: number;
    /**
     * For planned routes: duration in hours derived from the spread of
     * entry timestamps (last.timestamp − first.timestamp). PassagePlanSave
     * spreads entries linearly across plan.durationApprox at save time, so
     * this round-trips back to the original Gemini estimate. Used by
     * CrewManagement to auto-compute ETA when the user picks a departure
     * date — saves the user from manually typing the same number.
     * Undefined for tracks (where the spread is real elapsed time).
     */
    durationHours?: number;
    /**
     * True if this route/track exists only in the local offline queue
     * (Capacitor Preferences) and has not yet been synced to Supabase.
     * The picker renders a small "LOCAL" pill next to these so the
     * user knows the plan is single-device. After the user signs in
     * (or comes back online) and `syncOfflineQueue()` runs, the next
     * fetch sees the entries in the cloud and flips this to false.
     */
    isLocal: boolean;
    /**
     * Sea/land verdict for the group (Shane 2026-07-15: the tracer's
     * "From a past voyage" picker filled its six slots with car drives
     * and his real passage fell off the list). Majority vote on the
     * entries' capture-time `isOnWater` checks — the same signal the
     * career roll-up's landFraction uses — with a median-speed fallback
     * for entries that predate water capture. 'unknown' = no signal
     * either way; pickers should HIDE 'land' and keep the rest.
     */
    kind: 'sea' | 'land' | 'unknown';
}

export interface RoutesAndTracksResult {
    routes: RouteOrTrack[];
    tracks: RouteOrTrack[];
}

const CACHE_TTL_MS = 60_000;
type ScopedCache = { scope: AuthIdentityScope; at: number; data: RoutesAndTracksResult };
type ScopedInflight = { scope: AuthIdentityScope; promise: Promise<RoutesAndTracksResult> };
let cache: ScopedCache | null = null;
let inflight: ScopedInflight | null = null;

const EMPTY_RESULT: RoutesAndTracksResult = { routes: [], tracks: [] };

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function cloneRoute(item: RouteOrTrack): RouteOrTrack {
    return {
        ...item,
        points: item.points.map((point) => ({ ...point })),
        bbox: [item.bbox[0], item.bbox[1], item.bbox[2], item.bbox[3]],
    };
}

function cloneResult(result: RoutesAndTracksResult): RoutesAndTracksResult {
    return {
        routes: result.routes.map(cloneRoute),
        tracks: result.tracks.map(cloneRoute),
    };
}

subscribeAuthIdentityScope(() => {
    // Results and promises may contain private route names and geometry.
    // Drop both references synchronously at the account boundary.
    cache = null;
    inflight = null;
});

function isPlanned(voyageId: string | undefined | null): boolean {
    return typeof voyageId === 'string' && voyageId.startsWith('planned_');
}

function bboxOfPoints(pts: Array<{ lat: number; lon: number }>): [number, number, number, number] {
    let west = 180,
        east = -180,
        south = 90,
        north = -90;
    for (const p of pts) {
        if (p.lon < west) west = p.lon;
        if (p.lon > east) east = p.lon;
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
    }
    return [west, south, east, north];
}

/** Pretty-print a date for the picker subtitle. */
function fmtDate(ts: number): string {
    const d = new Date(ts);
    if (!isFinite(d.getTime())) return '—';
    const today = new Date();
    const y = d.getFullYear();
    const m = d.toLocaleString(undefined, { month: 'short' });
    const day = d.getDate();
    return y === today.getFullYear() ? `${day} ${m}` : `${day} ${m} ${y}`;
}

/**
 * Try to recover a saved route's curved geometry from the first entry's
 * notes blob (see PassagePlanSave.ROUTE_GEOMETRY_NOTES_PREFIX). Returns
 * the dense polyline if found and valid, null otherwise. The bend
 * waypoints are still saved as separate entries — those drive the
 * picker icons / counts; this geometry is purely for the rendered
 * polyline so the user sees the bathymetric curve, not straight lines.
 */
function recoverRouteGeometry(firstEntryNotes: string | null | undefined): Array<{ lat: number; lon: number }> | null {
    if (typeof firstEntryNotes !== 'string') return null;
    if (!firstEntryNotes.startsWith(ROUTE_GEOMETRY_NOTES_PREFIX)) return null;
    const after = firstEntryNotes.slice(ROUTE_GEOMETRY_NOTES_PREFIX.length);
    // Format: <JSON coords>\n<human summary>. Split on the first newline.
    const nlIdx = after.indexOf('\n');
    const jsonStr = nlIdx === -1 ? after : after.slice(0, nlIdx);
    try {
        const coords = JSON.parse(jsonStr);
        if (!Array.isArray(coords)) return null;
        const out: Array<{ lat: number; lon: number }> = [];
        for (const c of coords) {
            if (!Array.isArray(c) || c.length < 2) continue;
            const [lon, lat] = c;
            if (typeof lon !== 'number' || typeof lat !== 'number') continue;
            out.push({ lat, lon });
        }
        return out.length >= 2 ? out : null;
    } catch {
        return null;
    }
}

/** Equirectangular distance in NM — picker-scale accuracy is plenty. */
function distNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const kx = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 60;
    const dx = (b.lon - a.lon) * kx;
    const dy = (b.lat - a.lat) * 60;
    return Math.hypot(dx, dy);
}

/** Above this median speed a track reads as a road vehicle, not the
 *  boat — a displacement cruiser medians 4–8 kn; any real drive spends
 *  most of its time well past 12. Fallback signal only (no isOnWater). */
const LAND_MEDIAN_KN = 12;

/**
 * Sea/land/unknown verdict for one voyage's trackworthy entries.
 * Primary: majority vote on capture-time `isOnWater` (a real water
 * check per entry — the landFraction pattern VoyageSummary already
 * trusts for the career roll-up). Fallback for groups with no water
 * data (old rows, GPX imports): median speed — recorded speedKts when
 * present, else derived from consecutive fixes. No signal → 'unknown'
 * (callers keep those; hiding a legit old passage is the worse error).
 * Exported for tests.
 */
export function classifyTrackKind(
    sorted: Array<Pick<ShipLogEntry, 'isOnWater' | 'speedKts' | 'timestamp' | 'latitude' | 'longitude'>>,
): 'sea' | 'land' | 'unknown' {
    let water = 0;
    let land = 0;
    for (const e of sorted) {
        if (e.isOnWater === true) water++;
        else if (e.isOnWater === false) land++;
    }
    if (water + land > 0) return land > water ? 'land' : 'sea';

    // No water data — kinematic fallback. Recorded SOG first…
    let speeds = sorted.map((e) => e.speedKts).filter((v): v is number => typeof v === 'number' && v > 0);
    // …else derive leg speeds from the fixes (Δt window guards against
    // GPS glitches: a 1 s pair amplifies jitter, a 2 h gap means the
    // logger slept and the "leg" is fiction).
    if (speeds.length < 3) {
        speeds = [];
        for (let i = 1; i < sorted.length; i++) {
            const dtH =
                (new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()) / 3_600_000;
            if (dtH < 5 / 3600 || dtH > 2) continue;
            speeds.push(
                distNm(
                    { lat: sorted[i - 1].latitude, lon: sorted[i - 1].longitude },
                    { lat: sorted[i].latitude, lon: sorted[i].longitude },
                ) / dtH,
            );
        }
    }
    if (speeds.length < 3) return 'unknown';
    const median = speeds.sort((a, b) => a - b)[Math.floor(speeds.length / 2)];
    return median > LAND_MEDIAN_KN ? 'land' : 'sea';
}

/**
 * Group entries by voyageId, building a RouteOrTrack per group.
 *
 * @param entries          Merged cloud + offline-queue entries.
 * @param cloudVoyageIds   Set of voyageIds that exist in the cloud.
 *                         Any voyageId NOT in this set is local-only.
 *
 * Exported for tests. Production callers should use
 * `fetchRoutesAndTracks()` so cloud + offline merging is handled
 * consistently.
 */
export function groupByVoyage(entries: ShipLogEntry[], cloudVoyageIds: Set<string>): RouteOrTrack[] {
    const groups = new Map<string, ShipLogEntry[]>();
    for (const e of entries) {
        const id = e.voyageId || 'misc';
        const arr = groups.get(id) ?? [];
        arr.push(e);
        groups.set(id, arr);
    }

    const items: RouteOrTrack[] = [];
    for (const [id, arr] of groups) {
        // Sort entries by timestamp ascending so the polyline reads
        // departure → arrival. Trackworthy-only: turn pins sit at PAST
        // positions (zig-zag vertices), manual entries can carry a
        // stale fix, and (0,0) placeholders draw across the planet.
        const sorted = arr
            .filter(isTrackworthyEntry)
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (sorted.length < 2) continue; // Need at least 2 points to draw a line.

        // For planned routes, prefer the saved bathymetric geometry over
        // the straight-line waypoint polyline — the user wants to see
        // the curved sea path they actually planned, including bends
        // around shoals/headlands.
        const recoveredCurve = isPlanned(id) ? recoverRouteGeometry(sorted[0].notes) : null;
        const points =
            recoveredCurve ??
            sorted.map((e) => ({
                lat: e.latitude as number,
                lon: e.longitude as number,
            }));
        const bbox = bboxOfPoints(points);

        // Heuristic label: first entry's notes / waypoint name often
        // reads as the departure port; last entry's as arrival.
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const departure = (first as unknown as { notes?: string; waypointName?: string }).waypointName ?? 'Departure';
        const arrival = (last as unknown as { notes?: string; waypointName?: string }).waypointName ?? 'Arrival';
        const label = isPlanned(id) ? `${departure} → ${arrival}` : `${fmtDate(new Date(first.timestamp).getTime())}`;

        // MAX cumulative beats summing per-leg distanceNM: legs are
        // stored rounded to 2 dp, and at 5 s cadence most legs round to
        // 0.00 — a long high-frequency track summed to ~0 NM.
        const maxCumulative = sorted.reduce((acc, e) => Math.max(acc, e.cumulativeDistanceNM ?? 0), 0);
        const distanceNm = maxCumulative > 0 ? maxCumulative : sorted.reduce((acc, e) => acc + (e.distanceNM ?? 0), 0);
        const ts = new Date(first.timestamp).getTime();
        // Derive duration from the entry timestamp spread. For planned
        // routes this equals plan.durationApprox (PassagePlanSave spreads
        // entries linearly across that). For tracks it's real elapsed
        // time. We only attach it for planned routes — tracks would
        // confuse the ETA calculator with already-finished durations.
        const lastTs = new Date(last.timestamp).getTime();
        const durationHours = isPlanned(id) && lastTs > ts ? (lastTs - ts) / 3_600_000 : undefined;
        const sublabel = isPlanned(id)
            ? `Planned · ${distanceNm > 0 ? distanceNm.toFixed(0) + ' NM' : `${points.length} points`}`
            : `${fmtDate(ts)} · ${distanceNm > 0 ? distanceNm.toFixed(0) + ' NM' : `${points.length} points`}`;

        const isLocal = !cloudVoyageIds.has(id);
        // Planned routes are sea by construction (PassagePlanSave stamps
        // isOnWater: true); sailed groups earn their verdict.
        const kind = isPlanned(id) ? ('sea' as const) : classifyTrackKind(sorted);
        items.push({ id, label, sublabel, points, bbox, timestamp: ts, distanceNm, durationHours, isLocal, kind });
    }

    // Most recent first.
    items.sort((a, b) => b.timestamp - a.timestamp);
    return items;
}

export async function fetchRoutesAndTracks(force = false): Promise<RoutesAndTracksResult> {
    const scope = getAuthIdentityScope();
    const now = Date.now();
    if (!force && cache && sameScope(cache.scope, scope) && now - cache.at < CACHE_TTL_MS) {
        return cloneResult(cache.data);
    }
    if (inflight && sameScope(inflight.scope, scope)) return inflight.promise.then(cloneResult);

    const request: ScopedInflight = {
        scope,
        promise: Promise.resolve(EMPTY_RESULT),
    };
    request.promise = (async () => {
        try {
            // Pull cloud and offline queue in parallel — cloud covers
            // years of cruising (10k cap), offline queue is whatever
            // hasn't synced yet (un-authed user's plans, or anything
            // saved while the device had no network).
            const [cloudEntries, offlineEntries] = await Promise.all([getLogEntries(10_000), getOfflineEntries()]);
            if (!isAuthIdentityScopeCurrent(scope)) return EMPTY_RESULT;

            // Track which voyageIds exist in the cloud so groupByVoyage
            // can tag local-only entries with `isLocal: true`. Once the
            // offline queue syncs (post-sign-in or back-online),
            // syncOfflineQueue() clears the queue and the same voyageIds
            // start appearing in `cloudEntries` — the flag flips false
            // on the next fetch.
            const cloudVoyageIds = new Set<string>();
            for (const e of cloudEntries) {
                if (e.voyageId) cloudVoyageIds.add(e.voyageId);
            }

            // Merge cloud + offline. groupByVoyage de-dupes by voyageId
            // and sorts internally, so concat order doesn't matter.
            const merged = [...cloudEntries, ...offlineEntries];
            const all = groupByVoyage(merged, cloudVoyageIds);
            const data: RoutesAndTracksResult = {
                routes: all.filter((g) => isPlanned(g.id)),
                tracks: all.filter((g) => !isPlanned(g.id)),
            };
            if (!isAuthIdentityScopeCurrent(scope)) return EMPTY_RESULT;
            cache = { scope, at: Date.now(), data: cloneResult(data) };
            return cloneResult(data);
        } catch {
            return EMPTY_RESULT;
        } finally {
            // A's late finally must not erase B's newer in-flight request.
            if (inflight === request) inflight = null;
        }
    })();
    inflight = request;
    return request.promise.then(cloneResult);
}

/** Drop the cache so the next fetch hits Supabase. Call after a save.
 *  Also broadcasts a `routes-and-tracks-changed` window event so any
 *  surface that displays a count (Nav Station hero tiles, etc.) can
 *  re-fetch without polling. The event is fire-and-forget — listeners
 *  that aren't registered are no-ops. */
export const ROUTES_AND_TRACKS_CHANGED_EVENT = 'thalassa:routes-and-tracks-changed';

export function invalidateRoutesAndTracks(expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return;
    const scope = expectedScope;
    cache = null;
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new CustomEvent(ROUTES_AND_TRACKS_CHANGED_EVENT, { detail: { scopeKey: scope.key } }));
        } catch {
            /* CustomEvent not available (very old browsers) — silent fallback */
        }
    }
}

// ── Summary-backed picker path (no entry-dump window) ──────────────────────
//
// The tracer's "From a past voyage" picker originally listed groups from
// fetchRoutesAndTracks() — i.e. from getLogEntries(10_000), the NEWEST ten
// thousand rows. At auto-capture cadence that window is about a week of
// mixed logging: Shane's 3 July ocean passage aged out of it and the
// picker could never show the one track he wanted (2026-07-15 forensic
// query: 15,135 rows total, ALL since 3 July, window floor 10 July).
// Voyage SUMMARIES see the whole history for pennies; the actual polyline
// loads per-voyage on tap.

export interface SeaVoyageChoice {
    voyageId: string;
    /** Picker row title — the voyage date. */
    label: string;
    /** Picker row detail — distance or fix count. */
    sublabel: string;
    /** startedAt ms — the list is newest-first. */
    timestamp: number;
    distanceNm: number;
    /** Lives only in this device's offline queue (not yet synced). */
    isLocal: boolean;
}

/**
 * Sea voyages for the tracer picker, newest-first, whole history.
 * Sea filter = the career roll-up's landFraction majority vote
 * (isLandVoyage); planned/suggested routes excluded; landFraction null
 * fails OPEN to sea (never hide a real passage that predates water
 * capture). Offline-queue voyages (signed-out / no-network recordings)
 * merge in with a LOCAL flag.
 */
export async function fetchSeaVoyageChoices(max = 6): Promise<SeaVoyageChoice[]> {
    const scope = getAuthIdentityScope();
    const [summaries, offline] = await Promise.all([
        getVoyageSummaries().catch(() => [] as VoyageSummary[]),
        getOfflineEntries().catch(() => [] as ShipLogEntry[]),
    ]);
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    const fromCloud: SeaVoyageChoice[] = summaries
        .filter((s) => !s.isPlannedRoute && !isLandVoyage(s) && s.entryCount >= 2)
        .map((s) => {
            const ts = new Date(s.startedAt).getTime();
            return {
                voyageId: s.voyageId,
                label: fmtDate(ts),
                sublabel: s.totalDistanceNM > 0 ? `${s.totalDistanceNM.toFixed(0)} NM` : `${s.entryCount} fixes`,
                timestamp: ts,
                distanceNm: s.totalDistanceNM,
                isLocal: false,
            };
        });
    const cloudIds = new Set(fromCloud.map((c) => c.voyageId));
    const fromQueue: SeaVoyageChoice[] = groupByVoyage(offline, new Set<string>())
        .filter((t) => !isPlanned(t.id) && t.kind !== 'land' && !cloudIds.has(t.id))
        .map((t) => ({
            voyageId: t.id,
            label: t.label,
            sublabel: t.distanceNm > 0 ? `${t.distanceNm.toFixed(0)} NM` : `${t.points.length} fixes`,
            timestamp: t.timestamp,
            distanceNm: t.distanceNm,
            isLocal: true,
        }));
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    return [...fromQueue, ...fromCloud].sort((a, b) => b.timestamp - a.timestamp).slice(0, Math.max(0, max));
}

/**
 * Full RouteOrTrack for ONE voyage — for the underway trail refresh.
 *
 * The active-voyage chart used to re-run fetchRoutesAndTracks(true) every
 * 60 s, re-downloading and re-grouping the ENTIRE ship log (up to 10 paged
 * requests + a 10k-entry parse/sort, for years of cruising) just to extend
 * one boat's trail — and the identity guard then discarded it anyway (audit
 * rank 7). This fetches ONLY the active voyage's entries (paged, bounded by
 * that one passage) and groups them alone, so the periodic refresh is one
 * voyage's cost, not the whole career's.
 */
export async function fetchVoyageAsTrack(voyageId: string): Promise<RouteOrTrack | null> {
    if (!voyageId) return null;
    const scope = getAuthIdentityScope();
    const targetVoyageId = voyageId;
    const [cloud, offline] = await Promise.all([
        getVoyageEntries(targetVoyageId).catch(() => [] as ShipLogEntry[]),
        getOfflineEntries().catch(() => [] as ShipLogEntry[]),
    ]);
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    const merged = [...cloud, ...offline.filter((e) => e.voyageId === targetVoyageId)];
    const groups = groupByVoyage(merged, new Set(cloud.length > 0 ? [targetVoyageId] : []));
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    const match = groups.find((g) => g.id === targetVoyageId);
    return match ? cloneRoute(match) : null;
}

/**
 * Full track polyline for ONE voyage, in passage order — offline queue
 * first, then the per-voyage cloud fetch (paged internally, so a
 * 1,700-fix passage arrives whole; no global row window to age out of).
 */
export async function loadVoyageTrackPoints(voyageId: string): Promise<Array<{ lat: number; lon: number }>> {
    if (!voyageId) return [];
    const scope = getAuthIdentityScope();
    const targetVoyageId = voyageId;
    const offline = (await getOfflineEntries().catch(() => [] as ShipLogEntry[])).filter(
        (e) => e.voyageId === targetVoyageId,
    );
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    let entries = offline;
    if (entries.filter(isTrackworthyEntry).length < 2) {
        entries = await getVoyageEntries(targetVoyageId);
        if (!isAuthIdentityScopeCurrent(scope)) return [];
    }
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    return entries
        .filter(isTrackworthyEntry)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map((e) => ({ lat: e.latitude, lon: e.longitude }));
}
