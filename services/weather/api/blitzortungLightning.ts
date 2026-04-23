/**
 * blitzortungLightning — Real-time global lightning strike feed via the
 * volunteer-operated Blitzortung.org detector network.
 *
 * Platform routing (2026-04-23)
 * ─────────────────────────────
 * NATIVE iOS (Capacitor): connects directly via the Swift `Lightning`
 *   plugin, which opens a URLSessionWebSocketTask to
 *   `wss://ws{1,5,6,7}.blitzortung.org:3000/`. Apple's native networking
 *   doesn't set an Origin header, so Blitzortung's server-side check
 *   treats us as a native app (which their ToS explicitly permits) and
 *   streams live strikes. No server relay needed.
 *
 * WEB browser: disabled — WKWebView / Chrome / Safari all send an Origin
 *   header on WebSocket handshakes that Blitzortung rejects with code
 *   1006 before the first message. A future server-side relay at
 *   relay.thalassawx.com would unblock this; until then, the lightning
 *   layer is a no-op on web and the UI toggle is hidden in non-native
 *   builds.
 *
 * Why Blitzortung (replacing Xweather, DECOMMISSIONED 2026-04-22):
 *   - Free for non-commercial use (email permission for commercial)
 *   - No daily quota — Xweather exhausted its quota mid-afternoon
 *   - Strong Australian coverage (where most of our users are)
 *   - Real-time (sub-minute latency) vs Xweather's 15-min raster
 *   - Animated point markers > static raster tiles
 *
 * Message flow:
 *   1. Swift LightningPlugin opens wss:// to one of 4 live-data servers
 *   2. On open, sends {"time":0} to request live feed
 *   3. Server streams LZW-encoded JSON strings
 *   4. Swift forwards raw strings to JS via Capacitor events
 *   5. JS decodes (LZW + JSON.parse) and fires listener callbacks
 *
 * License: attribution required — render "⚡ Blitzortung.org" chip
 * somewhere in the UI when this layer is active.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { createLogger } from '../../../utils/createLogger';

const log = createLogger('blitzortung');

// ── Native WebSocket bridge ───────────────────────────────────────────
// Implemented in ios/App/App/LightningPlugin.swift. The web build gets
// a no-op proxy — `Capacitor.isNativePlatform()` guards us from ever
// calling into it there.
interface LightningNativePlugin {
    start(options: { url: string; subscribeMessage: string }): Promise<void>;
    stop(): Promise<void>;
    addListener(
        eventName: 'open' | 'message' | 'close' | 'error',
        handler: (event: { data?: string; error?: string; code?: number; reason?: string }) => void,
    ): Promise<PluginListenerHandle> & PluginListenerHandle;
    removeAllListeners(): Promise<void>;
}
const LightningNative = registerPlugin<LightningNativePlugin>('Lightning');

// ── Server pool ───────────────────────────────────────────────────────
// Blitzortung runs 4 known live-data servers. Pick one randomly to spread
// load. If a connection drops we'll re-pick on retry. (Only used once we
// have a relay; the browser can't hit these directly.)
const SERVER_IDS = [1, 6, 5, 7];
function pickServerUrl(): string {
    const id = SERVER_IDS[Math.floor(Math.random() * SERVER_IDS.length)];
    return `wss://ws${id}.blitzortung.org:3000/`;
}

// ── Strike data shape ─────────────────────────────────────────────────

export interface LightningStrike {
    /** Unique-ish key for dedup (Date.now() collisions tolerated). */
    id: string;
    /** Latitude in degrees. */
    lat: number;
    /** Longitude in degrees. */
    lon: number;
    /** Strike time as epoch ms. */
    time: number;
    /** Polarity: positive = +CG (cloud-to-ground positive), negative = -CG (the more common type). */
    polarity: 'positive' | 'negative' | 'unknown';
}

export type StrikeListener = (strike: LightningStrike) => void;

// ── LZW decoder ───────────────────────────────────────────────────────
// Blitzortung uses a custom LZW variant where each character of the
// incoming string represents a code. The reference implementation lives
// in their official viewer at maps.blitzortung.org. This is a faithful
// port — comments explain each step rather than assuming you've seen
// LZW before.
function lzwDecode(input: string): string {
    if (!input) return '';
    const dict: Record<number, string> = {};
    const data = input.split('');
    let prev = data[0];
    let result = prev;
    let dictSize = 256;
    for (let i = 1; i < data.length; i++) {
        const code = data[i].charCodeAt(0);
        // Either a literal byte (code < dict size) or a dictionary lookup.
        const entry = code < 256 ? data[i] : (dict[code] ?? prev + prev.charAt(0));
        result += entry;
        // Add the new sequence (prev + first char of current) to the dict.
        dict[dictSize++] = prev + entry.charAt(0);
        prev = entry;
    }
    return result;
}

// ── Raw message → LightningStrike ─────────────────────────────────────

interface RawStrike {
    /** Time in nanoseconds since epoch (Blitzortung convention). */
    time?: number;
    lat?: number;
    lon?: number;
    /** Polarity: > 0 positive, < 0 negative, 0 unknown. */
    pol?: number;
}

