// ISOLATED SYNTHETIC RESEARCH ONLY. No app/plugin registration or network.
// These checks exercise real provider bytes and sealed storage, with explicitly
// pinned fixture identities. They do not authenticate a production directory or
// server receipt and are not physical-device/crash/security-audit evidence.
import Foundation

enum DmCoordinatorProbeError: Error { case assertion(String) }

private final class DmProbeChecks {
    private(set) var assertions = 0

    func require(_ condition: Bool, _ label: String) throws {
        guard condition else { throw DmCoordinatorProbeError.assertion(label) }
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
        // Outside the do/catch: an assertion cannot satisfy its own refusal.
        throw DmCoordinatorProbeError.assertion(label)
    }

    func rollback(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as VodozemacSealedStoreError {
            try require(error == .injectedFailure, label)
            return
        }
        throw DmCoordinatorProbeError.assertion(label)
    }

    func staleRevision(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as VodozemacSealedStoreError {
            try require(error == .staleRevision, label)
            return
        }
        throw DmCoordinatorProbeError.assertion(label)
    }

    func contextRefusal(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmFrameError.invalidInput { try require(true, label); return }
        throw DmCoordinatorProbeError.assertion(label)
    }
}

private struct DmProbePair {
    let aliceStore: VodozemacSealedStore
    let bobStore: VodozemacSealedStore
    let alice: VodozemacDmCoordinator
    let bob: VodozemacDmCoordinator
    let aliceOwner = DmOwnerContext(userId: "alice", deviceId: "alice-device", generation: 11)
    let bobOwner = DmOwnerContext(userId: "bob", deviceId: "bob-device", generation: 21)
    let peerGeneration: Int64 = 7
}

private func dmProbeStore(root: URL) throws -> VodozemacSealedStore {
    let id = UUID()
    return try VodozemacSealedStore.create(directory: root.appendingPathComponent(id.uuidString),
                                         storeID: id, initialPayload: Data("{}".utf8))
}

private func dmProbePair(root: URL, _ operation: (DmProbePair) throws -> Void) throws {
    let aliceStore = try dmProbeStore(root: root)
    defer { try? aliceStore.destroyForTesting() }
    let bobStore = try dmProbeStore(root: root)
    defer { try? bobStore.destroyForTesting() }
    let aliceOwner = DmOwnerContext(userId: "alice", deviceId: "alice-device", generation: 11)
    let bobOwner = DmOwnerContext(userId: "bob", deviceId: "bob-device", generation: 21)
    let alice = try VodozemacDmCoordinator.bootstrapForResearch(store: aliceStore, owner: aliceOwner,
        identityKeyId: "alice-identity", conversationId: "synthetic-conversation")
    let bob = try VodozemacDmCoordinator.bootstrapForResearch(store: bobStore, owner: bobOwner,
        identityKeyId: "bob-identity", conversationId: "synthetic-conversation")
    let a = try alice.publicIdentity(owner: aliceOwner)
    let b = try bob.publicIdentity(owner: bobOwner)
    try alice.installPeerForResearch(DmPeerContext(userId: b.userId, deviceId: b.deviceId,
        identityKeyId: b.identityKeyId, curve: b.curve, prekey: b.prekey, generation: 7, status: .accepted), owner: aliceOwner)
    try bob.installPeerForResearch(DmPeerContext(userId: a.userId, deviceId: a.deviceId,
        identityKeyId: a.identityKeyId, curve: a.curve, prekey: a.prekey, generation: 7, status: .accepted), owner: bobOwner)
    try operation(DmProbePair(aliceStore: aliceStore, bobStore: bobStore, alice: alice, bob: bob))
}

private func dmProbeStored(_ result: DmReceiveResult, text: String, id: String,
                           owner: DmOwnerContext, peerGeneration: Int64,
                           envelope: String, checks: DmProbeChecks) throws {
    guard case .stored(let message) = result else { throw DmCoordinatorProbeError.assertion("new receive stored") }
    try checks.require(message.text == text && message.clientMessageId == id
        && message.ownerGeneration == owner.generation && message.peerGeneration == peerGeneration
        && message.serializedEnvelope == envelope, "stored plaintext and exact context")
}

