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

struct DmPublicIdentity: Codable, Equatable {
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
    let relayServerId: Int64?
    let relayRecord: DmOutboxRecord?
    init(clientMessageId: String, text: String, serializedEnvelope: String, ownerGeneration: Int64, peerGeneration: Int64,
         relayServerId: Int64? = nil, relayRecord: DmOutboxRecord? = nil) {
        self.clientMessageId = clientMessageId; self.text = text; self.serializedEnvelope = serializedEnvelope
        self.ownerGeneration = ownerGeneration; self.peerGeneration = peerGeneration
        self.relayServerId = relayServerId; self.relayRecord = relayRecord
    }
}

enum DmReceiveResult: Equatable {
    case stored(DmReceivedMessage)
    case duplicate
}

struct DmLifecycleSnapshot: Equatable {
    let owner: DmOwnerContext
    let active: Bool
    let credentialEpoch: UUID
}

enum DmKnownInbound: Equatable { case unknown, current, historical }

// Only successful stored results carry plaintext, after their durable commit.
// Deferred means retained for explicit retry, never accepted/read/deleted.
enum DmInboundSyncResult: Equatable {
    case stored(DmReceivedMessage), duplicate, historical, deferred, historicalUnresolved
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
    // Closed authority dispatch holds this across nested existing operations.
    // No caller callback can obtain/reenter the coordinator from the facade.
    private let lock = NSRecursiveLock()
    private struct MessageAuthority {
        let context: DmRelayNetworkContext
        let check: () throws -> Void
        var policy: DmNativeRelayPolicyPermit?
        var initialClaimRequired = false
        var privateMessagePreparation = false
    }
    private var messageAuthority: MessageAuthority?
    // Permission is short-lived native MEMORY, not a durable enrollment fact.
    // Reopening a store or another coordinator never restores an old allow.
    private let policyClock: () -> ContinuousClock.Instant
    private var policyQuery: DmNativeRelayPolicyRequest?
    private var policyPermit: DmNativeRelayPolicyPermit?
    private var policyState: DmNativeRelayPolicyState?
    // One ORIGINAL owner-only mode completion in native memory. Unlike peer
    // policy, its result never creates/updates a message-authority permit.
    private var accountModeQuery: DmNativeRelayAccountModeRequest?
    // Test-only interference hook, not a guard or a production/plugin argument.
    // Lets the probe commit a competing lifecycle change before our sealed CAS.
    private let beforeCommitForResearch: (() throws -> Void)?

    private struct Session: Codable {
        let pickle: String
        let id: String
    }
    // Optional only for older isolated research snapshots. Absence is never
    // evidence that a used account/prekey may be registered or claimed afresh.
    private struct RegistrationIntent: Codable {
        let signedBundle: String
    }
    // One-way local selection is row/intent existence, not a default legacy
    // mode. Expiry, renewal/logout or uncertainty never clears/rebinds it.
    private struct ProtectedAccountIntent: Codable {
        let owner: DmOwnerContext
        let credentialEpoch: UUID
        let wire: String
        let requestId: String
        let issuedAtSeconds: Int64
        let expiresAt: Int64
    }
    private struct ProtectedAccountWire: Codable {
        let version: Int
        let `protocol`: String
        let userId: String
        let deviceId: String
        let action: String
        let requestId: String
        let expiresAt: Int64
        let payload: String
        let signature: String
    }
    private struct ClaimIntent: Codable {
        let owner: DmOwnerContext
        let peer: DmPeerContext
        // Stable relay prekey reservation, independent of an expiring HTTP nonce.
        let claimId: String
    }
    private struct ClaimConfirmation: Codable {
        let owner: DmOwnerContext
        let peer: DmPeerContext
        let claimId: String
        let peerFingerprint: String
        let signedBundle: String
    }
    private enum OutboxStatus: String, Codable { case pending, accepted, rejected }
    private struct OutboxItem: Codable {
        let messageId: String
        let record: DmOutboxRecord
        // Native-only content comparison, itself sealed. Never a server digest.
        let requestDigest: Data
        var status: OutboxStatus
        var reason: DmRejectionReason?
        // Sealed locally with the ratchet/outbox commit. Optional only for old
        // research fixtures; absence never licenses recreating ciphertext.
        let text: String?
        let localCreatedAtMillis: Int64?
    }
    private enum UnresolvedReason: String, Codable { case messageNotOpened, contentNotBound }
    private struct UnresolvedItem: Codable {
        let serverId: Int64
        let clientMessageId: String
        let serializedEnvelope: String
        let relayRecord: DmOutboxRecord?
        let ownerGeneration: Int64
        let peerGeneration: Int64
        let reason: UnresolvedReason
    }
    private enum CandidateFailure: Error { case contentNotBound }
    private struct State: Codable {
        let version: Int
        var owner: DmOwnerContext
        var ownerActive: Bool
        var credentialEpoch: UUID
        // Optional only for pre-Auth research stores. First verified native
        // continuation pins its trusted issuer; no later project replacement.
        var authProjectOrigin: String?
        let conversationId: String
        let identityKeyId: String
        let signingKey: String
        let curve: String
        let prekey: String
        var account: String
        var peer: DmPeerContext?
        var peerIdentity: DmPublicIdentity?
        var peerFingerprint: String?
        var session: Session?
        var registrationIntent: RegistrationIntent?
        // Optional v5 research additions. Missing fields are UNKNOWN, never
        // promoted to acknowledged/verified or used to recreate old keys.
        var registrationAcknowledgement: Data?
        // Optional v5 cutover additions. Missing is UNKNOWN, never permission.
        // A protected diagnostic may confirm the durable server fact even if
        // a former mutation's original epoch has become historical/unusable.
        var protectedAccountIntent: ProtectedAccountIntent?
        var protectedAccountConfirmed: Bool?
        var claimIntent: ClaimIntent?
        var claimConfirmation: ClaimConfirmation?
        var outbox: [OutboxItem]
        var inbox: [DmReceivedMessage]
        var unresolved: [UnresolvedItem]
    }

    init(store: VodozemacSealedStore, beforeCommitForResearch: (() throws -> Void)? = nil,
         policyClockForResearch: (() -> ContinuousClock.Instant)? = nil) throws {
        self.store = store
        self.beforeCommitForResearch = beforeCommitForResearch
        self.policyClock = policyClockForResearch ?? { ContinuousClock.now }
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
        let state = State(version: 5, owner: owner, ownerActive: true, credentialEpoch: UUID(), authProjectOrigin: nil, conversationId: conversationId,
            identityKeyId: identityKeyId, signingKey: account.signingKey, curve: account.identityCurve, prekey: account.oneTimeKey,
            account: account.accountPickle, peer: nil, peerIdentity: nil, peerFingerprint: nil,
            session: nil, registrationIntent: nil, registrationAcknowledgement: nil,
            protectedAccountIntent: nil, protectedAccountConfirmed: nil,
            claimIntent: nil, claimConfirmation: nil,
            outbox: [], inbox: [], unresolved: [])
        try validate(state)
        try store.commit(expectedRevision: before.revision, payload: JSONEncoder().encode(state))
        return try VodozemacDmCoordinator(store: store)
    }

