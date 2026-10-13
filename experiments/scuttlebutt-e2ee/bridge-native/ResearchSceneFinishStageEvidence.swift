// Passive simulator-only diagnostics. Fixed value facts never grant native
// permission or prove acceptance, JavaScript consumption or an OS transition.
// The recorder retains no report, account snapshot, facade, scope, error,
// credential, closure, timer or I/O object and performs no Auth/fence/message work.
#if E2EE_SCENE_FINISH_STAGE_EVIDENCE_TEST || (E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator))
import Foundation

final class ResearchSceneFinishStageEvidence: @unchecked Sendable {
    enum Callsite: String, CaseIterable, Sendable {
        case javascriptFailed = "js-failed"
        case javascriptPassed = "js-passed"
        case nativeReceiveRefused = "native-receive-refused"
    }

    // These name the last native validation checkpoint entered by a future
    // caller. A marker does not mean that checkpoint succeeded. Missing native
    // knowledge is nil and serializes as the explicit fixed name "none".
    enum NativeValidationBoundary: String, CaseIterable, Sendable {
        case progressOrder = "progress-order"
        case http, common, control, write
        case protectedReady = "protected-ready"
        case final
    }

    // Exactly the fixture's admitted progress/control/terminal phase names,
    // plus explicit absence. No arbitrary phase or incoming report is retained.
    enum AdmittedReportPhase: String, CaseIterable, Sendable {
        case none
        case scriptInstalled = "script-installed"
        case domReady = "dom-ready"
        case httpRefusals = "http-refusals"
        case coldReady = "cold-ready"
        case signedIn = "signed-in"
        case unknownAdmission = "unknown-admission"
        case prepared
        case admissionReady = "admission-ready"
        case pmOpened = "pm-opened"
        case pmSent = "pm-sent"
        case peerReplied = "peer-replied"
        case pmReceived = "pm-received"
        case pmDeduped = "pm-deduped"
        case nativeProofCaptured = "native-proof-captured"
        case terminalClosed = "terminal-closed"
        case rootRemounted = "root-remounted"
        case protectedSetup = "protected-setup"
        case protectedPeerReply = "protected-peer-reply"
        case captureProof = "capture-proof"
        case fixtureComplete = "fixture-complete"
        case fixtureFailed = "fixture-failed"
    }

    // This is a separate JavaScript diagnostic channel. It cannot choose or
    // replace a native callsite, boundary, report phase or permission decision.
    enum JavaScriptFailurePhase: String, CaseIterable, Sendable {
        case coldReady = "cold-ready"
        case coldChatClosed = "cold-chat-closed"
        case authenticated
        case unknownAdmission = "unknown-admission"
        case prepared
        case nativeAdmission = "native-admission"
        case inboxEntry = "inbox-entry"
        case threadOpen = "thread-open"
        case sendEnabled = "send-enabled"
        case sendAccepted = "send-accepted"
        case replyRefreshEnabled = "reply-refresh-enabled"
        case peerReply = "peer-reply"
        case receiveRefreshEnabled = "receive-refresh-enabled"
        case receiveRefreshCompletion = "receive-refresh-completion"
        case incomingReceived = "incoming-received"
        case dedupRefreshEnabled = "dedup-refresh-enabled"
        case dedupRefreshCompletion = "dedup-refresh-completion"
        case proofCaptured = "proof-captured"
        case urlCheck = "url-check"
        case awaitForeground = "await-foreground"
        case awaitClosedWindow = "await-closed-window"
        case closurePost = "closure-post"
        case awaitClosureAcknowledgement = "await-closure-ack"
    }

    struct Snapshot: Equatable, Sendable {
        let selectedNativeFinishes: Int
        let nativeCallsites: [String: Int]
        let lastNativeValidationBoundaries: [String: Int]
        let admittedReportPhases: [String: Int]
        let selectedJavaScriptFailures: Int
        let javaScriptFailurePhases: [String: Int]

        fileprivate init(selectedNativeFinishes: Int, nativeCallsites: [String: Int],
                         lastNativeValidationBoundaries: [String: Int], admittedReportPhases: [String: Int],
                         selectedJavaScriptFailures: Int, javaScriptFailurePhases: [String: Int]) {
            self.selectedNativeFinishes = selectedNativeFinishes
            self.nativeCallsites = nativeCallsites
            self.lastNativeValidationBoundaries = lastNativeValidationBoundaries
            self.admittedReportPhases = admittedReportPhases
            self.selectedJavaScriptFailures = selectedJavaScriptFailures
            self.javaScriptFailurePhases = javaScriptFailurePhases
        }

