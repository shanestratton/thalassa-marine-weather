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
// Blitzortung runs 4 active live-data servers. Pick one randomly to
// spread load. If a connection drops we'll re-pick on retry.
//
// Endpoint history:
//   - 2020-era SimonSchick/BlitzortungAPI used :3000 with subscribe
//     {"time":0}. That's stale — port 3000 is now firewalled by most
//     cellular carriers (the user reported "Could not connect to server"
//     on iOS) and the protocol changed.
//   - We then tried :443 with {"time":0} — handshake succeeded but the
//     server never streamed (wrong subscribe).
//   - 2026-04-25 FINAL FIX: decoded the live map.blitzortung.org viewer
//     JS directly. Real protocol is wss://ws[1,2,7,8].blitzortung.org/
//     (port 443 implicit) with subscribe {"a":111}.
const SERVER_IDS = [1, 2, 7, 8];
function pickServerUrl(): string {
    const id = SERVER_IDS[Math.floor(Math.random() * SERVER_IDS.length)];
    return `wss://ws${id}.blitzortung.org/`;
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

/** Counter + cap for "dump the first N raw frames" debugging. Survives
 *  prod because we want to see exactly what the server is sending when
 *  users report "no strikes". Once we've got visibility we'll pull this. */
let rawFrameDebugBudget = 5;

function decodeMessage(rawData: string): LightningStrike | null {
    // Dump the first few raw frames so we can see if the server is
    // streaming at all, and if so, what shape the payload actually is.
    // log.warn so it survives production builds.
    if (rawFrameDebugBudget > 0) {
        rawFrameDebugBudget--;
        const preview = rawData.length > 200 ? `${rawData.slice(0, 200)}…(${rawData.length}ch)` : rawData;
        log.warn(`[Lightning] raw frame #${5 - rawFrameDebugBudget}: ${preview}`);
        try {
            const decoded = lzwDecode(rawData);
            const decodedPreview = decoded.length > 200 ? `${decoded.slice(0, 200)}…(${decoded.length}ch)` : decoded;
            log.warn(`[Lightning] decoded: ${decodedPreview}`);
        } catch {
            log.warn('[Lightning] decode threw — likely not LZW, maybe plain JSON');
        }
    }
    try {
        // Try LZW first (Blitzortung's historical encoding).
        let decoded: string;
        try {
            decoded = lzwDecode(rawData);
        } catch {
            decoded = rawData;
        }
        // Fall back to raw if LZW output doesn't look like JSON — some
        // Blitzortung server variants now send plain-text JSON.
        let obj: RawStrike;
        try {
            obj = JSON.parse(decoded) as RawStrike;
        } catch {
            obj = JSON.parse(rawData) as RawStrike;
        }
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

export type ConnectionStatus = 'open' | 'connecting' | 'closed' | 'stalled' | 'unsupported';

interface ConnectionState {
    listeners: Set<StrikeListener>;
    /** Observer callbacks for UI diagnostics (connection pill). Separate
     *  from strike listeners so we don't conflate "new strike" with
     *  "connection state changed". */
    statusObservers: Set<(snapshot: StatusSnapshot) => void>;
    status: ConnectionStatus;
    /** Wall-clock ms of the last strike received. Used to detect stalls
     *  (connection open but silent for > 2 min → force reconnect). */
    lastStrikeAt: number;
    /** Total strikes received this session — for the diagnostic pill. */
    strikesReceived: number;
    /** Rolling 60-second window of strike timestamps (epoch ms). Trimmed
     *  eagerly in emitStrike so the array stays bounded even during a
     *  hurricane (worst case ~few thousand entries). Used to compute
     *  global strikes/min — handy as a connection-health signal. */
    recentStrikeTimes: number[];
    /** Strikes/min in the user's current map viewport, computed by
     *  useLightningLayer (which has access to map.getBounds()) and
     *  pushed in via setViewportRate. The pill shows this number rather
     *  than the global rate — answers "is the storm I'm looking at
     *  intensifying?", not "is anywhere on Earth thunderstorming?".
     *  Falls back to 0 when no strikes have arrived in the viewport
     *  window or the layer hasn't reported a value yet. */
    viewportRate: number;
    /** Strikes currently visible in the user's viewport — shown alongside
     *  the rate. Updated by the same hook that updates viewportRate. */
    viewportCount: number;
    /** Server chosen for the current connection attempt — shown in the
     *  status pill so the user can tell if we're cycling through servers. */
    currentServer: string;
    /** Listener handles returned by Capacitor addListener — removed on teardown. */
    nativeHandles: PluginListenerHandle[];
    /** Retry timer so we can cancel on disconnect. */
    retryTimer: ReturnType<typeof setTimeout> | null;
    /** Stall-detection timer — fires if no strikes arrive for too long
     *  even though the socket is open. Blitzortung's servers occasionally
     *  accept the connection but never stream. */
    stallTimer: ReturnType<typeof setTimeout> | null;
    retryAttempts: number;
}

const RATE_WINDOW_MS = 60 * 1000;

export interface StatusSnapshot {
    status: ConnectionStatus;
    lastStrikeAt: number;
    /** Total strikes received this session, globally. Useful as a
     *  feed-health signal — if it's not climbing during a thunderstorm,
     *  something's wrong with the connection. */
    strikesReceived: number;
    /** Strikes/min over the last 60 s, GLOBAL. Reflects feed health. */
    strikesPerMinute: number;
    /** Strikes/min IN THE USER'S CURRENT VIEWPORT over the last 60 s.
     *  This is the answer to "is the storm I'm looking at intensifying?". */
    viewportRate: number;
    /** Active strikes currently visible inside the viewport. */
    viewportCount: number;
    currentServer: string;
    retryAttempts: number;
}

const state: ConnectionState = {
    listeners: new Set(),
    statusObservers: new Set(),
    status: 'closed',
    lastStrikeAt: 0,
    strikesReceived: 0,
    recentStrikeTimes: [],
    viewportRate: 0,
    viewportCount: 0,
    currentServer: '',
    nativeHandles: [],
    retryTimer: null,
    stallTimer: null,
    retryAttempts: 0,
};

/** Build the current snapshot. Centralised so subscribe + notify use
 *  exactly the same shape and the rate calc happens in one place. */
function buildSnapshot(): StatusSnapshot {
    // Trim the rate window to be safe — emitStrike usually keeps it tight
    // but during reconnects or quiet periods it can drift.
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (state.recentStrikeTimes.length > 0 && state.recentStrikeTimes[0] < cutoff) {
        state.recentStrikeTimes.shift();
    }
    return {
        status: state.status,
        lastStrikeAt: state.lastStrikeAt,
        strikesReceived: state.strikesReceived,
        strikesPerMinute: state.recentStrikeTimes.length, // 60s window = strikes/min directly
        viewportRate: state.viewportRate,
        viewportCount: state.viewportCount,
        currentServer: state.currentServer,
        retryAttempts: state.retryAttempts,
    };
}

/** Push the latest viewport rate + count from useLightningLayer (which
 *  is the only thing that knows about map.getBounds()). Also refreshes
 *  the pill so the count visibly ticks even while the user is panning
 *  around without new strikes arriving. */
export function setLightningViewportStats(rate: number, count: number): void {
    if (state.viewportRate === rate && state.viewportCount === count) return;
    state.viewportRate = rate;
    state.viewportCount = count;
    notifyStatusObservers();
}

/** Emit current status to every observer. Isolate errors so one broken
 *  observer doesn't silence the others. */
function notifyStatusObservers(): void {
    const snapshot = buildSnapshot();
    state.statusObservers.forEach((cb) => {
        try {
            cb(snapshot);
        } catch (err) {
            log.warn('Status observer threw', err);
        }
    });
}

function setStatus(next: ConnectionStatus): void {
    if (state.status === next) return;
    state.status = next;
    notifyStatusObservers();
}

const STALL_THRESHOLD_MS = 2 * 60 * 1000; // 2 min silent = probably dead
function armStallTimer(): void {
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.stallTimer = setTimeout(() => {
        state.stallTimer = null;
        // Only act if still open — if we already closed, reconnect path
        // handles it.
        if (state.status !== 'open') return;
        log.warn(`[Lightning] Stall detected — no strikes for ${STALL_THRESHOLD_MS / 1000}s, forcing reconnect`);
        setStatus('stalled');
        // Tear down and let reconnect logic pick a fresh server.
        void (async () => {
            await disconnect();
            if (state.listeners.size > 0) scheduleReconnect();
        })();
    }, STALL_THRESHOLD_MS);
}

/** Throttle the strikes-received pill update so a heavy storm (>10
 *  strikes/sec) doesn't trigger a React re-render on every single
 *  strike — but the count still moves visibly. 1Hz feels live without
 *  flooding. */
let lastStatusNotifyAt = 0;
const STATUS_NOTIFY_INTERVAL_MS = 1_000;

/** Fire a strike out to every subscriber; isolate each callback so one
 *  throwing listener doesn't kill the others. Also stamps
 *  `lastStrikeAt` so the stall detector knows the stream is alive. */
function emitStrike(strike: LightningStrike): void {
    const now = Date.now();
    state.lastStrikeAt = now;
    state.strikesReceived++;
    // Add to the rolling rate-window — kept short (60s) so the pill's
    // strikes/min number reflects current storm intensity, not session
    // history. Trim eagerly to the same window so the array doesn't
    // grow unbounded during a big storm.
    state.recentStrikeTimes.push(now);
    const cutoff = now - RATE_WINDOW_MS;
    while (state.recentStrikeTimes.length > 0 && state.recentStrikeTimes[0] < cutoff) {
        state.recentStrikeTimes.shift();
    }
    // Reset the stall timer — every strike resets the 2-min countdown.
    armStallTimer();
    // Throttle pill updates to 1Hz (1 second). Without this throttle the
    // pill never re-rendered after the first strike (stuck at "1"); with
    // a too-aggressive notify it would re-render on every strike during
    // a big storm and burn CPU on diff churn.
    if (now - lastStatusNotifyAt >= STATUS_NOTIFY_INTERVAL_MS) {
        lastStatusNotifyAt = now;
        notifyStatusObservers();
    }
    state.listeners.forEach((cb) => {
        try {
            cb(strike);
        } catch (err) {
            log.warn('Listener threw', err);
        }
    });
}

async function connect(): Promise<void> {
    if (state.status !== 'closed' && state.status !== 'stalled') return;
    setStatus('connecting');

    if (!Capacitor.isNativePlatform()) {
        // Web path intentionally left unwired — Blitzortung rejects
        // browser origins. Once a server-side relay ships this is
        // where we'd open wss://relay.thalassawx.com instead.
        // NOTE: uses warn (not info) so it survives prod builds — if
        // this fires on a real iOS device, something is very wrong
        // with Capacitor.isNativePlatform() and we want to see it.
        log.warn('Web platform detected — lightning feed not available (server relay required)');
        setStatus('unsupported');
        return;
    }

    const url = pickServerUrl();
    state.currentServer = url;
    // Use WARN so this survives prod — critical for field debugging.
    log.warn(`[Lightning] Opening native WebSocket to ${url}`);

    // Tear down any previous handles first (defensive — start/stop cycles).
    await teardownNativeHandles();

    // Register handlers BEFORE start so we don't race the first frames.
    const onOpen = await LightningNative.addListener('open', () => {
        log.warn('[Lightning] WebSocket open — streaming strikes');
        setStatus('open');
        state.retryAttempts = 0;
        // Arm the stall detector; `emitStrike` will reset it on every
        // strike. If nothing arrives in 2 min we'll force a reconnect.
        armStallTimer();
    });
    const onMessage = await LightningNative.addListener('message', ({ data }) => {
        if (!data) return;
        const strike = decodeMessage(data);
        if (strike) emitStrike(strike);
    });
    const onError = await LightningNative.addListener('error', ({ error }) => {
        log.warn('[Lightning] WebSocket error:', error ?? '(unknown)');
    });
    const onClose = await LightningNative.addListener('close', ({ code, reason }) => {
        log.warn(`[Lightning] WebSocket closed: code=${code ?? 'n/a'} reason=${reason || '(none)'}`);
        if (state.stallTimer) {
            clearTimeout(state.stallTimer);
            state.stallTimer = null;
        }
        setStatus('closed');
        // If we still have active subscribers, try to come back — but
        // with a bounded backoff so a misbehaving server doesn't burn
        // battery.
        if (state.listeners.size > 0) scheduleReconnect();
    });
    state.nativeHandles = [onOpen, onMessage, onError, onClose];

    try {
        // Subscribe message: extracted from the live map.blitzortung.org
        // viewer's obfuscated JS by reading the WebSocket onopen handler:
        //
        //   ws.send('{"a":111}');
        //
        // The 'a' key is some kind of authentication/capability handshake
        // value — the meaning of 111 is opaque but it's a literal in their
        // code. We tried {"time":0} (legacy) and a bbox format (guess);
        // neither works on the current server. {"a":111} unlocks the feed.
        const subscribeMessage = JSON.stringify({ a: 111 });
        // Reset the raw-frame debug budget each connect so we see the
        // first frames of every reconnect, not just the very first one.
        rawFrameDebugBudget = 5;
        await LightningNative.start({
            url,
            subscribeMessage,
        });
        log.warn(`[Lightning] native start() resolved, subscribe=${subscribeMessage}, waiting for didOpen`);
    } catch (err) {
        log.warn('[Lightning] native start() rejected:', err);
        setStatus('closed');
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
    if (state.stallTimer) {
        clearTimeout(state.stallTimer);
        state.stallTimer = null;
    }
    state.retryAttempts = 0;
    setStatus('closed');
    if (!Capacitor.isNativePlatform()) return;
    try {
        await LightningNative.stop();
    } catch {
        /* best effort */
    }
    await teardownNativeHandles();
}

/** Subscribe to connection-status changes for UI diagnostics. Separate
 *  from strike subscription so a status pill doesn't have to care about
 *  individual strikes. Returns an unsubscribe fn. */
export function subscribeLightningStatus(cb: (snapshot: StatusSnapshot) => void): () => void {
    state.statusObservers.add(cb);
    // Fire immediately so the caller gets current state without waiting.
    cb(buildSnapshot());
    return () => {
        state.statusObservers.delete(cb);
    };
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
