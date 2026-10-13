// Passive simulator-only progress diagnostics. A fixed phase names the stage
// currently entered/observed; it never means that stage completed or failed.
// The bounded value recorder grants no permission or acceptance, and retains no
// report, account, facade, scope, token, credential, closure, error, timer or I/O.
#if E2EE_SCENE_PROGRESS_STAGE_EVIDENCE_TEST || (E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator))
import Foundation

final class ResearchSceneProgressStageEvidence: @unchecked Sendable {
    static let maximumEntries = 64

    // Same fixed strings as the fixture's JavaScript failure-phase vocabulary,
    // with separate progress meaning. Even send-accepted/proof-captured only
    // name the current stage; these diagnostics cannot assert their success.
    enum JavaScriptPhase: String, CaseIterable, Sendable {
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

    struct DOMFacts: Equatable, Sendable {
        let sendPresent: Bool?
        let sendEnabled: Bool?
        let composePresent: Bool?
        let composeEmpty: Bool?
        let composeDisabled: Bool?
        let composeReadOnly: Bool?

        init(sendPresent: Bool? = nil, sendEnabled: Bool? = nil,
             composePresent: Bool? = nil, composeEmpty: Bool? = nil,
             composeDisabled: Bool? = nil, composeReadOnly: Bool? = nil) {
            self.sendPresent = sendPresent
            self.sendEnabled = sendEnabled
            self.composePresent = composePresent
            self.composeEmpty = composeEmpty
            self.composeDisabled = composeDisabled
            self.composeReadOnly = composeReadOnly
        }

        // An absent or unknown element cannot supply a child fact. A known
        // present element may still have an unknown child fact, represented nil.
        fileprivate var isConsistent: Bool {
            (sendPresent == true || sendEnabled == nil) &&
                (composePresent == true ||
                    (composeEmpty == nil && composeDisabled == nil && composeReadOnly == nil))
        }
    }

    struct Entry: Equatable, Sendable {
        let sequence: Int
        let phase: JavaScriptPhase
        let dom: DOMFacts

        fileprivate init(sequence: Int, phase: JavaScriptPhase, dom: DOMFacts) {
            self.sequence = sequence
            self.phase = phase
            self.dom = dom
        }

        fileprivate var json: [String: Any] {
            ["sequence": sequence, "phase": phase.rawValue,
             "sendPresent": dom.sendPresent.map { $0 as Any } ?? NSNull(),
             "sendEnabled": dom.sendEnabled.map { $0 as Any } ?? NSNull(),
             "composePresent": dom.composePresent.map { $0 as Any } ?? NSNull(),
             "composeEmpty": dom.composeEmpty.map { $0 as Any } ?? NSNull(),
             "composeDisabled": dom.composeDisabled.map { $0 as Any } ?? NSNull(),
             "composeReadOnly": dom.composeReadOnly.map { $0 as Any } ?? NSNull()]
        }
    }

    struct Snapshot: Equatable, Sendable {
        let entries: [Entry]

        fileprivate init(entries: [Entry]) { self.entries = entries }

        var json: [String: Any] {
            ["version": 1, "kind": "scene-progress-stage-diagnostic",
             "entries": entries.map { $0.json }, "acceptanceEvidence": false]
        }
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    // Sequence is the sole ordering rule, starting at one with no gaps. A phase
    // may recur at a new sequence when its allowlisted DOM facts are observed.
    // Refusal leaves all previously captured immutable value facts unchanged.
    @discardableResult
    func record(sequence: Int, phase: JavaScriptPhase, dom: DOMFacts) -> Bool {
        guard dom.isConsistent else { return false }
        lock.lock(); defer { lock.unlock() }
        guard entries.count < Self.maximumEntries,
              (1...Self.maximumEntries).contains(sequence),
              sequence == entries.count + 1 else { return false }
        entries.append(Entry(sequence: sequence, phase: phase, dom: dom))
        return true
    }

    // Narrow fixed-name seam: unknown/oversized names refuse before selection
    // and are never retained. This cannot parse a report or establish admission.
    @discardableResult
    func record(sequence: Int, phaseName: String, dom: DOMFacts) -> Bool {
        guard phaseName.utf8.count <= 48,
              let phase = JavaScriptPhase(rawValue: phaseName) else { return false }
        return record(sequence: sequence, phase: phase, dom: dom)
    }

    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(entries: entries)
    }
}
#endif
