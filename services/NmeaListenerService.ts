/**
 * NmeaListenerService — Background NMEA 0183 TCP/WebSocket listener.
 * Connects to vessel's Wi-Fi MFD, parses instrument sentences,
 * and emits averaged NmeaSample every 5 seconds.
 */
import type { NmeaSample } from '../types';

// ── Configuration ──
const DEFAULT_HOST = '192.168.1.1';
const DEFAULT_PORT = 10110;
const SAMPLE_INTERVAL_MS = 5000; // Emit averaged sample every 5s
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export type NmeaConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type NmeaSampleCallback = (sample: NmeaSample) => void;

// ── Raw accumulator between emissions ──
interface RawAccumulator {
    tws: number[];
    twa: number[];
    stw: number[];
    heading: number[];
    rpm: number[];
    voltage: number[];
    depth: number[];
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
    private ws: WebSocket | null = null;
    private status: NmeaConnectionStatus = 'disconnected';
    private host = DEFAULT_HOST;
    private port = DEFAULT_PORT;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private sampleTimer: ReturnType<typeof setInterval> | null = null;
    private accumulator: RawAccumulator = this.freshAccumulator();
    private listeners: Set<NmeaSampleCallback> = new Set();
    private statusListeners: Set<(s: NmeaConnectionStatus) => void> = new Set();
    private enabled = false;
    /** Track if RPM data has ever been received */
    private hasRpmData = false;

    // ── Public API ──

    configure(host: string, port: number) {
        this.host = host || DEFAULT_HOST;
        this.port = port || DEFAULT_PORT;
    }

    start() {
        if (this.enabled) return;
        this.enabled = true;
        this.connect();
        this.startSampleTimer();
    }

    stop() {
        this.enabled = false;
        this.stopSampleTimer();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.setStatus('disconnected');
    }

    getStatus(): NmeaConnectionStatus { return this.status; }
    getHasRpmData(): boolean { return this.hasRpmData; }

    onSample(cb: NmeaSampleCallback) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
    onStatusChange(cb: (s: NmeaConnectionStatus) => void) { this.statusListeners.add(cb); return () => this.statusListeners.delete(cb); }

    // ── Connection ──

    private connect() {
        if (!this.enabled) return;
        this.setStatus('connecting');

        try {
            // WebSocket URL — most NMEA multiplexers/SignalK servers expose WS
            const url = `ws://${this.host}:${this.port}`;
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
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
                this.setStatus('error');
            };

            this.ws.onclose = () => {
                this.ws = null;
                if (this.enabled) {
                    this.setStatus('disconnected');
                    this.scheduleReconnect();
                }
            };
        } catch (e) {
            console.warn('[NmeaListener]', e);
            this.setStatus('error');
            if (this.enabled) this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (!this.enabled || this.reconnectTimer) return;
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
        // Strip checksum
        const raw = sentence.split('*')[0];
        const parts = raw.split(',');
        const type = parts[0]?.slice(3); // Remove $XX prefix

        switch (type) {
            case 'MWV': this.parseMWV(parts); break;  // Wind
            case 'VHW': this.parseVHW(parts); break;  // Water speed
            case 'HDT': this.parseHDT(parts); break;  // True heading
            case 'HDG': this.parseHDG(parts); break;  // Magnetic heading
            case 'HDM': this.parseHDG(parts); break;  // Magnetic heading (alt)
            case 'RPM': this.parseRPM(parts); break;  // Engine RPM
            case 'XDR': this.parseXDR(parts); break;  // Transducers (voltage)
            case 'DBT': this.parseDBT(parts); break;  // Depth below transducer
            case 'DPT': this.parseDPT(parts); break;  // Depth
            case 'RMC': this.parseRMC(parts); break;  // GPS fix (SOG/COG + position)
            case 'GGA': this.parseGGA(parts); break;  // GPS fix quality + HDOP + satellites
            case 'MTW': this.parseMTW(parts); break;  // Water temperature
        }
    }

