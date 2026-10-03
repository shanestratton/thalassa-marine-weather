// ISOLATED NATIVE FIXTURES: synthetic URLProtocol Auth and relay responses,
// real provider bytes, Directory/Facade authority, Keychain and sealed SQLite.
// No live login/relay, scoped enrollment/claim completion, app/plugin activation,
// physical device exchange or independent security audit is established here.
// Accepted means relay-accepted only, never peer delivery or reading. Complete
// structural inbox validation is tested; per-row storage is NOT batch atomic.
import Foundation
import Darwin
import CryptoKit

enum DmScopedRelayProbeError: Error { case assertion(String) }

private final class DmScopedRelayChecks {
    private(set) var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmScopedRelayProbeError.assertion(label) }
        assertions += 1
    }
    func unresolved(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch DmRelayTransportError.unresolved { assertions += 1; return }
        throw DmScopedRelayProbeError.assertion(label)
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { assertions += 1; return }
        throw DmScopedRelayProbeError.assertion(label)
    }
}

private let dmScopedRelayOrigin = "https://scoped-relay-fixture.invalid"
private let dmScopedRelayHost = "scoped-relay-fixture.invalid"

private final class DmScopedRelayGate: @unchecked Sendable {
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

private enum DmScopedRelayReply {
    case accepted, rejected(DmRejectionReason), malformed, lostResponse, inbox(Data)
}
private struct DmScopedRelayScript {
    let reply: DmScopedRelayReply
    let gate: DmScopedRelayGate?
    init(_ reply: DmScopedRelayReply, gate: DmScopedRelayGate? = nil) { self.reply = reply; self.gate = gate }
}
private struct DmScopedRelayCapture {
    let body: Data
    let userId: String
    let url: URL
    let method: String
}

private func dmScopedRelayRecordFields(_ record: DmOutboxRecord) throws -> [String: Any] {
    guard let fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmScopedRelayProbeError.assertion("native relay fixture record encoding")
    }
    return fields
}
private func dmScopedRelayReceipt(_ record: DmOutboxRecord, reason: DmRejectionReason? = nil) throws -> Data {
    var fields = try dmScopedRelayRecordFields(record)
    fields["accepted"] = reason == nil
    if let reason { fields["reason"] = reason.rawValue }
    return try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
}
private func dmScopedRelayInbox(_ records: [DmOutboxRecord], badSecond: Bool = false,
                                extraRow: Bool = false) throws -> Data {
    var rows = try records.enumerated().map { offset, record -> [String: Any] in
        var fields = try dmScopedRelayRecordFields(record)
        fields["accepted"] = true
        fields["serverId"] = offset + 1
        if badSecond && offset == 1 { fields["accepted"] = 1 } // Number is deliberately not Boolean.
        return fields
    }
    if extraRow, let first = records.first {
        // A unique, structurally valid seventeenth row. Its copied ciphertext
        // is NOT claimed to authenticate this new ID and must never be opened:
        // the full structural batch bound must refuse before all row mutation.
        let original = try DmEnvelope.decode(first.serializedEnvelope)
        let envelope = try DmEnvelope(clientMessageId: "scoped-extra-structural-row",
            senderDeviceId: original.senderDeviceId, recipientDeviceId: original.recipientDeviceId,
            wire: original.wire).serialized()
        let record = DmOutboxRecord(ownerUserId: first.ownerUserId, ownerSessionGeneration: first.ownerSessionGeneration,
            recipientUserId: first.recipientUserId, recipientIdentityKeyId: first.recipientIdentityKeyId,
            recipientIdentityGeneration: first.recipientIdentityGeneration, serializedEnvelope: envelope)
        var extra = try dmScopedRelayRecordFields(record)
        extra["accepted"] = true; extra["serverId"] = rows.count + 1; rows.append(extra)
    }
    // The actual HTTP result codec consumes a top-level array, not the local
    // SQL-proof artifact's {messages: ...} wrapper.
    return try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys, .withoutEscapingSlashes])
}

private final class DmScopedRelayProtocol: URLProtocol, @unchecked Sendable {
    private static let fixtureLock = NSLock()
    private static var users: [String: String] = [:]
    private static var scripts: [DmScopedRelayScript] = []
    private static var requests: [DmScopedRelayCapture] = []
    private let stateLock = NSRecursiveLock()
    private var stopped = false

