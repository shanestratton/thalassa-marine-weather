// ISOLATED RESEARCH ONLY. URLProtocol supplies synthetic Auth responses; no
// production bearer, live Supabase account, app login or device registration.
// These checks exercise native scopes, real provider bytes and sealed storage.
// They do not establish TLS trust, real logout revocation, physical-phone or
// locked-device behaviour, deployment, or an independent security audit.
import Foundation

enum DmAuthProbeError: Error { case assertion(String) }

private final class DmAuthProbeChecks {
    private(set) var assertions = 0
    func require(_ value: Bool, _ label: String) throws {
        guard value else { throw DmAuthProbeError.assertion(label) }
        assertions += 1
    }
    func sessionSucceeds(_ label: String, _ operation: () async throws -> DmLifecycleSnapshot) async throws -> DmLifecycleSnapshot {
        do { return try await operation() }
        catch let failure as DmAuthProbeError { throw failure }
        catch { throw DmAuthProbeError.assertion(label) }
    }
    func transportSucceeds(_ label: String, _ operation: () async throws -> String) async throws -> String {
        do { return try await operation() }
        catch let failure as DmAuthProbeError { throw failure }
        catch { throw DmAuthProbeError.assertion(label) }
    }
    func sessionRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmAuthSessionError.unavailable { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func sessionRefuses(_ label: String, _ operation: () async throws -> DmLifecycleSnapshot) async throws {
        do { _ = try await operation() }
        catch DmAuthSessionError.unavailable { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func transportRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmSupabaseAuthError.unavailable { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func transportRefuses(_ label: String, _ operation: () async throws -> String) async throws {
        do { _ = try await operation() }
        catch DmSupabaseAuthError.unavailable { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func unavailable(_ session: VodozemacAuthSession, _ label: String) throws {
        try require(session.currentContext() == nil, label + " has no context")
        try sessionRefuses(label + " has no credential") { _ = try session.credential() }
    }
    func staleRevision(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.staleRevision { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func unsupportedState(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.unsupportedState { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
    func staleCredential(_ session: VodozemacAuthSession, _ label: String) throws {
        try require(session.currentContext() == nil, label + " has no current context")
        do { _ = try session.credential() }
        catch DmAuthSessionError.unavailable { try require(true, label + " credential refused"); return }
        catch DmCoordinatorError.unavailable { try require(true, label + " credential refused"); return }
        throw DmAuthProbeError.assertion(label)
    }
    func contextRefuses(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.unavailable { try require(true, label); return }
        throw DmAuthProbeError.assertion(label)
    }
}

// A response gate queues callbacks and invokes them after unlocking. It never
// blocks a URLSession queue, and release-before-registration is deterministic.
private final class DmAuthProbeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var released = false
    private var callbacks: [() -> Void] = []
    func afterRelease(_ callback: @escaping () -> Void) {
        lock.lock()
        if released { lock.unlock(); callback(); return }
        callbacks.append(callback)
        lock.unlock()
    }
    func release() {
        lock.lock(); released = true; let ready = callbacks; callbacks.removeAll(); lock.unlock()
        for callback in ready { callback() }
    }
}

private final class DmAuthProbeProtocol: URLProtocol, @unchecked Sendable {
    struct Script {
        var body: Data
        var status = 200
        var contentType = "application/json"
        var url = URL(string: "https://auth-fixture.invalid/auth/v1/user")!
        var contentLength: String?
        var gate: DmAuthProbeGate?
        var neverFinish = false
        var repeatChunk = false
        var connectionError = false
        var redirectURL: URL?
        init(userId: String) { body = Data("{\"id\":\"\(userId)\"}".utf8) }
    }
    private static let fixtureLock = NSLock()
    private static var scripts: [String: Script] = [:]
    private static var requests: [URLRequest] = []
    private let stateLock = NSLock()
    private var stopped = false
    static func install(_ script: Script, bearer: String) {
        fixtureLock.lock(); scripts["Bearer " + bearer] = script; fixtureLock.unlock()
    }
    static func captured() -> [URLRequest] {
        fixtureLock.lock(); defer { fixtureLock.unlock() }; return requests
    }
    static func count(bearer: String) -> Int {
        captured().filter { $0.value(forHTTPHeaderField: "Authorization") == "Bearer " + bearer }.count
    }
    static func reset() {
        fixtureLock.lock(); scripts.removeAll(); requests.removeAll(); fixtureLock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool {
        ["auth-fixture.invalid", "other-auth-fixture.invalid", "other.invalid"].contains(request.url?.host ?? "")
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.fixtureLock.lock()
        let script = Self.scripts[request.value(forHTTPHeaderField: "Authorization") ?? ""]
        Self.requests.append(request)
        Self.fixtureLock.unlock()
        guard let script else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
        }
        let respond = { [self] in DispatchQueue.global().async { [self] in deliver(script) } }
        if let gate = script.gate { gate.afterRelease(respond) } else { respond() }
    }
    private func isStopped() -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopped }
    private func deliver(_ script: Script) {
        guard !isStopped() else { return }
        var headers = ["Content-Type": script.contentType]
        if let length = script.contentLength { headers["Content-Length"] = length }
        let response = HTTPURLResponse(url: script.url, statusCode: script.status,
            httpVersion: "HTTP/1.1", headerFields: headers)!
        // Client callbacks can synchronously cancel/reenter stopLoading. No
        // fixture/state lock is held across any callback, including redirects.
        if let url = script.redirectURL {
            var redirected = request; redirected.url = url
            client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        guard !isStopped() else { return }
        if !script.body.isEmpty { client?.urlProtocol(self, didLoad: script.body) }
        guard !isStopped() else { return }
        if script.connectionError {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
        }
        if script.repeatChunk { drip() }
        else if !script.neverFinish { client?.urlProtocolDidFinishLoading(self) }
    }
    private func drip() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.005) { [self] in
            guard !isStopped() else { return }
            client?.urlProtocol(self, didLoad: Data(" ".utf8))
            drip()
        }
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

private final class DmAuthProbeConfiguration: @unchecked Sendable {
    private let lock = NSLock()
    private var value: URLSessionConfiguration?
    func create() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DmAuthProbeProtocol.self]
        config.urlCache = URLCache(memoryCapacity: 1024, diskCapacity: 0)
        config.urlCredentialStorage = .shared
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        config.httpAdditionalHeaders = ["Cookie": "fixture-must-be-removed", "X-Fixture": "must-be-removed"]
        lock.lock(); value = config; lock.unlock()
        return config
    }
    func read() -> URLSessionConfiguration? { lock.lock(); defer { lock.unlock() }; return value }
}

private func dmAuthProbeAuthenticator(deadline: TimeInterval = 2,
                                      configuration: DmAuthProbeConfiguration = DmAuthProbeConfiguration()) throws -> VodozemacSupabaseAuth {
    try VodozemacSupabaseAuth(projectOrigin: "https://auth-fixture.invalid",
        publicApiKey: "sb_publishable_research_fixture", deadlineSeconds: deadline,
        configurationForResearch: configuration.create)
}

// Wait for real fixture dispatch, rather than assuming a task starts within a
// chosen sleep. The monotonic bound turns scheduling failures into assertions.
private func dmAuthProbeAwaitRequest(_ bearer: String, count: Int = 1) async throws {
    let bound = ContinuousClock.now.advanced(by: .seconds(2))
    while DmAuthProbeProtocol.count(bearer: bearer) < count {
        guard ContinuousClock.now < bound else { throw DmAuthProbeError.assertion("fixture request did not start") }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private final class DmAuthProbeCommitHook: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (() throws -> Void)?
    func arm(_ action: @escaping () throws -> Void) { lock.lock(); self.action = action; lock.unlock() }
    func call() throws {
        lock.lock(); let action = self.action; self.action = nil; lock.unlock()
        try action?()
    }
}

private final class DmAuthProbeCommitGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var arrived = false
    private var released = false
    func hold() throws {
        lock.lock(); arrived = true; lock.unlock()
        guard semaphore.wait(timeout: .now() + 5) == .success else {
            throw DmAuthProbeError.assertion("failed authority commit fixture exceeded bound")
        }
    }
    func hasArrived() -> Bool { lock.lock(); defer { lock.unlock() }; return arrived }
    func release() {
        lock.lock(); let shouldSignal = !released; released = true; lock.unlock()
        if shouldSignal { semaphore.signal() }
    }
}

private func dmAuthProbeAwaitCommitGate(_ gate: DmAuthProbeCommitGate) async throws {
    let bound = ContinuousClock.now.advanced(by: .seconds(2))
    while !gate.hasArrived() {
        guard ContinuousClock.now < bound else { throw DmAuthProbeError.assertion("failed authority commit fixture did not start") }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
}

private final class DmAuthProbeTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<DmLifecycleSnapshot, Error>?
    func set(_ task: Task<DmLifecycleSnapshot, Error>) { lock.lock(); self.task = task; lock.unlock() }
    func cancel() { lock.lock(); let task = self.task; lock.unlock(); task?.cancel() }
}

// Fake time changes only this native session's verification lease; transport
// deadlines and request polling always retain the real monotonic clock.
private final class DmAuthProbeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ContinuousClock.now
    private var pendingReads: [ContinuousClock.Instant] = []
    func read() -> ContinuousClock.Instant {
        lock.lock(); defer { lock.unlock() }
        return pendingReads.isEmpty ? value : pendingReads.removeFirst()
    }
    func advance(seconds: Int) {
        lock.lock(); value = value.advanced(by: .seconds(seconds)); pendingReads.removeAll(); lock.unlock()
    }
    func crossOnSecondRead(from verifiedAt: ContinuousClock.Instant) {
        lock.lock()
        pendingReads = [verifiedAt.advanced(by: .seconds(59)), verifiedAt.advanced(by: .seconds(60))]
        value = verifiedAt.advanced(by: .seconds(60))
        lock.unlock()
    }
}

// This fixture authority is a separate real Keychain/sealed SQLite store, not
// a callback Boolean. Its transaction holds the snapshot binding through each
// Auth mutation. Production authority still belongs to AccountDirectory.
private final class DmAuthProbeScopeGuard: DmNativeAuthScopeGuard {
    private let store: VodozemacSealedStore
    private let expected: VodozemacSealedStore.Snapshot
    private let faultLock = NSLock()
    private var failNextCommit = false
    private let afterFailure = DmAuthProbeCommitHook()
    init(store: VodozemacSealedStore) throws { self.store = store; expected = try store.read() }
    func failNextCommitForResearch(afterFailure: (() throws -> Void)? = nil) {
        if let afterFailure { self.afterFailure.arm(afterFailure) }
        faultLock.lock(); failNextCommit = true; faultLock.unlock()
    }
    func withCurrentScope<T>(_ operation: () throws -> T) throws -> T {
        faultLock.lock(); let failCommit = failNextCommit; failNextCommit = false; faultLock.unlock()
        do {
            return try store.withAuthoritySnapshotForResearch({ current in
                guard current == expected else { throw DmAuthSessionError.unavailable }
                return try operation()
            }, fault: failCommit ? .beforeCommit : .none)
        } catch {
            // The index transaction has released authority before this hook.
            // A newer verification may now win before the old call cleans up.
            if failCommit { try afterFailure.call() }
            throw error
        }
    }
}

private final class DmAuthProbeFixture {
    let id: UUID
    let directory: URL
    let owner: DmOwnerContext
    var store: VodozemacSealedStore
    var coordinator: VodozemacDmCoordinator
    private var removed = false
    init(id: UUID = UUID(), userId: String = "11111111-1111-4111-8111-111111111111",
         deviceId: String? = nil) throws {
        self.id = id
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(id.uuidString, isDirectory: true)
        owner = DmOwnerContext(userId: userId, deviceId: deviceId ?? id.uuidString.lowercased(), generation: 11)
        store = try VodozemacSealedStore.create(directory: directory, storeID: id, initialPayload: Data("{}".utf8))
        do {
            coordinator = try VodozemacDmCoordinator.bootstrapForResearch(store: store, owner: owner,
                identityKeyId: "auth-fixture-identity", conversationId: "auth-fixture-conversation")
        } catch { try? store.destroyForTesting(); throw error }
    }
    func reopen() throws {
        store.close()
        store = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
        coordinator = try VodozemacDmCoordinator(store: store)
    }
    func destroy() throws {
        guard !removed else { return }
        try store.destroyForTesting()
        removed = true
    }
    deinit { if !removed { try? store.destroyForTesting() } }
}

private func dmAuthProbeIdentityMatches(_ a: DmPublicIdentity, _ b: DmPublicIdentity) -> Bool {
    zip([a.userId, a.deviceId, a.identityKeyId, a.signingKey, a.curve, a.prekey],
        [b.userId, b.deviceId, b.identityKeyId, b.signingKey, b.curve, b.prekey])
        .allSatisfy { $0.0.utf8.elementsEqual($0.1.utf8) }
}

private func dmAuthProbeStoredEnvelopes(_ store: VodozemacSealedStore) throws -> [Data] {
    guard let state = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any],
          let outbox = state["outbox"] as? [[String: Any]] else {
        throw DmAuthProbeError.assertion("fixture outbox has expected sealed shape")
    }
    return try outbox.map { row in
        guard let record = row["record"] as? [String: Any], let envelope = record["serializedEnvelope"] as? String else {
            throw DmAuthProbeError.assertion("fixture sealed envelope exists")
        }
        return Data(envelope.utf8)
    }
}

private func dmAuthProbeLegacyKey(role: String) -> String {
    let payload = Data("{\"role\":\"\(role)\"}".utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "eyJhbGciOiJIUzI1NiJ9." + payload + ".fixture"
}

private func dmAuthProbeTransport(checks: DmAuthProbeChecks) async throws {
    let user = "11111111-1111-4111-8111-111111111111"
    let configuration = DmAuthProbeConfiguration()
    let authenticator = try dmAuthProbeAuthenticator(deadline: 2, configuration: configuration)
    let token = "fixture.transport.token"
    for origin in ["http://auth-fixture.invalid", "https://auth-fixture.invalid/", "https://auth-fixture.invalid/path",
                   "https://name:password@auth-fixture.invalid", "https://auth-fixture.invalid?token=x",
                   "https://auth-fixture.invalid#fragment", "https://AUTH-fixture.invalid", "https://auth-fixture.invalid.",
                   "https://auth-fixture.invalid:443", "https://", "https://auth-fixture.invalid\n"] {
        try checks.transportRefuses("invalid Auth project origin refused") {
            _ = try VodozemacSupabaseAuth(projectOrigin: origin, publicApiKey: "sb_publishable_research_fixture")
        }
    }
    for deadline in [0, -1, 10.1, Double.infinity, Double.nan] {
        try checks.transportRefuses("invalid Auth deadline refused") {
            _ = try VodozemacSupabaseAuth(projectOrigin: "https://auth-fixture.invalid",
                publicApiKey: "sb_publishable_research_fixture", deadlineSeconds: deadline)
        }
    }
    for key in ["", "sb_publishable_", "sb_secret_fixture", "fixture-untyped-key", "sb_publishable_bad\r\nheader",
                dmAuthProbeLegacyKey(role: "service_role"), dmAuthProbeLegacyKey(role: "authenticated")] {
        try checks.transportRefuses("non-public or malformed Auth API key refused") {
            _ = try VodozemacSupabaseAuth(projectOrigin: "https://auth-fixture.invalid", publicApiKey: key)
        }
    }
    _ = try VodozemacSupabaseAuth(projectOrigin: "https://auth-fixture.invalid", publicApiKey: dmAuthProbeLegacyKey(role: "anon"))
    try checks.require(true, "legacy public anon configuration accepted without authenticating its claims")
    var good = DmAuthProbeProtocol.Script(userId: user)
    good.body = Data("{\"id\":\"\(user)\",\"user_metadata\":{\"id\":\"22222222-2222-4222-8222-222222222222\",\"deviceId\":\"spoofed\"}}".utf8)
    DmAuthProbeProtocol.install(good, bearer: token)
    let verified = try await checks.transportSucceeds("positive Auth transport fixture unexpectedly refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    try checks.require(verified == user,
        "only top-level verified UUID selects the account; metadata cannot select device")
    guard let request = DmAuthProbeProtocol.captured().last, let config = configuration.read() else {
        throw DmAuthProbeError.assertion("Auth fixture captured request and configuration")
    }
    try checks.require(request.url?.absoluteString == "https://auth-fixture.invalid/auth/v1/user"
        && request.httpMethod == "GET" && request.httpBody == nil && request.httpBodyStream == nil,
        "Auth sends exact GET endpoint with no body or caller claims")
    try checks.require(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + token
        && request.value(forHTTPHeaderField: "apikey") == "sb_publishable_research_fixture"
        && request.value(forHTTPHeaderField: "Accept") == "application/json"
        && request.value(forHTTPHeaderField: "Cookie") == nil && request.value(forHTTPHeaderField: "X-Fixture") == nil,
        "Auth headers contain exact bearer/public key and no inherited fixture headers")
    try checks.require(config.urlCache == nil && config.urlCredentialStorage == nil && config.httpCookieStorage == nil
        && config.httpAdditionalHeaders == nil && !config.httpShouldSetCookies
        && config.requestCachePolicy == .reloadIgnoringLocalCacheData && !config.waitsForConnectivity
        && config.timeoutIntervalForRequest == 2 && config.timeoutIntervalForResource == 2,
        "Auth disables cache, cookies, credentials, inherited headers and connectivity wait")
    let countBeforeBadTokens = DmAuthProbeProtocol.captured().count
    for bad in ["", "a b", "a\r\n", "é", "=", "a==b", String(repeating: "a", count: 8193)] {
        try await checks.transportRefuses("unsafe bearer refused before dispatch") {
            try await authenticator.authenticate(bearer: bad, currentAttempt: { true })
        }
    }
    try await checks.transportRefuses("invalid current attempt refused before dispatch") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { false })
    }
    try checks.require(DmAuthProbeProtocol.captured().count == countBeforeBadTokens,
        "invalid bearer and stale attempt start no HTTP request")

    for body in ["", "null", "[]", "{}", "not-json", "{\"id\":null}", "{\"id\":1}", "{\"id\":true}",
                 "{\"id\":{\"id\":\"\(user)\"}}", "{\"user\":{\"id\":\"\(user)\"}}",
                 "{\"user_metadata\":{\"id\":\"\(user)\"}}", "{\"id\":\"not-a-uuid\"}",
                 "{\"id\":\"\(user) \"}",
                 "{\"id\":\"\(user)\",\"id\":\"\(user)\"}",
                 "{\"id\":\"\(user)\",\"\\u0069d\":\"\(user)\"}",
                 "{\"id\":\"\(user)\"} trailing", "{\"id\":\"\(user)\""] {
        var bad = DmAuthProbeProtocol.Script(userId: user); bad.body = Data(body.utf8)
        DmAuthProbeProtocol.install(bad, bearer: token)
        try await checks.transportRefuses("malformed/missing/nested/noncanonical/duplicate Auth id refused") {
            try await authenticator.authenticate(bearer: token, currentAttempt: { true })
        }
    }
    // The UUID fixture must contain hex letters for uppercase rejection.
    var upper = DmAuthProbeProtocol.Script(userId: "abcdefab-cdef-4abc-8def-abcdefabcdef".uppercased())
    DmAuthProbeProtocol.install(upper, bearer: token)
    try await checks.transportRefuses("uppercase canonical-width Auth UUID refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    upper.body = Data("{\"id\":\"\(user)\\n\"}".utf8)
    DmAuthProbeProtocol.install(upper, bearer: token)
    try await checks.transportRefuses("newline-suffixed Auth UUID refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    for status in [201, 204, 301, 302, 307, 308, 401, 403, 429, 500, 503] {
        var bad = DmAuthProbeProtocol.Script(userId: user); bad.status = status
        DmAuthProbeProtocol.install(bad, bearer: token)
        try await checks.transportRefuses("non-200 Auth status refused") {
            try await authenticator.authenticate(bearer: token, currentAttempt: { true })
        }
    }
    for type in ["text/html", "application/json; charset=latin-1", "application/json; x=y", "application/json, text/html"] {
        var bad = DmAuthProbeProtocol.Script(userId: user); bad.contentType = type
        DmAuthProbeProtocol.install(bad, bearer: token)
        try await checks.transportRefuses("invalid Auth content type refused") {
            try await authenticator.authenticate(bearer: token, currentAttempt: { true })
        }
    }
    var badURL = DmAuthProbeProtocol.Script(userId: user)
    badURL.url = URL(string: "https://other.invalid/auth/v1/user")!
    DmAuthProbeProtocol.install(badURL, bearer: token)
    try await checks.transportRefuses("different final Auth URL refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    for length in ["524289", "-1", "01", "invalid"] {
        var bad = DmAuthProbeProtocol.Script(userId: user); bad.contentLength = length
        DmAuthProbeProtocol.install(bad, bearer: token)
        try await checks.transportRefuses("oversized or malformed declared Auth length refused") {
            try await authenticator.authenticate(bearer: token, currentAttempt: { true })
        }
    }
    var overflow = DmAuthProbeProtocol.Script(userId: user); overflow.body = Data(repeating: 32, count: 524289)
    DmAuthProbeProtocol.install(overflow, bearer: token)
    try await checks.transportRefuses("streamed Auth response cap enforced") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    var invalidUTF8 = DmAuthProbeProtocol.Script(userId: user)
    invalidUTF8.body = Data("{\"id\":\"".utf8) + Data([255]) + Data("\"}".utf8)
    DmAuthProbeProtocol.install(invalidUTF8, bearer: token)
    try await checks.transportRefuses("invalid UTF8 Auth body refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    invalidUTF8.body = Data("{\"id\":\"\(user)\"}".utf16.flatMap { [UInt8($0 & 255), UInt8($0 >> 8)] })
    DmAuthProbeProtocol.install(invalidUTF8, bearer: token)
    try await checks.transportRefuses("UTF16 autodetection cannot disguise an Auth object") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    var broken = DmAuthProbeProtocol.Script(userId: user); broken.connectionError = true
    DmAuthProbeProtocol.install(broken, bearer: token)
    try await checks.transportRefuses("Auth network failure refused") {
        try await authenticator.authenticate(bearer: token, currentAttempt: { true })
    }
    for destination in ["https://auth-fixture.invalid/auth/v1/redirect-target", "https://other.invalid/auth/v1/user"] {
        var redirect = DmAuthProbeProtocol.Script(userId: user); redirect.status = 307
        redirect.redirectURL = URL(string: destination)!
        DmAuthProbeProtocol.install(redirect, bearer: token)
        let before = DmAuthProbeProtocol.captured().count
        try await checks.transportRefuses("Auth redirect callback refuses bearer forwarding") {
            try await authenticator.authenticate(bearer: token, currentAttempt: { true })
        }
        try checks.require(DmAuthProbeProtocol.captured().count == before + 1, "redirect sends no second fixture request")
    }
    // Ordinary valid/invalid-response fixtures get two seconds. Only deliberate
    // stalled/dripping/header-timeout scenarios use this short transport.
    let timeoutAuthenticator = try dmAuthProbeAuthenticator(deadline: 0.15)
    for drip in [false, true] {
        var stalled = DmAuthProbeProtocol.Script(userId: user)
        stalled.body = Data(); stalled.neverFinish = true; stalled.repeatChunk = drip
        DmAuthProbeProtocol.install(stalled, bearer: token)
        let start = ContinuousClock.now
        try await checks.transportRefuses("monotonic Auth deadline refuses stalled or endless response") {
            try await timeoutAuthenticator.authenticate(bearer: token, currentAttempt: { true })
        }
        try checks.require(start.duration(to: .now) < .seconds(1), "Auth timeout finishes within bounded fixture wait")
    }
    let gate = DmAuthProbeGate(); defer { gate.release() }
    var slow = DmAuthProbeProtocol.Script(userId: user); slow.gate = gate
    DmAuthProbeProtocol.install(slow, bearer: token)
    try await checks.transportRefuses("Auth deadline also bounds waiting for headers") {
        try await timeoutAuthenticator.authenticate(bearer: token, currentAttempt: { true })
    }
}

/// Called only by the disposable native research runner. Returns assertion count;
/// bearer strings, keys, native snapshots and plaintext are never exported.
public func runAuthSessionProbeForResearch() async throws -> Int {
    do { return try await dmAuthProbeRun() }
    catch let failure as DmAuthProbeError { throw failure }
    catch { throw DmAuthProbeError.assertion("native Auth probe unexpected setup or storage failure") }
}

private func dmAuthProbeRun() async throws -> Int {
    let checks = DmAuthProbeChecks()
    DmAuthProbeProtocol.reset()
    defer { DmAuthProbeProtocol.reset() }
    do { try await dmAuthProbeTransport(checks: checks) }
    catch let failure as DmAuthProbeError { throw failure }
    catch { throw DmAuthProbeError.assertion("native Auth transport fixture unexpected failure") }

    var fixtures: [DmAuthProbeFixture] = []
    var extraHandles: [VodozemacSealedStore] = []
    defer {
        for handle in extraHandles { handle.close() }
        for fixture in fixtures { try? fixture.destroy() }
    }
    func fixture(id: UUID = UUID(), userId: String = "11111111-1111-4111-8111-111111111111",
                 deviceId: String? = nil) throws -> DmAuthProbeFixture {
        do {
            let value = try DmAuthProbeFixture(id: id, userId: userId, deviceId: deviceId)
            fixtures.append(value); return value
        } catch { throw DmAuthProbeError.assertion("native Auth fixture store or bootstrap unexpectedly refused") }
    }
    let auth = try dmAuthProbeAuthenticator()
    let legacyFixture = try fixture()
    let legacyKey = try legacyFixture.store.providerPickleKey()
    let legacyBefore = try legacyFixture.store.read()
    guard var legacyPayload = try JSONSerialization.jsonObject(with: legacyBefore.payload) as? [String: Any] else {
        throw DmAuthProbeError.assertion("legacy Auth fixture has expected native state shape")
    }
    legacyPayload["version"] = 4
    legacyPayload.removeValue(forKey: "authProjectOrigin")
    _ = try legacyFixture.store.commit(expectedRevision: legacyBefore.revision,
        payload: JSONSerialization.data(withJSONObject: legacyPayload))
    let legacyCommitted = try legacyFixture.store.read()
    try checks.unsupportedState("prior version-four issuerless snapshot is refused rather than implicitly migrated") {
        _ = try VodozemacDmCoordinator(store: legacyFixture.store)
    }
    try checks.unsupportedState("native Auth refuses a prior-version scope without recreating an identity") {
        _ = try VodozemacAuthSession(coordinator: legacyFixture.coordinator, authenticator: auth)
    }
    try checks.require(try legacyFixture.store.read() == legacyCommitted
        && legacyFixture.store.providerPickleKey() == legacyKey,
        "prior-version refusals preserve exact sealed snapshot and original native key")
    for invalid in [try fixture(userId: "caller-selected-user"), try fixture(deviceId: "caller-selected-device")] {
        try checks.sessionRefuses("native auth refuses noncanonical account or caller-selected device scope") {
            _ = try VodozemacAuthSession(coordinator: invalid.coordinator, authenticator: auth)
        }
    }

    // Sort native-generated store IDs so this fixture can initiate its one
    // research crypto session; the device ID remains the exact native store ID.
    let ids = [UUID(), UUID()].sorted { $0.uuidString.lowercased() < $1.uuidString.lowercased() }
    let primary = try fixture(id: ids[0])
    let peer = try fixture(id: ids[1], userId: "22222222-2222-4222-8222-222222222222")
    let originalIdentity = try primary.coordinator.publicIdentity(owner: primary.owner)
    let peerIdentity = try peer.coordinator.publicIdentity(owner: peer.owner)
    let peerGeneration: Int64 = 7
    try primary.coordinator.installPeerForResearch(DmPeerContext(userId: peerIdentity.userId, deviceId: peerIdentity.deviceId,
        identityKeyId: peerIdentity.identityKeyId, curve: peerIdentity.curve, prekey: peerIdentity.prekey,
        generation: peerGeneration, status: .accepted), owner: primary.owner)
    let pending = try primary.coordinator.prepare(clientMessageId: "auth-original-pending", text: "synthetic auth fixture",
        owner: primary.owner, peerGeneration: peerGeneration)
    var session = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: auth)
    let otherAuth = try VodozemacSupabaseAuth(projectOrigin: "https://other-auth-fixture.invalid",
        publicApiKey: "sb_publishable_research_fixture", deadlineSeconds: 1,
        configurationForResearch: DmAuthProbeConfiguration().create)
    // Construct before the trusted project is first sealed. Its later attempt
    // must recheck the binding even though construction was initially possible.
    let preconstructedOtherProject = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: otherAuth)
    let coldSnapshot = try primary.store.read()
    try checks.unavailable(session, "cold active fixture has no authenticated readiness")
    try checks.require(try primary.store.read() == coldSnapshot, "constructing session cannot mutate durable scope")
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.first.token")
    let first = try await checks.sessionSucceeds("positive native first Auth unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.first.token")
    }
    let credential = try session.credential(peerGeneration: peerGeneration)
    try checks.require(first.active && first.owner == primary.owner
        && credential.context == session.currentContext(peerGeneration: peerGeneration), "successful Auth installs exact native owner context")
    let pinnedSnapshot = try primary.store.read()
    let beforeCrossProjectRequests = DmAuthProbeProtocol.captured().count
    try checks.sessionRefuses("constructor refuses a different Auth project after first accepted binding") {
        _ = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: otherAuth)
    }
    try await checks.sessionRefuses("preconstructed other-project adapter rechecks sealed binding before dispatch") {
        try await preconstructedOtherProject.authenticate(bearer: "fixture.cross-project.token")
    }
    try checks.unavailable(preconstructedOtherProject, "different project cannot acquire native readiness")
    try checks.require(try primary.store.read() == pinnedSnapshot
        && DmAuthProbeProtocol.captured().count == beforeCrossProjectRequests
        && session.currentContext(peerGeneration: peerGeneration) == credential.context,
        "cross-project refusal preserves trusted native lease and sealed state without HTTP")
    try checks.require(String(describing: credential) == "DmRelayNetworkCredential(<redacted>)"
        && String(reflecting: credential) == "DmRelayNetworkCredential(<redacted>)", "native credential descriptions redact bearer")
    try checks.require(session.currentContext(peerGeneration: peerGeneration + 1) == nil,
        "credential context cannot accept a caller-selected peer generation")
    let renewGate = DmAuthProbeGate(); defer { renewGate.release() }
    var renewalScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); renewalScript.gate = renewGate
    DmAuthProbeProtocol.install(renewalScript, bearer: "fixture.renew.token")
    let renewalTask = Task { try await session.authenticate(bearer: "fixture.renew.token") }
    try await dmAuthProbeAwaitRequest("fixture.renew.token")
    try checks.unavailable(session, "renewal clears prior in-memory readiness before awaiting")
    let reserved = try primary.coordinator.lifecycleForResearch()
    try checks.require(reserved.owner == first.owner && reserved.credentialEpoch != first.credentialEpoch,
        "renewal reserves a durable epoch before Auth response")
    renewGate.release()
    let renewed = try await checks.sessionSucceeds("positive native renewal unexpectedly refused") { try await renewalTask.value }
    try checks.require(renewed.owner == first.owner && renewed.active && renewed.credentialEpoch != reserved.credentialEpoch,
        "active renewal keeps owner generation and publishes a fresh accepted epoch")
    try checks.require(try primary.coordinator.pending(owner: renewed.owner, peerGeneration: peerGeneration) == [pending]
        && dmAuthProbeStoredEnvelopes(primary.store) == [Data(pending.serializedEnvelope.utf8)],
        "successful renewal retains original pending record and exact ciphertext")
    try checks.require(dmAuthProbeIdentityMatches(try primary.coordinator.publicIdentity(owner: renewed.owner), originalIdentity),
        "successful renewal preserves all existing native identity keys")

    // Reserve BEFORE any SDK token acquisition. No token is installed in the
    // fixture yet, and no Auth HTTP should occur until this exact native ticket
    // is consumed. All checks use real provider/Keychain/sealed account bytes.
    let splitAuthority = try fixture()
    let splitGuard = try DmAuthProbeScopeGuard(store: splitAuthority.store)
    let splitAuthorityBefore = try splitAuthority.store.read()
    let splitBefore = try primary.store.read(), splitRequestsBefore = DmAuthProbeProtocol.captured().count
    let preSdkCredential = try session.credential(peerGeneration: peerGeneration)
    let splitReservation = try session.reserveVerification(scopeGuard: splitGuard)
    let splitReserved = try primary.coordinator.lifecycleForResearch(), splitReservedSnapshot = try primary.store.read()
    try checks.unavailable(session, "pre-SDK reservation fences existing credentials immediately")
    try checks.require(splitReservedSnapshot.revision == splitBefore.revision + 1
        && splitReserved.active && splitReserved.owner == renewed.owner
        && splitReserved.credentialEpoch != renewed.credentialEpoch,
        "pre-SDK reservation durably rotates only the active credential epoch")
    try checks.require(try primary.coordinator.pending(owner: splitReserved.owner, peerGeneration: peerGeneration) == [pending]
        && dmAuthProbeStoredEnvelopes(primary.store) == [Data(pending.serializedEnvelope.utf8)]
        && dmAuthProbeIdentityMatches(primary.coordinator.publicIdentity(owner: splitReserved.owner), originalIdentity),
        "pre-SDK reservation preserves pending generation, exact ciphertext and provider identity")
    try checks.require(try splitAuthority.store.read() == splitAuthorityBefore
        && DmAuthProbeProtocol.captured().count == splitRequestsBefore,
        "native reservation has no Auth request and cannot rewrite its authority index")
    try checks.contextRefuses("pre-SDK durable epoch rejects a previously captured native relay credential") {
        try primary.coordinator.validateRelayContextForResearch(owner: renewed.owner,
            credentialEpoch: preSdkCredential.context.credentialEpoch, peerGeneration: peerGeneration)
    }

    let foreignSplitSession = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: auth)
    try await checks.sessionRefuses("a reservation cannot be consumed by another session instance") {
        try await foreignSplitSession.authenticate(bearer: "fixture.split.foreign.token", reservation: splitReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.foreign.token") == 0
        && (try primary.store.read()) == splitReservedSnapshot,
        "foreign consumption cannot dispatch or mutate the reserved account")
    let splitGate = DmAuthProbeGate(); defer { splitGate.release() }
    var splitScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); splitScript.gate = splitGate
    DmAuthProbeProtocol.install(splitScript, bearer: "fixture.split.refresh.token")
    let splitTask = Task { try await session.authenticate(bearer: "fixture.split.refresh.token", reservation: splitReservation) }
    try await dmAuthProbeAwaitRequest("fixture.split.refresh.token")
    try checks.require(try primary.store.read() == splitReservedSnapshot,
        "consuming the pre-SDK attempt does not perform another begin or durable mutation")
    try await checks.sessionRefuses("a second consumer cannot claim an in-flight native reservation") {
        try await session.authenticate(bearer: "fixture.split.duplicate.token", reservation: splitReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.duplicate.token") == 0
        && (try primary.store.read()) == splitReservedSnapshot,
        "duplicate consumption cannot dispatch, abandon the first consumer or mutate account bytes")
    splitGate.release()
    let splitAccepted = try await checks.sessionSucceeds("exact pre-SDK reservation unexpectedly refused") { try await splitTask.value }
    let splitAcceptedSnapshot = try primary.store.read(), splitContext = session.currentContext()
    try checks.require(splitAccepted.active && splitAccepted.owner == renewed.owner
        && splitAccepted.credentialEpoch != splitReserved.credentialEpoch
        && splitAcceptedSnapshot.revision == splitReservedSnapshot.revision + 1 && splitContext != nil,
        "the original reservation completes once and publishes the unchanged owner generation")
    try checks.require(try primary.coordinator.pending(owner: splitAccepted.owner, peerGeneration: peerGeneration) == [pending]
        && dmAuthProbeStoredEnvelopes(primary.store) == [Data(pending.serializedEnvelope.utf8)],
        "split verification keeps the original pending record and exact provider ciphertext")
    try await checks.sessionRefuses("completed native reservation cannot be replayed") {
        try await session.authenticate(bearer: "fixture.split.replayed.token", reservation: splitReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.replayed.token") == 0
        && (try primary.store.read()) == splitAcceptedSnapshot && session.currentContext() == splitContext,
        "reservation replay preserves the accepted sealed snapshot and live credential lease")

    let supersededReservation = try session.reserveVerification(scopeGuard: splitGuard)
    let latestReservation = try session.reserveVerification(scopeGuard: splitGuard)
    let latestReservedSnapshot = try primary.store.read()
    try await checks.sessionRefuses("a newer native fence supersedes an unconsumed older reservation") {
        try await session.authenticate(bearer: "fixture.split.superseded.token", reservation: supersededReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.superseded.token") == 0
        && (try primary.store.read()) == latestReservedSnapshot,
        "older pre-SDK reservation refuses before HTTP without erasing the newer attempt")
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.split.latest.token")
    _ = try await checks.sessionSucceeds("newer native pre-SDK reservation unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.split.latest.token", reservation: latestReservation)
    }
    let latestSnapshot = try primary.store.read(), latestContext = session.currentContext()
    try await checks.sessionRefuses("stale pre-SDK reservation cannot clear the newer accepted lease") {
        try await session.authenticate(bearer: "fixture.split.superseded.token", reservation: supersededReservation)
    }
    try checks.require(try primary.store.read() == latestSnapshot && session.currentContext() == latestContext && latestContext != nil,
        "stale reservation preserves the exact winning snapshot and native readiness")

    // A different handle commits E2 while the original E1 reservation is still
    // waiting for its SDK token. Consumption must not reserve E3 from the winner.
    let splitOtherHandle = try VodozemacSealedStore.reopen(directory: primary.directory, storeID: primary.id)
    extraHandles.append(splitOtherHandle)
    let splitCompetitor = try VodozemacAuthSession(coordinator: VodozemacDmCoordinator(store: splitOtherHandle), authenticator: auth)
    let crossHandleReservation = try session.reserveVerification(scopeGuard: splitGuard)
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.split.cross-handle-winner.token")
    _ = try await checks.sessionSucceeds("cross-handle native winner unexpectedly refused") {
        try await splitCompetitor.authenticate(bearer: "fixture.split.cross-handle-winner.token", scopeGuard: splitGuard)
    }
    let crossHandleSnapshot = try primary.store.read(), crossHandleContext = splitCompetitor.currentContext()
    try await checks.sessionRefuses("cross-handle epoch winner fences an earlier unconsumed reservation") {
        try await session.authenticate(bearer: "fixture.split.cross-handle-old.token", reservation: crossHandleReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.cross-handle-old.token") == 0
        && (try primary.store.read()) == crossHandleSnapshot
        && splitCompetitor.currentContext() == crossHandleContext && crossHandleContext != nil,
        "cross-handle stale consumption preserves the exact winner with no new begin or HTTP")

    let revokedReservation = try session.reserveVerification(scopeGuard: splitGuard)
    let beforeAuthorityRevocation = try splitAuthority.store.read()
    _ = try splitAuthority.store.commit(expectedRevision: beforeAuthorityRevocation.revision, payload: Data("revoked fixture authority".utf8))
    let revokedAccountSnapshot = try primary.store.read(), revokedAuthoritySnapshot = try splitAuthority.store.read()
    try await checks.sessionRefuses("consumption must use the original now-revoked scope guard") {
        try await session.authenticate(bearer: "fixture.split.revoked.token", reservation: revokedReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.revoked.token") == 0
        && (try primary.store.read()) == revokedAccountSnapshot && (try splitAuthority.store.read()) == revokedAuthoritySnapshot,
        "revoked native guard refuses without account or index mutation")
    try checks.unavailable(session, "revoked pre-SDK reservation never restores the prior lease")

    let splitLogout = try fixture()
    let splitLogoutSession = try VodozemacAuthSession(coordinator: splitLogout.coordinator, authenticator: auth)
    let currentSplitGuard = try DmAuthProbeScopeGuard(store: splitAuthority.store)
    let loggedOutReservation = try splitLogoutSession.reserveVerification(scopeGuard: currentSplitGuard)
    _ = try splitLogoutSession.signOut()
    let splitLogoutSnapshot = try splitLogout.store.read()
    try await checks.sessionRefuses("logout fences a reservation before SDK token acquisition completes") {
        try await splitLogoutSession.authenticate(bearer: "fixture.split.after-logout.token", reservation: loggedOutReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.after-logout.token") == 0
        && (try splitLogout.store.read()) == splitLogoutSnapshot,
        "post-logout reservation consumption cannot dispatch or mutate the logout winner")
    try checks.unavailable(splitLogoutSession, "post-logout reservation has no native readiness")

    let splitExpired = try fixture(), splitExpiredClock = DmAuthProbeClock()
    let splitExpiredSession = try VodozemacAuthSession(coordinator: splitExpired.coordinator, authenticator: auth,
        clockForResearch: splitExpiredClock.read)
    let expiredReservation = try splitExpiredSession.reserveVerification(scopeGuard: currentSplitGuard)
    let splitExpiredSnapshot = try splitExpired.store.read()
    splitExpiredClock.advance(seconds: 60)
    try await checks.sessionRefuses("sixty seconds waiting for SDK token expires the exact original reservation") {
        try await splitExpiredSession.authenticate(bearer: "fixture.split.expired.token", reservation: expiredReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.expired.token") == 0
        && (try splitExpired.store.read()) == splitExpiredSnapshot,
        "expired pre-SDK reservation refuses without another begin, HTTP or durable mutation")
    try checks.unavailable(splitExpiredSession, "expired pre-SDK reservation cannot publish credentials")

    let splitDeadline = try fixture(), splitDeadlineClock = DmAuthProbeClock()
    let splitDeadlineSession = try VodozemacAuthSession(coordinator: splitDeadline.coordinator, authenticator: auth,
        clockForResearch: splitDeadlineClock.read)
    let deadlineReservation = try splitDeadlineSession.reserveVerification(scopeGuard: currentSplitGuard)
    splitDeadlineClock.advance(seconds: 59)
    DmAuthProbeProtocol.install(.init(userId: splitDeadline.owner.userId), bearer: "fixture.split.deadline.token")
    _ = try await checks.sessionSucceeds("pre-deadline split native verification unexpectedly refused") {
        try await splitDeadlineSession.authenticate(bearer: "fixture.split.deadline.token", reservation: deadlineReservation)
    }
    let splitDeadlineSnapshot = try splitDeadline.store.read()
    try checks.require(splitDeadlineSession.currentContext() != nil, "SDK token delay leaves only the original remaining lease")
    splitDeadlineClock.advance(seconds: 1)
    try checks.unavailable(splitDeadlineSession, "split consumption and completion cannot restart the original lease clock")
    try checks.require(try splitDeadline.store.read() == splitDeadlineSnapshot, "split lease expiry preserves exact accepted durable state")

    // The separate authority transaction can fail after its account operation
    // won. Only a successful claimant owns cleanup, and that cleanup may never
    // erase a newer verification which wins after the failed gate releases.
    let splitFault = try fixture()
    let splitFaultSession = try VodozemacAuthSession(coordinator: splitFault.coordinator, authenticator: auth)
    let splitFaultGuard = try DmAuthProbeScopeGuard(store: splitAuthority.store)
    let claimFaultReservation = try splitFaultSession.reserveVerification(scopeGuard: splitFaultGuard)
    let beforeClaimFault = try splitFault.store.read(), beforeClaimFaultAuthority = try splitAuthority.store.read()
    splitFaultGuard.failNextCommitForResearch()
    try await checks.sessionRefuses("authority failure after claim refuses before Auth dispatch") {
        try await splitFaultSession.authenticate(bearer: "fixture.split.claim-fault.token", reservation: claimFaultReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.claim-fault.token") == 0
        && (try splitFault.store.read()) == beforeClaimFault && (try splitAuthority.store.read()) == beforeClaimFaultAuthority,
        "failed claim authority cannot rewrite either sealed snapshot or dispatch HTTP")
    try checks.unavailable(splitFaultSession, "authority failure after claim abandons only its own pending memory")

    let completeFaultReservation = try splitFaultSession.reserveVerification(scopeGuard: splitFaultGuard)
    let beforeCompleteFault = try splitFault.store.read()
    let failedCommitGate = DmAuthProbeCommitGate(); defer { failedCommitGate.release() }
    DmAuthProbeProtocol.install(.init(userId: splitFault.owner.userId), bearer: "fixture.split.complete-fault-old.token")
    let completeFaultTask = Task {
        try await splitFaultSession.authenticateForResearch(bearer: "fixture.split.complete-fault-old.token",
            reservation: completeFaultReservation, hooks: .init(beforeComplete: {
                splitFaultGuard.failNextCommitForResearch(afterFailure: failedCommitGate.hold)
            }))
    }
    defer { completeFaultTask.cancel() }
    try await dmAuthProbeAwaitCommitGate(failedCommitGate)
    try checks.require(try splitFault.store.read().revision == beforeCompleteFault.revision + 1
        && splitAuthority.store.read() == beforeClaimFaultAuthority && splitFaultSession.currentContext() != nil,
        "paused failed authority completion has already committed and installed its exact accepted lease")
    let postFaultWinnerReservation = try splitFaultSession.reserveVerification(scopeGuard: splitFaultGuard)
    DmAuthProbeProtocol.install(.init(userId: splitFault.owner.userId), bearer: "fixture.split.post-fault-winner.token")
    _ = try await checks.sessionSucceeds("new verification after failed authority completion unexpectedly refused") {
        try await splitFaultSession.authenticate(bearer: "fixture.split.post-fault-winner.token", reservation: postFaultWinnerReservation)
    }
    let postFaultWinnerSnapshot = try splitFault.store.read(), postFaultWinnerContext = splitFaultSession.currentContext()
    failedCommitGate.release()
    try await checks.sessionRefuses("failed old authority completion reports refusal after a newer lease wins") { try await completeFaultTask.value }
    try checks.require(try splitFault.store.read() == postFaultWinnerSnapshot
        && splitAuthority.store.read() == beforeClaimFaultAuthority
        && splitFaultSession.currentContext() == postFaultWinnerContext && postFaultWinnerContext != nil,
        "post-failure old cleanup preserves exact newer account/index snapshots and winning lease")
    try await checks.sessionRefuses("failed old completion reservation cannot be reused to clear its winner") {
        try await splitFaultSession.authenticate(bearer: "fixture.split.post-fault-replay.token", reservation: completeFaultReservation)
    }
    try checks.require(DmAuthProbeProtocol.count(bearer: "fixture.split.post-fault-replay.token") == 0
        && (try splitFault.store.read()) == postFaultWinnerSnapshot && splitFaultSession.currentContext() == postFaultWinnerContext,
        "failed completed reservation replay has no mutation, dispatch or winner cleanup right")

    let isolatedFaultReservation = try splitFaultSession.reserveVerification(scopeGuard: splitFaultGuard)
    let beforeIsolatedFault = try splitFault.store.read()
    DmAuthProbeProtocol.install(.init(userId: splitFault.owner.userId), bearer: "fixture.split.complete-fault-isolated.token")
    try await checks.sessionRefuses("authority failure after successful isolated account completion refuses readiness") {
        try await splitFaultSession.authenticateForResearch(bearer: "fixture.split.complete-fault-isolated.token",
            reservation: isolatedFaultReservation, hooks: .init(beforeComplete: { splitFaultGuard.failNextCommitForResearch() }))
    }
    try checks.unavailable(splitFaultSession, "failed authority commit clears its exact accepted lease")
    try checks.require(try splitFault.store.read().revision == beforeIsolatedFault.revision + 1
        && splitAuthority.store.read() == beforeClaimFaultAuthority
        && splitFault.coordinator.lifecycleForResearch().owner == splitFault.owner,
        "authority failure cannot undo a committed account activation or manufacture an index mutation")

    // A reopened durable active state supplies neither a bearer nor readiness.
    let beforeRestart = try primary.store.read()
    try primary.reopen()
    session = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: auth)
    try checks.unavailable(session, "restart of previously authenticated scope requires fresh Auth")
    try checks.require(try primary.store.read() == beforeRestart, "restart preserves complete sealed snapshot")
    try checks.sessionRefuses("trusted Auth project binding survives native sealed reopen") {
        _ = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: otherAuth)
    }

    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.after-restart.token")
    _ = try await checks.sessionSucceeds("positive native Auth after restart unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.after-restart.token")
    }
    DmAuthProbeProtocol.install(.init(userId: "33333333-3333-4333-8333-333333333333"), bearer: "fixture.wrong-account.token")
    try await checks.sessionRefuses("a different verified account cannot rebind native store") {
        try await session.authenticate(bearer: "fixture.wrong-account.token")
    }
    let off = try primary.coordinator.lifecycleForResearch()
    try checks.require(!off.active && off.owner.userId == primary.owner.userId && off.owner.deviceId == primary.owner.deviceId
        && off.owner.generation == primary.owner.generation + 1, "account mismatch durably deactivates existing owner without identity rebinding")
    try checks.unavailable(session, "account mismatch cannot leave a credential")
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.resume.token")
    let resumed = try await checks.sessionSucceeds("positive native signed-out resume unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.resume.token")
    }
    try checks.require(resumed.active && resumed.owner.generation == off.owner.generation + 1
        && resumed.owner.userId == primary.owner.userId && resumed.owner.deviceId == primary.owner.deviceId,
        "same-account signed-out resume advances owner generation")
    try checks.require(dmAuthProbeIdentityMatches(try primary.coordinator.publicIdentity(owner: resumed.owner), originalIdentity)
        && dmAuthProbeStoredEnvelopes(primary.store) == [Data(pending.serializedEnvelope.utf8)]
        && primary.coordinator.pending(owner: resumed.owner, peerGeneration: peerGeneration).isEmpty,
        "resume preserves keys and historical ciphertext without rebinding pending records")

    let logoutGate = DmAuthProbeGate(); defer { logoutGate.release() }
    var logoutScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); logoutScript.gate = logoutGate
    DmAuthProbeProtocol.install(logoutScript, bearer: "fixture.logout-race.token")
    let logoutTask = Task { try await session.authenticate(bearer: "fixture.logout-race.token") }
    try await dmAuthProbeAwaitRequest("fixture.logout-race.token")
    let loggedOut = try session.signOut()
    let logoutSnapshot = try primary.store.read()
    logoutGate.release()
    try await checks.sessionRefuses("late Auth success after logout refused") { try await logoutTask.value }
    try checks.unavailable(session, "late Auth response cannot restore logged-out lease")
    try checks.require(!loggedOut.active && primary.store.read() == logoutSnapshot,
        "late Auth response preserves winning sealed logout state")

    // A is dispatched first; B wins. Both tokens verify the same account, so
    // this specifically catches stale same-account refresh publication.
    let oldGate = DmAuthProbeGate(); defer { oldGate.release() }
    var oldScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); oldScript.gate = oldGate
    DmAuthProbeProtocol.install(oldScript, bearer: "fixture.old-refresh.token")
    let oldTask = Task { try await session.authenticate(bearer: "fixture.old-refresh.token") }
    try await dmAuthProbeAwaitRequest("fixture.old-refresh.token")
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.new-refresh.token")
    let winner = try await checks.sessionSucceeds("positive native winning renewal unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.new-refresh.token")
    }
    let winnerContext = session.currentContext(), winnerSnapshot = try primary.store.read()
    oldGate.release()
    try await checks.sessionRefuses("reverse-order same-account renewal refuses old response") { try await oldTask.value }
    try checks.require(session.currentContext() == winnerContext && winner.active && primary.store.read() == winnerSnapshot,
        "stale renewal preserves newer lease and complete winning sealed state")

