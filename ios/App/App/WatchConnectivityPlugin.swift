import Foundation
import Capacitor
import WatchConnectivity

/**
 * WatchConnectivityPlugin — Bridges TS app state to the paired Apple Watch.
 *
 * Apple's WatchConnectivity framework requires a singleton `WCSession`
 * that's activated once per app launch with a delegate that handles the
 * full lifecycle (activation, reachability changes, state arrival from
 * the watch, etc.). We can't put that delegate on a Capacitor plugin
 * instance because Capacitor recreates plugins on certain bridge
 * resets — we'd lose pending messages. So the WCSession lives in a
 * persistent singleton (`WatchSessionManager`) and this plugin is just
 * the TS-facing API surface.
 *
 * Methods exposed to TypeScript:
 *   - isAvailable() → Promise<{ available, paired, reachable, installed }>
 *   - pushAnchorState(snapshot) → Promise<void>
 *   - pushWeatherSnapshot(snapshot) → Promise<void>
 *   - addListener('mobTriggered' | 'alarmAck', ...)
 *
 * On platforms without WatchConnectivity (anything not iOS) the
 * methods resolve with available=false and are no-ops. The TS bridge
 * should treat the plugin as best-effort.
 */
@objc(WatchConnectivityPlugin)
public class WatchConnectivityPlugin: CAPPlugin {

    public override func load() {
        // Wire ourselves into the singleton so it can fire CAP events
        // back to JS land (mobTriggered, alarmAck) when the watch
        // sends a reverse message.
        WatchSessionManager.shared.eventEmitter = { [weak self] eventName, payload in
            self?.notifyListeners(eventName, data: payload)
        }
        // Activate eagerly so the session is ready by the time the
        // first pushAnchorState arrives.
        WatchSessionManager.shared.activate()
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        let m = WatchSessionManager.shared
        call.resolve([
            "available": m.isSupported,
            "paired": m.isPaired,
            "reachable": m.isReachable,
            "installed": m.isWatchAppInstalled
        ])
    }

    /**
     * Push the latest AnchorWatchSnapshot to the watch. Uses the
     * "application context" channel which is durable: if the watch is
     * unreachable (in another room, screen off), the latest payload is
     * delivered when reachability is restored. Older payloads are
     * silently dropped — only the newest matters for "where is the boat
     * RIGHT NOW".
     */
    @objc func pushAnchorState(_ call: CAPPluginCall) {
        guard let snapshot = call.options as? [String: Any] else {
            call.reject("Missing snapshot")
            return
        }
        do {
            try WatchSessionManager.shared.updateApplicationContext(
                key: "anchorSnapshot",
                value: snapshot
            )
            call.resolve()
        } catch {
            call.reject("Failed to push anchor state: \(error.localizedDescription)")
        }
    }

    /**
     * Push a weather snapshot for the cockpit-glance view. Same durable
     * channel as anchor state.
     */
    @objc func pushWeatherSnapshot(_ call: CAPPluginCall) {
        guard let snapshot = call.options as? [String: Any] else {
            call.reject("Missing snapshot")
            return
        }
        do {
            try WatchSessionManager.shared.updateApplicationContext(
                key: "weatherSnapshot",
                value: snapshot
            )
            call.resolve()
        } catch {
            call.reject("Failed to push weather snapshot: \(error.localizedDescription)")
        }
    }
}

// MARK: - Singleton WCSession owner

/**
 * WatchSessionManager — owns the WCSession across the app lifetime.
 *
 * Why a singleton instead of putting WCSessionDelegate on the plugin:
 * Capacitor plugins are not guaranteed to outlive bridge resets, and
 * WCSession requires its delegate to live for the entire app session.
 * This class is created once on first access and survives plugin
 * recreations.
 */
final class WatchSessionManager: NSObject, WCSessionDelegate {

    static let shared = WatchSessionManager()

    /// Closure injected by the Capacitor plugin to fire JS events.
    var eventEmitter: ((String, [String: Any]) -> Void)?

    private let session: WCSession?
    private var pendingContext: [String: Any] = [:]

    private override init() {
        self.session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
    }

    var isSupported: Bool { session != nil }
    var isPaired: Bool { session?.isPaired ?? false }
    var isReachable: Bool { session?.isReachable ?? false }
    var isWatchAppInstalled: Bool { session?.isWatchAppInstalled ?? false }

    func activate() {
        guard let session else { return }
        session.delegate = self
        if session.activationState != .activated {
            session.activate()
        }
    }

    /**
     * Push a key/value into the durable application context. Apple
     * coalesces multiple updates and only delivers the latest, which
     * is exactly the semantics we want for "current vessel position".
     *
     * Throws if the session is not paired / not installed / not yet
     * activated. The plugin catches and reports.
     */
    func updateApplicationContext(key: String, value: Any) throws {
        guard let session else {
            throw NSError(
                domain: "WatchSessionManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "WatchConnectivity not supported on this device"]
            )
        }
        // Buffer updates that arrive before the session is activated;
        // flush on activation so we don't drop the first AnchorWatchSnapshot.
        if session.activationState != .activated {
            pendingContext[key] = value
            session.activate()
            return
        }
        if !session.isPaired || !session.isWatchAppInstalled {
            // Silently swallow — the user just doesn't have a watch
            // paired or our watch app isn't installed yet. Not an error.
            return
        }
        var context = session.applicationContext
        context[key] = value
        try session.updateApplicationContext(context)
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error = error {
            NSLog("WatchSessionManager: activation failed: \(error.localizedDescription)")
            return
        }
        // Flush anything that arrived before activation completed.
        if activationState == .activated && !pendingContext.isEmpty {
            do {
                var context = session.applicationContext
                for (k, v) in pendingContext {
                    context[k] = v
                }
                try session.updateApplicationContext(context)
                pendingContext.removeAll()
            } catch {
                NSLog("WatchSessionManager: failed to flush pendingContext: \(error.localizedDescription)")
            }
        }
    }

    // iOS-side callback when the session goes idle. Apple requires us
    // to reactivate on the next event for multi-watch scenarios.
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Reactivate so we're ready if the user switches watches.
        session.activate()
    }

    /**
     * Watch → phone messages. Used for MOB trigger and alarm-ack.
     * `replyHandler` lets the watch know the phone received the event.
     */
    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let type = message["type"] as? String {
                switch type {
                case "mob":
                    self.eventEmitter?("mobTriggered", message)
                case "alarmAck":
                    self.eventEmitter?("alarmAck", message)
                default:
                    NSLog("WatchSessionManager: unknown message type \(type)")
                }
            }
            replyHandler(["received": true])
        }
    }
}
