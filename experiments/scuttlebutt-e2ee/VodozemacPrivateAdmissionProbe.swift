// Fresh native sealed fixtures only: real provider/Keychain/facade, fixture Auth.
// No hosted actor, production account, server-mode inference or network proof.
import Foundation

enum DmPrivateAdmissionProbeError: Error { case assertion(String) }
private final class DmPrivateAdmissionChecks {
    var count = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmPrivateAdmissionProbeError.assertion(label) }
        count += 1
    }
    func refuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSessionFacadeError.unavailable { count += 1; return }
        catch ResearchMessagingAdapterError.unavailable { count += 1; return }
        throw DmPrivateAdmissionProbeError.assertion(label)
    }
}
private func dmPrivateAdmissionAdapter(_ actor: DmScopedEnrollmentActor) throws -> ResearchMessagingAdapter {
    let transport = try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin, deadlineSeconds: 3,
        configurationForResearch: {
            let value = URLSessionConfiguration.ephemeral
            value.protocolClasses = [DmScopedEnrollmentProtocol.self]; return value
        })
    return ResearchMessagingAdapter(facade: actor.facade, transport: transport,
        projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
}
private func dmPrivateAdmissionDTO(_ value: [String: Any], actor: DmScopedEnrollmentActor,
                                   expected: String, checks: DmPrivateAdmissionChecks) throws {
    try checks.require(Set(value.keys) == ["status", "accountId", "deviceId", "credentialBinding", "selection"],
        "projection-has-exact-five-public-fields")
    try checks.require(value["status"] as? String == "private_admission"
        && value["accountId"] as? String == actor.account.accountId
        && value["deviceId"] as? String == actor.account.deviceId
        && value["credentialBinding"] as? String == actor.account.credentialBinding
        && value["selection"] as? String == expected, "projection-binds-original-owner-lease-and-denial-state")
    try checks.require(expected == "unknown" || expected == "protected-required", "projection-never-admits-legacy")
}
private func dmPrivateAdmissionRead(_ actor: DmScopedEnrollmentActor, expected: String,
                                    checks: DmPrivateAdmissionChecks) throws {
    let before = try actor.store.read()
    DmScopedEnrollmentProtocol.setScripts([])
    let dto = try dmPrivateAdmissionAdapter(actor).privateAdmissionState(credentialBinding: actor.account.credentialBinding).publish()
    try dmPrivateAdmissionDTO(dto, actor: actor, expected: expected, checks: checks)
    try checks.require(try actor.store.read() == before, "projection-does-not-sign-persist-or-change-crypto")
    try checks.require(DmScopedEnrollmentProtocol.captured().isEmpty, "projection-has-zero-relay-http-or-implicit-enrollment")
}

