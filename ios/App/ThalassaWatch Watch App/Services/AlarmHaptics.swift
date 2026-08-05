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
 * While the Anchor screen is visible, a local distance warning uses
 * .notification + .failure on a 1.5s cadence. No background execution
 * is implied; the view stops its timer when it disappears.
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
