// ISOLATED RESEARCH. Public ciphertext transport, not a Thalassa auth/plugin adapter.
// Caller supplies a captured native context and an authoritative current-context
// reader. Generations must come from durable native lifecycle state, not a boot
// counter or JavaScript assertion. This file does not establish that lifecycle.
import Foundation

enum DmRelayTransportError: Error { case unresolved }

struct DmRelayNetworkContext: Equatable {
    let userId: String
    let deviceId: String
    let ownerGeneration: Int64
    let credentialEpoch: UUID
    let peerGeneration: Int64?
}

struct DmRelayNetworkCredential: CustomStringConvertible, CustomDebugStringConvertible {
    let context: DmRelayNetworkContext
    fileprivate let bearer: String
    var description: String { "DmRelayNetworkCredential(<redacted>)" }
    var debugDescription: String { description }

    init(context: DmRelayNetworkContext, bearer: String) throws {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/")
        let stem = bearer.prefix { $0 != "=" }
        guard !stem.isEmpty, bearer.utf8.count <= 8192,
              stem.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              bearer.dropFirst(stem.count).allSatisfy({ $0 == "=" }),
              Self.identifier(context.userId), Self.identifier(context.deviceId),
              (0...9_007_199_254_740_991).contains(context.ownerGeneration),
              context.peerGeneration.map({ (0...9_007_199_254_740_991).contains($0) }) ?? true else {
            throw DmRelayTransportError.unresolved
        }
        self.context = context
        self.bearer = bearer
    }

    fileprivate static func identifier(_ value: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
        return (1...128).contains(value.utf8.count) && value.unicodeScalars.allSatisfy({ allowed.contains($0) })
    }
}

/// No response here is a delivery decision. The coordinator must still validate
/// the exact receipt/peer and CAS its sealed state before acceptance or plaintext.
/// Timeout/cancellation may follow server commit: retry the SAME durable signed
/// wire; never manufacture a refusal, new ciphertext or a new nonce here.
final class VodozemacRelayTransport {
    private let serviceBaseURL: String
    private let deadline: TimeInterval
    private let configurationForResearch: (() -> URLSessionConfiguration)?

    convenience init(serviceOrigin: String, serviceBasePath: String = "", deadlineSeconds: TimeInterval = 10) throws {
        try self.init(serviceOrigin: serviceOrigin, serviceBasePath: serviceBasePath,
                      deadlineSeconds: deadlineSeconds, configurationForResearch: nil)
    }

    // Only the native probe injects URLProtocol. No production trust override,
    // alternate scheme, redirect exception, or custom TLS challenge is provided.
    init(serviceOrigin: String, serviceBasePath: String = "", deadlineSeconds: TimeInterval,
         configurationForResearch: (() -> URLSessionConfiguration)?) throws {
        guard let parts = URLComponents(string: serviceOrigin), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              parts.url?.absoluteString == serviceOrigin,
              Self.validServiceBasePath(serviceBasePath),
              deadlineSeconds.isFinite, (0.001...10).contains(deadlineSeconds) else {
            throw DmRelayTransportError.unresolved
        }
        self.serviceBaseURL = serviceOrigin + serviceBasePath
        self.deadline = deadlineSeconds
        self.configurationForResearch = configurationForResearch
    }

    // Native trusted configuration, never a JavaScript URL or request-derived
    // routing hint. Empty retains the root-mounted fixture contract. Hosted
    // mounts accept one lowercase ASCII slug, with no URL normalization needed.
    private static func validServiceBasePath(_ path: String) -> Bool {
        if path.isEmpty { return true }
        let prefix = "/functions/v1/"
        guard path.hasPrefix(prefix) else { return false }
        let slug = Array(path.dropFirst(prefix.count).utf8)
        guard (1...64).contains(slug.count), let first = slug.first, (97...122).contains(first),
              slug.last != 45 else { return false }
        var previousHyphen = false
        for byte in slug {
            if byte == 45 {
                if previousHyphen { return false }
                previousHyphen = true
            } else {
                guard (97...122).contains(byte) || (48...57).contains(byte) else { return false }
                previousHyphen = false
            }
        }
        return true
    }

