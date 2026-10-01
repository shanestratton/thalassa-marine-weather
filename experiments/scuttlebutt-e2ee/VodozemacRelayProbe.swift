// Actual native Olm ciphertext through the local PostgreSQL research relay.
// Auth principals, peer pinning and relay response provenance remain fixtures;
// this is not a live Supabase/TLS or two-physical-phone test.
import Foundation
import CoreFoundation
import CryptoKit

private enum RelayFixture {
    static let alice = DmOwnerContext(userId: "11111111-1111-4111-8111-111111111111", deviceId: "relay-alice-phone", generation: 11)
    static let bob = DmOwnerContext(userId: "22222222-2222-4222-8222-222222222222", deviceId: "relay-bob-phone", generation: 21)
    static let peerGeneration: Int64 = 7
    static let opening = "native ciphertext via PostgreSQL opening"
    static let reply = "native ciphertext via PostgreSQL reply"
    static let successor = "native ciphertext via PostgreSQL successor"
}

private func relayRequire(_ condition: Bool, _ label: String) throws {
    guard condition else { throw DmCoordinatorProbeError.assertion(label) }
}

private func relayFile(_ run: UUID, _ direction: String) -> URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("relay-\(direction)-\(run.uuidString.lowercased()).json")
}

private func relayRead(_ run: UUID) throws -> [String: Any] {
    let bytes = try Data(contentsOf: relayFile(run, "input"))
    guard bytes.count <= 512 * 1024,
          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw DmCoordinatorError.invalidInput }
    return object
}

private func relayWrite(_ run: UUID, _ object: [String: Any]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    guard bytes.count <= 512 * 1024 else { throw DmCoordinatorError.invalidInput }
    try bytes.write(to: relayFile(run, "output"), options: [.atomic])
}

private func relayRecord(_ value: Any, incoming: Bool) throws -> DmOutboxRecord {
    guard var object = value as? [String: Any], let accepted = object["accepted"] as? NSNumber,
          CFGetTypeID(accepted) == CFBooleanGetTypeID(), accepted.boolValue else { throw DmCoordinatorError.invalidInput }
    let fields: Set<String> = ["ownerUserId", "ownerSessionGeneration", "recipientUserId", "recipientIdentityKeyId", "recipientIdentityGeneration", "serializedEnvelope", "accepted"]
    if incoming {
        guard Set(object.keys) == fields.union(["serverId"]),
              let id = object["serverId"] as? NSNumber, CFGetTypeID(id) != CFBooleanGetTypeID(),
              id.int64Value > 0, id.int64Value <= DmRelayCodec.maxSafeInteger,
              id.doubleValue == Double(id.int64Value) else { throw DmCoordinatorError.invalidInput }
        object.removeValue(forKey: "serverId")
    } else { guard Set(object.keys) == fields else { throw DmCoordinatorError.invalidInput } }
    object.removeValue(forKey: "accepted")
    return try JSONDecoder().decode(DmOutboxRecord.self, from: JSONSerialization.data(withJSONObject: object))
}

private func relayMessages(_ input: [String: Any]) throws -> DmOutboxRecord {
    guard let rows = input["messages"] as? [Any], rows.count == 1 else { throw DmCoordinatorError.invalidInput }
    return try relayRecord(rows[0], incoming: true)
}

private func relayStored(_ result: DmReceiveResult, text: String) throws {
    guard case .stored(let message) = result, message.text == text else { throw DmCoordinatorProbeError.assertion("relay authenticated native content") }
}

private func relayRefuse(_ operation: () throws -> Void, _ label: String) throws {
    do { try operation() }
    catch is DmCoordinatorError { return }
    catch is VodozemacSealedStoreError { return }
    throw DmCoordinatorProbeError.assertion(label)
}

