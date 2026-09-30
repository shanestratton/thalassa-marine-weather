// Separate-process synthetic coordinator proof. No transport, app registration,
// real accounts or authenticated directory. Receipts below are trusted fixtures.
// Only dm-prepare creates identities; every later phase authenticates saved state.
import Foundation

private enum DmRestartFixture {
    static let alice = DmOwnerContext(userId: "restart-alice", deviceId: "alice-device", generation: 11)
    static let bob = DmOwnerContext(userId: "restart-bob", deviceId: "bob-device", generation: 21)
    static let generation: Int64 = 7
    static let opening = "synthetic coordinator opening across process restart"
    static let reply = "synthetic coordinator reply across process restart"
    static let successor = "synthetic coordinator successor across process restart"
}

private func dmRestartRequire(_ condition: Bool, _ label: String) throws {
    guard condition else { throw DmCoordinatorProbeError.assertion(label) }
}

private func dmRestartPending(_ coordinator: VodozemacDmCoordinator, owner: DmOwnerContext,
                              id: String) throws -> DmOutboxRecord {
    let rows = try coordinator.pending(owner: owner, peerGeneration: DmRestartFixture.generation)
    try dmRestartRequire(rows.count == 1, "restart one exact pending record")
    let row = rows[0]
    try dmRestartRequire(try DmEnvelope.decode(row.serializedEnvelope).clientMessageId == id
        && row.ownerUserId == owner.userId && row.ownerSessionGeneration == owner.generation
        && row.recipientIdentityGeneration == DmRestartFixture.generation, "restart pending identity and generations")
    return row
}

private func dmRestartStored(_ result: DmReceiveResult, record: DmOutboxRecord,
                             text: String, owner: DmOwnerContext) throws {
    guard case .stored(let message) = result else { throw DmCoordinatorProbeError.assertion("restart new message stored") }
    try dmRestartRequire(try message.clientMessageId == DmEnvelope.decode(record.serializedEnvelope).clientMessageId
        && message.text == text && Data(message.serializedEnvelope.utf8) == Data(record.serializedEnvelope.utf8)
        && message.ownerGeneration == owner.generation && message.peerGeneration == DmRestartFixture.generation,
        "restart stored exact content and context")
}

