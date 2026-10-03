// ISOLATED NATIVE RESEARCH send/receive wrapper, not a complete private-message
// port or evidence of a hosted/two-device exchange. Native Directory/Auth/peer
// authority owns preparation and every sealed result commit. This wrapper never
// receives a coordinator, owner claim, clock, pin, key or store locator.
import Foundation

final class VodozemacScopedRelayClient {
    private let facade: VodozemacSessionFacade
    private let transport: VodozemacRelayTransport

    init(facade: VodozemacSessionFacade, transport: VodozemacRelayTransport) {
        self.facade = facade
        self.transport = transport
    }

    /// Register the existing immutable native device, or return its already
    /// acknowledged enrollment state without HTTP. The native dispatcher
    /// requires owner-only network context and owns exact durable bundle replay;
    /// uncertainty never authorizes replacing keys/prekeys or automatic retry.
    func registerDevice(snapshot: DmNativeMessageSnapshot) async throws -> DmNativeRelayEnrollmentState {
        do {
            try requireCurrent(snapshot)
            let prepared = try facade.executeMessageOperation(snapshot: snapshot, operation: .relayRegistrationWire)
            let state: DmNativeRelayEnrollmentState
            switch prepared {
            case .enrollmentState(let cached):
                state = cached
            case .registrationRequest(let wire):
                try requireCurrent(snapshot)
                // Closed preparation has returned and released all authority
                // locks. Transport checks the ORIGINAL native snapshot at
                // dispatch/completion, not an independently refreshed lease.
                let response = try await transport.register(bundle: wire, credential: snapshot.credential,
                    currentContext: { self.facade.currentMessageContext(snapshot: snapshot) })
                try requireCurrent(snapshot)
                guard case .enrollmentState(let committed) = try facade.executeMessageOperation(snapshot: snapshot,
                    operation: .relayRegistrationResponse(wire: wire, response: response)) else {
                    throw DmRelayTransportError.unresolved
                }
                state = committed
            default:
                throw DmRelayTransportError.unresolved
            }
            try requireCurrent(snapshot)
            return state
        } catch { throw DmRelayTransportError.unresolved }
    }

    /// Claim the explicitly confirmed peer only when native enrollment, full
    /// OOB identity pin and lower-device initiation policy permit it. The opaque
    /// native request retains stable claim metadata across this ONE await; no
    /// JS peer/clock/role input, snapshot renewal or automatic retry is accepted.
    func claimPeer(snapshot: DmNativeMessageSnapshot) async throws -> DmNativeRelayEnrollmentState {
        do {
            try requireCurrent(snapshot)
            let prepared = try facade.executeMessageOperation(snapshot: snapshot, operation: .relayClaimWire)
            let state: DmNativeRelayEnrollmentState
            switch prepared {
            case .enrollmentState(let cached):
                state = cached
            case .claimRequest(let request):
                try requireCurrent(snapshot)
                // No authority lock crosses the network await. Completion gets
                // the same entire native request and ORIGINAL snapshot so it
                // cannot rebind stale/historical results to a new lease/pin.
                let response = try await transport.dispatch(request: request.wire, credential: snapshot.credential,
                    currentContext: { self.facade.currentMessageContext(snapshot: snapshot) })
                try requireCurrent(snapshot)
                guard case .enrollmentState(let committed) = try facade.executeMessageOperation(snapshot: snapshot,
                    operation: .relayClaimResponse(request: request, response: response)) else {
                    throw DmRelayTransportError.unresolved
                }
                state = committed
            default:
                throw DmRelayTransportError.unresolved
            }
            try requireCurrent(snapshot)
            return state
        } catch { throw DmRelayTransportError.unresolved }
    }

