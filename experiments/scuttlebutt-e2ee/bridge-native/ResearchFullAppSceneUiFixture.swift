// Separate simulator-only scene observations. This never fences, authenticates,
// registers, pairs, restores or resets an actor. Raw bindings remain private.
#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)
import Foundation
import CoreFoundation
import CryptoKit
import Darwin
import UIKit
import WebKit

private enum ResearchFullAppSceneUiError: Error { case unavailable }

@MainActor
final class ResearchFullAppSceneUiFixture: NSObject, WKScriptMessageHandler {
    static let handlerName = "researchFullAppSceneUiFixture"
    private static let shared = ResearchFullAppSceneUiFixture()
    private var observer: ResearchSceneLifecycleEvidence?
    private var runID: String?
    private var nonce: String?
    private var resourceSHA256: String?
    private var documents: URL?
    private var observerFile: URL?
    private var firstInboxDiagnosticFile: URL?
    private var finishDiagnosticFile: URL?
    private var progressDiagnosticFile: URL?
    private var authorityTimingDiagnosticFile: URL?
    private let progressStageEvidence = ResearchSceneProgressStageEvidence()
    private weak var scene: UIScene?
    private weak var delegate: ResearchSceneDelegate?
    private weak var view: WKWebView?
    private var ready = false
    private var backgroundObserved = false
    private var foregroundObserved = false
    private var presentationClosed = false
    private var closureReported = false
    private var failed = false
    private override init() { super.init() }

    static func startApplication() throws {
        guard shared.observer == nil, !shared.failed,
              Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID,
              let url = Bundle.main.url(forResource: "research-scene-lifecycle", withExtension: "json") else {
            throw ResearchFullAppSceneUiError.unavailable
        }
        let file = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard file.isRegularFile == true, file.isSymbolicLink == false,
              let size = file.fileSize, (1...4096).contains(size) else { throw ResearchFullAppSceneUiError.unavailable }
        let bytes = try Data(contentsOf: url)
        guard bytes.count == size else { throw ResearchFullAppSceneUiError.unavailable }
        let row = try exact(JSONSerialization.jsonObject(with: bytes), ["version", "scenario", "runID", "nonce", "maximumEvents"])
        let binding = try ResearchFullAppProtectedUiFixture.sceneResourceBinding()
        guard integer(row["version"], 1...1) == 1,
              row["scenario"] as? String == "full-app-native-os-lifecycle-observations",
              row["runID"] as? String == binding.runID, row["nonce"] as? String == binding.nonce,
              integer(row["maximumEvents"], 64...64) == 64 else { throw ResearchFullAppSceneUiError.unavailable }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let native = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        guard let canonical = native.path.withCString({ realpath($0, nil) }) else { throw ResearchFullAppSceneUiError.unavailable }
        defer { free(canonical) }
        let documents = URL(fileURLWithPath: String(cString: canonical), isDirectory: true)
        let observer = try ResearchSceneLifecycleEvidence(runID: binding.runID, nonce: binding.nonce, resourceSHA256: hash)
        let output = try observer.persist(inNativeDocumentsRoot: documents)
        shared.runID = binding.runID; shared.nonce = binding.nonce; shared.resourceSHA256 = hash
        shared.documents = documents; shared.observer = observer; shared.observerFile = output
        try shared.capture(.applicationLaunched)
    }

    static func attachScene(_ scene: UIScene, delegate: ResearchSceneDelegate) throws {
        guard shared.observer != nil, !shared.failed, shared.scene == nil,
              let window = delegate.window, window.windowScene === scene else { throw ResearchFullAppSceneUiError.unavailable }
        shared.scene = scene; shared.delegate = delegate
        try shared.capture(.sceneConnected)
    }

    static func install(in webView: WKWebView) throws {
        guard shared.observer != nil, !shared.failed, shared.view == nil,
              webView.url == nil, !webView.isLoading else { throw ResearchFullAppSceneUiError.unavailable }
        shared.view = webView
        webView.configuration.userContentController.add(shared, name: handlerName)
    }

