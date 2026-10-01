// ISOLATED NATIVE RESEARCH. Not a Capacitor plugin, device directory or transport.
// Native-owned identity fixtures stand in for the future authenticated lifecycle.
// No private key, pickle, history snapshot or request digest crosses into JS.
import Foundation
import CryptoKit

enum DmCoordinatorError: Error {
    case invalidInput, unavailable, conflict, capacity, terminalRecord, unsupportedState
}

struct DmOwnerContext: Codable, Equatable {
    let userId: String
    let deviceId: String
    let generation: Int64
}

enum DmPeerStatus: String, Codable { case accepted, blocked, changed, revoked }

struct DmPeerContext: Codable, Equatable {
    let userId: String
    let deviceId: String
    let identityKeyId: String
    let curve: String
    let prekey: String
    var generation: Int64
    var status: DmPeerStatus
}

struct DmPublicIdentity {
    let userId: String
    let deviceId: String
    let identityKeyId: String
    let signingKey: String
    let curve: String
    let prekey: String
}

// Same scalar fields as EncryptedDmOutboxRecord. It exposes ciphertext, not secrets.
struct DmOutboxRecord: Codable, Equatable {
    let ownerUserId: String
    let ownerSessionGeneration: Int64
    let recipientUserId: String
    let recipientIdentityKeyId: String
    let recipientIdentityGeneration: Int64
    let serializedEnvelope: String
}

enum DmRejectionReason: String, Codable {
    case blocked
    case deviceRevoked = "device-revoked"
    case recordConflict = "record-conflict"
}

struct DmReceivedMessage: Codable, Equatable {
    let clientMessageId: String
    let text: String
    let serializedEnvelope: String
    let ownerGeneration: Int64
    let peerGeneration: Int64
}

enum DmReceiveResult: Equatable {
    case stored(DmReceivedMessage)
    case duplicate
}

/// One owner/device, one pinned peer and conversation per bounded research store.
/// The per-instance lock forbids interleaving. Every mutation also CASes the whole
/// authenticated snapshot, so a second instance's trust/owner change or message
/// commit invalidates a stale preparation. No output before durable commit.
/// No async callbacks or JS-supplied guards act as transaction authority.
final class VodozemacDmCoordinator {
    private static let generationMax: Int64 = 9_007_199_254_740_991
    private static let capacity = 16
    private let store: VodozemacSealedStore
    private let lock = NSLock()
    // Test-only interference hook, not a guard or a production/plugin argument.
    // Lets the probe commit a competing lifecycle change before our sealed CAS.
    private let beforeCommitForResearch: (() throws -> Void)?

    private struct Session: Codable {
        let pickle: String
        let id: String
    }
    private enum OutboxStatus: String, Codable { case pending, accepted, rejected }
    private struct OutboxItem: Codable {
        let messageId: String
        let record: DmOutboxRecord
        // Native-only content comparison, itself sealed. Never a server digest.
        let requestDigest: Data
        var status: OutboxStatus
        var reason: DmRejectionReason?
    }
    private struct State: Codable {
        let version: Int
        var owner: DmOwnerContext
        let conversationId: String
        let identityKeyId: String
        let signingKey: String
        let curve: String
        let prekey: String
        var account: String
        var peer: DmPeerContext?
        var session: Session?
        var outbox: [OutboxItem]
        var inbox: [DmReceivedMessage]
    }

    init(store: VodozemacSealedStore, beforeCommitForResearch: (() throws -> Void)? = nil) throws {
        self.store = store
        self.beforeCommitForResearch = beforeCommitForResearch
        _ = try withState { _, _ in () }
    }

    /// Synthetic lifecycle only. Does not register/publish/verify account ownership.
    /// A missing/corrupt key or existing state NEVER becomes a new identity.
    static func bootstrapForResearch(store: VodozemacSealedStore, owner: DmOwnerContext,
                                     identityKeyId: String, conversationId: String) throws -> VodozemacDmCoordinator {
        try validateOwner(owner)
        try DmContentCodec.validateIdentifier(identityKeyId)
        try DmContentCodec.validateIdentifier(conversationId)
        let before = try store.read()
        guard before.revision == 0, before.payload == Data("{}".utf8) else {
            throw DmCoordinatorError.conflict
        }
        let account = try newAccount(pickleKey: store.providerPickleKey())
        let state = State(version: 2, owner: owner, conversationId: conversationId,
            identityKeyId: identityKeyId, signingKey: account.signingKey, curve: account.identityCurve, prekey: account.oneTimeKey,
            account: account.accountPickle, peer: nil, session: nil, outbox: [], inbox: [])
        try validate(state)
        try store.commit(expectedRevision: before.revision, payload: JSONEncoder().encode(state))
        return try VodozemacDmCoordinator(store: store)
    }