        var json: [String: Any] {
            ["version": 1, "kind": "scene-finish-stage-diagnostic",
             "native": ["selectedFinishes": selectedNativeFinishes,
                        "callsites": nativeCallsites,
                        "lastValidationBoundaries": lastNativeValidationBoundaries,
                        "admittedReportPhases": admittedReportPhases],
             "javascript": ["selectedFailures": selectedJavaScriptFailures,
                            "failurePhases": javaScriptFailurePhases],
             "acceptanceEvidence": false]
        }
    }

    private struct NativeCapture: Sendable {
        let callsite: Callsite
        let boundary: NativeValidationBoundary?
        let reportPhase: AdmittedReportPhase
    }
    private struct JavaScriptCapture: Sendable {
        let phase: JavaScriptFailurePhase?
    }
    private let lock = NSLock()
    private var native: NativeCapture?
    private var javascript: JavaScriptCapture?

    // Future wiring belongs immediately AFTER the existing finish accepted
    // guard, using only already-admitted fixed values. Retain this Boolean for
    // that selected call. This API cannot independently establish caller identity
    // or admission, and no diagnostic I/O belongs inside that guard.
    @discardableResult
    func selectNativeFinish(callsite: Callsite,
                            lastNativeValidationBoundary: NativeValidationBoundary?,
                            admittedReportPhase: AdmittedReportPhase) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard native == nil else { return false }
        native = NativeCapture(callsite: callsite, boundary: lastNativeValidationBoundary,
                               reportPhase: admittedReportPhase)
        return true
    }

    // The first optional JS fact is selected independently. A missing phase is
    // explicit absence, not a substitute for a native checkpoint. Either channel
    // may arrive first; subsequent/earlier replacements are refused unchanged.
    @discardableResult
    func selectJavaScriptFailurePhase(_ phase: JavaScriptFailurePhase?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard javascript == nil else { return false }
        javascript = JavaScriptCapture(phase: phase)
        return true
    }

    // Narrow fixed-name decoding seams: unknown/oversized names refuse before
    // selection and are never stored. These do not parse an incoming report or
    // establish native admission. nil boundary/phase means explicit absence.
    @discardableResult
    func selectNativeFinish(callsiteName: String, lastNativeValidationBoundaryName: String?,
                            admittedReportPhaseName: String?) -> Bool {
        guard callsiteName.utf8.count <= 48, let callsite = Callsite(rawValue: callsiteName) else { return false }
        let boundary: NativeValidationBoundary?
        if let name = lastNativeValidationBoundaryName {
            guard name.utf8.count <= 48, let value = NativeValidationBoundary(rawValue: name) else { return false }
            boundary = value
        } else { boundary = nil }
        let phase: AdmittedReportPhase
        if let name = admittedReportPhaseName {
            guard name.utf8.count <= 48, let value = AdmittedReportPhase(rawValue: name) else { return false }
            phase = value
        } else { phase = .none }
        return selectNativeFinish(callsite: callsite, lastNativeValidationBoundary: boundary,
                                  admittedReportPhase: phase)
    }

    @discardableResult
    func selectJavaScriptFailurePhase(name: String?) -> Bool {
        let phase: JavaScriptFailurePhase?
        if let name {
            guard name.utf8.count <= 48, let value = JavaScriptFailurePhase(rawValue: name) else { return false }
            phase = value
        } else { phase = nil }
        return selectJavaScriptFailurePhase(phase)
    }

    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(selectedNativeFinishes: native == nil ? 0 : 1,
            nativeCallsites: Self.markers(Callsite.allCases, selected: native?.callsite),
            lastNativeValidationBoundaries: Self.optionalMarkers(NativeValidationBoundary.allCases,
                selected: native?.boundary, channelSelected: native != nil),
            admittedReportPhases: Self.markers(AdmittedReportPhase.allCases, selected: native?.reportPhase),
            selectedJavaScriptFailures: javascript == nil ? 0 : 1,
            javaScriptFailurePhases: Self.optionalMarkers(JavaScriptFailurePhase.allCases,
                selected: javascript?.phase, channelSelected: javascript != nil))
    }

    private static func markers<Value: RawRepresentable>(_ values: [Value], selected: Value?) -> [String: Int]
        where Value.RawValue == String {
        Dictionary(uniqueKeysWithValues: values.map { ($0.rawValue, $0.rawValue == selected?.rawValue ? 1 : 0) })
    }
    private static func optionalMarkers<Value: RawRepresentable>(_ values: [Value], selected: Value?,
                                                               channelSelected: Bool) -> [String: Int]
        where Value.RawValue == String {
        var result = markers(values, selected: selected)
        result["none"] = channelSelected && selected == nil ? 1 : 0
        return result
    }
}
#endif
