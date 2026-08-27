/**
 * NmeaListenerService — Background NMEA 0183 TCP/WebSocket listener.
 * Connects to vessel's Wi-Fi MFD, parses instrument sentences,
 * and emits averaged NmeaSample every 5 seconds.
 *
 * Transport layer:
 * - Native (iOS/Android): Raw TCP via capacitor-tcp-socket (for YDWG-02 etc.)
 * - Web (browser dev):    WebSocket fallback
 */
import { createLogger } from '../utils/createLogger';
import type { NmeaSample } from '../types';
import { Capacitor } from '@capacitor/core';
import { processAisSentence } from './AisDecoder';
import { AisStore } from './AisStore';
import { AisHubService } from './AisHubService';
import { offer as offerToFleetShare, reportLink as reportFleetShareLink } from './AisShareService';
import { NmeaRateTracker } from './NmeaRateTracker';
import { getNmeaDeviceLabel } from './NmeaDeviceProfiles';
import { parseNmeaDepth, parseNmeaNumber, validateNmeaSentence, type ParsedNmeaDepth } from './nmea/nmeaSentence';
import { NMEA_SAMPLE_INTERVAL_MS } from './nmea/nmeaCadence';
// Bearings cannot be averaged arithmetically: the mean of 359 and 001 is 180,
// which points a north-facing boat due south. That trap sits exactly where
// Serene Summer was moored when the compass was reported wrong (2026-08-08).
import { circularMean } from '../utils/circularStats';
const log = createLogger('NMEA');

// Count rejected framing/checksum boundaries — surfaced occasionally so a
// corrupted NMEA link is diagnosable in the field without flooding logs.
let _nmeaSentenceRejects = 0;
/** XDR sentences dropped as a whole-attitude fault — surfaced sparingly. */
let xdrFaultSentences = 0;

// ── Configuration ──
const DEFAULT_HOST = '192.168.1.151';
const DEFAULT_PORT = 1456; // YDWG-02 standard TCP port
const RECONNECT_BASE_MS = 2000;
/** First retry after a drop. A gateway on the same Wi-Fi is usually back
 *  instantly, and paying the full 2 s base for attempt #1 was most of the
 *  "slow to reconnect" feel. The exponential ladder starts from attempt #2. */
const RECONNECT_FIRST_MS = 400;
/** Was 30 s. That is a sensible ceiling for a server across the internet and
 *  far too long for a box on the same LAN — a blip could leave the app idling
 *  half a minute after the gateway was reachable again. */
const RECONNECT_MAX_MS = 10000;
/**
 * Treat an open-but-silent socket as dead.
 *
 * The YDWG-02 streams continuously — measured 3,146 sentences in 91 s — so
 * silence is not "quiet", it is a corpse. Read timeouts were treated as
 * normal and `continue`d forever, so a HALF-OPEN socket (the usual result of
 * a Wi-Fi drop, where no FIN ever arrives) left the service reporting
 * "connected" indefinitely while receiving nothing, AND holding one of the
 * gateway's three TCP slots hostage until it timed the connection out.
 *
 * 15 s is deliberately generous: this service also feeds quieter sources
 * than the YDWG (multiplexers, a Bad Elf), and the cost of being wrong is
 * only a clean release plus a 400 ms reconnect.
 */
const DATA_SILENCE_TIMEOUT_MS = 15000;
/**
 * Ignore repeat network-change events inside this window.
 *
 * iOS does not report a Wi-Fi transition as one clean event. Reachability
 * flags flap several times as an interface comes up, an address is assigned
 * and a route is installed, so a single walk-aboard can deliver a burst.
 * Acting on every one would reconnect a socket several times over — and
 * against a gateway with three slots, restraint is not a nicety.
 */
const NETWORK_NUDGE_MIN_GAP_MS = 1500;
/**
 * A socket that delivered a sentence this recently is not gone, whatever the
 * OS says. `connected: false` means "no default route" — a statement about the
 * WAN. The boat's own Wi-Fi can lose its uplink while the LAN, and the gateway
 * sitting on it, carry on perfectly. Evidence beats opinion.
 */
const NETWORK_LOSS_GRACE_MS = 3000;
/**
 * When the interface type changes under a live socket — stepping off the boat
 * onto 5G — the socket is probably dead but has not been told. Rather than
 * assume, shorten its leash: it has this long to deliver another sentence
 * before the silence watchdog retires it.
 */
const NETWORK_TYPE_CHANGE_PROBE_MS = 3000;
/**
 * Zeroing the backoff ladder on every network event lets a flapping Wi-Fi
 * defeat it completely — each flap costs an immediate connect plus a re-armed
 * 400 ms retry. The ladder may be reset this often and no more; outside the
 * window an event still reconnects at once, it just does not rewind the climb.
 */
const LADDER_RESET_MIN_GAP_MS = 30000;
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000; // Give up after 5 minutes of failed reconnects
const TCP_READ_TIMEOUT_S = 5; // Read timeout for TCP polling (seconds)
const TCP_READ_BUFFER = 4096; // Bytes to request per read cycle
/**
 * How an iOS read actually reports "nothing" — and why it is ambiguous.
 *
 * capacitor-tcp-socket does NOT reject on a read timeout. TcpSocketPlugin.swift
 * does `guard let response = client.read(...) else { call.resolve(["result": ""]) }`,
 * and TCPClient.read returns nil for `readLen <= 0` — which ytcpsocket_pull
 * produces for a select() timeout, for EOF and for a reset, indistinguishably.
 * So every one of those arrives here as a RESOLVED empty string.
 *
 * The two cases are still separable, by clock rather than by value: a genuine
 * idle timeout blocks for the full TCP_READ_TIMEOUT_S inside select(), while
 * EOF and RST return immediately. An empty read that comes back in well under
 * the timeout we asked for is a finished socket, not a quiet one — which also
 * means it would spin this loop at full tilt against the single serial
 * Capacitor bridge queue the whole app shares if we simply looped again.
 */
const FAST_EMPTY_READ_MS = (TCP_READ_TIMEOUT_S * 1000) / 2;
const FAST_EMPTY_READS_BEFORE_DEAD = 3;
const EMPTY_READ_PAUSE_MS = 150;

export type NmeaConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type NmeaSampleCallback = (sample: NmeaSample) => void;

/**
 * The known transport endpoint, rather than a claim about the physical GPS
 * antenna. A regular NMEA 0183 stream cannot tell us its receiver make/model.
 */
export interface NmeaConnectionInfo {
    status: NmeaConnectionStatus;
    enabled: boolean;
    host: string;
    port: number;
    deviceId: string | null;
    deviceLabel: string;
    transport: 'tcp' | 'websocket';
}

/**
 * Does a positive XDR Roll mean heel to starboard? Standard convention says
 * yes. One boolean, because the alternative is negating at three call sites
 * and missing one.
 */
const HEEL_STARBOARD_POSITIVE = true;

/**
 * The value a Yacht Devices gateway emits for an attitude axis the sensor did
 * not supply. XDR attitude is encoded in quarter-degree steps; 255 quarters is
 * 0xFF, the N2K "not available" byte, and 255 / 4 = 63.75°.
 *
 * Used two ways. The whole-sentence fault is recognised by SHAPE (yaw, pitch
 * and roll all identical), which is gateway-agnostic. This number is matched
 * only for the PARTIAL fault: on 2026-08-19, a Garmin GPS 24xd on Serene
 * Summer's bus was caught transmitting `Yaw=63.75 Pitch=63.75 Roll=1.0` —
 * per-axis "not available" on a device with no attitude hardware. Two or more
 * axes at exactly this value mark those axes as no-data; a SINGLE axis at
 * 63.75 beside sane companions is still believed, because a real knockdown at
 * 63.75° of roll must never fall through the guard.
 */
