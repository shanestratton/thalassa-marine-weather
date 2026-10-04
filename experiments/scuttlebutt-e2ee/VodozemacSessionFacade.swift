// ISOLATED NATIVE AUTH CONTROL, not a Capacitor plugin or private-message port.
// The trusted native host owns Directory/project/conversation configuration.
// JS may eventually pass only a bearer and an opaque native-issued fence; no
// SDK user/device/store claims select authority. Supabase verifies an account,
// NOT hardware/device enrollment. No live Auth, installation or release claim.
import Foundation

enum DmSessionFacadeError: Error { case unavailable }
enum DmSessionFenceMode { case verify, signOut }

struct DmSessionFence {
    let authFence: String
}

/// Public account-auth result only. credentialBinding covers this exact native
/// credential lease; it is NOT a peer-trust-bound PM lifecycleVersion/readiness.
/// This public auth descriptor grants no authority to a message operation.
struct DmSessionAccount: Equatable {
    let accountId: String
    let deviceId: String
    let credentialBinding: String
    let serverVerified: Bool
}

/// In-memory NATIVE transport snapshot, not a plugin result or serializable
/// account descriptor. The credential retains a bearer in native memory only;
/// its existing description is redacted, and this value is redacted as a whole.
/// Only its minting facade can dispatch/commit the exact accepted lease. Keeping
/// this snapshot does not keep its lease alive or extend its original deadline.
final class DmNativeMessageSnapshot: CustomStringConvertible, CustomDebugStringConvertible {
    fileprivate let facadeID: UUID
    fileprivate let revision: UUID
    fileprivate let expires: ContinuousClock.Instant
    fileprivate let credentialBinding: String
    let credential: DmRelayNetworkCredential
    var context: DmRelayNetworkContext { credential.context }
    fileprivate init(facadeID: UUID, revision: UUID, expires: ContinuousClock.Instant,
                     credentialBinding: String, credential: DmRelayNetworkCredential) {
        self.facadeID = facadeID; self.revision = revision; self.expires = expires
        self.credentialBinding = credentialBinding; self.credential = credential
    }
    var description: String { "NativeMessageSnapshot(<native-only>)" }
    var debugDescription: String { description }
}

// Synchronous native fixture hooks ONLY: block at authority or advance a fake
// native clock. No async hooks, coordinator/store reference or plugin inputs.
struct DmMessageAuthorityHooksForResearch {
    var insideAuthority: (() throws -> Void)?
    init(insideAuthority: (() throws -> Void)? = nil) { self.insideAuthority = insideAuthority }
}

/// One native session owns at most ONE pending fence and ONE accepted scope.
/// Successful initial selection and same-owner renewal use distinct Directory
/// capabilities. Cold relaunch can continue only an exact sealed selected,
/// ready, active owner through fresh same-account Auth; no credential/readiness
/// is restored. A mismatched account refuses without deactivating that owner.
/// Explicit signOut still fences its generation before fresh account selection;
/// there is never an implicit open/rebind fallback based on SDK account labels.
final class VodozemacSessionFacade {
    private struct Pending {
        let id: String
        let revision: UUID
        let expires: ContinuousClock.Instant
        let reservation: VodozemacAccountDirectory.VerificationReservation?
    }
    private struct Lease {
        let revision: UUID
        let expires: ContinuousClock.Instant
        let account: DmSessionAccount
        let scope: VodozemacAccountDirectory.AuthenticatedScope
    }
    private let directory: VodozemacAccountDirectory
    private let clock: () -> ContinuousClock.Instant
    // Fence creation is synchronous and serialized BEFORE Directory authority.
    // Never retain these locks over HTTP, an SDK call, or another async task.
    // Directory has no callback into this facade, so native lock order is
    // fence -> facade state -> directory reservation -> directory/index/Auth.
    private let fenceLock = NSLock()
    private let lock = NSLock()
    private let instanceID = UUID()
    private var revision = UUID()
    private var pending: Pending?
    private var lease: Lease?

    convenience init(directory: VodozemacAccountDirectory) {
        self.init(directory: directory, clockForResearch: { ContinuousClock.now })
    }

    // Native deterministic probes only; never an app/plugin clock parameter.
    init(directory: VodozemacAccountDirectory, clockForResearch: @escaping () -> ContinuousClock.Instant) {
        self.directory = directory; clock = clockForResearch
    }

