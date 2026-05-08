import Foundation
import Capacitor

/**
 * MdnsBrowserPlugin — Native Bonjour / mDNS service browser.
 *
 * Replaces the hostname-guessing discovery in PiCacheService.ts with a
 * proper service-type browse for `_thalassa-cache._tcp`. Once this is
 * in place, the user can name the Pi anything (calypso, helm, bosun,
 * raspberrypi-of-tony) and the iOS app finds it automatically — the
 * Pi advertises its service type via avahi (already done by
 * pi-cache/install.sh), and we just browse for that type instead of
 * guessing hostnames.
 *
 * Why a native plugin
 * ───────────────────
 * Bonjour browsing requires DNS-SD service-type queries, which the
 * WebView's standard fetch / DNS APIs cannot perform. Only native
 * iOS networking (NetService / NWBrowser) can. iOS 14+ also requires
 * the service type to be declared in Info.plist's NSBonjourServices
 * array — without that declaration, the OS silently blocks the
 * browse and returns no results. Both halves are now in place.
 *
 * NetService is used here (rather than the newer NWBrowser) because
 * it gives back hostname + port directly, in one resolve step, with
 * a simple delegate callback — NWBrowser would require an additional
 * NWConnection round-trip per result to extract the same data.
 */
@objc(MdnsBrowserPlugin)
public class MdnsBrowserPlugin: CAPPlugin, NetServiceBrowserDelegate, NetServiceDelegate {

    private var browser: NetServiceBrowser?
    /** Services that have been discovered but not yet resolved to host:port. */
    private var pendingServices: [NetService] = []
    /** Resolved service descriptors, returned to JS when the browse completes. */
    private var resolved: [[String: Any]] = []
    /** The CAPPluginCall that's waiting on us. Resolved once the timeout fires. */
    private var pendingCall: CAPPluginCall?
    /** Used to make sure we don't call resolve() twice if results come in late. */
    private var didFinish = false

