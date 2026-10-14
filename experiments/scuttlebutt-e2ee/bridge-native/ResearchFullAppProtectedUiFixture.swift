// Separate simulator-only full-root protected scenario. Never compiled together
// with v3 startup or the old protected-page flag; neither receives new authority.
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
import Foundation
import CoreFoundation
import WebKit
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
import CryptoKit
#endif

private enum ResearchFullAppProtectedUiError: Error { case unavailable }

final class ResearchFullAppProtectedUiFixture: NSObject, WKScriptMessageHandler, @unchecked Sendable {
    static let handlerName = "researchFullAppProtectedUiFixture"
    static let scenario = "full-app-native-protected-exchange"
    private static let shared = ResearchFullAppProtectedUiFixture()
    private static let lifecycleAllowed: Set<String> = ["lifecycleState", "acknowledgeClosedPresentation"]
    private static let coldAllowed: Set<String> = ["configuration", "fenceSession", "authenticate", "currentAccount", "messagePrivateAdmission", "lifecycleState", "acknowledgeClosedPresentation"]
    private static let coldRequired = coldAllowed.subtracting(lifecycleAllowed)
    private static let privateAllowed: Set<String> = ["privateMessageIssue", "privateMessageReadiness", "privateMessagePermissions",
        "privateMessageInbox", "privateMessageThread", "privateMessageSendText", "privateMessageRetryPending"]
    private static let methods = ["configuration", "fenceSession", "authenticate", "currentAccount", "lifecycleState", "acknowledgeClosedPresentation", "messageState", "messagePrivateAdmission",
        "messagePairingCard", "messageInspectPeerCard", "messageConfirmPeer", "messageRegisterDevice", "messageClaimPeer", "messageRefreshPolicy",
        "messageRequireProtected", "messageAccountMode", "messageThread", "messagePrepareText", "messageSendPending", "messageSyncInbox",
        "privateMessageIssue", "privateMessageReadiness", "privateMessagePermissions", "privateMessageInbox", "privateMessageThread",
        "privateMessageSendText", "privateMessageRetryPending"]
    private static let cases = ["native-http-refusals", "cold-root-closed", "sdk-native-auth-browse-only", "unknown-admission-no-private-open",
        "explicit-owned-peer-setup", "native-admission-readiness", "actual-app-chat-pm-open", "actual-native-pm-send", "actual-native-pm-receive",
        "dedup-truthful-status", "native-exchange-proof-captured", "synthetic-terminal-pagehide", "fresh-root-no-restored-authority", "final-root-closed"]
    private static let progressPhases = ["script-installed", "dom-ready", "http-refusals", "cold-ready", "signed-in", "unknown-admission", "prepared",
        "admission-ready", "pm-opened", "pm-sent", "peer-replied", "pm-received", "pm-deduped", "native-proof-captured", "terminal-closed", "root-remounted"]
    private static let prefixes = ["script-installed": 0, "dom-ready": 0, "http-refusals": 1, "cold-ready": 2, "signed-in": 3,
        "unknown-admission": 4, "protected-setup": 4, "prepared": 5, "admission-ready": 6, "pm-opened": 7, "pm-sent": 8, "peer-replied": 8,
        "pm-received": 9, "pm-deduped": 10, "native-proof-captured": 11, "terminal-closed": 12, "root-remounted": 13, "fixture-complete": 14]
    private static let domNames = ["actualAppNavigation", "authenticatedNotice", "signedOutNotice", "unknownAdmission", "unavailablePrivateView",
        "stoppedNotice", "messageLogAbsent", "signInEnabled", "privateOpenEnabled", "passwordEmpty", "logPresent", "composeEmpty",
        "encryptionTestLabel", "truthfulIncomingStatus", "truthfulOutgoingStatus", "legacyControlsAbsent"]
    private static let messageNames = ["outgoingRows", "incomingRows", "openerRows", "outgoingAccepted", "incomingReceived", "incomingTimeUnknown",
        "incomingReadUnknown", "outgoingNotDeliveredOrRead", "composeEmpty", "dedupStable"]
    private static let pmNames = ["privateMessagePermissions", "privateMessageInbox", "privateMessageSendText", "privateMessageRetryPending"]
    private let lock = NSRecursiveLock()
    private var runID: String?
    private var nonce: String?
    private var script: String?
    private weak var facade: VodozemacSessionFacade?
    private weak var view: WKWebView?
    private var httpFence: ResearchFullAppProtectedHttpFenceAttachment?
    private var original: DmNativeMessageSnapshot?
    private var originalFenceCount: Int?
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
    static let sceneFinishStageEvidence = ResearchSceneFinishStageEvidence()
    static let sceneAuthorityTimingEvidence = ResearchSceneAuthorityTimingEvidence()
    private var sceneFinishInput: (ResearchSceneFinishStageEvidence.Callsite,
                                   ResearchSceneFinishStageEvidence.NativeValidationBoundary?)?
#endif
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
    // Separate from attempted plugin-method counters. Never reset during a run.
    private var sceneVerifyFenceCompletions: Int? = 0
    private var sceneProtectedResourceSHA256: String?
#endif
    private var counters = Dictionary(uniqueKeysWithValues: (ResearchFullAppProtectedUiFixture.methods +
        ["nativeAuthRequests", "unexpectedNativeRequests", "relayRequests", "unexpectedMethods", "fixtureSetupControls", "fixtureReplyControls"]).map { ($0, 0) })
    private var pmResults = Dictionary(uniqueKeysWithValues: ResearchFullAppProtectedUiFixture.pmNames.flatMap { method in
        ["ok", "unavailable"].map { (method + ":" + $0, 0) } })
    private var helper: ResearchProtectedUiFixture?
    private var setupComplete = false
    private var replyComplete = false
    private var controlBusy = false
    private var controlTask: Task<Void, Never>?
    private var controlTicket: UUID?
    private var capturedProof: [String: Any]?
    private var receivedInboxCount: Int?
    private var receivedThreadCount: Int?
    private var progressIndex = 0
    private var terminal = false
    private var finalizing = false
    private var completed = false
    private override init() { super.init() }

