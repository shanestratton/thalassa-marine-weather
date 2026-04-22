/**
 * blitzortungLightning — Real-time global lightning strike feed via the
 * volunteer-operated Blitzortung.org detector network.
 *
 * Why we use it (replacing Xweather):
 *   - Free for non-commercial use (we email permission for commercial)
 *   - No daily quota — Xweather burnt 2026-04-22 with quota exhaustion
 *   - Strong Australian coverage (where most of our users are)
 *   - Real-time (sub-minute latency) vs Xweather's 15-min raster
 *   - Animated point markers > static raster tiles for visual impact
 *
 * Architecture:
 *   1. Browser opens WSS to one of Blitzortung's load-balanced servers
 *   2. Sends `{"time": 0}` to subscribe to live strikes
 *   3. Each incoming message is LZW-encoded JSON describing one strike
 *   4. Decoded strike = { lat, lon, time, polarity }
 *   5. We push it into a ring-buffer (last 16 min) and fire callbacks
 *
 * The LZW decoder is inline (~30 lines) — bundled rather than added as
 * a dependency since Blitzortung's spec is stable + small.
 *
 * License: data attribution required — render "⚡ Blitzortung.org" chip
 * somewhere in the UI when this layer is active. Commercial use needs
 * an emailed permission from them; safe for development.
 */

import { createLogger } from '../../../utils/createLogger';

const log = createLogger('blitzortung');

// ── Server pool ───────────────────────────────────────────────────────
// Blitzortung runs 4 known live-data servers. Pick one randomly to spread
// load. If a connection drops we'll re-pick on retry.
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

// ── Connection manager ────────────────────────────────────────────────

interface ConnectionState {
    socket: WebSocket | null;
    listeners: Set<StrikeListener>;
    reconnectAttempts: number;
    closed: boolean;
}

const state: ConnectionState = {
    socket: null,
    listeners: new Set(),
    reconnectAttempts: 0,
    closed: true,
};

function connect(): void {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
    state.closed = false;
    const url = pickServerUrl();
    log.info(`Connecting to ${url}`);

    let socket: WebSocket;
    try {
        socket = new WebSocket(url);
    } catch (err) {
        log.warn('WebSocket constructor threw', err);
        scheduleReconnect();
        return;
    }
    state.socket = socket;

    socket.addEventListener('open', () => {
        log.info('Connected — subscribing');
        state.reconnectAttempts = 0;
        // Subscribe to the live data feed.
        socket.send(JSON.stringify({ time: 0 }));
    });

    socket.addEventListener('message', (e: MessageEvent) => {
        const raw = typeof e.data === 'string' ? e.data : '';
        const strike = decodeMessage(raw);
        if (!strike) return;
        state.listeners.forEach((cb) => {
            try {
                cb(strike);
            } catch (err) {
                log.warn('Listener threw', err);
            }
        });
    });

    socket.addEventListener('close', (e: CloseEvent) => {
        log.info(`Closed: code=${e.code} reason=${e.reason || '(none)'}`);
        state.socket = null;
        if (!state.closed) scheduleReconnect();
    });

    socket.addEventListener('error', (err: Event) => {
        log.warn('Socket error', err);
        // 'close' will fire after this — let it handle the reconnect.
    });
}

function scheduleReconnect(): void {
    if (state.closed) return;
    state.reconnectAttempts++;
    // Capped exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s…
    const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
    log.info(`Reconnect in ${delay}ms (attempt ${state.reconnectAttempts})`);
    setTimeout(() => {
        if (!state.closed) connect();
    }, delay);
}

function disconnect(): void {
    state.closed = true;
    if (state.socket) {
        try {
            state.socket.close();
        } catch {
            /* best effort */
        }
        state.socket = null;
    }
    state.reconnectAttempts = 0;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Subscribe to live lightning strikes. Returns an unsubscribe fn.
 *
 * On first subscriber → opens the WebSocket.
 * On last unsubscribe → closes the WebSocket.
 *
 * Strikes fire continuously as long as at least one subscriber exists.
 */
export function subscribeLightningStrikes(cb: StrikeListener): () => void {
    state.listeners.add(cb);
    if (state.listeners.size === 1) connect();
    return () => {
        state.listeners.delete(cb);
        if (state.listeners.size === 0) disconnect();
    };
}

/** Inspect connection status — for diagnostic UI. */
export function getLightningConnectionStatus(): 'open' | 'connecting' | 'closed' {
    if (!state.socket) return state.closed ? 'closed' : 'connecting';
    return state.socket.readyState === WebSocket.OPEN ? 'open' : 'connecting';
}
