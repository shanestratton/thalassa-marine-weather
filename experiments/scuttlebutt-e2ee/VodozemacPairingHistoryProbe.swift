// ISOLATED NATIVE FIXTURES. Real provider bytes and Keychain-sealed snapshots,
// not an app/plugin, live Auth, hosted relay, physical pairing or security audit.
// Research acceptance/rejection below injects a trusted decision only; it does
// not prove server acceptance, peer delivery or reading. Output is a count only.
// Closed registration/claim/policy responses are similarly trusted synthetic
// decisions, not authenticated HTTPS. There is no operational readiness bypass.
import Foundation
import CryptoKit

enum DmPairingHistoryProbeError: Error { case assertion(String) }

private final class DmPairingHistoryChecks {
    private(set) var assertions = 0

    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmPairingHistoryProbeError.assertion(label) }
        assertions += 1
    }

    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch is DmCoordinatorError { assertions += 1; return }
        // Outside the catch: an assertion cannot satisfy its own refusal.
        throw DmPairingHistoryProbeError.assertion(label)
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
        throw DmPairingHistoryProbeError.assertion(label)
    }
}

private let dmPairingHistoryProject = "https://kmtupdvwdgbhtssqqova.supabase.co"
private let dmPairingHistoryConversation = "pairing-history-conversation"

private struct DmPairingHistoryFixture {
    let aliceStore: VodozemacSealedStore
    let bobStore: VodozemacSealedStore
    let alice: VodozemacDmCoordinator
    let bob: VodozemacDmCoordinator
    let aliceOwner: DmOwnerContext
    let bobOwner: DmOwnerContext
}

private func dmPairingHistoryFixture(_ operation: (DmPairingHistoryFixture) throws -> Void) throws {
    // Fresh native UUIDs, sorted only to exercise the established device-order
    // initiator rule. These are two logical native fixtures, not two devices.
    let ids = [UUID(), UUID()].sorted { $0.uuidString.lowercased() < $1.uuidString.lowercased() }
    let parent = FileManager.default.temporaryDirectory
    let aStore = try VodozemacSealedStore.create(directory: parent.appendingPathComponent(ids[0].uuidString),
        storeID: ids[0], initialPayload: Data("{}".utf8))
    defer { try? aStore.destroyForTesting() }
    let bStore = try VodozemacSealedStore.create(directory: parent.appendingPathComponent(ids[1].uuidString),
        storeID: ids[1], initialPayload: Data("{}".utf8))
    defer { try? bStore.destroyForTesting() }
    let ao = DmOwnerContext(userId: "11111111-1111-4111-8111-111111111111",
        deviceId: ids[0].uuidString.lowercased(), generation: 11)
    let bo = DmOwnerContext(userId: "22222222-2222-4222-8222-222222222222",
        deviceId: ids[1].uuidString.lowercased(), generation: 21)
    let a = try VodozemacDmCoordinator.bootstrapForResearch(store: aStore, owner: ao,
        identityKeyId: "pairing-alice-key", conversationId: dmPairingHistoryConversation)
    let b = try VodozemacDmCoordinator.bootstrapForResearch(store: bStore, owner: bo,
        identityKeyId: "pairing-bob-key", conversationId: dmPairingHistoryConversation)
    // Synthetic native verified transitions pin the configured issuer. There
    // is deliberately no SDK, bearer, server /user request or live enrollment.
    _ = try a.completeAuthVerificationForResearch(expected: a.lifecycleForResearch(),
        verifiedUserId: ao.userId, projectOrigin: dmPairingHistoryProject)
    _ = try b.completeAuthVerificationForResearch(expected: b.lifecycleForResearch(),
        verifiedUserId: bo.userId, projectOrigin: dmPairingHistoryProject)
    try operation(DmPairingHistoryFixture(aliceStore: aStore, bobStore: bStore,
        alice: a, bob: b, aliceOwner: ao, bobOwner: bo))
}

private func dmPairingHistoryContext(_ coordinator: VodozemacDmCoordinator,
                                     peerGeneration: Int64? = nil) throws -> DmRelayNetworkContext {
    let lifecycle = try coordinator.lifecycleForResearch()
    return DmRelayNetworkContext(userId: lifecycle.owner.userId, deviceId: lifecycle.owner.deviceId,
        ownerGeneration: lifecycle.owner.generation, credentialEpoch: lifecycle.credentialEpoch,
        peerGeneration: peerGeneration)
}

