// ISOLATED NATIVE ADAPTER, not a Thalassa/Capacitor auth plugin. The concrete
// Supabase transport verifies a token; no caller-supplied user/device claims.
// An existing immutable native device scope is required. Initial enrollment,
// account-store selection, refresh-token acquisition and remote logout remain
// future integration work. Keys/pickles and bearer tokens never go to JS here.
import Foundation

enum DmAuthSessionError: Error { case unavailable }

/// Minted by native directory authority, never a JS/caller Boolean assertion.
/// The implementation must serialize directory epoch changes through the ENTIRE
/// synchronous operation, including its account-store CAS. Acquire this guard
/// before the AuthSession lock; never call it while that lock is already held.
protocol DmNativeAuthScopeGuard {
    func withCurrentScope<T>(_ operation: () throws -> T) throws -> T
}

// Deterministic native fixture seams. Async hooks run outside every authority
// and session lock; the synchronous hook observes an already-held scope gate.
struct DmAuthMutationHooksForResearch {
    var beforeBegin: (() async throws -> Void)?
    var beforeComplete: (() async throws -> Void)?
    var insideComplete: (() throws -> Void)?
    init(beforeBegin: (() async throws -> Void)? = nil,
         beforeComplete: (() async throws -> Void)? = nil,
         insideComplete: (() throws -> Void)? = nil) {
        self.beforeBegin = beforeBegin; self.beforeComplete = beforeComplete; self.insideComplete = insideComplete
    }
}

/// A single native owner/device scope. No identity is created/replaced by login.
/// On construction/restart readiness is empty, regardless of persisted active
/// status. Every auth attempt fences captured relay work BEFORE awaiting /user.
/// A bearer is retained in memory only after a guarded sealed commit succeeds.
final class VodozemacAuthSession {
    /// Opaque, in-memory native capability for ONE durably reserved attempt.
    /// A facade may map an opaque JS fence to this value, but must never expose
    /// or reconstruct it from JS. Restart invalidates it. The original scope
    /// guard is retained so consumption cannot substitute weaker authority.
    final class VerificationReservation: CustomStringConvertible, CustomDebugStringConvertible {
        fileprivate let sessionID: UUID
        fileprivate let attemptID: UUID
        fileprivate let scopeGuard: DmNativeAuthScopeGuard
        fileprivate init(sessionID: UUID, attemptID: UUID, scopeGuard: DmNativeAuthScopeGuard) {
            self.sessionID = sessionID; self.attemptID = attemptID; self.scopeGuard = scopeGuard
        }
        var description: String { "VerificationReservation(<native-only>)" }
        var debugDescription: String { description }
    }
    private struct Attempt {
        let id: UUID
        let reserved: DmLifecycleSnapshot
        let expires: ContinuousClock.Instant
        let continuation: Bool
        var consumed = false
    }
    private struct Lease {
        let lifecycle: DmLifecycleSnapshot
        let bearer: String
        let expires: ContinuousClock.Instant
    }
    private let coordinator: VodozemacDmCoordinator
    private let authenticator: VodozemacSupabaseAuth
    private let clock: () -> ContinuousClock.Instant
    private let sessionID = UUID()
    private let lock = NSLock()
    private var attempt: Attempt?
    private var lease: Lease?
    private var guardedInvocation: UUID?

    convenience init(coordinator: VodozemacDmCoordinator, authenticator: VodozemacSupabaseAuth) throws {
        try self.init(coordinator: coordinator, authenticator: authenticator, clockForResearch: { ContinuousClock.now })
    }

    // Only deterministic native probes inject time, never an app/plugin input.
    // The ordinary constructor uses the system monotonic clock without override.
    init(coordinator: VodozemacDmCoordinator, authenticator: VodozemacSupabaseAuth,
         clockForResearch: @escaping () -> ContinuousClock.Instant) throws {
        let scope = try coordinator.authScopeForResearch()
        guard let user = UUID(uuidString: scope.lifecycle.owner.userId),
              user.uuidString.lowercased() == scope.lifecycle.owner.userId,
              scope.lifecycle.owner.deviceId == scope.storeID.uuidString.lowercased(),
              scope.projectOrigin == nil || scope.projectOrigin == authenticator.projectOrigin else {
            throw DmAuthSessionError.unavailable
        }
        self.coordinator = coordinator
        self.authenticator = authenticator
        self.clock = clockForResearch
    }