    /// Success is a DURABLE fence, not a queued promise. The caller must await
    /// it before requesting an SDK token. signOut fences cannot authenticate.
    func fenceSession(mode: DmSessionFenceMode) throws -> DmSessionFence {
        fenceLock.lock(); defer { fenceLock.unlock() }
        lock.lock()
        revision = UUID(); let next = revision
        pending = nil; lease = nil
        lock.unlock()
        do {
            guard !Task.isCancelled else { throw DmSessionFacadeError.unavailable }
            let expires = clock().advanced(by: .seconds(60))
            let reservation: VodozemacAccountDirectory.VerificationReservation?
            switch mode {
            case .verify: reservation = try directory.reserveVerification(expiresBy: expires)
            case .signOut: try directory.signOut(); reservation = nil
            }
            let deadline: ContinuousClock.Instant
            if let reservation, reservation.expires < expires { deadline = reservation.expires }
            else { deadline = expires }
            guard !Task.isCancelled, clock() < deadline else { throw DmSessionFacadeError.unavailable }
            let id = UUID().uuidString.lowercased()
            lock.lock(); defer { lock.unlock() }
            guard revision == next else { throw DmSessionFacadeError.unavailable }
            pending = Pending(id: id, revision: next, expires: deadline, reservation: reservation)
            return DmSessionFence(authFence: id)
        } catch { throw DmSessionFacadeError.unavailable }
    }

    /// Removes only the exact matching handle BEFORE await. Unknown, expired,
    /// used, signOut or superseded handles never dispatch /user or clear a newer
    /// mapping/lease. Even pre-claim cancellation burns this facade's handle.
    func authenticate(accessToken: String, authFence: String) async throws -> DmSessionAccount {
        do {
            let ticket = try claim(authFence)
            guard let reservation = ticket.reservation, !Task.isCancelled else { throw DmSessionFacadeError.unavailable }
            let scope = try await directory.authenticate(bearer: accessToken, reservation: reservation)
            return try publish(ticket, scope: scope)
        } catch {
            // No unconditional Directory logout, rebind, retry, or global local
            // reset after an async failure: a newer fence may already have won.
            throw DmSessionFacadeError.unavailable
        }
    }

    private func claim(_ id: String) throws -> Pending {
        lock.lock(); defer { lock.unlock() }
        guard let ticket = pending, ticket.id == id, ticket.revision == revision else { throw DmSessionFacadeError.unavailable }
        pending = nil
        guard ticket.reservation != nil, clock() < ticket.expires else { throw DmSessionFacadeError.unavailable }
        return ticket
    }

    private func publish(_ ticket: Pending, scope: VodozemacAccountDirectory.AuthenticatedScope) throws -> DmSessionAccount {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, revision == ticket.revision, clock() < ticket.expires,
              let context = scope.currentContext(), clock() < ticket.expires else { throw DmSessionFacadeError.unavailable }
        let account = DmSessionAccount(accountId: context.userId, deviceId: context.deviceId,
            credentialBinding: UUID().uuidString.lowercased(), serverVerified: true)
        lease = Lease(revision: ticket.revision, expires: ticket.expires, account: account, scope: scope)
        return account
    }

    /// A stale public account value is never an authorization input. Native
    /// message operations must use their own guarded snapshot/dispatch below.
    func currentAccount() -> DmSessionAccount? {
        lock.lock(); defer { lock.unlock() }
        guard let current = lease, current.revision == revision, clock() < current.expires,
              current.scope.currentContext() != nil, clock() < current.expires else { return nil }
        return current.account
    }

    /// Native transport captures this BEFORE awaiting the network. Caller-owned
    /// owner/device/epoch claims cannot select authority. The optional peer
    /// generation is checked against the sealed coordinator by AuthSession.
    /// Do not expose this value, its credential, or these methods to JS.
    func messageSnapshot(credentialBinding: String, peerGeneration: Int64? = nil) throws -> DmNativeMessageSnapshot {
        lock.lock(); defer { lock.unlock() }
        do {
            let current = try requireMessageLease(credentialBinding: credentialBinding)
            let credential = try current.scope.messageCredential(peerGeneration: peerGeneration,
                checkAuthority: { try self.checkMessageDeadline(current) })
            try checkMessageDeadline(current)
            return DmNativeMessageSnapshot(facadeID: instanceID, revision: current.revision,
                expires: current.expires, credentialBinding: credentialBinding, credential: credential)
        } catch { throw DmSessionFacadeError.unavailable }
    }

