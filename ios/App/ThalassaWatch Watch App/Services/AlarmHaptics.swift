import Foundation
import WatchKit

/**
 * AlarmHaptics — taptic patterns for the watch alarm.
 *
 * watchOS WKHaptic types ranked by how attention-grabbing they are:
 *   .notification — short ding-dong
 *   .directionUp / .directionDown — one strong tap
 *   .success / .failure — short pattern
 *   .retry — long buzz
 *
 * For drag alarm we want something that wakes the user, so we
 * fire .notification + .failure on a 1.5s cadence. Apple won't let
 * us play arbitrary audio in the background, but the haptic engine
 * works regardless of mute state.
 */
enum AlarmHaptics {

    /** Single sharp tap — used for "anchor set" confirmation. */
    static func confirm() {
        WKInterfaceDevice.current().play(.success)
    }

    /** Strong attention tap — used when alarm first triggers. */
    static func alarmStart() {
        WKInterfaceDevice.current().play(.failure)
    }

    /** Periodic ping while the alarm is active. Schedule on a Timer. */
    static func alarmPing() {
        WKInterfaceDevice.current().play(.notification)
    }
}
