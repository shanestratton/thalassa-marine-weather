import SwiftUI

/**
 * MobButton — long-press MOB trigger.
 *
 * Two-stage activation deliberate to prevent accidents:
 *   1. Long-press for 1.5 seconds while a countdown ring fills
 *   2. On full fill, fires sendMobTrigger() and shows confirmation
 *
 * The phone-side MobService receives the trigger via the
 * 'mobTriggered' Capacitor event (wired in App.tsx) and runs the
 * existing MOB workflow (radio DSC, SOS, position log).
 */
struct MobButton: View {

    @EnvironmentObject var session: WatchSession

    private let HOLD_SECONDS = 1.5

    @State private var pressProgress: Double = 0
    @State private var pressTimer: Timer? = nil
    @State private var fired = false

    var body: some View {
        VStack(spacing: 8) {
            Text("MAN OVERBOARD")
                .font(.caption.bold())
                .foregroundColor(.red)
                .tracking(0.5)

            ZStack {
                // Outer ring fills as the user holds. At 100% the
                // alarm fires.
                Circle()
                    .stroke(Color.red.opacity(0.3), lineWidth: 4)
                    .frame(width: 110, height: 110)
                Circle()
                    .trim(from: 0, to: pressProgress)
                    .stroke(Color.red, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 110, height: 110)
                    .animation(.linear(duration: 0.05), value: pressProgress)

                if fired {
                    VStack(spacing: 2) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.green)
                        Text("SENT")
                            .font(.caption.bold())
                            .foregroundColor(.green)
                    }
                } else {
                    VStack(spacing: 2) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(.red)
                        Text("HOLD")
                            .font(.caption2)
                            .foregroundColor(.red.opacity(0.8))
                    }
                }
            }
            .gesture(
                LongPressGesture(minimumDuration: HOLD_SECONDS)
                    .onChanged { _ in
                        if !fired { startProgress() }
                    }
                    .onEnded { _ in
                        fire()
                    }
            )
            .simultaneousGesture(
                // Cancel handler — released early
                DragGesture(minimumDistance: 0)
                    .onEnded { _ in
                        if !fired { cancelProgress() }
                    }
            )

            Text("Hold to send mayday")
                .font(.system(size: 9))
                .foregroundColor(.gray)
        }
        .padding(.horizontal, 8)
    }

    // MARK: - Long-press driver

    private func startProgress() {
        guard pressTimer == nil else { return }
        pressProgress = 0
        let tick = 0.05
        pressTimer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { _ in
            pressProgress += tick / HOLD_SECONDS
            if pressProgress >= 1.0 {
                pressProgress = 1.0
                pressTimer?.invalidate()
                pressTimer = nil
                fire()
            }
        }
    }

    private func cancelProgress() {
        pressTimer?.invalidate()
        pressTimer = nil
        withAnimation { pressProgress = 0 }
    }

    private func fire() {
        guard !fired else { return }
        fired = true
        session.sendMobTrigger()
        AlarmHaptics.alarmStart()
        // Reset after 5s so user can re-trigger if first attempt didn't
        // make it through (phone out of range, etc.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            fired = false
            pressProgress = 0
        }
    }
}
