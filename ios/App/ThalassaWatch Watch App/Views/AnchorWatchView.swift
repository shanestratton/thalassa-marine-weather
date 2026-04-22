import SwiftUI

/**
 * AnchorWatchView — the headline screen.
 *
 * Visual: a full-bleed circular ring representing the swing radius.
 * The vessel-position dot orbits inside it. When the dot crosses the
 * ring, the ring goes red, the haptic engine fires every 1.5s, and
 * a "DRAGGING" banner appears. Tap dismisses the haptic but leaves
 * the alarm state until the phone clears it.
 *
 * Three states map to three visuals:
 *   - .idle / .setting / .paused → "No anchor" with a hint
 *   - .watching → green ring, vessel dot inside, distance + max
 *   - .alarm → red ring, vessel dot outside, "DRAGGING" + dismiss btn
 */
struct AnchorWatchView: View {

    @EnvironmentObject var session: WatchSession
    @EnvironmentObject var location: LocationManager

    /// Periodic haptic firer while the alarm is active.
    @State private var hapticTimer: Timer? = nil

    var body: some View {
        ZStack {
            backgroundForState

            if let snap = session.anchor, snap.state == .watching || snap.state == .alarm {
                liveRingView(snap: snap)
            } else {
                idleHintView
            }
        }
        .onAppear {
            location.start()
        }
        .onDisappear {
            location.stop()
            stopHapticPulse()
        }
        .onChange(of: session.anchor?.state) { _, newState in
            if newState == .alarm {
                startHapticPulse()
            } else {
                stopHapticPulse()
            }
        }
    }

    // MARK: - Subviews

    private var backgroundForState: some View {
        let isAlarm = session.anchor?.state == .alarm
        return (isAlarm ? Color.red.opacity(0.18) : Color.black)
            .ignoresSafeArea()
    }

    private var idleHintView: some View {
        VStack(spacing: 6) {
            Image(systemName: "anchor")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(.gray)
            Text("No Anchor Set")
                .font(.headline)
                .foregroundColor(.gray)
            Text("Drop anchor from the\nphone to enable.")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundColor(.gray.opacity(0.7))
        }
    }

    @ViewBuilder
    private func liveRingView(snap: AnchorSnapshot) -> some View {
        let isAlarm = snap.state == .alarm
        let ringColor: Color = isAlarm ? .red : .green
        let fillFraction = min(snap.radiusFraction, 1.5)

        VStack(spacing: 4) {
            if isAlarm {
                Text("DRAGGING")
                    .font(.caption.bold())
                    .foregroundColor(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.red.opacity(0.18))
                    .cornerRadius(4)
            }

            ZStack {
                // The swing-circle ring
                Circle()
                    .stroke(ringColor.opacity(0.35), lineWidth: 2)
                    .frame(width: 110, height: 110)

                // Distance dial: a thicker arc that fills the ring as
                // the boat moves outwards. Past 100% it overshoots
                // visually so dragging is unmistakable.
                Circle()
                    .trim(from: 0, to: min(fillFraction, 1.0))
                    .stroke(ringColor, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 110, height: 110)
                    .animation(.easeInOut(duration: 0.4), value: fillFraction)

                // Centre numbers: distance + swing radius
                VStack(spacing: 2) {
                    Text("\(Int(snap.distanceFromAnchor))")
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundColor(ringColor)
                    Text("/ \(Int(snap.swingRadius))m")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            .frame(width: 110, height: 110)

            // Max drift recorded since watch start — small caption
            // below the ring so the user can tell at a glance whether
            // they've EVER hit the limit, not just where they are now.
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.right.circle.fill")
                    .font(.caption2)
                    .foregroundColor(.orange)
                Text("Max \(Int(snap.maxDistanceRecorded))m")
                    .font(.caption2)
                    .foregroundColor(.orange)
            }

            if isAlarm {
                Button(action: {
                    session.sendAlarmAck()
                    AlarmHaptics.confirm()
                }) {
                    Text("Silence")
                        .font(.caption.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(Color.red)
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
    }

    // MARK: - Haptic pulse loop

    private func startHapticPulse() {
        stopHapticPulse()
        AlarmHaptics.alarmStart()
        hapticTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
            AlarmHaptics.alarmPing()
        }
    }

    private func stopHapticPulse() {
        hapticTimer?.invalidate()
        hapticTimer = nil
    }
}
