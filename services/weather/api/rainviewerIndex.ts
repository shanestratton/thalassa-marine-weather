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
 *   - Routes through the Pi cache when the boat network is up so the
 *     whole fleet shares one index fetch (and so re-fetches over the
 *     LAN take ~10ms instead of 200-400ms over cellular)
 *   - Returns the same WeatherMaps shape all three consumers were
 *     decoding inline
 */
import { piCache } from '../../PiCacheService';
import { withTimeout } from '../../../utils/deadline';
import { createLogger } from '../../../utils/createLogger';

const log = createLogger('rainviewerIndex');

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
        /** Legacy indexes may include this; the current public API is past-only. */
        nowcast?: RainViewerFrame[];
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
            // Route through the Pi when available so the boat-fleet shares
            // one fetch and subsequent requests come straight off the Pi's
            // disk. TTL matches our in-memory memo (5 min) — RainViewer
            // publishes a new past frame every ~10 min, so 5 min keeps us
            // within one frame of live.
            const piUrl = piCache.passthroughUrl(URL, TTL_MS, 'rainviewer-index');
            const fetchUrl = piUrl ?? URL;
            // 'default' lets the browser do its own conditional GET if
            // RainViewer's response carries cache-control headers.
            //
            // BOUNDED. This is the fetch the whole rain layer waits on before
            // it can paint anything, and it had no timeout and no signal — and
            // per utils/deadline.ts, CapacitorHttp ignores AbortSignal on the
            // native build, so the effective ceiling was the native default of
            // ten minutes. A stalled marine-LTE socket, or a Pi that probed
            // reachable and then went out of range, pinned rain on "loading"
            // for the rest of the passage. 6s is generous for a small JSON and
            // still short enough to feel like a failure rather than a hang.
            const res = await withTimeout(fetch(fetchUrl, { cache: 'default' }), null, 6000);
            if (!res) {
                log.warn('[rainviewer] index timed out — no radar frames this pass');
                return null;
            }
            if (!res.ok) {
                log.warn(`[rainviewer] index HTTP ${res.status} — no radar frames this pass`);
                return null;
            }
            const data = (await res.json()) as RainViewerIndex;
            memo = { at: Date.now(), data };
            return data;
        } catch (e) {
            // Was a bare `return null`. The caller then drew an empty rain
            // layer and reported it healthy, so a dead radar feed looked
            // exactly like clear skies with nothing in the console to say
            // otherwise. warn(), not info() — info is a no-op in prod builds.
            log.warn('[rainviewer] index fetch failed', e);
            return null;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}
