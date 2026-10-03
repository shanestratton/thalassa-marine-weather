// ISOLATED NATIVE FIXTURES. No app plugin, real Auth, server dispatch or audit.
// Uses real provider signatures and sealed Keychain snapshots. These checks do
// not establish live relay behavior or physical-device evidence.
import Foundation
import CryptoKit

private enum EnrollmentIntentProbeError: Error { case assertion(String) }
private final class EnrollmentIntentChecks {
    private(set) var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw EnrollmentIntentProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch is DmCoordinatorError { assertions += 1; return }
        throw EnrollmentIntentProbeError.assertion(label)
    }
    func stale(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.staleRevision { assertions += 1; return }
        throw EnrollmentIntentProbeError.assertion(label)
    }
}

private struct EnrollmentIntentPair {
    let aliceStore: VodozemacSealedStore
    let bobStore: VodozemacSealedStore
    let alice: VodozemacDmCoordinator
    let bob: VodozemacDmCoordinator
    let aliceOwner = DmOwnerContext(userId: "enrollment-alice", deviceId: "alice-device", generation: 11)
    let bobOwner = DmOwnerContext(userId: "enrollment-bob", deviceId: "bob-device", generation: 21)
    let peerGeneration: Int64 = 7
}

private func enrollmentIntentPair(root: URL, _ operation: (EnrollmentIntentPair) throws -> Void) throws {
    let aid = UUID(), bid = UUID()
    let asw = try VodozemacSealedStore.create(directory: root.appendingPathComponent(aid.uuidString),
        storeID: aid, initialPayload: Data("{}".utf8))
    defer { try? asw.destroyForTesting() }
    let bsw = try VodozemacSealedStore.create(directory: root.appendingPathComponent(bid.uuidString),
        storeID: bid, initialPayload: Data("{}".utf8))
    defer { try? bsw.destroyForTesting() }
    let ao = DmOwnerContext(userId: "enrollment-alice", deviceId: "alice-device", generation: 11)
    let bo = DmOwnerContext(userId: "enrollment-bob", deviceId: "bob-device", generation: 21)
    let a = try VodozemacDmCoordinator.bootstrapForResearch(store: asw, owner: ao,
        identityKeyId: "enrollment-alice-key", conversationId: "enrollment-intent-conversation")
    let b = try VodozemacDmCoordinator.bootstrapForResearch(store: bsw, owner: bo,
        identityKeyId: "enrollment-bob-key", conversationId: "enrollment-intent-conversation")
    let ai = try a.publicIdentity(owner: ao), bi = try b.publicIdentity(owner: bo)
    try a.installPeerForResearch(DmPeerContext(userId: bi.userId, deviceId: bi.deviceId,
        identityKeyId: bi.identityKeyId, curve: bi.curve, prekey: bi.prekey,
        generation: 7, status: .accepted), owner: ao)
    try b.installPeerForResearch(DmPeerContext(userId: ai.userId, deviceId: ai.deviceId,
        identityKeyId: ai.identityKeyId, curve: ai.curve, prekey: ai.prekey,
        generation: 7, status: .accepted), owner: bo)
    try operation(EnrollmentIntentPair(aliceStore: asw, bobStore: bsw, alice: a, bob: b))
}

// Compared only inside native fixtures; keys/pickles never appear in output.
private func enrollmentCryptoBytes(_ store: VodozemacSealedStore) throws -> Data {
    guard let fields = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any] else {
        throw EnrollmentIntentProbeError.assertion("native fixture snapshot")
    }
    var selected: [String: Any] = [:]
    for name in ["account", "session", "signingKey", "curve", "prekey", "identityKeyId"] {
        selected[name] = fields[name] ?? NSNull()
    }
    return try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys])
}

