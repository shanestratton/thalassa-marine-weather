// ISOLATED NATIVE RESEARCH. Supabase confirms an account, not possession of a
// hardware device or permission to enrol one. No app plugin, server device
// enrollment, recovery/replacement, refresh-token acquisition or live Auth.
// The native directory supplies every store/device/identity identifier. A
// missing/corrupt index or account never silently becomes a fresh identity.
// Two sealed DBs use durable reservation/CAS rather than one cross-store
// transaction. Filesystem rollback, real crash/locked-device behavior, secure
// erasure and independent security review remain unproved release gates.
import Foundation
import Darwin

enum DmAccountDirectoryError: Error { case unavailable }

/// Native-only authenticated access. The directory epoch fences credentials
/// even if another directory handle signs out or selects a different account.
/// Raw coordinator access is retained only for the isolated research adapter;
/// it is not a shipping authorization boundary and must never become a JS API.
final class VodozemacAccountAccess {
    private final class RenewalGuard: DmNativeAuthScopeGuard {
        private let original: DmNativeAuthScopeGuard
        private let coordinator: VodozemacDmCoordinator
        private let userId: String
        private let deviceId: String
        private let projectOrigin: String
        private let expires: ContinuousClock.Instant
        init(original: DmNativeAuthScopeGuard, coordinator: VodozemacDmCoordinator,
             userId: String, deviceId: String, projectOrigin: String, expires: ContinuousClock.Instant) {
            self.original = original; self.coordinator = coordinator
            self.userId = userId; self.deviceId = deviceId; self.projectOrigin = projectOrigin
            self.expires = expires
        }
        func withCurrentScope<T>(_ operation: () throws -> T) throws -> T {
            try original.withCurrentScope {
                // A mismatch/sign-out may not silently become a relogin. The
                // check AND mutation stay inside the original index authority.
                guard ContinuousClock.now < expires else { throw DmAccountDirectoryError.unavailable }
                let scope = try coordinator.authScopeForResearch()
                guard ContinuousClock.now < expires, scope.lifecycle.active, scope.lifecycle.owner.userId == userId,
                      scope.lifecycle.owner.deviceId == deviceId, scope.storeID.uuidString.lowercased() == deviceId,
                      scope.projectOrigin == projectOrigin else { throw DmAccountDirectoryError.unavailable }
                let result = try operation()
                guard ContinuousClock.now < expires else { throw DmAccountDirectoryError.unavailable }
                return result
            }
        }
    }
    let coordinatorForResearch: VodozemacDmCoordinator
    private let store: VodozemacSealedStore
    private let session: VodozemacAuthSession
    private let scopeGuard: DmNativeAuthScopeGuard
    private let authority: () -> Bool
    private let logout: () throws -> Void
    private let userId: String
    private let deviceId: String
    private let projectOrigin: String
    private let lock = NSLock()
    private var valid = true

    fileprivate init(store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator,
                     session: VodozemacAuthSession, scopeGuard: DmNativeAuthScopeGuard, authority: @escaping () -> Bool,
                     logout: @escaping () throws -> Void, userId: String, deviceId: String, projectOrigin: String) {
        self.store = store; coordinatorForResearch = coordinator; self.session = session
        self.scopeGuard = scopeGuard
        self.authority = authority; self.logout = logout
        self.userId = userId; self.deviceId = deviceId; self.projectOrigin = projectOrigin
    }

    deinit { store.close() }

    fileprivate func invalidate() { lock.lock(); valid = false; lock.unlock() }
    // Exact disposable-fixture teardown only; no durable logout guarantee.
    func closeForResearch() { invalidate(); store.close() }
    private func locallyValid() -> Bool { lock.lock(); defer { lock.unlock() }; return valid }
    private func requireAuthority() throws {
        guard locallyValid(), authority(), locallyValid() else { throw DmAccountDirectoryError.unavailable }
    }

    /// Same-account renewal uses the existing native session. It preserves the
    /// owner generation and pending ciphertext; account selection uses open().
    @discardableResult
    func authenticate(bearer: String) async throws -> DmLifecycleSnapshot {
        try await authenticateForResearch(bearer: bearer, hooks: .init())
    }

