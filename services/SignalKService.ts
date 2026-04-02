/**
 * SignalKService — Signal K server connection & chart discovery.
 *
 * Connects to a user's Signal K server (typically a Raspberry Pi aboard)
 * and discovers available nautical chart tile sources.
 *
 * Thalassa is a chart VIEWER only — charts are stored, licensed, and
 * served entirely from the user's own hardware. Zero licensing risk.
 *
 * Supports both Signal K API v1 and v2 endpoints for compatibility.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('SignalK');

// ── Types ──

export interface SignalKChart {
    id: string;
    name: string;
    description: string;
    tilesUrl: string; // Full URL template: http://host:port/path/{z}/{x}/{y}
    format: 'png' | 'pbf' | 'jpg' | 'webp';
    minZoom: number;
    maxZoom: number;
    bounds?: [number, number, number, number]; // [west, south, east, north]
    type: 'raster' | 'vector';
}

export type SignalKConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type StatusCallback = (status: SignalKConnectionStatus) => void;
type ChartCallback = (charts: SignalKChart[]) => void;

// ── Constants ──

const DEFAULT_HOST = 'signalk.local';
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

class SignalKServiceClass {
    private host = DEFAULT_HOST;
    private port = DEFAULT_PORT;
    private status: SignalKConnectionStatus = 'disconnected';
    private apiVersion: 'v1' | 'v2' | null = null; // Detected API version
    private serverType: 'signalk' | 'avnav' | null = null; // Auto-detected server type
    private charts: SignalKChart[] = [];
    private enabled = false;

    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private chartRefreshTimer: ReturnType<typeof setInterval> | null = null;

    private statusListeners = new Set<StatusCallback>();
    private chartListeners = new Set<ChartCallback>();

    private lastError: string | null = null;

    // ── Public API ──

    configure(host: string, port: number, explicitType?: 'signalk' | 'avnav') {
        this.host = host || DEFAULT_HOST;
        this.port = port || DEFAULT_PORT;
        if (explicitType) this.serverType = explicitType;
    }

    getHost(): string {
        return this.host;
    }
    getPort(): number {
        return this.port;
    }
    getStatus(): SignalKConnectionStatus {
        return this.status;
    }
    getCharts(): SignalKChart[] {
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

    /**
     * Auto-start on app boot if config was previously saved.
     */
    autoStart() {
        const savedHost = localStorage.getItem('signalk_host');
        const savedPort = localStorage.getItem('signalk_port');
        const savedEnabled = localStorage.getItem('signalk_enabled');
        const savedType = localStorage.getItem('signalk_server_type') as 'signalk' | 'avnav' | null;
        if (!savedHost || savedEnabled !== 'true') return;
        this.configure(savedHost, parseInt(savedPort || String(DEFAULT_PORT), 10), savedType || undefined);
        this.start();
    }

    async start() {
        if (this.enabled) return;
        this.enabled = true;
        this.reconnectAttempts = 0;
        this.lastError = null;

        // Save config
        localStorage.setItem('signalk_host', this.host);
        localStorage.setItem('signalk_port', String(this.port));
        localStorage.setItem('signalk_enabled', 'true');
        if (this.serverType) localStorage.setItem('signalk_server_type', this.serverType);

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
    getTileUrl(chart: SignalKChart): string {
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
                log.info(`Connecting to AvNav at ${directUrl} (explicit mode)`);
                this.reconnectAttempts = 0;
                this.setStatus('connected');

                // Discover charts from AvNav API
                await this.tryFetchAvNavCharts(directUrl);
                return;
            }

            // ── Auto-detect: try AvNav image probe first ──
            const isAvNav = await this.probeAvNavWithImage(directUrl);
            if (isAvNav) {
                log.info(`Connected to AvNav at ${directUrl}`);
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
                log.info('AvNav: created default chart tile source');

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
            log.warn('Connection failed:', msg);
            this.lastError = msg;
            this.setStatus('error');
            if (this.enabled) this.scheduleReconnect();
        }
    }

    /**
     * Probe AvNav server by loading a test image from its viewer.
     * Image loads bypass CORS and macOS firewall restrictions that block fetch().
     * Returns true if the server responds with any image-like content.
     */
    private probeAvNavWithImage(baseUrl: string): Promise<boolean> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 6000);

            // Try loading the AvNav favicon or a known static asset
            const img = new Image();
            img.onload = () => {
                clearTimeout(timeout);
                resolve(true);
            };
            img.onerror = () => {
                // Image failed — try an alternative probe
                const img2 = new Image();
                img2.onload = () => {
                    clearTimeout(timeout);
                    resolve(true);
                };
                img2.onerror = () => {
                    clearTimeout(timeout);
                    resolve(false);
                };
                // Try loading a tile at z=0 (world overview — always exists if charts are loaded)
                img2.src = `${baseUrl}/tiles/0/0/0.png?_t=${Date.now()}`;
            };
            // AvNav serves static assets — try favicon or a viewer icon
            img.src = `${baseUrl}/viewer/images/avn_logo.png?_t=${Date.now()}`;
        });
    }

    /**
     * Discover charts from the AvNav API.
     * Uses the AvNav navi.php endpoint (request=listdir&type=chart).
     * Routes through Vite proxy in dev mode to bypass CORS.
     */
    private async tryFetchAvNavCharts(directUrl: string) {
        // In dev, route API calls through the chart proxy to bypass CORS
        const apiBase = IS_DEV ? `/__chart-proxy/${this.host}/${this.port}` : directUrl;

        try {
            const res = await fetch(`${apiBase}/viewer/avnav_navi.php?request=listdir&type=chart`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
                const data = await res.json();
                const discovered = this.parseAvNavCharts(data);
                if (discovered.length > 0) {
                    this.charts = discovered;
                    this.emitCharts();
                    log.info(`AvNav: discovered ${discovered.length} chart set(s)`);
                    return;
                }
            }
        } catch (e) {
            log.info('AvNav: API discovery failed:', (e as Error)?.message);
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
        log.info('AvNav: using fallback tile source');
    }

    /**
     * Detect the Signal K API version by probing endpoints.
     * Returns 'v2' or 'v1' or null if neither responds.
     */
    private async detectApiVersion(baseUrl: string): Promise<'v1' | 'v2' | null> {
        // Try v2 first (newer)
        try {
            const res = await fetch(`${baseUrl}/signalk/v2/api`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return 'v2';
        } catch {
            /* v2 not available */
        }

        // Fall back to v1
        try {
            const res = await fetch(`${baseUrl}/signalk/v1/api`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return 'v1';
        } catch {
            /* v1 not available either */
        }

        // Last resort — try the discovery endpoint
        try {
            const res = await fetch(`${baseUrl}/signalk`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                // Check for v2 endpoints first
                if (data?.endpoints?.v2) return 'v2';
                if (data?.endpoints?.v1) return 'v1';
                // If we got a response, assume v1
                return 'v1';
            }
        } catch {
            /* no response at all */
        }

        return null;
    }

    /**
     * Detect if the server is AvNav by probing its API.
     */
    private async detectAvNav(baseUrl: string): Promise<boolean> {
        try {
            // AvNav serves its web UI at the root — check for its API
            const res = await fetch(`${baseUrl}/api/status`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return true;
        } catch {
            /* not AvNav status endpoint */
        }

        // Alternative: probe for the viewer page (AvNav always has this)
        try {
            const res = await fetch(`${baseUrl}/viewer/avnav_navi.php`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok || res.status === 302) return true;
        } catch {
            /* not AvNav */
        }

        // Final fallback: try the chart list endpoint directly
        try {
            const res = await fetch(`${baseUrl}/api/list?type=chart`, {
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return true;
        } catch {
            /* not AvNav */
        }

        return false;
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
    private parseAvNavCharts(data: any): SignalKChart[] {
        const charts: SignalKChart[] = [];
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
                // ocharts DRM chart — tiles MUST go through AvNav's download handler
                // which handles encryption/token internally.
                // URL: /viewer/avnav_navi.php?request=download&type=chart&name={chartName}&url={z}/{x}/{y}.png
                const chartName = chartUrl.split('/').pop() || name;
                const avnavDownloadBase = `/viewer/avnav_navi.php?request=download&type=chart&name=${encodeURIComponent(chartName)}&url=`;
                if (IS_DEV) {
                    tilesUrl = `/__chart-proxy/${this.host}/${this.port}${avnavDownloadBase}{z}/{x}/{y}.png`;
                } else {
                    tilesUrl = `http://${this.host}:${this.port}${avnavDownloadBase}{z}/{x}/{y}.png`;
                }
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
    private parseCharts(data: Record<string, unknown>): SignalKChart[] {
        const baseUrl = this.getBaseUrl();
        const charts: SignalKChart[] = [];

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
            this.lastError = 'Could not reach Signal K server';
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

    private setStatus(s: SignalKConnectionStatus) {
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
}

export const SignalKService = new SignalKServiceClass();
