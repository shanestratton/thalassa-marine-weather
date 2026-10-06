// Fresh disposable native fixtures only. Real provider/signatures/Keychain/sealed
// SQLite/facade/adapter, synthetic URLProtocol Auth/relay. No hosted or UI result.
import Foundation
import CryptoKit

enum DmAccountModeProbeError: Error { case assertion(String) }
private final class DmAccountModeChecks {
    var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmAccountModeProbeError.assertion(label) }
        assertions += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { assertions += 1; return }
        catch ResearchMessagingAdapterError.unavailable { assertions += 1; return }
        throw DmAccountModeProbeError.assertion(label)
    }
    func unresolved(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch DmRelayTransportError.unresolved { assertions += 1; return }
        catch ResearchMessagingAdapterError.unavailable { assertions += 1; return }
        throw DmAccountModeProbeError.assertion(label)
    }
}
private func dmAccountModeAdapter(_ actor: DmScopedEnrollmentActor) throws -> ResearchMessagingAdapter {
    let transport = try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
        configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmScopedEnrollmentProtocol.self]; return configuration
        })
    return ResearchMessagingAdapter(facade: actor.facade, transport: transport,
        projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
}
private func dmAccountModeSnapshot(_ actor: DmScopedEnrollmentActor, ignoringEpoch: Bool = false) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: actor.store.read().payload) as? [String: Any] else {
        throw DmAccountModeProbeError.assertion("synthetic sealed state object")
    }
    fields.removeValue(forKey: "protectedAccountIntent"); fields.removeValue(forKey: "protectedAccountConfirmed")
    if ignoringEpoch { fields.removeValue(forKey: "credentialEpoch") }
    return try dmScopedEnrollmentJSON(fields)
}
private func dmAccountModeRequest(_ actor: DmScopedEnrollmentActor, require: Bool) throws -> DmNativeRelayAccountModeRequest {
    guard case .accountModeRequest(let request) = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: require ? .relayRequireProtectedWire : .relayAccountModeWire) else {
        throw DmAccountModeProbeError.assertion("closed native account mode request")
    }
    return request
}
private func dmAccountModeSigned(_ actor: DmScopedEnrollmentActor, _ body: Data, action: String,
                                checks: DmAccountModeChecks) throws {
    let frame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: body)
    try checks.require(frame.version == 1 && frame.protocolName == "olm-v1" && frame.payload == "[]"
        && frame.action == action && frame.userId == actor.account.accountId && frame.deviceId == actor.account.deviceId,
        "native request has exact action payload and original account/device")
    // Independently construct the shared signing domain, not the codec signer.
    let bytes = try JSONSerialization.data(withJSONObject: ["thalassa-relay-request", 1, "olm-v1",
        frame.userId, frame.deviceId, frame.action, frame.requestId, frame.expiresAt, frame.payload] as [Any],
        options: [.withoutEscapingSlashes])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(actor.card.identity.signingKey))
    try checks.require(key.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64), for: bytes),
        "real native signature matches independently constructed request domain")
}
private func dmAccountModeDTO(_ value: [String: Any], actor: DmScopedEnrollmentActor, mode: String,
                             checks: DmAccountModeChecks) throws {
    try checks.require(Set(value.keys) == ["status", "credentialBinding", "mode"], "account mode DTO has only three public fields")
    try checks.require(value["status"] as? String == "account_mode" && value["credentialBinding"] as? String == actor.account.credentialBinding
        && value["mode"] as? String == mode, "mode DTO binds original native Auth and exact mode")
    try checks.require(JSONSerialization.isValidJSONObject(value), "mode DTO contains no native handle or wire")
}
private func dmAccountModeRace(logout: Bool, checks: DmAccountModeChecks) async throws {
    let fixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? fixture.destroy() }
    let actor = try await dmScopedEnrollmentLogin(fixture,
        userId: logout ? "81000000-0000-4000-8000-000000000011" : "81000000-0000-4000-8000-000000000012",
        bearer: logout ? "mode-logout-fixture" : "mode-renew-fixture")
    try await dmScopedEnrollmentRegistered(actor, checks: DmScopedEnrollmentChecks())
    let adapter = try dmAccountModeAdapter(actor), original = actor.account.credentialBinding
    let gate = DmScopedEnrollmentGate(); defer { gate.release() }
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", gate: gate, accountMode: "protected-required")])
    let task = Task { try await adapter.requireProtected(credentialBinding: original) }
    do {
        try await dmScopedEnrollmentAwait { gate.arrived() }
        try checks.require(DmScopedEnrollmentProtocol.captured().count == 1, "race reached actual synthetic relay before Auth transition")
        if logout { _ = try actor.facade.fenceSession(mode: .signOut) } else { try await actor.renew() }
        let winner = try actor.store.read()
        gate.release()
        try await checks.unresolved("late cutover cannot publish through stale native Auth") { _ = try await task.value.publish() }
        try checks.require(gate.releasedWithoutTimeout(), "held reply released explicitly within fixture deadline")
        try checks.require(try actor.store.read() == winner, "late cutover does not rewrite the winning sealed Auth state")
        DmScopedEnrollmentProtocol.setScripts([])
        try await checks.unresolved("old binding never silently recaptures renewed owner") {
            _ = try await adapter.refreshAccountMode(credentialBinding: original).publish()
        }
        try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "stale binding refused before transport")
        if !logout {
            try await checks.unresolved("pending mutation cannot rebind to refreshed epoch") {
                _ = try await adapter.requireProtected(credentialBinding: actor.account.credentialBinding).publish()
            }
            try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "changed epoch mutation refuses without replacement signature")
            DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
            try dmAccountModeDTO(try await adapter.refreshAccountMode(credentialBinding: actor.account.credentialBinding).publish(),
                actor: actor, mode: "protected-required", checks: checks)
        }
        try fixture.destroy()
    } catch {
        task.cancel(); gate.release(); _ = await task.result; throw error
    }
}

func runDmAccountModeProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmAccountModeChecks()
    DmScopedEnrollmentProtocol.reset(); defer { DmScopedEnrollmentProtocol.reset() }
    let fixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? fixture.destroy() }
    let actor = try await dmScopedEnrollmentLogin(fixture, userId: "81000000-0000-4000-8000-000000000001", bearer: "mode-fixture")
    let adapter = try dmAccountModeAdapter(actor), binding = actor.account.credentialBinding
    progressForResearch?("unregistered")
    let initial = try actor.store.read()
    DmScopedEnrollmentProtocol.setScripts([])
    for operation in [false, true] {
        try await checks.unresolved("mode operations do not enroll implicitly") {
            if operation { _ = try await adapter.requireProtected(credentialBinding: binding).publish() }
            else { _ = try await adapter.refreshAccountMode(credentialBinding: binding).publish() }
        }
    }
    try checks.require(try actor.store.read() == initial && DmScopedEnrollmentProtocol.captured().isEmpty,
        "unregistered operations preserve sealed state and make zero relay requests")
    try await dmScopedEnrollmentRegistered(actor, checks: DmScopedEnrollmentChecks())
    let before = try dmAccountModeSnapshot(actor)
    progressForResearch?("fresh-diagnostic")
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "legacy-permitted")])
    let legacyPublication = try await adapter.refreshAccountMode(credentialBinding: binding)
    try dmAccountModeDTO(legacyPublication.publish(), actor: actor,
        mode: "legacy-permitted", checks: checks)
    try checks.require(DmScopedEnrollmentProtocol.captured().count == 1, "explicit diagnostic has exactly one synthetic HTTP request")
    try dmAccountModeSigned(actor, DmScopedEnrollmentProtocol.captured()[0].body, action: "account-mode", checks: checks)
    try checks.require(try dmAccountModeSnapshot(actor) == before, "legacy diagnostic mutates no durable state")
    for fault in ["wrong-request", "wrong-owner", "wrong-device", "missing", "extra", "numeric", "duplicate", "escaped-duplicate", "oversized"] {
        DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required", accountModeFault: fault)])
        let unchanged = try actor.store.read()
        try await checks.unresolved("malformed account mode cannot become a receipt") {
            _ = try await adapter.refreshAccountMode(credentialBinding: binding).publish()
        }
        try checks.require(try actor.store.read() == unchanged, "malformed diagnostic changes no sealed fact")
    }
    progressForResearch?("sealed-intent")
    let snapshot = try actor.snapshot()
    let first = try dmAccountModeRequest(actor, require: true), committed = try actor.store.read()
    let repeated = try dmAccountModeRequest(actor, require: true)
    try checks.require(first.wire == repeated.wire && first.requestId == repeated.requestId && first.expiresAt == repeated.expiresAt,
        "pending cutover retries exact native signed wire nonce and expiry")
    try checks.require(first.attemptID != repeated.attemptID, "identical server bytes retain distinct native attempt fences")
    try checks.refuses("old legacy publication refuses after same-owner local selection") { _ = try legacyPublication.publish() }
    try checks.require(try actor.store.read() == committed, "repeat preparation does not rewrite durable intent")
    try checks.require(try dmAccountModeSnapshot(actor) == before, "cutover intent leaves all crypto enrollment peer and history bytes unchanged")
    try dmAccountModeSigned(actor, Data(first.wire.utf8), action: "require-protected", checks: checks)
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", loseAfterBody: true, accountMode: "protected-required")])
    try await checks.unresolved("lost cutover reply remains unresolved") { _ = try await adapter.requireProtected(credentialBinding: binding).publish() }
    try checks.require(try actor.store.read() == committed, "lost reply retains exact parked cutover intent")
    try checks.require(DmScopedEnrollmentProtocol.captured()[0].body == Data(first.wire.utf8), "lost response used saved wire only")
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "legacy-permitted")])
    try await checks.unresolved("local one-way selection refuses contradictory legacy mode") { _ = try await adapter.refreshAccountMode(credentialBinding: binding).publish() }
    try checks.require(try actor.store.read() == committed, "contradictory diagnostic never clears local selection")
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
    let publication = try await adapter.requireProtected(credentialBinding: binding)
    try dmAccountModeDTO(publication.publish(), actor: actor, mode: "protected-required", checks: checks)
    try checks.require(DmScopedEnrollmentProtocol.captured()[0].body == Data(first.wire.utf8), "successful retry reuses exact original signed intent")
    try checks.require(try dmAccountModeSnapshot(actor) == before, "confirmation grants no crypto peer or send policy state")
    try checks.refuses("cutover does not create a peer policy permit") {
        _ = try actor.facade.executeMessageOperation(snapshot: snapshot, operation: .relayPolicyState)
    }
    progressForResearch?("superseded-query")
    let old = try dmAccountModeRequest(actor, require: false)
    let current = try dmAccountModeRequest(actor, require: false)
    let response = try dmScopedEnrollmentJSON(["requestId": old.requestId, "ownerUserId": actor.account.accountId,
        "ownerDeviceId": actor.account.deviceId, "mode": "protected-required"])
    try checks.refuses("superseded native mode query cannot apply late") {
        _ = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(), operation: .relayAccountModeResponse(request: old, response: response))
    }
    try checks.require(current.requestId != old.requestId, "explicit diagnostic allocates fresh nonce rather than cached legacy outcome")
    progressForResearch?("renew-and-reopen")
    let preserved = try dmAccountModeSnapshot(actor, ignoringEpoch: true)
    try await actor.renew()
    try checks.refuses("captured mode DTO cannot publish after renewed Auth") { _ = try publication.publish() }
    let directory = try fixture.reopen(auth: dmScopedEnrollmentAuth()), facade = VodozemacSessionFacade(directory: directory)
    let account = try await facade.authenticate(accessToken: actor.bearer, authFence: facade.fenceSession(mode: .verify).authFence)
    let reopened = try DmScopedEnrollmentActor(fixture: fixture, facade: facade, account: account, bearer: actor.bearer, card: actor.card)
    let reopenedAdapter = try dmAccountModeAdapter(reopened)
    try checks.require(try dmAccountModeSnapshot(reopened, ignoringEpoch: true) == preserved,
        "reopen leaves original crypto enrollment and history unchanged")
    DmScopedEnrollmentProtocol.setScripts([])
    try await checks.unresolved("reopened mutation does not rebind historical pending epoch") { _ = try await reopenedAdapter.requireProtected(credentialBinding: account.credentialBinding).publish() }
    try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "reopen refuses historical mutation before HTTP")
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
    try dmAccountModeDTO(try await reopenedAdapter.refreshAccountMode(credentialBinding: account.credentialBinding).publish(),
        actor: reopened, mode: "protected-required", checks: checks)
    try fixture.destroy()
    progressForResearch?("auth-races")
    try await dmAccountModeRace(logout: false, checks: checks)
    try await dmAccountModeRace(logout: true, checks: checks)
    progressForResearch?("expired-intent")
    let expiredFixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? expiredFixture.destroy() }
    let expired = try await dmScopedEnrollmentLogin(expiredFixture,
        userId: "81000000-0000-4000-8000-000000000021", bearer: "mode-expiry-fixture")
    try await dmScopedEnrollmentRegistered(expired, checks: DmScopedEnrollmentChecks())
    let context = try expired.snapshot().context, state = try expired.store.read()
    guard var fields = try JSONSerialization.jsonObject(with: state.payload) as? [String: Any],
          let accountPickle = fields["account"] as? String,
          let owner = fields["owner"] as? [String: Any] else { throw DmAccountModeProbeError.assertion("expired native fixture facts") }
    // Seed an already-expired real signed intent. This is not elapsed wall-clock
    // or process-death evidence and never changes a human key/account.
    let now = Int64(Date().timeIntervalSince1970), nonce = UUID().uuidString.lowercased()
    let oldOwner = DmOwnerContext(userId: context.userId, deviceId: context.deviceId, generation: context.ownerGeneration)
    let signature = try signPublicRequest(accountPickle: accountPickle, pickleKey: expired.store.providerPickleKey(),
        message: DmRelayCodec.requestSigningBytes(owner: oldOwner, action: "require-protected", requestId: nonce,
            expiresAt: now - 10, payload: "[]"))
    let wire = try DmRelayCodec.requestWire(owner: oldOwner, action: "require-protected", requestId: nonce,
        expiresAt: now - 10, payload: "[]", signature: signature.signature)
    fields["protectedAccountIntent"] = ["owner": owner, "credentialEpoch": context.credentialEpoch.uuidString,
        "wire": wire, "requestId": nonce, "issuedAtSeconds": now - 250, "expiresAt": now - 10]
    try expired.store.commit(expectedRevision: state.revision, payload: dmScopedEnrollmentJSON(fields))
    let expiredAdapter = try dmAccountModeAdapter(expired), historical = try expired.store.read()
    DmScopedEnrollmentProtocol.setScripts([])
    try await checks.unresolved("expired original intent refuses rather than replacing nonce signature or expiry") {
        _ = try await expiredAdapter.requireProtected(credentialBinding: expired.account.credentialBinding).publish()
    }
    try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty && expired.store.read() == historical,
        "expired intent makes zero HTTP and retains exact sealed bytes")
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
    try dmAccountModeDTO(try await expiredAdapter.refreshAccountMode(credentialBinding: expired.account.credentialBinding).publish(),
        actor: expired, mode: "protected-required", checks: checks)
    guard let finalFields = try JSONSerialization.jsonObject(with: expired.store.read().payload) as? [String: Any] else {
        throw DmAccountModeProbeError.assertion("expired intent retained after diagnostic")
    }
    try checks.require(try dmScopedEnrollmentJSON(finalFields["protectedAccountIntent"] as! [String: Any])
        == dmScopedEnrollmentJSON(fields["protectedAccountIntent"] as! [String: Any]),
        "fresh diagnostic confirms account fact without relabelling historical mutation")
    try expiredFixture.destroy()
    return checks.assertions
}
