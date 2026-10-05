// ISOLATED one-peer research bridge, NOT PrivateMessageNativePort. No native
// credential, context, record, wire, permit, key, pickle or store crosses to JS.
// Restart/logout quarantine is deliberate; this adapter never resumes/rebinds.
import Foundation

enum ResearchMessagingAdapterError: Error { case unavailable }

/// Native-only pending publication. The plugin must call publish immediately
/// before resolving its promise. This retains the ORIGINAL lease across await,
/// never fetches currentAccount or manufactures a replacement snapshot.
final class ResearchMessagingResult {
    private let publication: () throws -> [String: Any]
    fileprivate init(_ publication: @escaping () throws -> [String: Any]) { self.publication = publication }
    func publish() throws -> [String: Any] {
        do { return try publication() }
        catch { throw ResearchMessagingAdapterError.unavailable }
    }
}

final class ResearchMessagingAdapter {
    private let facade: VodozemacSessionFacade
    private let client: VodozemacScopedRelayClient
    private let projectOrigin: String
    private let conversationId: String
    private struct Paired {
        let owner: DmNativeMessageSnapshot
        let snapshot: DmNativeMessageSnapshot
        let state: DmNativePairingState
    }

    // Trusted native composition only. No constructor parameter is a JS option;
    // the app pins origin/conversation/mount, fixtures inject synthetic transport.
    init(facade: VodozemacSessionFacade, transport: VodozemacRelayTransport,
         projectOrigin: String, conversationId: String) {
        self.facade = facade
        self.client = VodozemacScopedRelayClient(facade: facade, transport: transport)
        self.projectOrigin = projectOrigin
        self.conversationId = conversationId
    }

    func messageState(credentialBinding: String) throws -> ResearchMessagingResult {
        try guarded { try messageStateImpl(credentialBinding: credentialBinding) }
    }
    func pairingCard(credentialBinding: String) throws -> ResearchMessagingResult {
        try guarded { try pairingCardImpl(credentialBinding: credentialBinding) }
    }
    func inspectPeerCard(credentialBinding: String, card: String) throws -> ResearchMessagingResult {
        try guarded { try inspectPeerCardImpl(credentialBinding: credentialBinding, card: card) }
    }
    func confirmPeer(credentialBinding: String, card: String, confirmedFingerprint: String) throws -> ResearchMessagingResult {
        try guarded { try confirmPeerImpl(credentialBinding: credentialBinding, card: card, confirmedFingerprint: confirmedFingerprint) }
    }
    func registerDevice(credentialBinding: String) async throws -> ResearchMessagingResult {
        try await guardedAsync { try await registerDeviceImpl(credentialBinding: credentialBinding) }
    }
    func claimPeer(credentialBinding: String) async throws -> ResearchMessagingResult {
        try await guardedAsync { try await claimPeerImpl(credentialBinding: credentialBinding) }
    }
    func refreshPolicy(credentialBinding: String) async throws -> ResearchMessagingResult {
        try await guardedAsync { try await refreshPolicyImpl(credentialBinding: credentialBinding) }
    }
    func thread(credentialBinding: String) throws -> ResearchMessagingResult {
        try guarded { try threadImpl(credentialBinding: credentialBinding) }
    }
    func prepareText(credentialBinding: String, clientMessageId: String, text: String) throws -> ResearchMessagingResult {
        try guarded { try prepareTextImpl(credentialBinding: credentialBinding, clientMessageId: clientMessageId, text: text) }
    }
    func sendPending(credentialBinding: String, clientMessageId: String) async throws -> ResearchMessagingResult {
        try await guardedAsync { try await sendPendingImpl(credentialBinding: credentialBinding, clientMessageId: clientMessageId) }
    }
    func syncInbox(credentialBinding: String) async throws -> ResearchMessagingResult {
        try await guardedAsync { try await syncInboxImpl(credentialBinding: credentialBinding) }
    }

    private func messageStateImpl(credentialBinding: String) throws -> ResearchMessagingResult {
        try stateResult(owner: owner(credentialBinding), binding: credentialBinding)
    }

    private func pairingCardImpl(credentialBinding: String) throws -> ResearchMessagingResult {
        let snapshot = try owner(credentialBinding)
        guard case .pairingCard(let card) = try facade.executeMessageOperation(snapshot: snapshot, operation: .pairingCard),
              card.projectOrigin == projectOrigin, card.conversationId == conversationId else { throw unavailable }
        return try result(snapshot: snapshot, binding: credentialBinding, status: "pairing_card", fields: [
            "card": try canonical(card), "fingerprint": try card.fingerprint()])
    }