private func enrollmentWithoutIntentMetadata(_ store: VodozemacSealedStore) throws {
    let snapshot = try store.read()
    guard var fields = try JSONSerialization.jsonObject(with: snapshot.payload) as? [String: Any] else {
        throw EnrollmentIntentProbeError.assertion("legacy native fixture snapshot")
    }
    fields.removeValue(forKey: "registrationIntent"); fields.removeValue(forKey: "claimIntent")
    _ = try store.commit(expectedRevision: snapshot.revision,
        payload: JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]))
}

private struct EnrollmentClaimWire: Decodable {
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

private func enrollmentClaim(_ wire: String, owner: DmOwnerContext, identity: DmPublicIdentity,
                             requestId: String, claimId: String, peer: DmPublicIdentity,
                             checks: EnrollmentIntentChecks) throws {
    let value = try JSONDecoder().decode(EnrollmentClaimWire.self, from: Data(wire.utf8))
    try checks.require(value.version == 1 && value.protocolName == "olm-v1" && value.action == "claim"
        && value.userId == owner.userId && value.deviceId == owner.deviceId
        && value.requestId == requestId, "fresh signed outer claim nonce")
    let payload = try JSONSerialization.jsonObject(with: Data(value.payload.utf8)) as? [String]
    try checks.require(payload == [peer.userId, peer.deviceId, claimId], "stable sealed prekey reservation in payload")
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(identity.signingKey))
    try checks.require(key.isValidSignature(try DmRelayCodec.keyBytes(value.signature, count: 64),
        for: try DmRelayCodec.requestSigningBytes(owner: owner, action: value.action, requestId: value.requestId,
            expiresAt: value.expiresAt, payload: value.payload)), "retry claim retains valid provider signature")
}

