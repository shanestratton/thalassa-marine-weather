import Foundation
import Capacitor

/// Public NOAA observations only. Independent of authenticated app/Pi sessions.
@objc(ObservationHttpPlugin)
public class ObservationHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ObservationHttpPlugin"
    public let jsName = "ObservationHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private let lock = NSLock()
    private var downloads: [String: ObservationDownload] = [:]
    private var cancelled: [String: Date] = [:]

    @objc func read(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              Self.allowed(url), let id = call.getString("requestId"), UUID(uuidString: id) != nil,
              let limit = call.getInt("maxBytes"), limit > 0, limit <= 2 * 1024 * 1024 else {
            call.reject("Invalid public observation request"); return
        }
        let download = ObservationDownload(url: url, maxBytes: limit) { [weak self] result in
            if let owner = self { owner.lock.lock(); owner.downloads.removeValue(forKey: id); owner.lock.unlock() }
            switch result {
            case .success(let reply): call.resolve(reply)
            case .failure: call.reject("Public observation request unavailable")
            }
        }
        lock.lock()
        cancelled = cancelled.filter { Date().timeIntervalSince($0.value) < 30 }
        if cancelled.removeValue(forKey: id) != nil { lock.unlock(); call.reject("Observation request cancelled"); return }
        guard downloads[id] == nil, downloads.count < 2 else {
            lock.unlock(); call.reject("Observation request already active"); return
        }
        downloads[id] = download; lock.unlock()
        download.start()
    }
    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("requestId") ?? ""
        lock.lock(); let held = downloads[id]
        if held == nil, UUID(uuidString: id) != nil {
            if cancelled.count >= 32, let oldest = cancelled.min(by: { $0.value < $1.value })?.key { cancelled.removeValue(forKey: oldest) }
            cancelled[id] = Date()
        }
        lock.unlock()
        held?.cancel(); call.resolve()
    }
    static func allowed(_ url: URL) -> Bool {
        guard url.scheme == "https", url.port == nil, url.user == nil,
              url.password == nil, url.fragment == nil else { return false }
        if url.host == "www.ndbc.noaa.gov" {
            return url.query == nil && (url.path == "/data/latest_obs/latest_obs.txt" ||
                url.path.range(of: "^/data/realtime2/[A-Z0-9]{3,8}\\.txt$", options: .regularExpression) != nil)
        }
        guard url.host == "aviationweather.gov" else { return false }
        if url.path == "/data/cache/stations.cache.json.gz" { return url.query == nil }
        guard url.path == "/api/data/metar", let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems, items.count == 3,
              Set(items.map { $0.name }) == Set(["ids", "hours", "format"]) else { return false }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let rawHours = values["hours"] ?? ""
        guard let hours = Int(rawHours), String(hours) == rawHours,
              hours == 3 || (12...72).contains(hours),
              hours == 3 || !(values["ids"] ?? "").contains(",") else { return false }
        return values["format"] == "json" &&
            (values["ids"] ?? "").range(of: "^[A-Z0-9]{4}(,[A-Z0-9]{4}){0,19}$", options: .regularExpression) != nil
    }
}

private final class ObservationDownload: NSObject, URLSessionDataDelegate {
    private let url: URL
    private let maxBytes: Int
    private let completion: (Result<[String: Any], Error>) -> Void
    private let lock = NSLock()
    private var completed = false
    private var data = Data()
    private var status = 0
    private var mime = ""
    private var session: URLSession?
    init(url: URL, maxBytes: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.url = url; self.maxBytes = maxBytes; self.completion = completion
    }
    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let current = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        lock.lock()
        guard !completed else { lock.unlock(); current.invalidateAndCancel(); return }
        session = current; lock.unlock()
        var request = URLRequest(url: url)
        request.httpMethod = "GET"; request.httpShouldHandleCookies = false
        request.setValue("Thalassa/135 (public NOAA observations)", forHTTPHeaderField: "User-Agent")
        request.setValue(url.path.hasSuffix(".gz") ? "application/octet-stream" : url.host == "aviationweather.gov" ? "application/json" : "text/plain", forHTTPHeaderField: "Accept")
        current.dataTask(with: request).resume()
        DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak self] in self?.cancel() }
    }
    func cancel() { finish(.failure(URLError(.cancelled))) }
    private func finish(_ result: Result<[String: Any], Error>) {
        lock.lock(); guard !completed else { lock.unlock(); return }
        completed = true; let current = session; session = nil; lock.unlock()
        current?.invalidateAndCancel(); completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); finish(.failure(URLError(.redirectToNonExistentLocation)))
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Ordinary system TLS validation; never use stored HTTP credentials or prompt.
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, response.url == url else {
            completionHandler(.cancel); finish(.failure(URLError(.badServerResponse))); return
        }
        let type = (response.mimeType ?? "").lowercased()
        lock.lock(); status = http.statusCode; mime = type; lock.unlock()
        guard http.statusCode == 200 else {
            completionHandler(.cancel); finish(.success(["status": http.statusCode, "mime": type, "data": ""])); return
        }
        let allowedMime = url.path.hasSuffix(".gz") ? ["application/octet-stream", "application/gzip", "application/x-gzip"].contains(type) : url.host == "aviationweather.gov" ? type == "application/json" : ["text/plain", "text/csv"].contains(type)
        guard allowedMime, response.expectedContentLength <= Int64(maxBytes) else {
            completionHandler(.cancel); finish(.failure(URLError(.dataLengthExceedsMaximum))); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        guard data.count + incoming.count <= maxBytes else {
            lock.unlock(); finish(.failure(URLError(.dataLengthExceedsMaximum))); return
        }
        data.append(incoming); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { finish(.failure(error)); return }
        lock.lock(); let body = data; let code = status; let contentType = mime; lock.unlock()
        let text: String?
        if url.path.hasSuffix(".gz") { text = body.base64EncodedString() }
        else { text = String(data: body, encoding: .utf8) }
        guard let text = text else { finish(.failure(URLError(.cannotDecodeContentData))); return }
        finish(.success(["status": code, "mime": contentType, "data": text]))
    }
}