    /// Inspection checks only public syntax/routing. It NEVER establishes trust,
    /// changes a pin, queries a server directory or confirms on the user's behalf.
    private func inspectPeerCardImpl(credentialBinding: String, card: String) throws -> ResearchMessagingResult {
        let snapshot = try owner(credentialBinding)
        let parsed = try peerCard(card, owner: snapshot)
        return try result(snapshot: snapshot, binding: credentialBinding, status: "peer_card", fields: [
            "card": try canonical(parsed), "fingerprint": try parsed.fingerprint()])
    }

    private func confirmPeerImpl(credentialBinding: String, card: String,
                     confirmedFingerprint: String) throws -> ResearchMessagingResult {
        let snapshot = try owner(credentialBinding)
        let parsed = try peerCard(card, owner: snapshot)
        guard confirmedFingerprint.utf8.count == 64,
              confirmedFingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              try parsed.fingerprint().utf8.elementsEqual(confirmedFingerprint.utf8),
              case .pairingState = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .confirmPeer(card: parsed, confirmedFingerprint: confirmedFingerprint)) else { throw unavailable }
        return try stateResult(owner: snapshot, binding: credentialBinding)
    }

    private func registerDeviceImpl(credentialBinding: String) async throws -> ResearchMessagingResult {
        let snapshot = try owner(credentialBinding)
        _ = try await client.registerDevice(snapshot: snapshot)
        return try stateResult(owner: snapshot, binding: credentialBinding)
    }

    private func claimPeerImpl(credentialBinding: String) async throws -> ResearchMessagingResult {
        let captured = try paired(credentialBinding)
        _ = try await client.claimPeer(snapshot: captured.snapshot)
        try requirePaired(captured)
        return try stateResult(owner: captured.owner, binding: credentialBinding, paired: captured)
    }

    /// Explicit only. Send/sync never call this, and failed refresh does not
    /// retain an old allow. Public flags are diagnostics, NOT a readiness token.
    private func refreshPolicyImpl(credentialBinding: String) async throws -> ResearchMessagingResult {
        let snapshot = try owner(credentialBinding)
        let peer = try pairing(snapshot)
        let flags = try await client.refreshPolicy(snapshot: snapshot)
        return try result(snapshot: snapshot, binding: credentialBinding, status: "policy",
            fields: ["policy": policy(flags)], additionalGuard: {
                try self.requirePairing(peer, snapshot: snapshot)
                guard case .policyState(let current) = try self.facade.executeMessageOperation(snapshot: snapshot,
                    operation: .relayPolicyState), current == flags else { throw self.unavailable }
            })
    }

    /// Local history needs current authenticated full-pair authority, but not a
    /// fresh relay allow. Device-local/absent times and unknown reads stay honest.
    private func threadImpl(credentialBinding: String) throws -> ResearchMessagingResult {
        let captured = try paired(credentialBinding)
        guard case .thread(let thread) = try facade.executeMessageOperation(snapshot: captured.snapshot,
            operation: .thread), thread.ownerGeneration == captured.snapshot.context.ownerGeneration,
              thread.peerGeneration == captured.snapshot.context.peerGeneration,
              thread.messages.count <= 32, thread.outgoingCapacity == 16, thread.incomingCapacity == 16,
              (0...16).contains(thread.unresolvedCount) else { throw unavailable }
        let messages: [[String: Any]] = try thread.messages.map { message in
            try DmContentCodec.validateIdentifier(message.clientMessageId)
            guard message.text.map({ $0.utf8.count <= DmContentCodec.maxTextBytes }) ?? true,
                  message.localCreatedAtMillis.map({ (0...DmRelayCodec.maxSafeInteger).contains($0) }) ?? true,
                  message.envelopeSha256.utf8.count == 64,
                  message.envelopeSha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw unavailable
            }
            return ["clientMessageId": message.clientMessageId, "direction": message.direction.rawValue,
                "text": message.text.map { $0 as Any } ?? NSNull(), "delivery": message.delivery.rawValue,
                "reason": message.reason.map { $0.rawValue as Any } ?? NSNull(),
                "localCreatedAtMillis": message.localCreatedAtMillis.map { $0 as Any } ?? NSNull(),
                "envelopeSha256": message.envelopeSha256]
        }
        return try result(snapshot: captured.snapshot, binding: credentialBinding, status: "thread", fields: [
            "messages": messages, "unresolvedCount": thread.unresolvedCount,
            "outgoingCapacity": thread.outgoingCapacity, "incomingCapacity": thread.incomingCapacity],
            additionalGuard: { try self.requirePaired(captured) })
    }

    private func prepareTextImpl(credentialBinding: String, clientMessageId: String,
                     text: String) throws -> ResearchMessagingResult {
        try messageID(clientMessageId)
        guard text.utf8.count <= DmContentCodec.maxTextBytes,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw unavailable }
        let captured = try paired(credentialBinding)
        guard case .outbox = try facade.executeMessageOperation(snapshot: captured.snapshot,
            operation: .prepareText(clientMessageId: clientMessageId, text: text)) else { throw unavailable }
        // Do not return the native outbox or fabricate a text/history row from
        // caller input. An exact retry remains the same durable encrypted record.
        return try result(snapshot: captured.snapshot, binding: credentialBinding, status: "prepared",
            fields: ["clientMessageId": clientMessageId], additionalGuard: { try self.requirePaired(captured) })
    }

    private func sendPendingImpl(credentialBinding: String, clientMessageId: String) async throws -> ResearchMessagingResult {
        try messageID(clientMessageId)
        let captured = try paired(credentialBinding)
        // Original owner capability is captured BEFORE await. Only a strict
        // native terminal rejection may publish without the old peer/policy gate.
        let originalOwner = try facade.ownerOnlyCompletionSnapshot(from: captured.snapshot)
        let receipt = try await client.sendPending(clientMessageId: clientMessageId, snapshot: captured.snapshot)
        let record: DmOutboxRecord
        let decision: String
        let reason: Any
        let publication: DmNativeMessageSnapshot
        let guardPeer: (() throws -> Void)?
        switch receipt {
        case .accepted(let accepted):
            record = accepted; decision = "server_accepted"; reason = NSNull()
            publication = captured.snapshot; guardPeer = { try self.requirePaired(captured) }
        case .rejected(let rejected, let rejectedReason):
            record = rejected; decision = "rejected"; reason = rejectedReason.rawValue
            publication = originalOwner; guardPeer = nil
        }
        // Native-only reconciliation sanity; never serialize record/envelope.
        guard try DmEnvelope.decode(record.serializedEnvelope).clientMessageId == clientMessageId,
              record.ownerUserId == originalOwner.context.userId,
              record.ownerSessionGeneration == originalOwner.context.ownerGeneration else { throw unavailable }
        return try result(snapshot: publication, binding: credentialBinding, status: "send_result", fields: [
            "clientMessageId": clientMessageId, "decision": decision, "reason": reason], additionalGuard: guardPeer)
    }

    private func syncInboxImpl(credentialBinding: String) async throws -> ResearchMessagingResult {
        let captured = try paired(credentialBinding)
        let report = try await client.syncInbox(snapshot: captured.snapshot)
        for count in [report.stored, report.duplicates, report.historical, report.unresolved, report.historicalUnresolved] {
            guard (0...32).contains(count) else { throw unavailable }
        }
        return try result(snapshot: captured.snapshot, binding: credentialBinding, status: "inbox_result", fields: [
            "stored": report.stored, "duplicates": report.duplicates, "historical": report.historical,
            "unresolved": report.unresolved, "historicalUnresolved": report.historicalUnresolved],
            additionalGuard: { try self.requirePaired(captured) })
    }

    private var unavailable: ResearchMessagingAdapterError { .unavailable }
    private func guarded(_ operation: () throws -> ResearchMessagingResult) throws -> ResearchMessagingResult {
        do { return try operation() } catch { throw unavailable }
    }
    private func guardedAsync(_ operation: () async throws -> ResearchMessagingResult) async throws -> ResearchMessagingResult {
        do { return try await operation() } catch { throw unavailable }
    }
    private func owner(_ binding: String) throws -> DmNativeMessageSnapshot {
        guard binding.utf8.count == 36, UUID(uuidString: binding)?.uuidString.lowercased() == binding else { throw unavailable }
        let snapshot = try facade.messageSnapshot(credentialBinding: binding)
        guard snapshot.context.peerGeneration == nil else { throw unavailable }
        try requireCurrent(snapshot)
        return snapshot
    }
    private func paired(_ binding: String) throws -> Paired {
        let original = try owner(binding)
        let state = try pairing(original)
        guard state.status == .confirmed, let generation = state.peerGeneration,
              state.confirmedFingerprint != nil else { throw unavailable }
        let snapshot = try facade.messageSnapshot(credentialBinding: binding, peerGeneration: generation)
        let expected = DmRelayNetworkContext(userId: original.context.userId, deviceId: original.context.deviceId,
            ownerGeneration: original.context.ownerGeneration, credentialEpoch: original.context.credentialEpoch,
            peerGeneration: generation)
        guard snapshot.context == expected else { throw unavailable }
        let capture = Paired(owner: original, snapshot: snapshot, state: state)
        try requirePaired(capture)
        return capture
    }
    private func requireCurrent(_ snapshot: DmNativeMessageSnapshot) throws {
        guard !Task.isCancelled, facade.currentMessageContext(snapshot: snapshot) == snapshot.context else { throw unavailable }
    }
    private func pairing(_ snapshot: DmNativeMessageSnapshot) throws -> DmNativePairingState {
        guard case .pairingState(let state) = try facade.executeMessageOperation(snapshot: snapshot,
            operation: .pairingState) else { throw unavailable }
        return state
    }
    private func requirePairing(_ expected: DmNativePairingState, snapshot: DmNativeMessageSnapshot) throws {
        try requireCurrent(snapshot)
        let current = try pairing(snapshot)
        guard current.status == expected.status, current.peerGeneration == expected.peerGeneration,
              current.confirmedFingerprint == expected.confirmedFingerprint else { throw unavailable }
        try requireCurrent(snapshot)
    }
    private func requirePaired(_ captured: Paired) throws {
        try requireCurrent(captured.owner)
        try requireCurrent(captured.snapshot)
        try requirePairing(captured.state, snapshot: captured.snapshot)
    }
    private func peerCard(_ wire: String, owner snapshot: DmNativeMessageSnapshot) throws -> DmPairingCard {
        guard (1...4096).contains(wire.utf8.count) else { throw unavailable }
        let card = try JSONDecoder().decode(DmPairingCard.self, from: Data(wire.utf8))
        // Decoder alone ignores extra keys/collapses duplicate keys. Exact
        // re-encoding rejects both, escaped aliases, whitespace and key order.
        guard try canonical(card).utf8.elementsEqual(wire.utf8), card.projectOrigin == projectOrigin,
              card.conversationId == conversationId, card.identity.userId != snapshot.context.userId,
              card.identity.deviceId != snapshot.context.deviceId else { throw unavailable }
        _ = try card.fingerprint()
        try requireCurrent(snapshot)
        return card
    }
    private func canonical(_ card: DmPairingCard) throws -> String {
        _ = try card.fingerprint()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(card)
        guard data.count <= 4096, let value = String(data: data, encoding: .utf8) else { throw unavailable }
        return value
    }
    private func messageID(_ id: String) throws {
        guard id.utf8.count == 36, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw unavailable }
    }
    private func policy(_ flags: DmNativeRelayPolicyState) -> [String: Any] {
        ["ownerRevoked": flags.ownerRevoked, "peerRevoked": flags.peerRevoked,
         "blockedByMe": flags.blockedByMe, "blockedByPeer": flags.blockedByPeer]
    }
    private func stateResult(owner snapshot: DmNativeMessageSnapshot, binding: String,
                             paired: Paired? = nil) throws -> ResearchMessagingResult {
        try requireCurrent(snapshot)
        if let paired { try requirePaired(paired) }
        return ResearchMessagingResult {
            try self.requireCurrent(snapshot)
            if let paired { try self.requirePaired(paired) }
            let state = try self.pairing(snapshot)
            guard case .enrollmentState(let enrollment) = try self.facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayEnrollmentState) else { throw self.unavailable }
            let flags: Any
            if let result = try? self.facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayPolicyState), case .policyState(let current) = result { flags = self.policy(current) }
            else { flags = NSNull() }
            let registration: String
            switch enrollment.registration { case .none: registration = "none"; case .pending: registration = "pending";
                case .acknowledged: registration = "acknowledged" }
            let claim: String
            switch enrollment.claim { case .none: claim = "none"; case .pending: claim = "pending";
                case .verified: claim = "verified"; case .expired: claim = "expired"; case .historical: claim = "historical" }
            try self.requirePairing(state, snapshot: snapshot)
            return try self.bounded(["status": "state", "credentialBinding": binding, "pairing": state.status.rawValue,
                "role": state.sessionRole.rawValue, "fingerprint": state.confirmedFingerprint.map { $0 as Any } ?? NSNull(),
                "registration": registration, "claim": claim, "policy": flags])
        }
    }
    private func result(snapshot: DmNativeMessageSnapshot, binding: String, status: String, fields: [String: Any],
                        additionalGuard: (() throws -> Void)? = nil) throws -> ResearchMessagingResult {
        var value = fields; value["status"] = status; value["credentialBinding"] = binding
        let dto = try bounded(value)
        try requireCurrent(snapshot)
        try additionalGuard?()
        return ResearchMessagingResult {
            try self.requireCurrent(snapshot)
            try additionalGuard?()
            try self.requireCurrent(snapshot)
            return dto
        }
    }
    private func bounded(_ dto: [String: Any]) throws -> [String: Any] {
        guard JSONSerialization.isValidJSONObject(dto),
              try JSONSerialization.data(withJSONObject: dto).count <= 4 * 1024 * 1024 else { throw unavailable }
        return dto
    }
}
