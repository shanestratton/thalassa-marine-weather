// Simulator-only full-App native startup fixture. Intended only for the
// explicit full-app-native-startup simulator fixture, never an ordinary target.
// This closes the measured CapacitorHttp dispatch names; it is not a system
// network sandbox or a general defense against hostile same-origin bridge code.
#if E2EE_FULL_APP_UI_FIXTURE
import Foundation
import Capacitor

enum ResearchFullAppHttpFenceError: Error { case unavailable }

private enum ResearchFullAppHttpRoute: String {
    case standard = "CapacitorHttp"
    // The inspected bridge dynamically instantiates an unknown pluginId using
    // NSClassFromString. Reserve the actual @objc default HTTP class name too;
    // otherwise a direct CAPHttpPlugin request could reload the original class.
    case classAlias = "CAPHttpPlugin"
}

private enum ResearchFullAppHttpCounter: String, CaseIterable {
    case request, get, post, put, patch, delete
    case addListener, removeListener
}

private final class ResearchFullAppHttpMeter {
    private static let limit = 10_000
    private let lock = NSLock()
    private var counts: [String: Int] = Dictionary(uniqueKeysWithValues:
        ResearchFullAppHttpCounter.allCases.map { ($0.rawValue, 0) })

    func increment(_ method: ResearchFullAppHttpCounter) {
        lock.lock(); defer { lock.unlock() }
        counts[method.rawValue] = min(Self.limit, (counts[method.rawValue] ?? 0) + 1)
    }

    func copiedCounts() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        // Swift dictionaries have value semantics; only the fixed keys above
        // can enter this meter. No call, option, URL or callback is retained.
        return counts
    }
}

@objc(ResearchFullAppHttpFence)
final class ResearchFullAppHttpFence: CAPPlugin, CAPBridgedPlugin {
    // These are exactly the six promise methods exported by the inspected
    // cached @capacitor/ios 8.5.2 CAPHttpPlugin. Do not inherit from CAPHttpPlugin.
    private static let defaultMethods = ["request", "get", "post", "put", "patch", "delete"]
    private var route: ResearchFullAppHttpRoute = .standard
    private let meter = ResearchFullAppHttpMeter()
    var identifier: String {
        route == .standard ? "ResearchFullAppHttpFence" : "ResearchFullAppHttpClassAliasFence"
    }
    var jsName: String { route.rawValue }
    let pluginMethods: [CAPPluginMethod] = ResearchFullAppHttpFence.defaultMethods.map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    @MainActor static func install(on bridge: CAPBridgeProtocol) throws -> ResearchFullAppHttpFenceAttachment {
#if targetEnvironment(simulator)
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              let webView = bridge.webView, webView.url == nil, !webView.isLoading,
              bridge.config.localURL.scheme == "capacitor", bridge.config.localURL.host == "localhost",
              bridge.config.serverURL.scheme == "capacitor", bridge.config.serverURL.host == "localhost",
              let original = bridge.plugin(withName: ResearchFullAppHttpRoute.standard.rawValue) as? CAPHttpPlugin,
              original.identifier == "CAPHttpPlugin", original.jsName == "CapacitorHttp",
              NSStringFromClass(CAPHttpPlugin.self) == ResearchFullAppHttpRoute.classAlias.rawValue,
              bridge.plugin(withName: ResearchFullAppHttpRoute.classAlias.rawValue) == nil else {
            throw ResearchFullAppHttpFenceError.unavailable
        }
        let methods = original.pluginMethods
        guard methods.count == defaultMethods.count,
              Set(methods.map { $0.name }) == Set(defaultMethods),
              methods.allSatisfy({ $0.returnType == CAPPluginReturnPromise }) else {
            throw ResearchFullAppHttpFenceError.unavailable
        }
        let primary = ResearchFullAppHttpFence()
        let classAlias = ResearchFullAppHttpFence()
        classAlias.route = .classAlias
        guard [primary, classAlias].allSatisfy({ fence in
            fence.pluginMethods.allSatisfy({ fence.responds(to: $0.selector) })
        }) else { throw ResearchFullAppHttpFenceError.unavailable }

        // The inspected public API replaces the registry entry by jsName and
        // exports the matching JS metadata. No original HTTP instance is saved.
        bridge.registerPluginInstance(primary)
        bridge.registerPluginInstance(classAlias)
        guard let installed = bridge.plugin(withName: primary.jsName), installed === primary,
              let installedAlias = bridge.plugin(withName: classAlias.jsName), installedAlias === classAlias,
              webView.url == nil, !webView.isLoading else {
            // Registration cannot be rolled back safely. The caller MUST stop
            // document loading on this fixed failure, never continue startup.
            throw ResearchFullAppHttpFenceError.unavailable
        }
        return ResearchFullAppHttpFenceAttachment(bridge: bridge, primary: primary,
            classAlias: classAlias, observedDefaultMethodCount: methods.count)
#else
        // A mistakenly flagged physical build still refuses installation.
        throw ResearchFullAppHttpFenceError.unavailable
#endif
    }