    /// The only messaging entry point used by native facade authority. The
    /// checker is scoped to this synchronous call; never retained after return.
    /// No locks are held over HTTP/await. Lower-level *ForResearch methods are
    /// fixture seams, not alternatives for a JS/native app integration.
    func executeMessageOperation(_ operation: DmNativeMessageOperation, context: DmRelayNetworkContext,
                                 checkAuthority: () throws -> Void) throws -> DmNativeMessageResult {
        try withoutActuallyEscaping(checkAuthority) { check in
            lock.lock(); defer { lock.unlock() }
            guard messageAuthority == nil else { throw DmCoordinatorError.unavailable }
            messageAuthority = MessageAuthority(context: context, check: check)
            defer { messageAuthority = nil }
            let owner = DmOwnerContext(userId: context.userId, deviceId: context.deviceId, generation: context.ownerGeneration)
            switch operation {
            case .publicIdentity: return .publicIdentity(try publicIdentity(owner: owner))
            case .pairingCard:
                return try withState { _, state in
                    guard let origin = state.authProjectOrigin else { throw DmCoordinatorError.unavailable }
                    let card = DmPairingCard(projectOrigin: origin, conversationId: state.conversationId,
                                            identity: try publicIdentity(owner: owner))
                    _ = try card.fingerprint()
                    return .pairingCard(card)
                }
            case .confirmPeer(let card, let fingerprint):
                return try withState { revision, state in
                    guard context.peerGeneration == nil, card.projectOrigin == state.authProjectOrigin,
                          card.conversationId == state.conversationId,
                          try card.fingerprint().utf8.elementsEqual(fingerprint.utf8) else {
                        throw DmCoordinatorError.invalidInput
                    }
                    let identity = card.identity
                    let peer = DmPeerContext(userId: identity.userId, deviceId: identity.deviceId,
                        identityKeyId: identity.identityKeyId, curve: identity.curve, prekey: identity.prekey,
                        generation: 1, status: .accepted)
                    try Self.validatePeer(peer, owner: state.owner)
                    if let existing = state.peer {
                        // Exact idempotent confirmation only. Do not promote a
                        // legacy partial fixture pin or accept replacement keys.
                        guard existing == peer, state.peerIdentity == identity,
                              state.peerFingerprint == fingerprint else { throw DmCoordinatorError.conflict }
                    } else {
                        state.peer = peer; state.peerIdentity = identity; state.peerFingerprint = fingerprint
                        try persist(state, revision: revision)
                    }
                    return .pairingState(Self.pairingState(state))
                }
            case .pairingState: return try withState { _, state in .pairingState(Self.pairingState(state)) }
            case .privateMessagePeer:
                return try withState { _, state in
                    let generation = try Self.requireFullPair(context, state)
                    guard let peer = state.peer, let identity = state.peerIdentity,
                          let fingerprint = state.peerFingerprint,
                          identity.userId == peer.userId, identity.deviceId == peer.deviceId else {
                        throw DmCoordinatorError.unavailable
                    }
                    return .privateMessagePeer(DmNativePrivateMessagePeer(accountId: peer.userId,
                        deviceId: peer.deviceId, fingerprint: fingerprint, generation: generation))
                }
            case .privateMessagePermissions:
                // Missing/expired/denied readiness is a diagnostic refusal,
                // never an opportunity to accept cached clear policy flags.
                var canSend = false
                do { try armReadiness(context, initialClaim: true); canSend = true }
                catch { /* Final withState still enforces the original owner. */ }
                return try withState { _, state in
                    guard let peer = state.peer else { throw DmCoordinatorError.unavailable }
                    let flags: DmNativeRelayPolicyState?
                    if let permit = policyPermit,
                       (try? requirePolicyFacts(permit, context: context, state: state)) != nil {
                        flags = policyState
                    } else { flags = nil }
                    let blockedByMe = peer.status == .blocked || flags?.blockedByMe == true
                    let blocked = blockedByMe || flags?.blockedByPeer == true
                    return .privateMessagePermissions(DmNativePrivateMessagePermissions(peerAccountId: peer.userId,
                        blockedByMe: blockedByMe, blockedEitherDirection: blocked,
                        canSend: canSend && !blocked))
                }
            case .relayEnrollmentState:
                return try withState { _, state in .enrollmentState(try Self.enrollmentState(state)) }
            case .invalidateRelayPolicy:
                policyQuery = nil; policyPermit = nil; policyState = nil
                return try withState { _, state in .enrollmentState(try Self.enrollmentState(state)) }
            case .relayRequireProtectedWire, .relayAccountModeWire:
                accountModeQuery = nil
                return try withState { revision, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil,
                          state.registrationAcknowledgement != nil else { throw DmCoordinatorError.unavailable }
                    let now = try Self.nativeRelayTime(), startedAt = policyClock()
                    guard now <= DmRelayCodec.maxSafeInteger - 240 else { throw DmCoordinatorError.unavailable }
                    let action: DmNativeRelayAccountModeAction
                    let requestId: String, expiresAt: Int64, wire: String
                    switch operation {
                    case .relayRequireProtectedWire:
                        action = .requireProtected
                        if let intent = state.protectedAccountIntent {
                            // Conservative availability: even acknowledged intent
                            // replay keeps its original epoch/ID/expiry. Refresh or
                            // restart Auth may make it historical; diagnose mode
                            // explicitly instead of replacing/re-signing the intent.
                            guard intent.owner == owner, intent.credentialEpoch == context.credentialEpoch,
                                  now >= intent.issuedAtSeconds, now < intent.expiresAt else {
                                throw DmCoordinatorError.unavailable
                            }
                            requestId = intent.requestId; expiresAt = intent.expiresAt; wire = intent.wire
                        } else {
                            requestId = UUID().uuidString.lowercased(); expiresAt = now + 240
                            wire = try signRelay(state: state, revision: revision, owner: owner,
                                action: action.rawValue, payload: "[]", requestId: requestId,
                                expiresAt: expiresAt, now: now, persistState: false)
                            guard wire.utf8.count <= 2048 else { throw DmCoordinatorError.unavailable }
                            state.protectedAccountIntent = ProtectedAccountIntent(owner: owner,
                                credentialEpoch: context.credentialEpoch, wire: wire, requestId: requestId,
                                issuedAtSeconds: now, expiresAt: expiresAt)
                            // Seal selection + exact native signature before any
                            // observable wire. Does not advance crypto/outbox/peer.
                            try persist(state, revision: revision)
                        }
                    case .relayAccountModeWire:
                        action = .accountMode
                        requestId = UUID().uuidString.lowercased(); expiresAt = now + 240
                        wire = try signRelay(state: state, revision: revision, owner: owner,
                            action: action.rawValue, payload: "[]", requestId: requestId,
                            expiresAt: expiresAt, now: now, persistState: false)
                        guard wire.utf8.count <= 2048 else { throw DmCoordinatorError.unavailable }
                    default: throw DmCoordinatorError.unavailable
                    }
                    let request = DmNativeRelayAccountModeRequest(attemptID: UUID(), wire: wire, context: context,
                        action: action, requestId: requestId, expiresAt: expiresAt,
                        startedAtSeconds: now, startedAt: startedAt)
                    accountModeQuery = request
                    return .accountModeRequest(request)
                }
            case .relayAccountModeResponse(let request, let response):
                let result = try withState { revision, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil,
                          state.registrationAcknowledgement != nil,
                          accountModeQuery == request, request.context == context,
                          try accountModeCompletionTime(request) < request.expiresAt else {
                        throw DmCoordinatorError.unavailable
                    }
                    if request.action == .requireProtected {
                        guard let intent = state.protectedAccountIntent, intent.owner == owner,
                              intent.credentialEpoch == context.credentialEpoch,
                              intent.requestId == request.requestId, intent.expiresAt == request.expiresAt,
                              intent.wire.utf8.elementsEqual(request.wire.utf8) else {
                            throw DmCoordinatorError.unavailable
                        }
                    }
                    let mode = try DmRelayResultCodec.accountMode(response, request: request)
                    if mode == .legacyPermitted {
                        // A diagnostic is not a downgrade or a permission. An
                        // inconsistent legacy result cannot erase local selection.
                        guard state.protectedAccountIntent == nil, state.protectedAccountConfirmed == nil else {
                            throw DmCoordinatorError.unavailable
                        }
                    } else if state.protectedAccountConfirmed == nil {
                        state.protectedAccountConfirmed = true
                        try persist(state, revision: revision)
                    }
                    accountModeQuery = nil
                    return DmNativeMessageResult.accountModeState(mode)
                }
                if case .accountModeState(.legacyPermitted) = result {
                    // Another raw research writer can select protection without
                    // changing the owner lifecycle. Read sealed mode afresh,
                    // not only withState's final lifecycle reread. This remains
                    // a snapshot fact, never admission for a later operation.
                    return try withState { _, state in
                        guard state.protectedAccountIntent == nil, state.protectedAccountConfirmed == nil else {
                            throw DmCoordinatorError.unavailable
                        }
                        return result
                    }
                }
                return result
            case .relayAccountModeGuard(let mode):
                return try withState { _, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil,
                          state.registrationAcknowledgement != nil else { throw DmCoordinatorError.unavailable }
                    switch mode {
                    case .legacyPermitted:
                        guard state.protectedAccountIntent == nil, state.protectedAccountConfirmed == nil else {
                            throw DmCoordinatorError.unavailable
                        }
                    case .protectedRequired:
                        guard state.protectedAccountConfirmed == true else { throw DmCoordinatorError.unavailable }
                    }
                    return .accountModeState(mode)
                }
            case .relayPolicyWire:
                // Fail closed immediately, including failed refresh/signing.
                policyQuery = nil; policyPermit = nil; policyState = nil
                return try withState { revision, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil,
                          state.registrationAcknowledgement != nil,
                          let peer = state.peer, let pin = state.peerIdentity,
                          let fingerprint = state.peerFingerprint else { throw DmCoordinatorError.unavailable }
                    let now = try Self.nativeRelayTime(), startedAt = policyClock()
                    let requestId = UUID().uuidString.lowercased()
                    let payload = "[" + (try [pin.userId, pin.deviceId, pin.identityKeyId].map(DmRelayCodec.quote).joined(separator: ",")) + "]"
                    let wire = try signRelay(state: state, revision: revision, owner: owner, action: "policy",
                        payload: payload, requestId: requestId, expiresAt: now + 240, now: now, persistState: false)
                    let request = DmNativeRelayPolicyRequest(wire: wire, context: context, peer: pin,
                        peerGeneration: peer.generation, peerFingerprint: fingerprint,
                        requestId: requestId, startedAtSeconds: now, startedAt: startedAt)
                    policyQuery = request
                    return .policyRequest(request)
                }
            case .relayPolicyResponse(let request, let response):
                return try withState { _, state in
                    guard context.peerGeneration == nil, let saved = policyQuery,
                          saved.wire == request.wire, saved.context == request.context, request.context == context,
                          saved.peer == request.peer, saved.peerGeneration == request.peerGeneration,
                          saved.peerFingerprint == request.peerFingerprint, saved.requestId == request.requestId,
                          saved.startedAt == request.startedAt, saved.startedAtSeconds == request.startedAtSeconds,
                          state.peerIdentity == request.peer, state.peerFingerprint == request.peerFingerprint,
                          state.peer?.generation == request.peerGeneration,
                          policyClock() >= request.startedAt,
                          policyClock() < request.startedAt.advanced(by: .seconds(5)) else {
                        throw DmCoordinatorError.unavailable
                    }
                    let flags = try DmRelayResultCodec.policy(response, request: request)
                    let paired = DmRelayNetworkContext(userId: context.userId, deviceId: context.deviceId,
                        ownerGeneration: context.ownerGeneration, credentialEpoch: context.credentialEpoch,
                        peerGeneration: request.peerGeneration)
                    policyPermit = DmNativeRelayPolicyPermit(id: UUID(), context: paired,
                        peerFingerprint: request.peerFingerprint, startedAtSeconds: request.startedAtSeconds,
                        startedAt: request.startedAt)
                    policyState = flags; policyQuery = nil
                    return .policyState(flags)
                }
            case .relayPolicyState:
                return try withState { _, state in
                    guard let permit = policyPermit, let flags = policyState else { throw DmCoordinatorError.unavailable }
                    try requirePolicyFacts(permit, context: context, state: state)
                    return .policyState(flags)
                }
            case .relayPolicyGuard(let permit):
                try armReadiness(context, expected: permit)
                guard let flags = policyState else { throw DmCoordinatorError.unavailable }
                return .policyState(flags)
            case .relayRegistrationWire:
                return try withState { _, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil else {
                        throw DmCoordinatorError.unavailable
                    }
                    if state.registrationAcknowledgement != nil {
                        return .enrollmentState(try Self.enrollmentState(state))
                    }
                    if let intent = state.registrationIntent {
                        // Exact saved bytes, even after their expiry. Do NOT
                        // sign again or invent a replacement device/prekey.
                        return .registrationRequest(intent.signedBundle)
                    }
                    let now = try Self.nativeRelayTime()
                    guard now <= DmRelayCodec.maxSafeInteger - 604_800 else { throw DmCoordinatorError.unavailable }
                    let wire = try signedBundleForResearch(prekeyId: UUID().uuidString.lowercased(),
                        expiresAt: now + 604_800, now: now, owner: owner, credentialEpoch: context.credentialEpoch)
                    return .registrationRequest(wire)
                }
            case .relayRegistrationResponse(let wire, let response):
                return try withState { revision, state in
                    guard context.peerGeneration == nil, state.authProjectOrigin != nil,
                          let intent = state.registrationIntent,
                          intent.signedBundle.utf8.elementsEqual(wire.utf8) else { throw DmCoordinatorError.unavailable }
                    let identity = try publicIdentity(owner: owner)
                    try DmRelayResultCodec.registration(response, expected: identity)
                    let digest = Data(SHA256.hash(data: Data(wire.utf8)))
                    if let saved = state.registrationAcknowledgement {
                        guard saved == digest else { throw DmCoordinatorError.conflict }
                    } else {
                        state.registrationAcknowledgement = digest
                        try persist(state, revision: revision)
                    }
                    return .enrollmentState(try Self.enrollmentState(state))
                }
            case .relayClaimWire:
                return try withState { _, state in
                    let generation = try Self.requireFullPair(context, state)
                    let peer = try Self.requirePeer(owner, generation, state)
                    guard state.registrationAcknowledgement != nil,
                          Self.initiates(owner.deviceId, peer.deviceId),
                          let fingerprint = state.peerFingerprint else { throw DmCoordinatorError.unavailable }
                    if let saved = state.claimConfirmation {
                        guard saved.owner == owner, saved.peer == peer, saved.peerFingerprint == fingerprint else {
                            throw DmCoordinatorError.unavailable
                        }
                        return .enrollmentState(try Self.enrollmentState(state))
                    }
                    guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty,
                          state.unresolved.isEmpty else { throw DmCoordinatorError.unavailable }
                    let stableId: String
                    if let intent = state.claimIntent {
                        guard intent.owner == owner, intent.peer == peer else { throw DmCoordinatorError.unavailable }
                        stableId = intent.claimId
                    } else { stableId = UUID().uuidString.lowercased() }
                    let startedAt = ContinuousClock.now
                    let now = try Self.nativeRelayTime()
                    let wire = try signedClaimForResearch(requestId: UUID().uuidString.lowercased(),
                        expiresAt: now + 240, now: now, owner: owner, peerGeneration: generation,
                        credentialEpoch: context.credentialEpoch, claimId: stableId)
                    // Nested signing committed intent under the same authority;
                    // this outer read MUST NOT persist its older state copy.
                    return .claimRequest(DmNativeRelayClaimRequest(wire: wire, context: context,
                        claimId: stableId, peerFingerprint: fingerprint, startedAtSeconds: now, startedAt: startedAt))
                }
            case .relayClaimResponse(let request, let response):
                return try withState { revision, state in
                    let generation = try Self.requireFullPair(context, state)
                    let peer = try Self.requirePeer(owner, generation, state)
                    guard request.context == context, state.registrationAcknowledgement != nil,
                          Self.initiates(owner.deviceId, peer.deviceId), let pin = state.peerIdentity,
                          let fingerprint = state.peerFingerprint, fingerprint == request.peerFingerprint,
                          let intent = state.claimIntent, intent.owner == owner, intent.peer == peer,
                          intent.claimId == request.claimId else { throw DmCoordinatorError.unavailable }
                    let bundle = try DmRelayResultCodec.claim(response, pinned: pin,
                        now: try Self.claimCompletionTime(request))
                    let wire = try DmRelayCodec.bundleWire(pin, prekeyId: bundle.prekeyId,
                        expiresAt: bundle.expiresAt, signature: bundle.signature)
                    if let saved = state.claimConfirmation {
                        guard saved.owner == owner, saved.peer == peer, saved.claimId == request.claimId,
                              saved.peerFingerprint == fingerprint,
                              saved.signedBundle.utf8.elementsEqual(wire.utf8) else { throw DmCoordinatorError.conflict }
                    } else {
                        guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty,
                              state.unresolved.isEmpty else { throw DmCoordinatorError.unavailable }
                        state.claimConfirmation = ClaimConfirmation(owner: owner, peer: peer,
                            claimId: request.claimId, peerFingerprint: fingerprint, signedBundle: wire)
                        try persist(state, revision: revision)
                    }
                    return .enrollmentState(try Self.enrollmentState(state))
                }
            case .thread:
                return try withState { _, state in
                    let generation = try Self.requireFullPair(context, state)
                    return .thread(Self.thread(state, peerGeneration: generation))
                }
            case .prepareText(let id, let text), .privateMessagePrepareText(let id, let text):
                // Native text-only/nonblank policy; JS checks are not authority.
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      text.utf8.count <= DmContentCodec.maxTextBytes else { throw DmCoordinatorError.invalidInput }
                try armReadiness(context, initialClaim: true)
                let generation = try withState { _, state in try Self.requireFullPair(context, state) }
                if case .privateMessagePrepareText = operation {
                    messageAuthority?.privateMessagePreparation = true
                }
                let millis = Date().timeIntervalSince1970 * 1000
                guard millis.isFinite, (1...Double(Self.generationMax)).contains(millis) else {
                    throw DmCoordinatorError.unavailable
                }
                return .outbox(try prepare(clientMessageId: id, text: text, owner: owner,
                    peerGeneration: generation, localCreatedAtMillis: Int64(millis)))
            case .pendingRecords:
                let generation = try withState { _, state in try Self.requireFullPair(context, state) }
                return .pendingRecords(try pending(owner: owner, peerGeneration: generation))
            case .relaySendWire(let id):
                try DmContentCodec.validateIdentifier(id)
                return try withState { _, state in
                    let generation = try Self.requireFullPair(context, state)
                    guard let item = state.outbox.first(where: { $0.messageId.utf8.elementsEqual(id.utf8) }),
                          item.record.ownerSessionGeneration == owner.generation,
                          item.record.recipientIdentityGeneration == generation else {
                        throw DmCoordinatorError.unavailable
                    }
                    switch item.status {
                    case .accepted: return .relayReceipt(.accepted(item.record))
                    case .rejected:
                        guard let reason = item.reason else { throw DmCoordinatorError.conflict }
                        return .relayReceipt(.rejected(item.record, reason))
                    case .pending:
                        try armReadiness(context)
                        guard let permit = policyPermit else { throw DmCoordinatorError.unavailable }
                        let now = try Self.nativeRelayTime()
                        let wire = try signedSendForResearch(item.record, requestId: UUID().uuidString.lowercased(),
                            expiresAt: now + 240, now: now, owner: owner, peerGeneration: generation,
                            credentialEpoch: context.credentialEpoch)
                        return .sendRequest(DmNativeRelaySendRequest(wire: wire, record: item.record, policy: permit))
                    }
                }
            case .relaySendReceipt(let request, let response):
                try armReadiness(context, expected: request.policy)
                let record = request.record
                let generation = try withState { _, state in
                    let generation = try Self.requireFullPair(context, state)
                    guard record.ownerSessionGeneration == owner.generation,
                          record.recipientIdentityGeneration == generation else { throw DmCoordinatorError.unavailable }
                    // Check against durable state BEFORE decoding the response.
                    // A typed native record is not authority to create an outbox.
                    _ = try Self.outboxIndex(record, state)
                    return generation
                }
                let receipt = try DmRelayResultCodec.receipt(response, expected: record)
                switch receipt {
                case .accepted:
                    try confirmAcceptance(record, owner: owner, peerGeneration: generation,
                        credentialEpoch: context.credentialEpoch)
                case .rejected(_, let reason):
                    try confirmRejection(record, reason: reason, owner: owner,
                        credentialEpoch: context.credentialEpoch)
                }
                return .relayReceipt(receipt)
            case .relayRejectedReceipt(let record, let response):
                guard context.peerGeneration == nil else { throw DmCoordinatorError.unavailable }
                _ = try withState { _, state in
                    guard record.ownerUserId == owner.userId, record.ownerSessionGeneration == owner.generation else {
                        throw DmCoordinatorError.unavailable
                    }
                    return try Self.outboxIndex(record, state)
                }
                guard case .rejected(_, let reason) = try DmRelayResultCodec.receipt(response, expected: record) else {
                    throw DmCoordinatorError.unavailable
                }
                try confirmRejection(record, reason: reason, owner: owner, credentialEpoch: context.credentialEpoch)
                return .relayReceipt(.rejected(record, reason))
            case .relayInboxWire:
                try armReadiness(context)
                guard let permit = policyPermit else { throw DmCoordinatorError.unavailable }
                let now = try Self.nativeRelayTime()
                let wire = try signedListForResearch(requestId: UUID().uuidString.lowercased(),
                    afterId: 0, batch: 16, expiresAt: now + 240, now: now,
                    owner: owner, credentialEpoch: context.credentialEpoch)
                return .inboxRequest(DmNativeRelayInboxRequest(wire: wire, policy: permit))
            case .relayInboxResponse(let request, let response):
                try armReadiness(context, expected: request.policy)
                let input = try withState { _, state -> (Int64, [DmRelayInboxRow]) in
                    let generation = try Self.requireFullPair(context, state)
                    let identity = try publicIdentity(owner: owner)
                    let peer = try Self.requirePeer(owner, generation, state)
                    // Validate ALL row structure/routing before ANY crypto/CAS.
                    // Commits remain per-row, not a batch-atomic transaction.
                    return (generation, try DmRelayResultCodec.inbox(response, owner: owner,
                        identity: identity, peer: peer, afterId: 0, batch: 16))
                }
                var stored = 0, duplicates = 0, historical = 0, unresolved = 0, historicalUnresolved = 0
                for row in input.1 {
                    switch try receiveOrDeferForResearch(serverId: row.serverId,
                        serializedEnvelope: row.record.serializedEnvelope, relayRecord: row.record,
                        owner: owner, peerGeneration: input.0, credentialEpoch: context.credentialEpoch) {
                    case .stored: stored += 1
                    case .duplicate: duplicates += 1
                    case .historical: historical += 1
                    case .deferred: unresolved += 1
                    case .historicalUnresolved: historicalUnresolved += 1
                    }
                }
                // An empty batch must still pass the final native authority
                // read. Never publish counts into a replaced/expired scope.
                return try withState { _, state in
                    _ = try Self.requireFullPair(context, state)
                    return .inboxReport(DmRelayInboxReport(stored: stored, duplicates: duplicates,
                        historical: historical, unresolved: unresolved, historicalUnresolved: historicalUnresolved))
                }
            }
        }
    }

