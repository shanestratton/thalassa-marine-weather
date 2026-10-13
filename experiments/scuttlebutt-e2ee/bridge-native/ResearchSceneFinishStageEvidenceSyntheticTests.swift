// Prepared host-Mac direct-call source only. No app, simulator, OS transition,
// crypto or permission acceptance is established by this synthetic harness.
// Compile/run only under the explicit TEST flag after the current job is reviewed.
#if E2EE_SCENE_FINISH_STAGE_EVIDENCE_TEST
import Foundation
import Dispatch

private enum SceneFinishSyntheticFailure: Error { case refused }

private final class SceneFinishRaceResults: @unchecked Sendable {
    private let lock = NSLock()
    private var accepted = 0
    private var refused = 0
    private var invalid = 0

    func record(accepted selection: Bool, snapshot: ResearchSceneFinishStageEvidence.Snapshot) {
        lock.lock(); defer { lock.unlock() }
        if selection { accepted += 1 } else { refused += 1 }
        let groups = [snapshot.nativeCallsites, snapshot.lastNativeValidationBoundaries, snapshot.admittedReportPhases]
        if snapshot.selectedNativeFinishes != 1 || groups.contains(where: {
            $0.values.contains(where: { $0 != 0 && $0 != 1 }) || $0.values.reduce(0, +) != 1
        }) || !(0...1).contains(snapshot.selectedJavaScriptFailures)
            || snapshot.javaScriptFailurePhases.values.contains(where: { $0 != 0 && $0 != 1 })
            || snapshot.javaScriptFailurePhases.values.reduce(0, +) != snapshot.selectedJavaScriptFailures {
            invalid += 1
        }
    }
    func counts() -> (accepted: Int, refused: Int, invalid: Int) {
        lock.lock(); defer { lock.unlock() }
        return (accepted, refused, invalid)
    }
}

@main
private struct ResearchSceneFinishStageEvidenceSyntheticTests {
    static func main() throws {
        typealias Recorder = ResearchSceneFinishStageEvidence
        var assertions = 0
        func check(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw SceneFinishSyntheticFailure.refused }
            assertions += 1
        }
        func encoded(_ snapshot: Recorder.Snapshot) throws -> Data {
            let bytes = try JSONSerialization.data(withJSONObject: snapshot.json, options: [.sortedKeys])
            try check((1...4096).contains(bytes.count))
            return bytes
        }
        func checkShape(_ snapshot: Recorder.Snapshot) throws {
            try check((0...1).contains(snapshot.selectedNativeFinishes))
            try check((0...1).contains(snapshot.selectedJavaScriptFailures))
            let groups = [snapshot.nativeCallsites, snapshot.lastNativeValidationBoundaries,
                          snapshot.admittedReportPhases, snapshot.javaScriptFailurePhases]
            for group in groups { try check(group.values.allSatisfy { $0 == 0 || $0 == 1 }) }
            try check(Set(snapshot.nativeCallsites.keys) == Set(Recorder.Callsite.allCases.map { $0.rawValue }))
            try check(Set(snapshot.lastNativeValidationBoundaries.keys) ==
                Set(Recorder.NativeValidationBoundary.allCases.map { $0.rawValue } + ["none"]))
            try check(Set(snapshot.admittedReportPhases.keys) == Set(Recorder.AdmittedReportPhase.allCases.map { $0.rawValue }))
            try check(Set(snapshot.javaScriptFailurePhases.keys) ==
                Set(Recorder.JavaScriptFailurePhase.allCases.map { $0.rawValue } + ["none"]))
            try check(snapshot.nativeCallsites.values.reduce(0, +) == snapshot.selectedNativeFinishes)
            try check(snapshot.lastNativeValidationBoundaries.values.reduce(0, +) == snapshot.selectedNativeFinishes)
            try check(snapshot.admittedReportPhases.values.reduce(0, +) == snapshot.selectedNativeFinishes)
            try check(snapshot.javaScriptFailurePhases.values.reduce(0, +) == snapshot.selectedJavaScriptFailures)
            let json = snapshot.json
            try check(Set(json.keys) == Set(["version", "kind", "native", "javascript", "acceptanceEvidence"]))
            try check(json["acceptanceEvidence"] as? Bool == false)
            guard let native = json["native"] as? [String: Any],
                  let javascript = json["javascript"] as? [String: Any] else { throw SceneFinishSyntheticFailure.refused }
            try check(Set(native.keys) == Set(["selectedFinishes", "callsites", "lastValidationBoundaries", "admittedReportPhases"]))
            try check(Set(javascript.keys) == Set(["selectedFailures", "failurePhases"]))
            try check(native["selectedFinishes"] as? Int == snapshot.selectedNativeFinishes)
            try check(javascript["selectedFailures"] as? Int == snapshot.selectedJavaScriptFailures)
            _ = try encoded(snapshot)
        }