    /// Token acquisition belongs to the existing login SDK, but its reported
    /// user/device fields never select this scope. Native /user does that check.
    /// Same-account refresh preserves the owner generation and exact ciphertext.
    @discardableResult
    func authenticate(bearer: String) async throws -> DmLifecycleSnapshot {
        // Direct single-scope RESEARCH escape hatch. It does not authenticate a
        // directory selection; AccountDirectory must use the guarded overload.
        guard !Task.isCancelled else { throw DmAuthSessionError.unavailable }
        let pending = try begin()
        do {
            let user = try await authenticator.authenticate(bearer: bearer, currentAttempt: { self.isCurrent(pending) })
            guard !Task.isCancelled else { throw DmAuthSessionError.unavailable }
            // Conservatively start the lease BEFORE Auth, not after returning
            // from await. OS suspension/scheduling cannot make an aged response
            // fresh again. Lock/Keychain/CAS also cannot restart this deadline.
            return try complete(pending, userId: user, bearer: bearer, expires: pending.expires)
        } catch {
            abandon(pending)
            // No provider errors/URLs/bearers/Auth body escape as diagnostics.
            // Never restore the prior lease after timeout/refusal/cancellation.
            throw DmAuthSessionError.unavailable
        }
    }

    @discardableResult
    func authenticate(bearer: String, scopeGuard: DmNativeAuthScopeGuard) async throws -> DmLifecycleSnapshot {
        try await authenticateForResearch(bearer: bearer, scopeGuard: scopeGuard, hooks: .init())
    }

    /// Call BEFORE asking the login SDK for a token. Success has durably rotated
    /// the credential epoch under native scope authority and cleared the prior
    /// in-memory lease. Same-owner active renewal preserves owner generation,
    /// pending records and exact ciphertext. Token acquisition does not extend
    /// the original sixty-second attempt/lease deadline.
    func reserveVerification(scopeGuard: DmNativeAuthScopeGuard) throws -> VerificationReservation {
        try reserveVerification(invocation: clearReadiness(), scopeGuard: scopeGuard)
    }

    /// Native Directory selected-owner continuation ONLY (cold or renewal).
    /// The original sealed owner must
    /// already be active and project-pinned. Fresh Auth is still required; no
    /// bearer, lease, policy or caller-owned identity survives construction.
    /// A different verified account refuses without signing out this existing
    /// ratchet. Explicit logout remains a separate durable transition.
    func reserveContinuation(scopeGuard: DmNativeAuthScopeGuard) throws -> VerificationReservation {
        try reserveVerification(invocation: clearReadiness(), scopeGuard: scopeGuard, continuation: true)
    }

    /// Consume the exact earlier native reservation, using its original guard.
    /// No begin/epoch rotation occurs here. A stale, expired, foreign or already
    /// consumed reservation cannot dispatch Auth or clear another attempt/lease.
    /// Only a successful claim consumes it; pre-claim cancellation may retry
    /// within the original deadline unless the native facade discards its fence.
    @discardableResult
    func authenticate(bearer: String, reservation: VerificationReservation) async throws -> DmLifecycleSnapshot {
        try await authenticateForResearch(bearer: bearer, reservation: reservation, hooks: .init())
    }

    @discardableResult
    func authenticateForResearch(bearer: String, scopeGuard: DmNativeAuthScopeGuard,
                                hooks: DmAuthMutationHooksForResearch) async throws -> DmLifecycleSnapshot {
        // Clear local credentials even when the directory gate refuses before
        // begin. Release the session lock before acquiring directory authority.
        let invocation = clearReadiness()
        do {
            guard !Task.isCancelled else { throw DmAuthSessionError.unavailable }
            try await hooks.beforeBegin?()
            let reservation = try reserveVerification(invocation: invocation, scopeGuard: scopeGuard)
            return try await authenticateForResearch(bearer: bearer, reservation: reservation, hooks: hooks)
        } catch {
            abandonInvocation(invocation)
            throw DmAuthSessionError.unavailable
        }
    }

    private func reserveVerification(invocation: UUID, scopeGuard: DmNativeAuthScopeGuard,
                                     continuation: Bool = false) throws -> VerificationReservation {
        var reserved: Attempt?
        do {
            return try scopeGuard.withCurrentScope {
                guard !Task.isCancelled else { throw DmAuthSessionError.unavailable }
                let pending = try begin(guardedInvocation: invocation, continuation: continuation)
                reserved = pending
                return VerificationReservation(sessionID: sessionID, attemptID: pending.id, scopeGuard: scopeGuard)
            }
        } catch {
            if let reserved { abandonGuarded(reserved, accepted: nil) }
            abandonInvocation(invocation)
            throw DmAuthSessionError.unavailable
        }
    }

