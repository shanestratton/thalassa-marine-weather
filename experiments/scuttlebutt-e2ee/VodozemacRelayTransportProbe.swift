// URLProtocol response fixtures exercise the actual native URLSession delegate.
// They do NOT establish TLS trust, live Supabase auth, durable auth generations,
// relay encryption, physical phones or Keychain/locked-device behaviour.
import Foundation

private struct NetworkProbeFailure: Error { let line: UInt }
private func networkCheck(_ condition: @autoclosure () -> Bool, line: UInt = #line) throws {
    if !condition() { throw NetworkProbeFailure(line: line) }
}
private func refuses(_ operation: () throws -> Void, line: UInt = #line) throws {
    do { try operation() } catch is DmRelayTransportError { return }
    throw NetworkProbeFailure(line: line)
}
private func networkRefuses(_ operation: () async throws -> Data, line: UInt = #line) async throws {
    do { _ = try await operation() } catch is DmRelayTransportError { return }
    throw NetworkProbeFailure(line: line)
}

private final class NetworkProbeContext: @unchecked Sendable {
    private let lock = NSLock()
    private var value: DmRelayNetworkContext?
    init(_ value: DmRelayNetworkContext) { self.value = value }
    func read() -> DmRelayNetworkContext? { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ value: DmRelayNetworkContext?) { lock.lock(); self.value = value; lock.unlock() }
}

private final class NetworkProbeSlowContext: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    let slowCall: Int
    let invalidCall: Int
    let context: DmRelayNetworkContext
    init(_ context: DmRelayNetworkContext, slowCall: Int = 0, invalidCall: Int = 0) {
        self.context = context; self.slowCall = slowCall; self.invalidCall = invalidCall
    }
    func read() -> DmRelayNetworkContext? {
        lock.lock(); calls += 1; let slow = calls == slowCall, invalid = calls == invalidCall; lock.unlock()
        if slow { Thread.sleep(forTimeInterval: 0.06) }
        return invalid ? nil : context
    }
}

private final class NetworkProbeConfiguration: @unchecked Sendable {
    private let lock = NSLock()
    private var value: URLSessionConfiguration?
    func create() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NetworkProbeProtocol.self]
        config.urlCache = URLCache(memoryCapacity: 1024, diskCapacity: 0)
        config.urlCredentialStorage = .shared
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        lock.lock(); value = config; lock.unlock()
        return config
    }
    func read() -> URLSessionConfiguration? { lock.lock(); defer { lock.unlock() }; return value }
}

private final class NetworkProbeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if released { lock.unlock(); continuation.resume(); return }
            self.continuation = continuation
            lock.unlock()
        }
    }
    func release() {
        lock.lock(); released = true; let continuation = self.continuation; self.continuation = nil; lock.unlock()
        continuation?.resume()
    }
}

private final class NetworkProbeProtocol: URLProtocol, @unchecked Sendable {
    struct Script {
        var body = Data("{\"version\":1,\"result\":{\"accepted\":true}}".utf8)
        var status = 200
        var type = "application/json"
        var url = URL(string: "https://relay-fixture.invalid/v1/dispatch")!
        var length: Int?
        var delay: Double = 0
        var neverFinish = false
        var repeatChunk = false
        var error = false
        var redirectURL: URL?
    }
    private static let fixtureLock = NSLock()
    private static var script = Script()
    private static var requests: [URLRequest] = []
    private static var bodies: [Data] = []
    private let stateLock = NSLock()
    private var stopped = false
    static func configure(_ script: Script) { fixtureLock.lock(); self.script = script; fixtureLock.unlock() }
    static func captured() -> [URLRequest] { fixtureLock.lock(); defer { fixtureLock.unlock() }; return requests }
    static func capturedBodies() -> [Data] { fixtureLock.lock(); defer { fixtureLock.unlock() }; return bodies }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "relay-fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // Foundation turns data-task bodies into streams before URLProtocol.
        // Read the actual request stream, not an assumed httpBody representation.
        var body = request.httpBody ?? Data()
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while body.count <= 102400 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.fixtureLock.lock()
        let script = Self.script
        Self.requests.append(request)
        Self.bodies.append(body)
        Self.fixtureLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + script.delay) { [self] in
            stateLock.lock(); defer { stateLock.unlock() }
            guard !stopped else { return }
            var headers = ["Content-Type": script.type]
            if let length = script.length { headers["Content-Length"] = String(length) }
            let response = HTTPURLResponse(url: script.url, statusCode: script.status, httpVersion: "HTTP/1.1", headerFields: headers)!
            if let url = script.redirectURL {
                var redirected = request; redirected.url = url
                client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !script.body.isEmpty { client?.urlProtocol(self, didLoad: script.body) }
            if script.error { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
            if script.repeatChunk { drip() }
            else if !script.neverFinish { client?.urlProtocolDidFinishLoading(self) }
        }
    }
    private func drip() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.005) { [self] in
            stateLock.lock(); defer { stateLock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didLoad: Data(" ".utf8))
            drip()
        }
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

