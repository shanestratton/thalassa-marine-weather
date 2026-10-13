// Direct-call Foundation contracts only: no app/OS/Auth/crypto execution.
#if E2EE_FIRST_INBOX_STAGE_EVIDENCE_TEST
import Foundation

private final class FirstInboxSyntheticWinners: @unchecked Sendable {
    private let lock = NSLock()
    private var winners = 0
    func record() { lock.lock(); winners += 1; lock.unlock() }
    func count() -> Int { lock.lock(); defer { lock.unlock() }; return winners }
}

@main
struct ResearchFirstInboxStageEvidenceSyntheticTests {
    static func main() throws {
        var assertions = 0
        func check(_ value: Bool) {
            assertions += 1
            precondition(value, "Synthetic inbox-stage contract failed")
        }
        let progress: [ResearchFirstInboxStageEvidence.Stage] = [.taskOriginalTicket,
            .adapterOperation, .publicationOriginalTicket, .resultPublication, .completed]
        let successful = ResearchFirstInboxStageEvidence()
        check(successful.snapshot().selectedAttempts == 0)
        check(successful.snapshot().markers.values.allSatisfy { $0 == 0 })
        check(successful.beginFirstInbox())
        check(!successful.beginFirstInbox())
        for (index, stage) in progress.enumerated() {
            successful.note(stage)
            let value = successful.snapshot()
            check(!value.integrityRefused)
            check(value.markers.values.allSatisfy { $0 == 0 || $0 == 1 })
            check(value.markers.values.reduce(0, +) == index + 1)
        }
        check(successful.snapshot().markers["completed"] == 1)
        check(successful.snapshot().markers["failed"] == 0)
        check(!successful.beginFirstInbox())
        let frozen = successful.snapshot()
        successful.note(.failed)
        check(successful.snapshot().integrityRefused)
        check(successful.snapshot().markers == frozen.markers)
        for length in 1...4 {
            let failed = ResearchFirstInboxStageEvidence()
            check(failed.beginFirstInbox())
            for stage in progress.prefix(length) { failed.note(stage) }
            failed.note(.failed)
            let value = failed.snapshot()
            check(!value.integrityRefused)
            check(value.markers["failed"] == 1)
            check(value.markers["completed"] == 0)
            check(value.markers.values.reduce(0, +) == length + 1)
            check(!failed.beginFirstInbox())
            failed.note(.completed)
            check(failed.snapshot().markers == value.markers)
            check(failed.snapshot().integrityRefused)
        }
        for invalid in [ResearchFirstInboxStageEvidence.Stage.adapterOperation,
                        .publicationOriginalTicket, .resultPublication, .completed, .failed] {
            let recorder = ResearchFirstInboxStageEvidence()
            check(recorder.beginFirstInbox())
            recorder.note(invalid)
            check(recorder.snapshot().integrityRefused)
            check(recorder.snapshot().markers.values.allSatisfy { $0 == 0 })
        }
        let unselected = ResearchFirstInboxStageEvidence()
        unselected.note(.taskOriginalTicket)
        check(unselected.snapshot().integrityRefused)
        check(!unselected.beginFirstInbox())
        check(unselected.snapshot().selectedAttempts == 0)
        let duplicate = ResearchFirstInboxStageEvidence()
        check(duplicate.beginFirstInbox())
        duplicate.note(.taskOriginalTicket)
        duplicate.note(.taskOriginalTicket)
        check(duplicate.snapshot().integrityRefused)
        check(duplicate.snapshot().markers["task-original-ticket"] == 1)
        let data = try JSONSerialization.data(withJSONObject: frozen.json, options: [.sortedKeys])
        let value = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        check(Set(value.keys) == Set(["version", "kind", "selectedAttempts", "markers", "integrityRefused", "acceptanceEvidence"]))
        check(value["acceptanceEvidence"] as? Bool == false)
        let concurrent = ResearchFirstInboxStageEvidence()
        let winners = FirstInboxSyntheticWinners()
        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            if concurrent.beginFirstInbox() { winners.record() }
        }
        check(winners.count() == 1)
        check(concurrent.snapshot().selectedAttempts == 1)
        check(!concurrent.snapshot().integrityRefused)
        check(concurrent.snapshot().markers.values.allSatisfy { $0 == 0 })
        print(String(data: try JSONSerialization.data(withJSONObject: [
            "kind": "synthetic-foundation-first-inbox-stage-contracts", "assertions": assertions,
            "passed": true, "nativeAppExecution": false, "osLifecycleExecution": false,
            "cryptographicExecution": false, "diagnosticSnapshot": frozen.json],
            options: [.sortedKeys]), encoding: .utf8)!)
    }
}
#endif
