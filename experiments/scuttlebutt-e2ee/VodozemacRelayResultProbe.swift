// Parser fixtures only: public fake ciphertext does NOT prove an encrypted trip,
// transport authentication, real accounts, durable delivery or a security audit.
import Foundation
import CryptoKit

// Standalone host parser runner needs no Rust/provider or sealed-store linkage.
// The real coordinator defines these types when this compilation flag is absent.
#if DM_RELAY_RESULT_STANDALONE
enum DmCoordinatorError: Error { case invalidInput }
struct WireMessage { let messageType: UInt32; let body: Data }
struct DmOwnerContext { let userId: String; let deviceId: String; let generation: Int64 }
enum DmPeerStatus { case accepted, blocked, changed, revoked }
struct DmPeerContext {
    let userId: String; let deviceId: String; let identityKeyId: String; let curve: String; let prekey: String
    let generation: Int64; let status: DmPeerStatus
}
struct DmPublicIdentity {
    let userId: String; let deviceId: String; let identityKeyId: String; let signingKey: String; let curve: String; let prekey: String
}
struct DmOutboxRecord: Equatable {
    let ownerUserId: String; let ownerSessionGeneration: Int64; let recipientUserId: String; let recipientIdentityKeyId: String
    let recipientIdentityGeneration: Int64; let serializedEnvelope: String
}
enum DmRejectionReason: String { case blocked; case deviceRevoked = "device-revoked"; case recordConflict = "record-conflict" }
#endif

private enum DmRelayResultProbeError: Error { case assertion(String) }
private func resultRequire(_ condition: Bool, _ label: String) throws {
    guard condition else { throw DmRelayResultProbeError.assertion(label) }
}
private func resultRefuse(_ label: String, _ operation: () throws -> Void) throws {
    do { try operation() } catch { return }
    throw DmRelayResultProbeError.assertion(label)
}
private func resultJSON(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}
private func resultIdentity(_ user: String, _ device: String, _ key: String) throws -> DmPublicIdentity {
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    return DmPublicIdentity(userId: user, deviceId: device, identityKeyId: key,
        signingKey: signing.publicKey.rawRepresentation.base64EncodedString().replacingOccurrences(of: "=", with: ""),
        curve: Data(repeating: 2, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""),
        prekey: Data(repeating: 3, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""))
}
private func resultRecord(_ message: String = "result-message") throws -> DmOutboxRecord {
    let envelope = try DmEnvelope(clientMessageId: message, senderDeviceId: "alice-phone", recipientDeviceId: "bob-phone",
        wire: WireMessage(messageType: 0, body: Data([1, 2, 3]))).serialized()
    return DmOutboxRecord(ownerUserId: "alice", ownerSessionGeneration: 11, recipientUserId: "bob",
        recipientIdentityKeyId: "bob-identity", recipientIdentityGeneration: 7, serializedEnvelope: envelope)
}
private func resultFields(_ record: DmOutboxRecord, accepted: Bool = true) -> [String: Any] {
    ["ownerUserId": record.ownerUserId, "ownerSessionGeneration": record.ownerSessionGeneration,
     "recipientUserId": record.recipientUserId, "recipientIdentityKeyId": record.recipientIdentityKeyId,
     "recipientIdentityGeneration": record.recipientIdentityGeneration, "serializedEnvelope": record.serializedEnvelope,
     "accepted": accepted]
}

