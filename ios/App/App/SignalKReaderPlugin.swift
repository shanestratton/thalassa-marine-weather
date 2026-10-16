import Foundation
import Capacitor
import UIKit

/// Device-approved read transport. No arbitrary paths, sends, PUTs or navigation commands.
@objc(SignalKReaderPlugin)
public final class SignalKReaderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SignalKReaderPlugin"
    public let jsName = "SignalKReader"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private let lock = NSLock()
    private var downloads: [String: SignalKDownload] = [:]
    private var cancelled: [String: Date] = [:]
    private var socket: SignalKSocket?
    private var socketId: String?
    private var foreground = true
    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self); socket?.stop(); downloads.values.forEach { $0.cancel() } }
    @objc private func background() {
        lock.lock(); foreground = false; let held = socket; socket = nil; socketId = nil; let pending = Array(downloads.values); lock.unlock()
        held?.stop(); pending.forEach { $0.cancel() }
    }
    @objc private func active() { lock.lock(); foreground = true; lock.unlock() }
    private static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
    static func origin(_ call: CAPPluginCall) -> URL? {
        guard let raw = call.getString("origin"), raw.utf8.count <= 2048,
              let c = URLComponents(string: raw), let scheme = c.scheme, let host = c.host?.lowercased(),
              ["http", "https"].contains(scheme), c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/",
              c.port == nil || (1...65535).contains(c.port!), let url = c.url else { return nil }
        if scheme == "http" {
            let p = host.split(separator: ".").compactMap { Int($0) }
            let canonical = p.map { String($0) }.joined(separator: ".")
            let privateV4 = p.count == 4 && host == canonical && p.allSatisfy { (0...255).contains($0) } &&
                (p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 169 && p[1] == 254))
            guard call.getBool("allowInsecureLan") == true, privateV4 || host.hasSuffix(".local") else { return nil }
        }
        return url
    }
    private static func token(_ call: CAPPluginCall) -> String? {
        guard let t = call.getString("accessToken"), (1...4096).contains(t.utf8.count),
              t.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { return nil }
        return t
    }
    @objc func request(_ call: CAPPluginCall) {
        guard let base = Self.origin(call), let target = call.getString("target"),
              let id = call.getString("requestId"), UUID(uuidString: id) != nil else { call.reject("Invalid Signal K read request"); return }
        var path: String; var body: Data?; var method = "GET"; var limit = 65536
        switch target {
        case "discovery": path = "/signalk"
        case "self": path = "/signalk/v1/api/vessels/self"; limit = 1048576
        case "access":
            guard let clientId = call.getString("clientId"), UUID(uuidString: clientId) != nil else { call.reject("Invalid device identity"); return }
            path = "/signalk/v1/access/requests"; method = "POST"
            body = try? JSONSerialization.data(withJSONObject: ["clientId": clientId, "description": "Thalassa instrument reader (read only)"])
        case "accessStatus":
            guard let accessId = call.getString("accessId"), Self.matches(accessId, "^[A-Za-z0-9_-]{1,128}$") else { call.reject("Invalid approval request"); return }
            path = "/signalk/v1/access/requests/" + accessId
        default: call.reject("Signal K read target unavailable"); return
        }
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { call.reject("Invalid Signal K origin"); return }
        var req = URLRequest(url: url); req.httpMethod = method; req.httpBody = body
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if call.getString("accessToken") != nil {
            guard let t = Self.token(call), target == "discovery" || target == "self" else { call.reject("Invalid Signal K device access"); return }
            req.setValue("Bearer " + t, forHTTPHeaderField: "Authorization")
        }
        let download = SignalKDownload(request: req, maxBytes: limit) { [weak self] reply in
            if let owner = self { owner.lock.lock(); owner.downloads.removeValue(forKey: id); owner.lock.unlock() }
            switch reply { case .success(let result): call.resolve(result); case .failure: call.reject("Signal K read unavailable") }
        }
        lock.lock(); cancelled = cancelled.filter { Date().timeIntervalSince($0.value) < 30 }
        guard foreground, downloads.count < 2, downloads[id] == nil, cancelled.removeValue(forKey: id) == nil else { lock.unlock(); call.reject("Signal K read cancelled"); return }
        downloads[id] = download; lock.unlock(); download.start()
    }
    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("requestId") ?? ""
        lock.lock(); let current = downloads[id]
        if current == nil, UUID(uuidString: id) != nil {
            if cancelled.count >= 32, let key = cancelled.min(by: { $0.value < $1.value })?.key { cancelled.removeValue(forKey: key) }
            cancelled[id] = Date()
        }
        lock.unlock(); current?.cancel(); call.resolve()
    }
    @objc func start(_ call: CAPPluginCall) {
        guard let base = Self.origin(call), let t = Self.token(call), let id = call.getString("sessionId"), UUID(uuidString: id) != nil,
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { call.reject("Invalid Signal K stream"); return }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"; parts.path = "/signalk/v1/stream"; parts.query = "subscribe=none"
        guard let url = parts.url else { call.reject("Invalid Signal K stream"); return }
        let next = SignalKSocket(url: url, token: t, message: { [weak self] text in
            guard let owner = self else { return }; owner.lock.lock(); let current = owner.foreground && owner.socketId == id; owner.lock.unlock()
            if current { owner.notifyListeners("message", data: ["sessionId": id, "text": text]) }
        }, closed: { [weak self] in
            guard let owner = self else { return }; owner.lock.lock(); let current = owner.socketId == id
            if current { owner.socket = nil; owner.socketId = nil }; owner.lock.unlock()
            if current { owner.notifyListeners("closed", data: ["sessionId": id]) }
        })
        lock.lock()
        guard foreground, cancelled.removeValue(forKey: id) == nil else { lock.unlock(); call.reject("Signal K stream cancelled"); return }
        let old = socket; socket = next; socketId = id; lock.unlock(); old?.stop(); next.start(); call.resolve()
    }
    @objc func stop(_ call: CAPPluginCall) {
        let id = call.getString("sessionId") ?? ""
        lock.lock(); let current = socketId == id ? socket : nil
        if current != nil { socket = nil; socketId = nil }
        else if UUID(uuidString: id) != nil {
            if cancelled.count >= 32, let key = cancelled.min(by: { $0.value < $1.value })?.key { cancelled.removeValue(forKey: key) }
            cancelled[id] = Date()
        }
        lock.unlock(); current?.stop(); call.resolve()
    }
}

