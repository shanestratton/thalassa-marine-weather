/**
 * requestPath — the address a phone's request arrived from, echoed back.
 *
 * Shane 2026-10-07, at home with the boat 900 km away: the app said
 * "Aboard" because it reached this Pi at its boat-network address, and over
 * a VPN that carries the boat's network (a Tailscale subnet route from the
 * boat's router, ZeroTier, WireGuard to the router, a router-to-router VPN)
 * that address answers from anywhere. The phone cannot see which path its
 * own request took; this Pi can. A phone on the boat's Wi-Fi arrives from its
 * own Wi-Fi address; a phone over a VPN arrives from its tunnel address, or —
 * through a router that translates the VPN's traffic — from the router.
 * The phone compares the echo with its own addresses (services/boatLink).
 *
 * The Pi's own address that took the request is echoed too. A routed VPN
 * with no address translation (site-to-site WireGuard or IPsec from the
 * boat's router, a subnet route with source NAT off) shows this Pi the
 * phone's real HOME address, which the phone recognises as its own — so
 * "seen from my address" alone would say "aboard" from home. Only the same
 * address on the same /24 as the Pi's own is the boat's network.
 *
 * Read from the socket, never from a forwarded-for header: this server is
 * reached directly, and a header is whatever the client chose to write.
 * Only IPv4 is echoed, because only IPv4 is what the phone compares.
 */
export interface RequestPathWire {
    /** The IPv4 address this request arrived from, or null when not plain IPv4. */
    seen_from: string | null;
    /** This Pi's own IPv4 address that took the request, or null when not plain IPv4. */
    seen_at: string | null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `::ffff:192.0.2.7` → `192.0.2.7`; anything that is not plain IPv4 → null. */
export function seenFromAddress(remoteAddress: string | null | undefined): string | null {
    if (typeof remoteAddress !== 'string') return null;
    const trimmed = remoteAddress.trim();
    const v4 = trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
    const match = IPV4.exec(v4);
    if (!match || match.slice(1).some((part) => Number(part) > 255)) return null;
    return v4;
}

export function requestPath(
    remoteAddress: string | null | undefined,
    localAddress: string | null | undefined = null,
): RequestPathWire {
    return { seen_from: seenFromAddress(remoteAddress), seen_at: seenFromAddress(localAddress) };
}
