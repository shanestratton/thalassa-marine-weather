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

import { LocationStore } from '../stores/LocationStore';
import { resolveHostnameIpv4 } from '../utils/resolveHostnameIpv4';
import { withDeadline } from '../utils/deadline';
import { createLogger } from '../utils/createLogger';
import {
    PI_DISABLED_BASE_URL,
    PI_INTEGRATION_ENABLED,
    PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE,
} from './piPublicBetaBoundary';
import { piRequest } from './piTls';
import {
    pinnedPiRequest,
    getPairing,
    hasEverSeenPairableHost,
    fetchPairInfo,
    verifyPairedPi,
    markHostPairable,
    isLegacyPlainConnectionAllowed,
    type PairInfo,
} from './PiPairingService';

const log = createLogger('PiCacheService');

/** Events the pairing UI subscribes to — see onPairingEvent(). */
export type PiPairingEvent =
    | { type: 'pairable-found'; host: string; baseUrl: string; info: PairInfo }
    | { type: 'identity-failed'; host: string };

// ── Types ──

export interface PiCacheConfig {
    enabled: boolean;
    host: string;
    port: number;
}

/** Mirror of pi-cache /api/remote-access — the Tailscale state machine. */
export interface PiRemoteAccessStatus {
    state: 'not-installed' | 'stopped' | 'needs-auth' | 'starting' | 'connected' | 'error';
    /** Present while state==='needs-auth' — open in a browser, sign in. */
    authUrl?: string;
    tailscaleIps?: string[];
    dnsName?: string;
    message?: string;
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
    /** Stable, Pi-generated identity used to pair the durable diary relay. */
    diaryRelayId?: string;
    /** Whether this Pi currently has a scoped diary relay credential. */
    diaryRelayConfigured?: boolean;
    /** Account currently paired to the Pi diary relay; never a credential. */
    diaryRelayOwnerId?: string;
    /** Pi's currently persisted relay WAN gate, surfaced without secrets. */
    diaryRelayAllowInternet?: boolean;
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
/** One reading from the boat's own barometer. */
export interface PiBarometerSample {
    hpa: number;
    /** Enclosure temperature — the sensor self-heats, so NOT air temperature. */
    tempC: number;
    at: number;
}

/** The boat barometer's record as the Pi holds it. */
export interface PiBarometerState {
    available: boolean;
    reason: string | null;
    latest: PiBarometerSample | null;
    samples: PiBarometerSample[];
}

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
    // Fail closed until the authenticated app has loaded the skipper's
    // current policy and successfully reconciled it with a reachable Pi.
    private diaryRelayAllowInternet = false;
    /** Self-rearming steady-state health timer — a TIMEOUT handle, not an
     *  interval, because the period backs off. See scheduleSteadyState. */
    private healthCheckInterval: ReturnType<typeof setTimeout> | null = null;
    private retryBurstTimer: ReturnType<typeof setTimeout> | null = null;
    private discoveryListeners: Array<(status: PiCacheStatus) => void> = [];
    private pairingListeners: Array<(event: PiPairingEvent) => void> = [];
    /** Throttle for the pairable-found event so the tab isn't re-prompted every health tick. */
    private lastPairableEmitAt = 0;
    /**
     * The pairable Pi currently on offer, retained as STATE rather than only
     * announced as an event (2026-08-07).
     *
     * The event fires from checkHealth, which runs at boot — long before the
     * skipper opens Settings. Any listener mounting later missed it entirely,
     * and the 5-minute throttle then suppressed the next one, so the pairing
     * card simply never appeared and the Pi looked permanently unpairable.
     * A subscriber can now ASK what is on offer instead of having to have been
     * listening at the right instant.
     */
    private pairableCandidate: PiPairingEvent | null = null;
    /** Timer for the polite background discovery that replaced the manual toggle. */
    private autoDiscoverTimer: ReturnType<typeof setTimeout> | null = null;
    private locationUnsub: (() => void) | null = null;
    private foregroundListenersInstalled = false;
    /**
     * Consecutive discovery sweeps that found nothing. Drives the backoff in
     * scheduleSteadyState: a phone that is simply not on the boat's LAN — the
     * overwhelmingly common case once ashore — should stop paying for a sweep
     * every 30 s. Reset to 0 the moment a sweep succeeds.
     */
    private failedSweeps = 0;

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
        if (!PI_INTEGRATION_ENABLED) return;
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
        if (!PI_INTEGRATION_ENABLED) {
            this.configure({ enabled: false, host: '', port: 3001 });
            log.info(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE);
            return;
        }
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

        // Paired boats need no toggle: the pairing record IS the enable. It
        // also outranks stale persisted hosts — identity follows the key,
        // and checkHealth re-verifies it against whatever answers.
        const pairing = getPairing();
        if (pairing) {
            enabled = true;
            if (!host) host = pairing.host;
        }

