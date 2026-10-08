// Simulator-only native setup for the actual Research PM window. The UI owner
// is the SAME authenticated ResearchAuthHost facade. Only the separate fresh
// peer sends here; the UI owner's compose/send/receive path remains the real
// Capacitor port. Synthetic Auth/relay are not live-server or device evidence.
#if E2EE_LOCAL_UI_FIXTURE
import Foundation

enum ResearchProtectedUiFixtureError: Error { case unavailable }

final class ResearchProtectedUiFixture: @unchecked Sendable {
    static let outgoingText = "Protected UI outgoing canary"
    static let peerText = "Protected UI peer canary"
    static let openerText = "Protected UI opener canary"
    private static let openerID = "94000000-0000-4000-8000-000000000001"
    private static let replyID = "94000000-0000-4000-8000-000000000002"

    private enum Phase { case fresh, preparing, prepared, replying, replied, reporting, failed }
    private final class Actor {
        let facade: VodozemacSessionFacade
        let account: DmSessionAccount
        let owner: DmNativeMessageSnapshot
        let control: ResearchMessagingAdapter
        var paired: DmNativeMessageSnapshot?
        var peerFingerprint: String?

        init(facade: VodozemacSessionFacade, account: DmSessionAccount,
             transport: VodozemacRelayTransport) throws {
            self.facade = facade; self.account = account
            owner = try facade.messageSnapshot(credentialBinding: account.credentialBinding)
            control = ResearchMessagingAdapter(facade: facade, transport: transport,
                projectOrigin: ResearchAuthConfiguration.origin,
                conversationId: ResearchAuthConfiguration.conversation)
        }

        func requireCurrent() throws {
            guard !Task.isCancelled, facade.currentAccount() == account,
                  facade.currentMessageContext(snapshot: owner) == owner.context,
                  paired.map({ facade.currentMessageContext(snapshot: $0) == $0.context }) ?? true else {
                throw ResearchProtectedUiFixtureError.unavailable
            }
        }
    }

    private let host: Actor
    // Keep the owned peer namespace alive. No reset, account renewal, identity
    // replacement or cleanup is performed here; the runner owns its simulator.
    private var peerDirectory: VodozemacAccountDirectory?
    private var peer: Actor?
    private var peerMessages: ResearchPrivateMessageAdapter?
    private var peerLifecycle: String?
    private var hostInitiates: Bool?
    private var outgoingID: String?
    private var outgoingSHA256: String?
    private var replySHA256: String?
    private var openerSHA256: String?
    private let lock = NSLock()
    private var phase: Phase = .fresh
    private var assertions = 0
    private var calls: [String: Int] = ["peer-authenticate": 0, "host-register": 0, "peer-register": 0,
        "host-require-protected": 0, "peer-require-protected": 0,
        "host-pairing-card": 0, "peer-pairing-card": 0,
        "host-inspect-peer": 0, "peer-inspect-peer": 0,
        "host-confirm-peer": 0, "peer-confirm-peer": 0,
        "host-claim": 0, "peer-claim": 0, "peer-pm-issue": 0,
        "peer-pm-inbox": 0, "peer-pm-send": 0,
        "host-thread-read": 0, "peer-thread-read": 0]

    init(facade: VodozemacSessionFacade) throws {
        do {
            try Self.requireSimulator()
            guard let account = facade.currentAccount(), account.serverVerified,
                  account.accountId == ResearchLocalUiFixture.userID,
                  Self.identifier(account.deviceId), Self.identifier(account.credentialBinding) else {
                throw ResearchProtectedUiFixtureError.unavailable
            }
            host = try Actor(facade: facade, account: account,
                transport: ResearchProtectedUiRelay.transport())
            try host.requireCurrent()
        } catch { throw ResearchProtectedUiFixtureError.unavailable }
    }

