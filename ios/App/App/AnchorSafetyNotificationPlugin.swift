import Capacitor
import Foundation
import UserNotifications

/**
 * First-party notification bridge for the Anchor Watch safety fallback.
 *
 * Capacitor LocalNotifications preserves arbitrary `extra` values as userInfo;
 * it does not set the native interruption level. This bridge schedules a fixed,
 * verified set with real `.timeSensitive` content. It never requests or uses
 * Apple's Critical Alert entitlement.
 */
@objc(AnchorSafetyNotificationPlugin)
public final class AnchorSafetyNotificationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnchorSafetyNotificationPlugin"
    public let jsName = "AnchorSafetyNotifications"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkReadiness", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAlarm", returnType: CAPPluginReturnPromise)
    ]

    private struct PluginFailure: Error {
        let code: String
        let message: String
    }

    private struct SettingsSummary {
        let authorizationStatus: String
    }

    private typealias MutatingOperation = (@escaping () -> Void) -> Void

    private let notificationCenter = UNUserNotificationCenter.current()
    private let maximumPendingNotificationCount = 64
    private let alarmRequestCount = 21

    // UNUserNotificationCenter mutation callbacks are asynchronous. A normal
    // serial DispatchQueue would release before they finish, so keep an explicit
    // FIFO and start the next schedule/cancel only after the previous operation
    // has verified its final state. Stale work therefore cannot erase a newer
    // fixed-ID schedule.
    private var mutatingOperations: [MutatingOperation] = []
    private var mutatingOperationActive = false

    private var primaryIdentifier: String {
        "thalassa.anchor-watch.primary"
    }

    private var repeatIdentifiers: [String] {
        (0..<20).map { String(format: "thalassa.anchor-watch.repeat.%02d", $0) }
    }

    private var requestIdentifiers: [String] {
        [primaryIdentifier] + repeatIdentifiers
    }

    private var cleanupIdentifiers: [String] {
        let legacyIdentifiers = ["99001"] + (0..<20).map { String(99100 + $0) }
        return requestIdentifiers + legacyIdentifiers
    }

    @objc func checkReadiness(_ call: CAPPluginCall) {
        let requiredSlots = call.getInt("requiredSlots") ?? alarmRequestCount
        guard (1...maximumPendingNotificationCount).contains(requiredSlots) else {
            call.reject(
                "Anchor Watch requested an invalid notification reserve.",
                "ANCHOR_NOTIFICATION_INVALID_SLOT_COUNT"
            )
            return
        }

        withVerifiedSettings { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let failure):
                self.reject(call, failure)
            case .success(let summary):
                self.notificationCenter.getPendingNotificationRequests { requests in
                    let replaceable = Set(self.cleanupIdentifiers)
                    let nonAnchorCount = requests.filter { !replaceable.contains($0.identifier) }.count
                    let availableSlots = self.maximumPendingNotificationCount - nonAnchorCount
                    guard availableSlots >= requiredSlots else {
                        self.reject(
                            call,
                            PluginFailure(
                                code: "ANCHOR_NOTIFICATION_CAPACITY_EXCEEDED",
                                message: "Anchor Watch needs \(requiredSlots) notification slots, but only \(max(0, availableSlots)) are available. Clear pending notifications and try again."
                            )
                        )
                        return
                    }
                    self.resolve(
                        call,
                        [
                            "ready": true,
                            "authorizationStatus": summary.authorizationStatus,
                            "timeSensitiveEnabled": true,
                            "lockScreenEnabled": true,
                            "availableSlots": availableSlots
                        ]
                    )
                }
            }
        }
    }

    @objc func scheduleAlarm(_ call: CAPPluginCall) {
        guard
            let title = validatedText(call.getString("title"), maximumLength: 180),
            let body = validatedText(call.getString("body"), maximumLength: 1_000)
        else {
            call.reject(
                "Anchor Watch notification title and message are required.",
                "ANCHOR_NOTIFICATION_INVALID_CONTENT"
            )
            return
        }

        enqueueMutatingOperation { [weak self] finish in
            guard let self else {
                finish()
                return
            }
            self.performSchedule(title: title, body: body, call: call, finish: finish)
        }
    }

    @objc func cancelAlarm(_ call: CAPPluginCall) {
        enqueueMutatingOperation { [weak self] finish in
            guard let self else {
                finish()
                return
            }
            self.removeAndConfirmAnchorNotifications { removed in
                guard removed else {
                    self.reject(
                        call,
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_CANCEL_NOT_CONFIRMED",
                            message: "iOS did not confirm removal of every Anchor Watch notification."
                        )
                    )
                    finish()
                    return
                }
                self.resolve(call, ["cancelled": true])
                finish()
            }
        }
    }

    private func performSchedule(
        title: String,
        body: String,
        call: CAPPluginCall,
        finish: @escaping () -> Void
    ) {
        withVerifiedSettings { [weak self] result in
            guard let self else {
                finish()
                return
            }
            switch result {
            case .failure(let failure):
                self.rejectScheduleAfterCleanup(call, failure: failure, finish: finish)
            case .success:
                // Begin every replacement from a confirmed empty fixed-ID set.
                self.removeAndConfirmAnchorNotifications { removed in
                    guard removed else {
                        self.reject(
                            call,
                            PluginFailure(
                                code: "ANCHOR_NOTIFICATION_REPLACEMENT_CLEANUP_FAILED",
                                message: "iOS did not confirm removal of the previous Anchor Watch notification set."
                            )
                        )
                        finish()
                        return
                    }
                    self.addRequestsAfterCapacityCheck(title: title, body: body, call: call, finish: finish)
                }
            }
        }
    }

    private func addRequestsAfterCapacityCheck(
        title: String,
        body: String,
        call: CAPPluginCall,
        finish: @escaping () -> Void
    ) {
        notificationCenter.getPendingNotificationRequests { [weak self] pending in
            guard let self else {
                finish()
                return
            }
            let replaceable = Set(self.cleanupIdentifiers)
            let nonAnchorCount = pending.filter { !replaceable.contains($0.identifier) }.count
            let availableSlots = self.maximumPendingNotificationCount - nonAnchorCount
            guard availableSlots >= self.alarmRequestCount else {
                self.rejectScheduleAfterCleanup(
                    call,
                    failure: PluginFailure(
                        code: "ANCHOR_NOTIFICATION_CAPACITY_EXCEEDED",
                        message: "Anchor Watch needs \(self.alarmRequestCount) notification slots, but only \(max(0, availableSlots)) are available. Clear pending notifications and try again."
                    ),
                    finish: finish
                )
                return
            }

            let requests = self.makeAlarmRequests(title: title, body: body)
            let group = DispatchGroup()
            var addErrors: [Error] = []

            for request in requests {
                group.enter()
                self.notificationCenter.add(request) { error in
                    DispatchQueue.main.async {
                        if let error { addErrors.append(error) }
                        group.leave()
                    }
                }
            }

            group.notify(queue: .main) {
                guard addErrors.isEmpty else {
                    let firstError = addErrors[0]
                    self.rejectScheduleAfterCleanup(
                        call,
                        failure: PluginFailure(
                            code: "ANCHOR_NOTIFICATION_SCHEDULE_FAILED",
                            message: "iOS rejected part of the Anchor Watch notification set. Every Anchor Watch request was removed. \(firstError.localizedDescription)"
                        ),
                        finish: finish
                    )
                    return
                }
                self.verifyExactScheduledSet(call: call, finish: finish)
            }
        }
    }

    private func verifyExactScheduledSet(call: CAPPluginCall, finish: @escaping () -> Void) {
        notificationCenter.getPendingNotificationRequests { [weak self] pending in
            guard let self else {
                finish()
                return
            }
            let expected = Set(self.requestIdentifiers)
            let matching = pending.filter { expected.contains($0.identifier) }
            let exactIdentifiers = matching.count == self.alarmRequestCount && Set(matching.map(\.identifier)) == expected
            let allTimeSensitive: Bool
            if #available(iOS 15.0, *) {
                allTimeSensitive = matching.allSatisfy { $0.content.interruptionLevel == .timeSensitive }
            } else {
                allTimeSensitive = false
            }

            guard exactIdentifiers, allTimeSensitive else {
                self.rejectScheduleAfterCleanup(
                    call,
                    failure: PluginFailure(
                        code: "ANCHOR_NOTIFICATION_SCHEDULE_NOT_CONFIRMED",
                        message: "iOS did not retain the complete 21-request Time Sensitive Anchor Watch set. Every Anchor Watch request was removed."
                    ),
                    finish: finish
                )
                return
            }

            self.resolve(
                call,
                [
                    "scheduled": matching.count,
                    "interruptionLevel": "timeSensitive"
                ]
            )
            finish()
        }
    }

    private func rejectScheduleAfterCleanup(
        _ call: CAPPluginCall,
        failure: PluginFailure,
        finish: @escaping () -> Void
    ) {
        removeAndConfirmAnchorNotifications { [weak self] removed in
            guard let self else {
                finish()
                return
            }
            let finalFailure = removed
                ? failure
                : PluginFailure(
                    code: "ANCHOR_NOTIFICATION_SCHEDULE_CLEANUP_FAILED",
                    message: "\(failure.message) iOS also failed to confirm cleanup; open Notification Center and stop Anchor Watch before retrying."
                )
            self.reject(call, finalFailure)
            finish()
        }
    }

    private func removeAndConfirmAnchorNotifications(
        attemptsRemaining: Int = 2,
        completion: @escaping (Bool) -> Void
    ) {
        notificationCenter.removePendingNotificationRequests(withIdentifiers: cleanupIdentifiers)
        notificationCenter.removeDeliveredNotifications(withIdentifiers: cleanupIdentifiers)
        notificationCenter.getPendingNotificationRequests { [weak self] pending in
            guard let self else {
                completion(false)
                return
            }
            self.notificationCenter.getDeliveredNotifications { delivered in
                let identifiers = Set(self.cleanupIdentifiers)
                let pendingLeft = pending.contains { identifiers.contains($0.identifier) }
                let deliveredLeft = delivered.contains { identifiers.contains($0.request.identifier) }
                guard pendingLeft || deliveredLeft else {
                    completion(true)
                    return
                }
                guard attemptsRemaining > 0 else {
                    completion(false)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    self.removeAndConfirmAnchorNotifications(
                        attemptsRemaining: attemptsRemaining - 1,
                        completion: completion
                    )
                }
            }
        }
    }

    private func enqueueMutatingOperation(_ operation: @escaping MutatingOperation) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.mutatingOperations.append(operation)
            self.startNextMutatingOperationIfNeeded()
        }
    }

    private func startNextMutatingOperationIfNeeded() {
        guard !mutatingOperationActive, !mutatingOperations.isEmpty else { return }
        mutatingOperationActive = true
        let operation = mutatingOperations.removeFirst()
        operation { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.mutatingOperationActive = false
                self.startNextMutatingOperationIfNeeded()
            }
        }
    }

    private func withVerifiedSettings(
        completion: @escaping (Result<SettingsSummary, PluginFailure>) -> Void
    ) {
        notificationCenter.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized:
                break
            case .provisional:
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_PERMISSION_PROVISIONAL",
                            message: "Provisional notification permission is not sufficient for Anchor Watch. Grant full Notifications access in iOS Settings."
                        )
                    )
                )
                return
            case .denied:
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_PERMISSION_DENIED",
                            message: "Locked-screen notifications are denied. Enable Notifications for Thalassa in iOS Settings before dropping anchor."
                        )
                    )
                )
                return
            case .notDetermined:
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_PERMISSION_NOT_DETERMINED",
                            message: "Notification permission has not been granted. Allow Notifications for Thalassa before dropping anchor."
                        )
                    )
                )
                return
            case .ephemeral:
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_PERMISSION_EPHEMERAL",
                            message: "Temporary notification permission is not sufficient for Anchor Watch. Grant full Notifications access in iOS Settings."
                        )
                    )
                )
                return
            @unknown default:
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_PERMISSION_UNKNOWN",
                            message: "iOS returned an unknown notification authorization state. Check Notifications settings before dropping anchor."
                        )
                    )
                )
                return
            }

            guard settings.alertSetting == .enabled else {
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_ALERTS_DISABLED",
                            message: "Notification alerts are disabled for Thalassa. Enable Alerts in iOS Settings before dropping anchor."
                        )
                    )
                )
                return
            }

            guard settings.lockScreenSetting == .enabled else {
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_LOCK_SCREEN_DISABLED",
                            message: "Lock Screen notifications are disabled for Thalassa. Enable Lock Screen Alerts in iOS Settings before dropping anchor."
                        )
                    )
                )
                return
            }

            guard settings.soundSetting == .enabled else {
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_SOUND_DISABLED",
                            message: "Notification sounds are disabled for Thalassa. Enable Sounds in iOS Settings before dropping anchor."
                        )
                    )
                )
                return
            }

            if #available(iOS 15.0, *) {
                guard settings.timeSensitiveSetting == .enabled else {
                    let message = settings.timeSensitiveSetting == .notSupported
                        ? "Time Sensitive Notifications are unavailable in this signed build. Verify the capability and provisioning profile before using Anchor Watch."
                        : "Time Sensitive Notifications are off for Thalassa. Enable them in iOS Settings > Notifications > Thalassa before dropping anchor."
                    completion(
                        .failure(
                            PluginFailure(
                                code: "ANCHOR_NOTIFICATION_TIME_SENSITIVE_DISABLED",
                                message: message
                            )
                        )
                    )
                    return
                }
            } else {
                completion(
                    .failure(
                        PluginFailure(
                            code: "ANCHOR_NOTIFICATION_TIME_SENSITIVE_UNAVAILABLE",
                            message: "This iOS version does not support Time Sensitive Notifications required by Anchor Watch."
                        )
                    )
                )
                return
            }

            completion(.success(SettingsSummary(authorizationStatus: "authorized")))
        }
    }

    private func makeAlarmRequests(title: String, body: String) -> [UNNotificationRequest] {
        requestIdentifiers.enumerated().map { index, identifier in
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.threadIdentifier = "thalassa.anchor-watch"
            content.userInfo = ["kind": "anchor-drag", "source": "anchor-watch"]
            if #available(iOS 15.0, *) {
                content.interruptionLevel = .timeSensitive
            }

            // Audio and haptics fire immediately in the foreground alarm path.
            // Give the primary notification enough lead time for all 21 adds
            // and the mandatory pending-request readback to finish before iOS
            // can deliver/remove it from that pending set.
            let interval = index == 0 ? 5.0 : Double(index * 30)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
            return UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        }
    }

    private func validatedText(_ text: String?, maximumLength: Int) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maximumLength else { return nil }
        return trimmed
    }

    private func resolve(_ call: CAPPluginCall, _ data: PluginCallResultData) {
        DispatchQueue.main.async {
            call.resolve(data)
        }
    }

    private func reject(_ call: CAPPluginCall, _ failure: PluginFailure) {
        DispatchQueue.main.async {
            call.reject(failure.message, failure.code)
        }
    }
}