@main private struct RelayTransportProbe {
    static func main() async throws {
        let context = DmRelayNetworkContext(userId: "network-user", deviceId: "network-phone", ownerGeneration: 11,
            credentialEpoch: UUID(), peerGeneration: 7)
        let current = NetworkProbeContext(context)
        let credential = try DmRelayNetworkCredential(context: context, bearer: "fixture-native-only.token")
        let wire = "{\"userId\":\"network-user\",\"deviceId\":\"network-phone\"}"
        let configuration = NetworkProbeConfiguration()
        let configured: () -> URLSessionConfiguration = configuration.create
        let client = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", deadlineSeconds: 0.15,
            configurationForResearch: configured)
        func send(_ body: String? = nil) async throws -> Data {
            try await client.dispatch(request: body ?? wire, credential: credential, currentContext: current.read)
        }
        for url in ["http://relay-fixture.invalid", "https://relay-fixture.invalid/", "https://name:password@relay-fixture.invalid",
                    "https://relay-fixture.invalid/path", "https://relay-fixture.invalid?secret=x", "https://relay-fixture.invalid#anchor",
                    "https://", "https://relay-fixture.invalid\n"] {
            try refuses { _ = try VodozemacRelayTransport(serviceOrigin: url) }
        }
        for path in ["/", "/functions/v1/", "/functions/v1", "/functions/V1/pilot", "/Functions/v1/pilot",
                     "//functions/v1/pilot", "/functions//v1/pilot", "/functions/v1/Pilot", "/functions/v1/1pilot",
                     "/functions/v1/-pilot", "/functions/v1/pilot-", "/functions/v1/pilot--relay",
                     "/functions/v1/pilot_relay", "/functions/v1/pilot.relay", "/functions/v1/pilot/",
                     "/functions/v1/pilot//", "/functions/v1/./pilot", "/functions/v1/other/../pilot",
                     "/functions/v1/%70ilot", "/functions/v1/pilot%2fother", "/functions/v1/%2e%2e/pilot",
                     "/functions/v1/pilot\\other", "/functions/v1/pilot?project=other", "/functions/v1/pilot?",
                     "/functions/v1/pilot#fragment", "/functions/v1/pilot#", "/functions/v1/pilot\n",
                     " /functions/v1/pilot", "/functions/v1/pilot ", "/functions/v1/pilót",
                     "https://other.invalid/functions/v1/pilot", "/functions/v1/" + String(repeating: "a", count: 65)] {
            try refuses { _ = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", serviceBasePath: path) }
        }
        for deadline in [0, -1, 10.1, Double.infinity, Double.nan] {
            try refuses { _ = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", deadlineSeconds: deadline) }
        }
        for token in ["", "a b", "a\r\n", "é", "=", "a==b", String(repeating: "a", count: 8193)] {
            try refuses { _ = try DmRelayNetworkCredential(context: context, bearer: token) }
        }
        _ = try DmRelayNetworkCredential(context: context, bearer: "valid._~+/token==")
        try networkCheck(String(describing: credential) == "DmRelayNetworkCredential(<redacted>)")
        try networkCheck(String(reflecting: credential) == "DmRelayNetworkCredential(<redacted>)")
        print("PASS native network configuration and credential bounds")

        NetworkProbeProtocol.configure(.init())
        let result = try await send()
        try networkCheck(result == Data("{\"accepted\":true}".utf8))
        let request = NetworkProbeProtocol.captured().last!
        try networkCheck(request.httpMethod == "POST" && request.url?.absoluteString == "https://relay-fixture.invalid/v1/dispatch")
        try networkCheck(NetworkProbeProtocol.capturedBodies().last == Data(wire.utf8))
        try networkCheck(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-native-only.token")
        try networkCheck(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        try networkCheck(request.value(forHTTPHeaderField: "Cookie") == nil)
        let config = configuration.read()!
        try networkCheck(config.urlCache == nil && config.urlCredentialStorage == nil && config.httpCookieStorage == nil)
        try networkCheck(!config.httpShouldSetCookies && config.requestCachePolicy == .reloadIgnoringLocalCacheData)
        try networkCheck(!config.waitsForConnectivity && config.timeoutIntervalForRequest == 0.15 && config.timeoutIntervalForResource == 0.15)
        print("PASS native exact POST/public request wire, bearer header and public result")

        let edgeBasePath = "/functions/v1/scuttlebutt-e2ee-pilot"
        for path in ["", "/functions/v1/a", edgeBasePath, "/functions/v1/" + String(repeating: "a", count: 64)] {
            let mounted = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", serviceBasePath: path,
                deadlineSeconds: 0.15, configurationForResearch: configured)
            for registering in [true, false] {
                let expectedURL = "https://relay-fixture.invalid" + path + (registering ? "/v1/register" : "/v1/dispatch")
                var script = NetworkProbeProtocol.Script(); script.url = URL(string: expectedURL)!
                NetworkProbeProtocol.configure(script)
                let result: Data
                if registering {
                    result = try await mounted.register(bundle: wire, credential: credential, currentContext: current.read)
                } else {
                    result = try await mounted.dispatch(request: wire, credential: credential, currentContext: current.read)
                }
                try networkCheck(result == Data("{\"accepted\":true}".utf8))
                let request = NetworkProbeProtocol.captured().last!
                try networkCheck(request.url?.absoluteString == expectedURL && request.httpMethod == "POST")
                try networkCheck(NetworkProbeProtocol.capturedBodies().last == Data(wire.utf8))
                try networkCheck(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-native-only.token")
                try networkCheck(request.value(forHTTPHeaderField: "Cookie") == nil)
            }
        }
        print("PASS native trusted root/hosted mounts and exact registration/dispatch URLs")

        let mounted = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", serviceBasePath: edgeBasePath,
            deadlineSeconds: 0.15, configurationForResearch: configured)
        let mountedExpectedURL = "https://relay-fixture.invalid" + edgeBasePath + "/v1/dispatch"
        for path in ["/v1/dispatch", "/functions/v1/other/v1/dispatch", edgeBasePath + "/v1/dispatch/",
                     edgeBasePath + "//v1/dispatch", edgeBasePath + "/v1/%64ispatch", edgeBasePath + "/v1/dispatch?",
                     edgeBasePath + "/v1/dispatch?actor=other", edgeBasePath + "/v1/dispatch#",
                     edgeBasePath + "/v1/dispatch#fragment", "/functions/v1/%73cuttlebutt-e2ee-pilot/v1/dispatch",
                     "/functions/v1/scuttlebutt-e2ee-pilot%2fv1/dispatch",
                     "/functions/v1/other/../scuttlebutt-e2ee-pilot/v1/dispatch", edgeBasePath + "/other/../v1/dispatch",
                     edgeBasePath + "/%2e/v1/dispatch", edgeBasePath + "/v1/register/../dispatch", edgeBasePath + "\\v1/dispatch"] {
            var script = NetworkProbeProtocol.Script(); script.url = URL(string: "https://relay-fixture.invalid" + path)!
            NetworkProbeProtocol.configure(script)
            try await networkRefuses {
                try await mounted.dispatch(request: wire, credential: credential, currentContext: current.read)
            }
            try networkCheck(NetworkProbeProtocol.captured().last?.url?.absoluteString == mountedExpectedURL)
        }
        var mountedRedirect = NetworkProbeProtocol.Script(); mountedRedirect.url = URL(string: mountedExpectedURL)!
        mountedRedirect.redirectURL = URL(string: "https://relay-fixture.invalid/v1/dispatch")!
        mountedRedirect.status = 307
        NetworkProbeProtocol.configure(mountedRedirect)
        let beforeMountedRedirect = NetworkProbeProtocol.captured().count
        try await networkRefuses {
            try await mounted.dispatch(request: wire, credential: credential, currentContext: current.read)
        }
        try networkCheck(NetworkProbeProtocol.captured().count == beforeMountedRedirect + 1)
        NetworkProbeProtocol.configure(.init())
        print("PASS native hosted final URL encoding/traversal/slash/query/prefix and redirect refusals")

        let before = NetworkProbeProtocol.captured().count
        for bad in ["", "[]", "{}", wire + "é", String(repeating: "a", count: 102401),
                    wire.replacingOccurrences(of: "network-user", with: "different-user"),
                    wire.replacingOccurrences(of: "network-phone", with: "different-phone")] {
            try await networkRefuses { try await send(bad) }
        }
        current.set(nil)
        try await networkRefuses { try await send() }
        current.set(context)
        try await networkRefuses { try await client.dispatch(request: wire, credential: credential, currentContext: { throw NetworkProbeFailure(line: 0) }) }
        try networkCheck(NetworkProbeProtocol.captured().count == before)
        print("PASS native invalid/stale requests never start network tasks")

        var goodRegistration = NetworkProbeProtocol.Script()
        goodRegistration.url = URL(string: "https://relay-fixture.invalid/v1/register")!
        goodRegistration.body = Data("{\"version\":1,\"result\":null}".utf8)
        NetworkProbeProtocol.configure(goodRegistration)
        let registration = try await client.register(bundle: wire, credential: credential, currentContext: current.read)
        try networkCheck(registration == Data("null".utf8))
        try await networkRefuses { try await client.register(bundle: String(repeating: "a", count: 4097), credential: credential, currentContext: current.read) }

        for status in [301, 302, 307, 308, 401, 403, 429, 500, 503, 504] {
            var script = NetworkProbeProtocol.Script(); script.status = status
            NetworkProbeProtocol.configure(script)
            try await networkRefuses { try await send() }
        }
        for type in ["text/html", "application/json; charset=latin-1", "application/json\n", "application/json; x=y", "application/json, text/html"] {
            var script = NetworkProbeProtocol.Script(); script.type = type
            NetworkProbeProtocol.configure(script)
            try await networkRefuses { try await send() }
        }
        var wrongURL = NetworkProbeProtocol.Script(); wrongURL.url = URL(string: "https://other.invalid/v1/dispatch")!
        NetworkProbeProtocol.configure(wrongURL)
        try await networkRefuses { try await send() }
        var length = NetworkProbeProtocol.Script(); length.length = 2 * 1024 * 1024 + 1
        NetworkProbeProtocol.configure(length)
        try await networkRefuses { try await send() }
        var overflow = NetworkProbeProtocol.Script(); overflow.body = Data(repeating: 32, count: 2 * 1024 * 1024 + 1)
        NetworkProbeProtocol.configure(overflow)
        try await networkRefuses { try await send() }
        print("PASS native status/content-type/final-URL and declared/streamed response caps")
        var redirect = NetworkProbeProtocol.Script(); redirect.status = 307
        redirect.redirectURL = URL(string: "https://relay-fixture.invalid/v1/redirect-target")!
        NetworkProbeProtocol.configure(redirect)
        let beforeRedirect = NetworkProbeProtocol.captured().count
        try await networkRefuses { try await send() }
        try networkCheck(NetworkProbeProtocol.captured().count == beforeRedirect + 1)
        print("PASS native redirect callback refuses forwarding bearer/public request")

        for body in ["", "not-json", "{\"version\":true,\"result\":{}}", "{\"version\":2,\"result\":{}}",
                     "{\"version\":1,\"result\":{},\"result\":{}}", "{\"version\":1,\"result\":{},\"extra\":true}",
                     "{\"version\":1,\"result\":{}", "{\"version\":1,\"result\":{}} trailing"] {
            var script = NetworkProbeProtocol.Script(); script.body = Data(body.utf8)
            NetworkProbeProtocol.configure(script)
            try await networkRefuses { try await send() }
        }
        var invalidUTF8 = NetworkProbeProtocol.Script(); invalidUTF8.body = Data("{\"version\":1,\"result\":\"".utf8) + Data([255]) + Data("\"}".utf8)
        NetworkProbeProtocol.configure(invalidUTF8)
        try await networkRefuses { try await send() }
        for fragment: [UInt8] in [[0, 123, 0, 125], [123, 0, 125, 0], [0, 0, 0, 123, 0, 0, 0, 125], [123, 0, 0, 0, 125, 0, 0, 0]] {
            var mixed = NetworkProbeProtocol.Script()
            mixed.body = Data("{\"version\":1,\"result\":".utf8) + Data(fragment) + Data("}".utf8)
            NetworkProbeProtocol.configure(mixed)
            try await networkRefuses { try await send() }
        }
        var connectionError = NetworkProbeProtocol.Script(); connectionError.error = true
        NetworkProbeProtocol.configure(connectionError)
        try await networkRefuses { try await send() }
        print("PASS native malformed/duplicate outer framing, truncation, UTF8 and connection failure")

        for kind in 0..<4 {
            var delayed = NetworkProbeProtocol.Script(); delayed.delay = 0.04
            NetworkProbeProtocol.configure(delayed)
            let task = Task { try await send() }
            try await Task.sleep(nanoseconds: 10_000_000)
            let changed = DmRelayNetworkContext(userId: context.userId, deviceId: context.deviceId,
                ownerGeneration: kind == 0 ? context.ownerGeneration + 1 : context.ownerGeneration,
                credentialEpoch: kind == 1 ? UUID() : context.credentialEpoch,
                peerGeneration: kind == 2 ? 8 : context.peerGeneration)
            current.set(kind == 3 ? nil : changed)
            try await networkRefuses { try await task.value }
            current.set(context)
        }
        print("PASS native in-flight owner, credential, peer and logout response fences")
        NetworkProbeProtocol.configure(.init())
        for invalidCall in [2, 5] {
            let changed = NetworkProbeSlowContext(context, invalidCall: invalidCall)
            let before = NetworkProbeProtocol.captured().count
            try await networkRefuses { try await client.dispatch(request: wire, credential: credential, currentContext: changed.read) }
            try networkCheck(NetworkProbeProtocol.captured().count == before + (invalidCall == 2 ? 0 : 1))
        }
        print("PASS native direct pre-resume and post-await context fences")

        var stalled = NetworkProbeProtocol.Script(); stalled.neverFinish = true; stalled.body = Data()
        NetworkProbeProtocol.configure(stalled)
        try await networkRefuses { try await send() }
        var drip = NetworkProbeProtocol.Script(); drip.neverFinish = true; drip.repeatChunk = true; drip.body = Data()
        NetworkProbeProtocol.configure(drip)
        let started = ContinuousClock.now
        try await networkRefuses { try await send() }
        try networkCheck(started.duration(to: .now) < .seconds(1))
        var slowHeaders = NetworkProbeProtocol.Script(); slowHeaders.delay = 1
        NetworkProbeProtocol.configure(slowHeaders)
        try await networkRefuses { try await send() }
        print("PASS native independent monotonic deadline: stalled body, endless drip and slow headers")

        let short = try VodozemacRelayTransport(serviceOrigin: "https://relay-fixture.invalid", deadlineSeconds: 0.02,
            configurationForResearch: configured)
        NetworkProbeProtocol.configure(.init())
        for slowCall in [1, 2] {
            let slow = NetworkProbeSlowContext(context, slowCall: slowCall)
            let before = NetworkProbeProtocol.captured().count
            try await networkRefuses { try await short.dispatch(request: wire, credential: credential, currentContext: slow.read) }
            try networkCheck(NetworkProbeProtocol.captured().count == before)
        }
        let slowCompletion = NetworkProbeSlowContext(context, slowCall: 4)
        try await networkRefuses { try await short.dispatch(request: wire, credential: credential, currentContext: slowCompletion.read) }
        print("PASS native elapsed deadline before dispatch and after bounded context reads")

        NetworkProbeProtocol.configure(.init())
        let beforeCancel = NetworkProbeProtocol.captured().count, gate = NetworkProbeGate()
        let preCancelled = Task { await gate.wait(); return try await send() }
        preCancelled.cancel(); gate.release()
        try await networkRefuses { try await preCancelled.value }
        try networkCheck(NetworkProbeProtocol.captured().count == beforeCancel)
        NetworkProbeProtocol.configure(stalled)
        let inFlight = Task { try await send() }
        for _ in 0..<100 {
            if NetworkProbeProtocol.captured().count > beforeCancel { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        try networkCheck(NetworkProbeProtocol.captured().count == beforeCancel + 1)
        inFlight.cancel()
        try await networkRefuses { try await inFlight.value }
        for index in 0..<30 {
            var delayed = NetworkProbeProtocol.Script(); delayed.delay = index.isMultiple(of: 2) ? 0.002 : 0.02
            NetworkProbeProtocol.configure(delayed)
            let task = Task { try await send() }
            if !index.isMultiple(of: 3) { try await Task.sleep(nanoseconds: 1_000_000) }
            task.cancel()
            // A task that completed BEFORE cancellation may legitimately return
            // its result. Cancellation cannot undo completed work. Both racing
            // outcomes are valid; double continuation completion still traps.
            do { let result = try await task.value; try networkCheck(result == Data("{\"accepted\":true}".utf8)) }
            catch is DmRelayTransportError { /* expected unresolved race */ }
        }
        NetworkProbeProtocol.configure(.init())
        _ = try await send()
        print("PASS native cancellation/start/completion races and usable subsequent transport")
        print("PASS 13 native URLSession fixture scenario groups; no live TLS/Auth/physical phone claims")
    }
}
