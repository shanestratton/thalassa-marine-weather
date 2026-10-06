// ISOLATED Foundation adapter fixtures. Synthetic URLProtocol Auth/relay,
// real native provider/Directory/Facade/Keychain-sealed stores. No Capacitor
// runtime, hosted deployment, physical phone, SIGKILL/power-loss or audit proof.
// Restart fixtures close/reopen real sealed state in the SAME test process.
// Reuses narrowly prefixed disposable enrollment fixture/cleanup helpers only.
import Foundation
import CryptoKit

enum DmResearchBridgeProbeError: Error { case assertion(String) }

private final class DmResearchBridgeChecks {
    private(set) var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmResearchBridgeProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch ResearchMessagingAdapterError.unavailable { assertions += 1; return }
        throw DmResearchBridgeProbeError.assertion(label)
    }
    func refusesAsync(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch ResearchMessagingAdapterError.unavailable { assertions += 1; return }
        throw DmResearchBridgeProbeError.assertion(label)
    }
    func dto(_ value: [String: Any], keys: Set<String>, status: String, binding: String) throws {
        try require(Set(value.keys) == keys, "bridge DTO has exact public fields")
        try require(value["status"] as? String == status, "bridge DTO status is the operation's declared status")
        try require(value["credentialBinding"] as? String == binding, "bridge DTO echoes original accepted binding only")
        try require(JSONSerialization.isValidJSONObject(value), "bridge DTO is JSON-safe without native handles")
    }
}

private let dmResearchBridgeStateKeys: Set<String> = ["status", "credentialBinding", "pairing", "role", "fingerprint",
    "registration", "claim", "policy"]
private let dmResearchBridgeClear = DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: false,
    blockedByMe: false, blockedByPeer: false)

private func dmResearchBridgeAdapter(_ actor: DmScopedEnrollmentActor) throws -> ResearchMessagingAdapter {
    let transport = try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
        configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmScopedEnrollmentProtocol.self]
            return configuration
        })
    return ResearchMessagingAdapter(facade: actor.facade, transport: transport,
        projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
}
private func dmResearchBridgeCanonical(_ card: DmPairingCard) throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let wire = String(data: try encoder.encode(card), encoding: .utf8) else {
        throw DmResearchBridgeProbeError.assertion("bridge canonical public fixture card")
    }
    return wire
}
private func dmResearchBridgeRecord(_ actor: DmScopedEnrollmentActor, id: String) throws -> DmOutboxRecord {
    // Raw native records are fixture inputs ONLY, never adapter/JS output.
    guard case .pendingRecords(let records) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(peer: true),
        operation: .pendingRecords) else { throw DmResearchBridgeProbeError.assertion("bridge fixture native pending records") }
    for record in records {
        if try DmEnvelope.decode(record.serializedEnvelope).clientMessageId == id { return record }
    }
    throw DmResearchBridgeProbeError.assertion("bridge fixture exact pending id")
}
private func dmResearchBridgeThreadRow(_ value: [String: Any], id: String, direction: String) throws -> [String: Any] {
    guard let rows = value["messages"] as? [[String: Any]],
          let row = rows.first(where: { $0["clientMessageId"] as? String == id && $0["direction"] as? String == direction }) else {
        throw DmResearchBridgeProbeError.assertion("bridge fixture exact committed thread row")
    }
    return row
}
private func dmResearchBridgeReceipt(_ record: DmOutboxRecord, rejected: Bool = false) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmResearchBridgeProbeError.assertion("bridge fixture receipt fields")
    }
    fields["accepted"] = !rejected
    if rejected { fields["reason"] = "blocked" }
    return try dmScopedEnrollmentJSON(fields)
}
private func dmResearchBridgeInbox(_ record: DmOutboxRecord, serverId: Int = 1) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmResearchBridgeProbeError.assertion("bridge fixture inbox fields")
    }
    fields["accepted"] = true; fields["serverId"] = serverId
    return try JSONSerialization.data(withJSONObject: [fields], options: [.sortedKeys, .withoutEscapingSlashes])
}
private func dmResearchBridgePolicy(_ actor: DmScopedEnrollmentActor, adapter: ResearchMessagingAdapter,
                                   checks: DmResearchBridgeChecks) async throws {
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
    let value = try await adapter.refreshPolicy(credentialBinding: actor.account.credentialBinding).publish()
    try checks.dto(value, keys: ["status", "credentialBinding", "policy"], status: "policy", binding: actor.account.credentialBinding)
    guard let flags = value["policy"] as? [String: Any] else { throw DmResearchBridgeProbeError.assertion("bridge policy public flags") }
    try checks.require(Set(flags.keys) == ["ownerRevoked", "peerRevoked", "blockedByMe", "blockedByPeer"]
        && flags.values.allSatisfy({ ($0 as? Bool) == false }), "bridge policy retains exact diagnostic booleans")
    let captures = DmScopedEnrollmentProtocol.captured()
    try checks.require(captures.count == 1, "explicit bridge policy query makes exactly one synthetic HTTP request")
    let frame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: captures[0].body)
    try checks.require(frame.action == "policy" && frame.userId == actor.account.accountId
        && frame.deviceId == actor.account.deviceId, "bridge policy request derives native owner and action")
    DmScopedEnrollmentProtocol.setScripts([])
}
private func dmResearchBridgeSendRace(_ actor: DmScopedEnrollmentActor, adapter: ResearchMessagingAdapter,
                                     logout: Bool, checks: DmResearchBridgeChecks) async throws {
    try await dmResearchBridgePolicy(actor, adapter: adapter, checks: checks)
    let id = logout ? "10000000-0000-4000-8000-000000000008" : "10000000-0000-4000-8000-000000000007"
    let originalBinding = actor.account.credentialBinding
    _ = try adapter.prepareText(credentialBinding: originalBinding, clientMessageId: id, text: "bridge held auth fixture").publish()
    let record = try dmResearchBridgeRecord(actor, id: id)
    let beforePublication = try adapter.thread(credentialBinding: originalBinding)
    let gate = DmScopedEnrollmentGate()
    defer { gate.release() }
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(record), gate: gate)])
    let task = Task { try await adapter.sendPending(credentialBinding: originalBinding, clientMessageId: id) }
    do {
        try await dmScopedEnrollmentAwait { gate.arrived() }
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1, "bridge race actually dispatched before auth transition")
        if logout { _ = try actor.facade.fenceSession(mode: .signOut) }
        else { try await actor.renew() }
        let winner = try actor.store.read()
        gate.release()
        try await checks.refusesAsync("late relay success cannot publish under old bridge binding") {
            let result = try await task.value; _ = try result.publish()
        }
        try checks.require(gate.releasedWithoutTimeout(), "bridge race gate was explicitly released without timeout")
        try checks.require(try actor.store.read() == winner, "late bridge completion cannot rewrite winner sealed state")
        try checks.refuses("captured plaintext view cannot publish after original auth lease is invalidated") {
            _ = try beforePublication.publish()
        }
        try checks.refuses("old bridge binding cannot capture a new state snapshot") {
            _ = try adapter.messageState(credentialBinding: originalBinding).publish()
        }
        if logout {
            try checks.require(actor.facade.currentAccount() == nil, "late bridge response never revives signed-out native account")
        } else {
            let state = try adapter.messageState(credentialBinding: actor.account.credentialBinding).publish()
            try checks.dto(state, keys: dmResearchBridgeStateKeys, status: "state", binding: actor.account.credentialBinding)
            try checks.require(actor.account.credentialBinding != originalBinding && state["policy"] is NSNull,
                "renewal positive control has new binding and no silently refreshed policy")
            let view = try adapter.thread(credentialBinding: actor.account.credentialBinding).publish()
            let rows = view["messages"] as? [[String: Any]] ?? []
            try checks.require(rows.contains { $0["clientMessageId"] as? String == id && $0["delivery"] as? String == "pending" },
                "auth-renewal refusal preserves exact pending record visible under genuinely new lease")
        }
    } catch {
        task.cancel(); gate.release(); _ = await task.result
        throw error
    }
}

private func dmResearchBridgeContinuityPayload(_ snapshot: VodozemacSealedStore.Snapshot,
                                             excludingCredentialEpoch: Bool = true) throws -> Data {
    guard var state = try JSONSerialization.jsonObject(with: snapshot.payload) as? [String: Any] else {
        throw DmResearchBridgeProbeError.assertion("bridge continuity exact sealed payload comparison")
    }
    if excludingCredentialEpoch {
        guard state.removeValue(forKey: "credentialEpoch") != nil else {
            throw DmResearchBridgeProbeError.assertion("bridge continuity sealed credential epoch")
        }
    }
    return try dmScopedEnrollmentJSON(state)
}

