// Host-Mac direct-call source only. These synthetic checks establish no app,
// simulator, crypto, permission, JavaScript-consumption or OS-transition proof.
// Compile/run only under the explicit TEST flag when no build job is active.
#if E2EE_SCENE_PROGRESS_STAGE_EVIDENCE_TEST
import Foundation

private enum SceneProgressSyntheticFailure: Error { case refused }

@main
private struct ResearchSceneProgressStageEvidenceSyntheticTests {
    static func main() throws {
        typealias Recorder = ResearchSceneProgressStageEvidence
        var assertions = 0
        func check(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw SceneProgressSyntheticFailure.refused }
            assertions += 1
        }
        func encoded(_ snapshot: Recorder.Snapshot) throws -> Data {
            let bytes = try JSONSerialization.data(withJSONObject: snapshot.json, options: [.sortedKeys])
            try check((1...16384).contains(bytes.count))
            return bytes
        }
        func checkShape(_ snapshot: Recorder.Snapshot) throws {
            try check((0...64).contains(snapshot.entries.count))
            let json = snapshot.json
            try check(Set(json.keys) == Set(["version", "kind", "entries", "acceptanceEvidence"]))
            try check(json["version"] as? Int == 1)
            try check(json["kind"] as? String == "scene-progress-stage-diagnostic")
            try check(json["acceptanceEvidence"] as? Bool == false)
            guard let rows = json["entries"] as? [[String: Any]] else { throw SceneProgressSyntheticFailure.refused }
            try check(rows.count == snapshot.entries.count)
            for (index, entry) in snapshot.entries.enumerated() {
                try check(entry.sequence == index + 1)
                try check((1...64).contains(entry.sequence))
                let row = rows[index]
                try check(Set(row.keys) == Set(["sequence", "phase", "sendPresent", "sendEnabled",
                    "composePresent", "composeEmpty", "composeDisabled", "composeReadOnly"]))
                try check(row["sequence"] as? Int == entry.sequence)
                try check(row["phase"] as? String == entry.phase.rawValue)
                let facts: [(String, Bool?)] = [("sendPresent", entry.dom.sendPresent),
                    ("sendEnabled", entry.dom.sendEnabled), ("composePresent", entry.dom.composePresent),
                    ("composeEmpty", entry.dom.composeEmpty), ("composeDisabled", entry.dom.composeDisabled),
                    ("composeReadOnly", entry.dom.composeReadOnly)]
                for (name, fact) in facts {
                    if let fact { try check(row[name] as? Bool == fact) }
                    else { try check(row[name] is NSNull) }
                }
                if entry.dom.sendPresent != true { try check(entry.dom.sendEnabled == nil) }
                if entry.dom.composePresent != true {
                    try check(entry.dom.composeEmpty == nil)
                    try check(entry.dom.composeDisabled == nil)
                    try check(entry.dom.composeReadOnly == nil)
                }
            }
            _ = try encoded(snapshot)
        }

        // Freeze the actual fixed vocabulary independently of the implementation.
        let phases = ["cold-ready", "cold-chat-closed", "authenticated", "unknown-admission", "prepared",
            "native-admission", "inbox-entry", "thread-open", "send-enabled", "send-accepted", "reply-refresh-enabled",
            "peer-reply", "receive-refresh-enabled", "receive-refresh-completion", "incoming-received",
            "dedup-refresh-enabled", "dedup-refresh-completion", "proof-captured", "url-check", "await-foreground",
            "await-closed-window", "closure-post", "await-closure-ack"]
        try check(Recorder.maximumEntries == 64)
        try check(Recorder.JavaScriptPhase.allCases.map { $0.rawValue } == phases)
        try check(Recorder.JavaScriptPhase.allCases.count == 23)
        try check(Set(phases).count == 23)

        let recorder = Recorder()
        let empty = recorder.snapshot()
        try checkShape(empty)
        try check(empty.entries.isEmpty)
        let unknownFacts = Recorder.DOMFacts()
        let emptyBytes = try encoded(empty)
        for sequence in [Int.min, -1, 0, 2, 64, 65, Int.max] {
            try check(!recorder.record(sequence: sequence, phase: .coldReady, dom: unknownFacts))
            try check(recorder.snapshot() == empty)
            try check(try encoded(recorder.snapshot()) == emptyBytes)
        }
        try check(recorder.record(sequence: 1, phase: .threadOpen, dom: unknownFacts))
        let first = recorder.snapshot()
        try checkShape(first)
        try check(first.entries.count == 1)
        try check(first.entries[0].phase == .threadOpen)
        try check(first.entries[0].dom == unknownFacts)
        try check(empty.entries.isEmpty)
        let firstBytes = try encoded(first)
        // Duplicate, backward, gap and overflow refusal cannot replace a row.
        for sequence in [Int.min, -1, 0, 1, 3, 64, 65, Int.max] {
            try check(!recorder.record(sequence: sequence, phase: .sendAccepted,
                dom: Recorder.DOMFacts(sendPresent: true, sendEnabled: true)))
            try check(recorder.snapshot() == first)
            try check(try encoded(recorder.snapshot()) == firstBytes)
        }
        // A recurring current phase at the next sequence is a distinct snapshot.
        let observed = Recorder.DOMFacts(sendPresent: true, sendEnabled: false,
            composePresent: true, composeEmpty: true, composeDisabled: false, composeReadOnly: true)
        try check(recorder.record(sequence: 2, phase: .threadOpen, dom: observed))
        let second = recorder.snapshot()
        try checkShape(second)
        try check(second.entries[0] == first.entries[0])
        try check(second.entries[1].phase == .threadOpen)
        try check(second.entries[1].dom == observed)
        try check(first.entries.count == 1)
        var detached = second.entries
        detached.removeLast()
        try check(second.entries.count == 2)
        try check(recorder.snapshot() == second)

