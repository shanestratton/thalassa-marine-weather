// ISOLATED RESEARCH. Connects native sealed state to the bounded HTTPS transport.
// No app plugin, real Auth lifecycle, automatic peer trust, or UI security badge.
// Response validation is meaningful only over the trusted configured transport;
// a parser alone never establishes server authenticity.
import Foundation

struct DmRelayInboxReport: Equatable {
    let stored: Int
    let duplicates: Int
    let historical: Int
    init(stored: Int, duplicates: Int, historical: Int = 0) {
        self.stored = stored; self.duplicates = duplicates; self.historical = historical
    }
}

final class VodozemacRelayClient {
    private let coordinator: VodozemacDmCoordinator
    private let transport: VodozemacRelayTransport
    private let nowSeconds: () -> Int64

    init(coordinator: VodozemacDmCoordinator, transport: VodozemacRelayTransport,
         nowSeconds: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        self.coordinator = coordinator
        self.transport = transport
        self.nowSeconds = nowSeconds
    }

    private func owner(_ credential: DmRelayNetworkCredential) -> DmOwnerContext {
        DmOwnerContext(userId: credential.context.userId, deviceId: credential.context.deviceId,
                       generation: credential.context.ownerGeneration)
    }

    private func check(_ credential: DmRelayNetworkCredential,
                       _ currentContext: () throws -> DmRelayNetworkContext?) throws {
        guard !Task.isCancelled, try currentContext() == credential.context else {
            throw DmRelayTransportError.unresolved
        }
        // Read native authority AFTER the external reader. A slow/reentrant
        // callback cannot rotate the epoch and then return a captured old value.
        try coordinator.validateRelayContextForResearch(owner: owner(credential), credentialEpoch: credential.context.credentialEpoch,
                                                        peerGeneration: credential.context.peerGeneration)
    }

    // The transport rechecks durable native lifecycle at actual dispatch and
    // completion. A caller returning its captured old context cannot override
    // a persisted sign-out, token renewal, or peer status change.
    private func guardedContext(_ credential: DmRelayNetworkCredential,
                                _ currentContext: @escaping () throws -> DmRelayNetworkContext?) -> () throws -> DmRelayNetworkContext? {
        { try self.check(credential, currentContext); return credential.context }
    }

