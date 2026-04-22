/**
 * rainviewerIndex — shared cache + dedup for the RainViewer index JSON.
 *
 * Three independent client modules fetch the same RainViewer index URL:
 *   - components/map/useEmbeddedRain.ts (always-on rain underlay)
 *   - components/map/useWeatherLayers.ts (rain layer scrubber)
 *   - components/dashboard/hero/EssentialMapSlide.tsx (dashboard preview)
 * Without coordination they each fired their own request on every mount,
 * burning bandwidth and a free-tier quota for no good reason — the index
 * is identical and updates ~every 10 minutes.
 *
 * This module:
 *   - Coalesces concurrent callers via an inflight Promise
 *   - Memoises the parsed response for 5 minutes (RainViewer adds a new
 *     past frame every ~10min, so 5min freshness keeps us within one
 *     frame of live without hammering the API)
 *   - Returns the same WeatherMaps shape all three consumers were
 *     decoding inline
 */

export interface RainViewerFrame {
    path: string;
    time: number;
}

export interface RainViewerIndex {
    version: string;
    generated: number;
    host: string;
    radar: {
        past: RainViewerFrame[];
        nowcast: RainViewerFrame[];
    };
    satellite?: {
        infrared: RainViewerFrame[];
    };
}

const URL = 'https://api.rainviewer.com/public/weather-maps.json';
const TTL_MS = 5 * 60 * 1000;

let memo: { at: number; data: RainViewerIndex } | null = null;
let inflight: Promise<RainViewerIndex | null> | null = null;

/**
 * Fetch the RainViewer index, returning a cached / inflight result if
 * one is fresh. Returns null on network failure (don't throw — callers
 * uniformly fall back to "no frames available" UI).
 */
export async function fetchRainviewerIndex(): Promise<RainViewerIndex | null> {
    const now = Date.now();
    if (memo && now - memo.at < TTL_MS) {
        return memo.data;
    }
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            // 'default' lets the browser do its own conditional GET if
            // RainViewer's response carries cache-control headers.
            const res = await fetch(URL, { cache: 'default' });
            if (!res.ok) return null;
            const data = (await res.json()) as RainViewerIndex;
            memo = { at: Date.now(), data };
            return data;
        } catch {
            return null;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}
