/**
 * BoatNetworkService — Unified boat network discovery.
 *
 * One scan finds the Pi, then auto-configures EVERYTHING:
 *   - Pi Cache (weather/GRIB/tiles on :3001)
 *   - Signal K / NMEA 0183 TCP on :10110
 *   - AvNav / Signal K charts on :8080 / :3000
 *
 * The punter shouldn't have to type a single IP address.
 * OpenPlotter runs all these services on the same box —
 * find it once, configure it everywhere.
 *
 * Discovery order:
 *   1. Try saved host first (instant reconnect on app boot)
 *   2. mDNS hostnames (openplotter.local, raspberrypi.local, etc.)
 *   3. Common boat network subnets (/24 scan) as last resort
 */

import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';

const log = createLogger('BoatNetwork');

// ── Types ──────────────────────────────────────────────────────

export interface ServiceProbe {
    name: string;
    port: number;
    path: string;
    /** Validate the response to confirm it's the right service */
    validate: (data: unknown, status: number) => boolean;
}

export interface DiscoveredService {
    name: string;
    host: string;
    port: number;
    latencyMs: number;
}

export interface BoatNetworkState {
    /** The resolved Pi host (IP or hostname) — single source of truth */
    piHost: string | null;
    /** Services found on the Pi */
    services: DiscoveredService[];
    /** Whether a scan is in progress */
    scanning: boolean;
    /** Last scan timestamp */
    lastScan: number;
    /** Last scan error, if any */
    error: string | null;
}

type Listener = (state: BoatNetworkState) => void;

// ── Service Definitions ────────────────────────────────────────

const SERVICES: ServiceProbe[] = [
    {
        name: 'pi-cache',
        port: 3001,
        path: '/health',
        validate: (data: unknown) => {
            const d = data as Record<string, unknown> | null;
            return d?.status === 'ok' && d?.service === 'thalassa-pi-cache';
        },
    },
    {
        name: 'signalk',
        port: 3000,
        path: '/signalk',
        validate: (_data: unknown, status: number) => status >= 200 && status < 400,
    },
    {
        name: 'signalk-nmea',
        port: 10110,
        path: '', // TCP — no HTTP health check, validated by port reachability
        validate: (_data: unknown, status: number) => status >= 200 && status < 400,
    },
    {
        name: 'avnav',
        port: 8080,
        path: '/viewer/avnav_navi.php',
        validate: (_data: unknown, status: number) => status >= 200 && status < 400,
    },
    {
        name: 'avnav-alt',
        port: 8082,
        path: '/viewer/avnav_navi.php',
        validate: (_data: unknown, status: number) => status >= 200 && status < 400,
    },
];

// ── mDNS candidates (ordered by likelihood for OpenPlotter) ──

const MDNS_HOSTS = [
    'openplotter.local',
    'raspberrypi.local',
    'thalassa.local',
    'pi.local',
    'thalassa-cache.local',
    'signalk.local',
    'avnav.local',
];

const STORAGE_KEY = 'thalassa_boat_network';
const PROBE_TIMEOUT_MS = 3000;

// ── Persistence ────────────────────────────────────────────────

