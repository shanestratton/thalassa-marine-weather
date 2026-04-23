/**
 * internetProbe — Detects true WAN connectivity (not just "have some WiFi").
 *
 * Why this exists
 * ---------------
 * `navigator.onLine` only tells us whether the device has ANY network
 * interface up — it's `true` even when the device is on a WiFi network
 * whose router has no internet link (e.g. connected to a boat's Raspberry
 * Pi serving cached weather over LAN, with the uplink modem down).
 *
 * That created a real UX hazard: the "No Connection" banner stays hidden
 * and the punter thinks their weather data is fresh when it's actually
 * coming from the Pi's last known cache. For a skipper reading sea state
 * before a crossing, that's the worst time to be quietly wrong.
 *
 * What it does
 * ------------
 * Periodically hits a tiny "connectivity check" endpoint (Google's 204
 * endpoint — returns empty, is designed for this use, widely reachable)
 * using Capacitor's native HTTP so WebView CORS doesn't block us. If it
 * fails or times out, we flip `useUIStore.isOffline = true` and the
 * StalenessBanner surfaces. Re-probes on window 'online' events, and
 * whenever the app returns to the foreground.
 *
 * Costs ~220 bytes every two minutes (headers only, 204 response) — a
 * rounding error on any plan, including satellite.
 */
import { CapacitorHttp } from '@capacitor/core';

import { useUIStore } from '../stores/uiStore';
import { createLogger } from '../utils/createLogger';

const log = createLogger('internetProbe');

// Google's connectivity-check endpoint: returns HTTP 204 with empty body.
// Apple / MS / Android all use similar endpoints for the same purpose;
// this one is the most reliable worldwide.
const PROBE_URL = 'https://www.gstatic.com/generate_204';
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_INTERVAL_MS = 2 * 60 * 1_000; // every 2 minutes
// Short back-off after a failed probe so we don't hammer while offline.
const FAILED_PROBE_INTERVAL_MS = 30 * 1_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<boolean> | null = null;

async function runProbe(): Promise<boolean> {
    // De-dupe overlapping probes.
    if (inflight) return inflight;

    inflight = (async () => {
        // Navigator 'offline' is a definite signal — no need to burn a request.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return false;
        }
        try {
            const res = await CapacitorHttp.get({
                url: PROBE_URL,
                connectTimeout: PROBE_TIMEOUT_MS,
                readTimeout: PROBE_TIMEOUT_MS,
                // Avoid any caching proxies the OS might interject — we want
                // a real-time answer each time.
                headers: { 'Cache-Control': 'no-cache, no-store' },
            });
            // Any 2xx / 3xx counts as "reachable". 204 is what gstatic returns
            // on success but some corporate Wi-Fi captive portals rewrite to
            // 200, which is also fine for our purposes (they have internet).
            return res.status >= 200 && res.status < 400;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Use .error so Xcode Console actually shows this; Capacitor's
            // default LoggingBehavior drops warn-level console messages.
            log.error('probe failed — assuming no WAN:', msg);
            return false;
        }
    })();

    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

/**
 * Reconcile the probe result with the UI's offline flag. Only mutates
 * the store when the value would actually change — avoids waking
 * components that subscribe to `isOffline`.
 */
async function probeAndUpdate(): Promise<void> {
    const reachable = await runProbe();
    const shouldBeOffline = !reachable;
    const current = useUIStore.getState().isOffline;
    if (current !== shouldBeOffline) {
        log.error(`isOffline ${current} → ${shouldBeOffline} (probe reachable=${reachable})`);
        useUIStore.setState({ isOffline: shouldBeOffline });
    }
    // Adapt cadence: fast re-probe after a failure so we catch the moment
    // WAN comes back, slower cadence while everything's green.
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = setInterval(probeAndUpdate, reachable ? PROBE_INTERVAL_MS : FAILED_PROBE_INTERVAL_MS);
    }
}

/**
 * Start the probe. Idempotent — calling twice is a no-op. Returns a stop
 * function (useful in tests; production just lets it run for the app
 * lifetime).
 */
export function startInternetProbe(): () => void {
    if (intervalId) return stopInternetProbe;

    // First probe on a small delay so it doesn't compete with the boot-
    // critical weather fetch for HTTP bandwidth.
    const boot = setTimeout(probeAndUpdate, 3_000);

    intervalId = setInterval(probeAndUpdate, PROBE_INTERVAL_MS);

    // When the device reports coming online (e.g. reconnected to WiFi),
    // immediately re-probe — otherwise we wait up to PROBE_INTERVAL_MS to
    // clear the banner.
    const onOnline = () => {
        void probeAndUpdate();
    };
    // A definite 'offline' signal bypasses the probe — no point asking if
    // there's no link layer.
    const onOffline = () => {
        if (!useUIStore.getState().isOffline) {
            useUIStore.setState({ isOffline: true });
        }
    };
    // Refresh on foreground — the user just pocket-returned, their context
    // may have changed (walked off the marina, stepped into 5G).
    const onVisible = () => {
        if (document.visibilityState === 'visible') void probeAndUpdate();
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
        clearTimeout(boot);
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        document.removeEventListener('visibilitychange', onVisible);
    };
}

export function stopInternetProbe(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
