// ISOLATED RESEARCH ONLY. Auth responses and bearer strings are URLProtocol
// fixtures. Account/store creation uses the pinned REAL native provider and
// actual Keychain/sealed SQLite storage. No live Supabase, device registration,
// physical-phone/locked-device/crash-durability or production activation claim.
import Foundation
import Darwin
import SQLite3

enum DmAccountDirectoryProbeError: Error { case assertion(String) }

private final class DmAccountDirectoryChecks {
    private(set) var assertions = 0
    func require(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try value() else { throw DmAccountDirectoryProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmAccountDirectoryError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func refuses(_ label: String, _ operation: () async throws -> VodozemacAccountAccess) async throws {
        do { _ = try await operation() }
        catch DmAccountDirectoryError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func succeeds(_ label: String, _ operation: () async throws -> VodozemacAccountAccess) async throws -> VodozemacAccountAccess {
        do { return try await operation() }
        catch let error as DmAccountDirectoryProbeError { throw error }
        catch { throw DmAccountDirectoryProbeError.assertion(label) }
    }
    func refreshRefuses(_ label: String, _ operation: () async throws -> DmLifecycleSnapshot) async throws {
        do { _ = try await operation() }
        catch DmAccountDirectoryError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func transitionRefuses(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch DmAccountDirectoryError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func sessionRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func sessionAuthRefuses(_ label: String, _ operation: () async throws -> DmSessionAccount) async throws {
        do { _ = try await operation() }
        catch DmSessionFacadeError.unavailable { try require(true, label); return }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func sessionAuthSucceeds(_ label: String, _ operation: () async throws -> DmSessionAccount) async throws -> DmSessionAccount {
        do { return try await operation() }
        catch let error as DmAccountDirectoryProbeError { throw error }
        catch { throw DmAccountDirectoryProbeError.assertion(label) }
    }
    func busyRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.database(let code) where code == SQLITE_BUSY {
            try require(true, label); return
        }
        throw DmAccountDirectoryProbeError.assertion(label)
    }
    func fenced(_ access: VodozemacAccountAccess, _ label: String) throws {
        try require(access.currentContext() == nil, label + " context")
        try refuses(label + " credential") { _ = try access.credential() }
    }
}

private final class DmAccountDirectoryGate: @unchecked Sendable {
    private let lock = NSLock()
    private var released = false
    private var arrived = false
    private var callbacks: [() -> Void] = []
    func afterRelease(_ callback: @escaping () -> Void) {
        lock.lock()
        if released { lock.unlock(); callback(); return }
        callbacks.append(callback); lock.unlock()
    }
    func release() {
        lock.lock(); released = true; let callbacks = self.callbacks; self.callbacks.removeAll(); lock.unlock()
        for callback in callbacks { callback() }
    }
    private func markArrived() { lock.lock(); arrived = true; lock.unlock() }
    func hasArrived() -> Bool { lock.lock(); defer { lock.unlock() }; return arrived }
    func arriveAndWait() async throws {
        markArrived()
        await withCheckedContinuation { continuation in afterRelease { continuation.resume() } }
        guard !Task.isCancelled else { throw DmAccountDirectoryProbeError.assertion("cancelled native mutation fixture") }
    }
}

private final class DmAccountDirectoryCommitGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var arrived = false
    private var released = false
    private let timeoutSeconds: Double
    init(timeoutSeconds: Double = 3) { self.timeoutSeconds = timeoutSeconds }
    func hold() throws {
        lock.lock(); arrived = true; lock.unlock()
        guard semaphore.wait(timeout: .now() + timeoutSeconds) == .success else {
            throw DmAccountDirectoryProbeError.assertion("held native transition fixture exceeded bound")
        }
    }
    func hasArrived() -> Bool { lock.lock(); defer { lock.unlock() }; return arrived }
    func release() {
        lock.lock()
        let shouldSignal = !released
        released = true
        lock.unlock()
        if shouldSignal { semaphore.signal() }
    }
}

// Advances only this native facade fixture's monotonic deadline. Directory and
// transport still use their ordinary clocks; no real minute-long sleeps or SDK.
private final class DmSessionFacadeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = ContinuousClock.now
    func now() -> ContinuousClock.Instant { lock.lock(); defer { lock.unlock() }; return instant }
    func advance(seconds: Int) {
        lock.lock(); defer { lock.unlock() }
        instant = instant.advanced(by: .seconds(seconds))
    }
}

private final class DmAccountDirectoryProtocol: URLProtocol, @unchecked Sendable {
    struct Script {
        var body: Data
        var status = 200
        var gate: DmAccountDirectoryGate?
        init(userId: String) {
            // Untrusted metadata explicitly tries to choose a different owner
            // and device; only the native verified top-level UUID may win.
            body = Data("{\"id\":\"\(userId)\",\"user_metadata\":{\"id\":\"spoofed-owner\",\"deviceId\":\"spoofed-device\"}}".utf8)
        }
    }
    private static let fixtureLock = NSLock()
    private static var scripts: [String: [Script]] = [:]
    private static var requests: [String: Int] = [:]
    private let stateLock = NSLock()
    private var stopped = false
    static func install(_ values: [Script], bearer: String) {
        fixtureLock.lock(); scripts["Bearer " + bearer] = values; fixtureLock.unlock()
    }
    static func count(_ bearer: String) -> Int {
        fixtureLock.lock(); defer { fixtureLock.unlock() }; return requests["Bearer " + bearer] ?? 0
    }
    static func reset() { fixtureLock.lock(); scripts.removeAll(); requests.removeAll(); fixtureLock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool {
        ["enrollment-auth.invalid", "other-enrollment-auth.invalid"].contains(request.url?.host ?? "")
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.fixtureLock.lock()
        let bearer = request.value(forHTTPHeaderField: "Authorization") ?? ""
        let script = Self.scripts[bearer]?.first
        if (Self.scripts[bearer]?.count ?? 0) > 1 { Self.scripts[bearer]?.removeFirst() }
        Self.requests[bearer, default: 0] += 1
        Self.fixtureLock.unlock()
        guard let script else { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return }
        let callback = { [self] in DispatchQueue.global().async { [self] in deliver(script) } }
        if let gate = script.gate { gate.afterRelease(callback) } else { callback() }
    }
    private func deliver(_ script: Script) {
        guard !isStopped(), let url = request.url else { return }
        let response = HTTPURLResponse(url: url, statusCode: script.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        guard !isStopped() else { return }
        client?.urlProtocol(self, didLoad: script.body)
        guard !isStopped() else { return }
        client?.urlProtocolDidFinishLoading(self)
    }
    private func isStopped() -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopped }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

private func dmAccountDirectoryAuth(project: String = "https://enrollment-auth.invalid") throws -> VodozemacSupabaseAuth {
    try VodozemacSupabaseAuth(projectOrigin: project, publicApiKey: "sb_publishable_enrollment_fixture", deadlineSeconds: 3,
        configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmAccountDirectoryProtocol.self]
            return configuration
        })
}

private func dmAccountDirectoryAwaitRequest(_ bearer: String, count: Int = 1) async throws {
    let bound = ContinuousClock.now.advanced(by: .seconds(3))
    while DmAccountDirectoryProtocol.count(bearer) < count {
        guard ContinuousClock.now < bound else { throw DmAccountDirectoryProbeError.assertion("enrollment fixture request did not start") }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private func dmAccountDirectoryAwaitMutation(_ arrived: () -> Bool) async throws {
    let bound = ContinuousClock.now.advanced(by: .seconds(3))
    while !arrived() {
        guard ContinuousClock.now < bound else { throw DmAccountDirectoryProbeError.assertion("native mutation fixture did not reach barrier") }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private final class DmAccountDirectoryFixture {
    static let conversationId = "paired-native-enrollment-fixture"
    let root: URL
    let indexID: UUID
    let indexURL: URL
    let index: VodozemacSealedStore
    let directory: VodozemacAccountDirectory
    private var ownedIDs: Set<UUID> = []
    private var removed = false
    init(auth: VodozemacSupabaseAuth) throws {
        directory = try VodozemacAccountDirectory.create(parentDirectory: FileManager.default.temporaryDirectory,
            authenticator: auth, conversationId: Self.conversationId)
        root = directory.directoryURL
        let locator = try String(contentsOf: root.appendingPathComponent("index-id"), encoding: .utf8)
        guard let id = UUID(uuidString: String(locator.dropLast())), locator == id.uuidString.lowercased() + "\n" else {
            throw DmAccountDirectoryProbeError.assertion("native fixture locator")
        }
        indexID = id
        indexURL = root.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
        index = try VodozemacSealedStore.reopen(directory: indexURL, storeID: id)
        ownedIDs.insert(id)
    }
    func state() throws -> [String: Any] {
        guard let state = try JSONSerialization.jsonObject(with: index.read().payload) as? [String: Any] else {
            throw DmAccountDirectoryProbeError.assertion("sealed directory fixture state")
        }
        return state
    }
    func rows() throws -> [[String: Any]] {
        guard let rows = try state()["accounts"] as? [[String: Any]] else {
            throw DmAccountDirectoryProbeError.assertion("sealed account binding fixture rows")
        }
        for row in rows {
            guard let value = row["storeId"] as? String, let id = UUID(uuidString: value), value == id.uuidString.lowercased() else {
                throw DmAccountDirectoryProbeError.assertion("native fixture store UUID")
            }
            ownedIDs.insert(id)
        }
        return rows
    }
    func account(userId: String) throws -> (id: UUID, url: URL, store: VodozemacSealedStore) {
        guard let row = try rows().first(where: { $0["userId"] as? String == userId }),
              let value = row["storeId"] as? String, let id = UUID(uuidString: value) else {
            throw DmAccountDirectoryProbeError.assertion("native fixture account binding")
        }
        let url = root.appendingPathComponent(value, isDirectory: true)
        return (id, url, try VodozemacSealedStore.reopen(directory: url, storeID: id))
    }
    func reopen(auth: VodozemacSupabaseAuth) throws -> VodozemacAccountDirectory {
        try VodozemacAccountDirectory.reopen(directory: root, authenticator: auth, conversationId: Self.conversationId)
    }
    func destroy() throws {
        guard !removed else { return }
        // Capture every native reservation while the index remains authentic.
        // Loss/corruption cases capture before fault injection, never discover
        // arbitrary namespaces from a damaged DB or Keychain prefix.
        _ = try? rows()
        try? directory.signOut()
        directory.closeForResearch()
        index.close()
        let fm = FileManager.default
        let allowed = Set(ownedIDs.map { $0.uuidString.lowercased() }).union(["index-id"])
        let actual = Set(try fm.contentsOfDirectory(atPath: root.path))
        guard actual.isSubset(of: allowed) else { throw DmAccountDirectoryProbeError.assertion("cleanup only owned enrollment namespaces") }
        for id in ownedIDs {
            let url = root.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
            if !actual.contains(id.uuidString.lowercased()) { continue }
            guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeDirectory else {
                throw DmAccountDirectoryProbeError.assertion("cleanup owned enrollment leaf type")
            }
            let names = Set(try fm.contentsOfDirectory(atPath: url.path))
            guard names.isSubset(of: ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]) else {
                throw DmAccountDirectoryProbeError.assertion("cleanup owned enrollment leaf contents")
            }
            for name in names {
                let file = url.appendingPathComponent(name)
                guard try fm.attributesOfItem(atPath: file.path)[.type] as? FileAttributeType == .typeRegular,
                      file.path.withCString({ Darwin.unlink($0) }) == 0 else {
                    throw DmAccountDirectoryProbeError.assertion("cleanup exact enrollment file")
                }
            }
            try VodozemacSealedStore.deleteResearchKey(storeID: id)
            guard url.path.withCString({ Darwin.rmdir($0) }) == 0 else {
                throw DmAccountDirectoryProbeError.assertion("cleanup empty enrollment leaf")
            }
        }
        let locator = root.appendingPathComponent("index-id")
        if actual.contains("index-id") {
            guard try fm.attributesOfItem(atPath: locator.path)[.type] as? FileAttributeType == .typeRegular,
                  locator.path.withCString({ Darwin.unlink($0) }) == 0 else {
                throw DmAccountDirectoryProbeError.assertion("cleanup exact native locator")
            }
        }
        guard root.path.withCString({ Darwin.rmdir($0) }) == 0 else {
            throw DmAccountDirectoryProbeError.assertion("cleanup empty enrollment container")
        }
        removed = true
    }
    deinit { if !removed { try? destroy() } }
}

private func dmAccountDirectoryIdentityMatches(_ lhs: DmPublicIdentity, _ rhs: DmPublicIdentity) -> Bool {
    lhs.userId == rhs.userId && lhs.deviceId == rhs.deviceId && lhs.identityKeyId == rhs.identityKeyId
        && lhs.signingKey == rhs.signingKey && lhs.curve == rhs.curve && lhs.prekey == rhs.prekey
}

// Compare native fixture state without its one deliberately rotated credential
// field. Secret-bearing payloads stay inside this disposable native fixture;
// only a fixed assertion label/count escapes, never these bytes.
private func dmAccountDirectoryPayloadWithout(_ field: String, payload: Data) throws -> Data {
    guard var state = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
          state.removeValue(forKey: field) != nil else {
        throw DmAccountDirectoryProbeError.assertion("native continuity fixture comparison field")
    }
    return try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
}

private func dmAccountDirectoryCard(_ facade: VodozemacSessionFacade, account: DmSessionAccount) throws -> DmPairingCard {
    let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
    guard case .pairingCard(let card) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingCard) else {
        throw DmAccountDirectoryProbeError.assertion("native continuity fixture pairing result")
    }
    return card
}

private func dmAccountDirectoryThread(_ facade: VodozemacSessionFacade, snapshot: DmNativeMessageSnapshot) throws -> DmNativeThread {
    guard case .thread(let thread) = try facade.executeMessageOperation(snapshot: snapshot, operation: .thread) else {
        throw DmAccountDirectoryProbeError.assertion("native continuity fixture thread result")
    }
    return thread
}

/// Disposable native runner entry point. Only the nonsecret assertion count
/// and optional fixed research progress labels escape. A callback must return
/// promptly and must not call back into the fixture's native stores or facade.
/// Expected failures carry fixed labels, never Auth bodies/keys/tokens.
public func runAccountDirectoryProbeForResearch(progressForResearch: (@Sendable (String) -> Void)? = nil) async throws -> Int {
    do { return try await dmAccountDirectoryRun(progressForResearch: progressForResearch) }
    catch let error as DmAccountDirectoryProbeError { throw error }
    catch { throw DmAccountDirectoryProbeError.assertion("native enrollment probe unexpected setup or storage failure") }
}

private func dmAccountDirectoryRun(progressForResearch: (@Sendable (String) -> Void)?) async throws -> Int {
    progressForResearch?("directory-setup")
    let checks = DmAccountDirectoryChecks()
    let auth = try dmAccountDirectoryAuth()
    let alice = "11111111-1111-4111-8111-111111111111"
    let bob = "22222222-2222-4222-8222-222222222222"
    DmAccountDirectoryProtocol.reset()
    var fixtures: [DmAccountDirectoryFixture] = []
    var handles: [VodozemacSealedStore] = []
    var accesses: [VodozemacAccountAccess] = []
    var directories: [VodozemacAccountDirectory] = []
    defer {
        for access in accesses { access.closeForResearch() }
        for directory in directories { directory.closeForResearch() }
        for handle in handles { handle.close() }
        for fixture in fixtures { try? fixture.destroy() }
        DmAccountDirectoryProtocol.reset()
    }
    func fixture() throws -> DmAccountDirectoryFixture {
        let fixture = try DmAccountDirectoryFixture(auth: auth)
        fixtures.append(fixture); return fixture
    }
    func install(_ bearer: String, user: String = "11111111-1111-4111-8111-111111111111") {
        DmAccountDirectoryProtocol.install([.init(userId: user)], bearer: bearer)
    }
    func open(_ fixture: DmAccountDirectoryFixture, bearer: String, user: String) async throws -> VodozemacAccountAccess {
        install(bearer, user: user)
        let access = try await checks.succeeds("positive native enrollment unexpectedly refused") {
            try await fixture.directory.open(bearer: bearer)
        }
        accesses.append(access)
        return access
    }

    progressForResearch?("directory-baseline-create-primary")
    let primary = try fixture()
    progressForResearch?("directory-baseline-create-peer")
    let peer = try fixture()
    progressForResearch?("directory-baseline-open-primary")
    let a = try await open(primary, bearer: "fixture.enrollment.alice", user: alice)
    progressForResearch?("directory-baseline-open-peer")
    let b = try await open(peer, bearer: "fixture.enrollment.bob", user: bob)
    let al = try a.lifecycleForResearch(), bl = try b.lifecycleForResearch()
    let ai = try a.coordinatorForResearch.publicIdentity(owner: al.owner)
    let bi = try b.coordinatorForResearch.publicIdentity(owner: bl.owner)
    try checks.require(al.owner.userId == alice && bl.owner.userId == bob && al.active && bl.active,
        "server-verified top-level UUIDs own fresh native identities")
    try checks.require(UUID(uuidString: ai.deviceId)?.uuidString.lowercased() == ai.deviceId
        && UUID(uuidString: bi.deviceId)?.uuidString.lowercased() == bi.deviceId && ai.deviceId != bi.deviceId,
        "native UUID factory chooses unique devices rather than caller metadata")
    try checks.require(DmAccountDirectoryProtocol.count("fixture.enrollment.alice") == 2
        && DmAccountDirectoryProtocol.count("fixture.enrollment.bob") == 2,
        "selection verification and existing session verification both execute")
    try checks.require(try primary.state()["projectOrigin"] as? String == auth.projectOrigin
        && primary.state()["conversationId"] as? String == DmAccountDirectoryFixture.conversationId,
        "sealed index pins trusted project and one paired native conversation")
    try checks.require(try primary.rows().count == 1 && peer.rows().count == 1,
        "each verified account has exactly one atomic native binding")
    try checks.require(a.currentContext() != nil && b.currentContext() != nil,
        "only completed directory and Auth commits expose current context")
    let accountA = try primary.account(userId: alice), accountB = try peer.account(userId: bob)
    handles.append(accountA.store); handles.append(accountB.store)
    try checks.require(accountA.id.uuidString.lowercased() == ai.deviceId
        && accountB.id.uuidString.lowercased() == bi.deviceId,
        "device IDs match the immutable native sealed-store UUIDs")
    for fixture in [primary, peer] {
        for leaf in [fixture.indexURL, fixture.root.appendingPathComponent(fixture === primary ? ai.deviceId : bi.deviceId)] {
            for name in try FileManager.default.contentsOfDirectory(atPath: leaf.path) where name != "snapshot.sqlite-shm" {
                let data = try Data(contentsOf: leaf.appendingPathComponent(name))
                try checks.require(data.range(of: Data(alice.utf8)) == nil && data.range(of: Data(bob.utf8)) == nil,
                    "account identity is absent from unsealed index and store bytes")
            }
        }
    }

    // Real provider encryption and durable exact-ciphertext preservation across
    // same-scope refresh; direct peer pins remain explicit research fixtures.
    progressForResearch?("directory-baseline-refresh")
    try a.coordinatorForResearch.installPeerForResearch(DmPeerContext(userId: bi.userId, deviceId: bi.deviceId,
        identityKeyId: bi.identityKeyId, curve: bi.curve, prekey: bi.prekey, generation: 1, status: .accepted), owner: al.owner)
    try b.coordinatorForResearch.installPeerForResearch(DmPeerContext(userId: ai.userId, deviceId: ai.deviceId,
        identityKeyId: ai.identityKeyId, curve: ai.curve, prekey: ai.prekey, generation: 1, status: .accepted), owner: bl.owner)
    let sender = ai.deviceId < bi.deviceId ? a : b
    let senderFixture = ai.deviceId < bi.deviceId ? primary : peer
    let senderUser = ai.deviceId < bi.deviceId ? alice : bob
    let beforeRefresh = try sender.lifecycleForResearch()
    let ciphertext = try sender.coordinatorForResearch.prepare(clientMessageId: "native-enrollment-pending",
        text: "offline enrollment refresh payload", owner: beforeRefresh.owner, peerGeneration: 1)
    install("fixture.enrollment.refresh", user: senderUser)
    let afterRefresh = try await sender.authenticate(bearer: "fixture.enrollment.refresh")
    try checks.require(beforeRefresh.owner == afterRefresh.owner && beforeRefresh.credentialEpoch != afterRefresh.credentialEpoch,
        "same-account refresh retains generation and advances native credential epoch")
    try checks.require(try sender.coordinatorForResearch.pending(owner: afterRefresh.owner, peerGeneration: 1) == [ciphertext],
        "real encrypted pending ciphertext is byte-identical after refresh")
    progressForResearch?("directory-baseline-reopen")
    let oldCapturedContext = sender.currentContext()
    let reopened = try senderFixture.reopen(auth: auth)
    directories.append(reopened)
    install("fixture.enrollment.reopen", user: senderUser)
    let resumed = try await checks.succeeds("positive strict native account reopen unexpectedly refused") {
        try await reopened.open(bearer: "fixture.enrollment.reopen")
    }
    accesses.append(resumed)
    let resumedLifecycle = try resumed.lifecycleForResearch()
    try checks.fenced(sender, "another directory selection fences old access")
    try checks.require(oldCapturedContext != resumed.currentContext() && resumedLifecycle.owner.generation > afterRefresh.owner.generation,
        "relogin advances generation and does not reuse captured context")
    try checks.require(try resumed.coordinatorForResearch.pending(owner: resumedLifecycle.owner, peerGeneration: 1).isEmpty,
        "old-generation pending ciphertext is not rebound on relogin")
    let originalIdentity = senderUser == alice ? ai : bi
    try checks.require(try dmAccountDirectoryIdentityMatches(originalIdentity,
        resumed.coordinatorForResearch.publicIdentity(owner: resumedLifecycle.owner)),
        "reopen keeps exact native identity keys and original device UUID")
    try checks.refuses("old access cannot sign out a newer directory epoch") { try sender.signOut() }
    try checks.require(resumed.currentContext() != nil, "stale access logout leaves newer selection usable")
    try resumed.signOut()
    try checks.fenced(resumed, "local directory logout clears current access")

    // A -> B -> A must keep independent immutable stores, never rebind keys.
    progressForResearch?("directory-baseline-account-switch")
    let switched = try await open(primary, bearer: "fixture.enrollment.switch", user: bob)
    let switchedLife = try switched.lifecycleForResearch()
    try checks.require(switchedLife.owner.userId == bob && switchedLife.owner.deviceId != ai.deviceId,
        "different verified account receives its own native device identity")
    let restoredA = try await open(primary, bearer: "fixture.enrollment.return", user: alice)
    try checks.fenced(switched, "account switching fences prior account access")
    let restoredLife = try restoredA.lifecycleForResearch()
    try checks.require(try dmAccountDirectoryIdentityMatches(ai, restoredA.coordinatorForResearch.publicIdentity(owner: restoredLife.owner)),
        "return to first account reopens immutable existing identity")
    try checks.require(try primary.rows().count == 2, "account switching never creates duplicate account bindings")
    try checks.refuses("wrong trusted project cannot reopen native index") {
        _ = try primary.reopen(auth: dmAccountDirectoryAuth(project: "https://other-enrollment-auth.invalid"))
    }
    try checks.refuses("wrong paired conversation cannot reopen native index") {
        _ = try VodozemacAccountDirectory.reopen(directory: primary.root, authenticator: auth, conversationId: "different-native-pair")
    }
    progressForResearch?("directory-baseline-refresh-logout")
    let refreshGate = DmAccountDirectoryGate()
    defer { refreshGate.release() }
    var refreshHeld = DmAccountDirectoryProtocol.Script(userId: alice); refreshHeld.gate = refreshGate
    DmAccountDirectoryProtocol.install([refreshHeld], bearer: "fixture.enrollment.refresh-logout")
    let lateRefresh = Task { try await restoredA.authenticate(bearer: "fixture.enrollment.refresh-logout") }
    try await dmAccountDirectoryAwaitRequest("fixture.enrollment.refresh-logout")
    try primary.directory.signOut()
    refreshGate.release()
    try await checks.refreshRefuses("directory logout rejects an in-flight facade refresh") { try await lateRefresh.value }
    try checks.fenced(restoredA, "directory logout cannot restore old facade readiness")
    try checks.require(try !restoredA.coordinatorForResearch.lifecycleForResearch().active,
        "ordinary refresh response cannot reactivate the signed-out native lifecycle")

    // These barriers are after the facade's preliminary check but BEFORE each
    // native mutation guard. Exact account snapshots after revocation prove
    // that neither a stale reservation nor activation/cleanup committed.
    for beforeBegin in [true, false] {
        progressForResearch?(beforeBegin ? "directory-guard-pre-begin" : "directory-guard-pre-complete")
        let guardedFixture = try fixture()
        let suffix = beforeBegin ? "pre-begin" : "pre-complete"
        let access = try await open(guardedFixture, bearer: "fixture.enrollment.guarded-open." + suffix, user: alice)
        let account = try guardedFixture.account(userId: alice); handles.append(account.store)
        let revoker = try guardedFixture.reopen(auth: auth); directories.append(revoker)
        let mutationGate = DmAccountDirectoryGate()
        let token = "fixture.enrollment.guarded-refresh." + suffix
        install(token)
        let hooks = DmAuthMutationHooksForResearch(
            beforeBegin: beforeBegin ? { try await mutationGate.arriveAndWait() } : nil,
            beforeComplete: beforeBegin ? nil : { try await mutationGate.arriveAndWait() })
        let task = Task { try await access.authenticateForResearch(bearer: token, hooks: hooks) }
        defer { mutationGate.release(); task.cancel() }
        try await dmAccountDirectoryAwaitMutation(mutationGate.hasArrived)
        try revoker.signOut()
        let signedOut = try account.store.read()
        try checks.require(try !VodozemacDmCoordinator(store: account.store).lifecycleForResearch().active,
            "revoker established native inactive baseline before stale mutation")
        mutationGate.release()
        try await checks.refreshRefuses("revoked directory guard refuses before native begin or complete") { try await task.value }
        try checks.require(try account.store.read() == signedOut,
            "stale native mutation leaves sealed account revision and payload EXACTLY unchanged after revocation")
        try checks.require(DmAccountDirectoryProtocol.count(token) == (beforeBegin ? 0 : 1),
            "pre-begin refusal sends no Auth and pre-complete refusal uses only its already-verified response")
        try checks.fenced(access, "revoked mutation cannot expose an old facade lease")
    }

    progressForResearch?("directory-guard-ordered-renewal")
    do {
        let ordered = try fixture()
        let access = try await open(ordered, bearer: "fixture.enrollment.ordered-open", user: alice)
        let account = try ordered.account(userId: alice); handles.append(account.store)
        let gate = DmAccountDirectoryGate()
        install("fixture.enrollment.ordered-old")
        let older = Task {
            try await access.authenticateForResearch(bearer: "fixture.enrollment.ordered-old",
                hooks: .init(beforeBegin: { try await gate.arriveAndWait() }))
        }
        defer { gate.release(); older.cancel() }
        try await dmAccountDirectoryAwaitMutation(gate.hasArrived)
        install("fixture.enrollment.ordered-new")
        _ = try await access.authenticate(bearer: "fixture.enrollment.ordered-new")
        let newest = try account.store.read()
        let newestContext = access.currentContext()
        gate.release()
        try await checks.refreshRefuses("older guarded begin waiter cannot supersede a newer same-account renewal") { try await older.value }
        try checks.require(try account.store.read() == newest && access.currentContext() == newestContext && newestContext != nil,
            "rejected older invocation preserves the newer exact sealed state and in-memory lease")
        try checks.require(DmAccountDirectoryProtocol.count("fixture.enrollment.ordered-old") == 0,
            "superseded pre-begin waiter performs no Auth request")
    }

    // The first handle has durably cleared selection but has not yet captured
    // an account lifecycle to deactivate. A second handle completes relogin in
    // that exact gap. The obsolete first handle must never reread/deactivate the
    // winner, nor tombstone its ready binding. The winner must also close the
    // still-active old generation before Auth, rather than treating relogin as
    // refresh and reviving prior-generation pending ciphertext.
    for logout in [false, true] {
        progressForResearch?(logout ? "directory-deactivation-gap-logout" : "directory-deactivation-gap-begin")
        let interrupted = try fixture()
        let suffix = logout ? "logout" : "begin"
        let original = try await open(interrupted, bearer: "fixture.enrollment.deactivation-open." + suffix, user: alice)
        let originalLife = try original.lifecycleForResearch()
        // A native UUID sender sorts before this valid research peer device.
        // Public provider keys are real; ownership/peer pins remain fixtures.
        try original.coordinatorForResearch.installPeerForResearch(DmPeerContext(userId: bob,
            deviceId: "zz-deactivation-fixture-peer", identityKeyId: bi.identityKeyId,
            curve: bi.curve, prekey: bi.prekey, generation: 1, status: .accepted), owner: originalLife.owner)
        let pending = try original.coordinatorForResearch.prepare(clientMessageId: "deactivation-gap-" + suffix,
            text: "offline obsolete deactivation race payload", owner: originalLife.owner, peerGeneration: 1)
        try checks.require(try original.coordinatorForResearch.pending(owner: originalLife.owner, peerGeneration: 1) == [pending],
            "gap fixture starts with real original-generation pending ciphertext")
        let account = try interrupted.account(userId: alice); handles.append(account.store)
        let originalAccount = try account.store.read()
        let competitor = try interrupted.reopen(auth: auth); directories.append(competitor)
        let gate = DmAccountDirectoryCommitGate(timeoutSeconds: 10)
        let obsoleteToken = "fixture.enrollment.deactivation-obsolete." + suffix
        install(obsoleteToken)
        let hooks = VodozemacAccountDirectory.TransitionHooksForResearch(afterIndexCommitBeforeDeactivation: gate.hold)
        let obsolete = Task {
            if logout { try interrupted.directory.signOutForResearch(hooks: hooks) }
            else { _ = try await interrupted.directory.openForResearch(bearer: obsoleteToken, fault: .none, hooks: hooks) }
        }
        defer { gate.release(); obsolete.cancel() }
        try await dmAccountDirectoryAwaitMutation(gate.hasArrived)
        try checks.require(try interrupted.state()["selectedUserId"] == nil && account.store.read() == originalAccount,
            "post-index barrier precedes any obsolete account deactivation")
        let winnerToken = "fixture.enrollment.deactivation-winner." + suffix
        install(winnerToken)
        let winner = try await checks.succeeds("second handle could not complete relogin in deactivation gap") {
            try await competitor.open(bearer: winnerToken)
        }
        accesses.append(winner)
        let winnerLife = try winner.lifecycleForResearch()
        try checks.require(winnerLife.active && winnerLife.owner.generation > originalLife.owner.generation,
            "gap relogin advances generation instead of renewing the still-active old account")
        try checks.require(try winner.coordinatorForResearch.pending(owner: winnerLife.owner, peerGeneration: 1).isEmpty,
            "gap relogin cannot expose or rebind original-generation pending ciphertext")
        let winnerAccount = try account.store.read(), winnerIndex = try interrupted.index.read()
        let winnerContext = winner.currentContext()
        try checks.require(winnerContext != nil, "gap winner installs its own guarded native lease")
        gate.release()
        try await checks.transitionRefuses("obsolete transition refuses before capturing the winner lifecycle") { try await obsolete.value }
        try checks.require(try account.store.read() == winnerAccount,
            "obsolete transition leaves winner sealed account revision and payload EXACTLY unchanged")
        try checks.require(try interrupted.index.read() == winnerIndex,
            "obsolete deactivation cannot alter or tombstone the winner sealed index")
        try checks.require(winner.currentContext() == winnerContext && (try? winner.credential()) != nil,
            "obsolete transition cannot erase the newer native lease")
        try checks.require(DmAccountDirectoryProtocol.count(obsoleteToken) == 0
            && DmAccountDirectoryProtocol.count(winnerToken) == 2,
            "obsolete begin dispatches no Auth while winning selection completes both verified stages")
        try checks.fenced(original, "original access remains fenced after competing gap relogin")
    }

    // The shared deactivation body must hold index authority while capturing
    // and CASing the account lifecycle, not merely check an epoch beforehand.
    // A separate native SQLite handle proves actual writer exclusion.
    progressForResearch?("directory-deactivation-authority")
    do {
        let serial = try fixture()
        let access = try await open(serial, bearer: "fixture.enrollment.deactivation-serial-open", user: alice)
        let account = try serial.account(userId: alice); handles.append(account.store)
        let accountBefore = try account.store.read()
        let writer = try VodozemacSealedStore.reopen(directory: serial.indexURL, storeID: serial.indexID)
        handles.append(writer)
        try writer.failImmediatelyOnBusyForResearch()
        let gate = DmAccountDirectoryCommitGate()
        let task = Task {
            try serial.directory.signOutForResearch(hooks: .init(insideDeactivationAuthority: gate.hold))
        }
        defer { gate.release(); task.cancel() }
        try await dmAccountDirectoryAwaitMutation(gate.hasArrived)
        let tombstone = try writer.read()
        var nextEpoch = try serial.state()
        nextEpoch["epoch"] = UUID().uuidString
        let nextPayload = try JSONSerialization.data(withJSONObject: nextEpoch, options: [.sortedKeys])
        try checks.busyRefuses("cross-handle epoch writer cannot enter held deactivation authority") {
            _ = try writer.commit(expectedRevision: tombstone.revision, payload: nextPayload)
        }
        try checks.require(try writer.read() == tombstone && account.store.read() == accountBefore,
            "blocked epoch writer and pre-lifecycle deactivation barrier mutate neither sealed store")
        gate.release()
        try await task.value
        try checks.require(try !VodozemacDmCoordinator(store: account.store).lifecycleForResearch().active,
            "authorized deactivation completes while its exact tombstone owns index authority")
        try checks.require(try writer.read() == tombstone,
            "deactivation authority transaction itself does not advance index revision")
        let deactivated = try account.store.read()
        _ = try writer.commit(expectedRevision: tombstone.revision, payload: nextPayload)
        try checks.require(try writer.read().revision == tombstone.revision + 1 && account.store.read() == deactivated,
            "new epoch commits only after deactivation gate releases without another account mutation")
        try checks.fenced(access, "authorized logout keeps the old facade unavailable")
    }

    // A real competing index EPOCH COMMIT reports SQLITE_BUSY while completion
    // holds the authenticated writer reservation. No timing/sleep assertion is
    // used to infer that a background writer has reached the transaction.
    progressForResearch?("directory-completion-authority")
    do {
        let serial = try fixture()
        let access = try await open(serial, bearer: "fixture.enrollment.serial-open", user: alice)
        let account = try serial.account(userId: alice); handles.append(account.store)
        let writer = try VodozemacSealedStore.reopen(directory: serial.indexURL, storeID: serial.indexID)
        handles.append(writer)
        try writer.failImmediatelyOnBusyForResearch()
        let before = try writer.read()
        var nextEpoch = try serial.state()
        nextEpoch["epoch"] = UUID().uuidString
        let nextPayload = try JSONSerialization.data(withJSONObject: nextEpoch, options: [.sortedKeys])
        let completionGate = DmAccountDirectoryCommitGate()
        install("fixture.enrollment.serial-refresh")
        let task = Task {
            try await access.authenticateForResearch(bearer: "fixture.enrollment.serial-refresh",
                hooks: .init(insideComplete: completionGate.hold))
        }
        defer { completionGate.release(); task.cancel() }
        try await dmAccountDirectoryAwaitMutation(completionGate.hasArrived)
        try checks.busyRefuses("cross-handle index epoch commit cannot enter while native completion authority is held") {
            _ = try writer.commit(expectedRevision: before.revision, payload: nextPayload)
        }
        try checks.require(try writer.read() == before, "blocked epoch writer changes no sealed index bytes or revision")
        completionGate.release()
        let refreshed = try await task.value
        try checks.require(refreshed.active && access.currentContext() != nil,
            "native completion succeeds while its authenticated directory scope remains current")
        try checks.require(try writer.read() == before, "read-only authority transaction does not advance index revision")
        let completedAccount = try account.store.read()
        _ = try writer.commit(expectedRevision: before.revision, payload: nextPayload)
        try checks.require(try writer.read().revision == before.revision + 1,
            "cross-handle epoch commit succeeds only after the native completion guard releases")
        try checks.require(try account.store.read() == completedAccount,
            "later directory epoch commit cannot cause an additional old-session account commit")
        try checks.fenced(access, "serialized later epoch revocation fences the completed access")
    }

    // Native auth-control facade only: these account/credential results are NOT
    // private-message readiness or accepted peer/device trust. Auth remains a
    // URLProtocol fixture; provider ciphertext, Keychain and sealed CAS are real.
    progressForResearch?("directory-facade-initial-setup")
    do {
        let controlled = try fixture()
        let facade = VodozemacSessionFacade(directory: controlled.directory)
        let initialToken = "fixture.session.initial"
        install(initialToken)
        let initialIndex = try controlled.index.read()
        progressForResearch?("directory-facade-initial-fence")
        let initialFence = try facade.fenceSession(mode: .verify)
        let reservedIndex = try controlled.index.read()
        try checks.require(UUID(uuidString: initialFence.authFence)?.uuidString.lowercased() == initialFence.authFence,
            "auth facade issues an opaque native canonical UUID fence")
        try checks.require(try reservedIndex.revision == initialIndex.revision + 1 && reservedIndex.payload != initialIndex.payload
            && (try controlled.state()["selectedUserId"]) == nil && (try controlled.rows()).isEmpty,
            "initial facade fence durably changes the index before any account provisioning or SDK token request")
        try checks.require(DmAccountDirectoryProtocol.count(initialToken) == 0 && facade.currentAccount() == nil,
            "native verify fence itself dispatches zero Auth and publishes no account mapping")
        progressForResearch?("directory-facade-initial-authenticate")
        let initial = try await checks.sessionAuthSucceeds("fresh facade cannot establish verified native account") {
            try await facade.authenticate(accessToken: initialToken, authFence: initialFence.authFence)
        }
        progressForResearch?("directory-facade-initial-account")
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let coordinator = try VodozemacDmCoordinator(store: account.store)
        let initialLife = try coordinator.lifecycleForResearch()
        try checks.require(initial.accountId == alice && initial.deviceId == account.id.uuidString.lowercased()
            && initial.serverVerified && UUID(uuidString: initial.credentialBinding) != nil
            && facade.currentAccount() == initial && DmAccountDirectoryProtocol.count(initialToken) == 2,
            "first facade authentication verifies both selection and native lease and returns only native account binding")
        progressForResearch?("directory-facade-pending-ciphertext")
        try coordinator.installPeerForResearch(DmPeerContext(userId: bob, deviceId: "zz-session-facade-peer",
            identityKeyId: bi.identityKeyId, curve: bi.curve, prekey: bi.prekey, generation: 1, status: .accepted), owner: initialLife.owner)
        let ciphertext = try coordinator.prepare(clientMessageId: "session-facade-pending",
            text: "offline native auth facade renewal payload", owner: initialLife.owner, peerGeneration: 1)
        let indexBeforeRenewal = try controlled.index.read()
        let renewalToken = "fixture.session.renewal"
        install(renewalToken)
        progressForResearch?("directory-facade-renewal-fence")
        let renewalFence = try facade.fenceSession(mode: .verify)
        let reservedLife = try coordinator.lifecycleForResearch()
        try checks.require(try reservedLife.active && reservedLife.owner == initialLife.owner
            && reservedLife.credentialEpoch != initialLife.credentialEpoch
            && (try coordinator.pending(owner: reservedLife.owner, peerGeneration: 1)) == [ciphertext],
            "pre-SDK renewal fence rotates durable credentials but preserves generation and real exact pending ciphertext")
        try checks.require(try controlled.index.read() == indexBeforeRenewal
            && DmAccountDirectoryProtocol.count(renewalToken) == 0 && facade.currentAccount() == nil,
            "pre-SDK renewal clears public account readiness without changing directory selection or dispatching Auth")
        let reservedAccount = try account.store.read()
        progressForResearch?("directory-facade-invalid-fences")
        let foreign = try fixture()
        let foreignFacade = VodozemacSessionFacade(directory: foreign.directory)
        let foreignFence = try foreignFacade.fenceSession(mode: .verify)
        for (suffix, fence) in [("unknown", UUID().uuidString.lowercased()),
                                ("foreign", foreignFence.authFence), ("reused", initialFence.authFence)] {
            let token = "fixture.session.refused." + suffix
            install(token)
            try await checks.sessionAuthRefuses("unknown, foreign or used facade fence refuses before Auth") {
                try await facade.authenticate(accessToken: token, authFence: fence)
            }
            try checks.require(try DmAccountDirectoryProtocol.count(token) == 0
                && (try account.store.read()) == reservedAccount && (try controlled.index.read()) == indexBeforeRenewal
                && facade.currentAccount() == nil,
                "refused opaque fence preserves exact pending native account/index reservation without an HTTP request")
        }
        progressForResearch?("directory-facade-renewal-authenticate")
        let renewed = try await checks.sessionAuthSucceeds("legitimate renewal was consumed by an invalid facade fence") {
            try await facade.authenticate(accessToken: renewalToken, authFence: renewalFence.authFence)
        }
        let renewedLife = try coordinator.lifecycleForResearch()
        try checks.require(try renewed.accountId == initial.accountId && renewed.deviceId == initial.deviceId
            && renewed.credentialBinding != initial.credentialBinding && facade.currentAccount() == renewed
            && renewedLife.owner == initialLife.owner && (try coordinator.pending(owner: renewedLife.owner, peerGeneration: 1)) == [ciphertext]
            && DmAccountDirectoryProtocol.count(renewalToken) == 1,
            "live same-account facade renewal uses one Auth read, keeps native identity/generation and exact pending bytes")
        progressForResearch?("directory-facade-completed-replay")
        let renewedAccount = try account.store.read(), renewedIndex = try controlled.index.read()
        let replayToken = "fixture.session.completed-replay"
        install(replayToken)
        try await checks.sessionAuthRefuses("completed facade fence is single-use even with a different bearer") {
            try await facade.authenticate(accessToken: replayToken, authFence: renewalFence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(replayToken) == 0 && facade.currentAccount() == renewed
            && (try account.store.read()) == renewedAccount && (try controlled.index.read()) == renewedIndex,
            "a used fence cannot erase the accepted native account mapping or mutate its sealed state")

        progressForResearch?("directory-facade-ordered-renewal")
        let oldGate = DmAccountDirectoryGate()
        var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = oldGate
        let oldToken = "fixture.session.ordered-old"
        DmAccountDirectoryProtocol.install([held], bearer: oldToken)
        let oldFence = try facade.fenceSession(mode: .verify)
        let older = Task { try await facade.authenticate(accessToken: oldToken, authFence: oldFence.authFence) }
        defer { oldGate.release(); older.cancel() }
        try await dmAccountDirectoryAwaitRequest(oldToken)
        let winningToken = "fixture.session.ordered-winner"
        install(winningToken)
        progressForResearch?("directory-facade-ordered-winner-fence")
        let winningFence = try facade.fenceSession(mode: .verify)
        progressForResearch?("directory-facade-ordered-winner-authenticate")
        let winner = try await checks.sessionAuthSucceeds("newer same-facade renewal could not complete") {
            try await facade.authenticate(accessToken: winningToken, authFence: winningFence.authFence)
        }
        let winnerAccount = try account.store.read(), winnerIndex = try controlled.index.read()
        progressForResearch?("directory-facade-ordered-stale-completion")
        oldGate.release()
        try await checks.sessionAuthRefuses("late facade renewal cannot publish over a newer accepted account") { try await older.value }
        try checks.require(try facade.currentAccount() == winner && (try account.store.read()) == winnerAccount
            && (try controlled.index.read()) == winnerIndex,
            "stale same-facade completion preserves EXACT winner index/account snapshots and public mapping")
        try checks.require(try DmAccountDirectoryProtocol.count(oldToken) == 1 && DmAccountDirectoryProtocol.count(winningToken) == 1
            && (try coordinator.lifecycleForResearch()).owner == initialLife.owner
            && (try coordinator.pending(owner: initialLife.owner, peerGeneration: 1)) == [ciphertext],
            "newer renewal preserves real pending ciphertext and neither completion repeats its Auth request")
    }

    // Claim consumes a facade fence before await, but a duplicate must not
    // abandon/clear the legitimate claimant's native directory reservation.
    progressForResearch?("directory-facade-duplicate-claim")
    do {
        let controlled = try fixture()
        let facade = VodozemacSessionFacade(directory: controlled.directory)
        let gate = DmAccountDirectoryGate()
        var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
        let token = "fixture.session.duplicate-winner"
        DmAccountDirectoryProtocol.install([held], bearer: token)
        let fence = try facade.fenceSession(mode: .verify)
        let legitimate = Task { try await facade.authenticate(accessToken: token, authFence: fence.authFence) }
        defer { gate.release(); legitimate.cancel() }
        try await dmAccountDirectoryAwaitRequest(token)
        let claimedIndex = try controlled.index.read()
        let duplicateToken = "fixture.session.duplicate-refused"
        install(duplicateToken)
        try await checks.sessionAuthRefuses("duplicate in-flight facade claimant refuses without abandoning its winner") {
            try await facade.authenticate(accessToken: duplicateToken, authFence: fence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(duplicateToken) == 0
            && (try controlled.index.read()) == claimedIndex && (try controlled.rows()).isEmpty,
            "duplicate in-flight claimant dispatches zero HTTP and leaves exact legitimate initial reservation intact")
        gate.release()
        let winner = try await checks.sessionAuthSucceeds("duplicate claimant cancelled legitimate facade authentication") {
            try await legitimate.value
        }
        try checks.require(winner.accountId == alice && winner.serverVerified && facade.currentAccount() == winner
            && DmAccountDirectoryProtocol.count(token) == 2,
            "legitimate initial facade claimant still completes both Auth reads after duplicate refusal")
    }

    // Both selection verification and the later session verification can be
    // stale across directory handles. No late cleanup may mutate the winner.
    for secondStage in [false, true] {
        progressForResearch?(secondStage ? "directory-facade-cross-handle-lease" : "directory-facade-cross-handle-selection")
        let controlled = try fixture()
        let first = VodozemacSessionFacade(directory: controlled.directory)
        let competitor = try controlled.reopen(auth: auth); directories.append(competitor)
        let second = VodozemacSessionFacade(directory: competitor)
        let suffix = secondStage ? "lease" : "selection"
        let gate = DmAccountDirectoryGate()
        var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
        let token = "fixture.session.cross-handle-old." + suffix
        DmAccountDirectoryProtocol.install(secondStage ? [.init(userId: alice), held] : [held], bearer: token)
        let fence = try first.fenceSession(mode: .verify)
        let older = Task { try await first.authenticate(accessToken: token, authFence: fence.authFence) }
        defer { gate.release(); older.cancel() }
        try await dmAccountDirectoryAwaitRequest(token, count: secondStage ? 2 : 1)
        let beforeWinnerRows = try controlled.rows()
        let winningToken = "fixture.session.cross-handle-winner." + suffix
        install(winningToken)
        let winningFence = try second.fenceSession(mode: .verify)
        let winner = try await checks.sessionAuthSucceeds("second directory cannot establish current initial facade scope") {
            try await second.authenticate(accessToken: winningToken, authFence: winningFence.authFence)
        }
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let winnerAccount = try account.store.read(), winnerIndex = try controlled.index.read()
        if secondStage {
            try checks.require(beforeWinnerRows.count == 1 && beforeWinnerRows[0]["storeId"] as? String == winner.deviceId,
                "cross-handle winner strictly reopens the existing native binding instead of recreating stale initial keys")
        }
        gate.release()
        try await checks.sessionAuthRefuses("obsolete cross-directory facade completion refuses") { try await older.value }
        try checks.require(try first.currentAccount() == nil && second.currentAccount() == winner
            && (try account.store.read()) == winnerAccount && (try controlled.index.read()) == winnerIndex,
            "late cross-directory selection or lease completion leaves EXACT winner sealed state and facade mapping unchanged")
        try checks.require(try controlled.rows().count == 1 && DmAccountDirectoryProtocol.count(token) == (secondStage ? 2 : 1)
            && DmAccountDirectoryProtocol.count(winningToken) == 2,
            "cross-directory loser performs no extra Auth or duplicate native account provisioning")
    }

    // A mismatched SDK bearer is NOT account-selection permission. Native A's
    // credentials suspend; B needs explicit signOut and a fresh selection.
    progressForResearch?("directory-facade-account-mismatch")
    do {
        let controlled = try fixture()
        let facade = VodozemacSessionFacade(directory: controlled.directory)
        let initialToken = "fixture.session.mismatch-initial"
        install(initialToken)
        let initialFence = try facade.fenceSession(mode: .verify)
        let initial = try await checks.sessionAuthSucceeds("mismatch fixture cannot establish account A") {
            try await facade.authenticate(accessToken: initialToken, authFence: initialFence.authFence)
        }
        let accountA = try controlled.account(userId: alice); handles.append(accountA.store)
        let mismatchCoordinator = try VodozemacDmCoordinator(store: accountA.store)
        let initialLife = try mismatchCoordinator.lifecycleForResearch()
        let initialIdentity = try mismatchCoordinator.publicIdentity(owner: initialLife.owner)
        let initialContent = try dmAccountDirectoryPayloadWithout("credentialEpoch", payload: accountA.store.read().payload)
        let mismatchFence = try facade.fenceSession(mode: .verify)
        let mismatchToken = "fixture.session.mismatch-B"
        install(mismatchToken, user: bob)
        let mismatchReservedAccount = try accountA.store.read(), mismatchReservedIndex = try controlled.index.read()
        try await checks.sessionAuthRefuses("B token cannot silently turn A renewal into native account selection") {
            try await facade.authenticate(accessToken: mismatchToken, authFence: mismatchFence.authFence)
        }
        try checks.require(try facade.currentAccount() == nil && DmAccountDirectoryProtocol.count(mismatchToken) == 1
            && (try controlled.rows()).count == 1 && (try controlled.state()["selectedUserId"] as? String) == alice
            && (try VodozemacDmCoordinator(store: accountA.store).lifecycleForResearch()).active
            && (try accountA.store.read()) == mismatchReservedAccount && (try controlled.index.read()) == mismatchReservedIndex,
            "wrong selected-owner token suspends credentials without provisioning B or advancing the reserved native lifecycle")
        let retryToken = "fixture.session.mismatch-retry-A"
        install(retryToken)
        let retryFence = try facade.fenceSession(mode: .verify)
        let retried = try await checks.sessionAuthSucceeds("matching selected owner cannot retry after credential-only mismatch refusal") {
            try await facade.authenticate(accessToken: retryToken, authFence: retryFence.authFence)
        }
        try checks.require(try retried.accountId == alice && retried.deviceId == initial.deviceId
            && retried.credentialBinding != initial.credentialBinding && facade.currentAccount() == retried
            && DmAccountDirectoryProtocol.count(retryToken) == 1
            && mismatchCoordinator.lifecycleForResearch().owner == initialLife.owner
            && mismatchCoordinator.lifecycleForResearch().credentialEpoch != initialLife.credentialEpoch
            && dmAccountDirectoryIdentityMatches(initialIdentity, mismatchCoordinator.publicIdentity(owner: initialLife.owner))
            && dmAccountDirectoryPayloadWithout("credentialEpoch", payload: accountA.store.read().payload) == initialContent,
            "matching-owner retry keeps exact native generation, peer state, device and keys while publishing fresh credentials")
        progressForResearch?("directory-facade-explicit-signout")
        let signOutFence = try facade.fenceSession(mode: .signOut)
        let signedOutIndex = try controlled.index.read(), signedOutAccount = try accountA.store.read()
        let signOutToken = "fixture.session.signout-fence-refused"
        install(signOutToken, user: bob)
        try await checks.sessionAuthRefuses("signOut fence can never be consumed as an authentication fence") {
            try await facade.authenticate(accessToken: signOutToken, authFence: signOutFence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(signOutToken) == 0 && facade.currentAccount() == nil
            && (try controlled.state()["selectedUserId"]) == nil && (try controlled.index.read()) == signedOutIndex
            && (try accountA.store.read()) == signedOutAccount,
            "signOut fence authentication refusal sends zero HTTP and preserves exact durable logout")
        let transitionToken = "fixture.session.explicit-B"
        install(transitionToken, user: bob)
        progressForResearch?("directory-facade-explicit-new-selection")
        let transitionFence = try facade.fenceSession(mode: .verify)
        let transitioned = try await checks.sessionAuthSucceeds("explicit signOut then verify cannot select account B") {
            try await facade.authenticate(accessToken: transitionToken, authFence: transitionFence.authFence)
        }
        let accountB = try controlled.account(userId: bob); handles.append(accountB.store)
        let winnerAccount = try accountB.store.read(), winnerIndex = try controlled.index.read()
        try checks.require(try transitioned.accountId == bob && transitioned.deviceId != initial.deviceId
            && transitioned.deviceId == accountB.id.uuidString.lowercased() && transitioned.serverVerified
            && (try controlled.rows()).count == 2 && DmAccountDirectoryProtocol.count(transitionToken) == 2
            && facade.currentAccount() == transitioned && !(try VodozemacDmCoordinator(store: accountA.store).lifecycleForResearch()).active,
            "explicit transition provisions distinct native B identity while retaining inactive immutable A binding")
        let replayToken = "fixture.session.old-mismatch-fence"
        install(replayToken)
        try await checks.sessionAuthRefuses("old mismatched fence cannot cancel the explicitly selected B winner") {
            try await facade.authenticate(accessToken: replayToken, authFence: mismatchFence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(replayToken) == 0 && facade.currentAccount() == transitioned
            && (try accountB.store.read()) == winnerAccount && (try controlled.index.read()) == winnerIndex,
            "obsolete mismatch fence changes neither B mapping nor exact winner sealed index/account snapshots")
    }

    progressForResearch?("directory-facade-cold-reopen")
    do {
        let controlled = try fixture()
        let original = VodozemacSessionFacade(directory: controlled.directory)
        let token = "fixture.session.cold-original"
        install(token)
        let fence = try original.fenceSession(mode: .verify)
        let accepted = try await checks.sessionAuthSucceeds("cold reopen fixture cannot establish original account") {
            try await original.authenticate(accessToken: token, authFence: fence.authFence)
        }
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let coordinator = try VodozemacDmCoordinator(store: account.store)
        let beforeLife = try coordinator.lifecycleForResearch()
        let ownCard = try dmAccountDirectoryCard(original, account: accepted)
        let coldPeer = try fixture(), peerFacade = VodozemacSessionFacade(directory: coldPeer.directory)
        let peerToken = "fixture.session.cold-peer"
        install(peerToken, user: bob)
        let peerFence = try peerFacade.fenceSession(mode: .verify)
        let peerAccepted = try await checks.sessionAuthSucceeds("cold continuity fixture cannot establish peer account") {
            try await peerFacade.authenticate(accessToken: peerToken, authFence: peerFence.authFence)
        }
        let peerAccount = try coldPeer.account(userId: bob); handles.append(peerAccount.store)
        let peerCoordinator = try VodozemacDmCoordinator(store: peerAccount.store)
        let peerLife = try peerCoordinator.lifecycleForResearch(), peerCard = try dmAccountDirectoryCard(peerFacade, account: peerAccepted)
        // Explicit native fixture OOB confirmation, not server lookup-as-trust.
        _ = try original.executeMessageOperation(snapshot: original.messageSnapshot(credentialBinding: accepted.credentialBinding),
            operation: .confirmPeer(card: peerCard, confirmedFingerprint: peerCard.fingerprint()))
        _ = try peerFacade.executeMessageOperation(snapshot: peerFacade.messageSnapshot(credentialBinding: peerAccepted.credentialBinding),
            operation: .confirmPeer(card: ownCard, confirmedFingerprint: ownCard.fingerprint()))
        let ownerInitiates = accepted.deviceId < peerAccepted.deviceId
        let initiator = ownerInitiates ? coordinator : peerCoordinator
        let responder = ownerInitiates ? peerCoordinator : coordinator
        let initiatorOwner = ownerInitiates ? beforeLife.owner : peerLife.owner
        let responderOwner = ownerInitiates ? peerLife.owner : beforeLife.owner
        let opening = try initiator.prepare(clientMessageId: "cold-native-opening", text: "native cold opening fixture",
            owner: initiatorOwner, peerGeneration: 1)
        _ = try responder.receive(opening.serializedEnvelope, owner: responderOwner, peerGeneration: 1)
        let reply = try responder.prepare(clientMessageId: "cold-native-reply", text: "native cold reply fixture",
            owner: responderOwner, peerGeneration: 1)
        _ = try initiator.receive(reply.serializedEnvelope, owner: initiatorOwner, peerGeneration: 1)
        let oldSnapshot = try original.messageSnapshot(credentialBinding: accepted.credentialBinding, peerGeneration: 1)
        let beforeThread = try dmAccountDirectoryThread(original, snapshot: oldSnapshot)
        let beforePending = try coordinator.pending(owner: beforeLife.owner, peerGeneration: 1)
        let beforePeer = try coordinator.peerForResearch(owner: beforeLife.owner, generation: 1)
        try checks.require(beforeThread.messages.count == 2 && beforePending.count == 1
            && beforeThread.messages.contains(where: { $0.direction == .incoming })
            && beforeThread.messages.contains(where: { $0.direction == .outgoing }),
            "real provider fixture contains both received history and exact pending outgoing ciphertext before reopen")
        let coldDirectory = try controlled.reopen(auth: auth); directories.append(coldDirectory)
        let cold = VodozemacSessionFacade(directory: coldDirectory)
        let beforeAccount = try account.store.read(), beforeIndex = try controlled.index.read()
        let beforeContent = try dmAccountDirectoryPayloadWithout("credentialEpoch", payload: beforeAccount.payload)
        let beforeSelection = try dmAccountDirectoryPayloadWithout("epoch", payload: beforeIndex.payload)
        try checks.require(cold.currentAccount() == nil && original.currentAccount() == accepted,
            "strict cold reopen alone restores no credential or account readiness")
        try checks.sessionRefuses("persisted public binding cannot expose cold message/history authority before native verification") {
            _ = try cold.messageSnapshot(credentialBinding: accepted.credentialBinding, peerGeneration: 1)
        }
        let wrongToken = "fixture.session.cold-wrong-owner"
        install(wrongToken, user: bob)
        let coldFence = try cold.fenceSession(mode: .verify)
        let reservedLife = try coordinator.lifecycleForResearch()
        let reservedAccount = try account.store.read(), reservedIndex = try controlled.index.read()
        try checks.require(try reservedLife.active && reservedLife.owner == beforeLife.owner
            && reservedLife.credentialEpoch != beforeLife.credentialEpoch
            && dmAccountDirectoryPayloadWithout("credentialEpoch", payload: reservedAccount.payload) == beforeContent
            && dmAccountDirectoryPayloadWithout("epoch", payload: reservedIndex.payload) == beforeSelection
            && reservedIndex != beforeIndex && cold.currentAccount() == nil && original.currentAccount() == nil
            && DmAccountDirectoryProtocol.count(wrongToken) == 0,
            "cold reservation fences old handles before Auth while changing only directory and credential epochs")
        try checks.require(original.currentMessageContext(snapshot: oldSnapshot) == nil,
            "cold reservation invalidates the old exact native network snapshot")
        try checks.sessionRefuses("old facade snapshot cannot expose thread history after cold reservation") {
            _ = try original.executeMessageOperation(snapshot: oldSnapshot, operation: .thread)
        }
        try checks.sessionRefuses("cold reserved scope exposes no history credential before matching fresh Auth") {
            _ = try cold.messageSnapshot(credentialBinding: accepted.credentialBinding, peerGeneration: 1)
        }
        try await checks.sessionAuthRefuses("fresh wrong user cannot select or deactivate the persisted cold owner") {
            try await cold.authenticate(accessToken: wrongToken, authFence: coldFence.authFence)
        }
        try checks.require(try cold.currentAccount() == nil && DmAccountDirectoryProtocol.count(wrongToken) == 1
            && account.store.read() == reservedAccount && controlled.index.read() == reservedIndex
            && coordinator.lifecycleForResearch() == reservedLife,
            "wrong cold owner refusal leaves exact reserved index/account bytes and active generation unchanged")
        let coldToken = "fixture.session.cold-matching-owner"
        install(coldToken)
        let retryFence = try cold.fenceSession(mode: .verify)
        let continued = try await checks.sessionAuthSucceeds("matching cold owner cannot continue its strict existing native binding") {
            try await cold.authenticate(accessToken: coldToken, authFence: retryFence.authFence)
        }
        let continuedLife = try coordinator.lifecycleForResearch()
        let continuedSnapshot = try cold.messageSnapshot(credentialBinding: continued.credentialBinding, peerGeneration: 1)
        let continuedThread = try dmAccountDirectoryThread(cold, snapshot: continuedSnapshot)
        try checks.require(try continued.accountId == accepted.accountId && continued.deviceId == accepted.deviceId
            && continued.credentialBinding != accepted.credentialBinding && continuedLife.active
            && continuedLife.owner == beforeLife.owner && continuedLife.credentialEpoch != reservedLife.credentialEpoch
            && cold.currentAccount() == continued && DmAccountDirectoryProtocol.count(coldToken) == 1
            && dmAccountDirectoryIdentityMatches(ownCard.identity, coordinator.publicIdentity(owner: continuedLife.owner)),
            "fresh exact owner verification preserves device generation and all public identity keys with new native credential binding")
        try checks.require(try continuedThread.ownerGeneration == beforeThread.ownerGeneration
            && continuedThread.peerGeneration == beforeThread.peerGeneration && continuedThread.messages == beforeThread.messages
            && coordinator.pending(owner: continuedLife.owner, peerGeneration: 1) == beforePending
            && coordinator.peerForResearch(owner: continuedLife.owner, generation: 1) == beforePeer
            && dmAccountDirectoryPayloadWithout("credentialEpoch", payload: account.store.read().payload) == beforeContent
            && dmAccountDirectoryPayloadWithout("epoch", payload: controlled.index.read().payload) == beforeSelection,
            "cold continuation preserves exact ratchet/account/peer state, inbound history and pending ciphertext instead of recreating or rebinding it")
        try checks.sessionRefuses("old public binding cannot mint the successfully continued native lease") {
            _ = try cold.messageSnapshot(credentialBinding: accepted.credentialBinding, peerGeneration: 1)
        }
        let continuedAccount = try account.store.read(), continuedIndex = try controlled.index.read()
        let replayToken = "fixture.session.cold-old-fence"
        install(replayToken)
        try await checks.sessionAuthRefuses("used wrong-owner cold fence cannot cancel the matching-owner winner") {
            try await cold.authenticate(accessToken: replayToken, authFence: coldFence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(replayToken) == 0 && cold.currentAccount() == continued
            && account.store.read() == continuedAccount && controlled.index.read() == continuedIndex,
            "obsolete cold auth handle performs zero HTTP and preserves exact continued native winner")
        _ = try cold.fenceSession(mode: .signOut)
        let signedOutLife = try coordinator.lifecycleForResearch()
        try checks.require(try cold.currentAccount() == nil && original.currentAccount() == nil
            && cold.currentMessageContext(snapshot: continuedSnapshot) == nil && (try controlled.state()["selectedUserId"]) == nil
            && !signedOutLife.active && signedOutLife.owner.generation > continuedLife.owner.generation,
            "explicit logout still unselects and advances owner generation rather than becoming passive cold suspension")
        let restartToken = "fixture.session.cold-explicit-A"
        install(restartToken)
        let restartFence = try cold.fenceSession(mode: .verify)
        let restarted = try await checks.sessionAuthSucceeds("explicit logout then fresh same-owner selection cannot authenticate") {
            try await cold.authenticate(accessToken: restartToken, authFence: restartFence.authFence)
        }
        let restartedLife = try coordinator.lifecycleForResearch()
        let restartedSnapshot = try cold.messageSnapshot(credentialBinding: restarted.credentialBinding, peerGeneration: 1)
        let restartedThread = try dmAccountDirectoryThread(cold, snapshot: restartedSnapshot)
        try checks.require(try restarted.accountId == alice && restarted.deviceId == accepted.deviceId
            && restartedLife.owner.generation > signedOutLife.owner.generation && cold.currentAccount() == restarted
            && DmAccountDirectoryProtocol.count(restartToken) == 2 && (try controlled.rows()).count == 1
            && restartedThread.messages.isEmpty && coordinator.history(owner: restartedLife.owner, peerGeneration: 1).isEmpty
            && coordinator.pending(owner: restartedLife.owner, peerGeneration: 1).isEmpty,
            "explicit same-owner relogin keeps immutable identity but never revives old-generation history or pending records")
    }

    // URLProtocol delays only HTTP delivery. No native authority lock spans this
    // await; a durable explicit logout or newer verified owner wins meanwhile.
    progressForResearch?("directory-facade-cold-late-auth")
    for selectWinner in [false, true] {
        let controlled = try fixture(), original = VodozemacSessionFacade(directory: controlled.directory)
        let suffix = selectWinner ? "winner" : "logout"
        let originalToken = "fixture.session.cold-race-original." + suffix
        install(originalToken)
        let originalFence = try original.fenceSession(mode: .verify)
        _ = try await checks.sessionAuthSucceeds("cold race fixture cannot establish original selected owner") {
            try await original.authenticate(accessToken: originalToken, authFence: originalFence.authFence)
        }
        let accountA = try controlled.account(userId: alice); handles.append(accountA.store)
        let coldDirectory = try controlled.reopen(auth: auth); directories.append(coldDirectory)
        let cold = VodozemacSessionFacade(directory: coldDirectory), gate = DmAccountDirectoryGate()
        defer { gate.release() }
        let lateToken = "fixture.session.cold-race-late." + suffix
        var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
        DmAccountDirectoryProtocol.install([held], bearer: lateToken)
        let coldFence = try cold.fenceSession(mode: .verify)
        let late = Task { try await cold.authenticate(accessToken: lateToken, authFence: coldFence.authFence) }
        defer { late.cancel() }
        try await dmAccountDirectoryAwaitRequest(lateToken)
        try checks.sessionRefuses("held cold Auth grants no native message/history snapshot") {
            _ = try cold.messageSnapshot(credentialBinding: UUID().uuidString.lowercased())
        }
        _ = try original.fenceSession(mode: .signOut)
        var winner: DmSessionAccount?
        var winnerStore: VodozemacSealedStore?
        if selectWinner {
            let winnerToken = "fixture.session.cold-race-B"
            install(winnerToken, user: bob)
            let winnerFence = try original.fenceSession(mode: .verify)
            winner = try await checks.sessionAuthSucceeds("explicit newer cold-race account cannot become current") {
                try await original.authenticate(accessToken: winnerToken, authFence: winnerFence.authFence)
            }
            let accountB = try controlled.account(userId: bob); handles.append(accountB.store); winnerStore = accountB.store
        }
        let afterAccount = try accountA.store.read(), afterIndex = try controlled.index.read()
        let afterWinner = try winnerStore?.read()
        gate.release()
        try await checks.sessionAuthRefuses("late cold same-owner Auth cannot undo explicit logout or a newer account winner") {
            try await late.value
        }
        try checks.require(try cold.currentAccount() == nil && original.currentAccount() == winner
            && accountA.store.read() == afterAccount && controlled.index.read() == afterIndex
            && winnerStore?.read() == afterWinner && DmAccountDirectoryProtocol.count(lateToken) == 1,
            "late cold completion preserves exact durable logout or winner state without stale account compensation")
    }

    // A continuation accepts ONLY an existing selected/ready/active exact
    // binding. These explicit faults cannot become replacement identities.
    progressForResearch?("directory-facade-cold-invalid-binding")
    for fault in ["inactive", "reserved", "blocked", "missing-key", "missing-database"] {
        let controlled = try fixture()
        _ = try await open(controlled, bearer: "fixture.session.cold-invalid-original." + fault, user: alice)
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let beforeRows = try controlled.rows()
        switch fault {
        case "inactive":
            _ = try VodozemacDmCoordinator(store: account.store).deactivateAuthScopeForResearch()
        case "reserved", "blocked":
            let before = try controlled.index.read()
            guard var state = try JSONSerialization.jsonObject(with: before.payload) as? [String: Any],
                  var rows = state["accounts"] as? [[String: Any]], rows.count == 1 else {
                throw DmAccountDirectoryProbeError.assertion("cold invalid binding fixture")
            }
            rows[0]["status"] = fault; state["accounts"] = rows
            _ = try controlled.index.commit(expectedRevision: before.revision,
                payload: JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]))
        case "missing-key": try VodozemacSealedStore.deleteResearchKey(storeID: account.id)
        default:
            controlled.directory.closeForResearch(); account.store.close()
            let database = account.url.appendingPathComponent("snapshot.sqlite")
            guard database.path.withCString({ Darwin.unlink($0) }) == 0 else {
                throw DmAccountDirectoryProbeError.assertion("remove exact cold fixture account database")
            }
        }
        let invalidIndex = try controlled.index.read()
        let token = "fixture.session.cold-invalid-refused." + fault
        install(token)
        if fault == "reserved" || fault == "blocked" {
            try checks.refuses("selected nonready binding refuses cold directory construction") {
                _ = try controlled.reopen(auth: auth)
            }
        } else {
            let reopened = try controlled.reopen(auth: auth); directories.append(reopened)
            let cold = VodozemacSessionFacade(directory: reopened)
            try checks.sessionRefuses("inactive or missing cold account refuses continuation before fresh Auth") {
                _ = try cold.fenceSession(mode: .verify)
            }
        }
        try checks.require(try DmAccountDirectoryProtocol.count(token) == 0 && controlled.index.read() == invalidIndex
            && beforeRows.count == 1 && (try controlled.rows()).count == 1
            && controlled.rows()[0]["storeId"] as? String == account.id.uuidString.lowercased(),
            "invalid cold binding performs zero Auth and allocates no new namespace or replacement device")
    }

    // Inject only the facade clock: expiry is deterministic, zero-HTTP, and
    // never grants a new sixty-second window after waiting for an SDK token.
    progressForResearch?("directory-facade-expired-fence")
    do {
        let controlled = try fixture(), clock = DmSessionFacadeClock()
        let facade = VodozemacSessionFacade(directory: controlled.directory, clockForResearch: clock.now)
        let token = "fixture.session.expired-fence"
        install(token)
        let initialIndex = try controlled.index.read()
        try checks.refuses("native directory refuses an already-expired facade deadline before reserving authority") {
            _ = try controlled.directory.reserveVerification(expiresBy: ContinuousClock.now.advanced(by: .seconds(-1)))
        }
        try checks.require(try controlled.index.read() == initialIndex && controlled.rows().isEmpty
            && DmAccountDirectoryProtocol.count(token) == 0,
            "past native deadline creates no durable mutation, key namespace or Auth dispatch")
        let fence = try facade.fenceSession(mode: .verify)
        let reserved = try controlled.index.read()
        clock.advance(seconds: 61)
        try await checks.sessionAuthRefuses("expired pre-SDK facade fence cannot dispatch Auth") {
            try await facade.authenticate(accessToken: token, authFence: fence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(token) == 0 && facade.currentAccount() == nil
            && (try controlled.index.read()) == reserved && (try controlled.rows()).isEmpty,
            "expired facade claim leaves exact durable reservation unchanged and creates no native account")
    }
    progressForResearch?("directory-facade-expired-account")
    do {
        let controlled = try fixture(), clock = DmSessionFacadeClock()
        let facade = VodozemacSessionFacade(directory: controlled.directory, clockForResearch: clock.now)
        let token = "fixture.session.expiring-account"
        install(token)
        let fence = try facade.fenceSession(mode: .verify)
        let accepted = try await checks.sessionAuthSucceeds("facade expiry fixture cannot initially authenticate") {
            try await facade.authenticate(accessToken: token, authFence: fence.authFence)
        }
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let beforeAccount = try account.store.read(), beforeIndex = try controlled.index.read()
        try checks.require(facade.currentAccount() == accepted, "unexpired native facade account mapping is visible")
        clock.advance(seconds: 61)
        try checks.require(try facade.currentAccount() == nil && (try account.store.read()) == beforeAccount
            && (try controlled.index.read()) == beforeIndex && DmAccountDirectoryProtocol.count(token) == 2,
            "account mapping expires on original monotonic fence deadline without fresh Auth or hidden store mutations")
    }

    // The accepted native scope itself must retain a tightened fence deadline,
    // independently of the facade and the later inner AuthSession +60s lease.
    // Wait for the exact monotonic deadline, not an arbitrary scheduling delay.
    progressForResearch?("directory-scope-tightened-deadline")
    do {
        let controlled = try fixture()
        _ = try await open(controlled, bearer: "fixture.scope.deadline-initial", user: alice)
        let account = try controlled.account(userId: alice); handles.append(account.store)
        let started = ContinuousClock.now
        let deadline = started.advanced(by: .seconds(2))
        let reservation = try controlled.directory.reserveVerification(expiresBy: deadline)
        try checks.require(reservation.expires == deadline,
            "accepted-scope fixture retains the exact tightened native reservation deadline")
        let token = "fixture.scope.deadline-renewal"
        install(token)
        let scope: VodozemacAccountDirectory.AuthenticatedScope
        do { scope = try await controlled.directory.authenticate(bearer: token, reservation: reservation) }
        catch { throw DmAccountDirectoryProbeError.assertion("short native scope renewal could not complete before its deadline") }
        try checks.require(scope.currentContext() != nil && ContinuousClock.now < deadline,
            "accepted native scope is current before its original tightened deadline")
        let beforeAccount = try account.store.read(), beforeIndex = try controlled.index.read()
        try await ContinuousClock().sleep(until: deadline, tolerance: .zero)
        try checks.require(ContinuousClock.now >= deadline && ContinuousClock.now < started.advanced(by: .seconds(60))
            && scope.currentContext() == nil,
            "native scope refuses on its original deadline before the later inner sixty-second lease could expire")
        try checks.require(try account.store.read() == beforeAccount && (try controlled.index.read()) == beforeIndex
            && DmAccountDirectoryProtocol.count(token) == 1,
            "accepted scope expiry changes no sealed bytes, revision or native Auth request count")
    }

    progressForResearch?("directory-facade-cancelled-inflight")
    do {
        let controlled = try fixture()
        let facade = VodozemacSessionFacade(directory: controlled.directory)
        let gate = DmAccountDirectoryGate()
        var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
        let token = "fixture.session.cancelled-inflight"
        DmAccountDirectoryProtocol.install([held], bearer: token)
        let fence = try facade.fenceSession(mode: .verify)
        let task = Task { try await facade.authenticate(accessToken: token, authFence: fence.authFence) }
        defer { gate.release(); task.cancel() }
        try await dmAccountDirectoryAwaitRequest(token)
        let reserved = try controlled.index.read()
        task.cancel(); gate.release()
        try await checks.sessionAuthRefuses("cancelled in-flight facade Auth cannot publish an account") { try await task.value }
        try checks.require(try facade.currentAccount() == nil && DmAccountDirectoryProtocol.count(token) == 1
            && (try controlled.index.read()) == reserved && (try controlled.rows()).isEmpty,
            "cancellation before verified selection publishes no mapping and leaves exact native reservation without account provisioning")
        let replayToken = "fixture.session.cancelled-replay"
        install(replayToken)
        try await checks.sessionAuthRefuses("cancellation cannot revive a previously claimed facade fence") {
            try await facade.authenticate(accessToken: replayToken, authFence: fence.authFence)
        }
        try checks.require(try DmAccountDirectoryProtocol.count(replayToken) == 0 && (try controlled.index.read()) == reserved,
            "cancelled facade fence replay dispatches zero Auth and cannot reset durable authority")
    }

    progressForResearch?("directory-auth-refusals")
    let invalid = try fixture()
    try await checks.refuses("malformed bearer cannot create an account binding") { try await invalid.directory.open(bearer: "bad\nheader") }
    var denied = DmAccountDirectoryProtocol.Script(userId: alice); denied.status = 401
    DmAccountDirectoryProtocol.install([denied], bearer: "fixture.enrollment.denied")
    try await checks.refuses("first server Auth refusal creates no account") { try await invalid.directory.open(bearer: "fixture.enrollment.denied") }
    try checks.require(try invalid.rows().isEmpty, "Auth refusal leaves zero account bindings")
    DmAccountDirectoryProtocol.install([.init(userId: alice), .init(userId: bob)], bearer: "fixture.enrollment.changed")
    try await checks.refuses("changed account on lease verification never publishes selected access") {
        try await invalid.directory.open(bearer: "fixture.enrollment.changed")
    }
    try checks.require(try invalid.state()["selectedUserId"] == nil && invalid.rows().count == 1,
        "failed second verification retains only the original immutable binding")

    progressForResearch?("directory-interrupted-enrollment")
    for fault in [VodozemacAccountDirectory.EnrollmentFault.afterReservation, .beforeReadyCommit] {
        let interrupted = try fixture()
        install("fixture.enrollment.interrupted")
        try await checks.refuses("interrupted account enrollment is refused") {
            try await interrupted.directory.openForResearch(bearer: "fixture.enrollment.interrupted", fault: fault)
        }
        let rows = try interrupted.rows()
        try checks.require(rows.count == 1 && rows[0]["status"] as? String == "reserved",
            "durable reservation precedes account creation and ready commit")
        let reopened = try interrupted.reopen(auth: auth)
        directories.append(reopened)
        install("fixture.enrollment.no-recreate")
        try await checks.refuses("reserved enrollment refuses automatic continuation or recreation after reopen") {
            try await reopened.open(bearer: "fixture.enrollment.no-recreate")
        }
        try checks.require(try interrupted.rows().count == 1 && interrupted.rows()[0]["storeId"] as? String == rows[0]["storeId"] as? String,
            "interrupted enrollment never allocates a replacement device UUID")
    }

    // Deterministic async fences during both verification stages.
    progressForResearch?("directory-selection-cancel-and-logout")
    for secondStage in [false, true] {
        for cancel in [false, true] {
            let fixture = try fixture(), gate = DmAccountDirectoryGate()
            defer { gate.release() }
            let token = "fixture.enrollment.fenced." + (secondStage ? "second." : "first.") + (cancel ? "cancel" : "logout")
            var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
            DmAccountDirectoryProtocol.install(secondStage ? [.init(userId: alice), held] : [held], bearer: token)
            let task = Task { try await fixture.directory.open(bearer: token) }
            try await dmAccountDirectoryAwaitRequest(token, count: secondStage ? 2 : 1)
            if cancel { task.cancel() } else { try fixture.directory.signOut() }
            gate.release()
            try await checks.refuses("cancelled or signed-out enrollment cannot publish late access") { try await task.value }
            try checks.require(try fixture.state()["selectedUserId"] == nil,
                "late response cannot select an account after cancellation or logout")
            try checks.require(try fixture.rows().count == (secondStage ? 1 : 0),
                "pre-selection cancellation creates no account and post-selection preserves one binding")
            if secondStage {
                let local = try fixture.account(userId: alice)
                defer { local.store.close() }
                try checks.require(try !VodozemacDmCoordinator(store: local.store).lifecycleForResearch().active,
                    "cancelled or stale second-stage enrollment leaves its native lifecycle inactive")
            }
        }
    }
    progressForResearch?("directory-selection-cross-handle")
    let contested = try fixture(), competitor = try contested.reopen(auth: auth), gate = DmAccountDirectoryGate()
    directories.append(competitor)
    defer { gate.release() }
    var held = DmAccountDirectoryProtocol.Script(userId: alice); held.gate = gate
    DmAccountDirectoryProtocol.install([held], bearer: "fixture.enrollment.contested-old")
    let old = Task { try await contested.directory.open(bearer: "fixture.enrollment.contested-old") }
    try await dmAccountDirectoryAwaitRequest("fixture.enrollment.contested-old")
    install("fixture.enrollment.contested-new", user: bob)
    let winner = try await checks.succeeds("positive competing directory enrollment unexpectedly refused") {
        try await competitor.open(bearer: "fixture.enrollment.contested-new")
    }
    accesses.append(winner)
    gate.release()
    try await checks.refuses("durable directory epoch rejects another handle's late enrollment") { try await old.value }
    try checks.require(winner.currentContext()?.userId == bob && (try contested.rows()).count == 1,
        "only the newer verified account has a native binding and usable access")

    // A missing account key has a durable blocked index entry. No Keychain
    // query ever reads or prints private key bytes, and no replacement is made.
    progressForResearch?("directory-account-key-loss")
    let lost = try fixture()
    let lostAccess = try await open(lost, bearer: "fixture.enrollment.key-loss", user: alice)
    let lostAccount = try lost.account(userId: alice)
    handles.append(lostAccount.store)
    try VodozemacSealedStore.deleteResearchKey(storeID: lostAccount.id)
    try checks.fenced(lostAccess, "lost account key cannot supply an existing credential")
    try checks.refuses("missing account key prevents directory logout success") { try lost.directory.signOut() }
    try checks.require(try lost.rows()[0]["status"] as? String == "blocked", "missing key produces durable blocked binding")
    let lostReopened = try lost.reopen(auth: auth)
    directories.append(lostReopened)
    install("fixture.enrollment.missing-key-retry")
    try await checks.refuses("missing account key never causes replacement on next login") {
        try await lostReopened.open(bearer: "fixture.enrollment.missing-key-retry")
    }
    try checks.require(try lost.rows()[0]["storeId"] as? String == lostAccount.id.uuidString.lowercased(),
        "missing-key tombstone keeps the original device UUID")

    // Authenticated local corruption/scope mismatch is blocked even when a
    // fixture explicitly restores the former valid payload afterwards.
    progressForResearch?("directory-account-corruption")
    for field in ["account", "owner", "authProjectOrigin", "conversationId", "version"] {
        let damaged = try fixture()
        _ = try await open(damaged, bearer: "fixture.enrollment.damage." + field, user: alice)
        try damaged.directory.signOut()
        let account = try damaged.account(userId: alice); handles.append(account.store)
        let original = try account.store.read()
        guard var payload = try JSONSerialization.jsonObject(with: original.payload) as? [String: Any] else {
            throw DmAccountDirectoryProbeError.assertion("corruption fixture has native coordinator state")
        }
        switch field {
        case "owner":
            guard var owner = payload["owner"] as? [String: Any] else { throw DmAccountDirectoryProbeError.assertion("corruption owner fixture") }
            owner["userId"] = bob; payload[field] = owner
        case "authProjectOrigin": payload.removeValue(forKey: field)
        case "version": payload[field] = 4
        default: payload[field] = "corrupted-native-fixture"
        }
        let badRevision = try account.store.commit(expectedRevision: original.revision,
            payload: JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        let reopened = try damaged.reopen(auth: auth)
        directories.append(reopened)
        install("fixture.enrollment.corruption-retry." + field)
        try await checks.refuses("damaged account or binding cannot reopen as an identity") {
            try await reopened.open(bearer: "fixture.enrollment.corruption-retry." + field)
        }
        try checks.require(try damaged.rows()[0]["status"] as? String == "blocked",
            "damaged native account produces a durable refusal binding")
        _ = try account.store.commit(expectedRevision: badRevision, payload: original.payload)
        install("fixture.enrollment.restored-retry." + field)
        try await checks.refuses("blocked corruption never automatically recovers after old payload restoration") {
            try await reopened.open(bearer: "fixture.enrollment.restored-retry." + field)
        }
    }

    progressForResearch?("directory-account-database-loss")
    let missingDB = try fixture()
    _ = try await open(missingDB, bearer: "fixture.enrollment.database-loss", user: alice)
    try missingDB.directory.signOut()
    let missingAccount = try missingDB.account(userId: alice); missingAccount.store.close()
    let database = missingAccount.url.appendingPathComponent("snapshot.sqlite")
    guard database.path.withCString({ Darwin.unlink($0) }) == 0 else { throw DmAccountDirectoryProbeError.assertion("delete owned fixture database") }
    install("fixture.enrollment.missing-database")
    try await checks.refuses("missing account DB cannot cause identity recreation") { try await missingDB.directory.open(bearer: "fixture.enrollment.missing-database") }
    try checks.require(try missingDB.rows()[0]["status"] as? String == "blocked", "missing DB is durably blocked")

    progressForResearch?("directory-locator-refusals")
    let locatorFixture = try fixture()
    let locator = locatorFixture.root.appendingPathComponent("index-id")
    let originalLocator = try Data(contentsOf: locator)
    try Data("malformed-native-locator\n".utf8).write(to: locator)
    try checks.refuses("malformed locator cannot reopen or initialize an index") { _ = try locatorFixture.reopen(auth: auth) }
    install("fixture.enrollment.bad-locator")
    try await checks.refuses("existing handle also refuses changed locator before HTTP") { try await locatorFixture.directory.open(bearer: "fixture.enrollment.bad-locator") }
    try checks.require(DmAccountDirectoryProtocol.count("fixture.enrollment.bad-locator") == 0, "damaged native directory sends no Auth request")
    try originalLocator.write(to: locator)
    guard locator.path.withCString({ Darwin.unlink($0) }) == 0 else {
        throw DmAccountDirectoryProbeError.assertion("remove exact owned locator before symlink fixture")
    }
    try FileManager.default.createSymbolicLink(at: locator, withDestinationURL: locatorFixture.indexURL.appendingPathComponent("snapshot.sqlite"))
    try checks.refuses("symbolic-link locator cannot choose an account index") { _ = try locatorFixture.reopen(auth: auth) }
    guard locator.path.withCString({ Darwin.unlink($0) }) == 0 else {
        throw DmAccountDirectoryProbeError.assertion("remove exact fixture locator symlink")
    }
    try originalLocator.write(to: locator)
    let unknown = locatorFixture.root.appendingPathComponent("unexpected-native-content")
    try Data().write(to: unknown)
    try checks.refuses("unbound native directory content refuses fresh-account selection") { _ = try locatorFixture.reopen(auth: auth) }
    guard unknown.path.withCString({ Darwin.unlink($0) }) == 0 else { throw DmAccountDirectoryProbeError.assertion("remove exact fixture unknown file") }

    progressForResearch?("directory-index-corruption")
    let indexCorruption = try fixture()
    _ = try indexCorruption.rows()
    let validIndex = try indexCorruption.index.read()
    var invalidIndex = try indexCorruption.state()
    invalidIndex["version"] = 2
    _ = try indexCorruption.index.commit(expectedRevision: validIndex.revision,
        payload: JSONSerialization.data(withJSONObject: invalidIndex, options: [.sortedKeys]))
    try checks.refuses("unsupported sealed index never becomes a fresh account directory") { _ = try indexCorruption.reopen(auth: auth) }
    install("fixture.enrollment.index-corruption")
    try await checks.refuses("corrupt index prevents native account selection before Auth") {
        try await indexCorruption.directory.open(bearer: "fixture.enrollment.index-corruption")
    }
    try checks.require(DmAccountDirectoryProtocol.count("fixture.enrollment.index-corruption") == 0,
        "index corruption performs no server Auth or key creation")

    progressForResearch?("directory-index-key-loss")
    let indexLoss = try fixture()
    _ = try indexLoss.rows()
    try VodozemacSealedStore.deleteResearchKey(storeID: indexLoss.indexID)
    try checks.refuses("lost account index key refuses reopen") { _ = try indexLoss.reopen(auth: auth) }
    install("fixture.enrollment.index-key-loss")
    try await checks.refuses("lost index key cannot initialize a replacement account") { try await indexLoss.directory.open(bearer: "fixture.enrollment.index-key-loss") }
    try checks.require(DmAccountDirectoryProtocol.count("fixture.enrollment.index-key-loss") == 0,
        "index key loss sends no Auth request and creates no owner/store")

    progressForResearch?("directory-teardown")
    for access in accesses { access.closeForResearch() }
    for directory in directories { directory.closeForResearch() }
    for handle in handles { handle.close() }
    for fixture in fixtures {
        try fixture.destroy()
        try checks.require(!FileManager.default.fileExists(atPath: fixture.root.path), "owned account-directory namespace removed without recursion")
    }
    progressForResearch?("directory-complete")
    return checks.assertions
}