private func dmPairingHistoryExecute(_ coordinator: VodozemacDmCoordinator,
                                    _ operation: DmNativeMessageOperation,
                                    peerGeneration: Int64? = nil) throws -> DmNativeMessageResult {
    // The authoritative Directory/Facade gate has separate race probes. This
    // native-only fixture exercises the closed coordinator dispatcher contract.
    try coordinator.executeMessageOperation(operation,
        context: dmPairingHistoryContext(coordinator, peerGeneration: peerGeneration), checkAuthority: {})
}

private func dmPairingHistoryCard(_ coordinator: VodozemacDmCoordinator) throws -> DmPairingCard {
    guard case .pairingCard(let card) = try dmPairingHistoryExecute(coordinator, .pairingCard) else {
        throw DmPairingHistoryProbeError.assertion("closed dispatcher pairing-card result")
    }
    return card
}

private func dmPairingHistoryState(_ coordinator: VodozemacDmCoordinator,
                                  peerGeneration: Int64? = nil) throws -> DmNativePairingState {
    guard case .pairingState(let state) = try dmPairingHistoryExecute(coordinator, .pairingState,
        peerGeneration: peerGeneration) else {
        throw DmPairingHistoryProbeError.assertion("closed dispatcher pairing-state result")
    }
    return state
}

private func dmPairingHistoryConfirm(_ coordinator: VodozemacDmCoordinator, card: DmPairingCard) throws -> DmNativePairingState {
    // Confirmation is an owner/credential control, not a peer-bound message.
    // Use nil even for an exact repeat so replacement tests reach pin checks.
    guard case .pairingState(let state) = try dmPairingHistoryExecute(coordinator,
        .confirmPeer(card: card, confirmedFingerprint: card.fingerprint())) else {
        throw DmPairingHistoryProbeError.assertion("closed dispatcher confirmation result")
    }
    return state
}

private func dmPairingHistoryThread(_ coordinator: VodozemacDmCoordinator,
                                   peerGeneration: Int64) throws -> DmNativeThread {
    guard case .thread(let thread) = try dmPairingHistoryExecute(coordinator, .thread,
        peerGeneration: peerGeneration) else {
        throw DmPairingHistoryProbeError.assertion("closed dispatcher thread result")
    }
    return thread
}

private func dmPairingHistoryPrepare(_ coordinator: VodozemacDmCoordinator, id: String, text: String,
                                    peerGeneration: Int64) throws -> DmOutboxRecord {
    guard case .outbox(let record) = try dmPairingHistoryExecute(coordinator,
        .prepareText(clientMessageId: id, text: text), peerGeneration: peerGeneration) else {
        throw DmPairingHistoryProbeError.assertion("closed dispatcher preparation result")
    }
    return record
}

private func dmPairingHistoryPolicy(_ coordinator: VodozemacDmCoordinator) throws {
    guard case .policyRequest(let request) = try dmPairingHistoryExecute(coordinator, .relayPolicyWire) else {
        throw DmPairingHistoryProbeError.assertion("closed policy query fixture result")
    }
    let result = try dmScopedEnrollmentJSON(["requestId": request.requestId,
        "ownerUserId": request.context.userId, "ownerDeviceId": request.context.deviceId,
        "peerUserId": request.peer.userId, "peerDeviceId": request.peer.deviceId,
        "peerIdentityKeyId": request.peer.identityKeyId, "ownerRevoked": false,
        "peerRevoked": false, "blockedByMe": false, "blockedByPeer": false])
    guard case .policyState(let state) = try dmPairingHistoryExecute(coordinator,
        .relayPolicyResponse(request: request, response: result)),
          !state.ownerRevoked, !state.peerRevoked, !state.blockedByMe, !state.blockedByPeer else {
        throw DmPairingHistoryProbeError.assertion("closed trusted clear policy fixture result")
    }
}