    func register(bundle: String, credential: DmRelayNetworkCredential,
                  currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> Data {
        try await perform(wire: bundle, endpoint: "/v1/register", limit: 4096,
                          credential: credential, dispatchContext: currentContext, completionContext: currentContext)
    }

    func dispatch(request: String, credential: DmRelayNetworkCredential,
                  currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> Data {
        try await perform(wire: request, endpoint: "/v1/dispatch", limit: 100 * 1024,
                          credential: credential, dispatchContext: currentContext, completionContext: currentContext)
    }

    /// Native send-only split authority. BOTH readers must return the exact
    /// original owner-only credential context. The dispatch reader additionally
    /// validates the original paired snapshot/policy; only completion may omit
    /// that peer gate so an exact terminal rejection can be settled natively.
    /// This does not permit acceptance without the coordinator's full gate.
    func dispatch(request: String, credential: DmRelayNetworkCredential,
                  dispatchContext: @escaping () throws -> DmRelayNetworkContext?,
                  completionContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> Data {
        guard credential.context.peerGeneration == nil, !request.isEmpty, request.utf8.count <= 100 * 1024,
              request.utf8.allSatisfy({ (32...126).contains($0) }),
              let object = try? JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any],
              object["action"] as? String == "send" else { throw DmRelayTransportError.unresolved }
        return try await perform(wire: request, endpoint: "/v1/dispatch", limit: 100 * 1024,
            credential: credential, dispatchContext: dispatchContext, completionContext: completionContext)
    }

    private func perform(wire: String, endpoint: String, limit: Int,
                         credential: DmRelayNetworkCredential,
                         dispatchContext: @escaping () throws -> DmRelayNetworkContext?,
                         completionContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> Data {
        let deadlineAt = ContinuousClock.now.advanced(by: .seconds(deadline))
        guard !Task.isCancelled, !wire.isEmpty, wire.utf8.count <= limit,
              wire.utf8.allSatisfy({ (32...126).contains($0) }),
              let object = try? JSONSerialization.jsonObject(with: Data(wire.utf8)) as? [String: Any],
              object["userId"] as? String == credential.context.userId,
              object["deviceId"] as? String == credential.context.deviceId,
              (try? dispatchContext()) == credential.context,
              (try? completionContext()) == credential.context,
              ContinuousClock.now < deadlineAt,
              let url = URL(string: serviceBaseURL + endpoint) else { throw DmRelayTransportError.unresolved }
        let configuration = configurationForResearch?() ?? URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = deadline
        configuration.timeoutIntervalForResource = deadline
        configuration.waitsForConnectivity = false
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: deadline)
        request.httpMethod = "POST"
        request.httpBody = Data(wire.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + credential.bearer, forHTTPHeaderField: "Authorization")
        let operation = DmRelayNetworkOperation(url: url, request: request, configuration: configuration,
            deadlineAt: deadlineAt, context: credential.context,
            dispatchContext: dispatchContext, completionContext: completionContext)
        let result = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in operation.start(continuation) }
        }, onCancel: { operation.cancel() })
        guard !Task.isCancelled, (try? completionContext()) == credential.context, ContinuousClock.now < deadlineAt else {
            throw DmRelayTransportError.unresolved
        }
        return result
    }
}

private final class DmRelayNetworkOperation: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let responseLimit = 2 * 1024 * 1024
    private let lock = NSLock()
    private let expectedURL: URL
    private let request: URLRequest
    private let configuration: URLSessionConfiguration
    private let deadlineAt: ContinuousClock.Instant
    private let context: DmRelayNetworkContext
    private let dispatchContext: () throws -> DmRelayNetworkContext?
    private let completionContext: () throws -> DmRelayNetworkContext?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<Data, Error>?
    private var outcome: Result<Data, Error>?
    private var acceptedHeaders = false
    private var bytes = Data()

    init(url: URL, request: URLRequest, configuration: URLSessionConfiguration, deadlineAt: ContinuousClock.Instant,
         context: DmRelayNetworkContext, dispatchContext: @escaping () throws -> DmRelayNetworkContext?,
         completionContext: @escaping () throws -> DmRelayNetworkContext?) {
        self.expectedURL = url; self.request = request; self.configuration = configuration
        self.deadlineAt = deadlineAt; self.context = context
        self.dispatchContext = dispatchContext; self.completionContext = completionContext
    }

    func start(_ continuation: CheckedContinuation<Data, Error>) {
        lock.lock()
        if let outcome { lock.unlock(); continuation.resume(with: outcome); return }
        self.continuation = continuation
        // Serial delegate callbacks plus a locked, once-only completion gate.
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        let task = session.dataTask(with: request)
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let remaining = ContinuousClock.now.duration(to: deadlineAt).components
        timer.schedule(deadline: .now() + max(0, Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18))
        timer.setEventHandler { [weak self] in self?.cancel() }
        self.session = session; self.task = task; self.timer = timer
        timer.resume()
        // A lifecycle transition after this check can still reach the server.
        // Post-await and coordinator CAS fences prevent applying its stale result.
        let valid = (try? dispatchContext()) == context && (try? completionContext()) == context
            && ContinuousClock.now < deadlineAt
        if valid { task.resume() }
        lock.unlock()
        if !valid { cancel() }
    }

    func cancel() { finish(.failure(DmRelayTransportError.unresolved)) }

    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        let result: Result<Data, Error> = ContinuousClock.now < deadlineAt ? result : .failure(DmRelayTransportError.unresolved)
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

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.url?.absoluteString == expectedURL.absoluteString,
              response.statusCode == 200,
              let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased(),
              type.range(of: #"^application/json(?:\s*;\s*charset\s*=\s*utf-8)?$"#, options: .regularExpression)?.lowerBound == type.startIndex,
              type.range(of: #"^application/json(?:\s*;\s*charset\s*=\s*utf-8)?$"#, options: .regularExpression)?.upperBound == type.endIndex,
              response.expectedContentLength <= Int64(Self.responseLimit),
              (try? completionContext()) == context else {
            completionHandler(.cancel); cancel(); return
        }
        lock.lock()
        let active = outcome == nil
        if active { acceptedHeaders = true }
        lock.unlock()
        completionHandler(active ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        guard acceptedHeaders, data.count <= Self.responseLimit - bytes.count else {
            lock.unlock(); cancel(); return
        }
        bytes.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        let data = bytes, received = acceptedHeaders
        lock.unlock()
        // Strict outer framing rejects duplicate/additional outer keys without
        // relying on JSONSerialization's last-value-wins dictionary behaviour.
        let prefix = Data("{\"version\":1,\"result\":".utf8)
        guard error == nil, received, data.starts(with: prefix), data.last == 125,
              data.count > prefix.count + 1,
              let whole = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(whole.keys) == Set(["version", "result"]),
              (try? completionContext()) == context else { cancel(); return }
        // Foundation auto-detects UTF16/32 when parsing standalone fragments.
        // Validating the complete ASCII-prefixed document first prevents mixed
        // encodings from disguising an invalid response as a valid result slice.
        let result = Data(data.dropFirst(prefix.count).dropLast())
        guard (try? JSONSerialization.jsonObject(with: result, options: [.fragmentsAllowed])) != nil else {
            cancel(); return
        }
        finish(.success(result))
    }
}
