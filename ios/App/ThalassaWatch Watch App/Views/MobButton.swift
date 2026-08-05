import SwiftUI

/**
 * MobButton — deliberate request to mark MOB in the paired phone app.
 *
 * This control does not transmit DSC or a voice Mayday. Immediate delivery
 * is acknowledged by the phone; an unreachable-phone transfer is queued only
 * for a short safety window and then becomes visibly EXPIRED.
 */
struct MobButton: View {

    @EnvironmentObject var session: WatchSession

    private let holdSeconds = 1.5

    @State private var pressProgress: Double = 0
    @State private var pressTimer: Timer? = nil
    @State private var hasTriggered = false

    var body: some View {
        VStack(spacing: 6) {
            Text("MAN OVERBOARD")
                .font(.caption.bold())
                .foregroundColor(.red)
                .tracking(0.5)

            ZStack {
                Circle()
                    .stroke(statusColor.opacity(0.3), lineWidth: 4)
                    .frame(width: 106, height: 106)
                Circle()
                    .trim(from: 0, to: statusProgress)
                    .stroke(statusColor, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 106, height: 106)
                    .animation(.linear(duration: 0.05), value: statusProgress)

                statusContent
            }
            .contentShape(Circle())
            .gesture(
                LongPressGesture(minimumDuration: holdSeconds)
                    .onChanged { _ in
                        if canTrigger { startProgress() }
                    }
                    .onEnded { _ in
                        if canTrigger { fire() }
                    }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onEnded { _ in
                        if canTrigger { cancelProgress() }
                    }
            )

            Text(statusDetail)
                .font(.system(size: 9, weight: .medium))
                .multilineTextAlignment(.center)
                .foregroundColor(detailColor)
                .lineLimit(2)

            Text("DISTRESS: use VHF/DSC or chartplotter now")
                .font(.system(size: 8, weight: .bold))
                .multilineTextAlignment(.center)
                .foregroundColor(.red)

            if session.mobDeliveryState == .failed || session.mobDeliveryState == .unavailable || session.mobDeliveryState == .expired {
                Button("Try again") {
                    session.resetMobDeliveryState()
                    hasTriggered = false
                    pressProgress = 0
                }
                .font(.caption2.bold())
                .buttonStyle(.bordered)
                .tint(.orange)
            }
        }
        .padding(.horizontal, 8)
        .onDisappear {
            pressTimer?.invalidate()
            pressTimer = nil
        }
    }

    // MARK: - Honest delivery state

    private var canTrigger: Bool {
        !hasTriggered && session.mobDeliveryState == .idle
    }

    private var statusProgress: Double {
        switch session.mobDeliveryState {
        case .phoneReceived, .queued:
            return 1
        default:
            return pressProgress
        }
    }

    private var statusColor: Color {
        switch session.mobDeliveryState {
        case .phoneReceived:
            return .green
        case .sending:
            return .yellow
        case .queued:
            return .orange
        case .expired, .unavailable, .failed:
            return .red
        case .idle:
            return .red
        }
    }

    private var detailColor: Color {
        switch session.mobDeliveryState {
        case .phoneReceived:
            return .green
        case .queued, .sending:
            return .orange
        case .expired, .unavailable, .failed:
            return .red
        case .idle:
            return .gray
        }
    }

    private var statusDetail: String {
        switch session.mobDeliveryState {
        case .idle:
            return "Hold to mark MOB on phone"
        case .sending:
            return "Waiting for phone acknowledgement"
        case .phoneReceived:
            return "Phone received request — confirm marker there"
        case .queued:
            return "Phone unreachable — queued briefly, not a marker or distress"
        case .expired:
            return "Request expired — use phone MOB or chartplotter now"
        case .unavailable:
            return "Phone link unavailable — MOB request not delivered"
        case .failed:
            return "Phone delivery failed — MOB request not confirmed"
        }
    }

    @ViewBuilder
    private var statusContent: some View {
        switch session.mobDeliveryState {
        case .idle:
            VStack(spacing: 2) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 30))
                    .foregroundColor(.red)
                Text("HOLD")
                    .font(.caption2.bold())
                    .foregroundColor(.red.opacity(0.85))
            }
        case .sending:
            VStack(spacing: 4) {
                ProgressView()
                    .tint(.yellow)
                Text("CONTACTING")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(.yellow)
            }
        case .phoneReceived:
            VStack(spacing: 2) {
                Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                    .font(.system(size: 25))
                    .foregroundColor(.green)
                Text("PHONE RECEIVED")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(.green)
            }
        case .queued:
            VStack(spacing: 2) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 27))
                    .foregroundColor(.orange)
                Text("QUEUED")
                    .font(.caption2.bold())
                    .foregroundColor(.orange)
            }
        case .expired:
            VStack(spacing: 2) {
                Image(systemName: "clock.badge.exclamationmark.fill")
                    .font(.system(size: 28))
                    .foregroundColor(.red)
                Text("EXPIRED")
                    .font(.caption2.bold())
                    .foregroundColor(.red)
            }
        case .unavailable, .failed:
            VStack(spacing: 2) {
                Image(systemName: "xmark.octagon.fill")
                    .font(.system(size: 27))
                    .foregroundColor(.red)
                Text("NOT DELIVERED")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(.red)
            }
        }
    }

    // MARK: - Long-press driver

    private func startProgress() {
        guard pressTimer == nil else { return }
        pressProgress = 0
        let tick = 0.05
        pressTimer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { _ in
            pressProgress += tick / holdSeconds
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
        guard canTrigger else { return }
        hasTriggered = true
        pressTimer?.invalidate()
        pressTimer = nil
        pressProgress = 1
        session.sendMobTrigger()
        AlarmHaptics.alarmStart()
    }
}
