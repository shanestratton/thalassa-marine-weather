// ISOLATED RESEARCH. Unwired native Supabase Auth verifier, not an app login flow.
// The host supplies a trusted project origin and PUBLIC API key. Every bearer is
// checked afresh with that project's Auth server; local bearer claims, metadata,
// roles and a shared Supabase session never select the native actor.
// Supabase documents getUser as server validation of the access token:
// https://supabase.com/docs/reference/swift/auth-getuser
// URLProtocol probes establish mocked behavior, not live Auth or deployment.
import Foundation

enum DmSupabaseAuthError: Error { case unavailable }

final class VodozemacSupabaseAuth {
    let projectOrigin: String
    private let endpoint: URL
    private let publicApiKey: String
    private let deadline: TimeInterval
    private let configurationForResearch: (() -> URLSessionConfiguration)?

    convenience init(projectOrigin: String, publicApiKey: String, deadlineSeconds: TimeInterval = 5) throws {
        try self.init(projectOrigin: projectOrigin, publicApiKey: publicApiKey,
                      deadlineSeconds: deadlineSeconds, configurationForResearch: nil)
    }

    // Native probes may inject URLProtocol. Ordinary use always starts with an
    // ephemeral session and provides no trust override or redirect exception.
    init(projectOrigin: String, publicApiKey: String, deadlineSeconds: TimeInterval,
         configurationForResearch: (() -> URLSessionConfiguration)?) throws {
        guard let endpoint = Self.projectEndpoint(projectOrigin), Self.isPublicApiKey(publicApiKey),
              deadlineSeconds.isFinite, (0.001...10).contains(deadlineSeconds) else {
            throw DmSupabaseAuthError.unavailable
        }
        self.projectOrigin = projectOrigin
        self.endpoint = endpoint
        self.publicApiKey = publicApiKey
        self.deadline = deadlineSeconds
        self.configurationForResearch = configurationForResearch
    }

    /// Only the verified response's unique top-level id is returned. The native
    /// lifecycle owner must supply a quick, authoritative current-attempt check;
    /// a transition after dispatch may still reach Auth, but cannot apply its
    /// stale result. This callback is never invoked while an operation lock is held.
    func authenticate(bearer: String, currentAttempt: @escaping () -> Bool) async throws -> String {
        let deadlineAt = ContinuousClock.now.advanced(by: .seconds(deadline))
        guard !Task.isCancelled, Self.safeBearer(bearer), currentAttempt(),
              ContinuousClock.now < deadlineAt else { throw DmSupabaseAuthError.unavailable }

        let configuration = configurationForResearch?() ?? URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpAdditionalHeaders = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = deadline
        configuration.timeoutIntervalForResource = deadline
        configuration.waitsForConnectivity = false

        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: deadline)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        request.setValue(publicApiKey, forHTTPHeaderField: "apikey")
        let operation = DmSupabaseAuthOperation(url: endpoint, request: request, configuration: configuration,
                                               deadlineAt: deadlineAt, currentAttempt: currentAttempt)
        let data = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in operation.start(continuation) }
        }, onCancel: { operation.cancel() })

        guard !Task.isCancelled, currentAttempt(), ContinuousClock.now < deadlineAt,
              String(data: data, encoding: .utf8) != nil,
              let user = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              DmSupabaseAuthJSON.hasUniqueTopLevelMember("id", in: data),
              let id = user["id"] as? String, Self.canonicalUUID(id),
              !Task.isCancelled, currentAttempt(), ContinuousClock.now < deadlineAt else {
            throw DmSupabaseAuthError.unavailable
        }
        return id
    }

    private static func projectEndpoint(_ value: String) -> URL? {
        guard value.utf8.count <= 2048, value.utf8.allSatisfy({ (33...126).contains($0) }),
              let parts = URLComponents(string: value), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, host == host.lowercased(), !host.hasSuffix("."),
              parts.percentEncodedHost == host,
              host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || [45, 46, 58, 91, 93].contains($0) }),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty, parts.port.map({ (1...65535).contains($0) && $0 != 443 }) ?? true else { return nil }
        // Rebuild the origin to reject silent escaping, encoded hosts, redundant
        // default ports and noncanonical spelling before constructing the endpoint.
        var canonical = URLComponents()
        canonical.scheme = "https"; canonical.host = host; canonical.port = parts.port
        guard canonical.string == value, canonical.url?.absoluteString == value else { return nil }
        canonical.path = "/auth/v1/user"
        return canonical.url
    }

    private static func safeBearer(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...8192).contains(bytes.count) else { return false }
        var padding = false
        var stem = 0
        for byte in bytes {
            if byte == 61 { padding = true; continue }
            guard !padding, (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
                    || [45, 46, 95, 126, 43, 47].contains(byte) else { return false }
            stem += 1
        }
        return stem > 0
    }

    private static func isPublicApiKey(_ value: String) -> Bool {
        guard safeBearer(value) else { return false }
        let publishablePrefix = "sb_publishable_"
        if value.hasPrefix(publishablePrefix) { return value.utf8.count > publishablePrefix.utf8.count }
        // Decode only this trusted CONFIG value to catch accidental service_role
        // keys. This is not signature verification or bearer/user authentication.
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ part in
            !part.isEmpty && part.utf8.allSatisfy({ byte in
                (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
                    || byte == 45 || byte == 95
            })
        }) else { return false }
        var base64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard base64.utf8.count % 4 != 1 else { return false }
        base64 += String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), String(data: data, encoding: .utf8) != nil,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              DmSupabaseAuthJSON.hasUniqueTopLevelMember("role", in: data),
              payload["role"] as? String == "anon" else { return false }
        return true
    }

    private static func canonicalUUID(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 36 else { return false }
        for (index, byte) in bytes.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                guard byte == 45 else { return false }
            } else if !(48...57).contains(byte) && !(97...102).contains(byte) { return false }
        }
        return UUID(uuidString: value)?.uuidString.lowercased() == value
    }
}