    static func observe(_ event: ResearchSceneLifecycleEvidence.Event, scene: UIScene, delegate: ResearchSceneDelegate) {
        guard shared.scene === scene, shared.delegate === delegate, !shared.failed else { return }
        do {
            try shared.capture(event)
            if event == .didEnterBackground, shared.ready { shared.backgroundObserved = true }
            if event == .didBecomeActive, shared.ready, shared.backgroundObserved {
                shared.foregroundObserved = true
                shared.step("foreground-active-observed")
            }
        } catch { shared.failed = true }
    }

    static func observeTermination() {
        guard shared.observer != nil, !shared.failed else { return }
        do { try shared.capture(.willTerminate) } catch { shared.failed = true }
    }

    static func presentationClosed(scene: UIScene, delegate: ResearchSceneDelegate) {
        guard shared.scene === scene, shared.delegate === delegate, !shared.failed,
              shared.ready, shared.backgroundObserved, shared.foregroundObserved,
              !shared.presentationClosed, scene.activationState == .foregroundActive,
              let controller = delegate.window?.rootViewController as? ResearchBridgeViewController,
              controller.sceneAuthorityDescriptor().phase == .active,
              delegate.sceneLifecycleCoverFacts().present == false else { return }
        // Readonly notification after the real owner independently measured DOM
        // and released its presentation fence; no admission mutation here.
        shared.presentationClosed = true
        shared.step("foreground-presentation-closed")
    }

    static func protectedReady() throws {
        guard shared.observer != nil, !shared.failed, !shared.ready,
              shared.scene != nil, shared.delegate != nil, shared.view != nil else { throw ResearchFullAppSceneUiError.unavailable }
        try shared.capture(.protectedReady)
        shared.ready = true
        shared.step("protected-ready")
    }

    private func capture(_ event: ResearchSceneLifecycleEvidence.Event) throws {
        guard let observer, let documents, !failed else { throw ResearchFullAppSceneUiError.unavailable }
        let cover = delegate?.sceneLifecycleCoverFacts() ?? .absent
        try observer.record(event: event, activationState: activation(scene?.activationState), cover: cover) {
            ResearchFullAppProtectedUiFixture.sceneAuthorityFacts()
        }
        // The append is never replaced by a later safe snapshot. A failed write
        // leaves partial evidence; it cannot make this scenario pass.
        observerFile = try observer.persist(inNativeDocumentsRoot: documents)
        Self.persistFirstInboxDiagnostic()
        Self.persistSceneFinishDiagnostic()
        try? writeSceneProgressDiagnostic()
        Self.persistAuthorityTimingDiagnostic()
    }

    // Optional diagnostic I/O is separate from every operation, reply and scene
    // acceptance report. Failure is retained as missing/refused driver evidence;
    // it must not change native authority or the original PM resolution.
    static func persistFirstInboxDiagnostic() {
        try? shared.writeFirstInboxDiagnostic()
    }
    private func writeFirstInboxDiagnostic() throws {
        guard let observer, let documents, let observerFile,
              try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path,
              let slash = observerFile.path.lastIndex(of: "/") else { throw ResearchFullAppSceneUiError.unavailable }
        let directory = String(observerFile.path[..<slash])
        let file = URL(fileURLWithPath: directory + "/scene-first-inbox-stage.json")
        let bytes = try JSONSerialization.data(withJSONObject:
            ScuttlebuttResearchAuthPlugin.firstInboxStageEvidence.snapshot().json, options: [.sortedKeys])
        guard (1...4096).contains(bytes.count) else { throw ResearchFullAppSceneUiError.unavailable }
        if let existing = firstInboxDiagnosticFile {
            guard existing.path == file.path else { throw ResearchFullAppSceneUiError.unavailable }
            try requireFirstInboxDiagnostic(file)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        } else {
            // Never adopt or overwrite a pre-existing diagnostic, including an
            // incomplete first write. The observer owns this private directory.
            try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try requireFirstInboxDiagnostic(file)
        firstInboxDiagnosticFile = file
    }
    private func requireFirstInboxDiagnostic(_ file: URL, maximumBytes: Int = 4096) throws {
        // Parent ownership/canonical ancestors were checked by observer.persist.
        guard let canonical = file.path.withCString({ realpath($0, nil) }) else { throw ResearchFullAppSceneUiError.unavailable }
        defer { free(canonical) }
        var metadata = stat()
        guard String(cString: canonical) == file.path,
              file.path.withCString({ lstat($0, &metadata) }) == 0,
              (UInt32(metadata.st_mode) & UInt32(S_IFMT)) == UInt32(S_IFREG),
              metadata.st_uid == getuid(), (UInt32(metadata.st_mode) & 0o7777) == 0o600,
              (1...maximumBytes).contains(Int(metadata.st_size)) else { throw ResearchFullAppSceneUiError.unavailable }
    }
    static func persistSceneFinishDiagnostic() { try? shared.writeSceneFinishDiagnostic() }
    private func writeSceneFinishDiagnostic() throws {
        guard let observer, let documents, let observerFile,
              try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path,
              let slash = observerFile.path.lastIndex(of: "/") else { throw ResearchFullAppSceneUiError.unavailable }
        let file = URL(fileURLWithPath: String(observerFile.path[..<slash]) + "/scene-finish-stage.json")
        let bytes = try JSONSerialization.data(withJSONObject:
            ResearchFullAppProtectedUiFixture.sceneFinishStageEvidence.snapshot().json, options: [.sortedKeys])
        guard (1...4096).contains(bytes.count) else { throw ResearchFullAppSceneUiError.unavailable }
        if let existing = finishDiagnosticFile {
            guard existing.path == file.path else { throw ResearchFullAppSceneUiError.unavailable }
            try requireFirstInboxDiagnostic(file)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        } else { try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection]) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try requireFirstInboxDiagnostic(file)
        finishDiagnosticFile = file
    }

