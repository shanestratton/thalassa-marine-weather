/**
 * Universal API Response Cache
 *
 * Prevents quota exhaustion by caching API responses based on when
 * upstream data actually changes — not arbitrary timeouts.
 *
 * Model Update Schedules:
 * - WorldTides:  Harmonic predictions don't change. Cache 24h.
 * - StormGlass:  GFS runs 00/06/12/18z + ~5h delay. Cache until next run.
 * - WeatherKit:  Apple updates ~15-30 min. Cache 15 min.
 * - Open-Meteo:  Aggregated models. Cache 30 min.
 * - NOAA GFS:    Same 6h cycle as StormGlass. Cache until next run.
 *
 * Caches use a bounded 0.001° point cell (roughly 111m latitude). This still
 * absorbs ordinary GPS jitter without letting a tide or nearshore payload
 * travel kilometres to a different requested point.
 */

// ── Cache TTLs (milliseconds) ─────────────────────────────────

import { createLogger } from '../../utils/createLogger';
import { canUsePlaintextWeatherCache } from './plaintextCachePrivacy';

const log = createLogger('apiCache');
const TTL = {
    worldtides: 24 * 60 * 60 * 1000, // 24 hours — predictions are deterministic
    stormglass: 3 * 60 * 60 * 1000, //  3 hours — catches every 6h model cycle
    weatherkit: 15 * 60 * 1000, // 15 minutes — Apple refreshes frequently
    openmeteo: 30 * 60 * 1000, // 30 minutes — free, but still polite
    noaa_gfs: 3 * 60 * 60 * 1000, //  3 hours — same as StormGlass
    tides: 24 * 60 * 60 * 1000, // 24 hours — parsed tide extremes
} as const;

export type ApiCacheProvider = keyof typeof TTL;

/**
 * Providers whose data is published on the 6-hourly synoptic model cycle
 * (00/06/12/18Z). For these, a wall-clock TTL is the wrong shape: it either
 * refetches data that has not changed, or sits on an old run after a new one
 * lands. Expiring on the CYCLE instead does strictly better on both counts.
 *
 * StormGlass is metered and its quota is worth real money (Shane 2026-07-22:
 * "cut the quota for stormglass as much as possible"). At the old 3 h TTL a
 * boat sitting in one spot pulled up to 8 fetches a day for a model that only
 * moves 4 times — so roughly half of every bill bought byte-identical data.
 */
const CYCLE_ALIGNED: ReadonlySet<ApiCacheProvider> = new Set(['stormglass', 'noaa_gfs']);

/** Model cycle length, and how long after the cycle hour the run is available. */
const CYCLE_MS = 6 * 60 * 60 * 1000;
const PUBLISH_LAG_MS = 90 * 60 * 1000;

/**
 * The newest model run that could plausibly have been published by `now`.
 * An entry stored before this is stale; an entry stored after it is the
 * current run and cannot be improved on by refetching.
 */
export function currentCycleStart(now: number): number {
    return Math.floor((now - PUBLISH_LAG_MS) / CYCLE_MS) * CYCLE_MS;
}

/**
 * Is a cycle-aligned entry still current? True while it holds the newest run.
 *
 * Compares WHICH RUN the entry captured against which run is current, rather
 * than asking whether storedAt is past the current run's hour. Those differ:
 * an entry written at 07:24 was fetched before the 06Z run published (90 min
 * lag) so it still holds 00Z data, even though 07:24 is "after 06:00". The
 * naive comparison called that fresh and would have pinned yesterday's swell
 * through the whole next cycle.
 *
 * Note this is FRESHER than the old 3 h TTL in the worst case — a new run is
 * picked up as soon as it publishes rather than up to 3 h later — while
 * costing one fetch per run instead of two.
 */
export function isCycleEntryFresh(storedAt: number, now: number): boolean {
    return currentCycleStart(storedAt) === currentCycleStart(now);
}

// ── Location Key ──────────────────────────────────────────────

// v2 (2026-04-24): bumped to invalidate stale tide entries that were
// written before fetchWorldTides normalized the station name via
// processResponse on the Pi path. Old entries baked in a literal
// "WorldTides Station" stationName that surfaced on the tide graph.
const CACHE_PREFIX = 'thalassa_apicache_v3_point_';
const COORDINATE_DECIMALS = 3;

