/**
 * Proxy — Generic fetch-through-cache middleware.
 *
 * Every external API call follows the same pattern:
 *   1. Check local cache → serve if fresh
 *   2. Cache stale or missing → fetch from upstream (Supabase Edge Function or direct URL)
 *   3. Store response in cache with TTL
 *   4. If fetch fails and we have stale data → serve stale (better than nothing at sea)
 *
 * Two variants:
 *   - cachedJsonProxy: for JSON API responses (kv_cache table)
 *   - cachedTileProxy: for binary tile data (tile_cache table)
 */

import { Cache } from './cache.js';

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
}

/**
 * Fetch JSON through the cache layer.
 * Returns { data, fromCache, stale } so the caller can set appropriate headers.
 */
export async function cachedJsonFetch(
    cache: Cache,
    opts: JsonProxyOptions,
): Promise<{ data: unknown; fromCache: boolean; stale: boolean }> {
    // 1. Check cache
    const cached = cache.get(opts.cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return { data: cached.data, fromCache: true, stale: false };
    }

    // 2. Try upstream fetch
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout || 15000);

        const res = await fetch(opts.url, {
            headers: opts.headers || {},
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            throw new Error(`Upstream ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();

        // Don't cache error responses — prevents stale API errors from persisting
        const isError =
            data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            ('error' in (data as Record<string, unknown>) || 'message' in (data as Record<string, unknown>)) &&
            !('extremes' in (data as Record<string, unknown>)) && // Tide data can have metadata alongside
            !('hourly' in (data as Record<string, unknown>)) && // Weather data
            !('current' in (data as Record<string, unknown>)); // Current conditions

        if (!isError) {
            cache.set(opts.cacheKey, data, opts.ttlMs, opts.source);
        } else {
            console.warn(`⚠️ Skipping cache for ${opts.cacheKey}: response looks like an error`);
        }

        return { data, fromCache: false, stale: false };
    } catch (err) {
        // 3. Fetch failed — serve stale if we have it
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
 */
export async function cachedTileFetch(
    cache: Cache,
    opts: TileProxyOptions,
): Promise<{ data: Buffer; contentType: string; fromCache: boolean; stale: boolean }> {
    // 1. Check cache
    const cached = cache.getTile(opts.cacheKey);
    if (cached && cache.hasFreshTile(opts.cacheKey)) {
        return { ...cached, fromCache: true, stale: false };
    }

    // 2. Try upstream fetch
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout || 10000);

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
        // 3. Fetch failed — serve stale tile
        if (cached) {
            console.warn(`⚡ Serving stale tile for ${opts.cacheKey}: ${(err as Error).message}`);
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
