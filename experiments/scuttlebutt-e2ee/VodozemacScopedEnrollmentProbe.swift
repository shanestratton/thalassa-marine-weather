// ISOLATED NATIVE FIXTURES: synthetic URLProtocol Auth/relay with real provider,
// Directory/Facade authority, Keychain and sealed SQLite. No live enrollment,
// hosted exchange, physical devices, plugin activation or independent audit.
// Enrollment facts are historical control-plane evidence, NOT send permission.
// Existing send/receive operations are not newly gated by this enrollment slice.
import Foundation
import Darwin
import CryptoKit

enum DmScopedEnrollmentProbeError: Error { case assertion(String) }

private final class DmScopedEnrollmentChecks {
    private(set) var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmScopedEnrollmentProbeError.assertion(label) }
        assertions += 1
    }
    func unresolved(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch DmRelayTransportError.unresolved { assertions += 1; return }
        throw DmScopedEnrollmentProbeError.assertion(label)
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { assertions += 1; return }
        throw DmScopedEnrollmentProbeError.assertion(label)
    }
    func unsupported(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.unsupportedState { assertions += 1; return }
        throw DmScopedEnrollmentProbeError.assertion(label)
    }
}

private let dmScopedEnrollmentOrigin = "https://scoped-enrollment-fixture.invalid"
private let dmScopedEnrollmentHost = "scoped-enrollment-fixture.invalid"

private final class DmScopedEnrollmentGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var reached = false
    private var released = false
    private var passedWithoutTimeout = false
    func arrived() -> Bool { lock.lock(); defer { lock.unlock() }; return reached }
    func releasedWithoutTimeout() -> Bool { lock.lock(); defer { lock.unlock() }; return passedWithoutTimeout }
    func hold() -> Bool {
        lock.lock(); reached = true; lock.unlock()
        let passed = semaphore.wait(timeout: .now() + 2.5) == .success
        lock.lock(); passedWithoutTimeout = passed; lock.unlock()
        return passed
    }
    func release() {
        lock.lock(); let signal = !released; released = true; lock.unlock()
        if signal { semaphore.signal() }
    }
}

private struct DmScopedEnrollmentScript {
    let path: String
    let result: Data
    let loseAfterBody: Bool
    let gate: DmScopedEnrollmentGate?
    init(path: String, result: Data, loseAfterBody: Bool = false, gate: DmScopedEnrollmentGate? = nil) {
        self.path = path; self.result = result; self.loseAfterBody = loseAfterBody; self.gate = gate
    }
}
private struct DmScopedEnrollmentCapture {
    let body: Data
    let userId: String
    let url: URL
    let method: String
    let capturedAt: Int64
}

private final class DmScopedEnrollmentProtocol: URLProtocol, @unchecked Sendable {
    private static let fixtureLock = NSLock()
    private static var users: [String: String] = [:]
    private static var scripts: [DmScopedEnrollmentScript] = []
    private static var requests: [DmScopedEnrollmentCapture] = []
    private let stateLock = NSRecursiveLock()
    private var stopped = false
    static func reset() {
        fixtureLock.lock(); users.removeAll(); scripts.removeAll(); requests.removeAll(); fixtureLock.unlock()
    }
    static func install(bearer: String, userId: String) {
        fixtureLock.lock(); users["Bearer " + bearer] = userId; fixtureLock.unlock()
    }
    static func setScripts(_ values: [DmScopedEnrollmentScript]) {
        fixtureLock.lock(); scripts = values; requests.removeAll(); fixtureLock.unlock()
    }
    static func captured() -> [DmScopedEnrollmentCapture] {
        fixtureLock.lock(); defer { fixtureLock.unlock() }; return requests
    }
    // Even unexpected requests are intercepted; routing bugs cannot reach DNS.
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, url.scheme == "https", url.host == dmScopedEnrollmentHost,
              url.query == nil, url.fragment == nil else { fail(); return }
        Self.fixtureLock.lock()
        let user = Self.users[request.value(forHTTPHeaderField: "Authorization") ?? ""]
        Self.fixtureLock.unlock()
        guard let user else { fail(); return }
        if url.path == "/auth/v1/user", request.httpMethod == "GET" {
            respond(Data("{\"id\":\"\(user)\",\"user_metadata\":{\"deviceId\":\"spoofed-device\"}}".utf8), url: url)
            return
        }
        guard ["/v1/register", "/v1/dispatch"].contains(url.path), request.httpMethod == "POST" else {
            fail(); return
        }
        var body = request.httpBody ?? Data()
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while body.count <= 102400 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        guard !body.isEmpty, body.count <= 102400,
              let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              fields["userId"] as? String == user else { fail(); return }
        Self.fixtureLock.lock()
        Self.requests.append(DmScopedEnrollmentCapture(body: body, userId: user, url: url,
            method: request.httpMethod ?? "", capturedAt: Int64(Date().timeIntervalSince1970)))
        let script = Self.scripts.isEmpty ? nil : Self.scripts.removeFirst()
        Self.fixtureLock.unlock()
        guard let script, script.path == url.path else { fail(); return }
        // A held relay reply must not block concurrent native Auth callbacks.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            if let gate = script.gate, !gate.hold() { fail(); return }
            respond(script.result, url: url, loseAfterBody: script.loseAfterBody)
        }
    }
    private func respond(_ result: Data, url: URL, loseAfterBody: Bool = false) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !stopped else { return }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        var body = result
        if ["/v1/register", "/v1/dispatch"].contains(url.path) {
            body = Data("{\"version\":1,\"result\":".utf8)
            body.append(result); body.append(Data("}".utf8))
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        if loseAfterBody { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
        else { client?.urlProtocolDidFinishLoading(self) }
    }
    private func fail() {
        stateLock.lock(); defer { stateLock.unlock() }
        if !stopped { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)) }
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

private struct DmScopedEnrollmentFrame: Decodable {
    let version: Int
    let protocolName: String
    let userId: String
    let deviceId: String
    let action: String
    let requestId: String
    let expiresAt: Int64
    let payload: String
    let signature: String
    private enum CodingKeys: String, CodingKey {
        case version, userId, deviceId, action, requestId, expiresAt, payload, signature
        case protocolName = "protocol"
    }
}

