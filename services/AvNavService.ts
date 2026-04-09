/**
 * AvNavService — AvNav chart server connection & chart discovery.
 *
 * Connects to a user's AvNav chart server (typically a Raspberry Pi aboard)
 * and discovers available nautical chart tile sources.
 *
 * Thalassa is a chart VIEWER only — charts are stored, licensed, and
 * served entirely from the user's own hardware. Zero licensing risk.
 *
 * Supports both Signal K API v1 and v2 endpoints for compatibility.
 */
import { createLogger } from '../utils/createLogger';
import { Preferences } from '@capacitor/preferences';
import { CapacitorHttp } from '@capacitor/core';

const log = createLogger('AvNav');

/** Write a diagnostic log entry via Capacitor Preferences bridge.
 *  Does set + get so the value appears in Xcode as '⚡️  TO JS {"value":"..."}'. */
let _diagSeq = 0;
function nativeLog(msg: string): void {
    const key = `SK_LOG`;
    const val = `[${++_diagSeq}] ${msg}`;
    Preferences.set({ key, value: val })
        .then(() => Preferences.get({ key }))
        .catch(() => {});
    console.error(`[AvNav] ${msg}`);
}

/** Awaitable version — ensures logs appear sequentially in Xcode */
export async function nativeLogAsync(msg: string): Promise<void> {
    const key = `SK_LOG`;
    const val = `[${++_diagSeq}] ${msg}`;
    try {
        await Preferences.set({ key, value: val });
        await Preferences.get({ key });
    } catch {
        /* ignore */
    }
    console.error(`[AvNav] ${msg}`);
}

// ── Types ──

export interface AvNavChart {
    id: string;
    name: string;
    description: string;
    tilesUrl: string; // Full URL template: http://host:port/path/{z}/{x}/{y}
    format: 'png' | 'pbf' | 'jpg' | 'webp';
    minZoom: number;
    maxZoom: number;
    bounds?: [number, number, number, number]; // [west, south, east, north]
    type: 'raster' | 'vector';
    /** True if this chart is DRM-protected (ocharts) and needs URL encryption */
    isDrm?: boolean;
}

// ── ocharts DRM Bootstrap ──
// The ocharts token script registers on window.avnav.ochartsProvider(NG) and provides
// heartBeat() (initialization) and encryptUrl() (tile URL encryption).
// CRITICAL: The script MUST be loaded via <script src="direct-ocharts-url"> so that
// document.currentScript.src resolves to the real ocharts server. This means DRM
// charts only work on Capacitor (native) where there are no CORS restrictions.
// In dev mode (browser), heartBeat can't initialize through the Vite proxy.

let _ochartsBootstrapped = false;
// Server-assigned DRM sessionId and client's original sessionId.
// The server creates sessions with ITS OWN generated ID, but the client
// embeds ITS OWN ID in encrypted URLs. We must rewrite one to match.
let _drmServerSessionId: string | null = null;
let _drmClientSessionId: string | null = null;
let _heartbeatLoggedOnce = false;

/**
 * Bootstrap the ocharts DRM provider (native/Capacitor only).
 * Loads the token script directly from the ocharts server via <script src>.
 * The script auto-initializes via heartBeat using document.currentScript.src.
 */