// Separate store: failure probes cannot alter the exchange's participants.
private func runNativeRelaySigningProbe(root: URL, peer: DmPublicIdentity, now: Int64) throws {
    let id = UUID(), path = root.appendingPathComponent(id.uuidString)
    let owner = DmOwnerContext(userId: "signing-owner", deviceId: "aaa-signing-phone", generation: 8)
    let store = try VodozemacSealedStore.create(directory: path, storeID: id, initialPayload: Data("{}".utf8))
    defer { store.close() }
    let coordinator = try VodozemacDmCoordinator.bootstrapForResearch(store: store, owner: owner,
        identityKeyId: "signing-identity", conversationId: "signing-conversation")
    let bundle = try coordinator.signedBundleForResearch(prekeyId: "signing-prekey", expiresAt: now + 3600, now: now, owner: owner)
    let identity = try coordinator.publicIdentity(owner: owner)
    let verified = try DmRelayCodec.verifyBundle(bundle, now: now)
    try relayRequire(verified.signingKey == identity.signingKey, "native provider bundle signing identity")
    try relayRefuse({ _ = try DmRelayCodec.verifyBundle(bundle + " ", now: now) }, "native rejects noncanonical bundle")
    try relayRefuse({ _ = try DmRelayCodec.verifyBundle(bundle.replacingOccurrences(of: "signing-prekey", with: "different-prekey"), now: now) }, "native rejects tampered bundle")
    try coordinator.installPeerForResearch(DmPeerContext(userId: peer.userId, deviceId: peer.deviceId, identityKeyId: peer.identityKeyId,
        curve: peer.curve, prekey: peer.prekey, generation: 3, status: .accepted), owner: owner)
    let record = try coordinator.prepare(clientMessageId: "signed-only-pending", text: "native signing probe", owner: owner, peerGeneration: 3)
    guard var receipt = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else { throw DmCoordinatorError.invalidInput }
    receipt["accepted"] = 1
    try relayRefuse({ _ = try relayRecord(receipt, incoming: false) }, "native numeric acceptance is not a Boolean receipt")
    receipt["accepted"] = true
    receipt["serverId"] = DmRelayCodec.maxSafeInteger + 1
    try relayRefuse({ _ = try relayRecord(receipt, incoming: true) }, "native unsafe cursor is rejected")
    receipt["serverId"] = 1
    try relayRequire(try relayRecord(receipt, incoming: true) == record, "native exact Boolean and safe cursor receipt")
    let before = try store.read()
    let wire = try coordinator.signedSendForResearch(record, requestId: "signed-request", expiresAt: now + 240, now: now, owner: owner, peerGeneration: 3)
    let after = try store.read()
    let beforeState = try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: before.payload), options: [.sortedKeys])
    let afterState = try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: after.payload), options: [.sortedKeys])
    try relayRequire(beforeState == afterState && after.revision == before.revision + 1, "native signing CAS changes no ratchet/account state")
    guard let request = try JSONSerialization.jsonObject(with: Data(wire.utf8)) as? [String: Any],
          let payload = request["payload"] as? String, let signature = request["signature"] as? String else { throw DmCoordinatorError.invalidInput }
    // Independently assemble the signing array, not the production helper.
    let independent: [Any] = ["thalassa-relay-request", 1, "olm-v1", owner.userId, owner.deviceId, "send", "signed-request", now + 240, payload]
    let bytes = try JSONSerialization.data(withJSONObject: independent, options: [.withoutEscapingSlashes])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(identity.signingKey))
    try relayRequire(key.isValidSignature(try DmRelayCodec.keyBytes(signature, count: 64), for: bytes), "native exact domain signature verifies independently")
    var damaged = bytes; damaged[damaged.count - 2] ^= 1
    try relayRequire(!key.isValidSignature(try DmRelayCodec.keyBytes(signature, count: 64), for: damaged), "native signature rejects changed context")
    let wrongOwner = DmOwnerContext(userId: owner.userId, deviceId: owner.deviceId, generation: owner.generation + 1)
    try relayRefuse({ _ = try coordinator.signedListForResearch(requestId: "wrong-owner", expiresAt: now + 240, now: now, owner: wrongOwner) }, "native stale owner cannot sign")
    try relayRefuse({ _ = try coordinator.signedSendForResearch(record, requestId: "wrong-peer", expiresAt: now + 240, now: now, owner: owner, peerGeneration: 4) }, "native stale peer cannot sign")
    for expiry in [now, now + 301] {
        try relayRefuse({ _ = try coordinator.signedSendForResearch(record, requestId: "bad-time", expiresAt: expiry, now: now, owner: owner, peerGeneration: 3) }, "native invalid signature lifetime")
    }
    let forged = DmOutboxRecord(ownerUserId: record.ownerUserId, ownerSessionGeneration: record.ownerSessionGeneration,
        recipientUserId: record.recipientUserId, recipientIdentityKeyId: record.recipientIdentityKeyId,
        recipientIdentityGeneration: record.recipientIdentityGeneration + 1, serializedEnvelope: record.serializedEnvelope)
    try relayRefuse({ _ = try coordinator.signedSendForResearch(forged, requestId: "fabricated", expiresAt: now + 240, now: now, owner: owner, peerGeneration: 3) }, "native fabricated outbox cannot sign")
    try relayRequire(try store.read() == after, "native signing failures preserve snapshot")
    try coordinator.confirmAcceptance(record, owner: owner, peerGeneration: 3)
    try relayRefuse({ _ = try coordinator.signedSendForResearch(record, requestId: "terminal", expiresAt: now + 240, now: now, owner: owner, peerGeneration: 3) }, "native terminal record cannot be signed again")
    try relayRefuse({ _ = try coordinator.signedBundleForResearch(prekeyId: "republish", expiresAt: now + 3600, now: now, owner: owner) }, "native used account cannot republish one-time prekey")
    let second = try VodozemacSealedStore.reopen(directory: path, storeID: id)
    defer { second.close() }
    let competing = try VodozemacDmCoordinator(store: second)
    let raced = try VodozemacDmCoordinator(store: store, beforeCommitForResearch: {
        _ = try competing.advanceOwnerGenerationForResearch(owner: owner)
    })
    try relayRefuse({ _ = try raced.signedListForResearch(requestId: "lifecycle-race", expiresAt: now + 240, now: now, owner: owner) }, "native concurrent owner change fences signature output")
    try store.destroyForTesting()
    print("PASS native signed relay guards: domain/tamper, canonical bundle, exact pending outbox, lifetime, generations, terminal and competing-owner CAS")
}

