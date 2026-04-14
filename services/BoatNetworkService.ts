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

import { Capacitor, CapacitorHttp } from '@capacitor/core';
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
        // AvNav's PHP handler — this is the endpoint that works on OpenPlotter.
        // The /api/list endpoint is from newer AvNav; most installs use the PHP one.
        path: '/viewer/avnav_navi.php?request=list&type=chart',
        validate: (data: unknown, status: number) => {
            if (status < 200 || status >= 400) return false;
            const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
            if (text.includes('<!DOCTYPE') || text.includes('Cannot GET')) return false;
            // Must contain chart items or at least valid JSON structure
            return text.includes('items') || text.includes('charts') || text.startsWith('{') || text.startsWith('[');
        },
    },
    {
        name: 'avnav-alt',
        port: 8082,
        path: '/viewer/avnav_navi.php?request=list&type=chart',
        validate: (data: unknown, status: number) => {
            if (status < 200 || status >= 400) return false;
            const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
            if (text.includes('<!DOCTYPE') || text.includes('Cannot GET')) return false;
            return text.includes('items') || text.includes('charts') || text.startsWith('{') || text.startsWith('[');
        },
    },
    {
        name: 'avnav-8081',
        port: 8081,
        path: '/viewer/avnav_navi.php?request=list&type=chart',
        validate: (data: unknown, status: number) => {
            if (status < 200 || status >= 400) return false;
            const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
            if (text.includes('<!DOCTYPE') || text.includes('Cannot GET')) return false;
            return text.includes('items') || text.includes('charts') || text.startsWith('{') || text.startsWith('[');
        },
    },
    {
        name: 'avnav-8083',
        port: 8083,
        path: '/viewer/avnav_navi.php?request=list&type=chart',
        validate: (data: unknown, status: number) => {
            if (status < 200 || status >= 400) return false;
            const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
            if (text.includes('<!DOCTYPE') || text.includes('Cannot GET')) return false;
            return text.includes('items') || text.includes('charts') || text.startsWith('{') || text.startsWith('[');
        },
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
const SERVICES_STORAGE_KEY = 'thalassa_boat_network_services';
const PROBE_TIMEOUT_MS = 3000;

// ── Persistence ────────────────────────────────────────────────

function saveToStorage(host: string | null, services?: DiscoveredService[]) {
    try {
        if (host) {
            localStorage.setItem(STORAGE_KEY, host);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
        if (services && services.length > 0) {
            localStorage.setItem(SERVICES_STORAGE_KEY, JSON.stringify(services));
        } else if (!host) {
            localStorage.removeItem(SERVICES_STORAGE_KEY);
        }
    } catch {
        /* ignore */
    }
}

function loadFromStorage(): { host: string | null; services: DiscoveredService[] } {
    try {
        const host = localStorage.getItem(STORAGE_KEY);
        if (!host) return { host: null, services: [] };
        const raw = localStorage.getItem(SERVICES_STORAGE_KEY);
        const services: DiscoveredService[] = raw ? JSON.parse(raw) : [];
        return { host, services };
    } catch {
        return { host: null, services: [] };
    }
}

// ── Probe Helper ───────────────────────────────────────────────

/** Hard timeout wrapper — ensures no probe hangs longer than the limit */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

const isNative = Capacitor.isNativePlatform();

async function probeService(host: string, service: ServiceProbe): Promise<{ found: boolean; latencyMs: number }> {
    // TCP-only services (no HTTP path) — try a quick HTTP probe on the port
    const path = service.path || '/';
    const url = `http://${host}:${service.port}${path}`;
    const start = Date.now();
    const fail = { found: false, latencyMs: 0 };

    // Hard outer timeout — nothing escapes this
    return withTimeout(
        (async () => {
            // On native, CapacitorHttp bypasses CORS and enforces timeouts.
            // On web, CapacitorHttp wraps fetch but doesn't enforce timeouts,
            // so we use fetch + AbortSignal directly.
            if (isNative) {
                try {
                    const res = await CapacitorHttp.get({
                        url,
                        connectTimeout: PROBE_TIMEOUT_MS,
                        readTimeout: PROBE_TIMEOUT_MS,
                    });
                    const ok = service.validate(res.data, res.status);
                    return { found: ok, latencyMs: Date.now() - start };
                } catch {
                    return { found: false, latencyMs: Date.now() - start };
                }
            } else {
                // Web: use fetch with AbortSignal for reliable timeout
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
        })(),
        PROBE_TIMEOUT_MS + 500, // hard ceiling: probe timeout + 500ms grace
        fail,
    );
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
    private state: BoatNetworkState = (() => {
        const { host, services } = loadFromStorage();
        return {
            piHost: host,
            services,
            scanning: false,
            lastScan: 0,
            error: null,
        };
    })();
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
            const { host: saved } = loadFromStorage();
            if (saved && !candidates.includes(saved)) candidates.push(saved);
            for (const h of MDNS_HOSTS) {
                if (!candidates.includes(h)) candidates.push(h);
            }

            // Probe ALL candidates in parallel — first host with services wins.
            // Uses a race: each probeHost resolves; the first with results
            // resolves the outer promise. A hard ceiling prevents infinite hangs.
            const found = await withTimeout(
                new Promise<{ host: string; services: DiscoveredService[] } | null>((resolve) => {
                    let settled = 0;
                    const total = candidates.length;

                    candidates.forEach((host) => {
                        probeHost(host).then((services) => {
                            // First host with any service wins — resolve immediately
                            if (services.length > 0) {
                                resolve({ host, services });
                            }
                            settled++;
                            if (settled >= total) {
                                resolve(null); // all done, nothing found
                            }
                        });
                    });
                }),
                PROBE_TIMEOUT_MS + 2000, // hard ceiling: probe timeout + 2s grace
                null,
            );

            if (found) {
                log.info(`Found Pi at ${found.host}: ${found.services.map((s) => `${s.name}(:${s.port})`).join(', ')}`);
                saveToStorage(found.host, found.services);
                this.setState({
                    piHost: found.host,
                    services: found.services,
                    scanning: false,
                    lastScan: Date.now(),
                });
                return found.host;
            }

            // Not found
            log.info('No Pi found on network');
            saveToStorage(null);
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
        const saved = this.state.piHost || loadFromStorage().host;
        if (!saved) return this.scan();

        log.info(`Quick probe: ${saved}`);
        this.setState({ scanning: true, error: null });
        const services = await probeHost(saved);
        if (services.length > 0) {
            saveToStorage(saved, services);
            this.setState({
                piHost: saved,
                services,
                scanning: false,
                lastScan: Date.now(),
                error: null,
            });
            return saved;
        }

        // Saved host unreachable — try full scan
        log.info('Saved host unreachable, falling back to full scan');
        this.setState({ scanning: false });
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
        // Always save as 'avnav' type — the multi-port scanner in
        // AvNavService.connect() will find the actual AvNav port.
        // This ensures autoStart() on next boot uses the AvNav code path
        // which discovers charts from all common ports.
        if (options.avnav !== false) {
            const avnavService = services.find((s) => s.name.startsWith('avnav'));
            const chartPort = avnavService?.port || 8080;
            localStorage.setItem('avnav_chart_host', host);
            localStorage.setItem('avnav_chart_port', String(chartPort));
            localStorage.setItem('avnav_server_type', 'avnav');
            log.info(`Charts configured: ${host}:${chartPort} (avnav, port-scan on connect)`);
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

import { useState, useEffect, useRef } from 'react';

export function useBoatNetwork(): BoatNetworkState {
    const [s, setS] = useState(BoatNetworkService.getState());
    const probed = useRef(false);

    useEffect(() => BoatNetworkService.subscribe(setS), []);

    // Auto-probe saved host on mount when services are stale or empty.
    // This handles: app restart (singleton re-created from localStorage cache),
    // and page navigation back to Boat Network after being away.
    useEffect(() => {
        if (probed.current) return;
        const state = BoatNetworkService.getState();
        if (!state.piHost || state.scanning) return;

        const staleMs = 60_000; // consider services stale after 60s
        const isStale = state.lastScan === 0 || Date.now() - state.lastScan > staleMs;

        if (state.services.length === 0 || isStale) {
            probed.current = true;
            log.info(
                `Auto-probing saved Pi host on mount (${state.services.length === 0 ? 'no cached services' : 'stale'})`,
            );
            BoatNetworkService.quickProbe();
        }
    }, []);

    return s;
}
