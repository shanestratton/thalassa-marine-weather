import SwiftUI

/**
 * CockpitGlanceView — age-gated phone snapshot for wind / heading / SOG.
 *
 * WatchConnectivity application context is durable, so a value can remain
 * present long after the phone stops updating. This view refreshes its age
 * clock and completely hides numeric instruments after two minutes; an old
 * heading or SOG is never presented as live navigation data.
 */
struct CockpitGlanceView: View {

    @EnvironmentObject var session: WatchSession

    private let staleAfter: TimeInterval = 120

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { timeline in
            VStack(spacing: 5) {
                if let snapshot = session.weather {
                    let age = snapshotAge(snapshot, now: timeline.date)
                    if age <= staleAfter {
                        liveSnapshot(snapshot, age: age)
                    } else {
                        staleDataView(age: age)
                    }
                } else {
                    noDataView
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
    }

    // MARK: - Fresh snapshot

    @ViewBuilder
    private func liveSnapshot(_ snapshot: WeatherSnapshot, age: TimeInterval) -> some View {
        if !session.isReachable {
            statusBanner("PHONE LIVE LINK OFFLINE", color: .orange)
        }
        windRow(w: snapshot)
        Divider().background(Color.gray.opacity(0.3))
        sailRow(w: snapshot)
        Spacer(minLength: 0)
        HStack(spacing: 4) {
            Circle()
                .fill(session.isReachable ? Color.green : Color.orange)
                .frame(width: 5, height: 5)
            Text("Phone snapshot · \(ageLabel(age))")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(session.isReachable ? .secondary : .orange)
        }
    }

    private func windRow(w: WeatherSnapshot) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 0) {
                Text("\(Int(w.windKts))")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundColor(windColor(w.windKts))
                Text("kt wind")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                if let gust = w.gustKts, gust > w.windKts + 1 {
                    Text("gust \(Int(gust))")
                        .font(.caption2)
                        .foregroundColor(.orange)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text("\(Int(w.windDirDeg))°")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Text(cardinal(from: w.windDirDeg))
                    .font(.caption.bold())
                    .foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder
    private func sailRow(w: WeatherSnapshot) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("HDG")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                if let hdg = w.headingDeg {
                    Text("\(Int(hdg))°")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                } else {
                    unavailableInstrument
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("SOG")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                if let sog = w.sogKts {
                    Text(String(format: "%.1f kt", sog))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                } else {
                    unavailableInstrument
                }
            }
        }
    }

    private var unavailableInstrument: some View {
        Text("--")
            .font(.system(size: 18, weight: .semibold, design: .rounded))
            .foregroundColor(.gray)
    }

    // MARK: - Fail-closed states

    private func staleDataView(age: TimeInterval) -> some View {
        VStack(spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundColor(.orange)
            Text("COCKPIT DATA STALE")
                .font(.caption.bold())
                .foregroundColor(.orange)
            Text("Old wind, HDG and SOG hidden")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundColor(.white)
            Text("Last phone update \(ageLabel(age))")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.orange)
            if !session.isReachable {
                statusBanner("PHONE LIVE LINK OFFLINE", color: .red)
            } else {
                Text("Open Thalassa on phone to refresh")
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
            }
        }
    }

    private var noDataView: some View {
        VStack(spacing: 8) {
            Image(systemName: "wind")
                .font(.system(size: 28))
                .foregroundColor(.gray)
            Text("NO LIVE COCKPIT DATA")
                .font(.caption.bold())
                .foregroundColor(.orange)
            Text("Open Thalassa on phone")
                .font(.caption2)
                .foregroundColor(.gray)
            if !session.isReachable {
                statusBanner("PHONE LIVE LINK OFFLINE", color: .red)
            }
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

    // MARK: - Helpers

    private func snapshotAge(_ snapshot: WeatherSnapshot, now: Date) -> TimeInterval {
        let age = now.timeIntervalSince1970 - snapshot.generatedAt / 1000
        // A substantially future timestamp is invalid rather than "fresh".
        return age < -30 ? .greatestFiniteMagnitude : max(0, age)
    }

    private func ageLabel(_ age: TimeInterval) -> String {
        guard age.isFinite else { return "unknown" }
        if age < 60 { return "\(Int(age))s ago" }
        return "\(Int(age / 60))m ago"
    }

    private func windColor(_ kts: Double) -> Color {
        switch kts {
        case ..<10: return .green
        case ..<17: return .yellow
        case ..<22: return .orange
        case ..<28: return .red
        default: return .purple
        }
    }

    private func cardinal(from deg: Double) -> String {
        let dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        let idx = Int((deg / 45.0).rounded()) % 8
        return dirs[(idx + 8) % 8]
    }
}