        if (enabled) {
            this.configure({ enabled: true, host, port });
        } else {
            // Nothing configured and nothing paired — the zero-config path.
            // A single polite hostname-list sweep (never the subnet scan),
            // delayed clear of the boot window and throttled hard, because
            // for most users there is no Pi and this is pure background
            // noise. A hit doesn't connect — the identity gate turns it
            // into a pairing card instead.
            this.scheduleAutoDiscovery();
        }

        // App-foreground / network-online listeners are installed once at boot
        // and live for the app's lifetime. They trigger a fresh ping any time
        // the app comes back into focus or the network reconnects — covers the
        // common case where the user backgrounds the app, returns later, and
        // expects the pi-cache pill to be live immediately rather than waiting
        // up to 30s for the next health-check tick.
        this.installForegroundListeners();
    }

    /** Minimum gap between unattended discovery sweeps when no Pi is known. */
    private static readonly AUTO_DISCOVER_MIN_INTERVAL_MS = 6 * 3600 * 1000;
    private static readonly AUTO_DISCOVER_LAST_KEY = 'thalassa_pi_autodiscover_last';

    private scheduleAutoDiscovery(): void {
        if (this.autoDiscoverTimer) return;
        this.autoDiscoverTimer = setTimeout(() => {
            this.autoDiscoverTimer = null;
            void this.politeAutoDiscover();
        }, 15_000); // clear of the boot window — same reasoning as autoSyncFromPi's deferral
    }

    private async politeAutoDiscover(): Promise<void> {
        if (this.config.enabled) return; // something configured meanwhile
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        // The 6 h throttle is for devices with no Pi, where sweeping is pure
        // background noise. Once a Pi has advertised pairing on this device we
        // KNOW there is one and the skipper is trying to pair — throttling
        // there just means the pairing banner never appears (Shane 2026-08-07:
        // "the is no banner claude???"). Still bounded by the once-per-boot
        // timer, so this is at most one extra hostname sweep per launch.
        if (!hasEverSeenPairableHost()) {
            try {
                const last = Number(localStorage.getItem(PiCacheServiceImpl.AUTO_DISCOVER_LAST_KEY) ?? 0);
                if (Date.now() - last < PiCacheServiceImpl.AUTO_DISCOVER_MIN_INTERVAL_MS) return;
                localStorage.setItem(PiCacheServiceImpl.AUTO_DISCOVER_LAST_KEY, String(Date.now()));
            } catch {
                /* private mode — run anyway; the per-boot timer still bounds it */
            }
        }
        log.info('no Pi paired or configured — running one background discovery sweep');
        // discover() probes the fixed hostname list only. A found-but-unpaired
        // Pi comes back through the identity gate as a pairable-found event.
        this.config.enabled = true; // discovery needs the machinery on…
        const status = await this.discover();
        if (!status.reachable && !getPairing()) {
            this.config.enabled = false; // …but a miss returns us to dormant
        }
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
        if (!PI_INTEGRATION_ENABLED) {
            const wasEnabled = this.config.enabled;
            this.config = { enabled: false, host: '', port: 3001 };
            if (wasEnabled) this.stopHealthChecks();
            this.status = { reachable: false, lastCheck: 0, latencyMs: 0 };
            this.resolveReady();
            this._firstCheckDone = null;
            return;
        }
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

    /**
     * Called by the pairing UI right after a successful pairWithPi() — brings
     * the newly paired Pi online immediately instead of waiting for the next
     * discovery cycle.
     */
    adoptPairing(host: string): void {
        if (!PI_INTEGRATION_ENABLED) return;
        this.configure({ enabled: true, host });
        void this.ping();
    }

    /** Get the current Pi Cache status. */
    getStatus(): PiCacheStatus {
        return { ...this.status };
    }

    /**
     * The Pi's base URL for a pinned request, honouring remote access.
     *
     * Extracted from getBarometer, which built this by hand — a second caller
     * (the anchor watch handoff) is one copy too many for a rule about WHICH
     * host the app is allowed to talk to. Null when there is no host to talk
     * to at all.
     */
    getBaseUrl(): string | null {
        const host = this._useRemote && this.remoteHost ? this.remoteHost : this.config.host;
        if (!host) return null;
        return `https://${host}:${this.config.port}`;
    }

    /** Is the Pi Cache enabled AND reachable right now? */
    isAvailable(): boolean {
        return PI_INTEGRATION_ENABLED && this.config.enabled && this.status.reachable;
    }

    /**
     * Remember the skipper's desired Pi diary WAN policy even while the Pi is
     * away. The next successful health check reconciles this value, closing
     * the old hole where a satellite-mode change was silently lost until a
     * later manual handoff.
     */
    async setDiaryRelayInternetPolicy(allowed: boolean): Promise<boolean> {
        this.diaryRelayAllowInternet = allowed === true;
        if (!this.isAvailable()) return false;
        return this.pushConfig({
            supabaseUrl: '',
            supabaseAnonKey: '',
            diaryRelayAllowInternet: this.diaryRelayAllowInternet,
        });
    }

    /** Base URL for the Pi Cache server. */
    get baseUrl(): string {
        if (!PI_INTEGRATION_ENABLED) return PI_DISABLED_BASE_URL;
        // HTTPS only. The Pi's certificate is pinned to its pairing key
        // (services/piTls.ts), so this is verifiable offline with no CA — and
        // there is deliberately no plaintext fallback to slip back to.
        //
        // Off the boat, the same pinned transport rides the punter's tailnet:
        // the Pi serves the identical certificate on its 100.x address, and
        // the pin is key-equality, not hostname, so nothing about the trust
        // model changes with the network. checkHealth owns the ladder (LAN
        // first, tailnet fallback) and flips _useRemote.
        const host = this._useRemote && this.remoteHost ? this.remoteHost : this.config.host;
        return `https://${host}:${this.config.port}`;
    }

    // ── Remote access (punter's own Tailscale) ──

    private static readonly REMOTE_HOST_KEY = 'thalassa_pi_remote_host';
    private _useRemote = false;
    private _remoteHostCache: string | null = null;

    /** The Pi's tailnet address (100.x), learned when remote access connects. */
    private get remoteHost(): string {
        if (this._remoteHostCache === null) {
            try {
                this._remoteHostCache = localStorage.getItem(PiCacheServiceImpl.REMOTE_HOST_KEY) ?? '';
            } catch {
                this._remoteHostCache = '';
            }
        }
        return this._remoteHostCache;
    }

    private saveRemoteHost(host: string): void {
        this._remoteHostCache = host;
        if (!host) this._useRemote = false;
        try {
            if (host) localStorage.setItem(PiCacheServiceImpl.REMOTE_HOST_KEY, host);
            else localStorage.removeItem(PiCacheServiceImpl.REMOTE_HOST_KEY);
        } catch {
            /* private mode — session-only fallback via the cache field */
        }
    }

    /** True when the app is currently talking to the Pi over the tailnet. */
    get viaRemoteAccess(): boolean {
        return this._useRemote && this.status.reachable;
    }

    private adoptRemoteAccessStatus(status: PiRemoteAccessStatus): void {
        if (status.state === 'connected') {
            const ip = status.tailscaleIps?.find((candidate) => candidate.includes('.'));
            if (ip && ip !== this.remoteHost) {
                this.saveRemoteHost(ip);
                log.info(`remote access connected — tailnet fallback host ${ip}`);
            }
        }
    }

    private async remoteAccessRequest(
        path: string,
        method: 'GET' | 'POST',
        data?: Record<string, unknown>,
    ): Promise<PiRemoteAccessStatus | null> {
        if (!this.isAvailable()) return null;
        try {
            const res = await pinnedPiRequest({
                url: `${this.baseUrl}${path}`,
                method,
                headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
                data,
                connectTimeout: 5000,
                // /enable holds the request while `tailscale up` looks for a
                // login URL (up to ~8s Pi-side).
                readTimeout: 15000,
                responseType: 'text',
            });
            // 409 carries a real state payload (not-installed) — parse it too.
            if ((res.status < 200 || res.status >= 300) && res.status !== 409) return null;
            const status = JSON.parse(res.data) as PiRemoteAccessStatus;
            this.adoptRemoteAccessStatus(status);
            return status;
        } catch {
            return null;
        }
    }

    fetchRemoteAccessStatus(): Promise<PiRemoteAccessStatus | null> {
        return this.remoteAccessRequest('/api/remote-access', 'GET');
    }

    enableRemoteAccess(): Promise<PiRemoteAccessStatus | null> {
        return this.remoteAccessRequest('/api/remote-access/enable', 'POST', {});
    }

    async disableRemoteAccess(logout = false): Promise<PiRemoteAccessStatus | null> {
        const status = await this.remoteAccessRequest('/api/remote-access/disable', 'POST', { logout });
        if (status && status.state !== 'connected') this.saveRemoteHost('');
        return status;
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

    /**
     * The BOAT's barometer — a proper station barometer, not the phone's.
     *
     * Worth preferring wherever it is reachable, because a barometer earns its
     * keep on TENDENCY and a phone cannot supply one: it goes ashore in a
     * pocket and up and down the companionway, and altitude reads as pressure
     * (~0.12 hPa per metre), so a walk up the dock ramp swamps the 1-2 hPa/3h
     * that actually forecasts anything. The BMP390 is bolted to the boat and
     * mains-powered — it does not move and it does not sleep, and the Pi keeps
     * twelve hours of it across restarts.
     *
     * Returns null whenever the Pi lane is unusable, so the caller's fallback
     * is the same shape as everywhere else: try this, fall back to the phone.
     * `available: false` with a reason is a real answer, not a failure — a Pi
     * with no sensor fitted says so rather than erroring.
     */
    async getBarometer(timeoutMs = 4_000): Promise<PiBarometerState | null> {
        if (!this.status.reachable) return null;
        const baseUrl = this.getBaseUrl();
        if (!baseUrl) return null;
        try {
            const res = await pinnedPiRequest({
                url: `${baseUrl}/api/barometer`,
                readTimeout: timeoutMs,
                responseType: 'text',
            });
            if (res.status < 200 || res.status >= 300) return null;
            const body = typeof res.data === 'string' ? (JSON.parse(res.data) as unknown) : null;
            if (!body || typeof body !== 'object') return null;
            const state = body as PiBarometerState;
            if (typeof state.available !== 'boolean' || !Array.isArray(state.samples)) return null;
            return state;
        } catch {
            // A missing route (an older Pi that predates this) is indistinguishable
            // from an unreachable one here, and both mean the same thing to the
            // caller: use the phone.
            return null;
        }
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
        if (!PI_INTEGRATION_ENABLED) {
            this.status = { reachable: false, lastCheck: Date.now(), latencyMs: 0 };
            this.resolveReady();
            return this.status;
        }
        const candidates = [...DISCOVERY_HOSTS];

        // If the user already set a host, try that first
        if (this.config.host && !candidates.includes(this.config.host)) {
            candidates.unshift(this.config.host);
        }

        // Probe over the pinned channel. When already paired, /health is
        // reachable with the pin and a stranger answering `calypso.local`
        // cannot complete the handshake at all. When not yet paired, the only
        // path the transport will open unpinned is the pairing card — which is
        // also a perfectly good "is this a pi-cache?" probe, so discovery and
        // pairing discovery are now the same request rather than two.
        const pinnedSpki = getPairing()?.publicKeySpki;

        // ── PARALLEL, not serial (perf regression fix 2026-08-07) ──
        // These are seven mDNS names that mostly do not exist. Probed one at a
        // time behind a 2.5 s deadline each, a boat with no Pi — or any phone
        // off the boat LAN — paid ~18 s per sweep, measured. That was invisible
        // while Pi integration was development-only; the moment it shipped it
        // became every user's startup cost, re-paid every health interval.
        //
        // Racing them costs one deadline instead of seven. Failures are the
        // common case and cost nothing, so the sweep is now bounded by the
        // slowest single probe rather than their sum.
        const probeHost = async (host: string): Promise<{ host: string; latencyMs: number }> => {
            const base = `https://${host}:${this.config.port}`;
            const url = pinnedSpki ? `${base}/health` : `${base}/api/pair/info`;
            const start = Date.now();
            const res = await withDeadline(
                piRequest({ url, pinnedSpki, connectTimeout: 2000, readTimeout: 2000, responseType: 'text' }),
                2500,
                'pi-cache probe',
            );
            const data = res.status >= 200 && res.status < 300 ? JSON.parse(res.data) : null;
            const ok = pinnedSpki
                ? data?.status === 'ok' && data?.service === 'thalassa-pi-cache'
                : data?.service === 'thalassa-pi-cache' && !!data?.publicKeySpki;
            if (!ok) throw new Error(`${host} is not a pi-cache`);
            return { host, latencyMs: Date.now() - start };
        };

        // Promise.any resolves on the FIRST success and ignores the rest, which
        // is exactly the semantics the old loop had — first host that answers
        // wins — without waiting for the failures in front of it.
        let winner: { host: string; latencyMs: number } | null = null;
        try {
            winner = await Promise.any(candidates.map(probeHost));
        } catch {
            // AggregateError: every candidate failed. Handled below.
        }

        {
            const host = winner?.host;
            const start = Date.now() - (winner?.latencyMs ?? 0);
            if (host) {
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
                // NOT reachable yet — checkHealth() below re-probes and
                // runs the identity gate; nothing may treat a host as
                // "the Pi" on a bare /health hit.
                this.status = {
                    reachable: false,
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
                this.failedSweeps = 0;
                return this.status;
            }
        }

        // Nothing found — mark ready so fetchers stop waiting and fall through
        // to direct network.
        this.failedSweeps += 1;
        this.status = { reachable: false, lastCheck: Date.now(), latencyMs: 0 };
        this.resolveReady();
        return this.status;
    }

    /**
     * The identity gate every reachable-looking responder must pass.
     *
     *  paired          → challenge with a fresh nonce; the pinned key must
     *                    sign it. Runs on every health tick, so a mid-session
     *                    host takeover is caught within ~30 s.
     *  unpaired, offers pairing
     *                  → never auto-connect; surface the pairing card and
     *                    remember the host so plain mode can't come back.
     *  unpaired, no pairing support
     *                  → legacy grace, only while nothing was ever pairable
     *                    (isLegacyPlainConnectionAllowed) — an attacker can't
     *                    reopen it by hiding the endpoints.
     */
    private async passesIdentityGate(): Promise<boolean> {
        const host = this.config.host;
        const pairing = getPairing();
        if (pairing) {
            this.pairableCandidate = null;
            const ok = await verifyPairedPi(this.baseUrl, pairing);
            if (!ok) {
                log.warn(
                    `identity check FAILED for ${host} — refusing: responder does not hold the key paired for "${pairing.boatName}"`,
                );
                this.emitPairing({ type: 'identity-failed', host });
            }
            return ok;
        }

        const info = await fetchPairInfo(this.baseUrl);
        if (info) {
            markHostPairable(host);
            const now = Date.now();
            const offer: PiPairingEvent = { type: 'pairable-found', host, baseUrl: this.baseUrl, info };
            // Retained unconditionally; only the NOTIFICATION is throttled.
            this.pairableCandidate = offer;
            if (now - this.lastPairableEmitAt > 5 * 60 * 1000) {
                this.lastPairableEmitAt = now;
                this.emitPairing(offer);
            }
            log.info(`pairable Pi "${info.boatName}" at ${host} — blocked until the skipper pairs`);
            return false;
        }

        if (isLegacyPlainConnectionAllowed(host)) return true;
        log.warn(`refusing plain connection to ${host} — pairing exists or this host once offered pairing`);
        return false;
    }

    /**
     * The pairing offer currently outstanding, if any.
     *
     * Read this on mount BEFORE subscribing: onPairingEvent only delivers
     * future events, and the offer is usually made at boot.
     */
    getPairableCandidate(): PiPairingEvent | null {
        return this.pairableCandidate;
    }

    /** Subscribe to pairing lifecycle events (pairing card, identity warnings). */
    onPairingEvent(listener: (event: PiPairingEvent) => void): () => void {
        this.pairingListeners.push(listener);
        return () => {
            this.pairingListeners = this.pairingListeners.filter((l) => l !== listener);
        };
    }

    private emitPairing(event: PiPairingEvent): void {
        for (const listener of this.pairingListeners) {
            try {
                listener(event);
            } catch {
                /* listener errors must not break health checks */
            }
        }
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
        if (!PI_INTEGRATION_ENABLED) {
            this.resolveReady();
            return false;
        }
        if (!this.config.enabled || !this.config.host) {
            this.resolveReady();
            return false;
        }

        // ── UNPAIRED: raise the pairing offer, do not probe status ──
        // The pinned transport opens exactly one path without a pin,
        // /api/pair/info. So /api/admin/status below is unreachable until a
        // pairing exists — and this method used to reach the identity gate
        // only AFTER that status call succeeded. The result was a deadlock:
        // pairing needs the offer, the offer needs the identity gate, and the
        // gate sat behind a request that pairing gates. That is why no pairing
        // banner ever appeared (Shane 2026-08-07: "Still no banner????").
        //
        // Unpaired, the gate is the only thing worth running: it fetches the
        // pairing card over the one permitted path and emits pairable-found.
        // It returns false for a pairable-but-unpaired Pi by design — never
        // auto-connect — so the Pi correctly stays unreachable until the
        // skipper accepts.
        if (!getPairing()) {
            const identityOk = await this.passesIdentityGate();
            this.status = {
                ...this.status,
                reachable: identityOk,
                lastCheck: Date.now(),
            };
            this.resolveReady();
            this.notifyListeners();
            return identityOk;
        }

        const start = Date.now();
        try {
            // Pinned transport (2026-08-07). The Pi serves a self-signed
            // certificate, so the raw bridge/fetch this used to call could not
            // complete the handshake — it threw every time, checkHealth always
            // returned false, the Pi could never become `reachable`, and every
            // downstream feature (ENC sync included) stayed dead with no
            // visible error.
            //
            // Host ladder: boat LAN first, then the tailnet address remote
            // access learned. Same pinned certificate on both — the pin is
            // key-equality, so identity is transport-independent.
            const probe = (host: string) =>
                withDeadline(
                    pinnedPiRequest({
                        url: `https://${host}:${this.config.port}/api/admin/status`,
                        connectTimeout: 2000,
                        readTimeout: 2000,
                        responseType: 'text',
                    }),
                    2500,
                    'pi-cache /api/admin/status',
                );
            let res: Awaited<ReturnType<typeof probe>>;
            try {
                res = await probe(this.config.host);
                this._useRemote = false;
            } catch (lanErr) {
                const remote = this.remoteHost;
                if (!remote || remote === this.config.host) throw lanErr;
                res = await probe(remote);
                this._useRemote = true;
            }
            if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
            const data = JSON.parse(res.data) as {
                status: string;
                cache?: PiCacheStatus['cacheStats'];
                config?: {
                    supabaseConfigured?: boolean;
                    diaryRelayId?: string;
                    diaryRelayConfigured?: boolean;
                    diaryRelayOwnerId?: string;
                    diaryRelayAllowInternet?: boolean;
                };
            };

            // A healthy /status is necessary but no longer sufficient: the
            // responder must also pass the identity gate (pinned-key
            // challenge when paired; pairing offer or legacy grace when not)
            // before anything in the app treats it as "the Pi". See
            // PiPairingService for the threat model.
            const rawOk = data?.status === 'ok';
            const identityOk = rawOk ? await this.passesIdentityGate() : false;

            const wasReachable = this.status.reachable;
            this.status = {
                ...this.status,
                reachable: rawOk && identityOk,
                lastCheck: Date.now(),
                latencyMs: Date.now() - start,
                cacheStats: data?.cache as PiCacheStatus['cacheStats'],
                supabaseConfigured: data?.config?.supabaseConfigured,
                diaryRelayId: data?.config?.diaryRelayId,
                diaryRelayConfigured: data?.config?.diaryRelayConfigured,
                diaryRelayOwnerId: data?.config?.diaryRelayOwnerId,
                diaryRelayAllowInternet: data?.config?.diaryRelayAllowInternet,
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
            this.reconcileDiaryRelayInternetPolicy().catch(() => {
                /* Pi may disappear between status and policy push. */
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

    /**
     * Steady-state health checking, with backoff. Clears any in-flight retry
     * burst.
     *
     * A self-rearming timeout rather than setInterval, because the period is
     * not constant: 30 s is right for a Pi on the same LAN that might blink,
     * and wrong for a phone ashore, where every tick is a guaranteed-failing
     * discovery sweep for the rest of the session. Doubles 30 s → 5 min and
     * stays there. Any success resets `failedSweeps`, so the next tick after
     * the skipper steps back aboard reconnects at full rate.
     *
     * A fixed interval could not do this — the period has to be recomputed
     * after each result, which is exactly what re-arming gives us.
     */
    private scheduleSteadyState(): void {
        if (this.retryBurstTimer) {
            clearTimeout(this.retryBurstTimer);
            this.retryBurstTimer = null;
        }
        if (this.healthCheckInterval) clearTimeout(this.healthCheckInterval);

        const arm = (): void => {
            const period = Math.min(30_000 * 2 ** Math.min(this.failedSweeps, 4), 300_000);
            this.healthCheckInterval = setTimeout(() => {
                void this.checkHealth().finally(arm);
            }, period);
        };
        arm();
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
            clearTimeout(this.healthCheckInterval);
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
            const res = await pinnedPiRequest({
                url,
                connectTimeout: 5000,
                readTimeout: 10000,
                responseType: 'text',
            });
            if (res.status < 200 || res.status >= 300) throw new Error(`Pi Cache ${res.status}`);
            const responseData = JSON.parse(res.data) as T;
            const cacheHeader = res.headers?.['x-cache'] || res.headers?.['X-Cache'] || '';

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
     * Fetch JSON from upstream THROUGH the Pi, over the pinned transport.
     * Returns null whenever the Pi lane is unusable, so every caller's
     * fallback is the same shape: try this, and go direct on null.
     *
     * USE THIS, NOT passthroughUrl(). The URL builder hands back an
     * `https://<pi>:3001/...` string, and the Pi serves that with a
     * SELF-SIGNED certificate. Only the pinned transport can present the pin,
     * so a plain `fetch()` at that URL fails every time on iOS with
     * NSURLErrorDomain -1202. Ten call sites did exactly that; the ones with a
     * fallback merely wasted a round trip, and the ones without silently lost
     * their Pi hop and returned nothing. Handing out a bare URL invited it, so
     * the fetch now lives behind the same door as the URL.
     *
     * @param originalUrl — The full URL the app would normally fetch
     * @param ttlMs — Cache TTL in milliseconds (default: 15 min)
     * @param source — Label for debugging (e.g., 'open-meteo')
     * @param timeoutMs — Wall clock for the Pi hop. Short by default: the Pi
     *   is a LAN optimisation, so a slow one should lose to going direct.
     */
    async passthroughText(
        originalUrl: string,
        ttlMs = 900_000,
        source = 'passthrough',
        timeoutMs = 6_000,
    ): Promise<string | null> {
        const piUrl = this.passthroughUrl(originalUrl, ttlMs, source);
        if (!piUrl) return null;
        try {
            const res = await piRequest({ url: piUrl, readTimeout: timeoutMs });
            if (res.status < 200 || res.status >= 300) {
                log.warn(`[pi] passthrough ${source} returned ${res.status} — caller should go direct`);
                return null;
            }
            return res.data || null;
        } catch (err) {
            // Includes the certificate rejection and a Pi that has gone out of
            // range. Both mean the same thing to the caller: no Pi answer this
            // pass, go direct.
            log.warn(`[pi] passthrough ${source} failed — caller should go direct`, err);
            return null;
        }
    }

    /** JSON flavour of passthroughText. Malformed bodies read as no answer. */
    async passthroughJson<T = unknown>(
        originalUrl: string,
        ttlMs = 900_000,
        source = 'passthrough',
        timeoutMs = 6_000,
    ): Promise<T | null> {
        const body = await this.passthroughText(originalUrl, ttlMs, source, timeoutMs);
        if (body === null) return null;
        try {
            return JSON.parse(body) as T;
        } catch {
            // A poisoned or truncated cache entry is not an answer.
            log.warn(`[pi] passthrough ${source} returned unparseable JSON — caller should go direct`);
            return null;
        }
    }

    /**
     * Fetch a tile THROUGH the Pi, over the pinned transport, as a Response so
     * callers can treat both lanes identically.
     *
     * Same rule as passthroughJson: a plain fetch at a Pi tile URL cannot
     * present the pin. Note this is for tiles YOUR code fetches — a tile a MAP
     * ENGINE fetches can never work at all, which is what
     * canDisplayProxiedTiles() is for.
     */
    async passthroughTileResponse(
        originalUrl: string,
        ttlMs = 1_800_000,
        timeoutMs = 15_000,
    ): Promise<Response | null> {
        const piUrl = this.passthroughTileUrl(originalUrl, ttlMs);
        if (!piUrl) return null;
        try {
            const res = await piRequest({ url: piUrl, responseType: 'arraybuffer', readTimeout: timeoutMs });
            if (res.status < 200 || res.status >= 300 || !res.data) return null;
            const binary = atob(res.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            if (bytes.byteLength === 0) return null;
            return new Response(bytes);
        } catch (err) {
            log.warn('[pi] tile passthrough failed — caller should go direct', err);
            return null;
        }
    }

    /**
     * Route any URL through the Pi Cache's generic passthrough.
     * Returns a Pi-proxied URL, or null if Pi is unavailable.
     *
     * The Pi fetches the URL, caches the response in SQLite, and returns it.
     * Next time, the response comes straight from the Pi's disk — zero internet.
     *
     * ⚠️ THE RETURNED URL CANNOT BE FETCHED WITH PLAIN `fetch()`. It points at
     * the Pi's self-signed HTTPS endpoint. Use passthroughJson() above unless
     * you are handing the URL to something that can present the pin. A guard
     * test enumerates the callers allowed to touch this.
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
    /**
     * FALSE while the Pi speaks pinned self-signed TLS.
     *
     * Leaflet fetches tiles as <img src>, which goes through WKWebView's
     * ordinary image loader — NOT through PiTlsPlugin, which is what holds the
     * pin for the Pi's self-signed certificate. The webview has no CA for that
     * cert, so every tile request dies in the handshake and renders nothing:
     * the Log page's maps went white the moment the Pi moved to HTTPS on
     * 2026-08-07. Over the old http:// base an <img> was fine, which is why
     * this worked for months and then stopped.
     *
     * The cost of leaving it off is real — no Pi tile cache offshore — but a
     * cached tile that can never be displayed is worth nothing, and a white
     * chart is a worse failure than an uncached one.
     *
     * Flipping this back on requires the tiles to travel over a transport that
     * can present the pin: a native WKURLSchemeHandler serving a custom
     * scheme, or a certificate the webview already trusts. The wrapper below
     * is kept, and correct, for that day.
     */
    private static readonly PI_TILE_PROXY_USABLE = false;

    /**
     * Can a MAP ENGINE actually display a Pi-proxied tile?
     *
     * This is a different question from isAvailable(), and conflating the two
     * is what broke the rain radar (Shane, 2026-08-22). isAvailable() means
     * "the Pi answered a health check" — over the PINNED transport, which is
     * the only lane that can present its self-signed certificate. Mapbox and
     * Leaflet fetch tiles themselves, natively, and cannot present that pin.
     * So on iOS every proxied tile dies with NSURLErrorDomain -1202
     * (errSSLXCertChainInvalid, `s: Thalassa Pi calypso i: Thalassa Pi
     * calypso`) — a reachable Pi and an unusable one look identical until the
     * tiles simply never paint.
     *
     * Ask THIS before routing a tile that something else will fetch for you.
     * Ask isAvailable() only when you control the transport.
     */
    canDisplayProxiedTiles(): boolean {
        return PiCacheServiceImpl.PI_TILE_PROXY_USABLE && this.isAvailable();
    }

    leafletTileTemplate(originalTemplate: string, ttlMs = 1_800_000, contentType = 'image/png'): string {
        if (!this.canDisplayProxiedTiles()) return originalTemplate;
        // NEVER proxy tiles over the REMOTE path. The Pi cache earns its keep
        // on the boat LAN — shared scarce uplink, prefetched cells, offline at
        // anchor. Reached over the punter's tailnet instead, the same proxy is
        // a pure detour: phone → Tailscale → the boat's 5G → Pi → upstream →
        // back over 5G — for tiles the phone could fetch directly on its own
        // connection. Measured as "the box is instant but the map inside takes
        // ages" on the Log page from home (Shane, 2026-08-20). `reachable` and
        // `worth using` are different facts; this is where they part ways.
        if (this._useRemote) return originalTemplate;
        // ENCODE the upstream template. It may carry its own query string —
        // Mapbox requires ?access_token= — and interpolating it raw made
        // Express on the Pi parse that token as one of the PASSTHROUGH's own
        // params, truncating `url` at the '?'. The Pi then fetched a tokenless
        // Mapbox URL, got 401, and every tile came back empty: a silently
        // white map with working attribution underneath it (Shane 2026-08-07,
        // Log page). Esri has no query string, which is why this only appeared
        // when these maps moved to Mapbox.
        //
        // The {z}/{x}/{y} placeholders must survive encoding — Leaflet
        // substitutes them in the FINAL string, after this wrapping.
        const encoded = encodeURIComponent(originalTemplate).replace(/%7B([zxy])%7D/gi, (_m, axis) => `{${axis}}`);
        // Content type is not cosmetic here: the Pi stamps the cached response
        // with it. Satellite tiles are JPEG; labelling them image/png cached
        // and served a lie.
        return `${this.baseUrl}/api/passthrough-tile?url=${encoded}&ttl=${ttlMs}&ct=${encodeURIComponent(contentType)}`;
    }

    // ── Maintenance ──

    /** Purge expired entries on the Pi. */
    async purgeCache(): Promise<{ kvDeleted: number; tileDeleted: number } | null> {
        if (!this.isAvailable()) return null;
        try {
            // No plain-fetch fallback: it cannot complete the Pi's TLS
            // handshake, so it could only ever convert a real error into a
            // second, more confusing one.
            const res = await pinnedPiRequest({
                url: `${this.baseUrl}/cache/purge`,
                method: 'POST',
                responseType: 'text',
            });
            const data = JSON.parse(res.data) as { purged?: { kvDeleted: number; tileDeleted: number } };
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
        if (!PI_INTEGRATION_ENABLED) return this.getStatus();
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
    private _sessionKeyAsserted = false;
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
        // Push when the Pi explicitly reports missing creds — AND once per
        // app session regardless. /status only reports that a key is
        // PRESENT, not that it still passes the edge auth gate: a rotated
        // anon key reported configured:true forever while every proxied
        // route 502'd with "Upstream 401" (2026-08-04 tide log). The push is
        // idempotent, so re-asserting the build's creds once per session
        // self-heals key rot without a contract change.
        if (this.status.supabaseConfigured !== false && this._sessionKeyAsserted) return;
        this._sessionKeyAsserted = true;

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

    /** Reassert the in-memory policy only when the Pi reports a mismatch. */
    private async reconcileDiaryRelayInternetPolicy(): Promise<void> {
        if (!this.status.reachable || this.status.diaryRelayAllowInternet === this.diaryRelayAllowInternet) return;
        const applied = await this.pushConfig({
            supabaseUrl: '',
            supabaseAnonKey: '',
            diaryRelayAllowInternet: this.diaryRelayAllowInternet,
        });
        if (!applied) log.debug('Diary relay WAN policy reconciliation deferred');
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
        /** Scoped, Pi-only credential for diary outbox forwarding. */
        diaryRelayUrl?: string;
        diaryRelayId?: string;
        diaryRelayOwnerId?: string;
        diaryRelayToken?: string;
        /** False while the skipper has explicitly selected satellite mode. */
        diaryRelayAllowInternet?: boolean;
    }): Promise<boolean> {
        if (!this.isAvailable()) return false;

        try {
            // This POST carries the diary relay TOKEN. It was the single
            // strongest argument for putting the boat LAN on TLS, so it must
            // go through the pinned transport — never a plain fallback.
            const response = await pinnedPiRequest({
                url: `${this.baseUrl}/api/configure`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                data: config,
                responseType: 'text',
            });
            // Treat a rejected relay credential/policy as a real failure so
            // the app does not falsely cache a Pi pair.
            if (response.status < 200 || response.status >= 300) return false;
            try {
                const body = JSON.parse(response.data) as { status?: unknown };
                if (body?.status === 'error') return false;
            } catch {
                /* non-JSON 2xx — the Pi accepted it */
            }
            return true;
        } catch {
            return false;
        }
    }
}

/** Singleton — import this everywhere. */
export const piCache = new PiCacheServiceImpl();