    private func refuse(_ call: CAPPluginCall, method: ResearchFullAppHttpCounter) {
        meter.increment(method)
        // Synchronous fixed refusal: never inspect options/methodName/error,
        // create a Task/URLRequest/session, save a call or invoke a callback later.
        call.reject("Full App Research native HTTP unavailable", "FULL_APP_RESEARCH_HTTP_REFUSED")
    }

    @objc func request(_ call: CAPPluginCall) { refuse(call, method: .request) }
    @objc func get(_ call: CAPPluginCall) { refuse(call, method: .get) }
    @objc func post(_ call: CAPPluginCall) { refuse(call, method: .post) }
    @objc func put(_ call: CAPPluginCall) { refuse(call, method: .put) }
    @objc func patch(_ call: CAPPluginCall) { refuse(call, method: .patch) }
    @objc func delete(_ call: CAPPluginCall) { refuse(call, method: .delete) }

    // The inspected bridge specially dispatches these selectors without
    // consulting pluginMethods. Refuse both paths before the base implementation
    // can inspect options or mark/retain a CAPPluginCall as a listener.
    override func addListener(_ call: CAPPluginCall) { refuse(call, method: .addListener) }
    override func removeListener(_ call: CAPPluginCall) { refuse(call, method: .removeListener) }

    // Keep the Objective-C base removeAllListeners implementation: the inspected
    // bridge calls it with nil during native cleanup. Its implementation only
    // clears the empty listener map and messages resolve to the optional call;
    // it reads no options and performs no HTTP. It is NOT a measured HTTP call
    // and has no successful-transport meaning. No Swift nonnull override here.

    fileprivate func copiedCounts() -> [String: Int] { meter.copiedCounts() }
}

// Owned native fixture only. This attachment exposes a copied fixed diagnostic
// dictionary; it cannot recover the replaced plugin or dispatch native requests.
// Do not add it to pluginMethods, a Window global or an ordinary Auth projection.
final class ResearchFullAppHttpFenceAttachment {
    private weak var bridge: CAPBridgeProtocol?
    private let primary: ResearchFullAppHttpFence
    private let classAlias: ResearchFullAppHttpFence
    private let observedDefaultMethodCount: Int

    fileprivate init(bridge: CAPBridgeProtocol, primary: ResearchFullAppHttpFence,
                     classAlias: ResearchFullAppHttpFence, observedDefaultMethodCount: Int) {
        self.bridge = bridge; self.primary = primary; self.classAlias = classAlias
        self.observedDefaultMethodCount = observedDefaultMethodCount
    }

    @MainActor func copiedEvidence() -> [String: Any] {
        let primaryCurrent = bridge?.plugin(withName: "CapacitorHttp") === primary
        let classAliasCurrent = bridge?.plugin(withName: "CAPHttpPlugin") === classAlias
        return ["version": 1,
            "status": primaryCurrent && classAliasCurrent ? "installed" : "unavailable",
            "primaryCurrent": primaryCurrent, "classAliasCurrent": classAliasCurrent,
            "observedDefaultMethodCount": observedDefaultMethodCount,
            "primaryCounts": primary.copiedCounts(), "classAliasCounts": classAlias.copiedCounts()]
    }
}
#endif
