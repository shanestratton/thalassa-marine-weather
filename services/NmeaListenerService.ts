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
        } catch {
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
            case 'RMC': this.parseRMC(parts); break;  // GPS fix (SOG/COG)
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

    /** $xxRMC — Recommended Minimum (GPS SOG/COG) */
    private parseRMC(parts: string[]) {
        // $xxRMC,time,status,lat,N/S,lon,E/W,sog,cog,...
        if (parts[2] !== 'A') return; // A = valid fix
        const sog = parseFloat(parts[7]);
        const cog = parseFloat(parts[8]);
        if (!isNaN(sog)) this.accumulator.sog.push(sog);
        if (!isNaN(cog)) this.accumulator.cog.push(cog);
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
        };

        // Reset accumulator
        this.accumulator = this.freshAccumulator();

        // Only emit if we have core data
        if (sample.tws !== null && sample.twa !== null && sample.stw !== null) {
            for (const cb of this.listeners) cb(sample);
        }
    }

    private freshAccumulator(): RawAccumulator {
        return { tws: [], twa: [], stw: [], heading: [], rpm: [], voltage: [], depth: [], sog: [], cog: [], waterTemp: [] };
    }
}

function avg(arr: number[]): number | null {
    if (arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export const NmeaListenerService = new NmeaListenerServiceClass();
