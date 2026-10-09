// Simulator-only local UI evidence. Fixture Auth/relay is NOT live login,
// hosted enrollment, production admission or independent security review.
#if E2EE_LOCAL_UI_FIXTURE
import Foundation
import CoreFoundation
import WebKit

private enum ResearchLocalUiFixtureError: Error { case unavailable }

final class ResearchLocalUiFixture: NSObject, WKScriptMessageHandler, @unchecked Sendable {
    static let publicApiKey = "sb_publishable_research_local_ui_fixture"
    static let bearer = "research-local-ui-fixture-bearer"
    static let userID = "93000000-0000-4000-8000-000000000001"
    static let handlerName = "researchLocalUiFixture"
    private static let shared = ResearchLocalUiFixture()
    private static let coldAllowed: Set<String> = ["configuration", "fenceSession", "authenticate",
        "currentAccount", "messagePrivateAdmission"]
#if E2EE_FULL_APP_UI_FIXTURE
    private static let allowed = coldAllowed
    private static let cases = ["native-http-refusals", "cold-root-closed", "sdk-native-auth-browse-only",
        "unknown-admission-no-private-open", "synthetic-terminal-pagehide",
        "fresh-root-no-restored-authority", "final-root-closed"]
    private static let fullAppPhases = ["script-installed", "dom-ready", "http-refusals", "cold-ready",
        "signed-in", "admission-returned", "terminal-closed", "root-remounted"]
    private var fullAppNonce: String?
    private var fullAppHttpFence: ResearchFullAppHttpFenceAttachment?
    private var fullAppOriginalSnapshot: DmNativeMessageSnapshot?
    private var fullAppVerifiedFenceCount: Int?
    private var fullAppVerifiedAtProgress: [String: [String: Any]] = [:]
    private var fullAppProgressIndex = 0
    private var fullAppFinalizing = false
#elseif E2EE_PROTECTED_UI_FIXTURE
    private static let allowed = coldAllowed.union(["privateMessageIssue", "privateMessageReadiness",
        "privateMessagePermissions", "privateMessageInbox", "privateMessageThread", "privateMessageSendText"])
    private static let cases = ["cold-denied", "sign-in", "explicit-fixture-setup", "protected-admission",
        "actual-pm-open", "actual-pm-send", "actual-pm-receive", "truthful-status"]
    private var protectedFixture: ResearchProtectedUiFixture?
    private var protectedSetupStarted = false
    private var protectedReplyStarted = false
    private var protectedControlBusy = false
    private var protectedTask: Task<Void, Never>?
    private var protectedTaskID: UUID?
    private var finishing = false
    private var pmResults: [String: Int] = [:]
#else
    private static let allowed = coldAllowed
    private static let cases = ["cold-denied", "sign-in", "unknown-admission", "no-private-open", "password-cleared"]
#endif
    private static let methods = ["configuration", "fenceSession", "authenticate", "currentAccount",
        "messageState", "messagePrivateAdmission", "messagePairingCard", "messageInspectPeerCard",
        "messageConfirmPeer", "messageRegisterDevice", "messageClaimPeer", "messageRefreshPolicy",
        "messageRequireProtected", "messageAccountMode", "messageThread", "messagePrepareText",
        "messageSendPending", "messageSyncInbox", "privateMessageIssue", "privateMessageReadiness",
        "privateMessagePermissions", "privateMessageInbox", "privateMessageThread",
        "privateMessageSendText", "privateMessageRetryPending"]
    private let lock = NSRecursiveLock()
    private var runID: String?
    private var script: String?
    private var completed = false
    private weak var installedWebView: WKWebView?
    private weak var facade: VodozemacSessionFacade?
    private var counters: [String: Int] = Dictionary(uniqueKeysWithValues:
        (ResearchLocalUiFixture.methods + ["nativeAuthRequests", "unexpectedNativeRequests", "relayRequests", "unexpectedMethods",
            "fixtureSetupControls", "fixtureReplyControls"])
            .map { ($0, 0) })

    private override init() { super.init() }