    func registerForResearch(prekeyId: String, expiresAt: Int64, now: Int64,
                             credential: DmRelayNetworkCredential,
                             currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws {
        try check(credential, currentContext)
        let own = owner(credential)
        let identity = try coordinator.publicIdentity(owner: own)
        let wire = try coordinator.signedBundleForResearch(prekeyId: prekeyId, expiresAt: expiresAt,
                                                          now: now, owner: own, credentialEpoch: credential.context.credentialEpoch)
        let data = try await transport.register(bundle: wire, credential: credential, currentContext: guardedContext(credential, currentContext))
        try check(credential, currentContext)
        try DmRelayResultCodec.registration(data, expected: identity)
        _ = try coordinator.publicIdentity(owner: own) // Re-read durable owner after the await.
        try check(credential, currentContext)
    }

    // The full public signing-key pin is an explicit out-of-band research
    // fixture. A self-signed directory bundle must NEVER silently become trust.
    func claimForResearch(pinned: DmPublicIdentity, requestId: String, expiresAt: Int64, now: Int64,
                          credential: DmRelayNetworkCredential,
                          currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> DmRelayBundle {
        let started = ContinuousClock.now
        try check(credential, currentContext)
        let own = owner(credential)
        guard let generation = credential.context.peerGeneration else { throw DmCoordinatorError.invalidInput }
        let peer = try coordinator.peerForResearch(owner: own, generation: generation)
        guard peer.userId == pinned.userId, peer.deviceId == pinned.deviceId,
              peer.identityKeyId == pinned.identityKeyId, peer.curve == pinned.curve,
              peer.prekey == pinned.prekey else { throw DmCoordinatorError.conflict }
        let wire = try coordinator.signedClaimForResearch(requestId: requestId, expiresAt: expiresAt,
                                                         now: now, owner: own, peerGeneration: generation, credentialEpoch: credential.context.credentialEpoch)
        let data = try await transport.dispatch(request: wire, credential: credential, currentContext: guardedContext(credential, currentContext))
        try check(credential, currentContext)
        // A near-expiry key may expire while its response is in flight. Neither
        // the captured caller time nor a wall-clock rollback extends its life.
        let elapsed = started.duration(to: .now).components
        let seconds = elapsed.seconds + (elapsed.attoseconds > 0 ? 1 : 0)
        guard seconds >= 0, now <= DmRelayCodec.maxSafeInteger - seconds else { throw DmCoordinatorError.invalidInput }
        let bundle = try DmRelayResultCodec.claim(data, pinned: pinned, now: max(now + seconds, nowSeconds()))
        _ = try coordinator.peerForResearch(owner: own, generation: generation)
        try check(credential, currentContext)
        return bundle
    }

    // Reconciliation always signs the SAME durable record. A new request nonce
    // is allowed after expiry/restart, but never a new encryption/message ID.
    // A response lost after server COMMIT leaves native outbox pending.
    func sendForResearch(_ record: DmOutboxRecord, requestId: String, expiresAt: Int64, now: Int64,
                         credential: DmRelayNetworkCredential,
                         currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> DmRelayReceipt {
        try check(credential, currentContext)
        let own = owner(credential)
        guard let generation = credential.context.peerGeneration else { throw DmCoordinatorError.invalidInput }
        let wire = try coordinator.signedSendForResearch(record, requestId: requestId, expiresAt: expiresAt,
                                                        now: now, owner: own, peerGeneration: generation, credentialEpoch: credential.context.credentialEpoch)
        let data = try await transport.dispatch(request: wire, credential: credential, currentContext: guardedContext(credential, currentContext))
        try check(credential, currentContext)
        let receipt = try DmRelayResultCodec.receipt(data, expected: record)
        try check(credential, currentContext)
        switch receipt {
        case .accepted:
            try coordinator.confirmAcceptance(record, owner: own, peerGeneration: generation, credentialEpoch: credential.context.credentialEpoch)
        case .rejected(_, let reason):
            try coordinator.confirmRejection(record, reason: reason, owner: own, credentialEpoch: credential.context.credentialEpoch)
        }
        // Do not publish a completion into a replaced account/credential context.
        // If it changes here, the already committed local decision stays valid.
        try check(credential, currentContext)
        return receipt
    }

    // Bounded single-peer research store: re-scan from zero, deliberately no
    // advancing cursor. This revisits messages hidden by a temporary block and
    // survives restart/partial batch failure. Exact saved rows from an older
    // owner/peer generation are explicitly counted as historical, without
    // restoring plaintext or rebinding history. Device/key identity is immutable
    // in this research store. Unseen rows still need guarded native decryption.
    // Canonical but undecryptable ciphertext also stalls the bounded rescan.
    // Duplicate handling is native and
    // durable. A scalable sealed per-owner sync cursor remains future work.
    // Only counts leave this adapter; plaintext stays in guarded native history.
    func syncInboxForResearch(requestId: String, expiresAt: Int64, now: Int64,
                             credential: DmRelayNetworkCredential,
                             currentContext: @escaping () throws -> DmRelayNetworkContext?) async throws -> DmRelayInboxReport {
        try check(credential, currentContext)
        let own = owner(credential)
        guard let generation = credential.context.peerGeneration else { throw DmCoordinatorError.invalidInput }
        let identity = try coordinator.publicIdentity(owner: own)
        let peer = try coordinator.peerForResearch(owner: own, generation: generation)
        let wire = try coordinator.signedListForResearch(requestId: requestId, afterId: 0, batch: 16,
                                                        expiresAt: expiresAt, now: now, owner: own, credentialEpoch: credential.context.credentialEpoch)
        let data = try await transport.dispatch(request: wire, credential: credential, currentContext: guardedContext(credential, currentContext))
        try check(credential, currentContext)
        // Validate the COMPLETE batch before any ratchet/inbox mutation.
        let rows = try DmRelayResultCodec.inbox(data, owner: own, identity: identity, peer: peer, afterId: 0, batch: 16)
        var stored = 0, duplicates = 0, historical = 0
        for row in rows {
            try check(credential, currentContext)
            switch try coordinator.knownInboundForResearch(row.record.serializedEnvelope, owner: own, peerGeneration: generation,
                                                           credentialEpoch: credential.context.credentialEpoch) {
            case .current: duplicates += 1; continue
            case .historical: historical += 1; continue
            case .unknown: break
            }
            switch try coordinator.receive(row.record.serializedEnvelope, owner: own, peerGeneration: generation,
                                            credentialEpoch: credential.context.credentialEpoch) {
            case .stored: stored += 1
            case .duplicate: duplicates += 1
            }
        }
        _ = try coordinator.peerForResearch(owner: own, generation: generation)
        try check(credential, currentContext)
        return DmRelayInboxReport(stored: stored, duplicates: duplicates, historical: historical)
    }
}