private func dmPairingHistoryReady(_ fixture: DmPairingHistoryFixture, aliceGeneration: Int64) throws {
    // Both registrations acknowledge exact real-provider signed bundles. Only
    // the lower UUID actor claims; responder readiness does NOT invent a claim.
    _ = try dmPairingHistoryConfirm(fixture.bob, card: dmPairingHistoryCard(fixture.alice))
    var peerWire: String?
    for coordinator in [fixture.alice, fixture.bob] {
        guard case .registrationRequest(let wire) = try dmPairingHistoryExecute(coordinator, .relayRegistrationWire),
              case .publicIdentity(let identity) = try dmPairingHistoryExecute(coordinator, .publicIdentity) else {
            throw DmPairingHistoryProbeError.assertion("closed registration fixture bundle")
        }
        _ = try DmRelayCodec.verifyBundle(wire, now: Int64(Date().timeIntervalSince1970))
        guard case .enrollmentState(let state) = try dmPairingHistoryExecute(coordinator,
            .relayRegistrationResponse(wire: wire, response: dmScopedEnrollmentAck(identity))),
              state.registration == .acknowledged, state.claim == .none else {
            throw DmPairingHistoryProbeError.assertion("closed trusted registration acknowledgement fixture")
        }
        if coordinator === fixture.bob { peerWire = wire }
    }
    guard let peerWire,
          case .claimRequest(let request) = try dmPairingHistoryExecute(fixture.alice, .relayClaimWire,
            peerGeneration: aliceGeneration),
          case .enrollmentState(let claim) = try dmPairingHistoryExecute(fixture.alice,
            .relayClaimResponse(request: request, response: dmScopedEnrollmentClaimResult(peerWire)),
            peerGeneration: aliceGeneration), claim.claim == .verified else {
        throw DmPairingHistoryProbeError.assertion("closed trusted lower-device claim fixture")
    }
    try dmPairingHistoryPolicy(fixture.alice)
    try dmPairingHistoryPolicy(fixture.bob)
}

private func dmPairingHistoryMessage(_ thread: DmNativeThread, id: String,
                                    direction: DmNativeThreadDirection) throws -> DmNativeThreadMessage {
    let matches = thread.messages.filter { $0.clientMessageId == id && $0.direction == direction }
    guard matches.count == 1 else { throw DmPairingHistoryProbeError.assertion("exact current thread message") }
    return matches[0]
}

private func dmPairingHistoryReceive(_ coordinator: VodozemacDmCoordinator, record: DmOutboxRecord,
                                    owner: DmOwnerContext, peerGeneration: Int64, text: String,
                                    checks: DmPairingHistoryChecks) throws {
    let epoch = try coordinator.lifecycleForResearch().credentialEpoch
    guard case .stored(let message) = try coordinator.receive(record.serializedEnvelope, owner: owner,
        peerGeneration: peerGeneration, credentialEpoch: epoch) else {
        throw DmPairingHistoryProbeError.assertion("fresh real-provider receive")
    }
    try checks.require(message.text.utf8.elementsEqual(text.utf8), "received exact provider-authenticated fixture text")
}

