import Foundation
import Capacitor
import CoreLocation
import ExternalAccessory
import TSLocationManager

/**
 * BackgroundLocationPlugin - Enables continuous GPS tracking while app is backgrounded
 * 
 * This plugin uses CLLocationManager with allowsBackgroundLocationUpdates = true
 * to keep the app alive in the background for voyage logging.
 * 
 * WARNING: Background location tracking significantly increases battery consumption.
 * iOS will show a blue status bar when background location is active.
 */
@objc(BackgroundLocationPlugin)
public class BackgroundLocationPlugin: CAPPlugin, CLLocationManagerDelegate {
    
    private var locationManager: CLLocationManager?
    private var isTracking = false
    private var lastNotificationTime: Date?
    
    // Minimum time between location notifications to JS (15 minutes = 900 seconds)
    private let notificationInterval: TimeInterval = 900
    
    // MARK: - Plugin Methods
    
    @objc func startBackgroundLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            if self.locationManager == nil {
                self.setupLocationManager()
            }
            
            guard let manager = self.locationManager else {
                call.reject("Failed to initialize location manager")
                return
            }
            
            // Check authorization status
            let status = manager.authorizationStatus
            
            switch status {
            case .authorizedAlways:
                // Good to go
                self.startUpdates()
                call.resolve(["started": true])
                
            case .authorizedWhenInUse:
                // Need to request "Always" permission
                manager.requestAlwaysAuthorization()
                call.resolve(["started": false, "needsAlwaysPermission": true])
                
            case .notDetermined:
                // Request "Always" directly
                manager.requestAlwaysAuthorization()
                call.resolve(["started": false, "pendingPermission": true])
                
            case .denied, .restricted:
                call.reject("Location permission denied. Please enable in Settings.")
                
            @unknown default:
                call.reject("Unknown authorization status")
            }
        }
    }
    
    @objc func stopBackgroundLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.stopUpdates()
            call.resolve(["stopped": true])
        }
    }
    
    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            let status = self.locationManager?.authorizationStatus ?? .notDetermined
            var statusString = "unknown"
            
            switch status {
            case .authorizedAlways: statusString = "authorizedAlways"
            case .authorizedWhenInUse: statusString = "authorizedWhenInUse"
            case .denied: statusString = "denied"
            case .restricted: statusString = "restricted"
            case .notDetermined: statusString = "notDetermined"
            @unknown default: statusString = "unknown"
            }
            
            call.resolve([
                "isTracking": self.isTracking,
                "authorizationStatus": statusString,
                "canTrackInBackground": status == .authorizedAlways
            ])
        }
    }

    /**
     * Returns provenance for the existing Transistorsoft location cache.
     *
     * This deliberately does not touch this plugin's own CLLocationManager:
     * voyage / anchor tracking already owns the live Core Location stream via
     * TSLocationManager. Reading that cache adds no second GPS consumer,
     * battery use, or permission request.
     *
     * SDK v9 moved the cache: `lastLocation` is no longer a property of the
     * manager (which Swift now imports as non-optional `BackgroundGeolocation`,
     * so the old `?.` is a compile error too). It lives on TSOdometer, which
     * keeps the last fix in order to accumulate distance — same CLLocation,
     * same provenance fields, just reached through the object that owns it.
     */
    @objc func getActiveLocationSource(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Bound through an explicit Optional ON PURPOSE. TSOdometer.h
            // declares `lastLocation` as a bare `CLLocation*` with no
            // nullability annotation, so Swift imports it as NON-optional and
            // rejects `guard let` outright — while Objective-C is still free to
            // hand back nil, which it does before the very first fix of a
            // session. Taking Swift's word for it would turn "no fix yet" into
            // a crash on the first call. Widening to CLLocation? costs nothing
            // and restores the check the API cannot express.
            let cachedLocation: CLLocation? = TSOdometer.sharedInstance().lastLocation
            guard let location = cachedLocation else {
                call.resolve([
                    "hasLocation": false,
                    "timestampMs": NSNull(),
                    "externalAccessory": false,
                    "simulated": false
                ])
                return
            }

            let source = location.sourceInformation
            call.resolve([
                "hasLocation": true,
                "timestampMs": Int64(location.timestamp.timeIntervalSince1970 * 1000),
                // This is the authoritative iOS signal that the reported
                // CLLocation was supplied by an external accessory. It is
                // intentionally not inferred from horizontal accuracy.
                "externalAccessory": source?.isProducedByAccessory ?? false,
                "simulated": source?.isSimulatedBySoftware ?? false
            ])
        }
    }

    /**
     * Best-effort MFi accessory metadata. iOS only exposes accessories whose
     * protocols this app declares — Info.plist now carries
     * UISupportedExternalAccessoryProtocols with com.bad-elf.gps
     * (2026-08-02), so a paired Bad Elf shows up here by name/model even
     * between fixes. We never scan Bluetooth or open an EASession; the JS
     * layer uses this only to enrich a verified external-location source
     * with a human-readable identity.
     */
    @objc func getConnectedAccessories(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let accessories = EAAccessoryManager.shared().connectedAccessories.map { accessory in
                [
                    "name": accessory.name,
                    "manufacturer": accessory.manufacturer,
                    "modelNumber": accessory.modelNumber,
                    "firmwareRevision": accessory.firmwareRevision,
                    "hardwareRevision": accessory.hardwareRevision
                ]
            }
            call.resolve(["accessories": accessories])
        }
    }
    
    @objc func requestAlwaysPermission(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            if self.locationManager == nil {
                self.setupLocationManager()
            }
            
            self.locationManager?.requestAlwaysAuthorization()
            call.resolve(["requested": true])
        }
    }
    
    // MARK: - Private Methods
    
    private func setupLocationManager() {
        locationManager = CLLocationManager()
        locationManager?.delegate = self
        
        // Configure for background updates
        locationManager?.allowsBackgroundLocationUpdates = true
        locationManager?.pausesLocationUpdatesAutomatically = false
        
        // Use significant change + periodic updates for battery efficiency
        // We don't need high accuracy for 15-minute ship logging
        locationManager?.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locationManager?.distanceFilter = 100 // Meters - only update if moved 100m
        
        // Keep app alive indicator
        locationManager?.showsBackgroundLocationIndicator = true
    }
    
    private func startUpdates() {
        guard let manager = locationManager else { return }
        
        isTracking = true
        lastNotificationTime = Date()
        
        // Start location updates
        manager.startUpdatingLocation()
        
        // Also monitor significant changes as a backup
        manager.startMonitoringSignificantLocationChanges()
        
        print("[BackgroundLocationPlugin] Started background location tracking")
    }
    
    private func stopUpdates() {
        locationManager?.stopUpdatingLocation()
        locationManager?.stopMonitoringSignificantLocationChanges()
        isTracking = false
        
        print("[BackgroundLocationPlugin] Stopped background location tracking")
    }
    
    // MARK: - CLLocationManagerDelegate
    
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isTracking, let location = locations.last else { return }
        
        let now = Date()
        
        // Only notify JS every 15 minutes (900 seconds) to trigger log entry
        if let lastTime = lastNotificationTime {
            let elapsed = now.timeIntervalSince(lastTime)
            if elapsed < notificationInterval {
                // Not time yet, skip
                return
            }
        }
        
        // Time to notify JS for a log entry
        lastNotificationTime = now
        
        notifyListeners("locationUpdate", data: [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.altitude,
            "heading": location.course,
            "speed": location.speed,
            "timestamp": ISO8601DateFormatter().string(from: location.timestamp)
        ])
        
        print("[BackgroundLocationPlugin] Notified JS of location update for log entry")
    }
    
    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[BackgroundLocationPlugin] Location error: \(error.localizedDescription)")
        
        notifyListeners("locationError", data: [
            "error": error.localizedDescription
        ])
    }
    
    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        
        var statusString = "unknown"
        switch status {
        case .authorizedAlways: statusString = "authorizedAlways"
        case .authorizedWhenInUse: statusString = "authorizedWhenInUse"
        case .denied: statusString = "denied"
        case .restricted: statusString = "restricted"
        case .notDetermined: statusString = "notDetermined"
        @unknown default: statusString = "unknown"
        }
        
        notifyListeners("authorizationChange", data: [
            "status": statusString,
            "canTrackInBackground": status == .authorizedAlways
        ])
        
        // If we now have "Always" permission and were trying to track, start
        if status == .authorizedAlways && !isTracking {
            // Let JS decide when to start
        }
    }
}
