/**
 * voyageLogApi — client for the public voyage-log edge function.
 *
 * Deliberately self-contained: the default renderer is a separate Vite
 * bundle from the main Thalassa app, so it does NOT pull in
 * services/supabase.ts or the Capacitor stack.
 */

const SUPABASE_URL: string =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) || process.env.SUPABASE_URL || '';

/** Mapbox access token — publishable, safe to ship in this public bundle. */
export const MAPBOX_TOKEN: string =
    (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined) || process.env.MAPBOX_ACCESS_TOKEN || '';

export type DiaryMood = 'epic' | 'good' | 'neutral' | 'rough' | 'storm';

/** Mood → emoji + Tailwind text colour, mirrored from the app's MOOD_CONFIG. */
export const MOOD: Record<DiaryMood, { emoji: string; label: string; color: string; hex: string }> = {
    epic: { emoji: '🌅', label: 'Epic', color: 'text-amber-400', hex: '#fbbf24' },
    good: { emoji: '⛵', label: 'Good', color: 'text-emerald-400', hex: '#34d399' },
    neutral: { emoji: '🌊', label: 'Neutral', color: 'text-sky-400', hex: '#38bdf8' },
    rough: { emoji: '💨', label: 'Rough', color: 'text-orange-400', hex: '#fb923c' },
    storm: { emoji: '⛈️', label: 'Storm', color: 'text-red-400', hex: '#f87171' },
};

export interface VoyageLogWeather {
    description?: string;
    airTemp?: number;
    seaTemp?: number;
    windSpeed?: number;
    windDir?: string;
    humidity?: number;
    rain?: number;
}

export interface VoyageLogAuthor {
    user_id: string;
    display_name: string;
}

export interface VoyageLogEntry {
    id: string;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];
    video_url?: string | null;
    location_name: string;
    latitude: number | null;
    longitude: number | null;
    weather_summary: string;
    weather_data: VoyageLogWeather | null;
    tags: string[];
    created_at: string;
    /** The sailed voyage this entry belongs to. Null means it is an
     *  intentionally unassigned diary note, visible in the public page's
     *  "All diary entries" view. */
    voyage_id: string | null;
    /** Byline. Present only on combined-scope logs; null on personal logs. */
    author: VoyageLogAuthor | null;
}

/** A public, already-started voyage available in the log page's picker.
 *  Future plans deliberately do not appear here: a public voyage is what the
 *  crew has actually sailed, optionally with its linked planned route. */
export interface PublicVoyageTrip {
    id: string;
    kind: 'track' | 'all-diary';
    label: string;
    started_at: string | null;
    ended_at: string | null;
    active: boolean;
    point_count: number;
    distance_nm: number | null;
    has_route: boolean;
}

export interface VoyageLogTrackPoint {
    lat: number;
    lon: number;
    timestamp: string;
    /** Which voyage this fix belongs to — the map splits the drawn line
     *  per voyage so separate passages don't join up. */
    voyage_id?: string | null;
    speed_kts: number | null;
    course_deg: number | null;
    heading_deg: number | null;
    pressure: number | null;
    wind_speed_apparent: number | null;
    wind_angle_apparent: number | null;
    wind_speed_true: number | null;
    wind_direction_true: number | null;
    depth_m: number | null;
    air_temp: number | null;
    water_temp: number | null;
    wave_height: number | null;
}

export interface VoyageLogTelemetry {
    sog: number | null;
    cog: number | null;
    heading: number | null;
    baro: number | null;
    baro_trend: 'rising' | 'falling' | 'steady';
    aws: number | null;
    awa: number | null;
    tws: number | null;
    twd: number | null;
    depth: number | null;
    air_temp: number | null;
    water_temp: number | null;
    wave_height: number | null;
    lat: number;
    lon: number;
    updated_at: string;
    /** TRUE when this position is the last-known-position FALLBACK — no recent
     *  track exists, so it is where the boat was last seen rather than where it
     *  is now. The UI must label it; a stale berth fix shown as current is
     *  something a viewer could plan a rendezvous around. */
    is_last_known?: boolean;
}

export interface VoyageLogDestination {
    name: string | null;
    lat: number;
    lon: number;
}

