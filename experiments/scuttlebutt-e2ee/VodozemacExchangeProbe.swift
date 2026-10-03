// ISOLATED SIMULATOR APP. Real native Olm + sealed Keychain stores + URLSession
// HTTPS to a loopback SQL research relay. Auth/public peer pins are fixtures.
// No live Supabase identity, app chat, phone install or security-audit claim.
import Foundation
import UIKit

private enum ExchangeFailure: Error { case assertion(String), configuration }
private enum ExchangeFixture {
    static let alice = DmOwnerContext(userId: "11111111-1111-4111-8111-111111111111", deviceId: "relay-alice-phone", generation: 11)
    static let bob = DmOwnerContext(userId: "22222222-2222-4222-8222-222222222222", deviceId: "relay-bob-phone", generation: 21)
    static let peerGeneration: Int64 = 7
    static let opening = "Native HTTPS research opening"
    static let reply = "Native HTTPS research reply"
    static let successor = "Native HTTPS research successor"
    static let recovery = "Native HTTPS research recovery"
}

private struct ExchangeArguments {
    let phase: String
    let run: UUID
    let alice: UUID
    let bob: UUID
    let origin: String
    static func read() throws -> ExchangeArguments {
        let args = CommandLine.arguments
        guard args.count == 7, args[1] == "--exchange",
              ["tls-refuse", "prepare", "opening", "retry", "reply", "successor", "verify", "recovery", "cleanup"].contains(args[2]),
              let run = UUID(uuidString: args[3]), let alice = UUID(uuidString: args[4]), let bob = UUID(uuidString: args[5]),
              alice != bob else { throw ExchangeFailure.configuration }
        return ExchangeArguments(phase: args[2], run: run, alice: alice, bob: bob, origin: args[6])
    }
    var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    var root: URL { documents.appendingPathComponent("native-exchange-" + run.uuidString.lowercased()) }
    func status(_ value: String, stage: String, authFixtureAssertions: Int = 0,
                accountDirectoryFixtureAssertions: Int = 0, enrollmentIntentFixtureAssertions: Int = 0,
                messageAuthorityFixtureAssertions: Int = 0, pairingHistoryFixtureAssertions: Int = 0,
                scopedRelayFixtureAssertions: Int = 0, scopedEnrollmentFixtureAssertions: Int = 0) throws {
        let json: [String: Any] = ["runID": run.uuidString.lowercased(), "phase": phase, "status": value,
            "stage": stage, "pid": ProcessInfo.processInfo.processIdentifier, "physicalDeviceProtectionVerified": false,
            "authFixtureAssertions": authFixtureAssertions,
            "accountDirectoryFixtureAssertions": accountDirectoryFixtureAssertions,
            "enrollmentIntentFixtureAssertions": enrollmentIntentFixtureAssertions,
            "messageAuthorityFixtureAssertions": messageAuthorityFixtureAssertions,
            "pairingHistoryFixtureAssertions": pairingHistoryFixtureAssertions,
            "scopedRelayFixtureAssertions": scopedRelayFixtureAssertions,
            "scopedEnrollmentFixtureAssertions": scopedEnrollmentFixtureAssertions]
        let path = documents.appendingPathComponent("exchange-status-" + run.uuidString.lowercased() + ".json")
        try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: path, options: [.atomic])
    }
}

private func exchangeRequire(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
    guard try condition() else { throw ExchangeFailure.assertion(label) }
}
private func stateBytes(_ store: VodozemacSealedStore) throws -> Data {
    try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: store.read().payload), options: [.sortedKeys])
}

