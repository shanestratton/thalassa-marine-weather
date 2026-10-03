// ISOLATED NATIVE RESEARCH. Auth is supplied by synthetic URLProtocol responses;
// provider identities, native Keychain and sealed SQLite authority are real.
// No live login/relay, JS message API, physical-device or independent audit claim.
import Foundation
import Darwin
import SQLite3

enum DmMessageAuthorityProbeError: Error { case assertion(String) }

private final class DmMessageAuthorityChecks {
    private(set) var assertions = 0
    func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try value() else { throw DmMessageAuthorityProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { try require(true, label); return }
        throw DmMessageAuthorityProbeError.assertion(label)
    }
    func scopeRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmAccountDirectoryError.unavailable { try require(true, label); return }
        throw DmMessageAuthorityProbeError.assertion(label)
    }
    func busyRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.database(let code) where code == SQLITE_BUSY { try require(true, label); return }
        throw DmMessageAuthorityProbeError.assertion(label)
    }
}

private final class DmMessageAuthorityClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = ContinuousClock.now
    func now() -> ContinuousClock.Instant { lock.lock(); defer { lock.unlock() }; return instant }
    func advance(seconds: Int) { lock.lock(); instant = instant.advanced(by: .seconds(seconds)); lock.unlock() }
}

private final class DmMessageAuthorityFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    func read() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class DmMessageAuthorityGate: @unchecked Sendable {
    let arrived = DmMessageAuthorityFlag()
    private let lock = NSLock()
    private var released = false
    private let semaphore = DispatchSemaphore(value: 0)
    func hold() throws {
        arrived.set()
        guard semaphore.wait(timeout: .now() + 3) == .success else {
            throw DmMessageAuthorityProbeError.assertion("native authority fixture exceeded its bounded gate")
        }
    }
    func release() {
        lock.lock(); let signal = !released; released = true; lock.unlock()
        if signal { semaphore.signal() }
    }
}

private final class DmMessageAuthorityProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var users: [String: String] = [:]
    private static var requests = 0
    static func install(bearer: String, userId: String) {
        lock.lock(); users["Bearer " + bearer] = userId; lock.unlock()
    }
    static func count() -> Int { lock.lock(); defer { lock.unlock() }; return requests }
    static func reset() { lock.lock(); users.removeAll(); requests = 0; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "message-authority-auth.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let user = Self.users[request.value(forHTTPHeaderField: "Authorization") ?? ""]
        Self.requests += 1
        Self.lock.unlock()
        guard let user, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"id\":\"\(user)\",\"user_metadata\":{\"deviceId\":\"spoofed-device\"}}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func dmMessageAuthorityAuth() throws -> VodozemacSupabaseAuth {
    try VodozemacSupabaseAuth(projectOrigin: "https://message-authority-auth.invalid",
        publicApiKey: "sb_publishable_message_authority_fixture", deadlineSeconds: 3,
        configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmMessageAuthorityProtocol.self]
            return configuration
        })
}