    private static func nativeRelayTime() throws -> Int64 {
        let seconds = Date().timeIntervalSince1970
        guard seconds.isFinite, seconds >= 1,
              seconds <= Double(DmRelayCodec.maxSafeInteger - 240) else { throw DmCoordinatorError.unavailable }
        return Int64(seconds)
    }

    private func accountModeCompletionTime(_ request: DmNativeRelayAccountModeRequest) throws -> Int64 {
        let elapsed = request.startedAt.duration(to: policyClock()).components
        guard elapsed.seconds >= 0, elapsed.attoseconds >= 0,
              request.startedAtSeconds > 0, request.startedAtSeconds <= DmRelayCodec.maxSafeInteger else {
            throw DmCoordinatorError.unavailable
        }
        let ceiling = elapsed.seconds.addingReportingOverflow(elapsed.attoseconds == 0 ? 0 : 1)
        guard !ceiling.overflow, ceiling.partialValue <= DmRelayCodec.maxSafeInteger - request.startedAtSeconds else {
            throw DmCoordinatorError.unavailable
        }
        return max(try Self.nativeRelayTime(), request.startedAtSeconds + ceiling.partialValue)
    }

    private static func claimCompletionTime(_ request: DmNativeRelayClaimRequest) throws -> Int64 {
        let elapsed = request.startedAt.duration(to: ContinuousClock.now).components
        guard elapsed.seconds >= 0, elapsed.attoseconds >= 0,
              request.startedAtSeconds > 0, request.startedAtSeconds <= DmRelayCodec.maxSafeInteger else {
            throw DmCoordinatorError.unavailable
        }
        let ceiling = elapsed.seconds.addingReportingOverflow(elapsed.attoseconds == 0 ? 0 : 1)
        guard !ceiling.overflow, ceiling.partialValue <= DmRelayCodec.maxSafeInteger - request.startedAtSeconds else {
            throw DmCoordinatorError.unavailable
        }
        return max(try nativeRelayTime(), request.startedAtSeconds + ceiling.partialValue)
    }

