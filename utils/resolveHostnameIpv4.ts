/**
 * resolveHostnameIpv4 — resolve an mDNS hostname to a raw IPv4 address.
 *
 * Why: every TCP connection iOS makes to an mDNS hostname triggers a
 * Happy Eyeballs IPv6→IPv4 race. The Pi's services bind IPv4-only, so
 * IPv6 always RSTs and IPv4 wins — but the kernel logs every RST, and
 * the chart screen makes hundreds of new sockets per session (Mapbox
 * tiles, Capacitor HTTP, WebSocket reconnects). That's the source of
 * the recurring `tcp_input flags=[R.]` and `nw_endpoint_flow_failed`
 * spam in Xcode console.
 *
 * Fix: resolve the hostname ONCE per service, stash the IP, and dial
 * the IP directly on every subsequent connection. Skips the per-socket
 * dual-stack race entirely. Each service that owns a host config
 * (PiCacheService, AvNavService DRM, BoatNetworkService) calls this
 * helper after a successful discovery and stores the result.
 *
 * Native impl lives in ios/App/App/MdnsBrowserPlugin.swift —
 * `resolveHostname` method, calls getaddrinfo(AF_INET) off the main
 * thread. On web platforms the resolver returns null and the caller
 * falls back to the original hostname.
 *
 * Side effect: connections also get faster — no more ~50ms of
 * IPv6-RST-then-IPv4-fallback delay per socket.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface MdnsBrowserPlugin {
    resolveHostname(opts: { hostname: string }): Promise<{ ipv4: string }>;
}

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Resolve an mDNS hostname (e.g. `calypso.local`) to its IPv4 address
 * (e.g. `192.168.50.150`). Returns:
 *   - the input unchanged if it's already an IPv4 (idempotent)
 *   - the resolved IP on success
 *   - null on web platforms or resolution failure (caller should fall
 *     back to the input hostname — the system resolver still works,
 *     just without the noise reduction)
 */
export async function resolveHostnameIpv4(hostname: string, timeoutMs = 2000): Promise<string | null> {
    // Fast path: already an IP
    if (IPV4_REGEX.test(hostname)) return hostname;

    // Web platform — no plugin, no resolver
    if (!Capacitor.isNativePlatform()) return null;

    try {
        const MdnsBrowser = registerPlugin<MdnsBrowserPlugin>('MdnsBrowser');
        const resolved = await Promise.race([
            MdnsBrowser.resolveHostname({ hostname }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        return resolved && typeof resolved === 'object' && 'ipv4' in resolved ? resolved.ipv4 : null;
    } catch {
        return null;
    }
}

/**
 * Helper: rewrite the host portion of a URL to use an IPv4 address
 * if one is available. Useful for one-off URL rewriting where you
 * don't want to manage the resolution yourself.
 *
 * Returns the input unchanged on resolution failure (no regression).
 */
export async function urlWithIpv4Host(url: string): Promise<string> {
    try {
        const u = new URL(url);
        const resolved = await resolveHostnameIpv4(u.hostname);
        if (resolved && resolved !== u.hostname) {
            u.hostname = resolved;
            return u.toString();
        }
    } catch {
        /* malformed URL — pass through */
    }
    return url;
}
