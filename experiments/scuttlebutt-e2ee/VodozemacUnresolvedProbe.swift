// ISOLATED SYNTHETIC RESEARCH ONLY. Real pinned provider crypto and native
// sealed stores. No production directory/Auth, network, app/plugin registration,
// physical-device/crash evidence, or independent security review is established.
// Private fixture pickles/keys are inspected only inside this native probe and
// are never returned or logged. Its sole result is a checked assertion count.
import Foundation

enum DmUnresolvedProbeError: Error { case assertion(String) }

private final class DmUnresolvedChecks {
    private(set) var assertions = 0

    func require(_ condition: Bool, _ label: String) throws {
        guard condition else { throw DmUnresolvedProbeError.assertion(label) }
        assertions += 1
    }

    func coordinator(_ expected: DmCoordinatorError, _ label: String,
                     _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let actual as DmCoordinatorError {
            let matches: Bool
            switch (actual, expected) {
            case (.invalidInput, .invalidInput), (.unavailable, .unavailable),
                 (.conflict, .conflict), (.capacity, .capacity),
                 (.terminalRecord, .terminalRecord), (.unsupportedState, .unsupportedState): matches = true
            default: matches = false
            }
            try require(matches, label)
            return
        }
        // The assertion is outside the caught operation, and an unrelated
        // provider/storage failure cannot satisfy the expected refusal.
        throw DmUnresolvedProbeError.assertion(label)
    }

    func rollback(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.injectedFailure { try require(true, label); return }
        throw DmUnresolvedProbeError.assertion(label)
    }

    func staleCommit(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.staleRevision { try require(true, label); return }
        throw DmUnresolvedProbeError.assertion(label)
    }

    func framing(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmFrameError.invalidInput { try require(true, label); return }
        throw DmUnresolvedProbeError.assertion(label)
    }

    func corruptProviderState(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch NativeCryptoError.OperationFailed { try require(true, label); return }
        throw DmUnresolvedProbeError.assertion(label)
    }
}

private struct DmUnresolvedPair {
    let aliceStore: VodozemacSealedStore
    let bobStore: VodozemacSealedStore
    let alice: VodozemacDmCoordinator
    let bob: VodozemacDmCoordinator
    let aliceOwner = DmOwnerContext(userId: "unresolved-alice", deviceId: "unresolved-alice-device", generation: 11)
    let bobOwner = DmOwnerContext(userId: "unresolved-bob", deviceId: "unresolved-bob-device", generation: 21)
    let peerGeneration: Int64 = 7
}

private func unresolvedProbeStore(root: URL) throws -> VodozemacSealedStore {
    let id = UUID()
    return try VodozemacSealedStore.create(directory: root.appendingPathComponent(id.uuidString, isDirectory: true),
        storeID: id, initialPayload: Data("{}".utf8))
}

private func unresolvedProbePair(root: URL, checks: DmUnresolvedChecks,
                                 _ operation: (DmUnresolvedPair) throws -> Void) throws {
    let aliceStore = try unresolvedProbeStore(root: root)
    defer { try? aliceStore.destroyForTesting() }
    let bobStore = try unresolvedProbeStore(root: root)
    defer { try? bobStore.destroyForTesting() }
    let aliceOwner = DmOwnerContext(userId: "unresolved-alice", deviceId: "unresolved-alice-device", generation: 11)
    let bobOwner = DmOwnerContext(userId: "unresolved-bob", deviceId: "unresolved-bob-device", generation: 21)
    let alice = try VodozemacDmCoordinator.bootstrapForResearch(store: aliceStore, owner: aliceOwner,
        identityKeyId: "unresolved-alice-identity", conversationId: "unresolved-conversation")
    let bob = try VodozemacDmCoordinator.bootstrapForResearch(store: bobStore, owner: bobOwner,
        identityKeyId: "unresolved-bob-identity", conversationId: "unresolved-conversation")
    let a = try alice.publicIdentity(owner: aliceOwner), b = try bob.publicIdentity(owner: bobOwner)
    try alice.installPeerForResearch(DmPeerContext(userId: b.userId, deviceId: b.deviceId,
        identityKeyId: b.identityKeyId, curve: b.curve, prekey: b.prekey, generation: 7, status: .accepted), owner: aliceOwner)
    try bob.installPeerForResearch(DmPeerContext(userId: a.userId, deviceId: a.deviceId,
        identityKeyId: a.identityKeyId, curve: a.curve, prekey: a.prekey, generation: 7, status: .accepted), owner: bobOwner)
    try operation(DmUnresolvedPair(aliceStore: aliceStore, bobStore: bobStore, alice: alice, bob: bob))
    // Only these two known UUID namespaces are destroyed; no recursive cleanup.
    try bobStore.destroyForTesting()
    try aliceStore.destroyForTesting()
    try checks.require(!FileManager.default.fileExists(atPath: aliceStore.databaseURL.deletingLastPathComponent().path)
        && !FileManager.default.fileExists(atPath: bobStore.databaseURL.deletingLastPathComponent().path),
        "exact unresolved fixture namespaces removed")
}

