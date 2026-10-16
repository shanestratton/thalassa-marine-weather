import Foundation
import Capacitor
import Darwin
import UIKit

/// Receive-only unicast on the phone's Wi-Fi IPv4 address. The Capacitor serial
/// queue dispatches work and returns; it never performs a blocking receive.
@objc(NmeaUdpPlugin)
public class NmeaUdpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NmeaUdpPlugin"
    public let jsName = "NmeaUdp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "com.thalassa.nmea.unicast", qos: .utility)
    private var reader: DispatchSourceRead?
    private var sessionId: String?
    private var cancelled: Set<String> = []
    private var pending: [[String: Any]] = []
    private var pendingBytes = 0
    private var flushQueued = false
    private var dropped = 0
    private var windowAt = ProcessInfo.processInfo.systemUptime
    private var windowBytes = 0
    private var observers: [NSObjectProtocol] = []
    private var foreground = true

    public override func load() {
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in self?.foreground = false; self?.close(reason: "background") }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in self?.foreground = true }
        })
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) }; reader?.cancel() }

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"), UUID(uuidString: id) != nil,
              let host = call.getString("host"), let port = call.getInt("port"), (1...65535).contains(port) else {
            call.reject("Invalid unicast gateway configuration"); return
        }
        queue.async { [weak self] in
            guard let self = self else { call.reject("UDP listener unavailable"); return }
            guard self.foreground else { call.reject("UDP listener is paused in the background"); return }
            if self.cancelled.remove(id) != nil { call.reject("UDP listener cancelled"); return }
            self.close(reason: "replaced")
            var gateway = in_addr()
            guard inet_pton(AF_INET, host, &gateway) == 1,
                  let local = Self.wifiAddress(), local.mask.s_addr != 0,
                  gateway.s_addr & local.mask.s_addr == local.address.s_addr & local.mask.s_addr,
                  gateway.s_addr != local.address.s_addr,
                  gateway.s_addr != (local.address.s_addr & local.mask.s_addr),
                  gateway.s_addr != (local.address.s_addr | ~local.mask.s_addr),
                  (UInt32(bigEndian: gateway.s_addr) >> 24) > 0,
                  (UInt32(bigEndian: gateway.s_addr) >> 24) < 224,
                  (UInt32(bigEndian: gateway.s_addr) >> 24) != 127 else {
                call.reject("UDP needs a unicast gateway on this phone's Wi-Fi subnet"); return
            }
            let descriptor = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            guard descriptor >= 0 else { call.reject("UDP socket unavailable"); return }
            guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else {
                Darwin.close(descriptor); call.reject("UDP socket unavailable"); return
            }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = UInt16(port).bigEndian
            address.sin_addr = local.address
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0 else { Darwin.close(descriptor); call.reject("UDP port unavailable on Wi-Fi"); return }
            let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: self.queue)
            self.sessionId = id; self.reader = source
            self.pending = []; self.pendingBytes = 0; self.dropped = 0
            self.windowAt = ProcessInfo.processInfo.systemUptime; self.windowBytes = 0
            source.setCancelHandler { Darwin.close(descriptor) }
            source.setEventHandler { [weak self] in self?.receive(descriptor, gateway: gateway, id: id) }
            source.resume()
            call.resolve(["sessionId": id, "localAddress": String(cString: inet_ntoa(local.address))])
        }
    }
    @objc func stop(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"), UUID(uuidString: id) != nil else { call.reject("Invalid UDP session"); return }
        queue.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            if self.sessionId == id { self.close(reason: "stopped") }
            else { if self.cancelled.count >= 32 { self.cancelled.removeAll() }; self.cancelled.insert(id) }
            call.resolve()
        }
    }
    private func close(reason: String) {
        let previous = sessionId
        sessionId = nil; reader?.cancel(); reader = nil
        pending = []; pendingBytes = 0; flushQueued = false
        if let id = previous { notifyListeners("state", data: ["sessionId": id, "reason": reason]) }
    }
    private func receive(_ descriptor: Int32, gateway: in_addr, id: String) {
        guard sessionId == id else { return }
        // Bound both a dispatch turn and the bridge rate. Overflow is counted,
        // never carried as a partial sentence into a later datagram.
        for _ in 0..<128 {
            var bytes = [UInt8](repeating: 0, count: 16_385)
            var sender = sockaddr_in(), senderSize = socklen_t(MemoryLayout<sockaddr_in>.size)
            let count = bytes.withUnsafeMutableBytes { buffer in
                withUnsafeMutablePointer(to: &sender) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        recvfrom(descriptor, buffer.baseAddress, buffer.count, 0, $0, &senderSize)
                    }
                }
            }
            if count < 0 {
                if errno != EAGAIN && errno != EWOULDBLOCK { close(reason: "receive-failed") }
                break
            }
            if count == 0 || sender.sin_addr.s_addr != gateway.s_addr { continue }
            let now = ProcessInfo.processInfo.systemUptime
            if now - windowAt >= 1 { windowAt = now; windowBytes = 0 }
            windowBytes += count
            guard count <= 16_384, windowBytes <= 512 * 1024,
                  pending.count < 64, pendingBytes + count <= 65_536,
                  let text = String(bytes: bytes.prefix(count), encoding: .ascii) else { dropped += 1; continue }
            pending.append(["text": text, "at": Date().timeIntervalSince1970 * 1000])
            pendingBytes += count
        }
        if !flushQueued && (!pending.isEmpty || dropped > 0) {
            flushQueued = true
            queue.asyncAfter(deadline: .now() + 0.04) { [weak self] in
                guard let self = self, self.sessionId == id else { return }
                self.flushQueued = false
                let packets = self.pending, loss = self.dropped
                self.pending = []; self.pendingBytes = 0; self.dropped = 0
                self.notifyListeners("datagrams", data: ["sessionId": id, "packets": packets, "dropped": loss])
            }
        }
    }
    private static func wifiAddress() -> (address: in_addr, mask: in_addr)? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return nil }
        defer { freeifaddrs(head) }
        var current = head
        while let entry = current {
            defer { current = entry.pointee.ifa_next }
            guard String(cString: entry.pointee.ifa_name) == "en0",
                  let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  let mask = entry.pointee.ifa_netmask,
                  Int32(entry.pointee.ifa_flags) & IFF_UP != 0 else { continue }
            return (UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr,
                    UnsafeRawPointer(mask).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr)
        }
        return nil
    }
}
