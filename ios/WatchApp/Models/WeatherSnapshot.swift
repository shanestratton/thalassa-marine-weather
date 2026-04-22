import Foundation

/**
 * WeatherSnapshot — Swift mirror of the TS WatchWeatherSnapshot
 * interface (services/native/watchBridge.ts). Used by the
 * cockpit-glance view.
 */
struct WeatherSnapshot: Codable, Equatable {
    let windKts: Double
    let windDirDeg: Double
    let gustKts: Double?
    let headingDeg: Double?
    let sogKts: Double?
    let pressureHpa: Double?
    let generatedAt: Double

    init?(from dict: [String: Any]) {
        guard let wind = dict["windKts"] as? Double,
              let dir = dict["windDirDeg"] as? Double,
              let ts = dict["generatedAt"] as? Double else { return nil }
        self.windKts = wind
        self.windDirDeg = dir
        self.gustKts = dict["gustKts"] as? Double
        self.headingDeg = dict["headingDeg"] as? Double
        self.sogKts = dict["sogKts"] as? Double
        self.pressureHpa = dict["pressureHpa"] as? Double
        self.generatedAt = ts
    }

    /// Beaufort-ish band for tinting the wind number.
    var windBand: String {
        switch windKts {
        case ..<5: return "calm"
        case ..<11: return "light"
        case ..<17: return "moderate"
        case ..<22: return "fresh"
        case ..<28: return "strong"
        case ..<34: return "near-gale"
        default: return "gale-plus"
        }
    }
}
