/**
 * gatewayScan — find the boat's NMEA gateway on the LAN by scanning for it.
 *
 * Shane, back from Tangalooma 2026-08-02: "I have a YDWG-02 on the network, but
 * for the life of me I could not remember the IP address." A gateway you cannot
 * address is a gateway you do not have — the passage was sailed without
 * instruments because of a forgotten number.
 *
 * The scan connects to each host on the candidate ports and READS: an open port
 * proves nothing (a router's web UI answers too), so a candidate is only offered
 * once its bytes look like marine data. That check is `looksLikeNmea`, kept pure
 * and tested — offering the wrong host is worse than offering none, because the
 * skipper will save it and wonder why no instruments appear.
 *
 * The probe is injected so the scan logic is testable without sockets; the real
 * one lives in nativeTcpProbe.ts.
 */

/** What a single host:port probe reports back. */
export interface ScanProbeResult {
    open: boolean;
    /** First bytes read after connecting, if any. */
    sample?: string;
}

export type ScanProbe = (host: string, port: number, timeoutMs: number) => Promise<ScanProbeResult>;

export interface GatewayCandidate {
    host: string;
    port: number;
    /** NMEA_DEVICE_PROFILES id this port suggests, when the port is distinctive. */
    profileId?: string;
    label: string;
    sample: string;
    /**
     * 'confirmed' — the bytes read are recognisably marine data.
     * 'likely'    — the port is a known gateway port but the device sent
     *               nothing in the read window. Some gateways stay silent
     *               until the bus has traffic, so this is offered, clearly
     *               marked, rather than hidden.
     */
    confidence: 'confirmed' | 'likely';
}

export interface PortSpec {
    port: number;
    profileId?: string;
    label: string;
}

/**
 * PHASE 1 — the known gateway ports, across the whole /24. Default first
 * (Shane: "I would start with the default port"), so a factory YDWG-02 is
 * found in the first sweep rather than after four others.
 */
export const SCAN_PORTS: PortSpec[] = [
    { port: 1456, profileId: 'ydwg02', label: 'Yacht Devices YDWG-02' },
    { port: 2000, profileId: 'ikonvert', label: 'iKonvert / Actisense W2K-1' },
    { port: 10110, profileId: 'direct', label: 'NMEA 0183 over TCP' },
    { port: 3000, profileId: 'signalk', label: 'Signal K server' },
    { port: 2947, label: 'gpsd' },
];

/**
 * PHASE 2 — ports that merely prove a box EXISTS at an address. A gateway
 * moved to a non-standard data port still answers its own web config here
 * (the YDWG-02's setup page is plain HTTP on 80), which is what makes the
 * deep sweep cheap: a handful of live hosts instead of 254.
 */
export const LIVENESS_PORTS: PortSpec[] = [
    { port: 80, label: 'web config' },
    { port: 443, label: 'web config (TLS)' },
    { port: 8080, label: 'web config (alt)' },
];

/**
 * PHASE 3 — a wider data-port sweep, run ONLY against hosts phase 2 proved
 * alive. Deliberately a curated list rather than all 65535: on native sockets
 * a full sweep of even one host is minutes, and every port here is one a
 * marine gateway is actually configurable to.
 */
export const DEEP_PORTS: PortSpec[] = [
    ...[1455, 1457, 1458, 1459, 1460].map((port) => ({ port, label: 'Yacht Devices (alt port)' })),
    ...[2001, 2002, 2003, 2010].map((port) => ({ port, label: 'gateway (alt port)' })),
    ...[3001, 3002, 3003].map((port) => ({ port, label: 'Signal K (alt port)' })),
    ...[4000, 4001, 5000, 5001, 5002].map((port) => ({ port, label: 'gateway (alt port)' })),
    ...[10111, 10112, 10113].map((port) => ({ port, label: 'NMEA 0183 TCP (alt port)' })),
    { port: 8375, label: 'Signal K / NMEA' },
    { port: 20220, label: 'Digital Yacht' },
    { port: 60002, label: 'gateway (alt port)' },
];