    @objc func browse(_ call: CAPPluginCall) {
        // Defensive: kill any in-flight browse before starting a new one.
        cleanup()

        let serviceType = call.getString("serviceType") ?? "_thalassa-cache._tcp"
        let domain = call.getString("domain") ?? "local."
        let timeoutMs = call.getDouble("timeoutMs") ?? 3000

        pendingCall = call
        resolved = []
        pendingServices = []
        didFinish = false

        let b = NetServiceBrowser()
        b.delegate = self
        // includesPeerToPeer: false — we only want devices on the local LAN
        // (the boat's WiFi), not Bluetooth/AWDL peers.
        b.includesPeerToPeer = false
        b.searchForServices(ofType: serviceType, inDomain: domain)
        browser = b

        // Stop after timeout no matter what — even if no results came in.
        // Empty array is a valid result; the JS side falls back to the
        // hostname list if so.
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1000) { [weak self] in
            self?.finishBrowse()
        }
    }

    /** Tear down the browser + any in-flight resolves and resolve the JS promise. */
    private func finishBrowse() {
        if didFinish { return }
        didFinish = true
        cleanup()
        pendingCall?.resolve(["services": resolved])
        pendingCall = nil
    }

    private func cleanup() {
        browser?.stop()
        browser = nil
        for svc in pendingServices {
            svc.stop()
        }
        pendingServices = []
    }

    // MARK: - NetServiceBrowserDelegate

    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        // Each discovered service needs to be resolved separately to get
        // its hostname + port. Resolve in parallel with a per-service
        // timeout shorter than our overall timeout so all resolves have
        // a chance to complete before finishBrowse() fires.
        service.delegate = self
        pendingServices.append(service)
        service.resolve(withTimeout: 2.0)
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
        // Most common cause: NSBonjourServices missing the service type
        // in Info.plist (iOS 14+ requirement). Bail out cleanly so the JS
        // side can fall through to hostname discovery.
        finishBrowse()
    }

    // MARK: - NetServiceDelegate

    public func netServiceDidResolveAddress(_ sender: NetService) {
        guard let host = sender.hostName else { return }
        // hostName comes back with a trailing dot ("calypso.local.") —
        // strip it so it's a clean URL host.
        let cleanHost = host.hasSuffix(".") ? String(host.dropLast()) : host

        // Pull the first IPv4 address from the resolved service's
        // address records. Returning the IP alongside the hostname lets
        // the JS side use the raw IP for connections — that skips the
        // per-socket IPv6→IPv4 Happy Eyeballs race that was flooding
        // the Xcode console with `tcp_input flags=[R.]` noise. We keep
        // the hostname for display and as a fallback if the IP ever
        // stops working (DHCP lease change, service migration, etc.).
        var ipv4: String? = nil
        if let addresses = sender.addresses {
            for data in addresses {
                let ip: String? = data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> String? in
                    guard let base = buf.baseAddress else { return nil }
                    let sa = base.assumingMemoryBound(to: sockaddr.self)
                    if sa.pointee.sa_family == sa_family_t(AF_INET) {
                        let sin = base.assumingMemoryBound(to: sockaddr_in.self)
                        var addr = sin.pointee.sin_addr
                        var buf2 = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                        if inet_ntop(AF_INET, &addr, &buf2, socklen_t(INET_ADDRSTRLEN)) != nil {
                            return String(cString: buf2)
                        }
                    }
                    return nil
                }
                if let ip = ip {
                    ipv4 = ip
                    break // first IPv4 wins
                }
            }
        }

        var entry: [String: Any] = [
            "name": sender.name,
            "host": cleanHost,
            "port": sender.port
        ]
        if let ipv4 = ipv4 {
            entry["ipv4"] = ipv4
        }
        resolved.append(entry)
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
        // Resolve failed for this one service — silently drop it. Other
        // discovered services may still resolve successfully.
    }

    // MARK: - Hostname → IPv4 resolution
    //
    // Used by services/BoatNetworkService.ts to convert a discovered
    // mDNS hostname (`calypso.local`) into a raw IPv4 address
    // (`192.168.50.150`) that subsequent connections can dial directly.
    // This skips the per-socket IPv6→IPv4 Happy Eyeballs race that was
    // flooding the Xcode console with `tcp_input flags=[R.]` noise on
    // every Mapbox tile fetch / Capacitor HTTP call / WebSocket open.
    //
    // Off the main thread because getaddrinfo is blocking. Resolves
    // back on main with the first IPv4 address found, or rejects if
    // none.
    @objc func resolveHostname(_ call: CAPPluginCall) {
        guard let hostname = call.getString("hostname") else {
            call.reject("hostname required")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            var hints = addrinfo(
                ai_flags: 0,
                ai_family: AF_INET,        // IPv4 only — that's what we want to cache
                ai_socktype: SOCK_STREAM,
                ai_protocol: 0,
                ai_addrlen: 0,
                ai_canonname: nil,
                ai_addr: nil,
                ai_next: nil
            )
            var result: UnsafeMutablePointer<addrinfo>? = nil
            let status = getaddrinfo(hostname, nil, &hints, &result)
            defer { if result != nil { freeaddrinfo(result) } }

            guard status == 0, result != nil else {
                DispatchQueue.main.async {
                    call.reject("getaddrinfo failed for \(hostname): status=\(status)")
                }
                return
            }

            var ipv4: String? = nil
            var current = result
            while let curr = current {
                if let addr = curr.pointee.ai_addr,
                   addr.pointee.sa_family == sa_family_t(AF_INET) {
                    let sin = UnsafeRawPointer(addr).assumingMemoryBound(to: sockaddr_in.self)
                    var addrCopy = sin.pointee.sin_addr
                    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    if inet_ntop(AF_INET, &addrCopy, &buf, socklen_t(INET_ADDRSTRLEN)) != nil {
                        ipv4 = String(cString: buf)
                        break
                    }
                }
                current = curr.pointee.ai_next
            }

            DispatchQueue.main.async {
                if let ipv4 = ipv4 {
                    call.resolve(["ipv4": ipv4])
                } else {
                    call.reject("no IPv4 address resolved for \(hostname)")
                }
            }
        }
    }
}