function decodeMessage(rawData: string): LightningStrike | null {
    try {
        const decoded = lzwDecode(rawData);
        const obj = JSON.parse(decoded) as RawStrike;
        if (typeof obj.lat !== 'number' || typeof obj.lon !== 'number' || typeof obj.time !== 'number') {
            return null;
        }
        return {
            id: `${obj.time}-${obj.lat.toFixed(4)}-${obj.lon.toFixed(4)}`,
            lat: obj.lat,
            lon: obj.lon,
            // Convert nanoseconds → milliseconds for Date interop.
            time: Math.floor(obj.time / 1e6),
            polarity:
                typeof obj.pol === 'number'
                    ? obj.pol > 0
                        ? 'positive'
                        : obj.pol < 0
                          ? 'negative'
                          : 'unknown'
                    : 'unknown',
        };
    } catch (err) {
        log.warn('Failed to decode strike message', err);
        return null;
    }
}

// ── Connection state ──────────────────────────────────────────────────

type ConnectionStatus = 'open' | 'connecting' | 'closed';

interface ConnectionState {
    listeners: Set<StrikeListener>;
    status: ConnectionStatus;
    /** Listener handles returned by Capacitor addListener — removed on teardown. */
    nativeHandles: PluginListenerHandle[];
    /** Retry timer so we can cancel on disconnect. */
    retryTimer: ReturnType<typeof setTimeout> | null;
    retryAttempts: number;
}

const state: ConnectionState = {
    listeners: new Set(),
    status: 'closed',
    nativeHandles: [],
    retryTimer: null,
    retryAttempts: 0,
};

/** Fire a strike out to every subscriber; isolate each callback so one
 *  throwing listener doesn't kill the others. */
function emitStrike(strike: LightningStrike): void {
    state.listeners.forEach((cb) => {
        try {
            cb(strike);
        } catch (err) {
            log.warn('Listener threw', err);
        }
    });
}

async function connect(): Promise<void> {
    if (state.status !== 'closed') return;
    state.status = 'connecting';

    if (!Capacitor.isNativePlatform()) {
        // Web path intentionally left unwired — Blitzortung rejects
        // browser origins. Once a server-side relay ships this is
        // where we'd open wss://relay.thalassawx.com instead.
        log.info('Web platform — lightning feed not available (server relay required)');
        state.status = 'closed';
        return;
    }

    const url = pickServerUrl();
    log.info(`Opening native Lightning WebSocket to ${url}`);

    // Tear down any previous handles first (defensive — start/stop cycles).
    await teardownNativeHandles();

    // Register handlers BEFORE start so we don't race the first frames.
    const onOpen = await LightningNative.addListener('open', () => {
        log.info('Lightning WebSocket open — streaming strikes');
        state.status = 'open';
        state.retryAttempts = 0;
    });
    const onMessage = await LightningNative.addListener('message', ({ data }) => {
        if (!data) return;
        const strike = decodeMessage(data);
        if (strike) emitStrike(strike);
    });
    const onError = await LightningNative.addListener('error', ({ error }) => {
        log.warn('Lightning WebSocket error:', error ?? '(unknown)');
    });
    const onClose = await LightningNative.addListener('close', ({ code, reason }) => {
        log.info(`Lightning WebSocket closed: code=${code ?? 'n/a'} reason=${reason || '(none)'}`);
        state.status = 'closed';
        // If we still have active subscribers, try to come back — but
        // with a bounded backoff so a misbehaving server doesn't burn
        // battery.
        if (state.listeners.size > 0) scheduleReconnect();
    });
    state.nativeHandles = [onOpen, onMessage, onError, onClose];

    try {
        await LightningNative.start({
            url,
            subscribeMessage: JSON.stringify({ time: 0 }),
        });
    } catch (err) {
        log.warn('Lightning start() rejected', err);
        state.status = 'closed';
        await teardownNativeHandles();
        if (state.listeners.size > 0) scheduleReconnect();
    }
}

function scheduleReconnect(): void {
    if (state.retryTimer) return;
    state.retryAttempts++;
    // Exponential-ish backoff: 5s, 15s, 30s, then every 60s. Capped so
    // we don't hammer Blitzortung if something's genuinely broken on
    // their side.
    const delayMs =
        state.retryAttempts === 1
            ? 5_000
            : state.retryAttempts === 2
              ? 15_000
              : state.retryAttempts === 3
                ? 30_000
                : 60_000;
    log.info(`Reconnect scheduled in ${delayMs}ms (attempt ${state.retryAttempts})`);
    state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if (state.listeners.size > 0 && state.status === 'closed') {
            void connect();
        }
    }, delayMs);
}

async function teardownNativeHandles(): Promise<void> {
    const handles = state.nativeHandles;
    state.nativeHandles = [];
    for (const h of handles) {
        try {
            await h.remove();
        } catch {
            /* best effort */
        }
    }
}

async function disconnect(): Promise<void> {
    if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
    }
    state.retryAttempts = 0;
    state.status = 'closed';
    if (!Capacitor.isNativePlatform()) return;
    try {
        await LightningNative.stop();
    } catch {
        /* best effort */
    }
    await teardownNativeHandles();
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Subscribe to live lightning strikes. Returns an unsubscribe fn.
 *
 *   First subscriber → opens the native WebSocket
 *   Last unsubscribe → closes it + clears retry state
 *
 * On web, this is a no-op — the listener is registered but no strikes
 * will ever fire because the WebSocket can't open (see header).
 */
export function subscribeLightningStrikes(cb: StrikeListener): () => void {
    state.listeners.add(cb);
    if (state.listeners.size === 1 && state.status === 'closed') {
        void connect();
    }
    return () => {
        state.listeners.delete(cb);
        if (state.listeners.size === 0) {
            void disconnect();
        }
    };
}

/** Inspect connection status — for diagnostic UI. */
export function getLightningConnectionStatus(): ConnectionStatus {
    return state.status;
}