    static func requireResource() throws { try shared.loadResource() }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
    static func sceneResourceBinding() throws -> (runID: String, nonce: String, resourceSHA256: String) {
        try shared.loadResource(); shared.lock.lock(); defer { shared.lock.unlock() }
        guard let runID = shared.runID, let nonce = shared.nonce, let hash = shared.sceneProtectedResourceSHA256 else { throw ResearchFullAppProtectedUiError.unavailable }
        return (runID, nonce, hash)
    }
    static func noteSceneVerifyCompletion(_ candidate: VodozemacSessionFacade) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard shared.facade === candidate, let count = shared.sceneVerifyFenceCompletions else { return }
        // Overflow becomes unknown/refused evidence, never a fabricated total.
        shared.sceneVerifyFenceCompletions = count < 10000 ? count + 1 : nil
#if targetEnvironment(simulator)
        noteSceneTiming(.verifyCompleted)
#endif
    }
    @MainActor static func sceneAuthorityFacts() -> ResearchSceneLifecycleEvidence.AuthorityFacts {
        shared.lock.lock()
        let facade = shared.facade, original = shared.original, completions = shared.sceneVerifyFenceCompletions
        shared.lock.unlock()
        guard let facade else {
#if targetEnvironment(simulator)
            noteSceneAuthorityUnavailable()
#endif
            return .unavailable
        }
        let accountPresent = facade.currentAccount() != nil
        let current = original.map { facade.currentMessageContext(snapshot: $0) == $0.context }
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard shared.facade === facade, shared.original?.context == original?.context,
              shared.sceneVerifyFenceCompletions == completions else {
#if targetEnvironment(simulator)
            noteSceneAuthorityUnavailable()
#endif
            return .unavailable
        }
#if targetEnvironment(simulator)
        // Reuse only the ORIGINAL getter results above. No new account,
        // snapshot, credential or authority lookup is performed for timing.
        noteSceneTiming(.authorityObserved, accountPresent: accountPresent, originalCurrent: current)
#endif
        return .init(observationStatus: .observed, facadeObserved: true,
            originalSnapshotObserved: original != nil, accountPresent: accountPresent,
            originalSnapshotCurrent: current, verifyFenceCompletions: completions)
    }
#if targetEnvironment(simulator)
    private static func noteSceneAuthorityUnavailable() {
        shared.lock.lock(); defer { shared.lock.unlock() }
        sceneAuthorityTimingEvidence.record(.authorityUnavailable, fenceAttempts: shared.counters["fenceSession"],
            verifyCompletions: shared.sceneVerifyFenceCompletions,
            facadeObserved: false, originalObserved: false)
    }
    private static func noteSceneTiming(_ phase: ResearchSceneAuthorityTimingEvidence.Phase,
                                        accountPresent: Bool? = nil, originalCurrent: Bool? = nil) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        sceneAuthorityTimingEvidence.record(phase, fenceAttempts: shared.counters["fenceSession"],
            verifyCompletions: shared.sceneVerifyFenceCompletions,
            facadeObserved: shared.facade != nil, originalObserved: shared.original != nil,
            accountPresent: accountPresent, originalCurrent: originalCurrent)
    }
#endif
    @MainActor static func sceneWindowEvidence(_ raw: Any?, runID: String) throws -> [String: Any] {
        guard let window = try fullAppWindow(raw, runID: runID) else { throw ResearchFullAppProtectedUiError.unavailable }
        return window
    }
    @MainActor static func sceneClosureEvidence() throws -> [String: Any] {
        shared.lock.lock(); defer { shared.lock.unlock() }
        guard let resourceHash = shared.sceneProtectedResourceSHA256, let proof = shared.capturedProof else { throw ResearchFullAppProtectedUiError.unavailable }
        // Hash the original sanitized proof only; never recollect helper.evidence.
        let proofBytes = try JSONSerialization.data(withJSONObject: proof, options: [.sortedKeys])
        let proofHash = SHA256.hash(data: proofBytes).map { String(format: "%02x", $0) }.joined()
        let native = try counts(shared.copiedCounters(), methods + ["nativeAuthRequests", "unexpectedNativeRequests", "relayRequests", "unexpectedMethods", "fixtureSetupControls", "fixtureReplyControls"])
        let pm = try counts(shared.pmResults, pmNames.flatMap { method in ["ok", "unavailable"].map { method + ":" + $0 } })
        let relay = try ResearchProtectedUiRelay.evidence()
        let live = try counts(relay["methodCounters"], ["auth", "register", "dispatch", "unexpected"])
        return ["protectedResourceSHA256": resourceHash, "protectedProofSHA256": proofHash,
            "nativeCounters": native, "pmResultCounters": pm, "relayCounters": live]
    }
