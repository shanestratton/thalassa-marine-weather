// Native Research owner eligibility, not an account/message permission. One
// owner serializes lifecycle closure with synchronous native dispatch. No lock
// is retained over an async operation; its final publication uses the original
// epoch. This class performs no Auth, store, fencing or UIKit action itself.
import Foundation

enum ResearchSceneAuthorityError: Error { case unavailable }

final class ResearchSceneAuthority: @unchecked Sendable {
    enum Phase: String, Sendable {
        case active, suspended
        case foregroundCovered = "foreground-covered"
        case fenceFailed = "fence-failed"
    }
    enum CloseOutcome { case absentAuthority, verifyCompleted, failed }
    struct Descriptor: Sendable {
        let epoch: String
        let phase: Phase
        var verificationAvailable: Bool { phase == .active }
        var json: [String: Any] {
            ["version": 1, "epoch": epoch, "phase": phase.rawValue,
             "verificationAvailable": verificationAvailable]
        }
    }
    struct Ticket: Sendable { fileprivate let epoch: String }
    struct ClosedDomFacts {
        let logPresent: Bool
        let composeEmpty: Bool
        let passwordEmpty: Bool
        let privateOpenEnabled: Bool
        let verificationControlsDisabled: Bool
        var isClosed: Bool {
            !logPresent && composeEmpty && passwordEmpty && !privateOpenEnabled && verificationControlsDisabled
        }
    }
    private let lock = NSLock()
    private var epoch = UUID().uuidString.lowercased()
    private var phase: Phase = .suspended
    private var foreground = false
    private var hasInactiveClose = false
    private var nativeBoundaryClosed = false

    func descriptor() -> Descriptor {
        lock.lock(); defer { lock.unlock() }
        return copied()
    }
    private func copied() -> Descriptor { Descriptor(epoch: epoch, phase: phase) }
    private func eligible(_ expected: String?) -> Bool {
        phase == .active && foreground && (expected == nil || expected == epoch)
    }

    // Native synchronous operations run within this serialization boundary.
    // Its callees must not reenter this owner or await; lock order is owner ->
    // plugin host -> facade -> Directory. Facade has no callback into this owner.
    func withActive<T>(epoch expected: String? = nil, _ operation: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard eligible(expected) else { throw ResearchSceneAuthorityError.unavailable }
        return try operation()
    }
    func begin<T>(epoch expected: String? = nil, _ operation: () throws -> T) throws -> (Ticket, T) {
        lock.lock(); defer { lock.unlock() }
        guard eligible(expected) else { throw ResearchSceneAuthorityError.unavailable }
        return (Ticket(epoch: epoch), try operation())
    }
    func withCurrent<T>(_ ticket: Ticket, _ operation: () throws -> T) throws -> T {
        try withActive(epoch: ticket.epoch, operation)
    }

    // Close/rotate BEFORE the existing-host synchronous native fence. The
    // caller returns only an outcome, never a facade/account/fence handle.
    // Duplicate inactive callbacks do not fence again or reset a failed epoch.
    func suspend(closeNative: () -> CloseOutcome) -> Descriptor {
        lock.lock(); defer { lock.unlock() }
        if !foreground && hasInactiveClose && (phase == .suspended || phase == .fenceFailed) { return copied() }
        foreground = false; phase = .suspended
        hasInactiveClose = true
        epoch = UUID().uuidString.lowercased(); nativeBoundaryClosed = false
        switch closeNative() {
        case .absentAuthority, .verifyCompleted: nativeBoundaryClosed = true
        case .failed: phase = .fenceFailed
        }
        return copied()
    }
    func becameActive() -> Descriptor {
        lock.lock(); defer { lock.unlock() }
        if foreground { return copied() }
        foreground = true
        // An ACK queued in background cannot release a later foreground.
        epoch = UUID().uuidString.lowercased()
        // Only the App's first real active callback opens cold eligibility.
        // If an inactive callback happened first, its closure/ACK rules apply.
        if !hasInactiveClose { phase = .active; return copied() }
        if phase != .fenceFailed && nativeBoundaryClosed { phase = .foregroundCovered }
        else { phase = .fenceFailed }
        return copied()
    }
    func mayObserveClosure(epoch expected: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return expected == epoch && foreground && nativeBoundaryClosed && phase == .foregroundCovered
    }
    // Only independently observed native-WK facts may reach this method. A
    // caller's option booleans are not proof and cannot remove the privacy cover.
    func acknowledge(epoch expected: String, observed facts: ClosedDomFacts) throws -> Descriptor {
        lock.lock(); defer { lock.unlock() }
        guard expected == epoch, foreground, nativeBoundaryClosed, phase == .foregroundCovered,
              facts.isClosed else { throw ResearchSceneAuthorityError.unavailable }
        phase = .active
        return copied()
    }
}