    @discardableResult
    func authenticateForResearch(bearer: String, reservation: VerificationReservation,
                                hooks: DmAuthMutationHooksForResearch) async throws -> DmLifecycleSnapshot {
        guard reservation.sessionID == sessionID else { throw DmAuthSessionError.unavailable }
        var claimed: Attempt?
        var accepted: DmLifecycleSnapshot?
        do {
            let pending = try reservation.scopeGuard.withCurrentScope {
                let pending = try consume(reservation)
                // Only a successful claimant owns cleanup. Duplicate consumers
                // must not abandon an in-flight consumer of the same attempt.
                claimed = pending
                return pending
            }
            let user = try await authenticator.authenticate(bearer: bearer, currentAttempt: {
                (try? reservation.scopeGuard.withCurrentScope { self.isCurrent(pending) }) ?? false
            })
            guard !Task.isCancelled else { throw DmAuthSessionError.unavailable }
            try await hooks.beforeComplete?()
            return try reservation.scopeGuard.withCurrentScope {
                try hooks.insideComplete?()
                let lifecycle = try complete(pending, userId: user, bearer: bearer, expires: pending.expires)
                accepted = lifecycle
                return lifecycle
            }
        } catch {
            if let claimed { abandonGuarded(claimed, accepted: accepted) }
            throw DmAuthSessionError.unavailable
        }
    }

    private func consume(_ reservation: VerificationReservation) throws -> Attempt {
        lock.lock(); defer { lock.unlock() }
        guard reservation.sessionID == sessionID, !Task.isCancelled,
              var pending = attempt, pending.id == reservation.attemptID, !pending.consumed,
              clock() < pending.expires, try coordinator.lifecycleForResearch() == pending.reserved,
              clock() < pending.expires else { throw DmAuthSessionError.unavailable }
        pending.consumed = true
        attempt = pending
        return pending
    }

    private func clearReadiness() -> UUID {
        lock.lock(); defer { lock.unlock() }
        attempt = nil; lease = nil
        let invocation = UUID()
        guardedInvocation = invocation
        return invocation
    }

    private func abandonInvocation(_ invocation: UUID) {
        lock.lock(); defer { lock.unlock() }
        if guardedInvocation == invocation { guardedInvocation = nil }
    }

    private func abandonGuarded(_ pending: Attempt, accepted: DmLifecycleSnapshot?) {
        lock.lock(); defer { lock.unlock() }
        if attempt?.id == pending.id { attempt = nil; lease = nil }
        // The account commit may have succeeded before the index authority
        // transaction reported failure. Clear only this operation's lease;
        // never erase readiness installed by a newer competing verification.
        if attempt == nil, let accepted, lease?.lifecycle == accepted { lease = nil }
    }

    private func begin(guardedInvocation: UUID? = nil, continuation: Bool = false) throws -> Attempt {
        lock.lock(); defer { lock.unlock() }
        // A guarded call can wait outside this lock for directory authority.
        // Once a newer invocation clears readiness, the older waiter must not
        // reserve a fresh epoch from that newer scope or erase its lease.
        if let guardedInvocation {
            guard self.guardedInvocation == guardedInvocation else { throw DmAuthSessionError.unavailable }
        } else { self.guardedInvocation = nil }
        // Clear first, including on subsequent read/CAS/storage failure.
        attempt = nil; lease = nil
        let scope = try coordinator.authScopeForResearch()
        guard scope.projectOrigin == nil || scope.projectOrigin == authenticator.projectOrigin else {
            throw DmAuthSessionError.unavailable
        }
        if continuation {
            guard scope.lifecycle.active, scope.projectOrigin == authenticator.projectOrigin else {
                throw DmAuthSessionError.unavailable
            }
        }
        let reserved = try coordinator.beginAuthVerificationForResearch(expected: scope.lifecycle)
        let next = Attempt(id: UUID(), reserved: reserved, expires: clock().advanced(by: .seconds(60)),
            continuation: continuation)
        attempt = next
        return next
    }

