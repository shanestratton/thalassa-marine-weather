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

// ── Configuration ──
const DEFAULT_HOST = '192.168.1.151';
const DEFAULT_PORT = 1456; // YDWG-02 standard TCP port
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000; // Give up after 5 minutes of failed reconnects
const TCP_READ_TIMEOUT_S = 5; // Read timeout for TCP polling (seconds)
const TCP_READ_BUFFER = 4096; // Bytes to request per read cycle

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

class NmeaListenerServiceClass {
    // ── Transport state ──
    private ws: WebSocket | null = null; // WebSocket (browser dev)
    private tcpClientId: number | null = null; // Native TCP client ID
    private tcpReadLoop = false; // Whether TCP read loop is active

    private status: NmeaConnectionStatus = 'disconnected';
    private host = DEFAULT_HOST;
    private port = DEFAULT_PORT;
    private reconnectAttempts = 0;
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

    constructor() {
        // Un-park on app foreground. The webview fires visibilitychange on
        // Capacitor background/foreground transitions, and coming back to the
        // app is exactly when the boat Wi-Fi is likely reachable again.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden || !this.parkedAfterGiveUp || this.enabled) return;
                log.warn('Retrying parked NMEA connection on app foreground');
                // Retry at the BOTTOM of the ladder. The backoff doubles to a
                // 30 s cap, and reopening the app is the strongest signal we
                // get that the network just changed — walking aboard, joining
                // the boat Wi-Fi. Resuming mid-ladder made that first attempt
                // wait up to half a minute, which reads as "still broken".
                this.reconnectAttempts = 0;
                this.start();
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
        this.setStatus('connecting');

        if (Capacitor.isNativePlatform()) {
            this.connectTcp();
        } else {
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
            this.lastError = msg;
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
        if (this.tcpClientId === null) return;

        try {
            const { TcpSocket } = await import('capacitor-tcp-socket');

            while (this.tcpReadLoop && this.tcpClientId !== null && this.enabled) {
                try {
                    const { result } = await TcpSocket.read({
                        client: this.tcpClientId,
                        expectLen: TCP_READ_BUFFER,
                        timeout: TCP_READ_TIMEOUT_S,
                    });

                    if (result && result.length > 0) {
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
                    }
                } catch (readErr: unknown) {
                    // Read timeout is normal (no data available) — just continue
                    const errObj = readErr as Record<string, unknown> | null;
                    if (errObj?.message?.toString().includes?.('timeout') || errObj?.code === 'TIMEOUT') {
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
        await this.releaseTcpClient();
        if (this.enabled) {
            this.setStatus('disconnected');
            this.scheduleReconnect();
        }
    }

    /**
     * Hand this client's slot back to the gateway. Safe to call when there is
     * nothing open, and never throws — a gateway that has already reset the
     * socket will reject the close, which is fine: the point is that we always
     * ASK, so a healthy gateway reclaims the slot at once rather than waiting
     * out its own idle timeout.
     */
    private async releaseTcpClient(): Promise<void> {
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

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private setStatus(s: NmeaConnectionStatus) {
        this.status = s;
        for (const cb of this.statusListeners) cb(s);
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
        if (direction !== null && Number.isFinite(direction)) {
            this.accumulator.twd.push(((direction % 360) + 360) % 360);
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
        if (heading !== null) this.accumulator.heading.push(heading);
    }

    /** $xxHDT — True Heading */
    private parseHDT(parts: string[]) {
        const heading = parseNmeaNumber(parts[1]);
        if (heading !== null) this.accumulator.heading.push(heading);
    }

    /** $xxHDG — Magnetic Heading */
    private parseHDG(parts: string[]) {
        const heading = parseNmeaNumber(parts[1]);
        if (heading !== null) this.accumulator.heading.push(heading);
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
        if (cog !== null) this.accumulator.cog.push(cog);

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