    static func reset() {
        fixtureLock.lock(); users.removeAll(); scripts.removeAll(); requests.removeAll(); fixtureLock.unlock()
    }
    static func install(bearer: String, userId: String) {
        fixtureLock.lock(); users["Bearer " + bearer] = userId; fixtureLock.unlock()
    }
    static func setScripts(_ values: [DmScopedRelayScript]) {
        fixtureLock.lock(); scripts = values; requests.removeAll(); fixtureLock.unlock()
    }
    static func captured() -> [DmScopedRelayCapture] { fixtureLock.lock(); defer { fixtureLock.unlock() }; return requests }
    // Intercept even unexpected URLs. A fixture routing regression must fail,
    // never escape this synthetic session to a real network endpoint.
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, url.scheme == "https", url.host == dmScopedRelayHost,
              url.query == nil, url.fragment == nil else { fail(); return }
        Self.fixtureLock.lock()
        let user = Self.users[request.value(forHTTPHeaderField: "Authorization") ?? ""]
        Self.fixtureLock.unlock()
        guard let user else { fail(); return }
        if url.path == "/auth/v1/user", request.httpMethod == "GET" {
            // SDK-looking device metadata is deliberately not native authority.
            respond(Data("{\"id\":\"\(user)\",\"user_metadata\":{\"deviceId\":\"spoofed-device\"}}".utf8), url: url)
            return
        }
        guard url.path == "/v1/dispatch", request.httpMethod == "POST" else { fail(); return }
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
              let frame = try? JSONDecoder().decode(DmScopedRelayFrame.self, from: body), frame.userId == user else {
            fail(); return
        }
        Self.fixtureLock.lock()
        Self.requests.append(DmScopedRelayCapture(body: body, userId: user, url: url, method: request.httpMethod ?? ""))
        let script = Self.scripts.isEmpty ? nil : Self.scripts.removeFirst()
        Self.fixtureLock.unlock()
        guard let script else { fail(); return }
        // Never block URLProtocol's loading queue: a concurrent native Auth
        // refresh must be able to run while this synthetic relay reply is held.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            if let gate = script.gate, !gate.hold() { fail(); return }
            do {
                let bytes: Data
                switch script.reply {
                case .inbox(let data): bytes = data
                case .accepted, .rejected, .malformed, .lostResponse:
                    guard frame.action == "send" else { fail(); return }
                    let record = try JSONDecoder().decode(DmOutboxRecord.self, from: Data(frame.payload.utf8))
                    switch script.reply {
                    case .rejected(let reason): bytes = try dmScopedRelayReceipt(record, reason: reason)
                    case .malformed:
                        var fields = try dmScopedRelayRecordFields(record); fields["accepted"] = 1
                        bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
                    default: bytes = try dmScopedRelayReceipt(record)
                    }
                }
                if case .lostResponse = script.reply { respond(bytes, url: url, loseAfterBody: true) }
                else { respond(bytes, url: url) }
            } catch { fail() }
        }
    }
    private func respond(_ body: Data, url: URL, loseAfterBody: Bool = false) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !stopped else { return }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        // Auth /user remains raw. Every relay reply, including a response lost
        // after its body, has the actual transport's exact outer JSON framing.
        var responseBody = body
        if url.path == "/v1/dispatch" {
            responseBody = Data("{\"version\":1,\"result\":".utf8)
            responseBody.append(body)
            responseBody.append(Data("}".utf8))
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseBody)
        if loseAfterBody { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
        else { client?.urlProtocolDidFinishLoading(self) }
    }
    private func fail() {
        stateLock.lock(); defer { stateLock.unlock() }
        if !stopped { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)) }
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

