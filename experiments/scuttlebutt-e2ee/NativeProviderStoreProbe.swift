// ISOLATED RESEARCH: fresh synthetic peers, real libsignal session serialization.
// Plain SQLite contains generated test ratchet secrets; it is NOT secure storage.
// Only sending SessionStore callbacks are staged. Identity/prekey/receive stores
// remain in memory. Reopening SQLite here is NOT process-restart key recovery,
// full provider-store atomicity, receiving atomicity, or an iPhone storage test.
// Production still requires reviewed encrypted storage/Keychain/file protection.
import Foundation
import LibSignalClient
import SQLite3

private enum ProviderStoreFailure: Error {
    case assertion(String), wrongSession, unsupportedWire, injectedRollback
}

private func require(_ condition: Bool, _ check: String) throws {
    if !condition { throw ProviderStoreFailure.assertion(check) }
}

// Research framing only: a type byte followed by exact provider serialization.
// This tag is not authenticated by this framing or a negotiated-suite assertion.
private func frame(_ message: CiphertextMessage) throws -> Data {
    let tag: UInt8
    switch message.messageType {
    case .preKey: tag = 1
    case .whisper: tag = 2
    default: throw ProviderStoreFailure.unsupportedWire
    }
    return Data([tag]) + message.serialize()
}

private final class Peer {
    let address: ProtocolAddress
    let store = InMemorySignalProtocolStore()
    let context = NullContext()
    init(_ name: String) throws { address = try ProtocolAddress(name: name, deviceId: 1) }

    func bundle() throws -> PreKeyBundle {
        let oneTime = PrivateKey.generate(), signed = PrivateKey.generate(), kem = KEMKeyPair.generate()
        let identity = try store.identityKeyPair(context: context)
        let signature = identity.privateKey.generateSignature(message: signed.publicKey.serialize())
        let kemSignature = identity.privateKey.generateSignature(message: kem.publicKey.serialize())
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        try store.storePreKey(PreKeyRecord(id: 1, privateKey: oneTime), id: 1, context: context)
        try store.storeSignedPreKey(SignedPreKeyRecord(id: 2, timestamp: timestamp, privateKey: signed, signature: signature),
            id: 2, context: context)
        try store.storeKyberPreKey(KyberPreKeyRecord(id: 3, timestamp: timestamp, keyPair: kem, signature: kemSignature),
            id: 3, context: context)
        return try PreKeyBundle(registrationId: store.localRegistrationId(context: context), deviceId: 1,
            prekeyId: 1, prekey: oneTime.publicKey, signedPrekeyId: 2, signedPrekey: signed.publicKey,
            signedPrekeySignature: signature, identity: identity.identityKey,
            kyberPrekeyId: 3, kyberPrekey: kem.publicKey, kyberPrekeySignature: kemSignature)
    }

    func memoryEncrypt(_ bytes: Data, to peer: Peer) throws -> Data {
        try frame(signalEncrypt(message: bytes, for: peer.address, localAddress: address,
            sessionStore: store, identityStore: store, context: context))
    }

    func decrypt(_ wire: Data, from peer: Peer) throws -> Data {
        guard wire.count > 1 else { throw ProviderStoreFailure.unsupportedWire }
        let bytes = Data(wire.dropFirst())
        switch wire.first {
        case 1:
            return try signalDecryptPreKey(message: PreKeySignalMessage(bytes: bytes), from: peer.address,
                localAddress: address, sessionStore: store, identityStore: store, preKeyStore: store,
                signedPreKeyStore: store, kyberPreKeyStore: store, context: context)
        case 2:
            return try signalDecrypt(message: SignalMessage(bytes: bytes), from: peer.address, to: address,
                sessionStore: store, identityStore: store, context: context)
        default: throw ProviderStoreFailure.unsupportedWire
        }
    }
}

private struct Fixture {
    let sender: Peer, recipient: Peer
    let scope: StoreScope
    init(_ db: AtomicOutboxStore, acknowledged: Bool) throws {
        sender = try Peer("provider-store-sender")
        recipient = try Peer("provider-store-recipient")
        try processPreKeyBundle(recipient.bundle(), for: recipient.address, ourAddress: sender.address,
            sessionStore: sender.store, identityStore: sender.store, context: sender.context)
        if acknowledged {
            // Fixture setup only. The entire handshake/receive side is ephemeral.
            try require(recipient.decrypt(sender.memoryEncrypt(Data([1]), to: recipient), from: sender) == Data([1]), "opening")
            try require(sender.decrypt(recipient.memoryEncrypt(Data([2]), to: sender), from: recipient) == Data([2]), "reply")
        }
        let account = try db.activate(ownerID: sender.address.name, senderDeviceID: "sender-device-1")
        scope = try db.acceptIdentity(account: account, recipientID: recipient.address.name,
            recipientDeviceID: "recipient-device-1", identityKeyID: "synthetic-local-trust-reference")
        guard let session = try sender.store.loadSession(for: recipient.address, context: sender.context) else {
            throw ProviderStoreFailure.assertion("fixture session")
        }
        try db.initializeSession(scope: scope, opaqueState: session.serialize())
    }
}

