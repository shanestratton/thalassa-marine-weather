import Foundation

/**
 * AnchorSnapshot — Swift mirror of the TS WatchAnchorSnapshot interface
 * (services/native/watchBridge.ts). Decoded from the WCSession
 * application-context dictionary the iOS app pushes.
 *
 * Keep field names in sync with the TS side or the watch silently
 * stops reflecting state changes.
 */
struct AnchorSnapshot: Codable, Equatable {
    enum State: String, Codable {
        case idle
        case setting
        case watching
        case alarm
        case paused
    }

    struct Coord: Codable, Equatable {
        let lat: Double
        let lon: Double
    }

    struct VesselCoord: Codable, Equatable {
        let lat: Double
        let lon: Double
        let accuracy: Double
    }

    let state: State
    let anchor: Coord?
    let vessel: VesselCoord?
    let swingRadius: Double
    let distanceFromAnchor: Double
    let maxDistanceRecorded: Double
    let bearingFromAnchor: Double
    let watchStartedAt: Double?
    let alarmTriggeredAt: Double?

    /// Convenience: how full is the swing circle? 0..1+ where >1 = drag.
    var radiusFraction: Double {
        guard swingRadius > 0 else { return 0 }
        return distanceFromAnchor / swingRadius
    }

    /// Initialise from the dictionary form WatchConnectivity delivers.
    init?(from dict: [String: Any]) {
        guard let stateRaw = dict["state"] as? String,
              let state = State(rawValue: stateRaw) else { return nil }
        self.state = state

        if let a = dict["anchor"] as? [String: Any],
           let lat = a["lat"] as? Double,
           let lon = a["lon"] as? Double {
            self.anchor = Coord(lat: lat, lon: lon)
        } else {
            self.anchor = nil
        }

        if let v = dict["vessel"] as? [String: Any],
           let lat = v["lat"] as? Double,
           let lon = v["lon"] as? Double,
           let acc = v["accuracy"] as? Double {
            self.vessel = VesselCoord(lat: lat, lon: lon, accuracy: acc)
        } else {
            self.vessel = nil
        }

        self.swingRadius = (dict["swingRadius"] as? Double) ?? 0
        self.distanceFromAnchor = (dict["distanceFromAnchor"] as? Double) ?? 0
        self.maxDistanceRecorded = (dict["maxDistanceRecorded"] as? Double) ?? 0
        self.bearingFromAnchor = (dict["bearingFromAnchor"] as? Double) ?? 0
        self.watchStartedAt = dict["watchStartedAt"] as? Double
        self.alarmTriggeredAt = dict["alarmTriggeredAt"] as? Double
    }
}