private func unresolvedProbeObject(_ payload: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
        throw DmUnresolvedProbeError.assertion("sealed fixture object")
    }
    return value
}

private func unresolvedProbeProjection(_ payload: Data, excluding: Set<String> = []) throws -> Data {
    var object = try unresolvedProbeObject(payload)
    for field in excluding { object.removeValue(forKey: field) }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
}

private func unresolvedProbePoison(_ envelope: String, id: String? = nil) throws -> String {
    let frame = try DmEnvelope.decode(envelope)
    let wire = try frame.wire
    var body = wire.body
    guard !body.isEmpty else { throw DmUnresolvedProbeError.assertion("nonempty provider fixture") }
    body[body.count - 1] ^= 1 // Corrupt a real provider message/MAC, not local state.
    return try DmEnvelope(clientMessageId: id ?? frame.clientMessageId, senderDeviceId: frame.senderDeviceId,
        recipientDeviceId: frame.recipientDeviceId, wire: WireMessage(messageType: wire.messageType, body: body)).serialized()
}

private func unresolvedProbeRename(_ envelope: String, id: String) throws -> String {
    let frame = try DmEnvelope.decode(envelope)
    return try DmEnvelope(clientMessageId: id, senderDeviceId: frame.senderDeviceId,
        recipientDeviceId: frame.recipientDeviceId, wire: frame.wire).serialized()
}

private func unresolvedProbeRecord(_ record: DmOutboxRecord, envelope: String,
                                    ownerGeneration: Int64? = nil, recipientGeneration: Int64? = nil) -> DmOutboxRecord {
    DmOutboxRecord(ownerUserId: record.ownerUserId, ownerSessionGeneration: ownerGeneration ?? record.ownerSessionGeneration,
        recipientUserId: record.recipientUserId, recipientIdentityKeyId: record.recipientIdentityKeyId,
        recipientIdentityGeneration: recipientGeneration ?? record.recipientIdentityGeneration, serializedEnvelope: envelope)
}

private func unresolvedProbeStored(_ result: DmInboundSyncResult, id: String, text: String,
                                   owner: DmOwnerContext, peerGeneration: Int64, envelope: String,
                                   checks: DmUnresolvedChecks) throws {
    guard case .stored(let value) = result else { throw DmUnresolvedProbeError.assertion("new sync receive stored") }
    try checks.require(value.clientMessageId == id && value.text == text
        && value.ownerGeneration == owner.generation && value.peerGeneration == peerGeneration
        && value.serializedEnvelope.utf8.elementsEqual(envelope.utf8), "stored exact authenticated current row")
}

private func unresolvedProbeStrictStored(_ result: DmReceiveResult, id: String, text: String,
                                         checks: DmUnresolvedChecks) throws {
    guard case .stored(let value) = result else { throw DmUnresolvedProbeError.assertion("strict fresh receive stored") }
    try checks.require(value.clientMessageId == id && value.text == text, "strict authenticated fixture stored")
}

private func unresolvedProbeEstablished(_ p: DmUnresolvedPair, checks: DmUnresolvedChecks) throws {
    let opening = try p.alice.prepare(clientMessageId: "established-opening", text: "established opening",
        owner: p.aliceOwner, peerGeneration: p.peerGeneration)
    try unresolvedProbeStrictStored(p.bob.receive(opening.serializedEnvelope, owner: p.bobOwner,
        peerGeneration: p.peerGeneration), id: "established-opening", text: "established opening", checks: checks)
    let reply = try p.bob.prepare(clientMessageId: "established-reply", text: "established reply",
        owner: p.bobOwner, peerGeneration: p.peerGeneration)
    try unresolvedProbeStrictStored(p.alice.receive(reply.serializedEnvelope, owner: p.aliceOwner,
        peerGeneration: p.peerGeneration), id: "established-reply", text: "established reply", checks: checks)
}