function saveToStorage(host: string | null) {
    try {
        if (host) {
            localStorage.setItem(STORAGE_KEY, host);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        /* ignore */
    }
}

function loadFromStorage(): string | null {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

// ── Probe Helper ───────────────────────────────────────────────

async function probeService(host: string, service: ServiceProbe): Promise<{ found: boolean; latencyMs: number }> {
    // TCP-only services (no HTTP path) — try a quick HTTP probe on the port
    const path = service.path || '/';
    const url = `http://${host}:${service.port}${path}`;
    const start = Date.now();

    try {
        const res = await CapacitorHttp.get({
            url,
            connectTimeout: PROBE_TIMEOUT_MS,
            readTimeout: PROBE_TIMEOUT_MS,
        });
        const ok = service.validate(res.data, res.status);
        return { found: ok, latencyMs: Date.now() - start };
    } catch {
        // CapacitorHttp failed — try fetch as fallback (for browser dev)
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
            let data: unknown = null;
            try {
                data = await res.json();
            } catch {
                /* non-JSON response is fine for some services */
            }
            const ok = service.validate(data, res.status);
            return { found: ok, latencyMs: Date.now() - start };
        } catch {
            return { found: false, latencyMs: Date.now() - start };
        }
    }
}

/** Quick check: can we reach this host on ANY known service port? */
async function probeHost(host: string): Promise<DiscoveredService[]> {
    const results = await Promise.allSettled(
        SERVICES.map(async (svc) => {
            const { found, latencyMs } = await probeService(host, svc);
            if (found) {
                return { name: svc.name, host, port: svc.port, latencyMs };
            }
            return null;
        }),
    );

    return results
        .map((r) => (r.status === 'fulfilled' ? r.value : null))
        .filter((r): r is DiscoveredService => r !== null);
}

// ── Singleton ──────────────────────────────────────────────────

class BoatNetworkServiceClass {
    private state: BoatNetworkState = {
        piHost: loadFromStorage(),
        services: [],
        scanning: false,
        lastScan: 0,
        error: null,
    };
    private listeners = new Set<Listener>();

    // ── Public API ──

    getState(): BoatNetworkState {
        return { ...this.state };
    }

    /** The resolved Pi host (IP or mDNS hostname). Null if not yet discovered. */
    getPiHost(): string | null {
        return this.state.piHost;
    }

    /** Whether a specific service was found on the Pi */
    hasService(name: string): boolean {
        return this.state.services.some((s) => s.name === name);
    }

    /** Get a discovered service by name */
    getService(name: string): DiscoveredService | null {
        return this.state.services.find((s) => s.name === name) ?? null;
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * Full network scan. Finds the Pi, probes all services, persists the result.
     * Returns the discovered host or null.
     */
    async scan(preferredHost?: string): Promise<string | null> {
        if (this.state.scanning) return this.state.piHost;

        this.setState({ scanning: true, error: null });
        log.info('Starting boat network scan...');

        try {
            // Build candidate list: preferred → saved → mDNS hostnames
            const candidates: string[] = [];
            if (preferredHost) candidates.push(preferredHost);
            const saved = loadFromStorage();
            if (saved && !candidates.includes(saved)) candidates.push(saved);
            for (const h of MDNS_HOSTS) {
                if (!candidates.includes(h)) candidates.push(h);
            }

            // Phase 1: Probe candidates in parallel batches of 4
            for (let i = 0; i < candidates.length; i += 4) {
                const batch = candidates.slice(i, i + 4);
                const results = await Promise.allSettled(batch.map((h) => probeHost(h)));

                for (let j = 0; j < results.length; j++) {
                    const r = results[j];
                    if (r.status === 'fulfilled' && r.value.length > 0) {
                        const host = batch[j];
                        log.info(`Found Pi at ${host}: ${r.value.map((s) => `${s.name}(:${s.port})`).join(', ')}`);
                        saveToStorage(host);
                        this.setState({
                            piHost: host,
                            services: r.value,
                            scanning: false,
                            lastScan: Date.now(),
                        });
                        return host;
                    }
                }
            }

            // Not found
            log.info('No Pi found on network');
            this.setState({
                piHost: null,
                services: [],
                scanning: false,
                lastScan: Date.now(),
                error: 'No Pi found. Make sure it is on and connected to the same WiFi.',
            });
            return null;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Scan failed:', msg);
            this.setState({ scanning: false, error: msg });
            return null;
        }
    }

    /**
     * Quick re-probe of the saved host only. Used on app boot for instant reconnect.
     * Falls back to full scan if the saved host is unreachable.
     */
    async quickProbe(): Promise<string | null> {
        const saved = this.state.piHost || loadFromStorage();
        if (!saved) return this.scan();

        log.info(`Quick probe: ${saved}`);
        const services = await probeHost(saved);
        if (services.length > 0) {
            this.setState({
                piHost: saved,
                services,
                lastScan: Date.now(),
                error: null,
            });
            return saved;
        }

        // Saved host unreachable — try full scan
        log.info('Saved host unreachable, falling back to full scan');
        return this.scan();
    }

    /**
     * Apply the discovered Pi host to all downstream services.
     * This is the "configure everything" step.
     *
     * @param options.nmea     - Configure NMEA listener
     * @param options.avnav    - Configure AvNav chart service
     * @param options.piCache  - Configure Pi Cache weather proxy
     * @param options.onSaveSettings - Callback to persist to UserSettings
     */
    applyToServices(options: {
        nmea?: boolean;
        avnav?: boolean;
        piCache?: boolean;
        onSaveSettings?: (partial: Record<string, unknown>) => void;
    }): void {
        const host = this.state.piHost;
        if (!host) return;

        const services = this.state.services;

        // ── NMEA / Signal K TCP ──
        if (options.nmea !== false) {
            const signalkNmea = services.find((s) => s.name === 'signalk-nmea');
            const signalk = services.find((s) => s.name === 'signalk');
            if (signalkNmea || signalk) {
                const nmeaPort = signalkNmea ? signalkNmea.port : 10110;
                localStorage.setItem('nmea_host', host);
                localStorage.setItem('nmea_port', String(nmeaPort));
                localStorage.setItem('nmea_device', 'signalk');
                log.info(`NMEA configured: ${host}:${nmeaPort}`);
            }
        }

        // ── AvNav / Signal K Charts ──
        if (options.avnav !== false) {
            const avnav = services.find((s) => s.name === 'avnav');
            const avnavAlt = services.find((s) => s.name === 'avnav-alt');
            const signalk = services.find((s) => s.name === 'signalk');
            const chartService = avnav || avnavAlt || signalk;
            if (chartService) {
                const serverType = chartService.name === 'signalk' ? 'signalk' : 'avnav';
                localStorage.setItem('avnav_chart_host', host);
                localStorage.setItem('avnav_chart_port', String(chartService.port));
                localStorage.setItem('avnav_server_type', serverType);
                log.info(`Charts configured: ${host}:${chartService.port} (${serverType})`);
            }
        }

        // ── Pi Cache ──
        if (options.piCache !== false) {
            const cache = services.find((s) => s.name === 'pi-cache');
            if (cache && options.onSaveSettings) {
                options.onSaveSettings({
                    piCacheEnabled: true,
                    piCacheHost: host,
                    piCachePort: cache.port,
                    piCachePrefetch: true,
                });
                log.info(`Pi Cache configured: ${host}:${cache.port}`);
            }
        }
    }

    /** Clear saved host and service state */
    clear(): void {
        saveToStorage(null);
        this.setState({
            piHost: null,
            services: [],
            error: null,
        });
    }

    // ── Internals ──

    private setState(partial: Partial<BoatNetworkState>) {
        this.state = { ...this.state, ...partial };
        this.listeners.forEach((fn) => fn(this.state));
    }
}

export const BoatNetworkService = new BoatNetworkServiceClass();

// ── React Hook ─────────────────────────────────────────────────

import { useState, useEffect } from 'react';

export function useBoatNetwork(): BoatNetworkState {
    const [s, setS] = useState(BoatNetworkService.getState());
    useEffect(() => BoatNetworkService.subscribe(setS), []);
    return s;
}