#endif
    private func loadResource() throws {
        lock.lock(); defer { lock.unlock() }
        if runID != nil, nonce != nil, script != nil { return }
#if targetEnvironment(simulator)
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              let url = Bundle.main.url(forResource: "research-local-ui-fixture", withExtension: "json") else { throw ResearchFullAppProtectedUiError.unavailable }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, (1...131072).contains(size) else { throw ResearchFullAppProtectedUiError.unavailable }
        let data = try Data(contentsOf: url), row = try Self.row(JSONSerialization.jsonObject(with: data), ["version", "runID", "nonce", "scenario", "script"])
        guard Self.integer(row["version"], 4...4) == 4, row["scenario"] as? String == Self.scenario,
              let id = row["runID"] as? String, Self.identifier(id), let n = row["nonce"] as? String, Self.digest(n),
              let source = row["script"] as? String, (1...65536).contains(source.utf8.count),
              source.contains("const runID = '" + id + "'"), source.contains("const nonce = '" + n + "'"),
              !source.contains("__RESEARCH_FULL_APP_PROTECTED_RUN_ID__"), !source.contains("__RESEARCH_FULL_APP_PROTECTED_NONCE__") else { throw ResearchFullAppProtectedUiError.unavailable }
        guard source.components(separatedBy: "const sceneLifecycleProof = ").count == 2 else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        guard source.contains("const sceneLifecycleProof = true;"), !source.contains("const sceneLifecycleProof = false;") else { throw ResearchFullAppProtectedUiError.unavailable }
#else
        guard source.contains("const sceneLifecycleProof = false;"), !source.contains("const sceneLifecycleProof = true;") else { throw ResearchFullAppProtectedUiError.unavailable }
#endif
        runID = id; nonce = n; script = source
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        sceneProtectedResourceSHA256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
#endif
#else
        throw ResearchFullAppProtectedUiError.unavailable
#endif
    }
    static func attach(_ candidate: VodozemacSessionFacade) throws {
        try shared.loadResource(); shared.lock.lock(); defer { shared.lock.unlock() }
        guard shared.facade == nil || shared.facade === candidate else { throw ResearchFullAppProtectedUiError.unavailable }
        shared.facade = candidate
    }
    static func allow(method: String) -> Bool {
        shared.lock.lock(); defer { shared.lock.unlock() }
        if shared.counters[method] != nil { shared.counters[method] = min(10000, (shared.counters[method] ?? 0) + 1) }
        else { shared.counters["unexpectedMethods"] = min(10000, (shared.counters["unexpectedMethods"] ?? 0) + 1); return false }
        guard shared.runID != nil, !shared.completed else { return false }
        if shared.finalizing { return method == "fenceSession" || lifecycleAllowed.contains(method) }
        if shared.terminal { return ["configuration", "fenceSession", "currentAccount"].contains(method) || lifecycleAllowed.contains(method) }
        if coldAllowed.contains(method) { return true }
        guard privateAllowed.contains(method), shared.setupComplete, !shared.controlBusy,
              let original = shared.original, let facade = shared.facade,
              facade.currentMessageContext(snapshot: original) == original.context else {
            shared.counters["unexpectedMethods"] = min(10000, (shared.counters["unexpectedMethods"] ?? 0) + 1); return false
        }
        // This narrows fixture dispatch only. The actual native adapter still
        // issues/checks sealed admission, lifecycle, owner, peer and permissions.
        return true
    }
    static func notePmResult(method: String, status: String) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        let key = method + ":" + status
        if let old = shared.pmResults[key] { shared.pmResults[key] = min(10000, old + 1) }
    }
    static func notePhase(_ phase: String) {
#if targetEnvironment(simulator)
        let phases = progressPhases + ["application-launched", "scene-connected", "bridge-created", "fixture-installed", "fixture-install-failed",
            "protected-setup", "protected-peer-reply", "capture-proof", "protected-control-failed", "fixture-complete", "fixture-failed"]
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID, phases.contains(phase) else { return }
        do {
            let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "phase": phase], options: [.sortedKeys])
            let url = documents.appendingPathComponent("research-full-app-protected-ui-phase.json")
            try data.write(to: url, options: [.atomic, .completeFileProtection]); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { /* No error/options/identity data crosses this diagnostic. */ }