private func dmPairingHistoryBinding(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let before = try p.aliceStore.read()
        let alice = try dmPairingHistoryCard(p.alice), bob = try dmPairingHistoryCard(p.bob)
        guard case .publicIdentity(let identity) = try dmPairingHistoryExecute(p.alice, .publicIdentity) else {
            throw DmPairingHistoryProbeError.assertion("closed dispatcher public-identity result")
        }
        try checks.require(alice.identity == identity && alice.projectOrigin == dmPairingHistoryProject
            && alice.conversationId == dmPairingHistoryConversation, "card contains exact native full identity and routing")
        let unpaired = try dmPairingHistoryState(p.alice)
        try checks.require(unpaired.status == .unpaired && unpaired.peerGeneration == nil
            && unpaired.confirmedFingerprint == nil && unpaired.sessionRole == .unpaired,
            "fresh native state is explicitly unpaired")
        try checks.require(unpaired.outgoingCount == 0 && unpaired.incomingCount == 0 && unpaired.unresolvedCount == 0,
            "fresh pairing counters have no fabricated messages")
        try checks.require(try p.aliceStore.read() == before, "identity card and state reads do not mutate sealed revision")
        let fields = [bob.projectOrigin, bob.conversationId, bob.identity.userId, bob.identity.deviceId,
            bob.identity.identityKeyId, bob.identity.signingKey, bob.identity.curve, bob.identity.prekey]
        let reference = SHA256.hash(data: Data(("thalassa-research-pairing-v1\n" + fields.joined(separator: "\n") + "\n").utf8))
            .map { String(format: "%02x", $0) }.joined()
        let fingerprint = try bob.fingerprint()
        try checks.require(fingerprint == reference && fingerprint.count == 64, "fingerprint binds canonical full identity frame")
        let substituted = DmPublicIdentity(userId: bob.identity.userId, deviceId: bob.identity.deviceId,
            identityKeyId: bob.identity.identityKeyId, signingKey: alice.identity.signingKey,
            curve: bob.identity.curve, prekey: bob.identity.prekey)
        let swapped = DmPairingCard(projectOrigin: bob.projectOrigin, conversationId: bob.conversationId, identity: substituted)
        try checks.require(try swapped.fingerprint() != fingerprint, "signing-key-only substitution changes fingerprint")
        try checks.refuses("unconfirmed signing substitution cannot use old fingerprint") {
            _ = try dmPairingHistoryExecute(p.alice, .confirmPeer(card: swapped, confirmedFingerprint: fingerprint))
        }
        try checks.require(try p.aliceStore.read() == before, "fingerprint refusal cannot install peer or change revision")
        let wrongProject = DmPairingCard(projectOrigin: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co",
            conversationId: bob.conversationId, identity: bob.identity)
        let wrongConversation = DmPairingCard(projectOrigin: bob.projectOrigin,
            conversationId: "pairing-other-conversation", identity: bob.identity)
        for card in [wrongProject, wrongConversation] {
            try checks.require(try card.fingerprint() != fingerprint, "routing changes are fingerprint-bound")
            try checks.refuses("foreign project or conversation cannot become a native pin") {
                _ = try dmPairingHistoryConfirm(p.alice, card: card)
            }
            try checks.require(try p.aliceStore.read() == before, "foreign pairing refusal preserves exact snapshot")
        }
        let invalid = DmPairingCard(projectOrigin: "http://aaaaaaaaaaaaaaaaaaaa.supabase.co",
            conversationId: bob.conversationId, identity: bob.identity)
        try checks.coordinator(.invalidInput, "non-HTTPS card fingerprint is refused") { _ = try invalid.fingerprint() }
        let paired = try dmPairingHistoryConfirm(p.alice, card: bob)
        guard let generation = paired.peerGeneration else { throw DmPairingHistoryProbeError.assertion("confirmed peer generation") }
        try checks.require(paired.status == .confirmed && paired.confirmedFingerprint == fingerprint
            && paired.sessionRole == .initiator, "initial confirmation pins full peer and initiator role")
        let committed = try p.aliceStore.read()
        let exact = try dmPairingHistoryConfirm(p.alice, card: bob)
        try checks.require(exact.status == .confirmed && exact.peerGeneration == generation
            && exact.confirmedFingerprint == fingerprint, "exact pairing is idempotent")
        try checks.require(try p.aliceStore.read() == committed, "idempotent pairing does not rewrite sealed state")
        try checks.refuses("confirmed peer signing-key replacement is refused even with its own fingerprint") {
            _ = try dmPairingHistoryConfirm(p.alice, card: swapped)
        }
        let replacedIdentity = DmPublicIdentity(userId: bob.identity.userId, deviceId: bob.identity.deviceId,
            identityKeyId: "pairing-replacement-key", signingKey: bob.identity.signingKey,
            curve: bob.identity.curve, prekey: bob.identity.prekey)
        let replaced = DmPairingCard(projectOrigin: bob.projectOrigin, conversationId: bob.conversationId, identity: replacedIdentity)
        try checks.refuses("confirmed peer identity-ID replacement is refused") {
            _ = try dmPairingHistoryConfirm(p.alice, card: replaced)
        }
        try checks.require(try p.aliceStore.read() == committed, "replacement refusals preserve full pin and sealed revision")
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        let persisted = try dmPairingHistoryState(restored, peerGeneration: generation)
        try checks.require(persisted.status == .confirmed && persisted.confirmedFingerprint == fingerprint
            && persisted.peerGeneration == generation, "full confirmed pin survives authenticated sealed reopen")
    }
}