func runNativeRelayPhase(_ phase: String, runID: UUID, aliceID: UUID, bobID: UUID) throws {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let root = documents.appendingPathComponent("relay-e2ee-research-\(runID.uuidString)")
    let ap = root.appendingPathComponent(aliceID.uuidString), bp = root.appendingPathComponent(bobID.uuidString)
    let ao = RelayFixture.alice, bo = RelayFixture.bob, generation = RelayFixture.peerGeneration
    let now = Int64(Date().timeIntervalSince1970), expires = now + 240
    if phase == "relay-prepare" {
        try relayRequire(!FileManager.default.fileExists(atPath: root.path), "relay fresh namespace")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let aStore = try VodozemacSealedStore.create(directory: ap, storeID: aliceID, initialPayload: Data("{}".utf8))
        let bStore = try VodozemacSealedStore.create(directory: bp, storeID: bobID, initialPayload: Data("{}".utf8))
        defer { aStore.close(); bStore.close() }
        let a = try VodozemacDmCoordinator.bootstrapForResearch(store: aStore, owner: ao, identityKeyId: "relay-alice-identity", conversationId: "relay-conversation")
        let b = try VodozemacDmCoordinator.bootstrapForResearch(store: bStore, owner: bo, identityKeyId: "relay-bob-identity", conversationId: "relay-conversation")
        let ab = try a.signedBundleForResearch(prekeyId: "alice-prekey-1", expiresAt: now + 3600, now: now, owner: ao)
        let bb = try b.signedBundleForResearch(prekeyId: "bob-prekey-1", expiresAt: now + 3600, now: now, owner: bo)
        let ai = try DmRelayCodec.verifyBundle(ab, now: now), bi = try DmRelayCodec.verifyBundle(bb, now: now)
        try runNativeRelaySigningProbe(root: root, peer: b.publicIdentity(owner: bo), now: now)
        // Explicit same-process identity exchange is the out-of-band pin fixture,
        // not a claim that a self-signed first key identifies a real crew member.
        try a.installPeerForResearch(DmPeerContext(userId: bi.userId, deviceId: bi.deviceId, identityKeyId: bi.identityKeyId,
            curve: bi.curveKey, prekey: bi.prekey, generation: generation, status: .accepted), owner: ao)
        try b.installPeerForResearch(DmPeerContext(userId: ai.userId, deviceId: ai.deviceId, identityKeyId: ai.identityKeyId,
            curve: ai.curveKey, prekey: ai.prekey, generation: generation, status: .accepted), owner: bo)
        try relayWrite(runID, ["aliceBundle": ab, "bobBundle": bb,
            "aliceClaim": a.signedClaimForResearch(requestId: "alice-claim", expiresAt: expires, now: now, owner: ao, peerGeneration: generation),
            "bobClaim": b.signedClaimForResearch(requestId: "bob-claim", expiresAt: expires, now: now, owner: bo, peerGeneration: generation)])
        return
    }
    let aStore = try VodozemacSealedStore.reopen(directory: ap, storeID: aliceID)
    let bStore = try VodozemacSealedStore.reopen(directory: bp, storeID: bobID)
    defer { aStore.close(); bStore.close() }
    if phase == "relay-cleanup" {
        try aStore.destroyForTesting(); try bStore.destroyForTesting()
        try relayRequire(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "relay cleanup exact empty namespace")
        try FileManager.default.removeItem(at: root)
        for direction in ["input", "output"] { try FileManager.default.removeItem(at: relayFile(runID, direction)) }
        return
    }
    let a = try VodozemacDmCoordinator(store: aStore), b = try VodozemacDmCoordinator(store: bStore)
    let input = try relayRead(runID)
    switch phase {
    case "relay-send":
        try relayRequire(Set(input.keys) == ["aliceClaim", "bobClaim"], "relay claim response shape")
        for (name, own, coordinator) in [("aliceClaim", bo, b), ("bobClaim", ao, a)] {
            guard let claim = input[name] as? [String: Any], Set(claim.keys) == ["signedBundle", "prekeyId", "prekey"],
                  let wire = claim["signedBundle"] as? String else { throw DmCoordinatorError.invalidInput }
            let bundle = try DmRelayCodec.verifyBundle(wire, now: now), pinned = try coordinator.publicIdentity(owner: own)
            try relayRequire(bundle.userId == pinned.userId && bundle.deviceId == pinned.deviceId
                && bundle.identityKeyId == pinned.identityKeyId && bundle.signingKey == pinned.signingKey
                && bundle.curveKey == pinned.curve && bundle.prekey == pinned.prekey
                && claim["prekeyId"] as? String == bundle.prekeyId && claim["prekey"] as? String == bundle.prekey,
                "relay claimed key matches explicit fixture pin")
        }
        let opening = try a.prepare(clientMessageId: "relay-opening", text: RelayFixture.opening, owner: ao, peerGeneration: generation)
        try relayWrite(runID, ["send": a.signedSendForResearch(opening, requestId: "send-opening", expiresAt: expires, now: now, owner: ao, peerGeneration: generation),
            "list": b.signedListForResearch(requestId: "bob-list-opening", expiresAt: expires, now: now, owner: bo)])
    case "relay-reply":
        try relayRequire(Set(input.keys) == ["receipt", "messages"], "relay reply input shape")
        let receipt = try relayRecord(input["receipt"] as Any, incoming: false), opening = try relayMessages(input)
        try relayRequire(receipt == opening, "relay committed receipt and recipient ciphertext agree")
        try a.confirmAcceptance(receipt, owner: ao, peerGeneration: generation)
        try relayStored(b.receive(opening.serializedEnvelope, owner: bo, peerGeneration: generation), text: RelayFixture.opening)
        let reply = try b.prepare(clientMessageId: "relay-reply", text: RelayFixture.reply, owner: bo, peerGeneration: generation)
        try relayWrite(runID, ["send": b.signedSendForResearch(reply, requestId: "send-reply", expiresAt: expires, now: now, owner: bo, peerGeneration: generation),
            "list": a.signedListForResearch(requestId: "alice-list-reply", expiresAt: expires, now: now, owner: ao)])
    case "relay-verify":
        try relayRequire(Set(input.keys) == ["receipt", "messages"], "relay verify input shape")
        let receipt = try relayRecord(input["receipt"] as Any, incoming: false), reply = try relayMessages(input)
        try relayRequire(receipt == reply, "relay reply receipt agrees")
        try b.confirmAcceptance(receipt, owner: bo, peerGeneration: generation)
        try relayStored(a.receive(reply.serializedEnvelope, owner: ao, peerGeneration: generation), text: RelayFixture.reply)
        let successor = try a.prepare(clientMessageId: "relay-successor", text: RelayFixture.successor, owner: ao, peerGeneration: generation)
        guard let rows = input["messages"] as? [[String: Any]], let deliveredId = rows.first?["serverId"] as? NSNumber else { throw DmCoordinatorError.invalidInput }
        try relayWrite(runID, ["send": a.signedSendForResearch(successor, requestId: "send-successor", expiresAt: expires, now: now, owner: ao, peerGeneration: generation),
            "list": b.signedListForResearch(requestId: "bob-list-successor", afterId: deliveredId.int64Value, expiresAt: expires, now: now, owner: bo)])
    case "relay-replay":
        try relayRequire(Set(input.keys) == ["receipt", "messages"], "relay replay input shape")
        let receipt = try relayRecord(input["receipt"] as Any, incoming: false), successor = try relayMessages(input)
        try relayRequire(receipt == successor, "relay successor receipt agrees")
        try a.confirmAcceptance(receipt, owner: ao, peerGeneration: generation)
        try relayStored(b.receive(successor.serializedEnvelope, owner: bo, peerGeneration: generation), text: RelayFixture.successor)
        let before = try bStore.read()
        try relayRequire(try b.receive(successor.serializedEnvelope, owner: bo, peerGeneration: generation) == .duplicate,
                         "relay delivered duplicate reveals no plaintext")
        try relayRequire(try bStore.read() == before, "relay duplicate preserves sealed ratchet")
        try relayRequire(try a.pending(owner: ao, peerGeneration: generation).isEmpty && b.pending(owner: bo, peerGeneration: generation).isEmpty,
                         "relay actual committed server receipts survive restart")
        let ah = try a.history(owner: ao, peerGeneration: generation), bh = try b.history(owner: bo, peerGeneration: generation)
        try relayRequire(ah.map(\.text) == [RelayFixture.reply] && bh.map(\.text) == [RelayFixture.opening, RelayFixture.successor],
                         "relay native-only authenticated histories")
    default: throw DmCoordinatorError.invalidInput
    }
}