private struct ExchangeParticipant {
    let coordinator: VodozemacDmCoordinator
    let credential: DmRelayNetworkCredential
    let client: VodozemacRelayClient
    let readContext: () throws -> DmRelayNetworkContext?
    init(coordinator: VodozemacDmCoordinator, owner: DmOwnerContext, origin: String,
         generation: Int64 = ExchangeFixture.peerGeneration) throws {
        self.coordinator = coordinator
        let lifecycle = try coordinator.lifecycleForResearch()
        try exchangeRequire(lifecycle.active && lifecycle.owner == owner, "active-durable-owner")
        let context = DmRelayNetworkContext(userId: owner.userId, deviceId: owner.deviceId, ownerGeneration: owner.generation,
                                          credentialEpoch: lifecycle.credentialEpoch, peerGeneration: generation)
        credential = try DmRelayNetworkCredential(context: context,
            bearer: owner.userId == ExchangeFixture.alice.userId ? "fixture-alice" : "fixture-bob")
        client = VodozemacRelayClient(coordinator: coordinator,
                                     transport: try VodozemacRelayTransport(serviceOrigin: origin))
        // Token/account attestation remain research fixtures, but lifecycle
        // generation, active flag and epoch are native-owned durable state.
        readContext = {
            let current = try coordinator.lifecycleForResearch()
            guard current.active, current.owner == owner else { return nil }
            _ = try coordinator.publicIdentity(owner: owner)
            _ = try coordinator.peerForResearch(owner: owner, generation: generation)
            return DmRelayNetworkContext(userId: owner.userId, deviceId: owner.deviceId, ownerGeneration: owner.generation,
                credentialEpoch: current.credentialEpoch, peerGeneration: generation)
        }
    }
    func send(_ record: DmOutboxRecord, nonce: String) async throws -> DmRelayReceipt {
        let now = Int64(Date().timeIntervalSince1970)
        return try await client.sendForResearch(record, requestId: nonce, expiresAt: now + 240, now: now,
                                               credential: credential, currentContext: readContext)
    }
    func sync(_ nonce: String) async throws -> DmRelayInboxReport {
        let now = Int64(Date().timeIntervalSince1970)
        return try await client.syncInboxForResearch(requestId: nonce, expiresAt: now + 240, now: now,
                                                    credential: credential, currentContext: readContext)
    }
}