    /// Capture BEFORE HTTP. Removing the peer binding can settle only a strict
    /// terminal refusal, never accept a message or renew the original lease.
    func ownerOnlyCompletionSnapshot(from snapshot: DmNativeMessageSnapshot) throws -> DmNativeMessageSnapshot {
        lock.lock(); defer { lock.unlock() }
        do {
            let current = try requireMessageLease(snapshot: snapshot)
            let paired = try current.scope.messageCredential(peerGeneration: snapshot.context.peerGeneration,
                checkAuthority: { try self.checkMessageDeadline(current) })
            guard paired.context == snapshot.context else { throw DmSessionFacadeError.unavailable }
            let owner = try current.scope.messageCredential(peerGeneration: nil,
                checkAuthority: { try self.checkMessageDeadline(current) })
            try checkMessageDeadline(current)
            return DmNativeMessageSnapshot(facadeID: snapshot.facadeID, revision: snapshot.revision,
                expires: snapshot.expires, credentialBinding: snapshot.credentialBinding, credential: owner)
        } catch { throw DmSessionFacadeError.unavailable }
    }

    /// Relay dispatch/completion callback. This does not return a new credential
    /// or silently upgrade an old snapshot to a renewed lease. Network awaits
    /// occur only AFTER every facade/Directory/index/Auth lock has been released.
    func currentMessageContext(snapshot: DmNativeMessageSnapshot) -> DmRelayNetworkContext? {
        lock.lock(); defer { lock.unlock() }
        do {
            let current = try requireMessageLease(snapshot: snapshot)
            let credential = try current.scope.messageCredential(peerGeneration: snapshot.context.peerGeneration,
                checkAuthority: { try self.checkMessageDeadline(current) })
            guard credential.context == snapshot.context else { throw DmSessionFacadeError.unavailable }
            try checkMessageDeadline(current)
            return snapshot.context
        } catch { return nil }
    }

    /// CLOSED synchronous native dispatcher. No callback receives a coordinator,
    /// account store or credential; the scope privately supplies the exact
    /// context. The coordinator checks authority at each read/return and just
    /// before sealed CAS. No await, facade reentry or HTTP is allowed here.
    func executeMessageOperation(snapshot: DmNativeMessageSnapshot,
                                 operation: DmNativeMessageOperation) throws -> DmNativeMessageResult {
        try executeMessageOperationForResearch(snapshot: snapshot, operation: operation, hooks: .init())
    }

    func executeMessageOperationForResearch(snapshot: DmNativeMessageSnapshot,
                                            operation: DmNativeMessageOperation,
                                            hooks: DmMessageAuthorityHooksForResearch) throws -> DmNativeMessageResult {
        lock.lock(); defer { lock.unlock() }
        do {
            let current = try requireMessageLease(snapshot: snapshot)
            return try current.scope.executeMessageOperation(operation, context: snapshot.context,
                checkAuthority: { try self.checkMessageDeadline(current) }, insideAuthority: hooks.insideAuthority)
        } catch { throw DmSessionFacadeError.unavailable }
    }

    private func requireMessageLease(credentialBinding: String) throws -> Lease {
        guard let current = lease, current.account.credentialBinding == credentialBinding,
              current.revision == revision else { throw DmSessionFacadeError.unavailable }
        try checkMessageDeadline(current)
        return current
    }

    private func requireMessageLease(snapshot: DmNativeMessageSnapshot) throws -> Lease {
        guard snapshot.facadeID == instanceID, snapshot.revision == revision else { throw DmSessionFacadeError.unavailable }
        let current = try requireMessageLease(credentialBinding: snapshot.credentialBinding)
        guard snapshot.expires == current.expires, snapshot.revision == current.revision,
              snapshot.context.userId == current.account.accountId,
              snapshot.context.deviceId == current.account.deviceId else { throw DmSessionFacadeError.unavailable }
        return current
    }

    // Called only while facade state is already locked. This callback may run
    // under the coordinator lock, so never call a context getter/reacquire locks.
    private func checkMessageDeadline(_ current: Lease) throws {
        guard !Task.isCancelled, current.revision == revision, clock() < current.expires else {
            throw DmSessionFacadeError.unavailable
        }
    }
}
