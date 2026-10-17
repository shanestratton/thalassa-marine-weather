import Foundation
import Darwin

/// Compile with the production gate on macOS; no iOS/Capacitor dependency.
@main struct NmeaUdpRebindGateProof {
    static func main() {
        cancellationProof()
        for _ in 0..<32 { samePortProof() }
        print("PASS: cancelled/superseded/generation-fenced starts and 32 real same-port DispatchSource rebinds")
    }
    static func cancellationProof() {
        let gate = NmeaUdpRebindGate()
        var events: [String] = []
        gate.retiringDescriptor()
        let old = gate.replace(id: "one", ready: { events.append("one bound") }, cancel: { events.append("one cancelled") })
        gate.replace(id: "one", ready: { events.append("replacement bound") }, cancel: { events.append("replacement cancelled") })
        precondition(events == ["one cancelled"])
        precondition(!gate.cancel(id: "one", generation: old))
        precondition(gate.cancel(id: "one"))
        gate.descriptorClosed()
        precondition(events == ["one cancelled", "replacement cancelled"])
        gate.retiringDescriptor()
        gate.replace(id: "background", ready: { events.append("background bound") }, cancel: { events.append("background cancelled") })
        gate.cancelAll(); gate.descriptorClosed()
        precondition(events.last == "background cancelled")
    }
    static func samePortProof() {
        let queue = DispatchQueue(label: "test.udp.rebind"), done = DispatchSemaphore(value: 0)
        queue.async {
            let old = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            precondition(old >= 0)
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1")); address.sin_port = 0
            precondition(bindTo(old, &address) == 0)
            var size = socklen_t(MemoryLayout<sockaddr_in>.size)
            let found = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(old, $0, &size) } }
            precondition(found == 0)
            let gate = NmeaUdpRebindGate(), source = DispatchSource.makeReadSource(fileDescriptor: old, queue: queue)
            var closed = false
            source.setEventHandler { }
            source.setCancelHandler {
                precondition(Darwin.close(old) == 0); closed = true
                gate.descriptorClosed()
            }
            source.resume()
            gate.retiringDescriptor(); source.cancel()
            gate.replace(id: "replacement", ready: {
                precondition(closed, "Replacement must wait for actual fd close")
                let replacement = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
                precondition(replacement >= 0)
                precondition(bindTo(replacement, &address) == 0, "Same-port rebind failed")
                Darwin.close(replacement); done.signal()
            }, cancel: { preconditionFailure("Unexpected cancellation") })
            precondition(!closed, "Cancellation is asynchronous on this same queue")
        }
        precondition(done.wait(timeout: .now() + 5) == .success)
    }
    static func bindTo(_ fd: Int32, _ address: inout sockaddr_in) -> Int32 {
        withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    }
}
