/**
 * AisHubService — Forwards raw AIS NMEA sentences to AISHub via TCP.
 *
 * Makes Thalassa a contributing mobile AIS station.
 * Opt-in via checkbox on the NMEA page.
 *
 * Uses the same capacitor-tcp-socket already installed for NMEA listening —
 * no additional dependencies required.
 *
 * Features:
 *   - TCP connection to AISHub endpoint (native) or log-only (web)
 *   - 3-second deduplication window (same sentence on channels A+B)
 *   - Rate limiting: max 100 sentences/second
 *   - Auto-reconnect with backoff on connection drop
 *   - Statistics: sentence count, bytes sent, last forwarded time
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AISHub');

// ── Configuration ──
const DEDUP_WINDOW_MS = 3000;
const MAX_SENTENCES_PER_SECOND = 100;
const RATE_WINDOW_MS = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60_000;

// ── localStorage keys ──
const KEY_ENABLED = 'aishub_enabled';
const KEY_IP = 'aishub_ip';
const KEY_PORT = 'aishub_port';

export interface AisHubStats {
    sentenceCount: number;
    bytesSent: number;
    lastForwardedAt: number;
    isActive: boolean; // Currently sending (enabled + connected)
    networkOk: boolean;
}

export type AisHubListener = (stats: AisHubStats) => void;

class AisHubServiceClass {
    private enabled = false;
    private ip = '';
    private port = 0;
    private tcpClientId: number | null = null;
    private connecting = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;

    // ── Deduplication ──
    private recentSentences = new Map<string, number>(); // sentence → timestamp
    private dedupTimer: ReturnType<typeof setInterval> | null = null;

    // ── Rate limiting ──
    private rateCounter = 0;
    private rateWindowStart = 0;

    // ── Outbound buffer (queue sentences while connecting) ──
    private outboundQueue: string[] = [];
    private readonly MAX_QUEUE = 50;

    // ── Stats ──
    private stats: AisHubStats = {
        sentenceCount: 0,
        bytesSent: 0,
        lastForwardedAt: 0,
        isActive: false,
        networkOk: true,
    };

    private listeners = new Set<AisHubListener>();

    // ── Public API ──

    /** Load saved config and start if previously enabled */
    init(): void {
        this.enabled = localStorage.getItem(KEY_ENABLED) === 'true';
        this.ip = localStorage.getItem(KEY_IP) || '';
        this.port = parseInt(localStorage.getItem(KEY_PORT) || '0', 10);

        if (this.enabled && this.ip && this.port > 0) {
            this.openConnection();
        }
    }

    /** Enable/disable AISHub forwarding */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        localStorage.setItem(KEY_ENABLED, String(enabled));

        if (enabled && this.ip && this.port > 0) {
            this.openConnection();
        } else {
            this.closeConnection();
        }

        this.updateActiveState();
        this.notify();
    }

    /** Update station IP and port */
    configure(ip: string, port: number): void {
        this.ip = ip;
        this.port = port;
        localStorage.setItem(KEY_IP, ip);
        localStorage.setItem(KEY_PORT, String(port));

        // Reconnect if enabled
        if (this.enabled && ip && port > 0) {
            this.closeConnection();
            this.openConnection();
        }
    }

    /** Get current config */
    getConfig(): { enabled: boolean; ip: string; port: number } {
        return { enabled: this.enabled, ip: this.ip, port: this.port };
    }

    /** Get current stats */
    getStats(): AisHubStats {
        return { ...this.stats };
    }

    /** Subscribe to stats updates. Returns unsubscribe function. */
    subscribe(cb: AisHubListener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /**
     * Forward a raw AIS sentence to AISHub.
     * Called from NmeaListenerService for every !AIVDM/!AIVDO sentence.
     */
    forward(sentence: string): void {
        if (!this.enabled || !this.ip || this.port <= 0) return;

        // ── Deduplication: skip if same sentence seen within window ──
        const now = Date.now();
        // Strip checksum for dedup key (same msg on channels A/B has different checksums)
        const dedupKey = sentence.split('*')[0];
        const lastSeen = this.recentSentences.get(dedupKey);
        if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) return;
        this.recentSentences.set(dedupKey, now);

        // ── Rate limiting ──
        if (now - this.rateWindowStart > RATE_WINDOW_MS) {
            this.rateCounter = 0;
            this.rateWindowStart = now;
        }
        if (this.rateCounter >= MAX_SENTENCES_PER_SECOND) return;
        this.rateCounter++;

        // ── Send ──
        this.sendLine(sentence);
    }

    /** Clean up on app shutdown */
    destroy(): void {
        this.closeConnection();
        this.listeners.clear();
    }

    // ── Internals ──

    private async openConnection(): Promise<void> {
        if (this.tcpClientId !== null || this.connecting) return;

        this.startDedupCleanup();

        if (!Capacitor.isNativePlatform()) {
            // Web fallback — log only, no TCP socket capability
            log.info(`AISHub uplink enabled (web mode — log only) → ${this.ip}:${this.port}`);
            this.updateActiveState();
            return;
        }

        this.connecting = true;
        try {
            const { TcpSocket } = await import('capacitor-tcp-socket');
            const result = await TcpSocket.connect({
                ipAddress: this.ip,
                port: this.port,
            });
            this.tcpClientId = result.client;
            this.connecting = false;
            this.reconnectAttempts = 0;
            log.info(`AISHub TCP connected (client ${this.tcpClientId}) → ${this.ip}:${this.port}`);

            // Flush any queued sentences
            this.flushQueue();
            this.updateActiveState();
            this.notify();
        } catch (e) {
            this.connecting = false;
            log.warn('AISHub TCP connect failed:', e);
            this.scheduleReconnect();
        }
    }

    private async closeConnection(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.dedupTimer) {
            clearInterval(this.dedupTimer);
            this.dedupTimer = null;
        }
        this.recentSentences.clear();
        this.outboundQueue = [];
        this.reconnectAttempts = 0;

        if (this.tcpClientId !== null) {
            try {
                const { TcpSocket } = await import('capacitor-tcp-socket');
                await TcpSocket.disconnect({ client: this.tcpClientId });
            } catch (e) {
                log.warn('AISHub TCP disconnect error:', e);
            }
            this.tcpClientId = null;
        }

        this.updateActiveState();
    }

    private async sendLine(sentence: string): Promise<void> {
        const payload = sentence + '\r\n'; // NMEA line termination
        const bytes = payload.length;

        if (!Capacitor.isNativePlatform()) {
            // Web: just count it
            this.stats.sentenceCount++;
            this.stats.bytesSent += bytes;
            this.stats.lastForwardedAt = Date.now();
            this.notify();
            return;
        }

        if (this.tcpClientId === null) {
            // Queue while reconnecting
            if (this.outboundQueue.length < this.MAX_QUEUE) {
                this.outboundQueue.push(payload);
            }
            return;
        }

        try {
            const { TcpSocket } = await import('capacitor-tcp-socket');
            await TcpSocket.send({ client: this.tcpClientId, data: payload });

            this.stats.sentenceCount++;
            this.stats.bytesSent += bytes;
            this.stats.lastForwardedAt = Date.now();

            // Throttle notifications to avoid excessive re-renders
            if (this.stats.sentenceCount % 10 === 0) {
                this.notify();
            }
        } catch (e) {
            log.warn('AISHub TCP write failed:', e);
            this.tcpClientId = null;
            this.updateActiveState();
            this.scheduleReconnect();
        }
    }

    private async flushQueue(): Promise<void> {
        const queued = [...this.outboundQueue];
        this.outboundQueue = [];
        for (const line of queued) {
            await this.sendLine(line.replace(/\r\n$/, '')); // sendLine re-adds \r\n
        }
    }

    private scheduleReconnect(): void {
        if (!this.enabled || this.reconnectTimer) return;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
        this.reconnectAttempts++;
        log.info(`AISHub reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openConnection();
        }, delay);
    }

    private startDedupCleanup(): void {
        if (this.dedupTimer) return;
        this.dedupTimer = setInterval(() => {
            const cutoff = Date.now() - DEDUP_WINDOW_MS;
            for (const [key, ts] of this.recentSentences) {
                if (ts < cutoff) this.recentSentences.delete(key);
            }
        }, DEDUP_CLEANUP_INTERVAL_MS);
    }

    private updateActiveState(): void {
        this.stats.isActive = this.enabled && (this.tcpClientId !== null || !Capacitor.isNativePlatform());
    }

    private notify(): void {
        for (const cb of this.listeners) cb({ ...this.stats });
    }
}

export const AisHubService = new AisHubServiceClass();
