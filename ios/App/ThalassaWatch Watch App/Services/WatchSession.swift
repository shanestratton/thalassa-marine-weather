import Foundation
import Combine
import WatchConnectivity

enum MobDeliveryState: Equatable {
    case idle
    case sending
    /// The reachable phone acknowledged receipt. This does not prove a GPS fix was marked.
    case phoneReceived
    /// WatchConnectivity accepted a background transfer for later phone delivery.
    case queued
    /// The short-lived request was not acknowledged before its safety deadline.
    case expired
    case unavailable
    case failed
}

enum AlarmAckDeliveryState: Equatable {
    case idle
    case sending
    /// The phone acknowledged receipt of the request; its audio state is not observable here.
    case phoneReceived
    case phoneUnreachable
    case failed
}

/**
 * WatchSession — owns WCSession on the watch side and exposes the
 * latest anchor + weather snapshots as @Published properties for
 * SwiftUI to bind to.
 *
 * The phone-side iOS plugin pushes via `updateApplicationContext`,
 * which Apple delivers durably (latest-only) to this delegate.
 */
final class WatchSession: NSObject, ObservableObject, WCSessionDelegate {

    private static let mobRequestVersion = 1
    /// The phone has no historical casualty position in this request. After 15
    /// seconds it must never substitute its later current position as the mark.
    private static let mobRequestTtlMs: Double = 15_000

    @Published private(set) var anchor: AnchorSnapshot? = nil
    @Published private(set) var weather: WeatherSnapshot? = nil
    @Published private(set) var isReachable: Bool = false
    @Published private(set) var mobDeliveryState: MobDeliveryState = .idle
    @Published private(set) var alarmAckDeliveryState: AlarmAckDeliveryState = .idle

    private let session: WCSession?
    private var activeMobRequestId: String? = nil
    private var mobExpiryWorkItem: DispatchWorkItem? = nil
    private var mobUserInfoTransfer: WCSessionUserInfoTransfer? = nil

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
            isReachable = session.isReachable
            applyContext(session.applicationContext)
        }
    }

    /**
     * Ask the phone app to mark MOB. This is not a DSC/Mayday
     * transmission. Reachable delivery waits for the phone's reply;
     * unreachable delivery is reported as queued, never as sent/marked.
     */
    func sendMobTrigger(payload: [String: Any] = [:]) {
        guard let session, session.activationState == .activated else {
            mobDeliveryState = .unavailable
            return
        }
        let requestId = UUID().uuidString.lowercased()
        let requestedAtMs = Date().timeIntervalSince1970 * 1_000
        let expiresAtMs = requestedAtMs + Self.mobRequestTtlMs
        var msg = payload
        msg["type"] = "mob"
        msg["mobRequestVersion"] = Self.mobRequestVersion
        msg["mobRequestId"] = requestId
        msg["mobRequestedAtMs"] = requestedAtMs
        msg["mobRequestTtlMs"] = Self.mobRequestTtlMs
        msg["mobRequestExpiresAtMs"] = expiresAtMs
        activeMobRequestId = requestId
        scheduleMobRequestExpiry(requestId: requestId, expiresAtMs: expiresAtMs)
        if session.isReachable {
            mobDeliveryState = .sending
            session.sendMessage(msg, replyHandler: { [weak self] reply in
                DispatchQueue.main.async {
                    guard let self, self.activeMobRequestId == requestId else { return }
                    let beforeExpiry = Date().timeIntervalSince1970 * 1_000 <= expiresAtMs
                    let matchingReply = (reply["mobRequestId"] as? String)?.lowercased() == requestId
                    if (reply["received"] as? Bool) == true && matchingReply && beforeExpiry {
                        self.mobExpiryWorkItem?.cancel()
                        self.mobExpiryWorkItem = nil
                        self.mobUserInfoTransfer?.cancel()
                        self.mobUserInfoTransfer = nil
                        self.mobDeliveryState = .phoneReceived
                    } else if beforeExpiry {
                        // The radio link answered but the phone bridge did not
                        // accept this exact ID. Preserve the same envelope on
                        // the queued channel; phone-side dedupe makes a late
                        // immediate copy harmless.
                        self.queueMobTrigger(
                            msg,
                            on: session,
                            requestId: requestId,
                            expiresAtMs: expiresAtMs
                        )
                    } else {
                        self.mobDeliveryState = .expired
                    }
                }
            }, errorHandler: { [weak self] err in
                NSLog("WatchSession.sendMobTrigger: \(err.localizedDescription); queueing for later delivery")
                DispatchQueue.main.async {
                    guard self?.activeMobRequestId == requestId else { return }
                    self?.queueMobTrigger(msg, on: session, requestId: requestId, expiresAtMs: expiresAtMs)
                }
            })
        } else {
            queueMobTrigger(msg, on: session, requestId: requestId, expiresAtMs: expiresAtMs)
        }
    }

    private func queueMobTrigger(
        _ message: [String: Any],
        on session: WCSession,
        requestId: String,
        expiresAtMs: Double
    ) {
        guard activeMobRequestId == requestId else { return }
        guard Date().timeIntervalSince1970 * 1_000 <= expiresAtMs else {
            mobDeliveryState = .expired
            return
        }
        guard session.activationState == .activated else {
            mobDeliveryState = .unavailable
            return
        }
        mobUserInfoTransfer?.cancel()
        mobUserInfoTransfer = session.transferUserInfo(message)
        mobDeliveryState = .queued
    }

    private func scheduleMobRequestExpiry(requestId: String, expiresAtMs: Double) {
        mobExpiryWorkItem?.cancel()
        let delaySeconds = max(0, (expiresAtMs - Date().timeIntervalSince1970 * 1_000) / 1_000)
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.activeMobRequestId == requestId else { return }
            if self.mobDeliveryState == .sending || self.mobDeliveryState == .queued {
                self.mobUserInfoTransfer?.cancel()
                self.mobUserInfoTransfer = nil
                self.mobDeliveryState = .expired
            }
        }
        mobExpiryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds, execute: workItem)
    }

    func resetMobDeliveryState() {
        mobExpiryWorkItem?.cancel()
        mobExpiryWorkItem = nil
        mobUserInfoTransfer?.cancel()
        mobUserInfoTransfer = nil
        activeMobRequestId = nil
        mobDeliveryState = .idle
    }

    /**
     * Request phone-side alarm acknowledgement. The Watch can prove only
     * that the reachable phone received the request, not that its audio
     * has stopped, so the UI must keep that distinction visible.
     */
    func sendAlarmAck() {
        guard let session, session.activationState == .activated, session.isReachable else {
            alarmAckDeliveryState = .phoneUnreachable
            return
        }
        alarmAckDeliveryState = .sending
        session.sendMessage(
            ["type": "alarmAck", "watchTimestamp": Date().timeIntervalSince1970],
            replyHandler: { [weak self] reply in
                DispatchQueue.main.async {
                    self?.alarmAckDeliveryState = (reply["received"] as? Bool) == true ? .phoneReceived : .failed
                }
            },
            errorHandler: { [weak self] error in
                NSLog("WatchSession.sendAlarmAck: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self?.alarmAckDeliveryState = .failed
                }
            }
        )
    }

    func resetAlarmAckDeliveryState() {
        alarmAckDeliveryState = .idle
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