private struct DmScopedRelayFrame: Decodable {
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

private func dmScopedRelayConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DmScopedRelayProtocol.self]
    return configuration
}
private func dmScopedRelayAuth() throws -> VodozemacSupabaseAuth {
    try VodozemacSupabaseAuth(projectOrigin: dmScopedRelayOrigin,
        publicApiKey: "sb_publishable_scoped_relay_fixture", deadlineSeconds: 3,
        configurationForResearch: { dmScopedRelayConfiguration() })
}
private func dmScopedRelayTransport() throws -> VodozemacRelayTransport {
    try VodozemacRelayTransport(serviceOrigin: dmScopedRelayOrigin, deadlineSeconds: 3,
        configurationForResearch: { dmScopedRelayConfiguration() })
}
private func dmScopedRelayAwait(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while !condition() {
        guard ContinuousClock.now < deadline else { throw DmScopedRelayProbeError.assertion("scoped relay fixture bounded arrival") }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private final class DmScopedRelayFixture {
    static let conversationId = "scoped-native-relay-fixture"
    let directory: VodozemacAccountDirectory
    let root: URL
    let index: VodozemacSealedStore
    private var ownedIDs: Set<UUID> = []
    private var handles: [VodozemacSealedStore] = []
    private var destroyed = false
    init(auth: VodozemacSupabaseAuth) throws {
        directory = try VodozemacAccountDirectory.create(parentDirectory: FileManager.default.temporaryDirectory,
            authenticator: auth, conversationId: Self.conversationId)
        root = directory.directoryURL
        let locator = try String(contentsOf: root.appendingPathComponent("index-id"), encoding: .utf8)
        guard let id = UUID(uuidString: String(locator.dropLast())), locator == id.uuidString.lowercased() + "\n" else {
            throw DmScopedRelayProbeError.assertion("scoped relay fixture locator")
        }
        index = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(id.uuidString.lowercased()), storeID: id)
        ownedIDs.insert(id)
    }
    private func rows() throws -> [[String: Any]] {
        guard let fields = try JSONSerialization.jsonObject(with: index.read().payload) as? [String: Any],
              let rows = fields["accounts"] as? [[String: Any]] else {
            throw DmScopedRelayProbeError.assertion("scoped relay fixture sealed index")
        }
        for row in rows {
            guard let name = row["storeId"] as? String, let id = UUID(uuidString: name), name == id.uuidString.lowercased() else {
                throw DmScopedRelayProbeError.assertion("scoped relay fixture validated namespace")
            }
            ownedIDs.insert(id)
        }
        return rows
    }
    func account(userId: String) throws -> (VodozemacSealedStore, VodozemacDmCoordinator) {
        guard let row = try rows().first(where: { $0["userId"] as? String == userId }),
              let name = row["storeId"] as? String, let id = UUID(uuidString: name) else {
            throw DmScopedRelayProbeError.assertion("scoped relay fixture account")
        }
        let store = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(name), storeID: id)
        handles.append(store)
        return (store, try VodozemacDmCoordinator(store: store))
    }
    func destroy() throws {
        guard !destroyed else { return }
        _ = try rows()
        try? directory.signOut()
        directory.closeForResearch()
        for handle in handles { handle.close() }
        index.close()
        let fm = FileManager.default
        let names = Set(try fm.contentsOfDirectory(atPath: root.path))
        let allowed = Set(ownedIDs.map { $0.uuidString.lowercased() }).union(["index-id"])
        guard names.isSubset(of: allowed) else { throw DmScopedRelayProbeError.assertion("scoped relay cleanup exact container") }
        for id in ownedIDs {
            let name = id.uuidString.lowercased()
            guard names.contains(name) else { continue }
            let leaf = root.appendingPathComponent(name)
            guard try fm.attributesOfItem(atPath: leaf.path)[.type] as? FileAttributeType == .typeDirectory else {
                throw DmScopedRelayProbeError.assertion("scoped relay cleanup exact directory")
            }
            let files = Set(try fm.contentsOfDirectory(atPath: leaf.path))
            guard files.isSubset(of: ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]) else {
                throw DmScopedRelayProbeError.assertion("scoped relay cleanup exact SQLite leaves")
            }
            for file in files {
                let url = leaf.appendingPathComponent(file)
                guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular,
                      url.path.withCString({ Darwin.unlink($0) }) == 0 else {
                    throw DmScopedRelayProbeError.assertion("scoped relay cleanup exact SQLite file")
                }
            }
            try VodozemacSealedStore.deleteResearchKey(storeID: id)
            guard leaf.path.withCString({ Darwin.rmdir($0) }) == 0 else {
                throw DmScopedRelayProbeError.assertion("scoped relay cleanup empty leaf")
            }
        }
        let locator = root.appendingPathComponent("index-id")
        guard names.contains("index-id"), try fm.attributesOfItem(atPath: locator.path)[.type] as? FileAttributeType == .typeRegular,
              locator.path.withCString({ Darwin.unlink($0) }) == 0, root.path.withCString({ Darwin.rmdir($0) }) == 0 else {
            throw DmScopedRelayProbeError.assertion("scoped relay cleanup exact locator and empty container")
        }
        destroyed = true
    }
}

