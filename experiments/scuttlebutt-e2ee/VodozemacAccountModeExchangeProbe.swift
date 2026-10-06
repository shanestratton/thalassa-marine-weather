// Fresh simulator fixture only. Native Auth uses an explicit /user fixture;
// registration/account-mode requests use ordinary URLSession HTTPS to the real
// local signed gateway and on-disk SQL. No hosted/human account or peer exists.
import Foundation
import CryptoKit

enum DmAccountModeExchangeProbeError: Error { case assertion(String) }
private final class DmAccountModeExchangeChecks {
    var assertions = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmAccountModeExchangeProbeError.assertion(label) }
        assertions += 1
    }
    func unresolved(_ label: String, _ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch DmRelayTransportError.unresolved { assertions += 1; return }
        throw DmAccountModeExchangeProbeError.assertion(label)
    }
}

// Installed ONLY in native Auth's separate ephemeral configuration. The relay
// transport below receives no URLProtocol, delegate or TLS trust override.
private final class DmAccountModeExchangeAuthProtocol: URLProtocol {
    static var expectedOrigin: String?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let origin = Self.expectedOrigin, let url = request.url,
              url.absoluteString == origin + "/auth/v1/user", request.httpMethod == "GET",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-alice",
              request.value(forHTTPHeaderField: "apikey") == "sb_publishable_fixture",
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json", "cache-control": "no-store"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired)); return
        }
        let body = Data("{\"id\":\"11111111-1111-4111-8111-111111111111\",\"user_metadata\":{\"actor\":\"ignored-fixture\"}}".utf8)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func dmAccountModeExchangeState(_ store: VodozemacSealedStore, excludingCutover: Bool) throws -> Data {
    guard var fields = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any] else {
        throw DmAccountModeExchangeProbeError.assertion("sealed-state-object")
    }
    if excludingCutover {
        fields.removeValue(forKey: "protectedAccountIntent"); fields.removeValue(forKey: "protectedAccountConfirmed")
    }
    return try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
}
private func dmAccountModeExchangeRequest(_ facade: VodozemacSessionFacade,
                                          snapshot: DmNativeMessageSnapshot) throws -> DmNativeRelayAccountModeRequest {
    guard case .accountModeRequest(let request) = try facade.executeMessageOperation(snapshot: snapshot,
        operation: .relayRequireProtectedWire) else {
        throw DmAccountModeExchangeProbeError.assertion("native-cutover-request")
    }
    return request
}

