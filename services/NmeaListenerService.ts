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

// ── Raw accumulator between emissions ──
interface RawAccumulator {
    tws: number[];
    twa: number[];
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
    autoStart() {
        const savedHost = localStorage.getItem('nmea_host');
        const savedPort = localStorage.getItem('nmea_port');
        if (!savedHost && !savedPort) return; // No NMEA config saved — skip
        this.configure(savedHost || DEFAULT_HOST, parseInt(savedPort || String(DEFAULT_PORT), 10));
        this.start();
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

        // If we exited the loop and we're still enabled, reconnect
        if (this.enabled) {
            this.tcpClientId = null;
            this.setStatus('disconnected');
            this.scheduleReconnect();
        }
    }

    private async disconnectTcp() {
        this.tcpReadLoop = false;
        if (this.tcpClientId !== null) {
            try {
                const { TcpSocket } = await import('capacitor-tcp-socket');
                await TcpSocket.disconnect({ client: this.tcpClientId });
                log.info(`TCP disconnected (client ${this.tcpClientId})`);
            } catch (e) {
                log.warn('TCP disconnect error:', e);
            }
            this.tcpClientId = null;
        }
        this.tcpLineBuffer = '';
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
            this.stop();
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
                break; // Wind
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
    private parseMWV(parts: string[]) {
        // $xxMWV,angle,R/T,speed,unit,status
        if (parts[2] !== 'T') return; // Only true wind (not relative)
        if (parts[5] !== 'A') return; // A = valid
        const angle = parseNmeaNumber(parts[1]);
        const speed = parseNmeaNumber(parts[3]);
        const unit = parts[4]; // K=km/h, N=knots, M=m/s
        if (angle === null || speed === null) return;

        // Normalize to 0-180 (sailing polars use absolute angle)
        const twa = angle > 180 ? 360 - angle : angle;

        // Convert to knots
        let tws = speed;
        if (unit === 'K') tws = speed / 1.852;
        else if (unit === 'M') tws = speed * 1.94384;

        this.accumulator.twa.push(twa);
        this.accumulator.tws.push(tws);
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

    /** $xxXDR — Transducer data (battery voltage) */
    private parseXDR(parts: string[]) {
        // $xxXDR,type,value,unit,name,...
        for (let i = 1; i + 3 < parts.length; i += 4) {
            const type = parts[i];
            const value = parseNmeaNumber(parts[i + 1]);
            const name = parts[i + 3]?.toLowerCase() || '';
            if (
                type === 'V' &&
                value !== null &&
                (name.includes('batt') || name.includes('volt') || name.includes('alt'))
            ) {
                this.accumulator.voltage.push(value);
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
            stw: avg(this.accumulator.stw),
            heading: avg(this.accumulator.heading),
            rpm: avg(this.accumulator.rpm),
            voltage: avg(this.accumulator.voltage),
            depth: depthReading?.depthM ?? null,
            depthSource: depthReading?.source ?? null,
            depthReference: depthReading?.reference ?? null,
            depthOffsetM: depthReading?.offsetM ?? null,
            sog: avg(this.accumulator.sog),
            cog: avg(this.accumulator.cog),
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
