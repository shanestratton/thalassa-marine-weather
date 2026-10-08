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
#if E2EE_PROTECTED_UI_FIXTURE
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
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              ["application-launched", "scene-connected", "bridge-created", "fixture-installed",
               "fixture-install-failed", "script-installed", "dom-ready", "cold-ready", "signed-in",
               "admission-returned", "protected-setup", "prepared", "protected-peer-reply", "peer-replied",
               "pm-opened", "pm-sent", "pm-received", "pm-refresh-started", "protected-control-failed"].contains(phase) else { return }
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
#if E2EE_PROTECTED_UI_FIXTURE
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
    }

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