func runDmAccountModeExchangeProbe(origin: String, progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let checks = DmAccountModeExchangeChecks()
    DmAccountModeExchangeAuthProtocol.expectedOrigin = origin
    defer { DmAccountModeExchangeAuthProtocol.expectedOrigin = nil }
    let auth = try VodozemacSupabaseAuth(projectOrigin: origin, publicApiKey: "sb_publishable_fixture",
        deadlineSeconds: 5, configurationForResearch: {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DmAccountModeExchangeAuthProtocol.self]; return configuration
        })
    let fixture = try DmScopedEnrollmentFixture(auth: auth)
    defer { try? fixture.destroy() }
    let facade = VodozemacSessionFacade(directory: fixture.directory)
    progressForResearch?("native-auth")
    let fence = try facade.fenceSession(mode: .verify)
    let account = try await facade.authenticate(accessToken: "fixture-alice", authFence: fence.authFence)
    let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
    try checks.require(account.accountId == "11111111-1111-4111-8111-111111111111"
        && UUID(uuidString: account.deviceId)?.uuidString.lowercased() == account.deviceId,
        "native-auth-selects-fixture-account-and-native-device")
    try checks.require(snapshot.context.peerGeneration == nil && snapshot.context.userId == account.accountId
        && snapshot.context.deviceId == account.deviceId, "original-owner-only-native-snapshot")
    guard case .pairingCard(let card) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingCard) else {
        throw DmAccountModeExchangeProbeError.assertion("native-public-identity")
    }
    try checks.require(card.projectOrigin == origin, "native-project-pin-matches-local-https-relay")
    let native = try fixture.account(userId: account.accountId), store = native.0
    let client = VodozemacScopedRelayClient(facade: facade,
        transport: try VodozemacRelayTransport(serviceOrigin: origin, deadlineSeconds: 5))
    let initial = try store.read()
    for require in [false, true] {
        try await checks.unresolved("unregistered-control-never-enrolls") {
            if require { _ = try await client.requireProtected(snapshot: snapshot) }
            else { _ = try await client.refreshAccountMode(snapshot: snapshot) }
        }
    }
    try checks.require(try store.read() == initial, "unregistered-control-preserves-sealed-native-state")
    progressForResearch?("explicit-registration")
    let enrolled = try await client.registerDevice(snapshot: snapshot)
    try checks.require(enrolled.registration == .acknowledged && enrolled.claim == .none,
        "explicit-signed-registration-without-peer-claim")
    let unchanged = try dmAccountModeExchangeState(store, excludingCutover: true)
    let enrolledSnapshot = try store.read()
    progressForResearch?("legacy-diagnostic")
    let legacy = try await client.refreshAccountMode(snapshot: snapshot)
    try checks.require(legacy == .legacyPermitted, "real-sql-fresh-legacy-diagnostic")
    try checks.require(try store.read() == enrolledSnapshot, "legacy-diagnostic-does-not-cache-permission")
    let original = try dmAccountModeExchangeRequest(facade, snapshot: snapshot)
    let committed = try store.read()
    let frame = try JSONDecoder().decode(DmScopedEnrollmentFrame.self, from: Data(original.wire.utf8))
    try checks.require(frame.version == 1 && frame.protocolName == "olm-v1"
        && frame.action == "require-protected" && frame.payload == "[]"
        && frame.userId == account.accountId && frame.deviceId == account.deviceId
        && frame.requestId == original.requestId, "native-signed-original-cutover-bindings")
    let domain = try JSONSerialization.data(withJSONObject: ["thalassa-relay-request", 1, "olm-v1",
        frame.userId, frame.deviceId, frame.action, frame.requestId, frame.expiresAt, frame.payload] as [Any],
        options: [.withoutEscapingSlashes])
    let signingKey = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(card.identity.signingKey))
    try checks.require(signingKey.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64), for: domain),
        "real-native-signature-independent-domain")
    progressForResearch?("committed-reply-lost")
    try await checks.unresolved("lost-real-https-reply-is-unresolved") { _ = try await client.requireProtected(snapshot: snapshot) }
    try checks.require(try store.read() == committed, "lost-response-retains-exact-sealed-intent")
    let replay = try dmAccountModeExchangeRequest(facade, snapshot: snapshot)
    try checks.require(replay.wire.utf8.elementsEqual(original.wire.utf8)
        && replay.requestId == original.requestId && replay.expiresAt == original.expiresAt,
        "retry-preserves-original-wire-nonce-expiry")
    try checks.require(replay.attemptID != original.attemptID, "native-attempt-fence-does-not-change-server-nonce")
    progressForResearch?("exact-retry")
    let required = try await client.requireProtected(snapshot: snapshot)
    try checks.require(required == .protectedRequired, "real-sql-exact-retry-reconciles-cutover")
    let confirmed = try dmAccountModeExchangeRequest(facade, snapshot: snapshot)
    try checks.require(confirmed.wire.utf8.elementsEqual(original.wire.utf8), "confirmation-never-replaces-original-intent")
    progressForResearch?("protected-diagnostic")
    let current = try await client.refreshAccountMode(snapshot: snapshot)
    try checks.require(current == .protectedRequired, "real-sql-fresh-protected-diagnostic")
    try checks.require(try dmAccountModeExchangeState(store, excludingCutover: true) == unchanged,
        "cutover-changes-no-crypto-outbox-peer-or-enrollment-state")
    guard case .accountModeState(.protectedRequired) = try facade.executeMessageOperation(snapshot: snapshot,
        operation: .relayAccountModeGuard(.protectedRequired)) else {
        throw DmAccountModeExchangeProbeError.assertion("native-protected-publication-fact")
    }
    checks.assertions += 1
    progressForResearch?("exact-cleanup")
    try fixture.destroy()
    try checks.require(!FileManager.default.fileExists(atPath: fixture.root.path), "fresh-native-fixture-and-keys-cleaned")
    return checks.assertions
}