    func publicIdentity(owner: DmOwnerContext) throws -> DmPublicIdentity {
        try withState { _, state in
            try Self.requireOwner(owner, state)
            return DmPublicIdentity(userId: state.owner.userId, deviceId: state.owner.deviceId,
                identityKeyId: state.identityKeyId, signingKey: state.signingKey, curve: state.curve, prekey: state.prekey)
        }
    }

    /// Public bundle signing is limited to the initial unpublished research
    /// account. A consumed one-time prekey must never be republished as fresh.
    func signedBundleForResearch(prekeyId: String, expiresAt: Int64, now: Int64, owner: DmOwnerContext) throws -> String {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty else { throw DmCoordinatorError.unavailable }
            try DmRelayCodec.expiry(expiresAt, now: now, maximum: 7 * 24 * 60 * 60)
            let identity = DmPublicIdentity(userId: owner.userId, deviceId: owner.deviceId, identityKeyId: state.identityKeyId,
                                           signingKey: state.signingKey, curve: state.curve, prekey: state.prekey)
            let signed = try signPublicRequest(accountPickle: state.account, pickleKey: store.providerPickleKey(),
                message: DmRelayCodec.bundleSigningBytes(identity, prekeyId: prekeyId, expiresAt: expiresAt))
            guard signed.signingKey == state.signingKey else { throw DmCoordinatorError.conflict }
            let wire = try DmRelayCodec.bundleWire(identity, prekeyId: prekeyId, expiresAt: expiresAt, signature: signed.signature)
            // Signing doesn't advance Olm, but this CAS fences a competing owner
            // change before a signature becomes observable outside native code.
            try persist(state, revision: revision)
            return wire
        }
    }

    func signedClaimForResearch(requestId: String, expiresAt: Int64, now: Int64,
                                owner: DmOwnerContext, peerGeneration: Int64) throws -> String {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            let payload = "[" + (try [peer.userId, peer.deviceId, requestId].map(DmRelayCodec.quote)).joined(separator: ",") + "]"
            return try signRelay(state: state, revision: revision, owner: owner, action: "claim", payload: payload,
                                 requestId: requestId, expiresAt: expiresAt, now: now)
        }
    }

    /// Caller cannot sign a newly fabricated outbox: only exact durable pending
    /// ciphertext belonging to the current native owner and pinned peer.
    func signedSendForResearch(_ record: DmOutboxRecord, requestId: String, expiresAt: Int64, now: Int64,
                               owner: DmOwnerContext, peerGeneration: Int64) throws -> String {
        try withState { revision, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            let index = try Self.outboxIndex(record, state)
            guard state.outbox[index].status == .pending,
                  record.ownerSessionGeneration == owner.generation, record.recipientIdentityGeneration == peerGeneration else {
                throw DmCoordinatorError.unavailable
            }
            return try signRelay(state: state, revision: revision, owner: owner, action: "send", payload: DmRelayCodec.outboxWire(record),
                                 requestId: requestId, expiresAt: expiresAt, now: now)
        }
    }

    func signedListForResearch(requestId: String, afterId: Int64 = 0, batch: Int = 16, expiresAt: Int64, now: Int64,
                               owner: DmOwnerContext) throws -> String {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            guard (0...Self.generationMax).contains(afterId), (1...16).contains(batch) else { throw DmCoordinatorError.invalidInput }
            return try signRelay(state: state, revision: revision, owner: owner, action: "list", payload: "[\(afterId),\(batch)]",
                                 requestId: requestId, expiresAt: expiresAt, now: now)
        }
    }

    private func signRelay(state: State, revision: Int64, owner: DmOwnerContext, action: String, payload: String,
                           requestId: String, expiresAt: Int64, now: Int64) throws -> String {
        try DmRelayCodec.expiry(expiresAt, now: now, maximum: 300)
        let signed = try signPublicRequest(accountPickle: state.account, pickleKey: store.providerPickleKey(),
            message: DmRelayCodec.requestSigningBytes(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt, payload: payload))
        guard signed.signingKey == state.signingKey else { throw DmCoordinatorError.conflict }
        let wire = try DmRelayCodec.requestWire(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt,
                                               payload: payload, signature: signed.signature)
        try persist(state, revision: revision)
        return wire
    }

    /// Direct fixture pinning is NOT a reviewed authenticated device directory.
    func installPeerForResearch(_ peer: DmPeerContext, owner: DmOwnerContext) throws {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            guard state.peer == nil else { throw DmCoordinatorError.conflict }
            try Self.validatePeer(peer, owner: state.owner)
            state.peer = peer
            try persist(state, revision: revision)
        }
    }

    func prepare(clientMessageId: String, text: String, owner: DmOwnerContext, peerGeneration: Int64,
                 fault: VodozemacSealedStore.CommitFault = .none) throws -> DmOutboxRecord {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try DmContentCodec.validateIdentifier(clientMessageId)
            guard text.utf8.count <= DmContentCodec.maxTextBytes else { throw DmCoordinatorError.invalidInput }
            let digest = Data(SHA256.hash(data: Data(text.utf8)))
            if let prior = state.outbox.first(where: { $0.messageId == clientMessageId }) {
                guard prior.requestDigest == digest,
                      prior.record.ownerSessionGeneration == owner.generation,
                      prior.record.recipientIdentityGeneration == peerGeneration else {
                    throw DmCoordinatorError.conflict
                }
                guard prior.status == .pending else { throw DmCoordinatorError.terminalRecord }
                return prior.record // Exact committed bytes, never a second encryption.
            }
            guard state.outbox.count < Self.capacity else { throw DmCoordinatorError.capacity }
            let key = try store.providerPickleKey()
            let session: Session
            if let current = state.session { session = current }
            else {
                // A single-session research store cannot arbitrate simultaneous
                // initial sessions. The lower ASCII device ID alone initiates;
                // the responder waits for that first authenticated message.
                guard Self.initiates(owner.deviceId, peer.deviceId) else { throw DmCoordinatorError.unavailable }
                let created = try startSession(accountPickle: state.account, pickleKey: key,
                    peerIdentity: peer.curve, peerPrekey: peer.prekey)
                session = Session(pickle: created.sessionPickle, id: created.sessionId)
            }
            let context = Self.context(state, peer: peer, messageId: clientMessageId,
                                       sessionId: session.id, outbound: true)
            let payload = try DmContentCodec.encode(context: context, text: text)
            let sealed = try encrypt(sessionPickle: session.pickle, pickleKey: key, plaintext: payload)
            guard sealed.sessionId == session.id else { throw DmCoordinatorError.conflict }
            let envelope = try DmEnvelope(clientMessageId: clientMessageId, senderDeviceId: owner.deviceId,
                recipientDeviceId: peer.deviceId, wire: sealed.wire).serialized()
            let record = DmOutboxRecord(ownerUserId: owner.userId, ownerSessionGeneration: owner.generation,
                recipientUserId: peer.userId, recipientIdentityKeyId: peer.identityKeyId,
                recipientIdentityGeneration: peer.generation, serializedEnvelope: envelope)
            state.session = Session(pickle: sealed.sessionPickle, id: sealed.sessionId)
            state.outbox.append(OutboxItem(messageId: clientMessageId, record: record,
                requestDigest: digest, status: .pending, reason: nil))
            try persist(state, revision: revision, fault: fault)
            return record
        }
    }

    func pending(owner: DmOwnerContext, peerGeneration: Int64, limit: Int = 16) throws -> [DmOutboxRecord] {
        try withState { _, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            try Self.validateLimit(limit)
            return Array(state.outbox.filter {
                $0.status == .pending && $0.record.ownerSessionGeneration == owner.generation
                    && $0.record.recipientIdentityGeneration == peerGeneration
            }.prefix(limit).map(\.record))
        }
    }

    /// Caller must already authenticate the server decision. This research API
    /// does not establish that authenticity, delivery to the peer, or reading.
    func confirmAcceptance(_ record: DmOutboxRecord, owner: DmOwnerContext, peerGeneration: Int64,
                           fault: VodozemacSealedStore.CommitFault = .none) throws {
        try withState { revision, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            guard record.ownerSessionGeneration == owner.generation,
                  record.recipientIdentityGeneration == peerGeneration else { throw DmCoordinatorError.unavailable }
            let index = try Self.outboxIndex(record, state)
            if state.outbox[index].status == .accepted { return }
            guard state.outbox[index].status == .pending else { throw DmCoordinatorError.conflict }
            state.outbox[index].status = .accepted
            try persist(state, revision: revision, fault: fault)
        }
    }

    /// Unlike acceptance, a trusted terminal refusal may cancel an old pending
    /// generation after blocking/reauth. Current owner/device guard still applies.
    func confirmRejection(_ record: DmOutboxRecord, reason: DmRejectionReason, owner: DmOwnerContext,
                          fault: VodozemacSealedStore.CommitFault = .none) throws {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            let index = try Self.outboxIndex(record, state)
            if state.outbox[index].status == .rejected, state.outbox[index].reason == reason { return }
            guard state.outbox[index].status == .pending else { throw DmCoordinatorError.conflict }
            state.outbox[index].status = .rejected
            state.outbox[index].reason = reason
            try persist(state, revision: revision, fault: fault)
        }
    }

    func receive(_ serializedEnvelope: String, owner: DmOwnerContext, peerGeneration: Int64,
                 fault: VodozemacSealedStore.CommitFault = .none) throws -> DmReceiveResult {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            let envelope = try DmEnvelope.decode(serializedEnvelope)
            guard envelope.senderDeviceId == peer.deviceId, envelope.recipientDeviceId == owner.deviceId else {
                throw DmCoordinatorError.conflict
            }
            if let old = state.inbox.first(where: { $0.clientMessageId == envelope.clientMessageId }) {
                guard old.serializedEnvelope == serializedEnvelope,
                      old.ownerGeneration == owner.generation, old.peerGeneration == peerGeneration else {
                    throw DmCoordinatorError.conflict
                }
                return .duplicate
            }
            guard state.inbox.count < Self.capacity else { throw DmCoordinatorError.capacity }
            let key = try store.providerPickleKey()
            let advanced: Session
            let plaintext: Data
            if let session = state.session {
                // Even prekey-type messages may belong to an established session.
                // Never replace/reset a session on an authentication failure.
                let opened = try decrypt(sessionPickle: session.pickle, pickleKey: key, wire: envelope.wire)
                guard opened.sessionId == session.id else { throw DmCoordinatorError.conflict }
                advanced = Session(pickle: opened.sessionPickle, id: opened.sessionId)
                plaintext = opened.plaintext
            } else {
                guard Self.initiates(peer.deviceId, owner.deviceId) else { throw DmCoordinatorError.unavailable }
                let opened = try openSession(accountPickle: state.account, pickleKey: key,
                    pinnedSenderCurve: peer.curve, wire: envelope.wire)
                state.account = opened.accountPickle
                advanced = Session(pickle: opened.sessionPickle, id: opened.sessionId)
                plaintext = opened.plaintext
            }
            let expected = Self.context(state, peer: peer, messageId: envelope.clientMessageId,
                                        sessionId: advanced.id, outbound: false)
            let text = try DmContentCodec.decode(plaintext, expected: expected)
            let message = DmReceivedMessage(clientMessageId: envelope.clientMessageId, text: text,
                serializedEnvelope: serializedEnvelope, ownerGeneration: owner.generation, peerGeneration: peerGeneration)
            state.session = advanced
            state.inbox.append(message)
            try persist(state, revision: revision, fault: fault)
            return .stored(message) // Plaintext is never exposed before commit.
        }
    }

    func history(owner: DmOwnerContext, peerGeneration: Int64, limit: Int = 16) throws -> [DmReceivedMessage] {
        try withState { _, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            try Self.validateLimit(limit)
            return Array(state.inbox.filter {
                $0.ownerGeneration == owner.generation && $0.peerGeneration == peerGeneration
            }.prefix(limit))
        }
    }

    /// Research-only stand-in for a native authenticated trust/block lifecycle.
    /// No public API accepts a replacement identity or rolls a generation back.
    @discardableResult
    func setPeerStatusForResearch(_ status: DmPeerStatus, owner: DmOwnerContext) throws -> Int64 {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            guard var peer = state.peer, peer.generation < Self.generationMax else {
                throw DmCoordinatorError.unavailable
            }
            peer.generation += 1
            peer.status = status
            state.peer = peer
            try persist(state, revision: revision)
            return peer.generation
        }
    }

    @discardableResult
    func advanceOwnerGenerationForResearch(owner: DmOwnerContext) throws -> DmOwnerContext {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            guard owner.generation < Self.generationMax else { throw DmCoordinatorError.unavailable }
            state.owner = DmOwnerContext(userId: owner.userId, deviceId: owner.deviceId, generation: owner.generation + 1)
            try persist(state, revision: revision)
            return state.owner
        }
    }

    private func withState<T>(_ operation: (Int64, inout State) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        let snapshot = try store.read()
        let decoded: State
        do { decoded = try JSONDecoder().decode(State.self, from: snapshot.payload) }
        catch { throw DmCoordinatorError.unsupportedState }
        var state = decoded
        try Self.validate(state)
        return try operation(snapshot.revision, &state)
    }

    private func persist(_ state: State, revision: Int64, fault: VodozemacSealedStore.CommitFault = .none) throws {
        try Self.validate(state)
        try beforeCommitForResearch?()
        try store.commit(expectedRevision: revision, payload: JSONEncoder().encode(state), fault: fault)
    }

    private static func requireOwner(_ owner: DmOwnerContext, _ state: State) throws {
        try validateOwner(owner)
        guard owner == state.owner else { throw DmCoordinatorError.unavailable }
    }

    private static func requirePeer(_ owner: DmOwnerContext, _ generation: Int64, _ state: State) throws -> DmPeerContext {
        try requireOwner(owner, state)
        guard let peer = state.peer, peer.status == .accepted, peer.generation == generation else {
            throw DmCoordinatorError.unavailable
        }
        return peer
    }

    private static func outboxIndex(_ record: DmOutboxRecord, _ state: State) throws -> Int {
        try DmContentCodec.validateIdentifier(record.ownerUserId)
        try DmContentCodec.validateIdentifier(record.recipientUserId)
        try DmContentCodec.validateIdentifier(record.recipientIdentityKeyId)
        _ = try DmEnvelope.decode(record.serializedEnvelope)
        guard (0...generationMax).contains(record.ownerSessionGeneration),
              (0...generationMax).contains(record.recipientIdentityGeneration) else {
            throw DmCoordinatorError.invalidInput
        }
        guard let index = state.outbox.firstIndex(where: { exactRecord($0.record, record) }) else {
            throw DmCoordinatorError.conflict
        }
        return index
    }

    private static func exactRecord(_ a: DmOutboxRecord, _ b: DmOutboxRecord) -> Bool {
        // Swift String equality allows canonical Unicode equivalence. Receipts
        // must match bytes, not merely human-readable equivalent spellings.
        a.ownerSessionGeneration == b.ownerSessionGeneration
            && a.recipientIdentityGeneration == b.recipientIdentityGeneration
            && a.ownerUserId.utf8.elementsEqual(b.ownerUserId.utf8)
            && a.recipientUserId.utf8.elementsEqual(b.recipientUserId.utf8)
            && a.recipientIdentityKeyId.utf8.elementsEqual(b.recipientIdentityKeyId.utf8)
            && a.serializedEnvelope.utf8.elementsEqual(b.serializedEnvelope.utf8)
    }

    private static func initiates(_ device: String, _ peer: String) -> Bool {
        device.utf8.lexicographicallyPrecedes(peer.utf8)
    }

    private static func validateLimit(_ limit: Int) throws {
        guard (1...capacity).contains(limit) else { throw DmCoordinatorError.invalidInput }
    }

    private static func validateOwner(_ owner: DmOwnerContext) throws {
        try DmContentCodec.validateIdentifier(owner.userId)
        try DmContentCodec.validateIdentifier(owner.deviceId)
        guard (0...generationMax).contains(owner.generation) else { throw DmCoordinatorError.invalidInput }
    }

    private static func validateKey(_ value: String) throws {
        guard value.utf8.count == 43, let data = Data(base64Encoded: value + "="), data.count == 32,
              data.base64EncodedString() == value + "=" else { throw DmCoordinatorError.invalidInput }
    }

    private static func validatePeer(_ peer: DmPeerContext, owner: DmOwnerContext) throws {
        try validateOwner(DmOwnerContext(userId: peer.userId, deviceId: peer.deviceId, generation: peer.generation))
        try DmContentCodec.validateIdentifier(peer.identityKeyId)
        try validateKey(peer.curve)
        try validateKey(peer.prekey)
        guard peer.userId != owner.userId, peer.deviceId != owner.deviceId else {
            throw DmCoordinatorError.invalidInput
        }
    }

    private static func context(_ state: State, peer: DmPeerContext, messageId: String,
                                sessionId: String, outbound: Bool) -> DmAuthenticatedContext {
        DmAuthenticatedContext(conversationId: state.conversationId, clientMessageId: messageId,
            senderUserId: outbound ? state.owner.userId : peer.userId,
            senderDeviceId: outbound ? state.owner.deviceId : peer.deviceId,
            recipientUserId: outbound ? peer.userId : state.owner.userId,
            recipientDeviceId: outbound ? peer.deviceId : state.owner.deviceId,
            senderIdentityKeyId: outbound ? state.identityKeyId : peer.identityKeyId,
            recipientIdentityKeyId: outbound ? peer.identityKeyId : state.identityKeyId,
            senderCurve: outbound ? state.curve : peer.curve,
            recipientCurve: outbound ? peer.curve : state.curve, sessionId: sessionId)
    }

    private static func validate(_ state: State) throws {
        guard state.version == 2, !state.account.isEmpty, state.account.utf8.count <= 256 * 1024,
              state.outbox.count <= capacity, state.inbox.count <= capacity else {
            throw DmCoordinatorError.unsupportedState
        }
        try validateOwner(state.owner)
        try DmContentCodec.validateIdentifier(state.identityKeyId)
        try DmContentCodec.validateIdentifier(state.conversationId)
        try validateKey(state.curve)
        try validateKey(state.signingKey)
        try validateKey(state.prekey)
        guard let peer = state.peer else {
            guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty else {
                throw DmCoordinatorError.unsupportedState
            }
            return
        }
        try validatePeer(peer, owner: state.owner)
        if let session = state.session {
            try validateKey(session.id)
            guard !session.pickle.isEmpty, session.pickle.utf8.count <= 256 * 1024 else {
                throw DmCoordinatorError.unsupportedState
            }
        } else if !state.outbox.isEmpty || !state.inbox.isEmpty { throw DmCoordinatorError.unsupportedState }
        guard Set(state.outbox.map(\.messageId)).count == state.outbox.count,
              Set(state.inbox.map(\.clientMessageId)).count == state.inbox.count else {
            throw DmCoordinatorError.unsupportedState
        }
        for item in state.outbox {
            let frame = try DmEnvelope.decode(item.record.serializedEnvelope)
            guard item.messageId == frame.clientMessageId, item.requestDigest.count == 32,
                  item.record.ownerUserId == state.owner.userId, frame.senderDeviceId == state.owner.deviceId,
                  item.record.recipientUserId == peer.userId, frame.recipientDeviceId == peer.deviceId,
                  item.record.recipientIdentityKeyId == peer.identityKeyId,
                  (0...state.owner.generation).contains(item.record.ownerSessionGeneration),
                  (0...peer.generation).contains(item.record.recipientIdentityGeneration),
                  (item.status == .rejected) == (item.reason != nil) else {
                throw DmCoordinatorError.unsupportedState
            }
        }
        for message in state.inbox {
            let frame = try DmEnvelope.decode(message.serializedEnvelope)
            guard message.clientMessageId == frame.clientMessageId,
                  frame.senderDeviceId == peer.deviceId, frame.recipientDeviceId == state.owner.deviceId,
                  (0...state.owner.generation).contains(message.ownerGeneration),
                  (0...peer.generation).contains(message.peerGeneration),
                  message.text.utf8.count <= DmContentCodec.maxTextBytes else {
                throw DmCoordinatorError.unsupportedState
            }
        }
    }
}
