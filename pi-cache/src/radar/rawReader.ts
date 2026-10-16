/** Read-only operator-configured Signal K NMEA output. Never opens a hardware gateway slot. */
import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { RadarFeed, type RadarObservationEvidence } from './radarFeed.js';
import type { RadarOwnship } from './radarTarget.js';

export const RADAR_RESPONSE_BYTES = 512 * 1024;
export interface RadarRawSnapshot {
    schema: 1;
    source: 'radar';
    configured: boolean;
    connected: boolean;
    overloaded: boolean;
    feedId: string | null;
    servedAt: number;
    lastFrameAt: number | null;
    lastTargetAt: number | null;
    ownship: RadarOwnship | null;
    observations: RadarObservationEvidence[];
}
interface Options {
    /** Explicit local Signal K passthrough port; absent means unavailable, not inferred. */
    port?: number;
    host?: '127.0.0.1' | '::1';
    now?: () => number;
    reconnectMs?: number;
}
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_BYTES_PER_SECOND = 1024 * 1024;
const relevant = /^\$[A-Z0-9]{2}(?:TTM|TLL|RMC|GGA|GLL|VTG|HDT|THS),/;

export class RadarRawReader {
    private readonly now: () => number;
    private readonly host: '127.0.0.1' | '::1';
    private readonly port: number | null;
    private readonly reconnectMs: number;
    private socket: Socket | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;
    private context: string | null = null;
    private feed: RadarFeed | null = null;
    private connected = false;
    private overloaded = false;
    private lastFrameAt: number | null = null;
    private lastTargetAt: number | null = null;
    constructor(options: Options = {}) {
        if (options.host !== undefined && options.host !== '127.0.0.1' && options.host !== '::1')
            throw new Error('Radar passthrough must be the local Signal K output');
        if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535))
            throw new Error('Invalid local radar passthrough port');
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? null;
        this.now = options.now ?? Date.now;
        this.reconnectMs = Math.max(1000, Math.min(options.reconnectMs ?? 5000, 60_000));
    }
    /** Root supplies a verified vessel/pairing context; a context change retires the prior input. */
    start(context: string): void {
        if (!/^[A-Za-z0-9:_-]{1,120}$/.test(context)) throw new Error('Invalid radar input context');
        if (this.context === context) return;
        this.stop();
        this.context = context;
        if (this.port !== null) this.connect(this.generation);
    }
    stop(): void {
        this.generation++;
        this.context = null;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
        this.retire();
    }
    private retire(): void {
        this.connected = false;
        this.feed?.reset();
        this.feed = null;
        this.lastFrameAt = this.lastTargetAt = null;
    }
    private connect(generation: number): void {
        if (!this.context || this.port === null || generation !== this.generation) return;
        let buffer = '',
            discarding = false,
            epoch = this.now(),
            bytes = 0;
        const socket = createConnection({ host: this.host, port: this.port });
        this.socket = socket;
        const current = () => generation === this.generation && this.socket === socket && this.context !== null;
        socket.setTimeout(15_000);
        socket.on('connect', () => {
            if (!current()) {
                socket.destroy();
                return;
            }
            this.feed = new RadarFeed(`pi:${randomBytes(16).toString('hex')}`);
            this.overloaded = false;
            this.connected = true;
        });
        socket.on('data', (chunk: Buffer) => {
            if (!current() || !this.feed || !this.connected) return;
            const at = this.now();
            if (at - epoch >= 1000 || at < epoch) {
                epoch = at;
                bytes = 0;
            }
            bytes += chunk.byteLength;
            if (chunk.byteLength > MAX_CHUNK_BYTES || bytes > MAX_BYTES_PER_SECOND) {
                this.overloaded = true;
                this.retire();
                socket.destroy();
                return;
            }
            // A hostile/partial line never grows retained memory beyond 256 bytes.
            for (const byte of chunk) {
                if (byte === 10) {
                    if (!discarding) {
                        const sentence = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
                        if (relevant.test(sentence)) {
                            const accepted = this.feed.ingest(sentence, at, at);
                            if (accepted) this.lastFrameAt = at;
                            if (accepted === 'target') this.lastTargetAt = at;
                        }
                    }
                    buffer = '';
                    discarding = false;
                } else if (!discarding) {
                    if (buffer.length >= 257 || byte < 13 || byte > 126 || (byte > 13 && byte < 32)) {
                        buffer = '';
                        discarding = true;
                    } else buffer += String.fromCharCode(byte);
                }
            }
        });
        socket.on('timeout', () => socket.destroy());
        socket.on('error', () => {
            /* No raw frames, endpoints, or vessel data in logs. */
        });
        socket.on('close', () => {
            if (!current()) return;
            this.socket = null;
            this.retire();
            this.retry = setTimeout(() => {
                this.retry = null;
                if (generation === this.generation) this.connect(generation);
            }, this.reconnectMs);
            this.retry.unref();
        });
    }
    /** Cache-only. HTTP requests never initiate or renew the upstream input. */
    snapshot(): RadarRawSnapshot {
        const servedAt = this.now(),
            feed = this.feed;
        return {
            schema: 1,
            source: 'radar',
            configured: this.port !== null,
            connected: this.connected,
            overloaded: this.overloaded,
            feedId: feed?.feedId ?? null,
            servedAt,
            lastFrameAt: this.lastFrameAt,
            lastTargetAt: this.lastTargetAt,
            ownship: feed?.ownshipSnapshot() ?? null,
            observations: feed?.evidence(servedAt) ?? [],
        };
    }
}
