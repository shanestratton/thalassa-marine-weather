/**
 * wxServer — development-only availability gate for an explicitly configured
 * self-hosted Open-Meteo instance.
 *
 * Private/tailnet infrastructure is not part of the public-beta dependency
 * surface. Production builds always return unavailable and never probe a
 * private fallback. Development requires both VITE_WX_SERVER_ENABLED=true
 * and a valid VITE_WX_SERVER_BASE. Rules of engagement (see
 * docs/USING-THE-WEATHER-SERVER.md in the reef-recycling-social repo):
 *   - never expose the server publicly; the app only ever dials it directly
 *   - every request MUST carry an explicit `&models=` — the server returns
 *     HTTP 200 with all-null fields for unsynced default domains
 *
 * Reachability matrix:
 *   - explicit development build: configured HTTP/HTTPS endpoint only
 *   - public web/native build: NEVER — compile-time and runtime gated below
 */
import { CapacitorHttp, Capacitor } from '@capacitor/core';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('wxServer');

interface WxServerBuildConfig {
    dev: boolean;
    enabled: string | undefined;
    base: string | undefined;
}

export function resolveWxServerBase(config: WxServerBuildConfig): string {
    if (!config.dev || config.enabled !== 'true') return '';
    const candidate = config.base?.trim();
    if (!candidate) return '';

    try {
        const parsed = new URL(candidate);
        if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash
        ) {
            return '';
        }
        return candidate.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

const CONFIGURED_BASE = resolveWxServerBase({
    dev: import.meta.env.DEV,
    enabled: import.meta.env.VITE_WX_SERVER_ENABLED,
    base: import.meta.env.VITE_WX_SERVER_BASE,
});

export function wxServerBase(): string {
    return CONFIGURED_BASE;
}

const PROBE_TIMEOUT_MS = 2_500;
const RECHECK_OK_MS = 5 * 60 * 1000; // reachable — don't re-probe for 5 min
const RECHECK_FAIL_MS = 60 * 1000; // unreachable — allow retry after 1 min (VPN toggles)

let _lastResult: boolean | null = null;
let _lastCheckedAt = 0;
let _inflight: Promise<boolean> | null = null;

/** True when this build can never reach a plain-http tailnet host. */
function hardBlocked(): boolean {
    const base = wxServerBase();
    if (!base) return true;
    if (Capacitor.isNativePlatform()) return false;
    try {
        return window.location.protocol === 'https:' && base.startsWith('http://');
    } catch {
        return true;
    }
}

async function probe(): Promise<boolean> {
    const base = wxServerBase();
    if (!base) return false;
    // Minimal real query (not just a TCP touch): proves the API answers and
    // that the dwd_icon domain is actually served.
    const url = `${base}/v1/forecast?latitude=-27.2&longitude=153.1&current=temperature_2m&models=dwd_icon`;
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