    /// Explicit current-policy refresh using an ORIGINAL owner-only snapshot.
    /// The closed wire operation invalidates the old permit before signing, so
    /// a failed/held refresh never leaves a previous allow usable. No message
    /// operation calls this automatically, and no result establishes peer trust.
    func refreshPolicy(snapshot: DmNativeMessageSnapshot) async throws -> DmNativeRelayPolicyState {
        do {
            try requireCurrent(snapshot)
            guard snapshot.context.peerGeneration == nil,
                  case .policyRequest(let request) = try facade.executeMessageOperation(snapshot: snapshot,
                    operation: .relayPolicyWire), request.context == snapshot.context else {
                throw DmRelayTransportError.unresolved
            }
            try requireCurrent(snapshot)
            let response = try await transport.dispatch(request: request.wire, credential: snapshot.credential,
                currentContext: { self.facade.currentMessageContext(snapshot: snapshot) })
            try requireCurrent(snapshot)
            guard case .policyState(let state) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayPolicyResponse(request: request, response: response)) else {
                throw DmRelayTransportError.unresolved
            }
            try requireCurrent(snapshot)
            return state
        } catch { throw DmRelayTransportError.unresolved }
    }

    /// Dispatch ONE durable native outbox record. An already-terminal exact ID
    /// is reconciled locally without sending anything. An uncertain response
    /// remains unresolved; no automatic retry, replacement encryption or new
    /// snapshot is manufactured here. Relay acceptance is not delivery/read.
    func sendPending(clientMessageId: String, snapshot: DmNativeMessageSnapshot) async throws -> DmRelayReceipt {
        do {
            try requireCurrent(snapshot)
            let prepared = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relaySendWire(clientMessageId: clientMessageId))
            switch prepared {
            case .relayReceipt(let terminal):
                // Native dispatcher verified the exact existing terminal ID.
                // No transport call, registration, claim or automatic retry.
                try requireCurrent(snapshot)
                return terminal
            case .sendRequest(let request):
                try requirePolicy(request.policy, snapshot: snapshot)
                // Capture the rejection lane BEFORE await from the same exact
                // accepted lease. It cannot renew its credential epoch/deadline
                // or authorize acceptance after a peer/policy transition.
                let owner = try facade.ownerOnlyCompletionSnapshot(from: snapshot)
                try requireCurrent(owner)
                // All authority locks have returned. Actual dispatch still
                // requires the original paired context and policy; response
                // completion needs the ORIGINAL owner-only Auth lease so that
                // an authenticated terminal refusal is not stranded by block.
                let response = try await transport.dispatch(request: request.wire, credential: owner.credential,
                    dispatchContext: {
                        try self.requirePolicy(request.policy, snapshot: snapshot)
                        try self.requireCurrent(owner)
                        return owner.context
                    }, completionContext: {
                        try self.requireCurrent(owner)
                        return owner.context
                    })
                try requireCurrent(owner)
                do {
                    try requirePolicy(request.policy, snapshot: snapshot)
                    guard case .relayReceipt(let receipt) = try facade.executeMessageOperation(snapshot: snapshot,
                        operation: .relaySendReceipt(request: request, response: response)) else {
                        throw DmRelayTransportError.unresolved
                    }
                    // A valid earlier commit is not undone if this final view
                    // publication guard refuses after a later policy change.
                    try requirePolicy(request.policy, snapshot: snapshot)
                    return receipt
                } catch {
                    // This narrow closed operation parses AGAIN and accepts
                    // ONLY an exact rejected receipt for the saved outbox. An
                    // accepted/malformed/unrelated response cannot use fallback.
                    // No replacement snapshot or policy refresh is performed.
                    try requireCurrent(owner)
                    guard case .relayReceipt(let receipt) = try facade.executeMessageOperation(snapshot: owner,
                        operation: .relayRejectedReceipt(record: request.record, response: response)),
                          case .rejected = receipt else { throw DmRelayTransportError.unresolved }
                    try requireCurrent(owner)
                    return receipt
                }
            default:
                throw DmRelayTransportError.unresolved
            }
        } catch {
            // No provider/Auth/HTTP response, bearer, URL or raw error escapes.
            // Failure never becomes a fabricated acceptance/rejection receipt.
            throw DmRelayTransportError.unresolved
        }
    }

    /// Fetch ONE bounded native inbox batch and commit it through the original
    /// snapshot dispatcher. Unresolved/deferred items remain explicit native
    /// state; no polling loop, automatic retry or registration/claim is implied.
    func syncInbox(snapshot: DmNativeMessageSnapshot) async throws -> DmRelayInboxReport {
        do {
            try requireCurrent(snapshot)
            guard case .inboxRequest(let request) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayInboxWire) else { throw DmRelayTransportError.unresolved }
            try requirePolicy(request.policy, snapshot: snapshot)
            // The closed preparation call has released every authority lock.
            // Unlike negative send settlement, inbox dispatch AND completion
            // retain the original paired context and exact policy permit.
            let response = try await transport.dispatch(request: request.wire, credential: snapshot.credential,
                currentContext: {
                    try self.requirePolicy(request.policy, snapshot: snapshot)
                    return snapshot.context
                })
            try requirePolicy(request.policy, snapshot: snapshot)
            guard case .inboxReport(let report) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayInboxResponse(request: request, response: response)) else {
                throw DmRelayTransportError.unresolved
            }
            try requirePolicy(request.policy, snapshot: snapshot)
            return report
        } catch { throw DmRelayTransportError.unresolved }
    }

    private func requireCurrent(_ snapshot: DmNativeMessageSnapshot) throws {
        guard !Task.isCancelled, facade.currentMessageContext(snapshot: snapshot) == snapshot.context else {
            throw DmRelayTransportError.unresolved
        }
    }

    private func requirePolicy(_ permit: DmNativeRelayPolicyPermit, snapshot: DmNativeMessageSnapshot) throws {
        try requireCurrent(snapshot)
        guard permit.context == snapshot.context,
              case .policyState(let state) = try facade.executeMessageOperation(snapshot: snapshot,
                operation: .relayPolicyGuard(permit)),
              !state.ownerRevoked, !state.peerRevoked, !state.blockedByMe, !state.blockedByPeer else {
            throw DmRelayTransportError.unresolved
        }
        try requireCurrent(snapshot)
    }
}