private func unresolvedProbePreservation(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        try unresolvedProbeEstablished(p, checks: checks)
        let pending = try p.bob.pending(owner: p.bobOwner, peerGeneration: p.peerGeneration)
        let candidate = try p.alice.prepare(clientMessageId: "poison-preservation", text: "never expose poison",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let poison = try unresolvedProbePoison(candidate.serializedEnvelope)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let initial = try p.bobStore.read()
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 101, serializedEnvelope: poison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "typed provider message failure retained without plaintext")
        let queued = try p.bobStore.read()
        try checks.require(queued.revision == initial.revision + 1
            && unresolvedProbeProjection(queued.payload, excluding: ["unresolved"])
                == unresolvedProbeProjection(initial.payload, excluding: ["unresolved"]),
            "defer changes only unresolved ledger, preserving account session inbox and outbox")
        try checks.require(try p.bob.pending(owner: p.bobOwner, peerGeneration: p.peerGeneration) == pending
            && p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "poison leaves exact pending reply and one current unresolved row")
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 101, serializedEnvelope: poison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "exact current rescan skips decryption")
        try checks.require(try p.bobStore.read() == queued, "exact unresolved rescan is entirely read-only")
        try checks.require(try p.bob.retryUnresolvedForResearch(serverId: 101, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "failed explicit retry remains unresolved and exposes no plaintext")
        let retried = try p.bobStore.read()
        try checks.require(retried.revision == queued.revision + 1
            && unresolvedProbeProjection(retried.payload) == unresolvedProbeProjection(queued.payload),
            "failed retry CAS fences lifecycle while retaining exact payload")
        let successor = try p.alice.prepare(clientMessageId: "valid-after-poison", text: "valid after poison",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try unresolvedProbeStored(p.bob.receiveOrDeferForResearch(serverId: 102,
            serializedEnvelope: successor.serializedEnvelope, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch), id: "valid-after-poison",
            text: "valid after poison", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: successor.serializedEnvelope, checks: checks)
        try checks.require(try p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "a valid successor never silently discards a poison row")
    }
}

private func unresolvedProbeContentAndConflicts(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "original-opening", text: "original opening",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let renamed = try unresolvedProbeRename(opening.serializedEnvelope, id: "renamed-opening")
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let initial = try p.bobStore.read()
        try checks.framing("legacy strict receive retains authenticated-content refusal") {
            _ = try p.bob.receive(renamed, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == initial, "legacy content refusal does not consume initial one-time key")
        let record = unresolvedProbeRecord(opening, envelope: renamed)
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 201, serializedEnvelope: renamed,
            relayRecord: record, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "renamed outer ID becomes unresolved content-not-bound, not plaintext")
        let queued = try p.bobStore.read()
        try checks.require(try unresolvedProbeProjection(queued.payload, excluding: ["unresolved"])
            == unresolvedProbeProjection(initial.payload, excluding: ["unresolved"]),
            "content mismatch retains original account prekey and empty session")
        let changedCiphertext = try unresolvedProbePoison(renamed)
        for (serverID, envelope, row, label) in [
            (Int64(202), renamed, record, "same message and ciphertext cannot change server ID"),
            (Int64(201), try unresolvedProbeRename(renamed, id: "another-id"),
                unresolvedProbeRecord(record, envelope: try unresolvedProbeRename(renamed, id: "another-id")),
                "same server ID cannot change client ID"),
            (Int64(201), changedCiphertext, unresolvedProbeRecord(record, envelope: changedCiphertext),
                "same saved ID cannot change ciphertext"),
            (Int64(201), renamed, unresolvedProbeRecord(record, envelope: renamed,
                ownerGeneration: record.ownerSessionGeneration + 1), "same ciphertext cannot change remote owner generation"),
            (Int64(201), renamed, unresolvedProbeRecord(record, envelope: renamed,
                recipientGeneration: record.recipientIdentityGeneration + 1),
                "same ciphertext cannot change recipient trust generation")
        ] {
            try checks.coordinator(.conflict, label) {
                _ = try p.bob.receiveOrDeferForResearch(serverId: serverID, serializedEnvelope: envelope,
                    relayRecord: row, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
            }
            try checks.require(try p.bobStore.read() == queued, "changed queued row refusal preserves complete snapshot")
        }
        try checks.coordinator(.conflict, "saved full relay record cannot disappear during a rescan") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 201, serializedEnvelope: renamed,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.coordinator(.conflict, "strict receive cannot silently promote queued message ID") {
            _ = try p.bob.receive(renamed, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.coordinator(.conflict, "explicit retry requires a saved server row") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 999, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        for serverID in [Int64(0), Int64(9_007_199_254_740_992)] {
            try checks.coordinator(.invalidInput, "incoming server ID remains in safe positive integer range") {
                _ = try p.bob.receiveOrDeferForResearch(serverId: serverID, serializedEnvelope: opening.serializedEnvelope,
                    owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
            }
        }
        try checks.framing("malformed envelope is not a skippable provider failure") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 203, serializedEnvelope: "{}",
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        let originalFrame = try DmEnvelope.decode(opening.serializedEnvelope)
        let wrongRecipient = try DmEnvelope(clientMessageId: "wrong-device", senderDeviceId: originalFrame.senderDeviceId,
            recipientDeviceId: "another-device", wire: originalFrame.wire).serialized()
        try checks.coordinator(.conflict, "device binding failure is not deferred") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 204, serializedEnvelope: wrongRecipient,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == queued, "all framing identity and queued refusals preserve sealed state")
        try unresolvedProbeStored(p.bob.receiveOrDeferForResearch(serverId: 205,
            serializedEnvelope: opening.serializedEnvelope, relayRecord: opening, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch), id: "original-opening", text: "original opening",
            owner: p.bobOwner, peerGeneration: p.peerGeneration, envelope: opening.serializedEnvelope, checks: checks)
        try checks.require(try p.bob.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).count == 1
            && p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "valid original still consumes its available OTK once; renamed ciphertext stays separate")
        let boundOriginal = try p.bobStore.read()
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 205,
            serializedEnvelope: opening.serializedEnvelope, relayRecord: opening, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .duplicate,
            "bound committed inbox row has an exact no-plaintext duplicate")
        try checks.coordinator(.conflict, "committed inbox preserves remote owner generation metadata") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 205, serializedEnvelope: opening.serializedEnvelope,
                relayRecord: unresolvedProbeRecord(opening, envelope: opening.serializedEnvelope,
                    ownerGeneration: opening.ownerSessionGeneration + 1),
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.coordinator(.conflict, "committed inbox preserves its exact remote server ID") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 206, serializedEnvelope: opening.serializedEnvelope,
                relayRecord: opening, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == boundOriginal, "bound inbox duplicate and metadata conflicts remain read-only")
        let beforeRetry = try p.bobStore.read()
        try checks.require(try p.bob.retryUnresolvedForResearch(serverId: 201, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "renamed authenticated content cannot become valid on explicit retry")
        let afterRetry = try p.bobStore.read()
        try checks.require(afterRetry.revision == beforeRetry.revision + 1
            && unresolvedProbeProjection(afterRetry.payload) == unresolvedProbeProjection(beforeRetry.payload),
            "failed renamed retry preserves consumed valid OTK and original history")
    }
}

