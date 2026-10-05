// ISOLATED SIMULATOR PROCESS-CRASH PROOF. Compile only in a fresh disposable
// research app with THALASSA_SEALED_CRASH_PROBE. Direct coordinator fixtures are
// not Auth/facade, remote receipt, physical-device or power-loss evidence.
#if THALASSA_SEALED_CRASH_PROBE
import Foundation
import UIKit
import Darwin
import CryptoKit

private enum SealedCrashFailure: Error { case arguments, namespace, assertion, unexpectedReturn }
private enum SealedCrashPhase: String { case seed, fault, verify, cleanup }
private enum SealedCrashOperation: String {
    case prepare, receiveOpening, receiveSession, accepted, rejected, logout
    var targetsBob: Bool { self == .receiveOpening || self == .receiveSession }
}

private struct SealedCrashArguments {
    let run: UUID
    let phase: SealedCrashPhase
    let operation: SealedCrashOperation
    let boundary: VodozemacSealedStore.ResearchCommitBoundary
    let caseID: UUID
    let nonce: UUID
    let simulator: UUID
    let bundle: String

    static func parse() throws -> Self {
        let values = Array(CommandLine.arguments.dropFirst())
        let keys: Set<String> = ["--run", "--phase", "--operation", "--boundary", "--case", "--nonce", "--simulator", "--bundle"]
        guard values.count == keys.count * 2 else { throw SealedCrashFailure.arguments }
        var arguments: [String: String] = [:]
        for index in stride(from: 0, to: values.count, by: 2) {
            guard keys.contains(values[index]), arguments[values[index]] == nil else { throw SealedCrashFailure.arguments }
            arguments[values[index]] = values[index + 1]
        }
        guard let run = UUID(uuidString: arguments["--run"] ?? ""),
              let phase = SealedCrashPhase(rawValue: arguments["--phase"] ?? ""),
              let operation = SealedCrashOperation(rawValue: arguments["--operation"] ?? ""),
              let boundary = VodozemacSealedStore.ResearchCommitBoundary(rawValue: arguments["--boundary"] ?? ""),
              let caseID = UUID(uuidString: arguments["--case"] ?? ""),
              let nonce = UUID(uuidString: arguments["--nonce"] ?? ""),
              let simulator = UUID(uuidString: arguments["--simulator"] ?? ""),
              let bundle = arguments["--bundle"], Bundle.main.bundleIdentifier == bundle,
              bundle == "app.thalassa.research.sealed-crash." + run.uuidString.lowercased() else {
            throw SealedCrashFailure.arguments
        }
        #if targetEnvironment(simulator)
        guard UUID(uuidString: ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "") == simulator else {
            throw SealedCrashFailure.arguments
        }
        #else
        throw SealedCrashFailure.arguments
        #endif
        return Self(run: run, phase: phase, operation: operation, boundary: boundary,
                    caseID: caseID, nonce: nonce, simulator: simulator, bundle: bundle)
    }

    var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    var casesRoot: URL { documents.appendingPathComponent("SealedCrashCases", isDirectory: true) }
    var runRoot: URL { casesRoot.appendingPathComponent(run.uuidString.lowercased(), isDirectory: true) }
    var caseRoot: URL { runRoot.appendingPathComponent(caseID.uuidString.lowercased(), isDirectory: true) }
    var manifestURL: URL { caseRoot.appendingPathComponent("manifest.json") }
    var statusURL: URL {
        documents.appendingPathComponent("sealed-crash-status-\(run.uuidString.lowercased())-\(caseID.uuidString.lowercased())-\(nonce.uuidString.lowercased()).json")
    }

    func writeStatus(_ status: String, stage: String, assertions: Int) throws {
        try sealedCrashRequireDirectory(documents)
        if FileManager.default.fileExists(atPath: statusURL.path) { try sealedCrashRequireFile(statusURL) }
        let receipt: [String: Any] = [
            "runID": run.uuidString.lowercased(), "caseID": caseID.uuidString.lowercased(),
            "phase": phase.rawValue, "operation": operation.rawValue, "boundary": boundary.rawValue,
            "nonce": nonce.uuidString.lowercased(), "simulator": simulator.uuidString.lowercased(),
            "bundle": bundle, "pid": ProcessInfo.processInfo.processIdentifier,
            "status": status, "stage": stage, "assertions": assertions,
        ]
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: statusURL, options: [.atomic])
        try sealedCrashProtect(statusURL, directory: false)
    }
}