    static func persistAuthorityTimingDiagnostic() { try? shared.writeAuthorityTimingDiagnostic() }
    private func writeAuthorityTimingDiagnostic() throws {
        guard let observer, let documents, let observerFile, let runID, let nonce, let resourceSHA256,
              try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path,
              let slash = observerFile.path.lastIndex(of: "/") else { throw ResearchFullAppSceneUiError.unavailable }
        let file = URL(fileURLWithPath: String(observerFile.path[..<slash]) + "/scene-authority-timing.json")
        let row: [String: Any] = ["version": 1, "kind": "research-scene-authority-timing-observations",
            "runID": runID, "nonce": nonce, "resourceSHA256": resourceSHA256,
            "process": ["pid": observer.processID, "epoch": observer.processEpoch],
            "timing": ResearchFullAppProtectedUiFixture.sceneAuthorityTimingEvidence.snapshot(),
            "acceptanceEvidence": false, "authorityMutated": false]
        let bytes = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        guard (1...16384).contains(bytes.count) else { throw ResearchFullAppSceneUiError.unavailable }
        if let existing = authorityTimingDiagnosticFile {
            guard existing.path == file.path else { throw ResearchFullAppSceneUiError.unavailable }
            try requireFirstInboxDiagnostic(file, maximumBytes: 16384)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        } else { try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection]) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try requireFirstInboxDiagnostic(file, maximumBytes: 16384)
        authorityTimingDiagnosticFile = file
    }

    // Separate diagnostic admission is available before protected-ready. It
    // cannot enter the closure/permission path or mutate any native authority.
    private func receiveFinishDiagnostic(_ controller: WKUserContentController, message: WKScriptMessage) {
        guard let view, message.name == Self.handlerName,
              controller === view.configuration.userContentController,
              message.webView === view, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, url.scheme == "capacitor", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil || url.fragment == "" else { return }
        do {
            let row = try Self.exact(message.body, ["version", "kind", "runID", "nonce", "phase"])
            guard Self.integer(row["version"], 1...1) == 1,
                  row["kind"] as? String == "scene-finish-javascript-diagnostic",
                  let runID, let nonce, row["runID"] as? String == runID,
                  row["nonce"] as? String == nonce else { return }
            let phase: String?
            if row["phase"] is NSNull { phase = nil }
            else { guard let name = row["phase"] as? String else { return }; phase = name }
            guard ResearchFullAppProtectedUiFixture.sceneFinishStageEvidence.selectJavaScriptFailurePhase(name: phase) else { return }
            Self.persistSceneFinishDiagnostic()
        } catch { return } // Never turn optional diagnostic refusal into app failure.
    }

    private func writeSceneProgressDiagnostic() throws {
        guard let observer, let documents, let observerFile,
              try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path,
              let slash = observerFile.path.lastIndex(of: "/") else { throw ResearchFullAppSceneUiError.unavailable }
        let file = URL(fileURLWithPath: String(observerFile.path[..<slash]) + "/scene-progress-stage.json")
        let bytes = try JSONSerialization.data(withJSONObject: progressStageEvidence.snapshot().json, options: [.sortedKeys])
        guard (1...16384).contains(bytes.count) else { throw ResearchFullAppSceneUiError.unavailable }
        if let existing = progressDiagnosticFile {
            guard existing.path == file.path else { throw ResearchFullAppSceneUiError.unavailable }
            try requireFirstInboxDiagnostic(file, maximumBytes: 16384)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        } else { try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection]) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try requireFirstInboxDiagnostic(file, maximumBytes: 16384)
        progressDiagnosticFile = file
    }

    // An in-progress phase is a separate value-only channel, admitted before
    // ready. Sequence replay/gaps/overflow cannot overwrite an earlier entry.
    private func receiveProgressDiagnostic(_ controller: WKUserContentController, message: WKScriptMessage) {
        guard let view, message.name == Self.handlerName,
              controller === view.configuration.userContentController,
              message.webView === view, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, url.scheme == "capacitor", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil || url.fragment == "" else { return }
        do {
            let row = try Self.exact(message.body, ["version", "kind", "runID", "nonce", "sequence", "phase",
                "sendPresent", "sendEnabled", "composePresent", "composeEmpty", "composeDisabled", "composeReadOnly"])
            guard Self.integer(row["version"], 1...1) == 1,
                  row["kind"] as? String == "scene-progress-javascript-diagnostic",
                  let runID, let nonce, row["runID"] as? String == runID, row["nonce"] as? String == nonce,
                  let sequence = Self.integer(row["sequence"], 1...64),
                  let name = row["phase"] as? String,
                  let phase = ResearchSceneProgressStageEvidence.JavaScriptPhase(rawValue: name) else { return }
            func fact(_ key: String) throws -> Bool? {
                if row[key] is NSNull { return nil }
                guard let value = Self.boolean(row[key]) else { throw ResearchFullAppSceneUiError.unavailable }
                return value
            }
            let facts = try ResearchSceneProgressStageEvidence.DOMFacts(
                sendPresent: fact("sendPresent"), sendEnabled: fact("sendEnabled"),
                composePresent: fact("composePresent"), composeEmpty: fact("composeEmpty"),
                composeDisabled: fact("composeDisabled"), composeReadOnly: fact("composeReadOnly"))
            guard progressStageEvidence.record(sequence: sequence, phase: phase, dom: facts) else { return }
            try? writeSceneProgressDiagnostic()
        } catch { return }
    }

    private func activation(_ state: UIScene.ActivationState?) -> ResearchSceneLifecycleEvidence.ActivationState {
        guard let state else { return .unknown }
        switch state {
        case .unattached: return .unattached
        case .foregroundActive: return .foregroundActive
        case .foregroundInactive: return .foregroundInactive
        case .background: return .background
        @unknown default: return .unknown
        }
    }

    private func step(_ phase: String) {
        guard ["protected-ready", "foreground-active-observed", "foreground-presentation-closed", "foreground-ui-closed"].contains(phase), let view else { return }
        // Fixed diagnostics only: no permission/fence or synthetic OS event.
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('research-full-app-scene-ui-step',{detail:{phase:'" + phase + "'}}));", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], body["kind"] as? String == "scene-progress-javascript-diagnostic" {
            receiveProgressDiagnostic(controller, message: message); return
        }
        if let body = message.body as? [String: Any], body["kind"] as? String == "scene-finish-javascript-diagnostic" {
            receiveFinishDiagnostic(controller, message: message); return
        }
        guard !failed, ready, backgroundObserved, foregroundObserved, presentationClosed, !closureReported,
              let view, message.name == Self.handlerName, controller === view.configuration.userContentController,
              message.webView === view, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, url.scheme == "capacitor", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil || url.fragment == "" else { return }
        do {
            guard let runID, let nonce, let resourceSHA256, let observer, let observerFile else { throw ResearchFullAppSceneUiError.unavailable }
            let row = try Self.exact(message.body, ["version", "runID", "nonce", "phase", "windowEvidence", "domFacts", "sdkCounts"])
            guard Self.integer(row["version"], 1...1) == 1, row["runID"] as? String == runID,
                  row["nonce"] as? String == nonce, row["phase"] as? String == "foreground-ui-closed" else { throw ResearchFullAppSceneUiError.unavailable }
            let window = try ResearchFullAppProtectedUiFixture.sceneWindowEvidence(row["windowEvidence"], runID: runID)
            let authFacts = try Self.exact(window["auth"], ["status", "userPresent", "authChecked"])
            let scope = try Self.exact(window["authScope"], ["originalUserPresent", "originalAnonymous", "originalGeneration", "currentUserPresent", "currentAnonymous", "currentGeneration"])
            guard window["runId"] as? String == runID, window["phase"] as? String == "ready",
                  let auth = authFacts["status"] as? String, ["unavailable", "signed_out"].contains(auth),
                  Self.boolean(authFacts["userPresent"]) == false, Self.boolean(authFacts["authChecked"]) == true,
                  window["privateSelection"] as? String == "native-unavailable", Self.boolean(window["legacyPermitAvailable"]) == false,
                  Self.boolean(scope["currentUserPresent"]) == false, Self.boolean(scope["currentAnonymous"]) == true else { throw ResearchFullAppSceneUiError.unavailable }
            let sdk = try Self.exact(row["sdkCounts"], ["password", "unexpected"])
            guard Self.integer(sdk["password"], 0...10000) != nil, Self.integer(sdk["unexpected"], 0...10000) != nil else { throw ResearchFullAppSceneUiError.unavailable }
            let dom = try Self.exact(row["domFacts"], ["actualAppNavigation", "privateOpenEnabled", "logPresent", "composeEmpty", "passwordEmpty", "legacyControlsAbsent"])
            for key in ["actualAppNavigation", "composeEmpty", "passwordEmpty", "legacyControlsAbsent"] {
                guard Self.boolean(dom[key]) == true else { throw ResearchFullAppSceneUiError.unavailable }
            }
            guard Self.boolean(dom["privateOpenEnabled"]) == false, Self.boolean(dom["logPresent"]) == false else { throw ResearchFullAppSceneUiError.unavailable }
            let native = try ResearchFullAppProtectedUiFixture.sceneClosureEvidence()
            var body: [String: Any] = ["version": 1, "kind": "research-scene-protected-ui-closure", "runID": runID, "nonce": nonce,
                "resourceSHA256": resourceSHA256, "process": ["pid": observer.processID, "epoch": observer.processEpoch],
                "status": "observed", "phase": "foreground-ui-closed", "windowEvidence": window, "domFacts": dom,
                "sdkCounts": sdk, "syntheticPagehide": false, "realOsLifecycleOrBfCacheProved": false]
            for key in ["protectedResourceSHA256", "protectedProofSHA256", "nativeCounters", "pmResultCounters", "relayCounters"] {
                guard let value = native[key] else { throw ResearchFullAppSceneUiError.unavailable }
                body[key] = value
            }
            let bytes = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            guard bytes.count <= 16384 else { throw ResearchFullAppSceneUiError.unavailable }
            guard let documents, try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path,
                  let slash = observerFile.path.lastIndex(of: "/") else { throw ResearchFullAppSceneUiError.unavailable }
            // Do not let Foundation rewrite the canonical private-prefix path.
            let file = URL(fileURLWithPath: String(observerFile.path[..<slash]) + "/scene-ui-closure.json")
            try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            try capture(.foregroundUiClosed)
            closureReported = true; step("foreground-ui-closed")
        } catch { failed = true }
    }

    private static func exact(_ raw: Any?, _ keys: [String]) throws -> [String: Any] {
        guard let row = raw as? [String: Any], Set(row.keys) == Set(keys) else { throw ResearchFullAppSceneUiError.unavailable }
        return row
    }
    private static func integer(_ raw: Any?, _ range: ClosedRange<Int>) -> Int? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue == Double(number.intValue), range.contains(number.intValue) else { return nil }
        return number.intValue
    }
    private static func boolean(_ raw: Any?) -> Bool? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}
#endif