private func unresolvedProbeLifecycle(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "lifecycle-poison", text: "lifecycle poison",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let poison = try unresolvedProbePoison(opening.serializedEnvelope)
        let oldEpoch = try p.bob.lifecycleForResearch().credentialEpoch
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: oldEpoch) == .deferred,
            "lifecycle fixture has one current queued row")
        let refreshed = try p.bob.rotateCredentialEpochForResearch(owner: p.bobOwner)
        let refreshedSnapshot = try p.bobStore.read()
        try checks.coordinator(.unavailable, "queued rescan cannot bypass stale credential epoch") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: oldEpoch)
        }
        try checks.coordinator(.unavailable, "queued retry cannot bypass stale credential epoch") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 301, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: oldEpoch)
        }
        try checks.require(try p.bobStore.read() == refreshedSnapshot, "stale epoch refusals do not even update revision")
        let blocked = try p.bob.setPeerStatusForResearch(.blocked, owner: p.bobOwner)
        let blockedSnapshot = try p.bobStore.read()
        try checks.coordinator(.unavailable, "blocked peer cannot rescan queued ciphertext") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: blocked, credentialEpoch: refreshed.credentialEpoch)
        }
        try checks.coordinator(.unavailable, "blocked peer cannot retry queued ciphertext") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 301, owner: p.bobOwner,
                peerGeneration: blocked, credentialEpoch: refreshed.credentialEpoch)
        }
        try checks.coordinator(.unavailable, "blocked peer cannot enumerate unresolved count") {
            _ = try p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: blocked)
        }
        try checks.require(try p.bobStore.read() == blockedSnapshot, "blocked queued operations preserve exact state")
        let accepted = try p.bob.setPeerStatusForResearch(.accepted, owner: p.bobOwner)
        let acceptedSnapshot = try p.bobStore.read()
        try checks.require(accepted == p.peerGeneration + 2
            && p.bob.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: accepted, credentialEpoch: refreshed.credentialEpoch) == .historicalUnresolved,
            "reaccepted peer recognises historical queued row without plaintext or rebinding")
        try checks.require(try p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: accepted) == 0,
            "current unresolved count does not count old trust generation")
        try checks.coordinator(.unavailable, "explicit retry refuses old queued peer generation") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 301, owner: p.bobOwner,
                peerGeneration: accepted, credentialEpoch: refreshed.credentialEpoch)
        }
        try checks.require(try p.bobStore.read() == acceptedSnapshot, "historical rescan and refused retry remain read-only")
        let off = try p.bob.signOutForResearch(owner: p.bobOwner)
        let offSnapshot = try p.bobStore.read()
        try checks.coordinator(.unavailable, "signed-out owner cannot rescan old unresolved row") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
                owner: off.owner, peerGeneration: accepted, credentialEpoch: off.credentialEpoch)
        }
        try checks.coordinator(.unavailable, "signed-out owner cannot retry unresolved row") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 301, owner: off.owner,
                peerGeneration: accepted, credentialEpoch: off.credentialEpoch)
        }
        try checks.coordinator(.unavailable, "signed-out owner cannot read queue count") {
            _ = try p.bob.unresolvedCountForResearch(owner: off.owner, peerGeneration: accepted)
        }
        try checks.require(try p.bobStore.read() == offSnapshot, "sign-out authority wins without queued mutation")
        p.bobStore.close()
        let reopened = try VodozemacSealedStore.reopen(directory: p.bobStore.databaseURL.deletingLastPathComponent(),
            storeID: p.bobStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try restored.lifecycleForResearch() == off, "queued inactive lifecycle survives sealed reopen")
        let resumed = try restored.resumeOwnerForResearch(signedOut: off.owner,
            authenticatedUserId: off.owner.userId, authenticatedDeviceId: off.owner.deviceId)
        let resumedSnapshot = try reopened.read()
        try checks.require(resumed.owner.generation == p.bobOwner.generation + 2
            && restored.receiveOrDeferForResearch(serverId: 301, serializedEnvelope: poison,
                owner: resumed.owner, peerGeneration: accepted, credentialEpoch: resumed.credentialEpoch) == .historicalUnresolved,
            "same-account resume preserves historical unresolved context rather than rebinding it")
        try checks.require(try restored.unresolvedCountForResearch(owner: resumed.owner, peerGeneration: accepted) == 0
            && restored.history(owner: resumed.owner, peerGeneration: accepted).isEmpty,
            "resumed current scope exposes neither old unresolved count nor plaintext")
        try checks.coordinator(.unavailable, "explicit retry refuses saved old owner and peer generations") {
            _ = try restored.retryUnresolvedForResearch(serverId: 301, owner: resumed.owner,
                peerGeneration: accepted, credentialEpoch: resumed.credentialEpoch)
        }
        try checks.require(try reopened.read() == resumedSnapshot, "resume rescan does not rewrite original queue generations")
    }
}