private func runExchange(_ args: ExchangeArguments) async throws -> (Int, Int, Int, Int, Int, Int, Int) {
    var authFixtureAssertions = 0
    var accountDirectoryFixtureAssertions = 0
    var enrollmentIntentFixtureAssertions = 0
    var messageAuthorityFixtureAssertions = 0
    var pairingHistoryFixtureAssertions = 0
    var scopedRelayFixtureAssertions = 0
    var scopedEnrollmentFixtureAssertions = 0
    if args.phase == "tls-refuse" {
        // Valid transport input reaches TLS: host separately requires an actual
        // failed TLS handshake and zero HTTP/Auth/SQL calls before CA install.
        let own = ExchangeFixture.alice
        let context = DmRelayNetworkContext(userId: own.userId, deviceId: own.deviceId, ownerGeneration: own.generation,
                                          credentialEpoch: UUID(), peerGeneration: nil)
        let credential = try DmRelayNetworkCredential(context: context, bearer: "fixture-alice")
        let transport = try VodozemacRelayTransport(serviceOrigin: args.origin, deadlineSeconds: 5)
        let body = "{\"userId\":\"" + own.userId + "\",\"deviceId\":\"" + own.deviceId + "\"}"
        do {
            _ = try await transport.register(bundle: body, credential: credential, currentContext: { context })
            throw ExchangeFailure.assertion("untrusted-tls-accepted")
        } catch is DmRelayTransportError { /* Expected; no trust bypass. */ }
        return (0, 0, 0, 0, 0, 0, 0)
    }
    if args.phase == "prepare" {
        try exchangeRequire(!FileManager.default.fileExists(atPath: args.root.path), "fresh-store-namespace")
        try FileManager.default.createDirectory(at: args.root, withIntermediateDirectories: false)
    }
    let ap = args.root.appendingPathComponent(args.alice.uuidString), bp = args.root.appendingPathComponent(args.bob.uuidString)
    let aStore: VodozemacSealedStore, bStore: VodozemacSealedStore
    if args.phase == "prepare" {
        aStore = try .create(directory: ap, storeID: args.alice, initialPayload: Data("{}".utf8))
        bStore = try .create(directory: bp, storeID: args.bob, initialPayload: Data("{}".utf8))
    } else {
        aStore = try .reopen(directory: ap, storeID: args.alice)
        bStore = try .reopen(directory: bp, storeID: args.bob)
    }
    defer { aStore.close(); bStore.close() }
    if args.phase == "cleanup" {
        try aStore.destroyForTesting(); try bStore.destroyForTesting()
        try exchangeRequire(try FileManager.default.contentsOfDirectory(atPath: args.root.path).isEmpty, "exact-empty-cleanup")
        try FileManager.default.removeItem(at: args.root)
        return (0, 0, 0, 0, 0, 0, 0)
    }
    let ao = ExchangeFixture.alice, bo = ExchangeFixture.bob, generation = ExchangeFixture.peerGeneration
    let a: VodozemacDmCoordinator, b: VodozemacDmCoordinator
    if args.phase == "prepare" {
        a = try .bootstrapForResearch(store: aStore, owner: ao, identityKeyId: "exchange-alice-identity", conversationId: "exchange-conversation")
        b = try .bootstrapForResearch(store: bStore, owner: bo, identityKeyId: "exchange-bob-identity", conversationId: "exchange-conversation")
        let ai = try a.publicIdentity(owner: ao), bi = try b.publicIdentity(owner: bo)
        try a.installPeerForResearch(DmPeerContext(userId: bi.userId, deviceId: bi.deviceId, identityKeyId: bi.identityKeyId,
            curve: bi.curve, prekey: bi.prekey, generation: generation, status: .accepted), owner: ao)
        try b.installPeerForResearch(DmPeerContext(userId: ai.userId, deviceId: ai.deviceId, identityKeyId: ai.identityKeyId,
            curve: ai.curve, prekey: ai.prekey, generation: generation, status: .accepted), owner: bo)
    } else { a = try .init(store: aStore); b = try .init(store: bStore) }
    let alice = try ExchangeParticipant(coordinator: a, owner: ao, origin: args.origin)
    let bobOwner = args.phase == "recovery" ? try b.lifecycleForResearch().owner : bo
    let bobGeneration = args.phase == "recovery" ? generation + 2 : generation
    let bob = try ExchangeParticipant(coordinator: b, owner: bobOwner, origin: args.origin, generation: bobGeneration)
    switch args.phase {
    case "prepare":
        try args.status("running", stage: "prepare-relay-results")
        try runDmRelayResultProbe()
        try args.status("running", stage: "prepare-coordinator")
        _ = try runDmCoordinatorProbe(root: FileManager.default.temporaryDirectory)
        try args.status("running", stage: "prepare-enrollment-intent")
        enrollmentIntentFixtureAssertions = try runDmEnrollmentIntentProbe(root: FileManager.default.temporaryDirectory)
        print("PASS isolated native enrollment intent fixture assertions: \(enrollmentIntentFixtureAssertions)")
        try args.status("running", stage: "prepare-lifecycle")
        let lifecycleChecks = try runLifecycleProbeForResearch()
        print("PASS isolated native lifecycle assertions: \(lifecycleChecks)")
        try args.status("running", stage: "prepare-unresolved")
        let unresolvedChecks = try runUnresolvedProbeForResearch()
        print("PASS isolated native unresolved assertions: \(unresolvedChecks)")
        try args.status("running", stage: "prepare-auth-session")
        let authChecks = try await runAuthSessionProbeForResearch()
        authFixtureAssertions = authChecks
        print("PASS isolated native Auth fixture assertions: \(authChecks)")
        try args.status("running", stage: "prepare-account-directory")
        let directoryChecks = try await runAccountDirectoryProbeForResearch(progressForResearch: { label in
            // Fixed research labels only, no account IDs, key material or bearer values.
            try? args.status("running", stage: label)
        })
        accountDirectoryFixtureAssertions = directoryChecks
        print("PASS isolated native account directory fixture assertions: \(directoryChecks)")
        try args.status("running", stage: "prepare-message-authority")
        messageAuthorityFixtureAssertions = try await runDmMessageAuthorityProbe(progressForResearch: { label in
            try? args.status("running", stage: label)
        })
        print("PASS isolated native message authority fixture assertions: \(messageAuthorityFixtureAssertions)")
        try args.status("running", stage: "prepare-pairing-history")
        pairingHistoryFixtureAssertions = try runDmPairingHistoryProbe()
        print("PASS isolated native pairing/history fixture assertions: \(pairingHistoryFixtureAssertions)")
        try args.status("running", stage: "prepare-scoped-relay")
        scopedRelayFixtureAssertions = try await runDmScopedRelayProbe(progressForResearch: { label in
            try? args.status("running", stage: label)
        })
        print("PASS isolated native scoped relay fixture assertions: \(scopedRelayFixtureAssertions)")
        try args.status("running", stage: "prepare-scoped-enrollment")
        scopedEnrollmentFixtureAssertions = try await runDmScopedEnrollmentProbe(progressForResearch: { label in
            try? args.status("running", stage: label)
        })
        print("PASS isolated native scoped enrollment fixture assertions: \(scopedEnrollmentFixtureAssertions)")
        try args.status("running", stage: "prepare-https-register")
        let now = Int64(Date().timeIntervalSince1970)
        for (person, prekey) in [(alice, "alice-prekey"), (bob, "bob-prekey")] {
            try await person.client.registerForResearch(prekeyId: prekey, expiresAt: now + 3600, now: now,
                credential: person.credential, currentContext: person.readContext)
        }
        _ = try await alice.client.claimForResearch(pinned: b.publicIdentity(owner: bo), requestId: "alice-claim",
            expiresAt: now + 240, now: now, credential: alice.credential, currentContext: alice.readContext)
        _ = try await bob.client.claimForResearch(pinned: a.publicIdentity(owner: ao), requestId: "bob-claim",
            expiresAt: now + 240, now: now, credential: bob.credential, currentContext: bob.readContext)
        let staleClock = VodozemacRelayClient(coordinator: a, transport: try VodozemacRelayTransport(serviceOrigin: args.origin),
                                              nowSeconds: { now + 4000 })
        let beforeExpiredClaim = try stateBytes(aStore)
        do {
            _ = try await staleClock.claimForResearch(pinned: b.publicIdentity(owner: bo), requestId: "alice-claim",
                expiresAt: now + 240, now: now, credential: alice.credential, currentContext: alice.readContext)
            throw ExchangeFailure.assertion("expired-claim-returned")
        } catch is DmCoordinatorError { /* Post-await native clock refuses stale key. */ }
        try exchangeRequire(try stateBytes(aStore) == beforeExpiredClaim, "expired-claim-no-ratchet-mutation")
    case "opening":
        let record = try a.prepare(clientMessageId: "exchange-opening", text: ExchangeFixture.opening, owner: ao, peerGeneration: generation)
        do {
            _ = try await alice.send(record, nonce: "lost-send")
            throw ExchangeFailure.assertion("lost-send-resolved")
        } catch is DmRelayTransportError { /* Commit may already exist at relay. */ }
        try exchangeRequire(try a.pending(owner: ao, peerGeneration: generation) == [record], "uncertain-send-stays-pending")
        try exchangeRequire(try b.history(owner: bo, peerGeneration: generation).isEmpty, "no-premature-receive")
    case "retry":
        guard let record = try a.pending(owner: ao, peerGeneration: generation).first else { throw ExchangeFailure.configuration }
        let before = try stateBytes(aStore)
        do {
            _ = try await alice.send(record, nonce: "wrong-receipt-send")
            throw ExchangeFailure.assertion("wrong-receipt-accepted")
        } catch is DmCoordinatorError { /* Exact receipt mismatch is unresolved. */ }
        try exchangeRequire(try stateBytes(aStore) == before, "malformed-receipt-preserves-outbox-ratchet")
        try exchangeRequire(try a.prepare(clientMessageId: "exchange-opening", text: ExchangeFixture.opening,
            owner: ao, peerGeneration: generation) == record, "restart-reuses-ciphertext")
        let receipt = try await alice.send(record, nonce: "opening-reconciled")
        try exchangeRequire(receipt == .accepted(record), "exact-retry-acceptance")
        try exchangeRequire(try a.pending(owner: ao, peerGeneration: generation).isEmpty, "native-outbox-settled")
        let bobBefore = try stateBytes(bStore)
        do {
            _ = try await bob.sync("malformed-list")
            throw ExchangeFailure.assertion("malformed-batch-accepted")
        } catch is DmCoordinatorError { /* Whole batch validated before mutation. */ }
        try exchangeRequire(try stateBytes(bStore) == bobBefore, "bad-final-row-preserves-entire-inbox")
        // Structural validity doesn't prove ciphertext authenticity. Preserve
        // the exact poisoned row without plaintext or speculative ratchet state.
        for attempt in 0..<2 {
            // Each rescan is a fresh signed request with a fresh expiry. Reusing
            // one nonce would correctly refuse if the second crossed a second
            // boundary and no longer had byte-identical signed request bytes.
            let nonce = attempt == 0 ? "partial-poison-list" : "partial-poison-reread"
            let report = try await bob.sync(nonce)
            try exchangeRequire(report == DmRelayInboxReport(stored: attempt == 0 ? 1 : 0,
                duplicates: attempt == 0 ? 0 : 1, unresolved: 1), "typed-poison-retained-not-delivered")
            try exchangeRequire(try b.history(owner: bo, peerGeneration: generation).map(\.text) == [ExchangeFixture.opening],
                                "partial-receive-durable-poison-not-stored")
            try exchangeRequire(try b.unresolvedCountForResearch(owner: bo, peerGeneration: generation) == 1, "one-exact-unresolved-row")
        }
        let first = try await bob.sync("opening-read")
        try exchangeRequire(first == DmRelayInboxReport(stored: 0, duplicates: 1), "partial-receive-rescan-duplicate")
        let duplicated = try await bob.sync("opening-reread")
        try exchangeRequire(duplicated == DmRelayInboxReport(stored: 0, duplicates: 1), "durable-duplicate-no-plaintext")
        try exchangeRequire(try b.history(owner: bo, peerGeneration: generation).map(\.text) == [ExchangeFixture.opening], "native-opening-history")
    case "reply":
        try exchangeRequire(try b.unresolvedCountForResearch(owner: bo, peerGeneration: generation) == 1, "unresolved-survives-process-restart")
        let record = try b.prepare(clientMessageId: "exchange-reply", text: ExchangeFixture.reply, owner: bo, peerGeneration: generation)
        try exchangeRequire(try DmEnvelope.decode(record.serializedEnvelope).wire.messageType == 1, "real-olm-reply-session")
        let receipt = try await bob.send(record, nonce: "send-reply")
        try exchangeRequire(receipt == .accepted(record), "reply-committed")
        let result = try await alice.sync("read-reply")
        try exchangeRequire(result == DmRelayInboxReport(stored: 1, duplicates: 0), "reply-authenticated-receive")
    case "successor":
        let record = try a.prepare(clientMessageId: "exchange-successor", text: ExchangeFixture.successor, owner: ao, peerGeneration: generation)
        let receipt = try await alice.send(record, nonce: "send-successor")
        try exchangeRequire(receipt == .accepted(record), "successor-committed")
        let result = try await bob.sync("read-successor")
        try exchangeRequire(result == DmRelayInboxReport(stored: 1, duplicates: 1, unresolved: 1), "poison-before-successor-does-not-block-new")
    case "verify":
        let result = try await bob.sync("verify-restart")
        try exchangeRequire(result == DmRelayInboxReport(stored: 0, duplicates: 2, unresolved: 1), "process-restart-durable-inbox-and-unresolved")
        let beforePoisonRetry = try stateBytes(bStore)
        try exchangeRequire(try b.retryUnresolvedForResearch(serverId: 2, owner: bo, peerGeneration: generation,
            credentialEpoch: bob.credential.context.credentialEpoch) == .deferred, "explicit-poison-retry-retains-row")
        try exchangeRequire(try stateBytes(bStore) == beforePoisonRetry, "failed-retry-preserves-entire-payload")
        try exchangeRequire(try a.pending(owner: ao, peerGeneration: generation).isEmpty && b.pending(owner: bo, peerGeneration: generation).isEmpty,
                            "process-restart-durable-receipts")
        try exchangeRequire(try a.history(owner: ao, peerGeneration: generation).map(\.text) == [ExchangeFixture.reply], "native-reply-history")
        try exchangeRequire(try b.history(owner: bo, peerGeneration: generation).map(\.text) == [ExchangeFixture.opening, ExchangeFixture.successor], "native-complete-history")
        let blocked = try b.setPeerStatusForResearch(.blocked, owner: bo)
        let reaccepted = try b.setPeerStatusForResearch(.accepted, owner: bo)
        try exchangeRequire(blocked == generation + 1 && reaccepted == generation + 2, "peer-lifecycle-monotonic")
        let changedPeer = try ExchangeParticipant(coordinator: b, owner: bo, origin: args.origin, generation: reaccepted)
        let peerRescan = try await changedPeer.sync("old-peer-generation-rescan")
        try exchangeRequire(peerRescan == DmRelayInboxReport(stored: 0, duplicates: 0, historical: 2, historicalUnresolved: 1), "old-peer-known-reconciliation")
        do {
            _ = try b.retryUnresolvedForResearch(serverId: 2, owner: bo, peerGeneration: reaccepted,
                credentialEpoch: changedPeer.credential.context.credentialEpoch)
            throw ExchangeFailure.assertion("old-peer-unresolved-rebound")
        } catch DmCoordinatorError.unavailable { /* Old queue cannot be rebound. */ }
        try exchangeRequire(try b.history(owner: bo, peerGeneration: reaccepted).isEmpty, "old-peer-history-hidden")
        // Even a caller returning its captured context cannot defeat the sealed
        // credential epoch. Renewal must fence HTTP before a request is sent.
        let renewed = try b.rotateCredentialEpochForResearch(owner: bo)
        try exchangeRequire(renewed.owner == bo && renewed.credentialEpoch != changedPeer.credential.context.credentialEpoch,
                            "native-renewal-epoch")
        do {
            let now = Int64(Date().timeIntervalSince1970)
            _ = try await changedPeer.client.syncInboxForResearch(requestId: "stale-epoch-must-not-dispatch", expiresAt: now + 240, now: now,
                credential: changedPeer.credential, currentContext: { changedPeer.credential.context })
            throw ExchangeFailure.assertion("stale-native-epoch-dispatched")
        } catch DmCoordinatorError.unavailable { /* Native guard, not callback, refuses. */ }
        let callbackRace = try ExchangeParticipant(coordinator: b, owner: bo, origin: args.origin, generation: reaccepted)
        var rotatedInsideReader = false
        do {
            let now = Int64(Date().timeIntervalSince1970)
            _ = try await callbackRace.client.syncInboxForResearch(requestId: "callback-epoch-must-not-dispatch", expiresAt: now + 240, now: now,
                credential: callbackRace.credential, currentContext: {
                    if !rotatedInsideReader {
                        _ = try b.rotateCredentialEpochForResearch(owner: bo)
                        rotatedInsideReader = true
                    }
                    return callbackRace.credential.context
                })
            throw ExchangeFailure.assertion("reentrant-native-epoch-dispatched")
        } catch DmCoordinatorError.unavailable { /* Fresh authority read follows external callback. */ }
        try exchangeRequire(rotatedInsideReader, "native-epoch-race-fixture-ran")
        let signedOut = try b.signOutForResearch(owner: bo)
        try exchangeRequire(!signedOut.active && signedOut.owner.generation == bo.generation + 1, "durable-signed-out")
        do {
            _ = try b.publicIdentity(owner: signedOut.owner)
            throw ExchangeFailure.assertion("signed-out-state-accessible")
        } catch is DmCoordinatorError { /* No identity/signing/history while signed out. */ }
        let resumed = try b.resumeOwnerForResearch(signedOut: signedOut.owner, authenticatedUserId: bo.userId, authenticatedDeviceId: bo.deviceId)
        try exchangeRequire(resumed.active && resumed.owner.generation == bo.generation + 2, "native-resume-generation")
        let current = try ExchangeParticipant(coordinator: b, owner: resumed.owner, origin: args.origin, generation: reaccepted)
        let ownerRescan = try await current.sync("old-generation-rescan")
        try exchangeRequire(ownerRescan == DmRelayInboxReport(stored: 0, duplicates: 0, historical: 2, historicalUnresolved: 1), "old-owner-known-reconciliation")
        try exchangeRequire(try b.history(owner: resumed.owner, peerGeneration: reaccepted).isEmpty, "old-generation-history-hidden")
    case "recovery":
        try exchangeRequire(bobOwner.generation == bo.generation + 2, "resumed-owner-process-restart")
        let record = try a.prepare(clientMessageId: "exchange-recovery", text: ExchangeFixture.recovery, owner: ao, peerGeneration: generation)
        let receipt = try await alice.send(record, nonce: "send-recovery")
        try exchangeRequire(receipt == .accepted(record), "recovery-new-ciphertext-committed")
        let report = try await bob.sync("recovery-after-restart")
        try exchangeRequire(report == DmRelayInboxReport(stored: 1, duplicates: 0, historical: 2, historicalUnresolved: 1), "recovered-inbox-new-message")
        try exchangeRequire(try b.history(owner: bobOwner, peerGeneration: bobGeneration).map(\.text) == [ExchangeFixture.recovery],
                            "recovered-current-history-only")
        let duplicate = try await bob.sync("recovery-rescan")
        try exchangeRequire(duplicate == DmRelayInboxReport(stored: 0, duplicates: 1, historical: 2, historicalUnresolved: 1), "recovered-known-exact-rescan")
    default: throw ExchangeFailure.configuration
    }
    return (authFixtureAssertions, accountDirectoryFixtureAssertions, enrollmentIntentFixtureAssertions,
            messageAuthorityFixtureAssertions, pairingHistoryFixtureAssertions, scopedRelayFixtureAssertions,
            scopedEnrollmentFixtureAssertions)
}