private func dmResearchBridgeContinue(_ actor: DmScopedEnrollmentActor, adapter: ResearchMessagingAdapter,
                                     checks: DmResearchBridgeChecks) async throws -> DmScopedEnrollmentActor {
    let binding = actor.account.credentialBinding, original = try actor.snapshot(peer: true)
    let heldThread = try adapter.thread(credentialBinding: binding)
    let before = try dmResearchBridgeContinuityPayload(actor.store.read())
    actor.fixture.directory.closeForResearch() // Fixture teardown, NOT durable logout.
    let directory = try actor.fixture.reopen(auth: dmScopedEnrollmentAuth())
    let facade = VodozemacSessionFacade(directory: directory)
    let coldAdapter = ResearchMessagingAdapter(facade: facade,
        transport: try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
            configurationForResearch: {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [DmScopedEnrollmentProtocol.self]
                return configuration
            }), projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
    DmScopedEnrollmentProtocol.setScripts([])
    try checks.require(facade.currentAccount() == nil, "cold facade restores no bearer or accepted account lease")
    try checks.refuses("cold adapter cannot use a previous credential binding before fresh Auth") {
        _ = try coldAdapter.thread(credentialBinding: binding).publish()
    }
    let fence = try facade.fenceSession(mode: .verify)
    try checks.require(actor.facade.currentMessageContext(snapshot: original) == nil,
        "closed old scope is unavailable before continuation Auth response")
    try checks.refuses("captured old plaintext cannot publish after cold scope invalidation") { _ = try heldThread.publish() }
    let account = try await facade.authenticate(accessToken: actor.bearer, authFence: fence.authFence)
    let continued = try DmScopedEnrollmentActor(fixture: actor.fixture, facade: facade, account: account,
        bearer: actor.bearer, card: actor.card)
    continued.peerGeneration = actor.peerGeneration
    let current = try continued.snapshot(peer: true)
    try checks.require(account.accountId == actor.account.accountId && account.deviceId == actor.account.deviceId
        && account.credentialBinding != binding && current.context.ownerGeneration == original.context.ownerGeneration
        && current.context.peerGeneration == original.context.peerGeneration
        && current.context.credentialEpoch != original.context.credentialEpoch,
        "fresh continuation changes credential binding/epoch only, not owner/device/peer generations")
    try checks.require(try dmResearchBridgeContinuityPayload(continued.store.read()) == before,
        "cold reserve and verified continuation preserve every sealed ratchet/message/enrollment field except credential epoch")
    let state = try coldAdapter.messageState(credentialBinding: account.credentialBinding).publish()
    try checks.dto(state, keys: dmResearchBridgeStateKeys, status: "state", binding: account.credentialBinding)
    try checks.require(state["registration"] as? String == "acknowledged" && state["pairing"] as? String == "confirmed"
        && state["policy"] is NSNull && DmScopedEnrollmentProtocol.captured().isEmpty,
        "authenticated continuation retains public enrollment facts but restores no policy or relay HTTP")
    try checks.refuses("fresh continuation cannot recapture a previous facade's binding") {
        _ = try coldAdapter.messageState(credentialBinding: binding).publish()
    }
    try await checks.refusesAsync("cold receive requires an explicit new policy query") {
        _ = try await coldAdapter.syncInbox(credentialBinding: account.credentialBinding).publish()
    }
    try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty,
        "policy-free cold receive refuses without HTTP or silent policy refresh")
    let thread = try coldAdapter.thread(credentialBinding: account.credentialBinding).publish()
    try checks.require((thread["messages"] as? [[String: Any]])?.contains { $0["delivery"] as? String == "received" } == true,
        "fresh same-generation authority can read provider-authenticated pre-restart local history")
    return continued
}

func runDmResearchBridgeProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmResearchBridgeChecks()
    var fixtures: [DmScopedEnrollmentFixture] = []
    DmScopedEnrollmentProtocol.reset()
    defer { DmScopedEnrollmentProtocol.reset() }
    do {
        progressForResearch?("bridge-public-card")
        let first = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(first)
        let second = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(second)
        let a = try await dmScopedEnrollmentLogin(first, userId: "50000000-0000-4000-8000-000000000001", bearer: "bridge-fixture-a")
        let b = try await dmScopedEnrollmentLogin(second, userId: "60000000-0000-4000-8000-000000000002", bearer: "bridge-fixture-b")
        let aa = try dmResearchBridgeAdapter(a), ba = try dmResearchBridgeAdapter(b)
        let initial = try aa.messageState(credentialBinding: a.account.credentialBinding).publish()
        try checks.dto(initial, keys: dmResearchBridgeStateKeys, status: "state", binding: a.account.credentialBinding)
        try checks.require(initial["pairing"] as? String == "unpaired" && initial["role"] as? String == "unpaired"
            && initial["registration"] as? String == "none" && initial["claim"] as? String == "none"
            && initial["fingerprint"] is NSNull && initial["policy"] is NSNull, "unpaired public facts do not fabricate readiness or allow")
        let own = try aa.pairingCard(credentialBinding: a.account.credentialBinding).publish()
        try checks.dto(own, keys: ["status", "credentialBinding", "card", "fingerprint"], status: "pairing_card", binding: a.account.credentialBinding)
        let aw = try dmResearchBridgeCanonical(a.card), bw = try dmResearchBridgeCanonical(b.card)
        let af = try a.card.fingerprint(), bf = try b.card.fingerprint()
        try checks.require(own["card"] as? String == aw && own["fingerprint"] as? String == af,
            "bridge own card matches real native public identity and full fingerprint")
        let before = try a.store.read()
        guard var extra = try JSONSerialization.jsonObject(with: Data(bw.utf8)) as? [String: Any] else {
            throw DmResearchBridgeProbeError.assertion("bridge fixture peer card object")
        }
        extra["ignored"] = "must-refuse"
        guard let extraWire = String(data: try dmScopedEnrollmentJSON(extra), encoding: .utf8) else {
            throw DmResearchBridgeProbeError.assertion("bridge fixture extra-key card encoding")
        }
        let duplicate = "{\"conversationId\":" + (try DmRelayCodec.quote(b.card.conversationId)) + "," + String(bw.dropFirst())
        let alias = bw.replacingOccurrences(of: "\"conversationId\"", with: "\"conversation\\u0049d\"")
        let routed = DmPairingCard(projectOrigin: "https://wrong-bridge.invalid", conversationId: b.card.conversationId, identity: b.card.identity)
        let wrongConversation = DmPairingCard(projectOrigin: b.card.projectOrigin, conversationId: "wrong-conversation", identity: b.card.identity)
        for invalid in [aw, " " + bw, extraWire, duplicate, alias, try dmResearchBridgeCanonical(routed),
                        try dmResearchBridgeCanonical(wrongConversation), "{", String(repeating: "x", count: 4097)] {
            try checks.refuses("noncanonical duplicate extra alias own oversized or wrong-route peer card refuses") {
                _ = try aa.inspectPeerCard(credentialBinding: a.account.credentialBinding, card: invalid).publish()
            }
            try checks.require(try a.store.read() == before && DmScopedEnrollmentProtocol.captured().isEmpty,
                "invalid public card neither pins peer nor dispatches or mutates native state")
        }
        let inspected = try aa.inspectPeerCard(credentialBinding: a.account.credentialBinding, card: bw).publish()
        try checks.dto(inspected, keys: ["status", "credentialBinding", "card", "fingerprint"], status: "peer_card", binding: a.account.credentialBinding)
        try checks.require(try inspected["fingerprint"] as? String == bf && a.store.read() == before,
            "valid peer inspection computes full public fingerprint without mutation")
        try checks.refuses("human-confirmation fingerprint mismatch cannot pin") {
            _ = try aa.confirmPeer(credentialBinding: a.account.credentialBinding, card: bw,
                confirmedFingerprint: bf == String(repeating: "0", count: 64)
                    ? String(repeating: "1", count: 64) : String(repeating: "0", count: 64)).publish()
        }
        try checks.require(try a.store.read() == before, "wrong fingerprint leaves exact sealed native state unchanged")
        for (actor, adapter, card) in [(a, aa, bw), (b, ba, aw)] {
            let peer = actor === a ? b.card : a.card
            let expectedFingerprint = try peer.fingerprint()
            let state = try adapter.confirmPeer(credentialBinding: actor.account.credentialBinding, card: card,
                confirmedFingerprint: expectedFingerprint).publish()
            try checks.dto(state, keys: dmResearchBridgeStateKeys, status: "state", binding: actor.account.credentialBinding)
            try checks.require(state["pairing"] as? String == "confirmed" && state["fingerprint"] as? String == expectedFingerprint,
                "explicit full OOB confirmation seals native peer identity")
            guard case .pairingState(let native) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(), operation: .pairingState) else {
                throw DmResearchBridgeProbeError.assertion("bridge fixture confirmed native peer generation")
            }
            actor.peerGeneration = native.peerGeneration // Fixture-only; never a JS argument.
        }
        var initiator = a.account.deviceId < b.account.deviceId ? a : b
        var responder = initiator === a ? b : a
        var ia = initiator === a ? aa : ba, ra = responder === a ? aa : ba
        try checks.require(initiator.account.deviceId < responder.account.deviceId,
            "bridge roles derive from distinct native ASCII device identities")
        let openingID = "10000000-0000-4000-8000-000000000001"
        let beforeUnregistered = try initiator.store.read()
        try checks.refuses("unregistered adapter preparation refuses before mutation") {
            _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID, text: "opening").publish()
        }
        try checks.require(try initiator.store.read() == beforeUnregistered && DmScopedEnrollmentProtocol.captured().isEmpty,
            "unregistered prepare does not manufacture registration claim policy or ciphertext")

        progressForResearch?("bridge-enrollment-policy")
        var responderWire: String?
        for (actor, adapter) in [(initiator, ia), (responder, ra)] {
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/register", result: try dmScopedEnrollmentAck(actor.card.identity))])
            let state = try await adapter.registerDevice(credentialBinding: actor.account.credentialBinding).publish()
            try checks.dto(state, keys: dmResearchBridgeStateKeys, status: "state", binding: actor.account.credentialBinding)
            try checks.require(state["registration"] as? String == "acknowledged", "bridge registers exact existing native device explicitly")
            let captures = DmScopedEnrollmentProtocol.captured()
            try checks.require(captures.count == 1, "bridge registration makes exactly one synthetic request")
            guard let wire = String(data: captures[0].body, encoding: .utf8) else { throw DmResearchBridgeProbeError.assertion("bridge registered bundle fixture") }
            let verified = try DmRelayCodec.verifyBundle(wire, now: Int64(Date().timeIntervalSince1970))
            try checks.require(verified.signingKey == actor.card.identity.signingKey && verified.curveKey == actor.card.identity.curve
                && verified.prekey == actor.card.identity.prekey && verified.userId == actor.account.accountId,
                "synthetic registration acknowledged genuine provider/public pinned bundle")
            if actor === responder { responderWire = wire }
            DmScopedEnrollmentProtocol.setScripts([])
            _ = try await adapter.registerDevice(credentialBinding: actor.account.credentialBinding).publish()
            try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "cached registration does not recreate keys or redispatch")
        }
        try await dmResearchBridgePolicy(initiator, adapter: ia, checks: checks)
        let beforeNoClaim = try initiator.store.read()
        try checks.refuses("registered initiator with genuine clear policy still needs verified initial claim") {
            _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID, text: "opening").publish()
        }
        try checks.require(try initiator.store.read() == beforeNoClaim && DmScopedEnrollmentProtocol.captured().isEmpty,
            "missing-claim refusal is isolated with valid registration and policy")
        try await checks.refusesAsync("upper-device responder cannot claim even with its own registration") {
            let result = try await ra.claimPeer(credentialBinding: responder.account.credentialBinding); _ = try result.publish()
        }
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "wrong-role claim is refused before relay dispatch")
        guard let responderWire else { throw DmResearchBridgeProbeError.assertion("bridge responder bundle positive control") }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmScopedEnrollmentClaimResult(responderWire))])
        let claimed = try await ia.claimPeer(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.dto(claimed, keys: dmResearchBridgeStateKeys, status: "state", binding: initiator.account.credentialBinding)
        try checks.require(claimed["claim"] as? String == "verified" && DmScopedEnrollmentProtocol.captured().count == 1,
            "lower-device bridge claim verifies exact already-confirmed peer bundle")
        try await dmResearchBridgePolicy(initiator, adapter: ia, checks: checks)
        try await dmResearchBridgePolicy(responder, adapter: ra, checks: checks)

        progressForResearch?("bridge-thread-send-receive")
        let prepared = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID,
            text: "real provider bridge opening").publish()
        try checks.dto(prepared, keys: ["status", "credentialBinding", "clientMessageId"], status: "prepared", binding: initiator.account.credentialBinding)
        let opening = try dmResearchBridgeRecord(initiator, id: openingID), preparedSnapshot = try initiator.store.read()
        for invalidID in ["not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] {
            try checks.refuses("JS message id is canonical UUID idempotency input only") {
                _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding,
                    clientMessageId: invalidID, text: "invalid id").publish()
            }
        }
        for invalidText in [" \n\t", String(repeating: "x", count: DmContentCodec.maxTextBytes + 1)] {
            try checks.refuses("text-only bridge rejects empty and oversized input before encryption") {
                _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding,
                    clientMessageId: "10000000-0000-4000-8000-000000000099", text: invalidText).publish()
            }
        }
        try checks.require(try initiator.store.read() == preparedSnapshot && DmScopedEnrollmentProtocol.captured().isEmpty,
            "invalid native bridge text/id cannot mutate prepared state or dispatch")
        _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID,
            text: "real provider bridge opening").publish()
        try checks.require(try initiator.store.read() == preparedSnapshot, "same ID same text replay is byte-identical durable preparation")
        try checks.refuses("same message id cannot be rebound to a different plaintext") {
            _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID, text: "changed").publish()
        }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(opening))])
        let sent = try await ia.sendPending(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID).publish()
        try checks.dto(sent, keys: ["status", "credentialBinding", "clientMessageId", "decision", "reason"], status: "send_result", binding: initiator.account.credentialBinding)
        try checks.require(sent["decision"] as? String == "server_accepted" && sent["reason"] is NSNull,
            "accepted bridge outcome does not claim recipient delivery or read")
        DmScopedEnrollmentProtocol.setScripts([])
        _ = try await ia.sendPending(credentialBinding: initiator.account.credentialBinding, clientMessageId: openingID).publish()
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "exact terminal acceptance reconciles without HTTP")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(opening))])
        let synced = try await ra.syncInbox(credentialBinding: responder.account.credentialBinding).publish()
        try checks.dto(synced, keys: ["status", "credentialBinding", "stored", "duplicates", "historical", "unresolved", "historicalUnresolved"],
            status: "inbox_result", binding: responder.account.credentialBinding)
        try checks.require(synced["stored"] as? Int == 1 && synced["unresolved"] as? Int == 0,
            "registered responder receives real prekey opening without initiating a claim")
        let view = try ra.thread(credentialBinding: responder.account.credentialBinding).publish()
        try checks.dto(view, keys: ["status", "credentialBinding", "messages", "unresolvedCount", "outgoingCapacity", "incomingCapacity"],
            status: "thread", binding: responder.account.credentialBinding)
        guard let rows = view["messages"] as? [[String: Any]], let incoming = rows.first else {
            throw DmResearchBridgeProbeError.assertion("bridge committed plaintext thread positive control")
        }
        try checks.require(Set(incoming.keys) == ["clientMessageId", "direction", "text", "delivery", "reason", "localCreatedAtMillis", "envelopeSha256"],
            "thread projects exact public row and envelope fingerprint without raw encrypted native record")
        try checks.require(incoming["text"] as? String == "real provider bridge opening" && incoming["direction"] as? String == "incoming"
            && incoming["delivery"] as? String == "received" && incoming["reason"] is NSNull && incoming["localCreatedAtMillis"] is NSNull,
            "received thread text is provider-authenticated with no invented read or sender timestamp")
        let openingSha256 = SHA256.hash(data: Data(opening.serializedEnvelope.utf8)).map { String(format: "%02x", $0) }.joined()
        try checks.require(incoming["envelopeSha256"] as? String == openingSha256,
            "received bridge fingerprint hashes exact saved envelope UTF-8 bytes")
        try checks.require(view["outgoingCapacity"] as? Int == 16 && view["incomingCapacity"] as? Int == 16,
            "research thread exposes bounded native capacities honestly")

        // Established responder replies through the SAME adapter, without any
        // raw provider/session bypass or invented responder prekey claim.
        try await dmResearchBridgePolicy(responder, adapter: ra, checks: checks)
        try await dmResearchBridgePolicy(initiator, adapter: ia, checks: checks)
        let replyID = "10000000-0000-4000-8000-000000000002"
        _ = try ra.prepareText(credentialBinding: responder.account.credentialBinding, clientMessageId: replyID,
            text: "real provider bridge reply").publish()
        let reply = try dmResearchBridgeRecord(responder, id: replyID)
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(reply))])
        let replySent = try await ra.sendPending(credentialBinding: responder.account.credentialBinding, clientMessageId: replyID).publish()
        try checks.require(replySent["decision"] as? String == "server_accepted", "established responder bridge can send provider-authenticated reply")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(reply))])
        let replyInbox = try await ia.syncInbox(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require(replyInbox["stored"] as? Int == 1, "initiator bridge commits bounded responder reply")
        let replyView = try ia.thread(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require((replyView["messages"] as? [[String: Any]])?.contains {
            $0["clientMessageId"] as? String == replyID && $0["text"] as? String == "real provider bridge reply"
                && $0["delivery"] as? String == "received"
        } == true, "second direction plaintext is exposed only from guarded committed native history")

        progressForResearch?("bridge-cold-continuity")
        try await dmResearchBridgePolicy(responder, adapter: ra, checks: checks)
        let restartID = "10000000-0000-4000-8000-000000000003"
        _ = try ra.prepareText(credentialBinding: responder.account.credentialBinding, clientMessageId: restartID,
            text: "exact pending restart fixture").publish()
        let restartRecord = try dmResearchBridgeRecord(responder, id: restartID), beforeLoss = try responder.store.read()
        let restartSha256 = SHA256.hash(data: Data(restartRecord.serializedEnvelope.utf8)).map { String(format: "%02x", $0) }.joined()
        let pendingView = try ra.thread(credentialBinding: responder.account.credentialBinding).publish()
        let pendingRow = try dmResearchBridgeThreadRow(pendingView, id: restartID, direction: "outgoing")
        try checks.require(pendingRow["delivery"] as? String == "pending" && pendingRow["envelopeSha256"] as? String == restartSha256,
            "pending bridge fingerprint derives from committed envelope before restart")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(restartRecord), loseAfterBody: true)])
        try await checks.refusesAsync("synthetic accepted body followed by response loss stays unresolved, never fabricated refusal") {
            _ = try await ra.sendPending(credentialBinding: responder.account.credentialBinding, clientMessageId: restartID).publish()
        }
        let lostCaptures = DmScopedEnrollmentProtocol.captured()
        let afterLoss = try responder.store.read()
        try checks.require(try lostCaptures.count == 1 && afterLoss.revision == beforeLoss.revision + 1
            && dmResearchBridgeContinuityPayload(afterLoss, excludingCredentialEpoch: false)
                == dmResearchBridgeContinuityPayload(beforeLoss, excludingCredentialEpoch: false)
            && dmResearchBridgeRecord(responder, id: restartID) == restartRecord,
            "request signing advances sealed revision only; actual response loss preserves every pending/ratchet/credential field")
        let lostFrame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: lostCaptures[0].body)
        initiator = try await dmResearchBridgeContinue(initiator, adapter: ia, checks: checks)
        ia = try dmResearchBridgeAdapter(initiator)
        responder = try await dmResearchBridgeContinue(responder, adapter: ra, checks: checks)
        ra = try dmResearchBridgeAdapter(responder)
        try checks.require(try dmResearchBridgeRecord(responder, id: restartID) == restartRecord,
            "cold exact-ID retry uses byte-identical original ciphertext and immutable record")
        let restoredView = try ra.thread(credentialBinding: responder.account.credentialBinding).publish()
        let restoredRow = try dmResearchBridgeThreadRow(restoredView, id: restartID, direction: "outgoing")
        try checks.require(restoredRow["delivery"] as? String == "pending" && restoredRow["envelopeSha256"] as? String == restartSha256,
            "cold pending bridge fingerprint matches exact pre-restart envelope")
        try await checks.refusesAsync("cold pending send cannot silently acquire a new policy permit") {
            _ = try await ra.sendPending(credentialBinding: responder.account.credentialBinding, clientMessageId: restartID).publish()
        }
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty,
            "cold pending send policy refusal makes zero HTTP")
        try await dmResearchBridgePolicy(responder, adapter: ra, checks: checks)
        try await dmResearchBridgePolicy(initiator, adapter: ia, checks: checks)
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(restartRecord))])
        let retried = try await ra.sendPending(credentialBinding: responder.account.credentialBinding, clientMessageId: restartID).publish()
        try checks.require(retried["decision"] as? String == "server_accepted", "same pending ID settles after fresh continuation and explicit policy")
        let retryCaptures = DmScopedEnrollmentProtocol.captured()
        try checks.require(retryCaptures.count == 1, "continued pending send dispatched exactly once")
        let retryFrame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: retryCaptures[0].body)
        try checks.require(lostFrame.action == "send" && retryFrame.action == "send" && retryFrame.payload == lostFrame.payload
            && retryFrame.requestId != lostFrame.requestId,
            "continued exact ciphertext retry signs a fresh native outer nonce, not new encrypted content")
        let acceptedView = try ra.thread(credentialBinding: responder.account.credentialBinding).publish()
        let acceptedRow = try dmResearchBridgeThreadRow(acceptedView, id: restartID, direction: "outgoing")
        try checks.require(acceptedRow["delivery"] as? String == "serverAccepted" && acceptedRow["envelopeSha256"] as? String == restartSha256,
            "terminal acceptance retains original committed envelope fingerprint")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(restartRecord, serverId: 2))])
        let continuedInbox = try await ia.syncInbox(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require(continuedInbox["stored"] as? Int == 1, "reopened initiator decrypts responder's exact pending successor")
        let receivedView = try ia.thread(credentialBinding: initiator.account.credentialBinding).publish()
        let receivedRow = try dmResearchBridgeThreadRow(receivedView, id: restartID, direction: "incoming")
        try checks.require(receivedRow["delivery"] as? String == "received" && receivedRow["envelopeSha256"] as? String == restartSha256,
            "received bridge fingerprint matches original pending and accepted envelope")
        let successorID = "10000000-0000-4000-8000-000000000004"
        _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: successorID,
            text: "post-restart bidirectional successor").publish()
        let successor = try dmResearchBridgeRecord(initiator, id: successorID)
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(successor))])
        _ = try await ia.sendPending(credentialBinding: initiator.account.credentialBinding, clientMessageId: successorID).publish()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(successor, serverId: 2))])
        let successorInbox = try await ra.syncInbox(credentialBinding: responder.account.credentialBinding).publish()
        let successorView = try ra.thread(credentialBinding: responder.account.credentialBinding).publish()
        try checks.require(successorInbox["stored"] as? Int == 1 && (successorView["messages"] as? [[String: Any]])?.contains {
            $0["clientMessageId"] as? String == successorID && $0["text"] as? String == "post-restart bidirectional successor"
        } == true, "reopened responder decrypts newly prepared opposite-direction successor through guarded adapter")

        progressForResearch?("bridge-peer-publication-races")
        try await dmResearchBridgePolicy(responder, adapter: ra, checks: checks)
        let heldBinding = responder.account.credentialBinding
        let heldThread = try ra.thread(credentialBinding: heldBinding)
        let heldID = "10000000-0000-4000-8000-000000000009"
        let heldPrepared = try ra.prepareText(credentialBinding: heldBinding, clientMessageId: heldID,
            text: "prepared peer-publication fixture")
        let heldRecord = try dmResearchBridgeRecord(responder, id: heldID)
        try checks.require(try DmEnvelope.decode(heldRecord.serializedEnvelope).clientMessageId == heldID
            && heldRecord.ownerUserId == responder.account.accountId,
            "held prepared result follows genuine durable provider preparation, before any publication")
        let originalOwner = try responder.snapshot().context
        let fixtureOwner = DmOwnerContext(userId: originalOwner.userId, deviceId: originalOwner.deviceId,
            generation: originalOwner.ownerGeneration)
        guard let originalPeerGeneration = responder.peerGeneration else {
            throw DmResearchBridgeProbeError.assertion("bridge original confirmed fixture peer generation")
        }
        var previousPeerGeneration = originalPeerGeneration
        let unchangedFingerprint = try initiator.card.fingerprint()
        DmScopedEnrollmentProtocol.setScripts([])
        for status in [DmPeerStatus.blocked, .accepted] {
            // FIXTURE-ONLY lifecycle mutation. No adapter/plugin control can
            // replace, block, revoke or restore a peer, nor receive this owner.
            let generation = try responder.coordinator.setPeerStatusForResearch(status, owner: fixtureOwner)
            responder.peerGeneration = generation
            try checks.require(generation == previousPeerGeneration + 1,
                "fixture peer status transition advances exact native generation")
            previousPeerGeneration = generation
            let winner = try responder.store.read()
            for held in [heldThread, heldPrepared] {
                try checks.refuses("captured plaintext/prepared result remains unpublishable after peer block and reaccept") {
                    _ = try held.publish()
                }
                try checks.require(try responder.store.read() == winner,
                    "refused old peer publication preserves exact winner sealed revision and payload")
            }
            let state = try ra.messageState(credentialBinding: heldBinding).publish()
            try checks.dto(state, keys: dmResearchBridgeStateKeys, status: "state", binding: heldBinding)
            let expectedPairing = status == .blocked ? "blocked" : "confirmed"
            try checks.require(state["pairing"] as? String == expectedPairing
                && state["fingerprint"] as? String == unchangedFingerprint
                && state["registration"] as? String == "acknowledged" && state["claim"] as? String == "none"
                && state["policy"] is NSNull,
                "current owner-only setup facts stay readable while old peer results fail and old policy is unusable")
            try checks.require(responder.facade.currentAccount() == responder.account,
                "peer publication refusal is not caused by stale or unavailable native Auth")
            try checks.require(try responder.store.read() == winner && DmScopedEnrollmentProtocol.captured().isEmpty,
                "current state/Auth positive controls neither mutate winner nor make HTTP or refresh policy")
        }

        // Negative send settlement retains owner-only publication, but NEVER
        // plaintext or a successful acceptance bypass after policy invalidation.
        try await dmResearchBridgePolicy(initiator, adapter: ia, checks: checks)
        let refusalID = "10000000-0000-4000-8000-000000000006"
        _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: refusalID, text: "terminal refusal fixture").publish()
        let refusedRecord = try dmResearchBridgeRecord(initiator, id: refusalID), refusalGate = DmScopedEnrollmentGate()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmResearchBridgeReceipt(refusedRecord, rejected: true), gate: refusalGate)])
        let refusalTask = Task { try await ia.sendPending(credentialBinding: initiator.account.credentialBinding, clientMessageId: refusalID) }
        do {
            try await dmScopedEnrollmentAwait { refusalGate.arrived() }
            _ = try initiator.facade.executeMessageOperation(snapshot: initiator.snapshot(), operation: .invalidateRelayPolicy)
            refusalGate.release()
            let refusal = try await refusalTask.value.publish()
            try checks.dto(refusal, keys: ["status", "credentialBinding", "clientMessageId", "decision", "reason"], status: "send_result", binding: initiator.account.credentialBinding)
            try checks.require(refusal["decision"] as? String == "rejected" && refusal["reason"] as? String == "blocked",
                "strict terminal refusal publishes outcome only under captured original owner after policy loss")
            try checks.require(refusalGate.releasedWithoutTimeout(), "rejection gate was explicitly released without timeout")
        } catch { refusalTask.cancel(); refusalGate.release(); _ = await refusalTask.result; throw error }
        let localWithoutPolicy = try ia.thread(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require((localWithoutPolicy["messages"] as? [[String: Any]])?.contains {
            $0["clientMessageId"] as? String == refusalID && $0["delivery"] as? String == "rejected"
        } == true, "guarded local thread remains readable without current relay policy")
        DmScopedEnrollmentProtocol.setScripts([])
        try await checks.refusesAsync("inbox without explicit refreshed policy refuses rather than auto-refresh") {
            let result = try await ia.syncInbox(credentialBinding: initiator.account.credentialBinding); _ = try result.publish()
        }
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "missing-policy sync performs no HTTP or automatic query")

        progressForResearch?("bridge-original-binding-races")
        try await dmResearchBridgeSendRace(initiator, adapter: ia, logout: false, checks: checks)
        try await dmResearchBridgeSendRace(initiator, adapter: ia, logout: true, checks: checks)
        for fixture in fixtures { try fixture.destroy() }
        try checks.require(fixtures.allSatisfy { !FileManager.default.fileExists(atPath: $0.root.path) },
            "bridge disposable native fixture files and Keychain namespaces cleaned exactly")
        progressForResearch?("bridge-complete")
        return checks.assertions
    } catch {
        for fixture in fixtures { try? fixture.destroy() }
        throw error
    }
}

