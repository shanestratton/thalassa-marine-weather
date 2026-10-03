// ISOLATED native readiness evidence. Synthetic URLProtocol Auth/relay with
// real provider bytes, Directory/Facade authority and Keychain-sealed SQLite.
// No live policy/enrollment, plugin, physical devices or independent audit.
// Direct CLOSED policy responses and fake native monotonic clocks below are
// labelled fixture seams, not authenticated HTTPS or trusted wall-clock proof.
import Foundation
import CryptoKit

enum DmReadinessProbeError: Error { case assertion(String) }

private let dmReadinessClear = DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: false,
    blockedByMe: false, blockedByPeer: false)

private final class DmReadinessClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ContinuousClock.now
    func now() -> ContinuousClock.Instant { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: Int64) { lock.lock(); value = value.advanced(by: .seconds(seconds)); lock.unlock() }
}
private final class DmReadinessFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    func read() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private func dmReadinessPrepare(_ actor: DmScopedEnrollmentActor, id: String) throws -> DmOutboxRecord {
    guard case .outbox(let record) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(peer: true),
        operation: .prepareText(clientMessageId: id, text: "real-provider readiness fixture " + id)) else {
        throw DmReadinessProbeError.assertion("readiness native text preparation result")
    }
    return record
}
private func dmReadinessFields(_ record: DmOutboxRecord) throws -> [String: Any] {
    guard let fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any] else {
        throw DmReadinessProbeError.assertion("readiness native record fixture")
    }
    return fields
}
private func dmReadinessReceipt(_ record: DmOutboxRecord, rejected: Bool = false,
                                 malformed: Bool = false, wrongRecord: Bool = false) throws -> Data {
    var fields = try dmReadinessFields(record)
    fields["accepted"] = !rejected
    if rejected { fields["reason"] = "blocked" }
    if malformed { fields["accepted"] = 1 }
    if wrongRecord { fields["ownerSessionGeneration"] = record.ownerSessionGeneration + 1 }
    return try dmScopedEnrollmentJSON(fields)
}
private func dmReadinessInbox(_ record: DmOutboxRecord) throws -> Data {
    var fields = try dmReadinessFields(record)
    fields["accepted"] = true; fields["serverId"] = 1
    return try JSONSerialization.data(withJSONObject: [fields], options: [.sortedKeys, .withoutEscapingSlashes])
}
private func dmReadinessPolicyResponse(_ request: DmNativeRelayPolicyRequest,
                                       state: DmNativeRelayPolicyState = dmReadinessClear) throws -> Data {
    try dmScopedEnrollmentJSON(["requestId": request.requestId,
        "ownerUserId": request.context.userId, "ownerDeviceId": request.context.deviceId,
        "peerUserId": request.peer.userId, "peerDeviceId": request.peer.deviceId,
        "peerIdentityKeyId": request.peer.identityKeyId, "ownerRevoked": state.ownerRevoked,
        "peerRevoked": state.peerRevoked, "blockedByMe": state.blockedByMe, "blockedByPeer": state.blockedByPeer])
}
private func dmReadinessPolicy(_ actor: DmScopedEnrollmentActor,
                               state: DmNativeRelayPolicyState = dmReadinessClear,
                               checks: DmScopedEnrollmentChecks) async throws {
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: state)])
    let flags = try await actor.client.refreshPolicy(snapshot: actor.snapshot())
    try checks.require(flags == state, "explicit scoped policy refresh retains authenticated diagnostic flags")
    let captures = DmScopedEnrollmentProtocol.captured()
    guard captures.count == 1, let fields = try JSONSerialization.jsonObject(with: captures[0].body) as? [String: Any],
          let payload = fields["payload"] as? String,
          let target = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String] else {
        throw DmReadinessProbeError.assertion("readiness captured policy query")
    }
    try checks.require(fields["action"] as? String == "policy" && fields["userId"] as? String == actor.account.accountId
        && fields["deviceId"] as? String == actor.account.deviceId && target.count == 3,
        "scoped policy request uses native owner and exact three-field peer target")
    // Independent public-domain verifier, not the production byte composer.
    // Read only the confirmed PUBLIC pin from this disposable sealed fixture.
    guard let saved = try JSONSerialization.jsonObject(with: actor.store.read().payload) as? [String: Any],
          let pin = saved["peerIdentity"] as? [String: Any],
          let user = pin["userId"] as? String, let device = pin["deviceId"] as? String,
          let keyId = pin["identityKeyId"] as? String else {
        throw DmReadinessProbeError.assertion("policy independently expected sealed public pin")
    }
    let frame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: captures[0].body)
    try checks.require(target == [user, device, keyId] && frame.version == 1 && frame.protocolName == "olm-v1"
        && UUID(uuidString: frame.requestId)?.uuidString.lowercased() == frame.requestId
        && frame.expiresAt > captures[0].capturedAt && frame.expiresAt <= captures[0].capturedAt + 240,
        "native policy exact confirmed target nonce protocol and expiry independently checked")
    let domain: [Any] = ["thalassa-relay-request", 1, "olm-v1", frame.userId, frame.deviceId,
        "policy", frame.requestId, frame.expiresAt, frame.payload]
    let bytes = try JSONSerialization.data(withJSONObject: domain, options: [.withoutEscapingSlashes])
    let signing = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(actor.card.identity.signingKey))
    try checks.require(signing.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64), for: bytes),
        "native policy signature independently verifies domain and target bytes")
    let canonical = try DmRelayCodec.requestWire(owner: DmOwnerContext(userId: frame.userId, deviceId: frame.deviceId,
        generation: actor.snapshot().context.ownerGeneration), action: "policy", requestId: frame.requestId,
        expiresAt: frame.expiresAt, payload: frame.payload, signature: frame.signature)
    try checks.require(captures[0].body == Data(canonical.utf8), "captured native policy frame is canonical exact wire")
    guard case .policyState(let current) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: .relayPolicyState) else { throw DmReadinessProbeError.assertion("readiness current policy diagnostics") }
    try checks.require(current == state, "fresh policy diagnostics do not mislabel blocked or revoked flags as permission")
    DmScopedEnrollmentProtocol.setScripts([])
}
private func dmReadinessEnroll(_ pair: DmScopedEnrollmentPair, claim: Bool,
                               checks: DmScopedEnrollmentChecks) async throws -> String {
    var peerWire: String?
    for actor in [pair.initiator, pair.responder] {
        try await dmScopedEnrollmentRegistered(actor, checks: checks)
        let capture = DmScopedEnrollmentProtocol.captured()[0]
        guard let wire = String(data: capture.body, encoding: .utf8) else {
            throw DmReadinessProbeError.assertion("readiness captured registration bundle")
        }
        let signed = try DmRelayCodec.verifyBundle(wire, now: Int64(Date().timeIntervalSince1970))
        try checks.require(signed.userId == actor.account.accountId && signed.deviceId == actor.account.deviceId
            && signed.signingKey == actor.card.identity.signingKey && signed.curveKey == actor.card.identity.curve
            && signed.prekey == actor.card.identity.prekey,
            "readiness setup acknowledges each actor's genuine full native bundle")
        if actor === pair.responder { peerWire = wire }
    }
    guard let peerWire else { throw DmReadinessProbeError.assertion("readiness responder registration fixture") }
    if claim {
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmScopedEnrollmentClaimResult(peerWire))])
        let claimed = try await pair.initiator.client.claimPeer(snapshot: pair.initiator.snapshot(peer: true))
        try checks.require(claimed.claim == .verified, "only lower-device native initiator verifies the registered peer claim")
    }
    try checks.require(try pair.responder.facts().claim == .none, "responder readiness never invents a local claim")
    DmScopedEnrollmentProtocol.setScripts([])
    return peerWire
}
private func dmReadinessAllDenied(_ actor: DmScopedEnrollmentActor, pending: DmOutboxRecord,
                                  checks: DmScopedEnrollmentChecks) async throws {
    DmScopedEnrollmentProtocol.setScripts([])
    let before = try actor.store.read(), crypto = try dmScopedEnrollmentCrypto(actor.store)
    try checks.refuses("unready closed text preparation fails before durable provider mutation") {
        _ = try dmReadinessPrepare(actor, id: "unready-new-message")
    }
    try await checks.unresolved("unready existing native pending send refuses before HTTP") {
        let id = try DmEnvelope.decode(pending.serializedEnvelope).clientMessageId
        _ = try await actor.client.sendPending(clientMessageId: id, snapshot: actor.snapshot(peer: true))
    }
    try await checks.unresolved("unready inbox refuses before HTTP") {
        _ = try await actor.client.syncInbox(snapshot: actor.snapshot(peer: true))
    }
    try checks.require(try actor.store.read() == before && dmScopedEnrollmentCrypto(actor.store) == crypto,
        "unready prepare send inbox preserve exact sealed revision keys and ratchet")
    try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "unready operations make no relay request or automatic refresh")
}
private func dmReadinessCurrentPolicyRequest(_ actor: DmScopedEnrollmentActor) throws -> DmNativeRelayPolicyRequest {
    guard case .policyRequest(let request) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: .relayPolicyWire) else { throw DmReadinessProbeError.assertion("readiness closed policy query result") }
    return request
}
private func dmReadinessCompletePolicy(_ actor: DmScopedEnrollmentActor, request: DmNativeRelayPolicyRequest) throws {
    guard case .policyState(let flags) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: .relayPolicyResponse(request: request, response: dmReadinessPolicyResponse(request))), flags == dmReadinessClear else {
        throw DmReadinessProbeError.assertion("readiness closed trusted clear policy response fixture")
    }
}
private func dmReadinessCoordinatorRefuses(_ label: String, checks: DmScopedEnrollmentChecks,
                                           operation: () throws -> Void) throws {
    do { try operation() }
    catch DmCoordinatorError.unavailable { try checks.require(true, label); return }
    throw DmReadinessProbeError.assertion(label)
}
private func dmReadinessClockPolicy(_ coordinator: VodozemacDmCoordinator, context: DmRelayNetworkContext) throws {
    guard case .policyRequest(let request) = try coordinator.executeMessageOperation(.relayPolicyWire,
        context: context, checkAuthority: {}),
          case .policyState(let flags) = try coordinator.executeMessageOperation(
        .relayPolicyResponse(request: request, response: dmReadinessPolicyResponse(request)),
        context: context, checkAuthority: {}), flags == dmReadinessClear else {
        throw DmReadinessProbeError.assertion("readiness native-clock trusted policy fixture")
    }
}

func runDmReadinessProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmScopedEnrollmentChecks()
    var fixtures: [DmScopedEnrollmentFixture] = []
    var settleInFlight: [() async -> Void] = []
    DmScopedEnrollmentProtocol.reset()
    defer { DmScopedEnrollmentProtocol.reset() }
    func pair(enrolled: Bool = true, claim: Bool = true, policy: Bool = true) async throws -> (DmScopedEnrollmentPair, String?) {
        let a = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(a)
        let b = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth()); fixtures.append(b)
        let pair = try await dmScopedEnrollmentPair(a, b)
        let wire: String?
        if enrolled { wire = try await dmReadinessEnroll(pair, claim: claim, checks: checks) }
        else { wire = nil }
        if policy {
            try await dmReadinessPolicy(pair.initiator, checks: checks)
            try await dmReadinessPolicy(pair.responder, checks: checks)
        }
        return (pair, wire)
    }
    do {
        progressForResearch?("readiness-unknown-policy")
        let unknown = try await pair(policy: false).0
        let unknownBefore = try unknown.initiator.store.read()
        try checks.refuses("fully enrolled initiator cannot prepare text with unknown policy") {
            _ = try dmReadinessPrepare(unknown.initiator, id: "unknown-policy")
        }
        try checks.require(try unknown.initiator.store.read() == unknownBefore, "unknown policy allocates no message or ratchet")
        // A raw research provider helper creates ONE genuine pending fixture,
        // not permission for the closed application dispatcher. No fake ratchet.
        let life = try unknown.initiator.coordinator.lifecycleForResearch()
        guard let unknownGeneration = unknown.initiator.peerGeneration else {
            throw DmReadinessProbeError.assertion("unknown-policy full native generation")
        }
        let pendingUnknown = try unknown.initiator.coordinator.prepare(clientMessageId: "unknown-existing-pending",
            text: "real provider fixture for unknown policy", owner: life.owner, peerGeneration: unknownGeneration)
        try await dmReadinessAllDenied(unknown.initiator, pending: pendingUnknown, checks: checks)
        try await dmReadinessPolicy(unknown.initiator, checks: checks)
        let unknownReady = try dmReadinessPrepare(unknown.initiator, id: "known-policy-positive")
        try checks.require(try DmEnvelope.decode(unknownReady.serializedEnvelope).wire.body.count > 32,
            "explicit clear policy restores actual provider preparation without bypass")

        progressForResearch?("readiness-native-policy-parser-fail-closed")
        let malformedPair = try await pair().0, malformedActor = malformedPair.initiator
        let faults: [DmScopedEnrollmentPolicyFault] = [.duplicateRequestId, .numericBoolean, .stringBoolean,
            .wrongRequestId, .wrongOwnerUser, .wrongOwnerDevice, .wrongPeerUser, .wrongPeerDevice, .wrongPeerKey,
            .missingField, .extraField]
        for (index, fault) in faults.enumerated() {
            guard case .inboxRequest(let captured) = try malformedActor.facade.executeMessageOperation(
                snapshot: malformedActor.snapshot(peer: true), operation: .relayInboxWire) else {
                throw DmReadinessProbeError.assertion("native parser old allow fixture")
            }
            let before = try malformedActor.store.read()
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", policyState: dmReadinessClear, policyFault: fault)])
            try await checks.unresolved("duplicate coerced malformed or wrong native echo policy is refused") {
                _ = try await malformedActor.client.refreshPolicy(snapshot: malformedActor.snapshot())
            }
            try checks.refuses("failed native policy response cannot leave earlier allow current") {
                _ = try malformedActor.facade.executeMessageOperation(snapshot: malformedActor.snapshot(), operation: .relayPolicyState)
            }
            try checks.refuses("failed native policy query invalidates captured old messaging permit") {
                _ = try malformedActor.facade.executeMessageOperation(snapshot: malformedActor.snapshot(peer: true),
                    operation: .relayPolicyGuard(captured.policy))
            }
            try checks.refuses("failed native policy cannot authorize initial or established text preparation") {
                _ = try dmReadinessPrepare(malformedActor, id: "bad-policy-denied")
            }
            try checks.require(try malformedActor.store.read() == before && DmScopedEnrollmentProtocol.captured().count == 1,
                "native malformed policy reaches HTTPS once but commits no sealed state or automatic retry")
            try await dmReadinessPolicy(malformedActor, checks: checks)
            try checks.refuses("subsequent clear policy does not rehabilitate captured old permit") {
                _ = try malformedActor.facade.executeMessageOperation(snapshot: malformedActor.snapshot(peer: true),
                    operation: .relayPolicyGuard(captured.policy))
            }
            _ = try dmReadinessPrepare(malformedActor, id: "native-policy-parser-positive-\(index)")
        }
        guard case .inboxRequest(let beforeLostPolicy) = try malformedActor.facade.executeMessageOperation(
            snapshot: malformedActor.snapshot(peer: true), operation: .relayInboxWire) else {
            throw DmReadinessProbeError.assertion("lost policy old allow fixture")
        }
        let beforeLost = try malformedActor.store.read()
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", loseAfterBody: true, policyState: dmReadinessClear)])
        try await checks.unresolved("lost correctly framed policy response remains unresolved") {
            _ = try await malformedActor.client.refreshPolicy(snapshot: malformedActor.snapshot())
        }
        try checks.refuses("lost policy query cannot preserve old messaging allow") {
            _ = try malformedActor.facade.executeMessageOperation(snapshot: malformedActor.snapshot(peer: true),
                operation: .relayPolicyGuard(beforeLostPolicy.policy))
        }
        try checks.require(try malformedActor.store.read() == beforeLost && DmScopedEnrollmentProtocol.captured().count == 1,
            "lost policy response changes no sealed history or provider state")

        progressForResearch?("readiness-missing-historical-claim")
        let missingClaim = try await pair(claim: false)
        let missingActor = missingClaim.0.initiator
        let missingBefore = try missingActor.store.read()
        DmScopedEnrollmentProtocol.setScripts([])
        try checks.refuses("fresh clear-policy initiator needs a current verified claim before initial crypto") {
            _ = try dmReadinessPrepare(missingActor, id: "missing-initial-claim")
        }
        try await checks.unresolved("no-session initiator missing claim refuses inbox before HTTP") {
            _ = try await missingActor.client.syncInbox(snapshot: missingActor.snapshot(peer: true))
        }
        try checks.require(try missingActor.store.read() == missingBefore && DmScopedEnrollmentProtocol.captured().isEmpty,
            "missing claim refusal preserves exact state despite fresh authenticated clear policy")
        guard let missingPeerWire = missingClaim.1 else { throw DmReadinessProbeError.assertion("missing claim positive peer wire") }
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmScopedEnrollmentClaimResult(missingPeerWire))])
        _ = try await missingActor.client.claimPeer(snapshot: missingActor.snapshot(peer: true))
        try await dmReadinessPolicy(missingActor, checks: checks)
        let unusedVerified = try missingActor.store.read()
        try await missingActor.signOutAndLogin()
        try await dmReadinessPolicy(missingActor, checks: checks)
        let historicalClaim = try missingActor.facts()
        let historicalBefore = try missingActor.store.read()
        try checks.require(historicalClaim.claim == .historical && unusedVerified.payload != historicalBefore.payload,
            "no-session historical claim fixture changes owner authority without creating a ratchet")
        DmScopedEnrollmentProtocol.setScripts([])
        try checks.refuses("new owner cannot prepare from historical prekey confirmation") {
            _ = try dmReadinessPrepare(missingActor, id: "historical-initial-claim")
        }
        try await checks.unresolved("historical no-session initiator claim refuses inbox before HTTP") {
            _ = try await missingActor.client.syncInbox(snapshot: missingActor.snapshot(peer: true))
        }
        try checks.require(try missingActor.store.read() == historicalBefore && DmScopedEnrollmentProtocol.captured().isEmpty,
            "historical initial claim cannot be revived by fresh clear policy")

        progressForResearch?("readiness-initial-versus-established-prekey-expiry")
        let expiryPair = try await pair()
        let expiryActor = expiryPair.0.initiator, expiryPeer = expiryPair.0.responder
        guard let registeredPeerWire = expiryPair.1 else { throw DmReadinessProbeError.assertion("expiry full registered peer bundle") }
        let registeredPeer = try DmRelayCodec.verifyStoredBundle(registeredPeerWire)
        let expiredPeerWire = try dmScopedEnrollmentSignedFixture(identity: expiryPeer.card.identity, signer: expiryPeer,
            prekeyId: registeredPeer.prekeyId, expiresAt: 1_600_003_600)
        _ = try DmRelayCodec.verifyBundle(expiredPeerWire, now: 1_600_000_001)
        let expireConfirmation: (inout [String: Any]) throws -> Void = { fields in
            guard var confirmation = fields["claimConfirmation"] as? [String: Any] else {
                throw DmReadinessProbeError.assertion("readiness expired confirmation fixture")
            }
            confirmation["signedBundle"] = expiredPeerWire
            fields["claimConfirmation"] = confirmation
        }
        try await dmScopedEnrollmentSealedFixture(expiryActor, replacing: expireConfirmation) {
            let before = try expiryActor.store.read()
            DmScopedEnrollmentProtocol.setScripts([])
            try checks.require(try expiryActor.facts().claim == .expired, "initial expiry fixture retains genuinely signed expired fact")
            try checks.refuses("unused initiator cannot create session from expired confirmed prekey") {
                _ = try dmReadinessPrepare(expiryActor, id: "expired-initial-prekey")
            }
            try await checks.unresolved("unused initiator expired claim refuses protected inbox before HTTP") {
                _ = try await expiryActor.client.syncInbox(snapshot: expiryActor.snapshot(peer: true))
            }
            try checks.require(try expiryActor.store.read() == before && DmScopedEnrollmentProtocol.captured().isEmpty,
                "expired initial prekey performs no durable provider mutation or relay request")
        }
        try await dmReadinessPolicy(expiryActor, checks: checks)
        let actualOpening = try dmReadinessPrepare(expiryActor, id: "actual-session-before-expiry")
        try await dmScopedEnrollmentSealedFixture(expiryActor, replacing: expireConfirmation) {
            try checks.require(try expiryActor.facts().claim == .expired, "established-session expiry seam changes fact without fabricating ratchet")
            let continued = try dmReadinessPrepare(expiryActor, id: "actual-ratchet-after-expiry")
            try checks.require(try DmEnvelope.decode(continued.serializedEnvelope).wire.body.count > 32,
                "actual current established session does not require renewing consumed initial prekey")
            DmScopedEnrollmentProtocol.setScripts([
                .init(path: "/v1/dispatch", result: try dmReadinessReceipt(actualOpening)),
                .init(path: "/v1/dispatch", result: Data("[]".utf8))])
            let accepted = try await expiryActor.client.sendPending(clientMessageId: "actual-session-before-expiry",
                snapshot: expiryActor.snapshot(peer: true))
            let inbox = try await expiryActor.client.syncInbox(snapshot: expiryActor.snapshot(peer: true))
            try checks.require(accepted == .accepted(actualOpening) && inbox.stored == 0 && inbox.unresolved == 0,
                "established exact pending send and protected inbox retain policy gate without initial-claim expiry cutoff")
            try checks.require(DmScopedEnrollmentProtocol.captured().count == 2,
                "established expiry seam neither auto-claims nor auto-refreshes policy")
        }

        progressForResearch?("readiness-denied-policy-flags")
        let denials = [
            DmNativeRelayPolicyState(ownerRevoked: true, peerRevoked: false, blockedByMe: false, blockedByPeer: false),
            DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: true, blockedByMe: false, blockedByPeer: false),
            DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: false, blockedByMe: true, blockedByPeer: false),
            DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: false, blockedByMe: false, blockedByPeer: true)]
        for (index, denial) in denials.enumerated() {
            let controlled = try await pair().0, actor = controlled.initiator
            let pending = try dmReadinessPrepare(actor, id: "denied-policy-\(index)")
            try await dmReadinessPolicy(actor, state: denial, checks: checks)
            try checks.require(try actor.facade.currentMessageContext(snapshot: actor.snapshot(peer: true)) != nil,
                "denied policy test retains unrelated valid native Auth authority")
            try await dmReadinessAllDenied(actor, pending: pending, checks: checks)
            try await dmReadinessPolicy(actor, checks: checks)
            _ = try dmReadinessPrepare(actor, id: "clear-policy-positive-\(index)")
        }

        progressForResearch?("readiness-missing-ack-and-history")
        let missingAck = try await pair().0, ackActor = missingAck.initiator
        let ackPending = try dmReadinessPrepare(ackActor, id: "missing-ack-pending")
        try await dmScopedEnrollmentSealedFixture(ackActor, replacing: { fields in
            // Remove confirmation too so this is a structurally VALID unknown
            // acknowledgement, not an unrelated corrupt-state refusal. The
            // genuine established session needs no initial claim expiry.
            fields.removeValue(forKey: "registrationAcknowledgement")
            fields.removeValue(forKey: "claimConfirmation")
        }) {
            _ = try VodozemacDmCoordinator(store: ackActor.store)
            try await dmReadinessAllDenied(ackActor, pending: ackPending, checks: checks)
        }
        try await dmReadinessPolicy(ackActor, checks: checks)
        _ = try dmReadinessPrepare(ackActor, id: "restored-ack-positive")
        try await ackActor.signOutAndLogin()
        try await dmReadinessPolicy(ackActor, checks: checks)
        try checks.require(try ackActor.facts().claim == .historical, "established historical fixture retains old claim as fact only")
        try await dmReadinessAllDenied(ackActor, pending: ackPending, checks: checks)

        progressForResearch?("readiness-native-clock-and-final-CAS")
        let clockPair = try await pair().0, clockActor = clockPair.initiator
        let clockPending = try dmReadinessPrepare(clockActor, id: "clock-existing-pending")
        let nativeClock = DmReadinessClock()
        let clocked = try VodozemacDmCoordinator(store: clockActor.store, policyClockForResearch: { nativeClock.now() })
        let ownerContext = try clockActor.snapshot().context, pairedContext = try clockActor.snapshot(peer: true).context
        try dmReadinessClockPolicy(clocked, context: ownerContext)
        guard case .inboxRequest(let initialInbox) = try clocked.executeMessageOperation(.relayInboxWire,
            context: pairedContext, checkAuthority: {}) else { throw DmReadinessProbeError.assertion("clock native inbox permit") }
        let originalPermit = initialInbox.policy, clockBefore = try clockActor.store.read()
        nativeClock.advance(5)
        for operation in [DmNativeMessageOperation.relayPolicyState, .relayPolicyGuard(originalPermit),
                          .prepareText(clientMessageId: "clock-expired", text: "real provider expiry fixture"),
                          .relaySendWire(clientMessageId: "clock-existing-pending"), .relayInboxWire] {
            try dmReadinessCoordinatorRefuses("exact five-second native policy deadline refuses protected operation", checks: checks) {
                _ = try clocked.executeMessageOperation(operation, context: pairedContext, checkAuthority: {})
            }
        }
        try checks.require(try clockActor.store.read() == clockBefore, "expired policy produces no signing ratchet or sealed CAS")
        nativeClock.advance(-6)
        try dmReadinessCoordinatorRefuses("native clock before original policy start cannot revive permit", checks: checks) {
            _ = try clocked.executeMessageOperation(.relayPolicyGuard(originalPermit), context: pairedContext, checkAuthority: {})
        }
        nativeClock.advance(7)
        try dmReadinessClockPolicy(clocked, context: ownerContext)
        try dmReadinessCoordinatorRefuses("new clear native policy never authorizes captured old permit", checks: checks) {
            _ = try clocked.executeMessageOperation(.relayPolicyGuard(originalPermit), context: pairedContext, checkAuthority: {})
        }
        guard case .inboxRequest(let renewedInbox) = try clocked.executeMessageOperation(.relayInboxWire,
            context: pairedContext, checkAuthority: {}) else { throw DmReadinessProbeError.assertion("renewed native policy permit fixture") }
        let modified = DmNativeRelayPolicyPermit(id: renewedInbox.policy.id, context: renewedInbox.policy.context,
            peerFingerprint: renewedInbox.policy.peerFingerprint, startedAtSeconds: renewedInbox.policy.startedAtSeconds,
            startedAt: renewedInbox.policy.startedAt.advanced(by: .seconds(-1)))
        try dmReadinessCoordinatorRefuses("copied permit cannot alter private native deadline", checks: checks) {
            _ = try clocked.executeMessageOperation(.relayPolicyGuard(modified), context: pairedContext, checkAuthority: {})
        }
        guard case .policyRequest(let delayedQuery) = try clocked.executeMessageOperation(.relayPolicyWire,
            context: ownerContext, checkAuthority: {}) else { throw DmReadinessProbeError.assertion("delayed native policy query fixture") }
        let beforeDelayedResponse = try clockActor.store.read()
        nativeClock.advance(5)
        try dmReadinessCoordinatorRefuses("policy response at original five-second query deadline cannot mint permit", checks: checks) {
            _ = try clocked.executeMessageOperation(.relayPolicyResponse(request: delayedQuery,
                response: dmReadinessPolicyResponse(delayedQuery)), context: ownerContext, checkAuthority: {})
        }
        try dmReadinessCoordinatorRefuses("expired pending query never restores prior allow", checks: checks) {
            _ = try clocked.executeMessageOperation(.relayPolicyState, context: ownerContext, checkAuthority: {})
        }
        try checks.require(try clockActor.store.read() == beforeDelayedResponse,
            "expired exact policy query response performs no sealed CAS")
        let armed = DmReadinessFlag(), reached = DmReadinessFlag(), casClock = DmReadinessClock()
        let cas = try VodozemacDmCoordinator(store: clockActor.store, beforeCommitForResearch: {
            if armed.read() { reached.set(); casClock.advance(6) }
        }, policyClockForResearch: { casClock.now() })
        try dmReadinessClockPolicy(cas, context: ownerContext)
        let beforeCAS = try clockActor.store.read()
        armed.set()
        try dmReadinessCoordinatorRefuses("policy expiry at real final CAS refuses computed ciphertext publication", checks: checks) {
            _ = try cas.executeMessageOperation(.prepareText(clientMessageId: "policy-final-CAS", text: "real provider final CAS fixture"),
                context: pairedContext, checkAuthority: {})
        }
        try checks.require(reached.read(), "expiry proof actually reached real native beforeCommit hook")
        try checks.require(try clockActor.store.read() == beforeCAS, "late policy expiry leaves exact durable provider state and pending outbox")
        _ = clockPending // Keeps explicit real pending fixture, not a synthetic ratchet.

        progressForResearch?("readiness-policy-replacement-during-HTTP")
        for inbox in [false, true] {
            for mintNewClear in [false, true] {
                let controlled = try await pair().0
                let actor = inbox ? controlled.responder : controlled.initiator
                let record = try dmReadinessPrepare(controlled.initiator,
                    id: inbox ? "held-inbox-opening" : "held-send-acceptance")
                let result: Data
                if inbox { result = try dmReadinessInbox(record) }
                else { result = try dmReadinessReceipt(record) }
                let gate = DmScopedEnrollmentGate()
                let snapshot = try actor.snapshot(peer: true)
                DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: result, gate: gate)])
                let task = Task {
                    if inbox { _ = try await actor.client.syncInbox(snapshot: snapshot) }
                    else { _ = try await actor.client.sendPending(clientMessageId: "held-send-acceptance", snapshot: snapshot) }
                }
                settleInFlight.append { task.cancel(); gate.release(); _ = try? await task.value }
                try await dmScopedEnrollmentAwait { gate.arrived() }
                let query = try dmReadinessCurrentPolicyRequest(actor)
                try checks.refuses("starting policy query invalidates previous policy immediately") {
                    _ = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(), operation: .relayPolicyState)
                }
                if mintNewClear { try dmReadinessCompletePolicy(actor, request: query) }
                let winner = try actor.store.read()
                try checks.require(actor.facade.currentMessageContext(snapshot: snapshot) == snapshot.context,
                    "policy replacement race keeps original native Auth and peer authority current")
                gate.release()
                try await checks.unresolved("held acceptance or inbox cannot adopt newer or pending policy") { try await task.value }
                try checks.require(gate.releasedWithoutTimeout(), "policy replacement reply gate actually released before timeout")
                try checks.require(try actor.store.read() == winner && DmScopedEnrollmentProtocol.captured().count == 1,
                    "old policy completion performs no receipt crypto or sealed response CAS")
                if !mintNewClear { try dmReadinessCompletePolicy(actor, request: query) }
                DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: result)])
                if inbox {
                    let received = try await actor.client.syncInbox(snapshot: actor.snapshot(peer: true))
                    try checks.require(received.stored == 1 && received.unresolved == 0,
                        "responder receives genuine prekey under new policy without local claim")
                    try checks.require(try actor.facts().claim == .none, "responder prekey establishment does not fabricate a claim")
                    let reply = try dmReadinessPrepare(actor, id: "real-responder-ready-reply")
                    try checks.require(try DmEnvelope.decode(reply.serializedEnvelope).wire.body.count > 32,
                        "real established responder prepares genuine encrypted reply")
                    try await dmReadinessPolicy(controlled.initiator, checks: checks)
                    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmReadinessInbox(reply))])
                    let replyReceived = try await controlled.initiator.client.syncInbox(snapshot: controlled.initiator.snapshot(peer: true))
                    try checks.require(replyReceived.stored == 1 && replyReceived.unresolved == 0,
                        "initiator authenticates actual responder Olm reply under protected inbox path")
                } else {
                    let accepted = try await actor.client.sendPending(clientMessageId: "held-send-acceptance", snapshot: actor.snapshot(peer: true))
                    try checks.require(accepted == .accepted(record), "new current policy explicitly retries exact pending ciphertext")
                }
            }
        }

        progressForResearch?("readiness-owner-only-exact-rejection")
        for peerTransition in [false, true] {
            let controlled = try await pair().0, actor = controlled.initiator
            let record = try dmReadinessPrepare(actor, id: "blocked-in-flight")
            let snapshot = try actor.snapshot(peer: true)
            let ownerCompletion = try actor.facade.ownerOnlyCompletionSnapshot(from: snapshot)
            let gate = DmScopedEnrollmentGate()
            let denied = DmNativeRelayPolicyState(ownerRevoked: false, peerRevoked: false, blockedByMe: false, blockedByPeer: true)
            DmScopedEnrollmentProtocol.setScripts([
                .init(path: "/v1/dispatch", result: try dmReadinessReceipt(record, rejected: true), gate: gate),
                .init(path: "/v1/dispatch", policyState: denied)])
            let task = Task { try await actor.client.sendPending(clientMessageId: "blocked-in-flight", snapshot: snapshot) }
            settleInFlight.append { task.cancel(); gate.release(); _ = try? await task.value }
            try await dmScopedEnrollmentAwait { gate.arrived() }
            if peerTransition {
                _ = try actor.coordinator.setPeerStatusForResearch(.blocked, owner: actor.coordinator.lifecycleForResearch().owner)
            } else {
                let flags = try await actor.client.refreshPolicy(snapshot: actor.snapshot())
                try checks.require(flags == denied, "authenticated policy transition records peer block while send is held")
            }
            let crypto = try dmScopedEnrollmentCrypto(actor.store)
            try checks.require(actor.facade.currentMessageContext(snapshot: ownerCompletion) == ownerCompletion.context,
                "original owner-only completion lease survives unrelated peer or policy block")
            gate.release()
            let receipt = try await task.value
            try checks.require(gate.releasedWithoutTimeout(), "blocked rejection gate explicitly released without timeout")
            try checks.require(receipt == .rejected(record, .blocked), "strict exact rejection settles through original owner-only lane")
            try checks.require(try dmScopedEnrollmentCrypto(actor.store) == crypto, "owner-only rejection never re-encrypts or advances ratchet")
            let rejectedStore = try actor.store.read()
            guard case .relayReceipt(let replayed) = try actor.facade.executeMessageOperation(snapshot: ownerCompletion,
                operation: .relayRejectedReceipt(record: record, response: dmReadinessReceipt(record, rejected: true))) else {
                throw DmReadinessProbeError.assertion("owner-only rejection replay fixture")
            }
            try checks.require(replayed == receipt, "exact owner-only terminal rejection replay is idempotent")
            for response in [try dmReadinessReceipt(record), try dmReadinessReceipt(record, rejected: true, malformed: true),
                             try dmReadinessReceipt(record, rejected: true, wrongRecord: true)] {
                try checks.refuses("acceptance malformed or mismatched response cannot use rejection fallback") {
                    _ = try actor.facade.executeMessageOperation(snapshot: ownerCompletion,
                        operation: .relayRejectedReceipt(record: record, response: response))
                }
            }
            try checks.require(try actor.store.read() == rejectedStore, "rejection replay and refused alternatives preserve exact terminal store")
            try checks.require(DmScopedEnrollmentProtocol.captured().count == (peerTransition ? 1 : 2),
                "rejection settlement makes no automatic redispatch or policy refresh")
        }
        for logout in [false, true] {
            let controlled = try await pair().0, actor = controlled.initiator
            let record = try dmReadinessPrepare(actor, id: "old-auth-rejection")
            let snapshot = try actor.snapshot(peer: true), gate = DmScopedEnrollmentGate()
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", result: try dmReadinessReceipt(record, rejected: true), gate: gate)])
            let task = Task { try await actor.client.sendPending(clientMessageId: "old-auth-rejection", snapshot: snapshot) }
            settleInFlight.append { task.cancel(); gate.release(); _ = try? await task.value }
            try await dmScopedEnrollmentAwait { gate.arrived() }
            if logout { _ = try actor.facade.fenceSession(mode: .signOut) } else { try await actor.renew() }
            let winner = try actor.store.read()
            gate.release()
            try await checks.unresolved("owner-only rejection fallback never adopts refreshed or logged-out Auth") { _ = try await task.value }
            try checks.require(gate.releasedWithoutTimeout(), "Auth rejection race gate released before timeout")
            try checks.require(try actor.store.read() == winner && DmScopedEnrollmentProtocol.captured().count == 1,
                "stale Auth rejection cannot settle record or reopen owner authority")
        }

        progressForResearch?("readiness-cleanup")
        for settle in settleInFlight { await settle() }
        for fixture in fixtures { try fixture.destroy() }
        try checks.require(fixtures.allSatisfy { !FileManager.default.fileExists(atPath: $0.root.path) },
            "readiness exact disposable directories and native Keychain namespaces cleaned")
        return checks.assertions
    } catch {
        for settle in settleInFlight { await settle() }
        for fixture in fixtures { try? fixture.destroy() }
        if let fixtureError = error as? DmScopedEnrollmentProbeError, case .assertion(let label) = fixtureError {
            throw DmReadinessProbeError.assertion(label)
        }
        throw error
    }
}