private final class DmScopedRelayActor {
    let fixture: DmScopedRelayFixture
    let facade: VodozemacSessionFacade
    var account: DmSessionAccount
    let bearer: String
    let userId: String
    let card: DmPairingCard
    let generation: Int64
    let store: VodozemacSealedStore
    let coordinator: VodozemacDmCoordinator
    let client: VodozemacScopedRelayClient
    init(fixture: DmScopedRelayFixture, facade: VodozemacSessionFacade, account: DmSessionAccount,
         bearer: String, card: DmPairingCard, generation: Int64) throws {
        self.fixture = fixture; self.facade = facade; self.account = account; self.bearer = bearer
        userId = account.accountId; self.card = card; self.generation = generation
        let native = try fixture.account(userId: account.accountId)
        store = native.0; coordinator = native.1
        client = VodozemacScopedRelayClient(facade: facade, transport: try dmScopedRelayTransport())
    }
    func snapshot() throws -> DmNativeMessageSnapshot {
        try facade.messageSnapshot(credentialBinding: account.credentialBinding, peerGeneration: generation)
    }
    func renew() async throws {
        let fence = try facade.fenceSession(mode: .verify)
        account = try await facade.authenticate(accessToken: bearer, authFence: fence.authFence)
    }
    func prepare(id: String, text: String) throws -> DmOutboxRecord {
        guard case .outbox(let record) = try facade.executeMessageOperation(snapshot: snapshot(),
            operation: .prepareText(clientMessageId: id, text: text)) else {
            throw DmScopedRelayProbeError.assertion("scoped relay native preparation result")
        }
        return record
    }
    func thread() throws -> DmNativeThread {
        guard case .thread(let value) = try facade.executeMessageOperation(snapshot: snapshot(), operation: .thread) else {
            throw DmScopedRelayProbeError.assertion("scoped relay native thread result")
        }
        return value
    }
    func message(id: String, direction: DmNativeThreadDirection) throws -> DmNativeThreadMessage {
        let rows = try thread().messages.filter { $0.clientMessageId == id && $0.direction == direction }
        guard rows.count == 1 else { throw DmScopedRelayProbeError.assertion("scoped relay exact native message") }
        return rows[0]
    }
}

private struct DmScopedRelayPair {
    let initiator: DmScopedRelayActor
    let responder: DmScopedRelayActor
}
private func dmScopedRelayLogin(_ fixture: DmScopedRelayFixture, userId: String, bearer: String)
    async throws -> (VodozemacSessionFacade, DmSessionAccount, DmPairingCard) {
    DmScopedRelayProtocol.install(bearer: bearer, userId: userId)
    let facade = VodozemacSessionFacade(directory: fixture.directory)
    let fence = try facade.fenceSession(mode: .verify)
    let account = try await facade.authenticate(accessToken: bearer, authFence: fence.authFence)
    let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
    guard case .pairingCard(let card) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingCard) else {
        throw DmScopedRelayProbeError.assertion("scoped relay native pairing card")
    }
    return (facade, account, card)
}
private func dmScopedRelayPair(_ first: DmScopedRelayFixture, _ second: DmScopedRelayFixture) async throws -> DmScopedRelayPair {
    let a = try await dmScopedRelayLogin(first, userId: "30000000-0000-4000-8000-000000000001", bearer: "scoped-native-a")
    let b = try await dmScopedRelayLogin(second, userId: "40000000-0000-4000-8000-000000000002", bearer: "scoped-native-b")
    let asnap = try a.0.messageSnapshot(credentialBinding: a.1.credentialBinding)
    let bsnap = try b.0.messageSnapshot(credentialBinding: b.1.credentialBinding)
    guard case .pairingState(let ap) = try a.0.executeMessageOperation(snapshot: asnap,
        operation: .confirmPeer(card: b.2, confirmedFingerprint: b.2.fingerprint())),
          case .pairingState(let bp) = try b.0.executeMessageOperation(snapshot: bsnap,
        operation: .confirmPeer(card: a.2, confirmedFingerprint: a.2.fingerprint())),
          ap.status == .confirmed, bp.status == .confirmed, let ag = ap.peerGeneration, let bg = bp.peerGeneration else {
        throw DmScopedRelayProbeError.assertion("scoped relay reciprocal full native confirmation")
    }
    let aa = try DmScopedRelayActor(fixture: first, facade: a.0, account: a.1, bearer: "scoped-native-a", card: a.2, generation: ag)
    let ba = try DmScopedRelayActor(fixture: second, facade: b.0, account: b.1, bearer: "scoped-native-b", card: b.2, generation: bg)
    guard aa.account.deviceId != ba.account.deviceId else { throw DmScopedRelayProbeError.assertion("scoped relay distinct native devices") }
    return aa.account.deviceId < ba.account.deviceId ? DmScopedRelayPair(initiator: aa, responder: ba)
        : DmScopedRelayPair(initiator: ba, responder: aa)
}