/// Every load deserializes a fresh native handle; every store captures bytes.
/// No handle can alias SQLite's snapshot, another preparation, or the fixture.
private final class StagedSessionStore: SessionStore {
    private let expectedAddress: ProtocolAddress
    private var serialized: Data
    private var writes = 0
    init(snapshot: Data, address: ProtocolAddress) { serialized = snapshot; expectedAddress = address }
    func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
        guard address == expectedAddress else { throw ProviderStoreFailure.wrongSession }
        return try SessionRecord(bytes: serialized)
    }
    func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
        guard addresses.count <= 1 else { throw ProviderStoreFailure.wrongSession }
        return try addresses.map { address in
            guard let record = try loadSession(for: address, context: context) else { throw ProviderStoreFailure.wrongSession }
            return record
        }
    }
    func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws {
        guard address == expectedAddress else { throw ProviderStoreFailure.wrongSession }
        serialized = record.serialize()
        writes += 1
    }
    func capturedState() throws -> Data {
        try require(writes > 0, "provider stored staged session")
        return serialized
    }
}

/// Staged wire is private. The caller obtains dispatch bytes only after COMMIT.
/// Discard this object on failed commit; retries read persisted output directly.
private struct PreparedSend {
    private let output: StoreOutput
    private let nextState: Data
    init(db: AtomicOutboxStore, fixture: Fixture, messageID: String, plaintext: Data) throws {
        let snapshot = try db.session(scope: fixture.scope)
        let staged = StagedSessionStore(snapshot: snapshot.opaqueState, address: fixture.recipient.address)
        let ciphertext = try signalEncrypt(message: plaintext, for: fixture.recipient.address,
            localAddress: fixture.sender.address, sessionStore: staged,
            identityStore: fixture.sender.store, context: fixture.sender.context)
        nextState = try staged.capturedState()
        output = StoreOutput(scope: fixture.scope, clientMessageID: messageID, originalRevision: snapshot.revision,
            exactCiphertext: try frame(ciphertext))
    }
    func commit(to db: AtomicOutboxStore, injectFailure: Bool = false) throws -> Data {
        let persisted = try db.commitSend(output, nextState: nextState) {
            if injectFailure { throw ProviderStoreFailure.injectedRollback }
        }
        return persisted.exactCiphertext
    }
}

private func retry(_ db: AtomicOutboxStore, fixture: Fixture, messageID: String) throws -> Data {
    guard let record = try db.pending(account: fixture.scope.account).first(where: {
        $0.scope == fixture.scope && $0.clientMessageID == messageID
    }) else { throw ProviderStoreFailure.assertion("persisted retry exists") }
    return record.exactCiphertext
}

private func reopenAndRetry(_ path: String) throws {
    var db: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    let fixture = try Fixture(db!, acknowledged: false)
    let before = try db!.session(scope: fixture.scope)
    let text = Data("Synthetic persisted prekey message".utf8)
    let prepared = try PreparedSend(db: db!, fixture: fixture, messageID: "reopen-first", plaintext: text)
    try require(db!.session(scope: fixture.scope) == before, "preparation cannot change durable session")
    try require(db!.pending(account: fixture.scope.account).isEmpty, "preparation cannot enqueue")
    let wire = try prepared.commit(to: db!)
    try require(wire.first == 1, "prekey type persisted")
    db = nil
    let reopened = try AtomicOutboxStore(path: path)
    let persisted = try retry(reopened, fixture: fixture, messageID: "reopen-first")
    try require(persisted == wire, "byte-identical persisted retry after reopen")
    // The receiver has not consumed this wire before: it must decrypt, not replay.
    try require(fixture.recipient.decrypt(persisted, from: fixture.sender) == text, "persisted wire decrypts")
    let successor = try PreparedSend(db: reopened, fixture: fixture, messageID: "reopen-next", plaintext: Data([3]))
    try require(fixture.recipient.decrypt(successor.commit(to: reopened), from: fixture.sender) == Data([3]),
        "reconstructed sender session encrypts successor")
    try require(reopened.session(scope: fixture.scope).revision == 2, "reopened session advanced twice")
    try require(fixture.sender.store.loadSession(for: fixture.recipient.address, context: fixture.sender.context)?.serialize()
        == before.opaqueState, "fixture session never aliased by staged encryption")
    print("PASS real provider prekey bytes survive SQLite reopen/retry and sender-session reconstruction")
}