    /** $xxMWV — Wind Speed and Angle */
    private parseMWV(parts: string[]) {
        // $xxMWV,angle,R/T,speed,unit,status
        if (parts[2] !== 'T') return; // Only true wind (not relative)
        if (parts[5] !== 'A') return; // A = valid
        const angle = parseFloat(parts[1]);
        const speed = parseFloat(parts[3]);
        const unit = parts[4]; // K=km/h, N=knots, M=m/s
        if (isNaN(angle) || isNaN(speed)) return;

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
        const stw = parseFloat(parts[5]); // Knots
        if (!isNaN(stw)) this.accumulator.stw.push(stw);

        const heading = parseFloat(parts[1]);
        if (!isNaN(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxHDT — True Heading */
    private parseHDT(parts: string[]) {
        const heading = parseFloat(parts[1]);
        if (!isNaN(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxHDG — Magnetic Heading */
    private parseHDG(parts: string[]) {
        const heading = parseFloat(parts[1]);
        if (!isNaN(heading)) this.accumulator.heading.push(heading);
    }

    /** $xxRPM — Engine RPM */
    private parseRPM(parts: string[]) {
        // $xxRPM,source,engineNo,rpm,pitch,status
        const rpm = parseFloat(parts[3]);
        if (!isNaN(rpm)) {
            this.accumulator.rpm.push(rpm);
            this.hasRpmData = true;
        }
    }

    /** $xxXDR — Transducer data (battery voltage) */
    private parseXDR(parts: string[]) {
        // $xxXDR,type,value,unit,name,...
        for (let i = 1; i + 3 < parts.length; i += 4) {
            const type = parts[i];
            const value = parseFloat(parts[i + 1]);
            const name = parts[i + 3]?.toLowerCase() || '';
            if (type === 'V' && !isNaN(value) && (name.includes('batt') || name.includes('volt') || name.includes('alt'))) {
                this.accumulator.voltage.push(value);
            }
        }
    }

    /** $xxDBT — Depth Below Transducer */
    private parseDBT(parts: string[]) {
        // $xxDBT,depthFeet,f,depthMeters,M,depthFathoms,F
        const meters = parseFloat(parts[3]);
        if (!isNaN(meters)) this.accumulator.depth.push(meters);
    }

    /** $xxDPT — Depth */
    private parseDPT(parts: string[]) {
        // $xxDPT,depth,offset
        const depth = parseFloat(parts[1]);
        if (!isNaN(depth)) this.accumulator.depth.push(depth);
    }

    /** $xxRMC — Recommended Minimum (GPS SOG/COG + position) */
    private parseRMC(parts: string[]) {
        // $xxRMC,time,status,lat,N/S,lon,E/W,sog,cog,...
        if (parts[2] !== 'A') return; // A = valid fix
        const sog = parseFloat(parts[7]);
        const cog = parseFloat(parts[8]);
        if (!isNaN(sog)) this.accumulator.sog.push(sog);
        if (!isNaN(cog)) this.accumulator.cog.push(cog);

        // Extract lat/lon (DDMM.MMMM format → decimal degrees)
        const lat = nmeaLatLon(parts[3], parts[4]);
        const lon = nmeaLatLon(parts[5], parts[6]);
        if (lat !== null && lon !== null) {
            this.accumulator.latitude = lat;
            this.accumulator.longitude = lon;
        }
    }

    /** $xxGGA — GPS Fix Quality, HDOP, satellite count */
    private parseGGA(parts: string[]) {
        // $xxGGA,time,lat,N/S,lon,E/W,quality,numSats,hdop,alt,M,...
        const quality = parseInt(parts[6], 10);
        if (isNaN(quality) || quality === 0) return; // 0 = invalid

        this.accumulator.gpsFixQuality = quality;

        const numSats = parseInt(parts[7], 10);
        if (!isNaN(numSats)) this.accumulator.satellites = numSats;

        const hdop = parseFloat(parts[8]);
        if (!isNaN(hdop)) this.accumulator.hdop = hdop;

        // Also extract position (may be more accurate than RMC on some receivers)
        const lat = nmeaLatLon(parts[2], parts[3]);
        const lon = nmeaLatLon(parts[4], parts[5]);
        if (lat !== null && lon !== null) {
            this.accumulator.latitude = lat;
            this.accumulator.longitude = lon;
        }
    }

    /** $xxMTW — Water Temperature */
    private parseMTW(parts: string[]) {
        // $xxMTW,temp,C
        const temp = parseFloat(parts[1]);
        if (!isNaN(temp)) this.accumulator.waterTemp.push(temp);
    }

    // ── Sample Emission ──

    private startSampleTimer() {
        this.sampleTimer = setInterval(() => this.emitSample(), SAMPLE_INTERVAL_MS);
    }

    private stopSampleTimer() {
        if (this.sampleTimer) { clearInterval(this.sampleTimer); this.sampleTimer = null; }
    }

    private emitSample() {
        if (this.status !== 'connected') return;

        const sample: NmeaSample = {
            timestamp: Date.now(),
            tws: avg(this.accumulator.tws),
            twa: avg(this.accumulator.twa),
            stw: avg(this.accumulator.stw),
            heading: avg(this.accumulator.heading),
            rpm: avg(this.accumulator.rpm),
            voltage: avg(this.accumulator.voltage),
            depth: avg(this.accumulator.depth),
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

        // Emit if we have EITHER core instrument data OR GPS position data
        const hasInstruments = sample.tws !== null && sample.twa !== null && sample.stw !== null;
        const hasGps = sample.latitude !== null && sample.longitude !== null;
        if (hasInstruments || hasGps) {
            for (const cb of this.listeners) cb(sample);
        }
    }

    private freshAccumulator(): RawAccumulator {
        return {
            tws: [], twa: [], stw: [], heading: [], rpm: [], voltage: [],
            depth: [], sog: [], cog: [], waterTemp: [],
            latitude: null, longitude: null, hdop: null, satellites: null, gpsFixQuality: null,
        };
    }
}

function avg(arr: number[]): number | null {
    if (arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Convert NMEA DDMM.MMMM + N/S/E/W to decimal degrees */
function nmeaLatLon(value: string, hemisphere: string): number | null {
    if (!value || !hemisphere) return null;
    const v = parseFloat(value);
    if (isNaN(v)) return null;
    // NMEA format: DDMM.MMMM (lat) or DDDMM.MMMM (lon)
    const deg = Math.floor(v / 100);
    const min = v - deg * 100;
    let result = deg + min / 60;
    if (hemisphere === 'S' || hemisphere === 'W') result = -result;
    return result;
}

export const NmeaListenerService = new NmeaListenerServiceClass();