    let secondHandle = try VodozemacSealedStore.reopen(directory: primary.directory, storeID: primary.id)
    extraHandles.append(secondHandle)
    let competitor = try VodozemacDmCoordinator(store: secondHandle)
    let epochGate = DmAuthProbeGate(); defer { epochGate.release() }
    var epochScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); epochScript.gate = epochGate
    DmAuthProbeProtocol.install(epochScript, bearer: "fixture.other-coordinator.token")
    let epochTask = Task { try await session.authenticate(bearer: "fixture.other-coordinator.token") }
    try await dmAuthProbeAwaitRequest("fixture.other-coordinator.token")
    _ = try competitor.rotateCredentialEpochForResearch(owner: winner.owner)
    let competitorSnapshot = try secondHandle.read()
    epochGate.release()
    try await checks.sessionRefuses("another coordinator epoch fences pending Auth response") { try await epochTask.value }
    try checks.unavailable(session, "competing sealed epoch leaves no stale credential")
    try checks.require(try primary.store.read() == competitorSnapshot, "stale Auth response cannot mutate competing coordinator state")

    let cancelGate = DmAuthProbeGate(); defer { cancelGate.release() }
    var cancelScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); cancelScript.gate = cancelGate
    DmAuthProbeProtocol.install(cancelScript, bearer: "fixture.cancel.token")
    let cancelled = Task { try await session.authenticate(bearer: "fixture.cancel.token") }
    try await dmAuthProbeAwaitRequest("fixture.cancel.token")
    let cancelSnapshot = try primary.store.read()
    cancelled.cancel()
    try await checks.sessionRefuses("cancelling in-flight Auth returns bounded refusal") { try await cancelled.value }
    cancelGate.release()
    try checks.unavailable(session, "cancelled Auth cannot install credential")
    try checks.require(try primary.store.read() == cancelSnapshot, "cancellation cannot complete reserved durable transition")

    let preCancelledSession = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: auth)
    let beforePreCancel = try primary.store.read(), beforePreCancelRequests = DmAuthProbeProtocol.captured().count
    let preCancelled = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return try await preCancelledSession.authenticate(bearer: "fixture.pre-cancelled.token")
    }
    try await checks.sessionRefuses("already-cancelled Auth refuses before reserving a scope") { try await preCancelled.value }
    try checks.unavailable(preCancelledSession, "already-cancelled Auth leaves no credential")
    try checks.require(try primary.store.read() == beforePreCancel
        && DmAuthProbeProtocol.captured().count == beforePreCancelRequests,
        "already-cancelled Auth leaves durable scope and request count unchanged")

    // Ensure a previous good lease is never restored after refusal/timeout.
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.before-refusal.token")
    _ = try await checks.sessionSucceeds("positive native Auth before HTTP refusal unexpectedly refused") {
        try await session.authenticate(bearer: "fixture.before-refusal.token")
    }
    var refusal = DmAuthProbeProtocol.Script(userId: primary.owner.userId); refusal.status = 401
    DmAuthProbeProtocol.install(refusal, bearer: "fixture.denied.token")
    try await checks.sessionRefuses("HTTP Auth refusal invalidates prior lease") {
        try await session.authenticate(bearer: "fixture.denied.token")
    }
    try checks.unavailable(session, "failed verification cannot restore earlier successful credential")
    let timeoutSession = try VodozemacAuthSession(coordinator: primary.coordinator, authenticator: auth)
    DmAuthProbeProtocol.install(.init(userId: primary.owner.userId), bearer: "fixture.before-timeout.token")
    _ = try await checks.sessionSucceeds("positive native Auth before timeout unexpectedly refused") {
        try await timeoutSession.authenticate(bearer: "fixture.before-timeout.token")
    }
    let timeoutGate = DmAuthProbeGate(); defer { timeoutGate.release() }
    var timeoutScript = DmAuthProbeProtocol.Script(userId: primary.owner.userId); timeoutScript.gate = timeoutGate
    DmAuthProbeProtocol.install(timeoutScript, bearer: "fixture.timeout.token")
    try await checks.sessionRefuses("timed-out verification invalidates prior lease") {
        try await timeoutSession.authenticate(bearer: "fixture.timeout.token")
    }
    try checks.unavailable(timeoutSession, "timeout cannot leave bearer readiness")

    // Inject interference only after dispatch. The check before complete passes;
    // the competing commit occurs between native preparation and sealed CAS.
    let casFixture = try fixture()
    let casHandle = try VodozemacSealedStore.reopen(directory: casFixture.directory, storeID: casFixture.id)
    extraHandles.append(casHandle)
    let casCompetitor = try VodozemacDmCoordinator(store: casHandle)
    let casHook = DmAuthProbeCommitHook()
    let casCoordinator = try VodozemacDmCoordinator(store: casFixture.store, beforeCommitForResearch: casHook.call)
    let casSession = try VodozemacAuthSession(coordinator: casCoordinator, authenticator: auth)
    let casGate = DmAuthProbeGate(); defer { casGate.release() }
    var casScript = DmAuthProbeProtocol.Script(userId: casFixture.owner.userId); casScript.gate = casGate
    DmAuthProbeProtocol.install(casScript, bearer: "fixture.cas.token")
    let casTask = Task { try await casSession.authenticate(bearer: "fixture.cas.token") }
    try await dmAuthProbeAwaitRequest("fixture.cas.token")
    casHook.arm { _ = try casCompetitor.rotateCredentialEpochForResearch(owner: casFixture.owner) }
    casGate.release()
    try await checks.sessionRefuses("sealed CAS failure cannot publish verified bearer") { try await casTask.value }
    try checks.unavailable(casSession, "CAS failure leaves no lease")
    try checks.require(try casFixture.coordinator.lifecycleForResearch() == casCompetitor.lifecycleForResearch(),
        "Auth CAS failure preserves competing durable lifecycle")

    let storageFixture = try fixture()
    let storageHook = DmAuthProbeCommitHook()
    let storageCoordinator = try VodozemacDmCoordinator(store: storageFixture.store, beforeCommitForResearch: storageHook.call)
    let storageSession = try VodozemacAuthSession(coordinator: storageCoordinator, authenticator: auth)
    let storageGate = DmAuthProbeGate(); defer { storageGate.release() }
    var storageScript = DmAuthProbeProtocol.Script(userId: storageFixture.owner.userId); storageScript.gate = storageGate
    DmAuthProbeProtocol.install(storageScript, bearer: "fixture.storage.token")
    let storageTask = Task { try await storageSession.authenticate(bearer: "fixture.storage.token") }
    try await dmAuthProbeAwaitRequest("fixture.storage.token")
    let beforeStorageFailure = try storageFixture.store.read()
    storageHook.arm { storageFixture.store.close() }
    storageGate.release()
    try await checks.sessionRefuses("storage failure after verified response cannot publish bearer") { try await storageTask.value }
    try checks.unavailable(storageSession, "failed storage commit leaves no lease")
    try storageFixture.reopen()
    try checks.require(try storageFixture.store.read() == beforeStorageFailure,
        "failed completion commit retains authenticated reserved snapshot on reopen")

    // Cancellation races with the durable completion itself. A commit may have
    // won already; cancellation must still prevent in-memory bearer publication.
    let commitCancelFixture = try fixture()
    let commitCancelHook = DmAuthProbeCommitHook(), commitCancelBox = DmAuthProbeTaskBox()
    let commitCancelCoordinator = try VodozemacDmCoordinator(store: commitCancelFixture.store,
        beforeCommitForResearch: commitCancelHook.call)
    let commitCancelSession = try VodozemacAuthSession(coordinator: commitCancelCoordinator, authenticator: auth)
    let commitCancelGate = DmAuthProbeGate(); defer { commitCancelGate.release() }
    var commitCancelScript = DmAuthProbeProtocol.Script(userId: commitCancelFixture.owner.userId)
    commitCancelScript.gate = commitCancelGate
    DmAuthProbeProtocol.install(commitCancelScript, bearer: "fixture.commit-cancel.token")
    let commitCancelTask = Task { try await commitCancelSession.authenticate(bearer: "fixture.commit-cancel.token") }
    commitCancelBox.set(commitCancelTask)
    try await dmAuthProbeAwaitRequest("fixture.commit-cancel.token")
    commitCancelHook.arm { commitCancelBox.cancel() }
    commitCancelGate.release()
    try await checks.sessionRefuses("cancellation at completion commit cannot publish verified bearer") { try await commitCancelTask.value }
    try checks.unavailable(commitCancelSession, "commit cancellation leaves no native lease")
    try checks.require(try commitCancelCoordinator.lifecycleForResearch().owner == commitCancelFixture.owner,
        "commit cancellation cannot replace existing native identity scope")

    // Simulated suspension after attempt reservation but before native dispatch:
    // age is not reset when returning from await or configuring URLSession.
    let suspensionFixture = try fixture(), suspensionClock = DmAuthProbeClock()
    let suspensionConfiguration = DmAuthProbeConfiguration()
    let suspensionAuth = try VodozemacSupabaseAuth(projectOrigin: "https://auth-fixture.invalid",
        publicApiKey: "sb_publishable_research_fixture", deadlineSeconds: 2, configurationForResearch: {
            suspensionClock.advance(seconds: 60)
            return suspensionConfiguration.create()
        })
    let suspensionSession = try VodozemacAuthSession(coordinator: suspensionFixture.coordinator,
        authenticator: suspensionAuth, clockForResearch: suspensionClock.read)
    let beforeSuspensionRequests = DmAuthProbeProtocol.captured().count
    try await checks.sessionRefuses("suspended native Auth attempt refuses without resetting its lease age") {
        try await suspensionSession.authenticate(bearer: "fixture.suspension.token")
    }
    try checks.unavailable(suspensionSession, "expired reserved attempt cannot become authenticated readiness")
    try checks.require(DmAuthProbeProtocol.captured().count == beforeSuspensionRequests,
        "expired attempt at dispatch sends no fixture HTTP request")

    let expiryFixture = try fixture(), expiryClock = DmAuthProbeClock()
    let expirySession = try VodozemacAuthSession(coordinator: expiryFixture.coordinator, authenticator: auth,
        clockForResearch: expiryClock.read)
    DmAuthProbeProtocol.install(.init(userId: expiryFixture.owner.userId), bearer: "fixture.lease-expiry.token")
    _ = try await checks.sessionSucceeds("positive native expiry fixture Auth unexpectedly refused") {
        try await expirySession.authenticate(bearer: "fixture.lease-expiry.token")
    }
    try checks.require(expirySession.currentContext() != nil, "verified lease supplies readiness before native expiry")
    _ = try expirySession.credential()
    let expirySnapshot = try expiryFixture.store.read()
    expiryClock.advance(seconds: 60)
    try checks.unavailable(expirySession, "lease expiry at its exact boundary clears context and credential")
    try checks.require(try expiryFixture.store.read() == expirySnapshot,
        "local lease expiry cannot manufacture a durable logout transition")

    // Each accessor has its own lease. The first clock read is before expiry;
    // the second is after coordinator validation, exactly at the deadline.
    let crossingFixture = try fixture(), crossingClock = DmAuthProbeClock()
    let crossingSession = try VodozemacAuthSession(coordinator: crossingFixture.coordinator, authenticator: auth,
        clockForResearch: crossingClock.read)
    DmAuthProbeProtocol.install(.init(userId: crossingFixture.owner.userId), bearer: "fixture.credential-crossing.token")
    let credentialVerifiedAt = crossingClock.read()
    _ = try await checks.sessionSucceeds("positive native credential-crossing Auth unexpectedly refused") {
        try await crossingSession.authenticate(bearer: "fixture.credential-crossing.token")
    }
    let beforeCredentialCrossing = try crossingFixture.store.read()
    crossingClock.crossOnSecondRead(from: credentialVerifiedAt)
    try checks.sessionRefuses("credential read crossing expiry during coordinator validation refuses") {
        _ = try crossingSession.credential()
    }
    try checks.unavailable(crossingSession, "crossing credential read clears expired lease")
    try checks.require(try crossingFixture.store.read() == beforeCredentialCrossing,
        "crossing credential read cannot mutate the durable scope")
    DmAuthProbeProtocol.install(.init(userId: crossingFixture.owner.userId), bearer: "fixture.context-crossing.token")
    let contextVerifiedAt = crossingClock.read()
    _ = try await checks.sessionSucceeds("positive native context-crossing Auth unexpectedly refused") {
        try await crossingSession.authenticate(bearer: "fixture.context-crossing.token")
    }
    let beforeContextCrossing = try crossingFixture.store.read()
    crossingClock.crossOnSecondRead(from: contextVerifiedAt)
    try checks.require(crossingSession.currentContext() == nil,
        "context read crossing expiry during coordinator validation cannot return a stale context")
    try checks.unavailable(crossingSession, "crossing context read clears expired lease")
    try checks.require(try crossingFixture.store.read() == beforeContextCrossing,
        "crossing context read preserves sealed lifecycle")

    let slowCommitFixture = try fixture(), slowCommitClock = DmAuthProbeClock(), slowCommitHook = DmAuthProbeCommitHook()
    let slowCommitCoordinator = try VodozemacDmCoordinator(store: slowCommitFixture.store,
        beforeCommitForResearch: slowCommitHook.call)
    let slowCommitSession = try VodozemacAuthSession(coordinator: slowCommitCoordinator, authenticator: auth,
        clockForResearch: slowCommitClock.read)
    let slowCommitGate = DmAuthProbeGate(); defer { slowCommitGate.release() }
    var slowCommitScript = DmAuthProbeProtocol.Script(userId: slowCommitFixture.owner.userId)
    slowCommitScript.gate = slowCommitGate
    DmAuthProbeProtocol.install(slowCommitScript, bearer: "fixture.slow-commit.token")
    let slowCommitTask = Task { try await slowCommitSession.authenticate(bearer: "fixture.slow-commit.token") }
    try await dmAuthProbeAwaitRequest("fixture.slow-commit.token")
    slowCommitHook.arm { slowCommitClock.advance(seconds: 59) }
    slowCommitGate.release()
    _ = try await checks.sessionSucceeds("positive native slow-commit Auth unexpectedly refused") { try await slowCommitTask.value }
    try checks.require(slowCommitSession.currentContext() != nil,
        "commit completed before verification deadline may publish its remaining lease")
    slowCommitClock.advance(seconds: 1)
    try checks.unavailable(slowCommitSession, "slow completion cannot start another sixty seconds of readiness")

    let expiredCommitFixture = try fixture(), expiredCommitClock = DmAuthProbeClock(), expiredCommitHook = DmAuthProbeCommitHook()
    let expiredCommitCoordinator = try VodozemacDmCoordinator(store: expiredCommitFixture.store,
        beforeCommitForResearch: expiredCommitHook.call)
    let expiredCommitSession = try VodozemacAuthSession(coordinator: expiredCommitCoordinator, authenticator: auth,
        clockForResearch: expiredCommitClock.read)
    let expiredCommitGate = DmAuthProbeGate(); defer { expiredCommitGate.release() }
    var expiredCommitScript = DmAuthProbeProtocol.Script(userId: expiredCommitFixture.owner.userId)
    expiredCommitScript.gate = expiredCommitGate
    DmAuthProbeProtocol.install(expiredCommitScript, bearer: "fixture.expired-commit.token")
    let expiredCommitTask = Task { try await expiredCommitSession.authenticate(bearer: "fixture.expired-commit.token") }
    try await dmAuthProbeAwaitRequest("fixture.expired-commit.token")
    let beforeExpiredCommit = try expiredCommitFixture.store.read()
    expiredCommitHook.arm { expiredCommitClock.advance(seconds: 60) }
    expiredCommitGate.release()
    try await checks.sessionRefuses("verification expiring during durable completion cannot publish bearer") {
        try await expiredCommitTask.value
    }
    try checks.unavailable(expiredCommitSession, "completion at deadline leaves no readiness")
    let afterExpiredCommit = try expiredCommitFixture.store.read()
    try checks.require(afterExpiredCommit.revision == beforeExpiredCommit.revision + 1
        && expiredCommitCoordinator.lifecycleForResearch().owner == expiredCommitFixture.owner,
        "expiry after winning completion commit cannot rebind native owner or undo durable state")

    let logoutRaceFixture = try fixture(), logoutRaceHook = DmAuthProbeCommitHook()
    let logoutRaceHandle = try VodozemacSealedStore.reopen(directory: logoutRaceFixture.directory, storeID: logoutRaceFixture.id)
    extraHandles.append(logoutRaceHandle)
    let logoutRaceCompetitor = try VodozemacDmCoordinator(store: logoutRaceHandle)
    let logoutRaceCoordinator = try VodozemacDmCoordinator(store: logoutRaceFixture.store,
        beforeCommitForResearch: logoutRaceHook.call)
    let logoutRaceSession = try VodozemacAuthSession(coordinator: logoutRaceCoordinator, authenticator: auth)
    let logoutRaceOtherSession = try VodozemacAuthSession(coordinator: logoutRaceCompetitor, authenticator: auth)
    DmAuthProbeProtocol.install(.init(userId: logoutRaceFixture.owner.userId), bearer: "fixture.logout-local.token")
    _ = try await checks.sessionSucceeds("positive native local logout-race Auth unexpectedly refused") {
        try await logoutRaceSession.authenticate(bearer: "fixture.logout-local.token")
    }
    DmAuthProbeProtocol.install(.init(userId: logoutRaceFixture.owner.userId), bearer: "fixture.logout-other.token")
    _ = try await checks.sessionSucceeds("positive native competing logout-race Auth unexpectedly refused") {
        try await logoutRaceOtherSession.authenticate(bearer: "fixture.logout-other.token")
    }
    try checks.require(logoutRaceOtherSession.currentContext() != nil, "competing broker has verified readiness before local logout")
    var oneLogoutRace = 0
    logoutRaceHook.arm {
        oneLogoutRace += 1
        _ = try logoutRaceCompetitor.rotateCredentialEpochForResearch(owner: logoutRaceFixture.owner)
    }
    let raceSignedOut = try logoutRaceSession.signOut()
    try checks.require(oneLogoutRace == 1 && !raceSignedOut.active
        && raceSignedOut.owner.generation == logoutRaceFixture.owner.generation + 1
        && logoutRaceCompetitor.lifecycleForResearch() == raceSignedOut,
        "unconditional logout retries a competing epoch from fresh sealed state and durably wins")
    try checks.unavailable(logoutRaceSession, "logout retry leaves local memory signed out")
    try checks.staleCredential(logoutRaceOtherSession, "winning logout invalidates competing verified readiness")

    let exhaustedLogoutFixture = try fixture(), exhaustedLogoutHook = DmAuthProbeCommitHook()
    let exhaustedLogoutHandle = try VodozemacSealedStore.reopen(directory: exhaustedLogoutFixture.directory,
        storeID: exhaustedLogoutFixture.id)
    extraHandles.append(exhaustedLogoutHandle)
    let exhaustedLogoutCompetitor = try VodozemacDmCoordinator(store: exhaustedLogoutHandle)
    let exhaustedLogoutCoordinator = try VodozemacDmCoordinator(store: exhaustedLogoutFixture.store,
        beforeCommitForResearch: exhaustedLogoutHook.call)
    let exhaustedLogoutSession = try VodozemacAuthSession(coordinator: exhaustedLogoutCoordinator, authenticator: auth)
    DmAuthProbeProtocol.install(.init(userId: exhaustedLogoutFixture.owner.userId), bearer: "fixture.logout-exhausted.token")
    _ = try await checks.sessionSucceeds("positive native repeated logout-race Auth unexpectedly refused") {
        try await exhaustedLogoutSession.authenticate(bearer: "fixture.logout-exhausted.token")
    }
    var exhaustedLogoutRaces = 0
    func repeatLogoutRace() throws {
        exhaustedLogoutRaces += 1
        _ = try exhaustedLogoutCompetitor.rotateCredentialEpochForResearch(owner: exhaustedLogoutFixture.owner)
        if exhaustedLogoutRaces < 3 { exhaustedLogoutHook.arm(repeatLogoutRace) }
    }
    exhaustedLogoutHook.arm(repeatLogoutRace)
    try checks.staleRevision("three competing revisions exhaust bounded native logout retry with explicit failure") {
        _ = try exhaustedLogoutSession.signOut()
    }
    try checks.unavailable(exhaustedLogoutSession, "exhausted logout clears local bearer memory before disk work")
    let afterExhaustedLogout = try exhaustedLogoutCompetitor.lifecycleForResearch()
    try checks.require(exhaustedLogoutRaces == 3 && afterExhaustedLogout.active
        && afterExhaustedLogout.owner == exhaustedLogoutFixture.owner,
        "failed global logout reports failure while preserving the competing active scope")
    let explicitLogoutRetry = try exhaustedLogoutSession.signOut()
    try checks.require(!explicitLogoutRetry.active, "a later explicit local logout can win after contention stops")

    // Expected-ticket account-mismatch deactivation has no global retry right.
    // Its single CAS loss must preserve the competing newer active generation.
    let expectedLogoutFixture = try fixture(), expectedLogoutHook = DmAuthProbeCommitHook()
    let expectedLogoutHandle = try VodozemacSealedStore.reopen(directory: expectedLogoutFixture.directory,
        storeID: expectedLogoutFixture.id)
    extraHandles.append(expectedLogoutHandle)
    let expectedLogoutCompetitor = try VodozemacDmCoordinator(store: expectedLogoutHandle)
    let expectedLogoutCoordinator = try VodozemacDmCoordinator(store: expectedLogoutFixture.store,
        beforeCommitForResearch: expectedLogoutHook.call)
    let expectedLogoutSession = try VodozemacAuthSession(coordinator: expectedLogoutCoordinator, authenticator: auth)
    let expectedLogoutGate = DmAuthProbeGate(); defer { expectedLogoutGate.release() }
    var expectedLogoutScript = DmAuthProbeProtocol.Script(userId: "33333333-3333-4333-8333-333333333333")
    expectedLogoutScript.gate = expectedLogoutGate
    DmAuthProbeProtocol.install(expectedLogoutScript, bearer: "fixture.expected-logout-race.token")
    let expectedLogoutTask = Task { try await expectedLogoutSession.authenticate(bearer: "fixture.expected-logout-race.token") }
    try await dmAuthProbeAwaitRequest("fixture.expected-logout-race.token")
    var expectedLogoutRaces = 0
    expectedLogoutHook.arm {
        expectedLogoutRaces += 1
        _ = try expectedLogoutCompetitor.rotateCredentialEpochForResearch(owner: expectedLogoutFixture.owner)
    }
    expectedLogoutGate.release()
    try await checks.sessionRefuses("expected-ticket deactivation refuses its sealed CAS loss without global retry") {
        try await expectedLogoutTask.value
    }
    let afterExpectedLogoutRace = try expectedLogoutCompetitor.lifecycleForResearch()
    try checks.require(expectedLogoutRaces == 1 && afterExpectedLogoutRace.active
        && afterExpectedLogoutRace.owner == expectedLogoutFixture.owner
        && expectedLogoutCoordinator.lifecycleForResearch() == afterExpectedLogoutRace,
        "account-mismatch CAS loser cannot deactivate the newer competing lifecycle")
    try checks.unavailable(expectedLogoutSession, "expected-ticket deactivation failure leaves no local readiness")

    for handle in extraHandles { handle.close() }
    for value in fixtures {
        try value.destroy()
        try checks.require(!FileManager.default.fileExists(atPath: value.directory.path), "Auth fixture store exact namespace cleaned")
    }
    return checks.assertions
}
