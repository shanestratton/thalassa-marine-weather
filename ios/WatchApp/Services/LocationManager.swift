import Foundation
import Combine
import CoreLocation

/**
 * LocationManager — wraps CoreLocation on the watch so we have a
 * watch-local GPS source. The watch must be able to detect drag
 * INDEPENDENTLY of the phone — if the phone dies overnight, the
 * watch is the alarm of last resort.
 *
 * On Apple Watch Ultra and Series 9+, this uses the watch's built-in
 * GPS. On older models it falls back to the paired phone's GPS via
 * Apple's transparent location forwarding.
 */
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {

    @Published private(set) var location: CLLocation? = nil
    @Published private(set) var authorisation: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5  // metres — plenty for drag detection
        authorisation = manager.authorizationStatus
    }

    /**
     * Start continuous GPS updates. Call this when entering the
     * AnchorWatchView. Pair with `stop()` on view disappear.
     *
     * Apple recommends `startUpdatingLocation` for foreground use and
     * `startMonitoringSignificantLocationChanges` for background, but
     * the watch's drag-watch use case wants high precision while the
     * user actively cares — significant changes is too coarse.
     */
    func start() {
        if authorisation == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
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
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async {
            self.authorisation = manager.authorizationStatus
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("LocationManager error: \(error.localizedDescription)")
    }

    // MARK: - Distance helpers

    /** Haversine distance from current GPS to (lat, lon) in metres. */
    func distance(toLat lat: Double, lon: Double) -> Double? {
        guard let here = location else { return nil }
        let target = CLLocation(latitude: lat, longitude: lon)
        return here.distance(from: target)
    }
}