private func dmMessageAuthorityAwait(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while !condition() {
        guard ContinuousClock.now < deadline else {
            throw DmMessageAuthorityProbeError.assertion("native authority fixture failed to arrive at barrier")
        }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private final class DmMessageAuthorityFixture {
    static let conversationId = "native-message-authority-fixture"
    let directory: VodozemacAccountDirectory
    let root: URL
    let index: VodozemacSealedStore
    private var ownedIDs: Set<UUID> = []
    private var handles: [VodozemacSealedStore] = []
    private var competitors: [VodozemacAccountDirectory] = []
    private var destroyed = false
    init(auth: VodozemacSupabaseAuth) throws {
        directory = try VodozemacAccountDirectory.create(parentDirectory: FileManager.default.temporaryDirectory,
            authenticator: auth, conversationId: Self.conversationId)
        root = directory.directoryURL
        let locator = try String(contentsOf: root.appendingPathComponent("index-id"), encoding: .utf8)
        guard let id = UUID(uuidString: String(locator.dropLast())), locator == id.uuidString.lowercased() + "\n" else {
            throw DmMessageAuthorityProbeError.assertion("native authority fixture locator")
        }
        index = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(id.uuidString.lowercased()), storeID: id)
        ownedIDs.insert(id)
    }
    private func rows() throws -> [[String: Any]] {
        guard let state = try JSONSerialization.jsonObject(with: index.read().payload) as? [String: Any],
              let rows = state["accounts"] as? [[String: Any]] else {
            throw DmMessageAuthorityProbeError.assertion("sealed authority fixture index")
        }
        for row in rows {
            guard let name = row["storeId"] as? String, let id = UUID(uuidString: name), name == id.uuidString.lowercased() else {
                throw DmMessageAuthorityProbeError.assertion("native authority fixture namespace")
            }
            ownedIDs.insert(id)
        }
        return rows
    }
    func account(userId: String, beforeCommitForResearch: (() throws -> Void)? = nil) throws -> (VodozemacSealedStore, VodozemacDmCoordinator) {
        guard let row = try rows().first(where: { $0["userId"] as? String == userId }),
              let name = row["storeId"] as? String, let id = UUID(uuidString: name) else {
            throw DmMessageAuthorityProbeError.assertion("native authority fixture account")
        }
        let store = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(name), storeID: id)
        handles.append(store)
        return (store, try VodozemacDmCoordinator(store: store, beforeCommitForResearch: beforeCommitForResearch))
    }
    func reopen(auth: VodozemacSupabaseAuth) throws -> VodozemacAccountDirectory {
        let competitor = try VodozemacAccountDirectory.reopen(directory: root, authenticator: auth,
            conversationId: Self.conversationId)
        competitors.append(competitor)
        return competitor
    }
    func destroy() throws {
        guard !destroyed else { return }
        _ = try rows()
        try? directory.signOut()
        directory.closeForResearch()
        for competitor in competitors { competitor.closeForResearch() }
        for handle in handles { handle.close() }
        index.close()
        // Delete ONLY this fixture's validated UUID namespaces and exact known
        // SQLite files. Never infer key namespaces from unauthenticated state.
        let fm = FileManager.default
        let names = Set(try fm.contentsOfDirectory(atPath: root.path))
        let allowed = Set(ownedIDs.map { $0.uuidString.lowercased() }).union(["index-id"])
        guard names.isSubset(of: allowed) else { throw DmMessageAuthorityProbeError.assertion("authority cleanup exact container") }
        for id in ownedIDs {
            let name = id.uuidString.lowercased()
            guard names.contains(name) else { continue }
            let leaf = root.appendingPathComponent(name)
            guard try fm.attributesOfItem(atPath: leaf.path)[.type] as? FileAttributeType == .typeDirectory else {
                throw DmMessageAuthorityProbeError.assertion("authority cleanup exact directory")
            }
            let files = Set(try fm.contentsOfDirectory(atPath: leaf.path))
            guard files.isSubset(of: ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]) else {
                throw DmMessageAuthorityProbeError.assertion("authority cleanup exact SQLite leaves")
            }
            for file in files {
                let url = leaf.appendingPathComponent(file)
                guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular,
                      url.path.withCString({ Darwin.unlink($0) }) == 0 else {
                    throw DmMessageAuthorityProbeError.assertion("authority cleanup exact SQLite file")
                }
            }
            try VodozemacSealedStore.deleteResearchKey(storeID: id)
            guard leaf.path.withCString({ Darwin.rmdir($0) }) == 0 else {
                throw DmMessageAuthorityProbeError.assertion("authority cleanup empty leaf")
            }
        }
        let locator = root.appendingPathComponent("index-id")
        guard names.contains("index-id"), try fm.attributesOfItem(atPath: locator.path)[.type] as? FileAttributeType == .typeRegular,
              locator.path.withCString({ Darwin.unlink($0) }) == 0,
              root.path.withCString({ Darwin.rmdir($0) }) == 0 else {
            throw DmMessageAuthorityProbeError.assertion("authority cleanup exact locator and empty container")
        }
        destroyed = true
    }
}