function locationKey(lat: number, lon: number): string | null {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        return null;
    }
    return `${lat.toFixed(COORDINATE_DECIMALS)}_${lon.toFixed(COORDINATE_DECIMALS)}`;
}

function cacheKey(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): string | null {
    const point = locationKey(lat, lon);
    if (!point) return null;
    const base = `${CACHE_PREFIX}${provider}_${point}`;
    return extra ? `${base}_${extra}` : base;
}

// ── Core Cache Operations ─────────────────────────────────────

interface CacheEntry<T> {
    data: T;
    storedAt: number;
    provider: string;
    coordinates: { lat: number; lon: number };
}

/**
 * Get cached API response. Returns null if expired or missing.
 */
export function apiCacheGet<T>(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): T | null {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return null;
    try {
        const key = cacheKey(provider, lat, lon, extra);
        if (!key) return null;
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        const entry: CacheEntry<T> = JSON.parse(raw);
        const now = Date.now();
        const ageMs = now - entry.storedAt;
        const ttl = TTL[provider];
        if (locationKey(entry.coordinates?.lat, entry.coordinates?.lon) !== locationKey(lat, lon)) {
            localStorage.removeItem(key);
            return null;
        }

        // Cycle-aligned providers ignore the wall-clock TTL: they are current
        // until a NEWER model run publishes. The TTL above stays as a hard
        // backstop so a clock jump or a bad storedAt can't pin an entry
        // forever.
        const expired = CYCLE_ALIGNED.has(provider)
            ? !isCycleEntryFresh(entry.storedAt, now) || ageMs > CYCLE_MS + PUBLISH_LAG_MS
            : ageMs > ttl;

        if (expired) {
            localStorage.removeItem(key);
            return null;
        }

        const _ageMin = Math.round(ageMs / 60000);
        const _ttlMin = Math.round(ttl / 60000);
        return entry.data;
    } catch (e) {
        log.warn('[apiCache]', e);
        return null;
    }
}

/**
 * Store an API response in cache.
 */
export function apiCacheSet<T>(provider: ApiCacheProvider, lat: number, lon: number, data: T, extra?: string): void {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
    try {
        const key = cacheKey(provider, lat, lon, extra);
        if (!key) return;
        const entry: CacheEntry<T> = {
            data,
            storedAt: Date.now(),
            provider,
            coordinates: { lat, lon },
        };
        localStorage.setItem(key, JSON.stringify(entry));
    } catch (e) {
        log.warn('[apiCache]', e);
        // localStorage full — evict oldest entries
        evictOldest(3);
        try {
            const key = cacheKey(provider, lat, lon, extra);
            if (!key) return;
            localStorage.setItem(
                key,
                JSON.stringify({
                    data,
                    storedAt: Date.now(),
                    provider,
                    coordinates: { lat, lon },
                }),
            );
        } catch (e) {
            log.warn('[apiCache]', e);
            // Still full — give up silently
        }
    }
}

/**
 * Invalidate cache for a specific provider + location.
 */
export function apiCacheInvalidate(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): void {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
    const key = cacheKey(provider, lat, lon, extra);
    if (key) localStorage.removeItem(key);
}

// ── Housekeeping ──────────────────────────────────────────────

/** Evict N oldest cache entries to free space */
function evictOldest(count: number): void {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
    const entries: { key: string; storedAt: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            entries.push({ key, storedAt: parsed.storedAt || 0 });
        } catch (e) {
            log.warn('[apiCache] skip corrupt:', e);
        }
    }

    entries.sort((a, b) => a.storedAt - b.storedAt);
    for (let i = 0; i < Math.min(count, entries.length); i++) {
        localStorage.removeItem(entries[i].key);
    }
}

/** Get cache stats for debug panel */
export function apiCacheStats(): { provider: string; count: number; oldestAge: string }[] {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return [];
    const stats = new Map<string, { count: number; oldest: number }>();

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const provider = parsed.provider || 'unknown';
            const existing = stats.get(provider) || { count: 0, oldest: Infinity };
            existing.count++;
            existing.oldest = Math.min(existing.oldest, parsed.storedAt || 0);
            stats.set(provider, existing);
        } catch (e) {
            log.warn('[apiCache] skip:', e);
        }
    }

    return Array.from(stats.entries()).map(([provider, { count, oldest }]) => ({
        provider,
        count,
        oldestAge: oldest === Infinity ? 'n/a' : `${Math.round((Date.now() - oldest) / 60000)}m`,
    }));
}
