// Passive timing facts for one isolated simulator process. No authority,
// snapshot, credential, actor, identifier, report, error, timer or I/O is owned.
// Ages describe observed boundaries; they cannot establish a lease deadline.
#if (E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)) || E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
import Foundation

final class ResearchSceneAuthorityTimingEvidence: @unchecked Sendable {
    static let maximumEntries = 32
    static let maximumBytes = 16384

    enum Phase: String, CaseIterable, Sendable {
        case verifyCompleted = "verify-completed"
        case originalCaptured = "original-captured"
        case originalRechecked = "original-rechecked"
        case protectedSetup = "protected-setup"
        case peerReply = "peer-reply"
        case proofCaptured = "proof-captured"
        case protectedReport = "protected-report"
        case authorityObserved = "authority-observed"
        case authorityUnavailable = "authority-unavailable"
        case originalCleared = "original-cleared"
    }

    private enum Status: String {
        case recording
        case capacityRefused = "capacity-refused"
        case clockRefused = "clock-refused"
        case inputRefused = "input-refused"
    }

    private struct Entry {
        let sequence: Int
        let phase: Phase
        let sinceFirstVerify: String
        let sinceOriginalCapture: String
        let fenceAttempts: Int?
        let verifyCompletions: Int?
        let facadeObserved: Bool
        let originalObserved: Bool
        let accountPresent: Bool?
        let originalCurrent: Bool?

        var json: [String: Any] {
            ["sequence": sequence, "phase": phase.rawValue,
             "sinceFirstVerify": sinceFirstVerify, "sinceOriginalCapture": sinceOriginalCapture,
             "fenceAttempts": fenceAttempts.map { $0 as Any } ?? NSNull(),
             "verifyCompletions": verifyCompletions.map { $0 as Any } ?? NSNull(),
             "facadeObserved": facadeObserved, "originalObserved": originalObserved,
             "accountPresent": accountPresent.map { $0 as Any } ?? NSNull(),
             "originalCurrent": originalCurrent.map { $0 as Any } ?? NSNull()]
        }
    }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private var status: Status = .recording
    private var lastInstant: ContinuousClock.Instant?
    private var firstVerifyInstant: ContinuousClock.Instant?
    private var originalCaptureInstant: ContinuousClock.Instant?
    private var originalWasCleared = false
#if E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
    // This injected callback exists ONLY in direct-call synthetic compilation.
    // Production has no caller-supplied clock, callback or dependency seam.
    private let clockForResearch: (() -> ContinuousClock.Instant)?
    init(clockForResearch: @escaping () -> ContinuousClock.Instant) {
        self.clockForResearch = clockForResearch
    }
#endif

    init() {
#if E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
        clockForResearch = nil
#endif
    }

    private func now() -> ContinuousClock.Instant {
#if E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
        if let clockForResearch { return clockForResearch() }
#endif
        return ContinuousClock.now
    }

    private static func validCount(_ value: Int?) -> Bool {
        guard let value else { return true }
        return (0...10000).contains(value)
    }

    private static func age(from start: ContinuousClock.Instant?, to instant: ContinuousClock.Instant) -> String? {
        guard let start else { return "unobserved" }
        guard instant >= start else { return nil }
        let elapsed = start.duration(to: instant)
        guard elapsed >= .zero else { return nil }
        if elapsed < .seconds(1) { return "lt-1s" }
        if elapsed < .seconds(10) { return "1s-to-lt-10s" }
        if elapsed < .seconds(30) { return "10s-to-lt-30s" }
        if elapsed < .seconds(60) { return "30s-to-lt-60s" }
        if elapsed < .seconds(120) { return "60s-to-lt-120s" }
        return "ge-120s"
    }

    // No operation is dispatched by this method. Facts must come from the
    // caller's already observed boundaries, not from a fresh authority query.
    // Any refusal is sticky; previously appended immutable entries survive.
    func record(_ phase: Phase, fenceAttempts: Int?, verifyCompletions: Int?,
                facadeObserved: Bool, originalObserved: Bool,
                accountPresent: Bool? = nil, originalCurrent: Bool? = nil) {
        lock.lock(); defer { lock.unlock() }
        guard status == .recording else { return }
        guard entries.count < Self.maximumEntries else { status = .capacityRefused; return }
        guard Self.validCount(fenceAttempts), Self.validCount(verifyCompletions),
              !originalObserved || facadeObserved,
              (accountPresent == nil && originalCurrent == nil) || facadeObserved,
              originalCurrent == nil || originalObserved,
              !originalWasCleared || !originalObserved else { status = .inputRefused; return }
        switch phase {
        case .verifyCompleted:
            guard facadeObserved, let count = verifyCompletions, count > 0 else { status = .inputRefused; return }
        case .originalCaptured:
            guard facadeObserved, originalObserved, originalCaptureInstant == nil,
                  !originalWasCleared else { status = .inputRefused; return }
        case .authorityObserved:
            guard facadeObserved, accountPresent != nil,
                  originalObserved == (originalCurrent != nil) else { status = .inputRefused; return }
        case .authorityUnavailable:
            guard !facadeObserved, !originalObserved, accountPresent == nil,
                  originalCurrent == nil else { status = .inputRefused; return }
        case .originalCleared:
            guard !originalObserved, originalCurrent == nil else { status = .inputRefused; return }
        default: break
        }
        let instant = now()
        if let lastInstant, instant < lastInstant { status = .clockRefused; return }
        let verify = firstVerifyInstant ?? (phase == .verifyCompleted ? instant : nil)
        let original = originalCaptureInstant ?? (phase == .originalCaptured ? instant : nil)
        guard let sinceVerify = Self.age(from: verify, to: instant),
              let sinceOriginal = Self.age(from: original, to: instant) else { status = .clockRefused; return }
        let entry = Entry(sequence: entries.count + 1, phase: phase,
            sinceFirstVerify: sinceVerify, sinceOriginalCapture: sinceOriginal,
            fenceAttempts: fenceAttempts, verifyCompletions: verifyCompletions,
            facadeObserved: facadeObserved, originalObserved: originalObserved,
            accountPresent: accountPresent, originalCurrent: originalCurrent)
        // Reserve the longest refusal status spelling before committing. JSON
        // serialization uses only fixed names and copied bounded value facts.
        let candidate = copied(entries: entries + [entry], status: .capacityRefused)
        guard let bytes = try? JSONSerialization.data(withJSONObject: candidate, options: [.sortedKeys]),
              bytes.count <= Self.maximumBytes else { status = .capacityRefused; return }
        entries.append(entry)
        firstVerifyInstant = verify; originalCaptureInstant = original; lastInstant = instant
        if phase == .originalCleared { originalWasCleared = true }
    }

    private func copied(entries: [Entry], status: Status) -> [String: Any] {
#if E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
        let category = "synthetic-direct-calls"
#else
        let category = "simulator-native-observations"
#endif
        return ["version": 1, "kind": "scene-authority-timing-diagnostic",
                "evidenceCategory": category, "status": status.rawValue,
                "entries": entries.map { $0.json }, "acceptanceEvidence": false, "authorityMutated": false]
    }

    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return copied(entries: entries, status: status)
    }
}
#endif