/**
 * Does this look like marine data rather than a web server saying hello?
 *
 * Recognises the three shapes this app already parses:
 *   NMEA 0183   `$GPRMC,...` / `!AIVDM,...`  (talker + 3-letter sentence)
 *   SeaSmart    `$PCDIN,01F119,...`          (N2K wrapped in 0183)
 *   YD/Actisense RAW  `16:29:27.082 R 09F8017F 00 FF ...`
 *
 * Deliberately strict about the 0183 form — a bare '$' matches shell prompts,
 * JSON containing '$' and half the internet.
 */
export function looksLikeNmea(sample: string): boolean {
    if (!sample) return false;

    // NMEA 0183 / AIS: $AAXXX, or !AAXXX, — 2-char talker + 3-char sentence.
    if (/[$!][A-Z]{2}[A-Z0-9]{3},/.test(sample)) return true;

    // Yacht Devices / Actisense RAW: timestamp, direction, 29-bit CAN id, bytes.
    if (/\d{2}:\d{2}:\d{2}\.\d{3}\s+[RT]\s+[0-9A-F]{8}(\s+[0-9A-F]{2})+/i.test(sample)) return true;

    // Actisense ASCII (A-format), e.g. A173321.107 23FF7 1F513 ...
    if (/^A\d{6}\.\d{3}\s+[0-9A-F]+\s+[0-9A-F]+/im.test(sample)) return true;

    return false;
}

/** Clearly NOT a gateway — an HTTP server answering on a scanned port. */
export function looksLikeHttp(sample: string): boolean {
    return /^HTTP\/\d|<html|<!doctype/i.test(sample.trim());
}

