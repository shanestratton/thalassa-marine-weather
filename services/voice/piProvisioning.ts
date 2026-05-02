/**
 * piProvisioning — client for the Pi's network-setup endpoints.
 *
 * Talks to the `/api/network/{status,scan,configure}` Flask blueprint
 * specified in docs/BOSUN_NETWORK_SETUP_API.md. Used by the
 * PiSetupWizard component to walk the skipper through joining a fresh
 * Pi to their boat WiFi without SSH.
 *
 * Two contexts this is called from:
 *
 *   1. Setup mode — phone is on the Pi's open AP (Calypso-Setup-XXXX).
 *      Pi is reachable at http://10.0.0.1:5000. We hit /scan + /configure
 *      to push the user's WiFi credentials.
 *
 *   2. Already-on-LAN — phone is on the same network as the Pi (Pi has
 *      already been provisioned). We use the discovered piHost from
 *      BoatNetworkService. Useful for "change WiFi credentials"
 *      reconfiguration, though v1 mostly hits this in setup mode.
 */

import { BoatNetworkService } from '../BoatNetworkService';

/** Pi AP IP when phone is joined to Calypso-Setup-XXXX. */
const SETUP_AP_IP = '10.0.0.1';
const BOSUN_WEB_PORT = 5000;

/** Fast bailout for /status probes — UI shouldn't block. */
const STATUS_PROBE_TIMEOUT_MS = 2500;
/** Scans take 1-3s on the Pi side, allow generous headroom. */
const SCAN_TIMEOUT_MS = 8000;
/** Configure returns immediately (writes config + kicks off async join). */
const CONFIGURE_TIMEOUT_MS = 4000;

// ── Pi network types ───────────────────────────────────────────

export type NetworkMode = 'station' | 'setup_ap' | 'starting';

export type JoinResult = 'success' | 'auth_failed' | 'ssid_not_found' | 'timeout';

export type WifiSecurity = 'open' | 'wep' | 'wpa' | 'wpa2' | 'wpa3' | 'enterprise';

export interface NetworkStatus {
    mode: NetworkMode;
    station_ssid: string | null;
    station_ip: string | null;
    ap_ssid: string | null;
    uptime_seconds: number;
    last_join_attempt: {
        ssid: string;
        ts: string;
        result: JoinResult;
        error_detail: string | null;
    } | null;
}

export interface NearbyNetwork {
    ssid: string;
    signal_dbm: number;
    security: WifiSecurity;
    channel: number;
}

export interface ConfigureRequest {
    ssid: string;
    password?: string;
    security: WifiSecurity;
    tear_down_ap_on_success?: boolean;
}

export interface ConfigureResponse {
    accepted: boolean;
    next_state: 'station_attempting' | string;
    expected_settle_time_seconds: number;
}

interface PiEnvelope<T> {
    value: T | null;
    source: string;
    timestamp: string;
    error: string | null;
    latency_ms: number;
}

// ── Base URL resolution ────────────────────────────────────────

/**
 * Where do we send the request? Setup-mode hits the AP IP directly.
 * Station-mode reads piHost from BoatNetworkService discovery.
 */
type ProvisionContext = { mode: 'setup-ap' } | { mode: 'station'; piHost: string };

function baseUrl(ctx: ProvisionContext): string {
    if (ctx.mode === 'setup-ap') return `http://${SETUP_AP_IP}:${BOSUN_WEB_PORT}`;
    return `http://${ctx.piHost}:${BOSUN_WEB_PORT}`;
}

/** Returns a station-mode context if the Pi is currently discovered, else null. */
export function currentStationContext(): ProvisionContext | null {
    const piHost = BoatNetworkService.getState().piHost;
    if (!piHost) return null;
    return { mode: 'station', piHost };
}

/** Always-available setup-mode context (assumes phone is on the AP). */
export function setupApContext(): ProvisionContext {
    return { mode: 'setup-ap' };
}

// ── HTTP helpers ───────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(watchdog);
    }
}

