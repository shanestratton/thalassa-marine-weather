/**
 * Proxy — Generic fetch-through-cache middleware with stale-while-revalidate.
 *
 * Pattern (SWR):
 *   1. Fresh hit (within TTL)          → serve from cache, no upstream call
 *   2. Stale hit (within stale window) → serve from cache IMMEDIATELY, refresh
 *                                        upstream in the background
 *   3. Expired (beyond stale window)   → block on upstream fetch, then serve
 *   4. Upstream failed, any cache hit  → serve stale (better than nothing at sea)
 *
 * The stale-while-revalidate behavior means clients almost never wait on
 * upstream fetches after the first boot — critical for the "instant opens"
 * experience the Pi is supposed to give the app at sea.
 *
 * Two variants:
 *   - cachedJsonProxy: for JSON API responses (kv_cache table)
 *   - cachedTileProxy: for binary tile data (tile_cache table)
 */

import { Cache } from './cache.js';

/** In-flight upstream requests — deduplicates background revalidation so we
 *  don't stampede the upstream API when many concurrent requests hit a stale
 *  entry simultaneously. Keyed by cacheKey. */
const inFlight = new Map<string, Promise<unknown>>();

/** How long past the TTL we'll serve stale content while revalidating in
 *  background. After this window, we fall back to a blocking fetch. Default
 *  30 min — aligns with the weather staleness window on the client side. */
const DEFAULT_STALE_WINDOW_MS = 30 * 60 * 1000;

export interface ProxyConfig {
    supabaseUrl: string;
    supabaseAnonKey: string;
    openMeteoApiKey?: string;
}

/**
 * Build a commercial Open-Meteo API URL.
 * Uses customer-api.open-meteo.com with the API key appended.
 * Falls back to env var if not in config.
 */
export function openMeteoUrl(config: ProxyConfig, type: 'forecast' | 'marine', params: string): string {
    const key = config.openMeteoApiKey || process.env.OPEN_METEO_API_KEY || '';
    const base =
        type === 'marine'
            ? 'https://customer-marine-api.open-meteo.com/v1/marine'
            : 'https://customer-api.open-meteo.com/v1/forecast';
    return key ? `${base}?${params}&apikey=${key}` : `${base}?${params}`;
}

// ── JSON Proxy ──

interface JsonProxyOptions {
    /** Cache key — usually includes the endpoint + query params */
    cacheKey: string;
    /** Full URL to fetch from */
    url: string;
    /** TTL in milliseconds */
    ttlMs: number;
    /** Source label for debugging (e.g., 'open-meteo', 'worldtides') */
    source: string;
    /** Optional custom headers */
    headers?: Record<string, string>;
    /** Optional request timeout in ms (default: 15000) */
    timeout?: number;
    /** How long past TTL we'll serve stale data while revalidating in the
     *  background. Defaults to 30 min. */
    staleWindowMs?: number;
}

/** Perform the blocking upstream fetch and write to cache. Used both for
 *  cold loads (no cache) and for background revalidation of stale entries. */