private final class SignalKDownload: NSObject, URLSessionDataDelegate {
    private let request: URLRequest, maxBytes: Int, completion: (Result<[String: Any], Error>) -> Void
    private let lock = NSLock(); private var done = false, bytes = Data(), status = 0
    private var session: URLSession?
    init(request: URLRequest, maxBytes: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) { self.request = request; self.maxBytes = maxBytes; self.completion = completion }
    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        lock.lock(); guard !done else { lock.unlock(); s.invalidateAndCancel(); return }; session = s; lock.unlock()
        s.dataTask(with: request).resume(); DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak self] in self?.cancel() }
    }
    func cancel() { finish(.failure(URLError(.cancelled))) }
    private func finish(_ result: Result<[String: Any], Error>) {
        lock.lock(); guard !done else { lock.unlock(); return }; done = true; let s = session; session = nil; lock.unlock()
        s?.invalidateAndCancel(); completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); finish(.failure(URLError(.redirectToNonExistentLocation)))
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, response.url == request.url else { completionHandler(.cancel); cancel(); return }
        lock.lock(); status = http.statusCode; lock.unlock()
        guard [200, 202].contains(http.statusCode) else { completionHandler(.cancel); finish(.success(["status": http.statusCode, "body": ""])); return }
        guard response.expectedContentLength <= Int64(maxBytes) else { completionHandler(.cancel); cancel(); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); guard !done, bytes.count + data.count <= maxBytes else { lock.unlock(); cancel(); return }; bytes.append(data); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { cancel(); return }
        lock.lock(); let data = bytes, code = status; lock.unlock()
        guard let text = String(data: data, encoding: .utf8) else { cancel(); return }; finish(.success(["status": code, "body": text]))
    }
}