function bootstrapOchartsDrm(tokenUrl: string): void {
    if (_ochartsBootstrapped || IS_DEV) return;
    _ochartsBootstrapped = true;

    // Ensure window.avnav exists so the token script can register its provider
    if (!(window as unknown as Record<string, unknown>).avnav) {
        (window as unknown as Record<string, unknown>).avnav = {};
    }

    // WKWebView blocks cross-origin <script src> from local IPs.
    // Fetch the DRM script via CapacitorHttp (native networking, CORS-free)
    // and eval() it directly.
    (async () => {
        try {
            await nativeLogAsync(`DRM: Fetching token script from ${tokenUrl}`);
            const res = await CapacitorHttp.get({
                url: tokenUrl,
                responseType: 'text',
                connectTimeout: 10000,
                readTimeout: 10000,
            });

            if (res.status < 200 || res.status >= 300) {
                await nativeLogAsync(`DRM: Token script HTTP ${res.status}`);
                _ochartsBootstrapped = false;
                return;
            }

            const scriptText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            await nativeLogAsync(`DRM: Script loaded (${scriptText.length} bytes). Evaluating...`);

            // The ocharts script uses document.currentScript.src to derive the server
            // base URL for heartBeat callbacks. With eval(), document.currentScript is
            // null, so we override it before executing the script.
            const fakeScript = document.createElement('script');
            fakeScript.src = tokenUrl;
            document.head.appendChild(fakeScript);
            Object.defineProperty(document, 'currentScript', {
                value: fakeScript,
                writable: true,
                configurable: true,
            });

            try {
                // eslint-disable-next-line no-eval
                (0, eval)(scriptText);
            } catch (evalErr) {
                await nativeLogAsync(`DRM: eval error: ${(evalErr as Error)?.message || evalErr}`);
                _ochartsBootstrapped = false;
                return;
            }
            // NOTE: We intentionally leave document.currentScript pointing to fakeScript.
            // The DRM provider's heartbeat callbacks use document.currentScript.src
            // asynchronously, so restoring it to null would break the heartbeat.

            const avnav = (window as unknown as Record<string, unknown>).avnav as Record<string, unknown> | undefined;
            const provider = (avnav?.ochartsProvider || avnav?.ochartsProviderNG) as
                | Record<string, unknown>
                | undefined;
            if (provider && typeof provider.encryptUrl === 'function') {
                // Cache the provider reference so it survives even if window.avnav is modified later
                _cachedOchartsProvider = provider as Record<string, (...args: unknown[]) => unknown>;

                // CRITICAL FIX: DRM SessionId mismatch.
                // The server's TokenHandler::NewToken(clientSessionId) can't find the
                // client-generated sessionId, creates a DIFFERENT session.
                // Fix: pre-create a server session, capture its ID, then intercept
                // BOTH the heartbeat (to use server's ID) AND encrypted URL output
                // (to rewrite client's ID → server's ID).

                // Step 1: Pre-create server session
                const tokenBase = tokenUrl.replace(/\?.*$/, '');
                try {
                    const initRes = await CapacitorHttp.get({
                        url: `${tokenBase}?request=key`,
                        responseType: 'text',
                    });
                    const initData = typeof initRes.data === 'string' ? JSON.parse(initRes.data) : initRes.data;
                    _drmServerSessionId = initData?.data?.sessionId || initData?.sessionId || null;
                    await nativeLogAsync(`DRM: Server session created sid=${_drmServerSessionId?.slice(0, 16)}…`);
                } catch (e) {
                    await nativeLogAsync(`DRM: Session init error: ${(e as Error)?.message?.slice(0, 80)}`);
                }

                // Step 2: Intercept heartbeat fetch to fix TWO issues:
                // A) Rewrite client's sessionId → server's sessionId
                // B) Unwrap CapacitorHttp's response envelope so DRM script
                //    gets raw server JSON (not double-wrapped {data:{data:{key:...}}})
                if (_drmServerSessionId) {
                    const _origFetch = window.fetch;
                    window.fetch = (async (...args: Parameters<typeof fetch>) => {
                        const url = String(args[0]);
                        if (url.includes('/tokens/') && url.includes('request=key')) {
                            await nativeLogAsync(`DRM-INTERCEPT: raw url="${url.slice(0, 120)}"`);
                            // Capture client sessionId on first intercept
                            if (!_drmClientSessionId && url.includes('sessionId=')) {
                                const m = url.match(/sessionId=([^&]+)/);
                                if (m) _drmClientSessionId = m[1];
                            }
                            // Rewrite sessionId and make request via CapacitorHttp
                            const fixedUrl = url.includes('sessionId=')
                                ? url.replace(/sessionId=[^&]+/, `sessionId=${_drmServerSessionId}`)
                                : url + `&sessionId=${_drmServerSessionId}`;
                            try {
                                const capRes = await CapacitorHttp.get({
                                    url: fixedUrl,
                                    responseType: 'text',
                                });
                                // NUCLEAR FIX: CapacitorHttp INCONSISTENTLY strips "status":"OK"
                                // from server responses. Instead of trying to navigate arbitrary
                                // nesting, regex-extract the 3 fields from the raw stringified data
                                // and construct the EXACT JSON the DRM script expects.
                                // From TokenHandler.cpp: DecryptUrl expects {sessionId}/{sequence}/{iv}/{ciphertext}
                                // and the heartbeat returns {status:"OK", data:{sessionId, sequence, key}}
                                const rawDataType = typeof capRes.data;
                                const rawDataStr =
                                    rawDataType === 'string' ? (capRes.data as string) : JSON.stringify(capRes.data);

                                // Regex-extract the three required fields from ANY nesting format
                                const keyMatch = rawDataStr.match(/"key"\s*:\s*"([^"]+)"/);
                                const seqMatch = rawDataStr.match(/"sequence"\s*:\s*(\d+)/);
                                const sidMatch = rawDataStr.match(/"sessionId"\s*:\s*"([^"]+)"/);

                                const extractedKey = keyMatch?.[1] || '';
                                const extractedSeq = parseInt(seqMatch?.[1] || '1', 10);
                                const extractedSid = sidMatch?.[1] || _drmServerSessionId;

                                // Hard-construct the EXACT format the DRM script expects:
                                // {"status":"OK","data":{"sessionId":"X","sequence":N,"key":"Y"}}
                                const serverJson = JSON.stringify({
                                    status: 'OK',
                                    data: {
                                        sessionId: extractedSid,
                                        sequence: extractedSeq,
                                        key: extractedKey,
                                    },
                                });
                                // Log heartbeat success sparingly (only first one)
                                if (!_heartbeatLoggedOnce) {
                                    _heartbeatLoggedOnce = true;
                                    await nativeLogAsync(`DRM: Heartbeat OK sid=${extractedSid?.slice(0, 16)}…`);
                                }
                                return new Response(serverJson, {
                                    status: 200,
                                    headers: { 'content-type': 'application/json' },
                                });
                            } catch (e) {
                                await nativeLogAsync(
                                    `DRM-SESSION: Heartbeat fetch error: ${(e as Error)?.message?.slice(0, 80)}`,
                                );
                                return new Response('{"error":"fetch failed"}', { status: 500 });
                            }
                        }
                        return _origFetch.apply(window, args);
                    }) as typeof fetch;
                }

                // Step 3: Call heartBeat AND AWAIT its promise.
                // CRITICAL: The AvNav GUI does heartBeat().then(...) — it returns a Promise.
                // Without awaiting, the RSA key decryption may not complete before we
                // try to use encryptUrl, resulting in wrong AES keys and 404 tiles.
                if (typeof provider.heartBeat === 'function') {
                    try {
                        const hbResult = (provider.heartBeat as () => unknown)();
                        // heartBeat() may return a Promise — await it
                        if (hbResult && typeof (hbResult as Promise<unknown>).then === 'function') {
                            await nativeLogAsync(`DRM: heartBeat() returned Promise, awaiting...`);
                            await (hbResult as Promise<unknown>);
                            await nativeLogAsync(`DRM: heartBeat() Promise resolved ✅`);
                        } else {
                            await nativeLogAsync(`DRM: heartBeat() returned non-Promise: ${typeof hbResult}`);
                            // Still wait a bit for any async side effects
                            await new Promise((r) => setTimeout(r, 2000));
                        }
                    } catch (hbErr) {
                        await nativeLogAsync(`DRM: heartBeat() error: ${(hbErr as Error)?.message?.slice(0, 100)}`);
                    }
                }

                // Poll for encryptUrl readiness (typically ~500ms after first heartBeat call)
                const testUrl = tokenUrl.replace(/\/tokens\/.*$/, '/charts/test/0/0/0.png');
                let heartbeatOk = false;
                for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try {
                        const result = (
                            _cachedOchartsProvider as Record<string, (...args: unknown[]) => unknown>
                        ).encryptUrl(testUrl);
                        if (typeof result === 'string' && result.length > 0) {
                            heartbeatOk = true;
                            await nativeLogAsync(`DRM: ✅ encryptUrl ready after ${(i + 1) * 500}ms`);
                            break;
                        }
                    } catch {
                        // provider may throw during init — keep waiting
                    }
                    // Re-call heartBeat each iteration in case it needs multiple invocations
                    if (typeof provider.heartBeat === 'function') {
                        try {
                            (provider.heartBeat as () => unknown)();
                        } catch {
                            /* ignore */
                        }
                    }
                }
                if (!heartbeatOk) {
                    await nativeLogAsync('DRM: ⚠️ encryptUrl still unavailable after 10s');
                    // DRM fully bootstrapped — keep heartBeat running periodically
                    await nativeLogAsync(`DRM: ✅ OCharts DRM active — session=${_drmServerSessionId?.slice(0, 16)}…`);
                }

                // Set up periodic heartBeat to keep the DRM token alive (mirrors AvNav's main loop)
                setInterval(() => {
                    if (
                        _cachedOchartsProvider &&
                        typeof (_cachedOchartsProvider as Record<string, unknown>).heartBeat === 'function'
                    ) {
                        try {
                            (_cachedOchartsProvider as Record<string, (...args: unknown[]) => unknown>).heartBeat();
                        } catch {
                            /* ignore */
                        }
                    }
                }, 5000);
            } else {
                await nativeLogAsync(
                    `DRM: ⚠️ Script evaluated but encryptUrl not found. Keys: ${avnav ? Object.keys(avnav).join(',') : 'none'}`,
                );
                _ochartsBootstrapped = false;
            }
        } catch (e) {
            const msg = (e as Error)?.message || String(e);
            await nativeLogAsync(`DRM: ❌ Bootstrap failed: ${msg}`);
            _ochartsBootstrapped = false;
        }
    })();
}

