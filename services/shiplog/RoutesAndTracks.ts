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
import type { ShipLogEntry } from '../../types/navigation';

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
}

export interface RoutesAndTracksResult {
    routes: RouteOrTrack[];
    tracks: RouteOrTrack[];
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; data: RoutesAndTracksResult } | null = null;
let inflight: Promise<RoutesAndTracksResult> | null = null;

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
        items.push({ id, label, sublabel, points, bbox, timestamp: ts, distanceNm, durationHours, isLocal });
    }

    // Most recent first.
    items.sort((a, b) => b.timestamp - a.timestamp);
    return items;
}

export async function fetchRoutesAndTracks(force = false): Promise<RoutesAndTracksResult> {
    const now = Date.now();
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            // Pull cloud and offline queue in parallel — cloud covers
            // years of cruising (10k cap), offline queue is whatever
            // hasn't synced yet (un-authed user's plans, or anything
            // saved while the device had no network).
            const [cloudEntries, offlineEntries] = await Promise.all([getLogEntries(10_000), getOfflineEntries()]);

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
            cache = { at: Date.now(), data };
            return data;
        } catch {
            return { routes: [], tracks: [] };
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** Drop the cache so the next fetch hits Supabase. Call after a save.
 *  Also broadcasts a `routes-and-tracks-changed` window event so any
 *  surface that displays a count (Nav Station hero tiles, etc.) can
 *  re-fetch without polling. The event is fire-and-forget — listeners
 *  that aren't registered are no-ops. */
export const ROUTES_AND_TRACKS_CHANGED_EVENT = 'thalassa:routes-and-tracks-changed';

export function invalidateRoutesAndTracks(): void {
    cache = null;
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new CustomEvent(ROUTES_AND_TRACKS_CHANGED_EVENT));
        } catch {
            /* CustomEvent not available (very old browsers) — silent fallback */
        }
    }
}