private func dmScopedRelayNormalized(_ store: VodozemacSealedStore) throws -> Data {
    try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: store.read().payload), options: [.sortedKeys])
}
private func dmScopedRelayCrypto(_ store: VodozemacSealedStore) throws -> Data {
    guard let fields = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any] else {
        throw DmScopedRelayProbeError.assertion("scoped relay native crypto fixture")
    }
    var selected: [String: Any] = [:]
    for name in ["account", "session", "signingKey", "curve", "prekey", "identityKeyId"] { selected[name] = fields[name] ?? NSNull() }
    return try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys])
}
private func dmScopedRelayVerify(_ capture: DmScopedRelayCapture, actor: DmScopedRelayActor,
                                 action: String, checks: DmScopedRelayChecks) throws -> DmScopedRelayFrame {
    let frame = try JSONDecoder().decode(DmScopedRelayFrame.self, from: capture.body)
    try checks.require(capture.url.absoluteString == dmScopedRelayOrigin + "/v1/dispatch" && capture.method == "POST"
        && capture.userId == actor.userId && frame.version == 1 && frame.protocolName == "olm-v1"
        && frame.userId == actor.userId && frame.deviceId == actor.account.deviceId && frame.action == action,
        "captured HTTPS request retains exact verified native actor and action")
    let nonce = UUID(uuidString: frame.requestId)
    try checks.require(nonce?.uuidString.lowercased() == frame.requestId, "native request nonce is canonical fresh UUID")
    let signing: [Any] = ["thalassa-relay-request", 1, "olm-v1", frame.userId, frame.deviceId,
        frame.action, frame.requestId, frame.expiresAt, frame.payload]
    let bytes = try JSONSerialization.data(withJSONObject: signing, options: [.withoutEscapingSlashes])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(actor.card.identity.signingKey))
    try checks.require(key.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64), for: bytes),
        "captured native domain signature independently verifies")
    return frame
}
private func dmScopedRelayCommitted(_ actor: DmScopedRelayActor, record: DmOutboxRecord, response: Data) throws -> DmRelayReceipt {
    guard case .relayReceipt(let receipt) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: .relaySendReceipt(record: record, response: response)) else {
        throw DmScopedRelayProbeError.assertion("scoped relay closed receipt result")
    }
    return receipt
}

private func dmScopedRelayLostRetry(_ pair: DmScopedRelayPair, checks: DmScopedRelayChecks) async throws {
    let actor = pair.initiator, text = "fixture uncertain native send"
    let record = try actor.prepare(id: "scoped-lost-response", text: text), snapshot = try actor.snapshot()
    let pending = try actor.message(id: "scoped-lost-response", direction: .outgoing), crypto = try dmScopedRelayCrypto(actor.store)
    let envelope = try DmEnvelope.decode(record.serializedEnvelope)
    try checks.require(try envelope.messageType == "prekey" && envelope.wire.body.count > 32,
        "pending send contains actual provider ciphertext, not a fixed ciphertext fixture")
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.lostResponse), DmScopedRelayScript(.accepted)])
    try await checks.unresolved("lost response leaves outcome unresolved") {
        _ = try await actor.client.sendPending(clientMessageId: "scoped-lost-response", snapshot: snapshot)
    }
    try checks.require(try actor.message(id: "scoped-lost-response", direction: .outgoing) == pending
        && dmScopedRelayCrypto(actor.store) == crypto, "lost reply preserves pending text time ciphertext and ratchet")
    let receipt = try await actor.client.sendPending(clientMessageId: "scoped-lost-response", snapshot: snapshot)
    try checks.require(receipt == .accepted(record), "valid retry commits exact synthetic relay acceptance")
    let captured = DmScopedRelayProtocol.captured()
    try checks.require(captured.count == 2, "explicit uncertain retry dispatches exactly twice")
    let first = try dmScopedRelayVerify(captured[0], actor: actor, action: "send", checks: checks)
    let second = try dmScopedRelayVerify(captured[1], actor: actor, action: "send", checks: checks)
    try checks.require(first.requestId != second.requestId && first.payload.utf8.elementsEqual(second.payload.utf8),
        "uncertain retry uses fresh native nonce and byte-identical durable outbox payload")
    try checks.require(try JSONDecoder().decode(DmOutboxRecord.self, from: Data(first.payload.utf8)) == record,
        "signed retry payload is the original committed native outbox record")
    let accepted = try actor.message(id: "scoped-lost-response", direction: .outgoing)
    try checks.require(accepted.delivery == .serverAccepted && accepted.text == text
        && accepted.localCreatedAtMillis == pending.localCreatedAtMillis && accepted.reason == nil,
        "accepted native history retains text/time and makes no peer-delivery claim")
    let terminal = try actor.store.read()
    let localReceipt = try await actor.client.sendPending(clientMessageId: "scoped-lost-response", snapshot: snapshot)
    try checks.require(localReceipt == .accepted(record),
        "sealed accepted receipt is returned locally for an exact terminal ID")
    try checks.require(try actor.store.read() == terminal && DmScopedRelayProtocol.captured().count == 2,
        "accepted idempotency neither redispatches nor rewrites sealed state")
    try checks.require(try dmScopedRelayCommitted(actor, record: record, response: dmScopedRelayReceipt(record)) == .accepted(record),
        "identical accepted completion is idempotent")
    try checks.refuses("opposite terminal rejection cannot replace acceptance") {
        _ = try dmScopedRelayCommitted(actor, record: record, response: dmScopedRelayReceipt(record, reason: .blocked))
    }
    try checks.require(try actor.store.read() == terminal, "terminal receipt replay/conflict preserves exact accepted snapshot")
}

