// ISOLATED RESEARCH. Parses public endpoint results, not TLS/server authenticity.
// A valid result is usable only after the transport and native lifecycle guards.
import Foundation

enum DmRelayReceipt: Equatable {
    case accepted(DmOutboxRecord)
    case rejected(DmOutboxRecord, DmRejectionReason)
}

struct DmRelayInboxRow: Equatable {
    let serverId: Int64
    let record: DmOutboxRecord
}

enum DmRelayResultCodec {
    static let maxResponseBytes = 2 * 1024 * 1024
    private static let recordFields: Set<String> = ["ownerUserId", "ownerSessionGeneration", "recipientUserId",
        "recipientIdentityKeyId", "recipientIdentityGeneration", "serializedEnvelope"]

    static func registration(_ data: Data, expected: DmPublicIdentity) throws {
        try validateIdentity(expected)
        let fields = try object(parse(data), keys: ["registered", "userId", "deviceId"])
        guard try boolean(fields, "registered"),
              same(try string(fields, "userId"), expected.userId),
              same(try string(fields, "deviceId"), expected.deviceId) else { throw invalid }
    }

    /// Self-signature verification is not first-use authentication. All claimed
    /// identity/key fields must match the caller's separately pinned identity.
    static func claim(_ data: Data, pinned: DmPublicIdentity, now: Int64) throws -> DmRelayBundle {
        try validateIdentity(pinned)
        let fields = try object(parse(data), keys: ["signedBundle", "prekeyId", "prekey"])
        let bundle = try DmRelayCodec.verifyBundle(string(fields, "signedBundle"), now: now)
        guard same(bundle.userId, pinned.userId), same(bundle.deviceId, pinned.deviceId),
              same(bundle.identityKeyId, pinned.identityKeyId), same(bundle.signingKey, pinned.signingKey),
              same(bundle.curveKey, pinned.curve), same(bundle.prekey, pinned.prekey),
              same(try string(fields, "prekeyId"), bundle.prekeyId),
              same(try string(fields, "prekey"), bundle.prekey) else { throw invalid }
        return bundle
    }

    /// Strict current-policy diagnostic. Parsing alone is NOT authentication:
    /// use only native configured HTTPS bytes under the original Auth lease,
    /// then let the coordinator bind the result to its exact saved peer/permit.
    /// The existing parser detects duplicates, including escaped key aliases,
    /// and never coerces numbers/strings/null into the four policy booleans.
    static func policy(_ data: Data, request: DmNativeRelayPolicyRequest) throws -> DmNativeRelayPolicyState {
        try validateIdentity(request.peer)
        for id in [request.context.userId, request.context.deviceId, request.requestId] { try validateId(id) }
        guard request.context.peerGeneration == nil, uint(request.context.ownerGeneration), uint(request.peerGeneration),
              !same(request.context.userId, request.peer.userId),
              !same(request.context.deviceId, request.peer.deviceId) else { throw invalid }
        let fields = try object(parse(data), keys: ["requestId", "ownerUserId", "ownerDeviceId", "peerUserId",
            "peerDeviceId", "peerIdentityKeyId", "ownerRevoked", "peerRevoked", "blockedByMe", "blockedByPeer"])
        guard same(try string(fields, "requestId"), request.requestId),
              same(try string(fields, "ownerUserId"), request.context.userId),
              same(try string(fields, "ownerDeviceId"), request.context.deviceId),
              same(try string(fields, "peerUserId"), request.peer.userId),
              same(try string(fields, "peerDeviceId"), request.peer.deviceId),
              same(try string(fields, "peerIdentityKeyId"), request.peer.identityKeyId) else { throw invalid }
        return try DmNativeRelayPolicyState(ownerRevoked: boolean(fields, "ownerRevoked"),
            peerRevoked: boolean(fields, "peerRevoked"), blockedByMe: boolean(fields, "blockedByMe"),
            blockedByPeer: boolean(fields, "blockedByPeer"))
    }

    /// Original owner-only HTTPS response, not a permission or a caller result
    /// application API. This deliberately small contract has its own 2 KiB cap.
    static func accountMode(_ data: Data, request: DmNativeRelayAccountModeRequest) throws -> DmNativeRelayAccountModeState {
        guard !data.isEmpty, data.count <= 2048, request.context.peerGeneration == nil,
              uint(request.context.ownerGeneration) else { throw invalid }
        for id in [request.context.userId, request.context.deviceId, request.requestId] { try validateId(id) }
        let fields = try object(parse(data), keys: ["requestId", "ownerUserId", "ownerDeviceId", "mode"])
        guard same(try string(fields, "requestId"), request.requestId),
              same(try string(fields, "ownerUserId"), request.context.userId),
              same(try string(fields, "ownerDeviceId"), request.context.deviceId),
              let mode = DmNativeRelayAccountModeState(rawValue: try string(fields, "mode")),
              request.action != .requireProtected || mode == .protectedRequired else { throw invalid }
        return mode
    }

