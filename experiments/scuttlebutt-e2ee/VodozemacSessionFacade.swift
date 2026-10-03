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
/// No message/coordinator/store/key/token API is provided by this auth slice.
struct DmSessionAccount: Equatable {
    let accountId: String
    let deviceId: String
    let credentialBinding: String
    let serverVerified: Bool
}

/// One native session owns at most ONE pending fence and ONE accepted scope.
/// Successful initial selection and same-owner renewal use distinct Directory
/// capabilities. Cold relaunch with selected state, or a mismatched account,
/// requires explicit native signOut followed by a fresh verify fence. There is
/// never an implicit open/rebind fallback based on SDK account labels.
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

    /// A stale public account value is never an authorization input. Every
    /// future message operation must gate its own dispatch AND commit through
    /// native Directory/Auth/peer authority; those operations are not built here.
    func currentAccount() -> DmSessionAccount? {
        lock.lock(); defer { lock.unlock() }
        guard let current = lease, current.revision == revision, clock() < current.expires,
              current.scope.currentContext() != nil, clock() < current.expires else { return nil }
        return current.account
    }
}
