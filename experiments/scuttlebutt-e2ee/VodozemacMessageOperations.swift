// ISOLATED native messaging authority. Not a JS plugin, shipping PM port, or
// evidence of a hosted/device exchange. Operations cannot supply owner claims,
// credentials, clocks, store paths or arbitrary coordinator callbacks.
import Foundation
import CryptoKit

enum DmNativeMessageOperation {
    case publicIdentity
    case pairingCard
    case confirmPeer(card: DmPairingCard, confirmedFingerprint: String)
    case pairingState
    case thread
    case prepareText(clientMessageId: String, text: String)
    case pendingRecords
    // Native transport phases ONLY. Never expose response/record application
    // as JS/plugin operations: parsing is not server authentication.
    case relaySendWire(clientMessageId: String)
    case relaySendReceipt(request: DmNativeRelaySendRequest, response: Data)
    // Owner-only, exact rejected receipt from the original HTTPS completion.
    // Never exposes an acceptance bypass or a JS-supplied result application.
    case relayRejectedReceipt(record: DmOutboxRecord, response: Data)
    case relayInboxWire
    case relayInboxResponse(request: DmNativeRelayInboxRequest, response: Data)
    case relayPolicyWire
    case relayPolicyResponse(request: DmNativeRelayPolicyRequest, response: Data)
    case relayPolicyState
    case relayPolicyGuard(DmNativeRelayPolicyPermit)
    case invalidateRelayPolicy
    case relayEnrollmentState
    case relayRegistrationWire
    case relayRegistrationResponse(wire: String, response: Data)
    case relayClaimWire
    case relayClaimResponse(request: DmNativeRelayClaimRequest, response: Data)
}

enum DmNativeMessageResult {
    case publicIdentity(DmPublicIdentity)
    case pairingCard(DmPairingCard)
    case pairingState(DmNativePairingState)
    case thread(DmNativeThread)
    case outbox(DmOutboxRecord)
    case pendingRecords([DmOutboxRecord])
    case sendRequest(DmNativeRelaySendRequest)
    case relayReceipt(DmRelayReceipt)
    case relayRequest(String)
    case inboxReport(DmRelayInboxReport)
    case enrollmentState(DmNativeRelayEnrollmentState)
    case registrationRequest(String)
    case claimRequest(DmNativeRelayClaimRequest)
    case policyRequest(DmNativeRelayPolicyRequest)
    case policyState(DmNativeRelayPolicyState)
    case inboxRequest(DmNativeRelayInboxRequest)
}

// Historical control-plane facts ONLY. An acknowledgement is not current
// server permission, bilateral block status, delivery, or a can-send predicate.
// verified/expired classification uses the current device clock on reads; this
// is not a trusted-time guarantee across restart or subsequent clock changes.
enum DmNativeRegistrationState { case none, pending, acknowledged }
enum DmNativeClaimState { case none, pending, verified, expired, historical }
struct DmNativeRelayEnrollmentState {
    let registration: DmNativeRegistrationState
    let claim: DmNativeClaimState
    let claimedPrekeyExpiresAt: Int64?
}

/// Native-only completion intent. Not Codable or a JS/plugin argument. Its
/// native monotonic start prevents clock rollback during HTTP from extending a
/// peer prekey's validity. The original facade snapshot remains the authority.
struct DmNativeRelayClaimRequest: CustomStringConvertible, CustomDebugStringConvertible {
    let wire: String
    let context: DmRelayNetworkContext
    let claimId: String
    let peerFingerprint: String
    let startedAtSeconds: Int64
    let startedAt: ContinuousClock.Instant
    var description: String { "NativeRelayClaimRequest(<native-only>)" }
    var debugDescription: String { description }
}

/// In-memory transport intent, not a plugin value or send permission. The
/// caller must retain the original native snapshot across dispatch/completion.
struct DmNativeRelaySendRequest: CustomStringConvertible, CustomDebugStringConvertible {
    let wire: String
    let record: DmOutboxRecord
    let policy: DmNativeRelayPolicyPermit
    var description: String { "NativeRelaySendRequest(<native-only>)" }
    var debugDescription: String { description }
}

struct DmRelayInboxReport: Equatable {
    let stored: Int
    let duplicates: Int
    let historical: Int
    let unresolved: Int
    let historicalUnresolved: Int
    init(stored: Int, duplicates: Int, historical: Int = 0, unresolved: Int = 0, historicalUnresolved: Int = 0) {
        self.stored = stored; self.duplicates = duplicates; self.historical = historical
        self.unresolved = unresolved; self.historicalUnresolved = historicalUnresolved
    }
}

/// Public out-of-band pairing material, not proof of the human/account behind
/// it. Confirm its fingerprint with the peer separately. Native pins ALL keys,
/// including the signing key, to the configured project and conversation.
struct DmPairingCard: Codable, Equatable {
    let projectOrigin: String
    let conversationId: String
    let identity: DmPublicIdentity

    func fingerprint() throws -> String {
        let fields = try canonicalFields()
        let bytes = Data(("thalassa-research-pairing-v1\n" + fields.joined(separator: "\n") + "\n").utf8)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private func canonicalFields() throws -> [String] {
        guard let parts = URLComponents(string: projectOrigin), parts.scheme == "https", parts.host != nil,
              projectOrigin.utf8.count <= 256, projectOrigin.utf8.allSatisfy({ (33...126).contains($0) }),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty, parts.url?.absoluteString == projectOrigin else { throw DmCoordinatorError.invalidInput }
        for field in [conversationId, identity.userId, identity.deviceId, identity.identityKeyId] {
            try DmContentCodec.validateIdentifier(field)
        }
        for field in [identity.signingKey, identity.curve, identity.prekey] {
            _ = try DmRelayCodec.keyBytes(field)
        }
        return [projectOrigin, conversationId, identity.userId, identity.deviceId,
                identity.identityKeyId, identity.signingKey, identity.curve, identity.prekey]
    }
}

enum DmNativePeerState: String { case unpaired, confirmed, legacyUnverified, changed, revoked, blocked }
enum DmNativeSessionRole: String { case unpaired, initiator, responder, established }
struct DmNativePairingState {
    let status: DmNativePeerState
    let peerGeneration: Int64?
    let confirmedFingerprint: String?
    let sessionRole: DmNativeSessionRole
    let outgoingCount: Int
    let incomingCount: Int
    let unresolvedCount: Int
}

enum DmNativeThreadDirection: String { case outgoing, incoming }
enum DmNativeThreadDelivery: String { case pending, serverAccepted, rejected, received }
struct DmNativeThreadMessage: Equatable {
    let clientMessageId: String
    let direction: DmNativeThreadDirection
    let text: String?
    let delivery: DmNativeThreadDelivery
    let reason: DmRejectionReason?
    // Device-local creation/observation only; NOT authenticated sender time.
    // Older native fixtures have no timestamp. Never invent one on read/retry.
    let localCreatedAtMillis: Int64?
    // Research equality diagnostic for the exact saved envelope UTF-8 bytes.
    // Never hashes plaintext, keys, pickles or the changing signed HTTP wrapper.
    let envelopeSha256: String
}
struct DmNativeThread {
    let ownerGeneration: Int64
    let peerGeneration: Int64
    let messages: [DmNativeThreadMessage]
    let unresolvedCount: Int
    let outgoingCapacity: Int
    let incomingCapacity: Int
}