    /// Match every immutable outbox field, including ciphertext bytes. Malformed
    /// results are unresolved failures, never converted into terminal refusals.
    static func receipt(_ data: Data, expected: DmOutboxRecord) throws -> DmRelayReceipt {
        _ = try validatedRecord(expected)
        guard case .object(let values) = try parse(data) else { throw invalid }
        let accepted = try boolean(values, "accepted")
        let fields = try object(.object(values), keys: recordFields.union(accepted ? ["accepted"] : ["accepted", "reason"]))
        let actual = try record(fields)
        guard exact(actual, expected) else { throw invalid }
        if accepted { return .accepted(actual) }
        guard let reason = DmRejectionReason(rawValue: try string(fields, "reason")) else { throw invalid }
        return .rejected(actual, reason)
    }

    /// One pinned conversation only. A caller must persist its cursor ONLY after
    /// receive() has durably committed each row; no cursor is advanced by parsing.
    /// Sender-owned generation counters are bounded metadata, not the receiver's
    /// local owner/peer generations; authenticated plaintext binds the identities.
    static func inbox(_ data: Data, owner: DmOwnerContext, identity: DmPublicIdentity,
                      peer: DmPeerContext, afterId: Int64, batch: Int) throws -> [DmRelayInboxRow] {
        try validateIdentity(identity)
        for value in [owner.userId, owner.deviceId, peer.userId, peer.deviceId, peer.identityKeyId] {
            try validateId(value)
        }
        _ = try DmRelayCodec.keyBytes(peer.curve)
        _ = try DmRelayCodec.keyBytes(peer.prekey)
        guard uint(owner.generation), uint(peer.generation), uint(afterId), (1...16).contains(batch),
              peer.status == .accepted, same(identity.userId, owner.userId), same(identity.deviceId, owner.deviceId),
              !same(peer.userId, owner.userId), !same(peer.deviceId, owner.deviceId),
              case .array(let rows) = try parse(data), rows.count <= batch else { throw invalid }
        var previous = afterId
        var messageIds = Set<String>()
        var result: [DmRelayInboxRow] = []
        for row in rows {
            let fields = try object(row, keys: recordFields.union(["accepted", "serverId"]))
            let cursor = try integer(fields, "serverId")
            let value = try record(fields)
            let envelope = try validatedRecord(value)
            guard try boolean(fields, "accepted"), cursor > previous,
                  same(value.ownerUserId, peer.userId), same(value.recipientUserId, owner.userId),
                  same(value.recipientIdentityKeyId, identity.identityKeyId),
                  same(envelope.senderDeviceId, peer.deviceId), same(envelope.recipientDeviceId, owner.deviceId),
                  messageIds.insert(envelope.clientMessageId).inserted else { throw invalid }
            previous = cursor
            result.append(DmRelayInboxRow(serverId: cursor, record: value))
        }
        return result
    }

