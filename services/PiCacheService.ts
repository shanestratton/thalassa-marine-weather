/**
 * PiCacheService — Discovers and routes requests through the boat's Pi Cache server.
 *
 * When enabled in settings, this service intercepts all external API calls and
 * routes them through the local Raspberry Pi cache instead of directly to
 * Supabase Edge Functions or external APIs. This gives:
 *
 *   1. Instant responses from locally cached data (no internet latency)
 *   2. Stale-while-revalidate when the Pi has cached but expired data
 *   3. Automatic fallback to direct API calls if the Pi is unreachable
 *
 * Discovery: The service pings the Pi at the configured host:port on startup
 * and periodically checks if it's still alive.
 *
 * Usage:
 *   - Import { piCache } from this module
 *   - Call piCache.fetch('/api/weather/current', { lat, lon }) instead of direct fetch
 *   - The service handles routing, fallback, and caching headers
 */

import { CapacitorHttp } from '@capacitor/core';

// ── Types ──

export interface PiCacheConfig {
    enabled: boolean;
    host: string;
    port: number;
}

export interface PiCacheStatus {
    reachable: boolean;
    lastCheck: number;
    latencyMs: number;
    cacheStats?: {
        kvEntries: number;
        tileEntries: number;
        kvFresh: number;
        tileFresh: number;
        dbSizeMB: number;
    };
}

interface FetchResult<T = unknown> {
    data: T;
    source: 'pi-cache' | 'pi-stale' | 'direct';
    latencyMs: number;
}

// ── Singleton ──

class PiCacheServiceImpl {
    private config: PiCacheConfig = { enabled: false, host: 'raspberrypi.local', port: 3001 };
    private status: PiCacheStatus = { reachable: false, lastCheck: 0, latencyMs: 0 };
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

    /** Update config from UserSettings. Called when settings change. */
    configure(config: Partial<PiCacheConfig>): void {
        const wasEnabled = this.config.enabled;
        this.config = { ...this.config, ...config };

        if (this.config.enabled && !wasEnabled) {
            this.startHealthChecks();
        } else if (!this.config.enabled && wasEnabled) {
            this.stopHealthChecks();
            this.status = { reachable: false, lastCheck: 0, latencyMs: 0 };
        }
    }

    /** Get the current status of the Pi Cache connection. */
    getStatus(): PiCacheStatus {
        return { ...this.status };
    }

    /** Check if the Pi Cache is enabled and reachable. */
    isAvailable(): boolean {
        return this.config.enabled && this.status.reachable;
    }

    /** Base URL for the Pi Cache server. */
    private get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    // ── Health Check ──

    private async checkHealth(): Promise<boolean> {
        if (!this.config.enabled) return false;

        const start = Date.now();
        try {
            // Try CapacitorHttp first (native), then fetch (web/dev)
            let data: { status: string; cache?: PiCacheStatus['cacheStats'] };
            try {
                const res = await CapacitorHttp.get({
                    url: `${this.baseUrl}/status`,
                    connectTimeout: 3000,
                    readTimeout: 3000,
                });
                data = res.data;
            } catch {
                const res = await fetch(`${this.baseUrl}/status`, {
                    signal: AbortSignal.timeout(3000),
                });
                data = await res.json();
            }

            this.status = {
                reachable: data?.status === 'ok',
                lastCheck: Date.now(),
                latencyMs: Date.now() - start,
                cacheStats: data?.cache as PiCacheStatus['cacheStats'],
            };
            return this.status.reachable;
        } catch {
            this.status = {
                reachable: false,
                lastCheck: Date.now(),
                latencyMs: Date.now() - start,
            };
            return false;
        }
    }

    private startHealthChecks(): void {
        this.checkHealth(); // Immediate check
        this.healthCheckInterval = setInterval(() => this.checkHealth(), 30_000); // Every 30s
    }

    private stopHealthChecks(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    // ── Data Fetching ──

    /**
     * Fetch JSON data through the Pi Cache.
     * Falls back to the provided directFetch function if the Pi is unreachable.
     *
     * @param piPath — Pi cache API path, e.g., '/api/weather/current'
     * @param params — Query parameters
     * @param directFetch — Fallback function to call the API directly
     */
    async fetch<T = unknown>(
        piPath: string,
        params: Record<string, string | number>,
        directFetch: () => Promise<T>,
    ): Promise<FetchResult<T>> {
        // If Pi Cache is disabled or unreachable, go direct
        if (!this.isAvailable()) {
            const start = Date.now();
            const data = await directFetch();
            return { data, source: 'direct', latencyMs: Date.now() - start };
        }

        // Build Pi Cache URL
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            qs.set(k, String(v));
        }
        const url = `${this.baseUrl}${piPath}?${qs.toString()}`;

        const start = Date.now();
        try {
            let responseData: T;
            let cacheHeader = '';

            try {
                // Try CapacitorHttp (native)
                const res = await CapacitorHttp.get({
                    url,
                    connectTimeout: 5000,
                    readTimeout: 10000,
                });
                responseData = res.data as T;
                cacheHeader = res.headers?.['x-cache'] || res.headers?.['X-Cache'] || '';
            } catch {
                // Fallback to browser fetch
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (!res.ok) throw new Error(`Pi Cache ${res.status}`);
                responseData = (await res.json()) as T;
                cacheHeader = res.headers.get('x-cache') || '';
            }

            const source = cacheHeader === 'STALE' ? 'pi-stale' : 'pi-cache';
            return { data: responseData, source, latencyMs: Date.now() - start };
        } catch {
            // Pi failed — fall back to direct API
            console.warn(`⚡ Pi Cache failed for ${piPath}, falling back to direct API`);
            const data = await directFetch();
            return { data, source: 'direct', latencyMs: Date.now() - start };
        }
    }

    /**
     * Fetch a tile URL through the Pi Cache.
     * Returns the proxied tile URL, or the original URL if Pi is unavailable.
     *
     * Used by map tile layers to redirect tile requests through the Pi.
     */
    getTileUrl(piPath: string, originalUrl: string): string {
        if (!this.isAvailable()) return originalUrl;
        return `${this.baseUrl}${piPath}`;
    }

    /**
     * Build a tile URL template for Mapbox GL sources.
     * e.g., piCache.tileUrlTemplate('/api/tiles/openseamap/{z}/{x}/{y}', originalTemplate)
     */
    tileUrlTemplate(piTemplate: string, originalTemplate: string): string {
        if (!this.isAvailable()) return originalTemplate;
        return `${this.baseUrl}${piTemplate}`;
    }

    /**
     * Trigger a manual cache purge on the Pi.
     */
    async purgeCache(): Promise<{ kvDeleted: number; tileDeleted: number } | null> {
        if (!this.isAvailable()) return null;

        try {
            let data: { purged: { kvDeleted: number; tileDeleted: number } };
            try {
                const res = await CapacitorHttp.post({ url: `${this.baseUrl}/cache/purge` });
                data = res.data;
            } catch {
                const res = await fetch(`${this.baseUrl}/cache/purge`, { method: 'POST' });
                data = await res.json();
            }
            return data?.purged || null;
        } catch {
            return null;
        }
    }

    /** Force a health check right now. */
    async ping(): Promise<PiCacheStatus> {
        await this.checkHealth();
        return this.getStatus();
    }
}

/** Singleton Pi Cache service instance. */
export const piCache = new PiCacheServiceImpl();