    private static func enrollmentState(_ state: State) throws -> DmNativeRelayEnrollmentState {
        let registration: DmNativeRegistrationState = state.registrationAcknowledgement != nil ? .acknowledged
            : state.registrationIntent == nil ? .none : .pending
        let claim: DmNativeClaimState
        let expiry: Int64?
        if let saved = state.claimConfirmation {
            let savedExpiry = try DmRelayCodec.verifyStoredBundle(saved.signedBundle).expiresAt
            expiry = savedExpiry
            if saved.owner != state.owner || saved.peer != state.peer || saved.peerFingerprint != state.peerFingerprint {
                claim = .historical
            } else { claim = savedExpiry > (try nativeRelayTime()) ? .verified : .expired }
        } else if let intent = state.claimIntent {
            expiry = nil
            claim = intent.owner == state.owner && intent.peer == state.peer ? .pending : .historical
        } else { claim = .none; expiry = nil }
        return DmNativeRelayEnrollmentState(registration: registration, claim: claim, claimedPrekeyExpiresAt: expiry)
    }

    private static func requireFullPair(_ context: DmRelayNetworkContext, _ state: State) throws -> Int64 {
        guard let generation = context.peerGeneration, state.peerIdentity != nil, state.peerFingerprint != nil else {
            throw DmCoordinatorError.unavailable
        }
        _ = try requirePeer(state.owner, generation, state)
        return generation
    }

    // Attach the exact ephemeral permit to this lexical CLOSED operation. It
    // is then checked by every nested read/return and store CAS, not only once
    // before crypto or HTTP. Raw provider fixture helpers remain isolated seams.
    private func armReadiness(_ context: DmRelayNetworkContext,
                              expected: DmNativeRelayPolicyPermit? = nil, initialClaim: Bool = false) throws {
        let armed = try withState { _, state -> (DmNativeRelayPolicyPermit, Bool) in
            guard let current = policyPermit, expected == nil || expected == current else {
                throw DmCoordinatorError.unavailable
            }
            let claimRequired = state.session == nil && (initialClaim || state.peer.map {
                Self.initiates(state.owner.deviceId, $0.deviceId)
            } == true)
            try requireMessaging(current, context: context, state: state,
                initialClaim: claimRequired)
            return (current, claimRequired)
        }
        messageAuthority?.policy = armed.0
        messageAuthority?.initialClaimRequired = armed.1
    }

    private func requirePolicyFacts(_ permit: DmNativeRelayPolicyPermit,
                                    context: DmRelayNetworkContext, state: State) throws {
        guard policyPermit == permit, policyState != nil,
              permit.context.userId == context.userId, permit.context.deviceId == context.deviceId,
              permit.context.ownerGeneration == context.ownerGeneration,
              permit.context.credentialEpoch == context.credentialEpoch,
              context.peerGeneration == nil || context.peerGeneration == permit.context.peerGeneration,
              state.peer?.generation == permit.context.peerGeneration,
              state.peerFingerprint == permit.peerFingerprint, state.peerIdentity != nil,
              policyClock() >= permit.startedAt,
              policyClock() < permit.startedAt.advanced(by: .seconds(5)) else { throw DmCoordinatorError.unavailable }
    }

    private func requireMessaging(_ permit: DmNativeRelayPolicyPermit, context: DmRelayNetworkContext,
                                  state: State, initialClaim: Bool) throws {
        let generation = try Self.requireFullPair(context, state)
        try requirePolicyFacts(permit, context: context, state: state)
        guard state.registrationAcknowledgement != nil, let flags = policyState,
              !flags.ownerRevoked, !flags.peerRevoked, !flags.blockedByMe, !flags.blockedByPeer else {
            throw DmCoordinatorError.unavailable
        }
        if state.session != nil {
            // A surviving pickle is not a new owner's established conversation.
            // Existing native message generations quarantine it after logout or
            // peer replacement rather than silently reviving old ratchet state.
            guard state.outbox.allSatisfy({ $0.record.ownerSessionGeneration == state.owner.generation && $0.record.recipientIdentityGeneration == generation }),
                  state.inbox.allSatisfy({ $0.ownerGeneration == state.owner.generation && $0.peerGeneration == generation }),
                  state.unresolved.allSatisfy({ $0.ownerGeneration == state.owner.generation && $0.peerGeneration == generation }) else {
                throw DmCoordinatorError.unavailable
            }
        }
        if initialClaim {
            guard let peer = state.peer, Self.initiates(state.owner.deviceId, peer.deviceId),
                  let claim = state.claimConfirmation, claim.owner == state.owner, claim.peer == peer,
                  claim.peerFingerprint == state.peerFingerprint,
                  let intent = state.claimIntent, intent.owner == state.owner, intent.peer == peer,
                  intent.claimId == claim.claimId else { throw DmCoordinatorError.unavailable }
            let elapsed = permit.startedAt.duration(to: policyClock()).components
            guard elapsed.seconds >= 0, elapsed.attoseconds >= 0,
                  permit.startedAtSeconds <= DmRelayCodec.maxSafeInteger - 6 else { throw DmCoordinatorError.unavailable }
            let floor = permit.startedAtSeconds + elapsed.seconds + (elapsed.attoseconds == 0 ? 0 : 1)
            _ = try DmRelayCodec.verifyBundle(claim.signedBundle, now: max(try Self.nativeRelayTime(), floor))
        }
    }

    private static func pairingState(_ state: State) -> DmNativePairingState {
        let status: DmNativePeerState
        if let peer = state.peer {
            switch peer.status {
            case .accepted: status = state.peerIdentity == nil ? .legacyUnverified : .confirmed
            case .blocked: status = .blocked
            case .changed: status = .changed
            case .revoked: status = .revoked
            }
        } else { status = .unpaired }
        let role: DmNativeSessionRole
        if state.session != nil { role = .established }
        else if let peer = state.peer { role = initiates(state.owner.deviceId, peer.deviceId) ? .initiator : .responder }
        else { role = .unpaired }
        let generation = state.peer?.generation
        return DmNativePairingState(status: status, peerGeneration: generation, confirmedFingerprint: state.peerFingerprint,
            sessionRole: role,
            outgoingCount: state.outbox.filter { $0.record.ownerSessionGeneration == state.owner.generation
                && $0.record.recipientIdentityGeneration == generation }.count,
            incomingCount: state.inbox.filter { $0.ownerGeneration == state.owner.generation && $0.peerGeneration == generation }.count,
            unresolvedCount: state.unresolved.filter { $0.ownerGeneration == state.owner.generation && $0.peerGeneration == generation }.count)
    }