async function unwrapEnvelope<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
        // Try to parse a Pi error envelope; fall back to status text.
        try {
            const env = JSON.parse(text) as { error?: string };
            throw new Error(env.error || `HTTP ${response.status}`);
        } catch {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
    }
    let envelope: PiEnvelope<T>;
    try {
        envelope = JSON.parse(text) as PiEnvelope<T>;
    } catch {
        throw new Error(`Pi returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (envelope.value === null) {
        throw new Error(envelope.error || 'Pi returned null value with no error reason');
    }
    return envelope.value;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Probe the Pi for its current network state. Throws on transport
 * failure (Pi unreachable). Returns mode + last_join_attempt so the
 * UI can render the right next step.
 */
export async function getNetworkStatus(ctx: ProvisionContext): Promise<NetworkStatus> {
    const url = `${baseUrl(ctx)}/api/network/status`;
    const r = await fetchWithTimeout(url, { method: 'GET' }, STATUS_PROBE_TIMEOUT_MS);
    return await unwrapEnvelope<NetworkStatus>(r);
}

/**
 * Quick reachability check — distinct from getNetworkStatus because the
 * UI sometimes wants a yes/no answer ("can we even talk to the Pi?")
 * without surfacing a thrown error to the user. Returns true on any
 * successful 200 from /api/network/status.
 */
export async function isProvisioningReachable(ctx: ProvisionContext): Promise<boolean> {
    try {
        await getNetworkStatus(ctx);
        return true;
    } catch {
        return false;
    }
}

/**
 * Scan for nearby WiFi networks the Pi can see. Pi side filters out
 * its own AP, hidden SSIDs, and de-duplicates multi-AP networks. We
 * just sort by signal strength here for a stable UI order.
 */
export async function scanNetworks(ctx: ProvisionContext): Promise<NearbyNetwork[]> {
    const url = `${baseUrl(ctx)}/api/network/scan`;
    const r = await fetchWithTimeout(url, { method: 'GET' }, SCAN_TIMEOUT_MS);
    const networks = await unwrapEnvelope<NearbyNetwork[]>(r);
    return [...networks].sort((a, b) => b.signal_dbm - a.signal_dbm);
}

/**
 * Push WiFi credentials to the Pi and trigger a join attempt. Returns
 * immediately after the Pi acks; caller should poll getNetworkStatus
 * to observe the actual join outcome via last_join_attempt.
 */
export async function configureNetwork(ctx: ProvisionContext, request: ConfigureRequest): Promise<ConfigureResponse> {
    const url = `${baseUrl(ctx)}/api/network/configure`;
    const r = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tear_down_ap_on_success: true, ...request }),
        },
        CONFIGURE_TIMEOUT_MS,
    );
    return await unwrapEnvelope<ConfigureResponse>(r);
}

/**
 * Poll /api/network/status until the join attempt completes or we time
 * out. Resolves with the final NetworkStatus regardless of join
 * outcome — caller inspects last_join_attempt.result. Each probe is
 * timeout-bounded individually so a flaky Pi can't hang the wizard.
 */
export async function waitForJoinResolution(
    ctx: ProvisionContext,
    {
        targetSsid,
        timeoutMs = 30_000,
        intervalMs = 1500,
    }: { targetSsid: string; timeoutMs?: number; intervalMs?: number },
): Promise<NetworkStatus> {
    const start = Date.now();
    let lastStatus: NetworkStatus | null = null;
    while (Date.now() - start < timeoutMs) {
        try {
            const status = await getNetworkStatus(ctx);
            lastStatus = status;
            const attempt = status.last_join_attempt;
            // Resolution conditions:
            //   - mode flipped to station with the target SSID → success
            //   - last_join_attempt has a result for the target SSID → done (success or fail)
            // Any other mode/state, keep polling.
            if (status.mode === 'station' && status.station_ssid === targetSsid) {
                return status;
            }
            if (attempt && attempt.ssid === targetSsid && attempt.result !== undefined) {
                return status;
            }
        } catch {
            // Probe failed — Pi may be mid-network-swap and unreachable.
            // Keep polling; the timeout window catches genuine hangs.
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (lastStatus) return lastStatus;
    throw new Error('Pi did not respond during the join attempt window. Try again.');
}