private func dmPairingHistoryMessages(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let ac = try dmPairingHistoryCard(p.alice), bc = try dmPairingHistoryCard(p.bob)
        let a = try dmPairingHistoryConfirm(p.alice, card: bc), b = try dmPairingHistoryConfirm(p.bob, card: ac)
        guard let ag = a.peerGeneration, let bg = b.peerGeneration else {
            throw DmPairingHistoryProbeError.assertion("reciprocal confirmed native generations")
        }
        try checks.require(b.status == .confirmed && b.sessionRole == .responder, "higher native device waits as responder")
        try dmPairingHistoryReady(p, aliceGeneration: ag)
        let beforeResponder = try p.bobStore.read()
        try checks.coordinator(.unavailable, "responder cannot manufacture an initial session") {
            _ = try dmPairingHistoryPrepare(p.bob, id: "responder-first", text: "fixture premature reply", peerGeneration: bg)
        }
        try checks.require(try p.bobStore.read() == beforeResponder, "responder-first refusal does not advance ratchet or history")
        let beforeBlank = try p.aliceStore.read()
        for text in ["", " \t\r\n"] {
            try checks.coordinator(.invalidInput, "native blank text policy is fail-closed") {
                _ = try dmPairingHistoryPrepare(p.alice, id: "blank-fixture", text: text, peerGeneration: ag)
            }
        }
        try checks.coordinator(.invalidInput, "native oversized text policy is fail-closed") {
            _ = try dmPairingHistoryPrepare(p.alice, id: "oversized-fixture",
                text: String(repeating: "x", count: DmContentCodec.maxTextBytes + 1), peerGeneration: ag)
        }
        try checks.require(try p.aliceStore.read() == beforeBlank, "blank refusals do not allocate outgoing slots")
        let text = "  fixture opening with preserved whitespace \n"
        let first = try dmPairingHistoryPrepare(p.alice, id: "pairing-opening", text: text, peerGeneration: ag)
        let initialThread = try dmPairingHistoryThread(p.alice, peerGeneration: ag)
        let pending = try dmPairingHistoryMessage(initialThread, id: "pairing-opening", direction: .outgoing)
        try checks.require(pending.text == text && pending.delivery == .pending && pending.reason == nil,
            "native thread exposes exact locally pending plaintext without a receipt")
        try checks.require(pending.localCreatedAtMillis.map { $0 > 0 } == true,
            "new outgoing timestamp is native-local and persisted")
        let committed = try p.aliceStore.read()
        let retry = try dmPairingHistoryPrepare(p.alice, id: "pairing-opening", text: text, peerGeneration: ag)
        try checks.require(retry == first && retry.serializedEnvelope.utf8.elementsEqual(first.serializedEnvelope.utf8),
            "pending retry returns identical committed ciphertext and metadata")
        let retried = try dmPairingHistoryMessage(dmPairingHistoryThread(p.alice, peerGeneration: ag),
            id: "pairing-opening", direction: .outgoing)
        try checks.require(retried == pending, "pending retry retains exact plaintext status and timestamp")
        try checks.require(try p.aliceStore.read() == committed, "pending retry never rewrites ratchet or time")
        try checks.coordinator(.conflict, "message ID cannot bind a different native plaintext") {
            _ = try dmPairingHistoryPrepare(p.alice, id: "pairing-opening", text: "fixture altered text", peerGeneration: ag)
        }
        try checks.require(try p.aliceStore.read() == committed, "content-conflict refusal preserves exact committed snapshot")
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try checks.require(try dmPairingHistoryMessage(dmPairingHistoryThread(restored, peerGeneration: ag),
            id: "pairing-opening", direction: .outgoing) == pending, "pending text and native-local time survive sealed reopen")
        try dmPairingHistoryPolicy(restored)
        try checks.require(try dmPairingHistoryPrepare(restored, id: "pairing-opening", text: text, peerGeneration: ag) == first,
            "reopened pending retry does not encrypt again")
        try p.alice.confirmAcceptance(first, owner: p.aliceOwner, peerGeneration: ag,
            credentialEpoch: p.alice.lifecycleForResearch().credentialEpoch)
        let accepted = try dmPairingHistoryMessage(dmPairingHistoryThread(p.alice, peerGeneration: ag),
            id: "pairing-opening", direction: .outgoing)
        try checks.require(accepted.delivery == .serverAccepted && accepted.text == text && accepted.reason == nil
            && accepted.localCreatedAtMillis == pending.localCreatedAtMillis,
            "injected trusted acceptance is server-accepted only and preserves local text/time")
        try dmPairingHistoryReceive(p.bob, record: first, owner: p.bobOwner, peerGeneration: bg, text: text, checks: checks)
        let incoming = try dmPairingHistoryMessage(dmPairingHistoryThread(p.bob, peerGeneration: bg),
            id: "pairing-opening", direction: .incoming)
        try checks.require(incoming.delivery == .received && incoming.text == text && incoming.reason == nil,
            "stored real-provider incoming plaintext is visible in current native thread")
        try checks.require(incoming.localCreatedAtMillis == nil, "receive never invents a sender or legacy observation time")
        let established = try dmPairingHistoryState(p.bob, peerGeneration: bg)
        try checks.require(established.sessionRole == .established && established.incomingCount == 1,
            "real authenticated initial message establishes responder session")
        let replyText = "fixture responder reply"
        let reply = try dmPairingHistoryPrepare(p.bob, id: "pairing-reply", text: replyText, peerGeneration: bg)
        try dmPairingHistoryReceive(p.alice, record: reply, owner: p.aliceOwner, peerGeneration: ag, text: replyText, checks: checks)
        let rejected = try dmPairingHistoryPrepare(p.alice, id: "pairing-rejected", text: "fixture rejected draft", peerGeneration: ag)
        try p.alice.confirmRejection(rejected, reason: .blocked, owner: p.aliceOwner,
            credentialEpoch: p.alice.lifecycleForResearch().credentialEpoch)
        _ = try dmPairingHistoryPrepare(p.alice, id: "pairing-pending", text: "fixture pending draft", peerGeneration: ag)
        let thread = try dmPairingHistoryThread(p.alice, peerGeneration: ag)
        let refusal = try dmPairingHistoryMessage(thread, id: "pairing-rejected", direction: .outgoing)
        try checks.require(refusal.delivery == .rejected && refusal.reason == .blocked && refusal.text == "fixture rejected draft",
            "trusted rejection remains visible without a false delivery claim")
        try checks.require(try dmPairingHistoryMessage(thread, id: "pairing-pending", direction: .outgoing).delivery == .pending,
            "unresolved outgoing remains pending alongside terminal rows")
        try checks.require(thread.ownerGeneration == p.aliceOwner.generation && thread.peerGeneration == ag
            && thread.outgoingCapacity == 16 && thread.incomingCapacity == 16 && thread.unresolvedCount == 0,
            "native thread identifies current bounded scope without fabricated unresolved messages")
        let counts = try dmPairingHistoryState(p.alice, peerGeneration: ag)
        try checks.require(counts.outgoingCount == 3 && counts.incomingCount == 1 && counts.unresolvedCount == 0,
            "native pairing counters cover pending accepted rejected and received rows")
        let stale = try dmPairingHistoryContext(p.alice, peerGeneration: ag)
        let nextOwner = try p.alice.advanceOwnerGenerationForResearch(owner: p.aliceOwner)
        let historical = try p.aliceStore.read()
        try checks.coordinator(.unavailable, "old owner snapshot cannot read native thread") {
            _ = try p.alice.executeMessageOperation(.thread, context: stale, checkAuthority: {})
        }
        let fresh = try dmPairingHistoryThread(p.alice, peerGeneration: ag)
        try checks.require(fresh.ownerGeneration == nextOwner.generation && fresh.messages.isEmpty && fresh.unresolvedCount == 0,
            "historical plaintext and all old outgoing statuses are hidden after owner generation change")
        try checks.require(try p.aliceStore.read() == historical, "current history filtering does not rewrite historical storage")
    }
}

