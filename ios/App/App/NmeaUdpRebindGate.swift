import Foundation

/// Used only on the UDP serial queue. A cancelled DispatchSource still owns
/// its fd until its cancellation handler runs; no replacement may bind early.
final class NmeaUdpRebindGate {
    private var retiring = 0
    private var generation: UInt64 = 0
    private var pending: (id: String, generation: UInt64, ready: () -> Void, cancel: () -> Void)?
    func retiringDescriptor() { retiring += 1 }
    func descriptorClosed() {
        precondition(retiring > 0)
        retiring -= 1
        drain()
    }
    @discardableResult func replace(id: String, ready: @escaping () -> Void, cancel: @escaping () -> Void) -> UInt64 {
        let previous = pending; pending = nil; previous?.cancel()
        generation &+= 1
        let ticket = generation
        pending = (id, ticket, ready, cancel)
        drain()
        return ticket
    }
    @discardableResult func cancel(id: String, generation: UInt64? = nil) -> Bool {
        guard pending?.id == id, generation == nil || generation == pending?.generation else { return false }
        cancelAll(); return true
    }
    func cancelAll() {
        let previous = pending; pending = nil; previous?.cancel()
    }
    private func drain() {
        guard retiring == 0, let next = pending else { return }
        pending = nil; next.ready()
    }
}