private final class DmSupabaseAuthOperation: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let responseLimit = 512 * 1024
    private let lock = NSLock()
    private let expectedURL: URL
    private let request: URLRequest
    private let configuration: URLSessionConfiguration
    private let deadlineAt: ContinuousClock.Instant
    private let currentAttempt: () -> Bool
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<Data, Error>?
    private var outcome: Result<Data, Error>?
    private var acceptedHeaders = false
    private var bytes = Data()

    init(url: URL, request: URLRequest, configuration: URLSessionConfiguration,
         deadlineAt: ContinuousClock.Instant, currentAttempt: @escaping () -> Bool) {
        self.expectedURL = url; self.request = request; self.configuration = configuration
        self.deadlineAt = deadlineAt; self.currentAttempt = currentAttempt
    }

    func start(_ continuation: CheckedContinuation<Data, Error>) {
        lock.lock()
        if let outcome { lock.unlock(); continuation.resume(with: outcome); return }
        self.continuation = continuation
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        let task = session.dataTask(with: request)
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let remaining = ContinuousClock.now.duration(to: deadlineAt).components
        timer.schedule(deadline: .now() + max(0, Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18))
        timer.setEventHandler { [weak self] in self?.cancel() }
        self.session = session; self.task = task; self.timer = timer
        timer.resume()
        lock.unlock()

        // External lifecycle readers can reenter native code: never call them
        // under this lock. A cancelled task remains cancelled even if resumed.
        guard currentAttempt(), ContinuousClock.now < deadlineAt else { cancel(); return }
        lock.lock()
        let active = outcome == nil
        lock.unlock()
        if active { task.resume() }
    }

    func cancel() { finish(.failure(DmSupabaseAuthError.unavailable)) }

    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        let result: Result<Data, Error> = ContinuousClock.now < deadlineAt ? result : .failure(DmSupabaseAuthError.unavailable)
        outcome = result
        let continuation = self.continuation, session = self.session, timer = self.timer
        self.continuation = nil; self.session = nil; self.task = nil; self.timer = nil
        bytes.removeAll(keepingCapacity: false)
        lock.unlock()
        timer?.cancel()
        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        cancel()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler: completionHandler)
    }

    private func handle(_ challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            // System TLS verification only; no credential, pin bypass or custom trust.
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse,
              response.url?.absoluteString == expectedURL.absoluteString, response.statusCode == 200,
              Self.jsonContentType(response.value(forHTTPHeaderField: "Content-Type")),
              Self.boundedContentLength(response.value(forHTTPHeaderField: "Content-Length")),
              response.expectedContentLength <= Int64(Self.responseLimit),
              currentAttempt(), ContinuousClock.now < deadlineAt else {
            completionHandler(.cancel); cancel(); return
        }
        lock.lock()
        let active = outcome == nil
        if active { acceptedHeaders = true }
        lock.unlock()
        completionHandler(active ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard currentAttempt(), ContinuousClock.now < deadlineAt else { cancel(); return }
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        guard acceptedHeaders, data.count <= Self.responseLimit - bytes.count else {
            lock.unlock(); cancel(); return
        }
        bytes.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, willCacheResponse proposedResponse: CachedURLResponse,
                    completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        let data = bytes, received = acceptedHeaders
        lock.unlock()
        guard error == nil, received, !data.isEmpty, currentAttempt(), ContinuousClock.now < deadlineAt else {
            cancel(); return
        }
        finish(.success(data))
    }

    private static func jsonContentType(_ value: String?) -> Bool {
        guard let value else { return false }
        let type = value.lowercased()
        let match = type.range(of: #"^application/json(?:\s*;\s*charset\s*=\s*utf-8)?$"#, options: .regularExpression)
        return match?.lowerBound == type.startIndex && match?.upperBound == type.endIndex
    }

    private static func boundedContentLength(_ value: String?) -> Bool {
        guard let value else { return true }
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.allSatisfy({ (48...57).contains($0) }),
              bytes.count == 1 || bytes[0] != 48,
              let length = Int(value), length <= responseLimit else { return false }
        return true
    }
}

private enum DmSupabaseAuthJSON {
    // Called only after Foundation has validated an object and strict UTF-8.
    // Iterative token scanning avoids recursion and catches escaped duplicate
    // keys that JSONSerialization's last-value-wins dictionary would conceal.
    static func hasUniqueTopLevelMember(_ member: String, in data: Data) -> Bool {
        let bytes = Array(data)
        var index = 0, depth = 0, count = 0
        while index < bytes.count && whitespace(bytes[index]) { index += 1 }
        guard index < bytes.count, bytes[index] == 123 else { return false }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 34 {
                let start = index
                index += 1
                while index < bytes.count && bytes[index] != 34 {
                    if bytes[index] == 92 { index += 1 }
                    index += 1
                }
                guard index < bytes.count else { return false }
                index += 1
                if depth == 1 {
                    var next = index
                    while next < bytes.count && whitespace(bytes[next]) { next += 1 }
                    if next < bytes.count && bytes[next] == 58,
                       let key = try? JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: [.fragmentsAllowed]) as? String,
                       key == member {
                        count += 1
                        if count > 1 { return false }
                    }
                }
                continue
            }
            if byte == 123 || byte == 91 { depth += 1 }
            if byte == 125 || byte == 93 { depth -= 1 }
            index += 1
        }
        return depth == 0 && count == 1
    }

    private static func whitespace(_ byte: UInt8) -> Bool { [9, 10, 13, 32].contains(byte) }
}