private func rollbackAndReprepare(_ path: String) throws {
    let db = try AtomicOutboxStore(path: path)
    let fixture = try Fixture(db, acknowledged: true)
    let before = try db.session(scope: fixture.scope)
    let text = Data("Synthetic rollback recovery".utf8)
    var prepared: PreparedSend? = try PreparedSend(db: db, fixture: fixture, messageID: "rollback-send", plaintext: text)
    var dispatch: Data?
    do {
        dispatch = try prepared!.commit(to: db, injectFailure: true)
        throw ProviderStoreFailure.assertion("injected commit must fail")
    } catch ProviderStoreFailure.injectedRollback {}
    prepared = nil
    try require(dispatch == nil, "failed commit returns no dispatch bytes")
    try require(db.session(scope: fixture.scope) == before, "rollback restores exact serialized provider state")
    try require(db.pending(account: fixture.scope.account).isEmpty, "rollback leaves no wire output")
    let fresh = try PreparedSend(db: db, fixture: fixture, messageID: "rollback-send", plaintext: text)
    let wire = try fresh.commit(to: db)
    try require(wire.first == 2, "session type persisted")
    try require(retry(db, fixture: fixture, messageID: "rollback-send") == wire, "session wire exact retry")
    try require(fixture.recipient.decrypt(wire, from: fixture.sender) == text, "fresh preparation after rollback decrypts")
    try require(db.session(scope: fixture.scope).revision == 1, "rollback did not advance sender twice")
    print("PASS real provider staged state/output rollback, no dispatch on failure, fresh session-message recovery")
}

private func stalePreparations(_ path: String) throws {
    let first = try AtomicOutboxStore(path: path)
    let fixture = try Fixture(first, acknowledged: true)
    let second = try AtomicOutboxStore(path: path)
    let before = try first.session(scope: fixture.scope)
    let winner = try PreparedSend(db: first, fixture: fixture, messageID: "winner", plaintext: Data([10]))
    var loser: PreparedSend? = try PreparedSend(db: second, fixture: fixture, messageID: "loser", plaintext: Data([11]))
    try require(first.session(scope: fixture.scope) == before, "competing encryptions only stage state")
    let firstWire = try winner.commit(to: first)
    let committed = try first.session(scope: fixture.scope)
    var rejectedDispatch: Data?
    do {
        rejectedDispatch = try loser!.commit(to: second)
        throw ProviderStoreFailure.assertion("stale provider preparation must fail")
    } catch AtomicStoreError.staleRevision {}
    loser = nil
    try require(rejectedDispatch == nil, "stale commit returns no dispatch bytes")
    try require(second.session(scope: fixture.scope) == committed, "stale preparation cannot overwrite winner")
    try require(second.pending(account: fixture.scope.account).map(\.clientMessageID) == ["winner"], "only winner queued")
    try require(fixture.recipient.decrypt(firstWire, from: fixture.sender) == Data([10]), "winner decrypts")
    let fresh = try PreparedSend(db: second, fixture: fixture, messageID: "loser", plaintext: Data([11]))
    try require(fixture.recipient.decrypt(fresh.commit(to: second), from: fixture.sender) == Data([11]),
        "loser freshly prepared from committed state decrypts")
    try require(first.session(scope: fixture.scope).revision == 2, "only successful preparations advance state")
    print("PASS two real provider preparations: one revision commit, loser discarded/reprepared, both committed wires decrypt")
}

@main
private enum NativeProviderStoreProbe {
    static func main() {
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("thalassa-provider-store-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
            try reopenAndRetry(directory.appendingPathComponent("reopen.sqlite").path)
            try rollbackAndReprepare(directory.appendingPathComponent("rollback.sqlite").path)
            try stalePreparations(directory.appendingPathComponent("stale.sqlite").path)
            print("PASS three real Swift libsignal sender-session/SQLite outbox groups; synthetic peers only")
            print("NOT full provider-store/receive atomicity, secure storage, process-restart keys, or iPhone evidence")
        } catch let failure as ProviderStoreFailure {
            switch failure {
            case let .assertion(check): fputs("FAIL provider-store assertion: \(check)\n", stderr)
            default: fputs("FAIL provider-store staging/framing boundary\n", stderr)
            }
            exit(1)
        } catch is AtomicStoreError {
            fputs("FAIL provider-store SQLite boundary (no state or ciphertext logged)\n", stderr)
            exit(1)
        } catch {
            fputs("FAIL provider-store native operation (no keys, state, plaintext or ciphertext logged)\n", stderr)
            exit(1)
        }
    }
}