    /// Called explicitly by the owned WK fixture only after real SDK/native
    /// sign-in. No ordinary Auth, admission read or PM open invokes setup.
    func prepare() async throws -> Bool {
        try begin(.fresh, next: .preparing)
        do {
            try Self.requireSimulator(); try host.requireCurrent()
            let initialPair = try pairing(host)
            let initialEnrollment = try enrollment(host)
            try check(initialPair.status == .unpaired && initialPair.peerGeneration == nil
                && initialPair.outgoingCount == 0 && initialPair.incomingCount == 0
                && initialPair.unresolvedCount == 0)
            try check(initialEnrollment.registration == .none && initialEnrollment.claim == .none)
            try check(try admission(host) == .unknown)

            let directory = try VodozemacAccountDirectory.create(
                parentDirectory: FileManager.default.temporaryDirectory,
                authenticator: ResearchProtectedUiRelay.authenticator(),
                conversationId: ResearchAuthConfiguration.conversation)
            peerDirectory = directory
            let facade = VodozemacSessionFacade(directory: directory)
            let fence = try facade.fenceSession(mode: .verify)
            count("peer-authenticate")
            let account = try await facade.authenticate(accessToken: ResearchProtectedUiRelay.peerBearer,
                authFence: fence.authFence)
            try host.requireCurrent()
            try check(account.serverVerified && account.accountId == ResearchProtectedUiRelay.peerUserID
                && account.accountId != host.account.accountId && account.deviceId != host.account.deviceId
                && Self.identifier(account.deviceId) && Self.identifier(account.credentialBinding))
            let other = try Actor(facade: facade, account: account,
                transport: ResearchProtectedUiRelay.transport())
            peer = other
            try requireBoth(other)

            for (actor, name) in [(host, "host"), (other, "peer")] {
                count(name + "-register")
                _ = try await actor.control.registerDevice(credentialBinding: actor.account.credentialBinding).publish()
                try requireBoth(other)
                let registered = try enrollment(actor)
                try check(registered.registration == .acknowledged && registered.claim == .none)
                count(name + "-require-protected")
                let protected = try await actor.control.requireProtected(
                    credentialBinding: actor.account.credentialBinding).publish()
                try requireBoth(other)
                let selection = try admission(actor)
                try check(protected["status"] as? String == "account_mode"
                    && protected["mode"] as? String == "protected-required"
                    && selection == .protectedRequired)
            }

            let ownCard = try publicCard(host, name: "host")
            let otherCard = try publicCard(other, name: "peer")
            for (actor, name, card) in [(host, "host", otherCard), (other, "peer", ownCard)] {
                count(name + "-inspect-peer")
                let inspected = try actor.control.inspectPeerCard(
                    credentialBinding: actor.account.credentialBinding, card: card.wire).publish()
                try check(inspected["status"] as? String == "peer_card"
                    && inspected["card"] as? String == card.wire
                    && inspected["fingerprint"] as? String == card.fingerprint)
                count(name + "-confirm-peer")
                _ = try actor.control.confirmPeer(credentialBinding: actor.account.credentialBinding,
                    card: card.wire, confirmedFingerprint: card.fingerprint).publish()
                let pair = try pairing(actor)
                guard let generation = pair.peerGeneration else { throw ResearchProtectedUiFixtureError.unavailable }
                try check(pair.status == .confirmed && pair.confirmedFingerprint == card.fingerprint)
                actor.paired = try actor.facade.messageSnapshot(
                    credentialBinding: actor.account.credentialBinding, peerGeneration: generation)
                actor.peerFingerprint = card.fingerprint
                try requireBoth(other)
            }

            let initiates = host.account.deviceId.utf8.lexicographicallyPrecedes(other.account.deviceId.utf8)
            hostInitiates = initiates
            let hostPair = try pairing(host), peerPair = try pairing(other)
            try check(hostPair.sessionRole == (initiates ? .initiator : .responder)
                && peerPair.sessionRole == (initiates ? .responder : .initiator))
            let initiator = initiates ? host : other
            count(initiates ? "host-claim" : "peer-claim")
            _ = try await initiator.control.claimPeer(credentialBinding: initiator.account.credentialBinding).publish()
            try requireBoth(other)
            let claimed = try enrollment(initiator), responderEnrollment = try enrollment(initiates ? other : host)
            try check(claimed.claim == .verified && responderEnrollment.claim == .none)

            let messages = ResearchPrivateMessageAdapter(facade: other.facade,
                transport: try ResearchProtectedUiRelay.transport())
            peerMessages = messages
            count("peer-pm-issue")
            let ready = try messages.issue(credentialBinding: other.account.credentialBinding).publish()
            guard ready["status"] as? String == "ready",
                  let authority = ready["authority"] as? [String: Any],
                  let version = authority["lifecycleVersion"] as? String else {
                throw ResearchProtectedUiFixtureError.unavailable
            }
            try check(authority["accountId"] as? String == other.account.accountId
                && authority["deviceId"] as? String == other.account.deviceId && Self.identifier(version))
            peerLifecycle = version
            if !initiates {
                count("peer-pm-send")
                _ = try await messages.sendText(lifecycleVersion: version, peerAccountId: host.account.accountId,
                    clientMessageId: Self.openerID, text: Self.openerText).publish()
                try requireBoth(other)
                let row = try exactRow(thread(other, name: "peer"), id: Self.openerID, direction: .outgoing,
                    text: Self.openerText, delivery: .serverAccepted)
                try requireRelayHash(row.envelopeSha256)
                openerSHA256 = row.envelopeSha256
            }
            try requireBoth(other)
            finish(.prepared)
            return initiates
        } catch {
            finish(.failed)
            throw ResearchProtectedUiFixtureError.unavailable
        }
    }

