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

/** Group entries by voyageId, building a RouteOrTrack per group. */
function groupByVoyage(entries: ShipLogEntry[]): RouteOrTrack[] {
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
        // departure → arrival.
        const sorted = arr
            .filter((e) => typeof e.latitude === 'number' && typeof e.longitude === 'number')
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (sorted.length < 2) continue; // Need at least 2 points to draw a line.

        const points = sorted.map((e) => ({
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

        const distanceNm = sorted.reduce((acc, e) => acc + (e.distanceNM ?? 0), 0);
        const ts = new Date(first.timestamp).getTime();
        const sublabel = isPlanned(id)
            ? `Planned · ${distanceNm > 0 ? distanceNm.toFixed(0) + ' NM' : `${points.length} points`}`
            : `${fmtDate(ts)} · ${distanceNm > 0 ? distanceNm.toFixed(0) + ' NM' : `${points.length} points`}`;

        items.push({ id, label, sublabel, points, bbox, timestamp: ts, distanceNm });
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
            // Pull a generous slice — 10k entries covers years of cruising.
            const entries = await getLogEntries(10_000);
            const all = groupByVoyage(entries);
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

/** Drop the cache so the next fetch hits Supabase. Call after a save. */
export function invalidateRoutesAndTracks(): void {
    cache = null;
}
