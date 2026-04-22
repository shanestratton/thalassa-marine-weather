import Foundation
import Combine
import WatchConnectivity

/**
 * WatchSession — owns WCSession on the watch side and exposes the
 * latest anchor + weather snapshots as @Published properties for
 * SwiftUI to bind to.
 *
 * The phone-side iOS plugin pushes via `updateApplicationContext`,
 * which Apple delivers durably (latest-only) to this delegate.
 */
final class WatchSession: NSObject, ObservableObject, WCSessionDelegate {

    @Published private(set) var anchor: AnchorSnapshot? = nil
    @Published private(set) var weather: WeatherSnapshot? = nil
    @Published private(set) var isReachable: Bool = false

    private let session: WCSession?

    override init() {
        self.session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        if session.activationState != .activated {
            session.activate()
        } else {
            // Already activated — re-read context in case we missed
            // the initial delivery (cold start, app reopen).
            applyContext(session.applicationContext)
        }
    }

    /**
     * Send a "MOB" event to the phone. Long-press handler in
     * MobButton calls this. Uses sendMessage so it lands immediately
     * if the phone is reachable; falls back to transferUserInfo for
     * later delivery if not.
     */
    func sendMobTrigger(payload: [String: Any] = [:]) {
        guard let session else { return }
        var msg = payload
        msg["type"] = "mob"
        msg["watchTimestamp"] = Date().timeIntervalSince1970
        if session.isReachable {
            session.sendMessage(msg, replyHandler: nil, errorHandler: { err in
                NSLog("WatchSession.sendMobTrigger: \(err.localizedDescription)")
            })
        } else {
            // Phone not reachable — queue for later. This still gets
            // delivered when the watch comes back into Bluetooth range,
            // which matters for MOB because the user might have walked
            // to the bow and the phone is in the cockpit.
            session.transferUserInfo(msg)
        }
    }

    /** Acknowledge the alarm — silences phone-side audio. */
    func sendAlarmAck() {
        guard let session, session.isReachable else { return }
        session.sendMessage(
            ["type": "alarmAck", "watchTimestamp": Date().timeIntervalSince1970],
            replyHandler: nil,
            errorHandler: nil
        )
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error = error {
            NSLog("WatchSession activation failed: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            self.applyContext(session.applicationContext)
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async {
            self.applyContext(applicationContext)
        }
    }

    private func applyContext(_ ctx: [String: Any]) {
        if let a = ctx["anchorSnapshot"] as? [String: Any], let snap = AnchorSnapshot(from: a) {
            self.anchor = snap
        }
        if let w = ctx["weatherSnapshot"] as? [String: Any], let snap = WeatherSnapshot(from: w) {
            self.weather = snap
        }
    }
}