private func dmScopedRelayMalformed(_ pair: DmScopedRelayPair, checks: DmScopedRelayChecks) async throws {
    let actor = pair.initiator, record = try pair.initiator.prepare(id: "scoped-malformed", text: "fixture rejected native send")
    let snapshot = try actor.snapshot(), pending = try actor.message(id: "scoped-malformed", direction: .outgoing)
    let crypto = try dmScopedRelayCrypto(actor.store)
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.malformed), DmScopedRelayScript(.rejected(.blocked))])
    try await checks.unresolved("numeric malformed receipt never becomes a terminal rejection") {
        _ = try await actor.client.sendPending(clientMessageId: "scoped-malformed", snapshot: snapshot)
    }
    try checks.require(try actor.message(id: "scoped-malformed", direction: .outgoing) == pending
        && dmScopedRelayCrypto(actor.store) == crypto, "malformed receipt leaves exact pending message and ratchet intact")
    let rejected = try await actor.client.sendPending(clientMessageId: "scoped-malformed", snapshot: snapshot)
    try checks.require(rejected == .rejected(record, .blocked), "valid synthetic block response commits only exact rejection")
    let row = try actor.message(id: "scoped-malformed", direction: .outgoing)
    try checks.require(row.delivery == .rejected && row.reason == .blocked && row.text == pending.text
        && row.localCreatedAtMillis == pending.localCreatedAtMillis, "native rejection preserves sealed local content/time")
    let captured = DmScopedRelayProtocol.captured()
    try checks.require(captured.count == 2, "malformed reconciliation requires explicit retry only")
    let first = try dmScopedRelayVerify(captured[0], actor: actor, action: "send", checks: checks)
    let second = try dmScopedRelayVerify(captured[1], actor: actor, action: "send", checks: checks)
    try checks.require(first.requestId != second.requestId && first.payload.utf8.elementsEqual(second.payload.utf8),
        "malformed reconciliation never replaces committed ciphertext")
    let terminal = try actor.store.read()
    let localReceipt = try await actor.client.sendPending(clientMessageId: "scoped-malformed", snapshot: snapshot)
    try checks.require(localReceipt == rejected,
        "sealed rejected receipt is returned without redispatch")
    try checks.require(try dmScopedRelayCommitted(actor, record: record, response: dmScopedRelayReceipt(record, reason: .blocked)) == rejected,
        "identical rejected completion is idempotent")
    try checks.refuses("opposite terminal acceptance cannot replace rejection") {
        _ = try dmScopedRelayCommitted(actor, record: record, response: dmScopedRelayReceipt(record))
    }
    try checks.require(try actor.store.read() == terminal && DmScopedRelayProtocol.captured().count == 2,
        "rejected terminal paths make no HTTP request or sealed rewrite")
}

