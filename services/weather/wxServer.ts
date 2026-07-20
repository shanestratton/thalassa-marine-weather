/**
 * wxServer — availability gate for the self-hosted Open-Meteo instance on
 * Shane's tailnet (twelve global models, 1–3 ms answers, no key, no quota).
 *
 * The server is reachable ONLY over Tailscale, so for most users and most
 * network situations the probe fails and every caller silently falls back
 * to the commercial Open-Meteo API. Rules of engagement (see
 * docs/USING-THE-WEATHER-SERVER.md in the reef-recycling-social repo):
 *   - never expose the server publicly; the app only ever dials it directly
 *   - every request MUST carry an explicit `&models=` — the server returns
 *     HTTP 200 with all-null fields for unsynced default domains
 *
 * Reachability matrix:
 *   - native iOS: OK (Info.plist NSAllowsArbitraryLoads=true; CapacitorHttp
 *     goes through URLSession)
 *   - web dev (http://localhost): OK (server answers CORS with *)
 *   - deployed web (https): NEVER — mixed-content; hard-gated below so we
 *     don't burn a doomed probe on every boot
 */
import { CapacitorHttp, Capacitor } from '@capacitor/core';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('wxServer');

const DEFAULT_BASE = 'http://100.76.191.119:8080';

export function wxServerBase(): string {
    return (import.meta.env.VITE_WX_SERVER_BASE as string | undefined) || DEFAULT_BASE;
}

const PROBE_TIMEOUT_MS = 2_500;
const RECHECK_OK_MS = 5 * 60 * 1000; // reachable — don't re-probe for 5 min
const RECHECK_FAIL_MS = 60 * 1000; // unreachable — allow retry after 1 min (VPN toggles)

let _lastResult: boolean | null = null;
let _lastCheckedAt = 0;
let _inflight: Promise<boolean> | null = null;

/** True when this build can never reach a plain-http tailnet host. */
function hardBlocked(): boolean {
    if (Capacitor.isNativePlatform()) return false;
    try {
        return window.location.protocol === 'https:' && wxServerBase().startsWith('http://');
    } catch {
        return true;
    }
}

async function probe(): Promise<boolean> {
    // Minimal real query (not just a TCP touch): proves the API answers and
    // that the dwd_icon domain is actually served.
    const url = `${wxServerBase()}/v1/forecast?latitude=-27.2&longitude=153.1&current=temperature_2m&models=dwd_icon`;
    try {
        const res = await Promise.race([
            CapacitorHttp.get({ url, connectTimeout: PROBE_TIMEOUT_MS, readTimeout: PROBE_TIMEOUT_MS }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
        ]);
        if (!res || res.status !== 200) return false;
        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        return data?.current?.temperature_2m != null;
    } catch {
        return false;
    }
}

/**
 * Cached availability check. Never throws; never takes longer than the probe
 * timeout. Callers treat `false` as "use the commercial API".
 */
export async function isWxServerAvailable(): Promise<boolean> {
    if (hardBlocked()) return false;

    const age = Date.now() - _lastCheckedAt;
    if (_lastResult !== null && age < (_lastResult ? RECHECK_OK_MS : RECHECK_FAIL_MS)) {
        return _lastResult;
    }
    if (_inflight) return _inflight;

    _inflight = probe()
        .then((ok) => {
            if (ok !== _lastResult) log.info(`wx server ${ok ? 'reachable' : 'unreachable'} at ${wxServerBase()}`);
            _lastResult = ok;
            _lastCheckedAt = Date.now();
            return ok;
        })
        .finally(() => {
            _inflight = null;
        });
    return _inflight;
}

/** Synchronous best-guess (last probe result) — for UI hints only. */
export function wxServerLastKnownAvailable(): boolean {
    return _lastResult === true;
}

/** Test seam. */
export function _resetWxServerCacheForTest(): void {
    _lastResult = null;
    _lastCheckedAt = 0;
    _inflight = null;
}
