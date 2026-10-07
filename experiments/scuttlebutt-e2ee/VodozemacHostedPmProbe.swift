// ISOLATED HOSTED SIMULATOR ONLY. Two controlled fixture principals coexist in
// one fresh simulator. Both native Auth and relay use ordinary HTTPS/TLS, with
// no URLProtocol, mock responses, custom CA, key export or production wiring.
import Foundation
import CryptoKit

enum DmHostedPmProbeError: Error { case assertion(String) }
private final class DmHostedPmChecks {
    var count = 0
    func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw DmHostedPmProbeError.assertion(label) }
        count += 1
    }
}
private struct DmHostedPmInput: Decodable {
    struct Account: Decodable { let userId: String; let email: String; let accessToken: String }
    let version: Int
    let runID: String
    let project: String
    let projectOrigin: String
    let serviceBasePath: String
    let publicApiKey: String
    let conversationId: String
    let accounts: [Account]
}
private enum DmHostedPmFixture {
    static let origin = "https://kmtupdvwdgbhtssqqova.supabase.co"
    static let project = "kmtupdvwdgbhtssqqova"
    static let basePath = "/functions/v1/scuttlebutt-e2ee-pilot"
    static let emails = ["e2ee-native-fixture-a@thalassa.invalid", "e2ee-native-fixture-b@thalassa.invalid"]
    static let humans = ["f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73", "8fb85554-2385-49e9-8928-80d9407c05b1"]
    static let openingID = "91000000-0000-4000-8000-000000000001"
    static let replyID = "91000000-0000-4000-8000-000000000002"
    static let uncertainID = "91000000-0000-4000-8000-000000000003"
    static let opening = "Native hosted research opening"
    static let reply = "Native hosted research reply"
    static let uncertain = "Native hosted research uncertain"
}
private func dmHostedPmWrite(_ value: [String: Any], to url: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
private func dmHostedPmInput(_ url: URL, runID: UUID) throws -> DmHostedPmInput {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
          (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
          let size = attributes[.size] as? NSNumber, (1...65536).contains(size.intValue) else {
        throw DmHostedPmProbeError.assertion("private-input-metadata")
    }
    let bytes = try Data(contentsOf: url)
    guard !bytes.isEmpty, bytes.count <= 65536 else { throw DmHostedPmProbeError.assertion("private-input-size") }
    // Consume the exact owned sandbox file immediately. Tokens remain native
    // memory only; malformed input also leaves no persistent token copy here.
    try FileManager.default.removeItem(at: url)
    guard let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          Set(fields.keys) == ["version", "runID", "project", "projectOrigin", "serviceBasePath", "publicApiKey", "conversationId", "accounts"],
          let rows = fields["accounts"] as? [[String: Any]], rows.count == 2,
          rows.allSatisfy({ Set($0.keys) == ["userId", "email", "accessToken"] }) else {
        throw DmHostedPmProbeError.assertion("private-input-fields")
    }
    let input = try JSONDecoder().decode(DmHostedPmInput.self, from: bytes)
    guard input.version == 1, input.runID == runID.uuidString.lowercased(),
          input.project == DmHostedPmFixture.project, input.projectOrigin == DmHostedPmFixture.origin,
          input.serviceBasePath == DmHostedPmFixture.basePath,
          input.conversationId == "native-pm-" + input.runID, input.accounts.count == 2,
          input.accounts.enumerated().allSatisfy({ index, account in
              account.email == DmHostedPmFixture.emails[index]
                && UUID(uuidString: account.userId)?.uuidString.lowercased() == account.userId
                && !DmHostedPmFixture.humans.contains(account.userId)
                && !account.accessToken.isEmpty && account.accessToken.utf8.count <= 8192
          }), input.accounts[0].userId != input.accounts[1].userId else {
        throw DmHostedPmProbeError.assertion("private-input-pins")
    }
    return input
}

// Native-owned index/account paths only. Closing on failure is nonmutating;
// destruction is called ONLY after all hosted assertions and summary creation.
private final class DmHostedPmDirectory {
    let directory: VodozemacAccountDirectory
    let root: URL
    let index: VodozemacSealedStore
    private var identifiers: Set<UUID> = []
    private var handles: [VodozemacSealedStore] = []
    init(auth: VodozemacSupabaseAuth, conversation: String) throws {
        directory = try .create(parentDirectory: FileManager.default.temporaryDirectory,
            authenticator: auth, conversationId: conversation)
        root = directory.directoryURL
        let locator = try String(contentsOf: root.appendingPathComponent("index-id"), encoding: .utf8)
        guard let id = UUID(uuidString: String(locator.dropLast())), locator == id.uuidString.lowercased() + "\n" else {
            throw DmHostedPmProbeError.assertion("owned-index-locator")
        }
        index = try .reopen(directory: root.appendingPathComponent(id.uuidString.lowercased()), storeID: id)
        identifiers.insert(id)
    }
    private func rows() throws -> [[String: Any]] {
        guard let fields = try JSONSerialization.jsonObject(with: index.read().payload) as? [String: Any],
              let rows = fields["accounts"] as? [[String: Any]] else { throw DmHostedPmProbeError.assertion("owned-index-rows") }
        for row in rows {
            guard let text = row["storeId"] as? String, let id = UUID(uuidString: text), text == id.uuidString.lowercased() else {
                throw DmHostedPmProbeError.assertion("owned-account-locator")
            }
            identifiers.insert(id)
        }
        return rows
    }
    func account(_ userID: String) throws -> VodozemacSealedStore {
        guard let row = try rows().first(where: { $0["userId"] as? String == userID }),
              let text = row["storeId"] as? String, let id = UUID(uuidString: text) else {
            throw DmHostedPmProbeError.assertion("owned-authenticated-account")
        }
        let store = try VodozemacSealedStore.reopen(directory: root.appendingPathComponent(text), storeID: id)
        handles.append(store); return store
    }
    func closePreservingState() {
        directory.closeForResearch(); handles.forEach { $0.close() }; index.close()
    }
    func destroy() throws {
        _ = try rows()
        try directory.signOut()
        closePreservingState()
        let fm = FileManager.default
        let names = Set(try fm.contentsOfDirectory(atPath: root.path))
        guard names.isSubset(of: Set(identifiers.map { $0.uuidString.lowercased() }).union(["index-id"])) else {
            throw DmHostedPmProbeError.assertion("owned-cleanup-names")
        }
        for id in identifiers {
            let leaf = root.appendingPathComponent(id.uuidString.lowercased())
            guard try fm.attributesOfItem(atPath: leaf.path)[.type] as? FileAttributeType == .typeDirectory else {
                throw DmHostedPmProbeError.assertion("owned-cleanup-directory")
            }
            let files = Set(try fm.contentsOfDirectory(atPath: leaf.path))
            guard files.isSubset(of: ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]) else {
                throw DmHostedPmProbeError.assertion("owned-cleanup-leaves")
            }
            for file in files {
                let url = leaf.appendingPathComponent(file)
                guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular else {
                    throw DmHostedPmProbeError.assertion("owned-cleanup-file")
                }
                try fm.removeItem(at: url)
            }
            try VodozemacSealedStore.deleteResearchKey(storeID: id)
            try fm.removeItem(at: leaf)
        }
        try fm.removeItem(at: root.appendingPathComponent("index-id"))
        try fm.removeItem(at: root)
    }
}

private final class DmHostedPmActor {
    let owned: DmHostedPmDirectory
    let facade: VodozemacSessionFacade
    let transport: VodozemacRelayTransport
    let control: ResearchMessagingAdapter
    let pm: ResearchPrivateMessageAdapter
    let source: DmHostedPmInput.Account
    var account: DmSessionAccount
    let store: VodozemacSealedStore
    let generation: Int64
    var peerGeneration: Int64?
    var version: String?
    var peerUserID: String?
    init(owned: DmHostedPmDirectory, facade: VodozemacSessionFacade, account: DmSessionAccount,
         source: DmHostedPmInput.Account, input: DmHostedPmInput) throws {
        self.owned = owned; self.facade = facade; self.account = account; self.source = source
        store = try owned.account(account.accountId)
        generation = try facade.messageSnapshot(credentialBinding: account.credentialBinding).context.ownerGeneration
        transport = try VodozemacRelayTransport(serviceOrigin: input.projectOrigin, serviceBasePath: input.serviceBasePath)
        control = ResearchMessagingAdapter(facade: facade, transport: transport,
            projectOrigin: input.projectOrigin, conversationId: input.conversationId)
        pm = ResearchPrivateMessageAdapter(facade: facade, transport: transport)
    }
    func renew(_ checks: DmHostedPmChecks) async throws {
        let fence = try facade.fenceSession(mode: .verify)
        let next = try await facade.authenticate(accessToken: source.accessToken, authFence: fence.authFence)
        try checks.require(next.accountId == account.accountId && next.deviceId == account.deviceId,
            "phase-auth-keeps-native-owner-device")
        account = next; version = nil
        try checks.require(try facade.messageSnapshot(credentialBinding: next.credentialBinding).context.ownerGeneration == generation,
            "phase-auth-does-not-advance-message-generation")
    }
    func owner() throws -> DmNativeMessageSnapshot { try facade.messageSnapshot(credentialBinding: account.credentialBinding) }
    func paired() throws -> DmNativeMessageSnapshot {
        guard let peerGeneration else { throw DmHostedPmProbeError.assertion("native-full-peer-generation") }
        return try facade.messageSnapshot(credentialBinding: account.credentialBinding, peerGeneration: peerGeneration)
    }
    func issue(_ peer: DmHostedPmActor, checks: DmHostedPmChecks) throws {
        let ready = try pm.issue(credentialBinding: account.credentialBinding).publish()
        guard ready["status"] as? String == "ready", let authority = ready["authority"] as? [String: Any],
              let id = authority["lifecycleVersion"] as? String else { throw DmHostedPmProbeError.assertion("native-pm-descriptor") }
        try checks.require(authority["accountId"] as? String == account.accountId
            && authority["deviceId"] as? String == account.deviceId, "pm-descriptor-keeps-original-owner")
        version = id; peerUserID = peer.account.accountId
    }
    func lifecycle() throws -> String {
        guard let version else { throw DmHostedPmProbeError.assertion("native-pm-issued-lifecycle") }; return version
    }
    func nativeThread() throws -> DmNativeThread {
        guard case .thread(let thread) = try facade.executeMessageOperation(snapshot: paired(), operation: .thread) else {
            throw DmHostedPmProbeError.assertion("closed-native-thread")
        }
        return thread
    }
    func row(_ id: String, incoming: Bool, text: String, checks: DmHostedPmChecks) throws -> DmNativeThreadMessage {
        guard let peerUserID else { throw DmHostedPmProbeError.assertion("native-pm-peer") }
        let dto = try pm.thread(lifecycleVersion: lifecycle(), peerAccountId: peerUserID).publish()
        guard let value = dto["value"] as? [String: Any], let messages = value["messages"] as? [[String: Any]] else {
            throw DmHostedPmProbeError.assertion("native-pm-thread-projection")
        }
        let matches = messages.filter { $0["clientMessageId"] as? String == id && $0["direction"] as? String == (incoming ? "incoming" : "outgoing") }
        try checks.require(matches.count == 1 && (matches[0]["text"] as? String)?.utf8.elementsEqual(text.utf8) == true
            && matches[0]["delivery"] as? String == (incoming ? "received" : "server_accepted"), "native-pm-literal-decrypted-history")
        let native = try nativeThread().messages.filter { $0.clientMessageId == id && $0.direction == (incoming ? .incoming : .outgoing) }
        guard native.count == 1 else { throw DmHostedPmProbeError.assertion("native-exact-history-row") }
        return native[0]
    }
    func summary() throws -> [String: Any] {
        guard let state = try JSONSerialization.jsonObject(with: store.read().payload) as? [String: Any],
              let intent = state["registrationIntent"] as? [String: Any], let bundle = intent["signedBundle"] as? String,
              let identity = state["identityKeyId"] as? String else { throw DmHostedPmProbeError.assertion("native-registration-fingerprint") }
        return ["userId": account.accountId, "deviceId": account.deviceId, "identityKeyId": identity,
            "bundleSha256": SHA256.hash(data: Data(bundle.utf8)).map { String(format: "%02x", $0) }.joined()]
    }
}

func runDmHostedPmProbe(runID: UUID, inputURL: URL, progressForResearch: ((String) -> Void)? = nil) async throws -> Int {
    let input = try dmHostedPmInput(inputURL, runID: runID), checks = DmHostedPmChecks()
    let documents = inputURL.deletingLastPathComponent()
    let recoveryURL = documents.appendingPathComponent("native-hosted-recovery-" + input.runID + ".json")
    var owned: [DmHostedPmDirectory] = [], actors: [DmHostedPmActor] = []
    var recovery: [String: Any] = ["version": 1, "runID": input.runID, "stage": "input-consumed", "directoryPaths": [],
        "hostedEnrollmentMayHaveCommitted": false, "recoveryGate": "inspect-owned-stores-and-hosted-state-before-retry"]
    try dmHostedPmWrite(recovery, to: recoveryURL)
    do {
        progressForResearch?("actual-native-auth")
        let auth = try VodozemacSupabaseAuth(projectOrigin: input.projectOrigin, publicApiKey: input.publicApiKey)
        for source in input.accounts {
            let fixture = try DmHostedPmDirectory(auth: auth, conversation: input.conversationId)
            owned.append(fixture); recovery["directoryPaths"] = owned.map { $0.root.path }
            try dmHostedPmWrite(recovery, to: recoveryURL)
            let facade = VodozemacSessionFacade(directory: fixture.directory)
            let fence = try facade.fenceSession(mode: .verify)
            let account = try await facade.authenticate(accessToken: source.accessToken, authFence: fence.authFence)
            try checks.require(account.accountId == source.userId && !DmHostedPmFixture.humans.contains(account.accountId)
                && UUID(uuidString: account.deviceId)?.uuidString.lowercased() == account.deviceId,
                "real-user-authority-and-native-device")
            actors.append(try DmHostedPmActor(owned: fixture, facade: facade, account: account, source: source, input: input))
        }
        progressForResearch?("explicit-registration-and-mode")
        for actor in actors {
            try await actor.renew(checks)
            recovery["stage"] = "registration-attempted"; recovery["hostedEnrollmentMayHaveCommitted"] = true
            try dmHostedPmWrite(recovery, to: recoveryURL)
            _ = try await actor.control.registerDevice(credentialBinding: actor.account.credentialBinding).publish()
            guard case .enrollmentState(let state) = try actor.facade.executeMessageOperation(snapshot: actor.owner(), operation: .relayEnrollmentState) else {
                throw DmHostedPmProbeError.assertion("native-registration-acknowledgement")
            }
            try checks.require(state.registration == .acknowledged && state.claim == .none, "real-registration-is-explicit-without-claim")
            let mode = try await actor.control.requireProtected(credentialBinding: actor.account.credentialBinding).publish()
            try checks.require(mode["mode"] as? String == "protected-required", "native-signed-protected-account-selection")
        }
        // Each phase captures a new explicitly verified lease before work. No
        // completion is rebound to that lease and no 60s/5s deadline is extended.
        progressForResearch?("explicit-pair-pins-and-claim")
        for actor in actors { try await actor.renew(checks) }
        let cards = try actors.map { try $0.control.pairingCard(credentialBinding: $0.account.credentialBinding).publish() }
        for index in 0..<2 {
            guard let card = cards[1-index]["card"] as? String, let fingerprint = cards[1-index]["fingerprint"] as? String else {
                throw DmHostedPmProbeError.assertion("native-public-peer-card")
            }
            let inspected = try actors[index].control.inspectPeerCard(credentialBinding: actors[index].account.credentialBinding, card: card).publish()
            try checks.require(inspected["fingerprint"] as? String == fingerprint, "controlled-fixture-public-peer-fingerprint")
            _ = try actors[index].control.confirmPeer(credentialBinding: actors[index].account.credentialBinding,
                card: card, confirmedFingerprint: fingerprint).publish()
            guard case .pairingState(let pair) = try actors[index].facade.executeMessageOperation(snapshot: actors[index].owner(), operation: .pairingState),
                  pair.status == .confirmed, let generation = pair.peerGeneration else {
                throw DmHostedPmProbeError.assertion("native-confirmed-full-pair")
            }
            actors[index].peerGeneration = generation
        }
        let sender = actors[0].account.deviceId.utf8.lexicographicallyPrecedes(actors[1].account.deviceId.utf8) ? actors[0] : actors[1]
        let receiver = sender === actors[0] ? actors[1] : actors[0]
        _ = try await sender.control.claimPeer(credentialBinding: sender.account.credentialBinding).publish()
        for actor in actors {
            let mode = try await actor.control.refreshAccountMode(credentialBinding: actor.account.credentialBinding).publish()
            try checks.require(mode["mode"] as? String == "protected-required", "fresh-real-account-mode-diagnostic")
        }
        progressForResearch?("actual-private-message-opening-and-reply")
        for actor in actors { try await actor.renew(checks) }
        try sender.issue(receiver, checks: checks); try receiver.issue(sender, checks: checks)
        _ = try await sender.pm.sendText(lifecycleVersion: sender.lifecycle(), peerAccountId: receiver.account.accountId,
            clientMessageId: DmHostedPmFixture.openingID, text: DmHostedPmFixture.opening).publish()
        let opening = try sender.row(DmHostedPmFixture.openingID, incoming: false, text: DmHostedPmFixture.opening, checks: checks)
        _ = try await receiver.pm.inbox(lifecycleVersion: receiver.lifecycle()).publish()
        let receivedOpening = try receiver.row(DmHostedPmFixture.openingID, incoming: true, text: DmHostedPmFixture.opening, checks: checks)
        try checks.require(opening.envelopeSha256 == receivedOpening.envelopeSha256, "recipient-opened-identical-real-provider-envelope")
        _ = try await receiver.pm.sendText(lifecycleVersion: receiver.lifecycle(), peerAccountId: sender.account.accountId,
            clientMessageId: DmHostedPmFixture.replyID, text: DmHostedPmFixture.reply).publish()
        let reply = try receiver.row(DmHostedPmFixture.replyID, incoming: false, text: DmHostedPmFixture.reply, checks: checks)
        _ = try await sender.pm.inbox(lifecycleVersion: sender.lifecycle()).publish()
        let receivedReply = try sender.row(DmHostedPmFixture.replyID, incoming: true, text: DmHostedPmFixture.reply, checks: checks)
        try checks.require(reply.envelopeSha256 == receivedReply.envelopeSha256, "reply-opened-identical-real-provider-envelope")
        let terminalBefore = try sender.store.read()
        _ = try await sender.pm.retryPending(lifecycleVersion: sender.lifecycle(), peerAccountId: receiver.account.accountId,
            clientMessageId: DmHostedPmFixture.openingID).publish()
        try checks.require(try sender.store.read() == terminalBefore, "exact-terminal-id-retry-does-not-prepare-or-advance-ratchet")

        progressForResearch?("deliberately-discarded-successful-receipt")
        for actor in actors { try await actor.renew(checks) }
        try sender.issue(receiver, checks: checks); try receiver.issue(sender, checks: checks)
        _ = try await sender.pm.permissions(lifecycleVersion: sender.lifecycle(), peerAccountId: receiver.account.accountId).publish()
        let captured = try sender.paired()
        guard case .outbox = try sender.facade.executeMessageOperation(snapshot: captured,
            operation: .privateMessagePrepareText(clientMessageId: DmHostedPmFixture.uncertainID, text: DmHostedPmFixture.uncertain)),
              case .sendRequest(let request) = try sender.facade.executeMessageOperation(snapshot: captured,
                operation: .relaySendWire(clientMessageId: DmHostedPmFixture.uncertainID)) else {
            throw DmHostedPmProbeError.assertion("native-exact-pending-send-request")
        }
        let pending = try sender.store.read()
        let response = try await sender.transport.dispatch(request: request.wire, credential: captured.credential,
            currentContext: {
                guard sender.facade.currentMessageContext(snapshot: captured) == captured.context else { return nil }
                _ = try sender.facade.executeMessageOperation(snapshot: captured, operation: .relayPolicyGuard(request.policy))
                return captured.context
            })
        guard case .accepted = try DmRelayResultCodec.receipt(response, expected: request.record) else {
            throw DmHostedPmProbeError.assertion("real-receipt-before-deliberate-discard")
        }
        // The HTTPS request really committed and returned. Deliberately do NOT
        // apply its receipt: this models lost native publication, not a network
        // drop or mock. The ordinary PM retry gets the same durable ciphertext.
        try checks.require(try sender.store.read() == pending, "discarded-receipt-retains-native-pending-record")
        let beforeRetry = try sender.nativeThread().messages.first { $0.clientMessageId == DmHostedPmFixture.uncertainID }
        try checks.require(beforeRetry?.delivery == .pending, "uncertain-native-outbox-remains-pending")
        _ = try await sender.pm.retryPending(lifecycleVersion: sender.lifecycle(), peerAccountId: receiver.account.accountId,
            clientMessageId: DmHostedPmFixture.uncertainID).publish()
        let uncertain = try sender.row(DmHostedPmFixture.uncertainID, incoming: false, text: DmHostedPmFixture.uncertain, checks: checks)
        try checks.require(uncertain.envelopeSha256 == beforeRetry?.envelopeSha256, "pending-retry-preserves-exact-provider-ciphertext")
        _ = try await receiver.pm.inbox(lifecycleVersion: receiver.lifecycle()).publish()
        let receivedUncertain = try receiver.row(DmHostedPmFixture.uncertainID, incoming: true, text: DmHostedPmFixture.uncertain, checks: checks)
        try checks.require(uncertain.envelopeSha256 == receivedUncertain.envelopeSha256, "uncertain-retry-recipient-opened-original-envelope")
        for actor in actors {
            let history = try actor.nativeThread()
            try checks.require(history.messages.count == 3 && history.unresolvedCount == 0
                && !history.messages.contains(where: { $0.delivery == .pending }), "three-committed-native-history-facts-no-pending")
        }
        let summaryURL = documents.appendingPathComponent("native-hosted-summary-" + input.runID + ".json")
        func message(_ row: DmNativeThreadMessage, from first: DmHostedPmActor, to second: DmHostedPmActor) -> [String: Any] {
            ["senderUserId": first.account.accountId, "recipientUserId": second.account.accountId,
                "clientMessageId": row.clientMessageId, "envelopeSha256": row.envelopeSha256]
        }
        try dmHostedPmWrite(["version": 1, "runID": input.runID, "status": "passed", "assertions": checks.count,
            "accounts": try actors.map { try $0.summary() },
            "messages": [message(opening, from: sender, to: receiver), message(reply, from: receiver, to: sender),
                message(uncertain, from: sender, to: receiver)]], to: summaryURL)
        recovery["stage"] = "native-assertions-complete-cleanup-pending"; try dmHostedPmWrite(recovery, to: recoveryURL)
        progressForResearch?("owned-native-cleanup")
        for fixture in owned { try fixture.destroy() }
        recovery["stage"] = "owned-native-cleanup-complete"; recovery["recoveryGate"] = "none"
        try dmHostedPmWrite(recovery, to: recoveryURL)
        return checks.count
    } catch {
        owned.forEach { $0.closePreservingState() }
        recovery["stage"] = "failed-or-incomplete-preserved-owned-state"
        try? dmHostedPmWrite(recovery, to: recoveryURL)
        throw error
    }
}
