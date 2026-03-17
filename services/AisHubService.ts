/**
 * AisHubService — Forwards raw AIS NMEA sentences to AISHub via UDP.
 *
 * Makes Thalassa a contributing mobile AIS station.
 * Opt-in via checkbox on the NMEA page.
 *
 * Uses @frontall/capacitor-udp for native UDP datagrams.
 * Install: npm install @frontall/capacitor-udp --legacy-peer-deps && npx cap sync
 *
 * Features:
 *   - UDP datagram forwarding (native) or log-only (web)
 *   - 3-second deduplication window (same sentence on channels A+B)
 *   - Rate limiting: max 100 sentences/second
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

// ── localStorage keys ──
const KEY_ENABLED = 'aishub_enabled';
const KEY_IP = 'aishub_ip';
const KEY_PORT = 'aishub_port';

export interface AisHubStats {
    sentenceCount: number;
    bytesSent: number;
    lastForwardedAt: number;
    isActive: boolean; // Currently sending (enabled + socket open)
    networkOk: boolean;
}

export type AisHubListener = (stats: AisHubStats) => void;

class AisHubServiceClass {
    private enabled = false;
    private ip = '';
    private port = 0;
    private socketId: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private udpPlugin: any = null;

    // ── Deduplication ──
    private recentSentences = new Map<string, number>(); // sentence → timestamp
    private dedupTimer: ReturnType<typeof setInterval> | null = null;

    // ── Rate limiting ──
    private rateCounter = 0;
    private rateWindowStart = 0;

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
            this.openSocket();
        }
    }

    /** Enable/disable AISHub forwarding */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        localStorage.setItem(KEY_ENABLED, String(enabled));

        if (enabled && this.ip && this.port > 0) {
            this.openSocket();
        } else {
            this.closeSocket();
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
            this.closeSocket();
            this.openSocket();
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
        this.sendDatagram(sentence);
    }

    /** Clean up on app shutdown */
    destroy(): void {
        this.closeSocket();
        this.listeners.clear();
    }

    // ── Internals ──

    private async openSocket(): Promise<void> {
        if (this.socketId !== null) return;

        this.startDedupCleanup();

        if (!Capacitor.isNativePlatform()) {
            // Web fallback — log only, no UDP capability in browser
            log.info(`AISHub uplink enabled (web mode — log only) → ${this.ip}:${this.port}`);
            this.updateActiveState();
            return;
        }

        try {
            // Dynamic import — only loaded on native where the plugin exists
            const mod = await import('@frontall/capacitor-udp');
            this.udpPlugin = mod.UdpSocket || mod.default || mod;

            const result = await this.udpPlugin.create();
            this.socketId = result.socketId;
            // Bind to any available local port
            await this.udpPlugin.bind({ socketId: this.socketId, port: 0 });

            log.info(`AISHub UDP socket created (id=${this.socketId}) → ${this.ip}:${this.port}`);
            this.updateActiveState();
            this.notify();
        } catch (e) {
            log.error('Failed to create AISHub UDP socket:', e);
            this.socketId = null;
        }
    }

    private async closeSocket(): Promise<void> {
        if (this.dedupTimer) {
            clearInterval(this.dedupTimer);
            this.dedupTimer = null;
        }
        this.recentSentences.clear();

        if (this.socketId !== null && this.udpPlugin) {
            try {
                await this.udpPlugin.close({ socketId: this.socketId });
            } catch (e) {
                log.warn('AISHub UDP close error:', e);
            }
            this.socketId = null;
        }

        this.updateActiveState();
    }

    private async sendDatagram(sentence: string): Promise<void> {
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

        if (this.socketId === null || !this.udpPlugin) return;

        try {
            await this.udpPlugin.send({
                socketId: this.socketId,
                address: this.ip,
                port: this.port,
                buffer: payload,
            });

            this.stats.sentenceCount++;
            this.stats.bytesSent += bytes;
            this.stats.lastForwardedAt = Date.now();

            // Throttle notifications to avoid excessive re-renders
            if (this.stats.sentenceCount % 10 === 0) {
                this.notify();
            }
        } catch (e) {
            log.warn('AISHub UDP send failed:', e);
        }
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
        this.stats.isActive = this.enabled && (this.socketId !== null || !Capacitor.isNativePlatform());
    }

    private notify(): void {
        for (const cb of this.listeners) cb({ ...this.stats });
    }
}

export const AisHubService = new AisHubServiceClass();