private func dmMessageAuthorityLogin(_ facade: VodozemacSessionFacade, user: String, bearer: String) async throws -> DmSessionAccount {
    DmMessageAuthorityProtocol.install(bearer: bearer, userId: user)
    let fence = try facade.fenceSession(mode: .verify)
    return try await facade.authenticate(accessToken: bearer, authFence: fence.authFence)
}

private func dmMessageAuthorityIdentity(_ facade: VodozemacSessionFacade,
                                         snapshot: DmNativeMessageSnapshot) throws -> DmPublicIdentity {
    switch try facade.executeMessageOperation(snapshot: snapshot, operation: .publicIdentity) {
    case .publicIdentity(let identity): return identity
    default: throw DmMessageAuthorityProbeError.assertion("closed native dispatcher returned wrong result")
    }
}

/// A fixture assertion count, not an audit or live auth/message success claim.
func runDmMessageAuthorityProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    DmMessageAuthorityProtocol.reset()
    defer { DmMessageAuthorityProtocol.reset() }
    let checks = DmMessageAuthorityChecks(), auth = try dmMessageAuthorityAuth()
    let alice = "10000000-0000-4000-8000-000000000001", bob = "20000000-0000-4000-8000-000000000002"
    var fixtures: [DmMessageAuthorityFixture] = []
    func fixture() throws -> DmMessageAuthorityFixture {
        let result = try DmMessageAuthorityFixture(auth: auth); fixtures.append(result); return result
    }
    func refusesUnchanged(_ facade: VodozemacSessionFacade, snapshot: DmNativeMessageSnapshot,
                          store: VodozemacSealedStore, label: String) throws {
        let before = try store.read(), called = DmMessageAuthorityFlag(), count = DmMessageAuthorityProtocol.count()
        try checks.refuses(label) {
            _ = try facade.executeMessageOperationForResearch(snapshot: snapshot, operation: .publicIdentity,
                hooks: .init(insideAuthority: { called.set() }))
        }
        try checks.require(try !called.read() && store.read() == before && DmMessageAuthorityProtocol.count() == count,
            label + " runs no body, Auth request or sealed mutation")
    }
    do {
        progressForResearch?("message-authority-binding-and-logout")
        do {
            let controlled = try fixture(), facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.alice")
            let (store, _) = try controlled.account(userId: alice)
            let before = try store.read()
            try checks.refuses("SDK/public credential binding cannot mint another native lease") {
                _ = try facade.messageSnapshot(credentialBinding: UUID().uuidString.lowercased())
            }
            try checks.require(try store.read() == before, "invalid binding leaves sealed account unchanged")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let identity = try dmMessageAuthorityIdentity(facade, snapshot: snapshot)
            try checks.require(identity.userId == alice && identity.deviceId == account.deviceId,
                "closed dispatcher returns only the accepted native account public identity")
            try checks.require(snapshot.context == snapshot.credential.context && snapshot.context.userId == account.accountId
                && snapshot.context.deviceId == account.deviceId && snapshot.context.peerGeneration == nil,
                "native snapshot retains exact credential context without caller owner claims")
            try checks.require(String(describing: snapshot) == "NativeMessageSnapshot(<native-only>)"
                && String(reflecting: snapshot) == "NativeMessageSnapshot(<native-only>)"
                && !String(describing: snapshot.credential).contains("fixture.authority.alice"),
                "native snapshot and credential diagnostics remain redacted")
            try checks.require(facade.currentMessageContext(snapshot: snapshot) == snapshot.context,
                "dispatch/completion callback validates exact current snapshot")
            let foreignFacade = VodozemacSessionFacade(directory: controlled.directory)
            try refusesUnchanged(foreignFacade, snapshot: snapshot, store: store, label: "foreign facade cannot execute native snapshot")
            _ = try facade.fenceSession(mode: .signOut)
            try checks.require(facade.currentMessageContext(snapshot: snapshot) == nil && facade.currentAccount() == nil,
                "logout invalidates both public mapping and captured native network context")
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "logout-stale native snapshot refuses read/commit")
            let next = try await dmMessageAuthorityLogin(facade, user: bob, bearer: "fixture.authority.bob")
            let (bobStore, _) = try controlled.account(userId: bob)
            let bobSnapshot = try facade.messageSnapshot(credentialBinding: next.credentialBinding)
            try checks.require(bobSnapshot.context.userId == bob && next.deviceId != account.deviceId,
                "explicit signOut-to-verify switch selects a distinct immutable native device")
            try refusesUnchanged(facade, snapshot: snapshot, store: bobStore, label: "old owner snapshot cannot operate on switched account")
            try checks.refuses("old public binding cannot mint current switched-account credential") {
                _ = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            }
        }

        progressForResearch?("message-authority-renewal")
        do {
            let controlled = try fixture(), facade = VodozemacSessionFacade(directory: controlled.directory)
            let original = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.renew-before")
            let snapshot = try facade.messageSnapshot(credentialBinding: original.credentialBinding)
            let (store, _) = try controlled.account(userId: alice)
            let pending = try facade.fenceSession(mode: .verify)
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "renewal reservation fences prior snapshot before SDK/Auth await")
            DmMessageAuthorityProtocol.install(bearer: "fixture.authority.renew-after", userId: alice)
            let renewed = try await facade.authenticate(accessToken: "fixture.authority.renew-after", authFence: pending.authFence)
            let next = try facade.messageSnapshot(credentialBinding: renewed.credentialBinding)
            try checks.require(next.context.ownerGeneration == snapshot.context.ownerGeneration
                && next.context.credentialEpoch != snapshot.context.credentialEpoch
                && renewed.credentialBinding != original.credentialBinding,
                "same-owner renewal preserves generation but rotates exact epoch and opaque binding")
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "old snapshot cannot adopt successful renewed lease")
            try checks.require(try dmMessageAuthorityIdentity(facade, snapshot: next).userId == alice,
                "new native snapshot executes after verified same-owner renewal")
        }

        progressForResearch?("message-authority-session-renewal-and-generations")
        do {
            let controlled = try fixture()
            DmMessageAuthorityProtocol.install(bearer: "fixture.authority.direct-access", userId: alice)
            let access = try await controlled.directory.open(bearer: "fixture.authority.direct-access")
            let facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.direct-facade")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let (store, _) = try controlled.account(userId: alice)
            DmMessageAuthorityProtocol.install(bearer: "fixture.authority.direct-renewal", userId: alice)
            _ = try await access.authenticate(bearer: "fixture.authority.direct-renewal")
            try checks.require(facade.currentAccount() == nil && facade.currentMessageContext(snapshot: snapshot) == nil,
                "AuthSession renewal outside facade cannot upgrade its unchanged original scope")
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "exact credential epoch is required even when facade revision did not change")
        }
        do {
            let controlled = try fixture(), peerFixture = try fixture()
            let facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.peer-owner")
            let peerFacade = VodozemacSessionFacade(directory: peerFixture.directory)
            let peerAccount = try await dmMessageAuthorityLogin(peerFacade, user: bob, bearer: "fixture.authority.peer-identity")
            let peerSnapshot = try peerFacade.messageSnapshot(credentialBinding: peerAccount.credentialBinding)
            let peer = try dmMessageAuthorityIdentity(peerFacade, snapshot: peerSnapshot)
            let (store, coordinator) = try controlled.account(userId: alice)
            let owner = try coordinator.lifecycleForResearch().owner
            // Full OOB public identity is sealed through the real closed native
            // authority path; a server lookup or partial key never creates trust.
            let card = DmPairingCard(projectOrigin: "https://message-authority-auth.invalid",
                conversationId: DmMessageAuthorityFixture.conversationId, identity: peer)
            let ownerSnapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            _ = try facade.executeMessageOperation(snapshot: ownerSnapshot,
                operation: .confirmPeer(card: card, confirmedFingerprint: try card.fingerprint()))
            try checks.require(try coordinator.peerForResearch(owner: owner, generation: 1).identityKeyId == peer.identityKeyId,
                "closed confirmation seals the exact explicit peer public identity")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding, peerGeneration: 1)
            try checks.require(snapshot.context.peerGeneration == 1 && facade.currentMessageContext(snapshot: snapshot) == snapshot.context,
                "snapshot retains the exact coordinator-validated optional peer generation")
            _ = try coordinator.setPeerStatusForResearch(.changed, owner: owner)
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "peer-generation change rejects captured authority")
            try checks.require(facade.currentMessageContext(snapshot: snapshot) == nil,
                "peer-generation change refuses transport dispatch/completion")
            let unpairedSnapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            _ = try coordinator.advanceOwnerGenerationForResearch(owner: owner)
            try refusesUnchanged(facade, snapshot: unpairedSnapshot, store: store, label: "owner-generation change rejects captured authority")
        }

        progressForResearch?("message-authority-closed-pre-CAS")
        do {
            let controlled = try fixture(), peerFixture = try fixture()
            let facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.CAS-owner")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let peerFacade = VodozemacSessionFacade(directory: peerFixture.directory)
            let peerAccount = try await dmMessageAuthorityLogin(peerFacade, user: bob, bearer: "fixture.authority.CAS-peer")
            let peerSnapshot = try peerFacade.messageSnapshot(credentialBinding: peerAccount.credentialBinding)
            let identity = try dmMessageAuthorityIdentity(peerFacade, snapshot: peerSnapshot)
            // Explicit full out-of-band public identity confirmation fixture;
            // not a relay/server lookup that silently establishes trust.
            let card = DmPairingCard(projectOrigin: "https://message-authority-auth.invalid",
                conversationId: DmMessageAuthorityFixture.conversationId, identity: identity)
            let fingerprint = try card.fingerprint(), expired = DmMessageAuthorityFlag()
            let (store, coordinator) = try controlled.account(userId: alice, beforeCommitForResearch: { expired.set() })
            let before = try store.read(), beforeIndex = try controlled.index.read(), checkedAfterHook = DmMessageAuthorityFlag()
            // Direct CLOSED coordinator fixture isolates its final CAS checker.
            // Production goes through facade/Directory/index/Auth authority.
            try checks.refuses("closed mutating command refuses authority that expires immediately before sealed CAS") {
                _ = try coordinator.executeMessageOperation(.confirmPeer(card: card, confirmedFingerprint: fingerprint),
                    context: snapshot.context, checkAuthority: {
                        if expired.read() { checkedAfterHook.set(); throw DmSessionFacadeError.unavailable }
                    })
            }
            try checks.require(expired.read() && checkedAfterHook.read(),
                "closed coordinator invokes authority checker AFTER actual beforeCommit fixture hook")
            try checks.require(try store.read() == before && controlled.index.read() == beforeIndex,
                "late pre-CAS refusal leaves exact account/index revision and payload unchanged")
            try checks.require(facade.currentMessageContext(snapshot: snapshot) == snapshot.context,
                "refused peer confirmation neither rebinds peer nor invalidates authenticated owner")
        }

        progressForResearch?("message-authority-sealed-update-and-commit")
        do {
            // A standalone native-owned store isolates the real transaction
            // seams without corrupting an account/index payload for a fixture.
            let storeID = UUID()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(storeID.uuidString.lowercased(), isDirectory: true)
            let store = try VodozemacSealedStore.create(directory: directory, storeID: storeID,
                initialPayload: Data("{\"fixture\":\"authority-before\"}".utf8))
            do {
                let before = try store.read(), nextPayload = Data("{\"fixture\":\"authority-after\"}".utf8)
                for refusalCall in [1, 2] {
                    var calls = 0
                    try checks.refuses(refusalCall == 1
                        ? "sealed authority refusal immediately before UPDATE prevents mutation"
                        : "sealed authority refusal immediately before COMMIT rolls back prior UPDATE") {
                        _ = try store.commit(expectedRevision: before.revision, payload: nextPayload, checkAuthority: {
                            calls += 1
                            if calls == refusalCall { throw DmSessionFacadeError.unavailable }
                        })
                    }
                    try checks.require(calls == refusalCall,
                        "sealed store reaches the exact requested transaction authority seam")
                    try checks.require(try store.read() == before,
                        "authority refusal leaves exact revision and payload unchanged on original handle")
                    let reopened = try VodozemacSealedStore.reopen(directory: directory, storeID: storeID)
                    defer { reopened.close() }
                    try checks.require(try reopened.read() == before,
                        "authority refusal leaves exact durable revision and payload unchanged after reopen")
                }
                var calls = 0
                let nextRevision = try store.commit(expectedRevision: before.revision, payload: nextPayload,
                    checkAuthority: { calls += 1 })
                try checks.require(calls == 2 && nextRevision == before.revision + 1,
                    "successful sealed commit checks both transaction seams and advances one revision")
                let committed = try store.read()
                try checks.require(committed.revision == nextRevision && committed.payload == nextPayload && calls == 2,
                    "successful sealed write publishes only committed payload and read does not re-invoke checker")
                let reopened = try VodozemacSealedStore.reopen(directory: directory, storeID: storeID)
                do { try checks.require(try reopened.read() == committed, "successful guarded commit survives exact native reopen") }
                catch { reopened.close(); throw error }
                reopened.close()
                try store.destroyForTesting()
            } catch {
                try? store.destroyForTesting()
                throw error
            }
        }

        progressForResearch?("message-authority-deadlines")
        do {
            let controlled = try fixture(), clock = DmMessageAuthorityClock()
            let facade = VodozemacSessionFacade(directory: controlled.directory, clockForResearch: clock.now)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.deadline")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let (store, _) = try controlled.account(userId: alice)
            let before = try store.read(), beforeIndex = try controlled.index.read(), called = DmMessageAuthorityFlag()
            try checks.refuses("clock crossing inside held authority refuses before closed coordinator dispatch") {
                _ = try facade.executeMessageOperationForResearch(snapshot: snapshot, operation: .publicIdentity,
                    hooks: .init(insideAuthority: { called.set(); clock.advance(seconds: 61) }))
            }
            try checks.require(try called.read() && store.read() == before && controlled.index.read() == beforeIndex,
                "deadline crossing publishes no result and leaves exact sealed account/index bytes unchanged")
            try checks.require(facade.currentMessageContext(snapshot: snapshot) == nil && facade.currentAccount() == nil,
                "original facade deadline expires despite later inner AuthSession lease")
            try checks.refuses("expired public binding cannot obtain native credential") {
                _ = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            }
        }
        do {
            let controlled = try fixture()
            DmMessageAuthorityProtocol.install(bearer: "fixture.authority.tight-initial", userId: alice)
            _ = try await controlled.directory.open(bearer: "fixture.authority.tight-initial")
            let deadline = ContinuousClock.now.advanced(by: .seconds(2))
            let reservation = try controlled.directory.reserveVerification(expiresBy: deadline)
            DmMessageAuthorityProtocol.install(bearer: "fixture.authority.tight-renewal", userId: alice)
            let scope = try await controlled.directory.authenticate(bearer: "fixture.authority.tight-renewal", reservation: reservation)
            let credential = try scope.messageCredential(peerGeneration: nil, checkAuthority: {})
            let (store, _) = try controlled.account(userId: alice)
            let before = try store.read(), beforeIndex = try controlled.index.read()
            try checks.require(reservation.expires == deadline && scope.currentContext() == credential.context,
                "native messaging scope retains original tightened reservation deadline")
            try await ContinuousClock().sleep(until: deadline, tolerance: .zero)
            try checks.scopeRefuses("tightened scope deadline cannot be extended by inner AuthSession lease") {
                _ = try scope.executeMessageOperation(.publicIdentity, context: credential.context, checkAuthority: {})
            }
            try checks.require(try store.read() == before && controlled.index.read() == beforeIndex,
                "expired original scope executes no sealed mutation")
        }

        // All gates are synchronous. The other task may await scheduling, but no
        // authority lock is retained across an await by the messaging operation.
        for (mode, label) in [(DmSessionFenceMode.signOut, "message-authority-held-logout"), (.verify, "message-authority-held-renewal")] {
            progressForResearch?(label)
            let controlled = try fixture(), facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.held-\(fixtures.count)")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let gate = DmMessageAuthorityGate(), transitionStarted = DmMessageAuthorityFlag(), transitionFinished = DmMessageAuthorityFlag()
            let operation = Task.detached {
                try facade.executeMessageOperationForResearch(snapshot: snapshot, operation: .publicIdentity,
                    hooks: .init(insideAuthority: { try gate.hold() }))
            }
            defer { gate.release(); operation.cancel() }
            try await dmMessageAuthorityAwait(gate.arrived.read)
            let transition = Task.detached {
                transitionStarted.set()
                let fence = try facade.fenceSession(mode: mode)
                transitionFinished.set()
                return fence
            }
            defer { transition.cancel() }
            try await dmMessageAuthorityAwait(transitionStarted.read)
            try checks.require(!transitionFinished.read(), "facade transition cannot revoke a held synchronous message operation")
            gate.release()
            switch try await operation.value {
            case .publicIdentity(let identity): try checks.require(identity.userId == alice, "held operation finishes on its original authority")
            default: throw DmMessageAuthorityProbeError.assertion("held dispatcher result")
            }
            _ = try await transition.value
            try checks.require(transitionFinished.read() && facade.currentMessageContext(snapshot: snapshot) == nil,
                "queued transition wins only after synchronous authority releases")
        }

        progressForResearch?("message-authority-held-cross-directory-epoch")
        do {
            let controlled = try fixture(), facade = VodozemacSessionFacade(directory: controlled.directory)
            let account = try await dmMessageAuthorityLogin(facade, user: alice, bearer: "fixture.authority.cross-directory")
            let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            let competitor = try controlled.reopen(auth: auth)
            let gate = DmMessageAuthorityGate(), started = DmMessageAuthorityFlag(), finished = DmMessageAuthorityFlag()
            let operation = Task.detached {
                try facade.executeMessageOperationForResearch(snapshot: snapshot, operation: .publicIdentity,
                    hooks: .init(insideAuthority: { try gate.hold() }))
            }
            defer { gate.release(); operation.cancel() }
            try await dmMessageAuthorityAwait(gate.arrived.read)
            // Prove an ACTUAL competing epoch CAS reached SQLite and was
            // refused. A merely-started background task is not lock evidence.
            try controlled.index.failImmediatelyOnBusyForResearch()
            let beforeIndex = try controlled.index.read()
            guard var nextState = try JSONSerialization.jsonObject(with: beforeIndex.payload) as? [String: Any] else {
                throw DmMessageAuthorityProbeError.assertion("held authority exact index payload")
            }
            nextState["epoch"] = UUID().uuidString
            let nextPayload = try JSONSerialization.data(withJSONObject: nextState, options: [.sortedKeys])
            try checks.busyRefuses("actual cross-handle epoch CAS hits SQLITE_BUSY while message authority holds index") {
                _ = try controlled.index.commit(expectedRevision: beforeIndex.revision, payload: nextPayload)
            }
            try checks.require(try controlled.index.read() == beforeIndex,
                "refused concurrent epoch CAS changes neither index payload nor revision")
            let transition = Task.detached {
                started.set(); try competitor.signOut(); finished.set()
            }
            defer { transition.cancel() }
            try await dmMessageAuthorityAwait(started.read)
            try checks.require(!finished.read(), "sealed index writer reservation holds cross-directory epoch change through operation")
            gate.release()
            _ = try await operation.value
            try await transition.value
            try checks.require(finished.read() && facade.currentMessageContext(snapshot: snapshot) == nil && facade.currentAccount() == nil,
                "cross-directory durable logout invalidates unchanged local facade revision")
            let (store, _) = try controlled.account(userId: alice)
            try refusesUnchanged(facade, snapshot: snapshot, store: store, label: "stale durable directory epoch refuses operation body")
        }

        for controlled in fixtures.reversed() { try controlled.destroy() }
        return checks.assertions
    } catch {
        for controlled in fixtures.reversed() { try? controlled.destroy() }
        throw error
    }
}