/**
 * Cached reference to the ocharts DRM provider, captured at bootstrap time.
 * This prevents the provider from being lost if window.avnav is later modified.
 */
let _cachedOchartsProvider: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Find the ocharts provider — uses cached reference first, falls back to window.avnav.
 */
function getOchartsProvider(): Record<string, (...args: unknown[]) => unknown> | null {
    // Return cached provider if available
    if (_cachedOchartsProvider && typeof _cachedOchartsProvider.encryptUrl === 'function') {
        return _cachedOchartsProvider;
    }
    // Fallback: check window.avnav
    const avnav = (window as unknown as Record<string, unknown>).avnav as Record<string, unknown> | undefined;
    if (!avnav) return null;
    const provider = (avnav.ochartsProvider || avnav.ochartsProviderNG) as
        | Record<string, (...args: unknown[]) => unknown>
        | undefined;
    if (provider && typeof provider.encryptUrl === 'function') {
        _cachedOchartsProvider = provider; // Cache for future calls
        return provider;
    }
    return null;
}

/**
 * Encrypt an ocharts tile URL using the loaded DRM provider.
 * Returns the encrypted URL, or null if encryption isn't available.
 * Sets _lastEncryptDiag with the reason for failure (readable via getLastEncryptDiag).
 */
let _lastEncryptDiag = '';
export function getLastEncryptDiag(): string {
    return _lastEncryptDiag;
}

export function encryptOchartsUrl(url: string): string | null {
    const provider = getOchartsProvider();
    if (!provider) {
        _lastEncryptDiag = _cachedOchartsProvider
            ? `cached-exists(encryptUrl=${typeof _cachedOchartsProvider.encryptUrl})`
            : 'no-provider';
        return null;
    }
    try {
        const parsed = new URL(url);
        const origin = parsed.origin; // e.g. http://192.168.50.7:8083

        // CRITICAL DISCOVERY: The AvNav GUI only passes the z/x/y.png tile
        // coordinates to encryptUrl(), NOT the full chart path. The chart base
        // path (e.g. /charts/CSI_oeuSENC-AU-2026-1-11-base-linux/) stays as
        // a URL prefix, and the encrypted segment replaces only the tile part.
        //
        // URL structure: http://host:8083/charts/CSI_.../z/x/y.png
        // Chart base:    /charts/CSI_oeuSENC-AU-2026-1-11-base-linux
        // Tile part:     z/x/y.png
        //
        // encryptUrl("z/x/y.png") → "encrypted/{sid}/{seq}/{iv}/{ct}"
        // Final URL: http://host:8083/charts/CSI_.../encrypted/{sid}/{seq}/{iv}/{ct}

        const pathOnly = parsed.pathname; // e.g. /charts/CSI_.../10/942/614.png

        // Split the path into chart-base and tile-coordinates.
        // The chart base path matches: /charts/CSI_oeuSENC-{name}/
        // Everything after that is the z/x/y.png tile coordinates.
        const chartBaseMatch = pathOnly.match(/^(\/charts\/[^/]+)\/(.*)/);
        let chartBase: string;
        let tilePart: string;
        if (chartBaseMatch) {
            chartBase = chartBaseMatch[1]; // /charts/CSI_oeuSENC-AU-2026-1-11-base-linux
            tilePart = chartBaseMatch[2]; // 10/942/614.png
        } else {
            // Fallback: pass full path (shouldn't happen for valid chart URLs)
            chartBase = '';
            tilePart = pathOnly.startsWith('/') ? pathOnly.slice(1) : pathOnly;
        }

        // Pass ONLY the tile coordinates to encryptUrl
        const encrypted = provider.encryptUrl(tilePart);
        if (typeof encrypted === 'string' && encrypted.length > 0) {
            // Reconstruct: origin + chartBase + "/" + encrypted
            let finalUrl = `${origin}${chartBase}/${encrypted}`;
            // Rewrite client sessionId → server sessionId in encrypted URL
            if (_drmClientSessionId && _drmServerSessionId && finalUrl.includes(_drmClientSessionId)) {
                finalUrl = finalUrl.replace(_drmClientSessionId, _drmServerSessionId);
            }
            return finalUrl;
        }
        _lastEncryptDiag = `returned-empty: path=${typeof encrypted}(${String(encrypted).slice(0, 40)})`;
    } catch (e) {
        _lastEncryptDiag = `THREW: ${(e as Error)?.message?.slice(0, 60) || String(e).slice(0, 60)}`;
    }
    return null;
}

export type AvNavConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type StatusCallback = (status: AvNavConnectionStatus) => void;
type ChartCallback = (charts: AvNavChart[]) => void;