    // Fixed launch-stage diagnostics in this fresh simulator only. No native
    // errors, request/options, credentials or DOM contents are serialized.
    static func notePhase(_ phase: String) {
#if targetEnvironment(simulator)
        let phases = ["application-launched", "scene-connected", "bridge-created", "fixture-installed",
               "fixture-install-failed", "script-installed", "dom-ready", "cold-ready", "signed-in",
               "admission-returned", "protected-setup", "prepared", "protected-peer-reply", "peer-replied",
               "pm-opened", "pm-sent", "pm-received", "pm-refresh-started", "protected-control-failed"]
#if E2EE_FULL_APP_UI_FIXTURE
        let allowedPhases = phases + ["http-refusals", "terminal-closed", "root-remounted", "fixture-complete", "fixture-failed"]
#else
        let allowedPhases = phases
#endif
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              allowedPhases.contains(phase) else { return }
        do {
            let directory = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
            let url = directory.appendingPathComponent("research-local-ui-phase.json")
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "phase": phase], options: [.sortedKeys])
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { /* This is a diagnostic, never an admission or fallback. */ }
#endif
    }

    private static func integer(_ value: Any?, _ range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue == Double(number.intValue),
              range.contains(number.intValue) else { return nil }
        return number.intValue
    }

    private func loadBundled() throws {
        lock.lock(); defer { lock.unlock() }
        if runID != nil, script != nil { return }
#if targetEnvironment(simulator)
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              let url = Bundle.main.url(forResource: "research-local-ui-fixture", withExtension: "json") else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
        guard values.isSymbolicLink != true, values.isRegularFile == true,
              let size = values.fileSize, (1...524288).contains(size) else { throw ResearchLocalUiFixtureError.unavailable }
        let data = try Data(contentsOf: url)
        guard data.count <= 524288,
              let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = input["runID"] as? String, id.count == 36,
              UUID(uuidString: id)?.uuidString.lowercased() == id,
              let source = input["script"] as? String, (1...65536).contains(source.utf8.count) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
#if E2EE_FULL_APP_UI_FIXTURE
        guard Set(input.keys) == ["version", "runID", "nonce", "scenario", "script"],
              Self.integer(input["version"], 3...3) == 3,
              input["scenario"] as? String == "full-app-native-startup",
              let nonce = input["nonce"] as? String, nonce.utf8.count == 64,
              nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              source.contains("const runID = '" + id + "'"),
              source.contains("const nonce = '" + nonce + "'"),
              !source.contains("__RESEARCH_FULL_APP_NATIVE_RUN_ID__"),
              !source.contains("__RESEARCH_FULL_APP_NATIVE_NONCE__") else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        fullAppNonce = nonce
#elseif E2EE_PROTECTED_UI_FIXTURE
        guard Set(input.keys) == ["version", "runID", "script", "scenario"], Self.integer(input["version"], 2...2) == 2,
              input["scenario"] as? String == "protected-exchange" else { throw ResearchLocalUiFixtureError.unavailable }
#else
        guard Set(input.keys) == ["version", "runID", "script"], Self.integer(input["version"], 1...1) == 1
              else { throw ResearchLocalUiFixtureError.unavailable }
#endif
        runID = id; script = source
#else
        // A mistakenly flagged physical build must refuse, not use real Auth.
        throw ResearchLocalUiFixtureError.unavailable
#endif
    }

    static func authenticator(publicApiKey: String) throws -> VodozemacSupabaseAuth {
        guard publicApiKey == Self.publicApiKey else { throw ResearchLocalUiFixtureError.unavailable }
        try shared.loadBundled()
#if E2EE_PROTECTED_UI_FIXTURE
        return try ResearchProtectedUiRelay.authenticator()
#else
        return try VodozemacSupabaseAuth(projectOrigin: ResearchAuthConfiguration.origin,
            publicApiKey: Self.publicApiKey, deadlineSeconds: 5, configurationForResearch: {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [ResearchLocalUiAuthProtocol.self]
                return configuration
            })
#endif
    }

    static func relayTransport() throws -> VodozemacRelayTransport {
        try shared.loadBundled()
#if E2EE_PROTECTED_UI_FIXTURE
        return try ResearchProtectedUiRelay.transport()
#else
        return try VodozemacRelayTransport(serviceOrigin: ResearchAuthConfiguration.origin,
            serviceBasePath: "/functions/v1/scuttlebutt-e2ee-pilot", deadlineSeconds: 5,
            configurationForResearch: {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [ResearchLocalUiRelayProtocol.self]
                return configuration
            })
#endif
    }

    static func requireFreshInstallation(markerPresent: Bool, rootExists: Bool) throws {
        try shared.loadBundled()
        guard !markerPresent, !rootExists else { throw ResearchLocalUiFixtureError.unavailable }
    }

    static func attach(_ facade: VodozemacSessionFacade) throws {
        try shared.loadBundled()
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard shared.facade == nil || shared.facade === facade else { throw ResearchLocalUiFixtureError.unavailable }
        shared.facade = facade
    }

    // Called before option validation. Only fixed method names/counts are kept;
    // never a CAPPluginCall, options, bearer, password or diagnostic description.
    static func allow(method: String) -> Bool {
        shared.lock.lock(); defer { shared.lock.unlock() }
        let known = shared.counters[method] != nil
        if known { shared.increment(method) }
        else { shared.increment("unexpectedMethods") }
#if E2EE_PROTECTED_UI_FIXTURE
        guard !shared.finishing else { return false }
#endif
#if E2EE_FULL_APP_UI_FIXTURE
        // Final reporting may race the existing controller's queued fence.
        // Let ONLY that already-owned path settle; create no fixture Auth call.
        guard !shared.fullAppFinalizing || method == "fenceSession" else { return false }
#endif
        guard shared.runID != nil, !shared.completed, allowed.contains(method) else {
            if known && !allowed.contains(method) { shared.increment("unexpectedMethods") }
            return false
        }
        return true
    }

    private func increment(_ name: String) {
        counters[name] = min(10000, (counters[name] ?? 0) + 1)
    }

#if E2EE_PROTECTED_UI_FIXTURE
    static func notePmResult(method: String, status: String) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard ["privateMessagePermissions", "privateMessageInbox", "privateMessageSendText", "privateMessageRetryPending"].contains(method),
              ["ok", "unavailable"].contains(status) else { return }
        let key = method + ":" + status
        shared.pmResults[key] = min(10000, (shared.pmResults[key] ?? 0) + 1)
    }
#endif

    fileprivate static func authRequest(allowed: Bool) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        shared.increment("nativeAuthRequests")
        if !allowed { shared.increment("unexpectedNativeRequests") }
    }

    fileprivate static func relayRequest() {
        shared.lock.lock(); defer { shared.lock.unlock() }
        shared.increment("relayRequests"); shared.increment("unexpectedNativeRequests")
    }

    @MainActor static func install(in webView: WKWebView) throws {
#if E2EE_FULL_APP_UI_FIXTURE
        // The full-App scenario MUST supply its pre-document HTTP attachment.
        throw ResearchLocalUiFixtureError.unavailable
#else
        try shared.loadBundled()
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard shared.installedWebView == nil, let source = shared.script else { throw ResearchLocalUiFixtureError.unavailable }
        try shared.writeReceipt(status: "running", assertions: 0, nativeAssertions: 0,
            sdkCounts: ["password": 0, "unexpected": 0], cases: [],
            nativeState: ["status": "unavailable"], initial: true)
        let controller = webView.configuration.userContentController
        controller.add(shared, name: handlerName)
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        shared.installedWebView = webView
#endif
    }