    /// Receives the actual UI compose/send record. Its ID is selected only from
    /// decrypted committed peer history, never supplied by JS or reconstructed.
    func peerCatchupAndReply() async throws {
        try begin(.prepared, next: .replying)
        do {
            try Self.requireSimulator()
            guard let other = peer, let messages = peerMessages, let version = peerLifecycle,
                  let initiates = hostInitiates else { throw ResearchProtectedUiFixtureError.unavailable }
            try requireBoth(other)
            count("peer-pm-inbox")
            _ = try await messages.inbox(lifecycleVersion: version).publish()
            try requireBoth(other)
            let received = try thread(other, name: "peer")
            let incoming = received.messages.filter {
                $0.direction == .incoming && $0.text?.utf8.elementsEqual(Self.outgoingText.utf8) == true
            }
            try check(incoming.count == 1 && received.messages.count == (initiates ? 1 : 2)
                && received.unresolvedCount == 0)
            guard let candidate = incoming.first else { throw ResearchProtectedUiFixtureError.unavailable }
            let peerRow = try exactRow(received, id: candidate.clientMessageId, direction: .incoming,
                text: Self.outgoingText, delivery: .received)
            let hostRow = try exactRow(thread(host, name: "host"), id: peerRow.clientMessageId, direction: .outgoing,
                text: Self.outgoingText, delivery: .serverAccepted)
            try check(hostRow.envelopeSha256 == peerRow.envelopeSha256
                && peerRow.clientMessageId != Self.openerID && peerRow.clientMessageId != Self.replyID)
            try requireRelayHash(peerRow.envelopeSha256)
            outgoingID = peerRow.clientMessageId; outgoingSHA256 = peerRow.envelopeSha256
            count("peer-pm-send")
            _ = try await messages.sendText(lifecycleVersion: version, peerAccountId: host.account.accountId,
                clientMessageId: Self.replyID, text: Self.peerText).publish()
            try requireBoth(other)
            let reply = try exactRow(thread(other, name: "peer"), id: Self.replyID, direction: .outgoing,
                text: Self.peerText, delivery: .serverAccepted)
            try requireRelayHash(reply.envelopeSha256)
            replySHA256 = reply.envelopeSha256
            finish(.replied)
        } catch {
            finish(.failed)
            throw ResearchProtectedUiFixtureError.unavailable
        }
    }

