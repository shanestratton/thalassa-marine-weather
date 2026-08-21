import Capacitor
import UIKit

/**
 * MemoryGauge — the process-memory reading WKWebView refuses to give JS.
 *
 * Why this exists (Lady Musgrave kill, 2026-08-21): the chart's heavy ENC
 * merges have a heap brake (utils/heapGauge.ts awaitHeapHeadroom) that works
 * on Chrome via performance.memory — and was a documented NO-OP on iOS,
 * the one platform where the WebContent process actually gets jetsammed.
 * os_proc_available_memory() reports how much this app may still allocate
 * before jetsam, and UIKit's memory-warning notification is the system
 * telling us pressure is already critical. Together they let the existing
 * brake park a merge on the phone exactly where it used to die.
 *
 * The reading is for the APP process, not the separate WebContent process —
 * but jetsam pressure is budgeted per-app, so a shrinking available figure
 * here is precisely the warning the brake needs.
 */
@objc(MemoryGaugePlugin)
public final class MemoryGaugePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MemoryGaugePlugin"
    public let jsName = "MemoryGauge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)
    ]

    private var warningObserver: NSObjectProtocol?

    override public func load() {
        warningObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("warning", data: [:])
        }
    }

    deinit {
        if let warningObserver {
            NotificationCenter.default.removeObserver(warningObserver)
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        let availableBytes = os_proc_available_memory()
        call.resolve(["availableMB": Int(availableBytes / 1_048_576)])
    }
}
