// ISOLATED ordinary-PM projection over the ONE research native host. Account
// authentication alone never becomes readiness. No credentials, native handles,
// records, envelopes, permits, keys, pickles or store paths are serialized.
import Foundation

enum ResearchPrivateMessageAdapterError: Error { case unavailable }

/// The plugin publishes immediately before resolving JS. The retained ORIGINAL
/// native snapshots must still be current; a later lease is never substituted.
final class ResearchPrivateMessageResult {
    private let publication: () throws -> [String: Any]
    fileprivate init(_ publication: @escaping () throws -> [String: Any]) { self.publication = publication }
    func publish() throws -> [String: Any] {
        do { return try publication() }
        catch { throw ResearchPrivateMessageAdapterError.unavailable }
    }
}

final class ResearchPrivateMessageAdapter {
    private final class Entry {
        let lifecycleVersion: String
        let credentialBinding: String
        let owner: DmNativeMessageSnapshot
        let paired: DmNativeMessageSnapshot
        let peer: DmNativePrivateMessagePeer
        init(binding: String, owner: DmNativeMessageSnapshot, paired: DmNativeMessageSnapshot,
             peer: DmNativePrivateMessagePeer) {
            lifecycleVersion = UUID().uuidString.lowercased()
            credentialBinding = binding; self.owner = owner; self.paired = paired; self.peer = peer
        }
    }
    private let facade: VodozemacSessionFacade
    private let client: VodozemacScopedRelayClient
    private let registryLock = NSLock()
    // ONE descriptor, retained only in native memory. No global registry and
    // no recovery/rebinding of caller-issued revisions or old snapshots.
    private var entry: Entry?
    private var activeAction: UUID?

    init(facade: VodozemacSessionFacade, transport: VodozemacRelayTransport) {
        self.facade = facade
        client = VodozemacScopedRelayClient(facade: facade, transport: transport)
    }

    func issue(credentialBinding: String) throws -> ResearchPrivateMessageResult {
        try guarded {
            try identifier(credentialBinding)
            let owner = try facade.messageSnapshot(credentialBinding: credentialBinding)
            guard owner.context.peerGeneration == nil,
                  case .pairingState(let state) = try facade.executeMessageOperation(snapshot: owner, operation: .pairingState),
                  state.status == .confirmed, let generation = state.peerGeneration,
                  state.confirmedFingerprint != nil else { throw unavailable }
            let paired = try facade.messageSnapshot(credentialBinding: credentialBinding, peerGeneration: generation)
            let expected = DmRelayNetworkContext(userId: owner.context.userId, deviceId: owner.context.deviceId,
                ownerGeneration: owner.context.ownerGeneration, credentialEpoch: owner.context.credentialEpoch,
                peerGeneration: generation)
            guard paired.context == expected,
                  case .privateMessagePeer(let peer) = try facade.executeMessageOperation(snapshot: paired,
                    operation: .privateMessagePeer), peer.fingerprint == state.confirmedFingerprint else { throw unavailable }
            try identifier(owner.context.userId); try identifier(owner.context.deviceId)
            try identifier(peer.accountId); try identifier(peer.deviceId)
            guard peer.accountId != owner.context.userId, peer.deviceId != owner.context.deviceId,
                  peer.generation == generation, validFingerprint(peer.fingerprint) else { throw unavailable }
            let proposed = Entry(binding: credentialBinding, owner: owner, paired: paired, peer: peer)
            try requireNative(proposed)
            let selected = try select(proposed)
            try require(selected)
            return readyResult(selected)
        }
    }

    func readiness(lifecycleVersion: String) throws -> ResearchPrivateMessageResult {
        try guarded { readyResult(try capture(lifecycleVersion)) }
    }