private func dmPairingHistoryLegacy(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let bob = try dmPairingHistoryCard(p.bob)
        // Match the new-pair generation exactly: refusal must be because the
        // old pin lacks full identity evidence, not an unrelated counter clash.
        try p.alice.installPeerForResearch(DmPeerContext(userId: bob.identity.userId, deviceId: bob.identity.deviceId,
            identityKeyId: bob.identity.identityKeyId, curve: bob.identity.curve, prekey: bob.identity.prekey,
            generation: 1, status: .accepted), owner: p.aliceOwner)
        // Explicit CLOSED trusted-decision fixture, not authenticated HTTP.
        // Remove unrelated missing-enrollment denial before testing acquisition
        // of policy authority for an incomplete legacy public identity.
        guard case .registrationRequest(let wire) = try dmPairingHistoryExecute(p.alice, .relayRegistrationWire) else {
            throw DmPairingHistoryProbeError.assertion("legacy native enrollment fixture")
        }
        let identity = try p.alice.publicIdentity(owner: p.aliceOwner)
        let acknowledgement = try dmScopedEnrollmentJSON(["registered": true, "userId": identity.userId, "deviceId": identity.deviceId])
        _ = try dmPairingHistoryExecute(p.alice, .relayRegistrationResponse(wire: wire, response: acknowledgement))
        let before = try p.aliceStore.read()
        let state = try dmPairingHistoryState(p.alice, peerGeneration: 1)
        try checks.require(state.status == .legacyUnverified && state.peerGeneration == 1 && state.confirmedFingerprint == nil,
            "partial legacy peer is never labelled fingerprint-confirmed")
        try checks.refuses("confirm cannot silently upgrade an existing partial legacy pin") {
            _ = try dmPairingHistoryConfirm(p.alice, card: bob)
        }
        try checks.coordinator(.unavailable, "registered legacy partial pin cannot acquire current policy authority") {
            _ = try dmPairingHistoryExecute(p.alice, .relayPolicyWire)
        }
        try checks.refuses("legacy partial pin and unknown policy jointly refuse pilot preparation") {
            _ = try dmPairingHistoryPrepare(p.alice, id: "legacy-unverified", text: "fixture legacy draft", peerGeneration: 1)
        }
        try checks.require(try p.aliceStore.read() == before, "legacy refusals preserve identity ratchet and sealed revision")
    }
}