    /// Called only after the DOM's explicit native refresh. Nothing here scans
    /// the UI inbox or delivers a reply: it reads already committed native rows.
    func evidence() throws -> [String: Any] {
        try begin(.replied, next: .reporting)
        do {
            try Self.requireSimulator()
            guard let other = peer, let initiates = hostInitiates, let id = outgoingID,
                  let outgoingHash = outgoingSHA256, let replyHash = replySHA256 else {
                throw ResearchProtectedUiFixtureError.unavailable
            }
            try requireBoth(other)
            let hostThread = try thread(host, name: "host"), peerThread = try thread(other, name: "peer")
            let hostOutgoing = try exactRow(hostThread, id: id, direction: .outgoing,
                text: Self.outgoingText, delivery: .serverAccepted)
            let peerIncoming = try exactRow(peerThread, id: id, direction: .incoming,
                text: Self.outgoingText, delivery: .received)
            let peerReply = try exactRow(peerThread, id: Self.replyID, direction: .outgoing,
                text: Self.peerText, delivery: .serverAccepted)
            let hostReply = try exactRow(hostThread, id: Self.replyID, direction: .incoming,
                text: Self.peerText, delivery: .received)
            try check(hostOutgoing.envelopeSha256 == outgoingHash && peerIncoming.envelopeSha256 == outgoingHash
                && peerReply.envelopeSha256 == replyHash && hostReply.envelopeSha256 == replyHash)
            if !initiates {
                guard let openingHash = openerSHA256 else { throw ResearchProtectedUiFixtureError.unavailable }
                let hostOpening = try exactRow(hostThread, id: Self.openerID, direction: .incoming,
                    text: Self.openerText, delivery: .received)
                let peerOpening = try exactRow(peerThread, id: Self.openerID, direction: .outgoing,
                    text: Self.openerText, delivery: .serverAccepted)
                try check(hostOpening.envelopeSha256 == openingHash && peerOpening.envelopeSha256 == openingHash)
            } else { try check(openerSHA256 == nil) }
            let expected = initiates ? 2 : 3
            try check(hostThread.messages.count == expected && peerThread.messages.count == expected
                && hostThread.unresolvedCount == 0 && peerThread.unresolvedCount == 0
                && !hostThread.messages.contains(where: { $0.delivery == .pending })
                && !peerThread.messages.contains(where: { $0.delivery == .pending }))
            let relay = try ResearchProtectedUiRelay.evidence()
            guard let hashes = relay["acceptedEnvelopeSHA256"] as? [String],
                  let absent = relay["canaryAbsence"] as? [String: Bool],
                  let methods = relay["methodCounters"] as? [String: Int],
                  let auth = relay["authCounters"] as? [String: Int],
                  let actions = relay["actionCounters"] as? [String: Int],
                  let signatures = relay["signatureVerificationCounts"] as? [String: Int] else {
                throw ResearchProtectedUiFixtureError.unavailable
            }
            let expectedHashes = [outgoingHash, replyHash] + (openerSHA256.map { [$0] } ?? [])
            try check(hashes.count == expected && Set(hashes).count == expected
                && Set(hashes) == Set(expectedHashes)
                && relay["acceptedSendCount"] as? Int == expected
                && Set(absent.keys) == ["outgoing", "peer", "opener"] && absent.values.allSatisfy({ $0 }))
            // These are measured fixture HTTP/verification counts, including
            // the host's two cold independent verifier requests. The original
            // cold URLProtocol counters do not cover this protected relay.
            try check(methods["unexpected"] == 0 && methods["auth"] == 4 && methods["register"] == 2
                && auth["host"] == 2 && auth["peer"] == 2
                && actions["require-protected"] == 2 && actions["account-mode"] == 0
                && actions["claim"] == 1 && actions["send"] == expected
                && (actions["list"] ?? 0) >= 3 && (actions["list"] ?? 0) <= 16
                && methods["dispatch"] == actions.values.reduce(0, +)
                && signatures["registration"] == 2 && signatures["dispatch"] == methods["dispatch"])
            let hostFacts = try actorEvidence(host, expectedPeer: other, initiator: initiates,
                outgoing: 1, incoming: initiates ? 1 : 2)
            let peerFacts = try actorEvidence(other, expectedPeer: host, initiator: !initiates,
                outgoing: initiates ? 1 : 2, incoming: 1)
            try requireBoth(other)
            lock.lock(); let actualAssertions = assertions, actualCalls = calls; lock.unlock()
            let result: [String: Any] = ["version": 1, "status": "passed", "hostInitiates": initiates,
                "originalHostBindingStillCurrent": true, "originalPeerBindingStillCurrent": true,
                "host": hostFacts, "peer": peerFacts,
                "uiOutgoingEnvelopeSHA256": outgoingHash, "peerReplyEnvelopeSHA256": replyHash,
                "peerOpenerEnvelopeSHA256": openerSHA256.map { $0 as Any } ?? NSNull(),
                "nativeAssertions": actualAssertions, "nativeCalls": actualCalls,
                "relay": relay, "syntheticAuthAndRelay": true, "physicalDeviceExecution": false]
            finish(.replied)
            return result
        } catch {
            finish(.failed)
            throw ResearchProtectedUiFixtureError.unavailable
        }
    }