/** '192.168.50.159' → '192.168.50.' ; null when not a dotted IPv4. */
export function subnetPrefixOf(ip: string): string | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
    if (!m) return null;
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.`;
}

/** Is this a private (RFC1918) address — i.e. plausibly the boat's LAN? */
export function isPrivateIpv4(ip: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
    if (!m) return false;
    const [a, b] = m.slice(1, 3).map(Number);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
}

export interface ScanOptions {
    /** '192.168.50.' — hosts 1..254 on this /24 are probed. */
    subnetPrefix: string;
    probe: ScanProbe;
    ports?: PortSpec[];
    /** Restrict the sweep to these hosts instead of the whole /24. */
    hosts?: string[];
    /** Concurrent probes. Native sockets are a finite resource on iOS. */
    concurrency?: number;
    perProbeTimeoutMs?: number;
    /** Called as hosts complete, for a progress bar. */
    onProgress?: (done: number, total: number) => void;
    /** Called the moment a candidate is confirmed, so the UI can show it early. */
    onCandidate?: (candidate: GatewayCandidate) => void;
    /**
     * Called for EVERY open port, before the content filters — liveness is a
     * different question from candidacy. The deep sweep needs the addresses of
     * boxes whose only open port is a web UI, and those are exactly the ones
     * onCandidate drops.
     */
    onOpenPort?: (host: string, port: number, sample: string) => void;
    /** Abort the sweep (skipper hit Stop, or navigated away). */
    shouldStop?: () => boolean;
}

/**
 * Sweep one /24 for NMEA gateways. Resolves with every candidate found, best
 * first (confirmed before likely, then by port distinctiveness).
 */
export async function scanForGateways(opts: ScanOptions): Promise<GatewayCandidate[]> {
    const {
        subnetPrefix,
        probe,
        ports = SCAN_PORTS,
        hosts: hostSubset,
        concurrency = 12,
        perProbeTimeoutMs = 700,
        onProgress,
        onCandidate,
        onOpenPort,
        shouldStop,
    } = opts;

    const hosts = hostSubset ?? Array.from({ length: 254 }, (_, i) => `${subnetPrefix}${i + 1}`);
    const found: GatewayCandidate[] = [];
    const total = hosts.length * ports.length;
    let done = 0;

    // Port-major: every host on the most distinctive port first, so a YDWG-02
    // on 1456 surfaces in the first sweep instead of after four others.
    for (const portSpec of ports) {
        if (shouldStop?.()) break;
        let cursor = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                if (shouldStop?.()) return;
                const index = cursor++;
                if (index >= hosts.length) return;
                const host = hosts[index];
                let result: ScanProbeResult;
                try {
                    result = await probe(host, portSpec.port, perProbeTimeoutMs);
                } catch {
                    result = { open: false };
                }
                done++;
                onProgress?.(done, total);
                if (!result.open) continue;

                const sample = result.sample ?? '';
                onOpenPort?.(host, portSpec.port, sample); // liveness, before any filtering
                if (looksLikeHttp(sample)) continue; // a web UI, not a gateway

                const candidate: GatewayCandidate = {
                    host,
                    port: portSpec.port,
                    profileId: portSpec.profileId,
                    label: portSpec.label,
                    sample: sample.slice(0, 200),
                    confidence: looksLikeNmea(sample) ? 'confirmed' : 'likely',
                };
                found.push(candidate);
                onCandidate?.(candidate);
            }
        };

        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    }

    const rank = (c: GatewayCandidate) => (c.confidence === 'confirmed' ? 0 : 1);
    return found.sort((a, b) => rank(a) - rank(b) || a.port - b.port);
}

export type ScanPhase = 'default-ports' | 'finding-devices' | 'deep-ports';

export interface DiscoverOptions extends Omit<ScanOptions, 'ports' | 'hosts'> {
    /** Notified when the sweep moves on, so the UI can say what it is doing. */
    onPhase?: (phase: ScanPhase) => void;
}

/**
 * The whole hunt, in the order that finds a factory gateway fastest and a
 * reconfigured one at all:
 *
 *   1. known gateway ports across the /24, YDWG-02's 1456 first;
 *   2. if nothing was CONFIRMED, find hosts that answer on a web-config port;
 *   3. sweep the wider data-port list against just those hosts.
 *
 * Stops at the first phase that confirms real marine data — a skipper at the
 * helm wants the address, not a complete port inventory. Phase 1 alone settles
 * the common case in one sweep.
 */
export async function discoverGateways(opts: DiscoverOptions): Promise<GatewayCandidate[]> {
    const { onPhase, onCandidate, ...rest } = opts;
    const seen = new Set<string>();
    const all: GatewayCandidate[] = [];
    const collect = (c: GatewayCandidate) => {
        const key = `${c.host}:${c.port}`;
        if (seen.has(key)) return;
        seen.add(key);
        all.push(c);
        onCandidate?.(c);
    };

    onPhase?.('default-ports');
    const phase1 = await scanForGateways({ ...rest, ports: SCAN_PORTS, onCandidate: collect });
    if (phase1.some((c) => c.confidence === 'confirmed') || opts.shouldStop?.()) return sortCandidates(all);

    // Nothing proven yet — the gateway may be on a port we have not tried.
    onPhase?.('finding-devices');
    const liveHosts = new Set<string>();
    await scanForGateways({
        ...rest,
        ports: LIVENESS_PORTS,
        // onOpenPort, NOT onCandidate: a web-config hit is an ADDRESS, not a
        // gateway, and onCandidate never sees it because looksLikeHttp drops
        // it first — which is precisely the host we need. (My first cut used
        // onCandidate here and the deep sweep silently never ran.)
        onOpenPort: (host) => liveHosts.add(host),
    });
    if (liveHosts.size === 0 || opts.shouldStop?.()) return sortCandidates(all);

    onPhase?.('deep-ports');
    await scanForGateways({
        ...rest,
        ports: DEEP_PORTS,
        hosts: [...liveHosts],
        onCandidate: collect,
    });
    return sortCandidates(all);
}

function sortCandidates(list: GatewayCandidate[]): GatewayCandidate[] {
    const rank = (c: GatewayCandidate) => (c.confidence === 'confirmed' ? 0 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.port - b.port);
}