export interface NearbyVessel {
    mmsi: string;
    name: string | null;
    lat: number;
    lon: number;
    /** Course over ground, degrees true. */
    cog: number | null;
    /** Speed over ground, knots. */
    sog: number | null;
    heading: number | null;
    /** Human-readable ship type (cargo / tanker / passenger / fishing / …). */
    /** The pond stores the raw ITU-R M.1371 integer (36 = sailing); older
     *  rows carry a descriptive string. Typing this as string-only is what
     *  let a number reach `.toLowerCase()` and blank the page (2026-09-02). */
    ship_type: string | number | null;
    call_sign: string | null;
    destination: string | null;
    nav_status: string | null;
    updated_at: string | null;
    /** Registry enrichment (vessel_metadata) — filled by MMSI when the live
     *  AIS feed doesn't carry the name/details itself. */
    flag_emoji?: string | null;
    flag_country?: string | null;
    loa?: number | null;
    thumbnail_url?: string | null;
}

export interface VoyageLogData {
    vessel: { name: string; type: string; model: string | null };
    /** 'personal' = one author, no bylines. 'combined' = boat-wide, entries carry author. */
    scope: 'personal' | 'combined';
    destination: VoyageLogDestination | null;
    /** Started tracks plus the permanent catch-all diary view. */
    trips: PublicVoyageTrip[];
    /** The trip the server resolved for this response. null only for the
     *  backward-compatible, unscoped API request. */
    selected_trip: string | null;
    entries: VoyageLogEntry[];
    track: VoyageLogTrackPoint[];
    /** Named waypoints dropped under way — shown as labelled pins. */
    waypoints?: VoyageLogWaypoint[];
    telemetry: VoyageLogTelemetry | null;
    nearby_vessels: NearbyVessel[];
    /** The route the boat is CURRENTLY following — the linked passage plan for
     *  the fresh voyage, decimated to ≤200 [lon,lat] points server-side. null
     *  when no active passage. This is the one route the public map draws;
     *  every other saved/planned route is filtered out (Shane 2026-07-17:
     *  "show just the route we are currently following"). */
    passage?: { voyage_id?: string | null; plan_line: [number, number][] } | null;
    generated_at: string;
}

export interface VoyageLogWaypoint {
    lat: number;
    lon: number;
    name: string;
    timestamp: string;
}

export class VoyageLogError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = 'VoyageLogError';
    }
}

/** Fetch a vessel's published voyage log. `trip=latest` follows newly-started
 * voyages; an explicit id holds a historical selection stable across polls. */
export async function fetchVoyageLog(handle: string, trip?: string): Promise<VoyageLogData> {
    if (!SUPABASE_URL) {
        throw new VoyageLogError(0, 'Voyage Log API URL is not configured for this build.');
    }
    const params = new URLSearchParams({ handle });
    if (trip !== undefined) params.set('trip', trip);
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/voyage-log?${params.toString()}`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch {
        throw new VoyageLogError(0, 'Could not reach the Voyage Log API — check your connection.');
    }

    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
            const body = await res.json();
            if (body?.error) message = body.error as string;
        } catch {
            /* non-JSON error body — keep the generic message */
        }
        throw new VoyageLogError(res.status, message);
    }

    return (await res.json()) as VoyageLogData;
}

/**
 * Pull the handle out of the page URL. Accepts either:
 *   1. <handle>.thalassawx.app (subdomain — production)
 *   2. /logs/<handle>           (path — fallback, local dev, share-by-path)
 */
export function parseVoyageLogParams(): { handle: string } {
    // Subdomain form: serene-summer.thalassawx.app → "serene-summer".
    const host = window.location.hostname;
    const hostParts = host.split('.');
    // Anything with a sub-label that isn't www/apex is treated as the handle.
    // TLD-agnostic on purpose: the page is served from both thalassawx.app
    // and thalassawx.com (2026-09-02), and a two-label apex never reaches the
    // >= 3 test anyway.
    if (hostParts.length >= 3 && hostParts[0] !== 'www' && !/^thalassawx\.(app|com)$/i.test(host)) {
        return { handle: hostParts[0] };
    }
    // Path form: /logs/<handle>
    const path = window.location.pathname.replace(/\/+$/, '');
    const m = path.match(/\/logs\/([^/]+)/);
    if (m) return { handle: decodeURIComponent(m[1]) };
    // Query form: ?handle=<handle> — local dev + debugging (mirrors the
    // plan page's parser; Vite serves /logs.html directly with no
    // rewrite layer to carry a path handle).
    const q = new URLSearchParams(window.location.search).get('handle');
    return { handle: q ?? '' };
}
