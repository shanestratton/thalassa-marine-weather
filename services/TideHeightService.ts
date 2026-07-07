/**
 * Tide Height Service — routing-grade tide height lookup. Exposes a
 * synchronous interpolated heightAt() for the routing validator and
 * hazard query path.
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
 * Source tiers (provenance carried on the returned curve):
 *   - 'STATION_HEIGHTS' — dense WorldTides station heights, linearly
 *     interpolated. No Thalassa fetch path requests heights today
 *     (extremes are 1 credit; dense heights cost per-day), so this
 *     tier is dormant — the branch stays so a future paid path can
 *     light it up without touching consumers.
 *   - 'EXTREMES_INTERP' — half-cosine interpolation between the HW/LW
 *     extremes the app already fetches everywhere (free, and served
 *     from the pi/proxy caches offline). Accurate to roughly ±0.3 m
 *     in semidiurnal regimes; Phase 7 labels windows built on these
 *     curves "approx".
 *
 * Datum guard: under-keel clearance maths assumes heights above LAT
 * (chart datum). Every fetch path requests datum=LAT and WorldTides
 * echoes requestDatum/responseDatum back (verified on both the pi
 * and proxy paths 2026-06-11); hydration REFUSES (null + warn) any
 * response that doesn't explicitly confirm LAT. Converting datums
 * client-side is how groundings happen — we never do it.
 *
 * Limitations (documented honestly):
 *   - Single station per curve. For routes >100 NM that cross
 *     significant tide-phase boundaries (e.g. Cook Strait), the
 *     midpoint station is approximate. Phase 7 will compute a
 *     piecewise curve from multiple stations along the route.
 *   - Returns null when no tide data is available; caller should
 *     degrade to the static tideOffsetM in HazardQueryOptions.
 */

import { createLogger } from '../utils/createLogger';
import { fetchWorldTides } from './weather/api/worldtides';
import { buildExtremesLookup, TideExtremePoint } from './tides/extremesInterp';
import type { WorldTidesHeight, WorldTidesResponse } from '../types/api';

const log = createLogger('TideHeightService');

// ── Types ──────────────────────────────────────────────────────────

export type TideCurveProvenance = 'STATION_HEIGHTS' | 'EXTREMES_INTERP';

export interface TideCurve {
    /**
     * Dense station heights sorted ascending by `dt` (unix seconds).
     * Populated only for 'STATION_HEIGHTS' curves; empty for
     * 'EXTREMES_INTERP' — interpolate via `heightAt`, not this array.
     */
    heights: WorldTidesHeight[];
    /**
     * How the curve was built. 'EXTREMES_INTERP' is approximate
     * (±0.3 m-ish) — Phase 7 uses this to label tide windows "approx".
     */
    provenance: TideCurveProvenance;
    /**
     * Synchronous lookup. Returns metres above LAT at `timeMs`.
     * Returns `null` when the time is outside the curve's range (the
     * caller should not extrapolate guess-tides).
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
 * Build a heightAt() over dense station heights (linear interpolation
 * — points are ~30 min apart, so linear is within a centimetre).
 */
function buildHeightsLookup(heights: WorldTidesHeight[]): TideCurve['heightAt'] {
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

// ── Hydration ──────────────────────────────────────────────────────

const ROUTING_SAFE_DATUM = 'LAT';

/**
 * Build a TideCurve from a raw WorldTides response. Exported for unit
 * tests and for Phase 7 to hydrate piecewise curves from per-station
 * cached responses.
 *
 * Returns null when the datum isn't explicitly LAT, or when the
 * response carries neither dense heights nor ≥2 extremes.
 */
export function buildTideCurve(response: WorldTidesResponse): TideCurve | null {
    // Datum guard — refuse rather than convert. An MSL (or unknown)
    // curve fed into under-keel clearance maths reads roughly half the
    // tide range too optimistic.
    const datum = response.responseDatum ?? response.requestDatum;
    if (datum !== ROUTING_SAFE_DATUM) {
        log.warn(`refusing tide curve on datum '${datum ?? 'unknown'}' — only ${ROUTING_SAFE_DATUM} is routing-safe`);
        return null;
    }

    const station = {
        stationName: response.station?.name,
        stationLat: response.station?.lat,
        stationLon: response.station?.lon,
    };

    // Tier 1: dense station heights (paid path, currently dormant).
    if (response.heights && response.heights.length > 0) {
        const heights = [...response.heights].sort((a, b) => a.dt - b.dt);
        return {
            heights,
            provenance: 'STATION_HEIGHTS',
            heightAt: buildHeightsLookup(heights),
            rangeMs: [heights[0].dt * 1000, heights[heights.length - 1].dt * 1000],
            ...station,
        };
    }

    // Tier 2: half-cosine between the cached HW/LW extremes (free path).
    if (response.extremes && response.extremes.length >= 2) {
        const points: TideExtremePoint[] = response.extremes
            .map((e) => ({ timeMs: e.dt * 1000, heightM: e.height, type: e.type }))
            .sort((a, b) => a.timeMs - b.timeMs);
        return {
            heights: [],
            provenance: 'EXTREMES_INTERP',
            heightAt: buildExtremesLookup(points),
            rangeMs: [points[0].timeMs, points[points.length - 1].timeMs],
            ...station,
        };
    }

    return null;
}

// ── Public API ─────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch (or cached-return) a tide curve covering the requested
 * range at the requested location.
 *
 * `startMs` / `endMs` are in milliseconds since epoch. Data comes
 * through fetchWorldTides — the same pi-cache → Supabase proxy →
 * direct pipeline every other tide consumer uses — so a curve is
 * available wherever the app already shows tide extremes.
 *
 * Returns null when no tide data is available at all (failed
 * upstream, no station nearby, non-LAT datum). Caller should fall
 * back to the static tideOffsetM in HazardQueryOptions.
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

    // In-flight dedupe: the Route Tracer can fire several same-bucket lookups
    // in one render burst (one per sub-keel leg) — share one upstream fetch
    // instead of racing the rate-limited WorldTides proxy.
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = fetchTideCurveUpstream(lat, lon, key, endMs).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

const inflight = new Map<string, Promise<TideCurve | null>>();

async function fetchTideCurveUpstream(lat: number, lon: number, key: string, endMs: number): Promise<TideCurve | null> {
    // The proxy anchors the WorldTides window at yesterday 00:00, so
    // coverage must be measured from *now*, not from startMs — a
    // passage departing in 3 days needs 3 + duration days of window,
    // not just the duration. +2 covers the yesterday-anchor and
    // partial-day rounding; clamp to the 14-day window the rest of
    // the app requests.
    const daysAhead = Math.ceil((endMs - Date.now()) / DAY_MS) + 2;
    const days = Math.min(14, Math.max(1, daysAhead));

    const response = await fetchWorldTides(lat, lon, days);
    if (!response) {
        log.info(`no tide data for ${lat.toFixed(2)},${lon.toFixed(2)} — caller should fall back`);
        return null;
    }

    const curve = buildTideCurve(response);
    if (!curve) {
        log.info(`tide response unusable for ${lat.toFixed(2)},${lon.toFixed(2)} — caller should fall back`);
        return null;
    }

    cache.set(key, { fetchedAt: Date.now(), curve });
    log.info(
        `fetched tide curve at ${lat.toFixed(2)},${lon.toFixed(2)}: ` +
            `${curve.provenance}, ${curve.stationName ?? 'station unknown'}`,
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