    func authenticateForResearch(bearer: String, hooks: DmAuthMutationHooksForResearch) async throws -> DmLifecycleSnapshot {
        do {
            try requireAuthority()
            let lifecycle = try await session.authenticateForResearch(bearer: bearer, scopeGuard: scopeGuard, hooks: hooks)
            try requireAuthority()
            guard !Task.isCancelled else { throw DmAccountDirectoryError.unavailable }
            return lifecycle
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    fileprivate func reserveVerification(expires: ContinuousClock.Instant) throws -> VodozemacAuthSession.VerificationReservation {
        do {
            try requireAuthority()
            return try session.reserveVerification(scopeGuard: RenewalGuard(original: scopeGuard, coordinator: coordinatorForResearch,
                userId: userId, deviceId: deviceId, projectOrigin: projectOrigin, expires: expires))
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    fileprivate func authenticate(bearer: String, reservation: VodozemacAuthSession.VerificationReservation) async throws -> DmLifecycleSnapshot {
        do {
            try requireAuthority()
            let accepted = try await session.authenticate(bearer: bearer, reservation: reservation)
            try requireAuthority()
            guard !Task.isCancelled else { throw DmAccountDirectoryError.unavailable }
            return accepted
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    func credential(peerGeneration: Int64? = nil) throws -> DmRelayNetworkCredential {
        do {
            try requireAuthority()
            let value = try session.credential(peerGeneration: peerGeneration)
            try requireAuthority()
            return value
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    func currentContext(peerGeneration: Int64? = nil) -> DmRelayNetworkContext? {
        guard (try? requireAuthority()) != nil,
              let context = session.currentContext(peerGeneration: peerGeneration),
              (try? requireAuthority()) != nil else { return nil }
        return context
    }

    func lifecycleForResearch() throws -> DmLifecycleSnapshot {
        do {
            try requireAuthority()
            let lifecycle = try coordinatorForResearch.lifecycleForResearch()
            try requireAuthority()
            return lifecycle
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    /// An old access cannot sign out a newer directory selection.
    func signOut() throws {
        do { try requireAuthority(); try logout() }
        catch { throw DmAccountDirectoryError.unavailable }
    }
}

/// One bounded, authenticated account index in a native-created container.
/// New-container creation is explicit; reopen never creates a container,
/// locator, index, key, account or identity. Preserve the container URL in the
/// native host; losing that locator is not authorization to bootstrap another.
final class VodozemacAccountDirectory {
    private enum Status: String, Codable { case reserved, ready, blocked }
    // Only failures originating in an account can establish account loss.
    // Obsolete directory authority or index failures must never tombstone it.
    private enum DeactivationFailure: Error { case superseded, account(Error) }
    private struct Entry: Codable, Equatable {
        let userId: String
        let storeId: String
        let identityKeyId: String
        var status: Status
    }
    private struct State: Codable {
        let version: Int
        let containerId: String
        let projectOrigin: String
        let conversationId: String
        var epoch: UUID
        var selectedUserId: String?
        var accounts: [Entry]
    }
    fileprivate struct Attempt {
        let id: UUID
        let epoch: UUID
        let expires: ContinuousClock.Instant
        var consumed = false
    }
    fileprivate enum VerificationKind {
        case selection(Attempt)
        case renewal(VodozemacAccountAccess, VodozemacAuthSession.VerificationReservation)
    }
    /// Native-issued, one-claim capability. Never reconstructed from SDK/JS
    /// account fields; a facade maps its own opaque fence to this exact value.
    final class VerificationReservation: CustomStringConvertible, CustomDebugStringConvertible {
        fileprivate let directoryID: UUID
        fileprivate let id: UUID
        fileprivate let kind: VerificationKind
        let expires: ContinuousClock.Instant
        fileprivate init(directoryID: UUID, id: UUID, kind: VerificationKind, expires: ContinuousClock.Instant) {
            self.directoryID = directoryID; self.id = id; self.kind = kind; self.expires = expires
        }
        var description: String { "DirectoryVerificationReservation(<native-only>)" }
        var debugDescription: String { description }
    }
    /// Holds only one exact accepted credential binding; a later renewal cannot
    /// turn an old completion into authority for the new winner. No coordinator,
    /// store, credential, key or token is returned to the facade/JS.
    final class AuthenticatedScope {
        private let access: VodozemacAccountAccess
        private let expected: DmRelayNetworkContext
        private let nativeDeadline: ContinuousClock.Instant
        fileprivate init(access: VodozemacAccountAccess, lifecycle: DmLifecycleSnapshot,
                         nativeDeadline: ContinuousClock.Instant) {
            self.access = access; self.nativeDeadline = nativeDeadline
            expected = DmRelayNetworkContext(userId: lifecycle.owner.userId, deviceId: lifecycle.owner.deviceId,
                ownerGeneration: lifecycle.owner.generation, credentialEpoch: lifecycle.credentialEpoch, peerGeneration: nil)
        }
        func currentContext() -> DmRelayNetworkContext? {
            // The inner AuthSession starts later and may have a later lease
            // deadline. It must never extend this original native fence.
            guard ContinuousClock.now < nativeDeadline, access.currentContext() == expected,
                  ContinuousClock.now < nativeDeadline else { return nil }
            return expected
        }
    }
    private final class ScopeGuard: DmNativeAuthScopeGuard {
        private weak var directory: VodozemacAccountDirectory?
        private let ticket: Attempt
        private let userId: String
        private let storeId: String
        private let selected: Bool
        init(directory: VodozemacAccountDirectory, ticket: Attempt, userId: String, storeId: String, selected: Bool) {
            self.directory = directory; self.ticket = ticket; self.userId = userId; self.storeId = storeId; self.selected = selected
        }
        func withCurrentScope<T>(_ operation: () throws -> T) throws -> T {
            guard let directory else { throw DmAccountDirectoryError.unavailable }
            return try directory.withCurrentScope(ticket: ticket, userId: userId, storeId: storeId,
                selected: selected, operation: operation)
        }
    }
    // Read only the immutable binding fields from the existing v5 coordinator
    // format; keys/pickles remain native and no replacement payload is written.
    private struct AccountBinding: Decodable {
        let version: Int
        let owner: DmOwnerContext
        let authProjectOrigin: String?
        let conversationId: String
        let identityKeyId: String
        let signingKey: String
        let account: String
    }
    // Fixed deterministic interruptions leave a durable reservation; these are
    // native probe hooks, never application-facing enrollment controls.
    enum EnrollmentFault { case none, afterReservation, beforeReadyCommit }
    struct TransitionHooksForResearch {
        // Synchronous fixture hooks. The first holds only this directory's lock;
        // the second also holds authenticated index authority. Neither may await
        // or reenter this directory; the second must not call an index writer.
        var afterIndexCommitBeforeDeactivation: (() throws -> Void)?
        var insideDeactivationAuthority: (() throws -> Void)?
        init(afterIndexCommitBeforeDeactivation: (() throws -> Void)? = nil,
             insideDeactivationAuthority: (() throws -> Void)? = nil) {
            self.afterIndexCommitBeforeDeactivation = afterIndexCommitBeforeDeactivation
            self.insideDeactivationAuthority = insideDeactivationAuthority
        }
    }

    let directoryURL: URL
    private let containerID: UUID
    private let index: VodozemacSealedStore
    private let authenticator: VodozemacSupabaseAuth
    private let conversationId: String
    private let lock = NSLock()
    // Serializes synchronous reservation creation/claim only, never HTTP.
    // Acquire before directory/index/session locks; no path acquires it from
    // inside a scope guard. Research open/signOut remain independently guarded.
    private let verificationLock = NSLock()
    private let instanceID = UUID()
    private var verificationID: UUID?
    private var attempt: Attempt?
    // Revoked before disk work, including on a failed local transition. A
    // selected scope may refresh after its original enrollment deadline, but
    // only while this local permit AND the durable directory epoch still match.
    private var liveScopeID: UUID?
    private var currentAccess: VodozemacAccountAccess?
    private static let locatorName = "index-id"
    private static let capacity = 16

    private init(directory: URL, containerID: UUID, index: VodozemacSealedStore,
                 authenticator: VodozemacSupabaseAuth, conversationId: String) throws {
        directoryURL = directory; self.containerID = containerID; self.index = index
        self.authenticator = authenticator
        try DmContentCodec.validateIdentifier(conversationId)
        self.conversationId = conversationId
        _ = try readState()
    }

    /// A native host explicitly initializes one new directory. Neither an
    /// account, device ID nor key namespace can be supplied by its caller.
    // The trusted native host configures the same pilot conversation on both
    // paired devices. This is immutable configuration, never a login/JS input;
    // the bounded coordinator still supports exactly ONE paired conversation.
    static func create(parentDirectory: URL, authenticator: VodozemacSupabaseAuth,
                       conversationId: String) throws -> VodozemacAccountDirectory {
        do {
            try DmContentCodec.validateIdentifier(conversationId)
            guard parentDirectory.isFileURL else { throw DmAccountDirectoryError.unavailable }
            let parent = parentDirectory.standardizedFileURL.resolvingSymlinksInPath()
            try requireType(parent, .typeDirectory)
            let containerID = UUID(), indexID = UUID()
            let directory = parent.appendingPathComponent(containerID.uuidString.lowercased(), isDirectory: true)
            guard directory.path.withCString({ Darwin.mkdir($0, 0o700) }) == 0 else {
                throw DmAccountDirectoryError.unavailable
            }
            // Failed initialization remains an owned, unusable directory.
            // Never remove/reinitialize an uncertain namespace automatically.
            try protect(directory)
            let state = State(version: 1, containerId: containerID.uuidString.lowercased(),
                projectOrigin: authenticator.projectOrigin, conversationId: conversationId,
                epoch: UUID(), selectedUserId: nil, accounts: [])
            let index = try VodozemacSealedStore.create(
                directory: directory.appendingPathComponent(indexID.uuidString.lowercased(), isDirectory: true),
                storeID: indexID, initialPayload: JSONEncoder().encode(state))
            do {
                let locator = directory.appendingPathComponent(locatorName)
                try Data((indexID.uuidString.lowercased() + "\n").utf8).write(to: locator, options: .withoutOverwriting)
                try protect(locator)
                let handle = try FileHandle(forWritingTo: locator)
                defer { try? handle.close() }
                try handle.synchronize()
                try syncDirectory(directory)
                try syncDirectory(parent)
                return try VodozemacAccountDirectory(directory: directory, containerID: containerID,
                    index: index, authenticator: authenticator, conversationId: conversationId)
            } catch { index.close(); throw error }
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    static func reopen(directory: URL, authenticator: VodozemacSupabaseAuth,
                       conversationId: String) throws -> VodozemacAccountDirectory {
        do {
            guard directory.isFileURL, let containerID = canonicalUUID(directory.lastPathComponent) else {
                throw DmAccountDirectoryError.unavailable
            }
            try requireType(directory, .typeDirectory)
            let canonical = directory.standardizedFileURL.resolvingSymlinksInPath()
            let locator = canonical.appendingPathComponent(locatorName)
            try requireType(locator, .typeRegular)
            guard let size = try locator.resourceValues(forKeys: [.fileSizeKey]).fileSize, size == 37,
                  let value = String(data: try readLocator(locator), encoding: .utf8),
                  value.utf8.count == 37, value.hasSuffix("\n"),
                  let indexID = canonicalUUID(String(value.dropLast())) else {
                throw DmAccountDirectoryError.unavailable
            }
            let index = try VodozemacSealedStore.reopen(
                directory: canonical.appendingPathComponent(indexID.uuidString.lowercased(), isDirectory: true), storeID: indexID)
            do {
                return try VodozemacAccountDirectory(directory: canonical, containerID: containerID,
                    index: index, authenticator: authenticator, conversationId: conversationId)
            } catch { index.close(); throw error }
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    deinit { currentAccess?.invalidate(); index.close() }

    // Exact disposable-fixture teardown only. An ordinary native host retains
    // the directory throughout its access lifetime and uses signOut() first.
    func closeForResearch() {
        lock.lock(); defer { lock.unlock() }
        verificationID = nil; attempt = nil; liveScopeID = nil; currentAccess?.closeForResearch(); currentAccess = nil
        index.close()
    }

    /// Fence BEFORE SDK token acquisition. A live selected account can ONLY
    /// renew its existing active owner; unselected state can begin selection.
    /// Cold reopen of a persisted selection has no native continuation permit:
    /// this bounded pilot requires explicit signOut followed by fresh verify.
    // A native facade may tighten, but NEVER extend, this monotonic deadline.
    // It is not a plugin/SDK parameter or owner/device authority.
    func reserveVerification(expiresBy: ContinuousClock.Instant? = nil) throws -> VerificationReservation {
        verificationLock.lock(); defer { verificationLock.unlock() }
        let id = UUID(), naturalExpiry = ContinuousClock.now.advanced(by: .seconds(60))
        let expires = expiresBy.map { $0 < naturalExpiry ? $0 : naturalExpiry } ?? naturalExpiry
        do {
            let access: VodozemacAccountAccess? = try {
                lock.lock(); defer { lock.unlock() }
                guard !Task.isCancelled, ContinuousClock.now < expires else { throw DmAccountDirectoryError.unavailable }
                verificationID = id
                let state = try readState()
                if state.selectedUserId != nil {
                    guard liveScopeID != nil, let access = currentAccess else { throw DmAccountDirectoryError.unavailable }
                    return access
                }
                return nil
            }()
            if let access {
                // Do not retain directory/index locks: this original guard
                // reacquires them around the AuthSession reservation CAS.
                let ticket = try access.reserveVerification(expires: expires)
                lock.lock(); defer { lock.unlock() }
                guard verificationID == id, currentAccess === access, ContinuousClock.now < expires else {
                    throw DmAccountDirectoryError.unavailable
                }
                return VerificationReservation(directoryID: instanceID, id: id, kind: .renewal(access, ticket), expires: expires)
            }
            let ticket = try begin(hooks: .init(), requireUnselected: true, expiresBy: expires)
            lock.lock(); defer { lock.unlock() }
            guard attempt?.id == ticket.id, liveScopeID == ticket.id, ContinuousClock.now < ticket.expires else {
                throw DmAccountDirectoryError.unavailable
            }
            verificationID = id
            return VerificationReservation(directoryID: instanceID, id: id, kind: .selection(ticket),
                expires: expires < ticket.expires ? expires : ticket.expires)
        } catch {
            lock.lock(); if verificationID == id { verificationID = nil }; lock.unlock()
            throw DmAccountDirectoryError.unavailable
        }
    }

    /// Consume only the earlier capability. No begin/open fallback, even if
    /// Auth verifies a different account. Explicit signOut→verify selects it.
    func authenticate(bearer: String, reservation: VerificationReservation) async throws -> AuthenticatedScope {
        do {
            try claimVerification(reservation)
            let accepted: (access: VodozemacAccountAccess, lifecycle: DmLifecycleSnapshot)
            switch reservation.kind {
            case .selection(let ticket):
                accepted = try await completeSelection(bearer: bearer, ticket: ticket, fault: .none)
            case .renewal(let access, let ticket):
                accepted = (access, try await access.authenticate(bearer: bearer, reservation: ticket))
            }
            let scope = AuthenticatedScope(access: accepted.access, lifecycle: accepted.lifecycle,
                nativeDeadline: reservation.expires)
            guard !Task.isCancelled, ContinuousClock.now < reservation.expires, scope.currentContext() != nil else {
                throw DmAccountDirectoryError.unavailable
            }
            return scope
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    private func claimVerification(_ reservation: VerificationReservation) throws {
        guard reservation.directoryID == instanceID else { throw DmAccountDirectoryError.unavailable }
        verificationLock.lock(); defer { verificationLock.unlock() }
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, verificationID == reservation.id, ContinuousClock.now < reservation.expires else {
            throw DmAccountDirectoryError.unavailable
        }
        if case .selection(let ticket) = reservation.kind {
            guard var pending = attempt, pending.id == ticket.id, !pending.consumed else { throw DmAccountDirectoryError.unavailable }
            pending.consumed = true; attempt = pending
        }
        verificationID = nil
    }

    /// Account selection/login, not refresh. A previous selected lifecycle is
    /// deactivated before HTTP. Only a server-verified canonical UUID may select
    /// its immutable binding. A second /user check obtains the existing session's
    /// guarded lease after selection; no bearer is persisted in either store.
    func open(bearer: String) async throws -> VodozemacAccountAccess {
        try await openForResearch(bearer: bearer, fault: .none)
    }

    func openForResearch(bearer: String, fault: EnrollmentFault,
                         hooks: TransitionHooksForResearch = .init()) async throws -> VodozemacAccountAccess {
        do {
            guard !Task.isCancelled else { throw DmAccountDirectoryError.unavailable }
            let ticket = try begin(hooks: hooks)
            let result = try await completeSelection(bearer: bearer, ticket: ticket, fault: fault)
            return result.access
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    private func completeSelection(bearer: String, ticket: Attempt, fault: EnrollmentFault)
        async throws -> (access: VodozemacAccountAccess, lifecycle: DmLifecycleSnapshot) {
        var selected: (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator)?
        var accepted: DmLifecycleSnapshot?
        do {
            guard !Task.isCancelled, isCurrent(ticket) else { throw DmAccountDirectoryError.unavailable }
            let userId = try await authenticator.authenticate(bearer: bearer, currentAttempt: { self.isCurrent(ticket) })
            guard !Task.isCancelled, isCurrent(ticket) else { throw DmAccountDirectoryError.unavailable }
            let local = try select(userId: userId, ticket: ticket, fault: fault)
            selected = local
            let session = try VodozemacAuthSession(coordinator: local.coordinator, authenticator: authenticator)
            guard !Task.isCancelled, isCurrent(ticket) else { throw DmAccountDirectoryError.unavailable }
            let scopeGuard = ScopeGuard(directory: self, ticket: ticket, userId: userId,
                storeId: local.store.storeID.uuidString.lowercased(), selected: false)
            let lifecycle = try await session.authenticate(bearer: bearer, scopeGuard: scopeGuard)
            accepted = lifecycle
            return (try publish(local: local, session: session, userId: userId, ticket: ticket), lifecycle)
        } catch {
            // Publication can fail AFTER an authorized account commit. This
            // exact-lifecycle compensation is not stale-mutation prevention;
            // the mandatory transaction guard already refused stale commits.
            if let selected {
                if let accepted { _ = try? selected.coordinator.deactivateAuthScopeForResearch(expected: accepted) }
                selected.store.close()
            }
            abandon(ticket)
            throw DmAccountDirectoryError.unavailable
        }
    }

    /// Local native sign-out only. Failed storage/deactivation is surfaced; this
    /// does not revoke remote tokens or undo already-dispatched server requests.
    func signOut() throws { try signOut(expectedEpoch: nil) }

    func signOutForResearch(hooks: TransitionHooksForResearch) throws {
        try signOut(expectedEpoch: nil, hooks: hooks)
    }

    private func begin(hooks: TransitionHooksForResearch, requireUnselected: Bool = false,
                       expiresBy: ContinuousClock.Instant? = nil) throws -> Attempt {
        lock.lock(); defer { lock.unlock() }
        if let expiresBy, ContinuousClock.now >= expiresBy { throw DmAccountDirectoryError.unavailable }
        if !requireUnselected {
            verificationID = nil; attempt = nil; liveScopeID = nil; currentAccess?.invalidate(); currentAccess = nil
        }
        let snapshot = try index.read()
        var state = try decode(snapshot.payload)
        if requireUnselected, state.selectedUserId != nil { throw DmAccountDirectoryError.unavailable }
        verificationID = nil; attempt = nil; liveScopeID = nil; currentAccess?.invalidate(); currentAccess = nil
        let previous = state.selectedUserId.flatMap { user in state.accounts.first { $0.userId == user } }
        let epoch = UUID()
        state.epoch = epoch; state.selectedUserId = nil
        if let expiresBy, ContinuousClock.now >= expiresBy { throw DmAccountDirectoryError.unavailable }
        try commit(state, revision: snapshot.revision)
        // This ordering fences old access even when deactivation fails. Explicit
        // retry may be needed; failure never restores an old in-memory lease.
        if let previous {
            do {
                try hooks.afterIndexCommitBeforeDeactivation?()
                try deactivate(previous, expectedEpoch: epoch, hooks: hooks)
            }
            catch {
                if case DeactivationFailure.account(let cause) = error,
                   Self.permanentAccountFailure(cause) { try block(previous, epoch: epoch) }
                throw error
            }
        }
        let ticket = Attempt(id: UUID(), epoch: epoch, expires: expiresBy ?? ContinuousClock.now.advanced(by: .seconds(60)))
        guard ContinuousClock.now < ticket.expires else { throw DmAccountDirectoryError.unavailable }
        attempt = ticket
        liveScopeID = ticket.id
        return ticket
    }

    private func isCurrent(_ ticket: Attempt) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, attempt?.id == ticket.id, ContinuousClock.now < ticket.expires,
              let state = try? readState(), state.epoch == ticket.epoch, state.selectedUserId == nil else { return false }
        return ContinuousClock.now < ticket.expires
    }

    private func select(userId: String, ticket: Attempt, fault: EnrollmentFault)
        throws -> (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator) {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, attempt?.id == ticket.id, ContinuousClock.now < ticket.expires else {
            throw DmAccountDirectoryError.unavailable
        }
        let snapshot = try index.read()
        var state = try decode(snapshot.payload)
        guard state.epoch == ticket.epoch, state.selectedUserId == nil, Self.canonicalUUID(userId) != nil else {
            throw DmAccountDirectoryError.unavailable
        }
        if let entry = state.accounts.first(where: { $0.userId == userId }) {
            guard entry.status == .ready else { throw DmAccountDirectoryError.unavailable }
            do { return try reopenForSelection(entry, ticket: ticket) }
            catch {
                if case DeactivationFailure.account(let cause) = error,
                   Self.permanentAccountFailure(cause) {
                    // Durable tombstone before reporting loss/corruption. If the
                    // index CAS fails, the ready entry still strictly reopens;
                    // it cannot ever take the missing-account create branch.
                    try block(entry, epoch: ticket.epoch)
                }
                throw error
            }
        }
        guard state.accounts.count < Self.capacity else { throw DmAccountDirectoryError.unavailable }
        let storeID = UUID()
        let entry = Entry(userId: userId, storeId: storeID.uuidString.lowercased(),
            identityKeyId: UUID().uuidString.lowercased(), status: .reserved)
        state.accounts.append(entry)
        let reservedRevision = try commit(state, revision: snapshot.revision)
        if case .afterReservation = fault { throw DmAccountDirectoryError.unavailable }
        guard !Task.isCancelled, ContinuousClock.now < ticket.expires else { throw DmAccountDirectoryError.unavailable }
        let store = try VodozemacSealedStore.create(directory: accountURL(entry), storeID: storeID, initialPayload: Data("{}".utf8))
        do {
            let owner = DmOwnerContext(userId: userId, deviceId: entry.storeId, generation: 1)
            let coordinator = try VodozemacDmCoordinator.bootstrapForResearch(store: store, owner: owner,
                identityKeyId: entry.identityKeyId, conversationId: conversationId)
            let initial = try coordinator.lifecycleForResearch()
            let pinned = try coordinator.completeAuthVerificationForResearch(expected: initial,
                verifiedUserId: userId, projectOrigin: authenticator.projectOrigin)
            _ = try coordinator.deactivateAuthScopeForResearch(expected: pinned)
            guard !Task.isCancelled, ContinuousClock.now < ticket.expires else { throw DmAccountDirectoryError.unavailable }
            if case .beforeReadyCommit = fault { throw DmAccountDirectoryError.unavailable }
            guard let position = state.accounts.firstIndex(where: { $0 == entry }) else { throw DmAccountDirectoryError.unavailable }
            state.accounts[position].status = .ready
            // Epoch and reservation are part of the same sealed-index CAS.
            _ = try commit(state, revision: reservedRevision)
            return (store, coordinator)
        } catch { store.close(); throw error }
    }

    private func publish(local: (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator),
                         session: VodozemacAuthSession, userId: String, ticket: Attempt) throws -> VodozemacAccountAccess {
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, attempt?.id == ticket.id, ContinuousClock.now < ticket.expires else {
            throw DmAccountDirectoryError.unavailable
        }
        let snapshot = try index.read()
        var state = try decode(snapshot.payload)
        let storeId = local.store.storeID.uuidString.lowercased()
        guard state.epoch == ticket.epoch, state.selectedUserId == nil,
              state.accounts.contains(where: { $0.userId == userId && $0.storeId == storeId && $0.status == .ready }),
              session.currentContext()?.userId == userId else { throw DmAccountDirectoryError.unavailable }
        state.selectedUserId = userId
        _ = try commit(state, revision: snapshot.revision)
        guard !Task.isCancelled, ContinuousClock.now < ticket.expires else { throw DmAccountDirectoryError.unavailable }
        let access = VodozemacAccountAccess(store: local.store, coordinator: local.coordinator, session: session,
            scopeGuard: ScopeGuard(directory: self, ticket: ticket, userId: userId, storeId: storeId, selected: true),
            authority: { [weak self] in self?.authorizes(epoch: ticket.epoch, userId: userId, storeId: storeId) ?? false },
            logout: { [weak self] in
                guard let self else { throw DmAccountDirectoryError.unavailable }
                try self.signOut(expectedEpoch: ticket.epoch)
            }, userId: userId, deviceId: storeId, projectOrigin: authenticator.projectOrigin)
        currentAccess = access; attempt = nil
        return access
    }

    private func authorizes(epoch: UUID, userId: String, storeId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let state = try? readState() else { return false }
        return state.epoch == epoch && state.selectedUserId == userId
            && state.accounts.contains { $0.userId == userId && $0.storeId == storeId && $0.status == .ready }
    }

    private func withCurrentScope<T>(ticket: Attempt, userId: String, storeId: String, selected: Bool,
                                     operation: () throws -> T) throws -> T {
        // Fixed lock order: directory -> authenticated index transaction ->
        // AuthSession -> coordinator -> account store. The operation may not
        // await or call back into the directory/index. Every epoch commit on a
        // different SQLite handle/process waits for this writer reservation.
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, liveScopeID == ticket.id else { throw DmAccountDirectoryError.unavailable }
        return try index.withAuthoritySnapshotForResearch { snapshot in
            let state = try decode(snapshot.payload)
            guard state.epoch == ticket.epoch,
                  state.accounts.contains(where: { $0.userId == userId && $0.storeId == storeId && $0.status == .ready }) else {
                throw DmAccountDirectoryError.unavailable
            }
            if selected {
                guard state.selectedUserId == userId, currentAccess != nil else { throw DmAccountDirectoryError.unavailable }
            } else {
                guard state.selectedUserId == nil, attempt?.id == ticket.id, ContinuousClock.now < ticket.expires else {
                    throw DmAccountDirectoryError.unavailable
                }
            }
            return try operation()
        }
    }

    private func abandon(_ ticket: Attempt) {
        lock.lock(); defer { lock.unlock() }
        if attempt?.id == ticket.id { attempt = nil; liveScopeID = nil }
    }

    private func signOut(expectedEpoch: UUID?, hooks: TransitionHooksForResearch = .init()) throws {
        do {
            lock.lock(); defer { lock.unlock() }
            // Unconditional logout revokes local authority before even reading
            // storage. A stale expected-epoch logout must not revoke a newer
            // local selection; it validates its epoch before this step.
            if expectedEpoch == nil {
                verificationID = nil; attempt = nil; liveScopeID = nil; currentAccess?.invalidate(); currentAccess = nil
            }
            let snapshot = try index.read()
            var state = try decode(snapshot.payload)
            if let expectedEpoch, state.epoch != expectedEpoch { throw DmAccountDirectoryError.unavailable }
            verificationID = nil; attempt = nil; liveScopeID = nil; currentAccess?.invalidate(); currentAccess = nil
            let previous = state.selectedUserId.flatMap { user in state.accounts.first { $0.userId == user } }
            state.epoch = UUID(); state.selectedUserId = nil
            _ = try commit(state, revision: snapshot.revision)
            if let previous {
                do {
                    try hooks.afterIndexCommitBeforeDeactivation?()
                    try deactivate(previous, expectedEpoch: state.epoch, hooks: hooks)
                }
                catch {
                    if case DeactivationFailure.account(let cause) = error,
                       Self.permanentAccountFailure(cause) { try block(previous, epoch: state.epoch) }
                    throw error
                }
            }
        } catch { throw DmAccountDirectoryError.unavailable }
    }

    private func deactivate(_ entry: Entry, expectedEpoch: UUID, hooks: TransitionHooksForResearch) throws {
        // Caller already holds directory lock. The tombstone CAS alone is not
        // authority to reread/deactivate an account after another handle wins.
        // Keep index -> coordinator -> account order through the account CAS.
        try index.withAuthoritySnapshotForResearch { snapshot in
            let state = try decode(snapshot.payload)
            guard state.epoch == expectedEpoch, state.selectedUserId == nil,
                  entry.status == .ready, state.accounts.contains(entry) else {
                throw DeactivationFailure.superseded
            }
            try hooks.insideDeactivationAuthority?()
            do {
                let local = try reopenAccount(entry)
                defer { local.store.close() }
                let current = try local.coordinator.lifecycleForResearch()
                _ = try local.coordinator.deactivateAuthScopeForResearch(expected: current)
            } catch { throw DeactivationFailure.account(error) }
        }
    }

    private func reopenForSelection(_ entry: Entry, ticket: Attempt)
        throws -> (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator) {
        // A competing handle may have cleared selection but not yet closed the
        // old account. Account selection must still be a relogin, never an
        // active renewal that revives prior-generation ciphertext. Normalize
        // the target before initial Auth under this exact pending authority.
        // select() already holds directory lock; do not reacquire it here.
        var opened: (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator)?
        do {
            return try index.withAuthoritySnapshotForResearch { snapshot in
                let state = try decode(snapshot.payload)
                guard !Task.isCancelled, attempt?.id == ticket.id, liveScopeID == ticket.id,
                      ContinuousClock.now < ticket.expires, state.epoch == ticket.epoch,
                      state.selectedUserId == nil, entry.status == .ready, state.accounts.contains(entry) else {
                    throw DeactivationFailure.superseded
                }
                do {
                    let local = try reopenAccount(entry)
                    opened = local
                    let current = try local.coordinator.lifecycleForResearch()
                    if current.active { _ = try local.coordinator.deactivateAuthScopeForResearch(expected: current) }
                    return local
                } catch { throw DeactivationFailure.account(error) }
            }
        } catch { opened?.store.close(); throw error }
    }

    private func reopenAccount(_ entry: Entry) throws -> (store: VodozemacSealedStore, coordinator: VodozemacDmCoordinator) {
        guard let id = Self.canonicalUUID(entry.storeId) else { throw DmAccountDirectoryError.unavailable }
        let store = try VodozemacSealedStore.reopen(directory: accountURL(entry), storeID: id)
        do {
            let coordinator = try VodozemacDmCoordinator(store: store)
            let scope = try coordinator.authScopeForResearch()
            let binding = try JSONDecoder().decode(AccountBinding.self, from: store.read().payload)
            guard scope.storeID == id, scope.lifecycle.owner.userId == entry.userId,
                  scope.lifecycle.owner.deviceId == entry.storeId, scope.projectOrigin == authenticator.projectOrigin,
                  binding.version == 5, binding.owner.userId == entry.userId, binding.owner.deviceId == entry.storeId,
                  binding.authProjectOrigin == authenticator.projectOrigin,
                  binding.conversationId == conversationId, binding.identityKeyId == entry.identityKeyId else {
                throw DmAccountDirectoryError.unavailable
            }
            // Restore/authenticate the real provider account without changing
            // its pickle/prekeys/ratchet. This local signature is discarded and
            // never exported as a registration or device-attestation proof.
            let check = try signPublicRequest(accountPickle: binding.account, pickleKey: store.providerPickleKey(),
                message: Data("thalassa-research-local-account-reopen-v1\0".utf8))
            guard check.signingKey == binding.signingKey else { throw DmAccountDirectoryError.unavailable }
            return (store, coordinator)
        } catch { store.close(); throw error }
    }

    private func block(_ entry: Entry, epoch: UUID) throws {
        let snapshot = try index.read()
        var state = try decode(snapshot.payload)
        guard state.epoch == epoch,
              let position = state.accounts.firstIndex(where: { $0 == entry }) else { throw DmAccountDirectoryError.unavailable }
        state.accounts[position].status = .blocked
        _ = try commit(state, revision: snapshot.revision)
    }

    private func accountURL(_ entry: Entry) -> URL {
        directoryURL.appendingPathComponent(entry.storeId, isDirectory: true)
    }
    private func readState() throws -> State { try decode(index.read().payload) }
    private func decode(_ payload: Data) throws -> State {
        let state = try JSONDecoder().decode(State.self, from: payload)
        guard state.version == 1, state.containerId == containerID.uuidString.lowercased(),
              state.projectOrigin == authenticator.projectOrigin, state.conversationId == conversationId,
              state.accounts.count <= Self.capacity,
              Set(state.accounts.map(\.userId)).count == state.accounts.count,
              Set(state.accounts.map(\.storeId)).count == state.accounts.count,
              Set(state.accounts.map(\.identityKeyId)).count == state.accounts.count else {
            throw DmAccountDirectoryError.unavailable
        }
        for entry in state.accounts {
            guard Self.canonicalUUID(entry.userId) != nil, Self.canonicalUUID(entry.storeId) != nil,
                  Self.canonicalUUID(entry.identityKeyId) != nil,
                  entry.storeId != index.storeID.uuidString.lowercased() else { throw DmAccountDirectoryError.unavailable }
        }
        if let selected = state.selectedUserId {
            guard state.accounts.contains(where: { $0.userId == selected && $0.status == .ready }) else {
                throw DmAccountDirectoryError.unavailable
            }
        }
        try Self.requireType(directoryURL, .typeDirectory)
        let required = Set([Self.locatorName, index.storeID.uuidString.lowercased()])
        let allowed = required.union(state.accounts.map(\.storeId))
        let actual = Set(try FileManager.default.contentsOfDirectory(atPath: directoryURL.path))
        guard required.isSubset(of: actual), actual.isSubset(of: allowed) else { throw DmAccountDirectoryError.unavailable }
        try Self.requireType(directoryURL.appendingPathComponent(Self.locatorName), .typeRegular)
        guard try Self.readLocator(directoryURL.appendingPathComponent(Self.locatorName))
                == Data((index.storeID.uuidString.lowercased() + "\n").utf8) else {
            throw DmAccountDirectoryError.unavailable
        }
        try Self.requireType(directoryURL.appendingPathComponent(index.storeID.uuidString.lowercased()), .typeDirectory)
        return state
    }
    @discardableResult
    private func commit(_ state: State, revision: Int64) throws -> Int64 {
        let payload = try JSONEncoder().encode(state)
        _ = try decode(payload)
        return try index.commit(expectedRevision: revision, payload: payload)
    }

    private static func permanentAccountFailure(_ error: Error) -> Bool {
        if let error = error as? VodozemacSealedStoreError {
            switch error {
            case .missingDatabase, .missingKey, .authenticationFailed, .unsupportedDatabase, .invalidInput: return true
            default: return false
            }
        }
        if case DmCoordinatorError.unsupportedState = error { return true }
        if error is DmAccountDirectoryError || error is NativeCryptoError || error is DecodingError { return true }
        return false
    }
    private static func canonicalUUID(_ value: String) -> UUID? {
        guard let id = UUID(uuidString: value), id.uuidString.lowercased() == value else { return nil }
        return id
    }
    private static func requireType(_ url: URL, _ type: FileAttributeType) throws {
        guard url.isFileURL, url.path.utf8.count < 4000, !url.path.utf8.contains(0),
              try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == type else {
            throw DmAccountDirectoryError.unavailable
        }
    }
    private static func readLocator(_ url: URL) throws -> Data {
        try requireType(url, .typeRegular)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 38) ?? Data()
        guard data.count == 37 else { throw DmAccountDirectoryError.unavailable }
        return data
    }
    private static func protect(_ url: URL) throws {
        let directory = try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        try FileManager.default.setAttributes([.posixPermissions: directory ? 0o700 : 0o600], ofItemAtPath: url.path)
        var mutable = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try mutable.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        #endif
    }
    private static func syncDirectory(_ url: URL) throws {
        let descriptor = url.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw DmAccountDirectoryError.unavailable }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw DmAccountDirectoryError.unavailable }
    }
}