export const XDR_ATTITUDE_UNAVAILABLE_DEG = 63.75;

/**
 * A compass bearing or course that a device can actually steer. The YDWG
 * scales N2K sentinels like any other number: heading 0xFFFE arrives as
 * 6.5534 rad = 375.5° on the wire (seen verbatim from a factory-fresh GPS
 * 24xd, and in the 2026-08-09 "un-normalised VHW" capture — those were never
 * wraparound, they were error codes). Folding 375.5 through a modulo or a
 * circular mean launders the sentinel into a confident, wrong 15.5°. Out of
 * range is out — never normalised.
 */
const isPlausibleBearing = (v: number) => v >= 0 && v <= 360;

// ── Raw accumulator between emissions ──
interface RawAccumulator {
    tws: number[];
    twa: number[];
    /** Signed true wind angle, negative to port. Drawable; `twa` is not. */
    twaSigned: number[];
    heel: number[];
    pitch: number[];
    /** True wind DIRECTION as a compass bearing (deg true), from MWD. */
    twd: number[];
    /** Apparent wind speed (kts) and signed angle off the bow, from MWV,R. */
    aws: number[];
    awa: number[];
    stw: number[];
    heading: number[];
    rpm: number[];
    /** $xxRSA rudder angle (°, + = helm to starboard). Raw per-sentence
     *  values — the 5s sample carries mean AND swing because helm-balance
     *  activity needs the excursion the mean smooths away. */
    rudder: number[];
    voltage: number[];
    /** DBT fallback for this sample window (never averaged with DPT). */
    depthDbt: ParsedNmeaDepth | null;
    /** DPT wins when both forms are broadcast because it declares an offset. */
    depthDpt: ParsedNmeaDepth | null;
    sog: number[];
    cog: number[];
    waterTemp: number[];
    // GPS position — use last value, not averaged
    latitude: number | null;
    longitude: number | null;
    hdop: number | null;
    satellites: number | null;
    gpsFixQuality: number | null;
}

/**
 * Turn a raw socket failure into something a skipper can act on.
 *
 * The native layer surfaces strings like "The operation couldn't be completed.
 * (SwiftSocket.SocketError error 3.)", which names the errno and nothing else
 * — so a refused port and an unreachable boat looked identical on screen, and
 * both got rediagnosed as broken hardware. Error 3 in particular means the
 * host ANSWERED and refused the port, which is the single most useful thing
 * to know: the gateway is alive and the port is wrong or its server is down.
 *
 * The raw text is always kept on the end; support needs the errno even when
 * the plain-English half is what gets read.
 */
export function diagnoseConnectFailure(raw: string, host: string, port: number): string {
    const s = raw.toLowerCase();
    const where = `${host}:${port}`;
    if (/socketerror error 3\b|refused|econnrefused/.test(s)) {
        return `${where} answered but refused the connection — nothing is listening on port ${port}. Check the port, and that the gateway's NMEA server is running. (${raw})`;
    }
    if (/timed ?out|etimedout|socketerror error 60\b/.test(s)) {
        return `No answer from ${where} before the timeout — the gateway may be powered down, asleep, or on a network you are not currently on. (${raw})`;
    }
    if (/no route|enetunreach|ehostunreach|unreachable|socketerror error 51\b/.test(s)) {
        return `No route to ${host} — you are not on its network, and nothing is carrying it (subnet router or VPN). (${raw})`;
    }
    if (/refused to connect|connection reset|econnreset/.test(s)) {
        return `${where} dropped the connection. On a Yacht Devices gateway this usually means its TCP slots are already taken — close other apps or captures using it. (${raw})`;
    }
    return raw;
}

class NmeaListenerServiceClass {
    // ── Transport state ──
    private ws: WebSocket | null = null; // WebSocket (browser dev)
    private tcpClientId: number | null = null; // Native TCP client ID
    private tcpReadLoop = false; // Whether TCP read loop is active

    private status: NmeaConnectionStatus = 'disconnected';
    private host = DEFAULT_HOST;
    private port = DEFAULT_PORT;
    private reconnectAttempts = 0;
    /** Watchdog seed. Set when a socket opens AND when data arrives, because
     *  the watchdog measures "how long has this connection been quiet". */
    private lastDataAt = 0;
    /**
     * When a sentence genuinely ARRIVED. Never seeded on connect.
     *
     * Kept apart from lastDataAt because the two answer different questions,
     * and conflating them made the network-loss grace window trust a socket
     * that had proved nothing: opening a connection is not evidence the link
     * carries traffic. Only this field is evidence.
     */
    private lastSentenceAt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private firstAttemptTime: number | null = null; // For 5-minute give-up
    private sampleTimer: ReturnType<typeof setInterval> | null = null;
    private accumulator: RawAccumulator = this.freshAccumulator();
    private listeners: Set<NmeaSampleCallback> = new Set();
    private statusListeners: Set<(s: NmeaConnectionStatus) => void> = new Set();
    private enabled = false;
    /** Track if RPM data has ever been received */
    private hasRpmData = false;
    /** Partial NMEA line buffer for TCP (data may arrive mid-sentence) */
    private tcpLineBuffer = '';
    /** Last error message for UI display */
    private lastError: string | null = null;
    /** The 5-minute give-up parked us — retry once on next app foreground. */
    private parkedAfterGiveUp = false;
    /** OS network-change watch is registered (once, for the app's lifetime). */
    private networkWatchReady = false;
    /** Debounce stamp for the burst of events iOS emits per real transition. */
    private lastNetworkNudgeAt = 0;
    /**
     * Identity for the current socket. The read loop captures it on entry, so
     * a loop still parked inside a 5 s read when someone tears the connection
     * down from OUTSIDE it — the network-loss branch does exactly that — can
     * tell that the socket it was reading is not the socket the service now
     * holds, and decline to close somebody else's.
     */
    private connectionGeneration = 0;
    /** A connect is dispatched and unresolved — do not open a second socket. */
    private connectInFlight = false;
    /** Rationing stamp for backoff-ladder rewinds. */
    private lastLadderResetAt = 0;
    /** Last interface type the OS reported, to spot a change under a live socket. */
    private lastConnectionType = '';