@main
private final class ExchangeApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        do { try ExchangeArguments.read().status("running", stage: "didFinish") } catch { exit(1) }
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Research", sessionRole: session.role)
        configuration.delegateClass = ExchangeScene.self
        return configuration
    }
}

@objc(ThalassaNativeExchangeScene)
private final class ExchangeScene: UIResponder, UIWindowSceneDelegate {
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
        Task {
            do {
                let args = try ExchangeArguments.read()
                try args.status("running", stage: "native-https-exchange")
                let checks = try await runExchange(args)
                try args.status("passed", stage: "complete", authFixtureAssertions: checks.0,
                                accountDirectoryFixtureAssertions: checks.1, enrollmentIntentFixtureAssertions: checks.2,
                                messageAuthorityFixtureAssertions: checks.3, pairingHistoryFixtureAssertions: checks.4,
                                scopedRelayFixtureAssertions: checks.5, scopedEnrollmentFixtureAssertions: checks.6)
                print("PASS isolated native HTTPS exchange phase: " + args.phase)
                fflush(stdout); exit(0)
            } catch {
                let stage: String
                if case ExchangeFailure.assertion(let label) = error { stage = "check-" + label }
                else if case DmUnresolvedProbeError.assertion(let label) = error { stage = "unresolved-check-" + label }
                else if case DmAuthProbeError.assertion(let label) = error { stage = "auth-check-" + label }
                else if case DmAccountDirectoryProbeError.assertion(let label) = error { stage = "directory-check-" + label }
                else if case DmMessageAuthorityProbeError.assertion(let label) = error { stage = "message-authority-check-" + label }
                else if case DmPairingHistoryProbeError.assertion(let label) = error { stage = "pairing-history-check-" + label }
                else if case DmScopedRelayProbeError.assertion(let label) = error { stage = "scoped-relay-check-" + label }
                else if case DmScopedEnrollmentProbeError.assertion(let label) = error { stage = "scoped-enrollment-check-" + label }
                else if error is DmCoordinatorError { stage = "native-state-or-result-refused" }
                else if error is DmRelayTransportError { stage = "network-unresolved" }
                else if error is VodozemacSealedStoreError { stage = "sealed-store-refused" }
                else { stage = "research-check-failed" }
                try? ExchangeArguments.read().status("failed", stage: stage)
                print("FAIL isolated native HTTPS exchange; no production state touched")
                fflush(stdout); exit(1)
            }
        }
    }
}
