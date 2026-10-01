// ISOLATED NATIVE ADAPTER, not a Thalassa/Capacitor auth plugin. The concrete
// Supabase transport verifies a token; no caller-supplied user/device claims.
// An existing immutable native device scope is required. Initial enrollment,
// account-store selection, refresh-token acquisition and remote logout remain
// future integration work. Keys/pickles and bearer tokens never go to JS here.
import Foundation

enum DmAuthSessionError: Error { case unavailable }

/// A single native owner/device scope. No identity is created/replaced by login.
/// On construction/restart readiness is empty, regardless of persisted active
/// status. Every auth attempt fences captured relay work BEFORE awaiting /user.
/// A bearer is retained in memory only after a guarded sealed commit succeeds.
final class VodozemacAuthSession {
    private struct Attempt {
        let id: UUID
        let reserved: DmLifecycleSnapshot
        let expires: ContinuousClock.Instant
    }
    private struct Lease {
        let lifecycle: DmLifecycleSnapshot
        let bearer: String
        let expires: ContinuousClock.Instant
    }
    private let coordinator: VodozemacDmCoordinator
    private let authenticator: VodozemacSupabaseAuth
    private let clock: () -> ContinuousClock.Instant
    private let lock = NSLock()
    private var attempt: Attempt?
    private var lease: Lease?

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

    private func begin() throws -> Attempt {
        lock.lock(); defer { lock.unlock() }
        // Clear first, including on subsequent read/CAS/storage failure.
        attempt = nil; lease = nil
        let scope = try coordinator.authScopeForResearch()
        guard scope.projectOrigin == nil || scope.projectOrigin == authenticator.projectOrigin else {
            throw DmAuthSessionError.unavailable
        }
        let reserved = try coordinator.beginAuthVerificationForResearch(expected: scope.lifecycle)
        let next = Attempt(id: UUID(), reserved: reserved, expires: clock().advanced(by: .seconds(60)))
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
            _ = try coordinator.deactivateAuthScopeForResearch(expected: pending.reserved)
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
        attempt = nil; lease = nil
        return try coordinator.deactivateAuthScopeForResearch()
    }

    /// Native-only captured credential. A future plugin must not expose this
    /// method/value to JS. Server authorization is still checked per dispatch.
    func credential(peerGeneration: Int64? = nil) throws -> DmRelayNetworkCredential {
        lock.lock(); defer { lock.unlock() }
        let current = try requireLease(peerGeneration: peerGeneration)
        return try DmRelayNetworkCredential(context: context(current.lifecycle, peerGeneration: peerGeneration), bearer: current.bearer)
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
