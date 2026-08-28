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
import { PI_INTEGRATION_ENABLED, PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from './piPublicBetaBoundary';

const log = createLogger('BoatNetwork');

// ── Types ──────────────────────────────────────────────────────

export interface ServiceProbe {
    name: string;
    port: number;
    path: string;
    /** Validate the response to confirm it's the right service */
    validate: (data: unknown, status: number) => boolean;
    /**
     * Service speaks pinned TLS rather than plain HTTP.
     *
     * Only pi-cache does. Signal K and AvNav are genuinely cleartext on the
     * boat LAN and are reached under NSAllowsLocalNetworking. Probing pi-cache
     * over http after it moved to TLS is why the Boat Network card reported
     * "Pi found, but no weather cache service detected" while happily listing
     * the other two (Shane 2026-08-07).
     */
    pinnedTls?: boolean;
    /**
     * Path to probe when the app is NOT yet paired. The pinned transport opens
     * only /api/pair/info without a pin, so a paired-only path would make an
     * unpaired app conclude the service is absent — the state every skipper is
     * in before they pair.
     */
    unpairedPath?: string;
    /** Validator for the unpaired probe, whose shape differs from /health. */
    validateUnpaired?: (data: unknown, status: number) => boolean;
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
        pinnedTls: true,
        unpairedPath: '/api/pair/info',
        validate: (data: unknown) => {
            const d = data as Record<string, unknown> | null;
            return d?.status === 'ok' && d?.service === 'thalassa-pi-cache';
        },
        validateUnpaired: (data: unknown) => {
            const d = data as Record<string, unknown> | null;
            return d?.service === 'thalassa-pi-cache' && typeof d?.publicKeySpki === 'string';
        },
    },
    {
        // Bosun web service — the Pi-side tool host described in
        // docs/BOSUN_TOOL_API.md. Hosts /api/health + /tool/* endpoints
        // (vessel position, state, profile, manual search, log query).
        // The orchestrator targets this when on-boat to read live vessel
        // data straight from SignalK + Modbus and skip Anthropic tool
        // round-trips on Pi-local queries.
        name: 'bosun-web',
        port: 5000,
        path: '/api/health',
        validate: (data: unknown, status: number) => {
            if (status < 200 || status >= 400) return false;
            const d = data as Record<string, unknown> | null;
            return d?.ok === true && d?.service === 'bosun-web';
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
    'calypso.local', // Shane's renamed Pi (boat-named after the yacht)
    // Raw-IP fallback: iOS mDNS (.local) resolution inside CapacitorHttp is
    // flaky — the Mac resolves calypso.local instantly while the phone times
    // out (observed 2026-07-02, "pi wont connect"). Calypso's DHCP address on
    // the boat LAN; harmless dead candidate elsewhere. If the lease ever
    // moves, calypso.local above still wins first.
    '192.168.50.150',
    'openplotter.local',
    'raspberrypi.local',
    'thalassa.local',
    'bosun.local', // older Shane setup, kept for backwards compat
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

// Hostname → IPv4 resolution moved to utils/resolveHostnameIpv4 so
// every service that owns a host config (PiCacheService, AvNav DRM,
// this) shares the same helper. Local alias kept for diff churn.
import { resolveHostnameIpv4 } from '../utils/resolveHostnameIpv4';
const resolveToIpv4 = (host: string) => resolveHostnameIpv4(host);

async function probeService(host: string, service: ServiceProbe): Promise<{ found: boolean; latencyMs: number }> {
    const start = Date.now();
    const fail = { found: false, latencyMs: 0 };

    // ── Pinned-TLS services take a different lane entirely ──
    if (service.pinnedTls) {
        const { getPairing, pinnedPiRequest } = await import('./PiPairingService');
        const paired = getPairing() !== null;
        // Unpaired, the transport opens only the pairing card — so probe THAT
        // and treat a valid card as proof the service is up. Probing the
        // paired-only path here would report "no weather cache" to every
        // skipper who has not paired yet, which is all of them at first run.
        const probePath = paired ? service.path || '/' : (service.unpairedPath ?? service.path ?? '/');
        const validate = paired ? service.validate : (service.validateUnpaired ?? service.validate);
        return withTimeout(
            (async () => {
                try {
                    const res = await pinnedPiRequest({
                        url: `https://${host}:${service.port}${probePath}`,
                        connectTimeout: PROBE_TIMEOUT_MS,
                        readTimeout: PROBE_TIMEOUT_MS,
                        responseType: 'text',
                    });
                    let data: unknown = null;
                    try {
                        data = JSON.parse(res.data);
                    } catch {
                        /* non-JSON body fails validation below */
                    }
                    return { found: validate(data, res.status), latencyMs: Date.now() - start };
                } catch {
                    return { found: false, latencyMs: Date.now() - start };
                }
            })(),
            PROBE_TIMEOUT_MS + 500,
            fail,
        );
    }

    // TCP-only services (no HTTP path) — try a quick HTTP probe on the port
    const path = service.path || '/';
    const url = `http://${host}:${service.port}${path}`;

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
        if (!PI_INTEGRATION_ENABLED) {
            return {
                piHost: null,
                services: [],
                scanning: false,
                lastScan: 0,
                error: PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE,
            };
        }
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
        if (!PI_INTEGRATION_ENABLED) return null;
        if (this.state.scanning) return this.state.piHost;

        this.setState({ scanning: true, error: null });
        log.info('Starting boat network scan...');

        try {
            // Build candidate list: preferred → user-configured → saved → mDNS.
            const candidates: string[] = [];
            if (preferredHost) candidates.push(preferredHost);
            // The manually-entered Settings host (PiCacheTab "Hostname / IP")
            // was only tried when THAT tab drove the scan — an app-boot or
            // background scan ignored it entirely, so a typed IP "didn't
            // work" anywhere else (Shane 2026-07-03, boat network page).
            try {
                const { useSettingsStore } = await import('../stores/settingsStore');
                const manual = useSettingsStore.getState().settings?.piCacheHost as string | undefined;
                if (manual && manual.trim() && !candidates.includes(manual.trim())) candidates.push(manual.trim());
            } catch {
                /* settings store unavailable (tests) — skip */
            }
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
                        probeHost(host)
                            .then((services) => {
                                // First host with any service wins — resolve immediately
                                if (services.length > 0) {
                                    resolve({ host, services });
                                }
                            })
                            .catch(() => {
                                /* a rejecting probe must still count as settled —
                                   without this the race only ended at the hard
                                   ceiling, making every failed scan feel slow */
                            })
                            .finally(() => {
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
                // Resolve the hostname to a raw IPv4 address so subsequent
                // connections skip the per-socket Happy Eyeballs race.
                // Falls back to the original hostname on resolution
                // failure or non-native platforms — no loss of function,
                // we just don't get the noise reduction.
                const ipv4 = await resolveToIpv4(found.host);
                const effectiveHost = ipv4 ?? found.host;
                if (ipv4 && ipv4 !== found.host) {
                    log.info(`Resolved ${found.host} → ${ipv4} — using IP for connections`);
                }
                log.info(
                    `Found Pi at ${effectiveHost}: ${found.services.map((s) => `${s.name}(:${s.port})`).join(', ')}`,
                );
                saveToStorage(effectiveHost, found.services);
                this.setState({
                    piHost: effectiveHost,
                    services: found.services,
                    scanning: false,
                    lastScan: Date.now(),
                });
                return effectiveHost;
            }

            // Not found. Keep the REMEMBERED host on disk — a single failed
            // scan (wifi blip, Pi rebooting, wrong network for a minute) used
            // to wipe it, so the next scan lost its best candidate and the
            // connection "worked sometimes" (Shane 2026-07-03). State shows
            // disconnected; storage keeps the memory for the next attempt.
            log.info('No Pi found on network (remembered host retained for next scan)');
            this.setState({
                piHost: null,
                services: [],
                scanning: false,
                lastScan: Date.now(),
                error: 'No Pi found. Check the Pi is powered and on the same WiFi — or enter its IP under Manual settings.',
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
        if (!PI_INTEGRATION_ENABLED) return null;
        const saved = this.state.piHost || loadFromStorage().host;
        if (!saved) return this.scan();

        log.info(`Quick probe: ${saved}`);
        this.setState({ scanning: true, error: null });
        const services = await probeHost(saved);
        if (services.length > 0) {
            // If the saved host is still a hostname (e.g. carried over
            // from a pre-2026-05-08 install), resolve to IP now so we
            // get the same per-socket noise reduction the full scan
            // path enjoys. Already-IP hosts pass through unchanged.
            const ipv4 = await resolveToIpv4(saved);
            const effectiveHost = ipv4 ?? saved;
            if (ipv4 && ipv4 !== saved) {
                log.info(`Quick probe resolved ${saved} → ${ipv4}`);
            }
            saveToStorage(effectiveHost, services);
            this.setState({
                piHost: effectiveHost,
                services,
                scanning: false,
                lastScan: Date.now(),
                error: null,
            });
            return effectiveHost;
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
        if (!PI_INTEGRATION_ENABLED) return;
        const host = this.state.piHost;
        if (!host) return;

        const services = this.state.services;

        // ── NMEA / Signal K TCP ──
        if (options.nmea !== false) {
            const signalkNmea = services.find((s) => s.name === 'signalk-nmea');
            if (signalkNmea) {
                localStorage.setItem('nmea_host', host);
                localStorage.setItem('nmea_port', String(signalkNmea.port));
                localStorage.setItem('nmea_device', 'signalk');
                log.info(`NMEA configured: ${host}:${signalkNmea.port}`);
            } else {
                /*
                 * A Signal K WEB server on :3000 is not evidence of an NMEA
                 * stream, and this used to write port 10110 on that basis —
                 * a port its own `signalk-nmea` probe had just failed to
                 * confirm — while also repointing `nmea_host` at the Pi.
                 *
                 * On the house Pi that is AvNav listening on 10110 with no
                 * input sources: a socket that opens and then stays silent
                 * forever. So "Connect All", whose label promises charts and
                 * cache, quietly made a home-LAN address the boat's gateway.
                 * It looked connected at home, never delivered a sentence,
                 * and vanished the moment Shane left the house
                 * (diagnosed 2026-08-28).
                 *
                 * Guessing a port is worse than leaving the setting alone:
                 * the skipper already had a working gateway configured.
                 */
                log.info('No NMEA stream discovered on the Pi — leaving the gateway config alone');
            }
        }

        // ── AvNav / Signal K Charts ──
        // Always save as 'avnav' type — the multi-port scanner in
        // AvNavService.connect() will find the actual AvNav port.
        // This ensures autoStart() on next boot uses the AvNav code path
        // which discovers charts from all common ports.
        if (options.avnav !== false) {
            const avnavService = services.find((s) => s.name.startsWith('avnav'));
            if (avnavService) {
                localStorage.setItem('avnav_chart_host', host);
                localStorage.setItem('avnav_chart_port', String(avnavService.port));
                localStorage.setItem('avnav_server_type', 'avnav');
                log.info(`Charts configured: ${host}:${avnavService.port} (avnav, port-scan on connect)`);
            } else {
                // No avnav* service discovered — write NOTHING. The old
                // unconditional `|| 8080` default re-armed the dead-AvNav
                // connect storm on every boot after avnav was stopped on the
                // Pi and :8080 was taken over by a 404-ing server.
                log.info('No AvNav service discovered — chart config left untouched');
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
