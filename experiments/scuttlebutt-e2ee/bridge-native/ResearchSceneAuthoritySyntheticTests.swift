// Synthetic Foundation state/serialization probe. No UIKit, real Auth/native
// provider, app or OS callback evidence. Not part of an app source inventory.
#if E2EE_SCENE_AUTHORITY_TEST
import Foundation

private enum SceneAuthoritySyntheticError: Error { case refused }
private final class SceneOrder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func append(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
    func copy() -> [String] { lock.lock(); defer { lock.unlock() }; return values }
}

@main private struct ResearchSceneAuthoritySyntheticTests {
    static func main() throws {
        var assertions = 0
        func check(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw SceneAuthoritySyntheticError.refused }; assertions += 1
        }
        func refused(_ operation: () throws -> Void) throws {
            do { try operation() } catch ResearchSceneAuthorityError.unavailable { assertions += 1; return }
            throw SceneAuthoritySyntheticError.refused
        }
        let closed = ResearchSceneAuthority.ClosedDomFacts(logPresent: false, composeEmpty: true,
            passwordEmpty: true, privateOpenEnabled: false, verificationControlsDisabled: true)
        let owner = ResearchSceneAuthority()
        try check(owner.descriptor().phase == .suspended && !owner.descriptor().verificationAvailable)
        try refused { _ = try owner.withActive { 1 } }
        let initial = owner.becameActive()
        try check(initial.phase == .active && initial.verificationAvailable)
        try check(UUID(uuidString: initial.epoch)?.uuidString.lowercased() == initial.epoch)
        try check(try owner.withActive(epoch: initial.epoch) { 7 } == 7)
        let ticket = try owner.begin(epoch: initial.epoch) { 1 }.0
        var fences = 0
        let inactive = owner.suspend { fences += 1; return .verifyCompleted }
        try check(inactive.epoch != initial.epoch && inactive.phase == .suspended && !inactive.verificationAvailable)
        try check(fences == 1)
        try refused { _ = try owner.withActive(epoch: initial.epoch) { 1 } }
        try refused { _ = try owner.withCurrent(ticket) { 1 } }
        try refused { _ = try owner.acknowledge(epoch: inactive.epoch, observed: closed) }
        let duplicate = owner.suspend { fences += 1; return .verifyCompleted }
        try check(duplicate.epoch == inactive.epoch && fences == 1)
        let foreground = owner.becameActive()
        try check(foreground.phase == .foregroundCovered && !foreground.verificationAvailable)
        try check(foreground.epoch != inactive.epoch)
        try check(owner.becameActive().epoch == foreground.epoch)
        try refused { _ = try owner.acknowledge(epoch: inactive.epoch, observed: closed) }
        try refused { _ = try owner.withActive(epoch: foreground.epoch) { 1 } }
        for invalid in [
            ResearchSceneAuthority.ClosedDomFacts(logPresent: true, composeEmpty: true, passwordEmpty: true, privateOpenEnabled: false, verificationControlsDisabled: true),
            .init(logPresent: false, composeEmpty: false, passwordEmpty: true, privateOpenEnabled: false, verificationControlsDisabled: true),
            .init(logPresent: false, composeEmpty: true, passwordEmpty: false, privateOpenEnabled: false, verificationControlsDisabled: true),
            .init(logPresent: false, composeEmpty: true, passwordEmpty: true, privateOpenEnabled: true, verificationControlsDisabled: true),
            .init(logPresent: false, composeEmpty: true, passwordEmpty: true, privateOpenEnabled: false, verificationControlsDisabled: false),
        ] { try refused { _ = try owner.acknowledge(epoch: foreground.epoch, observed: invalid) } }
        try check(owner.descriptor().phase == .foregroundCovered)
        let acknowledged = try owner.acknowledge(epoch: foreground.epoch, observed: closed)
        try check(acknowledged.phase == .active && acknowledged.epoch == foreground.epoch && fences == 1)
        try refused { _ = try owner.withCurrent(ticket) { 1 } }
        try refused { _ = try owner.withActive(epoch: initial.epoch) { 1 } }
        try check(try owner.withActive(epoch: acknowledged.epoch) { 9 } == 9)
        let failed = ResearchSceneAuthority(); _ = failed.becameActive()
        let failedState = failed.suspend { .failed }
        try check(failedState.phase == .fenceFailed && !failedState.verificationAvailable)
        let failedForeground = failed.becameActive()
        try refused { _ = try failed.acknowledge(epoch: failedForeground.epoch, observed: closed) }
        let early = ResearchSceneAuthority(); _ = early.suspend { .absentAuthority }
        let earlyForeground = early.becameActive()
        try check(earlyForeground.phase == .foregroundCovered)
        try check(try early.acknowledge(epoch: earlyForeground.epoch, observed: closed).phase == .active)

        // Test the synchronous linearization order, not a native CAS or HTTP:
        // one synthetic operation wins before closure, later work is refused.
        let serial = ResearchSceneAuthority(); _ = serial.becameActive()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let closing = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let order = SceneOrder()
        DispatchQueue.global().async {
            try? serial.withActive {
                order.append("operation-entered"); entered.signal()
                if release.wait(timeout: .now() + 2) == .success { order.append("operation-completed") }
            }
        }
        try check(entered.wait(timeout: .now() + 2) == .success)
        DispatchQueue.global().async {
            closing.signal()
            _ = serial.suspend { order.append("close-completed"); return .verifyCompleted }
            finished.signal()
        }
        try check(closing.wait(timeout: .now() + 2) == .success)
        release.signal()
        try check(finished.wait(timeout: .now() + 2) == .success)
        try check(order.copy() == ["operation-entered", "operation-completed", "close-completed"])
        try refused { _ = try serial.withActive { order.append("late-operation") } }
        try check(order.copy().count == 3)
        print("PASS synthetic scene authority: \(assertions) assertions; OS/Auth/native-CAS unproved")
    }
}
#endif
