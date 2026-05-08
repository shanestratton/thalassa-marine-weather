/**
 * Tide Height Service — fetches tide curves from pi-cache (or
 * Supabase fallback) and exposes a synchronous interpolated lookup
 * for use by the routing validator and hazard query path.
 *
 * Why this exists separately from the other tide consumers:
 *   - Voice integrations (services/voice/integrations/tides.ts)
 *     and the dashboard daily briefing pull tides for display —
 *     "next high at 14:23, 1.8m." They format for humans.
 *   - Routing-grade tide correction needs a numeric height at an
 *     arbitrary lat/lon/time during the planned passage. That's a
 *     different access pattern (curve interpolation, not extremes
 *     listing).
 *
 * Architecture:
 *   1. fetchTideCurve(lat, lon, startMs, endMs) does a single
 *      pi-cache call covering the requested time range.
 *   2. Returned TideCurve carries the heights array and an
 *      interpolation function the routing engine calls per-waypoint.
 *   3. In-memory session cache so a single planning session doesn't
 *      hit the API once per route segment.
 *
 * Limitations (documented honestly):
 *   - Single station per curve. For routes >100 NM that cross
 *     significant tide-phase boundaries (e.g. Cook Strait), the
 *     midpoint station is approximate. Phase 7 will compute a
 *     piecewise curve from multiple stations along the route.
 *   - Pi-cache is preferred when available; falls back to Supabase
 *     edge function `proxy-tides` directly.
 *   - Returns null when no tide data is available; caller should
 *     degrade to the static tideOffsetM in HazardQueryOptions.
 */

import { CapacitorHttp } from '@capacitor/core';

import { createLogger } from '../utils/createLogger';
import { piCache } from './PiCacheService';
import type { WorldTidesHeight, WorldTidesResponse } from '../types/api';

const log = createLogger('TideHeightService');

// ── Types ──────────────────────────────────────────────────────────

export interface TideCurve {
    /**
     * Heights array sorted ascending by `dt` (unix seconds). May be
     * empty if the source returned no data — caller should null-
     * check via `heightAt`.
     */
    heights: WorldTidesHeight[];
    /**
     * Synchronous lookup. Returns metres above chart datum at
     * `timeMs`, linearly interpolated between the two surrounding
     * heights. Returns `null` when the time is outside the curve's
     * range (the caller should not extrapolate guess-tides).
     */
    heightAt(timeMs: number): number | null;
    /** [start, end] inclusive in millis. */
    rangeMs: [number, number];
    /** Source station name for the attribution chip. */
    stationName?: string;
    /** Source lat/lon (the station's actual position). */
    stationLat?: number;
    stationLon?: number;
}

// ── Cache ──────────────────────────────────────────────────────────

interface CachedCurve {
    fetchedAt: number;
    curve: TideCurve;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — tides predicted hours ahead don't change.
const cache = new Map<string, CachedCurve>();

function cacheKey(lat: number, lon: number, startMs: number, endMs: number): string {
    // Round to 0.25° spatial buckets and 6h temporal buckets so
    // adjacent route midpoints share the same fetch.
    const latBucket = Math.round(lat * 4) / 4;
    const lonBucket = Math.round(lon * 4) / 4;
    const startBucket = Math.floor(startMs / (6 * 60 * 60 * 1000));
    const endBucket = Math.floor(endMs / (6 * 60 * 60 * 1000));
    return `${latBucket},${lonBucket},${startBucket},${endBucket}`;
}

// ── Interpolation ─────────────────────────────────────────────────

/**
 * Build a heightAt() function over the heights array. Encapsulates
 * the binary search + linear interpolation so callers don't have
 * to reimplement it.
 */
function buildLookup(heights: WorldTidesHeight[]): TideCurve['heightAt'] {
    return (timeMs: number): number | null => {
        if (heights.length === 0) return null;
        const t = timeMs / 1000;
        if (t < heights[0].dt) return null;
        if (t > heights[heights.length - 1].dt) return null;

        // Binary search for the closest two heights bracketing t.
        let lo = 0;
        let hi = heights.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (heights[mid].dt <= t) lo = mid;
            else hi = mid;
        }
        const a = heights[lo];
        const b = heights[hi];
        if (a.dt === b.dt) return a.height;
        const frac = (t - a.dt) / (b.dt - a.dt);
        return a.height + frac * (b.height - a.height);
    };
}

