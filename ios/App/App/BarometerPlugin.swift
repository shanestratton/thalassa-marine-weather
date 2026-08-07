import Foundation
import CoreMotion
import Capacitor

/**
 * BarometerPlugin — the iPhone's own barometer, exposed to JS.
 *
 * Why a native plugin
 * ───────────────────
 * There is no web API for atmospheric pressure. The DeviceMotion /
 * Generic Sensor pressure interfaces were never shipped by Safari, so a
 * WKWebView cannot see the sensor at all. CoreMotion's `CMAltimeter` is
 * the only route, and it is native-only.
 *
 * What the sensor is actually good at
 * ───────────────────────────────────
 * `CMAltimeter` reports STATION pressure — the raw air pressure where the
 * phone is sitting, in kPa. Two things about it drive the whole design of
 * this plugin and the JS on the other side:
 *
 *   - Its ABSOLUTE accuracy is mediocre. Apple quotes roughly ±1 hPa, and
 *     unit-to-unit offsets of a couple of hPa are normal. Printing that
 *     number next to a forecast MSLP and calling it "the pressure" would
 *     be wrong, sometimes by more than the 3-hourly change a skipper
 *     actually cares about.
 *   - Its RELATIVE precision is excellent — on the order of 0.01 hPa, and
 *     the offset is stable over hours. So the DELTA over three hours, the
 *     one number that forecasts weather from a single station, is the part
 *     you can trust.
 *
 * So this plugin emits raw station pressure and timestamps and nothing
 * else. Sea-level reduction, the calibration offset against a forecast
 * MSLP, and the tendency maths all live in TypeScript
 * (`services/native/barometer.ts`, `utils/barometerTendency.ts`) where
 * they can be unit-tested.
 *
 * Sampling and the throttle
 * ─────────────────────────
 * CoreMotion delivers roughly one reading a second, which is far more
 * than a barometer needs and far too much to push across the Capacitor
 * bridge continuously. Readings are buffered natively for `intervalMs`
 * (default 15 s) and one MEDIAN is emitted per window. The median, not
 * the mean: a slammed hatch, a lift, or the cabin door closing is a
 * genuine short pressure spike that the sensor faithfully reports, and a
 * mean would smear it across the record while a median throws it away.
 *
 * Events: `"sample"` → `{ pressureHpa: Double, timestamp: Double (ms),
 * samples: Int }`. Standard Capacitor addListener pattern.
 *
 * Permission: CoreMotion altimeter reads are gated by
 * NSMotionUsageDescription (already present in Info.plist for the
 * anchor-watch motion detection). `isAvailable()` reports both hardware
 * presence and authorization so the UI can tell "this iPad has no
 * barometer" apart from "you said no to Motion & Fitness".
 */
@objc(BarometerPlugin)
public class BarometerPlugin: CAPPlugin {

    private let altimeter = CMAltimeter()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "com.thalassa.barometer"
        q.maxConcurrentOperationCount = 1
        return q
    }()

    private var running = false
    /// Emission throttle, milliseconds. One median sample per window.
    private var intervalMs: Double = 15_000
    /// Readings collected since the last emission (hPa).
    private var window: [Double] = []
    private var windowOpenedAt: Double = 0
    /// Most recent emitted sample, for `getLatest()` without a listener.
    private var latestHpa: Double?
    private var latestAt: Double?

    private let lock = NSLock()

    /// Milliseconds since the epoch — the unit the JS side works in.
    private func nowMs() -> Double {
        return Date().timeIntervalSince1970 * 1000.0
    }

    // MARK: - Availability

    @objc func isAvailable(_ call: CAPPluginCall) {
        let hardware = CMAltimeter.isRelativeAltitudeAvailable()
        var authorization = "unknown"
        if #available(iOS 11.0, *) {
            switch CMAltimeter.authorizationStatus() {
            case .notDetermined: authorization = "notDetermined"
            case .restricted: authorization = "restricted"
            case .denied: authorization = "denied"
            case .authorized: authorization = "authorized"
            @unknown default: authorization = "unknown"
            }
        }
        call.resolve([
            "available": hardware,
            "authorization": authorization,
            "running": running,
        ])
    }

    // MARK: - Sampling

    @objc func start(_ call: CAPPluginCall) {
        guard CMAltimeter.isRelativeAltitudeAvailable() else {
            // Not an error the user can fix — iPads and the simulator simply
            // have no barometer. The JS side falls back to forecast pressure.
            call.reject("BAROMETER_UNAVAILABLE", "This device has no barometer")
            return
        }

        // A requested interval below one second would emit single readings
        // rather than medians, which is exactly the spike-sensitivity the
        // median window exists to avoid. Floor it.
        let requested = call.getDouble("intervalMs") ?? 15_000
        intervalMs = max(1_000, requested)

        if running {
            // Re-arming with a new interval is legitimate; don't stack a
            // second CoreMotion subscription behind it.
            call.resolve(["running": true, "intervalMs": intervalMs])
            return
        }

        lock.lock()
        window.removeAll()
        windowOpenedAt = nowMs()
        lock.unlock()

        running = true
        altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[BarometerPlugin] altimeter error: \(error.localizedDescription)")
                return
            }
            guard let data = data else { return }
            // CMAltitudeData.pressure is kPa. The marine world works in hPa
            // (= mb), so convert once, here, and never again downstream.
            self.ingest(hpa: data.pressure.doubleValue * 10.0)
        }
        NSLog("[BarometerPlugin] started (interval \(intervalMs) ms)")
        call.resolve(["running": true, "intervalMs": intervalMs])
    }

    @objc func stop(_ call: CAPPluginCall) {
        if running {
            altimeter.stopRelativeAltitudeUpdates()
            running = false
            NSLog("[BarometerPlugin] stopped")
        }
        lock.lock()
        window.removeAll()
        lock.unlock()
        call.resolve()
    }

    @objc func getLatest(_ call: CAPPluginCall) {
        lock.lock()
        let hpa = latestHpa
        let at = latestAt
        lock.unlock()
        guard let hpa = hpa, let at = at else {
            call.resolve(["pressureHpa": NSNull(), "timestamp": NSNull()])
            return
        }
        call.resolve(["pressureHpa": hpa, "timestamp": at])
    }

    // MARK: - Median window

    private func ingest(hpa: Double) {
        // A reading outside this range is a sensor fault, not weather. The
        // world record extremes are 870 and 1084 hPa at sea level; the band
        // below is wide enough to cover a phone up a mountain (~500 hPa at
        // 5.5 km) and still reject a zero or a NaN.
        guard hpa.isFinite, hpa > 300, hpa < 1200 else { return }

        lock.lock()
        window.append(hpa)
        let openedAt = windowOpenedAt
        let now = nowMs()
        let due = now - openedAt >= intervalMs
        var emit: (Double, Double, Int)?
        if due, !window.isEmpty {
            let sorted = window.sorted()
            let mid = sorted.count / 2
            let median = sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2.0 : sorted[mid]
            emit = (median, now, window.count)
            latestHpa = median
            latestAt = now
            window.removeAll()
            windowOpenedAt = now
        }
        lock.unlock()

        guard let (median, at, count) = emit else { return }
        // notifyListeners hops to the web view; keep it off the CoreMotion queue.
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("sample", data: [
                "pressureHpa": median,
                "timestamp": at,
                "samples": count,
            ])
        }
    }

    // MARK: - Lifecycle

    /// Capacitor tears the plugin down when the web view goes away; make sure
    /// CoreMotion isn't left running against a dead listener.
    deinit {
        if running {
            altimeter.stopRelativeAltitudeUpdates()
        }
    }
}