#endif
    }
    private static func identifier(_ v: String) -> Bool { v.utf8.count == 36 && UUID(uuidString: v)?.uuidString.lowercased() == v }
    private static func digest(_ v: String) -> Bool { v.utf8.count == 64 && v.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private static func integer(_ value: Any?, _ range: ClosedRange<Int>) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue == Double(n.intValue), range.contains(n.intValue) else { return nil }; return n.intValue
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
    }
    private static func row(_ value: Any?, _ names: [String]) throws -> [String: Any] {
        guard let r = value as? [String: Any], Set(r.keys) == Set(names) else { throw ResearchFullAppProtectedUiError.unavailable }; return r
    }
    private static func counts(_ value: Any?, _ names: [String], limit: Int = 10000) throws -> [String: Int] {
        let r = try row(value, names); return try Dictionary(uniqueKeysWithValues: names.map { name in
            guard let n = integer(r[name], 0...limit) else { throw ResearchFullAppProtectedUiError.unavailable }; return (name, n) })
    }
    private static func booleans(_ value: Any?, _ names: [String]) throws -> [String: Bool] {
        let r = try row(value, names); return try Dictionary(uniqueKeysWithValues: names.map { name in
            guard let b = boolean(r[name]) else { throw ResearchFullAppProtectedUiError.unavailable }; return (name, b) })
    }
    private struct Report {
        let status: String, phase: String
        let assertions: Int
        let sdkCounts: [String: Int], cases: [String]
        let window: [String: Any]?
        let dom: [String: Bool], messages: [String: Any]
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
            throw ResearchFullAppProtectedUiError.unavailable
        }
        return row
    }

    private static func fullAppCounts(_ value: Any?, _ names: [String], limit: Int = 10000) throws -> [String: Int] {
        let row = try fullAppRow(value, names)
        return try Dictionary(uniqueKeysWithValues: names.map { key in
            guard let number = integer(row[key], 0...limit) else { throw ResearchFullAppProtectedUiError.unavailable }
            return (key, number)
        })
    }

    private static func fullAppNullableBoolean(_ value: Any?) throws -> Any {
        if value is NSNull { return NSNull() }
        guard let boolean = fullAppBoolean(value) else { throw ResearchFullAppProtectedUiError.unavailable }
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
            throw ResearchFullAppProtectedUiError.unavailable
        }
        let fence: Any
        if row["fence"] is NSNull { fence = NSNull() }
        else {
            let item = try fullAppRow(row["fence"], ["version", "status", "counts"])
            guard integer(item["version"], 1...1) == 1, let status = item["status"] as? String,
                  ["uninstalled", "installed", "failed"].contains(status) else { throw ResearchFullAppProtectedUiError.unavailable }
            fence = ["version": 1, "status": status, "counts": try fullAppCounts(item["counts"], fullAppFenceNames)] as [String: Any]
        }
        let auth = try fullAppRow(row["auth"], ["status", "userPresent", "authChecked"])
        guard let authStatus = auth["status"] as? String,
              ["unknown", "unsupported", "unavailable", "signed_out", "verifying", "authenticated", "detached", "inactive"].contains(authStatus) else {
            throw ResearchFullAppProtectedUiError.unavailable
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
                guard let generation = integer(scope[key], 0...10000) else { throw ResearchFullAppProtectedUiError.unavailable }
                copiedScope[key] = generation
            }
        }
        let selection: Any
        if row["privateSelection"] is NSNull { selection = NSNull() }
        else {
            guard let name = row["privateSelection"] as? String, ["native-unavailable", "native-pilot"].contains(name) else {
                throw ResearchFullAppProtectedUiError.unavailable
            }
            selection = name
        }
        let core: Any
        if row["core"] is NSNull { core = NSNull() }
        else {
            let item = try fullAppRow(row["core"], ["registrationAttempts", "methodAttempts", "platform"])
            guard let platform = item["platform"] as? String, ["web", "ios"].contains(platform),
                  let registration = integer(item["registrationAttempts"], 0...1024),
                  let methods = integer(item["methodAttempts"], 0...1024) else { throw ResearchFullAppProtectedUiError.unavailable }
            core = ["registrationAttempts": registration, "methodAttempts": methods, "platform": platform] as [String: Any]
        }
        let lifecycle = try fullAppRow(row["lifecycle"], ["stopped"])
        guard let stopped = fullAppBoolean(lifecycle["stopped"]) else { throw ResearchFullAppProtectedUiError.unavailable }
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

    private func parse(_ value: Any) throws -> Report {
        let r = try Self.row(value, ["version", "runID", "nonce", "scenario", "status", "phase", "assertions", "sdkCounts", "cases",
            "windowEvidence", "domFacts", "messageFacts", "syntheticPagehide", "realOsLifecycleOrBfCacheProved"])
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        let syntheticPagehide = false
#else
        let syntheticPagehide = true
#endif
        guard let runID, let nonce, Self.integer(r["version"], 3...3) == 3, r["runID"] as? String == runID,
              r["nonce"] as? String == nonce, r["scenario"] as? String == Self.scenario,
              let status = r["status"] as? String, ["progress", "control", "passed", "failed"].contains(status),
              let phase = r["phase"] as? String, let a = Self.integer(r["assertions"], 0...10000),
              Self.boolean(r["syntheticPagehide"]) == syntheticPagehide, Self.boolean(r["realOsLifecycleOrBfCacheProved"]) == false,
              let cases = r["cases"] as? [String] else { throw ResearchFullAppProtectedUiError.unavailable }
        if status == "failed" { guard phase == "fixture-failed", cases == ["fixture-failed"] else { throw ResearchFullAppProtectedUiError.unavailable } }
        else {
            let expected: Int?
            if phase == "protected-peer-reply" { expected = 8 }
            else if phase == "capture-proof" { expected = 10 }
            else { expected = Self.prefixes[phase] }
            guard let expected, cases == Array(Self.cases.prefix(expected)),
                  status != "passed" || (phase == "fixture-complete" && a > 0),
                  status != "control" || ["protected-setup", "protected-peer-reply", "capture-proof"].contains(phase),
                  status != "progress" || Self.progressPhases.contains(phase) else { throw ResearchFullAppProtectedUiError.unavailable }
        }
        let messages = try Self.row(r["messageFacts"], Self.messageNames)
        guard Self.integer(messages["outgoingRows"], 0...1) != nil, Self.integer(messages["incomingRows"], 0...2) != nil,
              Self.integer(messages["openerRows"], 0...1) != nil else { throw ResearchFullAppProtectedUiError.unavailable }
        for key in Self.messageNames.dropFirst(3) { guard Self.boolean(messages[key]) != nil else { throw ResearchFullAppProtectedUiError.unavailable } }
        return Report(status: status, phase: phase, assertions: a, sdkCounts: try Self.counts(r["sdkCounts"], ["password", "unexpected"]),
            cases: cases, window: try Self.fullAppWindow(r["windowEvidence"], runID: runID), dom: try Self.booleans(r["domFacts"], Self.domNames), messages: messages)
    }
    @MainActor static func install(in webView: WKWebView, httpFence: ResearchFullAppProtectedHttpFenceAttachment) throws {
        try shared.loadResource()
        guard shared.view == nil, shared.httpFence == nil, let source = shared.script, webView.url == nil, !webView.isLoading else { throw ResearchFullAppProtectedUiError.unavailable }
        shared.httpFence = httpFence
        _ = try shared.httpEvidence(challenge: false, zero: true)
        try shared.write(status: "running", phase: "fixture-installed", report: nil, nativeAssertions: 0, state: ["status": "unavailable"], initial: true)
        webView.configuration.userContentController.add(shared, name: handlerName)
        webView.configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        shared.view = webView
    }
    @MainActor private func httpEvidence(challenge: Bool, zero: Bool = false) throws -> [String: Any] {
        guard let httpFence else { throw ResearchFullAppProtectedUiError.unavailable }
        let r = try Self.row(httpFence.copiedEvidence(), ["version", "status", "primaryCurrent", "classAliasCurrent", "observedDefaultMethodCount", "primaryCounts", "classAliasCounts"])
        guard Self.integer(r["version"], 1...1) == 1, r["status"] as? String == "installed", Self.boolean(r["primaryCurrent"]) == true,
              Self.boolean(r["classAliasCurrent"]) == true, Self.integer(r["observedDefaultMethodCount"], 6...6) == 6 else { throw ResearchFullAppProtectedUiError.unavailable }
        for route in ["primaryCounts", "classAliasCounts"] {
            let c = try Self.counts(r[route], ["request", "get", "post", "put", "patch", "delete", "addListener", "removeListener"])
            guard c["addListener"] == 0, c["removeListener"] == 0,
                  ["request", "get", "post", "put", "patch", "delete"].allSatisfy({ c[$0] == (challenge ? 1 : zero ? 0 : c[$0]) && (c[$0] ?? 2) <= 1 }) else { throw ResearchFullAppProtectedUiError.unavailable }
        }
        return r
    }
    private func copiedCounters() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        var result = counters
        if let relay = try? ResearchProtectedUiRelay.evidence(), let auth = relay["authCounters"] as? [String: Int] { result["nativeAuthRequests"] = auth["host"] ?? 0 }
        return result
    }
    @MainActor private func captureOriginal() throws {
        guard let facade, let account = facade.currentAccount(), account.serverVerified, account.accountId == ResearchLocalUiFixture.userID else { throw ResearchFullAppProtectedUiError.unavailable }
        let snapshot = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
        guard case .privateAdmissionState(.unknown) = try facade.executeMessageOperation(snapshot: snapshot, operation: .privateAdmissionState),
              case .enrollmentState(let enrollment) = try facade.executeMessageOperation(snapshot: snapshot, operation: .relayEnrollmentState),
              case .none = enrollment.registration, case .none = enrollment.claim,
              case .pairingState(let pair) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingState), pair.status == .unpaired,
              facade.currentMessageContext(snapshot: snapshot) == snapshot.context else { throw ResearchFullAppProtectedUiError.unavailable }
        if let original {
            guard facade.currentMessageContext(snapshot: original) == original.context else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            Self.noteSceneTiming(.originalRechecked, accountPresent: true, originalCurrent: true)
#endif
        } else {
            lock.lock(); original = snapshot; originalFenceCount = copiedCounters()["fenceSession"]; lock.unlock()
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            Self.noteSceneTiming(.originalCaptured, accountPresent: true, originalCurrent: true)
#endif
        }
    }
    @MainActor private func fenced() -> Bool {
        guard let facade, let original, let baseline = originalFenceCount, (copiedCounters()["fenceSession"] ?? 0) > baseline else { return false }
        return facade.currentAccount() == nil && facade.currentMessageContext(snapshot: original) == nil
    }
    @MainActor private func common(_ report: Report) throws {
        guard let w = report.window, let f = w["fence"] as? [String: Any], f["status"] as? String == "installed",
              let c = f["counts"] as? [String: Int], c["patchFailures"] == 0,
              let sdk = w["sdk"] as? [String: Int], let root = w["root"] as? [String: Int],
              let auth = w["auth"] as? [String: Any], Self.boolean(auth["userPresent"]) == false, Self.boolean(auth["authChecked"]) == true,
              let scope = w["authScope"] as? [String: Any], Self.boolean(scope["originalUserPresent"]) == false, Self.boolean(scope["originalAnonymous"]) == true,
              w["phase"] as? String == "ready", Self.boolean(w["legacyPermitAvailable"]) == false,
              let core = w["core"] as? [String: Any], core["platform"] as? String == "ios",
              w["boundaries"] is [String: Int], w["memory"] is [String: Int] else { throw ResearchFullAppProtectedUiError.unavailable }
        let p = Self.prefixes[report.phase] ?? (report.phase == "protected-peer-reply" ? 8 : 10)
        let mounts = p >= 13 ? 2 : 1, password = p >= 3 ? 1 : 0
        guard sdk["runtimeCreations"] == mounts, sdk["sdkConstructions"] == mounts, (sdk["nativeCalls"] ?? 0) > 0,
              root["mounts"] == mounts, root["remounts"] == (p >= 13 ? 1 : 0), (root["closedRenders"] ?? 0) >= mounts,
              c["authRequests"] == password, c["authResponses"] == password, c["authRefused"] == 0,
              report.sdkCounts["password"] == password, report.sdkCounts["unexpected"] == 0,
              ["fetch", "xhr", "webSocket", "eventSource", "beacon", "preservedFetch", "preservedXhr", "worker", "sharedWorker", "serviceWorker", "otherNetwork"].allSatisfy({ c[$0] == 0 }),
              report.dom["actualAppNavigation"] == true, report.dom["passwordEmpty"] == true, report.dom["legacyControlsAbsent"] == true else { throw ResearchFullAppProtectedUiError.unavailable }
        let active = (3...11).contains(p), selection = (6...11).contains(p) ? "native-pilot" : "native-unavailable"
        let authStatus = active ? "authenticated" : [12,14].contains(p) ? "inactive" : "signed_out"
        guard auth["status"] as? String == authStatus, w["privateSelection"] as? String == selection else { throw ResearchFullAppProtectedUiError.unavailable }
        if active { guard report.dom["authenticatedNotice"] == true, Self.boolean(scope["currentUserPresent"]) == true, Self.boolean(scope["currentAnonymous"]) == false else { throw ResearchFullAppProtectedUiError.unavailable } }
        else { guard report.dom["privateOpenEnabled"] == false, Self.boolean(scope["currentUserPresent"]) == false, Self.boolean(scope["currentAnonymous"]) == true else { throw ResearchFullAppProtectedUiError.unavailable } }
        if p < 6 || p >= 12 { guard report.dom["unavailablePrivateView"] == true, report.dom["messageLogAbsent"] == true, report.dom["logPresent"] == false else { throw ResearchFullAppProtectedUiError.unavailable } }
        if (7...11).contains(p) { guard report.dom["logPresent"] == true, report.dom["encryptionTestLabel"] == true else { throw ResearchFullAppProtectedUiError.unavailable } }
        if [12,14].contains(p) { guard let l = w["lifecycle"] as? [String: Any], Self.boolean(l["stopped"]) == true, report.dom["stoppedNotice"] == true else { throw ResearchFullAppProtectedUiError.unavailable } }
    }
    @MainActor func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !completed, !finalizing, let view, controller === view.configuration.userContentController,
              message.name == Self.handlerName, message.frameInfo.isMainFrame, message.webView === view,
              let url = message.frameInfo.request.url, url.scheme == "capacitor", url.host == "localhost", url.user == nil, url.password == nil,
              url.port == nil, url.fragment == nil || url.fragment == "", let report = try? parse(message.body) else { return }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
        var nativeBoundary: ResearchSceneFinishStageEvidence.NativeValidationBoundary? = nil
