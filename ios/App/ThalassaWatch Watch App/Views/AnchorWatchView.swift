import SwiftUI
import Combine
import CoreLocation

/**
 * AnchorWatchView — honest phone companion with a foreground local-GPS check.
 *
 * The phone remains the durable Anchor Watch. While this tab is visible, a
 * recent watch-local location can independently calculate distance and fire
 * local haptics. No workout/extended-runtime session is used, so this screen
 * never claims standalone or overnight background monitoring.
 */
struct AnchorWatchView: View {

    @EnvironmentObject var session: WatchSession
    @EnvironmentObject var location: LocationManager

    @State private var now = Date()
    @State private var hapticTimer: Timer? = nil
    @State private var localHapticsSilenced = false

    private let freshnessTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private let snapshotFreshFor: TimeInterval = 60

    var body: some View {
        ZStack {
            backgroundColor(at: now)
                .ignoresSafeArea()

            content(at: now)
        }
        .onAppear {
            now = Date()
            location.start()
            syncHapticState(at: now)
        }
        .onDisappear {
            location.stop()
            stopHapticPulse()
        }
        .onReceive(freshnessTimer) { tick in
            now = tick
            syncHapticState(at: tick)
        }
        .onChange(of: session.anchor) { _, _ in
            syncHapticState(at: Date())
        }
        .onChange(of: location.location?.timestamp) { _, _ in
            syncHapticState(at: Date())
        }
    }

    // MARK: - State routing

    @ViewBuilder
    private func content(at date: Date) -> some View {
        if let snapshot = session.anchor {
            if isActive(snapshot), snapshot.anchor != nil {
                let localDistance = foregroundDistance(for: snapshot, at: date)
                if isSnapshotFresh(snapshot, at: date) || localDistance != nil {
                    liveRingView(snapshot: snapshot, localDistance: localDistance, at: date)
                } else {
                    unverifiedActiveView(snapshot: snapshot, at: date)
                }
            } else if isSnapshotFresh(snapshot, at: date) {
                idleHintView(snapshot: snapshot)
            } else {
                staleStatusView(snapshot: snapshot, at: date)
            }
        } else {
            waitingForPhoneView
        }
    }

    private func backgroundColor(at date: Date) -> Color {
        guard let snapshot = session.anchor else { return .black }
        if alarmCondition(snapshot: snapshot, at: date) { return Color.red.opacity(0.18) }
        if !isSnapshotFresh(snapshot, at: date) || !session.isReachable { return Color.orange.opacity(0.10) }
        return .black
    }

    private var waitingForPhoneView: some View {
        VStack(spacing: 7) {
            Image(systemName: "iphone.slash")
                .font(.system(size: 27))
                .foregroundColor(.orange)
            Text("NO VERIFIED ANCHOR STATE")
                .font(.caption.bold())
                .multilineTextAlignment(.center)
                .foregroundColor(.orange)
            Text("Open Thalassa on phone")
                .font(.caption2)
                .foregroundColor(.secondary)
            if !session.isReachable {
                statusBanner("PHONE LIVE LINK OFFLINE", color: .red)
            }
        }
    }

    private func idleHintView(snapshot: AnchorSnapshot) -> some View {
        VStack(spacing: 7) {
            Image(systemName: "anchor")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(.gray)
            Text(idleTitle(for: snapshot.state))
                .font(.headline)
                .multilineTextAlignment(.center)
                .foregroundColor(.gray)
            Text("Use the phone to arm Anchor Watch")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundColor(.gray.opacity(0.8))
            if !session.isReachable {
                statusBanner("PHONE LIVE LINK OFFLINE", color: .orange)
            }
        }
    }

    private func staleStatusView(snapshot: AnchorSnapshot, at date: Date) -> some View {
        VStack(spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundColor(.orange)
            Text("ANCHOR STATUS STALE")
                .font(.caption.bold())
                .foregroundColor(.orange)
            Text("Cached phone state is \(ageLabel(snapshotAge(snapshot, at: date)))")
                .font(.caption2)
                .multilineTextAlignment(.center)
            Text("Do not assume monitoring is active")
                .font(.caption2.bold())
                .multilineTextAlignment(.center)
                .foregroundColor(.red)
            statusBanner("CHECK PHONE NOW", color: .red)
        }
    }