    private static func thread(_ state: State, peerGeneration: Int64) -> DmNativeThread {
        // Bounded sealed insertion order; no fabricated ordering by remote time.
        let outgoing = state.outbox.filter { $0.record.ownerSessionGeneration == state.owner.generation
            && $0.record.recipientIdentityGeneration == peerGeneration }.map { item in
            let delivery: DmNativeThreadDelivery
            switch item.status { case .pending: delivery = .pending; case .accepted: delivery = .serverAccepted; case .rejected: delivery = .rejected }
            return DmNativeThreadMessage(clientMessageId: item.messageId, direction: .outgoing,
                text: item.text, delivery: delivery, reason: item.reason, localCreatedAtMillis: item.localCreatedAtMillis,
                envelopeSha256: envelopeSha256(item.record.serializedEnvelope))
        }
        let incoming = state.inbox.filter { $0.ownerGeneration == state.owner.generation && $0.peerGeneration == peerGeneration }.map { item in
            DmNativeThreadMessage(clientMessageId: item.clientMessageId, direction: .incoming,
                text: item.text, delivery: .received, reason: nil, localCreatedAtMillis: nil,
                envelopeSha256: envelopeSha256(item.serializedEnvelope))
        }
        return DmNativeThread(ownerGeneration: state.owner.generation, peerGeneration: peerGeneration,
            messages: outgoing + incoming,
            unresolvedCount: state.unresolved.filter { $0.ownerGeneration == state.owner.generation && $0.peerGeneration == peerGeneration }.count,
            outgoingCapacity: capacity, incomingCapacity: capacity)
    }

    private static func envelopeSha256(_ serializedEnvelope: String) -> String {
        SHA256.hash(data: Data(serializedEnvelope.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // Research-native lifecycle authority, not proof of a real Auth sign-in.
    // Persisted epoch survives process restarts; bearer tokens are never saved.
    // Reading this exposes only identifiers/status, never keys or message text.
    func lifecycleForResearch() throws -> DmLifecycleSnapshot {
        try withState { _, state in Self.lifecycle(state) }
    }

    // Auth binds this existing native identity to its native-created store ID.
    // This is not a hardware attestation or server device registration.
    func authScopeForResearch() throws -> (lifecycle: DmLifecycleSnapshot, storeID: UUID, projectOrigin: String?) {
        try withState { _, state in (Self.lifecycle(state), store.storeID, state.authProjectOrigin) }
    }

    /// Reserve a durable epoch BEFORE token verification leaves the process.
    /// A concurrent adapter/restart/refresh makes the old response unusable even
    /// when both tokens resolve to the same account. No keys or records rebound.
    @discardableResult
    func beginAuthVerificationForResearch(expected: DmLifecycleSnapshot) throws -> DmLifecycleSnapshot {
        try withState { revision, state in
            guard Self.lifecycle(state) == expected else { throw DmCoordinatorError.unavailable }
            state.credentialEpoch = UUID()
            try persist(state, revision: revision)
            return Self.lifecycle(state)
        }
    }

    /// Used only after the concrete native Supabase adapter verifies /user.
    /// Expected scope/epoch is part of the sealed CAS, not a caller assertion.
    /// An active renewal keeps pending ciphertext in its original generation;
    /// resuming a signed-out owner advances it and cannot revive old records.
    @discardableResult
    func completeAuthVerificationForResearch(expected: DmLifecycleSnapshot,
                                             verifiedUserId: String, projectOrigin: String) throws -> DmLifecycleSnapshot {
        try withState { revision, state in
            guard Self.lifecycle(state) == expected,
                  state.owner.userId.utf8.elementsEqual(verifiedUserId.utf8),
                  state.owner.deviceId == store.storeID.uuidString.lowercased(),
                  state.authProjectOrigin == nil || state.authProjectOrigin == projectOrigin else {
                throw DmCoordinatorError.unavailable
            }
            if !state.ownerActive { try Self.advanceOwner(&state) }
            else { state.credentialEpoch = UUID() }
            state.ownerActive = true
            state.authProjectOrigin = projectOrigin
            try persist(state, revision: revision)
            return Self.lifecycle(state)
        }
    }

    /// The auth adapter clears all in-memory credentials first. A late account
    /// mismatch may deactivate only its exact reserved lifecycle. Local logout
    /// deliberately closes the current scope, including a competing renewal.
    @discardableResult
    func deactivateAuthScopeForResearch(expected: DmLifecycleSnapshot? = nil) throws -> DmLifecycleSnapshot {
        // Local unconditional logout retries only a competing sealed revision,
        // from fresh state, within a fixed bound. Storage/key failures propagate.
        // Expected-ticket mismatches MUST NOT close somebody else's newer lease.
        for index in 0..<3 {
            do {
                return try withState { revision, state in
                    if let expected, Self.lifecycle(state) != expected { throw DmCoordinatorError.unavailable }
                    if state.ownerActive, state.owner.generation < Self.generationMax { try Self.advanceOwner(&state) }
                    else { state.credentialEpoch = UUID() }
                    state.ownerActive = false
                    try persist(state, revision: revision)
                    return Self.lifecycle(state)
                }
            } catch VodozemacSealedStoreError.staleRevision {
                if expected != nil || index == 2 { throw VodozemacSealedStoreError.staleRevision }
            }
        }
        throw DmCoordinatorError.unavailable
    }

    func validateRelayContextForResearch(owner: DmOwnerContext, credentialEpoch: UUID, peerGeneration: Int64?) throws {
        try withState { _, state in
            try Self.requireOwner(owner, state)
            try Self.requireEpoch(credentialEpoch, state)
            if let generation = peerGeneration { _ = try Self.requirePeer(owner, generation, state) }
        }
    }

    @discardableResult
    func signOutForResearch(owner: DmOwnerContext) throws -> DmLifecycleSnapshot {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            // Exhausted counters must not leave an account active on logout.
            // The final inactive scope cannot resume, but still rotates its
            // epoch so previously captured credentials are invalidated.
            if state.owner.generation < Self.generationMax { try Self.advanceOwner(&state) }
            else { state.credentialEpoch = UUID() }
            state.ownerActive = false
            try persist(state, revision: revision)
            return Self.lifecycle(state)
        }
    }

    /// Only a future native Auth adapter may attest the authenticated identity.
    /// Here these arguments are explicit fixtures, not a JS/plugin API. Resume
    /// keeps immutable account/device keys; replacement needs a separate store.
    /// Old pending records and history are NEVER rebound to the new generation.
    @discardableResult
    func resumeOwnerForResearch(signedOut: DmOwnerContext, authenticatedUserId: String,
                                authenticatedDeviceId: String) throws -> DmLifecycleSnapshot {
        try withState { revision, state in
            try Self.validateOwner(signedOut)
            guard !state.ownerActive, state.owner == signedOut,
                  authenticatedUserId.utf8.elementsEqual(state.owner.userId.utf8),
                  authenticatedDeviceId.utf8.elementsEqual(state.owner.deviceId.utf8) else {
                throw DmCoordinatorError.unavailable
            }
            try Self.advanceOwner(&state)
            state.ownerActive = true
            try persist(state, revision: revision)
            return Self.lifecycle(state)
        }
    }

    /// Same-account token renewal fences in-flight HTTP through a new durable
    /// epoch, without re-encrypting/rebinding pending ciphertext or history.
    @discardableResult
    func rotateCredentialEpochForResearch(owner: DmOwnerContext) throws -> DmLifecycleSnapshot {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            state.credentialEpoch = UUID()
            try persist(state, revision: revision)
            return Self.lifecycle(state)
        }
    }

    func publicIdentity(owner: DmOwnerContext) throws -> DmPublicIdentity {
        try withState { _, state in
            try Self.requireOwner(owner, state)
            return DmPublicIdentity(userId: state.owner.userId, deviceId: state.owner.deviceId,
                identityKeyId: state.identityKeyId, signingKey: state.signingKey, curve: state.curve, prekey: state.prekey)
        }
    }

    /// Read-only sealed peer context for the isolated relay adapter. This does
    /// not authenticate a first-use directory key or establish app Auth.
    func peerForResearch(owner: DmOwnerContext, generation: Int64) throws -> DmPeerContext {
        try withState { _, state in try Self.requirePeer(owner, generation, state) }
    }

    /// Freeze the first exact signed registration BEFORE dispatch. An uncertain
    /// retry may replay those same bytes after session/prekey use, but must never
    /// create a different prekey ID, expiry, signature or device registration.
    func signedBundleForResearch(prekeyId: String, expiresAt: Int64, now: Int64, owner: DmOwnerContext,
                                 credentialEpoch: UUID? = nil) throws -> String {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            try Self.requireEpoch(credentialEpoch, state)
            try DmContentCodec.validateIdentifier(prekeyId)
            guard now > 0, now <= DmRelayCodec.maxSafeInteger else { throw DmCoordinatorError.invalidInput }
            if let intent = state.registrationIntent {
                let bundle = try Self.registrationBundle(intent, state: state)
                guard bundle.prekeyId == prekeyId, bundle.expiresAt == expiresAt else { throw DmCoordinatorError.conflict }
                // Do not re-sign or extend an expired bundle. The relay can
                // reconcile an existing byte-identical registration; a peer
                // claim still separately requires an unexpired prekey bundle.
                try persist(state, revision: revision)
                return intent.signedBundle
            }
            guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty,
                  state.unresolved.isEmpty else { throw DmCoordinatorError.unavailable }
            try DmRelayCodec.expiry(expiresAt, now: now, maximum: 7 * 24 * 60 * 60)
            let identity = DmPublicIdentity(userId: owner.userId, deviceId: owner.deviceId, identityKeyId: state.identityKeyId,
                                           signingKey: state.signingKey, curve: state.curve, prekey: state.prekey)
            let signed = try signPublicRequest(accountPickle: state.account, pickleKey: store.providerPickleKey(),
                message: DmRelayCodec.bundleSigningBytes(identity, prekeyId: prekeyId, expiresAt: expiresAt))
            guard signed.signingKey == state.signingKey else { throw DmCoordinatorError.conflict }
            let wire = try DmRelayCodec.bundleWire(identity, prekeyId: prekeyId, expiresAt: expiresAt, signature: signed.signature)
            state.registrationIntent = RegistrationIntent(signedBundle: wire)
            // Signing doesn't advance Olm, but this CAS fences a competing owner
            // change before a signature becomes observable outside native code.
            try persist(state, revision: revision)
            return wire
        }
    }