/// The runner invokes each of these six phases once in a new app process.
func runDmCoordinatorPhase(_ phase: String, runID: UUID, aliceID: UUID, bobID: UUID) throws {
    try dmRestartRequire(aliceID != bobID && ["dm-prepare", "dm-receive", "dm-reply", "dm-verify", "dm-replay", "dm-cleanup"].contains(phase),
        "restart phase arguments")
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let root = documents.appendingPathComponent("dm-e2ee-research-\(runID.uuidString)")
    let alicePath = root.appendingPathComponent(aliceID.uuidString)
    let bobPath = root.appendingPathComponent(bobID.uuidString)
    let ao = DmRestartFixture.alice, bo = DmRestartFixture.bob, generation = DmRestartFixture.generation
    if phase == "dm-prepare" {
        try dmRestartRequire(!FileManager.default.fileExists(atPath: root.path), "restart prepare requires fresh namespace")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let aStore = try VodozemacSealedStore.create(directory: alicePath, storeID: aliceID, initialPayload: Data("{}".utf8))
        defer { aStore.close() }
        let bStore = try VodozemacSealedStore.create(directory: bobPath, storeID: bobID, initialPayload: Data("{}".utf8))
        defer { bStore.close() }
        let a = try VodozemacDmCoordinator.bootstrapForResearch(store: aStore, owner: ao,
            identityKeyId: "restart-alice-identity", conversationId: "restart-conversation")
        let b = try VodozemacDmCoordinator.bootstrapForResearch(store: bStore, owner: bo,
            identityKeyId: "restart-bob-identity", conversationId: "restart-conversation")
        let ap = try a.publicIdentity(owner: ao), bp = try b.publicIdentity(owner: bo)
        try a.installPeerForResearch(DmPeerContext(userId: bp.userId, deviceId: bp.deviceId,
            identityKeyId: bp.identityKeyId, curve: bp.curve, prekey: bp.prekey, generation: generation, status: .accepted), owner: ao)
        try b.installPeerForResearch(DmPeerContext(userId: ap.userId, deviceId: ap.deviceId,
            identityKeyId: ap.identityKeyId, curve: ap.curve, prekey: ap.prekey, generation: generation, status: .accepted), owner: bo)
        let opening = try a.prepare(clientMessageId: "restart-opening", text: DmRestartFixture.opening, owner: ao, peerGeneration: generation)
        try dmRestartRequire(try dmRestartPending(a, owner: ao, id: "restart-opening") == opening, "restart opening atomically pending")
    } else {
        let aStore = try VodozemacSealedStore.reopen(directory: alicePath, storeID: aliceID)
        defer { aStore.close() }
        let bStore = try VodozemacSealedStore.reopen(directory: bobPath, storeID: bobID)
        defer { bStore.close() }
        if phase == "dm-cleanup" {
            try aStore.destroyForTesting()
            try bStore.destroyForTesting()
            try dmRestartRequire(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "restart exact cleanup empty namespace")
            try FileManager.default.removeItem(at: root)
        } else {
            let a = try VodozemacDmCoordinator(store: aStore), b = try VodozemacDmCoordinator(store: bStore)
            switch phase {
            case "dm-receive":
                let opening = try dmRestartPending(a, owner: ao, id: "restart-opening")
                try dmRestartStored(b.receive(opening.serializedEnvelope, owner: bo, peerGeneration: generation),
                    record: opening, text: DmRestartFixture.opening, owner: bo)
                let reply = try b.prepare(clientMessageId: "restart-reply", text: DmRestartFixture.reply, owner: bo, peerGeneration: generation)
                try dmRestartRequire(try DmEnvelope.decode(reply.serializedEnvelope).messageType == "session", "restart reply normal wire")
            case "dm-reply":
                let reply = try dmRestartPending(b, owner: bo, id: "restart-reply")
                try dmRestartStored(a.receive(reply.serializedEnvelope, owner: ao, peerGeneration: generation),
                    record: reply, text: DmRestartFixture.reply, owner: ao)
                let opening = try dmRestartPending(a, owner: ao, id: "restart-opening")
                // Trusted synthetic receipt, not proof of authenticated server acceptance.
                try a.confirmAcceptance(opening, owner: ao, peerGeneration: generation)
                _ = try a.prepare(clientMessageId: "restart-successor", text: DmRestartFixture.successor, owner: ao, peerGeneration: generation)
            case "dm-verify":
                let successor = try dmRestartPending(a, owner: ao, id: "restart-successor")
                try dmRestartStored(b.receive(successor.serializedEnvelope, owner: bo, peerGeneration: generation),
                    record: successor, text: DmRestartFixture.successor, owner: bo)
                let reply = try dmRestartPending(b, owner: bo, id: "restart-reply")
                try b.confirmAcceptance(reply, owner: bo, peerGeneration: generation) // Trusted fixture receipt.
            case "dm-replay":
                let successor = try dmRestartPending(a, owner: ao, id: "restart-successor")
                let beforeA = try aStore.read(), beforeB = try bStore.read()
                let retry = try a.prepare(clientMessageId: "restart-successor", text: DmRestartFixture.successor, owner: ao, peerGeneration: generation)
                try dmRestartRequire(retry == successor && Data(retry.serializedEnvelope.utf8) == Data(successor.serializedEnvelope.utf8), "restart retry exact ciphertext")
                try dmRestartRequire(try aStore.read() == beforeA, "restart retry leaves sender snapshot unchanged")
                try dmRestartRequire(try b.receive(successor.serializedEnvelope, owner: bo, peerGeneration: generation) == .duplicate, "restart duplicate has no plaintext")
                try dmRestartRequire(try bStore.read() == beforeB, "restart duplicate leaves receiver snapshot unchanged")
                let ah = try a.history(owner: ao, peerGeneration: generation), bh = try b.history(owner: bo, peerGeneration: generation)
                try dmRestartRequire(ah.count == 1 && ah[0].clientMessageId == "restart-reply" && ah[0].text == DmRestartFixture.reply,
                    "restart Alice committed history")
                try dmRestartRequire(bh.count == 2 && bh[0].clientMessageId == "restart-opening" && bh[0].text == DmRestartFixture.opening
                    && bh[1].clientMessageId == "restart-successor" && bh[1].text == DmRestartFixture.successor, "restart Bob committed history")
                try dmRestartRequire(try b.pending(owner: bo, peerGeneration: generation).isEmpty, "restart Bob receipt remains terminal")
                let opening = DmOutboxRecord(ownerUserId: ao.userId, ownerSessionGeneration: ao.generation, recipientUserId: bo.userId,
                    recipientIdentityKeyId: "restart-bob-identity", recipientIdentityGeneration: generation, serializedEnvelope: bh[0].serializedEnvelope)
                try a.confirmAcceptance(opening, owner: ao, peerGeneration: generation)
                try dmRestartRequire(try aStore.read() == beforeA, "restart Alice durable receipt idempotent")
            default: throw DmCoordinatorProbeError.assertion("restart unsupported phase")
            }
        }
    }
    print("PASS native DM coordinator restart phase: \(phase)")
}