func runDmPrivateAdmissionProbe(progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmPrivateAdmissionChecks()
    DmScopedEnrollmentProtocol.reset(); defer { DmScopedEnrollmentProtocol.reset() }
    let fixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? fixture.destroy() }
    let actor = try await dmScopedEnrollmentLogin(fixture,
        userId: "82000000-0000-4000-8000-000000000001", bearer: "admission-local-fixture")
    let adapter = try dmPrivateAdmissionAdapter(actor)
    progressForResearch?("unknown-no-enrollment")
    try dmPrivateAdmissionRead(actor, expected: "unknown", checks: checks)
    let unknown = try adapter.privateAdmissionState(credentialBinding: actor.account.credentialBinding)
    try checks.refuses("caller-unknown-binding-never-selects-account") {
        _ = try adapter.privateAdmissionState(credentialBinding: UUID().uuidString.lowercased()).publish()
    }
    try checks.refuses("publication-guard-refuses-different-local-projection") {
        _ = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(), operation: .privateAdmissionGuard(.protectedRequired))
    }
    progressForResearch?("pending-and-confirmed")
    try await dmScopedEnrollmentRegistered(actor, checks: DmScopedEnrollmentChecks())
    guard case .accountModeRequest = try actor.facade.executeMessageOperation(snapshot: actor.snapshot(),
        operation: .relayRequireProtectedWire) else { throw DmPrivateAdmissionProbeError.assertion("native-sealed-selection-intent") }
    try dmPrivateAdmissionRead(actor, expected: "protected-required", checks: checks)
    try checks.refuses("late-unknown-publication-refuses-after-local-selection") { _ = try unknown.publish() }
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
    _ = try await adapter.requireProtected(credentialBinding: actor.account.credentialBinding).publish()
    try dmPrivateAdmissionRead(actor, expected: "protected-required", checks: checks)
    let oldBinding = actor.account.credentialBinding
    let old = try adapter.privateAdmissionState(credentialBinding: oldBinding)
    progressForResearch?("renew-and-cold-reopen")
    try await actor.renew()
    try checks.refuses("renewal-does-not-rebind-old-projection") { _ = try old.publish() }
    try checks.refuses("renewal-does-not-rebind-old-public-binding") { _ = try adapter.privateAdmissionState(credentialBinding: oldBinding).publish() }
    try dmPrivateAdmissionRead(actor, expected: "protected-required", checks: checks)
    let reopenedDirectory = try fixture.reopen(auth: dmScopedEnrollmentAuth())
    let reopenedFacade = VodozemacSessionFacade(directory: reopenedDirectory)
    let unavailableAdapter = ResearchMessagingAdapter(facade: reopenedFacade,
        transport: try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin),
        projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
    try checks.refuses("cold-process-has-no-restored-credential-authority") {
        _ = try unavailableAdapter.privateAdmissionState(credentialBinding: actor.account.credentialBinding).publish()
    }
    let reopenedAccount = try await reopenedFacade.authenticate(accessToken: actor.bearer,
        authFence: reopenedFacade.fenceSession(mode: .verify).authFence)
    let reopened = try DmScopedEnrollmentActor(fixture: fixture, facade: reopenedFacade,
        account: reopenedAccount, bearer: actor.bearer, card: actor.card)
    try checks.require(reopened.account.accountId == actor.account.accountId && reopened.account.deviceId == actor.account.deviceId,
        "cold-verification-keeps-exact-native-owner-and-device")
    try dmPrivateAdmissionRead(reopened, expected: "protected-required", checks: checks)
    let reopenedAdapter = try dmPrivateAdmissionAdapter(reopened)
    let beforeLogout = try reopenedAdapter.privateAdmissionState(credentialBinding: reopened.account.credentialBinding)
    progressForResearch?("logout-and-account-change")
    _ = try reopened.facade.fenceSession(mode: .signOut)
    try checks.refuses("signed-out-projection-cannot-publish") { _ = try beforeLogout.publish() }
    try checks.refuses("signed-out-public-binding-cannot-project") {
        _ = try reopenedAdapter.privateAdmissionState(credentialBinding: reopened.account.credentialBinding).publish()
    }
    try await reopened.renew()
    try dmPrivateAdmissionRead(reopened, expected: "protected-required", checks: checks)
    let previous = try reopenedAdapter.privateAdmissionState(credentialBinding: reopened.account.credentialBinding)
    _ = try reopened.facade.fenceSession(mode: .signOut)
    let otherUser = "82000000-0000-4000-8000-000000000002", otherBearer = "admission-other-local-fixture"
    DmScopedEnrollmentProtocol.install(bearer: otherBearer, userId: otherUser)
    let otherAccount = try await reopened.facade.authenticate(accessToken: otherBearer,
        authFence: reopened.facade.fenceSession(mode: .verify).authFence)
    guard case .pairingCard(let otherCard) = try reopened.facade.executeMessageOperation(
        snapshot: reopened.facade.messageSnapshot(credentialBinding: otherAccount.credentialBinding), operation: .pairingCard) else {
        throw DmPrivateAdmissionProbeError.assertion("other-native-account")
    }
    let other = try DmScopedEnrollmentActor(fixture: fixture, facade: reopened.facade,
        account: otherAccount, bearer: otherBearer, card: otherCard)
    try checks.refuses("account-change-does-not-publish-previous-selection") { _ = try previous.publish() }
    try dmPrivateAdmissionRead(other, expected: "unknown", checks: checks)
    try fixture.destroy()

    progressForResearch?("confirmed-without-intent")
    let confirmedFixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? confirmedFixture.destroy() }
    let confirmed = try await dmScopedEnrollmentLogin(confirmedFixture,
        userId: "82000000-0000-4000-8000-000000000011", bearer: "admission-confirmed-local-fixture")
    try await dmScopedEnrollmentRegistered(confirmed, checks: DmScopedEnrollmentChecks())
    DmScopedEnrollmentProtocol.setScripts([.init(path: "/v1/dispatch", accountMode: "protected-required")])
    _ = try await confirmed.client.refreshAccountMode(snapshot: confirmed.snapshot())
    guard let confirmation = try JSONSerialization.jsonObject(with: confirmed.store.read().payload) as? [String: Any] else {
        throw DmPrivateAdmissionProbeError.assertion("confirmed-native-state")
    }
    try checks.require(confirmation["protectedAccountIntent"] == nil && confirmation["protectedAccountConfirmed"] as? Bool == true,
        "protected-diagnostic-confirms-without-manufactured-mutation")
    try dmPrivateAdmissionRead(confirmed, expected: "protected-required", checks: checks)
    try confirmedFixture.destroy()

    progressForResearch?("expired-intent")
    let expiredFixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? expiredFixture.destroy() }
    let expired = try await dmScopedEnrollmentLogin(expiredFixture,
        userId: "82000000-0000-4000-8000-000000000021", bearer: "admission-expired-local-fixture")
    try await dmScopedEnrollmentRegistered(expired, checks: DmScopedEnrollmentChecks())
    let context = try expired.snapshot().context, snapshot = try expired.store.read()
    guard var fields = try JSONSerialization.jsonObject(with: snapshot.payload) as? [String: Any],
          let accountPickle = fields["account"] as? String, let ownerFields = fields["owner"] as? [String: Any] else {
        throw DmPrivateAdmissionProbeError.assertion("expired-local-owned-state")
    }
    let clock = Int64(Date().timeIntervalSince1970), nonce = UUID().uuidString.lowercased()
    let owner = DmOwnerContext(userId: context.userId, deviceId: context.deviceId, generation: context.ownerGeneration)
    let signature = try signPublicRequest(accountPickle: accountPickle, pickleKey: expired.store.providerPickleKey(),
        message: DmRelayCodec.requestSigningBytes(owner: owner, action: "require-protected", requestId: nonce,
            expiresAt: clock - 10, payload: "[]"))
    let wire = try DmRelayCodec.requestWire(owner: owner, action: "require-protected", requestId: nonce,
        expiresAt: clock - 10, payload: "[]", signature: signature.signature)
    fields["protectedAccountIntent"] = ["owner": ownerFields, "credentialEpoch": context.credentialEpoch.uuidString,
        "wire": wire, "requestId": nonce, "issuedAtSeconds": clock - 250, "expiresAt": clock - 10]
    try expired.store.commit(expectedRevision: snapshot.revision, payload: dmScopedEnrollmentJSON(fields))
    try dmPrivateAdmissionRead(expired, expected: "protected-required", checks: checks)
    try await expired.renew()
    try dmPrivateAdmissionRead(expired, expected: "protected-required", checks: checks)
    try expiredFixture.destroy()

    progressForResearch?("missing-key-cold-refusal")
    let missingFixture = try DmScopedEnrollmentFixture(auth: dmScopedEnrollmentAuth())
    defer { try? missingFixture.destroy() }
    let missing = try await dmScopedEnrollmentLogin(missingFixture,
        userId: "82000000-0000-4000-8000-000000000031", bearer: "admission-missing-key-local-fixture")
    try await dmScopedEnrollmentRegistered(missing, checks: DmScopedEnrollmentChecks())
    guard case .accountModeRequest = try missing.facade.executeMessageOperation(snapshot: missing.snapshot(),
        operation: .relayRequireProtectedWire) else { throw DmPrivateAdmissionProbeError.assertion("missing-key-local-intent") }
    missingFixture.directory.closeForResearch(); missing.store.close()
    try VodozemacSealedStore.deleteResearchKey(storeID: missing.store.storeID)
    let missingDirectory = try missingFixture.reopen(auth: dmScopedEnrollmentAuth())
    let missingFacade = VodozemacSessionFacade(directory: missingDirectory)
    try checks.refuses("missing-key-refuses-cold-authority-without-replacement") { _ = try missingFacade.fenceSession(mode: .verify) }
    let missingAdapter = ResearchMessagingAdapter(facade: missingFacade,
        transport: try VodozemacRelayTransport(serviceOrigin: dmScopedEnrollmentOrigin),
        projectOrigin: dmScopedEnrollmentOrigin, conversationId: DmScopedEnrollmentFixture.conversationId)
    try checks.refuses("missing-key-does-not-emit-unknown-as-legacy") {
        _ = try missingAdapter.privateAdmissionState(credentialBinding: missing.account.credentialBinding).publish()
    }
    try missingFixture.destroy()
    return checks.count
}