    /// Native-only recovery path. No caller reconstruction of expiry/prekey ID,
    /// no new signature, and no implicit intent creation on a legacy snapshot.
    func savedRegistrationBundleForResearch(owner: DmOwnerContext, credentialEpoch: UUID) throws -> String {
        try withState { _, state in
            try Self.requireOwner(owner, state)
            try Self.requireEpoch(credentialEpoch, state)
            guard let intent = state.registrationIntent else { throw DmCoordinatorError.unavailable }
            _ = try Self.registrationBundle(intent, state: state)
            return intent.signedBundle
        }
    }

    func signedClaimForResearch(requestId: String, expiresAt: Int64, now: Int64,
                                owner: DmOwnerContext, peerGeneration: Int64, credentialEpoch: UUID? = nil,
                                claimId: String? = nil) throws -> String {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
            if let claimId { try DmContentCodec.validateIdentifier(claimId) }
            let stableId: String
            if let intent = state.claimIntent {
                guard intent.owner == owner, intent.peer == peer,
                      claimId == nil || intent.claimId == claimId else { throw DmCoordinatorError.conflict }
                stableId = intent.claimId
            } else {
                // An old used snapshot contains no trustworthy claim ledger.
                // Never reconstruct or rebind a reservation from its ratchet.
                guard state.session == nil, state.outbox.isEmpty, state.inbox.isEmpty,
                      state.unresolved.isEmpty else { throw DmCoordinatorError.unavailable }
                stableId = claimId ?? requestId
                try DmContentCodec.validateIdentifier(stableId)
                state.claimIntent = ClaimIntent(owner: owner, peer: peer, claimId: stableId)
            }
            let payload = "[" + (try [peer.userId, peer.deviceId, stableId].map(DmRelayCodec.quote)).joined(separator: ",") + "]"
            return try signRelay(state: state, revision: revision, owner: owner, action: "claim", payload: payload,
                                 requestId: requestId, expiresAt: expiresAt, now: now)
        }
    }

    /// Caller cannot sign a newly fabricated outbox: only exact durable pending
    /// ciphertext belonging to the current native owner and pinned peer.
    func signedSendForResearch(_ record: DmOutboxRecord, requestId: String, expiresAt: Int64, now: Int64,
                               owner: DmOwnerContext, peerGeneration: Int64, credentialEpoch: UUID? = nil) throws -> String {
        try withState { revision, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
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
                               owner: DmOwnerContext, credentialEpoch: UUID? = nil) throws -> String {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            try Self.requireEpoch(credentialEpoch, state)
            guard (0...Self.generationMax).contains(afterId), (1...16).contains(batch) else { throw DmCoordinatorError.invalidInput }
            return try signRelay(state: state, revision: revision, owner: owner, action: "list", payload: "[\(afterId),\(batch)]",
                                 requestId: requestId, expiresAt: expiresAt, now: now)
        }
    }

    private func signRelay(state: State, revision: Int64, owner: DmOwnerContext, action: String, payload: String,
                           requestId: String, expiresAt: Int64, now: Int64, persistState: Bool = true) throws -> String {
        try DmRelayCodec.expiry(expiresAt, now: now, maximum: 300)
        let signed = try signPublicRequest(accountPickle: state.account, pickleKey: store.providerPickleKey(),
            message: DmRelayCodec.requestSigningBytes(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt, payload: payload))
        guard signed.signingKey == state.signingKey else { throw DmCoordinatorError.conflict }
        let wire = try DmRelayCodec.requestWire(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt,
                                               payload: payload, signature: signed.signature)
        if persistState { try persist(state, revision: revision) }
        else { try checkMessageAuthority(state) }
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
                 localCreatedAtMillis: Int64? = nil,
                 fault: VodozemacSealedStore.CommitFault = .none) throws -> DmOutboxRecord {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try DmContentCodec.validateIdentifier(clientMessageId)
            if messageAuthority?.privateMessagePreparation == true {
                // Check the SAME sealed snapshot used for encryption and CAS.
                // Another coordinator cannot insert a different pending ID
                // between a separate preliminary read and this preparation.
                guard state.outbox.filter({ $0.status == .pending }).allSatisfy({
                    $0.messageId == clientMessageId && $0.record.ownerSessionGeneration == owner.generation &&
                    $0.record.recipientIdentityGeneration == peerGeneration
                }) else { throw DmCoordinatorError.unavailable }
            }
            guard text.utf8.count <= DmContentCodec.maxTextBytes else { throw DmCoordinatorError.invalidInput }
            if let timestamp = localCreatedAtMillis, !(1...Self.generationMax).contains(timestamp) {
                throw DmCoordinatorError.invalidInput
            }
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
                requestDigest: digest, status: .pending, reason: nil, text: text, localCreatedAtMillis: localCreatedAtMillis))
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
                           credentialEpoch: UUID? = nil,
                           fault: VodozemacSealedStore.CommitFault = .none) throws {
        try withState { revision, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
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
                          credentialEpoch: UUID? = nil,
                          fault: VodozemacSealedStore.CommitFault = .none) throws {
        try withState { revision, state in
            try Self.requireOwner(owner, state)
            try Self.requireEpoch(credentialEpoch, state)
            let index = try Self.outboxIndex(record, state)
            if state.outbox[index].status == .rejected, state.outbox[index].reason == reason { return }
            guard state.outbox[index].status == .pending else { throw DmCoordinatorError.conflict }
            state.outbox[index].status = .rejected
            state.outbox[index].reason = reason
            try persist(state, revision: revision, fault: fault)
        }
    }

    func receive(_ serializedEnvelope: String, owner: DmOwnerContext, peerGeneration: Int64,
                 credentialEpoch: UUID? = nil,
                 fault: VodozemacSealedStore.CommitFault = .none) throws -> DmReceiveResult {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
            let envelope = try DmEnvelope.decode(serializedEnvelope)
            guard envelope.senderDeviceId == peer.deviceId, envelope.recipientDeviceId == owner.deviceId else {
                throw DmCoordinatorError.conflict
            }
            guard !state.unresolved.contains(where: { $0.clientMessageId == envelope.clientMessageId }) else {
                throw DmCoordinatorError.conflict // Only explicit retry can promote a queued row.
            }
            if let old = state.inbox.first(where: { $0.clientMessageId == envelope.clientMessageId }) {
                guard old.serializedEnvelope.utf8.elementsEqual(serializedEnvelope.utf8),
                      old.ownerGeneration == owner.generation, old.peerGeneration == peerGeneration else {
                    throw DmCoordinatorError.conflict
                }
                return .duplicate
            }
            guard state.inbox.count + state.unresolved.count < Self.capacity else { throw DmCoordinatorError.capacity }
            let key = try store.providerPickleKey()
            let message: DmReceivedMessage
            do { message = try Self.openCandidate(serializedEnvelope, envelope: envelope, peer: peer, state: &state, key: key) }
            catch CandidateFailure.contentNotBound { throw DmFrameError.invalidInput }
            try persist(state, revision: revision, fault: fault)
            return .stored(message) // Plaintext is never exposed before commit.
        }
    }

    /// Bounded native-only unresolved ledger. No caller-supplied failure reason
    /// is trusted. Only the provider's typed incoming-message failure or a
    /// narrowly isolated authenticated-content failure can retain ciphertext.
    /// Storage/key/identity/frame/CAS/capacity errors remain fatal to the batch.
    func receiveOrDeferForResearch(serverId: Int64, serializedEnvelope: String,
                                  relayRecord: DmOutboxRecord? = nil,
                                  owner: DmOwnerContext, peerGeneration: Int64, credentialEpoch: UUID,
                                  fault: VodozemacSealedStore.CommitFault = .none) throws -> DmInboundSyncResult {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
            guard (1...Self.generationMax).contains(serverId) else { throw DmCoordinatorError.invalidInput }
            let envelope = try DmEnvelope.decode(serializedEnvelope)
            guard envelope.senderDeviceId == peer.deviceId, envelope.recipientDeviceId == owner.deviceId else {
                throw DmCoordinatorError.conflict
            }
            if let record = relayRecord { try Self.validateInboundRecord(record, envelope: serializedEnvelope, state: state, peer: peer) }
            if let saved = state.unresolved.first(where: { $0.serverId == serverId || $0.clientMessageId == envelope.clientMessageId }) {
                guard saved.serverId == serverId, saved.clientMessageId == envelope.clientMessageId,
                      saved.serializedEnvelope.utf8.elementsEqual(serializedEnvelope.utf8),
                      Self.exactOptionalRecord(saved.relayRecord, relayRecord) else {
                    throw DmCoordinatorError.conflict
                }
                // Rescans NEVER retry decryption, even after other messages have
                // advanced the session. Explicit native retry is required.
                return saved.ownerGeneration == owner.generation && saved.peerGeneration == peerGeneration
                    ? .deferred : .historicalUnresolved
            }
            if let old = state.inbox.first(where: { $0.clientMessageId == envelope.clientMessageId || $0.relayServerId == serverId }) {
                guard old.clientMessageId == envelope.clientMessageId,
                      old.serializedEnvelope.utf8.elementsEqual(serializedEnvelope.utf8) else { throw DmCoordinatorError.conflict }
                if let bound = old.relayServerId {
                    guard bound == serverId, Self.exactOptionalRecord(old.relayRecord, relayRecord) else { throw DmCoordinatorError.conflict }
                }
                return old.ownerGeneration == owner.generation && old.peerGeneration == peerGeneration ? .duplicate : .historical
            }
            guard state.inbox.count + state.unresolved.count < Self.capacity else { throw DmCoordinatorError.capacity }
            let key = try store.providerPickleKey()
            var trial = state // Speculative account/OTK/session changes MUST NOT enter a deferred commit.
            var reason: UnresolvedReason?
            var message: DmReceivedMessage?
            do {
                message = try Self.openCandidate(serializedEnvelope, envelope: envelope, peer: peer, state: &trial, key: key,
                                                 serverId: serverId, relayRecord: relayRecord)
            } catch NativeCryptoError.MessageNotOpened { reason = .messageNotOpened }
              catch CandidateFailure.contentNotBound { reason = .contentNotBound }
            if let message = message {
                try persist(trial, revision: revision, fault: fault)
                return .stored(message)
            }
            guard let reason = reason else { throw DmCoordinatorError.unavailable }
            state.unresolved.append(UnresolvedItem(serverId: serverId, clientMessageId: envelope.clientMessageId,
                serializedEnvelope: serializedEnvelope, relayRecord: relayRecord, ownerGeneration: owner.generation,
                peerGeneration: peerGeneration, reason: reason))
            try persist(state, revision: revision, fault: fault)
            return .deferred // No plaintext or rejected/read receipt.
        }
    }

    /// Retry the exact saved row, under its original local lifecycle only.
    /// Success atomically promotes queue -> inbox with the advanced ratchet.
    /// Failure retains original ciphertext and crypto state, with a sealed CAS
    /// even for a repeated failed attempt. Nothing is silently evicted/rebound.
    func retryUnresolvedForResearch(serverId: Int64, owner: DmOwnerContext, peerGeneration: Int64,
                                   credentialEpoch: UUID,
                                   fault: VodozemacSealedStore.CommitFault = .none) throws -> DmInboundSyncResult {
        try withState { revision, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
            guard let index = state.unresolved.firstIndex(where: { $0.serverId == serverId }) else { throw DmCoordinatorError.conflict }
            let saved = state.unresolved[index]
            guard saved.ownerGeneration == owner.generation, saved.peerGeneration == peerGeneration else {
                throw DmCoordinatorError.unavailable
            }
            let envelope = try DmEnvelope.decode(saved.serializedEnvelope)
            let key = try store.providerPickleKey()
            var trial = state
            trial.unresolved.remove(at: index)
            var message: DmReceivedMessage?
            do {
                message = try Self.openCandidate(saved.serializedEnvelope, envelope: envelope, peer: peer, state: &trial, key: key,
                                                 serverId: saved.serverId, relayRecord: saved.relayRecord)
            } catch NativeCryptoError.MessageNotOpened { /* Retain original state. */ }
              catch CandidateFailure.contentNotBound { /* Retain original state. */ }
            if let message = message {
                try persist(trial, revision: revision, fault: fault)
                return .stored(message)
            }
            try persist(state, revision: revision, fault: fault)
            return .deferred
        }
    }

    func unresolvedCountForResearch(owner: DmOwnerContext, peerGeneration: Int64) throws -> Int {
        try withState { _, state in
            _ = try Self.requirePeer(owner, peerGeneration, state)
            return state.unresolved.filter { $0.ownerGeneration == owner.generation && $0.peerGeneration == peerGeneration }.count
        }
    }

    /// Operates on a caller-owned trial snapshot only, never persistence.
    private static func openCandidate(_ serializedEnvelope: String, envelope: DmEnvelope, peer: DmPeerContext,
                                      state: inout State, key: Data, serverId: Int64? = nil,
                                      relayRecord: DmOutboxRecord? = nil) throws -> DmReceivedMessage {
        let advanced: Session
        let plaintext: Data
        if let session = state.session {
            let opened = try decrypt(sessionPickle: session.pickle, pickleKey: key, wire: envelope.wire)
            guard opened.sessionId == session.id else { throw DmCoordinatorError.conflict }
            advanced = Session(pickle: opened.sessionPickle, id: opened.sessionId)
            plaintext = opened.plaintext
        } else {
            guard initiates(peer.deviceId, state.owner.deviceId) else { throw DmCoordinatorError.unavailable }
            let opened = try openSession(accountPickle: state.account, pickleKey: key, pinnedSenderCurve: peer.curve, wire: envelope.wire)
            state.account = opened.accountPickle
            advanced = Session(pickle: opened.sessionPickle, id: opened.sessionId)
            plaintext = opened.plaintext
        }
        let expected = context(state, peer: peer, messageId: envelope.clientMessageId, sessionId: advanced.id, outbound: false)
        try DmContentCodec.validateContext(expected) // Local metadata failure is NOT deferred.
        let text: String
        do { text = try DmContentCodec.decode(plaintext, expected: expected) }
        catch DmFrameError.invalidInput { throw CandidateFailure.contentNotBound }
        let message = DmReceivedMessage(clientMessageId: envelope.clientMessageId, text: text,
            serializedEnvelope: serializedEnvelope, ownerGeneration: state.owner.generation, peerGeneration: peer.generation,
            relayServerId: serverId, relayRecord: relayRecord)
        state.session = advanced
        state.inbox.append(message)
        return message
    }

    /// Explicit read-only rescan reconciliation. Identities are immutable in
    /// this store: current owner + accepted unchanged peer may recognise exact
    /// ciphertext saved before a generation change. No plaintext, old-history
    /// restoration, ratchet mutation, or outbox rebinding occurs. Unknown rows
    /// still require receive() and a durable guarded commit. A future key/device
    /// replacement must NOT reuse this identity scope.
    func knownInboundForResearch(_ serializedEnvelope: String, owner: DmOwnerContext,
                                 peerGeneration: Int64, credentialEpoch: UUID? = nil) throws -> DmKnownInbound {
        try withState { _, state in
            let peer = try Self.requirePeer(owner, peerGeneration, state)
            try Self.requireEpoch(credentialEpoch, state)
            let envelope = try DmEnvelope.decode(serializedEnvelope)
            guard envelope.senderDeviceId == peer.deviceId, envelope.recipientDeviceId == owner.deviceId else {
                throw DmCoordinatorError.conflict
            }
            guard let old = state.inbox.first(where: { $0.clientMessageId == envelope.clientMessageId }) else { return .unknown }
            guard old.serializedEnvelope.utf8.elementsEqual(serializedEnvelope.utf8) else { throw DmCoordinatorError.conflict }
            return old.ownerGeneration == owner.generation && old.peerGeneration == peerGeneration ? .current : .historical
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
            try Self.advanceOwner(&state)
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
        try checkMessageAuthority(state)
        let result = try operation(snapshot.revision, &state)
        // Another raw research coordinator can write without this object's
        // lock. Re-read the durable context before releasing any public result.
        if messageAuthority != nil {
            let latest = try JSONDecoder().decode(State.self, from: store.read().payload)
            try Self.validate(latest)
            try checkMessageAuthority(latest)
        }
        return result
    }

    private func checkMessageAuthority(_ state: State) throws {
        guard let authority = messageAuthority else { return }
        try authority.check()
        let context = authority.context
        try Self.requireOwner(DmOwnerContext(userId: context.userId, deviceId: context.deviceId,
            generation: context.ownerGeneration), state)
        try Self.requireEpoch(context.credentialEpoch, state)
        if let generation = context.peerGeneration { _ = try Self.requirePeer(state.owner, generation, state) }
        if let permit = authority.policy {
            try requireMessaging(permit, context: context, state: state, initialClaim: authority.initialClaimRequired)
        }
        try authority.check()
    }

    private func persist(_ state: State, revision: Int64, fault: VodozemacSealedStore.CommitFault = .none) throws {
        try Self.validate(state)
        try beforeCommitForResearch?()
        try checkMessageAuthority(state)
        try store.commit(expectedRevision: revision, payload: JSONEncoder().encode(state), fault: fault,
                         checkAuthority: { try self.checkMessageAuthority(state) })
    }

    private static func requireOwner(_ owner: DmOwnerContext, _ state: State) throws {
        try validateOwner(owner)
        guard state.ownerActive, owner == state.owner else { throw DmCoordinatorError.unavailable }
    }

    private static func lifecycle(_ state: State) -> DmLifecycleSnapshot {
        DmLifecycleSnapshot(owner: state.owner, active: state.ownerActive, credentialEpoch: state.credentialEpoch)
    }

    // Optional only for legacy non-network provider probes. The relay adapter
    // always supplies its captured epoch for signing and atomic local decisions.
    private static func requireEpoch(_ expected: UUID?, _ state: State) throws {
        if let expected = expected, expected != state.credentialEpoch { throw DmCoordinatorError.unavailable }
    }

    private static func advanceOwner(_ state: inout State) throws {
        guard state.owner.generation < generationMax else { throw DmCoordinatorError.unavailable }
        state.owner = DmOwnerContext(userId: state.owner.userId, deviceId: state.owner.deviceId,
                                    generation: state.owner.generation + 1)
        state.credentialEpoch = UUID()
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

    private static func exactOptionalRecord(_ a: DmOutboxRecord?, _ b: DmOutboxRecord?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (.some(let a), .some(let b)): return exactRecord(a, b)
        default: return false
        }
    }

    private static func validateInboundRecord(_ record: DmOutboxRecord, envelope: String, state: State, peer: DmPeerContext) throws {
        guard record.serializedEnvelope.utf8.elementsEqual(envelope.utf8), record.ownerUserId == peer.userId,
              record.recipientUserId == state.owner.userId, record.recipientIdentityKeyId == state.identityKeyId,
              (0...generationMax).contains(record.ownerSessionGeneration),
              (0...generationMax).contains(record.recipientIdentityGeneration) else { throw DmCoordinatorError.conflict }
        _ = try DmRelayCodec.outboxWire(record)
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

    /// Validate saved public bytes without renewing their time validity. This
    /// authenticates local intent consistency, not live server registration.
    private static func registrationBundle(_ intent: RegistrationIntent, state: State) throws -> DmRelayBundle {
        guard intent.signedBundle.utf8.count <= 4096,
              intent.signedBundle.utf8.allSatisfy({ (32...126).contains($0) }),
              let bundle = try? JSONDecoder().decode(DmRelayBundle.self, from: Data(intent.signedBundle.utf8)),
              bundle.version == 1, bundle.protocol == "olm-v1",
              bundle.userId == state.owner.userId, bundle.deviceId == state.owner.deviceId,
              bundle.identityKeyId == state.identityKeyId, bundle.signingKey == state.signingKey,
              bundle.curveKey == state.curve, bundle.prekey == state.prekey,
              (1...generationMax).contains(bundle.expiresAt) else { throw DmCoordinatorError.unsupportedState }
        let identity = DmPublicIdentity(userId: bundle.userId, deviceId: bundle.deviceId, identityKeyId: bundle.identityKeyId,
            signingKey: bundle.signingKey, curve: bundle.curveKey, prekey: bundle.prekey)
        let canonical = try DmRelayCodec.bundleWire(identity, prekeyId: bundle.prekeyId,
            expiresAt: bundle.expiresAt, signature: bundle.signature)
        guard canonical.utf8.elementsEqual(intent.signedBundle.utf8) else { throw DmCoordinatorError.unsupportedState }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(bundle.signingKey))
        guard key.isValidSignature(try DmRelayCodec.keyBytes(bundle.signature, count: 64),
            for: try DmRelayCodec.bundleSigningBytes(identity, prekeyId: bundle.prekeyId, expiresAt: bundle.expiresAt)) else {
            throw DmCoordinatorError.unsupportedState
        }
        return bundle
    }

    // Stored expired/historical selections remain consistency-checked facts.
    // Validation NEVER re-signs or treats their old epoch as current authority.
    private static func validateProtectedAccountIntent(_ intent: ProtectedAccountIntent, state: State) throws {
        try validateOwner(intent.owner)
        try DmContentCodec.validateIdentifier(intent.requestId)
        guard state.authProjectOrigin != nil, state.registrationAcknowledgement != nil,
              intent.owner.userId.utf8.elementsEqual(state.owner.userId.utf8),
              intent.owner.deviceId.utf8.elementsEqual(state.owner.deviceId.utf8),
              intent.owner.generation <= state.owner.generation,
              intent.issuedAtSeconds > 0, intent.issuedAtSeconds <= generationMax - 240,
              intent.expiresAt == intent.issuedAtSeconds + 240,
              !intent.wire.isEmpty, intent.wire.utf8.count <= 2048,
              intent.wire.utf8.allSatisfy({ (32...126).contains($0) }),
              let frame = try? JSONDecoder().decode(ProtectedAccountWire.self, from: Data(intent.wire.utf8)),
              frame.version == 1, frame.protocol == "olm-v1", frame.action == "require-protected",
              frame.payload == "[]", frame.userId.utf8.elementsEqual(intent.owner.userId.utf8),
              frame.deviceId.utf8.elementsEqual(intent.owner.deviceId.utf8),
              frame.requestId.utf8.elementsEqual(intent.requestId.utf8), frame.expiresAt == intent.expiresAt else {
            throw DmCoordinatorError.unsupportedState
        }
        let canonical = try DmRelayCodec.requestWire(owner: intent.owner, action: frame.action,
            requestId: intent.requestId, expiresAt: intent.expiresAt, payload: "[]", signature: frame.signature)
        guard canonical.utf8.elementsEqual(intent.wire.utf8) else { throw DmCoordinatorError.unsupportedState }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(state.signingKey))
        guard key.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64),
            for: try DmRelayCodec.requestSigningBytes(owner: intent.owner, action: frame.action,
                requestId: intent.requestId, expiresAt: intent.expiresAt, payload: "[]")) else {
            throw DmCoordinatorError.unsupportedState
        }
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
        // Older research snapshots are refused, never recreated/migrated into
        // a newly active identity. A shipping migration remains separate work.
        guard state.version == 5, !state.account.isEmpty, state.account.utf8.count <= 256 * 1024,
              state.outbox.count <= capacity, state.inbox.count + state.unresolved.count <= capacity else {
            throw DmCoordinatorError.unsupportedState
        }
        try validateOwner(state.owner)
        if let origin = state.authProjectOrigin {
            guard let parts = URLComponents(string: origin), parts.scheme == "https", parts.host != nil,
                  parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                  parts.path.isEmpty, parts.url?.absoluteString == origin else {
                throw DmCoordinatorError.unsupportedState
            }
        }
        try DmContentCodec.validateIdentifier(state.identityKeyId)
        try DmContentCodec.validateIdentifier(state.conversationId)
        try validateKey(state.curve)
        try validateKey(state.signingKey)
        try validateKey(state.prekey)
        if let intent = state.registrationIntent { _ = try registrationBundle(intent, state: state) }
        if let acknowledgement = state.registrationAcknowledgement {
            guard state.authProjectOrigin != nil, let intent = state.registrationIntent,
                  acknowledgement.count == 32,
                  acknowledgement == Data(SHA256.hash(data: Data(intent.signedBundle.utf8))) else {
                throw DmCoordinatorError.unsupportedState
            }
        }
        if let intent = state.protectedAccountIntent { try validateProtectedAccountIntent(intent, state: state) }
        if let confirmed = state.protectedAccountConfirmed {
            guard confirmed, state.authProjectOrigin != nil, state.registrationAcknowledgement != nil else {
                throw DmCoordinatorError.unsupportedState
            }
        }
        guard let peer = state.peer else {
            guard state.peerIdentity == nil, state.peerFingerprint == nil, state.session == nil, state.claimIntent == nil,
                  state.claimConfirmation == nil, state.outbox.isEmpty,
                  state.inbox.isEmpty, state.unresolved.isEmpty else {
                throw DmCoordinatorError.unsupportedState
            }
            return
        }
        try validatePeer(peer, owner: state.owner)
        guard (state.peerIdentity == nil) == (state.peerFingerprint == nil) else { throw DmCoordinatorError.unsupportedState }
        if let identity = state.peerIdentity {
            guard let origin = state.authProjectOrigin, let fingerprint = state.peerFingerprint,
                  identity.userId == peer.userId, identity.deviceId == peer.deviceId,
                  identity.identityKeyId == peer.identityKeyId, identity.curve == peer.curve, identity.prekey == peer.prekey,
                  try DmPairingCard(projectOrigin: origin, conversationId: state.conversationId, identity: identity)
                    .fingerprint().utf8.elementsEqual(fingerprint.utf8) else { throw DmCoordinatorError.unsupportedState }
        }
        if let intent = state.claimIntent {
            try validateOwner(intent.owner)
            try validatePeer(intent.peer, owner: intent.owner)
            try DmContentCodec.validateIdentifier(intent.claimId)
            guard intent.owner.userId == state.owner.userId, intent.owner.deviceId == state.owner.deviceId,
                  intent.owner.generation <= state.owner.generation,
                  intent.peer.userId == peer.userId, intent.peer.deviceId == peer.deviceId,
                  intent.peer.identityKeyId == peer.identityKeyId, intent.peer.curve == peer.curve,
                  intent.peer.prekey == peer.prekey, intent.peer.generation <= peer.generation,
                  intent.peer.status == .accepted else { throw DmCoordinatorError.unsupportedState }
        }
        if let confirmation = state.claimConfirmation {
            guard state.registrationAcknowledgement != nil, let intent = state.claimIntent,
                  confirmation.owner == intent.owner, confirmation.peer == intent.peer,
                  confirmation.claimId == intent.claimId, confirmation.peerFingerprint == state.peerFingerprint,
                  initiates(confirmation.owner.deviceId, confirmation.peer.deviceId),
                  let pin = state.peerIdentity else { throw DmCoordinatorError.unsupportedState }
            let bundle = try DmRelayCodec.verifyStoredBundle(confirmation.signedBundle)
            let identity = DmPublicIdentity(userId: bundle.userId, deviceId: bundle.deviceId,
                identityKeyId: bundle.identityKeyId, signingKey: bundle.signingKey,
                curve: bundle.curveKey, prekey: bundle.prekey)
            guard identity == pin else { throw DmCoordinatorError.unsupportedState }
        }
        if let session = state.session {
            try validateKey(session.id)
            guard !session.pickle.isEmpty, session.pickle.utf8.count <= 256 * 1024 else {
                throw DmCoordinatorError.unsupportedState
            }
        } else if !state.outbox.isEmpty || !state.inbox.isEmpty { throw DmCoordinatorError.unsupportedState }
        guard Set(state.outbox.map(\.messageId)).count == state.outbox.count,
              Set(state.inbox.map(\.clientMessageId) + state.unresolved.map(\.clientMessageId)).count == state.inbox.count + state.unresolved.count,
              Set(state.inbox.compactMap(\.relayServerId) + state.unresolved.map(\.serverId)).count
                == state.inbox.compactMap(\.relayServerId).count + state.unresolved.count else {
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
            if let text = item.text {
                guard text.utf8.count <= DmContentCodec.maxTextBytes,
                      Data(SHA256.hash(data: Data(text.utf8))) == item.requestDigest else {
                    throw DmCoordinatorError.unsupportedState
                }
            }
            if let timestamp = item.localCreatedAtMillis {
                guard item.text != nil, (1...generationMax).contains(timestamp) else { throw DmCoordinatorError.unsupportedState }
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
            if let serverId = message.relayServerId {
                guard (1...generationMax).contains(serverId) else { throw DmCoordinatorError.unsupportedState }
            }
            if let record = message.relayRecord {
                guard message.relayServerId != nil else { throw DmCoordinatorError.unsupportedState }
                try validateInboundRecord(record, envelope: message.serializedEnvelope, state: state, peer: peer)
            }
        }
        for item in state.unresolved {
            let frame = try DmEnvelope.decode(item.serializedEnvelope)
            guard (1...generationMax).contains(item.serverId), item.clientMessageId == frame.clientMessageId,
                  frame.senderDeviceId == peer.deviceId, frame.recipientDeviceId == state.owner.deviceId,
                  (0...state.owner.generation).contains(item.ownerGeneration),
                  (0...peer.generation).contains(item.peerGeneration) else {
                throw DmCoordinatorError.unsupportedState
            }
            if let record = item.relayRecord {
                try validateInboundRecord(record, envelope: item.serializedEnvelope, state: state, peer: peer)
            }
        }
    }
}