    private func isCurrent(_ pending: Attempt) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, clock() < pending.expires, attempt?.id == pending.id,
              let state = try? coordinator.lifecycleForResearch() else { return false }
        return state == pending.reserved && clock() < pending.expires
    }

    private func complete(_ pending: Attempt, userId: String, bearer: String,
                          expires: ContinuousClock.Instant) throws -> DmLifecycleSnapshot {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, clock() < expires, attempt?.id == pending.id,
              try coordinator.lifecycleForResearch() == pending.reserved else {
            throw DmAuthSessionError.unavailable
        }
        guard clock() < expires else { throw DmAuthSessionError.unavailable }
        guard userId.utf8.elementsEqual(pending.reserved.owner.userId.utf8) else {
            attempt = nil; lease = nil
            if !pending.continuation {
                _ = try coordinator.deactivateAuthScopeForResearch(expected: pending.reserved)
            }
            throw DmAuthSessionError.unavailable
        }
        // Token format has been checked by the concrete authenticator. Validate
        // it for relay headers before committing so no throwing setup remains
        // between the durable transition and installing the in-memory lease.
        _ = try DmRelayNetworkCredential(context: context(pending.reserved, peerGeneration: nil), bearer: bearer)
        let accepted = try coordinator.completeAuthVerificationForResearch(expected: pending.reserved,
            verifiedUserId: userId, projectOrigin: authenticator.projectOrigin)
        guard !Task.isCancelled, clock() < expires else {
            attempt = nil; lease = nil
            throw DmAuthSessionError.unavailable
        }
        lease = Lease(lifecycle: accepted, bearer: bearer, expires: expires)
        attempt = nil
        return accepted
    }

    private func abandon(_ pending: Attempt) {
        lock.lock(); defer { lock.unlock() }
        if attempt?.id == pending.id { attempt = nil; lease = nil }
    }

    /// LOCAL native logout only; does not claim server token revocation. It
    /// invalidates pending auth and credentials before disk work. Failure is
    /// surfaced; memory never becomes ready again automatically.
    @discardableResult
    func signOut() throws -> DmLifecycleSnapshot {
        lock.lock(); defer { lock.unlock() }
        attempt = nil; lease = nil; guardedInvocation = nil
        return try coordinator.deactivateAuthScopeForResearch()
    }

    /// Native-only captured credential. A future plugin must not expose this
    /// method/value to JS. Server authorization is still checked per dispatch.
    func credential(peerGeneration: Int64? = nil) throws -> DmRelayNetworkCredential {
        lock.lock(); defer { lock.unlock() }
        let current = try requireLease(peerGeneration: peerGeneration)
        return try DmRelayNetworkCredential(context: context(current.lifecycle, peerGeneration: peerGeneration), bearer: current.bearer)
    }

    /// Called only while the Directory/index scope gate is held. Keep this
    /// session lock THROUGH the synchronous coordinator read/CAS: renewal must
    /// not clear readiness after a successful preflight but before a commit.
    /// The supplied checker runs under the coordinator lock. It therefore
    /// checks memory/deadlines only, NEVER reenters requireLease/coordinator.
    func withCurrentCredential<T>(expected: DmRelayNetworkContext, nativeDeadline: ContinuousClock.Instant,
                                  operation: (DmRelayNetworkCredential, () throws -> Void) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        let current = try requireLease(peerGeneration: expected.peerGeneration)
        guard context(current.lifecycle, peerGeneration: expected.peerGeneration) == expected else {
            throw DmAuthSessionError.unavailable
        }
        let check = {
            guard !Task.isCancelled, self.attempt == nil,
                  self.lease?.lifecycle == current.lifecycle, self.lease?.expires == current.expires,
                  self.clock() < current.expires, ContinuousClock.now < nativeDeadline else {
                throw DmAuthSessionError.unavailable
            }
        }
        try check()
        let result = try operation(DmRelayNetworkCredential(context: expected, bearer: current.bearer), check)
        try check()
        return result
    }

    /// Used by the existing relay client's dispatch/completion guards. Returns
    /// public context only, never token/key material. Expiry/auth failure stops
    /// activity; it does not manufacture a receipt or silently retry plaintext.
    func currentContext(peerGeneration: Int64? = nil) -> DmRelayNetworkContext? {
        lock.lock(); defer { lock.unlock() }
        guard let current = try? requireLease(peerGeneration: peerGeneration) else { return nil }
        return context(current.lifecycle, peerGeneration: peerGeneration)
    }

    private func requireLease(peerGeneration: Int64?) throws -> Lease {
        guard let current = lease, attempt == nil, clock() < current.expires else {
            lease = nil
            throw DmAuthSessionError.unavailable
        }
        try coordinator.validateRelayContextForResearch(owner: current.lifecycle.owner,
            credentialEpoch: current.lifecycle.credentialEpoch, peerGeneration: peerGeneration)
        guard clock() < current.expires else {
            lease = nil
            throw DmAuthSessionError.unavailable
        }
        return current
    }

    private func context(_ lifecycle: DmLifecycleSnapshot, peerGeneration: Int64?) -> DmRelayNetworkContext {
        DmRelayNetworkContext(userId: lifecycle.owner.userId, deviceId: lifecycle.owner.deviceId,
            ownerGeneration: lifecycle.owner.generation, credentialEpoch: lifecycle.credentialEpoch,
            peerGeneration: peerGeneration)
    }
}