private func unresolvedProbeCorruption(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "corrupt-local-opening", text: "corrupt local opening",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let original = try p.bobStore.read()
        var damaged = try unresolvedProbeObject(original.payload)
        damaged["account"] = "not-a-provider-pickle"
        _ = try p.bobStore.commit(expectedRevision: original.revision,
            payload: JSONSerialization.data(withJSONObject: damaged))
        let corruptAccount = try p.bobStore.read()
        let corrupt = try VodozemacDmCoordinator(store: p.bobStore)
        try checks.corruptProviderState("corrupt local account is fatal, not incoming-message deferral") {
            _ = try corrupt.receiveOrDeferForResearch(serverId: 401, serializedEnvelope: opening.serializedEnvelope,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == corruptAccount
            && corrupt.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 0,
            "local account failure queues nothing and preserves complete snapshot")
        // Test-only restoration of the deliberately damaged fixture; no live
        // state recovery or production anti-rollback claim is being made.
        _ = try p.bobStore.commit(expectedRevision: corruptAccount.revision, payload: original.payload)
        try unresolvedProbeStrictStored(p.bob.receive(opening.serializedEnvelope, owner: p.bobOwner,
            peerGeneration: p.peerGeneration), id: "corrupt-local-opening", text: "corrupt local opening", checks: checks)
        let successor = try p.alice.prepare(clientMessageId: "corrupt-local-successor", text: "corrupt local successor",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let healthySession = try p.bobStore.read()
        damaged = try unresolvedProbeObject(healthySession.payload)
        guard var session = damaged["session"] as? [String: Any] else {
            throw DmUnresolvedProbeError.assertion("established session fixture")
        }
        session["pickle"] = "not-a-provider-pickle"
        damaged["session"] = session
        _ = try p.bobStore.commit(expectedRevision: healthySession.revision,
            payload: JSONSerialization.data(withJSONObject: damaged))
        let corruptSession = try p.bobStore.read()
        try checks.corruptProviderState("corrupt local session is fatal, not a skippable row") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 402, serializedEnvelope: successor.serializedEnvelope,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == corruptSession
            && p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 0,
            "local session corruption does not enter unresolved ledger")
    }
}