        // Every fixed name is admitted through only its bounded enum seam.
        for phase in Recorder.JavaScriptPhase.allCases {
            let known = Recorder()
            try check(known.record(sequence: 1, phaseName: phase.rawValue, dom: unknownFacts))
            let snapshot = known.snapshot()
            try check(snapshot.entries[0].phase == phase)
            try checkShape(snapshot)
        }
        let privateCanary = "scene-progress-private-canary"
        for name in [privateCanary, "", "none", "fixture-complete", "COLD-READY", "cold-ready\n",
                     String(repeating: "x", count: 49)] {
            let refused = Recorder()
            try check(!refused.record(sequence: 1, phaseName: name, dom: unknownFacts))
            try check(refused.snapshot() == empty)
            try check(!recorder.record(sequence: 3, phaseName: name, dom: unknownFacts))
            try check(recorder.snapshot() == second)
        }
        try check(!String(decoding: try encoded(recorder.snapshot()), as: UTF8.self).contains(privateCanary))

        let nullable: [Bool?] = [nil, false, true]
        // Present elements preserve all nullable child facts exactly.
        for sendEnabled in nullable {
            for composeEmpty in nullable {
                for composeDisabled in nullable {
                    for composeReadOnly in nullable {
                        let dom = Recorder.DOMFacts(sendPresent: true, sendEnabled: sendEnabled,
                            composePresent: true, composeEmpty: composeEmpty,
                            composeDisabled: composeDisabled, composeReadOnly: composeReadOnly)
                        let known = Recorder()
                        try check(known.record(sequence: 1, phase: .sendEnabled, dom: dom))
                        try check(known.snapshot().entries[0].dom == dom)
                        try checkShape(known.snapshot())
                    }
                }
            }
        }
        // Missing knowledge and observed absence both require nil child facts.
        for sendPresent in nullable {
            for composePresent in nullable {
                let dom = Recorder.DOMFacts(sendPresent: sendPresent, composePresent: composePresent)
                let known = Recorder()
                try check(known.record(sequence: 1, phase: .threadOpen, dom: dom))
                try check(known.snapshot().entries[0].dom == dom)
                try checkShape(known.snapshot())
            }
        }
        let absentPresences: [Bool?] = [nil, false]
        for presence in absentPresences {
            for value in [false, true] {
                let inconsistent = [Recorder.DOMFacts(sendPresent: presence, sendEnabled: value),
                    Recorder.DOMFacts(composePresent: presence, composeEmpty: value),
                    Recorder.DOMFacts(composePresent: presence, composeDisabled: value),
                    Recorder.DOMFacts(composePresent: presence, composeReadOnly: value)]
                for dom in inconsistent {
                    let refused = Recorder()
                    try check(!refused.record(sequence: 1, phase: .threadOpen, dom: dom))
                    try check(refused.snapshot() == empty)
                    try check(!recorder.record(sequence: 3, phase: .threadOpen, dom: dom))
                    try check(recorder.snapshot() == second)
                }
            }
        }

        let bounded = Recorder()
        for sequence in 1...64 {
            let before = bounded.snapshot()
            let dom = Recorder.DOMFacts(sendPresent: true, sendEnabled: sequence.isMultiple(of: 2),
                composePresent: true, composeEmpty: sequence.isMultiple(of: 3),
                composeDisabled: sequence.isMultiple(of: 4), composeReadOnly: sequence.isMultiple(of: 5))
            try check(bounded.record(sequence: sequence, phase: .sendEnabled, dom: dom))
            let after = bounded.snapshot()
            try check(after.entries.count == sequence)
            try check(Array(after.entries.dropLast()) == before.entries)
            try check(after.entries.last?.dom == dom)
            try check(before.entries.count == sequence - 1)
            try checkShape(after)
        }
        let full = bounded.snapshot()
        let fullBytes = try encoded(full)
        for sequence in [Int.min, 0, 1, 63, 64, 65, 66, Int.max] {
            try check(!bounded.record(sequence: sequence, phase: .proofCaptured, dom: observed))
            try check(bounded.snapshot() == full)
            try check(try encoded(bounded.snapshot()) == fullBytes)
        }
        try check(full.entries.allSatisfy { $0.phase == .sendEnabled })
        try check(full.entries.count == 64)

        // Longest admitted phase and longest consistent boolean spellings at
        // full capacity must fit the private diagnostic persistence byte bound.
        let largest = Recorder()
        let longestPhase = Recorder.JavaScriptPhase.allCases.max {
            $0.rawValue.utf8.count < $1.rawValue.utf8.count
        }!
        let longestFacts = Recorder.DOMFacts(sendPresent: true, sendEnabled: false,
            composePresent: true, composeEmpty: false, composeDisabled: false, composeReadOnly: false)
        for sequence in 1...64 {
            try check(largest.record(sequence: sequence, phase: longestPhase, dom: longestFacts))
        }
        let largestSnapshot = largest.snapshot()
        try checkShape(largestSnapshot)
        let largestBytes = try encoded(largestSnapshot)
        try check(largestBytes.count <= 16384)

        // One bounded row may be cross-checked by the JS parser. Only this test
        // harness prints it; the recorder owns no file, log or other I/O object.
        print(String(decoding: try encoded(second), as: UTF8.self))
        print("PASS synthetic direct scene-progress recorder harness: \(assertions) assertions; maximum JSON \(largestBytes.count) bytes; native/OS acceptance unproved")
    }
}
#endif
