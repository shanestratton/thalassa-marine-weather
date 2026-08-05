import Foundation
import Combine
import CoreLocation

/**
 * LocationManager — wraps CoreLocation for a watch-local, foreground
 * position check while the Anchor tab is visible.
 *
 * On Apple Watch Ultra and Series 9+, this uses the watch's built-in
 * GPS. On older models it falls back to the paired phone's GPS via
 * Apple's transparent location forwarding. This class does not start
 * a workout or extended runtime session, so it must never be described
 * as independent overnight/background anchor monitoring.
 */
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {

    @Published private(set) var location: CLLocation? = nil
    @Published private(set) var authorisation: CLAuthorizationStatus = .notDetermined
    @Published private(set) var lastError: String? = nil

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5  // metres — plenty for drag detection
        authorisation = manager.authorizationStatus
    }

    /**
     * Start GPS updates while AnchorWatchView is on screen. Pair with
     * `stop()` on view disappear; no background-monitoring claim is made.
     * High precision is used for the short-lived visible check; stale or
     * inaccurate fixes are rejected before distance is displayed.
     */
    func start() {
        if authorisation == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        guard authorisation != .denied, authorisation != .restricted else {
            lastError = "Watch Location access is unavailable."
            return
        }
        lastError = nil
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        DispatchQueue.main.async {
            self.location = latest
            self.lastError = nil
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async {
            self.authorisation = manager.authorizationStatus
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("LocationManager error: \(error.localizedDescription)")
        DispatchQueue.main.async {
            self.lastError = error.localizedDescription
        }
    }

    // MARK: - Distance helpers

    /** A recent, reasonably accurate fix suitable for a visible local check. */
    func freshLocation(
        at now: Date = Date(),
        maximumAge: TimeInterval = 20,
        maximumAccuracy: CLLocationAccuracy = 50
    ) -> CLLocation? {
        guard let location,
              location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= maximumAccuracy,
              now.timeIntervalSince(location.timestamp) <= maximumAge else { return nil }
        return location
    }

    /** Distance from a fresh foreground fix to (lat, lon), in metres. */
    func freshDistance(toLat lat: Double, lon: Double, at now: Date = Date()) -> Double? {
        guard let here = freshLocation(at: now) else { return nil }
        let target = CLLocation(latitude: lat, longitude: lon)
        return here.distance(from: target)
    }
}