// ── Constants ──

const DEFAULT_HOST = '';
const DEFAULT_PORT = 3000;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // Verify connection every 60s
const CHART_REFRESH_INTERVAL_MS = 5 * 60_000; // Re-scan charts every 5 min

/**
 * In browser dev mode (Vite), we can't fetch cross-origin LAN devices
 * due to CORS. Route through Vite's proxy instead.
 * In Capacitor native, CORS isn't enforced so direct fetch works.
 */
const IS_DEV = import.meta.env?.DEV ?? false;

// ── Singleton ──

class AvNavServiceClass {
    private host = DEFAULT_HOST; // LAN address (primary)
    private wanHost = ''; // WAN address (fallback when LAN unreachable)
    private activeHost = ''; // Which host actually connected
    private port = DEFAULT_PORT;
    private status: AvNavConnectionStatus = 'disconnected';
    private apiVersion: 'v1' | 'v2' | null = null; // Detected API version
    private serverType: 'signalk' | 'avnav' | null = null; // Auto-detected server type
    private charts: AvNavChart[] = [];
    private enabled = false;

    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private chartRefreshTimer: ReturnType<typeof setInterval> | null = null;

    private statusListeners = new Set<StatusCallback>();
    private chartListeners = new Set<ChartCallback>();

    private lastError: string | null = null;

    // ── Public API ──

    configure(host: string, port: number, explicitType?: 'signalk' | 'avnav', wanHost?: string) {
        this.host = host || DEFAULT_HOST;
        this.port = port || DEFAULT_PORT;
        if (explicitType) this.serverType = explicitType;
        if (wanHost !== undefined) this.wanHost = wanHost;
    }

    getHost(): string {
        return this.host;
    }
    getPort(): number {
        return this.port;
    }
    getStatus(): AvNavConnectionStatus {
        return this.status;
    }
    getCharts(): AvNavChart[] {
        return this.charts;
    }
    getApiVersion(): string | null {
        return this.apiVersion;
    }
    getLastError(): string | null {
        return this.lastError;
    }
    isEnabled(): boolean {
        return this.enabled;
    }
    getServerType(): 'signalk' | 'avnav' | null {
        return this.serverType;
    }
    getWanHost(): string {
        return this.wanHost;
    }
    getActiveHost(): string {
        return this.activeHost || this.host;
    }
    /** True if currently connected via the WAN address */
    isWanActive(): boolean {
        return this.activeHost === this.wanHost && this.wanHost !== '';
    }

    /**
     * Auto-start on app boot if config was previously saved.
     */
    autoStart() {
        const savedHost = localStorage.getItem('avnav_chart_host');
        const savedPort = localStorage.getItem('avnav_chart_port');
        const savedEnabled = localStorage.getItem('signalk_enabled');
        const savedType = localStorage.getItem('avnav_server_type') as 'signalk' | 'avnav' | null;
        nativeLog(`autoStart: host=${savedHost}, port=${savedPort}, enabled=${savedEnabled}, type=${savedType}`);
        if (!savedHost || savedEnabled !== 'true') {
            nativeLog('autoStart: skipped — no saved config');
            return;
        }
        const savedWanHost = localStorage.getItem('avnav_wan_host') || '';
        nativeLog(`autoStart: connecting... (wan=${savedWanHost || 'none'})`);
        this.configure(
            savedHost,
            parseInt(savedPort || String(DEFAULT_PORT), 10),
            savedType || undefined,
            savedWanHost,
        );
        this.start();
    }

    async start() {
        if (this.enabled) return;
        this.enabled = true;
        this.reconnectAttempts = 0;
        this.lastError = null;

        // Save config
        localStorage.setItem('avnav_chart_host', this.host);
        localStorage.setItem('avnav_chart_port', String(this.port));
        localStorage.setItem('signalk_enabled', 'true');
        if (this.serverType) localStorage.setItem('avnav_server_type', this.serverType);
        if (this.wanHost) localStorage.setItem('avnav_wan_host', this.wanHost);
        else localStorage.removeItem('avnav_wan_host');

        await this.connect();
    }

    stop() {
        this.enabled = false;
        this.charts = [];
        this.apiVersion = null;
        this.reconnectAttempts = 0;
        this.lastError = null;

        localStorage.setItem('signalk_enabled', 'false');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        if (this.chartRefreshTimer) {
            clearInterval(this.chartRefreshTimer);
            this.chartRefreshTimer = null;
        }

        this.setStatus('disconnected');
        this.emitCharts();
    }

    onStatusChange(cb: StatusCallback): () => void {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
    }

    onChartsChange(cb: ChartCallback): () => void {
        this.chartListeners.add(cb);
        return () => this.chartListeners.delete(cb);
    }

    /** Build base URL, routing through Vite proxy in dev to bypass CORS */
    private getBaseUrl(): string {
        return IS_DEV ? `/__chart-proxy/${this.host}/${this.port}` : `http://${this.host}:${this.port}`;
    }

    /**
     * Build a full tile URL for a given chart.
     * Used by Mapbox as a raster tile source.
     */
    getTileUrl(chart: AvNavChart): string {
        return chart.tilesUrl;
    }

    // ── Connection ──