        // Freeze the actual fixture's admitted names instead of accepting an
        // arbitrary new enum case just because the implementation contains it.
        let admittedNames = ["none", "script-installed", "dom-ready", "http-refusals", "cold-ready", "signed-in",
            "unknown-admission", "prepared", "admission-ready", "pm-opened", "pm-sent", "peer-replied", "pm-received",
            "pm-deduped", "native-proof-captured", "terminal-closed", "root-remounted", "protected-setup",
            "protected-peer-reply", "capture-proof", "fixture-complete", "fixture-failed"]
        try check(Set(Recorder.AdmittedReportPhase.allCases.map { $0.rawValue }) == Set(admittedNames))
        try check(Recorder.AdmittedReportPhase.allCases.count == admittedNames.count)
        let javascriptNames = ["cold-ready", "cold-chat-closed", "authenticated", "unknown-admission", "prepared",
            "native-admission", "inbox-entry", "thread-open", "send-enabled", "send-accepted", "reply-refresh-enabled",
            "peer-reply", "receive-refresh-enabled", "receive-refresh-completion", "incoming-received",
            "dedup-refresh-enabled", "dedup-refresh-completion", "proof-captured", "url-check", "await-foreground",
            "await-closed-window", "closure-post", "await-closure-ack"]
        try check(Set(Recorder.JavaScriptFailurePhase.allCases.map { $0.rawValue }) == Set(javascriptNames))
        try check(Recorder.JavaScriptFailurePhase.allCases.count == javascriptNames.count)

        let recorder = Recorder()
        let empty = recorder.snapshot()
        try checkShape(empty)
        try check(empty.selectedNativeFinishes == 0 && empty.selectedJavaScriptFailures == 0)
        try check(recorder.selectNativeFinish(callsite: .nativeReceiveRefused,
            lastNativeValidationBoundary: .common, admittedReportPhase: .nativeProofCaptured))
        let nativeOnly = recorder.snapshot()
        try checkShape(nativeOnly)
        try check(nativeOnly.nativeCallsites["native-receive-refused"] == 1)
        try check(nativeOnly.lastNativeValidationBoundaries["common"] == 1)
        try check(nativeOnly.admittedReportPhases["native-proof-captured"] == 1)
        try check(nativeOnly.selectedJavaScriptFailures == 0)
        try check(empty.selectedNativeFinishes == 0)
        let nativeBytes = try encoded(nativeOnly)
        // Duplicate and late/backward replacement cannot amend the first facts.
        for callsite in Recorder.Callsite.allCases {
            try check(!recorder.selectNativeFinish(callsite: callsite,
                lastNativeValidationBoundary: .progressOrder, admittedReportPhase: .scriptInstalled))
            try check(recorder.snapshot() == nativeOnly)
            try check(try encoded(recorder.snapshot()) == nativeBytes)
        }
        try check(recorder.selectJavaScriptFailurePhase(.awaitClosureAcknowledgement))
        let combined = recorder.snapshot()
        try checkShape(combined)
        try check(combined.selectedJavaScriptFailures == 1)
        try check(combined.javaScriptFailurePhases["await-closure-ack"] == 1)
        try check(combined.nativeCallsites == nativeOnly.nativeCallsites)
        try check(combined.lastNativeValidationBoundaries == nativeOnly.lastNativeValidationBoundaries)
        try check(combined.admittedReportPhases == nativeOnly.admittedReportPhases)
        let combinedBytes = try encoded(combined)
        for phase in Recorder.JavaScriptFailurePhase.allCases {
            try check(!recorder.selectJavaScriptFailurePhase(phase))
            try check(recorder.snapshot() == combined)
            try check(try encoded(recorder.snapshot()) == combinedBytes)
        }
        try check(!recorder.selectJavaScriptFailurePhase(nil))
        try check(recorder.snapshot() == combined)
        try check(nativeOnly.selectedJavaScriptFailures == 0)