#if E2EE_FULL_APP_UI_FIXTURE
    private struct FullAppReport {
        let status: String
        let phase: String
        let assertions: Int
        let sdkCounts: [String: Int]
        let cases: [String]
        let windowEvidence: [String: Any]?
        let domFacts: [String: Bool]
    }

    private static let fullAppFenceNames = ["fetch", "xhr", "webSocket", "eventSource", "beacon",
        "preservedFetch", "preservedXhr", "worker", "sharedWorker", "serviceWorker", "caches", "indexedDB",
        "geolocation", "media", "clipboard", "audio", "navigation", "permissions", "otherNetwork",
        "localStorageReads", "localStorageWrites", "sessionStorageReads", "sessionStorageWrites",
        "storageRefused", "storageManager", "patchFailures", "locationPatchUnavailable",
        "authRequests", "authResponses", "authRefused"]
    private static let fullAppBoundaryNames = ["instrumentRequests", "gpsRequests", "internetRequests", "aisRequests",
        "appleRequests", "anchorRequests", "anchorSyncRequests", "anchorPiRequests", "shiplogRequests",
        "vesselRequests", "piRequests", "nativeRequests", "observations", "subscriptions", "cleanups"]
    private static let fullAppMemoryNames = ["preferenceReads", "preferenceWrites", "preferenceRemovals",
        "preferenceClears", "preferenceKeys", "cacheReads", "cacheWrites", "cacheRemovals", "cacheFlushes",
        "versionReads", "versionWrites", "refusals"]
    private static let fullAppDomNames = ["actualAppNavigation", "authenticatedNotice", "signedOutNotice",
        "unknownAdmission", "unavailablePrivateView", "stoppedNotice", "messageLogAbsent", "signInEnabled",
        "privateOpenEnabled", "passwordEmpty"]

    private static func fullAppBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func fullAppRow(_ value: Any?, _ names: [String]) throws -> [String: Any] {
        guard let row = value as? [String: Any], Set(row.keys) == Set(names) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        return row
    }

    private static func fullAppCounts(_ value: Any?, _ names: [String], limit: Int = 10000) throws -> [String: Int] {
        let row = try fullAppRow(value, names)
        return try Dictionary(uniqueKeysWithValues: names.map { key in
            guard let number = integer(row[key], 0...limit) else { throw ResearchLocalUiFixtureError.unavailable }
            return (key, number)
        })
    }

    private static func fullAppNullableBoolean(_ value: Any?) throws -> Any {
        if value is NSNull { return NSNull() }
        guard let boolean = fullAppBoolean(value) else { throw ResearchLocalUiFixtureError.unavailable }
        return boolean
    }

    // Copy only the existing fixed Window schema; never serialize a supplied
    // error, URL, message, native handle, credential or identity string.
    private static func fullAppWindow(_ value: Any?, runID: String) throws -> [String: Any]? {
        if value is NSNull { return nil }
        let row = try fullAppRow(value, ["version", "runId", "phase", "fence", "sdk", "root", "auth", "authScope",
            "privateSelection", "legacyPermitAvailable", "core", "boundaries", "memory", "lifecycle"])
        guard integer(row["version"], 1...1) == 1, row["runId"] as? String == runID,
              let phase = row["phase"] as? String, ["starting", "ready", "failed"].contains(phase) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let fence: Any
        if row["fence"] is NSNull { fence = NSNull() }
        else {
            let item = try fullAppRow(row["fence"], ["version", "status", "counts"])
            guard integer(item["version"], 1...1) == 1, let status = item["status"] as? String,
                  ["uninstalled", "installed", "failed"].contains(status) else { throw ResearchLocalUiFixtureError.unavailable }
            fence = ["version": 1, "status": status, "counts": try fullAppCounts(item["counts"], fullAppFenceNames)] as [String: Any]
        }
        let auth = try fullAppRow(row["auth"], ["status", "userPresent", "authChecked"])
        guard let authStatus = auth["status"] as? String,
              ["unknown", "unsupported", "unavailable", "signed_out", "verifying", "authenticated", "detached", "inactive"].contains(authStatus) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let copiedAuth: [String: Any] = ["status": authStatus,
            "userPresent": try fullAppNullableBoolean(auth["userPresent"]),
            "authChecked": try fullAppNullableBoolean(auth["authChecked"])]
        let scope = try fullAppRow(row["authScope"], ["originalUserPresent", "originalAnonymous", "originalGeneration",
            "currentUserPresent", "currentAnonymous", "currentGeneration"])
        var copiedScope: [String: Any] = [:]
        for key in ["originalUserPresent", "originalAnonymous", "currentUserPresent", "currentAnonymous"] {
            copiedScope[key] = try fullAppNullableBoolean(scope[key])
        }
        for key in ["originalGeneration", "currentGeneration"] {
            if scope[key] is NSNull { copiedScope[key] = NSNull() }
            else {
                guard let generation = integer(scope[key], 0...10000) else { throw ResearchLocalUiFixtureError.unavailable }
                copiedScope[key] = generation
            }
        }
        let selection: Any
        if row["privateSelection"] is NSNull { selection = NSNull() }
        else {
            guard let name = row["privateSelection"] as? String, ["native-unavailable", "native-pilot"].contains(name) else {
                throw ResearchLocalUiFixtureError.unavailable
            }
            selection = name
        }
        let core: Any
        if row["core"] is NSNull { core = NSNull() }
        else {
            let item = try fullAppRow(row["core"], ["registrationAttempts", "methodAttempts", "platform"])
            guard let platform = item["platform"] as? String, ["web", "ios"].contains(platform),
                  let registration = integer(item["registrationAttempts"], 0...1024),
                  let methods = integer(item["methodAttempts"], 0...1024) else { throw ResearchLocalUiFixtureError.unavailable }
            core = ["registrationAttempts": registration, "methodAttempts": methods, "platform": platform] as [String: Any]
        }
        let lifecycle = try fullAppRow(row["lifecycle"], ["stopped"])
        guard let stopped = fullAppBoolean(lifecycle["stopped"]) else { throw ResearchLocalUiFixtureError.unavailable }
        let boundaries: Any
        if row["boundaries"] is NSNull { boundaries = NSNull() }
        else { boundaries = try fullAppCounts(row["boundaries"], fullAppBoundaryNames, limit: 1024) }
        let memory: Any
        if row["memory"] is NSNull { memory = NSNull() }
        else { memory = try fullAppCounts(row["memory"], fullAppMemoryNames, limit: 1024) }
        return ["version": 1, "runId": runID, "phase": phase, "fence": fence,
            "sdk": try fullAppCounts(row["sdk"], ["runtimeCreations", "sdkConstructions", "nativeCalls"]),
            "root": try fullAppCounts(row["root"], ["mounts", "remounts", "closedRenders"]), "auth": copiedAuth,
            "authScope": copiedScope, "privateSelection": selection,
            "legacyPermitAvailable": try fullAppNullableBoolean(row["legacyPermitAvailable"]),
            "core": core, "boundaries": boundaries, "memory": memory, "lifecycle": ["stopped": stopped]]
    }

    private func fullAppReport(_ value: Any) throws -> FullAppReport {
        let row = try Self.fullAppRow(value, ["version", "runID", "nonce", "scenario", "status", "phase", "assertions",
            "sdkCounts", "cases", "windowEvidence", "domFacts", "syntheticPagehide", "realOsLifecycleOrBfCacheProved"])
        guard let runID, let fullAppNonce, Self.integer(row["version"], 2...2) == 2,
              row["runID"] as? String == runID, row["nonce"] as? String == fullAppNonce,
              row["scenario"] as? String == "full-app-native-startup",
              let status = row["status"] as? String, ["progress", "passed", "failed"].contains(status),
              let phase = row["phase"] as? String,
              status == "progress" ? Self.fullAppPhases.contains(phase) : phase == (status == "passed" ? "fixture-complete" : "fixture-failed"),
              let assertions = Self.integer(row["assertions"], 0...10000), status != "passed" || assertions > 0,
              Self.fullAppBoolean(row["syntheticPagehide"]) == true,
              Self.fullAppBoolean(row["realOsLifecycleOrBfCacheProved"]) == false,
              let cases = row["cases"] as? [String], cases.count <= Self.cases.count else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        if status == "failed" { guard cases == ["fixture-failed"] else { throw ResearchLocalUiFixtureError.unavailable } }
        else {
            let expected = status == "passed" ? 7 : ["script-installed": 0, "dom-ready": 0, "http-refusals": 1,
                "cold-ready": 2, "signed-in": 3, "admission-returned": 4, "terminal-closed": 5, "root-remounted": 6][phase]
            guard let expected, cases == Array(Self.cases.prefix(expected)) else { throw ResearchLocalUiFixtureError.unavailable }
        }
        let counts = try Self.fullAppCounts(row["sdkCounts"], ["password", "unexpected"])
        let dom = try Self.fullAppRow(row["domFacts"], Self.fullAppDomNames)
        let copiedDom = try Dictionary(uniqueKeysWithValues: Self.fullAppDomNames.map { key in
            guard let value = Self.fullAppBoolean(dom[key]) else { throw ResearchLocalUiFixtureError.unavailable }
            return (key, value)
        })
        let window = try Self.fullAppWindow(row["windowEvidence"], runID: runID)
        guard status == "failed" || ["script-installed", "dom-ready", "http-refusals"].contains(phase) || window != nil else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        return FullAppReport(status: status, phase: phase, assertions: assertions, sdkCounts: counts,
            cases: cases, windowEvidence: window, domFacts: copiedDom)
    }

    private func fullAppCopiedCounters() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return counters
    }

    private func fullAppFacade() -> VodozemacSessionFacade? {
        lock.lock(); defer { lock.unlock() }
        return facade
    }

    @MainActor private func fullAppHttpEvidence(requireChallenge: Bool, initialZero: Bool = false) throws -> [String: Any] {
        guard let fullAppHttpFence else { throw ResearchLocalUiFixtureError.unavailable }
        // Never invoke bridge APIs while holding the receipt/counter lock.
        let row = try Self.fullAppRow(fullAppHttpFence.copiedEvidence(), ["version", "status", "primaryCurrent",
            "classAliasCurrent", "observedDefaultMethodCount", "primaryCounts", "classAliasCounts"])
        guard Self.integer(row["version"], 1...1) == 1, row["status"] as? String == "installed",
              Self.fullAppBoolean(row["primaryCurrent"]) == true, Self.fullAppBoolean(row["classAliasCurrent"]) == true,
              Self.integer(row["observedDefaultMethodCount"], 6...6) == 6 else { throw ResearchLocalUiFixtureError.unavailable }
        for route in ["primaryCounts", "classAliasCounts"] {
            let counts = try Self.fullAppCounts(row[route], ["request", "get", "post", "put", "patch", "delete", "addListener", "removeListener"])
            guard counts["addListener"] == 0, counts["removeListener"] == 0,
                  ["request", "get", "post", "put", "patch", "delete"].allSatisfy({ key in
                      guard let value = counts[key] else { return false }
                      // Only the pre-document installation claims exact zero.
                      // Early queued progress may race the deliberate probes.
                      return requireChallenge ? value == 1 : (initialZero ? value == 0 : value <= 1)
                  }) else {
                throw ResearchLocalUiFixtureError.unavailable
            }
        }
        return row
    }

    @MainActor static func install(in webView: WKWebView, fullAppHttpFence: ResearchFullAppHttpFenceAttachment) throws {
        try shared.loadBundled()
        guard shared.installedWebView == nil, shared.fullAppHttpFence == nil,
              let source = shared.script, shared.fullAppNonce != nil,
              webView.url == nil, !webView.isLoading else { throw ResearchLocalUiFixtureError.unavailable }
        shared.fullAppHttpFence = fullAppHttpFence
        _ = try shared.fullAppHttpEvidence(requireChallenge: false, initialZero: true)
        try shared.writeFullAppReceipt(status: "running", phase: "fixture-installed", report: nil,
            nativeAssertions: 0, nativeState: ["status": "unavailable"], initial: true)
        let controller = webView.configuration.userContentController
        controller.add(shared, name: handlerName)
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        shared.installedWebView = webView
    }

    @MainActor private func fullAppCommon(_ report: FullAppReport) throws {
        guard let window = report.windowEvidence,
              let fence = window["fence"] as? [String: Any], fence["status"] as? String == "installed",
              let counts = fence["counts"] as? [String: Int], counts["patchFailures"] == 0,
              let sdk = window["sdk"] as? [String: Int], let root = window["root"] as? [String: Int],
              let auth = window["auth"] as? [String: Any], Self.fullAppBoolean(auth["userPresent"]) == false,
              Self.fullAppBoolean(auth["authChecked"]) == true,
              let scope = window["authScope"] as? [String: Any], Self.fullAppBoolean(scope["originalUserPresent"]) == false,
              Self.fullAppBoolean(scope["originalAnonymous"]) == true,
              let core = window["core"] as? [String: Any], core["platform"] as? String == "ios",
              window["boundaries"] is [String: Int], window["memory"] is [String: Int],
              window["phase"] as? String == "ready", window["privateSelection"] as? String == "native-unavailable",
              Self.fullAppBoolean(window["legacyPermitAvailable"]) == false,
              report.sdkCounts["unexpected"] == 0 else { throw ResearchLocalUiFixtureError.unavailable }
        let remounted = ["root-remounted", "fixture-complete"].contains(report.phase)
        let mounts = remounted ? 2 : 1
        let password = ["cold-ready"].contains(report.phase) ? 0 : 1
        guard sdk["runtimeCreations"] == mounts, sdk["sdkConstructions"] == mounts, (sdk["nativeCalls"] ?? 0) > 0,
              root["mounts"] == mounts, root["remounts"] == (remounted ? 1 : 0), (root["closedRenders"] ?? 0) >= mounts,
              counts["authRequests"] == password, counts["authResponses"] == password, counts["authRefused"] == 0,
              report.sdkCounts["password"] == password,
              ["fetch", "xhr", "webSocket", "eventSource", "beacon", "preservedFetch", "preservedXhr", "worker",
               "sharedWorker", "serviceWorker", "otherNetwork"].allSatisfy({ counts[$0] == 0 }) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let expectedAuth = ["signed-in", "admission-returned"].contains(report.phase) ? "authenticated"
            : (["terminal-closed", "fixture-complete"].contains(report.phase) ? "inactive" : "signed_out")
        guard auth["status"] as? String == expectedAuth, report.domFacts["actualAppNavigation"] == true,
              report.domFacts["unavailablePrivateView"] == true, report.domFacts["messageLogAbsent"] == true,
              report.domFacts["passwordEmpty"] == true else { throw ResearchLocalUiFixtureError.unavailable }
        if expectedAuth == "authenticated" {
            guard report.domFacts["authenticatedNotice"] == true, report.domFacts["privateOpenEnabled"] == true,
                  Self.fullAppBoolean(scope["currentUserPresent"]) == true,
                  Self.fullAppBoolean(scope["currentAnonymous"]) == false else { throw ResearchLocalUiFixtureError.unavailable }
        } else {
            guard report.domFacts["privateOpenEnabled"] == false else { throw ResearchLocalUiFixtureError.unavailable }
        }
        if expectedAuth == "signed_out" {
            guard report.domFacts["signedOutNotice"] == true, report.domFacts["signInEnabled"] == true,
                  Self.fullAppBoolean(scope["currentUserPresent"]) == false,
                  Self.fullAppBoolean(scope["currentAnonymous"]) == true else { throw ResearchLocalUiFixtureError.unavailable }
        }
        if ["terminal-closed", "fixture-complete"].contains(report.phase) {
            guard let lifecycle = window["lifecycle"] as? [String: Any], Self.fullAppBoolean(lifecycle["stopped"]) == true,
                  report.domFacts["stoppedNotice"] == true else { throw ResearchLocalUiFixtureError.unavailable }
        }
        if report.phase == "admission-returned" {
            guard report.domFacts["unknownAdmission"] == true else { throw ResearchLocalUiFixtureError.unavailable }
        }
    }

    @MainActor private func captureFullAppVerifiedState() throws -> [String: Any] {
        guard let facade = fullAppFacade(), let account = facade.currentAccount(), account.serverVerified,
              account.accountId == Self.userID, UUID(uuidString: account.deviceId)?.uuidString.lowercased() == account.deviceId else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
        guard snapshot.context.peerGeneration == nil,
              case .privateAdmissionState(.unknown) = try facade.executeMessageOperation(snapshot: snapshot, operation: .privateAdmissionState),
              case .enrollmentState(let enrollment) = try facade.executeMessageOperation(snapshot: snapshot, operation: .relayEnrollmentState),
              case .none = enrollment.registration, case .none = enrollment.claim, enrollment.claimedPrekeyExpiresAt == nil,
              case .pairingState(let pairing) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingState),
              pairing.status == .unpaired, pairing.peerGeneration == nil, pairing.confirmedFingerprint == nil,
              pairing.sessionRole == .unpaired, pairing.outgoingCount == 0, pairing.incomingCount == 0, pairing.unresolvedCount == 0,
              facade.currentMessageContext(snapshot: snapshot) == snapshot.context else { throw ResearchLocalUiFixtureError.unavailable }
        if let original = fullAppOriginalSnapshot {
            guard facade.currentMessageContext(snapshot: original) == original.context else { throw ResearchLocalUiFixtureError.unavailable }
        } else {
            // Native-only original lease, never published or used for new
            // operations after terminal. Finalization clears this reference.
            fullAppOriginalSnapshot = snapshot
            fullAppVerifiedFenceCount = fullAppCopiedCounters()["fenceSession"]
        }
        return ["status": "verified-unregistered-unpaired", "serverVerified": true, "accountPresent": true,
            "selection": "unknown", "registration": "none", "claim": "none", "pairing": "unpaired",
            "outgoingCount": 0, "incomingCount": 0, "unresolvedCount": 0, "originalSnapshotCurrent": true]
    }

    @MainActor private func fullAppCredentialFenced() -> Bool {
        guard let facade = fullAppFacade(), let original = fullAppOriginalSnapshot,
              let capturedFences = fullAppVerifiedFenceCount,
              (fullAppCopiedCounters()["fenceSession"] ?? 0) > capturedFences else { return false }
        return facade.currentAccount() == nil && facade.currentMessageContext(snapshot: original) == nil
    }

    @MainActor private func handleFullAppMessage(_ controller: WKUserContentController, message: WKScriptMessage) {
        guard !completed, !fullAppFinalizing, let view = installedWebView,
              controller === view.configuration.userContentController,
              message.name == Self.handlerName, message.frameInfo.isMainFrame, message.webView === view,
              let url = message.frameInfo.request.url, url.scheme == "capacitor", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil || url.fragment == "" else { return }
        // The report's resource-bound run/nonce and copied Window runId bind the
        // fixture. WK frame request query is not assumed to track replaceState.
        guard let supplied = try? fullAppReport(message.body) else { return }
        do {
            if supplied.status == "failed" { finishFullAppReport(supplied, passing: false); return }
            if supplied.status == "passed" {
                guard fullAppProgressIndex == Self.fullAppPhases.count else { throw ResearchLocalUiFixtureError.unavailable }
                try fullAppCommon(supplied)
                finishFullAppReport(supplied, passing: true)
                return
            }
            guard fullAppProgressIndex < Self.fullAppPhases.count,
                  supplied.phase == Self.fullAppPhases[fullAppProgressIndex] else { throw ResearchLocalUiFixtureError.unavailable }
            let challenge = fullAppProgressIndex >= 2
            _ = try fullAppHttpEvidence(requireChallenge: challenge)
            if fullAppProgressIndex >= 3 { try fullAppCommon(supplied) }
            var state: [String: Any] = ["status": "running"]
            if ["signed-in", "admission-returned"].contains(supplied.phase) {
                state = try captureFullAppVerifiedState()
                fullAppVerifiedAtProgress[supplied.phase] = state
            } else if ["terminal-closed", "root-remounted"].contains(supplied.phase) {
                state = fullAppCredentialFenced() ? ["status": "credential-fenced", "accountPresent": false,
                    "originalSnapshotCurrent": false] : ["status": "pending-fence"]
            }
            fullAppProgressIndex += 1
            Self.notePhase(supplied.phase)
            try writeFullAppReceipt(status: "running", phase: supplied.phase, report: supplied,
                nativeAssertions: 0, nativeState: state, initial: false)
        } catch { finishFullAppReport(supplied, passing: false) }
    }

    @MainActor private func finishFullAppReport(_ supplied: FullAppReport, passing: Bool) {
        guard !completed, !fullAppFinalizing else { return }
        fullAppFinalizing = true
        // Pure bounded observation of the controller's existing queued fence;
        // no new Auth, native fence, setup, enrollment, transport or reset.
        Task { @MainActor in
            defer { self.fullAppOriginalSnapshot = nil; self.fullAppVerifiedFenceCount = nil }
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while !self.fullAppCredentialFenced(), ContinuousClock.now < deadline {
                try? await Task.sleep(nanoseconds: 25_000_000)
            }
            do {
                guard passing, self.installedWebView != nil, self.fullAppCredentialFenced(),
                      Set(self.fullAppVerifiedAtProgress.keys) == ["signed-in", "admission-returned"],
                      supplied.sdkCounts["password"] == 1, supplied.sdkCounts["unexpected"] == 0 else {
                    throw ResearchLocalUiFixtureError.unavailable
                }
                let counts = self.fullAppCopiedCounters()
                guard Self.allowed.allSatisfy({ (counts[$0] ?? 0) > 0 }), counts["authenticate"] == 1,
                      Self.methods.filter({ !Self.allowed.contains($0) }).allSatisfy({ counts[$0] == 0 }),
                      counts["nativeAuthRequests"] == 2, counts["unexpectedNativeRequests"] == 0,
                      counts["relayRequests"] == 0, counts["unexpectedMethods"] == 0,
                      counts["fixtureSetupControls"] == 0, counts["fixtureReplyControls"] == 0 else {
                    throw ResearchLocalUiFixtureError.unavailable
                }
                _ = try self.fullAppHttpEvidence(requireChallenge: true)
                try self.fullAppCommon(supplied)
                try self.writeFullAppReceipt(status: "passed", phase: "fixture-complete", report: supplied,
                    nativeAssertions: 10, nativeState: ["status": "credential-fenced", "accountPresent": false,
                        "originalSnapshotCurrent": false], initial: false)
                self.completed = true
                Self.notePhase("fixture-complete")
            } catch {
                let state: [String: Any] = self.fullAppCredentialFenced()
                    ? ["status": "credential-fenced", "accountPresent": false, "originalSnapshotCurrent": false]
                    : ["status": "unavailable"]
                try? self.writeFullAppReceipt(status: "failed", phase: "fixture-failed", report: supplied,
                    nativeAssertions: 0, nativeState: state, initial: false)
                self.completed = true
                Self.notePhase("fixture-failed")
            }
        }
    }

    @MainActor private func writeFullAppReceipt(status: String, phase: String, report: FullAppReport?,
        nativeAssertions: Int, nativeState: [String: Any], initial: Bool) throws {
        guard let runID, let fullAppNonce, ["running", "passed", "failed"].contains(status),
              ["fixture-installed", "fixture-complete", "fixture-failed"].contains(phase) || Self.fullAppPhases.contains(phase) else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let http: Any = fullAppHttpFence.map { $0.copiedEvidence() as Any } ?? NSNull()
        let window: Any
        if let copied = report?.windowEvidence { window = copied }
        else { window = NSNull() }
        let body: [String: Any] = ["version": 2, "runID": runID, "nonce": fullAppNonce,
            "scenario": "full-app-native-startup", "status": status, "phase": phase,
            "assertions": report?.assertions ?? 0, "nativeAssertions": nativeAssertions,
            "sdkCounts": report.map { $0.sdkCounts as Any } ?? NSNull(),
            "cases": status == "failed" ? ["fixture-failed"] : (report?.cases ?? []),
            "nativeCounters": fullAppCopiedCounters(), "nativeState": nativeState,
            "nativeVerifiedAtProgress": fullAppVerifiedAtProgress, "nativeHttpFence": http,
            "windowEvidence": window,
            "domFacts": report.map { $0.domFacts as Any } ?? NSNull(),
            "syntheticPagehide": true, "realOsLifecycleOrBfCacheProved": false]
        let manager = FileManager.default
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = try documents.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directory.isDirectory == true, directory.isSymbolicLink != true else { throw ResearchLocalUiFixtureError.unavailable }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: documents.path)
        let url = documents.appendingPathComponent("research-local-ui-status-" + runID + ".json")
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        guard data.count <= 65536 else { throw ResearchLocalUiFixtureError.unavailable }
        if initial {
            guard !manager.fileExists(atPath: url.path) else { throw ResearchLocalUiFixtureError.unavailable }
            try data.write(to: url, options: [.withoutOverwriting, .completeFileProtection])
        } else {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, (1...65536).contains(size),
                  let prior = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
                  Self.integer(prior["version"], 2...2) == 2, prior["runID"] as? String == runID,
                  prior["nonce"] as? String == fullAppNonce, prior["scenario"] as? String == "full-app-native-startup",
                  prior["status"] as? String == "running" else { throw ResearchLocalUiFixtureError.unavailable }
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var protected = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
    }