private func dmPairingHistoryOldOutbox(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let paired = try dmPairingHistoryConfirm(p.alice, card: dmPairingHistoryCard(p.bob))
        guard let generation = paired.peerGeneration else {
            throw DmPairingHistoryProbeError.assertion("old outbox fixture native peer generation")
        }
        try dmPairingHistoryReady(p, aliceGeneration: generation)
        let text = "fixture optional old outgoing text"
        let record = try dmPairingHistoryPrepare(p.alice, id: "old-outbox", text: text, peerGeneration: generation)
        let snapshot = try p.aliceStore.read()
        guard var fields = try JSONSerialization.jsonObject(with: snapshot.payload) as? [String: Any],
              var outbox = fields["outbox"] as? [[String: Any]], outbox.count == 1 else {
            throw DmPairingHistoryProbeError.assertion("old outbox fixture sealed shape")
        }
        // Simulate only the two absent optional fields of an old authenticated
        // native snapshot. Retain its full pairing pin, ciphertext and digest.
        outbox[0].removeValue(forKey: "text")
        outbox[0].removeValue(forKey: "localCreatedAtMillis")
        fields["outbox"] = outbox
        _ = try p.aliceStore.commit(expectedRevision: snapshot.revision,
            payload: JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]))
        let legacy = try p.aliceStore.read()
        let reopened = try VodozemacSealedStore.reopen(directory: p.aliceStore.databaseURL.deletingLastPathComponent(),
            storeID: p.aliceStore.storeID)
        defer { reopened.close() }
        let restored = try VodozemacDmCoordinator(store: reopened)
        try dmPairingHistoryPolicy(restored)
        let readyLegacy = try reopened.read()
        let missing = try dmPairingHistoryMessage(dmPairingHistoryThread(restored, peerGeneration: generation),
            id: "old-outbox", direction: .outgoing)
        try checks.require(missing.text == nil && missing.localCreatedAtMillis == nil && missing.delivery == .pending,
            "optional old outgoing fields remain absent rather than fabricated on read")
        guard case .pendingRecords(let pending) = try dmPairingHistoryExecute(restored, .pendingRecords,
            peerGeneration: generation) else {
            throw DmPairingHistoryProbeError.assertion("closed dispatcher pending-records result")
        }
        try checks.require(pending == [record], "old pending ciphertext remains available for exact retry")
        try checks.require(try dmPairingHistoryPrepare(restored, id: "old-outbox", text: text,
            peerGeneration: generation) == record, "old pending retry never recreates ciphertext")
        let retried = try dmPairingHistoryMessage(dmPairingHistoryThread(restored, peerGeneration: generation),
            id: "old-outbox", direction: .outgoing)
        try checks.require(retried == missing, "old pending retry does not manufacture historical text or time")
        try checks.require(readyLegacy.payload == legacy.payload,
            "explicit reopened policy query does not alter optional legacy outgoing fields")
        try checks.require(try reopened.read() == readyLegacy, "optional-field reads and exact retry leave ready sealed revision unchanged")
    }
}

private func dmPairingHistoryPeerGeneration(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let paired = try dmPairingHistoryConfirm(p.alice, card: dmPairingHistoryCard(p.bob))
        guard let generation = paired.peerGeneration else {
            throw DmPairingHistoryProbeError.assertion("peer-history fixture native generation")
        }
        try dmPairingHistoryReady(p, aliceGeneration: generation)
        _ = try dmPairingHistoryPrepare(p.alice, id: "peer-historical", text: "fixture historical peer draft",
            peerGeneration: generation)
        let stale = try dmPairingHistoryContext(p.alice, peerGeneration: generation)
        _ = try p.alice.setPeerStatusForResearch(.blocked, owner: p.aliceOwner)
        let current = try p.alice.setPeerStatusForResearch(.accepted, owner: p.aliceOwner)
        let snapshot = try p.aliceStore.read()
        try checks.coordinator(.unavailable, "old peer generation cannot expose native thread") {
            _ = try p.alice.executeMessageOperation(.thread, context: stale, checkAuthority: {})
        }
        let thread = try dmPairingHistoryThread(p.alice, peerGeneration: current)
        try checks.require(thread.peerGeneration == current && thread.messages.isEmpty,
            "current peer generation hides historical pending plaintext")
        let counts = try dmPairingHistoryState(p.alice, peerGeneration: current)
        try checks.require(counts.outgoingCount == 0 && counts.incomingCount == 0 && counts.unresolvedCount == 0,
            "pairing counters cannot leak historical peer-generation counts")
        try checks.require(try p.aliceStore.read() == snapshot, "peer-generation filtering never erases historical records")
    }
}

