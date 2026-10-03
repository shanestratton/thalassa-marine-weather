// ISOLATED NATIVE RESEARCH. Authenticated relay policy is a bounded diagnostic
// and a native operation gate, not peer trust, enrollment, delivery or reading.
// None of these transport intents is Codable or a JS/plugin argument.
import Foundation

struct DmNativeRelayPolicyRequest: CustomStringConvertible, CustomDebugStringConvertible {
    let wire: String
    let context: DmRelayNetworkContext
    let peer: DmPublicIdentity
    let peerGeneration: Int64
    let peerFingerprint: String
    let requestId: String
    let startedAtSeconds: Int64
    let startedAt: ContinuousClock.Instant
    var description: String { "NativeRelayPolicyRequest(<native-only>)" }
    var debugDescription: String { description }
}

struct DmNativeRelayPolicyState: Equatable {
    let ownerRevoked: Bool
    let peerRevoked: Bool
    let blockedByMe: Bool
    let blockedByPeer: Bool
}

/// Captured native permission, not a reusable assertion of server readiness.
/// The coordinator rechecks this exact permit, pin and original monotonic
/// deadline before signing, accepting plaintext/results and every sealed CAS.
struct DmNativeRelayPolicyPermit: Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    let id: UUID
    let context: DmRelayNetworkContext
    let peerFingerprint: String
    let startedAtSeconds: Int64
    let startedAt: ContinuousClock.Instant
    var description: String { "NativeRelayPolicyPermit(<native-only>)" }
    var debugDescription: String { description }
}

struct DmNativeRelayInboxRequest: CustomStringConvertible, CustomDebugStringConvertible {
    let wire: String
    let policy: DmNativeRelayPolicyPermit
    var description: String { "NativeRelayInboxRequest(<native-only>)" }
    var debugDescription: String { description }
}
