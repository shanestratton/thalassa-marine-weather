/**
 * lanRoute — is this boat device on our own network, and is a VPN in the way?
 *
 * THE HAIRPIN. Shane, on the boat 2026-08-08: the phone sat on the boat's own
 * Wi-Fi while Tailscale advertised 192.168.1.0/24 from the RUTX50, so traffic
 * to an NMEA gateway two metres away was pulled onto the tailnet — out over
 * 5G, through the router's NAT, and back in. It did not fail cleanly. It was
 * laggy and dropped connections, which read as the gateway being broken, and
 * cost a day. Turning off subnet-route acceptance fixed it instantly.
 *
 * An app cannot stop this. A system VPN is a NetworkExtension owned by iOS and
 * there is no entitlement that lets an app exempt a socket from it. What an
 * app CAN do is notice — we are on 192.168.1.x, the gateway is 192.168.1.151,
 * and a tunnel interface is up — and say so, instead of letting the skipper
 * conclude the hardware is faulty.
 *
 * Pure, so the policy is testable without a network. The plumbing that reads
 * real interfaces lives in services/network/networkContext.ts.
 */

export interface NetworkInterfaceInfo {
    name: string;
    address: string;
    family: 'ipv4' | 'ipv6';
    tunnel: boolean;
}

export interface HairpinAssessment {
    /** A tunnel interface is up. */
    vpnActive: boolean;
    /** We hold an address on the same IPv4 /24 as the target device. */
    onSameLan: boolean;
    /** Both of the above: the VPN is very likely round-tripping local traffic. */
    hairpinLikely: boolean;
    /** Our address on that shared subnet, when there is one. */
    localAddress: string | null;
    /** Plain-English warning, or null when there is nothing to say. */
    warning: string | null;
}

/** Same IPv4 /24? Deliberately not a full netmask calculation — every boat
 *  network in the wild here is a /24, and guessing a wider mask would produce
 *  false positives that cost more than the missed cases. */
export function sameIpv4Subnet(a: string, b: string): boolean {
    const octets = (ip: string) => ip.split('.').map((part) => Number(part));
    const left = octets(a);
    const right = octets(b);
    if (left.length !== 4 || right.length !== 4) return false;
    if (left.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (right.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

/**
 * Decide whether reaching `hostIp` is at risk of being hairpinned.
 *
 * Only fires when BOTH halves are true. A VPN on its own is normal and useful
 * — it is how the boat is reached from ashore, and warning about it there
 * would be noise that teaches the skipper to ignore the banner.
 */
export function assessHairpin(params: {
    interfaces: NetworkInterfaceInfo[];
    /** The boat device we are trying to reach, e.g. the NMEA gateway. */
    hostIp: string | null;
    /** What to call it in the warning. */
    hostLabel?: string;
}): HairpinAssessment {
    const { interfaces, hostIp, hostLabel = 'this device' } = params;
    const vpnActive = interfaces.some((iface) => iface.tunnel);

    const localOnHostLan =
        hostIp === null
            ? null
            : (interfaces.find(
                  (iface) => !iface.tunnel && iface.family === 'ipv4' && sameIpv4Subnet(iface.address, hostIp),
              )?.address ?? null);

    const onSameLan = localOnHostLan !== null;
    const hairpinLikely = vpnActive && onSameLan;

    return {
        vpnActive,
        onSameLan,
        hairpinLikely,
        localAddress: localOnHostLan,
        warning: hairpinLikely
            ? `You’re on the same network as ${hostLabel} (${localOnHostLan} → ${hostIp}), but a VPN is active. ` +
              `Traffic to it may be routed out to the internet and back instead of going direct — that shows up as ` +
              `lag and dropped connections. In Tailscale, turn off “Use Tailscale subnets” while you’re aboard.`
            : null,
    };
}
