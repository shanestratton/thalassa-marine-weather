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

            // TRY THE PI, THEN ALWAYS TRY DIRECT. The Pi is an OPTIMISATION —
            // it must never be the reason a skipper has no radar.
            //
            // The first version of this fallback (2026-08-21) only re-tried
            // when the Pi lane RESOLVED badly — a timeout or a non-OK status.
            // That missed the failure mode that actually strands a boat.
            // isAvailable() reflects the LAST health probe, so the common case
            // is a Pi that answered once and then went out of range: that
            // fetch REJECTS, and per utils/deadline.ts withTimeout propagates
            // rejections by design. The throw sailed past the retry into the
            // outer catch and returned null with RainViewer working one hop
            // away — the same "No Radar" the fallback was written to prevent.
            //
            // attemptLane() therefore collapses every way a lane can fail —
            // throw, timeout, bad status, unusable body — into one null, so
            // the fall-through cannot be skipped by the failure shape.
            let data = piUrl ? await attemptLane(piUrl, 'pi') : null;
            if (!data) {
                if (piUrl) log.warn('[rainviewer] Pi lane unusable — falling through to direct');
                data = await attemptLane(URL, 'direct');
            }

            if (!data) {
                log.warn('[rainviewer] no lane returned a usable index — no radar frames this pass');
                return null;
            }
            memo = { at: Date.now(), data };
            return data;
        } catch (e) {
            // Belt and braces: attemptLane already swallows per-lane failures,
            // so reaching here means something outside the lanes broke.
            log.warn('[rainviewer] index fetch failed', e);
            return null;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/**
 * One fetch attempt, reduced to "usable index or null".
 *
 * Every failure mode is caught HERE rather than at the call site, because the
 * call site's job is to decide which lane to try next and it cannot do that if
 * one class of failure throws past it.
 *
 * The body check is not paranoia. The Pi's /api/passthrough answers 200 from
 * `cachedJsonFetch`, so a poisoned or stale cache entry — or its own
 * `{ error: ... }` envelope, which it returns with a status only on the throw
 * path — arrives as a perfectly valid 200 JSON document with no frames in it.
 * Accepting that as success would pin us to the bad lane and skip the direct
 * retry, which is exactly the "reports healthy, paints nothing" shape this
 * module already got caught by once.
 */
async function attemptLane(url: string, lane: 'pi' | 'direct'): Promise<RainViewerIndex | null> {
    try {
        // 'default' lets the browser do its own conditional GET if
        // RainViewer's response carries cache-control headers.
        //
        // BOUNDED. This is the fetch the whole rain layer waits on before it
        // can paint anything, and it had no timeout and no signal — and per
        // utils/deadline.ts, CapacitorHttp ignores AbortSignal on the native
        // build, so the effective ceiling was the native default of ten
        // minutes. A stalled marine-LTE socket pinned rain on "loading" for
        // the rest of the passage. 6s is generous for a small JSON and still
        // short enough to feel like a failure rather than a hang.
        const res = await withTimeout(fetch(url, { cache: 'default' }), null, 6000);
        if (!res) {
            log.warn(`[rainviewer] ${lane} lane timed out after 6s`);
            return null;
        }
        if (!res.ok) {
            log.warn(`[rainviewer] ${lane} lane HTTP ${res.status}`);
            return null;
        }
        const body = (await res.json()) as RainViewerIndex | null;
        if (!body || !Array.isArray(body.radar?.past) || body.radar.past.length === 0) {
            log.warn(`[rainviewer] ${lane} lane returned 200 with no radar frames`);
            return null;
        }
        return body;
    } catch (e) {
        // Includes the one that mattered: an unreachable host rejects.
        log.warn(`[rainviewer] ${lane} lane threw`, e);
        return null;
    }
}
