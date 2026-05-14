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

export interface VoyageLogEntry {
    id: string;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];
    location_name: string;
    latitude: number | null;
    longitude: number | null;
    weather_summary: string;
    weather_data: VoyageLogWeather | null;
    tags: string[];
    created_at: string;
}

export interface VoyageLogTrackPoint {
    lat: number;
    lon: number;
    timestamp: string;
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
}

export interface VoyageLogData {
    vessel: { name: string; type: string; model: string | null };
    entries: VoyageLogEntry[];
    track: VoyageLogTrackPoint[];
    telemetry: VoyageLogTelemetry | null;
    generated_at: string;
}

export class VoyageLogError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = 'VoyageLogError';
    }
}

/** Fetch a vessel's published voyage log. Throws VoyageLogError on failure. */
export async function fetchVoyageLog(handle: string, key: string): Promise<VoyageLogData> {
    if (!SUPABASE_URL) {
        throw new VoyageLogError(0, 'Voyage Log API URL is not configured for this build.');
    }
    const url =
        `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/voyage-log` +
        `?handle=${encodeURIComponent(handle)}&key=${encodeURIComponent(key)}`;

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

/** Pull handle + key out of the page URL: /logs/<handle>?k=<key> */
export function parseVoyageLogParams(): { handle: string; key: string } {
    const path = window.location.pathname.replace(/\/+$/, '');
    const m = path.match(/\/logs\/([^/]+)/);
    const handle = m ? decodeURIComponent(m[1]) : '';
    const key = new URLSearchParams(window.location.search).get('k') || '';
    return { handle, key };
}