    /// Current policy refresh is explicit. A returned canSend Boolean is only
    /// presentation: each prepare/send still arms its own real native guard.
    func permissions(lifecycleVersion: String, peerAccountId: String) async throws -> ResearchPrivateMessageResult {
        try await guardedAsync {
            let captured = try capture(lifecycleVersion, peerAccountId: peerAccountId)
            let admission = try begin(captured); defer { end(admission) }
            try await refreshPolicy(captured)
            _ = try permissionValue(captured)
            return valueResult(captured) { try self.permissionValue(captured) }
        }
    }

    /// Authenticated local history does not require a current relay permit.
    /// Unknown text/time and rejected/received outcomes remain explicit.
    func thread(lifecycleVersion: String, peerAccountId: String) throws -> ResearchPrivateMessageResult {
        try guarded {
            let captured = try capture(lifecycleVersion, peerAccountId: peerAccountId)
            _ = try threadValue(captured)
            return valueResult(captured) { try self.threadValue(captured) }
        }
    }

    /// ONE bounded scan, without hidden registration, claims, retries or loops.
    func inbox(lifecycleVersion: String) async throws -> ResearchPrivateMessageResult {
        try await guardedAsync {
            let captured = try capture(lifecycleVersion)
            let admission = try begin(captured); defer { end(admission) }
            try await refreshPolicy(captured)
            try require(captured)
            let report = try await client.syncInbox(snapshot: captured.paired)
            try require(captured)
            guard [report.stored, report.duplicates, report.historical, report.unresolved,
                   report.historicalUnresolved].allSatisfy({ (0...32).contains($0) }) else { throw unavailable }
            _ = try inboxValue(captured)
            return valueResult(captured) { try self.inboxValue(captured) }
        }
    }

    /// Reconcile an exact native outgoing ID before preparing. An unresolved
    /// different ID blocks replacement. Success comes ONLY from committed rows.
    func sendText(lifecycleVersion: String, peerAccountId: String,
                  clientMessageId: String, text: String) async throws -> ResearchPrivateMessageResult {
        try await guardedAsync {
            try identifier(clientMessageId); try validateText(text)
            let captured = try capture(lifecycleVersion, peerAccountId: peerAccountId)
            let admission = try begin(captured); defer { end(admission) }
            try await refreshPolicy(captured)
            let before = try committedThread(captured)
            let outgoing = before.messages.filter { $0.direction == .outgoing }
            let pending = outgoing.filter { $0.delivery == .pending }
            guard pending.allSatisfy({ $0.clientMessageId == clientMessageId }) else { throw unavailable }
            if let existing = outgoing.first(where: { $0.clientMessageId == clientMessageId }) {
                guard existing.text?.utf8.elementsEqual(text.utf8) == true else { throw unavailable }
            } else {
                guard pending.isEmpty else { throw unavailable }
                try require(captured)
                guard case .outbox = try facade.executeMessageOperation(snapshot: captured.paired,
                    operation: .privateMessagePrepareText(clientMessageId: clientMessageId, text: text)) else { throw unavailable }
                try require(captured)
                let prepared = try committedThread(captured).messages.filter {
                    $0.direction == .outgoing && $0.clientMessageId == clientMessageId
                }
                guard prepared.count == 1, prepared[0].text?.utf8.elementsEqual(text.utf8) == true,
                      prepared[0].delivery == .pending else { throw unavailable }
            }
            try require(captured)
            // The client's original-owner rejection lane can settle internally
            // after peer policy changes. Our final full-pair projection can
            // still refuse; no fabricated acceptance or replacement snapshot.
            _ = try await client.sendPending(clientMessageId: clientMessageId, snapshot: captured.paired)
            try require(captured)
            _ = try sentValue(captured, clientMessageId: clientMessageId, text: text)
            return valueResult(captured) {
                try self.sentValue(captured, clientMessageId: clientMessageId, text: text)
            }
        }
    }

