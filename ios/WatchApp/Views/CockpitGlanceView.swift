import SwiftUI

/**
 * CockpitGlanceView — quick-read wind / heading / SOG screen.
 *
 * The "I'm trimming sail and want to see the gust without pulling out
 * my phone" view. Big numbers, minimal chrome, one-glance read.
 *
 * Layout:
 *   ┌─────────────────────────┐
 *   │     12 kt    045°       │   wind speed     wind dir
 *   │   gust 18    NE         │
 *   │                         │
 *   │   HDG 270°    SOG 6.4   │   heading        speed-over-ground
 *   └─────────────────────────┘
 */
struct CockpitGlanceView: View {

    @EnvironmentObject var session: WatchSession

    var body: some View {
        VStack(spacing: 8) {
            if let w = session.weather {
                windRow(w: w)
                Divider().background(Color.gray.opacity(0.3))
                sailRow(w: w)
                Spacer()
                ageFooter(generatedAt: w.generatedAt)
            } else {
                noDataView
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: - Subviews

    private func windRow(w: WeatherSnapshot) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 0) {
                Text("\(Int(w.windKts))")
                    .font(.system(size: 36, weight: .bold, design: .rounded))
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
                    Text("--")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .foregroundColor(.gray)
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
                    Text("--")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .foregroundColor(.gray)
                }
            }
        }
    }

    private var noDataView: some View {
        VStack(spacing: 8) {
            Image(systemName: "wind")
                .font(.system(size: 28))
                .foregroundColor(.gray)
            Text("Waiting for\nweather sync…")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundColor(.gray)
            if !session.isReachable {
                Text("Phone unreachable")
                    .font(.caption2)
                    .foregroundColor(.orange)
            }
        }
    }

    private func ageFooter(generatedAt: Double) -> some View {
        let age = Int((Date().timeIntervalSince1970 * 1000 - generatedAt) / 60_000)
        let label = age <= 1 ? "now" : "\(age) min ago"
        return Text(label)
            .font(.system(size: 9))
            .foregroundColor(.gray)
    }

    // MARK: - Helpers

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