async function fetchAndCache(cache: Cache, opts: JsonProxyOptions): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 15000);
    try {
        const res = await fetch(opts.url, {
            headers: opts.headers || {},
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
        const data = await res.json();

        // Don't cache error responses — prevents stale API errors from persisting.
        const isError =
            data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            ('error' in (data as Record<string, unknown>) || 'message' in (data as Record<string, unknown>)) &&
            !('extremes' in (data as Record<string, unknown>)) && // Tide data
            !('hourly' in (data as Record<string, unknown>)) && // Weather
            !('current' in (data as Record<string, unknown>)); // Current conditions

        if (!isError) {
            cache.set(opts.cacheKey, data, opts.ttlMs, opts.source);
        } else {
            console.warn(`⚠️ Skipping cache for ${opts.cacheKey}: response looks like an error`);
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/** Fire a background revalidation (deduplicated per cacheKey). Errors are
 *  swallowed — the stale data has already been served to the client. */
function revalidateInBackground(cache: Cache, opts: JsonProxyOptions): void {
    if (inFlight.has(opts.cacheKey)) return; // Already revalidating.
    const p = fetchAndCache(cache, opts)
        .catch((err) => {
            console.warn(`⚡ Background revalidation failed for ${opts.cacheKey}: ${(err as Error).message}`);
        })
        .finally(() => {
            inFlight.delete(opts.cacheKey);
        });
    inFlight.set(opts.cacheKey, p);
}

/**
 * Fetch JSON through the cache layer with stale-while-revalidate semantics.
 *
 * Returns `{ data, fromCache, stale }`:
 *   - Fresh hit:   fromCache=true,  stale=false  (no upstream call)
 *   - Stale hit:   fromCache=true,  stale=true   (upstream refresh in background)
 *   - Cold/expired: fromCache=false, stale=false (blocking upstream fetch)
 *   - Upstream down but cache exists: fromCache=true, stale=true
 */
export async function cachedJsonFetch(
    cache: Cache,
    opts: JsonProxyOptions,
): Promise<{ data: unknown; fromCache: boolean; stale: boolean }> {
    const now = Date.now();
    const cached = cache.get(opts.cacheKey);
    const staleWindow = opts.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;

    // 1. Fresh hit — serve instantly, no upstream call.
    if (cached && cached.expiresAt > now) {
        return { data: cached.data, fromCache: true, stale: false };
    }

    // 2. Stale hit (within stale window) — serve stale IMMEDIATELY, revalidate
    //    in background. This is the SWR fast path that makes the app instant
    //    when the Pi has any recent cache, even if the TTL has ticked over.
    if (cached && cached.expiresAt > now - staleWindow) {
        revalidateInBackground(cache, opts);
        return { data: cached.data, fromCache: true, stale: true };
    }

    // 3. No cache or stale past the window — block on upstream fetch.
    //    Dedupe concurrent requests for the same key so we don't stampede
    //    upstream when the dashboard mounts and 3 simultaneous boot fetches
    //    all want the same endpoint.
    try {
        let promise = inFlight.get(opts.cacheKey) as Promise<unknown> | undefined;
        if (!promise) {
            promise = fetchAndCache(cache, opts).finally(() => {
                inFlight.delete(opts.cacheKey);
            });
            inFlight.set(opts.cacheKey, promise);
        }
        const data = await promise;
        return { data, fromCache: false, stale: false };
    } catch (err) {
        // 4. Fetch failed — serve whatever stale data we still have.
        if (cached) {
            console.warn(`⚡ Serving stale cache for ${opts.cacheKey}: ${(err as Error).message}`);
            return { data: cached.data, fromCache: true, stale: true };
        }
        throw err;
    }
}

// ── Tile Proxy ──

interface TileProxyOptions {
    /** Cache key — usually `{source}/{z}/{x}/{y}` */
    cacheKey: string;
    /** Full tile URL to fetch from */
    url: string;
    /** Expected content type (e.g., 'image/png') */
    contentType: string;
    /** TTL in milliseconds */
    ttlMs: number;
    /** Optional custom headers */
    headers?: Record<string, string>;
    /** Optional request timeout in ms (default: 10000) */
    timeout?: number;
}

/**
 * Fetch a binary tile through the cache layer.
 * Returns the raw Buffer and content type.
 *
 * Uses a stale-while-revalidate strategy when a stale tile is available:
 * respond with the stale tile IMMEDIATELY and fire the upstream refresh
 * in the background. This is the key UX win for slow upstreams (e.g.
 * OWM's `clouds_new` endpoint, which has been measured at 5-7s). Without
 * SWR, every toggle paid full upstream latency even when the Pi already
 * had a tile from 20 min ago — the user's device sat on a white map.
 *
 * TTL ordering:
 *   - Within ttlMs: serve fresh cache instantly.
 *   - TTL expired but within staleWindowMs: serve stale + revalidate.
 *   - Outside stale window: block on upstream (reduced timeout → fast
 *     failure mode so we don't hang the client for 10s).
 */
const TILE_STALE_WINDOW_MS = 60 * 60 * 1000; // 1h — tiles change slowly
const tileInflight = new Map<string, Promise<void>>();

function revalidateTileInBackground(cache: Cache, opts: TileProxyOptions): void {
    if (tileInflight.has(opts.cacheKey)) return;
    const p = (async () => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), opts.timeout || 5000);
            const res = await fetch(opts.url, {
                headers: opts.headers || {},
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`Tile upstream ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            const data = Buffer.from(arrayBuffer);
            const contentType = res.headers.get('content-type') || opts.contentType;
            cache.setTile(opts.cacheKey, data, contentType, opts.ttlMs);
        } catch (err) {
            console.warn(`⚡ Background tile revalidation failed for ${opts.cacheKey}: ${(err as Error).message}`);
        } finally {
            tileInflight.delete(opts.cacheKey);
        }
    })();
    tileInflight.set(opts.cacheKey, p);
}

export async function cachedTileFetch(
    cache: Cache,
    opts: TileProxyOptions,
): Promise<{ data: Buffer; contentType: string; fromCache: boolean; stale: boolean }> {
    // 1. Fresh cache — serve instantly.
    const cached = cache.getTile(opts.cacheKey);
    if (cached && cache.hasFreshTile(opts.cacheKey)) {
        return { ...cached, fromCache: true, stale: false };
    }

    // 2. SWR fast-path — stale tile within the stale window. Return NOW,
    //    refresh in background so the next client request gets fresh data.
    //    This is what fixes the "clouds takes 7s to show" symptom: even a
    //    20-min-old tile is indistinguishable from fresh at typical sea
    //    zoom levels, and shipping it instantly beats waiting for OWM.
    if (cached) {
        const cachedMeta = cache.getTileMeta?.(opts.cacheKey);
        const age = cachedMeta ? Date.now() - cachedMeta.storedAt : Infinity;
        if (age < opts.ttlMs + TILE_STALE_WINDOW_MS) {
            revalidateTileInBackground(cache, opts);
            return { ...cached, fromCache: true, stale: true };
        }
    }

    // 3. Cold or past stale window — block on upstream. Shortened the
    //    default timeout from 10s → 5s so a truly dead upstream fails
    //    quickly instead of hanging the client through the old 10s ceiling.
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout || 5000);

        const res = await fetch(opts.url, {
            headers: opts.headers || {},
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            throw new Error(`Tile upstream ${res.status}: ${res.statusText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const data = Buffer.from(arrayBuffer);
        const contentType = res.headers.get('content-type') || opts.contentType;

        cache.setTile(opts.cacheKey, data, contentType, opts.ttlMs);
        return { data, contentType, fromCache: false, stale: false };
    } catch (err) {
        // 4. Fetch failed outside stale window — last resort, serve any
        //    ancient cached version we still have rather than error.
        if (cached) {
            console.warn(`⚡ Serving ancient stale tile for ${opts.cacheKey}: ${(err as Error).message}`);
            return { ...cached, fromCache: true, stale: true };
        }
        throw err;
    }
}

// ── Binary POST Fetch (e.g. GRIB2 wind grids from Supabase) ──

interface BinaryPostOptions {
    /** Cache key — include the request body so different bounds don't collide. */
    cacheKey: string;
    /** Full URL to fetch from */
    url: string;
    /** Expected content type (default: 'application/octet-stream') */
    contentType?: string;
    /** TTL in milliseconds */
    ttlMs: number;
    /** POST body (JSON-serialisable object) */
    body: unknown;
    /** Optional custom headers */
    headers?: Record<string, string>;
    /** Optional request timeout in ms (default: 30000 — GRIB can be slow) */
    timeout?: number;
}

/**
 * POST a JSON body, cache the binary response. Used for GFS GRIB grids where
 * the Supabase edge function expects a bounding-box POST and returns a binary
 * GRIB2 buffer. Reuses the tile-cache storage (same Buffer shape) for LRU
 * eviction + TTL-based staleness.
 */
export async function cachedBinaryPost(
    cache: Cache,
    opts: BinaryPostOptions,
): Promise<{ data: Buffer; contentType: string; fromCache: boolean; stale: boolean }> {
    const cached = cache.getTile(opts.cacheKey);
    if (cached && cache.hasFreshTile(opts.cacheKey)) {
        return { ...cached, fromCache: true, stale: false };
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout || 30000);

        const res = await fetch(opts.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(opts.headers || {}),
            },
            body: JSON.stringify(opts.body),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            throw new Error(`Binary POST upstream ${res.status}: ${res.statusText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const data = Buffer.from(arrayBuffer);
        const contentType = res.headers.get('content-type') || opts.contentType || 'application/octet-stream';

        cache.setTile(opts.cacheKey, data, contentType, opts.ttlMs);
        return { data, contentType, fromCache: false, stale: false };
    } catch (err) {
        if (cached) {
            console.warn(`⚡ Serving stale binary for ${opts.cacheKey}: ${(err as Error).message}`);
            return { ...cached, fromCache: true, stale: true };
        }
        throw err;
    }
}

// ── Supabase Edge Function Helper ──

/**
 * Build the full URL for a Supabase Edge Function.
 * e.g., supabaseEdgeUrl(config, 'weather', { lat: -36.84, lon: 174.76 })
 *   → https://xxx.supabase.co/functions/v1/weather?lat=-36.84&lon=174.76
 */
export function supabaseEdgeUrl(
    config: ProxyConfig,
    functionName: string,
    params?: Record<string, string | number | boolean>,
): string {
    const base = `${config.supabaseUrl}/functions/v1/${functionName}`;
    if (!params) return base;

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        qs.set(k, String(v));
    }
    return `${base}?${qs.toString()}`;
}

/**
 * Default headers for Supabase Edge Function requests.
 */
export function supabaseHeaders(config: ProxyConfig): Record<string, string> {
    return {
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        apikey: config.supabaseAnonKey,
    };
}