// Only public ownership/store identifiers go in the setup manifest. Baselines,
// epochs, pickles, original envelopes and history remain in the sealed ledger.
private struct SealedCrashManifest: Codable {
    let version: Int
    let run: UUID
    let caseID: UUID
    let operation: String
    let boundary: String
    let simulator: UUID
    let bundle: String
    let aliceID: UUID
    let bobID: UUID
    let evidenceID: UUID

    func directory(_ id: UUID, arguments: SealedCrashArguments) -> URL {
        arguments.caseRoot.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
    }

    func validate(_ arguments: SealedCrashArguments) throws {
        guard version == 1, run == arguments.run, caseID == arguments.caseID,
              operation == arguments.operation.rawValue, boundary == arguments.boundary.rawValue,
              simulator == arguments.simulator, bundle == arguments.bundle,
              Set([aliceID, bobID, evidenceID]).count == 3 else { throw SealedCrashFailure.namespace }
        try sealedCrashRequireDirectory(arguments.casesRoot)
        try sealedCrashRequireDirectory(arguments.runRoot)
        try sealedCrashRequireDirectory(arguments.caseRoot)
        let permitted = Set(["manifest.json", aliceID.uuidString.lowercased(), bobID.uuidString.lowercased(), evidenceID.uuidString.lowercased()])
        guard Set(try FileManager.default.contentsOfDirectory(atPath: arguments.caseRoot.path)).isSubset(of: permitted) else {
            throw SealedCrashFailure.namespace
        }
    }

    static func read(_ arguments: SealedCrashArguments) throws -> Self {
        try sealedCrashRequireDirectory(arguments.casesRoot)
        try sealedCrashRequireDirectory(arguments.runRoot)
        try sealedCrashRequireDirectory(arguments.caseRoot)
        try sealedCrashRequireFile(arguments.manifestURL)
        let data = try Data(contentsOf: arguments.manifestURL)
        guard data.count <= 4096,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "run", "caseID", "operation", "boundary", "simulator", "bundle", "aliceID", "bobID", "evidenceID"] else {
            throw SealedCrashFailure.namespace
        }
        let manifest = try JSONDecoder().decode(Self.self, from: data)
        try manifest.validate(arguments)
        return manifest
    }
}

private struct SealedCrashBaseline: Codable {
    let revision: Int64
    let payload: Data
    init(_ snapshot: VodozemacSealedStore.Snapshot) { revision = snapshot.revision; payload = snapshot.payload }
    var snapshot: VodozemacSealedStore.Snapshot { .init(revision: revision, payload: payload) }
}

private struct SealedCrashEvidence: Codable {
    let version: Int
    let run: UUID
    let caseID: UUID
    let operation: String
    let boundary: String
    let alice: SealedCrashBaseline
    let bob: SealedCrashBaseline
    let aliceIdentity: DmPublicIdentity
    let bobIdentity: DmPublicIdentity
    let owner: DmOwnerContext
    let credentialEpoch: UUID
    let originalRecord: DmOutboxRecord?
}

private final class SealedCrashChecks {
    private(set) var count = 0
    func require(_ condition: @autoclosure () throws -> Bool) throws {
        guard try condition() else { throw SealedCrashFailure.assertion }
        count += 1
    }
    func unavailable(_ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.unavailable { count += 1; return }
        throw SealedCrashFailure.assertion
    }
    func conflict(_ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.conflict { count += 1; return }
        throw SealedCrashFailure.assertion
    }
    func messageNotOpened(_ operation: () throws -> Void) throws {
        do { try operation() }
        catch NativeCryptoError.MessageNotOpened { count += 1; return }
        throw SealedCrashFailure.assertion
    }
}

private enum SealedCrashFixture {
    static let alice = DmOwnerContext(userId: "crash-alice", deviceId: "alice-device", generation: 11)
    static let bob = DmOwnerContext(userId: "crash-bob", deviceId: "bob-device", generation: 21)
    static let generation: Int64 = 7
    static let openingText = "sealed crash synthetic opening"
    static let replyText = "sealed crash synthetic baseline reply"
    static let operationText = "sealed crash synthetic operation"
    static let operationID = "crash-operation"
}

private func sealedCrashRequireDirectory(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else { throw SealedCrashFailure.namespace }
}

private func sealedCrashRequireFile(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else { throw SealedCrashFailure.namespace }
}