        // JavaScript alone cannot select a native finish or native boundary.
        for phase in Recorder.JavaScriptFailurePhase.allCases {
            let jsFirst = Recorder()
            try check(jsFirst.selectJavaScriptFailurePhase(phase))
            let before = jsFirst.snapshot()
            try check(before.selectedNativeFinishes == 0)
            try check(before.nativeCallsites.values.allSatisfy { $0 == 0 })
            try check(before.lastNativeValidationBoundaries.values.allSatisfy { $0 == 0 })
            try check(before.admittedReportPhases.values.allSatisfy { $0 == 0 })
            try check(jsFirst.selectNativeFinish(callsite: .javascriptFailed,
                lastNativeValidationBoundary: nil, admittedReportPhase: .fixtureFailed))
            let after = jsFirst.snapshot()
            try check(after.javaScriptFailurePhases == before.javaScriptFailurePhases)
            try check(after.lastNativeValidationBoundaries["none"] == 1)
            try check(after.lastNativeValidationBoundaries["final"] == 0)
        }
        let absent = Recorder()
        try check(absent.selectJavaScriptFailurePhase(name: nil))
        try check(absent.selectNativeFinish(callsiteName: "js-passed",
            lastNativeValidationBoundaryName: nil, admittedReportPhaseName: nil))
        let absentSnapshot = absent.snapshot()
        try checkShape(absentSnapshot)
        try check(absentSnapshot.lastNativeValidationBoundaries["none"] == 1)
        try check(absentSnapshot.admittedReportPhases["none"] == 1)
        try check(absentSnapshot.javaScriptFailurePhases["none"] == 1)
        try check(!absent.selectJavaScriptFailurePhase(.closurePost))
        try check(absent.snapshot() == absentSnapshot)

        // Every fixed admitted name round-trips through only its bounded enum.
        for phase in Recorder.AdmittedReportPhase.allCases {
            let known = Recorder()
            try check(known.selectNativeFinish(callsiteName: "native-receive-refused",
                lastNativeValidationBoundaryName: "write", admittedReportPhaseName: phase.rawValue))
            try check(known.snapshot().admittedReportPhases[phase.rawValue] == 1)
        }
        for boundary in Recorder.NativeValidationBoundary.allCases {
            let known = Recorder()
            try check(known.selectNativeFinish(callsiteName: "js-passed",
                lastNativeValidationBoundaryName: boundary.rawValue, admittedReportPhaseName: "fixture-complete"))
            try check(known.snapshot().lastNativeValidationBoundaries[boundary.rawValue] == 1)
        }
        for phase in Recorder.JavaScriptFailurePhase.allCases {
            let known = Recorder()
            try check(known.selectJavaScriptFailurePhase(name: phase.rawValue))
            try check(known.snapshot().javaScriptFailurePhases[phase.rawValue] == 1)
        }