    private static func requireSimulator() throws {
#if targetEnvironment(simulator)
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID else {
            throw ResearchProtectedUiFixtureError.unavailable
        }
#else
        throw ResearchProtectedUiFixtureError.unavailable
#endif
    }
    private static func identifier(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    private func begin(_ expected: Phase, next: Phase) throws {
        lock.lock(); defer { lock.unlock() }
        guard phase == expected, !Task.isCancelled else { throw ResearchProtectedUiFixtureError.unavailable }
        phase = next
    }
    // Fixed counters only, also usable after refusal. No account capabilities,
    // raw errors, keys, ciphertext or plaintext enter diagnostic output.
    func diagnostics() -> [String: Any] {
        lock.lock(); let a = assertions, c = calls; lock.unlock()
        var value: [String: Any] = ["nativeAssertions": a, "nativeCalls": c]
        if let paired = host.paired, host.facade.currentAccount() == host.account,
           case .thread(let rows) = try? host.facade.executeMessageOperation(snapshot: paired, operation: .thread) {
            value["hostRowFacts"] = rows.messages.map { ["direction": $0.direction.rawValue, "delivery": $0.delivery.rawValue,
                "matchesOutgoingCanary": $0.text == Self.outgoingText, "matchesPeerCanary": $0.text == Self.peerText,
                "hasLocalTime": $0.localCreatedAtMillis != nil] as [String: Any] }
        }
        return value
    }
    private func finish(_ next: Phase) { lock.lock(); phase = next; lock.unlock() }
    private func count(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        if let prior = calls[name] { calls[name] = prior + 1 }
    }
    private func check(_ condition: @autoclosure () throws -> Bool) throws {
        guard try condition() else { throw ResearchProtectedUiFixtureError.unavailable }
        lock.lock(); assertions += 1; lock.unlock()
    }
    private func requireBoth(_ other: Actor) throws {
        try host.requireCurrent(); try other.requireCurrent()
    }
    private func pairing(_ actor: Actor) throws -> DmNativePairingState {
        try actor.requireCurrent()
        guard case .pairingState(let value) = try actor.facade.executeMessageOperation(
            snapshot: actor.owner, operation: .pairingState) else { throw ResearchProtectedUiFixtureError.unavailable }
        return value
    }
    private func enrollment(_ actor: Actor) throws -> DmNativeRelayEnrollmentState {
        try actor.requireCurrent()
        guard case .enrollmentState(let value) = try actor.facade.executeMessageOperation(
            snapshot: actor.owner, operation: .relayEnrollmentState) else { throw ResearchProtectedUiFixtureError.unavailable }
        return value
    }
    private func admission(_ actor: Actor) throws -> DmNativePrivateAdmissionState {
        try actor.requireCurrent()
        guard case .privateAdmissionState(let value) = try actor.facade.executeMessageOperation(
            snapshot: actor.owner, operation: .privateAdmissionState) else { throw ResearchProtectedUiFixtureError.unavailable }
        return value
    }
    private func publicCard(_ actor: Actor, name: String) throws -> (wire: String, fingerprint: String) {
        count(name + "-pairing-card")
        let value = try actor.control.pairingCard(credentialBinding: actor.account.credentialBinding).publish()
        guard value["status"] as? String == "pairing_card", let wire = value["card"] as? String,
              let fingerprint = value["fingerprint"] as? String,
              case .pairingCard(let native) = try actor.facade.executeMessageOperation(
                snapshot: actor.owner, operation: .pairingCard) else { throw ResearchProtectedUiFixtureError.unavailable }
        let nativeFingerprint = try native.fingerprint()
        try check(native.identity.userId == actor.account.accountId && native.identity.deviceId == actor.account.deviceId
            && native.projectOrigin == ResearchAuthConfiguration.origin
            && native.conversationId == ResearchAuthConfiguration.conversation
            && nativeFingerprint == fingerprint)
        return (wire, fingerprint)
    }
    private func thread(_ actor: Actor, name: String) throws -> DmNativeThread {
        try actor.requireCurrent()
        guard let paired = actor.paired,
              case .thread(let value) = try actor.facade.executeMessageOperation(snapshot: paired, operation: .thread) else {
            throw ResearchProtectedUiFixtureError.unavailable
        }
        count(name + "-thread-read")
        try check(value.ownerGeneration == paired.context.ownerGeneration && value.peerGeneration == paired.context.peerGeneration
            && value.outgoingCapacity == 16 && value.incomingCapacity == 16 && value.messages.count <= 32)
        return value
    }
    private func exactRow(_ thread: DmNativeThread, id: String, direction: DmNativeThreadDirection,
                          text: String, delivery: DmNativeThreadDelivery) throws -> DmNativeThreadMessage {
        let matches = thread.messages.filter { $0.clientMessageId == id && $0.direction == direction }
        try check(matches.count == 1)
        guard let row = matches.first else { throw ResearchProtectedUiFixtureError.unavailable }
        try check(Self.identifier(row.clientMessageId) && row.text?.utf8.elementsEqual(text.utf8) == true
            && row.delivery == delivery && row.reason == nil
            && (direction != .incoming || row.localCreatedAtMillis == nil)
            && row.envelopeSha256.utf8.count == 64
            && row.envelopeSha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }))
        return row
    }
    private func requireRelayHash(_ hash: String) throws {
        let evidence = try ResearchProtectedUiRelay.evidence()
        guard let hashes = evidence["acceptedEnvelopeSHA256"] as? [String],
              let absent = evidence["canaryAbsence"] as? [String: Bool] else {
            throw ResearchProtectedUiFixtureError.unavailable
        }
        try check(hashes.filter({ $0 == hash }).count == 1
            && Set(absent.keys) == ["outgoing", "peer", "opener"] && absent.values.allSatisfy({ $0 }))
    }
    private func actorEvidence(_ actor: Actor, expectedPeer: Actor, initiator: Bool,
                               outgoing: Int, incoming: Int) throws -> [String: Any] {
        let pair = try pairing(actor), registered = try enrollment(actor), selection = try admission(actor)
        guard let paired = actor.paired, let fingerprint = actor.peerFingerprint,
              case .privateMessagePeer(let pinned) = try actor.facade.executeMessageOperation(
                snapshot: paired, operation: .privateMessagePeer) else { throw ResearchProtectedUiFixtureError.unavailable }
        try check(pair.status == .confirmed && pair.peerGeneration == paired.context.peerGeneration
            && pair.confirmedFingerprint == fingerprint && pair.sessionRole == .established
            && pinned.accountId == expectedPeer.account.accountId && pinned.deviceId == expectedPeer.account.deviceId
            && pinned.fingerprint == fingerprint && pinned.generation == paired.context.peerGeneration
            && pair.outgoingCount == outgoing && pair.incomingCount == incoming && pair.unresolvedCount == 0
            && registered.registration == .acknowledged
            && registered.claim == (initiator ? .verified : .none) && selection == .protectedRequired)
        return ["accountId": actor.account.accountId, "deviceId": actor.account.deviceId,
            "selection": selection.rawValue, "registration": "acknowledged", "claim": initiator ? "verified" : "none",
            "pairing": "confirmed", "initialRole": initiator ? "initiator" : "responder",
            "sessionRole": pair.sessionRole.rawValue, "fullFingerprintStillConfirmed": true,
            "outgoingCount": pair.outgoingCount, "incomingCount": pair.incomingCount,
            "unresolvedCount": pair.unresolvedCount]
    }
}
#endif