#endif

    private struct Report {
        let passed: Bool
        let assertions: Int
        let sdkCounts: [String: Int]
        let domFacts: [String: Any]?
    }

    private func report(_ value: Any) -> Report? {
        guard let row = value as? [String: Any] else { return nil }
        let domFacts: [String: Any]?
#if E2EE_PROTECTED_UI_FIXTURE
        guard Set(row.keys) == ["version", "runID", "status", "assertions", "sdkCounts", "cases", "domFacts"],
              let facts = row["domFacts"] as? [String: Any],
              Set(facts.keys) == ["logPresent", "outgoingCount", "outgoingAccepted", "composeEmpty", "unavailableNotice", "closedNotice"],
              Self.integer(facts["outgoingCount"], 0...16) != nil,
              ["logPresent", "outgoingAccepted", "composeEmpty", "unavailableNotice", "closedNotice"].allSatisfy({ key in
                  guard let number = facts[key] as? NSNumber else { return false }
                  return CFGetTypeID(number) == CFBooleanGetTypeID()
              }) else { return nil }
        domFacts = facts
#else
        guard Set(row.keys) == ["version", "runID", "status", "assertions", "sdkCounts", "cases"] else { return nil }
        domFacts = nil
#endif
        guard Self.integer(row["version"], 1...1) == 1, row["runID"] as? String == runID,
              let status = row["status"] as? String, ["passed", "failed"].contains(status),
              let assertions = Self.integer(row["assertions"], 0...100),
              status == "failed" || assertions > 0,
              let counts = row["sdkCounts"] as? [String: Any], Set(counts.keys) == ["password", "unexpected"],
              let password = Self.integer(counts["password"], 0...10000),
              let unexpected = Self.integer(counts["unexpected"], 0...10000),
              let cases = row["cases"] as? [String],
              status == "passed" ? cases.count == Self.cases.count && Set(cases) == Set(Self.cases)
                : cases == ["fixture-failed"] else { return nil }
        return Report(passed: status == "passed", assertions: assertions,
            sdkCounts: ["password": password, "unexpected": unexpected], domFacts: domFacts)
    }

    @MainActor func userContentController(_ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage) {
#if E2EE_FULL_APP_UI_FIXTURE
        handleFullAppMessage(userContentController, message: message)
#else
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return }
        let validFrame = message.name == Self.handlerName && message.frameInfo.isMainFrame
            && message.webView === installedWebView
            && message.frameInfo.request.url?.scheme == "capacitor"
            && message.frameInfo.request.url?.host == "localhost"
        guard validFrame else { return } // Never let another document finish this fixture.
        if let row = message.body as? [String: Any],
           Set(row.keys) == ["version", "runID", "status", "phase"],
           Self.integer(row["version"], 1...1) == 1, row["runID"] as? String == runID,
           row["status"] as? String == "progress", let phase = row["phase"] as? String,
           ["script-installed", "dom-ready", "cold-ready", "signed-in", "admission-returned", "pm-opened",
            "pm-sent", "pm-received", "pm-refresh-started"].contains(phase) {
            Self.notePhase(phase)
#if E2EE_PROTECTED_UI_FIXTURE
            // Progress remains a diagnostic, never completion. Keep current
            // counters so timeout evidence does not reuse initial zeros.
            var state: [String: Any] = ["status": "running", "phase": phase]
            if let fixture = protectedFixture { state["fixtureDiagnostics"] = fixture.diagnostics() }
            if let relay = try? ResearchProtectedUiRelay.evidence() { state["relayDiagnostics"] = relay }
            state["pmResultCounters"] = pmResults
            try? writeReceipt(status: "running", assertions: 0, nativeAssertions: 0,
                sdkCounts: nil, cases: [], nativeState: state, initial: false)
#endif
            return // Diagnostic only; no permission, state mutation or completion.
        }
