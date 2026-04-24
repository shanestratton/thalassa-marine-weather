import Foundation
import Capacitor

/**
 * LightningPlugin — Native WebSocket bridge to the Blitzortung live lightning
 * feed, used by services/weather/api/blitzortungLightning.ts on iOS.
 *
 * Why this is a native plugin rather than a direct JS WebSocket
 * ─────────────────────────────────────────────────────────────
 * Blitzortung's servers reject browser-initiated WebSocket connections from
 * third-party origins (they check the Origin header and close with code
 * 1006 before the first message). WKWebView sets Origin to
 * `capacitor://localhost`, which fails that check.
 *
 * `URLSessionWebSocketTask` is native iOS networking — it does NOT set an
 * Origin header unless you explicitly ask it to. That's exactly what a
 * "third-party app" looks like to Blitzortung's server, and is the exception
 * their ToS allows (you can use the feed from native apps; only browsers
 * need a server-side relay). So we forward WebSocket traffic through Swift
 * instead of letting the WebView touch it.
 *
 * Protocol surface exposed to JS
 * ──────────────────────────────
 * - `start({ url, subscribeMessage })` opens the WebSocket and sends the
 *   initial subscription payload as soon as it connects.
 * - `stop()` closes the socket and tears down the session.
 * - Events: `"open"` (no body), `"message"` ({ data: string }),
 *   `"close"` ({ code: number, reason: string }), `"error"`
 *   ({ error: string }). Standard Capacitor addListener pattern.
 *
 * Minimal scope on purpose — all LZW decoding and strike parsing stays in
 * the shared TypeScript layer so the browser build (if we ever add a server
 * relay) can use the exact same code.
 */
@objc(LightningPlugin)
public class LightningPlugin: CAPPlugin, URLSessionWebSocketDelegate {

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    // Saved so we can send it in didOpen (we don't send until the
    // connection is actually up — URLSessionWebSocketTask lets you
    // call send() earlier but errors are easier to reason about if we
    // defer).
    private var subscribeMessage: String?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              url.scheme?.lowercased() == "wss" || url.scheme?.lowercased() == "ws" else {
            NSLog("[LightningPlugin] start rejected — invalid URL: \(call.getString("url") ?? "nil")")
            call.reject("Valid ws:// or wss:// URL required")
            return
        }
        subscribeMessage = call.getString("subscribeMessage")
        NSLog("[LightningPlugin] start → \(url.absoluteString) (subscribe: \(subscribeMessage ?? "none"))")

        // Cancel any previous session cleanly before starting a new one.
        // Keeps stop()/start() cycles safe without leaking tasks.
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()

        let config = URLSessionConfiguration.default
        // WebSockets are long-lived. The previous config set
        // timeoutIntervalForRequest=15 which killed the connection if no
        // bytes flowed for 15 seconds — that's normal for a streaming
        // feed during quiet periods (Blitzortung's volunteer detector
        // network can be silent for tens of seconds globally). Default
        // is 60s for request and 7 days for resource which is fine for
        // our use case; we have our own 2-min stall detector in the TS
        // layer to recover from genuinely-dead connections.
        // Delegate queue must NOT be the main queue — URLSessionWebSocketTask
        // blocks in receive() and we don't want it on the UI thread.
        let queue = OperationQueue()
        queue.name = "com.thalassa.lightning.ws"
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        task = session?.webSocketTask(with: url)
        task?.resume()
        receiveLoop()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        subscribeMessage = nil
        call.resolve()
    }

    // MARK: - URLSessionWebSocketDelegate

    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol proto: String?) {
        // `proto` renamed from `protocol` — Swift reserved word. Unused
        // anyway; Blitzortung doesn't negotiate a sub-protocol.
        _ = proto
        NSLog("[LightningPlugin] didOpen")
        notifyListeners("open", data: [:])
        // Fire the subscription message as soon as the socket is open.
        if let msg = subscribeMessage {
            NSLog("[LightningPlugin] sending subscribe: \(msg)")
            webSocketTask.send(.string(msg)) { [weak self] err in
                if let err = err {
                    NSLog("[LightningPlugin] subscribe send failed: \(err.localizedDescription)")
                    self?.notifyListeners("error", data: ["error": err.localizedDescription])
                } else {
                    NSLog("[LightningPlugin] subscribe sent OK")
                }
            }
        }
    }

    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        let reasonStr: String = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        NSLog("[LightningPlugin] didClose code=\(closeCode.rawValue) reason=\(reasonStr)")
        notifyListeners("close", data: [
            "code": closeCode.rawValue,
            "reason": reasonStr,
        ])
    }

    public func urlSession(_ session: URLSession,
                           task: URLSessionTask,
                           didCompleteWithError error: Error?) {
        if let error = error {
            NSLog("[LightningPlugin] didCompleteWithError: \(error.localizedDescription)")
            notifyListeners("error", data: ["error": error.localizedDescription])
        }
    }

    // MARK: - Receive loop

    /// Recursively pulls messages off the socket. Each receive() registers
    /// a one-shot callback, so we re-arm it after every delivery. Any error
    /// terminates the loop and fires an "error" event — the TS layer will
    /// get `close` shortly after (from the delegate) and can decide whether
    /// to reconnect.
    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let s):
                    // NSLog only the first ~60 chars so a heavy storm
                    // doesn't flood the log. Truncated head + length
                    // is enough to tell us the server is sending real
                    // data versus pings/empty frames.
                    let head = s.count > 60 ? String(s.prefix(60)) + "…" : s
                    NSLog("[LightningPlugin] frame (\(s.count)ch): \(head)")
                    self.notifyListeners("message", data: ["data": s])
                case .data(let d):
                    // Blitzortung sends text frames; any binary frame here
                    // is unexpected but we decode UTF-8 just in case.
                    NSLog("[LightningPlugin] binary frame (\(d.count) bytes) — unexpected")
                    if let s = String(data: d, encoding: .utf8) {
                        self.notifyListeners("message", data: ["data": s])
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure(let err):
                NSLog("[LightningPlugin] receive failed: \(err.localizedDescription)")
                self.notifyListeners("error", data: ["error": err.localizedDescription])
                // Don't re-arm — close delegate will follow.
            }
        }
    }
}
