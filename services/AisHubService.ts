/**
 * Public-beta boundary for the optional AISHub contribution uplink.
 *
 * The historical UDP bridge declares a Capacitor 3 peer
 * while Thalassa ships Capacitor 8. Receiving and displaying AIS over the
 * supported NMEA/TCP path remains available; only the outbound UDP
 * contribution is disabled until a compatible, device-tested bridge exists.
 */
import { createLogger } from '../utils/createLogger';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const log = createLogger('AISHub');
const KEY_ENABLED = 'aishub_enabled';
const KEY_IP = 'aishub_ip';
const KEY_PORT = 'aishub_port';

export interface AisHubStats {
    sentenceCount: number;
    bytesSent: number;
    lastForwardedAt: number;
    isActive: boolean;
    networkOk: boolean;
}

export type AisHubListener = (stats: AisHubStats) => void;

class AisHubServiceClass {
    private ip = '';
    private port = 0;
    private readonly listeners = new Set<AisHubListener>();
    private readonly stats: AisHubStats = {
        sentenceCount: 0,
        bytesSent: 0,
        lastForwardedAt: 0,
        isActive: false,
        networkOk: false,
    };

    init(): void {
        this.ip = localStorage.getItem(KEY_IP) || '';
        this.port = Number.parseInt(localStorage.getItem(KEY_PORT) || '0', 10) || 0;
        // Retire a remembered opt-in from builds which bundled the incompatible
        // bridge. It must never spring back to life without a fresh choice in a
        // future compatible release.
        localStorage.setItem(KEY_ENABLED, 'false');
        this.notify();
    }

    setEnabled(enabled: boolean): void {
        localStorage.setItem(KEY_ENABLED, 'false');
        if (enabled) log.warn('AISHub contribution is unavailable in this public-beta build.');
        this.notify();
    }

    configure(ip: string, port: number): void {
        this.ip = ip;
        this.port = Number.isFinite(port) && port > 0 ? Math.trunc(port) : 0;
        localStorage.setItem(KEY_IP, this.ip);
        localStorage.setItem(KEY_PORT, String(this.port));
    }

    getConfig(): { enabled: boolean; ip: string; port: number } {
        return { enabled: false, ip: this.ip, port: this.port };
    }

    getStats(): AisHubStats {
        return { ...this.stats };
    }

    subscribe(listener: AisHubListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    forward(_sentence: string): void {
        // Intentionally inert. Keep the call surface stable for NMEA ingestion
        // without importing or invoking an incompatible native plugin.
    }

    destroy(): void {
        this.listeners.clear();
    }

    private notify(): void {
        // This invariant is a release guard as well as documentation. A future
        // implementation must deliberately flip the source-controlled flag.
        if (FEATURE_VISIBILITY.aisHub) {
            log.warn('AISHub visibility was enabled without a compatible uplink implementation.');
        }
        for (const listener of this.listeners) listener({ ...this.stats });
    }
}

export const AisHubService = new AisHubServiceClass();
