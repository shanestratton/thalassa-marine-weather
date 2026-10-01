// ISOLATED SYNTHETIC RESEARCH ONLY. Real provider crypto, scoped Keychain and
// sealed SQLite state; fixture lifecycle assertions are not Supabase Auth,
// physical-device evidence, HTTP delivery, or an independent security audit.
import Foundation

private enum DmLifecycleProbeError: Error { case assertion(String) }

private final class DmLifecycleChecks {
    private(set) var assertions = 0

    func require(_ value: Bool, _ label: String) throws {
        guard value else { throw DmLifecycleProbeError.assertion(label) }
        assertions += 1
    }

    func refuse(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.unavailable { try require(true, label); return }
        // An unrelated storage/crypto failure cannot satisfy a lifecycle test.
        throw DmLifecycleProbeError.assertion(label)
    }

    func conflict(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmCoordinatorError.conflict { try require(true, label); return }
        throw DmLifecycleProbeError.assertion(label)
    }

    func framing(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch DmFrameError.invalidInput { try require(true, label); return }
        throw DmLifecycleProbeError.assertion(label)
    }

    func staleCommit(_ label: String, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch VodozemacSealedStoreError.staleRevision { try require(true, label); return }
        throw DmLifecycleProbeError.assertion(label)
    }
}

private func lifecycleProbeIdentityMatches(_ a: DmPublicIdentity, _ b: DmPublicIdentity) -> Bool {
    zip([a.userId, a.deviceId, a.identityKeyId, a.signingKey, a.curve, a.prekey],
        [b.userId, b.deviceId, b.identityKeyId, b.signingKey, b.curve, b.prekey])
        .allSatisfy { $0.0.utf8.elementsEqual($0.1.utf8) }
}

private func lifecycleProbeStored(_ result: DmReceiveResult, text: String, id: String,
                                  owner: DmOwnerContext, peerGeneration: Int64,
                                  checks: DmLifecycleChecks) throws {
    guard case .stored(let value) = result else { throw DmLifecycleProbeError.assertion("fresh receive stored") }
    try checks.require(value.clientMessageId == id && value.text == text
        && value.ownerGeneration == owner.generation && value.peerGeneration == peerGeneration,
        "fresh authenticated receive belongs only to the current lifecycle")
}

private func lifecycleProbeGenerationLimit(parent: URL, checks: DmLifecycleChecks) throws {
    let id = UUID(), maximum: Int64 = 9_007_199_254_740_991
    let directory = parent.appendingPathComponent(id.uuidString, isDirectory: true)
    let store = try VodozemacSealedStore.create(directory: directory, storeID: id, initialPayload: Data("{}".utf8))
    var cleaned = false
    defer { if !cleaned { try? store.destroyForTesting() } }
    let owner = DmOwnerContext(userId: "lifecycle-max", deviceId: "lifecycle-max-device", generation: maximum)
    let coordinator = try VodozemacDmCoordinator.bootstrapForResearch(store: store, owner: owner,
        identityKeyId: "lifecycle-max-identity", conversationId: "lifecycle-max-conversation")
    let initial = try coordinator.lifecycleForResearch()
    let renewed = try coordinator.rotateCredentialEpochForResearch(owner: owner)
    let renewedSnapshot = try store.read()
    try checks.refuse("unpublished bundle signing rejects a stale epoch before any other boundary") {
        _ = try coordinator.signedBundleForResearch(prekeyId: "lifecycle-max-prekey", expiresAt: 1_800_003_600,
            now: 1_800_000_000, owner: owner, credentialEpoch: initial.credentialEpoch)
    }
    try checks.require(try store.read() == renewedSnapshot, "stale bundle epoch cannot commit or publish a signature")
    let bundle = try coordinator.signedBundleForResearch(prekeyId: "lifecycle-max-prekey", expiresAt: 1_800_003_600,
        now: 1_800_000_000, owner: owner, credentialEpoch: renewed.credentialEpoch)
    try checks.require(try DmRelayCodec.verifyBundle(bundle, now: 1_800_000_000).userId == owner.userId,
        "the same unpublished account can sign under its current epoch")
    let signedOut = try coordinator.signOutForResearch(owner: owner)
    try checks.require(!signedOut.active && signedOut.owner == owner
        && signedOut.credentialEpoch != renewed.credentialEpoch,
        "exhausted generation still signs out and invalidates captured credentials")
    let offSnapshot = try store.read()
    try checks.refuse("maximum-generation signed-out scope cannot silently resume") {
        _ = try coordinator.resumeOwnerForResearch(signedOut: owner,
            authenticatedUserId: owner.userId, authenticatedDeviceId: owner.deviceId)
    }
    try checks.refuse("maximum-generation sign-out leaves ordinary identity access unavailable") {
        _ = try coordinator.publicIdentity(owner: owner)
    }
    try checks.require(try store.read() == offSnapshot, "maximum counter refusals retain the final inactive snapshot")
    store.close()
    let reopened = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    defer { reopened.close() }
    let restored = try VodozemacDmCoordinator(store: reopened).lifecycleForResearch()
    try checks.require(!restored.active && restored.owner == owner
        && restored.credentialEpoch == signedOut.credentialEpoch,
        "maximum-generation inactive state survives authenticated reopen")
    try reopened.destroyForTesting()
    cleaned = true
    try checks.require(!FileManager.default.fileExists(atPath: directory.path),
        "maximum-generation fixture store removed in its exact namespace")
}