func runDmRelayResultProbe() throws {
    let alice = try resultIdentity("alice", "alice-phone", "alice-identity")
    let bob = try resultIdentity("bob", "bob-phone", "bob-identity")
    let owner = DmOwnerContext(userId: "bob", deviceId: "bob-phone", generation: 21)
    let peer = DmPeerContext(userId: "alice", deviceId: "alice-phone", identityKeyId: "alice-identity",
        curve: alice.curve, prekey: alice.prekey, generation: 23, status: .accepted)
    let record = try resultRecord()
    let accepted = resultFields(record)
    let receiptBytes = try resultJSON(accepted)
    let now: Int64 = 1_800_000_000

    // 1. Exact registration identity and real Boolean, not numeric bridging.
    let registration: [String: Any] = ["registered": true, "userId": "alice", "deviceId": "alice-phone"]
    try DmRelayResultCodec.registration(resultJSON(registration), expected: alice)
    for mutation in [["registered": 1], ["registered": false], ["userId": "bob"], ["deviceId": "other-phone"], ["extra": true]] as [[String: Any]] {
        try resultRefuse("registration exact shape/identity") {
            _ = try DmRelayResultCodec.registration(resultJSON(registration.merging(mutation) { _, next in next }), expected: alice)
        }
    }
    print("PASS native result registration: exact own identity, Boolean and fields")

    // 2. Claimed bundle uses a real Ed25519 signature but explicit fixture pin.
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    let signature = try signing.signature(for: DmRelayCodec.bundleSigningBytes(alice, prekeyId: "alice-prekey", expiresAt: now + 3600))
        .base64EncodedString().replacingOccurrences(of: "=", with: "")
    let bundle = try DmRelayCodec.bundleWire(alice, prekeyId: "alice-prekey", expiresAt: now + 3600, signature: signature)
    let claim: [String: Any] = ["signedBundle": bundle, "prekeyId": "alice-prekey", "prekey": alice.prekey]
    try resultRequire(try DmRelayResultCodec.claim(resultJSON(claim), pinned: alice, now: now).deviceId == "alice-phone", "claim valid signature/pin")
    try resultRefuse("claim rejects different pin") { _ = try DmRelayResultCodec.claim(resultJSON(claim), pinned: bob, now: now) }
    for mutation in [["prekeyId": "wrong"], ["prekey": bob.curve], ["signedBundle": bundle + " "], ["signedBundle": bundle.replacingOccurrences(of: "alice-prekey", with: "bad-prekey")], ["extra": true]] as [[String: Any]] {
        try resultRefuse("claim exact signed key/shape") {
            _ = try DmRelayResultCodec.claim(resultJSON(claim.merging(mutation) { _, next in next }), pinned: alice, now: now)
        }
    }
    try resultRefuse("claim expired bundle") { _ = try DmRelayResultCodec.claim(resultJSON(claim), pinned: alice, now: now + 3600) }
    print("PASS native result claim: real signature, expiry, canonical bundle and separately pinned fields")

    // 3. Accepted/refused decisions preserve the exact committed public record.
    try resultRequire(try DmRelayResultCodec.receipt(receiptBytes, expected: record) == .accepted(record), "exact accepted receipt")
    for reason in [DmRejectionReason.blocked, .deviceRevoked, .recordConflict] {
        var refusal = resultFields(record, accepted: false); refusal["reason"] = reason.rawValue
        try resultRequire(try DmRelayResultCodec.receipt(resultJSON(refusal), expected: record) == .rejected(record, reason), "exact rejected receipt")
    }
    print("PASS native result receipts: exact acceptance and all three explicit refusal reasons")

    // 4. Boolean confusion and receipt field/status combinations never settle.
    for mutation in [["accepted": 1], ["accepted": "true"], ["accepted": NSNull()], ["reason": "blocked"], ["extra": true],
                     ["accepted": false], ["accepted": false, "reason": "timeout"], ["accepted": false, "reason": 1]] as [[String: Any]] {
        try resultRefuse("receipt malformed decision remains unresolved") {
            _ = try DmRelayResultCodec.receipt(resultJSON(accepted.merging(mutation) { _, next in next }), expected: record)
        }
    }
    print("PASS native result receipts: Boolean typing, exact shape and no invented terminal reason")

    // 5. Every immutable outbox field, ciphertext framing and bytes are checked.
    let changedEnvelope = try resultRecord("different-message").serializedEnvelope
    for mutation in [["ownerUserId": "other"], ["ownerSessionGeneration": 12], ["recipientUserId": "other"],
                     ["recipientIdentityKeyId": "other-key"], ["recipientIdentityGeneration": 8],
                     ["serializedEnvelope": changedEnvelope], ["serializedEnvelope": record.serializedEnvelope + " "],
                     ["serializedEnvelope": record.serializedEnvelope.replacingOccurrences(of: "AQID", with: "AQI=")]] as [[String: Any]] {
        try resultRefuse("receipt immutable record mismatch") {
            _ = try DmRelayResultCodec.receipt(resultJSON(accepted.merging(mutation) { _, next in next }), expected: record)
        }
    }
    print("PASS native result immutable record: all fields and canonical ciphertext bytes")

    // 6. Duplicate key names, including equivalent escaped spellings, are fatal.
    let receiptText = String(decoding: receiptBytes, as: UTF8.self)
    for name in ["accepted", "\\u0061ccepted", "ownerUserId", "\\u006fwnerUserId"] {
        let duplicate = String(receiptText.dropLast()) + ",\"\(name)\":" + (name.contains("ccepted") ? "true" : "\"alice\"") + "}"
        try resultRefuse("duplicate result key") { _ = try DmRelayResultCodec.receipt(Data(duplicate.utf8), expected: record) }
    }
    let duplicateRegistration = Data("{\"registered\":true,\"registered\":true,\"userId\":\"alice\",\"deviceId\":\"alice-phone\"}".utf8)
    try resultRefuse("duplicate registration key") { try DmRelayResultCodec.registration(duplicateRegistration, expected: alice) }
    print("PASS native result duplicate keys: ordinary and escaped spellings before field extraction")

    // 7. Only lexical, safe, nonnegative integers are accepted as metadata.
    for number in ["true", "false", "-1", "-0", "01", "11.0", "11e0", "9007199254740992", "9223372036854775808"] {
        let numeric = receiptText.replacingOccurrences(of: "\"ownerSessionGeneration\":11", with: "\"ownerSessionGeneration\":\(number)")
        try resultRefuse("unsafe/noninteger metadata") { _ = try DmRelayResultCodec.receipt(Data(numeric.utf8), expected: record) }
    }
    print("PASS native result numbers: no Boolean, negative, alternate spelling, fraction, exponent or unsafe integer")

    // 8. Sender generation metadata intentionally differs from own local guards.
    var row = accepted; row["serverId"] = 4
    let rows = try DmRelayResultCodec.inbox(resultJSON([row]), owner: owner, identity: bob, peer: peer, afterId: 3, batch: 1)
    try resultRequire(rows == [DmRelayInboxRow(serverId: 4, record: record)], "inbox pinned route and sender-owned counters")
    try resultRequire(try DmRelayResultCodec.inbox(resultJSON([]), owner: owner, identity: bob, peer: peer,
        afterId: DmRelayCodec.maxSafeInteger, batch: 16).isEmpty, "empty safe cursor page")
    print("PASS native result inbox: pinned devices/users/identity, safe empty pages and independent sender counters")

    // 9. Bound pages and ordered, unique cursors/message IDs.
    var second = resultFields(try resultRecord("second-message")); second["serverId"] = 5
    try resultRequire(try DmRelayResultCodec.inbox(resultJSON([row, second]), owner: owner, identity: bob, peer: peer,
        afterId: 3, batch: 2).count == 2, "ordered valid page")
    try resultRefuse("inbox exceeds requested batch") {
        _ = try DmRelayResultCodec.inbox(resultJSON([row, second]), owner: owner, identity: bob, peer: peer, afterId: 3, batch: 1)
    }
    for page in [[second, row], [row, row]] {
        try resultRefuse("inbox unordered/equal cursor") {
            _ = try DmRelayResultCodec.inbox(resultJSON(page), owner: owner, identity: bob, peer: peer, afterId: 3, batch: 2)
        }
    }
    try resultRefuse("inbox cursor not beyond request") {
        _ = try DmRelayResultCodec.inbox(resultJSON([row]), owner: owner, identity: bob, peer: peer, afterId: 4, batch: 1)
    }
    try resultRefuse("inbox global maximum rows") {
        _ = try DmRelayResultCodec.inbox(resultJSON(Array(repeating: row, count: 17)), owner: owner, identity: bob, peer: peer, afterId: 3, batch: 16)
    }
    var duplicateMessage = row; duplicateMessage["serverId"] = 5
    try resultRefuse("inbox duplicate message ID") {
        _ = try DmRelayResultCodec.inbox(resultJSON([row, duplicateMessage]), owner: owner, identity: bob, peer: peer, afterId: 3, batch: 2)
    }
    print("PASS native result inbox bounds: page size, ascending cursors and unique message IDs")

    // 10. No result from a different user/device/key, refused record or unsafe ID.
    let alienEnvelope = try DmEnvelope(clientMessageId: "result-message", senderDeviceId: "other-phone", recipientDeviceId: "bob-phone",
        wire: WireMessage(messageType: 0, body: Data([1, 2, 3]))).serialized()
    for mutation in [["ownerUserId": "other"], ["recipientUserId": "other"], ["recipientIdentityKeyId": "other-key"],
                     ["serializedEnvelope": alienEnvelope], ["accepted": false], ["accepted": 1], ["serverId": true],
                     ["serverId": 0], ["serverId": DmRelayCodec.maxSafeInteger + 1], ["reason": "blocked"]] as [[String: Any]] {
        try resultRefuse("inbox exact pinned accepted row") {
            _ = try DmRelayResultCodec.inbox(resultJSON([row.merging(mutation) { _, next in next }]), owner: owner, identity: bob, peer: peer, afterId: 0, batch: 16)
        }
    }
    print("PASS native result inbox isolation: no cross-user/device/key, refused row or unsafe cursor")

    // 11. Local guard validation cannot be supplied by fields in the result.
    for batch in [0, 17] {
        try resultRefuse("invalid inbox batch") { _ = try DmRelayResultCodec.inbox(resultJSON([]), owner: owner, identity: bob, peer: peer, afterId: 0, batch: batch) }
    }
    for cursor in [Int64(-1), DmRelayCodec.maxSafeInteger + 1] {
        try resultRefuse("invalid inbox cursor input") { _ = try DmRelayResultCodec.inbox(resultJSON([]), owner: owner, identity: bob, peer: peer, afterId: cursor, batch: 1) }
    }
    try resultRefuse("wrong current identity") { _ = try DmRelayResultCodec.inbox(resultJSON([]), owner: owner, identity: alice, peer: peer, afterId: 0, batch: 1) }
    let blocked = DmPeerContext(userId: peer.userId, deviceId: peer.deviceId, identityKeyId: peer.identityKeyId,
        curve: peer.curve, prekey: peer.prekey, generation: peer.generation, status: .blocked)
    try resultRefuse("blocked peer") { _ = try DmRelayResultCodec.inbox(resultJSON([]), owner: owner, identity: bob, peer: blocked, afterId: 0, batch: 1) }
    print("PASS native result local guards: own identity, accepted peer, cursor and batch input")

    // 12. Entire bounded ASCII grammar, encoding, trailing data and depth checks.
    for bytes in [Data(), Data("null".utf8), Data("[]".utf8), Data(receiptText.dropLast().utf8),
                  Data((receiptText + "true").utf8), Data("{\"accepted\":truE}".utf8), Data("{\"accepted\":true,}".utf8),
                  Data("{\"accepted\":\"\\uD800\"}".utf8), Data("{\"accepted\":\"é\"}".utf8),
                  receiptText.data(using: .utf16LittleEndian)!, Data(repeating: 32, count: DmRelayResultCodec.maxResponseBytes + 1)] {
        try resultRefuse("malformed/bounded result grammar") { _ = try DmRelayResultCodec.receipt(bytes, expected: record) }
    }
    let deep = String(repeating: "{\"x\":", count: 10) + "true" + String(repeating: "}", count: 10)
    try resultRefuse("bounded result depth") { _ = try DmRelayResultCodec.receipt(Data(deep.utf8), expected: record) }
    print("PASS native result syntax: size, encoding, malformed tokens, trailing bytes and depth")
    print("PASS 12 native relay result parser fixture groups; no transport or encryption claim")
}

#if DM_RELAY_RESULT_STANDALONE
@main
private struct DmRelayResultStandaloneProbe {
    static func main() throws { try runDmRelayResultProbe() }
}
#endif