/// Root's guarded research runner may call this. No runner changes in this file.
func runDmEnrollmentIntentProbe(root: URL) throws -> Int {
    let checks = EnrollmentIntentChecks(), now: Int64 = 1_800_000_000
    try enrollmentIntentPair(root: root) { p in
        let epoch = try p.alice.lifecycleForResearch().credentialEpoch
        let crypto = try enrollmentCryptoBytes(p.aliceStore)
        let first = try p.alice.signedBundleForResearch(prekeyId: "enrollment-prekey",
            expiresAt: now + 3600, now: now, owner: p.aliceOwner, credentialEpoch: epoch)
        try checks.require(try p.alice.savedRegistrationBundleForResearch(owner: p.aliceOwner,
            credentialEpoch: epoch).utf8.elementsEqual(first.utf8), "registration intent saved before wire return")
        try checks.require(try enrollmentCryptoBytes(p.aliceStore) == crypto, "registration intent preserves provider account")
        let committed = try p.aliceStore.read()
        try checks.refuses("registration cannot silently extend expiry") {
            _ = try p.alice.signedBundleForResearch(prekeyId: "enrollment-prekey",
                expiresAt: now + 3601, now: now, owner: p.aliceOwner, credentialEpoch: epoch)
        }
        try checks.refuses("registration cannot silently replace prekey ID") {
            _ = try p.alice.signedBundleForResearch(prekeyId: "enrollment-replacement",
                expiresAt: now + 3600, now: now, owner: p.aliceOwner, credentialEpoch: epoch)
        }
        try checks.require(try p.aliceStore.read() == committed, "incompatible registration retries preserve snapshot")
        p.aliceStore.close()
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try restored.savedRegistrationBundleForResearch(owner: p.aliceOwner,
            credentialEpoch: epoch).utf8.elementsEqual(first.utf8), "reopen recovers byte-identical registration")
        try checks.require(try restored.signedBundleForResearch(prekeyId: "enrollment-prekey",
            expiresAt: now + 3600, now: now + 3601, owner: p.aliceOwner,
            credentialEpoch: epoch).utf8.elementsEqual(first.utf8), "expired replay does not renew bundle")
    }
    // A responder has actually consumed its OTK before this exact replay.
    try enrollmentIntentPair(root: root) { p in
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let first = try p.bob.signedBundleForResearch(prekeyId: "consumed-prekey",
            expiresAt: now + 3600, now: now, owner: p.bobOwner, credentialEpoch: epoch)
        let opening = try p.alice.prepare(clientMessageId: "enrollment-opening", text: "fixture opening",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        _ = try p.bob.receive(opening.serializedEnvelope, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        let crypto = try enrollmentCryptoBytes(p.bobStore)
        try checks.require(try p.bob.signedBundleForResearch(prekeyId: "consumed-prekey",
            expiresAt: now + 3600, now: now + 10, owner: p.bobOwner,
            credentialEpoch: epoch).utf8.elementsEqual(first.utf8), "used account only replays original registration")
        try checks.require(try enrollmentCryptoBytes(p.bobStore) == crypto, "replay preserves consumed account and ratchet")
    }
    // A lost claim reply can cross its first nonce expiry, reopen and renew Auth.
    try enrollmentIntentPair(root: root) { p in
        let ai = try p.alice.publicIdentity(owner: p.aliceOwner), bi = try p.bob.publicIdentity(owner: p.bobOwner)
        let epoch = try p.alice.lifecycleForResearch().credentialEpoch
        let first = try p.alice.signedClaimForResearch(requestId: "claim-http-first", expiresAt: now + 60, now: now,
            owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch, claimId: "stable-prekey-claim")
        try enrollmentClaim(first, owner: p.aliceOwner, identity: ai, requestId: "claim-http-first",
            claimId: "stable-prekey-claim", peer: bi, checks: checks)
        let committed = try p.aliceStore.read(), crypto = try enrollmentCryptoBytes(p.aliceStore)
        try checks.refuses("claim cannot replace sealed reservation") {
            _ = try p.alice.signedClaimForResearch(requestId: "claim-http-bad", expiresAt: now + 60, now: now,
                owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch, claimId: "different-claim")
        }
        try checks.require(try p.aliceStore.read() == committed, "incompatible claim preserves snapshot")
        p.aliceStore.close()
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        let retry = try restored.signedClaimForResearch(requestId: "claim-http-retry", expiresAt: now + 660, now: now + 600,
            owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        try enrollmentClaim(retry, owner: p.aliceOwner, identity: ai, requestId: "claim-http-retry",
            claimId: "stable-prekey-claim", peer: bi, checks: checks)
        let renewed = try restored.rotateCredentialEpochForResearch(owner: p.aliceOwner)
        let beforeStale = try reopened.read()
        try checks.refuses("stale epoch cannot sign claim retry") {
            _ = try restored.signedClaimForResearch(requestId: "claim-stale", expiresAt: now + 660, now: now + 600,
                owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try reopened.read() == beforeStale, "stale epoch leaves sealed claim intact")
        let fresh = try restored.signedClaimForResearch(requestId: "claim-http-renewed", expiresAt: now + 660, now: now + 600,
            owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: renewed.credentialEpoch)
        try enrollmentClaim(fresh, owner: p.aliceOwner, identity: ai, requestId: "claim-http-renewed",
            claimId: "stable-prekey-claim", peer: bi, checks: checks)
        try checks.require(try enrollmentCryptoBytes(reopened) == crypto, "claim retries never advance crypto")
        _ = try restored.setPeerStatusForResearch(.blocked, owner: p.aliceOwner)
        let generation = try restored.setPeerStatusForResearch(.accepted, owner: p.aliceOwner)
        let beforePeer = try reopened.read()
        try checks.refuses("claim cannot rebind after peer generation change") {
            _ = try restored.signedClaimForResearch(requestId: "claim-rebound", expiresAt: now + 660, now: now + 600,
                owner: p.aliceOwner, peerGeneration: generation, credentialEpoch: renewed.credentialEpoch)
        }
        try checks.require(try reopened.read() == beforePeer, "peer refusal preserves historical claim")
    }
    try enrollmentIntentPair(root: root) { p in
        let epoch = try p.alice.lifecycleForResearch().credentialEpoch
        _ = try p.alice.signedClaimForResearch(requestId: "legacy-first", expiresAt: now + 60, now: now,
            owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        let retry = try p.alice.signedClaimForResearch(requestId: "legacy-retry", expiresAt: now + 660, now: now + 600,
            owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        try enrollmentClaim(retry, owner: p.aliceOwner, identity: p.alice.publicIdentity(owner: p.aliceOwner),
            requestId: "legacy-retry", claimId: "legacy-first", peer: p.bob.publicIdentity(owner: p.bobOwner), checks: checks)
        _ = try p.alice.advanceOwnerGenerationForResearch(owner: p.aliceOwner)
        let latest = try p.alice.lifecycleForResearch(), beforeOwner = try p.aliceStore.read()
        try checks.refuses("claim cannot rebind after owner generation change") {
            _ = try p.alice.signedClaimForResearch(requestId: "owner-rebound", expiresAt: now + 660, now: now + 600,
                owner: latest.owner, peerGeneration: p.peerGeneration, credentialEpoch: latest.credentialEpoch)
        }
        try checks.require(try p.aliceStore.read() == beforeOwner, "owner refusal preserves historical claim")
    }
    // An old used snapshot may lack intent metadata; this is not enrollment.
    try enrollmentIntentPair(root: root) { p in
        _ = try p.alice.prepare(clientMessageId: "legacy-used", text: "fixture used account",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try enrollmentWithoutIntentMetadata(p.aliceStore)
        let legacy = try VodozemacDmCoordinator(store: p.aliceStore)
        let epoch = try legacy.lifecycleForResearch().credentialEpoch, before = try p.aliceStore.read()
        try checks.refuses("legacy used account cannot create replacement registration") {
            _ = try legacy.signedBundleForResearch(prekeyId: "legacy-replacement", expiresAt: now + 3600, now: now,
                owner: p.aliceOwner, credentialEpoch: epoch)
        }
        try checks.refuses("legacy account cannot recover nonexistent registration intent") {
            _ = try legacy.savedRegistrationBundleForResearch(owner: p.aliceOwner, credentialEpoch: epoch)
        }
        try checks.refuses("legacy used account cannot recreate claim reservation") {
            _ = try legacy.signedClaimForResearch(requestId: "legacy-new-claim", expiresAt: now + 60, now: now,
                owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.aliceStore.read() == before, "legacy refusals preserve identity and ciphertext")
    }
    for registration in [true, false] {
        try enrollmentIntentPair(root: root) { p in
            let epoch = try p.alice.lifecycleForResearch().credentialEpoch
            let crypto = try enrollmentCryptoBytes(p.aliceStore)
            var competed = false
            let stale = try VodozemacDmCoordinator(store: p.aliceStore, beforeCommitForResearch: {
                guard !competed else { return }
                competed = true
                _ = try p.alice.rotateCredentialEpochForResearch(owner: p.aliceOwner)
            })
            try checks.stale("enrollment output waits for guarded sealed CAS") {
                if registration {
                    _ = try stale.signedBundleForResearch(prekeyId: "cas-prekey", expiresAt: now + 3600, now: now,
                        owner: p.aliceOwner, credentialEpoch: epoch)
                } else {
                    _ = try stale.signedClaimForResearch(requestId: "cas-claim", expiresAt: now + 60, now: now,
                        owner: p.aliceOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
                }
            }
            let fields = try JSONSerialization.jsonObject(with: p.aliceStore.read().payload) as? [String: Any]
            try checks.require(competed && fields?["registrationIntent"] == nil && fields?["claimIntent"] == nil,
                "obsolete enrollment cannot commit intent metadata")
            try checks.require(try enrollmentCryptoBytes(p.aliceStore) == crypto, "CAS refusal preserves crypto")
        }
    }
    return checks.assertions
}
