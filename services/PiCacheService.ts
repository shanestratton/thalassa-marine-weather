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
import { LocationStore } from '../stores/LocationStore';
import { resolveHostnameIpv4 } from '../utils/resolveHostnameIpv4';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PiCacheService');

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
    /**
     * Whether the Pi has Supabase credentials loaded right now. Comes from
     * `/status` → `config.supabaseConfigured`. When `false`, weather/wind-grid
     * proxies on the Pi will 502, so the app should re-push config — see
     * autoReconcileConfigIfNeeded().
     */
    supabaseConfigured?: boolean;
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

/** Reactive fetch stats — tracks how data is being served. */
export interface PiFetchStats {
    /** Last source used for a weather/data fetch */
    lastSource: 'pi-cache' | 'pi-stale' | 'direct' | null;
    /** Timestamp of last Pi-served fetch */
    lastPiServedAt: number;
    /** Cumulative: requests served from Pi this session */
    piHits: number;
    /** Cumulative: requests that fell back to direct this session */
    directHits: number;
}

// ── Discovery candidates ──
// Ordered by likelihood — skip the rest as soon as one works.
const DISCOVERY_HOSTS = [
    'calypso.local', // Shane's renamed Pi (boat-named after the yacht)
    'openplotter.local', // OpenPlotter default hostname
    'raspberrypi.local', // Default Pi mDNS hostname
    'thalassa.local', // If they renamed it
    'bosun.local', // Bosun-branded Pi (older Shane setup)
    'pi.local', // Common shortname
    'thalassa-cache.local', // If they used our suggested hostname
];

// ── Singleton ──

class PiCacheServiceImpl {
    private config: PiCacheConfig = { enabled: false, host: '', port: 3001 };
    private status: PiCacheStatus = { reachable: false, lastCheck: 0, latencyMs: 0 };
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
    private retryBurstTimer: ReturnType<typeof setTimeout> | null = null;
    private discoveryListeners: Array<(status: PiCacheStatus) => void> = [];
    private locationUnsub: (() => void) | null = null;
    private foregroundListenersInstalled = false;

    // ── Fetch Stats ──
    private _fetchStats: PiFetchStats = {
        lastSource: null,
        lastPiServedAt: 0,
        piHits: 0,
        directHits: 0,
    };

    // ── Location Push (debounced) ──
    private lastPushedLat = 0;
    private lastPushedLon = 0;
    private lastPushTime = 0;

    // ── Ready Promise ──
    //
    // Resolves after the FIRST health check or discovery attempt completes —
    // regardless of outcome. Weather fetchers await this (with a short cap)
    // before deciding Pi-vs-direct, so a cold boot race can't make them fall
    // through to the network while the Pi check is still in flight.
    private _firstCheckDone: Promise<void> | null = null;
    private _markFirstCheckDone: (() => void) | null = null;

    // ── Adaptive-skip state ──
    // Counts how many consecutive fetches have seen Pi unreachable. After
    // a threshold we skip the ready-wait entirely — the punter is clearly
    // off the Pi's LAN (ashore, another marina, coffee shop), so paying
    // 1.5s per fetch to wait for a health check that'll never succeed is
    // pure cost. A successful health check resets the counter instantly.
    private _consecutiveMisses = 0;
    private static readonly MISS_SKIP_THRESHOLD = 3;

    // Timestamp of the last successful Pi reach, persisted to localStorage
    // so we remember across cold starts. If we haven't seen the Pi in > 24h,
    // skip the boot race gate entirely — the user is clearly away from the
    // boat's network and paying 1.5s per cold start for a Pi that isn't
    // going to answer is exactly the "slow startup" complaint we need to fix.
    private static readonly LAST_SEEN_KEY = 'thalassa_pi_last_seen_at';
    private static readonly STALE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

    private initReadyPromise(): void {
        // Idempotent — only create once per enable cycle.
        if (this._firstCheckDone) return;
        this._firstCheckDone = new Promise<void>((resolve) => {
            this._markFirstCheckDone = resolve;
        });
    }