    constructor() {
        // Un-park on app foreground. The webview fires visibilitychange on
        // Capacitor background/foreground transitions, and coming back to the
        // app is exactly when the boat Wi-Fi is likely reachable again.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) return;

                if (this.parkedAfterGiveUp && !this.enabled) {
                    log.warn('Retrying parked NMEA connection on app foreground');
                    // Retry at the BOTTOM of the ladder. Reopening the app is
                    // the strongest signal we get that the network just changed
                    // — walking aboard, joining the boat Wi-Fi. Resuming
                    // mid-ladder made that first attempt wait out the whole
                    // backoff cap, which reads as "still broken".
                    this.reconnectAttempts = 0;
                    this.start();
                    return;
                }

                // Still enabled but not connected: a retry is already queued,
                // somewhere up a ladder that may have climbed to its cap. That
                // countdown was measured against a network that no longer
                // exists — the skipper has just walked into Wi-Fi range and is
                // looking at the screen. Waiting out the remainder is the
                // single most visible part of "difficult to connect at times"
                // (Shane, 2026-08-17). Collapse it and go now.
                if (this.enabled && this.status !== 'connected' && this.reconnectTimer) {
                    log.info('App foregrounded while disconnected — retrying NMEA immediately');
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                    this.rewindLadderIfAllowed(Date.now());
                    this.connect();
                }
            });
        }
    }

    // ── Public API ──

    configure(host: string, port: number) {
        this.host = host || DEFAULT_HOST;
        this.port = port || DEFAULT_PORT;
    }

    /**
     * Auto-start on app boot if host/port were previously saved.
     * Silently does nothing if no config exists.
     */
    /**
     * The saved gateway, or null if the skipper has never configured one.
     *
     * Exposed so app bootstrap can start NmeaStore BEFORE the socket opens
     * without duplicating the localStorage keys. Ordering matters: the store
     * has to be subscribed in time to catch the initial 'connecting' status,
     * or the instrument panel believes there is no feed while the gateway is
     * connected and streaming.
     */
    getSavedConfig(): { host: string; port: number } | null {
        const savedHost = localStorage.getItem('nmea_host');
        const savedPort = localStorage.getItem('nmea_port');
        if (!savedHost && !savedPort) return null;
        return {
            host: savedHost || DEFAULT_HOST,
            port: parseInt(savedPort || String(DEFAULT_PORT), 10),
        };
    }

    /** Reconnect to the saved gateway. Returns false when none is saved. */
    autoStart(): boolean {
        const config = this.getSavedConfig();
        if (!config) return false; // No NMEA config saved — skip
        this.configure(config.host, config.port);
        this.start();
        return true;
    }

    start() {
        if (this.enabled) return;
        this.enabled = true;
        // Registered here rather than in the constructor so the plugin is never
        // touched by an app that has no gateway configured — and so the 800-odd
        // test files that import this service transitively never load it.
        void this.ensureNetworkWatch();
        this.parkedAfterGiveUp = false;
        this.firstAttemptTime = Date.now();
        this.connect();
        this.startSampleTimer();
    }

    stop() {
        this.enabled = false;
        this.tcpReadLoop = false;
        // stop() is the public off-switch (NmeaPage Disconnect, Smart Polars
        // toggle) — it must also disarm the parked-retry tripwire, or an
        // explicit disable issued after a park gets silently undone by the
        // next app foreground (audit 2026-08-02). The give-up path re-sets
        // the flag AFTER calling stop(), so legitimate parking still works.
        this.parkedAfterGiveUp = false;
        this.firstAttemptTime = null;
        this.reconnectAttempts = 0;
        this.lastError = null;
        // Throttles must not outlive the off-switch. Flipping Disconnect and
        // then Connect is a deliberate act; it must not be swallowed as a
        // duplicate of some event from before the service was switched off.
        this.lastNetworkNudgeAt = 0;
        this.lastLadderResetAt = 0;
        // A native connect that never settles would otherwise latch this true
        // for the life of the process, and every later connect() would return
        // early — the off/on switch, the one recovery a skipper has, silently
        // stops working. stop() ends the attempt, so it also ends the claim.
        this.connectInFlight = false;
        this.stopSampleTimer();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Disconnect active transport
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.disconnectTcp();
        this.setStatus('disconnected');
    }

    getStatus(): NmeaConnectionStatus {
        return this.status;
    }
    getConnectionInfo(): NmeaConnectionInfo {
        const deviceId = this.readSavedDeviceId();
        return {
            status: this.status,
            enabled: this.enabled,
            host: this.host,
            port: this.port,
            deviceId,
            deviceLabel: getNmeaDeviceLabel(deviceId),
            transport: Capacitor.isNativePlatform() ? 'tcp' : 'websocket',
        };
    }
    getHasRpmData(): boolean {
        return this.hasRpmData;
    }
    getReconnectAttempts(): number {
        return this.reconnectAttempts;
    }
    isReconnecting(): boolean {
        return this.enabled && this.reconnectAttempts > 0 && this.status !== 'connected';
    }
    getLastError(): string | null {
        return this.lastError;
    }
    isEnabled(): boolean {
        return this.enabled;
    }

    private readSavedDeviceId(): string | null {
        try {
            return localStorage.getItem('nmea_device');
        } catch {
            // Keep the service import-safe in non-browser test/runtime paths.
            return null;
        }
    }

    onSample(cb: NmeaSampleCallback) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    onStatusChange(cb: (s: NmeaConnectionStatus) => void) {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
    }

    // ── Connection ──

    private connect() {
        if (!this.enabled) return;

        if (Capacitor.isNativePlatform()) {
            // TcpSocket.connect can sit unresolved for seconds against an
            // unreachable host. Until it settles this.tcpClientId is still
            // null, so connectTcp's own defensive release finds nothing and a
            // second connect opens a SECOND socket — the first one's handle
            // then arrives and is overwritten, orphaning a slot on a gateway
            // that has three. Reachable in one tap: any retry trigger (network
            // change, app foreground) firing while status is 'connecting'.
            if (this.connectInFlight) {
                log.info('Connect already in flight — not opening a second socket');
                return;
            }
            this.connectInFlight = true;
            this.setStatus('connecting');
            void this.connectTcp().finally(() => {
                this.connectInFlight = false;
            });
        } else {
            this.setStatus('connecting');
            this.connectWebSocket();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  NATIVE TCP TRANSPORT (capacitor-tcp-socket)
    // ═══════════════════════════════════════════════════════════════

    private async connectTcp() {
        try {
            // Never stack a second socket on top of a live one. Any path that
            // reaches connect while a client is still held would otherwise
            // burn one of the gateway's three slots per attempt.
            await this.releaseTcpClient();
            const { TcpSocket } = await import('capacitor-tcp-socket');
            const result = await TcpSocket.connect({
                ipAddress: this.host,
                port: this.port,
            });
            this.tcpClientId = result.client;
            this.tcpLineBuffer = '';
            this.lastDataAt = Date.now();
            this.reconnectAttempts = 0;
            this.firstAttemptTime = null; // Reset give-up timer on success
            this.setStatus('connected');
            log.info(`TCP connected to ${this.host}:${this.port} (client ${this.tcpClientId})`);

            // Start continuous read loop
            this.tcpReadLoop = true;
            this.runTcpReadLoop();
        } catch (e: unknown) {
            const msg = (e as Error)?.message || String(e);
            log.warn('TCP connect failed:', msg);
            this.lastError = diagnoseConnectFailure(msg, this.host, this.port);
            this.setStatus('error');
            if (this.enabled) this.scheduleReconnect();
        }
    }

    /**
     * Continuously reads from the TCP socket in a loop.
     * The YDWG-02 streams NMEA sentences non-stop; we read chunks
     * and split them into individual lines for parsing.
     */
    private async runTcpReadLoop() {
        // Captured, not re-read each turn. Both matter: `client` so we can never
        // read from or close a socket this loop did not open, and `generation`
        // so an out-of-loop teardown cleanly retires us.
        const client = this.tcpClientId;
        if (client === null) return;
        const generation = this.connectionGeneration;
        let fastEmptyReads = 0;

        try {
            const { TcpSocket } = await import('capacitor-tcp-socket');

            while (this.tcpReadLoop && this.enabled && generation === this.connectionGeneration) {
                try {
                    const readStartedAt = Date.now();
                    const { result } = await TcpSocket.read({
                        client,
                        expectLen: TCP_READ_BUFFER,
                        timeout: TCP_READ_TIMEOUT_S,
                    });

                    if (result && result.length > 0) {
                        fastEmptyReads = 0;
                        this.lastDataAt = Date.now();
                        this.lastSentenceAt = this.lastDataAt;
                        // Append to line buffer and process complete lines
                        this.tcpLineBuffer += result;
                        const lines = this.tcpLineBuffer.split(/\r?\n/);
                        // Last element may be a partial line — keep it in the buffer
                        this.tcpLineBuffer = lines.pop() || '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('$') || trimmed.startsWith('!')) {
                                this.parseNmeaSentence(trimmed);
                            }
                        }
                        continue;
                    }

                    // Empty result. On iOS this is EVERY quiet outcome —
                    // timeout, EOF and reset alike (see FAST_EMPTY_READ_MS).
                    // The silence check has to live here, not in the catch
                    // below: that catch is gated on a rejection the native
                    // plugin never produces, so a watchdog placed inside it
                    // could not fire on the very platform this ships to.
                    if (Date.now() - readStartedAt < FAST_EMPTY_READ_MS) {
                        // Returned far too quickly to have waited out select().
                        // The socket is finished; do not wait for the silence
                        // timeout to say so, and do not spin on it either.
                        fastEmptyReads++;
                        if (fastEmptyReads >= FAST_EMPTY_READS_BEFORE_DEAD) {
                            log.warn('Socket returning empty reads immediately — closed at the far end');
                            this.lastError = 'Gateway closed the connection';
                            break;
                        }
                    } else {
                        fastEmptyReads = 0;
                    }

                    if (this.isDataSilenceFatal()) break;
                    await new Promise((r) => setTimeout(r, EMPTY_READ_PAUSE_MS));
                } catch (readErr: unknown) {
                    // Read timeout is normal (no data available) — just continue
                    const errObj = readErr as Record<string, unknown> | null;
                    if (errObj?.message?.toString().includes?.('timeout') || errObj?.code === 'TIMEOUT') {
                        // Retained for transports that DO reject on timeout —
                        // the WebSocket dev path and Android. iOS never lands
                        // here; its timeouts resolve empty and are handled above.
                        if (this.isDataSilenceFatal()) break;
                        continue;
                    }
                    // Actual error — connection lost
                    log.warn('TCP read error:', readErr);
                    break;
                }
            }
        } catch (importErr) {
            log.warn('TCP plugin import error:', importErr);
        }

        // CLOSE THE SOCKET BEFORE RECONNECTING. This used to drop the handle
        // (`this.tcpClientId = null`) and open a fresh one, which leaks the
        // native socket: the gateway still holds it open, and nothing ever
        // closes it.
        //
        // That is fatal against a YDWG-02, because its TCP server has exactly
        // THREE usable client slots. Measured on Serene Summer's gateway
        // 2026-08-08: connections four, five and six complete the handshake
        // and are then reset by the gateway — accepted, never fed. So three
        // read errors are enough for the app to fill every slot with its own
        // orphans and lock ITSELF out. From there it is self-sustaining:
        // connect succeeds at the TCP layer, the gateway resets it, the read
        // loop errors, another slot leaks, repeat. The skipper sees "won't
        // connect" from a gateway that is streaming perfectly, and the only
        // escape was the manual Disconnect button — the one path that did
        // close properly (disconnectTcp) — or power-cycling the gateway.
        //
        // A read error means this socket is finished either way, so closing it
        // costs nothing and returns the slot immediately.
        // Only if this loop still owns the connection. A teardown from outside
        // (network loss) has already released the socket and may have opened a
        // replacement; closing "the current client" from here would shut down a
        // healthy connection somebody else established and report it dead.
        if (generation !== this.connectionGeneration) {
            log.info('Read loop retired — a newer connection has taken over');
            return;
        }
        await this.releaseTcpClient();
        if (this.enabled) {
            this.setStatus('disconnected');
            this.scheduleReconnect();
        }
    }

    /**
     * Has the gateway gone quiet for long enough to call the socket dead?
     *
     * One definition, reached from both the empty-resolve path and the
     * rejecting-timeout path, so the two transports cannot drift apart.
     */
    private isDataSilenceFatal(): boolean {
        const silentFor = Date.now() - this.lastDataAt;
        if (silentFor <= DATA_SILENCE_TIMEOUT_MS) return false;
        log.warn(`No NMEA data for ${Math.round(silentFor / 1000)}s — treating the socket as dead`);
        this.lastError = 'Gateway stopped sending — reconnecting';
        return true;
    }

    /**
     * Hand this client's slot back to the gateway. Safe to call when there is
     * nothing open, and never throws — a gateway that has already reset the
     * socket will reject the close, which is fine: the point is that we always
     * ASK, so a healthy gateway reclaims the slot at once rather than waiting
     * out its own idle timeout.
     */
    private async releaseTcpClient(): Promise<void> {
        // Retires any read loop still parked on the old socket.
        this.connectionGeneration++;
        const client = this.tcpClientId;
        this.tcpClientId = null;
        this.tcpLineBuffer = '';
        if (client === null) return;
        try {
            const { TcpSocket } = await import('capacitor-tcp-socket');
            await TcpSocket.disconnect({ client });
            log.info(`TCP slot released (client ${client})`);
        } catch (e) {
            log.warn('TCP slot release failed (socket already gone?):', e);
        }
    }

    private async disconnectTcp() {
        this.tcpReadLoop = false;
        // One closer, shared with the read-loop exit. Two of them is how the
        // manual Disconnect button ended up being the only path that actually
        // returned a gateway slot.
        await this.releaseTcpClient();
    }

    // ═══════════════════════════════════════════════════════════════
    //  WEBSOCKET TRANSPORT (browser dev fallback)
    // ═══════════════════════════════════════════════════════════════

    private connectWebSocket() {
        try {
            const url = `ws://${this.host}:${this.port}`;
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                this.firstAttemptTime = null; // Reset give-up timer on success
                this.setStatus('connected');
            };

            this.ws.onmessage = (event) => {
                const lines = String(event.data).split(/\r?\n/);
                for (const line of lines) {
                    if (line.startsWith('$') || line.startsWith('!')) {
                        this.parseNmeaSentence(line.trim());
                    }
                }
            };

            this.ws.onerror = () => {
                if (this.enabled) this.setStatus('error');
            };

            this.ws.onclose = () => {
                this.ws = null;
                if (this.enabled) {
                    this.setStatus('disconnected');
                    this.scheduleReconnect();
                }
            };
        } catch (e) {
            log.warn(e);
            this.setStatus('error');
            if (this.enabled) this.scheduleReconnect();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SHARED INFRASTRUCTURE
    // ═══════════════════════════════════════════════════════════════

    private scheduleReconnect() {
        if (!this.enabled || this.reconnectTimer) return;

        // The give-up clock arms when a reconnect cycle BEGINS. start() also
        // arms it, but successful connects null it ('reset give-up timer on
        // success') and the transport-loss paths (TCP read-loop exit,
        // ws.onclose) jump straight here — so after the first successful
        // connection of a session the 5-minute park could never fire again,
        // and the service hammered TcpSocket.connect every ≤30 s forever
        // once the phone left boat Wi-Fi (audit 2026-08-02).
        if (!this.firstAttemptTime) this.firstAttemptTime = Date.now();

        // Park after 5 minutes of continuous failed attempts. This used to be
        // a PERMANENT give-up (stop(), enabled=false, nothing ever retried),
        // which silently killed a mux-fed Bad Elf / MFD feed until the
        // skipper manually reconnected: walk out of Wi-Fi range for six
        // minutes and the feed was gone for the day. Now the give-up is a
        // parked state that retries once on the next app foreground —
        // start() re-arms the give-up clock, so a still-dead network parks
        // again after another 5 minutes instead of looping hot.
        //
        // The flag is set AFTER stop() because stop() clears it: stop() is
        // also the user's off-switch and must disarm the retry, while this
        // path is the one caller that wants it armed.
        if (this.firstAttemptTime && Date.now() - this.firstAttemptTime > RECONNECT_GIVE_UP_MS) {
            log.warn('Parking NMEA reconnects after 5 minutes of failures — will retry on next app foreground');
            // Keep WHY it failed. stop() clears lastError, which is correct for
            // the user's off-switch and exactly wrong here: parking is the
            // moment the skipper finally looks at the screen, and deleting the
            // reason leaves a bare "Disconnected" with no cause (Shane
            // 2026-08-13, unable to tell a refused connection from a dead
            // gateway). Restored after stop() rather than teaching stop() a
            // flag, so the off-switch keeps its single obvious behaviour.
            const parkedReason = this.lastError;
            this.stop();
            this.lastError = parkedReason;
            this.parkedAfterGiveUp = true;
            return;
        }

        // Attempt #1 goes almost immediately — a LAN device that just dropped
        // is usually already back. Everything after climbs as before. Jitter
        // keeps several clients (phone, MFD, laptop) from retrying in lockstep
        // and racing for the same three slots.
        const base =
            this.reconnectAttempts === 0
                ? RECONNECT_FIRST_MS
                : RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1);
        const delay = Math.min(base, RECONNECT_MAX_MS) + Math.random() * 250;
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /**
     * Watch the OS for network changes.
     *
     * Everything else in this service is a guess about the network dressed up
     * as a timer: wait 400 ms, wait 10 s, wait for the app to be foregrounded.
     * The OS already knows the moment the phone joins the boat's Wi-Fi, leaves
     * it, or has a VPN raised or dropped underneath it. Asking it is the
     * difference between reconnecting when the network actually returns and
     * reconnecting whenever the ladder next happens to fire.
     *
     * Registered once and never removed, exactly like the visibilitychange
     * handler above: this service is an app-lifetime singleton, and the handler
     * is inert while the feature is off. The returned handle is deliberately
     * discarded — there is nothing in the app's life that would call it.
     *
     * The import is dynamic and reached only from start(), which is what keeps
     * the plugin off the boot path of the 30 test files that evaluate this
     * module. Note what the catch below does NOT cover: mocking @capacitor/core
     * does not reach inside @capacitor/network, because that package lives in
     * node_modules and is externalized rather than inlined, so it binds the
     * real registerPlugin. Under vitest the genuine web plugin loads and
     * succeeds against jsdom. The catch is for a host where the plugin is
     * absent outright; there, reconnects fall back to the timer ladder.
     */
    private async ensureNetworkWatch(): Promise<void> {
        if (this.networkWatchReady) return;
        // Claimed BEFORE the await, or two rapid start() calls each get past
        // the guard while the import is in flight and register two listeners.
        this.networkWatchReady = true;
        try {
            const { Network } = await import('@capacitor/network');
            // addListener returns a PROMISE of the handle in Capacitor 5+.
            // Not awaiting it is the classic silent bug here.
            await Network.addListener('networkStatusChange', (status) => {
                this.handleNetworkStatusChange(status.connected, status.connectionType);
            });
            log.info('Network-change watch registered — reconnects now follow the OS, not the clock');
        } catch (e) {
            // Retry on the next start() rather than giving up for the session.
            this.networkWatchReady = false;
            log.warn('Network-change watch unavailable, falling back to timers:', (e as Error)?.message || e);
        }
    }

    /**
     * The OS says the network moved. Two cases, and the losing one matters most.
     *
     * LOST: our TCP socket is already dead — it simply has not been told. Left
     * alone it becomes an orphan occupying one of the YDWG-02's three slots
     * until the GATEWAY times it out, which is precisely how the app locks
     * itself out of a gateway that is streaming perfectly (see releaseTcpClient
     * below). Handing the slot back at the moment connectivity drops is the
     * cheapest slot-exhaustion fix available.
     *
     * GAINED: retry now. Not after the remaining 10 s of a backoff that was
     * counting down against a network which no longer exists.
     */
    private handleNetworkStatusChange(connected: boolean, connectionType: string): void {
        // NOTE, because the obvious refinement is a trap: do NOT also skip
        // events whose {connected, connectionType} payload matches the last
        // one. iOS does re-fire identical payloads (it de-duplicates on raw
        // SCNetworkReachability flags, so a Wi-Fi band change re-fires with the
        // same derived value), and suppressing those looks like free thrift.
        // But leaving the marina's Wi-Fi for the boat's own is ALSO
        // connected:true / 'wifi' both sides, and that is precisely the moment
        // this whole feature exists to catch. Dropping it to spare a few
        // redundant connects would break the case Shane asked for. The runaway
        // is bounded anyway: firstAttemptTime is untouched here, so five
        // minutes of failure still parks the retries however many events land.
        const now = Date.now();

        // A LOSS IS NEVER DEBOUNCED, and never stamps the window either.
        // Debouncing exists to stop redundant CONNECTS; there is at most one
        // socket to release and releasing it twice is a no-op, so throttling
        // this side buys nothing and costs a slot. The sequence that proves it:
        // the network returns, we reconnect and stamp the window, and Wi-Fi
        // drops again 500 ms later mid-handoff. Debounced, that drop is
        // swallowed and the socket becomes an orphan against a gateway with
        // three of them — the precise failure this whole feature exists to
        // prevent. Stamping here would be the same mistake mirrored: it would
        // debounce the recovery that follows a flap.
        const previousType = this.lastConnectionType;
        this.lastConnectionType = connectionType;

        if (!connected) {
            if (!this.enabled || this.tcpClientId === null) return;
            // EVIDENCE BEATS OPINION. `connected: false` is derived from
            // reachability flags for 0.0.0.0 — it means "no default route",
            // which is a claim about the WAN. A boat Wi-Fi whose uplink just
            // died says exactly that while the gateway on the same LAN keeps
            // streaming. A sentence in the last few seconds is proof the link
            // is alive, and proof outranks the OS's summary of it.
            const sinceData = Date.now() - this.lastSentenceAt;
            if (sinceData < NETWORK_LOSS_GRACE_MS) {
                log.info(`Network reported down, but NMEA data arrived ${sinceData}ms ago — keeping the socket`);
                return;
            }
            log.warn('Network lost — releasing the NMEA socket rather than orphaning a gateway slot');
            this.lastError = 'Network unavailable';
            // Drop out of the read loop, then close. The loop's own exit path
            // re-releases (a no-op) and schedules the reconnect, and
            // scheduleReconnect ignores a second call while one is pending —
            // so this cannot double-schedule or double-open.
            this.tcpReadLoop = false;
            void this.releaseTcpClient();
            this.setStatus('disconnected');
            this.scheduleReconnect();
            return;
        }

        // Stepping off the boat onto 5G never reports `connected: false` — it
        // is connected:true / 'cellular', and until this existed no branch
        // acted on it at all: the loss branch is skipped, and the retry branch
        // below is gated on not already being connected. The socket over the
        // departed Wi-Fi is almost certainly dead, but "almost" is not grounds
        // for closing a working connection, so demand proof instead of
        // guessing — shorten its leash and let the silence watchdog decide.
        if (this.status === 'connected' && previousType && connectionType !== previousType) {
            log.warn(`Interface changed ${previousType} → ${connectionType} under a live socket — probing it`);
            const leash = Date.now() - (DATA_SILENCE_TIMEOUT_MS - NETWORK_TYPE_CHANGE_PROBE_MS);
            this.lastDataAt = Math.min(this.lastDataAt, leash);
            return;
        }

        if (now - this.lastNetworkNudgeAt < NETWORK_NUDGE_MIN_GAP_MS) return;
        // Stamped inside each acting branch below, never here: an event we
        // ignore — no gateway configured, nothing to retry — must not spend the
        // window and swallow the real transition a second behind it.

        if (this.parkedAfterGiveUp && !this.enabled) {
            log.warn(`Network back (${connectionType}) — retrying parked NMEA connection`);
            this.lastNetworkNudgeAt = now;
            this.rewindLadderIfAllowed(now);
            this.start();
            return;
        }

        if (this.enabled && this.status !== 'connected') {
            log.info(`Network changed (${connectionType}) — retrying NMEA immediately`);
            this.lastNetworkNudgeAt = now;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.rewindLadderIfAllowed(now);
            this.connect();
        }
    }

    /**
     * Send the backoff ladder back to the bottom — but not on demand.
     *
     * Every trigger that means "the network moved" wants an immediate retry,
     * and rewinding the ladder as well felt like part of the same thought. It
     * is not: under a flapping Wi-Fi the events keep coming, the ladder never
     * climbs past its first rung, and the retry rate rises by an order of
     * magnitude against a gateway with three slots. The immediate reconnect is
     * the valuable half and is kept unconditionally by the callers; only the
     * rewind is rationed.
     */
    private rewindLadderIfAllowed(now: number): void {
        if (now - this.lastLadderResetAt < LADDER_RESET_MIN_GAP_MS) return;
        this.lastLadderResetAt = now;
        this.reconnectAttempts = 0;
    }

    private setStatus(s: NmeaConnectionStatus) {
        this.status = s;
        for (const cb of this.statusListeners) cb(s);
        // Tell the crowd-feed what the gateway is doing. The dependency points
        // this way on purpose: AisShareService is already downstream of the
        // hot path here, so having it ask US would be a circular import.
        //
        // Note 'connecting' maps to 'reconnecting' rather than 'down' — a
        // socket that is mid-retry is a boat trying, not a boat absent, and
        // the ledger holds standing through it. Neither state earns credit;
        // only elapsed CONNECTED time does.
        // OFF THE CONNECT PATH, deliberately. This is the gateway's status
        // setter and it runs inside the connect/retry sequence; crowd-feed
        // bookkeeping is telemetry and has no business adding synchronous work
        // there. Doing it inline was enough to perturb that sequence's timing —
        // NmeaNetworkAwareness went from stable to failing a DIFFERENT test on
        // roughly two runs in three, and passed cleanly the moment this call
        // was taken out of the path (measured 2026-08-24).
        //
        // A microtask keeps the ordering (it runs before any I/O continuation)
        // while leaving the setter itself synchronous and cheap. The link state
        // is read at check-in time anyway, minutes later, so nothing here is
        // latency-sensitive. Still wrapped: telemetry must never be able to
        // break the link it reports on.
        const linkState = s === 'connected' ? 'connected' : s === 'connecting' ? 'reconnecting' : 'down';
        const linkError = s === 'error' ? (this.lastError ?? undefined) : undefined;
        queueMicrotask(() => {
            try {
                reportFleetShareLink(linkState, linkError);
            } catch {
                /* never let share bookkeeping affect the connection */
            }
        });
    }

    // ── NMEA Parsing ──

    private parseNmeaSentence(sentence: string) {
        // Validate once at the ingress boundary. A present checksum must be
        // exactly two terminal hex digits and verify; malformed `*...` is not
        // silently downgraded to a checksum-less sentence. See the pure helper
        // for the deliberately narrow checksum-absent compatibility policy.
        const validated = validateNmeaSentence(sentence);
        if (!validated) {
            _nmeaSentenceRejects++;
            if (_nmeaSentenceRejects % 50 === 1) {
                log.warn(`dropped ${_nmeaSentenceRejects} malformed/checksum-invalid NMEA sentence(s)`);
            }
            return;
        }

        // ── AIS sentences: valid-checksum !AIVDM or !AIVDO only ──
        if (validated.kind === 'ais') {
            const result = processAisSentence(sentence);
            if (result) AisStore.update(result);
            // Never forward a malformed raw sentence to an external service.
            AisHubService.forward(sentence);
            // Fleet share (opt-in): O(1) offer into the crowd-feed buffer —
            // both received !AIVDM and own-ship !AIVDO, exactly what the
            // consent copy declares. Costs one boolean when disabled.
            offerToFleetShare(sentence);
            return;
        }

        const raw = validated.raw;
        const parts = raw.split(',');
        const type = validated.type;

        // Record per-sentence arrival for the diagnostic rate tracker.
        // This is independent of the 5-second NmeaSample aggregation
        // pipeline below — it lets the System Status panel show actual
        // per-sentence cadence (1 Hz steady vs bursty, etc.) rather than
        // the smoothed/averaged view.
        if (type) NmeaRateTracker.record(type);

        switch (type) {
            case 'MWV':
                this.parseMWV(parts);
                break; // Wind (apparent + true)
            case 'MWD':
                this.parseMWD(parts);
                break; // True wind direction
            case 'VHW':
                this.parseVHW(parts);
                break; // Water speed
            case 'HDT':
                this.parseHDT(parts);
                break; // True heading
            case 'HDG':
                this.parseHDG(parts);
                break; // Magnetic heading
            case 'HDM':
                this.parseHDG(parts);
                break; // Magnetic heading (alt)
            case 'RSA':
                this.parseRSA(parts);
                break;
            case 'RPM':
                this.parseRPM(parts);
                break; // Engine RPM
            case 'XDR':
                this.parseXDR(parts);
                break; // Transducers (voltage)
            case 'DBT':
                this.parseDBT(parts);
                break; // Depth below transducer
            case 'DPT':
                this.parseDPT(parts);
                break; // Depth
            case 'RMC':
                this.parseRMC(parts);
                break; // GPS fix (SOG/COG + position)
            case 'GGA':
                this.parseGGA(parts);
                break; // GPS fix quality + HDOP + satellites
            case 'MTW':
                this.parseMTW(parts);
                break; // Water temperature
        }
    }

    /** $xxMWV — Wind Speed and Angle */
    /** Wind speed in whatever unit the sentence declared → knots. */
    private windSpeedToKnots(speed: number, unit: string): number {
        if (unit === 'K') return speed / 1.852; // km/h
        if (unit === 'M') return speed * 1.94384; // m/s
        return speed; // 'N' — already knots
    }

    private parseMWV(parts: string[]) {
        // $xxMWV,angle,R/T,speed,unit,status
        //
        // This used to open `if (parts[2] !== 'T') return;` — apparent wind was
        // read off the wire and thrown straight in the bin, which is why the
        // panel's APPARENT WINDS tile was permanently blank on a boat whose
        // gateway broadcasts $YDMWV,...,R every second (2026-08-08).
        if (parts[5] !== 'A') return; // A = valid
        const reference = parts[2];
        if (reference !== 'T' && reference !== 'R') return;
        const angle = parseNmeaNumber(parts[1]);
        const speed = parseNmeaNumber(parts[3]);
        if (angle === null || speed === null) return;
        const knots = this.windSpeedToKnots(speed, parts[4]);

        // Signed angle off the bow, negative to port. The 0–360 form the wire
        // uses cannot be averaged arithmetically and cannot be drawn without
        // knowing which side the wind is on.
        const signed = angle > 180 ? angle - 360 : angle;

        if (reference === 'R') {
            this.accumulator.awa.push(signed);
            this.accumulator.aws.push(knots);
            return;
        }

        // TRUE. `twa` stays a 0–180 magnitude because SmartPolarStore buckets
        // on it and polars are symmetric — changing it would silently
        // re-bucket every learned polar. The signed form is carried
        // separately for anything that has to draw the wind.
        this.accumulator.twa.push(angle > 180 ? 360 - angle : angle);
        this.accumulator.twaSigned.push(signed);
        this.accumulator.tws.push(knots);
    }

    /**
     * $xxMWD — true wind DIRECTION and speed.
     *
     * `$YDMWD,128.1,T,117.1,M,5.7,N,2.9,M` — 128.1°T / 117.1°M, 5.7 kts. This
     * is the only sentence that gives the wind as a compass bearing rather
     * than an angle off the bow, which is what a wind rose needs. Prefer the
     * true field; fall back to magnetic when a device omits true.
     */
    private parseMWD(parts: string[]) {
        const trueDir = parts[2] === 'T' ? parseNmeaNumber(parts[1]) : null;
        const magDir = parts[4] === 'M' ? parseNmeaNumber(parts[3]) : null;
        const direction = trueDir ?? magDir;
        if (direction !== null && Number.isFinite(direction) && isPlausibleBearing(direction)) {
            this.accumulator.twd.push(direction % 360);
        }
        // MWD also carries wind speed in knots (field 5) and m/s (field 7).
        // Only used when MWV,T is absent — a boat that sends both should not
        // have its true-wind speed averaged from two sources at two cadences.
        if (this.accumulator.tws.length === 0) {
            const knots = parts[6] === 'N' ? parseNmeaNumber(parts[5]) : null;
            const ms = parts[8] === 'M' ? parseNmeaNumber(parts[7]) : null;
            if (knots !== null) this.accumulator.tws.push(knots);
            else if (ms !== null) this.accumulator.tws.push(ms * 1.94384);
        }
    }

    /** $xxVHW — Water Speed and Heading */
    private parseVHW(parts: string[]) {
        // $xxVHW,headTrue,T,headMag,M,stwKts,N,stwKmh,K
        const stw = parseNmeaNumber(parts[5]); // Knots
        if (stw !== null) this.accumulator.stw.push(stw);

        const heading = parseNmeaNumber(parts[1]);
        if (heading !== null && isPlausibleBearing(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxHDT — True Heading */
    private parseHDT(parts: string[]) {
        const heading = parseNmeaNumber(parts[1]);
        if (heading !== null && isPlausibleBearing(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxHDG — Magnetic Heading */
    private parseHDG(parts: string[]) {
        const heading = parseNmeaNumber(parts[1]);
        if (heading !== null && isPlausibleBearing(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxRSA — Rudder Sensor Angle. parts: stbd-or-single angle, status,
     *  port angle, status. Status 'A' = valid. Positive = helm to starboard
     *  (the same unverified-under-sail caveat as heel applies — the serene
     *  handover's dead bands absorb a degree of zero error by design). */
    private parseRSA(parts: string[]) {
        const status = (parts[2] ?? '').trim().toUpperCase();
        if (status !== 'A') return;
        const angle = parseNmeaNumber(parts[1]);
        if (angle !== null && Math.abs(angle) <= 90) this.accumulator.rudder.push(angle);
    }

    /** $xxRPM — Engine RPM */
    private parseRPM(parts: string[]) {
        // $xxRPM,source,engineNo,rpm,pitch,status
        const rpm = parseNmeaNumber(parts[3]);
        if (rpm !== null) {
            this.accumulator.rpm.push(rpm);
            this.hasRpmData = true;
        }
    }

    /**
     * $xxXDR — Transducer data. Battery voltage AND vessel attitude.
     *
     * XDR is a bag of arbitrary transducers, so every branch must check the
     * TYPE and UNIT as well as the name — 'A' angular in 'D' degrees for
     * attitude, 'V' volts for the battery. A name match alone would happily
     * read a temperature into the heel gauge.
     *
     * Confirmed on Calypso's own backbone 2026-08-09:
     *   $YDXDR,A,-4.50,D,Yaw,A,0.75,D,Pitch,A,1.00,D,Roll
     * at 1 Hz. This is the real sensor behind the heel tile — the previous
     * one was wired to a literal 0 and was removed on 2026-08-08 for exactly
     * that reason.
     *
     * SIGN: positive Roll is taken as heel to STARBOARD, the usual convention
     * for this field. If it ever reads the wrong way round on the water, flip
     * HEEL_STARBOARD_POSITIVE below rather than negating at the call sites —
     * there is more than one of them.
     */
    private parseXDR(parts: string[]) {
        // $xxXDR,type,value,unit,name,...
        //
        // First pass: is this sentence a whole-attitude fault? A real sensor
        // never reports yaw, pitch and roll as the SAME number — a boat is not
        // simultaneously heeled, trimmed and pointed to one identical angle.
        // Three identical attitude values mean the whole PGN came through as
        // "not available", whatever the number happens to be. Stronger than
        // matching one magic value, because a genuine knockdown at 63.75° of
        // roll alone must still be believed.
        const attitude: number[] = [];
        for (let i = 1; i + 3 < parts.length; i += 4) {
            if (parts[i] === 'A' && parts[i + 2] === 'D') {
                const v = parseNmeaNumber(parts[i + 1]);
                if (v !== null) attitude.push(v);
            }
        }
        const wholeAttitudeFault = attitude.length >= 3 && attitude.every((v) => v === attitude[0]);
        if (wholeAttitudeFault) {
            xdrFaultSentences++;
            if (xdrFaultSentences === 1 || xdrFaultSentences % 60 === 0) {
                log.warn(
                    `XDR attitude fault marker (${attitude[0]}° on every axis) — sensor is on the bus but not ` +
                        `reporting; ignoring (${xdrFaultSentences} so far)`,
                );
            }
            return;
        }
        // Second pass: the PARTIAL fault. A device with no attitude hardware
        // (a GPS puck with a compass, say) fills the axes it cannot measure
        // with the 0xFF sentinel and sends the rest for real — caught verbatim
        // on 2026-08-19 as `Yaw=63.75 Pitch=63.75 Roll=1.0`. Two or more axes
        // at exactly the sentinel mark THOSE axes as no-data while the valid
        // ones are kept. A single 63.75 beside sane companions still passes:
        // that is a boat on her ear, not a marker.
        const sentinelAxes = attitude.filter((v) => v === XDR_ATTITUDE_UNAVAILABLE_DEG).length;
        const dropSentinelAxes = sentinelAxes >= 2;

        for (let i = 1; i + 3 < parts.length; i += 4) {
            const type = parts[i];
            const value = parseNmeaNumber(parts[i + 1]);
            const unit = parts[i + 2];
            const name = parts[i + 3]?.toLowerCase().split('*')[0] || '';
            if (value === null) continue;

            if (type === 'V' && (name.includes('batt') || name.includes('volt') || name.includes('alt'))) {
                this.accumulator.voltage.push(value);
                continue;
            }
            if (type === 'A' && unit === 'D') {
                // Guard the range: an attitude sensor that reports 375° is
                // reporting something other than heel, and a compass bearing
                // averaged in here would read as a knockdown.
                if (Math.abs(value) > 90) continue;
                // Whole-attitude fault (all axes identical) is caught above;
                // partial fault (two-plus axes at the sentinel) drops only the
                // sentinel axes. A LONE 63.75 beside sane companions is still
                // believed — a knockdown must not fall through the guard.
                if (dropSentinelAxes && value === XDR_ATTITUDE_UNAVAILABLE_DEG) continue;
                if (name === 'roll') {
                    this.accumulator.heel.push(HEEL_STARBOARD_POSITIVE ? value : -value);
                } else if (name === 'pitch') {
                    this.accumulator.pitch.push(value);
                }
            }
        }
    }

    /** $xxDBT — Depth Below Transducer */
    private parseDBT(parts: string[]) {
        const reading = parseNmeaDepth(parts.join(','), 'DBT');
        if (reading) this.accumulator.depthDbt = reading;
    }

    /** $xxDPT — transducer depth plus an optional signed reference offset */
    private parseDPT(parts: string[]) {
        const reading = parseNmeaDepth(parts.join(','), 'DPT');
        if (reading) this.accumulator.depthDpt = reading;
    }

    /** $xxRMC — Recommended Minimum (GPS SOG/COG + position) */
    private parseRMC(parts: string[]) {
        // $xxRMC,time,status,lat,N/S,lon,E/W,sog,cog,...
        if (parts[2] !== 'A') return; // A = valid fix
        const sog = parseNmeaNumber(parts[7]);
        const cog = parseNmeaNumber(parts[8]);
        if (sog !== null) this.accumulator.sog.push(sog);
        if (cog !== null && isPlausibleBearing(cog)) this.accumulator.cog.push(cog);

        // Extract lat/lon (DDMM.MMMM format → decimal degrees)
        const lat = nmeaLatLon(parts[3], parts[4], 90);
        const lon = nmeaLatLon(parts[5], parts[6], 180);
        if (lat !== null && lon !== null) {
            this.accumulator.latitude = lat;
            this.accumulator.longitude = lon;
        }
    }

    /** $xxGGA — GPS Fix Quality, HDOP, satellite count */
    private parseGGA(parts: string[]) {
        // $xxGGA,time,lat,N/S,lon,E/W,quality,numSats,hdop,alt,M,...
        const quality = parseNmeaInteger(parts[6]);
        if (quality === null || quality === 0) return; // 0 = invalid

        this.accumulator.gpsFixQuality = quality;

        const numSats = parseNmeaInteger(parts[7]);
        if (numSats !== null) this.accumulator.satellites = numSats;

        const hdop = parseNmeaNumber(parts[8]);
        if (hdop !== null) this.accumulator.hdop = hdop;

        // Also extract position (may be more accurate than RMC on some receivers)
        const lat = nmeaLatLon(parts[2], parts[3], 90);
        const lon = nmeaLatLon(parts[4], parts[5], 180);
        if (lat !== null && lon !== null) {
            this.accumulator.latitude = lat;
            this.accumulator.longitude = lon;
        }
    }

    /** $xxMTW — Water Temperature */
    private parseMTW(parts: string[]) {
        // $xxMTW,temp,C
        const temp = parseNmeaNumber(parts[1]);
        if (temp !== null) this.accumulator.waterTemp.push(temp);
    }

    // ── Sample Emission ──

    private startSampleTimer() {
        this.sampleTimer = setInterval(() => this.emitSample(), NMEA_SAMPLE_INTERVAL_MS);
    }

    private stopSampleTimer() {
        if (this.sampleTimer) {
            clearInterval(this.sampleTimer);
            this.sampleTimer = null;
        }
    }

    private emitSample() {
        if (this.status !== 'connected') return;

        // DPT is explicit about its signed datum offset, so prefer its most
        // recent value when a sounder broadcasts both DBT and DPT. Averaging
        // the two can blend below-transducer, waterline and keel references
        // into a number that has no truthful meaning.
        const depthReading = this.accumulator.depthDpt ?? this.accumulator.depthDbt;

        const sample: NmeaSample = {
            timestamp: Date.now(),
            tws: avg(this.accumulator.tws),
            twa: avg(this.accumulator.twa),
            twaSigned: avgSigned(this.accumulator.twaSigned),
            // Signed arithmetic mean, not circular: heel is a ±90 displacement,
            // not a compass bearing, and circularMean would smear ±180.
            heel: avgSigned(this.accumulator.heel),
            pitch: avgSigned(this.accumulator.pitch),
            twd: circularMean(this.accumulator.twd),
            aws: avg(this.accumulator.aws),
            awa: avgSigned(this.accumulator.awa),
            stw: avg(this.accumulator.stw),
            heading: circularMean(this.accumulator.heading),
            rpm: avg(this.accumulator.rpm),
            // Signed mean like heel — a ±displacement, not a bearing. Swing
            // (max-min in the 5s window) survives separately because helm
            // ACTIVITY is exactly what averaging destroys, and the serene
            // helm advice needs both.
            rudder: avgSigned(this.accumulator.rudder),
            rudderSwing:
                this.accumulator.rudder.length >= 2
                    ? Math.max(...this.accumulator.rudder) - Math.min(...this.accumulator.rudder)
                    : this.accumulator.rudder.length === 1
                      ? 0
                      : null,
            voltage: avg(this.accumulator.voltage),
            depth: depthReading?.depthM ?? null,
            depthSource: depthReading?.source ?? null,
            depthReference: depthReading?.reference ?? null,
            depthOffsetM: depthReading?.offsetM ?? null,
            sog: avg(this.accumulator.sog),
            cog: circularMean(this.accumulator.cog),
            waterTemp: avg(this.accumulator.waterTemp),
            // GPS — use last values (not averaged)
            latitude: this.accumulator.latitude,
            longitude: this.accumulator.longitude,
            hdop: this.accumulator.hdop,
            satellites: this.accumulator.satellites,
            gpsFixQuality: this.accumulator.gpsFixQuality,
        };

        // Reset accumulator
        this.accumulator = this.freshAccumulator();

        // Emit when ANY supported instrument has data. Requiring TWS + TWA +
        // STW together silently discarded depth-only sounders and standalone
        // GPS/engine feeds despite a healthy connection.
        const hasInstruments = [
            sample.tws,
            sample.twa,
            // The new wind fields must be listed here too. A gateway that sends
            // apparent wind but no true wind produces a sample whose every
            // previously-gated field is null — so without these it would be
            // dropped on the floor and never reach the store, which is the same
            // blank tile the parser fix was meant to end.
            sample.twaSigned ?? null,
            sample.heel ?? null,
            sample.pitch ?? null,
            sample.twd ?? null,
            sample.aws ?? null,
            sample.awa ?? null,
            sample.stw,
            sample.heading,
            sample.rpm,
            sample.voltage,
            sample.depth,
            sample.sog,
            sample.cog,
            sample.waterTemp,
        ].some((value) => value !== null);
        const hasGps = sample.latitude !== null && sample.longitude !== null;
        if (hasInstruments || hasGps) {
            for (const cb of this.listeners) cb(sample);
        }
    }

    private freshAccumulator(): RawAccumulator {
        return {
            tws: [],
            twa: [],
            twaSigned: [],
            heel: [],
            pitch: [],
            twd: [],
            aws: [],
            awa: [],
            stw: [],
            heading: [],
            rpm: [],
            rudder: [],
            voltage: [],
            depthDbt: null,
            depthDpt: null,
            sog: [],
            cog: [],
            waterTemp: [],
            latitude: null,
            longitude: null,
            hdop: null,
            satellites: null,
            gpsFixQuality: null,
        };
    }
}

function avg(arr: number[]): number | null {
    if (arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Mean of signed angles in (-180, 180]. Goes through the circular mean for the
 * same reason bearings do — the arithmetic mean of -179 and 179 is 0, i.e. dead
 * ahead, when the wind is in fact dead astern.
 */
function avgSigned(arr: number[]): number | null {
    const mean = circularMean(arr);
    if (mean === null) return null;
    return mean > 180 ? mean - 360 : mean;
}

/** Convert NMEA DDMM.MMMM + N/S/E/W to decimal degrees. Returns null for a
 *  corrupted/out-of-range field (maxAbs = 90 for latitude, 180 for longitude). */
function nmeaLatLon(value: string, hemisphere: string, maxAbs: number): number | null {
    if (!value || !hemisphere) return null;
    const validHemispheres = maxAbs === 90 ? ['N', 'S'] : ['E', 'W'];
    if (!validHemispheres.includes(hemisphere)) return null;
    const v = parseNmeaNumber(value);
    if (v === null) return null;
    // NMEA format: DDMM.MMMM (lat) or DDDMM.MMMM (lon)
    const deg = Math.floor(v / 100);
    const min = v - deg * 100;
    // Minutes must be 0–60; anything else is a misaligned/corrupted field
    // (e.g. a truncated read splicing two sentences together).
    if (min < 0 || min >= 60) return null;
    let result = deg + min / 60;
    if (hemisphere === 'S' || hemisphere === 'W') result = -result;
    // Range sanity — rejects garbage that still parsed as a finite number.
    if (!Number.isFinite(result) || Math.abs(result) > maxAbs) return null;
    return result;
}

function parseNmeaInteger(value: string | undefined): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export const NmeaListenerService = new NmeaListenerServiceClass();
