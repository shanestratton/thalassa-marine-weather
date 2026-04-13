/**
 * PiCacheService — Auto-discovers and routes requests through the boat's Pi Cache.
 *
 * The skipper runs `install.sh` on their Pi and that's it. This service:
 *
 *   1. Auto-discovers the Pi on the local network (tries common hostnames)
 *   2. Routes weather/tide/GRIB/satellite requests through the Pi cache
 *   3. Falls back to direct API calls transparently if the Pi is unreachable
 *   4. Periodically health-checks to track Pi availability
 *
 * Skipper-only feature (requires 'owner' subscription tier).
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
    piIp?: string;
    discoveredVia?: string;
    cacheStats?: {
        kvEntries: number;
        tileEntries: number;
        kvFresh: number;
        tileFresh: number;
        dbSizeMB: number;
    };
}

export interface FetchResult<T = unknown> {
    data: T;
    source: 'pi-cache' | 'pi-stale' | 'direct';
    latencyMs: number;
}

// ── Discovery candidates ──
// Ordered by likelihood — skip the rest as soon as one works.
const DISCOVERY_HOSTS = [
    'raspberrypi.local', // Default Pi mDNS hostname
    'thalassa.local', // If they renamed it
    'pi.local', // Common shortname
    'thalassa-cache.local', // If they used our suggested hostname
];

// ── Singleton ──

class PiCacheServiceImpl {
    private config: PiCacheConfig = { enabled: false, host: '', port: 3001 };
    private status: PiCacheStatus = { reachable: false, lastCheck: 0, latencyMs: 0 };
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
    private discoveryListeners: Array<(status: PiCacheStatus) => void> = [];

    // ── Configuration ──

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

    /** Get the current Pi Cache status. */
    getStatus(): PiCacheStatus {
        return { ...this.status };
    }

    /** Is the Pi Cache enabled AND reachable right now? */
    isAvailable(): boolean {
        return this.config.enabled && this.status.reachable;
    }

    /** Base URL for the Pi Cache server. */
    get baseUrl(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    // ── Auto-Discovery ──

    /**
     * Scan for a Pi Cache server on the local network.
     * Tries common hostnames, returns the first one that responds.
     * Called automatically when enabled with no host configured.
     */
    async discover(): Promise<PiCacheStatus> {
        const candidates = [...DISCOVERY_HOSTS];

        // If the user already set a host, try that first
        if (this.config.host && !candidates.includes(this.config.host)) {
            candidates.unshift(this.config.host);
        }

        for (const host of candidates) {
            const url = `http://${host}:${this.config.port}/health`;
            const start = Date.now();

            try {
                let ok = false;
                try {
                    const res = await CapacitorHttp.get({
                        url,
                        connectTimeout: 2000,
                        readTimeout: 2000,
                    });
                    ok = res.data?.status === 'ok' && res.data?.service === 'thalassa-pi-cache';
                } catch {
                    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
                    const data = await res.json();
                    ok = data?.status === 'ok' && data?.service === 'thalassa-pi-cache';
                }

                if (ok) {
                    this.config.host = host;
                    this.status = {
                        reachable: true,
                        lastCheck: Date.now(),
                        latencyMs: Date.now() - start,
                        discoveredVia: host,
                    };

                    // Now get full status with cache stats
                    await this.checkHealth();
                    this.notifyListeners();
                    return this.status;
                }
            } catch {
                // This host didn't respond — try next
            }
        }

        // Nothing found
        this.status = { reachable: false, lastCheck: Date.now(), latencyMs: 0 };
        return this.status;
    }

    /**
     * Register a callback for when Pi is discovered/lost.
     * Used by the settings UI to update status in real-time.
     */
    onStatusChange(listener: (status: PiCacheStatus) => void): () => void {
        this.discoveryListeners.push(listener);
        return () => {
            this.discoveryListeners = this.discoveryListeners.filter((l) => l !== listener);
        };
    }

    private notifyListeners(): void {
        const s = this.getStatus();
        this.discoveryListeners.forEach((l) => l(s));
    }

    // ── Health Check ──

    private async checkHealth(): Promise<boolean> {
        if (!this.config.enabled || !this.config.host) return false;

        const start = Date.now();
        try {
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

            const wasReachable = this.status.reachable;
            this.status = {
                ...this.status,
                reachable: data?.status === 'ok',
                lastCheck: Date.now(),
                latencyMs: Date.now() - start,
                cacheStats: data?.cache as PiCacheStatus['cacheStats'],
            };

            // Notify if status changed
            if (wasReachable !== this.status.reachable) {
                this.notifyListeners();
            }
            return this.status.reachable;
        } catch {
            const wasReachable = this.status.reachable;
            this.status = {
                ...this.status,
                reachable: false,
                lastCheck: Date.now(),
                latencyMs: Date.now() - start,
            };
            if (wasReachable) this.notifyListeners();
            return false;
        }
    }

    private startHealthChecks(): void {
        // If no host configured, run discovery first
        if (!this.config.host) {
            this.discover().then(() => {
                if (this.status.reachable) {
                    this.healthCheckInterval = setInterval(() => this.checkHealth(), 30_000);
                }
            });
        } else {
            this.checkHealth();
            this.healthCheckInterval = setInterval(() => this.checkHealth(), 30_000);
        }
    }

    private stopHealthChecks(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    // ── Data Fetching ──

    /**
     * Fetch JSON through the Pi Cache, with transparent fallback.
     *
     * @param piPath  — Pi endpoint path, e.g., '/api/weather/current'
     * @param params  — Query parameters
     * @param directFetch — Fallback: call the API directly if Pi is down
     */
    async fetch<T = unknown>(
        piPath: string,
        params: Record<string, string | number>,
        directFetch: () => Promise<T>,
    ): Promise<FetchResult<T>> {
        if (!this.isAvailable()) {
            const start = Date.now();
            const data = await directFetch();
            return { data, source: 'direct', latencyMs: Date.now() - start };
        }

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
                const res = await CapacitorHttp.get({
                    url,
                    connectTimeout: 5000,
                    readTimeout: 10000,
                });
                responseData = res.data as T;
                cacheHeader = res.headers?.['x-cache'] || res.headers?.['X-Cache'] || '';
            } catch {
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (!res.ok) throw new Error(`Pi Cache ${res.status}`);
                responseData = (await res.json()) as T;
                cacheHeader = res.headers.get('x-cache') || '';
            }

            const source = cacheHeader === 'STALE' ? 'pi-stale' : 'pi-cache';
            return { data: responseData, source, latencyMs: Date.now() - start };
        } catch {
            // Pi hiccup — fall back silently
            const data = await directFetch();
            return { data, source: 'direct', latencyMs: Date.now() - start };
        }
    }

    // ── Tile URL Routing ──

    /**
     * Swap a tile URL template to route through the Pi.
     * Returns the original template if Pi is unavailable.
     *
     * @example
     *   piCache.tileUrl('/api/tiles/openseamap/{z}/{x}/{y}',
     *                   'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png')
     */
    tileUrl(piTemplate: string, originalTemplate: string): string {
        if (!this.isAvailable()) return originalTemplate;
        return `${this.baseUrl}${piTemplate}`;
    }

    // ── Passthrough Proxy (the magic one) ──

    /**
     * Route any URL through the Pi Cache's generic passthrough.
     * Returns a Pi-proxied URL, or null if Pi is unavailable.
     *
     * The Pi fetches the URL, caches the response in SQLite, and returns it.
     * Next time, the response comes straight from the Pi's disk — zero internet.
     *
     * @param originalUrl — The full URL the app would normally fetch
     * @param ttlMs — Cache TTL in milliseconds (default: 15 min)
     * @param source — Label for debugging (e.g., 'open-meteo')
     */
    passthroughUrl(originalUrl: string, ttlMs = 900_000, source = 'passthrough'): string | null {
        if (!this.isAvailable()) return null;
        const params = new URLSearchParams({
            url: originalUrl,
            ttl: String(ttlMs),
            source,
        });
        return `${this.baseUrl}/api/passthrough?${params.toString()}`;
    }

    /**
     * Route a tile URL through the Pi Cache's tile passthrough.
     */
    passthroughTileUrl(originalUrl: string, ttlMs = 1_800_000): string | null {
        if (!this.isAvailable()) return null;
        const params = new URLSearchParams({
            url: originalUrl,
            ttl: String(ttlMs),
            ct: 'image/png',
        });
        return `${this.baseUrl}/api/passthrough-tile?${params.toString()}`;
    }

    // ── Maintenance ──

    /** Purge expired entries on the Pi. */
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
        if (!this.config.host) {
            return this.discover();
        }
        await this.checkHealth();
        return this.getStatus();
    }

    // ── App → Pi Configuration Push ──

    /**
     * Push Supabase credentials and pre-fetch location to the Pi.
     * Called once after discovery so the Pi can run pre-fetch jobs.
     * The skipper never sees or types these — the app sends them automatically.
     */
    async pushConfig(config: {
        supabaseUrl: string;
        supabaseAnonKey: string;
        prefetchLat?: number;
        prefetchLon?: number;
        prefetchRadius?: number;
    }): Promise<boolean> {
        if (!this.isAvailable()) return false;

        try {
            try {
                await CapacitorHttp.post({
                    url: `${this.baseUrl}/api/configure`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(config),
                });
            } catch {
                await fetch(`${this.baseUrl}/api/configure`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config),
                });
            }
            return true;
        } catch {
            return false;
        }
    }
}

/** Singleton — import this everywhere. */
export const piCache = new PiCacheServiceImpl();
