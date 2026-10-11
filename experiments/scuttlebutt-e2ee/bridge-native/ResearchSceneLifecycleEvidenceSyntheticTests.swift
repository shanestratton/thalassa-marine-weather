// Host-Mac direct-call harness only. No UIKit, app, simulator or OS transition.
// Compile only with the explicit TEST flag; root owns any later execution.
#if E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST
import Foundation
import Darwin

private enum SceneSyntheticFailure: Error { case refused }

@main
private struct ResearchSceneLifecycleEvidenceSyntheticTests {
    @MainActor static func main() throws {
        typealias Observer = ResearchSceneLifecycleEvidence
        var assertions = 0
        func check(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw SceneSyntheticFailure.refused }
            assertions += 1
        }
        func refused(_ action: () throws -> Void) throws {
            do { try action() }
            catch ResearchSceneLifecycleEvidenceError.unavailable { assertions += 1; return }
            throw SceneSyntheticFailure.refused
        }
        func row(_ observer: Observer) throws -> [String: Any] {
            guard let value = try JSONSerialization.jsonObject(with: observer.serializedReceipt()) as? [String: Any] else {
                throw SceneSyntheticFailure.refused
            }
            return value
        }
        let args = CommandLine.arguments
        guard args.count == 2 else { throw SceneSyntheticFailure.refused }
        let root = URL(fileURLWithPath: args[1], isDirectory: true)
        let run = "91000000-0000-4000-8000-000000000001"
        let observer = try Observer(runID: run, nonce: String(repeating: "a", count: 64),
            resourceSHA256: String(repeating: "b", count: 64))
        let initial = try row(observer)
        try check(initial["evidenceCategory"] as? String == "synthetic-direct-calls")
        try check(initial["osLifecycleProved"] as? Bool == false)
        try check(initial["authorityMutated"] as? Bool == false)
        try check(observer.processID == Int(ProcessInfo.processInfo.processIdentifier))
        try check(UUID(uuidString: observer.processEpoch) != nil)
        try check(initial["eventCount"] as? Int == 1)
        var calls = 0
        try refused {
            try observer.record(eventName: "private-canary", activationState: .unknown, cover: .absent) {
                calls += 1; return .unavailable
            }
        }
        try check(calls == 0)
        try refused {
            try observer.record(event: .processStarted, activationState: .unknown, cover: .absent) {
                calls += 1; return .unavailable
            }
        }
        try check(calls == 0)
        let active = Observer.AuthorityFacts(observationStatus: .observed, facadeObserved: true,
            originalSnapshotObserved: true, accountPresent: true, originalSnapshotCurrent: true,
            verifyFenceCompletions: 1)
        try observer.record(event: .protectedReady, activationState: .foregroundActive, cover: .absent) { active }
        try observer.record(event: .didEnterBackground, activationState: .background, cover: .absent) {
            throw SceneSyntheticFailure.refused
        }
        let captured = try row(observer)
        guard let events = captured["events"] as? [[String: Any]],
              let unknown = events.last?["authority"] as? [String: Any] else { throw SceneSyntheticFailure.refused }
        try check(unknown["observationStatus"] as? String == "unavailable")
        try check(unknown["accountPresent"] is NSNull)
        try check(unknown["originalSnapshotCurrent"] is NSNull)
        try check(events[1]["index"] as? Int == 1 && events[1]["sequence"] as? Int == 2)
        try refused {
            try observer.record(event: .didBecomeActive, activationState: .foregroundActive, cover: .absent) {
                .init(observationStatus: .observed, facadeObserved: false, originalSnapshotObserved: false,
                    accountPresent: nil, originalSnapshotCurrent: nil, verifyFenceCompletions: nil)
            }
        }
        try check(try row(observer)["eventCount"] as? Int == 3)
        for count in [-1, 10001] {
            try refused {
                try observer.record(event: .didBecomeActive, activationState: .foregroundActive, cover: .absent) {
                    .init(observationStatus: .observed, facadeObserved: true, originalSnapshotObserved: true,
                        accountPresent: true, originalSnapshotCurrent: true, verifyFenceCompletions: count)
                }
            }
        }
        try check(try row(observer)["eventCount"] as? Int == 3)
        let file = try observer.persist(inNativeDocumentsRoot: root)
        try check(file.lastPathComponent == "scene-observer.json")
        try check((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let symlink = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(atPath: symlink.path, withDestinationPath: root.path)
        try refused { _ = try observer.persist(inNativeDocumentsRoot: symlink) }
        let second = try Observer(runID: run, nonce: String(repeating: "a", count: 64),
            resourceSHA256: String(repeating: "b", count: 64))
        try check(second.processEpoch == observer.processEpoch)
        // One run/process output cannot be reused by a second observer instance.
        try refused { _ = try second.persist(inNativeDocumentsRoot: root) }
        for _ in 3..<Observer.maximumEvents {
            try observer.record(event: .sceneConnected, activationState: .unknown, cover: .absent)
        }
        try refused {
            try observer.record(event: .didBecomeActive, activationState: .foregroundActive, cover: .absent) {
                calls += 1; return active
            }
        }
        try check(calls == 0)
        let full = try row(observer)
        try check(full["status"] as? String == "capacity-refused")
        try check(full["eventCount"] as? Int == Observer.maximumEvents)
        try check(try observer.persist(inNativeDocumentsRoot: root) == file)
        try refused { _ = try Observer(runID: "bad", nonce: "bad", resourceSHA256: "bad") }
        print("PASS synthetic direct observer harness: \(assertions) assertions; OS lifecycle unproved")
    }
}
#endif