    private var unavailable: ResearchPrivateMessageAdapterError { .unavailable }
    /// Exact committed-ID reconciliation without caller plaintext or any
    /// preparation. An unknown native ID refuses rather than creating a record.
    func retryPending(lifecycleVersion: String, peerAccountId: String,
                      clientMessageId: String) async throws -> ResearchPrivateMessageResult {
        try await guardedAsync {
            try identifier(clientMessageId)
            let captured = try capture(lifecycleVersion, peerAccountId: peerAccountId)
            let admission = try begin(captured); defer { end(admission) }
            let rows = try committedThread(captured).messages.filter {
                $0.direction == .outgoing && $0.clientMessageId == clientMessageId
            }
            guard rows.count == 1 else { throw unavailable }
            try await refreshPolicy(captured)
            try require(captured)
            _ = try await client.sendPending(clientMessageId: clientMessageId, snapshot: captured.paired)
            try require(captured)
            _ = try reconciledValue(captured, clientMessageId: clientMessageId)
            return valueResult(captured) { try self.reconciledValue(captured, clientMessageId: clientMessageId) }
        }
    }

    private func guarded<T>(_ operation: () throws -> T) throws -> T {
        do { return try operation() } catch { throw unavailable }
    }
    private func guardedAsync<T>(_ operation: () async throws -> T) async throws -> T {
        do { return try await operation() } catch { throw unavailable }
    }
    private func identifier(_ value: String) throws {
        guard value.utf8.count == 36, UUID(uuidString: value)?.uuidString.lowercased() == value else { throw unavailable }
    }
    private func validFingerprint(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private func validateText(_ value: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.utf16.count <= 4_000, value.utf8.count <= DmContentCodec.maxTextBytes,
              !value.contains("\0"), !value.components(separatedBy: "\n").contains(where: {
                  $0.hasPrefix("📍PIN|") || $0.hasPrefix("🍳RECIPE:")
              }) else { throw unavailable }
    }
    private func capture(_ version: String, peerAccountId: String? = nil) throws -> Entry {
        try identifier(version)
        if let peerAccountId { try identifier(peerAccountId) }
        registryLock.lock(); let current = entry; registryLock.unlock()
        guard let current, current.lifecycleVersion == version,
              peerAccountId == nil || peerAccountId == current.peer.accountId else { throw unavailable }
        try require(current)
        return current
    }
    private func select(_ proposed: Entry) throws -> Entry {
        registryLock.lock(); defer { registryLock.unlock() }
        // Selection serializes with issuance and verifies the ORIGINAL lease
        // while the registry is locked. A stale issue cannot overwrite a newer
        // mapping after its earlier unlocked native check. No await is allowed.
        try requireNative(proposed)
        if let previous = entry, previous.credentialBinding == proposed.credentialBinding,
           previous.owner.context == proposed.owner.context, previous.paired.context == proposed.paired.context,
           previous.peer == proposed.peer {
            try requireNative(previous)
            return previous
        }
        entry = proposed
        return proposed
    }
    private func require(_ captured: Entry) throws {
        registryLock.lock(); let same = entry === captured; registryLock.unlock()
        guard same else { throw unavailable }
        try requireNative(captured)
        registryLock.lock(); let stillSame = entry === captured; registryLock.unlock()
        guard stillSame else { throw unavailable }
    }
    private func requireNative(_ captured: Entry) throws {
        guard !Task.isCancelled,
              facade.currentMessageContext(snapshot: captured.owner) == captured.owner.context,
              facade.currentMessageContext(snapshot: captured.paired) == captured.paired.context,
              case .privateMessagePeer(let current) = try facade.executeMessageOperation(snapshot: captured.paired,
                operation: .privateMessagePeer), current == captured.peer,
              facade.currentMessageContext(snapshot: captured.owner) == captured.owner.context,
              facade.currentMessageContext(snapshot: captured.paired) == captured.paired.context else { throw unavailable }
    }
    private func begin(_ captured: Entry) throws -> UUID {
        try require(captured)
        registryLock.lock(); defer { registryLock.unlock() }
        guard entry === captured, activeAction == nil else { throw unavailable }
        let admission = UUID(); activeAction = admission
        return admission
    }
    private func end(_ admission: UUID) {
        registryLock.lock(); defer { registryLock.unlock() }
        if activeAction == admission { activeAction = nil }
    }
    private func refreshPolicy(_ captured: Entry) async throws {
        try require(captured)
        _ = try await client.refreshPolicy(snapshot: captured.owner)
        try require(captured)
    }
    private func authority(_ captured: Entry) -> [String: Any] {
        ["accountId": captured.owner.context.userId, "deviceId": captured.owner.context.deviceId,
         "lifecycleVersion": captured.lifecycleVersion, "serverVerified": true]
    }
    private func readyResult(_ captured: Entry) -> ResearchPrivateMessageResult {
        ResearchPrivateMessageResult {
            try self.require(captured)
            let dto = try self.bounded(["status": "ready", "authority": self.authority(captured),
                                       "supportedContent": ["text"]])
            try self.require(captured)
            return dto
        }
    }
    private func valueResult(_ captured: Entry, value: @escaping () throws -> Any) -> ResearchPrivateMessageResult {
        ResearchPrivateMessageResult {
            try self.require(captured)
            let dto = try self.bounded(["status": "ok", "authority": self.authority(captured), "value": try value()])
            try self.require(captured)
            return dto
        }
    }
    private func permissionsState(_ captured: Entry) throws -> DmNativePrivateMessagePermissions {
        try require(captured)
        guard case .privateMessagePermissions(let flags) = try facade.executeMessageOperation(snapshot: captured.paired,
            operation: .privateMessagePermissions), flags.peerAccountId == captured.peer.accountId,
              !flags.blockedByMe || flags.blockedEitherDirection,
              !flags.canSend || !flags.blockedEitherDirection else { throw unavailable }
        try require(captured)
        return flags
    }
    private func permissionValue(_ captured: Entry) throws -> [String: Any] {
        let flags = try permissionsState(captured)
        return ["peerAccountId": flags.peerAccountId, "blockedByMe": flags.blockedByMe,
                "blockedEitherDirection": flags.blockedEitherDirection, "canSend": flags.canSend,
                "reason": flags.canSend ? NSNull() as Any : "unavailable" as Any]
    }
    private func committedThread(_ captured: Entry) throws -> DmNativeThread {
        try require(captured)
        guard case .thread(let value) = try facade.executeMessageOperation(snapshot: captured.paired, operation: .thread),
              value.ownerGeneration == captured.owner.context.ownerGeneration,
              value.peerGeneration == captured.peer.generation, value.messages.count <= 32,
              value.outgoingCapacity == 16, value.incomingCapacity == 16,
              (0...16).contains(value.unresolvedCount) else { throw unavailable }
        var ids = Set<String>()
        var outgoing = 0; var incoming = 0; var pending = 0
        for row in value.messages {
            try identifier(row.clientMessageId)
            guard ids.insert(row.direction.rawValue + ":" + row.clientMessageId).inserted,
                  row.localCreatedAtMillis.map({ (0...DmRelayCodec.maxSafeInteger).contains($0) }) ?? true,
                  validFingerprint(row.envelopeSha256) else { throw unavailable }
            if let text = row.text { try validateText(text) }
            if row.direction == .incoming {
                incoming += 1
                guard row.delivery == .received, row.reason == nil, row.localCreatedAtMillis == nil else { throw unavailable }
            } else {
                outgoing += 1
                guard row.delivery != .received,
                      row.delivery == .rejected ? row.reason != nil : row.reason == nil else { throw unavailable }
                if row.delivery == .pending { pending += 1 }
            }
        }
        // No guessed priority or replacement ID when research fixtures contain
        // multiple unresolved outgoing attempts. Ordinary send refuses closed.
        guard outgoing <= 16, incoming <= 16, pending <= 1 else { throw unavailable }
        try require(captured)
        return value
    }
    private func messageValue(_ row: DmNativeThreadMessage, captured: Entry) -> [String: Any] {
        let outgoing = row.direction == .outgoing
        let delivery: String
        switch row.delivery {
        case .pending: delivery = "pending"
        case .serverAccepted: delivery = "server_accepted"
        case .rejected: delivery = "rejected"
        case .received: delivery = "received"
        }
        return ["id": row.direction.rawValue + ":" + row.clientMessageId,
                "clientMessageId": row.clientMessageId, "direction": row.direction.rawValue,
                "senderAccountId": outgoing ? captured.owner.context.userId : captured.peer.accountId,
                "recipientAccountId": outgoing ? captured.peer.accountId : captured.owner.context.userId,
                "senderName": outgoing ? "You" : "Paired sailor",
                "text": row.text.map { $0 as Any } ?? NSNull(),
                "localCreatedAtMillis": row.localCreatedAtMillis.map { $0 as Any } ?? NSNull(),
                "read": false, "delivery": delivery,
                "reason": row.reason.map { $0.rawValue as Any } ?? NSNull()]
    }
    private func threadValue(_ captured: Entry) throws -> [String: Any] {
        let value = try committedThread(captured)
        let pending = value.messages.first { $0.direction == .outgoing && $0.delivery == .pending }
        return ["peerAccountId": captured.peer.accountId,
                "messages": value.messages.map { messageValue($0, captured: captured) },
                "permissions": try permissionValue(captured), "unresolvedCount": value.unresolvedCount,
                "pendingAttemptId": pending.map { $0.clientMessageId as Any } ?? NSNull()]
    }
    private func inboxValue(_ captured: Entry) throws -> [[String: Any]] {
        let value = try committedThread(captured)
        // Native sealed insertion order only. The last row has no inferred
        // sender/relay time, and absence never becomes the time of this read.
        // Native history is grouped outgoing + incoming, not globally ordered.
        // Mixed lanes have no authoritative latest-activity fact. Never label
        // the last incoming as newer than an outgoing reply or invent a time.
        let mixed = value.messages.contains { $0.direction == .outgoing }
            && value.messages.contains { $0.direction == .incoming }
        let last = mixed ? nil : value.messages.last
        return [["peerAccountId": captured.peer.accountId, "displayName": "Paired sailor",
                 "lastText": last?.text.map { $0 as Any } ?? NSNull(),
                 "lastLocalCreatedAtMillis": last?.localCreatedAtMillis.map { $0 as Any } ?? NSNull(),
                 "unreadCount": 0, "historyAvailable": true]]
    }
    private func sentValue(_ captured: Entry, clientMessageId: String, text: String) throws -> [String: Any] {
        let rows = try committedThread(captured).messages.filter {
            $0.direction == .outgoing && $0.clientMessageId == clientMessageId
        }
        guard rows.count == 1, rows[0].text?.utf8.elementsEqual(text.utf8) == true,
              rows[0].delivery == .serverAccepted || rows[0].delivery == .rejected else { throw unavailable }
        return messageValue(rows[0], captured: captured)
    }
    private func reconciledValue(_ captured: Entry, clientMessageId: String) throws -> [String: Any] {
        let rows = try committedThread(captured).messages.filter {
            $0.direction == .outgoing && $0.clientMessageId == clientMessageId
        }
        guard rows.count == 1,
              rows[0].delivery == .serverAccepted || rows[0].delivery == .rejected else { throw unavailable }
        return messageValue(rows[0], captured: captured)
    }
    private func bounded(_ dto: [String: Any]) throws -> [String: Any] {
        guard JSONSerialization.isValidJSONObject(dto),
              try JSONSerialization.data(withJSONObject: dto).count <= 4 * 1024 * 1024 else { throw unavailable }
        return dto
    }
}