private func dmScopedEnrollmentConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [DmScopedEnrollmentProtocol.self]
    return config
}
private func dmScopedEnrollmentAuth() throws -> VodozemacSupabaseAuth {
    try VodozemacSupabaseAuth(projectOrigin: dmScopedEnrollmentOrigin,
        publicApiKey: "sb_publishable_scoped_enrollment_fixture", deadlineSeconds: 3,
        configurationForResearch: { dmScopedEnrollmentConfiguration() })
}
private func dmScopedEnrollmentTransport() throws -> VodozemacRelayTransport {
    try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
        configurationForResearch: { dmScopedEnrollmentConfiguration() })
}
private func dmScopedEnrollmentAwait(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while !condition() {
        guard ContinuousClock.now < deadline else {
            throw DmScopedEnrollmentProbeError.assertion("scoped enrollment bounded fixture arrival")
        }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}
private func dmScopedEnrollmentJSON(_ fields: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
}
private func dmScopedEnrollmentAck(_ identity: DmPublicIdentity, wrongUser: Bool = false,
                                    wrongDevice: Bool = false, malformed: Bool = false) throws -> Data {
    var registered: Any = true
    if malformed { registered = 1 }
    return try dmScopedEnrollmentJSON(["registered": registered,
        "userId": wrongUser ? "60000000-0000-4000-8000-000000000099" : identity.userId,
        "deviceId": wrongDevice ? "70000000-0000-4000-8000-000000000099" : identity.deviceId])
}
private func dmScopedEnrollmentClaimResult(_ wire: String) throws -> Data {
    let bundle = try JSONDecoder().decode(DmRelayBundle.self, from: Data(wire.utf8))
    return try dmScopedEnrollmentJSON(["signedBundle": wire, "prekeyId": bundle.prekeyId, "prekey": bundle.prekey])
}

private final class DmScopedEnrollmentFixture {
    static let conversationId = "scoped-native-enrollment-fixture"
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
            throw DmScopedEnrollmentProbeError.assertion("scoped enrollment fixture locator")
        }
        index = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(id.uuidString.lowercased()), storeID: id)
        ownedIDs.insert(id)
    }
    private func rows() throws -> [[String: Any]] {
        guard let fields = try JSONSerialization.jsonObject(with: index.read().payload) as? [String: Any],
              let rows = fields["accounts"] as? [[String: Any]] else {
            throw DmScopedEnrollmentProbeError.assertion("scoped enrollment sealed index")
        }
        for row in rows {
            guard let name = row["storeId"] as? String, let id = UUID(uuidString: name), name == id.uuidString.lowercased() else {
                throw DmScopedEnrollmentProbeError.assertion("scoped enrollment validated namespace")
            }
            ownedIDs.insert(id)
        }
        return rows
    }
    func account(userId: String) throws -> (VodozemacSealedStore, VodozemacDmCoordinator) {
        guard let row = try rows().first(where: { $0["userId"] as? String == userId }),
              let name = row["storeId"] as? String, let id = UUID(uuidString: name) else {
            throw DmScopedEnrollmentProbeError.assertion("scoped enrollment fixture account")
        }
        let store = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(name), storeID: id)
        handles.append(store)
        return (store, try VodozemacDmCoordinator(store: store))
    }
    func reopen(auth: VodozemacSupabaseAuth) throws -> VodozemacAccountDirectory {
        let reopened = try VodozemacAccountDirectory.reopen(directory: root, authenticator: auth,
            conversationId: Self.conversationId)
        competitors.append(reopened)
        return reopened
    }
    func destroy() throws {
        guard !destroyed else { return }
        _ = try rows()
        try? directory.signOut()
        directory.closeForResearch()
        for competitor in competitors { competitor.closeForResearch() }
        for handle in handles { handle.close() }
        index.close()
        // Exact validated disposable namespaces only; never recursive cleanup.
        let fm = FileManager.default
        let names = Set(try fm.contentsOfDirectory(atPath: root.path))
        let allowed = Set(ownedIDs.map { $0.uuidString.lowercased() }).union(["index-id"])
        guard names.isSubset(of: allowed) else { throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup exact container") }
        for id in ownedIDs {
            let name = id.uuidString.lowercased()
            guard names.contains(name) else { continue }
            let leaf = root.appendingPathComponent(name)
            guard try fm.attributesOfItem(atPath: leaf.path)[.type] as? FileAttributeType == .typeDirectory else {
                throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup exact directory")
            }
            let files = Set(try fm.contentsOfDirectory(atPath: leaf.path))
            guard files.isSubset(of: ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]) else {
                throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup exact SQLite leaves")
            }
            for file in files {
                let url = leaf.appendingPathComponent(file)
                guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular,
                      url.path.withCString({ Darwin.unlink($0) }) == 0 else {
                    throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup exact SQLite file")
                }
            }
            try VodozemacSealedStore.deleteResearchKey(storeID: id)
            guard leaf.path.withCString({ Darwin.rmdir($0) }) == 0 else {
                throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup empty leaf")
            }
        }
        let locator = root.appendingPathComponent("index-id")
        guard names.contains("index-id"), try fm.attributesOfItem(atPath: locator.path)[.type] as? FileAttributeType == .typeRegular,
              locator.path.withCString({ Darwin.unlink($0) }) == 0, root.path.withCString({ Darwin.rmdir($0) }) == 0 else {
            throw DmScopedEnrollmentProbeError.assertion("enrollment cleanup exact locator and empty container")
        }
        destroyed = true
    }
}