private func dmScopedRelayFence(_ pair: DmScopedRelayPair, logout: Bool, checks: DmScopedRelayChecks) async throws {
    let actor = pair.initiator
    _ = try actor.prepare(id: "scoped-stale-flight", text: "fixture stale response")
    let oldBinding = actor.account.credentialBinding
    let snapshot = try actor.snapshot(), gate = DmScopedRelayGate()
    defer { gate.release() }
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.accepted, gate: gate)])
    let task = Task { try await actor.client.sendPending(clientMessageId: "scoped-stale-flight", snapshot: snapshot) }
    do {
        try await dmScopedRelayAwait { gate.arrived() }
        try checks.require(DmScopedRelayProtocol.captured().count == 1, "stale-race request was actually dispatched before fence")
        if logout { _ = try actor.facade.fenceSession(mode: .signOut) }
        else { try await actor.renew() }
        let winner = try actor.store.read()
        gate.release()
        try await checks.unresolved("in-flight old snapshot cannot publish or commit a receipt") { _ = try await task.value }
        try checks.require(gate.releasedWithoutTimeout(), "stale-response gate was explicitly released without timing out")
        try checks.require(try actor.store.read() == winner, "late old response cannot alter newer fenced native state")
        try checks.require(actor.facade.currentMessageContext(snapshot: snapshot) == nil,
            "old credential snapshot remains invalid after local auth transition")
        if logout {
            try checks.require(actor.facade.currentAccount() == nil, "logout never restores an account from relay completion")
        } else {
            try checks.require(actor.account.credentialBinding != oldBinding
                && actor.facade.currentAccount() == actor.account, "renewal keeps only newer verified native mapping")
            try checks.require(try actor.message(id: "scoped-stale-flight", direction: .outgoing).delivery == .pending,
                "refresh failure leaves exact native outbox pending")
        }
        try await checks.unresolved("stale snapshot retry is refused before redispatch") {
            _ = try await actor.client.sendPending(clientMessageId: "scoped-stale-flight", snapshot: snapshot)
        }
        try checks.require(try actor.store.read() == winner && DmScopedRelayProtocol.captured().count == 1,
            "stale retry neither signs new work nor touches winner state")
    } catch {
        task.cancel(); gate.release(); _ = await task.result
        throw error
    }
}

private func dmScopedRelayInboxRun(_ pair: DmScopedRelayPair, checks: DmScopedRelayChecks) async throws {
    let a = pair.initiator, b = pair.responder
    let opening = try a.prepare(id: "scoped-inbox-opening", text: "fixture scoped initial opening")
    let asnap = try a.snapshot(), bsnap = try b.snapshot()
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.accepted), DmScopedRelayScript(.inbox(try dmScopedRelayInbox([opening])))])
    _ = try await a.client.sendPending(clientMessageId: "scoped-inbox-opening", snapshot: asnap)
    let setup = try await b.client.syncInbox(snapshot: bsnap)
    try checks.require(setup.stored == 1 && setup.duplicates == 0 && setup.unresolved == 0,
        "scoped real-provider opening establishes responder without raw receive bypass")
    var replies: [DmOutboxRecord] = []
    for index in 0..<2 { replies.append(try b.prepare(id: "scoped-reply-\(index)", text: "fixture reply \(index)")) }
    let before = try dmScopedRelayNormalized(a.store), crypto = try dmScopedRelayCrypto(a.store)
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.inbox(try dmScopedRelayInbox(replies, badSecond: true))),
        DmScopedRelayScript(.inbox(try dmScopedRelayInbox(replies))), DmScopedRelayScript(.inbox(try dmScopedRelayInbox(replies)))])
    try await checks.unresolved("malformed second inbox row refuses complete batch before first mutation") {
        _ = try await a.client.syncInbox(snapshot: asnap)
    }
    try checks.require(try dmScopedRelayNormalized(a.store) == before && dmScopedRelayCrypto(a.store) == crypto,
        "whole-batch structural refusal leaves sealed payload and ratchet unchanged despite signing CAS")
    try checks.require(try a.thread().messages.filter { $0.direction == .incoming }.isEmpty,
        "valid first row is not stored when a later structural row is malformed")
    let stored = try await a.client.syncInbox(snapshot: asnap)
    try checks.require(stored == DmRelayInboxReport(stored: 2, duplicates: 0, historical: 0, unresolved: 0, historicalUnresolved: 0),
        "valid complete batch stores both real Olm replies")
    let thread = try a.thread()
    for index in 0..<2 {
        let row = try a.message(id: "scoped-reply-\(index)", direction: .incoming)
        try checks.require(row.text == "fixture reply \(index)" && row.delivery == .received && row.localCreatedAtMillis == nil,
            "scoped incoming plaintext is committed and has no invented sender time")
    }
    let committed = try dmScopedRelayNormalized(a.store)
    let duplicate = try await a.client.syncInbox(snapshot: asnap)
    try checks.require(duplicate == DmRelayInboxReport(stored: 0, duplicates: 2, historical: 0, unresolved: 0, historicalUnresolved: 0),
        "from-zero rescan counts exact rows as duplicates")
    try checks.require(try a.thread().messages == thread.messages && dmScopedRelayNormalized(a.store) == committed,
        "duplicate rescan does not ratchet again or append plaintext")
    let captured = DmScopedRelayProtocol.captured()
    try checks.require(captured.count == 3, "malformed batch and two explicit scans perform exactly three requests")
    var nonces: Set<String> = []
    for capture in captured {
        let frame = try dmScopedRelayVerify(capture, actor: a, action: "list", checks: checks)
        try checks.require(frame.payload == "[0,16]" && nonces.insert(frame.requestId).inserted,
            "native inbox rescans from zero with batch sixteen and fresh native nonce")
    }
    for index in 2..<16 { replies.append(try b.prepare(id: "scoped-reply-\(index)", text: "fixture reply \(index)")) }
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.inbox(try dmScopedRelayInbox(replies, extraRow: true))),
        DmScopedRelayScript(.inbox(try dmScopedRelayInbox(replies)))])
    // Still only two stored rows. If a broken bound starts processing this
    // oversized batch, fourteen real unseen replies would mutate the ratchet;
    // an already-full inbox cannot mask that regression as a capacity refusal.
    let bounded = try dmScopedRelayNormalized(a.store)
    try await checks.unresolved("seventeenth structural inbox row is refused by batch bound") {
        _ = try await a.client.syncInbox(snapshot: asnap)
    }
    try checks.require(try dmScopedRelayNormalized(a.store) == bounded,
        "oversized batch does not evict mutate or automatically retry native rows")
    let maximum = try await a.client.syncInbox(snapshot: asnap)
    try checks.require(maximum == DmRelayInboxReport(stored: 14, duplicates: 2, historical: 0, unresolved: 0, historicalUnresolved: 0),
        "maximum sixteen-row batch accepts remaining current replies")
    try checks.require(try a.thread().messages.filter { $0.direction == .incoming }.count == 16,
        "scoped native inbox remains bounded at sixteen current rows")
}

