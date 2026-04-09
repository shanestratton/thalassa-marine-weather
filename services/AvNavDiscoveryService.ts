/**
 * AvNavDiscoveryService — auto-discovery for AvNav / Signal K servers.
 *
 * On native (iOS/Android), uses capacitor-zeroconf to browse for
 * `_http._tcp.` services via Bonjour/mDNS.
 *
 * Always (native + web) delegates network probing to AvNavService.scanNetwork(),
 * which performs WebRTC local-IP detection followed by a full /24 subnet scan
 * on ports 8080/8082/3000 using CapacitorHttp (CORS-free on native).
 */
import { createLogger } from '../utils/createLogger';
import { Capacitor } from '@capacitor/core';

const log = createLogger('AvNav-Discovery');

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredServer {
    /** Display name from mDNS or constructed from host */
    name: string;
    /** IP address or hostname */
    host: string;
    /** AvNav API port */
    port: number;
    /** Discovery method */
    source: 'mdns' | 'probe';
}

export type DiscoveryStatus = 'idle' | 'scanning' | 'done';

type StatusListener = (status: DiscoveryStatus) => void;
type ServersListener = (servers: DiscoveredServer[]) => void;

// ── Service ──────────────────────────────────────────────────────────────────

class AvNavDiscoveryServiceClass {
    private status: DiscoveryStatus = 'idle';
    private servers: DiscoveredServer[] = [];
    private statusListeners = new Set<StatusListener>();
    private serversListeners = new Set<ServersListener>();
    private scanTimeout: ReturnType<typeof setTimeout> | null = null;

    // ── Public API ───────────────────────────────────────────────────────

    getStatus(): DiscoveryStatus {
        return this.status;
    }

    getServers(): DiscoveredServer[] {
        return [...this.servers];
    }

    onStatusChange(fn: StatusListener): () => void {
        this.statusListeners.add(fn);
        return () => this.statusListeners.delete(fn);
    }

    onServersChange(fn: ServersListener): () => void {
        this.serversListeners.add(fn);
        return () => this.serversListeners.delete(fn);
    }

    /** Start scanning. Auto-stops after ~60 seconds (full /24 scan). */
    async scan(): Promise<void> {
        if (this.status === 'scanning') return;

        this.servers = [];
        this.setStatus('scanning');
        this.notifyServers();

        // Auto-stop after 60s — full /24 scan with 762 probes in batches of 30 takes ~30-45s
        this.scanTimeout = setTimeout(() => this.stop(), 60_000);

        const isNative = Capacitor.isNativePlatform();

        if (isNative) {
            await this.scanNative();
        }

        // Always run network probes (delegates to AvNavService.scanNetwork — WebRTC + full /24)
        await this.scanWeb();

        // Mark complete when scan finishes naturally
        if (this.status === 'scanning') {
            this.setStatus('done');
            if (this.scanTimeout) {
                clearTimeout(this.scanTimeout);
                this.scanTimeout = null;
            }
        }
    }

    /** Stop scanning immediately. In-flight network probes will be ignored. */
    stop(): void {
        if (this.scanTimeout) {
            clearTimeout(this.scanTimeout);
            this.scanTimeout = null;
        }
        this.stopNative();
        if (this.status === 'scanning') {
            this.setStatus('done');
        }
    }

    // ── Native mDNS (capacitor-zeroconf) ─────────────────────────────────

    private async scanNative(): Promise<void> {
        try {
            // Opaque import — hides from Vite's static analysis so it doesn't
            // fail to resolve when the package isn't installed (web dev mode).
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const dynamicImport = new Function('specifier', 'return import(specifier)');
            const { Zeroconf } = await dynamicImport('capacitor-zeroconf');

            log.info('Starting mDNS browse for _http._tcp.');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Zeroconf.addListener('discover', (result: any) => {
                if (result?.service?.resolved) {
                    const svc = result.service;
                    const host = svc.ipv4Addresses?.[0] || svc.ipv6Addresses?.[0] || svc.hostname || '';
                    if (!host) return;

                    const server: DiscoveredServer = {
                        name: svc.name || `AvNav (${host})`,
                        host,
                        port: svc.port || 3000,
                        source: 'mdns',
                    };

                    // Deduplicate by host:port
                    if (!this.servers.some((s) => s.host === server.host && s.port === server.port)) {
                        log.info(`Found via mDNS: ${server.name} @ ${server.host}:${server.port}`);
                        this.servers = [...this.servers, server];
                        this.notifyServers();
                    }
                }
            });

            await Zeroconf.watch({
                type: '_http._tcp.',
                domain: 'local.',
            });
        } catch (err) {
            log.warn('mDNS browse not available:', err);
        }
    }

    private async stopNative(): Promise<void> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const dynamicImport = new Function('specifier', 'return import(specifier)');
            const { Zeroconf } = await dynamicImport('capacitor-zeroconf');
            await Zeroconf.close();
        } catch {
            // Plugin not available — fine
        }
    }

    // ── Network probing (delegates to AvNavService.scanNetwork) ──────────

    /**
     * Delegates to AvNavService.scanNetwork() which performs:
     *   1. mDNS-style hostname probes (avnav.local, raspberrypi.local, etc.)
     *   2. WebRTC local IP detection to find the device's subnet
     *   3. Full /24 subnet scan on ports [8080, 8082, 3000]
     *
     * Uses CapacitorHttp under the hood to bypass CORS restrictions.
     */
    private async scanWeb(): Promise<void> {
        // Dynamic import to avoid circular dependency at module load time
        const { AvNavService } = await import('./AvNavService');

        try {
            await AvNavService.scanNetwork(undefined, (server) => {
                // Bail if scanning was cancelled while a probe was in flight
                if (this.status !== 'scanning') return;

                const adapted: DiscoveredServer = {
                    name: server.label,
                    host: server.host,
                    port: server.port,
                    source: 'probe',
                };

                if (!this.servers.some((s) => s.host === adapted.host && s.port === adapted.port)) {
                    log.info(`Found ${server.serverType}: ${adapted.name}`);
                    this.servers = [...this.servers, adapted];
                    this.notifyServers();
                }
            });
        } catch (err) {
            log.warn('Network scan failed:', err);
        }
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private setStatus(status: DiscoveryStatus): void {
        this.status = status;
        this.statusListeners.forEach((fn) => fn(status));
    }

    private notifyServers(): void {
        const snapshot = [...this.servers];
        this.serversListeners.forEach((fn) => fn(snapshot));
    }
}

export const AvNavDiscoveryService = new AvNavDiscoveryServiceClass();
