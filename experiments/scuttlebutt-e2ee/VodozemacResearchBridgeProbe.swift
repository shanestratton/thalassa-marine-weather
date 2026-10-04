// ISOLATED Foundation adapter fixtures. Synthetic URLProtocol Auth/relay,
// real native provider/Directory/Facade/Keychain-sealed stores. No Capacitor
// runtime, hosted deployment, physical phone, persistence-resume or audit proof.
// Reuses narrowly prefixed disposable enrollment fixture/cleanup helpers only.
import Foundation

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
private func dmResearchBridgeReceipt(_ record: DmOutboxRecord, rejected: Bool = false) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmResearchBridgeProbeError.assertion("bridge fixture receipt fields")
    }
    fields["accepted"] = !rejected
    if rejected { fields["reason"] = "blocked" }
    return try dmScopedEnrollmentJSON(fields)
}
private func dmResearchBridgeInbox(_ record: DmOutboxRecord) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmResearchBridgeProbeError.assertion("bridge fixture inbox fields")
    }
    fields["accepted"] = true; fields["serverId"] = 1
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
        let initiator = a.account.deviceId < b.account.deviceId ? a : b
        let responder = initiator === a ? b : a
        let ia = initiator === a ? aa : ba, ra = responder === a ? aa : ba
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
        try checks.require(Set(incoming.keys) == ["clientMessageId", "direction", "text", "delivery", "reason", "localCreatedAtMillis"],
            "thread projects exact public plaintext row, not encrypted native record")
        try checks.require(incoming["text"] as? String == "real provider bridge opening" && incoming["direction"] as? String == "incoming"
            && incoming["delivery"] as? String == "received" && incoming["reason"] is NSNull && incoming["localCreatedAtMillis"] is NSNull,
            "received thread text is provider-authenticated with no invented read or sender timestamp")
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