    private resolveReady(): void {
        this._markFirstCheckDone?.();
        this._markFirstCheckDone = null;
    }

    /**
     * Wait for the first Pi health check / discovery attempt to complete.
     *
     * Returns immediately if:
     *   - Pi Cache is disabled (nothing to wait for)
     *   - Pi is already known to be reachable (health check already ran)
     *   - We've missed Pi ≥ 3 times in a row this session
     *   - We haven't successfully reached the Pi in the last 24 hours
     *     (persisted across cold starts — the punter is ashore)
     *
     * Otherwise waits up to `maxMs` (default **500ms** — was 1500ms, but
     * that 1-extra-second was showing up as "the app takes ages to load"
     * on every cold start for users whose Pi was slightly slow. 500ms is
     * more than enough to catch a healthy LAN Pi (50-150ms typical) while
     * keeping the cold-start latency tight for everyone else).
     */
    async awaitReady(maxMs: number = 500): Promise<void> {
        if (!this.config.enabled) return;
        if (this.status.reachable) {
            this._consecutiveMisses = 0; // reset on success
            this._persistLastSeen();
            return;
        }
        if (this._consecutiveMisses >= PiCacheServiceImpl.MISS_SKIP_THRESHOLD) return;
        // Stale-persistence gate — if the last successful Pi contact was
        // more than 24h ago, the user's off the boat's LAN. Skip the wait
        // immediately rather than paying it on every cold start.
        if (this._isPiStale()) return;
        if (!this._firstCheckDone) return;
        const hit = await Promise.race([
            this._firstCheckDone.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), maxMs)),
        ]);
        if (hit && this.status.reachable) {
            this._consecutiveMisses = 0;
            this._persistLastSeen();
        } else {
            this._consecutiveMisses++;
        }
    }

    /** Write "seen now" to localStorage. Called on every successful
     *  health check or fetch so the cross-session cutoff stays fresh. */
    private _persistLastSeen(): void {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(PiCacheServiceImpl.LAST_SEEN_KEY, String(Date.now()));
            }
        } catch {
            /* private mode / disk full — non-critical */
        }
    }

    /** True if we haven't seen the Pi in > 24h (or never). */
    private _isPiStale(): boolean {
        try {
            if (typeof localStorage === 'undefined') return false;
            const raw = localStorage.getItem(PiCacheServiceImpl.LAST_SEEN_KEY);
            if (!raw) return true; // never seen = stale
            const lastSeenAt = parseInt(raw, 10);
            if (!Number.isFinite(lastSeenAt)) return true;
            return Date.now() - lastSeenAt > PiCacheServiceImpl.STALE_CUTOFF_MS;
        } catch {
            return false; // on error, default to "not stale" (preserves old behavior)
        }
    }

    // ── Boot ──

    /**
     * Boot from persisted UserSettings.
     * Called once on app startup (from settingsStore) so the service auto-enables
     * without needing the PiCacheTab UI to be mounted.
     */
    boot(settings: { piCacheEnabled?: boolean; piCacheHost?: string; piCachePort?: number }): void {
        let enabled =
            settings.piCacheEnabled ??
            (typeof localStorage !== 'undefined' && localStorage.getItem('thalassa_pi_cache_enabled') === 'true');
        let host =
            settings.piCacheHost ||
            (typeof localStorage !== 'undefined' && localStorage.getItem('thalassa_pi_cache_host')) ||
            '';
        let port =
            settings.piCachePort ||
            parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('thalassa_pi_cache_port')) || '3001');

        // If the Pi is your ORIGIN, the Pi is your cache. pi-cache serves
        // the whole web app to browsers on the boat LAN
        // (http://calypso.local:3001 — pi-cache/src/server.ts app-dist
        // hosting), and a fresh browser profile there has no settings: the
        // page served BY the Pi couldn't find the Pi and fell back to the
        // bootstrap demo cells. Origin beats persisted config — the user is
        // literally looking at the Pi.
        try {
            if (
                typeof window !== 'undefined' &&
                window.location.protocol === 'http:' &&
                window.location.port === '3001'
            ) {
                enabled = true;
                host = window.location.hostname;
                port = 3001;
            }
        } catch {
            /* exotic environment — persisted config stands */
        }

        if (enabled) {
            this.configure({ enabled: true, host, port });
        }

        // App-foreground / network-online listeners are installed once at boot
        // and live for the app's lifetime. They trigger a fresh ping any time
        // the app comes back into focus or the network reconnects — covers the
        // common case where the user backgrounds the app, returns later, and
        // expects the pi-cache pill to be live immediately rather than waiting
        // up to 30s for the next health-check tick.
        this.installForegroundListeners();
    }

    private installForegroundListeners(): void {
        if (this.foregroundListenersInstalled) return;
        this.foregroundListenersInstalled = true;

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) return;
                if (!this.config.enabled) return;
                // App back in focus — ping immediately so the pill reflects
                // current reality, don't wait for the next 30s interval.
                this.ping().catch(() => {
                    /* ping failures already drive the listener path */
                });
            });
        }

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('online', () => {
                if (!this.config.enabled) return;
                // Network came back — Pi might be reachable again. Ping now.
                this.ping().catch(() => {});
            });
        }
    }

    // ── Configuration ──

    /** Update config from UserSettings. Called when settings change. */
    configure(config: Partial<PiCacheConfig>): void {
        const wasEnabled = this.config.enabled;
        this.config = { ...this.config, ...config };

        if (this.config.enabled && !wasEnabled) {
            this.initReadyPromise();
            this.startHealthChecks();
        } else if (!this.config.enabled && wasEnabled) {
            this.stopHealthChecks();
            this.status = { reachable: false, lastCheck: 0, latencyMs: 0 };
            // Resolve any pending awaitReady() so fetchers don't hang.
            this.resolveReady();
            this._firstCheckDone = null;
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

    /**
     * Build a URL for the Pi's DEDICATED unified-weather endpoint. This is what
     * the scheduler pre-fetches — using it means we hit the scheduler's cache
     * key exactly and get a near-instant HIT on almost every boot.
     *
     * Returns null if the Pi isn't available. Lat/lon are rounded to 2
     * decimals on the server side to match the scheduler; we still pass full
     * precision here so the server round is the single source of truth.
     */
    unifiedWeatherUrl(lat: number, lon: number, userId?: string, minified = false): string | null {
        if (!this.isAvailable()) return null;
        const params = new URLSearchParams({
            lat: String(lat),
            lon: String(lon),
            minified: minified ? '1' : '0',
        });
        if (userId) params.set('user_id', userId);
        return `${this.baseUrl}/api/weather/unified?${params.toString()}`;
    }

    /** Get fetch stats — used by UI to show Pi Cache source indicator. */
    getFetchStats(): PiFetchStats {
        return { ...this._fetchStats };
    }

    /** Record a fetch result for stats tracking. */
    private recordFetch(source: 'pi-cache' | 'pi-stale' | 'direct'): void {
        this._fetchStats.lastSource = source;
        if (source !== 'direct') {
            this._fetchStats.lastPiServedAt = Date.now();
            this._fetchStats.piHits++;
        } else {
            this._fetchStats.directHits++;
        }
    }

    // ── Location Push ──

    /**
     * Push the skipper's current location to the Pi for pre-fetch targeting.
     * Debounced: only pushes if location moved >0.05° (~5km) OR >15min since last push.
     * Called automatically by the app when the LocationStore updates.
     */
    updateLocation(lat: number, lon: number): void {
        if (!this.isAvailable()) return;

        const dist = Math.abs(lat - this.lastPushedLat) + Math.abs(lon - this.lastPushedLon);
        const elapsed = Date.now() - this.lastPushTime;

        // Skip if location hasn't moved much and we pushed recently
        if (dist < 0.05 && elapsed < 15 * 60 * 1000) return;

        this.lastPushedLat = lat;
        this.lastPushedLon = lon;
        this.lastPushTime = Date.now();

        // Fire and forget — location push is best-effort
        this.pushConfig({
            supabaseUrl: '',
            supabaseAnonKey: '',
            prefetchLat: lat,
            prefetchLon: lon,
            prefetchRadius: 5,
        }).catch(() => {});
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
                    // Resolve mDNS hostnames to a raw IPv4 BEFORE storing
                    // — every subsequent /api/passthrough-tile, /status,
                    // /api/charts/* etc. then dials the IP directly and
                    // skips the per-socket Happy Eyeballs IPv6→IPv4 race.
                    // That race was the source of the recurring
                    // tcp_input flags=[R.] noise the user reported.
                    // Fall back to the hostname on resolution failure
                    // — connection still works, just without the noise
                    // reduction. Mirrors BoatNetworkService's pattern.
                    const ipv4 = await resolveHostnameIpv4(host);
                    const effectiveHost = ipv4 ?? host;
                    if (ipv4 && ipv4 !== host) {
                        log.info(`Resolved ${host} → ${ipv4} for pi-cache connections`);
                    }
                    this.config.host = effectiveHost;
                    this.status = {
                        reachable: true,
                        lastCheck: Date.now(),
                        latencyMs: Date.now() - start,
                        discoveredVia: effectiveHost,
                    };

                    // Persist the winning host so next boot is an instant verify
                    // (checkHealth on a known host ≈ 100ms LAN) instead of another
                    // 5-host discovery sweep.
                    if (typeof localStorage !== 'undefined') {
                        try {
                            localStorage.setItem('thalassa_pi_cache_host', effectiveHost);
                        } catch {
                            /* quota/private mode — non-fatal */
                        }
                    }

                    // Now get full status with cache stats
                    await this.checkHealth();
                    this.notifyListeners();
                    this.resolveReady();
                    return this.status;
                }
            } catch {
                // This host didn't respond — try next
            }
        }

        // Nothing found — mark ready so fetchers stop waiting and fall through
        // to direct network.
        this.status = { reachable: false, lastCheck: Date.now(), latencyMs: 0 };
        this.resolveReady();
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
        if (!this.config.enabled || !this.config.host) {
            this.resolveReady();
            return false;
        }

        const start = Date.now();
        try {
            let data: {
                status: string;
                cache?: PiCacheStatus['cacheStats'];
                config?: { supabaseConfigured?: boolean };
            };
            try {
                const res = await CapacitorHttp.get({
                    url: `${this.baseUrl}/status`,
                    connectTimeout: 2000,
                    readTimeout: 2000,
                });
                data = res.data;
            } catch {
                const res = await fetch(`${this.baseUrl}/status`, {
                    signal: AbortSignal.timeout(2000),
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
                supabaseConfigured: data?.config?.supabaseConfigured,
            };

            // Notify if status changed
            if (wasReachable !== this.status.reachable) {
                this.notifyListeners();
            }

            // Self-heal: if the Pi answered but reports no Supabase creds
            // (e.g. fresh install, .env wiped, restart that lost in-memory
            // state and never persisted), re-push our bundled creds so the
            // wind-grid / tide proxies work without a manual curl.
            this.autoReconcileConfigIfNeeded().catch(() => {
                /* fire-and-forget — failures already logged inside */
            });

            this.resolveReady();
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
            this.resolveReady();
            return false;
        }
    }

    private startHealthChecks(): void {
        // ── Initial check + retry-burst on cold-start failure ────────────
        //
        // The naive "check once, then 30s interval" pattern means a Pi that
        // wasn't reachable at the very first attempt (cold WiFi waking up,
        // mDNS still resolving calypso.local, brief packet loss) stays red
        // for up to 30s before the next health-check tick. The pill on the
        // dashboard sits there looking dead while the user knows the Pi is
        // fine.
        //
        // Fix: on initial failure, run a retry burst at 2s / 5s / 10s
        // before settling into the steady-state 30s cadence. Cheap, covers
        // the common "Pi reaches reachability ~5s after app boot" case.
        if (!this.config.host) {
            // No saved host — full discovery is the only option.
            this.discover().then((status) => {
                if (status.reachable) {
                    this.scheduleSteadyState();
                } else {
                    this.scheduleRetryBurst();
                }
            });
        } else {
            // Saved host — try fast checkHealth first.
            this.checkHealth().then((reachable) => {
                if (reachable) {
                    this.scheduleSteadyState();
                } else {
                    this.scheduleRetryBurst();
                }
            });
        }

        // Subscribe to location changes — push to Pi as the boat moves
        if (!this.locationUnsub) {
            this.locationUnsub = LocationStore.subscribe((loc) => {
                this.updateLocation(loc.lat, loc.lon);
            });
        }
    }

    /** Steady-state: 30s health-check interval. Clears any in-flight retry burst. */
    private scheduleSteadyState(): void {
        if (this.retryBurstTimer) {
            clearTimeout(this.retryBurstTimer);
            this.retryBurstTimer = null;
        }
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = setInterval(() => this.checkHealth(), 30_000);
    }

    /**
     * Cold-start retry burst: 2s, 5s, 10s. Alternates between checkHealth
     * (fast, uses saved host) and discover (covers IP-changed / hostname-stale
     * cases). As soon as ANY attempt succeeds, switches to steady-state. If
     * all retries fail, also switches to steady-state — at that point the Pi
     * is genuinely offline and the 30s cadence is appropriate.
     */
    private scheduleRetryBurst(): void {
        if (this.retryBurstTimer) clearTimeout(this.retryBurstTimer);
        const delays = [2000, 5000, 10000];
        let attempt = 0;
        const tryAgain = async () => {
            this.retryBurstTimer = null;
            if (!this.config.enabled) return; // user disabled mid-burst — bail
            if (this.status.reachable) {
                this.scheduleSteadyState();
                return;
            }
            // Alternate strategy: 1st retry uses checkHealth (cheap, saved host).
            // 2nd+ retries use discover (covers IP-changed / mDNS-stale cases).
            if (attempt === 0 && this.config.host) {
                await this.checkHealth();
            } else {
                await this.discover();
            }
            if (this.status.reachable) {
                this.scheduleSteadyState();
                return;
            }
            attempt++;
            if (attempt < delays.length) {
                this.retryBurstTimer = setTimeout(tryAgain, delays[attempt]);
            } else {
                // All bursts exhausted — Pi is genuinely offline. Steady state.
                this.scheduleSteadyState();
            }
        };
        this.retryBurstTimer = setTimeout(tryAgain, delays[0]);
    }

    private stopHealthChecks(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.retryBurstTimer) {
            clearTimeout(this.retryBurstTimer);
            this.retryBurstTimer = null;
        }
        if (this.locationUnsub) {
            this.locationUnsub();
            this.locationUnsub = null;
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
            this.recordFetch('direct');
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
            this.recordFetch(source);
            return { data: responseData, source, latencyMs: Date.now() - start };
        } catch {
            // Pi hiccup — fall back silently
            const data = await directFetch();
            this.recordFetch('direct');
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

    // ── Leaflet Tile Template ──

    /**
     * Create a Leaflet-compatible tile URL template that routes through the Pi.
     *
     * Works because Leaflet replaces {z}/{x}/{y}/{s}/{r} everywhere in the string,
     * including inside query parameter values. The Pi receives the concrete URL
     * after Leaflet fills in the placeholders.
     *
     * Only safe for "clean" tile URL templates (no `?query=params` in the original).
     * For URLs with query strings, use Mapbox GL's transformRequest + passthroughTileUrl().
     *
     * @param originalTemplate — Leaflet tile URL template, e.g. 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'
     * @param ttlMs — Cache TTL in milliseconds (default: 30 min)
     */
    leafletTileTemplate(originalTemplate: string, ttlMs = 1_800_000): string {
        if (!this.isAvailable()) return originalTemplate;
        return `${this.baseUrl}/api/passthrough-tile?url=${originalTemplate}&ttl=${ttlMs}&ct=image/png`;
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

    /**
     * Force a health check right now.
     *
     * If a host is already saved: tries checkHealth first (fast, ~100ms LAN).
     * If that fails, falls through to full discovery — covers the case where
     * the Pi got a new DHCP IP, the saved hostname stopped resolving, or the
     * user moved between networks (home WiFi → marina WiFi).
     */
    async ping(): Promise<PiCacheStatus> {
        if (!this.config.host) {
            return this.discover();
        }
        const ok = await this.checkHealth();
        if (!ok) {
            // Saved host unreachable — try fresh discovery as fallback.
            await this.discover();
        }
        return this.getStatus();
    }

    // ── App → Pi Configuration Push ──

    // Last successful auto-reconcile timestamp. We use this to avoid
    // hammering /api/configure if the push silently no-ops (e.g. when the
    // iOS bundle was built without VITE_SUPABASE_URL baked in — empty
    // strings get sent, the server keeps existing values, and the next
    // /status STILL says supabaseConfigured: false. Without a debounce
    // we'd push every 30s forever.)
    private _lastReconcileAttemptAt = 0;
    private static readonly RECONCILE_MIN_INTERVAL_MS = 5 * 60 * 1000;

    /**
     * If the Pi answered `/status` with `supabaseConfigured: false`, re-push
     * the credentials bundled into this iOS build. Idempotent — the Pi only
     * accepts non-empty values (see pi-cache server.ts) so calling this on
     * a Pi that's already configured is a harmless no-op.
     *
     * This exists because the .env file on the Pi can drift out of sync
     * with the in-memory state (e.g. .env write fails silently, Pi reboots
     * before the disk write flushes, install.sh overwrites it). The app is
     * the source of truth — every successful health check verifies the Pi
     * still has working creds and re-asserts them if not.
     */
    private async autoReconcileConfigIfNeeded(): Promise<void> {
        if (!this.status.reachable) return;
        // Only act when the Pi explicitly tells us it's missing creds.
        // `undefined` (older Pi without this field) → don't push, let it be.
        if (this.status.supabaseConfigured !== false) return;

        const now = Date.now();
        if (now - this._lastReconcileAttemptAt < PiCacheServiceImpl.RECONCILE_MIN_INTERVAL_MS) {
            return;
        }
        this._lastReconcileAttemptAt = now;

        // Pull credentials from the Vite env that was baked into this build.
        // Same source as PiCacheTab's manual "Discover" flow.
        const envSrc = (typeof import.meta !== 'undefined' ? import.meta.env : null) as Record<
            string,
            string | undefined
        > | null;
        const supabaseUrl = envSrc?.VITE_SUPABASE_URL || '';
        const supabaseAnonKey = envSrc?.VITE_SUPABASE_ANON_KEY || envSrc?.VITE_SUPABASE_KEY || '';

        if (!supabaseUrl || !supabaseAnonKey) {
            log.warn(
                'Pi reports supabaseConfigured: false but this app build has no VITE_SUPABASE_URL/KEY — cannot self-heal. Rebuild the iOS app with env vars present, or POST /api/configure on the Pi manually.',
            );
            return;
        }

        log.info('Pi reports supabaseConfigured: false — re-pushing config to self-heal');
        const loc = LocationStore.getState();
        const ok = await this.pushConfig({
            supabaseUrl,
            supabaseAnonKey,
            prefetchLat: loc.lat,
            prefetchLon: loc.lon,
            prefetchRadius: 5,
        });
        if (ok) {
            log.info('Auto-reconcile pushConfig succeeded — Pi should now have working Supabase creds');
        } else {
            log.warn('Auto-reconcile pushConfig failed — will retry after RECONCILE_MIN_INTERVAL');
        }
    }

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
        userId?: string;
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