// Distinct checks keep the original research-adapter refusal expectations
// strict. These fixtures exercise the new ordinary-PM projection specifically.
private final class DmResearchPrivateMessageChecks {
    private(set) var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmResearchBridgeProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch ResearchPrivateMessageAdapterError.unavailable { assertions += 1; return }
        throw DmResearchBridgeProbeError.assertion(label)
    }
    func refusesAsync(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch ResearchPrivateMessageAdapterError.unavailable { assertions += 1; return }
        throw DmResearchBridgeProbeError.assertion(label)
    }
    func nativeRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { assertions += 1; return }
        throw DmResearchBridgeProbeError.assertion(label)
    }
    func ready(_ dto: [String: Any], actor: DmScopedEnrollmentActor) throws -> String {
        try require(Set(dto.keys) == ["status", "authority", "supportedContent"], "PM readiness exact public DTO")
        try require(dto["status"] as? String == "ready" && dto["supportedContent"] as? [String] == ["text"],
            "PM readiness declares native text-only surface")
        guard let authority = dto["authority"] as? [String: Any], let version = authority["lifecycleVersion"] as? String else {
            throw DmResearchBridgeProbeError.assertion("PM readiness native descriptor")
        }
        try require(Set(authority.keys) == ["accountId", "deviceId", "lifecycleVersion", "serverVerified"],
            "PM authority has no binding credentials generations or native handles")
        try require(authority["accountId"] as? String == actor.account.accountId
            && authority["deviceId"] as? String == actor.account.deviceId && authority["serverVerified"] as? Bool == true,
            "PM authority owner and device derive from server-verified native scope")
        try require(UUID(uuidString: version)?.uuidString.lowercased() == version
            && version != actor.account.credentialBinding, "PM lifecycle token is native UUID distinct from account binding")
        return version
    }
    func value(_ dto: [String: Any], actor: DmScopedEnrollmentActor, version: String) throws -> [String: Any] {
        try operation(dto, actor: actor, version: version)
        guard let value = dto["value"] as? [String: Any] else {
            throw DmResearchBridgeProbeError.assertion("PM operation structured public value")
        }
        return value
    }
    func operation(_ dto: [String: Any], actor: DmScopedEnrollmentActor, version: String) throws {
        try require(Set(dto.keys) == ["status", "authority", "value"] && dto["status"] as? String == "ok",
            "PM operation exact success wrapper")
        guard let authority = dto["authority"] as? [String: Any] else {
            throw DmResearchBridgeProbeError.assertion("PM operation native authority")
        }
        try require(Set(authority.keys) == ["accountId", "deviceId", "lifecycleVersion", "serverVerified"]
            && authority["accountId"] as? String == actor.account.accountId
            && authority["deviceId"] as? String == actor.account.deviceId
            && authority["lifecycleVersion"] as? String == version && authority["serverVerified"] as? Bool == true,
            "PM success retains exact original full-pair authority")
        try require(JSONSerialization.isValidJSONObject(dto), "PM success is JSON-safe with no native capabilities")
    }
    func message(_ value: [String: Any], id: String, direction: String, text: String,
                 owner: DmScopedEnrollmentActor, peer: DmScopedEnrollmentActor, delivery: String) throws {
        try require(Set(value.keys) == ["id", "clientMessageId", "direction", "senderAccountId", "recipientAccountId",
            "senderName", "text", "localCreatedAtMillis", "read", "delivery", "reason"],
            "PM message exposes only exact bounded rendering fields")
        try require(value["id"] as? String == direction + ":" + id
            && value["clientMessageId"] as? String == id && value["direction"] as? String == direction,
            "PM rendering identity is direction-scoped canonical client UUID")
        try require(value["senderAccountId"] as? String == (direction == "outgoing" ? owner.account.accountId : peer.account.accountId)
            && value["recipientAccountId"] as? String == (direction == "outgoing" ? peer.account.accountId : owner.account.accountId),
            "PM committed message routing derives from native owner and paired peer")
        try require(value["text"] as? String == text && value["delivery"] as? String == delivery,
            "PM committed plaintext and outcome match actual provider record")
        try require(value["read"] as? Bool == false, "PM relay/local outcome never invents reading")
        if direction == "incoming" {
            try require(value["localCreatedAtMillis"] is NSNull, "PM incoming sender time remains unknown")
        } else {
            try require((value["localCreatedAtMillis"] as? Int64).map { $0 > 0 } == true,
                "PM outgoing time is genuine sealed local creation metadata")
        }
        try require(delivery == "rejected" ? value["reason"] as? String == "blocked" : value["reason"] is NSNull,
            "PM terminal reason matches rejection only")
    }
}