    private async connect() {
        if (!this.enabled) return;
        this.setStatus('connecting');

        const directUrl = `http://${this.host}:${this.port}`;

        try {
            // ── Explicit AvNav mode — skip all detection ──
            if (this.serverType === 'avnav') {
                this.apiVersion = null;

                // Try LAN first, then WAN fallback
                const hostsToTry = [this.host];
                if (this.wanHost && this.wanHost !== this.host) hostsToTry.push(this.wanHost);

                for (const tryHost of hostsToTry) {
                    const tryUrl = `http://${tryHost}:${this.port}`;
                    nativeLog(`Trying ${tryHost === this.host ? 'LAN' : 'WAN'}: ${tryUrl}`);
                    const reachable = await this.probeAvNavWithImage(tryUrl);
                    if (reachable) {
                        this.activeHost = tryHost;
                        nativeLog(`Connected to AvNav at ${tryUrl} (${tryHost === this.host ? 'LAN' : 'WAN'})`);
                        this.reconnectAttempts = 0;
                        this.setStatus('connected');
                        await this.tryFetchAvNavCharts(tryUrl);
                        this.startHealthCheck();
                        this.startChartRefresh();
                        return;
                    }
                }

                // Neither LAN nor WAN responded — report error and schedule retry
                const triedHosts = hostsToTry.join(', ');
                nativeLog(`No probe response from any host (${triedHosts}), scheduling reconnect`);
                this.lastError = `Unreachable: ${triedHosts}`;
                this.setStatus('error');
                if (this.enabled) this.scheduleReconnect();
                return;
            }

            // ── Auto-detect: try AvNav image probe first ──
            nativeLog(`Probing for AvNav at ${directUrl}...`);
            const isAvNav = await this.probeAvNavWithImage(directUrl);
            nativeLog(`AvNav probe result: ${isAvNav}`);
            if (isAvNav) {
                nativeLog(`Connected to AvNav at ${directUrl}`);
                this.reconnectAttempts = 0;
                this.setStatus('connected');

                // Create a default chart entry — AvNav always serves tiles at /tiles/
                this.charts = [
                    {
                        id: 'avnav-default',
                        name: 'AvNav Charts',
                        description: `Charts from ${this.host}:${this.port}`,
                        tilesUrl: `${directUrl}/tiles/{z}/{x}/{y}.png`,
                        format: 'png',
                        minZoom: 1,
                        maxZoom: 18,
                        type: 'raster',
                    },
                ];
                this.emitCharts();
                nativeLog('AvNav: created default chart tile source');

                // Try to discover individual chart sets via fetch (best-effort)
                this.tryFetchAvNavCharts(directUrl);

                this.startHealthCheck();
                this.startChartRefresh();
                return;
            }

            // ── Try SignalK (fetch-based — works in Capacitor, may fail in browser dev) ──
            const baseUrl = this.getBaseUrl();
            this.apiVersion = await this.detectApiVersion(baseUrl);

            if (!this.apiVersion) {
                throw new Error('No Signal K or AvNav server detected');
            }

            this.serverType = 'signalk';
            log.info(`Connected to Signal K ${this.apiVersion} at ${baseUrl}`);
            this.reconnectAttempts = 0;
            this.setStatus('connected');

            // Fetch charts immediately
            await this.fetchCharts();

            // Start health check + chart refresh
            this.startHealthCheck();
            this.startChartRefresh();
        } catch (e: unknown) {
            const msg = (e as Error)?.message || String(e);
            console.error('[AvNav] Connection failed:', msg);
            nativeLog(`Connection failed: ${msg}`);
            this.lastError = msg;
            this.setStatus('error');
            if (this.enabled) this.scheduleReconnect();
        }
    }

    /**
     * Probe AvNav server by making a native HTTP request.
     * Uses CapacitorHttp to bypass CORS restrictions in WKWebView.
     */
    private async probeAvNavWithImage(baseUrl: string): Promise<boolean> {
        const endpoints = [
            `${baseUrl}/api/status`,
            `${baseUrl}/viewer/avnav_navi.php`,
            `${baseUrl}/api/list?type=chart`,
        ];
        for (const url of endpoints) {
            try {
                const res = await CapacitorHttp.get({
                    url,
                    connectTimeout: 5000,
                    readTimeout: 5000,
                });
                if (res.status >= 200 && res.status < 400) return true;
            } catch {
                /* try next */
            }
        }
        return false;
    }

    /**
     * Discover charts from the AvNav API.
     * Tries multiple endpoint patterns since different AvNav versions serve
     * chart lists at different URLs.
     * Routes through CapacitorHttp to bypass CORS.
     */
    private async tryFetchAvNavCharts(directUrl: string) {
        const apiBase = IS_DEV ? `/__chart-proxy/${this.host}/${this.port}` : directUrl;

        const endpoints = [
            `${apiBase}/viewer/avnav_navi.php?request=listdir&type=chart`,
            `${apiBase}/api/list?type=chart`,
            `${apiBase}/api/charts`,
        ];

        for (const chartListUrl of endpoints) {
            await nativeLogAsync(`Trying: ${chartListUrl}`);
            try {
                const res = await CapacitorHttp.get({
                    url: chartListUrl,
                    connectTimeout: 10000,
                    readTimeout: 10000,
                });
                await nativeLogAsync(`Response: ${res.status} (${chartListUrl.split('/').slice(-1)})`);
                if (res.status < 200 || res.status >= 300) continue;

                const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                await nativeLogAsync(`Body (first 300): ${text.substring(0, 300)}`);

                let data: unknown;
                try {
                    data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                } catch {
                    await nativeLogAsync('Response is not JSON, skipping...');
                    continue;
                }

                const discovered = this.parseAvNavCharts(data);
                await nativeLogAsync(
                    `Parsed ${discovered.length} chart(s): ${discovered.map((c) => `${c.name}[drm=${!!c.isDrm}]`).join(', ')}`,
                );
                if (discovered.length > 0) {
                    // Log each chart's tile URL for debugging
                    for (const c of discovered) {
                        await nativeLogAsync(`TILE URL [${c.name}]: ${c.tilesUrl}`);
                    }
                    this.charts = discovered;
                    this.emitCharts();
                    await nativeLogAsync(`SUCCESS: discovered ${discovered.length} chart set(s)`);

                    // Test-fetch a single tile to verify accessibility
                    for (const c of discovered) {
                        const testUrl = c.tilesUrl.replace('{z}', '10').replace('{x}', '900').replace('{y}', '596');
                        try {
                            const tileRes = await CapacitorHttp.get({
                                url: testUrl,
                                connectTimeout: 5000,
                                readTimeout: 5000,
                                responseType: 'blob',
                            });
                            await nativeLogAsync(
                                `TEST TILE [${c.name}]: ${testUrl} → status=${tileRes.status}, content-type=${tileRes.headers?.['content-type']}`,
                            );
                        } catch (te) {
                            await nativeLogAsync(`TEST TILE FAIL [${c.name}]: ${testUrl} → ${(te as Error)?.message}`);
                        }
                    }

                    return;
                }
            } catch (e) {
                const msg = (e as Error)?.message || String(e);
                await nativeLogAsync(`FAILED ${chartListUrl.split('?')[0].split('/').slice(-2).join('/')}: ${msg}`);
            }
        }

        // Fallback: create a generic tile source
        const tileBaseUrl = IS_DEV ? `/__chart-proxy/${this.host}/${this.port}` : directUrl;
        this.charts = [
            {
                id: 'avnav-default',
                name: 'AvNav Charts',
                description: `Charts from ${this.host}:${this.port}`,
                tilesUrl: `${tileBaseUrl}/tiles/{z}/{x}/{y}.png`,
                format: 'png',
                minZoom: 1,
                maxZoom: 18,
                type: 'raster',
            },
        ];
        this.emitCharts();
        await nativeLogAsync(`FALLBACK: using generic tile source: ${tileBaseUrl}/tiles/{z}/{x}/{y}.png`);
    }