    private func unverifiedActiveView(snapshot: AnchorSnapshot, at date: Date) -> some View {
        VStack(spacing: 7) {
            Image(systemName: "location.slash.fill")
                .font(.system(size: 27))
                .foregroundColor(.red)
            Text("ANCHOR CHECK UNVERIFIED")
                .font(.caption.bold())
                .foregroundColor(.red)
            Text("Phone state \(ageLabel(snapshotAge(snapshot, at: date)))")
                .font(.caption2)
                .foregroundColor(.orange)
            Text(localGpsProblem)
                .font(.caption2)
                .multilineTextAlignment(.center)
            Text("Check phone and vessel position now")
                .font(.caption2.bold())
                .multilineTextAlignment(.center)
                .foregroundColor(.red)
        }
    }

    // MARK: - Active ring

    private func liveRingView(snapshot: AnchorSnapshot, localDistance: Double?, at date: Date) -> some View {
        let phoneFresh = isSnapshotFresh(snapshot, at: date)
        let shownDistance = localDistance ?? snapshot.distanceFromAnchor
        let localAlarm = localDistance.map { snapshot.swingRadius > 0 && $0 >= snapshot.swingRadius } ?? false
        let phoneAlarm = phoneFresh && snapshot.state == .alarm
        let isAlarm = localAlarm || phoneAlarm
        let ringColor: Color = isAlarm ? .red : (phoneFresh && session.isReachable ? .green : .orange)
        let fillFraction = snapshot.swingRadius > 0 ? min(shownDistance / snapshot.swingRadius, 1.0) : 0

        return ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 4) {
                if isAlarm {
                    Text(localAlarm ? "LOCAL DISTANCE WARNING" : "PHONE DRAG ALARM")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(.red)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.red.opacity(0.18))
                        .clipShape(Capsule())
                }

                sourceBanner(phoneFresh: phoneFresh, hasLocalDistance: localDistance != nil)

                ZStack {
                    Circle()
                        .stroke(ringColor.opacity(0.35), lineWidth: 2)
                        .frame(width: 98, height: 98)
                    Circle()
                        .trim(from: 0, to: fillFraction)
                        .stroke(ringColor, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 98, height: 98)
                        .animation(.easeInOut(duration: 0.4), value: fillFraction)

                    VStack(spacing: 1) {
                        Text("\(Int(shownDistance))")
                            .font(.system(size: 29, weight: .bold, design: .rounded))
                            .foregroundColor(ringColor)
                        Text("/ \(Int(snapshot.swingRadius))m")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text(localDistance == nil ? "PHONE" : "WATCH GPS")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundColor(ringColor)
                    }
                }
                .frame(width: 98, height: 98)