    private static var invalid: DmCoordinatorError { .invalidInput }
    private static func uint(_ value: Int64) -> Bool { (0...DmRelayCodec.maxSafeInteger).contains(value) }
    private static func same(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    private static func exact(_ a: DmOutboxRecord, _ b: DmOutboxRecord) -> Bool {
        a.ownerSessionGeneration == b.ownerSessionGeneration && a.recipientIdentityGeneration == b.recipientIdentityGeneration
            && same(a.ownerUserId, b.ownerUserId) && same(a.recipientUserId, b.recipientUserId)
            && same(a.recipientIdentityKeyId, b.recipientIdentityKeyId) && same(a.serializedEnvelope, b.serializedEnvelope)
    }
    private static func validateIdentity(_ identity: DmPublicIdentity) throws {
        for value in [identity.userId, identity.deviceId, identity.identityKeyId] { try validateId(value) }
        for value in [identity.signingKey, identity.curve, identity.prekey] { _ = try DmRelayCodec.keyBytes(value) }
    }
    private static func validateId(_ value: String) throws {
        do { try DmContentCodec.validateIdentifier(value) } catch { throw invalid }
    }
    private static func validatedRecord(_ value: DmOutboxRecord) throws -> DmEnvelope {
        for id in [value.ownerUserId, value.recipientUserId, value.recipientIdentityKeyId] { try validateId(id) }
        let envelope: DmEnvelope
        do { envelope = try DmEnvelope.decode(value.serializedEnvelope) } catch { throw invalid }
        guard uint(value.ownerSessionGeneration), uint(value.recipientIdentityGeneration),
              !same(value.ownerUserId, value.recipientUserId),
              !same(envelope.senderDeviceId, envelope.recipientDeviceId) else { throw invalid }
        return envelope
    }
    private static func record(_ fields: [String: Value]) throws -> DmOutboxRecord {
        let result = try DmOutboxRecord(ownerUserId: string(fields, "ownerUserId"),
            ownerSessionGeneration: integer(fields, "ownerSessionGeneration"), recipientUserId: string(fields, "recipientUserId"),
            recipientIdentityKeyId: string(fields, "recipientIdentityKeyId"),
            recipientIdentityGeneration: integer(fields, "recipientIdentityGeneration"), serializedEnvelope: string(fields, "serializedEnvelope"))
        _ = try validatedRecord(result)
        return result
    }
    private static func object(_ value: Value, keys: Set<String>) throws -> [String: Value] {
        guard case .object(let fields) = value, Set(fields.keys) == keys else { throw invalid }
        return fields
    }
    private static func string(_ fields: [String: Value], _ key: String) throws -> String {
        guard case .string(let value) = fields[key], value.utf8.allSatisfy({ (32...126).contains($0) }) else { throw invalid }
        return value
    }
    private static func integer(_ fields: [String: Value], _ key: String) throws -> Int64 {
        guard case .integer(let value) = fields[key], uint(value) else { throw invalid }
        return value
    }
    private static func boolean(_ fields: [String: Value], _ key: String) throws -> Bool {
        guard case .boolean(let value) = fields[key] else { throw invalid }
        return value
    }

    // JSONDecoder/JSONSerialization collapse duplicate object keys and bridge
    // booleans/numbers. Parse this small public result grammar before extracting
    // fields. No unbounded recursion, arbitrary numeric syntax or raw Unicode is
    // needed by these ASCII-only relay contracts. Escaped key names are decoded
    // before uniqueness checks, so "accepted" and "\u0061ccepted" collide.
    private indirect enum Value {
        case object([String: Value]), array([Value]), string(String), integer(Int64), boolean(Bool)
    }
    private static func parse(_ data: Data) throws -> Value {
        guard !data.isEmpty, data.count <= maxResponseBytes else { throw invalid }
        do {
            var parser = Parser(bytes: Array(data))
            let result = try parser.value(depth: 0)
            parser.space()
            guard parser.offset == parser.bytes.count else { throw invalid }
            return result
        } catch { throw invalid }
    }
    private struct Parser {
        let bytes: [UInt8]
        var offset = 0
        var nodes = 0
        mutating func space() {
            while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 }
        }
        mutating func value(depth: Int) throws -> Value {
            space(); nodes += 1
            guard depth <= 8, nodes <= 512, offset < bytes.count else { throw invalid }
            switch bytes[offset] {
            case 123:
                offset += 1; space()
                var fields: [String: Value] = [:]
                if consume(125) { return .object(fields) }
                while true {
                    space(); let name = try quoted()
                    guard fields[name] == nil else { throw invalid }
                    space(); guard consume(58) else { throw invalid }
                    fields[name] = try value(depth: depth + 1)
                    space()
                    if consume(125) { return .object(fields) }
                    guard consume(44) else { throw invalid }
                }
            case 91:
                offset += 1; space()
                var rows: [Value] = []
                if consume(93) { return .array(rows) }
                while true {
                    guard rows.count < 16 else { throw invalid }
                    rows.append(try value(depth: depth + 1)); space()
                    if consume(93) { return .array(rows) }
                    guard consume(44) else { throw invalid }
                }
            case 34: return .string(try quoted())
            case 116: try literal("true"); return .boolean(true)
            case 102: try literal("false"); return .boolean(false)
            case 48...57:
                let start = offset
                while offset < bytes.count && (48...57).contains(bytes[offset]) { offset += 1 }
                guard offset - start <= 16, offset - start == 1 || bytes[start] != 48,
                      let number = Int64(String(decoding: bytes[start..<offset], as: UTF8.self)), uint(number) else { throw invalid }
                return .integer(number)
            default: throw invalid
            }
        }
        mutating func consume(_ byte: UInt8) -> Bool {
            guard offset < bytes.count, bytes[offset] == byte else { return false }
            offset += 1; return true
        }
        mutating func literal(_ word: String) throws {
            let token = Array(word.utf8)
            guard bytes.count - offset >= token.count, bytes[offset..<(offset + token.count)].elementsEqual(token) else { throw invalid }
            offset += token.count
        }
        mutating func quoted() throws -> String {
            let start = offset
            guard consume(34) else { throw invalid }
            while offset < bytes.count {
                let byte = bytes[offset]; offset += 1
                if byte == 34 {
                    let raw = Data(bytes[start..<offset])
                    guard let decoded = try JSONSerialization.jsonObject(with: raw, options: [.fragmentsAllowed]) as? String,
                          decoded.utf8.allSatisfy({ (32...126).contains($0) }) else { throw invalid }
                    return decoded
                }
                guard (32...126).contains(byte) else { throw invalid }
                if byte == 92 {
                    guard offset < bytes.count else { throw invalid }
                    let escaped = bytes[offset]; offset += 1
                    if escaped == 117 {
                        guard bytes.count - offset >= 4,
                              bytes[offset..<(offset + 4)].allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else { throw invalid }
                        offset += 4
                    } else if ![34, 47, 92, 98, 102, 110, 114, 116].contains(escaped) { throw invalid }
                }
            }
            throw invalid
        }
    }
}