private func dmResearchPrivateMessageAdapter(_ actor: DmScopedEnrollmentActor) throws -> ResearchPrivateMessageAdapter {
    let transport = try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
        configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmScopedEnrollmentProtocol.self]
            return configuration
        })
    return ResearchPrivateMessageAdapter(facade: actor.facade, transport: transport)
}
private func dmResearchPrivateMessageThread(_ adapter: ResearchPrivateMessageAdapter, actor: DmScopedEnrollmentActor,
                                          peer: DmScopedEnrollmentActor, version: String,
                                          checks: DmResearchPrivateMessageChecks) throws -> [String: Any] {
    let value = try checks.value(adapter.thread(lifecycleVersion: version, peerAccountId: peer.account.accountId).publish(),
        actor: actor, version: version)
    try checks.require(Set(value.keys) == ["peerAccountId", "messages", "permissions", "unresolvedCount", "pendingAttemptId"],
        "PM thread exact public fields preserve pending reconciliation")
    try checks.require(value["peerAccountId"] as? String == peer.account.accountId,
        "PM thread identifies only the native paired sailor")
    guard let rows = value["messages"] as? [[String: Any]], let permissions = value["permissions"] as? [String: Any],
          let unresolved = value["unresolvedCount"] as? Int else {
        throw DmResearchBridgeProbeError.assertion("PM thread bounded native history")
    }
    try checks.require(rows.count <= 32 && rows.filter { $0["direction"] as? String == "outgoing" }.count <= 16
        && rows.filter { $0["direction"] as? String == "incoming" }.count <= 16 && (0...16).contains(unresolved),
        "PM history respects actual per-direction native capacity and unresolved bound")
    try checks.require(Set(rows.compactMap { $0["id"] as? String }).count == rows.count,
        "PM history preserves unique direction-scoped rendering identifiers")
    try checks.require(Set(permissions.keys) == ["peerAccountId", "blockedByMe", "blockedEitherDirection", "canSend", "reason"]
        && permissions["peerAccountId"] as? String == peer.account.accountId,
        "PM permissions remain exact current native diagnostics")
    return value
}
private func dmResearchPrivateMessageSendCapture(_ actor: DmScopedEnrollmentActor,
                                               checks: DmResearchPrivateMessageChecks) throws -> DmOutboxRecord {
    let captures = DmScopedEnrollmentProtocol.captured()
    try checks.require(captures.count == 2, "PM send explicitly queries policy then sends once")
    let frames = try captures.map { try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: $0.body) }
    try checks.require(frames.map { $0.action } == ["policy", "send"],
        "PM send has no hidden registration claim polling or second send")
    let record = try dmScopedEnrollmentSendRecord(captures[1].body, authenticatedUserId: actor.account.accountId,
        signingKey: actor.card.identity.signingKey)
    try checks.require(record.ownerUserId == actor.account.accountId,
        "PM send wire canonical ownership and genuine provider signature independently verify")
    return record
}
private func dmResearchPrivateMessageRace(_ actor: DmScopedEnrollmentActor, peer: DmScopedEnrollmentActor,
                                        adapter: ResearchPrivateMessageAdapter, version: String,
                                        checks: DmResearchPrivateMessageChecks) async throws -> (String, DmOutboxRecord) {
    let id = "21000000-0000-4000-8000-000000000006"
    let heldReady = try adapter.readiness(lifecycleVersion: version)
    let heldThread = try adapter.thread(lifecycleVersion: version, peerAccountId: peer.account.accountId)
    let gate = DmScopedEnrollmentGate(); defer { gate.release() }
    DmScopedEnrollmentProtocol.setScripts([
        .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
        .init(path: "/v1/dispatch", gate: gate, echoSendAccepted: true, sendSigningKey: actor.card.identity.signingKey),
    ])
    let task = Task { try await adapter.sendText(lifecycleVersion: version, peerAccountId: peer.account.accountId,
        clientMessageId: id, text: "PM delayed original lease") }
    do {
        try await dmScopedEnrollmentAwait { gate.arrived() }
        let submitted = try dmResearchPrivateMessageSendCapture(actor, checks: checks)
        try checks.require(try submitted == dmResearchBridgeRecord(actor, id: id),
            "PM delayed send reaches HTTP only after exact durable preparation")
        try await actor.renew()
        let winner = try actor.store.read()
        gate.release()
        try await checks.refusesAsync("PM held successful relay reply cannot commit or publish after native Auth renewal") {
            _ = try await task.value.publish()
        }
        try checks.require(gate.releasedWithoutTimeout(), "PM held send released explicitly before fixture timeout")
        try checks.require(try actor.store.read() == winner, "PM late send cannot rewrite winning renewed sealed payload or revision")
        try checks.refuses("PM cached readiness retains original lease across Auth renewal") { _ = try heldReady.publish() }
        try checks.refuses("PM cached plaintext thread retains original lease across Auth renewal") { _ = try heldThread.publish() }
        try checks.refuses("PM old lifecycle cannot capture new ready owner") { _ = try adapter.readiness(lifecycleVersion: version).publish() }
        let fresh = try checks.ready(adapter.issue(credentialBinding: actor.account.credentialBinding).publish(), actor: actor)
        try checks.require(fresh != version, "PM genuine renewed owner receives a different native lifecycle descriptor")
        let thread = try dmResearchPrivateMessageThread(adapter, actor: actor, peer: peer, version: fresh, checks: checks)
        try checks.require(thread["pendingAttemptId"] as? String == id,
            "PM winner renewal leaves original unresolved attempt available for exact reconciliation")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: true, sendSigningKey: actor.card.identity.signingKey),
        ])
        let retried = try await adapter.retryPending(lifecycleVersion: fresh, peerAccountId: peer.account.accountId, clientMessageId: id).publish()
        _ = try checks.value(retried, actor: actor, version: fresh)
        let retry = try dmResearchPrivateMessageSendCapture(actor, checks: checks)
        try checks.require(retry == submitted, "PM post-renewal explicit retry transmits unchanged original encrypted record")
        return (fresh, retry)
    } catch { task.cancel(); gate.release(); _ = await task.result; throw error }
}