        let unknown = Recorder()
        let unknownEmpty = unknown.snapshot()
        let privateCanary = "scene-finish-private-canary"
        let unknownNames = [privateCanary, "", "JS-FAILED", "native-receive-refused\n", String(repeating: "x", count: 49)]
        for name in unknownNames {
            try check(!unknown.selectNativeFinish(callsiteName: name,
                lastNativeValidationBoundaryName: "common", admittedReportPhaseName: "pm-received"))
            try check(unknown.snapshot() == unknownEmpty)
            try check(!unknown.selectNativeFinish(callsiteName: "js-failed",
                lastNativeValidationBoundaryName: name, admittedReportPhaseName: "fixture-failed"))
            try check(unknown.snapshot() == unknownEmpty)
            try check(!unknown.selectNativeFinish(callsiteName: "js-failed",
                lastNativeValidationBoundaryName: nil, admittedReportPhaseName: name))
            try check(unknown.snapshot() == unknownEmpty)
            try check(!unknown.selectJavaScriptFailurePhase(name: name))
            try check(unknown.snapshot() == unknownEmpty)
        }
        let unknownBytes = try encoded(unknown.snapshot())
        try check(!String(decoding: unknownBytes, as: UTF8.self).contains(privateCanary))
        try check(unknown.selectNativeFinish(callsite: .javascriptFailed,
            lastNativeValidationBoundary: nil, admittedReportPhase: .fixtureFailed))
        let selectedAfterUnknown = unknown.snapshot()
        try check(!unknown.selectNativeFinish(callsiteName: privateCanary,
            lastNativeValidationBoundaryName: privateCanary, admittedReportPhaseName: privateCanary))
        try check(unknown.snapshot() == selectedAfterUnknown)

        let raced = Recorder()
        let raceResults = SceneFinishRaceResults()
        let callsites = Recorder.Callsite.allCases
        let boundaries = Recorder.NativeValidationBoundary.allCases
        let phases = Recorder.AdmittedReportPhase.allCases
        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let accepted = raced.selectNativeFinish(callsite: callsites[index % callsites.count],
                lastNativeValidationBoundary: boundaries[index % boundaries.count],
                admittedReportPhase: phases[index % phases.count])
            raceResults.record(accepted: accepted, snapshot: raced.snapshot())
        }
        let nativeRace = raceResults.counts()
        try check(nativeRace.accepted == 1)
        try check(nativeRace.refused == 31)
        try check(nativeRace.invalid == 0)
        let racedNative = raced.snapshot()
        try checkShape(racedNative)
        try check(racedNative.selectedJavaScriptFailures == 0)
        try check(!raced.selectNativeFinish(callsite: .nativeReceiveRefused,
            lastNativeValidationBoundary: .final, admittedReportPhase: .none))
        try check(raced.snapshot() == racedNative)

        // Concurrent JS selection remains independent of the captured native row.
        let jsRaceResults = SceneFinishRaceResults()
        let jsPhases = Recorder.JavaScriptFailurePhase.allCases
        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let accepted = raced.selectJavaScriptFailurePhase(jsPhases[index % jsPhases.count])
            jsRaceResults.record(accepted: accepted, snapshot: raced.snapshot())
        }
        let jsRace = jsRaceResults.counts()
        try check(jsRace.accepted == 1)
        try check(jsRace.refused == 31)
        try check(jsRace.invalid == 0)
        let racedCombined = raced.snapshot()
        try checkShape(racedCombined)
        try check(racedCombined.nativeCallsites == racedNative.nativeCallsites)
        try check(racedCombined.lastNativeValidationBoundaries == racedNative.lastNativeValidationBoundaries)
        try check(racedCombined.admittedReportPhases == racedNative.admittedReportPhases)
        try check(!raced.selectJavaScriptFailurePhase(.urlCheck))
        try check(raced.snapshot() == racedCombined)

        // One actual bounded snapshot for the current JS contract to inspect.
        // The caller may save this JSON line as synthetic.json; no I/O is owned
        // by the recorder and no identity, resource or secret enters this row.
        let syntheticBytes = try encoded(combined)
        print(String(decoding: syntheticBytes, as: UTF8.self))
        print("PASS synthetic direct scene-finish recorder harness: \(assertions) assertions; native/OS acceptance unproved")
    }
}
#endif