private func dmProbeDuplicate(_ result: DmReceiveResult, checks: DmProbeChecks) throws {
    guard case .duplicate = result else { throw DmCoordinatorProbeError.assertion("receive duplicate has no plaintext") }
    try checks.require(true, "receive duplicate has no plaintext")
}

private func dmProbeSame(_ a: DmOutboxRecord, _ b: DmOutboxRecord) -> Bool {
    a.ownerUserId == b.ownerUserId && a.ownerSessionGeneration == b.ownerSessionGeneration
        && a.recipientUserId == b.recipientUserId && a.recipientIdentityKeyId == b.recipientIdentityKeyId
        && a.recipientIdentityGeneration == b.recipientIdentityGeneration
        && Data(a.serializedEnvelope.utf8) == Data(b.serializedEnvelope.utf8)
}

/// Called only by the disposable native research app's replay phase.
func runDmCoordinatorProbe(root: URL) throws -> Int {
    let checks = DmProbeChecks()

    // Failed prepare is rollback-safe; same-ID retry returns the committed bytes.
    try dmProbePair(root: root) { p in
        let responderInitial = try p.bobStore.read()
        try checks.coordinator(.unavailable, "responder cannot initiate the single research session") {
            _ = try p.bob.prepare(clientMessageId: "responder-first", text: "too early", owner: p.bobOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.bobStore.read() == responderInitial, "responder-first refusal preserves complete snapshot")
        let initial = try p.aliceStore.read()
        try checks.rollback("prepare injected rollback") {
            _ = try p.alice.prepare(clientMessageId: "opening", text: "opening text", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration, fault: .beforeCommit)
        }
        try checks.require(try p.aliceStore.read() == initial, "prepare rollback preserves complete snapshot")
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration).isEmpty,
            "prepare rollback exposes no pending output")
        let opening = try p.alice.prepare(clientMessageId: "opening", text: "opening text", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        try checks.require(try DmEnvelope.decode(opening.serializedEnvelope).messageType == "prekey", "opening uses prekey")
        let committed = try p.aliceStore.read()
        let retry = try p.alice.prepare(clientMessageId: "opening", text: "opening text", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        try checks.require(dmProbeSame(opening, retry), "prepare retry exact record")
        try checks.require(try p.aliceStore.read() == committed, "prepare retry does not advance ratchet")
        try checks.coordinator(.conflict, "changed body same ID conflicts") {
            _ = try p.alice.prepare(clientMessageId: "opening", text: "different text", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.aliceStore.read() == committed, "prepare conflict preserves state")
        p.aliceStore.close()
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        let pending = try restored.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try checks.require(pending.count == 1 && dmProbeSame(pending[0], opening), "reopen exact pending ciphertext")
        let afterReopen = try restored.prepare(clientMessageId: "opening", text: "opening text", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        try checks.require(dmProbeSame(afterReopen, opening), "reopen prepare exact retry")
        try dmProbeStored(p.bob.receive(opening.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration),
            text: "opening text", id: "opening", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: opening.serializedEnvelope, checks: checks)
        let reply = try p.bob.prepare(clientMessageId: "reply", text: "reply text", owner: p.bobOwner,
            peerGeneration: p.peerGeneration)
        try checks.require(try DmEnvelope.decode(reply.serializedEnvelope).messageType == "session", "reply uses normal session")
        try dmProbeStored(restored.receive(reply.serializedEnvelope, owner: p.aliceOwner, peerGeneration: p.peerGeneration),
            text: "reply text", id: "reply", owner: p.aliceOwner, peerGeneration: p.peerGeneration,
            envelope: reply.serializedEnvelope, checks: checks)
    }

    // Initial prekey receive faults and authenticated-context failures cannot
    // consume a key. Repeated prekey messages use the existing pinned session.
    try dmProbePair(root: root) { p in
        let one = try p.alice.prepare(clientMessageId: "one", text: "one", owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let two = try p.alice.prepare(clientMessageId: "two", text: "two", owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try checks.require(try DmEnvelope.decode(two.serializedEnvelope).messageType == "prekey", "second send still prekey")
        let initial = try p.bobStore.read()
        try checks.rollback("receive injected rollback") {
            _ = try p.bob.receive(one.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration, fault: .beforeCommit)
        }
        try checks.require(try p.bobStore.read() == initial, "receive rollback preserves account prekey and session")
        let originalFrame = try DmEnvelope.decode(one.serializedEnvelope)
        let renamed = try DmEnvelope(clientMessageId: "substituted-id", senderDeviceId: originalFrame.senderDeviceId,
            recipientDeviceId: originalFrame.recipientDeviceId, wire: originalFrame.wire).serialized()
        try checks.contextRefusal("outer ID substitution refused") {
            _ = try p.bob.receive(renamed, owner: p.bobOwner, peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.bobStore.read() == initial, "context refusal leaves prekey available")
        try dmProbeStored(p.bob.receive(one.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration),
            text: "one", id: "one", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: one.serializedEnvelope, checks: checks)
        try dmProbeStored(p.bob.receive(two.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration),
            text: "two", id: "two", owner: p.bobOwner, peerGeneration: p.peerGeneration,
            envelope: two.serializedEnvelope, checks: checks)
        let received = try p.bobStore.read()
        try dmProbeDuplicate(p.bob.receive(one.serializedEnvelope, owner: p.bobOwner, peerGeneration: p.peerGeneration), checks: checks)
        try checks.require(try p.bobStore.read() == received, "duplicate does not advance state")
        let conflicting = try DmEnvelope(clientMessageId: "one", senderDeviceId: originalFrame.senderDeviceId,
            recipientDeviceId: originalFrame.recipientDeviceId, wire: DmEnvelope.decode(two.serializedEnvelope).wire).serialized()
        try checks.coordinator(.conflict, "same received ID different ciphertext conflicts") {
            _ = try p.bob.receive(conflicting, owner: p.bobOwner, peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.bobStore.read() == received, "receive conflict preserves state")
        try checks.require(try p.bob.history(owner: p.bobOwner, peerGeneration: p.peerGeneration).count == 2,
            "history contains exactly committed receives")
        let staleOwner = DmOwnerContext(userId: p.bobOwner.userId, deviceId: p.bobOwner.deviceId,
            generation: p.bobOwner.generation + 1)
        try checks.coordinator(.unavailable, "duplicate cannot bypass owner guard") {
            _ = try p.bob.receive(one.serializedEnvelope, owner: staleOwner, peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.bobStore.read() == received, "stale duplicate owner leaves state unchanged")
        let blocked = try p.bob.setPeerStatusForResearch(.blocked, owner: p.bobOwner)
        try checks.require(blocked == p.peerGeneration + 1, "receive block advances trust generation")
        let blockedState = try p.bobStore.read()
        try checks.coordinator(.unavailable, "duplicate cannot bypass blocked peer") {
            _ = try p.bob.receive(one.serializedEnvelope, owner: p.bobOwner, peerGeneration: blocked)
        }
        try checks.coordinator(.unavailable, "blocked peer cannot expose history") {
            _ = try p.bob.history(owner: p.bobOwner, peerGeneration: blocked)
        }
        try checks.require(try p.bobStore.read() == blockedState, "blocked duplicate leaves state unchanged")
    }

    // A fixture receipt is trusted input here, not evidence of server auth.
    try dmProbePair(root: root) { p in
        let accepted = try p.alice.prepare(clientMessageId: "acceptedK", text: "accepted", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        let rejected = try p.alice.prepare(clientMessageId: "rejected", text: "rejected", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        let before = try p.aliceStore.read()
        try checks.rollback("acceptance receipt rollback") {
            try p.alice.confirmAcceptance(accepted, owner: p.aliceOwner, peerGeneration: p.peerGeneration, fault: .beforeCommit)
        }
        try checks.require(try p.aliceStore.read() == before, "failed acceptance leaves record pending")
        // Swift String equality treats ASCII K and U+212A KELVIN SIGN as
        // canonically equivalent. An exact receipt must compare validated bytes.
        let equivalent = DmOutboxRecord(ownerUserId: accepted.ownerUserId,
            ownerSessionGeneration: accepted.ownerSessionGeneration, recipientUserId: accepted.recipientUserId,
            recipientIdentityKeyId: accepted.recipientIdentityKeyId,
            recipientIdentityGeneration: accepted.recipientIdentityGeneration,
            serializedEnvelope: accepted.serializedEnvelope.replacingOccurrences(of: "acceptedK", with: "accepted\u{212A}"))
        try checks.require(equivalent.serializedEnvelope == accepted.serializedEnvelope
            && Data(equivalent.serializedEnvelope.utf8) != Data(accepted.serializedEnvelope.utf8),
            "receipt fixture canonically equivalent but byte-distinct")
        try checks.contextRefusal("Unicode-equivalent acceptance receipt rejected by framing") {
            try p.alice.confirmAcceptance(equivalent, owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.aliceStore.read() == before, "malformed acceptance receipt preserves pending snapshot")
        try checks.contextRefusal("Unicode-equivalent rejection receipt rejected by framing") {
            try p.alice.confirmRejection(equivalent, reason: .blocked, owner: p.aliceOwner)
        }
        try checks.require(try p.aliceStore.read() == before, "malformed rejection receipt preserves pending snapshot")
        let mismatch = DmOutboxRecord(ownerUserId: accepted.ownerUserId, ownerSessionGeneration: accepted.ownerSessionGeneration,
            recipientUserId: accepted.recipientUserId, recipientIdentityKeyId: "another-identity",
            recipientIdentityGeneration: accepted.recipientIdentityGeneration, serializedEnvelope: accepted.serializedEnvelope)
        try checks.coordinator(.conflict, "acceptance compares complete record") {
            try p.alice.confirmAcceptance(mismatch, owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        }
        try p.alice.confirmAcceptance(accepted, owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let committedAcceptance = try p.aliceStore.read()
        try p.alice.confirmAcceptance(accepted, owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        try checks.require(try p.aliceStore.read() == committedAcceptance, "acceptance receipt idempotent")
        try checks.coordinator(.conflict, "accepted record cannot become rejected") {
            try p.alice.confirmRejection(accepted, reason: .blocked, owner: p.aliceOwner)
        }
        try checks.coordinator(.terminalRecord, "accepted record cannot prepare again") {
            _ = try p.alice.prepare(clientMessageId: "acceptedK", text: "accepted", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.rollback("rejection receipt rollback") {
            try p.alice.confirmRejection(rejected, reason: .blocked, owner: p.aliceOwner, fault: .beforeCommit)
        }
        try checks.require(try p.aliceStore.read() == committedAcceptance, "failed rejection leaves record pending")
        try p.alice.confirmRejection(rejected, reason: .blocked, owner: p.aliceOwner)
        let committedRejection = try p.aliceStore.read()
        try p.alice.confirmRejection(rejected, reason: .blocked, owner: p.aliceOwner)
        try checks.require(try p.aliceStore.read() == committedRejection, "rejection receipt idempotent")
        try checks.coordinator(.conflict, "rejected record cannot become accepted") {
            try p.alice.confirmAcceptance(rejected, owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        }
        try checks.coordinator(.conflict, "terminal rejection reason immutable") {
            try p.alice.confirmRejection(rejected, reason: .deviceRevoked, owner: p.aliceOwner)
        }
        try checks.coordinator(.terminalRecord, "rejected record cannot prepare again") {
            _ = try p.alice.prepare(clientMessageId: "rejected", text: "rejected", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration).isEmpty,
            "terminal records never pending")
        let secondHandle = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { secondHandle.close() }
        let restored = try VodozemacDmCoordinator(store: secondHandle)
        try checks.require(try restored.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration).isEmpty,
            "terminal receipts survive authenticated reopen")
        try restored.confirmRejection(rejected, reason: .blocked, owner: p.aliceOwner)
        try checks.require(try secondHandle.read() == committedRejection, "reopened receipt retry idempotent")
    }

    try dmProbePair(root: root) { p in
        let old = try p.alice.prepare(clientMessageId: "old-peer", text: "old peer", owner: p.aliceOwner,
            peerGeneration: p.peerGeneration)
        let blockedGeneration = try p.alice.setPeerStatusForResearch(.blocked, owner: p.aliceOwner)
        try checks.require(blockedGeneration == p.peerGeneration + 1, "block increments peer generation")
        try checks.coordinator(.unavailable, "blocked peer cannot enumerate pending") {
            _ = try p.alice.pending(owner: p.aliceOwner, peerGeneration: blockedGeneration)
        }
        try p.alice.confirmRejection(old, reason: .blocked, owner: p.aliceOwner)
        let resumedGeneration = try p.alice.setPeerStatusForResearch(.accepted, owner: p.aliceOwner)
        try checks.require(resumedGeneration == blockedGeneration + 1, "unblock increments peer generation again")
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: resumedGeneration).isEmpty,
            "unblock does not revive old ciphertext")
        try checks.coordinator(.unavailable, "stale peer generation refused") {
            _ = try p.alice.prepare(clientMessageId: "stale-peer", text: "stale", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        let ownerOld = try p.alice.prepare(clientMessageId: "old-owner", text: "old owner", owner: p.aliceOwner,
            peerGeneration: resumedGeneration)
        let nextOwner = try p.alice.advanceOwnerGenerationForResearch(owner: p.aliceOwner)
        try checks.require(nextOwner.userId == p.aliceOwner.userId && nextOwner.deviceId == p.aliceOwner.deviceId
            && nextOwner.generation == p.aliceOwner.generation + 1, "owner generation advances without rebinding identity")
        try checks.coordinator(.unavailable, "old owner guard refused") {
            _ = try p.alice.pending(owner: p.aliceOwner, peerGeneration: resumedGeneration)
        }
        try checks.require(try p.alice.pending(owner: nextOwner, peerGeneration: resumedGeneration).isEmpty,
            "new owner generation cannot enumerate old ciphertext")
        try checks.coordinator(.unavailable, "old owner cannot confirm rejection") {
            try p.alice.confirmRejection(ownerOld, reason: .deviceRevoked, owner: p.aliceOwner)
        }
        try p.alice.confirmRejection(ownerOld, reason: .deviceRevoked, owner: nextOwner)
        try checks.require(try p.alice.pending(owner: nextOwner, peerGeneration: resumedGeneration).isEmpty,
            "current owner cancels exact record from old generation")
        let wrongOwner = DmOwnerContext(userId: "mallory", deviceId: nextOwner.deviceId, generation: nextOwner.generation)
        try checks.coordinator(.unavailable, "wrong owner identity refused") {
            _ = try p.alice.history(owner: wrongOwner, peerGeneration: resumedGeneration)
        }
        try checks.coordinator(.unavailable, "wrong receive owner identity refused") {
            _ = try p.bob.receive(old.serializedEnvelope, owner: wrongOwner, peerGeneration: p.peerGeneration)
        }
    }

    try dmProbePair(root: root) { p in
        var records = [DmOutboxRecord]()
        for index in 0..<16 {
            records.append(try p.alice.prepare(clientMessageId: "bounded-\(index)", text: "bounded", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration))
        }
        let full = try p.aliceStore.read()
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration).count == 16,
            "outbox exact capacity")
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration, limit: 3).count == 3,
            "outbox result limit")
        try checks.coordinator(.capacity, "seventeenth outbox record refused") {
            _ = try p.alice.prepare(clientMessageId: "bounded-overflow", text: "overflow", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.aliceStore.read() == full, "capacity refusal preserves pending ratchet and records")
        try p.alice.confirmAcceptance(records[0], owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        let withTombstone = try p.aliceStore.read()
        try checks.coordinator(.capacity, "terminal tombstone not evicted to make capacity") {
            _ = try p.alice.prepare(clientMessageId: "bounded-overflow", text: "overflow", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(try p.aliceStore.read() == withTombstone, "tombstone retained after full refusal")
        try checks.require(try p.alice.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration).count == 15,
            "only acknowledged item removed from pending")
        try checks.coordinator(.terminalRecord, "full outbox retains terminal identity") {
            _ = try p.alice.prepare(clientMessageId: "bounded-0", text: "bounded", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
    }

    // Deterministic interference occurs after crypto preparation but before the
    // sealed CAS. The independently committed trust change must win atomically.
    try dmProbePair(root: root) { p in
        var interferenceCalls = 0
        var blockedGeneration: Int64 = 0
        var competingSnapshot = try p.aliceStore.read()
        let racing = try VodozemacDmCoordinator(store: p.aliceStore, beforeCommitForResearch: {
            interferenceCalls += 1
            blockedGeneration = try p.alice.setPeerStatusForResearch(.blocked, owner: p.aliceOwner)
            competingSnapshot = try p.aliceStore.read()
        })
        var exposed: DmOutboxRecord?
        try checks.staleRevision("peer change wins CAS race against prepared send") {
            exposed = try racing.prepare(clientMessageId: "peer-race", text: "must remain staged", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(interferenceCalls == 1 && blockedGeneration == p.peerGeneration + 1,
            "peer race performs one competing trust commit")
        try checks.require(exposed == nil, "peer CAS loser exposes no ciphertext record")
        try checks.require(try p.aliceStore.read() == competingSnapshot, "peer CAS loser preserves competing snapshot")
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try reopened.read() == competingSnapshot, "competing peer block survives reopen")
        try checks.coordinator(.unavailable, "reopened peer race retains blocked state") {
            _ = try restored.pending(owner: p.aliceOwner, peerGeneration: blockedGeneration)
        }
        let acceptedGeneration = try p.alice.setPeerStatusForResearch(.accepted, owner: p.aliceOwner)
        try checks.require(acceptedGeneration == blockedGeneration + 1, "peer race reaccept advances generation")
        try checks.require(try restored.pending(owner: p.aliceOwner, peerGeneration: acceptedGeneration).isEmpty,
            "peer race never persists prepared ciphertext")
    }

    try dmProbePair(root: root) { p in
        var interferenceCalls = 0
        var nextOwner = p.aliceOwner
        var competingSnapshot = try p.aliceStore.read()
        let racing = try VodozemacDmCoordinator(store: p.aliceStore, beforeCommitForResearch: {
            interferenceCalls += 1
            nextOwner = try p.alice.advanceOwnerGenerationForResearch(owner: p.aliceOwner)
            competingSnapshot = try p.aliceStore.read()
        })
        var exposed: DmOutboxRecord?
        try checks.staleRevision("owner change wins CAS race against prepared send") {
            exposed = try racing.prepare(clientMessageId: "owner-race", text: "must remain staged", owner: p.aliceOwner,
                peerGeneration: p.peerGeneration)
        }
        try checks.require(interferenceCalls == 1 && nextOwner.generation == p.aliceOwner.generation + 1,
            "owner race performs one competing generation commit")
        try checks.require(exposed == nil, "owner CAS loser exposes no ciphertext record")
        try checks.require(try p.aliceStore.read() == competingSnapshot, "owner CAS loser preserves competing snapshot")
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try reopened.read() == competingSnapshot, "competing owner generation survives reopen")
        try checks.coordinator(.unavailable, "reopened owner race refuses old generation") {
            _ = try restored.pending(owner: p.aliceOwner, peerGeneration: p.peerGeneration)
        }
        try checks.require(try restored.pending(owner: nextOwner, peerGeneration: p.peerGeneration).isEmpty,
            "owner race never persists prepared ciphertext")
    }

    // Use direct native-provider fixture calls to create cryptographically valid
    // plaintext with the wrong conversation; no coordinator internals are read.
    let senderStore = try dmProbeStore(root: root)
    defer { try? senderStore.destroyForTesting() }
    let receiverStore = try dmProbeStore(root: root)
    defer { try? receiverStore.destroyForTesting() }
    let owner = DmOwnerContext(userId: "receiver", deviceId: "z-receiver-device", generation: 31)
    let receiver = try VodozemacDmCoordinator.bootstrapForResearch(store: receiverStore, owner: owner,
        identityKeyId: "receiver-identity", conversationId: "correct-conversation")
    let recipient = try receiver.publicIdentity(owner: owner)
    let pickleKey = try senderStore.providerPickleKey()
    let sender = try newAccount(pickleKey: pickleKey)
    try receiver.installPeerForResearch(DmPeerContext(userId: "sender", deviceId: "sender-device",
        identityKeyId: "sender-identity", curve: sender.identityCurve, prekey: sender.oneTimeKey,
        generation: 1, status: .accepted), owner: owner)
    let session = try startSession(accountPickle: sender.accountPickle, pickleKey: pickleKey,
        peerIdentity: recipient.curve, peerPrekey: recipient.prekey)
    func content(_ id: String, conversation: String) throws -> Data {
        try DmContentCodec.encode(context: DmAuthenticatedContext(conversationId: conversation, clientMessageId: id,
            senderUserId: "sender", senderDeviceId: "sender-device", recipientUserId: recipient.userId,
            recipientDeviceId: recipient.deviceId, senderIdentityKeyId: "sender-identity",
            recipientIdentityKeyId: recipient.identityKeyId, senderCurve: sender.identityCurve,
            recipientCurve: recipient.curve, sessionId: session.sessionId), text: id)
    }
    let wrong = try encrypt(sessionPickle: session.sessionPickle, pickleKey: pickleKey,
        plaintext: content("context-check", conversation: "wrong-conversation"))
    let wrongEnvelope = try DmEnvelope(clientMessageId: "context-check", senderDeviceId: "sender-device",
        recipientDeviceId: recipient.deviceId, wire: wrong.wire).serialized()
    let beforeAttack = try receiverStore.read()
    try checks.contextRefusal("valid ciphertext wrong conversation refused") {
        _ = try receiver.receive(wrongEnvelope, owner: owner, peerGeneration: 1)
    }
    try checks.require(try receiverStore.read() == beforeAttack, "wrong conversation commits no prekey or session")
    var senderSession = session.sessionPickle
    var firstEnvelope = ""
    for index in 0..<16 {
        let id = "inbox-\(index)"
        let encrypted = try encrypt(sessionPickle: senderSession, pickleKey: pickleKey,
            plaintext: content(id, conversation: "correct-conversation"))
        senderSession = encrypted.sessionPickle
        let envelope = try DmEnvelope(clientMessageId: id, senderDeviceId: "sender-device",
            recipientDeviceId: recipient.deviceId, wire: encrypted.wire).serialized()
        if index == 0 { firstEnvelope = envelope }
        try dmProbeStored(receiver.receive(envelope, owner: owner, peerGeneration: 1), text: id, id: id,
            owner: owner, peerGeneration: 1, envelope: envelope, checks: checks)
    }
    let fullInbox = try receiverStore.read()
    try checks.require(try receiver.history(owner: owner, peerGeneration: 1).count == 16, "inbox exact capacity")
    try checks.require(try receiver.history(owner: owner, peerGeneration: 1, limit: 3).count == 3, "history result limit")
    let overflow = try encrypt(sessionPickle: senderSession, pickleKey: pickleKey,
        plaintext: content("inbox-overflow", conversation: "correct-conversation"))
    let overflowEnvelope = try DmEnvelope(clientMessageId: "inbox-overflow", senderDeviceId: "sender-device",
        recipientDeviceId: recipient.deviceId, wire: overflow.wire).serialized()
    try checks.coordinator(.capacity, "seventeenth inbox record refused") {
        _ = try receiver.receive(overflowEnvelope, owner: owner, peerGeneration: 1)
    }
    try checks.require(try receiverStore.read() == fullInbox, "inbox capacity preserves ratchet and history")
    try dmProbeDuplicate(receiver.receive(firstEnvelope, owner: owner, peerGeneration: 1), checks: checks)
    try checks.require(try receiverStore.read() == fullInbox, "duplicate at full inbox neither evicts nor advances")
    print("PASS native DM coordinator research: \(checks.assertions) assertions")
    return checks.assertions
}