private func sealedCrashProtect(_ url: URL, directory: Bool) throws {
    try FileManager.default.setAttributes([.posixPermissions: directory ? 0o700 : 0o600,
                                           .protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var mutable = url
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
}

private func sealedCrashEnsureParent(_ url: URL) throws {
    if FileManager.default.fileExists(atPath: url.path) { try sealedCrashRequireDirectory(url) }
    else { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
    try sealedCrashProtect(url, directory: true)
}

private func sealedCrashReopen(_ id: UUID, manifest: SealedCrashManifest,
                               arguments: SealedCrashArguments) throws -> VodozemacSealedStore {
    let directory = manifest.directory(id, arguments: arguments)
    try sealedCrashRequireDirectory(directory)
    return try VodozemacSealedStore.reopen(directory: directory, storeID: id)
}

private func sealedCrashExactRecord(_ first: DmOutboxRecord, _ second: DmOutboxRecord) -> Bool {
    first == second && first.serializedEnvelope.utf8.elementsEqual(second.serializedEnvelope.utf8)
}

private func sealedCrashStored(_ result: DmReceiveResult, record: DmOutboxRecord,
                               text: String, owner: DmOwnerContext, checks: SealedCrashChecks) throws {
    guard case .stored(let message) = result else { throw SealedCrashFailure.assertion }
    let envelope = try DmEnvelope.decode(record.serializedEnvelope)
    try checks.require(message.text == text && message.ownerGeneration == owner.generation
        && message.peerGeneration == SealedCrashFixture.generation
        && message.clientMessageId == envelope.clientMessageId
        && message.serializedEnvelope.utf8.elementsEqual(record.serializedEnvelope.utf8))
}

private func sealedCrashState(_ payload: Data) throws -> [String: Any] {
    guard let state = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
        throw SealedCrashFailure.assertion
    }
    return state
}

private func sealedCrashSameStateExcept(_ baseline: Data, _ current: Data,
                                       keys: Set<String>, checks: SealedCrashChecks) throws {
    var before = try sealedCrashState(baseline), after = try sealedCrashState(current)
    for key in keys { before.removeValue(forKey: key); after.removeValue(forKey: key) }
    try checks.require(NSDictionary(dictionary: before).isEqual(to: after))
}

private func sealedCrashOutboxItem(_ payload: Data, record: DmOutboxRecord) throws -> [String: Any] {
    let state = try sealedCrashState(payload)
    guard let rows = state["outbox"] as? [[String: Any]] else { throw SealedCrashFailure.assertion }
    for row in rows {
        guard let saved = row["record"] else { throw SealedCrashFailure.assertion }
        let decoded = try JSONDecoder().decode(DmOutboxRecord.self, from: JSONSerialization.data(withJSONObject: saved))
        if sealedCrashExactRecord(decoded, record) { return row }
    }
    throw SealedCrashFailure.assertion
}

// Stored identity metadata and an established session cannot authenticate a
// restored account pickle. Sign/verify with the actual provider account, wholly
// in native memory, without publishing a signature or changing durable state.
private func sealedCrashUsableAccount(_ store: VodozemacSealedStore, identity: DmPublicIdentity,
                                     checks: SealedCrashChecks) throws {
    let before = try store.read()
    let state = try sealedCrashState(before.payload)
    guard let account = state["account"] as? String else { throw SealedCrashFailure.assertion }
    let message = Data("sealed-crash-native-account-control".utf8)
    let signed = try signPublicRequest(accountPickle: account, pickleKey: store.providerPickleKey(), message: message)
    try checks.require(signed.signingKey == identity.signingKey)
    let verifier = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(identity.signingKey))
    try checks.require(try verifier.isValidSignature(DmRelayCodec.keyBytes(signed.signature, count: 64), for: message))
    try checks.require(try store.read() == before)
}

private func sealedCrashSeed(_ arguments: SealedCrashArguments, checks: SealedCrashChecks) throws {
    try sealedCrashRequireDirectory(arguments.documents)
    try sealedCrashEnsureParent(arguments.casesRoot)
    try sealedCrashEnsureParent(arguments.runRoot)
    guard !FileManager.default.fileExists(atPath: arguments.caseRoot.path) else { throw SealedCrashFailure.namespace }
    try FileManager.default.createDirectory(at: arguments.caseRoot, withIntermediateDirectories: false)
    try sealedCrashProtect(arguments.caseRoot, directory: true)
    let manifest = SealedCrashManifest(version: 1, run: arguments.run, caseID: arguments.caseID,
        operation: arguments.operation.rawValue, boundary: arguments.boundary.rawValue,
        simulator: arguments.simulator, bundle: arguments.bundle, aliceID: UUID(), bobID: UUID(), evidenceID: UUID())
    try JSONEncoder().encode(manifest).write(to: arguments.manifestURL, options: [.atomic])
    try sealedCrashProtect(arguments.manifestURL, directory: false)
    try manifest.validate(arguments)
    let aStore = try VodozemacSealedStore.create(directory: manifest.directory(manifest.aliceID, arguments: arguments),
        storeID: manifest.aliceID, initialPayload: Data("{}".utf8))
    defer { aStore.close() }
    let bStore = try VodozemacSealedStore.create(directory: manifest.directory(manifest.bobID, arguments: arguments),
        storeID: manifest.bobID, initialPayload: Data("{}".utf8))
    defer { bStore.close() }
    let a = try VodozemacDmCoordinator.bootstrapForResearch(store: aStore, owner: SealedCrashFixture.alice,
        identityKeyId: "crash-alice-identity", conversationId: "crash-conversation")
    let b = try VodozemacDmCoordinator.bootstrapForResearch(store: bStore, owner: SealedCrashFixture.bob,
        identityKeyId: "crash-bob-identity", conversationId: "crash-conversation")
    let ap = try a.publicIdentity(owner: SealedCrashFixture.alice), bp = try b.publicIdentity(owner: SealedCrashFixture.bob)
    try a.installPeerForResearch(DmPeerContext(userId: bp.userId, deviceId: bp.deviceId, identityKeyId: bp.identityKeyId,
        curve: bp.curve, prekey: bp.prekey, generation: SealedCrashFixture.generation, status: .accepted), owner: SealedCrashFixture.alice)
    try b.installPeerForResearch(DmPeerContext(userId: ap.userId, deviceId: ap.deviceId, identityKeyId: ap.identityKeyId,
        curve: ap.curve, prekey: ap.prekey, generation: SealedCrashFixture.generation, status: .accepted), owner: SealedCrashFixture.bob)
    try checks.require(SealedCrashFixture.alice.deviceId.utf8.lexicographicallyPrecedes(SealedCrashFixture.bob.deviceId.utf8))
    if arguments.operation == .receiveSession || arguments.operation == .logout {
        let opening = try a.prepare(clientMessageId: "baseline-opening", text: SealedCrashFixture.openingText,
            owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
        try sealedCrashStored(b.receive(opening.serializedEnvelope, owner: SealedCrashFixture.bob,
            peerGeneration: SealedCrashFixture.generation), record: opening, text: SealedCrashFixture.openingText,
            owner: SealedCrashFixture.bob, checks: checks)
        let reply = try b.prepare(clientMessageId: "baseline-reply", text: SealedCrashFixture.replyText,
            owner: SealedCrashFixture.bob, peerGeneration: SealedCrashFixture.generation)
        try sealedCrashStored(a.receive(reply.serializedEnvelope, owner: SealedCrashFixture.alice,
            peerGeneration: SealedCrashFixture.generation), record: reply, text: SealedCrashFixture.replyText,
            owner: SealedCrashFixture.alice, checks: checks)
    }
    let original: DmOutboxRecord?
    if arguments.operation == .prepare { original = nil }
    else {
        original = try a.prepare(clientMessageId: SealedCrashFixture.operationID, text: SealedCrashFixture.operationText,
            owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
        let type = try DmEnvelope.decode(original!.serializedEnvelope).messageType
        try checks.require(type == ((arguments.operation == .receiveSession || arguments.operation == .logout) ? "session" : "prekey"))
    }
    let target = arguments.operation.targetsBob ? b : a
    let lifecycle = try target.lifecycleForResearch()
    try checks.require(lifecycle.active)
    let evidence = SealedCrashEvidence(version: 1, run: arguments.run, caseID: arguments.caseID,
        operation: arguments.operation.rawValue, boundary: arguments.boundary.rawValue,
        alice: SealedCrashBaseline(try aStore.read()), bob: SealedCrashBaseline(try bStore.read()),
        aliceIdentity: ap, bobIdentity: bp, owner: lifecycle.owner, credentialEpoch: lifecycle.credentialEpoch,
        originalRecord: original)
    let ledger = try VodozemacSealedStore.create(directory: manifest.directory(manifest.evidenceID, arguments: arguments),
        storeID: manifest.evidenceID, initialPayload: JSONEncoder().encode(evidence))
    defer { ledger.close() }
    try checks.require(try ledger.read().revision == 0)
}

private func sealedCrashReadEvidence(_ ledger: VodozemacSealedStore, arguments: SealedCrashArguments,
                                     checks: SealedCrashChecks) throws -> SealedCrashEvidence {
    let saved = try ledger.read()
    let evidence = try JSONDecoder().decode(SealedCrashEvidence.self, from: saved.payload)
    try checks.require(saved.revision == 0 && evidence.version == 1 && evidence.run == arguments.run
        && evidence.caseID == arguments.caseID && evidence.operation == arguments.operation.rawValue
        && evidence.boundary == arguments.boundary.rawValue)
    try checks.require(evidence.owner == (arguments.operation.targetsBob ? SealedCrashFixture.bob : SealedCrashFixture.alice))
    try checks.require((evidence.originalRecord == nil) == (arguments.operation == .prepare))
    return evidence
}

private func sealedCrashFault(_ arguments: SealedCrashArguments, checks: SealedCrashChecks) throws {
    let manifest = try SealedCrashManifest.read(arguments)
    let ledger = try sealedCrashReopen(manifest.evidenceID, manifest: manifest, arguments: arguments)
    defer { ledger.close() }
    let evidence = try sealedCrashReadEvidence(ledger, arguments: arguments, checks: checks)
    let targetID = arguments.operation.targetsBob ? manifest.bobID : manifest.aliceID
    let target = try VodozemacSealedStore.reopenForCrashResearch(
        directory: manifest.directory(targetID, arguments: arguments), storeID: targetID,
        boundary: arguments.boundary, callback: {
            do { try arguments.writeStatus("parked", stage: "fault-parked", assertions: checks.count) }
            catch { print("FAIL sealed crash boundary receipt"); fflush(stdout); exit(1) }
            while true { Darwin.pause() }
        })
    defer { target.close() }
    let coordinator = try VodozemacDmCoordinator(store: target)
    let baseline = arguments.operation.targetsBob ? evidence.bob : evidence.alice
    try checks.require(try target.read() == baseline.snapshot)
    switch arguments.operation {
    case .prepare:
        _ = try coordinator.prepare(clientMessageId: SealedCrashFixture.operationID, text: SealedCrashFixture.operationText,
            owner: evidence.owner, peerGeneration: SealedCrashFixture.generation)
    case .receiveOpening, .receiveSession:
        guard let record = evidence.originalRecord else { throw SealedCrashFailure.assertion }
        _ = try coordinator.receive(record.serializedEnvelope, owner: evidence.owner, peerGeneration: SealedCrashFixture.generation)
    case .accepted:
        guard let record = evidence.originalRecord else { throw SealedCrashFailure.assertion }
        try coordinator.confirmAcceptance(record, owner: evidence.owner, peerGeneration: SealedCrashFixture.generation)
    case .rejected:
        guard let record = evidence.originalRecord else { throw SealedCrashFailure.assertion }
        try coordinator.confirmRejection(record, reason: .blocked, owner: evidence.owner)
    case .logout: _ = try coordinator.signOutForResearch(owner: evidence.owner)
    }
    throw SealedCrashFailure.unexpectedReturn
}

private func sealedCrashVerify(_ arguments: SealedCrashArguments, checks: SealedCrashChecks) throws {
    let manifest = try SealedCrashManifest.read(arguments)
    let ledger = try sealedCrashReopen(manifest.evidenceID, manifest: manifest, arguments: arguments)
    defer { ledger.close() }
    let ledgerBefore = try ledger.read()
    let evidence = try sealedCrashReadEvidence(ledger, arguments: arguments, checks: checks)
    let aStore = try sealedCrashReopen(manifest.aliceID, manifest: manifest, arguments: arguments)
    defer { aStore.close() }
    let bStore = try sealedCrashReopen(manifest.bobID, manifest: manifest, arguments: arguments)
    defer { bStore.close() }
    let a = try VodozemacDmCoordinator(store: aStore), b = try VodozemacDmCoordinator(store: bStore)
    let targetStore = arguments.operation.targetsBob ? bStore : aStore
    let target = arguments.operation.targetsBob ? b : a
    let baseline = arguments.operation.targetsBob ? evidence.bob : evidence.alice
    let otherStore = arguments.operation.targetsBob ? aStore : bStore
    let otherBaseline = arguments.operation.targetsBob ? evidence.alice : evidence.bob
    let recovered = try targetStore.read()
    let committed = arguments.boundary == .afterCommit
    try checks.require(try otherStore.read() == otherBaseline.snapshot)
    if committed { try checks.require(recovered.revision == baseline.revision + 1) }
    else { try checks.require(recovered == baseline.snapshot) }
    try sealedCrashUsableAccount(aStore, identity: evidence.aliceIdentity, checks: checks)
    try sealedCrashUsableAccount(bStore, identity: evidence.bobIdentity, checks: checks)
    if arguments.operation != .logout || !committed {
        let lifecycle = try target.lifecycleForResearch()
        try checks.require(lifecycle.active && lifecycle.owner == evidence.owner && lifecycle.credentialEpoch == evidence.credentialEpoch)
        try checks.require(try a.publicIdentity(owner: SealedCrashFixture.alice) == evidence.aliceIdentity)
        try checks.require(try b.publicIdentity(owner: SealedCrashFixture.bob) == evidence.bobIdentity)
    }

    var record = evidence.originalRecord
    switch arguments.operation {
    case .prepare:
        if committed {
            let rows = try a.pending(owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
            try checks.require(rows.count == 1)
            record = rows[0]
            try checks.require(try DmEnvelope.decode(rows[0].serializedEnvelope).clientMessageId == SealedCrashFixture.operationID)
        } else {
            try checks.require(try a.pending(owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation).isEmpty)
            record = try a.prepare(clientMessageId: SealedCrashFixture.operationID, text: SealedCrashFixture.operationText,
                owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
            try checks.require(try aStore.read().revision == baseline.revision + 1)
        }
        guard let saved = record else { throw SealedCrashFailure.assertion }
        let beforeRetry = try aStore.read()
        let retry = try a.prepare(clientMessageId: SealedCrashFixture.operationID, text: SealedCrashFixture.operationText,
            owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
        try checks.require(sealedCrashExactRecord(saved, retry))
        try checks.require(try aStore.read() == beforeRetry)
        try sealedCrashSameStateExcept(baseline.payload, beforeRetry.payload, keys: ["session", "outbox"], checks: checks)
    case .receiveOpening, .receiveSession:
        guard let saved = record else { throw SealedCrashFailure.assertion }
        let oldState = try sealedCrashState(baseline.payload)
        guard let oldInbox = oldState["inbox"] as? [Any] else { throw SealedCrashFailure.assertion }
        if !committed {
            try checks.require(try b.history(owner: SealedCrashFixture.bob, peerGeneration: SealedCrashFixture.generation).count == oldInbox.count)
            try sealedCrashStored(b.receive(saved.serializedEnvelope, owner: SealedCrashFixture.bob,
                peerGeneration: SealedCrashFixture.generation), record: saved, text: SealedCrashFixture.operationText,
                owner: SealedCrashFixture.bob, checks: checks)
            try checks.require(try bStore.read().revision == baseline.revision + 1)
        }
        let history = try b.history(owner: SealedCrashFixture.bob, peerGeneration: SealedCrashFixture.generation)
        try checks.require(history.count == oldInbox.count + 1)
        guard let message = history.last else { throw SealedCrashFailure.assertion }
        try checks.require(message.clientMessageId == SealedCrashFixture.operationID && message.text == SealedCrashFixture.operationText
            && message.serializedEnvelope.utf8.elementsEqual(saved.serializedEnvelope.utf8)
            && message.ownerGeneration == SealedCrashFixture.bob.generation && message.peerGeneration == SealedCrashFixture.generation)
        let beforeDuplicate = try bStore.read()
        let receivedState = try sealedCrashState(beforeDuplicate.payload)
        try checks.require(receivedState["session"] is [String: Any])
        if arguments.operation == .receiveOpening {
            try checks.require(oldState["session"] == nil)
            try checks.require((oldState["account"] as? String) != (receivedState["account"] as? String))
            try sealedCrashUsableAccount(bStore, identity: evidence.bobIdentity, checks: checks)
            guard let account = receivedState["account"] as? String else { throw SealedCrashFailure.assertion }
            let originalEnvelope = try DmEnvelope.decode(saved.serializedEnvelope)
            try checks.messageNotOpened {
                _ = try openSession(accountPickle: account, pickleKey: bStore.providerPickleKey(),
                    pinnedSenderCurve: evidence.aliceIdentity.curve, wire: originalEnvelope.wire)
            }
            try checks.require(try bStore.read() == beforeDuplicate)
        } else {
            guard let oldSession = oldState["session"] as? [String: Any],
                  let receivedSession = receivedState["session"] as? [String: Any] else { throw SealedCrashFailure.assertion }
            try checks.require(oldSession["id"] as? String == receivedSession["id"] as? String)
            try checks.require((oldSession["pickle"] as? String) != (receivedSession["pickle"] as? String))
        }
        try checks.require(try b.receive(saved.serializedEnvelope, owner: SealedCrashFixture.bob,
            peerGeneration: SealedCrashFixture.generation) == .duplicate)
        try checks.require(try bStore.read() == beforeDuplicate)
        let changed: Set<String> = arguments.operation == .receiveOpening ? ["account", "session", "inbox"] : ["session", "inbox"]
        try sealedCrashSameStateExcept(baseline.payload, beforeDuplicate.payload, keys: changed, checks: checks)
    case .accepted, .rejected:
        guard let saved = record else { throw SealedCrashFailure.assertion }
        if !committed {
            try checks.require(try a.pending(owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation).contains {
                sealedCrashExactRecord($0, saved)
            })
            if arguments.operation == .accepted {
                try a.confirmAcceptance(saved, owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
            } else { try a.confirmRejection(saved, reason: .blocked, owner: SealedCrashFixture.alice) }
            try checks.require(try aStore.read().revision == baseline.revision + 1)
        }
        let terminal = try aStore.read()
        let row = try sealedCrashOutboxItem(terminal.payload, record: saved)
        try checks.require(row["status"] as? String == (arguments.operation == .accepted ? "accepted" : "rejected"))
        try checks.require((row["reason"] as? String) == (arguments.operation == .accepted ? nil : "blocked"))
        try checks.require(try a.pending(owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation).isEmpty)
        if arguments.operation == .accepted {
            try a.confirmAcceptance(saved, owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
            try checks.conflict { try a.confirmRejection(saved, reason: .blocked, owner: SealedCrashFixture.alice) }
        } else {
            try a.confirmRejection(saved, reason: .blocked, owner: SealedCrashFixture.alice)
            try checks.conflict { try a.confirmAcceptance(saved, owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation) }
        }
        try checks.require(try aStore.read() == terminal)
        try sealedCrashSameStateExcept(baseline.payload, terminal.payload, keys: ["outbox"], checks: checks)
        var oldItem = try sealedCrashOutboxItem(baseline.payload, record: saved), newItem = row
        oldItem.removeValue(forKey: "status"); oldItem.removeValue(forKey: "reason")
        newItem.removeValue(forKey: "status"); newItem.removeValue(forKey: "reason")
        try checks.require(NSDictionary(dictionary: oldItem).isEqual(to: newItem))
    case .logout:
        guard let saved = record else { throw SealedCrashFailure.assertion }
        if !committed { _ = try a.signOutForResearch(owner: SealedCrashFixture.alice) }
        let signedOut = try a.lifecycleForResearch(), retained = try aStore.read()
        try checks.require(retained.revision == baseline.revision + 1 && !signedOut.active
            && signedOut.owner.userId == evidence.owner.userId && signedOut.owner.deviceId == evidence.owner.deviceId
            && signedOut.owner.generation == evidence.owner.generation + 1 && signedOut.credentialEpoch != evidence.credentialEpoch)
        try sealedCrashSameStateExcept(baseline.payload, retained.payload, keys: ["owner", "ownerActive", "credentialEpoch"], checks: checks)
        _ = try sealedCrashOutboxItem(retained.payload, record: saved)
        try checks.unavailable { _ = try a.prepare(clientMessageId: "denied-after-logout", text: SealedCrashFixture.operationText,
            owner: evidence.owner, peerGeneration: SealedCrashFixture.generation) }
        try checks.unavailable { _ = try a.pending(owner: evidence.owner, peerGeneration: SealedCrashFixture.generation) }
        try checks.unavailable { _ = try a.history(owner: evidence.owner, peerGeneration: SealedCrashFixture.generation) }
        try checks.unavailable { try a.confirmAcceptance(saved, owner: evidence.owner, peerGeneration: SealedCrashFixture.generation) }
        try checks.unavailable { try a.validateRelayContextForResearch(owner: evidence.owner,
            credentialEpoch: evidence.credentialEpoch, peerGeneration: SealedCrashFixture.generation) }
        try checks.require(try aStore.read() == retained)
    }

    if arguments.operation != .logout {
        guard let saved = record else { throw SealedCrashFailure.assertion }
        if !arguments.operation.targetsBob {
            try sealedCrashStored(b.receive(saved.serializedEnvelope, owner: SealedCrashFixture.bob,
                peerGeneration: SealedCrashFixture.generation), record: saved, text: SealedCrashFixture.operationText,
                owner: SealedCrashFixture.bob, checks: checks)
        }
        let reply = try b.prepare(clientMessageId: "verify-bob-reply", text: "synthetic positive reply after crash",
            owner: SealedCrashFixture.bob, peerGeneration: SealedCrashFixture.generation)
        try sealedCrashStored(a.receive(reply.serializedEnvelope, owner: SealedCrashFixture.alice,
            peerGeneration: SealedCrashFixture.generation), record: reply, text: "synthetic positive reply after crash",
            owner: SealedCrashFixture.alice, checks: checks)
        let successor = try a.prepare(clientMessageId: "verify-alice-successor", text: "synthetic positive successor after crash",
            owner: SealedCrashFixture.alice, peerGeneration: SealedCrashFixture.generation)
        try sealedCrashStored(b.receive(successor.serializedEnvelope, owner: SealedCrashFixture.bob,
            peerGeneration: SealedCrashFixture.generation), record: successor, text: "synthetic positive successor after crash",
            owner: SealedCrashFixture.bob, checks: checks)
    }
    try checks.require(try ledger.read() == ledgerBefore)
}

private func sealedCrashCleanup(_ arguments: SealedCrashArguments, checks: SealedCrashChecks) throws {
    let manifest = try SealedCrashManifest.read(arguments)
    for id in [manifest.aliceID, manifest.bobID, manifest.evidenceID] {
        let directory = manifest.directory(id, arguments: arguments)
        if FileManager.default.fileExists(atPath: directory.path) {
            try sealedCrashRequireDirectory(directory)
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("snapshot.sqlite").path) {
                let store = try sealedCrashReopen(id, manifest: manifest, arguments: arguments)
                defer { store.close() }
                try store.destroyForTesting()
            } else {
                try checks.require(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
                try VodozemacSealedStore.deleteResearchKey(storeID: id)
                try FileManager.default.removeItem(at: directory)
            }
        } else { try VodozemacSealedStore.deleteResearchKey(storeID: id) }
        try checks.require(!FileManager.default.fileExists(atPath: directory.path))
    }
    try checks.require(try FileManager.default.contentsOfDirectory(atPath: arguments.caseRoot.path) == ["manifest.json"])
    try sealedCrashRequireFile(arguments.manifestURL)
    try FileManager.default.removeItem(at: arguments.manifestURL)
    try checks.require(try FileManager.default.contentsOfDirectory(atPath: arguments.caseRoot.path).isEmpty)
    try FileManager.default.removeItem(at: arguments.caseRoot)
    if try FileManager.default.contentsOfDirectory(atPath: arguments.runRoot.path).isEmpty {
        try FileManager.default.removeItem(at: arguments.runRoot)
    }
    if try FileManager.default.contentsOfDirectory(atPath: arguments.casesRoot.path).isEmpty {
        try FileManager.default.removeItem(at: arguments.casesRoot)
    }
    try checks.require(!FileManager.default.fileExists(atPath: arguments.caseRoot.path))
}

private func sealedCrashRun() {
    let arguments: SealedCrashArguments
    do { arguments = try SealedCrashArguments.parse() }
    catch { print("FAIL sealed crash arguments"); fflush(stdout); exit(1) }
    let checks = SealedCrashChecks()
    do {
        try arguments.writeStatus("running", stage: "phase-started", assertions: 0)
        switch arguments.phase {
        case .seed: try sealedCrashSeed(arguments, checks: checks)
        case .fault: try sealedCrashFault(arguments, checks: checks)
        case .verify: try sealedCrashVerify(arguments, checks: checks)
        case .cleanup: try sealedCrashCleanup(arguments, checks: checks)
        }
        try arguments.writeStatus("passed", stage: "phase-complete", assertions: checks.count)
        print("PASS sealed crash phase"); fflush(stdout); exit(0)
    } catch {
        do { try arguments.writeStatus("failed", stage: "probe-failed", assertions: checks.count) }
        catch { print("FAIL sealed crash failure receipt") }
        print("FAIL sealed crash phase"); fflush(stdout); exit(1)
    }
}

@main
private final class SealedCrashApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { true }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "SealedCrashResearch", sessionRole: session.role)
        configuration.delegateClass = SealedCrashScene.self
        return configuration
    }
}

@objc(ThalassaSealedCrashResearchScene)
private final class SealedCrashScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var started = false
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: scene)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        guard !started else { return }
        started = true
        // Keep UIKit responsive while the exact transaction callback parks.
        DispatchQueue.global(qos: .userInitiated).async { sealedCrashRun() }
    }
}
#endif
