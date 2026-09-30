// ISOLATED SYNTHETIC RESEARCH APP. No transport, app account or user messages.
// Generated UniFFI bindings are compiled beside this file, never into Thalassa.
// Each phase is a separate process launch. Only committed encrypted snapshots
// carry state across launches. Directly exchanged public keys are trusted test
// fixtures, NOT a production authenticated device directory.
import Foundation
import UIKit

private enum ProbeFailure: Error { case check, assertion(UInt) }
private func require(_ condition: @autoclosure () throws -> Bool, line: UInt = #line) throws {
    if try !condition() { throw ProbeFailure.assertion(line) }
}

private struct Packet: Codable, Equatable {
    let kind: UInt32
    let body: Data
    init(_ wire: WireMessage) { kind = wire.messageType; body = wire.body }
    var wire: WireMessage { WireMessage(messageType: kind, body: body) }
}

private struct PeerSnapshot: Codable {
    var account = ""
    var ownCurve = ""
    var peerCurve = ""
    var session: String?
    var sessionID: String?
    var pending: Packet?
    var received: String?
}

private func decode(_ store: VodozemacSealedStore) throws -> (Int64, PeerSnapshot) {
    let snapshot = try store.read()
    return (snapshot.revision, try JSONDecoder().decode(PeerSnapshot.self, from: snapshot.payload))
}

private func commit(_ store: VodozemacSealedStore, _ revision: Int64, _ state: PeerSnapshot) throws {
    _ = try store.commit(expectedRevision: revision, payload: JSONEncoder().encode(state))
}

private func runPhase(_ phase: String, runID: UUID, aliceID: UUID, bobID: UUID) throws {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let root = documents.appendingPathComponent("e2ee-research-\(runID.uuidString)")
    try ProbeProgress.write("storage")
    if phase == "prepare" {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let empty = try JSONEncoder().encode(PeerSnapshot())
        let alice = try VodozemacSealedStore.create(directory: root.appendingPathComponent(aliceID.uuidString), storeID: aliceID, initialPayload: empty)
        let bob = try VodozemacSealedStore.create(directory: root.appendingPathComponent(bobID.uuidString), storeID: bobID, initialPayload: empty)
        defer { alice.close(); bob.close() }
        try ProbeProgress.write("provider")
        let a = try newAccount(pickleKey: alice.providerPickleKey())
        let b = try newAccount(pickleKey: bob.providerPickleKey())
        // Direct public-key exchange is intentionally confined to the fixture.
        let session = try startSession(accountPickle: a.accountPickle, pickleKey: alice.providerPickleKey(), peerIdentity: b.identityCurve, peerPrekey: b.oneTimeKey)
        let message = try encrypt(sessionPickle: session.sessionPickle, pickleKey: alice.providerPickleKey(), plaintext: Data("synthetic opening before restart".utf8))
        try require(message.sessionId == session.sessionId && message.wire.messageType == 0)
        try commit(alice, 0, PeerSnapshot(account: a.accountPickle, ownCurve: a.identityCurve, peerCurve: b.identityCurve, session: message.sessionPickle, sessionID: message.sessionId, pending: Packet(message.wire)))
        try commit(bob, 0, PeerSnapshot(account: b.accountPickle, ownCurve: b.identityCurve, peerCurve: a.identityCurve))
        // Exact ciphertext is read only after the ratchet/outbox commit.
        let (_, saved) = try decode(alice)
        try require(saved.pending == Packet(message.wire))
    } else {
        let alice = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(aliceID.uuidString), storeID: aliceID)
        let bob = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(bobID.uuidString), storeID: bobID)
        defer { alice.close(); bob.close() }
        let (ar, a) = try decode(alice)
        let (br, b) = try decode(bob)
        try require(a.ownCurve == b.peerCurve && b.ownCurve == a.peerCurve)
        try ProbeProgress.write("provider")
        switch phase {
        case "receive":
            guard let packet = a.pending else { throw ProbeFailure.check }
            var damaged = packet.body
            guard !damaged.isEmpty else { throw ProbeFailure.check }
            damaged[damaged.count - 1] ^= 1
            do {
                _ = try openSession(accountPickle: b.account, pickleKey: bob.providerPickleKey(), pinnedSenderCurve: b.peerCurve, wire: WireMessage(messageType: packet.kind, body: damaged))
                throw ProbeFailure.check
            } catch is NativeCryptoError { /* expected: authenticate before commit */ }
            try require(try bob.read().revision == br)
            let opened = try openSession(accountPickle: b.account, pickleKey: bob.providerPickleKey(), pinnedSenderCurve: b.peerCurve, wire: packet.wire)
            try require(opened.plaintext == Data("synthetic opening before restart".utf8))
            try require(opened.sessionId == a.sessionID)
            let reply = try encrypt(sessionPickle: opened.sessionPickle, pickleKey: bob.providerPickleKey(), plaintext: Data("synthetic reply after restart".utf8))
            try require(reply.sessionId == opened.sessionId && reply.wire.messageType == 1)
            var next = b
            next.account = opened.accountPickle // Consumed prekey committed with session.
            next.session = reply.sessionPickle
            next.sessionID = reply.sessionId
            next.pending = Packet(reply.wire)
            next.received = "opening"
            try commit(bob, br, next)
            try require(try decode(bob).1.received == "opening")
        case "reply":
            guard let packet = b.pending, let session = a.session else { throw ProbeFailure.check }
            let opened = try decrypt(sessionPickle: session, pickleKey: alice.providerPickleKey(), wire: packet.wire)
            try require(opened.sessionId == a.sessionID && opened.plaintext == Data("synthetic reply after restart".utf8))
            let nextMessage = try encrypt(sessionPickle: opened.sessionPickle, pickleKey: alice.providerPickleKey(), plaintext: Data("synthetic successor after second restart".utf8))
            try require(nextMessage.sessionId == a.sessionID)
            var next = a
            next.session = nextMessage.sessionPickle
            next.pending = Packet(nextMessage.wire)
            next.received = "reply"
            try commit(alice, ar, next)
        case "verify":
            guard let packet = a.pending, let session = b.session else { throw ProbeFailure.check }
            let opened = try decrypt(sessionPickle: session, pickleKey: bob.providerPickleKey(), wire: packet.wire)
            try require(opened.sessionId == b.sessionID && opened.plaintext == Data("synthetic successor after second restart".utf8))
            var next = b
            next.session = opened.sessionPickle
            next.received = "successor"
            try commit(bob, br, next)
            try require(try bob.read().revision == br + 1)
            try require(a.received == "reply")
        case "replay":
            // A separate process must use the actual durable ratchet, not the
            // successful in-memory result from the preceding decryption call.
            guard let packet = a.pending, let session = b.session else { throw ProbeFailure.check }
            try require(b.received == "successor" && b.sessionID == a.sessionID)
            do {
                _ = try decrypt(sessionPickle: session, pickleKey: bob.providerPickleKey(), wire: packet.wire)
                throw ProbeFailure.check
            } catch is NativeCryptoError { /* committed session rejects replay */ }
            try require(try bob.read().revision == br)
            // A corrupt restored pickle must not masquerade as replay refusal.
            // The same durable sessions must still exchange a fresh message.
            guard let senderSession = a.session else { throw ProbeFailure.check }
            let followup = try encrypt(sessionPickle: senderSession, pickleKey: alice.providerPickleKey(), plaintext: Data("usable after durable replay refusal".utf8))
            let accepted = try decrypt(sessionPickle: session, pickleKey: bob.providerPickleKey(), wire: followup.wire)
            try require(followup.sessionId == a.sessionID && accepted.sessionId == b.sessionID)
            try require(accepted.plaintext == Data("usable after durable replay refusal".utf8))
            var nextA = a
            nextA.session = followup.sessionPickle
            nextA.pending = Packet(followup.wire)
            try commit(alice, ar, nextA)
            var nextB = b
            nextB.session = accepted.sessionPickle
            nextB.received = "post-replay"
            try commit(bob, br, nextB)
            try ProbeProgress.write("storage-probes")
            try runSealedStoreProbe(root: root)
        case "cleanup":
            try alice.destroyForTesting()
            try bob.destroyForTesting()
            // Exact empty test directory only; never recursive removal.
            try require(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
            try FileManager.default.removeItem(at: root)
        default: throw ProbeFailure.check
        }
    }
    print("PASS native research phase: \(phase)")
}