    /**
     * Detect the Signal K API version by probing endpoints.
     * Uses CapacitorHttp to bypass CORS.
     */
    private async detectApiVersion(baseUrl: string): Promise<'v1' | 'v2' | null> {
        const versions: Array<{ path: string; ver: 'v2' | 'v1' }> = [
            { path: '/signalk/v2/api', ver: 'v2' },
            { path: '/signalk/v1/api', ver: 'v1' },
        ];
        for (const { path, ver } of versions) {
            try {
                const res = await CapacitorHttp.get({
                    url: `${baseUrl}${path}`,
                    connectTimeout: 5000,
                    readTimeout: 5000,
                });
                if (res.status >= 200 && res.status < 300) return ver;
            } catch {
                /* not available */
            }
        }
        // Last resort — discovery endpoint
        try {
            const res = await CapacitorHttp.get({
                url: `${baseUrl}/signalk`,
                connectTimeout: 5000,
                readTimeout: 5000,
            });
            if (res.status >= 200 && res.status < 300) {
                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data?.endpoints?.v2) return 'v2';
                if (data?.endpoints?.v1) return 'v1';
                return 'v1';
            }
        } catch {
            /* no response */
        }
        return null;
    }

    /**
     * Detect if the server is AvNav by probing its API.
     * Uses CapacitorHttp to bypass CORS.
     */
    private async detectAvNav(baseUrl: string): Promise<boolean> {
        return this.probeAvNavWithImage(baseUrl);
    }

    /**
     * Fetch available charts from an AvNav server.
     * AvNav serves tiles at: /tiles/{chartName}/{z}/{x}/{y}.png
     */
    private async fetchAvNavCharts() {
        const baseUrl = this.getBaseUrl();

        try {
            const res = await fetch(`${baseUrl}/api/list?type=chart`, {
                signal: AbortSignal.timeout(10_000),
            });

            if (!res.ok) {
                log.info('AvNav: no charts available');
                this.charts = [];
                this.emitCharts();
                return;
            }

            const data = await res.json();
            this.charts = this.parseAvNavCharts(data);
            log.info(`AvNav: discovered ${this.charts.length} chart(s)`);
            this.emitCharts();
        } catch (e) {
            log.warn('AvNav: failed to fetch charts:', e);
        }
    }

    /**
     * Parse AvNav chart list response.
     * AvNav returns items with: name, chartKey, url (absolute to the AvNav host).
     * Charts may be served from different ports (e.g. ocharts on 8083).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private parseAvNavCharts(data: any): AvNavChart[] {
        const charts: AvNavChart[] = [];
        const items = Array.isArray(data) ? data : data?.items || data?.data || [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const name = String(item.name || item.chartKey || 'Unknown');
            const chartUrl: string = item.url || '';
            const hasToken = !!item.tokenUrl; // ocharts DRM-protected chart

            // Skip online-only chart definitions (e.g. osm-online.xml)
            if (name.includes('online') || chartUrl.startsWith('http://osm')) continue;

            let tilesUrl = '';

            if (hasToken && chartUrl.startsWith('http')) {
                // ocharts DRM chart — only works on native (Capacitor).
                // heartBeat needs document.currentScript.src to resolve to the real
                // ocharts server, which fails through the Vite dev proxy.
                if (IS_DEV) {
                    log.info(`Skipping DRM chart in dev (native-only): ${name}`);
                    continue;
                }

                // Native: bootstrap the DRM provider with the direct ocharts URL
                const tokenUrl = String(item.tokenUrl);
                bootstrapOchartsDrm(tokenUrl);
                tilesUrl = chartUrl;
            } else if (chartUrl.startsWith('http://') || chartUrl.startsWith('https://')) {
                // Absolute URL — extract host:port for proxy routing
                try {
                    const parsed = new URL(chartUrl);
                    const chartHost = parsed.hostname;
                    const chartPort = parsed.port || '80';
                    const chartPath = parsed.pathname;
                    if (IS_DEV) {
                        tilesUrl = `/__chart-proxy/${chartHost}/${chartPort}${chartPath}`;
                    } else {
                        tilesUrl = chartUrl;
                    }
                } catch {
                    tilesUrl = chartUrl;
                }
            } else {
                // Relative path — use AvNav host
                const path = chartUrl.startsWith('/') ? chartUrl : `/${chartUrl}`;
                if (IS_DEV) {
                    tilesUrl = `/__chart-proxy/${this.host}/${this.port}${path}`;
                } else {
                    tilesUrl = `http://${this.host}:${this.port}${path}`;
                }
            }

            // Append tile coordinate template if not present
            if (!tilesUrl.includes('{z}')) {
                tilesUrl = `${tilesUrl}/{z}/{x}/{y}.png`;
            }

            charts.push({
                id: `avnav-${name.replace(/[^a-zA-Z0-9-]/g, '_')}`,
                name: name.replace(/\.(gemf|mbtiles|xml)$/i, ''),
                description: `AvNav: ${name}`,
                tilesUrl,
                format: 'png',
                minZoom: Number(item.minzoom ?? 1),
                maxZoom: Number(item.maxzoom ?? 18),
                bounds: item.bounds ? item.bounds : undefined,
                type: 'raster',
                isDrm: hasToken || undefined,
            });
        }

        return charts;
    }

    /**
     * Fetch available charts from the Signal K Resources API.
     */
    private async fetchCharts() {
        const baseUrl = this.getBaseUrl();
        const chartsEndpoint =
            this.apiVersion === 'v2'
                ? `${baseUrl}/signalk/v2/api/resources/charts`
                : `${baseUrl}/signalk/v1/api/resources/charts`;

        try {
            const res = await fetch(chartsEndpoint, {
                signal: AbortSignal.timeout(10_000),
            });

            if (!res.ok) {
                // Charts endpoint might not exist if no chart plugin is installed
                log.info('No charts available (plugin may not be installed)');
                this.charts = [];
                this.emitCharts();
                return;
            }

            const data = await res.json();
            this.charts = this.parseCharts(data);
            log.info(`Discovered ${this.charts.length} chart(s)`);
            this.emitCharts();
        } catch (e) {
            log.warn('Failed to fetch charts:', e);
            // Don't clear existing charts on a transient fetch error
        }
    }

    /**
     * Parse the Signal K charts response into our internal format.
     * The response shape varies between v1 and v2, and between plugins.
     */
    private parseCharts(data: Record<string, unknown>): AvNavChart[] {
        const baseUrl = this.getBaseUrl();
        const charts: AvNavChart[] = [];

        // Response is typically { chartId: { ...chartData } }
        for (const [id, raw] of Object.entries(data)) {
            if (!raw || typeof raw !== 'object') continue;
            const chart = raw as Record<string, unknown>;

            // Extract tile URL
            let tilesUrl = (chart.tilemapUrl || chart.tilesUrl || chart.url || '') as string;
            if (!tilesUrl) continue;

            // Resolve relative URLs
            if (tilesUrl.startsWith('/')) {
                tilesUrl = `${baseUrl}${tilesUrl}`;
            }

            // Ensure URL has {z}/{x}/{y} placeholders
            if (!tilesUrl.includes('{z}')) {
                tilesUrl = `${tilesUrl}/{z}/{x}/{y}`;
            }

            // Detect format
            let format: 'png' | 'pbf' | 'jpg' | 'webp' = 'png';
            const formatStr = String(chart.format || '').toLowerCase();
            if (formatStr.includes('pbf')) format = 'pbf';
            else if (formatStr.includes('jpg') || formatStr.includes('jpeg')) format = 'jpg';
            else if (formatStr.includes('webp')) format = 'webp';

            // Parse bounds
            let bounds: [number, number, number, number] | undefined;
            if (Array.isArray(chart.bounds) && chart.bounds.length === 4) {
                bounds = chart.bounds as [number, number, number, number];
            } else if (chart.bounds && typeof chart.bounds === 'object' && !Array.isArray(chart.bounds)) {
                const b = chart.bounds as Record<string, unknown>;
                if (b.west != null && b.south != null && b.east != null && b.north != null) {
                    bounds = [Number(b.west), Number(b.south), Number(b.east), Number(b.north)];
                }
            }

            charts.push({
                id,
                name: String(chart.name || chart.identifier || id),
                description: String(chart.description || ''),
                tilesUrl,
                format,
                minZoom: Number(chart.minzoom ?? chart.minZoom ?? 1),
                maxZoom: Number(chart.maxzoom ?? chart.maxZoom ?? 18),
                bounds,
                type: format === 'pbf' ? 'vector' : 'raster',
            });
        }

        return charts;
    }

    // ── Health check ──

    private startHealthCheck() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL_MS);
    }

    private async checkHealth() {
        if (!this.enabled || this.status !== 'connected') return;

        const baseUrl = this.getBaseUrl();
        try {
            const res = await fetch(`${baseUrl}/signalk`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
            // If it's an AvNav server, try AvNav health check instead
            if (this.serverType === 'avnav') {
                try {
                    const res2 = await fetch(`${baseUrl}/api/status`, {
                        signal: AbortSignal.timeout(5000),
                    });
                    if (res2.ok) return; // AvNav is healthy
                } catch {
                    /* AvNav also down */
                }
            }
            log.warn('Health check failed — reconnecting');
            this.setStatus('disconnected');
            this.scheduleReconnect();
        }
    }

    private startChartRefresh() {
        if (this.chartRefreshTimer) clearInterval(this.chartRefreshTimer);
        this.chartRefreshTimer = setInterval(() => {
            if (this.status === 'connected') {
                if (this.serverType === 'avnav') {
                    this.fetchAvNavCharts();
                } else {
                    this.fetchCharts();
                }
            }
        }, CHART_REFRESH_INTERVAL_MS);
    }

    // ── Reconnect ──

    private scheduleReconnect() {
        if (!this.enabled || this.reconnectTimer) return;
        if (this.reconnectAttempts > 10) {
            log.info('Giving up after 10 reconnect attempts');
            this.lastError = 'Could not reach AvNav chart server';
            this.setStatus('error');
            return;
        }

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ── Emit ──

    private setStatus(s: AvNavConnectionStatus) {
        this.status = s;
        for (const cb of this.statusListeners) {
            try {
                cb(s);
            } catch (e) {
                log.warn('Status listener error:', e);
            }
        }
    }

    private emitCharts() {
        const charts = [...this.charts];
        for (const cb of this.chartListeners) {
            try {
                cb(charts);
            } catch (e) {
                log.warn('Chart listener error:', e);
            }
        }
    }

    // ── Network Scanning ──

    /**
     * Scan the local network for AvNav/SignalK servers.
     * Uses CapacitorHttp to probe common ports on the local subnet.
     *
     * Strategy:
     *   1. Try mDNS-style hostnames first (fast, no subnet needed)
     *   2. Detect local IP via WebRTC
     *   3. Probe .1–.254 on common ports (8080, 8082, 3000) with short timeouts
     *
     * Returns discovered servers sorted by response time.
     */
    async scanNetwork(
        onProgress?: (scanned: number, total: number) => void,
        onFound?: (server: DiscoveredServer) => void,
    ): Promise<DiscoveredServer[]> {
        const found: DiscoveredServer[] = [];
        const PORTS = [8080, 8082, 3000];
        const TIMEOUT = 1500; // Short timeout per probe

        // ── Phase 1: Quick mDNS-style hostname probes ──
        const mdnsHosts = ['avnav.local', 'signalk.local', 'raspberrypi.local', 'openplotter.local'];
        nativeLog(`[scan] Phase 1: probing ${mdnsHosts.length} mDNS hostnames...`);

        for (const hostname of mdnsHosts) {
            for (const port of PORTS) {
                try {
                    const server = await this.probeServer(hostname, port, TIMEOUT);
                    if (server) {
                        found.push(server);
                        onFound?.(server);
                        nativeLog(`[scan] Found: ${hostname}:${port} (${server.serverType})`);
                    }
                } catch {
                    /* not found */
                }
            }
        }

        // ── Phase 2: Detect local IP via WebRTC ──
        let subnet: string | null = null;
        try {
            const localIp = await this.detectLocalIp();
            if (localIp) {
                const parts = localIp.split('.');
                if (parts.length === 4) {
                    subnet = parts.slice(0, 3).join('.');
                    nativeLog(`[scan] Local IP detected: ${localIp}, scanning ${subnet}.x`);
                }
            }
        } catch (err) {
            nativeLog(`[scan] WebRTC IP detection failed: ${(err as Error)?.message}`);
        }

        if (!subnet) {
            // Fallback: try common subnets
            nativeLog('[scan] Falling back to common subnets: 192.168.1.x, 192.168.0.x, 10.10.10.x');
            const fallbackSubnets = ['192.168.1', '192.168.0', '10.10.10', '192.168.50'];
            // Only probe a few common gateway-adjacent IPs, not all 254
            const quickIps = [1, 2, 10, 20, 50, 100, 150, 200];

            const total = fallbackSubnets.length * quickIps.length * PORTS.length;
            let scanned = 0;

            const batchProbes: Promise<void>[] = [];
            for (const sub of fallbackSubnets) {
                for (const lastOctet of quickIps) {
                    for (const port of PORTS) {
                        const ip = `${sub}.${lastOctet}`;
                        if (found.some((s) => s.host === ip && s.port === port)) continue;

                        batchProbes.push(
                            this.probeServer(ip, port, TIMEOUT)
                                .then((server) => {
                                    scanned++;
                                    onProgress?.(scanned, total);
                                    if (
                                        server &&
                                        !found.some((s) => s.host === server.host && s.port === server.port)
                                    ) {
                                        found.push(server);
                                        onFound?.(server);
                                    }
                                })
                                .catch(() => {
                                    scanned++;
                                    onProgress?.(scanned, total);
                                }),
                        );
                    }
                }
            }

            // Run probes with concurrency limit
            await this.runBatched(batchProbes, 20);
            return found;
        }

        // ── Phase 3: Full /24 subnet scan ──
        const total = 254 * PORTS.length;
        let scanned = 0;

        // Split into batches for concurrency control
        const batchProbes: Promise<void>[] = [];
        for (let i = 1; i <= 254; i++) {
            const ip = `${subnet}.${i}`;
            for (const port of PORTS) {
                if (found.some((s) => s.host === ip && s.port === port)) continue;

                batchProbes.push(
                    this.probeServer(ip, port, TIMEOUT)
                        .then((server) => {
                            scanned++;
                            onProgress?.(scanned, total);
                            if (server && !found.some((s) => s.host === server.host && s.port === server.port)) {
                                found.push(server);
                                onFound?.(server);
                            }
                        })
                        .catch(() => {
                            scanned++;
                            onProgress?.(scanned, total);
                        }),
                );
            }
        }

        // Run with concurrency of 30 (don't flood the network)
        await this.runBatched(batchProbes, 30);

        nativeLog(`[scan] Complete: found ${found.length} server(s)`);
        return found;
    }

    /** Run promises in batches to limit concurrency */
    private async runBatched(tasks: Promise<void>[], concurrency: number): Promise<void> {
        for (let i = 0; i < tasks.length; i += concurrency) {
            await Promise.allSettled(tasks.slice(i, i + concurrency));
        }
    }

    /** Probe a single host:port for an AvNav or SignalK server */
    private async probeServer(host: string, port: number, timeout: number): Promise<DiscoveredServer | null> {
        const url = `http://${host}:${port}`;

        // Try AvNav endpoints first
        const avnavEndpoints = [`${url}/api/status`, `${url}/viewer/avnav_navi.php`];

        for (const endpoint of avnavEndpoints) {
            try {
                const res = await CapacitorHttp.get({
                    url: endpoint,
                    connectTimeout: timeout,
                    readTimeout: timeout,
                });
                if (res.status >= 200 && res.status < 400) {
                    return {
                        host,
                        port,
                        serverType: 'avnav',
                        label: `AvNav (${host}:${port})`,
                    };
                }
            } catch {
                /* not available */
            }
        }

        // Try SignalK
        try {
            const res = await CapacitorHttp.get({
                url: `${url}/signalk`,
                connectTimeout: timeout,
                readTimeout: timeout,
            });
            if (res.status >= 200 && res.status < 300) {
                return {
                    host,
                    port,
                    serverType: 'signalk',
                    label: `Signal K (${host}:${port})`,
                };
            }
        } catch {
            /* not available */
        }

        return null;
    }

    /** Detect local IP address using WebRTC ICE candidates */
    private detectLocalIp(): Promise<string | null> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 3000);

            try {
                const pc = new RTCPeerConnection({ iceServers: [] });
                pc.createDataChannel('');

                pc.onicecandidate = (e) => {
                    if (!e.candidate) return;
                    const match = e.candidate.candidate.match(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
                    if (match) {
                        const ip = match[0];
                        // Filter out link-local and loopback
                        if (!ip.startsWith('0.') && !ip.startsWith('127.') && !ip.startsWith('169.254.')) {
                            clearTimeout(timeout);
                            pc.close();
                            resolve(ip);
                        }
                    }
                };

                pc.createOffer()
                    .then((offer) => pc.setLocalDescription(offer))
                    .catch(() => {
                        clearTimeout(timeout);
                        resolve(null);
                    });
            } catch {
                clearTimeout(timeout);
                resolve(null);
            }
        });
    }
}

export interface DiscoveredServer {
    host: string;
    port: number;
    serverType: 'avnav' | 'signalk';
    label: string;
}

export const AvNavService = new AvNavServiceClass();