private final class SignalKSocket: NSObject, URLSessionWebSocketDelegate {
    private let url: URL, token: String, message: (String) -> Void, closed: () -> Void
    private let lock = NSLock(); private var stopped = false, session: URLSession?, task: URLSessionWebSocketTask?
    private var lastMessage = Date(), window = Date(), count = 0, bytes = 0
    init(url: URL, token: String, message: @escaping (String) -> Void, closed: @escaping () -> Void) { self.url = url; self.token = token; self.message = message; self.closed = closed }
    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 10
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        var request = URLRequest(url: url); request.httpShouldHandleCookies = false; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let t = s.webSocketTask(with: request); t.maximumMessageSize = 65536
        lock.lock(); guard !stopped else { lock.unlock(); s.invalidateAndCancel(); return }; session = s; task = t; lock.unlock(); t.resume()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let owner = self else { return }; owner.lock.lock(); let opened = owner.task?.state == .running && Date().timeIntervalSince(owner.lastMessage) < 10; owner.lock.unlock()
            if !opened { owner.stop() }
        }
    }
    func stop() {
        lock.lock(); guard !stopped else { lock.unlock(); return }; stopped = true; let s = session, t = task; session = nil; task = nil; lock.unlock()
        t?.cancel(with: .normalClosure, reason: nil); s?.invalidateAndCancel(); closed()
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil); stop() }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        // Deliberately duplicated native allowlist: callers have no arbitrary WS-send API.
        let paths = ["navigation.position", "navigation.speedOverGround", "navigation.courseOverGroundTrue", "navigation.speedThroughWater", "navigation.headingTrue", "navigation.headingMagnetic", "navigation.magneticVariation", "navigation.leewayAngle", "navigation.attitude", "environment.wind.speedTrue", "environment.wind.angleTrueWater", "environment.wind.directionTrue", "environment.wind.speedApparent", "environment.wind.angleApparent", "environment.depth.belowKeel", "environment.depth.belowTransducer", "environment.depth.belowSurface", "environment.depth.transducerToKeel", "environment.water.temperature", "environment.outside.pressure", "steering.rudderAngle", "propulsion.*.revolutions", "propulsion.*.runTime", "propulsion.*.coolantTemperature", "propulsion.*.oilPressure", "notifications.*"]
        let value: [String: Any] = ["context": "vessels.self", "subscribe": paths.map { ["path": $0, "period": 1000, "policy": "instant", "minPeriod": 1000] as [String: Any] }]
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { stop(); return }
        lock.lock(); lastMessage = Date(); lock.unlock()
        webSocketTask.send(.string(text)) { [weak self] error in if error != nil { self?.stop() } else { self?.receive() } }
        watchdog()
    }
    private func watchdog() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let owner = self else { return }; owner.lock.lock(); let done = owner.stopped, quiet = Date().timeIntervalSince(owner.lastMessage) > 30; owner.lock.unlock()
            if done { return }; if quiet { owner.stop() } else { owner.watchdog() }
        }
    }
    private func receive() {
        lock.lock(); let t = stopped ? nil : task; lock.unlock()
        t?.receive { [weak self] result in
            guard let owner = self else { return }
            guard case .success(.string(let text)) = result, text.utf8.count <= 65536 else { owner.stop(); return }
            owner.lock.lock(); let now = Date()
            if now.timeIntervalSince(owner.window) >= 1 { owner.window = now; owner.count = 0; owner.bytes = 0 }
            owner.count += 1; owner.bytes += text.utf8.count; owner.lastMessage = now
            let allowed = !owner.stopped && owner.count <= 64 && owner.bytes <= 262144; owner.lock.unlock()
            guard allowed else { owner.stop(); return }; owner.message(text); owner.receive()
        }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { stop() }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { if error != nil { stop() } }
}