#endif
        do {
            if report.status == "failed" {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                sceneFinishInput = (.javascriptFailed, nil)
#endif
                finish(report, passing: false); return
            }
            if report.status == "control" {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                nativeBoundary = .common
#endif
                try common(report)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                nativeBoundary = .control
#endif
                try control(report); return
            }
            if report.status == "passed" {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                nativeBoundary = .progressOrder
#endif
                guard progressIndex == Self.progressPhases.count else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                nativeBoundary = .common
#endif
                try common(report); finish(report, passing: true); return
            }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            nativeBoundary = .progressOrder
#endif
            guard progressIndex < Self.progressPhases.count, report.phase == Self.progressPhases[progressIndex] else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            nativeBoundary = .http
#endif
            _ = try httpEvidence(challenge: progressIndex >= 2)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            if progressIndex >= 3 { nativeBoundary = .common }
#endif
            if progressIndex >= 3 { try common(report) }
            if ["signed-in", "unknown-admission"].contains(report.phase) { try captureOriginal() }
            if report.phase == "pm-received" {
                lock.lock(); defer { lock.unlock() }
                guard receivedInboxCount == nil, receivedThreadCount == nil,
                      let inbox = pmResults["privateMessageInbox:ok"], inbox >= 2,
                      let thread = counters["privateMessageThread"], thread > 0 else { throw ResearchFullAppProtectedUiError.unavailable }
                receivedInboxCount = inbox; receivedThreadCount = thread
            }
            if report.phase == "pm-deduped" {
                lock.lock(); defer { lock.unlock() }
                guard let inbox = receivedInboxCount, let thread = receivedThreadCount,
                      pmResults["privateMessageInbox:ok"] == inbox + 1,
                      counters["privateMessageThread"] == thread + 1,
                      Self.boolean(report.messages["dedupStable"]) == true else { throw ResearchFullAppProtectedUiError.unavailable }
            }
            if report.phase == "native-proof-captured" {
                guard capturedProof != nil else { throw ResearchFullAppProtectedUiError.unavailable }
            }
            if report.phase == "terminal-closed" { guard capturedProof != nil else { throw ResearchFullAppProtectedUiError.unavailable }; lock.lock(); terminal = true; lock.unlock() }
            progressIndex += 1; Self.notePhase(report.phase)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            nativeBoundary = .write
#endif
            try write(status: "running", phase: report.phase, report: report, nativeAssertions: 0,
                state: fenced() ? ["status": "credential-fenced", "accountPresent": false, "originalSnapshotCurrent": false] : ["status": "running"], initial: false)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
            // Persist the real protected prefix before announcing readiness to
            // the lifecycle driver/JS. No stale earlier prefix can authorize it.
            if report.phase == "native-proof-captured" {
#if targetEnvironment(simulator)
                Self.noteSceneTiming(.protectedReport)
                nativeBoundary = .protectedReady
#endif
                try ResearchFullAppSceneUiFixture.protectedReady()
            }
#endif
        } catch {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
            sceneFinishInput = (.nativeReceiveRefused, nativeBoundary)
#endif
            finish(report, passing: false)
        }
    }
    @MainActor private func control(_ report: Report) throws {
        guard !terminal, !controlBusy, let facade, let view, let original, facade.currentMessageContext(snapshot: original) == original.context else { throw ResearchFullAppProtectedUiError.unavailable }
        let expected = report.phase == "protected-setup" ? "prepared" : report.phase == "protected-peer-reply" ? "peer-replied" : "native-proof-captured"
        guard progressIndex < Self.progressPhases.count, Self.progressPhases[progressIndex] == expected else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
        Self.noteSceneTiming(report.phase == "protected-setup" ? .protectedSetup : report.phase == "protected-peer-reply" ? .peerReply : .proofCaptured,
            originalCurrent: true)
#endif
        if report.phase == "capture-proof" {
            guard setupComplete, replyComplete, capturedProof == nil, let helper else { throw ResearchFullAppProtectedUiError.unavailable }
            capturedProof = try sanitizedExchange(helper.evidence())
            try write(status: "running", phase: "pm-deduped", report: report, nativeAssertions: 0, state: ["status": "running"], initial: false)
            step("proof-captured", on: view); return
        }
        if report.phase == "protected-setup" {
            guard helper == nil, !setupComplete else { throw ResearchFullAppProtectedUiError.unavailable }
            helper = try ResearchProtectedUiFixture(facade: facade); counters["fixtureSetupControls"] = 1
        } else { guard setupComplete, !replyComplete else { throw ResearchFullAppProtectedUiError.unavailable }; counters["fixtureReplyControls"] = 1 }
        guard let helper else { throw ResearchFullAppProtectedUiError.unavailable }
        let ticket = UUID(); controlTicket = ticket; lock.lock(); controlBusy = true; lock.unlock(); Self.notePhase(report.phase)
        controlTask = Task { @MainActor in
            defer { if self.controlTicket == ticket { self.controlTask = nil; self.controlTicket = nil; self.lock.lock(); self.controlBusy = false; self.lock.unlock() } }
            do {
                let initiates: Bool?
                if report.phase == "protected-setup" { initiates = try await helper.prepare() }
                else { try await helper.peerCatchupAndReply(); initiates = nil }
                guard !Task.isCancelled, !self.completed, !self.finalizing, self.view === view, self.controlTicket == ticket else { throw ResearchFullAppProtectedUiError.unavailable }
                self.lock.lock()
                if report.phase == "protected-setup" { self.setupComplete = true }
                else { self.replyComplete = true }
                self.controlBusy = false
                self.lock.unlock()
                self.step(initiates == nil ? "peer-replied" : "prepared", on: view, initiates: initiates)
            } catch { self.lock.lock(); self.controlBusy = false; self.lock.unlock(); Self.notePhase("protected-control-failed"); self.step("failed", on: view) }
        }
    }
    @MainActor private func step(_ phase: String, on view: WKWebView, initiates: Bool? = nil) {
        var detail: [String: Any] = ["phase": phase]; if let initiates { detail["hostInitiates"] = initiates }
        guard let bytes = try? JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys]), let json = String(data: bytes, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-full-app-protected-ui-step',{detail:" + json + "}));", completionHandler: nil)
    }
    private func sanitizedExchange(_ raw: [String: Any]) throws -> [String: Any] {
        var result = try Self.row(raw, ["version", "status", "hostInitiates", "originalHostBindingStillCurrent", "originalPeerBindingStillCurrent", "host", "peer",
            "uiOutgoingEnvelopeSHA256", "peerReplyEnvelopeSHA256", "peerOpenerEnvelopeSHA256", "nativeAssertions", "nativeCalls", "relay", "syntheticAuthAndRelay", "physicalDeviceExecution"])
        guard result["status"] as? String == "passed", Self.boolean(result["originalHostBindingStillCurrent"]) == true,
              Self.boolean(result["originalPeerBindingStillCurrent"]) == true else { throw ResearchFullAppProtectedUiError.unavailable }
        for key in ["host", "peer"] {
            var actor = try Self.row(result[key], ["accountId", "deviceId", "selection", "registration", "claim", "pairing", "initialRole", "sessionRole", "fullFingerprintStillConfirmed", "outgoingCount", "incomingCount", "unresolvedCount"])
            actor.removeValue(forKey: "accountId"); actor.removeValue(forKey: "deviceId"); result[key] = actor
        }
        result["capturedBeforeTerminal"] = true
        return result
    }
    @MainActor private func finish(_ report: Report, passing: Bool) {
        guard !completed, !finalizing else { return }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
        // Fixed admitted values only, selected after the ORIGINAL finish guard.
        // No Report, error or credential is retained by this passive recorder.
        let callsite = passing ? ResearchSceneFinishStageEvidence.Callsite.javascriptPassed : sceneFinishInput?.0
        if let callsite {
            _ = Self.sceneFinishStageEvidence.selectNativeFinish(callsiteName: callsite.rawValue,
                lastNativeValidationBoundaryName: passing ? "final" : sceneFinishInput?.1?.rawValue,
                admittedReportPhaseName: report.phase)
        }
        sceneFinishInput = nil
#endif
        lock.lock(); finalizing = true; terminal = true; lock.unlock()
        let active = controlTask; active?.cancel()
        Task { @MainActor in
            if let active { await active.value }
            defer {
                self.lock.lock(); self.original = nil; self.originalFenceCount = nil; self.lock.unlock()
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
                Self.noteSceneTiming(.originalCleared)
                ResearchFullAppSceneUiFixture.persistAuthorityTimingDiagnostic()
#endif
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while !self.fenced(), ContinuousClock.now < deadline { try? await Task.sleep(nanoseconds: 25_000_000) }
            do {
                guard passing, self.fenced(), self.capturedProof != nil, self.setupComplete, self.replyComplete,
                      report.sdkCounts["password"] == 1, report.sdkCounts["unexpected"] == 0 else { throw ResearchFullAppProtectedUiError.unavailable }
                let c = self.copiedCounters(), required = Self.coldRequired.union(Self.privateAllowed.subtracting(["privateMessageRetryPending"]))
                guard required.allSatisfy({ (c[$0] ?? 0) > 0 }), c["authenticate"] == 1, c["nativeAuthRequests"] == 2,
                      c["unexpectedNativeRequests"] == 0, c["relayRequests"] == 0, c["unexpectedMethods"] == 0,
                      c["fixtureSetupControls"] == 1, c["fixtureReplyControls"] == 1,
                      Self.methods.filter({ !required.contains($0) && !Self.lifecycleAllowed.contains($0) && $0 != "privateMessageRetryPending" }).allSatisfy({ c[$0] == 0 }),
                      self.pmResults["privateMessageSendText:ok"] == 1, (self.pmResults["privateMessagePermissions:ok"] ?? 0) > 0,
                      (self.pmResults["privateMessageInbox:ok"] ?? 0) >= 3 else { throw ResearchFullAppProtectedUiError.unavailable }
                _ = try self.httpEvidence(challenge: true); try self.common(report)
                try self.write(status: "passed", phase: "fixture-complete", report: report, nativeAssertions: 12,
                    state: ["status": "credential-fenced", "accountPresent": false, "originalSnapshotCurrent": false], initial: false)
                self.lock.lock(); self.completed = true; self.lock.unlock(); Self.notePhase("fixture-complete")
            } catch {
                try? self.write(status: "failed", phase: "fixture-failed", report: report, nativeAssertions: 0,
                    state: self.fenced() ? ["status": "credential-fenced", "accountPresent": false, "originalSnapshotCurrent": false] : ["status": "unavailable"], initial: false)
                self.lock.lock(); self.completed = true; self.lock.unlock(); Self.notePhase("fixture-failed")
            }
        }
    }
    @MainActor private func write(status: String, phase: String, report: Report?, nativeAssertions: Int, state: [String: Any], initial: Bool) throws {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
        ResearchFullAppSceneUiFixture.persistFirstInboxDiagnostic()
        ResearchFullAppSceneUiFixture.persistSceneFinishDiagnostic()
        ResearchFullAppSceneUiFixture.persistAuthorityTimingDiagnostic()
#endif
        guard let runID, let nonce else { throw ResearchFullAppProtectedUiError.unavailable }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        let syntheticPagehide = false
#else
        let syntheticPagehide = true
#endif
        let body: [String: Any] = ["version": 3, "runID": runID, "nonce": nonce, "scenario": Self.scenario, "status": status, "phase": phase,
            "assertions": report?.assertions ?? 0, "nativeAssertions": nativeAssertions, "sdkCounts": report.map { $0.sdkCounts as Any } ?? NSNull(),
            "cases": status == "failed" ? ["fixture-failed"] : report?.cases ?? [], "nativeCounters": copiedCounters(), "nativeState": state,
            "nativeHttpFence": httpFence.map { $0.copiedEvidence() as Any } ?? NSNull(), "windowEvidence": report?.window.map { $0 as Any } ?? NSNull(),
            "domFacts": report.map { $0.dom as Any } ?? NSNull(), "messageFacts": report.map { $0.messages as Any } ?? NSNull(),
            "protectedExchange": capturedProof.map { $0 as Any } ?? NSNull(), "pmResultCounters": pmResults,
            "syntheticPagehide": syntheticPagehide, "realOsLifecycleOrBfCacheProved": false]
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]); guard data.count <= 65536 else { throw ResearchFullAppProtectedUiError.unavailable }
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let info = try documents.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]); guard info.isDirectory == true, info.isSymbolicLink != true else { throw ResearchFullAppProtectedUiError.unavailable }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: documents.path)
        let url = documents.appendingPathComponent("research-full-app-protected-ui-status-" + runID + ".json")
        if initial { guard !manager.fileExists(atPath: url.path) else { throw ResearchFullAppProtectedUiError.unavailable }; try data.write(to: url, options: [.withoutOverwriting, .completeFileProtection]) }
        else { let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]); guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 65537) <= 65536 else { throw ResearchFullAppProtectedUiError.unavailable }; try data.write(to: url, options: [.atomic, .completeFileProtection]) }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
#endif