private func unresolvedProbeCapacity(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "capacity-opening", text: "capacity opening",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        for index in 0..<16 {
            let poison = try unresolvedProbePoison(opening.serializedEnvelope, id: "queue-only-\(index)")
            try checks.require(try p.bob.receiveOrDeferForResearch(serverId: Int64(500 + index), serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
                "bounded queue retains exact poison row")
        }
        let full = try p.bobStore.read()
        try checks.require(try p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 16
            && p.bob.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).isEmpty,
            "unresolved-only store reaches sixteen without exposing plaintext")
        try checks.coordinator(.capacity, "seventeenth unresolved row is not silently evicted") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 516,
                serializedEnvelope: unresolvedProbePoison(opening.serializedEnvelope, id: "queue-overflow"),
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.coordinator(.capacity, "full unresolved queue also blocks a new valid inbox row") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 517, serializedEnvelope: opening.serializedEnvelope,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == full, "full queue failures preserve all sixteen exact rows and crypto")
        let firstPoison = try unresolvedProbePoison(opening.serializedEnvelope, id: "queue-only-0")
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 500, serializedEnvelope: firstPoison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "full queue still permits exact read-only rescan")
        try checks.require(try p.bobStore.read() == full, "capacity does not cause a rescan write")
    }
    try unresolvedProbePair(root: root, checks: checks) { p in
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        var lastEnvelope = ""
        for index in 0..<15 {
            let row = try p.alice.prepare(clientMessageId: "mixed-inbox-\(index)", text: "mixed inbox",
                owner: p.aliceOwner, peerGeneration: p.peerGeneration)
            lastEnvelope = row.serializedEnvelope
            try unresolvedProbeStored(p.bob.receiveOrDeferForResearch(serverId: Int64(600 + index),
                serializedEnvelope: row.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration,
                credentialEpoch: epoch), id: "mixed-inbox-\(index)", text: "mixed inbox", owner: p.bobOwner,
                peerGeneration: p.peerGeneration, envelope: row.serializedEnvelope, checks: checks)
        }
        let poison = try unresolvedProbePoison(lastEnvelope, id: "mixed-poison")
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 615, serializedEnvelope: poison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "fifteen inbox rows and one unresolved row fill one shared capacity")
        let full = try p.bobStore.read()
        let overflow = try p.alice.prepare(clientMessageId: "mixed-overflow", text: "mixed overflow",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try checks.coordinator(.capacity, "combined inbox and queue bound applies to valid sync receive") {
            _ = try p.bob.receiveOrDeferForResearch(serverId: 616, serializedEnvelope: overflow.serializedEnvelope,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.coordinator(.capacity, "legacy strict receive has the same shared bound") {
            _ = try p.bob.receive(overflow.serializedEnvelope, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(try p.bobStore.read() == full
            && p.bob.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).count == 15
            && p.bob.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "mixed bound preserves history and queued ciphertext without eviction")
        var invalid = try unresolvedProbeObject(full.payload)
        guard var rows = invalid["unresolved"] as? [[String: Any]] else {
            throw DmUnresolvedProbeError.assertion("unresolved fixture rows")
        }
        rows[0]["clientMessageId"] = "mixed-inbox-0"
        invalid["unresolved"] = rows
        _ = try p.bobStore.commit(expectedRevision: full.revision, payload: JSONSerialization.data(withJSONObject: invalid))
        let disjointFailure = try p.bobStore.read()
        try checks.coordinator(.unsupportedState, "sealed queue and inbox IDs must remain disjoint") {
            _ = try VodozemacDmCoordinator(store: p.bobStore)
        }
        try checks.require(try p.bobStore.read() == disjointFailure, "invalid sealed overlap never silently recreates a store")
    }
}

private func unresolvedProbeDeferTransactions(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "transaction-poison", text: "transaction poison",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let poison = try unresolvedProbePoison(opening.serializedEnvelope)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let initial = try p.bobStore.read()
        var exposed: DmInboundSyncResult?
        try checks.rollback("deferral is not returned before its sealed commit") {
            exposed = try p.bob.receiveOrDeferForResearch(serverId: 701, serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch, fault: .beforeCommit)
        }
        try checks.require(exposed == nil && p.bobStore.read() == initial,
            "deferral rollback exposes no result and preserves account OTK and ledger")
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 701, serializedEnvelope: poison,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "successful deferral commits the exact ciphertext")
        let queued = try p.bobStore.read()
        try checks.rollback("failed retry also rolls back its fencing commit") {
            _ = try p.bob.retryUnresolvedForResearch(serverId: 701, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: epoch, fault: .beforeCommit)
        }
        try checks.require(try p.bobStore.read() == queued, "failed retry rollback retains exact queued snapshot")
        var calls = 0
        var winner = queued
        let racing = try VodozemacDmCoordinator(store: p.bobStore, beforeCommitForResearch: {
            calls += 1
            _ = try p.bob.rotateCredentialEpochForResearch(owner: p.bobOwner)
            winner = try p.bobStore.read()
        })
        exposed = nil
        try checks.staleCommit("failed retry CAS refuses a competing credential refresh") {
            exposed = try racing.retryUnresolvedForResearch(serverId: 701, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(calls == 1 && exposed == nil && p.bobStore.read() == winner,
            "failed retry CAS loser retains winner epoch and exact unresolved ledger")
    }
    try unresolvedProbePair(root: root, checks: checks) { p in
        let opening = try p.alice.prepare(clientMessageId: "defer-signout-race", text: "defer signout race",
            owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let poison = try unresolvedProbePoison(opening.serializedEnvelope)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        var winner = try p.bobStore.read()
        var calls = 0
        let racing = try VodozemacDmCoordinator(store: p.bobStore, beforeCommitForResearch: {
            calls += 1
            _ = try p.bob.signOutForResearch(owner: p.bobOwner)
            winner = try p.bobStore.read()
        })
        var exposed: DmInboundSyncResult?
        try checks.staleCommit("sign-out wins CAS against prepared deferral") {
            exposed = try racing.receiveOrDeferForResearch(serverId: 702, serializedEnvelope: poison,
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(calls == 1 && exposed == nil && p.bobStore.read() == winner,
            "defer CAS loser publishes no result and preserves winning inactive snapshot")
        let state = try unresolvedProbeObject(winner.payload)
        try checks.require((state["unresolved"] as? [Any])?.isEmpty == true,
            "losing deferral neither appends ciphertext nor consumes account OTK")
    }
}

private struct DmUnresolvedGapFixture {
    let middle: String
    let late: String
}

private func unresolvedProbeGapFixture(_ p: DmUnresolvedPair, checks: DmUnresolvedChecks) throws -> DmUnresolvedGapFixture {
    try unresolvedProbeEstablished(p, checks: checks)
    let a = try p.alice.publicIdentity(owner: p.aliceOwner), b = try p.bob.publicIdentity(owner: p.bobOwner)
    let state = try unresolvedProbeObject(p.aliceStore.read().payload)
    guard let session = state["session"] as? [String: Any], let savedPickle = session["pickle"] as? String,
          let sessionID = session["id"] as? String else {
        throw DmUnresolvedProbeError.assertion("real established sender session fixture")
    }
    let key = try p.aliceStore.providerPickleKey()
    var ephemeralPickle = savedPickle
    var middle: String?, late: String?
    // Pinned vodozemac 0.11.0 receiver_chain.rs: MAX_MESSAGE_GAP = 2,000.
    // Encrypt a single forward-only private fixture branch. Positions 1,000
    // and 2,002 are retained; all others are discarded. Bob's real initial DH
    // session is kept, so receiving the middle advances it enough for the late
    // row to open. No sender counter is rolled back/reused by the coordinator:
    // Alice is never used to send again and both fixture stores are destroyed.
    for position in 0...2_002 {
        let id = "gap-position-\(position)"
        let context = DmAuthenticatedContext(conversationId: "unresolved-conversation", clientMessageId: id,
            senderUserId: a.userId, senderDeviceId: a.deviceId, recipientUserId: b.userId, recipientDeviceId: b.deviceId,
            senderIdentityKeyId: a.identityKeyId, recipientIdentityKeyId: b.identityKeyId,
            senderCurve: a.curve, recipientCurve: b.curve, sessionId: sessionID)
        let encrypted = try encrypt(sessionPickle: ephemeralPickle, pickleKey: key,
            plaintext: DmContentCodec.encode(context: context, text: "gap fixture \(position)"))
        guard encrypted.sessionId == sessionID else { throw DmUnresolvedProbeError.assertion("gap session remains pinned") }
        ephemeralPickle = encrypted.sessionPickle
        if position == 1_000 || position == 2_002 {
            let envelope = try DmEnvelope(clientMessageId: id, senderDeviceId: a.deviceId,
                recipientDeviceId: b.deviceId, wire: encrypted.wire).serialized()
            if position == 1_000 { middle = envelope } else { late = envelope }
        }
    }
    guard let middle = middle, let late = late else { throw DmUnresolvedProbeError.assertion("gap fixture retained two positions") }
    try checks.require(try DmEnvelope.decode(middle).messageType == "session"
        && DmEnvelope.decode(late).messageType == "session", "gap fixture uses established normal session messages")
    return DmUnresolvedGapFixture(middle: middle, late: late)
}

private func unresolvedProbePromotion(root: URL, checks: DmUnresolvedChecks) throws {
    try unresolvedProbePair(root: root, checks: checks) { p in
        let gap = try unresolvedProbeGapFixture(p, checks: checks)
        let bobIdentity = try p.bob.publicIdentity(owner: p.bobOwner)
        let lateRecord = DmOutboxRecord(ownerUserId: p.aliceOwner.userId,
            ownerSessionGeneration: p.aliceOwner.generation, recipientUserId: p.bobOwner.userId,
            recipientIdentityKeyId: bobIdentity.identityKeyId, recipientIdentityGeneration: p.peerGeneration,
            serializedEnvelope: gap.late)
        let epoch = try p.bob.lifecycleForResearch().credentialEpoch
        let initial = try p.bobStore.read()
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 801, serializedEnvelope: gap.late,
            relayRecord: lateRecord, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "beyond-provider-gap real session message is unresolved")
        let queued = try p.bobStore.read()
        try checks.require(try unresolvedProbeProjection(queued.payload, excluding: ["unresolved"])
            == unresolvedProbeProjection(initial.payload, excluding: ["unresolved"]),
            "too-large gap leaves real account ratchet inbox and pending reply untouched")
        try checks.require(try p.bob.retryUnresolvedForResearch(serverId: 801, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "explicit gap retry cannot invent unavailable ratchet steps")
        try unresolvedProbeStored(p.bob.receiveOrDeferForResearch(serverId: 802, serializedEnvelope: gap.middle,
            owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch), id: "gap-position-1000",
            text: "gap fixture 1000", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: gap.middle, checks: checks)
        let advanced = try p.bobStore.read()
        try checks.require(try p.bob.receiveOrDeferForResearch(serverId: 801, serializedEnvelope: gap.late,
            relayRecord: lateRecord, owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: epoch) == .deferred,
            "ordinary rescan stays deferred even after ratchet becomes capable")
        try checks.require(try p.bobStore.read() == advanced, "newly-capable rescan remains read-only")
        p.bobStore.close()
        let reopened = try VodozemacSealedStore.reopen(directory: p.bobStore.databaseURL.deletingLastPathComponent(),
            storeID: p.bobStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try reopened.read() == advanced
            && restored.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "exact queued ciphertext and advanced ratchet survive authenticated reopen")
        var winner = advanced
        var calls = 0
        let racing = try VodozemacDmCoordinator(store: reopened, beforeCommitForResearch: {
            calls += 1
            _ = try restored.rotateCredentialEpochForResearch(owner: p.bobOwner)
            winner = try reopened.read()
        })
        var exposed: DmInboundSyncResult?
        try checks.staleCommit("credential change wins CAS against successfully opened promotion") {
            exposed = try racing.retryUnresolvedForResearch(serverId: 801, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: epoch)
        }
        try checks.require(calls == 1 && exposed == nil && reopened.read() == winner,
            "promotion CAS loser exposes no plaintext and retains exact winner ledger")
        try checks.require(try restored.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).count == 2
            && restored.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 1,
            "lost promotion CAS cannot add inbox row or remove queued row")
        let currentEpoch = try restored.lifecycleForResearch().credentialEpoch
        try checks.rollback("successful decrypt cannot promote before sealed commit") {
            exposed = try restored.retryUnresolvedForResearch(serverId: 801, owner: p.bobOwner,
                peerGeneration: p.peerGeneration, credentialEpoch: currentEpoch, fault: .beforeCommit)
        }
        try checks.require(exposed == nil && reopened.read() == winner,
            "promotion rollback retains queue crypto and history without plaintext output")
        let promotion = try restored.retryUnresolvedForResearch(serverId: 801, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: currentEpoch)
        try unresolvedProbeStored(promotion, id: "gap-position-2002",
            text: "gap fixture 2002", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: gap.late, checks: checks)
        guard case .stored(let message) = promotion else { throw DmUnresolvedProbeError.assertion("promoted metadata fixture") }
        try checks.require(message.relayServerId == 801 && message.relayRecord == lateRecord,
            "promotion retains the exact saved server ID and full relay record")
        let promoted = try reopened.read()
        try checks.require(promoted.revision == winner.revision + 1
            && restored.unresolvedCountForResearch(owner: p.bobOwner, peerGeneration: p.peerGeneration) == 0
            && restored.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).count == 3,
            "explicit retry atomically promotes exact queued row with advanced ratchet")
        try checks.require(try restored.receiveOrDeferForResearch(serverId: 801, serializedEnvelope: gap.late,
            relayRecord: lateRecord, owner: p.bobOwner, peerGeneration: p.peerGeneration,
            credentialEpoch: currentEpoch) == .duplicate,
            "promoted rescan is a no-plaintext duplicate")
        try checks.coordinator(.conflict, "promoted inbox cannot change saved server ID on a rescan") {
            _ = try restored.receiveOrDeferForResearch(serverId: 803, serializedEnvelope: gap.late,
                relayRecord: lateRecord, owner: p.bobOwner, peerGeneration: p.peerGeneration,
                credentialEpoch: currentEpoch)
        }
        try checks.coordinator(.conflict, "promoted inbox cannot change saved full-record generation") {
            _ = try restored.receiveOrDeferForResearch(serverId: 801, serializedEnvelope: gap.late,
                relayRecord: unresolvedProbeRecord(lateRecord, envelope: gap.late,
                    recipientGeneration: lateRecord.recipientIdentityGeneration + 1),
                owner: p.bobOwner, peerGeneration: p.peerGeneration, credentialEpoch: currentEpoch)
        }
        guard case .duplicate = try restored.receive(gap.late, owner: p.bobOwner,
            peerGeneration: p.peerGeneration, credentialEpoch: currentEpoch) else {
            throw DmUnresolvedProbeError.assertion("strict promoted duplicate")
        }
        try checks.require(try reopened.read() == promoted, "both duplicate paths retain exact promoted snapshot")
    }
}

/// Invoked only by a disposable native research app; no sensitive value leaves.
func runUnresolvedProbeForResearch() throws -> Int {
    let checks = DmUnresolvedChecks()
    let root = FileManager.default.temporaryDirectory
    try unresolvedProbePreservation(root: root, checks: checks)
    try unresolvedProbeContentAndConflicts(root: root, checks: checks)
    try unresolvedProbeLifecycle(root: root, checks: checks)
    try unresolvedProbeCorruption(root: root, checks: checks)
    try unresolvedProbeCapacity(root: root, checks: checks)
    try unresolvedProbeDeferTransactions(root: root, checks: checks)
    try unresolvedProbePromotion(root: root, checks: checks)
    return checks.assertions
}
