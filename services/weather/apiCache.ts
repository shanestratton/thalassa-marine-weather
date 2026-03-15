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
 * All caches are keyed by rounded lat/lon (0.1° ≈ 11km) to prevent
 * GPS jitter from causing separate cache misses.
 */

// ── Cache TTLs (milliseconds) ─────────────────────────────────

const TTL = {
    worldtides: 24 * 60 * 60 * 1000, // 24 hours — predictions are deterministic
    stormglass: 3 * 60 * 60 * 1000, //  3 hours — catches every 6h model cycle
    weatherkit: 15 * 60 * 1000, // 15 minutes — Apple refreshes frequently
    openmeteo: 30 * 60 * 1000, // 30 minutes — free, but still polite
    noaa_gfs: 3 * 60 * 60 * 1000, //  3 hours — same as StormGlass
    tides: 24 * 60 * 60 * 1000, // 24 hours — parsed tide extremes
} as const;

export type ApiCacheProvider = keyof typeof TTL;

// ── Location Key ──────────────────────────────────────────────

const CACHE_PREFIX = 'thalassa_apicache_v1_';

/** Round to 0.1° to coalesce nearby coordinates (~11km grid) */
function locationKey(lat: number, lon: number): string {
    return `${(Math.round(lat * 10) / 10).toFixed(1)}_${(Math.round(lon * 10) / 10).toFixed(1)}`;
}

function cacheKey(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): string {
    const base = `${CACHE_PREFIX}${provider}_${locationKey(lat, lon)}`;
    return extra ? `${base}_${extra}` : base;
}

// ── Core Cache Operations ─────────────────────────────────────

interface CacheEntry<T> {
    data: T;
    storedAt: number;
    provider: string;
}

/**
 * Get cached API response. Returns null if expired or missing.
 */
export function apiCacheGet<T>(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): T | null {
    try {
        const key = cacheKey(provider, lat, lon, extra);
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        const entry: CacheEntry<T> = JSON.parse(raw);
        const ageMs = Date.now() - entry.storedAt;
        const ttl = TTL[provider];

        if (ageMs > ttl) {
            localStorage.removeItem(key);
            return null;
        }

        const ageMin = Math.round(ageMs / 60000);
        const ttlMin = Math.round(ttl / 60000);
        return entry.data;
    } catch (e) {
        console.warn('[apiCache]', e);
        return null;
    }
}

/**
 * Store an API response in cache.
 */
export function apiCacheSet<T>(provider: ApiCacheProvider, lat: number, lon: number, data: T, extra?: string): void {
    try {
        const key = cacheKey(provider, lat, lon, extra);
        const entry: CacheEntry<T> = {
            data,
            storedAt: Date.now(),
            provider,
        };
        localStorage.setItem(key, JSON.stringify(entry));
    } catch (e) {
        console.warn('[apiCache]', e);
        // localStorage full — evict oldest entries
        evictOldest(3);
        try {
            const key = cacheKey(provider, lat, lon, extra);
            localStorage.setItem(
                key,
                JSON.stringify({
                    data,
                    storedAt: Date.now(),
                    provider,
                }),
            );
        } catch (e) {
            console.warn('[apiCache]', e);
            // Still full — give up silently
        }
    }
}

/**
 * Invalidate cache for a specific provider + location.
 */
export function apiCacheInvalidate(provider: ApiCacheProvider, lat: number, lon: number, extra?: string): void {
    const key = cacheKey(provider, lat, lon, extra);
    localStorage.removeItem(key);
}

// ── Housekeeping ──────────────────────────────────────────────

/** Evict N oldest cache entries to free space */
function evictOldest(count: number): void {
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
            console.warn('[apiCache] skip corrupt:', e);
        }
    }

    entries.sort((a, b) => a.storedAt - b.storedAt);
    for (let i = 0; i < Math.min(count, entries.length); i++) {
        localStorage.removeItem(entries[i].key);
    }
}

/** Get cache stats for debug panel */
export function apiCacheStats(): { provider: string; count: number; oldestAge: string }[] {
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
            console.warn('[apiCache] skip:', e);
        }
    }

    return Array.from(stats.entries()).map(([provider, { count, oldest }]) => ({
        provider,
        count,
        oldestAge: oldest === Infinity ? 'n/a' : `${Math.round((Date.now() - oldest) / 60000)}m`,
    }));
}