/// Synthetic Auth/relay, but real provider encryption/decryption and sealed
/// native authority. This is NOT physical-device, hosted-exchange or audit proof.
func runDmResearchPrivateMessageProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmResearchPrivateMessageChecks()
    var fixtures: [DmScopedEnrollmentFixture] = []
    DmScopedEnrollmentProtocol.reset(); defer { DmScopedEnrollmentProtocol.reset() }
    do {
        progressForResearch?("pm-native-descriptor")
        let first = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(first)
        let second = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(second)
        let a = try await dmScopedEnrollmentLogin(first, userId: "51000000-0000-4000-8000-000000000001", bearer: "pm-fixture-a")
        let b = try await dmScopedEnrollmentLogin(second, userId: "61000000-0000-4000-8000-000000000002", bearer: "pm-fixture-b")
        let aa = try dmResearchBridgeAdapter(a), ba = try dmResearchBridgeAdapter(b)
        let ap = try dmResearchPrivateMessageAdapter(a), bp = try dmResearchPrivateMessageAdapter(b)
        let initial = try a.store.read()
        try checks.refuses("PM account authentication without full confirmed peer is unavailable") {
            _ = try ap.issue(credentialBinding: a.account.credentialBinding).publish()
        }
        try checks.refuses("PM unknown account binding cannot select a native owner") {
            _ = try ap.issue(credentialBinding: "21000000-0000-4000-8000-000000000099").publish()
        }
        try checks.require(try a.store.read() == initial && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM pre-pair readiness failures mutate no sealed state or relay")
        for (actor, adapter, peer) in [(a, aa, b), (b, ba, a)] {
            let paired = try adapter.confirmPeer(credentialBinding: actor.account.credentialBinding,
                card: dmResearchBridgeCanonical(peer.card), confirmedFingerprint: peer.card.fingerprint()).publish()
            try checks.require(paired["pairing"] as? String == "confirmed", "PM setup requires explicit genuine public-card confirmation")
            guard case .pairingState(let native) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(), operation: .pairingState) else {
                throw DmResearchBridgeProbeError.assertion("PM fixture confirmed generation")
            }
            actor.peerGeneration = native.peerGeneration
        }
        let initiator = a.account.deviceId < b.account.deviceId ? a : b
        let responder = initiator === a ? b : a
        let ia = initiator === a ? aa : ba, ra = responder === a ? aa : ba
        let ip = initiator === a ? ap : bp, rp = responder === a ? ap : bp
        var iv = try checks.ready(ip.issue(credentialBinding: initiator.account.credentialBinding).publish(), actor: initiator)
        var rv = try checks.ready(rp.issue(credentialBinding: responder.account.credentialBinding).publish(), actor: responder)
        let repeatReady = try ip.issue(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require((repeatReady["authority"] as? [String: Any])?["lifecycleVersion"] as? String == iv,
            "PM repeated issue keeps stable token for unchanged original owner and full pair")
        let unchanged = try initiator.store.read()
        try checks.refuses("PM invented lifecycle descriptor cannot read") {
            _ = try ip.readiness(lifecycleVersion: "21000000-0000-4000-8000-000000000099").publish()
        }
        try checks.refuses("PM noncanonical lifecycle aliases refuse") {
            _ = try ip.readiness(lifecycleVersion: iv.uppercased() == iv ? iv + " " : iv.uppercased()).publish()
        }
        try checks.refuses("PM paired thread cannot be redirected to third account") {
            _ = try ip.thread(lifecycleVersion: iv, peerAccountId: "71000000-0000-4000-8000-000000000003").publish()
        }
        try await checks.refusesAsync("PM wrong peer fails before policy or preparation") {
            _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: initiator.account.accountId,
                clientMessageId: "21000000-0000-4000-8000-000000000001", text: "self unsupported").publish()
        }
        try checks.require(try initiator.store.read() == unchanged && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM rejected tokens and peer routing make no mutation or HTTP")
        let empty = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.require((empty["messages"] as? [[String: Any]])?.isEmpty == true && empty["pendingAttemptId"] is NSNull,
            "PM authenticated empty native history invents no rows or pending attempt")
        try checks.require((empty["permissions"] as? [String: Any])?["canSend"] as? Bool == false,
            "PM paired account readiness does not imply registered/claimed send readiness")
        try checks.require(try initiator.store.read() == unchanged && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM local history needs no relay call and changes no sealed state")

        progressForResearch?("pm-explicit-setup")
        var responderBundle: String?
        for (actor, adapter) in [(initiator, ia), (responder, ra)] {
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/register", result: try dmScopedEnrollmentAck(actor.card.identity))])
            let registered = try await adapter.registerDevice(credentialBinding: actor.account.credentialBinding).publish()
            try checks.require(registered["registration"] as? String == "acknowledged", "PM setup registration is explicit and exact native acknowledgement")
            let captures = DmScopedEnrollmentProtocol.captured()
            try checks.require(captures.count == 1, "PM explicit registration makes one bounded synthetic request")
            guard let wire = String(data: captures[0].body, encoding: .utf8) else { throw DmResearchBridgeProbeError.assertion("PM genuine bundle wire") }
            let verified = try DmRelayCodec.verifyBundle(wire, now: Int64(Date().timeIntervalSince1970))
            try checks.require(verified.userId == actor.account.accountId && verified.deviceId == actor.account.deviceId
                && verified.signingKey == actor.card.identity.signingKey && verified.curveKey == actor.card.identity.curve,
                "PM setup verifies genuine provider public bundle independently")
            if actor === responder { responderBundle = wire }
        }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        let missingClaim = try await ip.permissions(lifecycleVersion: iv, peerAccountId: responder.account.accountId).publish()
        let missingValue = try checks.value(missingClaim, actor: initiator, version: iv)
        try checks.require(missingValue["canSend"] as? Bool == false && missingValue["reason"] as? String == "unavailable",
            "PM fresh clear policy still refuses initiator before genuine native claim")
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1,
            "PM permissions explicitly refresh policy without implicit claim")
        guard let responderBundle else { throw DmResearchBridgeProbeError.assertion("PM registered responder bundle") }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmScopedEnrollmentClaimResult(responderBundle))])
        let claimed = try await ia.claimPeer(credentialBinding: initiator.account.credentialBinding).publish()
        try checks.require(claimed["claim"] as? String == "verified" && DmScopedEnrollmentProtocol.captured().count == 1,
            "PM initiator's explicit claim matches already pinned provider keys")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        let allowedResult = try await ip.permissions(lifecycleVersion: iv, peerAccountId: responder.account.accountId)
        let allowed = try allowedResult.publish()
        let allowedValue = try checks.value(allowed, actor: initiator, version: iv)
        try checks.require(allowedValue["canSend"] as? Bool == true && allowedValue["reason"] is NSNull,
            "PM canSend comes from current real native registration claim and ephemeral readiness guard")
        _ = try initiator.facade.executeMessageOperation(snapshot: initiator.snapshot(), operation: .invalidateRelayPolicy)
        DmScopedEnrollmentProtocol.setScripts([])
        let noPermit = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.require((noPermit["permissions"] as? [String: Any])?["canSend"] as? Bool == false,
            "PM missing current permit refuses despite earlier verified clear flags")
        let republished = try checks.value(allowedResult.publish(), actor: initiator, version: iv)
        try checks.require(republished["canSend"] as? Bool == false && republished["reason"] as? String == "unavailable",
            "PM delayed permission publication rechecks actual native guard rather than retaining prior allow")
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "PM missing-permit local reads never silently refresh permission")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        let waiting = try await rp.permissions(lifecycleVersion: rv, peerAccountId: initiator.account.accountId).publish()
        try checks.require(try checks.value(waiting, actor: responder, version: rv)["canSend"] as? Bool == false,
            "PM responder cannot initiate before receiving the real opening")
        DmScopedEnrollmentProtocol.setScripts([])
        let beforeInvalid = try initiator.store.read()
        for invalid in [" ", "bad\0text", "📍PIN|1|2|unsupported", "🍳RECIPE:unsupported", String(repeating: "x", count: 4_001)] {
            try await checks.refusesAsync("PM native text boundary refuses blank NUL structured-share and oversized content") {
                _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                    clientMessageId: "21000000-0000-4000-8000-000000000001", text: invalid).publish()
            }
        }
        try checks.require(try initiator.store.read() == beforeInvalid && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM unsupported content has no policy HTTP encryption or native commit")

        progressForResearch?("pm-real-send-receive")
        progressForResearch?("pm-opening-send")
        let openingID = "21000000-0000-4000-8000-000000000001"
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: true, sendSigningKey: initiator.card.identity.signingKey),
        ])
        let openingDTO = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
            clientMessageId: openingID, text: "PM provider encrypted opening").publish()
        let openingValue = try checks.value(openingDTO, actor: initiator, version: iv)
        try checks.message(openingValue, id: openingID, direction: "outgoing", text: "PM provider encrypted opening",
            owner: initiator, peer: responder, delivery: "server_accepted")
        let opening = try dmResearchPrivateMessageSendCapture(initiator, checks: checks)
        try checks.require(try DmEnvelope.decode(opening.serializedEnvelope).clientMessageId == openingID,
            "PM adapter actually prepared a real native encrypted envelope for the new UUID")
        try checks.require(!opening.serializedEnvelope.contains("PM provider encrypted opening")
            && !String(decoding: DmScopedEnrollmentProtocol.captured()[1].body, as: UTF8.self).contains("PM provider encrypted opening"),
            "PM synthetic relay captures ciphertext only rather than the rendering plaintext")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(opening)),
        ])
        progressForResearch?("pm-opening-receive")
        let inbox = try await rp.inbox(lifecycleVersion: rv).publish()
        try checks.operation(inbox, actor: responder, version: rv)
        guard let conversations = inbox["value"] as? [[String: Any]], conversations.count == 1 else {
            throw DmResearchBridgeProbeError.assertion("PM one-peer inbox projection")
        }
        try checks.require(Set(conversations[0].keys) == ["peerAccountId", "displayName", "lastText",
            "lastLocalCreatedAtMillis", "unreadCount", "historyAvailable"], "PM inbox has exact honest public fields")
        try checks.require(conversations[0]["peerAccountId"] as? String == initiator.account.accountId
            && conversations[0]["lastText"] as? String == "PM provider encrypted opening"
            && conversations[0]["lastLocalCreatedAtMillis"] is NSNull
            && conversations[0]["unreadCount"] as? Int == 0 && conversations[0]["historyAvailable"] as? Bool == true,
            "PM inbox projects only committed decrypted native history without invented time or unread receipts")
        let receiveFrames = try DmScopedEnrollmentProtocol.captured().map { try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: $0.body) }
        try checks.require(receiveFrames.map { $0.action } == ["policy", "list"], "PM receive performs one fresh policy query and one bounded native inbox scan")
        DmScopedEnrollmentProtocol.setScripts([])
        let received = try dmResearchPrivateMessageThread(rp, actor: responder, peer: initiator, version: rv, checks: checks)
        let incoming = try dmResearchBridgeThreadRow(received, id: openingID, direction: "incoming")
        try checks.message(incoming, id: openingID, direction: "incoming", text: "PM provider encrypted opening",
            owner: responder, peer: initiator, delivery: "received")
        try checks.require((received["permissions"] as? [String: Any])?["canSend"] as? Bool == true,
            "PM responder reply becomes native-ready only after actual provider opening establishes session")

        // UUID uniqueness is scoped by direction, not guessed across accounts.
        progressForResearch?("pm-directional-reply")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: true, sendSigningKey: responder.card.identity.signingKey),
        ])
        let replyDTO = try await rp.sendText(lifecycleVersion: rv, peerAccountId: initiator.account.accountId,
            clientMessageId: openingID, text: "PM responder same UUID").publish()
        let replyValue = try checks.value(replyDTO, actor: responder, version: rv)
        try checks.message(replyValue, id: openingID, direction: "outgoing", text: "PM responder same UUID",
            owner: responder, peer: initiator, delivery: "server_accepted")
        let reply = try dmResearchPrivateMessageSendCapture(responder, checks: checks)
        let bothDirections = try dmResearchPrivateMessageThread(rp, actor: responder, peer: initiator, version: rv, checks: checks)
        let collisionRows = bothDirections["messages"] as? [[String: Any]] ?? []
        try checks.require(collisionRows.count == 2 && Set(collisionRows.compactMap { $0["clientMessageId"] as? String }) == [openingID]
            && Set(collisionRows.compactMap { $0["id"] as? String }) == ["incoming:" + openingID, "outgoing:" + openingID],
            "PM same UUID from opposite actors preserves both committed rows without identity collision")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(reply)),
        ])
        _ = try await ip.inbox(lifecycleVersion: iv).publish()
        let initiatorBoth = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.message(dmResearchBridgeThreadRow(initiatorBoth, id: openingID, direction: "incoming"),
            id: openingID, direction: "incoming", text: "PM responder same UUID", owner: initiator, peer: responder, delivery: "received")
        progressForResearch?("pm-mixed-history-preview")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(reply)),
        ])
        let mixedInbox = try await ip.inbox(lifecycleVersion: iv).publish()
        try checks.operation(mixedInbox, actor: initiator, version: iv)
        guard let mixedRows = mixedInbox["value"] as? [[String: Any]], mixedRows.count == 1 else {
            throw DmResearchBridgeProbeError.assertion("PM mixed-history inbox row")
        }
        try checks.require(mixedRows[0]["lastText"] is NSNull && mixedRows[0]["lastLocalCreatedAtMillis"] is NSNull
            && mixedRows[0]["historyAvailable"] as? Bool == true,
            "PM grouped incoming/outgoing lanes do not invent latest conversation activity")

        // Authenticated sealed legacy fixture has no saved plaintext/local time.
        // The projection must preserve absence; it must not echo an input draft.
        progressForResearch?("pm-legacy-missing-content")
        let beforeLegacy = try initiator.store.read()
        try await dmScopedEnrollmentSealedFixture(initiator, replacing: { fields in
            guard var rows = fields["outbox"] as? [[String: Any]],
                  let index = rows.firstIndex(where: { $0["messageId"] as? String == openingID }) else {
                throw DmResearchBridgeProbeError.assertion("PM bounded legacy outgoing fixture")
            }
            rows[index].removeValue(forKey: "text")
            rows[index].removeValue(forKey: "localCreatedAtMillis")
            fields["outbox"] = rows
        }, operation: {
            DmScopedEnrollmentProtocol.setScripts([])
            let legacy = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
            let row = try dmResearchBridgeThreadRow(legacy, id: openingID, direction: "outgoing")
            try checks.require(row["text"] is NSNull && row["localCreatedAtMillis"] is NSNull,
                "PM legacy committed row preserves unknown plaintext and time")
            try checks.require(row["delivery"] as? String == "server_accepted" && row["read"] as? Bool == false,
                "PM absent content cannot fabricate delivery or reading beyond saved acceptance")
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
            let terminal = try await ip.retryPending(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: openingID).publish()
            let terminalValue = try checks.value(terminal, actor: initiator, version: iv)
            try checks.require(terminalValue["text"] is NSNull && terminalValue["localCreatedAtMillis"] is NSNull,
                "PM exact-ID terminal reconciliation accepts no replacement caller plaintext")
            try checks.require(DmScopedEnrollmentProtocol.captured().count == 1,
                "PM legacy terminal exact-ID reconciliation makes no ciphertext upload or preparation")
        })
        try checks.require(try initiator.store.read().payload == beforeLegacy.payload,
            "PM temporary sealed legacy fixture restores exact original provider payload")

        progressForResearch?("pm-uncertain-exact-retry")
        let uncertainID = "21000000-0000-4000-8000-000000000002"
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", loseAfterBody: true, echoSendAccepted: true, sendSigningKey: initiator.card.identity.signingKey),
        ])
        try await checks.refusesAsync("PM response loss after accepted synthetic body remains unresolved") {
            _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: uncertainID, text: "PM durable uncertain attempt").publish()
        }
        let uncertain = try dmResearchPrivateMessageSendCapture(initiator, checks: checks)
        try checks.require(try uncertain == dmResearchBridgeRecord(initiator, id: uncertainID),
            "PM lost response retains exactly the submitted durable ciphertext")
        let pendingView = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.require(pendingView["pendingAttemptId"] as? String == uncertainID,
            "PM thread exposes the real pending ID after uncertainty")
        try checks.message(dmResearchBridgeThreadRow(pendingView, id: uncertainID, direction: "outgoing"),
            id: uncertainID, direction: "outgoing", text: "PM durable uncertain attempt", owner: initiator, peer: responder, delivery: "pending")
        let pendingSnapshot = try initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        try await checks.refusesAsync("PM other new ID cannot replace an unresolved native preparation") {
            _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: "21000000-0000-4000-8000-000000000099", text: "replacement must fail").publish()
        }
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1,
            "PM pending replacement refusal performs only explicit policy refresh and never sends")
        try checks.require(try initiator.store.read() == pendingSnapshot && dmResearchBridgeRecord(initiator, id: uncertainID) == uncertain,
            "PM replacement refusal cannot alter ratchet pending ID or ciphertext")
        try checks.nativeRefuses("PM closed native preparation also atomically refuses another pending ID") {
            _ = try initiator.facade.executeMessageOperation(snapshot: initiator.snapshot(peer: true),
                operation: .privateMessagePrepareText(clientMessageId: "21000000-0000-4000-8000-000000000098", text: "atomic replacement"))
        }
        try checks.require(try initiator.store.read() == pendingSnapshot, "PM lexical single-pending guard shares exact preparation sealed snapshot")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: true, sendSigningKey: initiator.card.identity.signingKey),
        ])
        let retried = try await ip.retryPending(lifecycleVersion: iv, peerAccountId: responder.account.accountId, clientMessageId: uncertainID).publish()
        let retryValue = try checks.value(retried, actor: initiator, version: iv)
        try checks.message(retryValue, id: uncertainID, direction: "outgoing", text: "PM durable uncertain attempt",
            owner: initiator, peer: responder, delivery: "server_accepted")
        try checks.require(try dmResearchPrivateMessageSendCapture(initiator, checks: checks) == uncertain,
            "PM retry without JS plaintext retransmits unchanged native record")
        let settled = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.require(settled["pendingAttemptId"] is NSNull, "PM validated terminal receipt clears pending diagnostic")
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        _ = try await ip.retryPending(lifecycleVersion: iv, peerAccountId: responder.account.accountId, clientMessageId: uncertainID).publish()
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1,
            "PM already accepted exact ID reconciles locally without another upload")
        DmScopedEnrollmentProtocol.setScripts([])
        let acceptedSnapshot = try initiator.store.read()
        try await checks.refusesAsync("PM unknown retry ID never prepares or refreshes policy") {
            _ = try await ip.retryPending(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: "21000000-0000-4000-8000-000000000099").publish()
        }
        try checks.require(try initiator.store.read() == acceptedSnapshot && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM unknown retry is a zero-mutation zero-HTTP refusal")

        let rejectedID = "21000000-0000-4000-8000-000000000003"
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: false, sendSigningKey: initiator.card.identity.signingKey),
        ])
        let rejected = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
            clientMessageId: rejectedID, text: "PM terminal rejected attempt").publish()
        try checks.message(checks.value(rejected, actor: initiator, version: iv), id: rejectedID, direction: "outgoing",
            text: "PM terminal rejected attempt", owner: initiator, peer: responder, delivery: "rejected")
        _ = try dmResearchPrivateMessageSendCapture(initiator, checks: checks)
        let terminalSnapshot = try initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        try await checks.refusesAsync("PM same native ID with different caller plaintext cannot masquerade as success") {
            _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: rejectedID, text: "different plaintext").publish()
        }
        try checks.require(try initiator.store.read() == terminalSnapshot && DmScopedEnrollmentProtocol.captured().count == 1,
            "PM content conflict performs no replacement encryption or upload")

        progressForResearch?("pm-exact-unicode-bytes")
        let unicodeID = "21000000-0000-4000-8000-000000000008"
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", echoSendAccepted: true, sendSigningKey: initiator.card.identity.signingKey),
        ])
        _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
            clientMessageId: unicodeID, text: "Caf\u{00e9}").publish()
        let unicodeRecord = try dmResearchPrivateMessageSendCapture(initiator, checks: checks)
        let unicodeSnapshot = try initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        try await checks.refusesAsync("PM same-ID canonically equivalent but different UTF-8 plaintext refuses before upload") {
            _ = try await ip.sendText(lifecycleVersion: iv, peerAccountId: responder.account.accountId,
                clientMessageId: unicodeID, text: "Cafe\u{0301}").publish()
        }
        try checks.require(try initiator.store.read() == unicodeSnapshot && DmScopedEnrollmentProtocol.captured().count == 1,
            "PM exact-byte Unicode conflict preserves complete sealed state and performs only policy query")
        try checks.require(try DmEnvelope.decode(unicodeRecord.serializedEnvelope).clientMessageId == unicodeID,
            "PM Unicode fixture has an actual provider-encrypted committed original ID")

        progressForResearch?("pm-ambiguous-pending-fails-closed")
        // Existing research permits multiple attempts; the ordinary projection
        // must refuse rather than guess a priority or create a replacement.
        let multipleIDs = ["21000000-0000-4000-8000-000000000004", "21000000-0000-4000-8000-000000000005"]
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
        _ = try await ia.refreshPolicy(credentialBinding: initiator.account.credentialBinding).publish()
        for id in multipleIDs {
            _ = try ia.prepareText(credentialBinding: initiator.account.credentialBinding, clientMessageId: id, text: "PM ambiguous fixture " + id).publish()
        }
        let ambiguous = try initiator.store.read()
        DmScopedEnrollmentProtocol.setScripts([])
        try checks.refuses("PM local projection refuses ambiguous multiple outgoing pending IDs") {
            _ = try ip.thread(lifecycleVersion: iv, peerAccountId: responder.account.accountId).publish()
        }
        try await checks.refusesAsync("PM retry refuses ambiguous native history before dispatch") {
            _ = try await ip.retryPending(lifecycleVersion: iv, peerAccountId: responder.account.accountId, clientMessageId: multipleIDs[0]).publish()
        }
        try checks.require(try initiator.store.read() == ambiguous && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM ambiguity neither loses native pending records nor makes speculative HTTP")
        for id in multipleIDs {
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmResearchBridgeClear)])
            _ = try await ia.refreshPolicy(credentialBinding: initiator.account.credentialBinding).publish()
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", echoSendAccepted: true,
                sendSigningKey: initiator.card.identity.signingKey)])
            let outcome = try await ia.sendPending(credentialBinding: initiator.account.credentialBinding, clientMessageId: id).publish()
            try checks.require(outcome["decision"] as? String == "server_accepted", "explicit research reconciliation settles selected existing pending fixture ID")
        }
        DmScopedEnrollmentProtocol.setScripts([])
        let unambiguous = try dmResearchPrivateMessageThread(ip, actor: initiator, peer: responder, version: iv, checks: checks)
        try checks.require(unambiguous["pendingAttemptId"] is NSNull, "PM positive local history resumes after real terminal reconciliation")

        progressForResearch?("pm-original-snapshot-races")
        let race = try await dmResearchPrivateMessageRace(initiator, peer: responder, adapter: ip, version: iv, checks: checks)
        iv = race.0
        let heldIncomingReady = try rp.readiness(lifecycleVersion: rv)
        let heldIncomingThread = try rp.thread(lifecycleVersion: rv, peerAccountId: initiator.account.accountId)
        let inboxGate = DmScopedEnrollmentGate(); defer { inboxGate.release() }
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(race.1, serverId: 2), gate: inboxGate),
        ])
        let incomingTask = Task { try await rp.inbox(lifecycleVersion: rv) }
        do {
            try await dmScopedEnrollmentAwait { inboxGate.arrived() }
            try checks.require(DmScopedEnrollmentProtocol.captured().count == 2, "PM inbox race reaches actual list after current policy query")
            try await responder.renew()
            let winner = try responder.store.read()
            inboxGate.release()
            try await checks.refusesAsync("PM delayed inbox cannot commit plaintext after original native Auth expires by renewal") {
                _ = try await incomingTask.value.publish()
            }
            try checks.require(try inboxGate.releasedWithoutTimeout() && responder.store.read() == winner,
                "PM inbox race releases bounded gate and preserves exact winner native state")
            try checks.refuses("PM cached incoming readiness cannot publish after renewal") { _ = try heldIncomingReady.publish() }
            try checks.refuses("PM cached incoming plaintext cannot publish after renewal") { _ = try heldIncomingThread.publish() }
        } catch { incomingTask.cancel(); inboxGate.release(); _ = await incomingTask.result; throw error }
        let previousRV = rv
        rv = try checks.ready(rp.issue(credentialBinding: responder.account.credentialBinding).publish(), actor: responder)
        try checks.require(rv != previousRV, "PM renewed recipient receives genuinely new lifecycle revision")
        let beforeNewReceive = try dmResearchPrivateMessageThread(rp, actor: responder, peer: initiator, version: rv, checks: checks)
        try checks.require(!(beforeNewReceive["messages"] as? [[String: Any]] ?? []).contains {
            $0["clientMessageId"] as? String == "21000000-0000-4000-8000-000000000006"
        }, "PM stale inbox result left no late decrypted incoming row")
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", result: try dmResearchBridgeInbox(race.1, serverId: 2)),
        ])
        _ = try await rp.inbox(lifecycleVersion: rv).publish()
        let currentReceived = try dmResearchPrivateMessageThread(rp, actor: responder, peer: initiator, version: rv, checks: checks)
        try checks.message(dmResearchBridgeThreadRow(currentReceived, id: "21000000-0000-4000-8000-000000000006", direction: "incoming"),
            id: "21000000-0000-4000-8000-000000000006", direction: "incoming", text: "PM delayed original lease",
            owner: responder, peer: initiator, delivery: "received")

        let logoutReady = try ip.readiness(lifecycleVersion: iv)
        let logoutThread = try ip.thread(lifecycleVersion: iv, peerAccountId: responder.account.accountId)
        let logoutGate = DmScopedEnrollmentGate(); defer { logoutGate.release() }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", gate: logoutGate, policyState: dmResearchBridgeClear)])
        let logoutTask = Task { try await ip.permissions(lifecycleVersion: iv, peerAccountId: responder.account.accountId) }
        do {
            try await dmScopedEnrollmentAwait { logoutGate.arrived() }
            _ = try initiator.facade.fenceSession(mode: .signOut)
            let winner = try initiator.store.read()
            logoutGate.release()
            try await checks.refusesAsync("PM held permissions reply cannot renew signed-out native authority") { _ = try await logoutTask.value.publish() }
            try checks.require(try logoutGate.releasedWithoutTimeout() && initiator.store.read() == winner,
                "PM late permissions response preserves signed-out sealed winner")
            try checks.require(initiator.facade.currentAccount() == nil, "PM late policy result never revives signed-out account")
            try checks.refuses("PM cached ready publication refuses after durable logout") { _ = try logoutReady.publish() }
            try checks.refuses("PM cached plaintext publication refuses after durable logout") { _ = try logoutThread.publish() }
        } catch { logoutTask.cancel(); logoutGate.release(); _ = await logoutTask.result; throw error }
        DmScopedEnrollmentProtocol.setScripts([])
        try await initiator.renew()
        let afterLogout = try checks.ready(ip.issue(credentialBinding: initiator.account.credentialBinding).publish(), actor: initiator)
        try checks.require(afterLogout != iv, "PM explicit new Auth after logout issues new owner-bound descriptor")
        try checks.refuses("PM old lifecycle cannot revive through same-account fresh sign-in") { _ = try ip.readiness(lifecycleVersion: iv).publish() }

        progressForResearch?("pm-peer-lifecycle-fences")
        let blockedReady = try rp.readiness(lifecycleVersion: rv)
        let blockedThread = try rp.thread(lifecycleVersion: rv, peerAccountId: initiator.account.accountId)
        let context = try responder.snapshot().context
        let owner = DmOwnerContext(userId: context.userId, deviceId: context.deviceId, generation: context.ownerGeneration)
        let oldGeneration = responder.peerGeneration
        let peerRaceID = "21000000-0000-4000-8000-000000000007"
        let peerGate = DmScopedEnrollmentGate(); defer { peerGate.release() }
        DmScopedEnrollmentProtocol.setScripts([
            .init(path: "/v1/dispatch", policyState: dmResearchBridgeClear),
            .init(path: "/v1/dispatch", gate: peerGate, echoSendAccepted: false, sendSigningKey: responder.card.identity.signingKey),
        ])
        let peerTask = Task { try await rp.sendText(lifecycleVersion: rv, peerAccountId: initiator.account.accountId,
            clientMessageId: peerRaceID, text: "PM exact terminal refusal after peer block") }
        do {
            try await dmScopedEnrollmentAwait { peerGate.arrived() }
            let submitted = try dmResearchPrivateMessageSendCapture(responder, checks: checks)
            responder.peerGeneration = try responder.coordinator.setPeerStatusForResearch(.blocked, owner: owner)
            peerGate.release()
            try await checks.refusesAsync("PM held terminal rejection may settle natively but cannot publish under superseded full pair") {
                _ = try await peerTask.value.publish()
            }
            try checks.require(peerGate.releasedWithoutTimeout(), "PM peer-block rejection gate explicitly releases before timeout")
            guard let fields = try JSONSerialization.jsonObject(with: responder.store.read().payload) as? [String: Any],
                  let rows = fields["outbox"] as? [[String: Any]],
                  let row = rows.first(where: { $0["messageId"] as? String == peerRaceID }),
                  let record = row["record"] as? [String: Any] else {
                throw DmResearchBridgeProbeError.assertion("PM original-owner terminal rejection fixture")
            }
            try checks.require(row["status"] as? String == "rejected" && row["reason"] as? String == "blocked",
                "PM strict original-owner rejection lane durably settles only negative receipt after peer transition")
            try checks.require(record["serializedEnvelope"] as? String == submitted.serializedEnvelope,
                "PM terminal refusal settles original exact ciphertext without replacement or acceptance")
        } catch { peerTask.cancel(); peerGate.release(); _ = await peerTask.result; throw error }
        let blockedWinner = try responder.store.read()
        try checks.require(responder.peerGeneration != oldGeneration && responder.facade.currentAccount() == responder.account,
            "PM fixture peer block changes native generation while owner Auth remains current")
        try checks.refuses("PM cached full-pair ready result cannot publish after peer block") { _ = try blockedReady.publish() }
        try checks.refuses("PM cached full-pair plaintext cannot publish after peer block") { _ = try blockedThread.publish() }
        try checks.refuses("PM blocked peer cannot issue new full-pair readiness") { _ = try rp.issue(credentialBinding: responder.account.credentialBinding).publish() }
        guard case .privateMessagePermissions(let blockedFlags) = try responder.facade.executeMessageOperation(snapshot: responder.snapshot(),
            operation: .privateMessagePermissions) else { throw DmResearchBridgeProbeError.assertion("PM native owned blocked diagnostic") }
        try checks.require(!blockedFlags.canSend && blockedFlags.blockedByMe && blockedFlags.blockedEitherDirection,
            "PM native owner-only current blocked facts cannot become messaging permission")
        DmScopedEnrollmentProtocol.setScripts([])
        try checks.require(try responder.store.read() == blockedWinner && DmScopedEnrollmentProtocol.captured().isEmpty,
            "PM peer refusal cannot rewrite native block winner or call relay")
        responder.peerGeneration = try responder.coordinator.setPeerStatusForResearch(.accepted, owner: owner)
        try checks.refuses("PM old lifecycle stays fenced after same fingerprint reaccept with newer generation") {
            _ = try rp.readiness(lifecycleVersion: rv).publish()
        }
        let currentPeer = try checks.ready(rp.issue(credentialBinding: responder.account.credentialBinding).publish(), actor: responder)
        try checks.require(currentPeer != rv, "PM genuinely current accepted peer generation receives new descriptor")
        let quarantined = try dmResearchPrivateMessageThread(rp, actor: responder, peer: initiator, version: currentPeer, checks: checks)
        try checks.require((quarantined["messages"] as? [[String: Any]])?.isEmpty == true,
            "PM changed peer generation quarantines old plaintext instead of rebinding history")
        try checks.require((quarantined["permissions"] as? [String: Any])?["canSend"] as? Bool == false,
            "PM reaccepted peer generation restores no old ephemeral policy permission")

        for fixture in fixtures { try fixture.destroy() }
        try checks.require(fixtures.allSatisfy { !FileManager.default.fileExists(atPath: $0.root.path) },
            "PM disposable provider Keychain and sealed-file namespaces cleaned exactly")
        guard checks.assertions >= 50 else { throw DmResearchBridgeProbeError.assertion("PM fixture matrix substantive assertion bound") }
        progressForResearch?("pm-native-complete")
        return checks.assertions
    } catch {
        for fixture in fixtures { try? fixture.destroy() }
        throw error
    }
}