#if E2EE_PROTECTED_UI_FIXTURE
        if let row = message.body as? [String: Any], Set(row.keys) == ["version", "runID", "status", "phase"],
           Self.integer(row["version"], 1...1) == 1, row["runID"] as? String == runID,
           row["status"] as? String == "control", let phase = row["phase"] as? String,
           ["protected-setup", "protected-peer-reply"].contains(phase) {
            startProtectedControl(phase)
            return
        }
#endif
        let supplied = report(message.body)
#if E2EE_PROTECTED_UI_FIXTURE
        guard !finishing else { return }
        if let running = protectedTask {
            // An early terminal report is a failure, not a completed setup.
            // Deny new calls, suspend host credentials and wait for the owned
            // fixture task to quiesce before writing its final counters.
            finishing = true
            running.cancel()
            _ = try? facade?.fenceSession(mode: .verify)
            Task { @MainActor in
                await running.value
                self.finishReport(supplied.map { Report(passed: false, assertions: $0.assertions, sdkCounts: $0.sdkCounts, domFacts: $0.domFacts) })
            }
            return
        }
#endif
        finishReport(supplied)
#endif
    }

    @MainActor private func finishReport(_ supplied: Report?) {
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return }
        completed = true
        do {
            guard let supplied, supplied.passed, supplied.sdkCounts["password"] == 1,
                  supplied.sdkCounts["unexpected"] == 0,
                  Self.allowed.allSatisfy({ (counters[$0] ?? 0) > 0 }),
                  Self.methods.filter({ !Self.allowed.contains($0) }).allSatisfy({ counters[$0] == 0 }),
                  // Cold Directory bootstrap verifies before creating an owner,
                  // then AuthSession verifies that same bearer independently.
                  counters["authenticate"] == 1,
                  counters["unexpectedNativeRequests"] == 0, counters["relayRequests"] == 0,
                  counters["unexpectedMethods"] == 0 else { throw ResearchLocalUiFixtureError.unavailable }
            let state: [String: Any]
            let groups: Int
#if E2EE_PROTECTED_UI_FIXTURE
            guard !protectedControlBusy, protectedSetupStarted, protectedReplyStarted,
                  counters["fixtureSetupControls"] == 1, counters["fixtureReplyControls"] == 1,
                  let fixture = protectedFixture else { throw ResearchLocalUiFixtureError.unavailable }
            state = try fixture.evidence()
            groups = 9
#else
            guard counters["nativeAuthRequests"] == 2, counters["fixtureSetupControls"] == 0,
                  counters["fixtureReplyControls"] == 0 else { throw ResearchLocalUiFixtureError.unavailable }
            state = try nativeState()
            groups = 8
#endif
            try writeReceipt(status: "passed", assertions: supplied.assertions, nativeAssertions: groups,
                sdkCounts: supplied.sdkCounts, cases: Self.cases, nativeState: state, initial: false)
        } catch {
            // Fixed refusal only; never serialize native errors or JS payloads.
            var failedState: [String: Any] = ["status": "unavailable"]
            if let facts = supplied?.domFacts { failedState["domFacts"] = facts }
#if E2EE_PROTECTED_UI_FIXTURE
            if let fixture = protectedFixture { failedState["fixtureDiagnostics"] = fixture.diagnostics() }
            if let relay = try? ResearchProtectedUiRelay.evidence() { failedState["relayDiagnostics"] = relay }
            failedState["pmResultCounters"] = pmResults
#endif
            try? writeReceipt(status: "failed", assertions: supplied?.assertions ?? 0, nativeAssertions: 0,
                sdkCounts: supplied?.sdkCounts,
                cases: ["fixture-failed"], nativeState: failedState, initial: false)
        }
    }

