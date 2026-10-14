// Direct-call harness only. The explicit TEST flag owns clock injection and
// this executable entry point. Neither exists in ordinary disabled compilation.
// No app, simulator, native permission, provider or OS transition is exercised.
#if E2EE_SCENE_AUTHORITY_TIMING_EVIDENCE_TEST
import Foundation

private enum SceneAuthorityTimingSyntheticFailure: Error { case refused }

private final class SceneAuthorityTimingSyntheticClock {
    private let lock = NSLock()
    private let origin = ContinuousClock.now
    private var offset: Duration = .zero
    func set(_ offset: Duration) { lock.lock(); self.offset = offset; lock.unlock() }
    func now() -> ContinuousClock.Instant {
        lock.lock(); defer { lock.unlock() }
        return origin.advanced(by: offset)
    }
}

@main
private struct ResearchSceneAuthorityTimingEvidenceSyntheticTests {
    static func main() throws {
        typealias Recorder = ResearchSceneAuthorityTimingEvidence
        var assertions = 0
        func check(_ value: @autoclosure () throws -> Bool) throws {
            guard try value() else { throw SceneAuthorityTimingSyntheticFailure.refused }
            assertions += 1
        }
        func encoded(_ value: Any) throws -> Data {
            try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        }
        func rows(_ snapshot: [String: Any]) throws -> [[String: Any]] {
            guard let value = snapshot["entries"] as? [[String: Any]] else {
                throw SceneAuthorityTimingSyntheticFailure.refused
            }
            return value
        }
        let phases = ["verify-completed", "original-captured", "original-rechecked", "protected-setup",
            "peer-reply", "proof-captured", "protected-report", "authority-observed", "authority-unavailable", "original-cleared"]
        let buckets = ["unobserved", "lt-1s", "1s-to-lt-10s", "10s-to-lt-30s", "30s-to-lt-60s",
            "60s-to-lt-120s", "ge-120s"]
        let statuses = ["recording", "capacity-refused", "clock-refused", "input-refused"]
        let header = ["version", "kind", "evidenceCategory", "status", "entries", "acceptanceEvidence", "authorityMutated"]
        let fields = ["sequence", "phase", "sinceFirstVerify", "sinceOriginalCapture", "fenceAttempts",
            "verifyCompletions", "facadeObserved", "originalObserved", "accountPresent", "originalCurrent"]
        func shape(_ snapshot: [String: Any]) throws {
            try check(Set(snapshot.keys) == Set(header))
            try check(snapshot["version"] as? Int == 1)
            try check(snapshot["kind"] as? String == "scene-authority-timing-diagnostic")
            try check(snapshot["evidenceCategory"] as? String == "synthetic-direct-calls")
            try check(statuses.contains(snapshot["status"] as? String ?? ""))
            try check(snapshot["acceptanceEvidence"] as? Bool == false)
            try check(snapshot["authorityMutated"] as? Bool == false)
            let entries = try rows(snapshot)
            try check(entries.count <= 32)
            for (index, entry) in entries.enumerated() {
                try check(Set(entry.keys) == Set(fields))
                try check(entry["sequence"] as? Int == index + 1)
                try check(phases.contains(entry["phase"] as? String ?? ""))
                for name in ["sinceFirstVerify", "sinceOriginalCapture"] {
                    try check(buckets.contains(entry[name] as? String ?? ""))
                }
                for name in ["fenceAttempts", "verifyCompletions"] {
                    if let count = entry[name] as? Int { try check((0...10000).contains(count)) }
                    else { try check(entry[name] is NSNull) }
                }
                for name in ["facadeObserved", "originalObserved"] { try check(entry[name] is Bool) }
                for name in ["accountPresent", "originalCurrent"] {
                    try check(entry[name] is NSNull || entry[name] is Bool)
                }
                if !(entry["originalCurrent"] is NSNull) { try check(entry["originalObserved"] as? Bool == true) }
                if entry["phase"] as? String == "authority-observed" {
                    try check(entry["facadeObserved"] as? Bool == true)
                    try check(entry["accountPresent"] is Bool)
                    try check((entry["originalObserved"] as? Bool == true) == (entry["originalCurrent"] is Bool))
                }
            }
            try check((1...16384).contains(try encoded(snapshot).count))
        }
        func unknown(_ recorder: Recorder, _ phase: Recorder.Phase = .protectedReport) {
            recorder.record(phase, fenceAttempts: nil, verifyCompletions: nil,
                facadeObserved: false, originalObserved: false)
        }
        func anchors(_ recorder: Recorder) {
            recorder.record(.verifyCompleted, fenceAttempts: 1, verifyCompletions: 1,
                facadeObserved: true, originalObserved: false)
            recorder.record(.originalCaptured, fenceAttempts: 1, verifyCompletions: 1,
                facadeObserved: true, originalObserved: true)
        }
        try check(Recorder.maximumEntries == 32)
        try check(Recorder.maximumBytes == 16384)
        try check(Recorder.Phase.allCases.map { $0.rawValue } == phases)
        try check(Set(phases).count == 10)

        let empty = Recorder().snapshot()
        try shape(empty)
        try check(try rows(empty).isEmpty)
        let defaultClock = Recorder()
        unknown(defaultClock)
        try shape(defaultClock.snapshot())
        let unknownRow = try rows(defaultClock.snapshot())[0]
        try check(unknownRow["sinceFirstVerify"] as? String == "unobserved")
        try check(unknownRow["sinceOriginalCapture"] as? String == "unobserved")
        for name in ["fenceAttempts", "verifyCompletions", "accountPresent", "originalCurrent"] {
            try check(unknownRow[name] is NSNull)
        }
        try check(unknownRow["facadeObserved"] as? Bool == false)
        try check(unknownRow["originalObserved"] as? Bool == false)

        // The boundary immediately below and exactly at every threshold is
        // tested with a deterministic native instant, never a sleep or timer.
        let ageCases: [(Duration, String)] = [
            (.zero, "lt-1s"), (.nanoseconds(999_999_999), "lt-1s"),
            (.seconds(1), "1s-to-lt-10s"), (.nanoseconds(9_999_999_999), "1s-to-lt-10s"),
            (.seconds(10), "10s-to-lt-30s"), (.nanoseconds(29_999_999_999), "10s-to-lt-30s"),
            (.seconds(30), "30s-to-lt-60s"), (.nanoseconds(59_999_999_999), "30s-to-lt-60s"),
            (.seconds(60), "60s-to-lt-120s"), (.nanoseconds(119_999_999_999), "60s-to-lt-120s"),
            (.seconds(120), "ge-120s"), (.seconds(100000), "ge-120s"),
        ]
        for (offset, expected) in ageCases {
            let clock = SceneAuthorityTimingSyntheticClock()
            let recorder = Recorder(clockForResearch: clock.now)
            anchors(recorder)
            let first = recorder.snapshot()
            clock.set(offset)
            unknown(recorder)
            let after = recorder.snapshot()
            try shape(after)
            let entry = try rows(after)[2]
            try check(entry["sinceFirstVerify"] as? String == expected)
            try check(entry["sinceOriginalCapture"] as? String == expected)
            try check(try encoded(Array(rows(after).prefix(2))) == encoded(rows(first)))
        }

        let timelineClock = SceneAuthorityTimingSyntheticClock()
        let timeline = Recorder(clockForResearch: timelineClock.now)
        timeline.record(.verifyCompleted, fenceAttempts: 1, verifyCompletions: 1,
            facadeObserved: true, originalObserved: false)
        timelineClock.set(.seconds(10))
        timeline.record(.originalCaptured, fenceAttempts: 1, verifyCompletions: 1,
            facadeObserved: true, originalObserved: true, accountPresent: true, originalCurrent: true)
        timelineClock.set(.seconds(60))
        timeline.record(.authorityObserved, fenceAttempts: 1, verifyCompletions: 1,
            facadeObserved: true, originalObserved: true, accountPresent: false, originalCurrent: false)
        let stale = timeline.snapshot()
        try shape(stale)
        try check(try rows(stale)[2]["sinceFirstVerify"] as? String == "60s-to-lt-120s")
        try check(try rows(stale)[2]["sinceOriginalCapture"] as? String == "30s-to-lt-60s")
        // A later successful verification must not renew either original age.
        timelineClock.set(.seconds(120))
        timeline.record(.verifyCompleted, fenceAttempts: 1, verifyCompletions: 2,
            facadeObserved: true, originalObserved: true)
        let later = timeline.snapshot()
        try shape(later)
        try check(try rows(later)[3]["sinceFirstVerify"] as? String == "ge-120s")
        try check(try rows(later)[3]["sinceOriginalCapture"] as? String == "60s-to-lt-120s")
        try check(try rows(later)[3]["verifyCompletions"] as? Int == 2)
        try check(try rows(stale).count == 3)
        timelineClock.set(.seconds(180))
        timeline.record(.originalCleared, fenceAttempts: nil, verifyCompletions: nil,
            facadeObserved: true, originalObserved: false)
        let cleared = timeline.snapshot()
        try shape(cleared)
        try check(try rows(cleared)[4]["sinceOriginalCapture"] as? String == "ge-120s")
        try check(try rows(cleared)[4]["originalCurrent"] is NSNull)
        timeline.record(.originalCaptured, fenceAttempts: 2, verifyCompletions: 2,
            facadeObserved: true, originalObserved: true)
        try check(timeline.snapshot()["status"] as? String == "input-refused")
        try check(try encoded(rows(timeline.snapshot())) == encoded(rows(cleared)))

        // Original capture is once-only even before clearing. A replacement
        // cannot rewrite an old entry or its first-capture timestamp.
        let duplicateClock = SceneAuthorityTimingSyntheticClock()
        let duplicate = Recorder(clockForResearch: duplicateClock.now)
        anchors(duplicate)
        let beforeDuplicate = duplicate.snapshot()
        duplicateClock.set(.seconds(5))
        duplicate.record(.originalCaptured, fenceAttempts: 1, verifyCompletions: 1,
            facadeObserved: true, originalObserved: true)
        try check(duplicate.snapshot()["status"] as? String == "input-refused")
        try check(try encoded(rows(duplicate.snapshot())) == encoded(rows(beforeDuplicate)))
        let refusedBytes = try encoded(duplicate.snapshot())
        unknown(duplicate)
        try check(try encoded(duplicate.snapshot()) == refusedBytes)
        let clearedBeforeCapture = Recorder()
        clearedBeforeCapture.record(.originalCleared, fenceAttempts: nil, verifyCompletions: nil,
            facadeObserved: false, originalObserved: false)
        clearedBeforeCapture.record(.originalCaptured, fenceAttempts: nil, verifyCompletions: nil,
            facadeObserved: true, originalObserved: true)
        try check(clearedBeforeCapture.snapshot()["status"] as? String == "input-refused")

        for phase in Recorder.Phase.allCases {
            let recorder = Recorder()
            switch phase {
            case .verifyCompleted:
                recorder.record(phase, fenceAttempts: nil, verifyCompletions: 1,
                    facadeObserved: true, originalObserved: false)
            case .originalCaptured:
                recorder.record(phase, fenceAttempts: nil, verifyCompletions: nil,
                    facadeObserved: true, originalObserved: true)
            case .authorityObserved:
                recorder.record(phase, fenceAttempts: nil, verifyCompletions: nil,
                    facadeObserved: true, originalObserved: false, accountPresent: false)
            default: unknown(recorder, phase)
            }
            try shape(recorder.snapshot())
            try check(recorder.snapshot()["status"] as? String == "recording")
            try check(try rows(recorder.snapshot())[0]["phase"] as? String == phase.rawValue)
        }

        // Counts are independent nullable observations, not a permission test.
        // Successful native-owner fences need not be JS plugin-call attempts.
        let counts: [Int?] = [nil, 0, 1, 9999, 10000]
        for attempts in counts {
            for completions in counts {
                let recorder = Recorder()
                recorder.record(.protectedReport, fenceAttempts: attempts, verifyCompletions: completions,
                    facadeObserved: false, originalObserved: false)
                try shape(recorder.snapshot())
                let entry = try rows(recorder.snapshot())[0]
                if let attempts { try check(entry["fenceAttempts"] as? Int == attempts) }
                else { try check(entry["fenceAttempts"] is NSNull) }
                if let completions { try check(entry["verifyCompletions"] as? Int == completions) }
                else { try check(entry["verifyCompletions"] is NSNull) }
                try check(entry["sinceFirstVerify"] as? String == "unobserved")
            }
        }
        for invalid in [Int.min, -1, 10001, Int.max] {
            for badAttempts in [false, true] {
                let recorder = Recorder()
                unknown(recorder)
                let before = recorder.snapshot()
                recorder.record(.protectedReport, fenceAttempts: badAttempts ? invalid : nil,
                    verifyCompletions: badAttempts ? nil : invalid, facadeObserved: false, originalObserved: false)
                try check(recorder.snapshot()["status"] as? String == "input-refused")
                try check(try encoded(rows(recorder.snapshot())) == encoded(rows(before)))
            }
        }

        typealias InvalidMode = (Recorder.Phase, Bool, Bool, Bool?, Bool?, Int?)
        let invalidModes: [InvalidMode] = [
            (.verifyCompleted, true, false, nil, nil, nil),
            (.verifyCompleted, true, false, nil, nil, 0),
            (.verifyCompleted, false, false, nil, nil, 1),
            (.originalCaptured, true, false, nil, nil, nil),
            (.originalCaptured, false, true, nil, nil, nil),
            (.authorityObserved, false, false, false, nil, nil),
            (.authorityObserved, true, false, nil, nil, nil),
            (.authorityObserved, true, true, true, nil, nil),
            (.authorityObserved, true, false, false, false, nil),
            (.authorityUnavailable, true, false, nil, nil, nil),
            (.authorityUnavailable, false, false, false, nil, nil),
            (.originalCleared, true, true, nil, nil, nil),
            (.protectedSetup, false, true, nil, nil, nil),
            (.peerReply, true, false, nil, true, nil),
            (.proofCaptured, false, false, true, nil, nil),
        ]
        for (phase, facade, original, account, current, completions) in invalidModes {
            let recorder = Recorder()
            unknown(recorder)
            let before = recorder.snapshot()
            recorder.record(phase, fenceAttempts: nil, verifyCompletions: completions,
                facadeObserved: facade, originalObserved: original, accountPresent: account, originalCurrent: current)
            try shape(recorder.snapshot())
            try check(recorder.snapshot()["status"] as? String == "input-refused")
            try check(try encoded(rows(recorder.snapshot())) == encoded(rows(before)))
        }
        for originalObserved in [false, true] {
            for account in [false, true] {
                for current in [false, true] {
                    let recorder = Recorder()
                    recorder.record(.authorityObserved, fenceAttempts: nil, verifyCompletions: nil,
                        facadeObserved: true, originalObserved: originalObserved,
                        accountPresent: account, originalCurrent: originalObserved ? current : nil)
                    try shape(recorder.snapshot())
                    try check(recorder.snapshot()["status"] as? String == "recording")
                }
            }
        }

        // Regressions refuse even before either anchor exists. A later corrected
        // sample cannot hide the refusal or replace a previously appended row.
        for anchored in [false, true] {
            let clock = SceneAuthorityTimingSyntheticClock()
            let recorder = Recorder(clockForResearch: clock.now)
            clock.set(.seconds(10))
            if anchored { anchors(recorder) }
            else { unknown(recorder) }
            let before = recorder.snapshot()
            clock.set(.seconds(9))
            unknown(recorder)
            try check(recorder.snapshot()["status"] as? String == "clock-refused")
            try check(try encoded(rows(recorder.snapshot())) == encoded(rows(before)))
            let refused = try encoded(recorder.snapshot())
            clock.set(.seconds(11))
            unknown(recorder)
            try check(try encoded(recorder.snapshot()) == refused)
        }

        let largestClock = SceneAuthorityTimingSyntheticClock()
        let largest = Recorder(clockForResearch: largestClock.now)
        anchors(largest)
        largestClock.set(.seconds(60))
        for sequence in 3...32 {
            let before = largest.snapshot()
            largest.record(.authorityUnavailable, fenceAttempts: 10000, verifyCompletions: 10000,
                facadeObserved: false, originalObserved: false)
            let after = largest.snapshot()
            try shape(after)
            try check(try rows(after).count == sequence)
            try check(try encoded(Array(rows(after).dropLast())) == encoded(rows(before)))
        }
        let full = largest.snapshot()
        let fullBytes = try encoded(full)
        try check(fullBytes.count <= 16384)
        unknown(largest)
        let overflow = largest.snapshot()
        try shape(overflow)
        try check(overflow["status"] as? String == "capacity-refused")
        try check(try encoded(rows(overflow)) == encoded(rows(full)))
        let overflowBytes = try encoded(overflow)
        for _ in 0..<3 { unknown(largest) }
        try check(try encoded(largest.snapshot()) == overflowBytes)

        var detached = full
        detached["version"] = 999
        var detachedRows = try rows(detached)
        detachedRows[0]["phase"] = "private-canary"
        detached["entries"] = detachedRows
        try check(try encoded(largest.snapshot()) == overflowBytes)
        try check(full["version"] as? Int == 1)
        try check(try rows(full)[0]["phase"] as? String == "verify-completed")

        for canary in ["private-token-canary", "private-account-canary", "private-message-canary",
            "12345678-1234-4234-8234-123456789abc", "verify-completed\n", String(repeating: "x", count: 4096)] {
            try check(Recorder.Phase(rawValue: canary) == nil)
            try check(!String(decoding: fullBytes, as: UTF8.self).contains(canary))
        }
        for name in ["snapshot", "credential", "account", "facade", "error", "nonce", "runID",
            "revision", "credentialEpoch", "ownerGeneration", "timestamp", "deadline", "clock", "permission"] {
            try check(full[name] == nil)
            for entry in try rows(full) { try check(entry[name] == nil) }
        }

        // Only the TEST executable prints one bounded actual synthetic snapshot
        // for a separate strict JS parser. The production recorder has no I/O.
        print(String(decoding: try encoded(later), as: UTF8.self))
        print("PASS synthetic scene-authority timing harness: \(assertions) assertions; maximum JSON \(overflowBytes.count) bytes; authority/OS acceptance unproved")
    }
}
#endif