// ── Pi-cache fetch ─────────────────────────────────────────────────

/**
 * Fetch via pi-cache. Returns null on any failure so the caller
 * can fall back to the Supabase direct path.
 */
async function fetchViaPi(lat: number, lon: number, days: number): Promise<WorldTidesResponse | null> {
    if (!piCache.isAvailable()) return null;
    try {
        const url = `${piCache.baseUrl}/api/tides/predictions?lat=${lat}&lon=${lon}&days=${days}`;
        const res = await CapacitorHttp.get({
            url,
            connectTimeout: 5000,
            readTimeout: 10000,
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) return null;
        return res.data as WorldTidesResponse;
    } catch (err) {
        log.warn('pi-cache tide fetch failed', err);
        return null;
    }
}

/**
 * Fallback: Supabase edge function. Same wire format. Used only
 * when pi-cache is unreachable.
 */
async function fetchViaSupabase(lat: number, lon: number, days: number): Promise<WorldTidesResponse | null> {
    try {
        const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
        const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
        if (!supabaseUrl || !supabaseKey) return null;
        const url = `${supabaseUrl}/functions/v1/proxy-tides?lat=${lat}&lon=${lon}&days=${days}`;
        const res = await CapacitorHttp.get({
            url,
            headers: {
                Authorization: `Bearer ${supabaseKey}`,
                apikey: supabaseKey,
            },
            connectTimeout: 5000,
            readTimeout: 15000,
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) return null;
        return res.data as WorldTidesResponse;
    } catch (err) {
        log.warn('Supabase tide fetch failed', err);
        return null;
    }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Fetch (or cached-return) a tide curve covering the requested
 * range at the requested location.
 *
 * `startMs` / `endMs` are in milliseconds since epoch. We round
 * the curve to whole-day boundaries inside the API params so we
 * always grab a cache-friendly window.
 *
 * Returns null when no tide data is available at all (failed
 * upstream, no station nearby). Caller should fall back to the
 * static tideOffsetM in HazardQueryOptions.
 */
export async function fetchTideCurve(
    lat: number,
    lon: number,
    startMs: number,
    endMs: number,
): Promise<TideCurve | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

    const key = cacheKey(lat, lon, startMs, endMs);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        return hit.curve;
    }

    // Round the requested span up to whole days for the API call;
    // callers asking for 4 h get the same fetch as callers asking
    // for the same 4 h overlapping a 24 h window.
    const days = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1);

    const response = (await fetchViaPi(lat, lon, days)) ?? (await fetchViaSupabase(lat, lon, days));
    if (!response || !response.heights || response.heights.length === 0) {
        log.info(`no tide data for ${lat.toFixed(2)},${lon.toFixed(2)} — caller should fall back`);
        return null;
    }

    const heights = [...response.heights].sort((a, b) => a.dt - b.dt);
    const rangeMs: [number, number] = [heights[0].dt * 1000, heights[heights.length - 1].dt * 1000];

    const curve: TideCurve = {
        heights,
        heightAt: buildLookup(heights),
        rangeMs,
        stationName: response.station?.name,
        stationLat: response.station?.lat,
        stationLon: response.station?.lon,
    };
    cache.set(key, { fetchedAt: Date.now(), curve });
    log.info(
        `fetched tide curve at ${lat.toFixed(2)},${lon.toFixed(2)}: ` +
            `${heights.length} points, ${response.station?.name ?? 'station unknown'}`,
    );
    return curve;
}

/**
 * Drop the in-memory cache. Used for tests and for the "reload"
 * admin action.
 */
export function clearTideCache(): void {
    cache.clear();
}
