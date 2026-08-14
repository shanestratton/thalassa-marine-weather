import Foundation
import Capacitor

/**
 * NetworkInterfacesPlugin — what this device's network actually looks like.
 *
 * Two questions the web layer cannot answer on iOS:
 *
 *   1. WHAT IS OUR LAN ADDRESS? The existing route (WebRTC ICE candidate
 *      harvesting, AvNavService.detectLocalIp) does not work in WKWebView —
 *      the code says so itself — and mDNS only finds services that advertise.
 *      Without our own address we cannot tell "the gateway is on this LAN"
 *      from "the gateway is somewhere out on the internet".
 *
 *   2. IS A VPN CARRYING OUR TRAFFIC? A tunnel appears as a `utun*` (or
 *      `ipsec*`/`ppp*`) interface. An app cannot disable a system VPN —
 *      NetworkExtension belongs to the OS and there is no entitlement for it —
 *      but it can SEE one, and that is enough to warn.
 *
 * Together they catch the hairpin that cost Shane a day on the boat
 * (2026-08-08): the phone sitting on the boat's own Wi-Fi while Tailscale
 * pulled 192.168.1.0/24 onto the tailnet, so traffic to a gateway two metres
 * away went out over 5G, through the router's NAT, and back. It "worked"
 * badly — laggy, dropping, and it read as the gateway being broken.
 *
 * Read-only and cheap: one getifaddrs() walk, no permissions, nothing
 * retained. Deliberately reports RAW interfaces and lets TypeScript decide
 * what they mean, so the policy stays unit-testable.
 */
@objc(NetworkInterfacesPlugin)
public class NetworkInterfacesPlugin: CAPPlugin {

    /// Interface name prefixes that mean "this traffic is in a tunnel".
    private static let tunnelPrefixes = ["utun", "ipsec", "ppp", "tap", "tun"]

    @objc func list(_ call: CAPPluginCall) {
        var interfaces: [[String: Any]] = []

        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else {
            call.resolve(["interfaces": interfaces, "vpnActive": false])
            return
        }
        defer { freeifaddrs(head) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }

            let flags = Int32(entry.pointee.ifa_flags)
            // Skip anything down, and skip loopback — 127.0.0.1 tells us
            // nothing about which network we are on.
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = entry.pointee.ifa_addr else { continue }

            let family = addr.pointee.sa_family
            guard family == UInt8(AF_INET) || family == UInt8(AF_INET6) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }

            let name = String(cString: entry.pointee.ifa_name)
            // Strip the zone suffix IPv6 link-local addresses carry
            // ("fe80::1%en0") — it is noise to every caller here.
            let address = String(cString: host).components(separatedBy: "%").first ?? ""
            if address.isEmpty { continue }

            // ── Drop link-local-only rows ──────────────────────────────
            // iOS keeps several SYSTEM utun interfaces permanently UP,
            // carrying nothing but an IPv6 link-local address, with no VPN
            // anywhere in sight. Because "tunnel" below is decided purely by
            // interface NAME, those rows made vpnActive true on every iPhone,
            // always — which collapsed the hairpin warning into "am I on the
            // gateway's subnet?", i.e. it fired exactly when aboard, which is
            // precisely when it is wrong and most misleading (Shane
            // 2026-08-13: "i get the message about a vpn being there, but i
            // have it turned off", while chasing a real connection failure).
            //
            // A link-local address routes nowhere and can never carry traffic
            // to the gateway, so such a row tells no caller anything. A real
            // tunnel is identified by a ROUTABLE address — Tailscale's
            // 100.64/10 survives this untouched, so ashore detection is
            // unaffected. 169.254/16 is the IPv4 equivalent (self-assigned,
            // no DHCP) and is dropped for the same reason.
            if address.hasPrefix("fe80") || address.hasPrefix("169.254.") { continue }

            interfaces.append([
                "name": name,
                "address": address,
                "family": family == UInt8(AF_INET) ? "ipv4" : "ipv6",
                "tunnel": Self.tunnelPrefixes.contains { name.hasPrefix($0) },
            ])
        }

        let vpnActive = interfaces.contains { ($0["tunnel"] as? Bool) == true }
        call.resolve(["interfaces": interfaces, "vpnActive": vpnActive])
    }
}
