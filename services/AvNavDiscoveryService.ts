/**
 * AvNavDiscoveryService — mDNS auto-discovery for AvNav servers.
 *
 * On native (iOS/Android), uses capacitor-zeroconf to browse for
 * `_http._tcp.` services via Bonjour/mDNS.
 *
 * On web, falls back to probing common local endpoints via fetch:
 *   - localhost:3000, localhost:3100 (dev mock server)
 *   - signalk.local:3000
 *   - Common gateway IPs on port 3000
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
    private abortController: AbortController | null = null;

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

    /** Start scanning. Auto-stops after ~10 seconds. */
    async scan(): Promise<void> {
        if (this.status === 'scanning') return;

        this.servers = [];
        this.setStatus('scanning');
        this.notifyServers();

        // Auto-stop after 10s
        this.scanTimeout = setTimeout(() => this.stop(), 10_000);

        const isNative = Capacitor.isNativePlatform();

        if (isNative) {
            await this.scanNative();
        }

        // Always run web probes (works everywhere, catches mock servers)
        await this.scanWeb();
    }

    /** Stop scanning immediately. */
    stop(): void {
        if (this.scanTimeout) {
            clearTimeout(this.scanTimeout);
            this.scanTimeout = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
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

    // ── Web fallback (HTTP probing) ──────────────────────────────────────

    private async scanWeb(): Promise<void> {
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        // Common endpoints to probe
        const candidates = [
            // Dev mock server
            { host: 'localhost', port: 3100 },
            // Vite proxy (if Signal K is behind it)
            { host: 'localhost', port: 3000 },
            // Common Signal K default
            { host: 'signalk.local', port: 3000 },
            // Common Pi/router IPs
            { host: '192.168.1.1', port: 3000 },
            { host: '192.168.0.1', port: 3000 },
            { host: '10.10.10.1', port: 3000 },
        ];

        const probes = candidates.map(({ host, port }) => this.probeEndpoint(host, port, signal));

        // Fire all probes concurrently, don't fail-fast
        await Promise.allSettled(probes);
    }

    private async probeEndpoint(host: string, port: number, signal: AbortSignal): Promise<void> {
        const url = `http://${host}:${port}/signalk`;
        try {
            const resp = await fetch(url, {
                signal,
                mode: 'cors',
                headers: { Accept: 'application/json' },
                // Short timeout via AbortSignal
            });

            // Also set a per-probe timeout
            const timeoutId = setTimeout(() => {
                // Can't abort a single probe from the shared controller,
                // so we just ignore late results
            }, 4000);

            if (resp.ok) {
                clearTimeout(timeoutId);
                const data = await resp.json().catch(() => null);

                // Validate it's actually a Signal K endpoint
                if (data?.endpoints || data?.server) {
                    const server: DiscoveredServer = {
                        name: data.server?.id ? `${data.server.id} (${host})` : `AvNav (${host}:${port})`,
                        host,
                        port,
                        source: 'probe',
                    };

                    if (!this.servers.some((s) => s.host === server.host && s.port === server.port)) {
                        log.info(`Found via probe: ${server.name}`);
                        this.servers = [...this.servers, server];
                        this.notifyServers();
                    }
                }
            }
        } catch {
            // Expected for most probes — host unreachable, CORS, timeout
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
