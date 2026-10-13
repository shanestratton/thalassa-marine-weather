// Passive, bounded preparation for a first-inbox diagnostic. It owns no Auth,
// adapter, ticket, error, message, path, timer or I/O. A marker never grants
// permission, changes a reply or proves that JavaScript consumed publication.
#if E2EE_FIRST_INBOX_STAGE_EVIDENCE_TEST || (E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator))
import Foundation

final class ResearchFirstInboxStageEvidence: @unchecked Sendable {
    enum Stage: String, CaseIterable, Sendable {
        case taskOriginalTicket = "task-original-ticket"
        case adapterOperation = "adapter-operation"
        case publicationOriginalTicket = "publication-original-ticket"
        case resultPublication = "result-publication"
        case completed, failed
    }
    struct Snapshot: Sendable {
        let selectedAttempts: Int
        let markers: [String: Int]
        let integrityRefused: Bool
        var json: [String: Any] {
            ["version": 1, "kind": "first-inbox-stage-diagnostic",
             "selectedAttempts": selectedAttempts, "markers": markers,
             "integrityRefused": integrityRefused, "acceptanceEvidence": false]
        }
    }
    private static let progress: [Stage] = [.taskOriginalTicket, .adapterOperation,
        .publicationOriginalTicket, .resultPublication, .completed]
    private let lock = NSLock()
    private var selected = false
    private var next = 0
    private var terminal = false
    private var refused = false
    private var markers = Dictionary(uniqueKeysWithValues: Stage.allCases.map { ($0.rawValue, 0) })

    // The future caller must retain this Boolean for the selected Task and
    // never call note from later attempts. This method does not reset state.
    func beginFirstInbox() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !selected, !refused else { return false }
        selected = true
        return true
    }
    func note(_ stage: Stage) {
        lock.lock(); defer { lock.unlock() }
        guard !refused else { return }
        guard selected, !terminal else { refused = true; return }
        if stage == .failed {
            guard next >= 1, next <= 4 else { refused = true; return }
            markers[stage.rawValue] = 1
            terminal = true
            return
        }
        guard next < Self.progress.count, Self.progress[next] == stage else {
            refused = true; return
        }
        markers[stage.rawValue] = 1
        next += 1
        if stage == .completed { terminal = true }
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(selectedAttempts: selected ? 1 : 0, markers: markers,
                        integrityRefused: refused)
    }
}
#endif