// Sanitized lifecycle receipts distinguish launch failures from failed checks.
// Never include keys, provider error descriptions, snapshots or message bytes.
private enum ProbeProgress {
    static func arguments() throws -> (phase: String, run: UUID, alice: UUID, bob: UUID) {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--probe"), args.count == i + 5,
              ["prepare", "receive", "reply", "verify", "replay", "cleanup"].contains(args[i + 1]),
              let run = UUID(uuidString: args[i + 2]), let alice = UUID(uuidString: args[i + 3]),
              let bob = UUID(uuidString: args[i + 4]), alice != bob else { throw ProbeFailure.check }
        return (args[i + 1], run, alice, bob)
    }

    static func write(_ stage: String, status: String = "running") throws {
        let args = try arguments()
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let path = documents.appendingPathComponent("probe-status-\(args.run.uuidString.lowercased()).json")
        let value: [String: Any] = ["phase": args.phase, "stage": stage, "status": status,
                                     "runID": args.run.uuidString.lowercased(), "pid": ProcessInfo.processInfo.processIdentifier,
                                     "physicalDeviceProtectionVerified": false]
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: path, options: [.atomic])
    }
}

@main
private final class ProbeApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        do { try ProbeProgress.write("didFinish") } catch { exit(1) }
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Research", sessionRole: session.role)
        configuration.delegateClass = ProbeScene.self
        return configuration
    }
}

@objc(ThalassaNativeResearchScene)
private final class ProbeScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var started = false

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: scene)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
        do { try ProbeProgress.write("sceneConnected") } catch { exit(1) }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        guard !started else { return }
        started = true
        DispatchQueue.main.async {
            do {
                try ProbeProgress.write("sceneActive")
                let args = try ProbeProgress.arguments()
                try runPhase(args.phase, runID: args.run, aliceID: args.alice, bobID: args.bob)
                try ProbeProgress.write("complete", status: "passed")
                fflush(stdout)
                exit(0)
            } catch {
                // Only fixed test labels / line numbers and our bounded store
                // error codes, never provider/localized descriptions or inputs.
                let failure: String
                switch error {
                case SealedProbeError.assertion(let label): failure = "storage-check: " + label
                case ProbeFailure.assertion(let line): failure = "check-line-\(line)"
                case let storeError as VodozemacSealedStoreError: failure = "store: \(storeError)"
                case is NativeCryptoError: failure = "native-crypto-refusal"
                default: failure = "check-failed"
                }
                try? ProbeProgress.write(failure, status: "failed")
                print("FAIL native research phase; no production state touched")
                fflush(stdout)
                exit(1)
            }
        }
    }
}