private final class DmScopedEnrollmentActor {
    let fixture: DmScopedEnrollmentFixture
    let facade: VodozemacSessionFacade
    var account: DmSessionAccount
    let bearer: String
    let card: DmPairingCard
    var peerGeneration: Int64?
    let store: VodozemacSealedStore
    let coordinator: VodozemacDmCoordinator
    let client: VodozemacScopedRelayClient
    init(fixture: DmScopedEnrollmentFixture, facade: VodozemacSessionFacade, account: DmSessionAccount,
         bearer: String, card: DmPairingCard) throws {
        self.fixture = fixture; self.facade = facade; self.account = account; self.bearer = bearer; self.card = card
        let native = try fixture.account(userId: account.accountId)
        store = native.0; coordinator = native.1
        client = VodozemacScopedRelayClient(facade: facade, transport: try dmScopedEnrollmentTransport())
    }
    func snapshot(peer: Bool = false) throws -> DmNativeMessageSnapshot {
        try facade.messageSnapshot(credentialBinding: account.credentialBinding, peerGeneration: peer ? peerGeneration : nil)
    }
    func facts() throws -> DmNativeRelayEnrollmentState {
        guard case .enrollmentState(let state) = try facade.executeMessageOperation(snapshot: snapshot(),
            operation: .relayEnrollmentState) else { throw DmScopedEnrollmentProbeError.assertion("native enrollment fact result") }
        return state
    }
    func registrationWire() throws -> String {
        guard case .registrationRequest(let wire) = try facade.executeMessageOperation(snapshot: snapshot(),
            operation: .relayRegistrationWire) else { throw DmScopedEnrollmentProbeError.assertion("native enrollment registration wire") }
        return wire
    }
    func claimRequest() throws -> DmNativeRelayClaimRequest {
        guard case .claimRequest(let request) = try facade.executeMessageOperation(snapshot: snapshot(peer: true),
            operation: .relayClaimWire) else { throw DmScopedEnrollmentProbeError.assertion("native enrollment claim request") }
        return request
    }
    func confirm(_ peer: DmPairingCard) throws {
        guard case .pairingState(let state) = try facade.executeMessageOperation(snapshot: snapshot(),
            operation: .confirmPeer(card: peer, confirmedFingerprint: peer.fingerprint())),
              state.status == .confirmed, let generation = state.peerGeneration else {
            throw DmScopedEnrollmentProbeError.assertion("native full enrollment pairing confirmation")
        }
        peerGeneration = generation
    }
    func renew() async throws {
        let fence = try facade.fenceSession(mode: .verify)
        account = try await facade.authenticate(accessToken: bearer, authFence: fence.authFence)
    }
    func signOutAndLogin() async throws {
        _ = try facade.fenceSession(mode: .signOut)
        try await renew()
    }
}
private func dmScopedEnrollmentLogin(_ fixture: DmScopedEnrollmentFixture, userId: String, bearer: String,
                                     directory: VodozemacAccountDirectory? = nil) async throws -> DmScopedEnrollmentActor {
    DmScopedEnrollmentProtocol.install(bearer: bearer, userId: userId)
    let facade = VodozemacSessionFacade(directory: directory ?? fixture.directory)
    // Reopening selected durable state requires an explicit native logout;
    // neither a saved device label nor SDK account metadata grants a lease.
    if directory != nil { _ = try facade.fenceSession(mode: .signOut) }
    let fence = try facade.fenceSession(mode: .verify)
    let account = try await facade.authenticate(accessToken: bearer, authFence: fence.authFence)
    let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
    guard case .pairingCard(let card) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingCard) else {
        throw DmScopedEnrollmentProbeError.assertion("native enrollment pairing card")
    }
    return try DmScopedEnrollmentActor(fixture: fixture, facade: facade, account: account, bearer: bearer, card: card)
}
private struct DmScopedEnrollmentPair {
    let initiator: DmScopedEnrollmentActor
    let responder: DmScopedEnrollmentActor
}
private func dmScopedEnrollmentPair(_ first: DmScopedEnrollmentFixture, _ second: DmScopedEnrollmentFixture)
    async throws -> DmScopedEnrollmentPair {
    let a = try await dmScopedEnrollmentLogin(first, userId: "50000000-0000-4000-8000-000000000001", bearer: "enrollment-native-a")
    let b = try await dmScopedEnrollmentLogin(second, userId: "60000000-0000-4000-8000-000000000002", bearer: "enrollment-native-b")
    try a.confirm(b.card); try b.confirm(a.card)
    guard a.account.deviceId != b.account.deviceId else {
        throw DmScopedEnrollmentProbeError.assertion("enrollment distinct native devices")
    }
    return a.account.deviceId < b.account.deviceId ? DmScopedEnrollmentPair(initiator: a, responder: b)
        : DmScopedEnrollmentPair(initiator: b, responder: a)
}
private func dmScopedEnrollmentRegistered(_ actor: DmScopedEnrollmentActor, checks: DmScopedEnrollmentChecks) async throws {
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/register", result: try dmScopedEnrollmentAck(actor.card.identity))])
    let state = try await actor.client.registerDevice(snapshot: actor.snapshot())
    try checks.require(state.registration == .acknowledged && state.claim == .none && state.claimedPrekeyExpiresAt == nil,
        "valid scoped registration persists only acknowledgement fact")
    try checks.require(DmScopedEnrollmentProtocol.captured().count == 1, "scoped registration uses exactly one HTTP request")
}
private func dmScopedEnrollmentCrypto(_ store: VodozemacSealedStore) throws -> Data {
    guard let fields = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any] else {
        throw DmScopedEnrollmentProbeError.assertion("enrollment native crypto fixture")
    }
    var selected: [String: Any] = [:]
    for name in ["account", "session", "signingKey", "curve", "prekey", "identityKeyId"] {
        selected[name] = fields[name] ?? NSNull()
    }
    return try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys])
}
private func dmScopedEnrollmentVerifyClaim(_ capture: DmScopedEnrollmentCapture, actor: DmScopedEnrollmentActor,
                                           peer: DmScopedEnrollmentActor, checks: DmScopedEnrollmentChecks) throws -> DmScopedEnrollmentFrame {
    let frame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: capture.body)
    try checks.require(capture.url.absoluteString == dmScopedEnrollmentOrigin + "/v1/dispatch" && capture.method == "POST"
        && capture.userId == actor.account.accountId && frame.version == 1 && frame.protocolName == "olm-v1"
        && frame.userId == actor.account.accountId && frame.deviceId == actor.account.deviceId && frame.action == "claim",
        "captured claim binds exact verified native actor and HTTPS route")
    try checks.require(UUID(uuidString: frame.requestId)?.uuidString.lowercased() == frame.requestId,
        "native claim request nonce is canonical UUID")
    try checks.require(frame.expiresAt > capture.capturedAt && frame.expiresAt <= capture.capturedAt + 240,
        "native claim wire has bounded native-clock expiry")
    let domain: [Any] = ["thalassa-relay-request", 1, "olm-v1", frame.userId, frame.deviceId,
        frame.action, frame.requestId, frame.expiresAt, frame.payload]
    let bytes = try JSONSerialization.data(withJSONObject: domain, options: [.withoutEscapingSlashes])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(actor.card.identity.signingKey))
    try checks.require(key.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64), for: bytes),
        "captured native claim signature independently verifies")
    guard let payload = try JSONSerialization.jsonObject(with: Data(frame.payload.utf8)) as? [String], payload.count == 3 else {
        throw DmScopedEnrollmentProbeError.assertion("native claim payload shape")
    }
    try checks.require(payload[0] == peer.account.accountId && payload[1] == peer.account.deviceId
        && UUID(uuidString: payload[2])?.uuidString.lowercased() == payload[2],
        "native claim payload retains full pinned peer and canonical stable claim ID")
    return frame
}
// Raw provider signing is ONLY fixture-data construction. The application
// client still accepts/rejects through closed operations under native authority.
private func dmScopedEnrollmentSignedFixture(identity: DmPublicIdentity, signer: DmScopedEnrollmentActor,
                                              prekeyId: String, expiresAt: Int64) throws -> String {
    guard let fields = try JSONSerialization.jsonObject(with: signer.store.read().payload) as? [String: Any],
          let pickle = fields["account"] as? String else {
        throw DmScopedEnrollmentProbeError.assertion("enrollment native signing fixture")
    }
    let signed = try signPublicRequest(accountPickle: pickle, pickleKey: signer.store.providerPickleKey(),
        message: DmRelayCodec.bundleSigningBytes(identity, prekeyId: prekeyId, expiresAt: expiresAt))
    guard signed.signingKey == identity.signingKey else {
        throw DmScopedEnrollmentProbeError.assertion("enrollment genuine fixture signing key")
    }
    return try DmRelayCodec.bundleWire(identity, prekeyId: prekeyId, expiresAt: expiresAt, signature: signed.signature)
}
private func dmScopedEnrollmentSealedFixture(_ actor: DmScopedEnrollmentActor,
                                              replacing: (inout [String: Any]) throws -> Void,
                                              operation: () async throws -> Void) async throws {
    // Explicit native test seam ONLY: authenticate and reseal a disposable
    // payload, run the bounded observation, then restore the exact old payload.
    // It is not migration, server input, an app API, or rollback resistance.
    let original = try actor.store.read()
    guard var fields = try JSONSerialization.jsonObject(with: original.payload) as? [String: Any] else {
        throw DmScopedEnrollmentProbeError.assertion("enrollment sealed replacement fixture")
    }
    try replacing(&fields)
    try actor.store.commit(expectedRevision: original.revision, payload: dmScopedEnrollmentJSON(fields))
    do { try await operation() }
    catch {
        if let current = try? actor.store.read() {
            try? actor.store.commit(expectedRevision: current.revision, payload: original.payload)
        }
        throw error
    }
    let current = try actor.store.read()
    try actor.store.commit(expectedRevision: current.revision, payload: original.payload)
}
private func dmScopedEnrollmentCorruptReopen(_ actor: DmScopedEnrollmentActor,
                                             replacing: (inout [String: Any]) throws -> Void,
                                             checks: DmScopedEnrollmentChecks) async throws {
    let original = try actor.store.read()
    let nativeKey = try actor.store.providerPickleKey()
    try await dmScopedEnrollmentSealedFixture(actor, replacing: replacing) {
        let corrupt = try actor.store.read()
        let reopened = try VodozemacSealedStore.reopen(directory: actor.store.databaseURL.deletingLastPathComponent(),
            storeID: actor.store.storeID)
        defer { reopened.close() }
        try checks.unsupported("partial or mismatched sealed enrollment facts refuse coordinator reopen") {
            _ = try VodozemacDmCoordinator(store: reopened)
        }
        try checks.require(try actor.store.read() == corrupt, "unsupported enrollment reopen never recreates or rewrites state")
        try checks.require(try reopened.providerPickleKey() == nativeKey, "unsupported enrollment reopen preserves exact native Keychain key")
    }
    try checks.require(try actor.store.read().payload == original.payload, "corrupt enrollment disposable payload restored exactly")
    try checks.require(try actor.store.providerPickleKey() == nativeKey, "corrupt enrollment fixture never replaces native Keychain key")
}
private func dmScopedEnrollmentNegativeClaim(_ actor: DmScopedEnrollmentActor, result: Data,
                                             loseAfterBody: Bool = false, checks: DmScopedEnrollmentChecks) async throws {
    let gate = DmScopedEnrollmentGate()
    defer { gate.release() }
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: result,
        loseAfterBody: loseAfterBody, gate: gate)])
    let snapshot = try actor.snapshot(peer: true)
    let task = Task { try await actor.client.claimPeer(snapshot: snapshot) }
    do {
        try await dmScopedEnrollmentAwait { gate.arrived() }
        let prepared = try actor.store.read()
        try checks.require(try actor.facts().claim == .pending, "claim intent is sealed before awaited relay completion")
        gate.release()
        try await checks.unresolved("unavailable claim response remains unresolved") { _ = try await task.value }
        try checks.require(gate.releasedWithoutTimeout(), "claim negative gate released before timeout")
        try checks.require(try actor.store.read() == prepared, "invalid or lost claim response performs no sealed response CAS")
        let unavailableFacts = try actor.facts()
        try checks.require(unavailableFacts.claim == .pending && unavailableFacts.claimedPrekeyExpiresAt == nil,
            "invalid or lost claim cannot invent verified bundle or expiry")
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1, "negative claim reaches intended synthetic HTTP endpoint")
    } catch {
        task.cancel(); gate.release()
        _ = try? await task.value
        throw error
    }
}

func runDmScopedEnrollmentProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmScopedEnrollmentChecks()
    var fixtures: [DmScopedEnrollmentFixture] = []
    var settleInFlight: [() async -> Void] = []
    DmScopedEnrollmentProtocol.reset()
    defer { DmScopedEnrollmentProtocol.reset() }
    func fixture() throws -> DmScopedEnrollmentFixture {
        let value = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
        fixtures.append(value); return value
    }
    do {
        progressForResearch?("scoped-enrollment-registration-retry")
        let registrationFixture = try fixture()
        let solo = try await dmScopedEnrollmentLogin(registrationFixture,
            userId: "50000000-0000-4000-8000-000000000010", bearer: "enrollment-native-solo")
        let empty = try solo.facts()
        try checks.require(empty.registration == .none && empty.claim == .none && empty.claimedPrekeyExpiresAt == nil,
            "new native enrollment facts start unknown without server claims")
        let goodAck = try dmScopedEnrollmentAck(solo.card.identity)
        // Identical duplicate values isolate duplicate-field refusal rather
        // than a different last value accidentally failing verdict validation.
        let duplicateAck = Data(("{\"registered\":true,\"registered\":true,\"userId\":\""
            + solo.card.identity.userId + "\",\"deviceId\":\"" + solo.card.identity.deviceId + "\"}").utf8)
        let gate = DmScopedEnrollmentGate()
        defer { gate.release() }
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/register", result: goodAck, loseAfterBody: true, gate: gate),
            .init(path: "/v1/register", result: try dmScopedEnrollmentAck(solo.card.identity, malformed: true)),
            .init(path: "/v1/register", result: try dmScopedEnrollmentAck(solo.card.identity, wrongUser: true)),
            .init(path: "/v1/register", result: try dmScopedEnrollmentAck(solo.card.identity, wrongDevice: true)),
            .init(path: "/v1/register", result: duplicateAck),
            .init(path: "/v1/register", result: goodAck)])
        let originalSnapshot = try solo.snapshot()
        let lostRegister = Task { try await solo.client.registerDevice(snapshot: originalSnapshot) }
        settleInFlight.append { lostRegister.cancel(); gate.release(); _ = try? await lostRegister.value }
        try await dmScopedEnrollmentAwait { gate.arrived() }
        let preparedRegistration = try solo.store.read()
        let pendingRegistration = try solo.facts()
        try checks.require(pendingRegistration.registration == .pending && pendingRegistration.claim == .none,
            "exact signed native registration intent persists before HTTP response")
        gate.release()
        try await checks.unresolved("lost registration acknowledgement is unresolved") { _ = try await lostRegister.value }
        try checks.require(gate.releasedWithoutTimeout(), "registration loss gate released before timeout")
        try checks.require(try solo.store.read() == preparedRegistration, "lost registration acknowledgement performs no sealed response CAS")
        for _ in 0..<4 {
            let before = try solo.store.read()
            try await checks.unresolved("malformed duplicate-field or mismatched registration acknowledgement refused") {
                _ = try await solo.client.registerDevice(snapshot: solo.snapshot())
            }
            try checks.require(try solo.store.read() == before, "malformed duplicate wrong-user wrong-device ack leaves exact pending store")
            try checks.require(try solo.facts().registration == .pending, "registration negative cannot acknowledge native device")
        }
        let acknowledged = try await solo.client.registerDevice(snapshot: solo.snapshot())
        try checks.require(acknowledged.registration == .acknowledged && acknowledged.claim == .none,
            "exact registration retry eventually acknowledges only immutable native device")
        let registrations = DmScopedEnrollmentProtocol.captured()
        try checks.require(registrations.count == 6, "all registration negative and positive replies exercised actual transport")
        guard let firstRegister = registrations.first, let originalWire = String(data: firstRegister.body, encoding: .utf8) else {
            throw DmScopedEnrollmentProbeError.assertion("captured registration fixture wire")
        }
        let bundle = try DmRelayCodec.verifyBundle(originalWire, now: firstRegister.capturedAt)
        try checks.require(bundle.userId == solo.account.accountId && bundle.deviceId == solo.account.deviceId
            && bundle.signingKey == solo.card.identity.signingKey && bundle.curveKey == solo.card.identity.curve
            && bundle.prekey == solo.card.identity.prekey && bundle.identityKeyId == solo.card.identity.identityKeyId,
            "captured registration is a genuinely signed full native public identity")
        try checks.require(bundle.expiresAt > firstRegister.capturedAt && bundle.expiresAt <= firstRegister.capturedAt + 604_800,
            "registration prekey expiry is native-owned and bounded")
        for capture in registrations {
            try checks.require(capture.body == firstRegister.body && capture.url.absoluteString == dmScopedEnrollmentOrigin + "/v1/register"
                && capture.method == "POST" && capture.userId == solo.account.accountId,
                "lost registration exact retry preserves bundle signature prekey ID expiry and actor")
        }
        DmScopedEnrollmentProtocol.setScripts([])
        let beforeCachedRegistration = try solo.store.read()
        let cachedRegistration = try await solo.client.registerDevice(snapshot: solo.snapshot())
        try checks.require(cachedRegistration.registration == .acknowledged && DmScopedEnrollmentProtocol.captured().isEmpty,
            "acknowledged registration returns historical fact without HTTP")
        try checks.require(try solo.store.read() == beforeCachedRegistration, "cached registration performs no sealed CAS")
        guard case .enrollmentState(let replayedAck) = try solo.facade.executeMessageOperation(snapshot: solo.snapshot(),
            operation: .relayRegistrationResponse(wire: originalWire, response: goodAck)) else {
            throw DmScopedEnrollmentProbeError.assertion("registration exact acknowledgement replay result")
        }
        let afterAckReplay = try solo.store.read()
        try checks.require(replayedAck.registration == .acknowledged && afterAckReplay == beforeCachedRegistration,
            "exact registration acknowledgement replay is idempotent")
        let reopenedDirectory = try registrationFixture.reopen(auth: dmScopedEnrollmentAuth())
        let reopened = try await dmScopedEnrollmentLogin(registrationFixture, userId: solo.account.accountId,
            bearer: solo.bearer, directory: reopenedDirectory)
        try checks.require(reopened.card == solo.card && reopened.account.deviceId == solo.account.deviceId,
            "cold native reopen retains original immutable public keys and device")
        try checks.require(solo.facade.currentMessageContext(snapshot: originalSnapshot) == nil,
            "cold reopen explicit logout fences original facade snapshot")
        let reopenedStore = try reopened.store.read()
        let reopenedState = try await reopened.client.registerDevice(snapshot: reopened.snapshot())
        try checks.require(reopenedState.registration == .acknowledged && reopenedState.claim == .none,
            "sealed acknowledgement survives cold reopen as historical fact")
        let afterReopenCached = try reopened.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterReopenCached == reopenedStore,
            "reopened acknowledged registration neither re-registers nor performs CAS")

        progressForResearch?("scoped-enrollment-claim-retry")
        let pair = try await dmScopedEnrollmentPair(fixture(), fixture())
        try checks.require(pair.initiator.peerGeneration == 1 && pair.responder.peerGeneration == 1,
            "full native pairing initially pins generation one")
        let unregisteredStore = try pair.initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([])
        try await checks.unresolved("claim without registration acknowledgement refused") {
            _ = try await pair.initiator.client.claimPeer(snapshot: pair.initiator.snapshot(peer: true))
        }
        let afterUnregisteredRefusal = try pair.initiator.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterUnregisteredRefusal == unregisteredStore,
            "unregistered claim refusal performs neither HTTP nor sealed CAS")
        try await dmScopedEnrollmentRegistered(pair.initiator, checks: checks)
        DmScopedEnrollmentProtocol.setScripts([])
        let ownerOnlyRegistrationStore = try pair.initiator.store.read()
        try await checks.unresolved("registration refuses a peer-bound transport snapshot even when cached") {
            _ = try await pair.initiator.client.registerDevice(snapshot: pair.initiator.snapshot(peer: true))
        }
        let afterOwnerOnlyRefusal = try pair.initiator.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterOwnerOnlyRefusal == ownerOnlyRegistrationStore,
            "owner-only registration policy refuses before HTTP and sealed CAS")
        let peerWire = try pair.responder.registrationWire()
        let peerBundle = try DmRelayCodec.verifyBundle(peerWire, now: Int64(Date().timeIntervalSince1970))
        let claimResult = try dmScopedEnrollmentClaimResult(peerWire)
        let nativeRequest = try pair.initiator.claimRequest()
        let claimCrypto = try dmScopedEnrollmentCrypto(pair.initiator.store)
        try await dmScopedEnrollmentNegativeClaim(pair.initiator, result: claimResult, loseAfterBody: true, checks: checks)
        let lostCapture = DmScopedEnrollmentProtocol.captured()[0]
        let lostFrame = try dmScopedEnrollmentVerifyClaim(lostCapture, actor: pair.initiator, peer: pair.responder, checks: checks)
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: claimResult)])
        let verified = try await pair.initiator.client.claimPeer(snapshot: pair.initiator.snapshot(peer: true))
        let retryCaptures = DmScopedEnrollmentProtocol.captured()
        try checks.require(retryCaptures.count == 1, "exact claim retry makes one explicit HTTP attempt")
        let retryFrame = try dmScopedEnrollmentVerifyClaim(retryCaptures[0], actor: pair.initiator, peer: pair.responder, checks: checks)
        try checks.require(lostFrame.payload == retryFrame.payload && lostFrame.requestId != retryFrame.requestId,
            "lost claim reuses stable sealed claim ID with fresh native request nonce")
        let payload = try JSONSerialization.jsonObject(with: Data(retryFrame.payload.utf8)) as? [String]
        let peerFingerprint = try pair.responder.card.fingerprint()
        try checks.require(payload?[2] == nativeRequest.claimId && nativeRequest.peerFingerprint == peerFingerprint,
            "native claim completion intent binds stable claim ID and full peer fingerprint")
        try checks.require(verified.registration == .acknowledged && verified.claim == .verified
            && verified.claimedPrekeyExpiresAt == peerBundle.expiresAt,
            "matching full signed prekey bundle commits verified claim and original expiry")
        try checks.require(try dmScopedEnrollmentCrypto(pair.initiator.store) == claimCrypto,
            "registration and claim acknowledgement do not advance Olm or change native keys")
        DmScopedEnrollmentProtocol.setScripts([])
        let beforeCachedClaim = try pair.initiator.store.read()
        let cachedClaim = try await pair.initiator.client.claimPeer(snapshot: pair.initiator.snapshot(peer: true))
        let afterCachedClaim = try pair.initiator.store.read()
        try checks.require(cachedClaim.claim == .verified && cachedClaim.claimedPrekeyExpiresAt == peerBundle.expiresAt
            && DmScopedEnrollmentProtocol.captured().isEmpty && afterCachedClaim == beforeCachedClaim,
            "verified exact claim returns cached fact without HTTP or sealed CAS")
        guard case .enrollmentState(let replayedClaim) = try pair.initiator.facade.executeMessageOperation(
            snapshot: pair.initiator.snapshot(peer: true), operation: .relayClaimResponse(request: nativeRequest, response: claimResult)) else {
            throw DmScopedEnrollmentProbeError.assertion("claim exact completion replay result")
        }
        let afterClaimReplay = try pair.initiator.store.read()
        try checks.require(replayedClaim.claim == .verified && afterClaimReplay == beforeCachedClaim,
            "exact claim completion replay is idempotent")
        try await pair.initiator.renew()
        let renewedFacts = try pair.initiator.facts()
        try checks.require(renewedFacts.registration == .acknowledged && renewedFacts.claim == .verified,
            "same-owner native token refresh retains verified historical control facts")
        let ownerBeforeLogout = try pair.initiator.coordinator.lifecycleForResearch().owner
        try await pair.initiator.signOutAndLogin()
        let historical = try pair.initiator.facts()
        let ownerAfterLogout = try pair.initiator.coordinator.lifecycleForResearch().owner
        try checks.require(ownerAfterLogout != ownerBeforeLogout
            && historical.registration == .acknowledged && historical.claim == .historical
            && historical.claimedPrekeyExpiresAt == peerBundle.expiresAt,
            "new owner generation keeps acknowledged device and historical claim without rebinding")
        let historicalStore = try pair.initiator.store.read()
        try await checks.unresolved("historical claim cannot be promoted into new owner authority") {
            _ = try await pair.initiator.client.claimPeer(snapshot: pair.initiator.snapshot(peer: true))
        }
        let afterHistoricalRefusal = try pair.initiator.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterHistoricalRefusal == historicalStore,
            "historical claim refusal neither dispatches nor rebinds sealed intent")

        progressForResearch?("scoped-enrollment-full-pin-expiry")
        let negativePair = try await dmScopedEnrollmentPair(fixture(), fixture())
        try await dmScopedEnrollmentRegistered(negativePair.initiator, checks: checks)
        let validPeerWire = try negativePair.responder.registrationWire()
        let validPeerBundle = try DmRelayCodec.verifyBundle(validPeerWire, now: Int64(Date().timeIntervalSince1970))
        let pin = negativePair.responder.card.identity
        let substituted = DmPublicIdentity(userId: pin.userId, deviceId: pin.deviceId, identityKeyId: pin.identityKeyId,
            signingKey: negativePair.initiator.card.identity.signingKey, curve: pin.curve, prekey: pin.prekey)
        let substitutedWire = try dmScopedEnrollmentSignedFixture(identity: substituted, signer: negativePair.initiator,
            prekeyId: validPeerBundle.prekeyId, expiresAt: validPeerBundle.expiresAt)
        let genuineSubstitution = try DmRelayCodec.verifyBundle(substitutedWire, now: Int64(Date().timeIntervalSince1970))
        try checks.require(genuineSubstitution.userId == pin.userId && genuineSubstitution.deviceId == pin.deviceId
            && genuineSubstitution.identityKeyId == pin.identityKeyId && genuineSubstitution.curveKey == pin.curve
            && genuineSubstitution.prekey == pin.prekey && genuineSubstitution.signingKey != pin.signingKey,
            "signing-only substitution has valid signature and otherwise identical pinned identity")
        let negativeCrypto = try dmScopedEnrollmentCrypto(negativePair.initiator.store)
        try await dmScopedEnrollmentNegativeClaim(negativePair.initiator,
            result: dmScopedEnrollmentClaimResult(substitutedWire), checks: checks)
        let substitutedFrame = try dmScopedEnrollmentVerifyClaim(DmScopedEnrollmentProtocol.captured()[0],
            actor: negativePair.initiator, peer: negativePair.responder, checks: checks)
        let past: Int64 = 1_600_000_000
        let expiredWire = try dmScopedEnrollmentSignedFixture(identity: pin, signer: negativePair.responder,
            prekeyId: validPeerBundle.prekeyId, expiresAt: past + 3600)
        let genuinelyExpired = try DmRelayCodec.verifyBundle(expiredWire, now: past + 1)
        try checks.require(genuinelyExpired.signingKey == pin.signingKey
            && genuinelyExpired.expiresAt < Int64(Date().timeIntervalSince1970),
            "expired fixture is genuinely signed by the full pinned peer")
        try await dmScopedEnrollmentNegativeClaim(negativePair.initiator,
            result: dmScopedEnrollmentClaimResult(expiredWire), checks: checks)
        let expiredFrame = try dmScopedEnrollmentVerifyClaim(DmScopedEnrollmentProtocol.captured()[0],
            actor: negativePair.initiator, peer: negativePair.responder, checks: checks)
        progressForResearch?("scoped-enrollment-monotonic-fixture-floor")
        let floorSnapshot = try negativePair.initiator.snapshot(peer: true)
        let floorRequest = try negativePair.initiator.claimRequest()
        let soonExpiry = floorRequest.startedAtSeconds + 10
        let soonWire = try dmScopedEnrollmentSignedFixture(identity: pin, signer: negativePair.responder,
            prekeyId: validPeerBundle.prekeyId, expiresAt: soonExpiry)
        let soonResult = try dmScopedEnrollmentClaimResult(soonWire)
        let wallValid = try DmRelayCodec.verifyBundle(soonWire, now: Int64(Date().timeIntervalSince1970))
        try checks.require(wallValid.expiresAt == soonExpiry && wallValid.signingKey == pin.signingKey,
            "monotonic seam uses genuine pinned bundle still valid at real wall time")
        // Native-only fixture token copy: no system clock change or delay. All
        // authority fields stay exact; only the monotonic start is backdated.
        let backdated = DmNativeRelayClaimRequest(wire: floorRequest.wire, context: floorRequest.context,
            claimId: floorRequest.claimId, peerFingerprint: floorRequest.peerFingerprint,
            startedAtSeconds: floorRequest.startedAtSeconds, startedAt: floorRequest.startedAt.advanced(by: .seconds(-20)))
        let beforeFloor = try negativePair.initiator.store.read()
        try checks.require(try negativePair.initiator.facts().claim == .pending,
            "monotonic expiry refusal begins without earlier confirmed-bundle conflict")
        try checks.refuses("native monotonic completion floor refuses elapsed-expired bundle despite wall validity") {
            _ = try negativePair.initiator.facade.executeMessageOperation(snapshot: floorSnapshot,
                operation: .relayClaimResponse(request: backdated, response: soonResult))
        }
        try checks.require(try negativePair.initiator.store.read() == beforeFloor,
            "monotonic completion refusal performs no sealed CAS")
        // Same bytes and untouched native request are a closed-path positive
        // control. Restore only this disposable fixture's pending payload before
        // the regular HTTPS retry below; this does not claim rollback safety.
        do {
            guard case .enrollmentState(let floorControl) = try negativePair.initiator.facade.executeMessageOperation(
                snapshot: floorSnapshot, operation: .relayClaimResponse(request: floorRequest, response: soonResult)) else {
                throw DmScopedEnrollmentProbeError.assertion("monotonic fixture positive completion result")
            }
            try checks.require(floorControl.claim == .verified && floorControl.claimedPrekeyExpiresAt == soonExpiry,
                "original native token accepts identical wall-valid bundle as positive control")
        } catch {
            if let current = try? negativePair.initiator.store.read() {
                try? negativePair.initiator.store.commit(expectedRevision: current.revision, payload: beforeFloor.payload)
            }
            throw error
        }
        let afterFloorControl = try negativePair.initiator.store.read()
        try negativePair.initiator.store.commit(expectedRevision: afterFloorControl.revision, payload: beforeFloor.payload)
        try checks.require(try negativePair.initiator.store.read().payload == beforeFloor.payload,
            "monotonic fixture positive control restores exact disposable pending payload")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmScopedEnrollmentClaimResult(validPeerWire))])
        let validAfterNegatives = try await negativePair.initiator.client.claimPeer(snapshot: negativePair.initiator.snapshot(peer: true))
        let finalFrame = try dmScopedEnrollmentVerifyClaim(DmScopedEnrollmentProtocol.captured()[0],
            actor: negativePair.initiator, peer: negativePair.responder, checks: checks)
        try checks.require(validAfterNegatives.claim == .verified && substitutedFrame.payload == expiredFrame.payload
            && expiredFrame.payload == finalFrame.payload
            && Set([substitutedFrame.requestId, expiredFrame.requestId, finalFrame.requestId]).count == 3,
            "invalid full-pin and expired replies preserve claim ID for successful fresh-nonce retry")
        try checks.require(try dmScopedEnrollmentCrypto(negativePair.initiator.store) == negativeCrypto,
            "negative claim responses and positive retry never mutate ratchet or immutable keys")
        progressForResearch?("scoped-enrollment-expired-stored-facts")
        let verifiedBeforeExpiryFixture = try negativePair.initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([])
        try await dmScopedEnrollmentSealedFixture(negativePair.initiator, replacing: { fields in
            guard var confirmation = fields["claimConfirmation"] as? [String: Any] else {
                throw DmScopedEnrollmentProbeError.assertion("expired stored confirmation fixture")
            }
            confirmation["signedBundle"] = expiredWire
            fields["claimConfirmation"] = confirmation
        }) {
            let expiredStore = try negativePair.initiator.store.read()
            let reopened = try VodozemacSealedStore.reopen(
                directory: negativePair.initiator.store.databaseURL.deletingLastPathComponent(),
                storeID: negativePair.initiator.store.storeID)
            defer { reopened.close() }
            let reopenedCoordinator = try VodozemacDmCoordinator(store: reopened)
            try checks.require(try reopenedCoordinator.lifecycleForResearch().owner
                == negativePair.initiator.coordinator.lifecycleForResearch().owner,
                "genuinely signed expired saved claim permits structural coordinator reopen")
            let expiredFacts = try negativePair.initiator.facts()
            try checks.require(expiredFacts.registration == .acknowledged && expiredFacts.claim == .expired
                && expiredFacts.claimedPrekeyExpiresAt == genuinelyExpired.expiresAt,
                "expired saved confirmation remains readable evidence with original expiry")
            let cachedExpired = try await negativePair.initiator.client.claimPeer(snapshot: negativePair.initiator.snapshot(peer: true))
            let afterExpiredCached = try negativePair.initiator.store.read()
            try checks.require(cachedExpired.claim == .expired && cachedExpired.claimedPrekeyExpiresAt == genuinelyExpired.expiresAt
                && DmScopedEnrollmentProtocol.captured().isEmpty && afterExpiredCached == expiredStore,
                "expired cached claim does not renew prekey dispatch HTTP or perform sealed CAS")
        }
        try checks.require(try negativePair.initiator.store.read().payload == verifiedBeforeExpiryFixture.payload,
            "expired saved confirmation fixture restores exact previously verified payload")
        try checks.require(try negativePair.initiator.facts().claim == .verified,
            "restored disposable confirmation retains original verified fact")

        progressForResearch?("scoped-enrollment-partial-state-reopen")
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            fields["registrationAcknowledgement"] = Data(repeating: 0, count: 16).base64EncodedString()
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            fields["registrationAcknowledgement"] = Data(repeating: 0, count: 32).base64EncodedString()
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            fields.removeValue(forKey: "registrationIntent")
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            fields.removeValue(forKey: "registrationAcknowledgement")
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            guard var confirmation = fields["claimConfirmation"] as? [String: Any] else {
                throw DmScopedEnrollmentProbeError.assertion("partial confirmation fixture")
            }
            confirmation.removeValue(forKey: "peerFingerprint")
            fields["claimConfirmation"] = confirmation
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            guard var confirmation = fields["claimConfirmation"] as? [String: Any] else {
                throw DmScopedEnrollmentProbeError.assertion("mismatched confirmation fixture")
            }
            confirmation["claimId"] = UUID().uuidString.lowercased()
            fields["claimConfirmation"] = confirmation
        }, checks: checks)
        try await dmScopedEnrollmentCorruptReopen(negativePair.initiator, replacing: { fields in
            guard var confirmation = fields["claimConfirmation"] as? [String: Any] else {
                throw DmScopedEnrollmentProbeError.assertion("mismatched full-pin confirmation fixture")
            }
            confirmation["signedBundle"] = substitutedWire
            fields["claimConfirmation"] = confirmation
        }, checks: checks)
        try await dmScopedEnrollmentRegistered(negativePair.responder, checks: checks)
        DmScopedEnrollmentProtocol.setScripts([])
        let responderStore = try negativePair.responder.store.read()
        try await checks.unresolved("higher-device responder cannot initiate a claim") {
            _ = try await negativePair.responder.client.claimPeer(snapshot: negativePair.responder.snapshot(peer: true))
        }
        let afterResponderRefusal = try negativePair.responder.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterResponderRefusal == responderStore,
            "responder claim policy refuses before HTTP and sealed CAS")
        try checks.require(try negativePair.responder.facts().claim == .none,
            "responder refusal does not manufacture a pending claim")

        progressForResearch?("scoped-enrollment-authority-races")
        // Four distinct stores prevent a completed/pending earlier phase from
        // masking the exact registration/claim refresh/logout completion race.
        for claiming in [false, true] {
            for logout in [false, true] {
                let actor: DmScopedEnrollmentActor
                let result: Data
                if claiming {
                    let racePair = try await dmScopedEnrollmentPair(fixture(), fixture())
                    actor = racePair.initiator
                    try await dmScopedEnrollmentRegistered(actor, checks: checks)
                    result = try dmScopedEnrollmentClaimResult(racePair.responder.registrationWire())
                } else {
                    actor = try await dmScopedEnrollmentLogin(fixture(),
                        userId: "50000000-0000-4000-8000-000000000020", bearer: "enrollment-native-race")
                    result = try dmScopedEnrollmentAck(actor.card.identity)
                }
                let raceGate = DmScopedEnrollmentGate()
                defer { raceGate.release() }
                DmScopedEnrollmentProtocol.setScripts([.init(path: claiming ? "/v1/dispatch" : "/v1/register",
                    result: result, gate: raceGate)])
                let stale = try actor.snapshot(peer: claiming)
                let task = Task {
                    if claiming { return try await actor.client.claimPeer(snapshot: stale) }
                    return try await actor.client.registerDevice(snapshot: stale)
                }
                settleInFlight.append { task.cancel(); raceGate.release(); _ = try? await task.value }
                try await dmScopedEnrollmentAwait { raceGate.arrived() }
                let pending = try actor.facts()
                try checks.require(claiming ? pending.claim == .pending : pending.registration == .pending,
                    "in-flight race begins only after durable enrollment intent exists")
                if logout { _ = try actor.facade.fenceSession(mode: .signOut) }
                else { try await actor.renew() }
                let winningStore = try actor.store.read()
                try checks.require(actor.facade.currentMessageContext(snapshot: stale) == nil,
                    "refresh or logout invalidates original in-flight enrollment snapshot")
                raceGate.release()
                try await checks.unresolved("stale registration or claim response cannot commit") { _ = try await task.value }
                try checks.require(raceGate.releasedWithoutTimeout(), "stale completion gate actually released before timeout")
                try checks.require(try actor.store.read() == winningStore,
                    "stale reply cannot overwrite durable native refresh or logout winner")
                let raceCaptures = DmScopedEnrollmentProtocol.captured()
                try checks.require(raceCaptures.count == 1 && raceCaptures[0].url.path == (claiming ? "/v1/dispatch" : "/v1/register"),
                    "stale completion test dispatched its intended enrollment HTTP phase")
                if logout { try await actor.renew() }
                let after = try actor.facts()
                try checks.require(claiming ? (after.registration == .acknowledged && after.claim != .verified)
                    : (after.registration == .pending && after.claim == .none),
                    "new authority sees no acknowledgement or verification fabricated by stale completion")
            }
        }

        progressForResearch?("scoped-enrollment-legacy-unknown")
        let legacyPair = try await dmScopedEnrollmentPair(fixture(), fixture())
        let lifecycle = try legacyPair.initiator.coordinator.lifecycleForResearch()
        let now = Int64(Date().timeIntervalSince1970)
        // Earlier raw research signing persisted intents but no trustworthy
        // server acknowledgement/claim confirmation. Closed reads must not
        // promote those optional-field-free facts after schema-compatible reopen.
        _ = try legacyPair.initiator.coordinator.signedBundleForResearch(prekeyId: "legacy-enrollment-prekey",
            expiresAt: now + 3600, now: now, owner: lifecycle.owner, credentialEpoch: lifecycle.credentialEpoch)
        guard let legacyGeneration = legacyPair.initiator.peerGeneration else {
            throw DmScopedEnrollmentProbeError.assertion("legacy native paired generation")
        }
        _ = try legacyPair.initiator.coordinator.signedClaimForResearch(requestId: UUID().uuidString.lowercased(),
            expiresAt: now + 240, now: now, owner: lifecycle.owner, peerGeneration: legacyGeneration,
            credentialEpoch: lifecycle.credentialEpoch)
        let legacyStore = try legacyPair.initiator.store.read()
        let legacyFacts = try legacyPair.initiator.facts()
        let afterLegacyRead = try legacyPair.initiator.store.read()
        try checks.require(legacyFacts.registration == .pending && legacyFacts.claim == .pending
            && legacyFacts.claimedPrekeyExpiresAt == nil && afterLegacyRead == legacyStore,
            "legacy raw signed intents remain unacknowledged and unverified without read CAS")
        DmScopedEnrollmentProtocol.setScripts([])
        try await checks.unresolved("legacy signed intents do not authorize scoped peer claim") {
            _ = try await legacyPair.initiator.client.claimPeer(snapshot: legacyPair.initiator.snapshot(peer: true))
        }
        let afterLegacyRefusal = try legacyPair.initiator.store.read()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && afterLegacyRefusal == legacyStore,
            "legacy unknown acknowledgement refuses claim before HTTP and mutation")

        progressForResearch?("scoped-enrollment-cleanup")
        for settle in settleInFlight { await settle() }
        for value in fixtures { try value.destroy() }
        try checks.require(fixtures.allSatisfy { !FileManager.default.fileExists(atPath: $0.root.path) },
            "all exact disposable enrollment directories and Keychain namespaces cleaned")
        return checks.assertions
    } catch {
        // No suspended response may resume against already-destroyed fixtures.
        for settle in settleInFlight { await settle() }
        for value in fixtures { try? value.destroy() }
        throw error
    }
}