#if E2EE_PROTECTED_UI_FIXTURE
    @MainActor private func startProtectedControl(_ phase: String) {
        increment(phase == "protected-setup" ? "fixtureSetupControls" : "fixtureReplyControls")
        guard !finishing, !protectedControlBusy, let facade, let view = installedWebView else {
            protectedTask?.cancel()
            installedWebView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-protected-ui-step',{detail:{phase:'failed'}}));", completionHandler: nil)
            return
        }
        do {
            let fixture: ResearchProtectedUiFixture
            if phase == "protected-setup" {
                guard !protectedSetupStarted, !protectedReplyStarted else { throw ResearchLocalUiFixtureError.unavailable }
                protectedSetupStarted = true
                fixture = try ResearchProtectedUiFixture(facade: facade); protectedFixture = fixture
            } else {
                guard protectedSetupStarted, !protectedReplyStarted, let prepared = protectedFixture else { throw ResearchLocalUiFixtureError.unavailable }
                protectedReplyStarted = true; fixture = prepared
            }
            protectedControlBusy = true; Self.notePhase(phase)
            let ticket = UUID(); protectedTaskID = ticket
            // Never hold the fixture receipt lock over native async operations.
            protectedTask = Task { @MainActor in
                defer {
                    if self.protectedTaskID == ticket { self.protectedTask = nil; self.protectedTaskID = nil; self.protectedControlBusy = false }
                }
                do {
                    let hostInitiates: Bool?
                    let result: String
                    if phase == "protected-setup" { hostInitiates = try await fixture.prepare(); result = "prepared" }
                    else { try await fixture.peerCatchupAndReply(); hostInitiates = nil; result = "peer-replied" }
                    guard !Task.isCancelled, !self.completed, !self.finishing, self.installedWebView === view else { throw ResearchLocalUiFixtureError.unavailable }
                    self.protectedControlBusy = false; Self.notePhase(result)
                    var detail: [String: Any] = ["phase": result]
                    if let hostInitiates { detail["hostInitiates"] = hostInitiates }
                    let bytes = try JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])
                    guard let json = String(data: bytes, encoding: .utf8) else { throw ResearchLocalUiFixtureError.unavailable }
                    view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-protected-ui-step',{detail:" + json + "}));", completionHandler: nil)
                } catch {
                    self.protectedControlBusy = false; Self.notePhase("protected-control-failed")
                    if !self.finishing { view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-protected-ui-step',{detail:{phase:'failed'}}));", completionHandler: nil) }
                }
            }
        } catch {
            Self.notePhase("protected-control-failed")
            view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-protected-ui-step',{detail:{phase:'failed'}}));", completionHandler: nil)
        }
    }