private func dmPairingHistoryCapacity(_ checks: DmPairingHistoryChecks) throws {
    try dmPairingHistoryFixture { p in
        let ac = try dmPairingHistoryCard(p.alice), bc = try dmPairingHistoryCard(p.bob)
        let a = try dmPairingHistoryConfirm(p.alice, card: bc), b = try dmPairingHistoryConfirm(p.bob, card: ac)
        guard let ag = a.peerGeneration, let bg = b.peerGeneration else {
            throw DmPairingHistoryProbeError.assertion("capacity fixture native peer generations")
        }
        try dmPairingHistoryReady(p, aliceGeneration: ag)
        var first: DmOutboxRecord?
        for index in 0..<16 {
            if index > 0 && index % 4 == 0 {
                // Explicit trusted fixture-query boundaries keep this provider
                // capacity test independent of host load; no gate is bypassed.
                try dmPairingHistoryPolicy(p.alice)
                try dmPairingHistoryPolicy(p.bob)
            }
            let at = "fixture bounded outgoing \(index)", bt = "fixture bounded reply \(index)"
            let sent = try dmPairingHistoryPrepare(p.alice, id: "capacity-a-\(index)", text: at, peerGeneration: ag)
            if index == 0 { first = sent }
            try dmPairingHistoryReceive(p.bob, record: sent, owner: p.bobOwner, peerGeneration: bg, text: at, checks: checks)
            let reply = try dmPairingHistoryPrepare(p.bob, id: "capacity-b-\(index)", text: bt, peerGeneration: bg)
            try dmPairingHistoryReceive(p.alice, record: reply, owner: p.aliceOwner, peerGeneration: ag, text: bt, checks: checks)
        }
        for (coordinator, generation) in [(p.alice, ag), (p.bob, bg)] {
            let thread = try dmPairingHistoryThread(coordinator, peerGeneration: generation)
            try checks.require(thread.messages.filter { $0.direction == .outgoing }.count == 16
                && thread.messages.filter { $0.direction == .incoming }.count == 16,
                "current thread contains no more than sixteen messages in each direction")
            let counts = try dmPairingHistoryState(coordinator, peerGeneration: generation)
            try checks.require(counts.outgoingCount == 16 && counts.incomingCount == 16 && counts.unresolvedCount == 0,
                "bounded pairing counters match current real-provider ledger")
        }
        let before = try p.aliceStore.read()
        try checks.coordinator(.capacity, "seventeenth outgoing preparation fails closed") {
            _ = try dmPairingHistoryPrepare(p.alice, id: "capacity-overflow", text: "fixture overflow", peerGeneration: ag)
        }
        try checks.require(try p.aliceStore.read() == before, "capacity refusal does not evict history or advance ratchet")
        guard let initial = first else { throw DmPairingHistoryProbeError.assertion("capacity fixture opening") }
        let bobBefore = try p.bobStore.read()
        guard case .duplicate = try p.bob.receive(initial.serializedEnvelope, owner: p.bobOwner, peerGeneration: bg,
            credentialEpoch: p.bob.lifecycleForResearch().credentialEpoch) else {
            throw DmPairingHistoryProbeError.assertion("full inbox exact retry remains duplicate")
        }
        try checks.require(try p.bobStore.read() == bobBefore, "full inbox duplicate does not allocate or invent a second receive")
    }
}

/// Parent's isolated runner may call this; this file does not alter any runner.
/// The returned count is meaningful only after that native execution succeeds.
func runDmPairingHistoryProbe() throws -> Int {
    let checks = DmPairingHistoryChecks()
    try dmPairingHistoryBinding(checks)
    try dmPairingHistoryMessages(checks)
    try dmPairingHistoryLegacy(checks)
    try dmPairingHistoryOldOutbox(checks)
    try dmPairingHistoryPeerGeneration(checks)
    try dmPairingHistoryCapacity(checks)
    return checks.assertions
}