private func dmScopedRelayCancellation(_ pair: DmScopedRelayPair, checks: DmScopedRelayChecks) async throws {
    let actor = pair.initiator
    _ = try actor.prepare(id: "scoped-cancelled", text: "fixture cancellation")
    let snapshot = try actor.snapshot(), gate = DmScopedRelayGate()
    defer { gate.release() }
    DmScopedRelayProtocol.setScripts([DmScopedRelayScript(.accepted, gate: gate)])
    let task = Task { try await actor.client.sendPending(clientMessageId: "scoped-cancelled", snapshot: snapshot) }
    do {
        try await dmScopedRelayAwait { gate.arrived() }
        let before = try actor.store.read()
        task.cancel(); gate.release()
        try await checks.unresolved("cancelled dispatched send stays unresolved") { _ = try await task.value }
        try checks.require(try actor.store.read() == before && DmScopedRelayProtocol.captured().count == 1,
            "cancellation applies no receipt mutation or automatic redispatch")
        try checks.require(try actor.message(id: "scoped-cancelled", direction: .outgoing).delivery == .pending
            && actor.facade.currentMessageContext(snapshot: snapshot) == snapshot.context,
            "cancellation preserves pending record without erasing valid unrelated native lease")
    } catch {
        task.cancel(); gate.release(); _ = await task.result
        throw error
    }
}

/// The parent alone wires/runs this disposable native phase. Fixed assertion
/// labels are safe runner diagnostics; no body, key, token or error is printed.
func runDmScopedRelayProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    DmScopedRelayProtocol.reset()
    defer { DmScopedRelayProtocol.reset() }
    let checks = DmScopedRelayChecks(), auth = try dmScopedRelayAuth()
    var fixtures: [DmScopedRelayFixture] = []
    func pair() async throws -> DmScopedRelayPair {
        let first = try DmScopedRelayFixture(auth: auth); fixtures.append(first)
        let second = try DmScopedRelayFixture(auth: auth); fixtures.append(second)
        return try await dmScopedRelayPair(first, second)
    }
    do {
        progressForResearch?("scoped-relay-lost-response-and-terminal-acceptance")
        try await dmScopedRelayLostRetry(pair(), checks: checks)
        progressForResearch?("scoped-relay-malformed-and-terminal-rejection")
        try await dmScopedRelayMalformed(pair(), checks: checks)
        progressForResearch?("scoped-relay-refresh-in-flight")
        try await dmScopedRelayFence(pair(), logout: false, checks: checks)
        progressForResearch?("scoped-relay-logout-in-flight")
        try await dmScopedRelayFence(pair(), logout: true, checks: checks)
        progressForResearch?("scoped-relay-complete-inbox-validation-and-rescan")
        try await dmScopedRelayInboxRun(pair(), checks: checks)
        progressForResearch?("scoped-relay-cancellation")
        try await dmScopedRelayCancellation(pair(), checks: checks)
        for fixture in fixtures { try fixture.destroy() }
        return checks.assertions
    } catch {
        for fixture in fixtures { try? fixture.destroy() }
        throw error
    }
}