#endif

    private func nativeState() throws -> [String: Any] {
        guard let facade, let account = facade.currentAccount(), account.serverVerified,
              account.accountId == Self.userID,
              UUID(uuidString: account.deviceId)?.uuidString.lowercased() == account.deviceId else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
        guard snapshot.context.peerGeneration == nil,
              case .privateAdmissionState(.unknown) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .privateAdmissionState),
              case .enrollmentState(let enrollment) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayEnrollmentState),
              case .none = enrollment.registration, case .none = enrollment.claim,
              enrollment.claimedPrekeyExpiresAt == nil,
              case .pairingState(let pairing) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .pairingState),
              pairing.status == .unpaired, pairing.peerGeneration == nil, pairing.confirmedFingerprint == nil,
              pairing.sessionRole == .unpaired, pairing.outgoingCount == 0,
              pairing.incomingCount == 0, pairing.unresolvedCount == 0,
              facade.currentMessageContext(snapshot: snapshot) == snapshot.context else {
            throw ResearchLocalUiFixtureError.unavailable
        }
        return ["accountId": account.accountId, "deviceId": account.deviceId, "selection": "unknown",
            "registration": "none", "claim": "none", "pairing": "unpaired",
            "outgoingCount": 0, "incomingCount": 0, "unresolvedCount": 0]
    }

    private func writeReceipt(status: String, assertions: Int, nativeAssertions: Int,
        sdkCounts: [String: Int]?, cases: [String], nativeState: [String: Any], initial: Bool) throws {
        guard let runID else { throw ResearchLocalUiFixtureError.unavailable }
        let manager = FileManager.default
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = try documents.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directory.isDirectory == true, directory.isSymbolicLink != true else { throw ResearchLocalUiFixtureError.unavailable }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: documents.path)
        let url = documents.appendingPathComponent("research-local-ui-status-" + runID + ".json")
        let body: [String: Any] = ["version": 1, "runID": runID, "status": status,
            "assertions": assertions, "nativeAssertions": nativeAssertions, "sdkCounts": sdkCounts.map { $0 as Any } ?? NSNull(),
            "cases": cases, "nativeCounters": counters, "nativeState": nativeState]
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        if initial {
            guard !manager.fileExists(atPath: url.path) else { throw ResearchLocalUiFixtureError.unavailable }
            try data.write(to: url, options: [.withoutOverwriting, .completeFileProtection])
        } else {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, (1...16384).contains(size),
                  let prior = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
                  prior["runID"] as? String == runID, prior["status"] as? String == "running" else {
                throw ResearchLocalUiFixtureError.unavailable
            }
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var protected = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
    }
}

private final class ResearchLocalUiAuthProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let allowed = request.url?.absoluteString == ResearchAuthConfiguration.origin + "/auth/v1/user"
            && request.httpMethod == "GET" && request.httpBody == nil && request.httpBodyStream == nil
            && request.value(forHTTPHeaderField: "Authorization") == "Bearer " + ResearchLocalUiFixture.bearer
            && request.value(forHTTPHeaderField: "apikey") == ResearchLocalUiFixture.publicApiKey
        ResearchLocalUiFixture.authRequest(allowed: allowed)
        let data = Data(("{\"id\":\"" + ResearchLocalUiFixture.userID + "\"}").utf8)
        guard allowed, let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json", "cache-control": "no-store",
                    "content-length": String(data.count)]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class ResearchLocalUiRelayProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        ResearchLocalUiFixture.relayRequest()
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
#endif