                HStack(spacing: 7) {
                    Text("Max \(Int(max(snapshot.maxDistanceRecorded, shownDistance)))m")
                    if let fix = location.freshLocation(at: date) {
                        Text("±\(Int(fix.horizontalAccuracy))m")
                    }
                }
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.orange)

                Text("Foreground companion only · keep phone armed")
                    .font(.system(size: 8, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .foregroundColor(.secondary)

                if isAlarm {
                    alarmControls
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func sourceBanner(phoneFresh: Bool, hasLocalDistance: Bool) -> some View {
        if !phoneFresh {
            statusBanner("CACHED ANCHOR · LOCAL GPS ONLY", color: .orange)
        } else if !session.isReachable {
            statusBanner("PHONE LIVE LINK OFFLINE", color: .orange)
        } else if hasLocalDistance {
            statusBanner("FOREGROUND WATCH GPS", color: .green)
        } else {
            statusBanner("PHONE DATA · WATCH GPS WAITING", color: .orange)
        }
    }

    private var alarmControls: some View {
        VStack(spacing: 3) {
            Button(action: silenceWatch) {
                Text("Silence Watch")
                    .font(.caption.bold())
                    .foregroundColor(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(Color.red)
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)

            Text(alarmAckStatus)
                .font(.system(size: 8, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundColor(alarmAckColor)
        }
        .padding(.top, 2)
    }

    private var alarmAckStatus: String {
        switch session.alarmAckDeliveryState {
        case .idle:
            return "Silences this Watch only; phone alarm is separate"
        case .sending:
            return "Watch quiet · contacting phone…"
        case .phoneReceived:
            return "Watch quiet · phone received request; confirm there"
        case .phoneUnreachable, .failed:
            return "Watch quiet · phone alarm may continue"
        }
    }

    private var alarmAckColor: Color {
        switch session.alarmAckDeliveryState {
        case .phoneReceived:
            return .green
        case .phoneUnreachable, .failed:
            return .red
        case .sending:
            return .orange
        case .idle:
            return .secondary
        }
    }

    private func silenceWatch() {
        localHapticsSilenced = true
        stopHapticPulse()
        AlarmHaptics.confirm()
        session.sendAlarmAck()
    }

    // MARK: - Freshness and local distance

    private func isActive(_ snapshot: AnchorSnapshot) -> Bool {
        snapshot.state == .watching || snapshot.state == .alarm
    }

    private func snapshotAge(_ snapshot: AnchorSnapshot, at date: Date) -> TimeInterval {
        date.timeIntervalSince1970 - snapshot.generatedAt / 1000
    }

    private func isSnapshotFresh(_ snapshot: AnchorSnapshot, at date: Date) -> Bool {
        let age = snapshotAge(snapshot, at: date)
        return snapshot.generatedAt > 0 && age >= -30 && age <= snapshotFreshFor
    }

    private func foregroundDistance(for snapshot: AnchorSnapshot, at date: Date) -> Double? {
        guard let anchor = snapshot.anchor else { return nil }
        return location.freshDistance(toLat: anchor.lat, lon: anchor.lon, at: date)
    }

    private func alarmCondition(snapshot: AnchorSnapshot, at date: Date) -> Bool {
        guard isActive(snapshot), snapshot.anchor != nil else { return false }
        let localAlarm = foregroundDistance(for: snapshot, at: date)
            .map { snapshot.swingRadius > 0 && $0 >= snapshot.swingRadius } ?? false
        let freshPhoneAlarm = isSnapshotFresh(snapshot, at: date) && snapshot.state == .alarm
        return localAlarm || freshPhoneAlarm
    }

    private var localGpsProblem: String {
        if location.authorisation == .denied || location.authorisation == .restricted {
            return "Watch Location permission unavailable"
        }
        if let lastError = location.lastError {
            return "Watch GPS error: \(lastError)"
        }
        return "No fresh, accurate Watch GPS fix"
    }

    private func ageLabel(_ age: TimeInterval) -> String {
        guard age.isFinite, age >= 0 else { return "timestamp invalid" }
        if age < 60 { return "\(Int(age))s old" }
        return "\(Int(age / 60))m old"
    }

    private func idleTitle(for state: AnchorSnapshot.State) -> String {
        switch state {
        case .idle: return "No Anchor Set"
        case .setting: return "Setting on Phone"
        case .paused: return "Anchor Watch Paused"
        case .watching, .alarm: return "Anchor Status Unavailable"
        }
    }

    private func statusBanner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 8, weight: .bold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.16))
            .clipShape(Capsule())
    }

    // MARK: - Foreground Watch haptics

    private func syncHapticState(at date: Date) {
        guard let snapshot = session.anchor, alarmCondition(snapshot: snapshot, at: date) else {
            stopHapticPulse()
            if localHapticsSilenced {
                localHapticsSilenced = false
            }
            if session.alarmAckDeliveryState != .idle {
                session.resetAlarmAckDeliveryState()
            }
            return
        }

        if !localHapticsSilenced && hapticTimer == nil {
            startHapticPulse()
        }
    }

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