/// Called only by a disposable native research simulator phase. No secret,
/// snapshot, fixture text, or credential leaves this function; only a count.
func runLifecycleProbeForResearch() throws -> Int {
    let checks = DmLifecycleChecks()
    let parent = FileManager.default.temporaryDirectory
    let aliceID = UUID(), bobID = UUID()
    let aliceDirectory = parent.appendingPathComponent(aliceID.uuidString, isDirectory: true)
    let bobDirectory = parent.appendingPathComponent(bobID.uuidString, isDirectory: true)
    let aliceStore = try VodozemacSealedStore.create(directory: aliceDirectory, storeID: aliceID,
        initialPayload: Data("{}".utf8))
    var bobStore: VodozemacSealedStore?
    var reopenedHandles: [VodozemacSealedStore] = []
    var cleaned = false
    defer {
        if !cleaned {
            for handle in reopenedHandles { handle.close() }
            try? bobStore?.destroyForTesting()
            try? aliceStore.destroyForTesting()
        }
    }
    let initialBobStore = try VodozemacSealedStore.create(directory: bobDirectory, storeID: bobID,
        initialPayload: Data("{}".utf8))
    bobStore = initialBobStore
    let aliceOwner = DmOwnerContext(userId: "lifecycle-alice", deviceId: "lifecycle-alice-device", generation: 11)
    let initialBobOwner = DmOwnerContext(userId: "lifecycle-bob", deviceId: "lifecycle-bob-device", generation: 21)
    let initialPeerGeneration: Int64 = 7
    let alice = try VodozemacDmCoordinator.bootstrapForResearch(store: aliceStore, owner: aliceOwner,
        identityKeyId: "lifecycle-alice-identity", conversationId: "lifecycle-conversation")
    var bob = try VodozemacDmCoordinator.bootstrapForResearch(store: initialBobStore, owner: initialBobOwner,
        identityKeyId: "lifecycle-bob-identity", conversationId: "lifecycle-conversation")
    let aliceIdentity = try alice.publicIdentity(owner: aliceOwner)
    let bobIdentity = try bob.publicIdentity(owner: initialBobOwner)
    try alice.installPeerForResearch(DmPeerContext(userId: bobIdentity.userId, deviceId: bobIdentity.deviceId,
        identityKeyId: bobIdentity.identityKeyId, curve: bobIdentity.curve, prekey: bobIdentity.prekey,
        generation: initialPeerGeneration, status: .accepted), owner: aliceOwner)
    try bob.installPeerForResearch(DmPeerContext(userId: aliceIdentity.userId, deviceId: aliceIdentity.deviceId,
        identityKeyId: aliceIdentity.identityKeyId, curve: aliceIdentity.curve, prekey: aliceIdentity.prekey,
        generation: initialPeerGeneration, status: .accepted), owner: initialBobOwner)
    let initialLifecycle = try bob.lifecycleForResearch()
    try checks.require(initialLifecycle.active && initialLifecycle.owner == initialBobOwner,
        "bootstrap creates an active fixture lifecycle")

    let oldInbound = try alice.prepare(clientMessageId: "lifecycle-old-inbound", text: "old inbound",
        owner: aliceOwner, peerGeneration: initialPeerGeneration)
    try lifecycleProbeStored(bob.receive(oldInbound.serializedEnvelope, owner: initialBobOwner,
        peerGeneration: initialPeerGeneration), text: "old inbound", id: "lifecycle-old-inbound",
        owner: initialBobOwner, peerGeneration: initialPeerGeneration, checks: checks)
    let oldPending = try bob.prepare(clientMessageId: "lifecycle-old-pending", text: "old pending",
        owner: initialBobOwner, peerGeneration: initialPeerGeneration)
    let beforeKnown = try initialBobStore.read()
    guard case .current = try bob.knownInboundForResearch(oldInbound.serializedEnvelope,
        owner: initialBobOwner, peerGeneration: initialPeerGeneration) else {
        throw DmLifecycleProbeError.assertion("current known envelope classification")
    }
    try checks.require(try initialBobStore.read() == beforeKnown, "known classification is strictly read-only")

    // Sign-out fences every ordinary operation, and is durable across reopen.
    let signedOut = try bob.signOutForResearch(owner: initialBobOwner)
    try checks.require(!signedOut.active && signedOut.owner.userId == initialBobOwner.userId
        && signedOut.owner.deviceId == initialBobOwner.deviceId
        && signedOut.owner.generation == initialBobOwner.generation + 1
        && signedOut.credentialEpoch != initialLifecycle.credentialEpoch,
        "sign-out advances generation and epoch without identity rebinding")
    let signedOutSnapshot = try initialBobStore.read()
    try checks.refuse("signed-out identity unavailable") { _ = try bob.publicIdentity(owner: signedOut.owner) }
    try checks.refuse("signed-out history unavailable") {
        _ = try bob.history(owner: signedOut.owner, peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("signed-out pending unavailable") {
        _ = try bob.pending(owner: signedOut.owner, peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("signed-out known row cannot bypass owner authority") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: signedOut.owner,
            peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("signed-out receive cannot disclose plaintext") {
        _ = try bob.receive(oldInbound.serializedEnvelope, owner: signedOut.owner,
            peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("signed-out credential rotation refused") {
        _ = try bob.rotateCredentialEpochForResearch(owner: signedOut.owner)
    }
    try checks.refuse("stale active owner cannot sign out twice") { _ = try bob.signOutForResearch(owner: initialBobOwner) }
    try checks.refuse("resume refuses a different authenticated account") {
        _ = try bob.resumeOwnerForResearch(signedOut: signedOut.owner,
            authenticatedUserId: "lifecycle-mallory", authenticatedDeviceId: signedOut.owner.deviceId)
    }
    try checks.refuse("resume refuses a different authenticated device") {
        _ = try bob.resumeOwnerForResearch(signedOut: signedOut.owner,
            authenticatedUserId: signedOut.owner.userId, authenticatedDeviceId: "lifecycle-other-device")
    }
    try checks.refuse("resume refuses a stale signed-out generation") {
        _ = try bob.resumeOwnerForResearch(signedOut: initialBobOwner,
            authenticatedUserId: initialBobOwner.userId, authenticatedDeviceId: initialBobOwner.deviceId)
    }
    try checks.require(try initialBobStore.read() == signedOutSnapshot,
        "all signed-out refusals preserve the complete sealed snapshot")
    initialBobStore.close()
    let resumedHandle = try VodozemacSealedStore.reopen(directory: bobDirectory, storeID: bobID)
    reopenedHandles.append(resumedHandle)
    bobStore = resumedHandle
    bob = try VodozemacDmCoordinator(store: resumedHandle)
    let reopenedOff = try bob.lifecycleForResearch()
    try checks.require(!reopenedOff.active && reopenedOff.owner == signedOut.owner
        && reopenedOff.credentialEpoch == signedOut.credentialEpoch,
        "authenticated reopen retains signed-out state and exact credential epoch")

    let resumed = try bob.resumeOwnerForResearch(signedOut: reopenedOff.owner,
        authenticatedUserId: reopenedOff.owner.userId, authenticatedDeviceId: reopenedOff.owner.deviceId)
    let currentOwner = resumed.owner
    try checks.require(resumed.active && currentOwner.generation == signedOut.owner.generation + 1
        && currentOwner.userId == initialBobOwner.userId && currentOwner.deviceId == initialBobOwner.deviceId
        && resumed.credentialEpoch != signedOut.credentialEpoch,
        "same-account resume creates a fresh active generation and epoch")
    try checks.require(lifecycleProbeIdentityMatches(try bob.publicIdentity(owner: currentOwner), bobIdentity),
        "resume preserves all existing identity keys")
    let afterResume = try resumedHandle.read()
    try checks.refuse("active lifecycle cannot resume again") {
        _ = try bob.resumeOwnerForResearch(signedOut: currentOwner,
            authenticatedUserId: currentOwner.userId, authenticatedDeviceId: currentOwner.deviceId)
    }
    try checks.refuse("old owner cannot enumerate current history") {
        _ = try bob.history(owner: initialBobOwner, peerGeneration: initialPeerGeneration)
    }
    try checks.require(try bob.history(owner: currentOwner, peerGeneration: initialPeerGeneration).isEmpty,
        "old-generation plaintext remains hidden after resume")
    guard case .historical = try bob.knownInboundForResearch(oldInbound.serializedEnvelope,
        owner: currentOwner, peerGeneration: initialPeerGeneration) else {
        throw DmLifecycleProbeError.assertion("owner transition known historical envelope")
    }
    try checks.conflict("strict receive still refuses a historical duplicate") {
        _ = try bob.receive(oldInbound.serializedEnvelope, owner: currentOwner,
            peerGeneration: initialPeerGeneration)
    }
    try checks.require(try bob.pending(owner: currentOwner, peerGeneration: initialPeerGeneration).isEmpty,
        "resume never rebinds the old pending outbox")
    try checks.refuse("old pending record cannot be signed under the new owner") {
        _ = try bob.signedSendForResearch(oldPending, requestId: "lifecycle-old-send", expiresAt: 1_800_000_060,
            now: 1_800_000_000, owner: currentOwner, peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("old pending record cannot be accepted under the new owner") {
        try bob.confirmAcceptance(oldPending, owner: currentOwner, peerGeneration: initialPeerGeneration)
    }
    try checks.conflict("same pending message ID cannot be re-encrypted or rebound") {
        _ = try bob.prepare(clientMessageId: "lifecycle-old-pending", text: "old pending",
            owner: currentOwner, peerGeneration: initialPeerGeneration)
    }
    try checks.require(try resumedHandle.read() == afterResume,
        "known recovery and old outbox refusals do not mutate or redisclose historical state")

    let freshOwnerInbound = try alice.prepare(clientMessageId: "lifecycle-fresh-owner", text: "fresh owner",
        owner: aliceOwner, peerGeneration: initialPeerGeneration)
    let beforeUnknown = try resumedHandle.read()
    guard case .unknown = try bob.knownInboundForResearch(freshOwnerInbound.serializedEnvelope,
        owner: currentOwner, peerGeneration: initialPeerGeneration) else {
        throw DmLifecycleProbeError.assertion("unknown envelope does not masquerade as stored history")
    }
    try checks.require(try resumedHandle.read() == beforeUnknown, "unknown classification leaves ratchet untouched")
    try lifecycleProbeStored(bob.receive(freshOwnerInbound.serializedEnvelope, owner: currentOwner,
        peerGeneration: initialPeerGeneration), text: "fresh owner", id: "lifecycle-fresh-owner",
        owner: currentOwner, peerGeneration: initialPeerGeneration, checks: checks)
    let visibleAfterResume = try bob.history(owner: currentOwner, peerGeneration: initialPeerGeneration)
    try checks.require(visibleAfterResume.count == 1 && visibleAfterResume[0].clientMessageId == "lifecycle-fresh-owner",
        "resumed history exposes only the newly committed current-generation message")

    let currentPending = try bob.prepare(clientMessageId: "lifecycle-current-pending", text: "current pending",
        owner: currentOwner, peerGeneration: initialPeerGeneration)
    let rotated = try bob.rotateCredentialEpochForResearch(owner: currentOwner)
    try checks.require(rotated.active && rotated.owner == currentOwner
        && rotated.credentialEpoch != resumed.credentialEpoch,
        "credential refresh changes only the active credential epoch")
    try checks.require(try bob.history(owner: currentOwner, peerGeneration: initialPeerGeneration) == visibleAfterResume,
        "epoch rotation preserves current history and identity generation")
    let rotatedSnapshot = try resumedHandle.read()
    try bob.validateRelayContextForResearch(owner: currentOwner, credentialEpoch: rotated.credentialEpoch,
        peerGeneration: initialPeerGeneration)
    try checks.refuse("single-snapshot relay authority refuses a stale credential epoch") {
        try bob.validateRelayContextForResearch(owner: currentOwner, credentialEpoch: resumed.credentialEpoch,
            peerGeneration: initialPeerGeneration)
    }
    try checks.refuse("list signing refuses stale epoch despite current owner") {
        _ = try bob.signedListForResearch(requestId: "lifecycle-stale-list", expiresAt: 1_800_000_060,
            now: 1_800_000_000, owner: currentOwner, credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("claim signing refuses stale epoch despite current peer") {
        _ = try bob.signedClaimForResearch(requestId: "lifecycle-stale-claim", expiresAt: 1_800_000_060,
            now: 1_800_000_000, owner: currentOwner, peerGeneration: initialPeerGeneration,
            credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("exact pending send signing refuses a stale epoch") {
        _ = try bob.signedSendForResearch(currentPending, requestId: "lifecycle-stale-send", expiresAt: 1_800_000_060,
            now: 1_800_000_000, owner: currentOwner, peerGeneration: initialPeerGeneration,
            credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("exact acceptance cannot settle through an old credential epoch") {
        try bob.confirmAcceptance(currentPending, owner: currentOwner, peerGeneration: initialPeerGeneration,
            credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("exact rejection cannot settle through an old credential epoch") {
        try bob.confirmRejection(currentPending, reason: .blocked, owner: currentOwner,
            credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("stored duplicate cannot bypass stale epoch at receive") {
        _ = try bob.receive(freshOwnerInbound.serializedEnvelope, owner: currentOwner,
            peerGeneration: initialPeerGeneration, credentialEpoch: resumed.credentialEpoch)
    }
    try checks.refuse("historical known-row recovery cannot bypass stale epoch") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: currentOwner,
            peerGeneration: initialPeerGeneration, credentialEpoch: resumed.credentialEpoch)
    }
    try checks.require(try resumedHandle.read() == rotatedSnapshot,
        "all stale epoch operations preserve the exact sealed snapshot")
    let currentRetry = try bob.prepare(clientMessageId: "lifecycle-current-pending", text: "current pending",
        owner: currentOwner, peerGeneration: initialPeerGeneration)
    try checks.require(currentRetry == currentPending
        && currentRetry.serializedEnvelope.utf8.elementsEqual(currentPending.serializedEnvelope.utf8),
        "credential refresh retains the exact current pending ciphertext")
    try checks.require(try resumedHandle.read() == rotatedSnapshot, "retry after token refresh does not re-encrypt or mutate state")
    resumedHandle.close()
    let activeHandle = try VodozemacSealedStore.reopen(directory: bobDirectory, storeID: bobID)
    reopenedHandles.append(activeHandle)
    bobStore = activeHandle
    bob = try VodozemacDmCoordinator(store: activeHandle)
    let reopenedActive = try bob.lifecycleForResearch()
    try checks.require(reopenedActive.active && reopenedActive.owner == rotated.owner
        && reopenedActive.credentialEpoch == rotated.credentialEpoch,
        "reopen retains the refreshed active credential epoch")
    let restoredPending = try bob.pending(owner: currentOwner, peerGeneration: initialPeerGeneration)
    try checks.require(restoredPending.count == 1 && restoredPending[0] == currentPending,
        "reopen after credential refresh retains only exact current pending ciphertext")

    // Block/reaccept advances trust, but exact known ciphertext needs no second
    // decrypt and must not become plaintext tagged with that new trust generation.
    let blocked = try bob.setPeerStatusForResearch(.blocked, owner: currentOwner)
    let blockedSnapshot = try activeHandle.read()
    try checks.refuse("blocked peer cannot classify a known row") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: currentOwner, peerGeneration: blocked)
    }
    try checks.refuse("blocked peer cannot expose history") { _ = try bob.history(owner: currentOwner, peerGeneration: blocked) }
    try checks.require(try activeHandle.read() == blockedSnapshot, "blocked known/history refusals are read-only")
    let accepted = try bob.setPeerStatusForResearch(.accepted, owner: currentOwner)
    try checks.require(accepted == blocked + 1, "reaccept creates a new peer generation")
    let acceptedSnapshot = try activeHandle.read()
    for envelope in [oldInbound.serializedEnvelope, freshOwnerInbound.serializedEnvelope] {
        guard case .historical = try bob.knownInboundForResearch(envelope, owner: currentOwner, peerGeneration: accepted) else {
            throw DmLifecycleProbeError.assertion("peer transition historical known classification")
        }
        try checks.conflict("strict receive does not rebind old peer-generation plaintext") {
            _ = try bob.receive(envelope, owner: currentOwner, peerGeneration: accepted)
        }
    }
    try checks.require(try bob.history(owner: currentOwner, peerGeneration: accepted).isEmpty,
        "reaccepted peer history still hides both historical messages")
    try checks.require(try activeHandle.read() == acceptedSnapshot,
        "peer recovery skips exact bytes without changing inbox generations or ratchet")
    let freshPeerInbound = try alice.prepare(clientMessageId: "lifecycle-fresh-peer", text: "fresh peer",
        owner: aliceOwner, peerGeneration: initialPeerGeneration)
    try lifecycleProbeStored(bob.receive(freshPeerInbound.serializedEnvelope, owner: currentOwner,
        peerGeneration: accepted), text: "fresh peer", id: "lifecycle-fresh-peer",
        owner: currentOwner, peerGeneration: accepted, checks: checks)
    let visibleAfterReaccept = try bob.history(owner: currentOwner, peerGeneration: accepted)
    try checks.require(visibleAfterReaccept.count == 1 && visibleAfterReaccept[0].clientMessageId == "lifecycle-fresh-peer",
        "only new current-peer plaintext is visible after reaccept")

    let goodFrame = try DmEnvelope.decode(oldInbound.serializedEnvelope)
    let substituted = try DmEnvelope(clientMessageId: goodFrame.clientMessageId,
        senderDeviceId: goodFrame.senderDeviceId, recipientDeviceId: goodFrame.recipientDeviceId,
        wire: DmEnvelope.decode(freshPeerInbound.serializedEnvelope).wire).serialized()
    let wrongRoute = try DmEnvelope(clientMessageId: goodFrame.clientMessageId,
        senderDeviceId: goodFrame.senderDeviceId, recipientDeviceId: "lifecycle-other-device", wire: goodFrame.wire).serialized()
    let protectedSnapshot = try activeHandle.read()
    try checks.conflict("same known ID with different ciphertext remains a conflict") {
        _ = try bob.knownInboundForResearch(substituted, owner: currentOwner, peerGeneration: accepted)
    }
    try checks.conflict("known envelope cannot bypass recipient routing") {
        _ = try bob.knownInboundForResearch(wrongRoute, owner: currentOwner, peerGeneration: accepted)
    }
    try checks.framing("known lookup refuses noncanonical bytes") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope + " ", owner: currentOwner, peerGeneration: accepted)
    }
    for invalidOwner in [initialBobOwner,
        DmOwnerContext(userId: "lifecycle-mallory", deviceId: currentOwner.deviceId, generation: currentOwner.generation),
        DmOwnerContext(userId: currentOwner.userId, deviceId: "lifecycle-other-device", generation: currentOwner.generation)] {
        try checks.refuse("known lookup cannot bypass current owner/account/device") {
            _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: invalidOwner, peerGeneration: accepted)
        }
    }
    try checks.refuse("known lookup cannot bypass stale peer generation") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: currentOwner,
            peerGeneration: initialPeerGeneration)
    }
    try checks.require(try activeHandle.read() == protectedSnapshot, "all malformed and stale known-row refusals preserve state")

    // Same-generation token renewal also fences the prepared receive at sealed
    // CAS, rather than merely suppressing its result after it already committed.
    let epochRacingInbound = try alice.prepare(clientMessageId: "lifecycle-epoch-racing", text: "epoch race safe",
        owner: aliceOwner, peerGeneration: initialPeerGeneration)
    let beforeEpochRace = try bob.lifecycleForResearch()
    var epochInterferenceCalls = 0
    var epochWinningSnapshot = try activeHandle.read()
    let epochRacingBob = try VodozemacDmCoordinator(store: activeHandle, beforeCommitForResearch: {
        epochInterferenceCalls += 1
        _ = try bob.rotateCredentialEpochForResearch(owner: currentOwner)
        epochWinningSnapshot = try activeHandle.read()
    })
    try checks.staleCommit("competing epoch rotation fences prepared plaintext before durable receive") {
        _ = try epochRacingBob.receive(epochRacingInbound.serializedEnvelope, owner: currentOwner,
            peerGeneration: accepted, credentialEpoch: beforeEpochRace.credentialEpoch)
    }
    try checks.require(epochInterferenceCalls == 1 && (try activeHandle.read()) == epochWinningSnapshot,
        "credential rotation wins without an old-epoch ratchet or inbox commit")
    let winningEpoch = try bob.lifecycleForResearch()
    try checks.require(winningEpoch.active && winningEpoch.owner == currentOwner
        && winningEpoch.credentialEpoch != beforeEpochRace.credentialEpoch,
        "competing credential rotation retains owner scope while invalidating the captured epoch")
    try lifecycleProbeStored(bob.receive(epochRacingInbound.serializedEnvelope, owner: currentOwner,
        peerGeneration: accepted, credentialEpoch: winningEpoch.credentialEpoch), text: "epoch race safe",
        id: "lifecycle-epoch-racing", owner: currentOwner, peerGeneration: accepted, checks: checks)

    // A separate coordinator signs out after successful cryptographic opening
    // but before sealed CAS. The receive must return neither plaintext nor a
    // stale commit; a subsequent same-account resume can retry the exact bytes.
    let racingInbound = try alice.prepare(clientMessageId: "lifecycle-racing", text: "race safe",
        owner: aliceOwner, peerGeneration: initialPeerGeneration)
    var interferenceCalls = 0
    var winningSnapshot = try activeHandle.read()
    let racingBob = try VodozemacDmCoordinator(store: activeHandle, beforeCommitForResearch: {
        interferenceCalls += 1
        _ = try bob.signOutForResearch(owner: currentOwner)
        winningSnapshot = try activeHandle.read()
    })
    try checks.staleCommit("competing sign-out fences prepared plaintext before durable receive") {
        _ = try racingBob.receive(racingInbound.serializedEnvelope, owner: currentOwner, peerGeneration: accepted,
            credentialEpoch: winningEpoch.credentialEpoch)
    }
    try checks.require(interferenceCalls == 1 && (try activeHandle.read()) == winningSnapshot,
        "the lifecycle transition wins without a ratchet/inbox overwrite")
    let racingOff = try bob.lifecycleForResearch()
    try checks.require(!racingOff.active && racingOff.owner.generation == currentOwner.generation + 1,
        "competing sign-out remains authoritative")
    let finalResume = try bob.resumeOwnerForResearch(signedOut: racingOff.owner,
        authenticatedUserId: racingOff.owner.userId, authenticatedDeviceId: racingOff.owner.deviceId)
    try lifecycleProbeStored(bob.receive(racingInbound.serializedEnvelope, owner: finalResume.owner,
        peerGeneration: accepted, credentialEpoch: finalResume.credentialEpoch), text: "race safe",
        id: "lifecycle-racing", owner: finalResume.owner,
        peerGeneration: accepted, checks: checks)
    guard case .historical = try bob.knownInboundForResearch(freshPeerInbound.serializedEnvelope,
        owner: finalResume.owner, peerGeneration: accepted) else {
        throw DmLifecycleProbeError.assertion("second resume preserves known-byte recovery without old plaintext")
    }
    let changed = try bob.setPeerStatusForResearch(.changed, owner: finalResume.owner)
    try checks.refuse("changed peer refuses historical-known recovery") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: finalResume.owner, peerGeneration: changed)
    }
    let revoked = try bob.setPeerStatusForResearch(.revoked, owner: finalResume.owner)
    try checks.refuse("revoked peer refuses historical-known recovery") {
        _ = try bob.knownInboundForResearch(oldInbound.serializedEnvelope, owner: finalResume.owner, peerGeneration: revoked)
    }

    try lifecycleProbeGenerationLimit(parent: parent, checks: checks)

    // Exact store cleanup removes only these two UUID-named leaves and their
    // scoped research keys. No recursive deletion or production namespace.
    for handle in reopenedHandles { handle.close() }
    try activeHandle.destroyForTesting()
    try aliceStore.destroyForTesting()
    cleaned = true
    try checks.require(!FileManager.default.fileExists(atPath: aliceDirectory.path)
        && !FileManager.default.fileExists(atPath: bobDirectory.path), "both owned research stores were removed exactly")
    return checks.assertions
}
