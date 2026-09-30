// Synthetic persistence proof. No provider, app, account credentials or user keys.
import Foundation
import Darwin

private enum StoreProbeError: Error { case assertion(String), injectedRollback }

private func require(_ condition: Bool, _ check: String) throws {
    if !condition { throw StoreProbeError.assertion(check) }
}

private func rejects(_ expected: AtomicStoreError, _ attempt: () throws -> Void) throws {
    do {
        try attempt()
        throw StoreProbeError.assertion("expected rejection")
    } catch let error as AtomicStoreError {
        try require(error == expected, "rejection category")
    }
}

private let initialState = Data([0, 1, 2, 3])
private let nextState = Data([4, 5, 6, 7])
private let laterState = Data([8, 9, 10, 11])

private func makeOutput(_ scope: StoreScope, _ id: String, revision: Int64 = 0,
                        bytes: Data = Data([240, 0, 10, 255])) -> StoreOutput {
    StoreOutput(scope: scope, clientMessageID: id, originalRevision: revision, exactCiphertext: bytes)
}

private func seed(_ store: AtomicOutboxStore) throws -> StoreScope {
    let account = try store.activate(ownerID: "synthetic-owner", senderDeviceID: "synthetic-sender")
    let scope = try store.acceptIdentity(account: account, recipientID: "synthetic-recipient",
        recipientDeviceID: "synthetic-recipient-device", identityKeyID: "synthetic-identity-A")
    try store.initializeSession(scope: scope, opaqueState: initialState)
    return scope
}

private func retryAndRestart(_ path: String) throws {
    var store: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    let scope = try seed(store!)
    let first = makeOutput(scope, "first")
    let second = makeOutput(scope, "second", revision: 1, bytes: Data([0, 255, 1]))
    try require(store!.commitSend(first, nextState: nextState) == first, "first commit")
    try require(store!.commitSend(second, nextState: laterState) == second, "second commit")
    store = nil
    let reopened = try AtomicOutboxStore(path: path)
    try require(reopened.activate(ownerID: scope.account.ownerID, senderDeviceID: scope.account.senderDeviceID) == scope.account,
        "account generation survives reopen")
    try require(reopened.session(scope: scope) == StoreSession(revision: 2, opaqueState: laterState),
        "identity generation and ratchet survive reopen")
    // An ambiguous caller retry returns the original committed bytes even after
    // later sends; its obsolete next-state argument must never reset the ratchet.
    try require(reopened.commitSend(first, nextState: Data([99])) == first, "exact old output retry")
    try require(reopened.session(scope: scope) == StoreSession(revision: 2, opaqueState: laterState),
        "retry leaves advanced state unchanged")
    try require(reopened.pending(account: scope.account) == [first, second], "exact bytes preserved across restart")
    try require(reopened.pending(account: scope.account, limit: 1) == [first], "bounded enumeration")
    try rejects(.recordConflict) {
        _ = try reopened.commitSend(makeOutput(scope, "first", bytes: Data([22])), nextState: nextState)
    }
    try rejects(.recordConflict) {
        _ = try reopened.commitSend(makeOutput(scope, "first", revision: 2), nextState: nextState)
    }
    try rejects(.sessionExists) { try reopened.initializeSession(scope: scope, opaqueState: Data([77])) }
    // Server idempotency scope includes recipient device; a collision that tries
    // to change recipient ownership must not silently retarget an existing row.
    let rerouted = try reopened.acceptIdentity(account: scope.account, recipientID: "different-recipient",
        recipientDeviceID: scope.recipientDeviceID, identityKeyID: "different-identity")
    try reopened.initializeSession(scope: rerouted, opaqueState: initialState)
    try rejects(.recordConflict) { _ = try reopened.commitSend(makeOutput(rerouted, "first"), nextState: nextState) }
    try require(reopened.session(scope: rerouted).revision == 0, "route conflict leaves state unchanged")
    print("PASS committed bytes, exact retry, conflicts, bounded reads, durable reopen")
}

private func rollbackAndCompareAndSwap(_ path: String) throws {
    let firstConnection = try AtomicOutboxStore(path: path)
    let scope = try seed(firstConnection)
    let secondConnection = try AtomicOutboxStore(path: path)
    let pending = makeOutput(scope, "rollback")
    do {
        _ = try firstConnection.commitSend(pending, nextState: nextState) {
            throw StoreProbeError.injectedRollback
        }
        throw StoreProbeError.assertion("expected fault injection")
    } catch StoreProbeError.injectedRollback {}
    try require(secondConnection.session(scope: scope) == StoreSession(revision: 0, opaqueState: initialState),
        "rollback restores state on other connection")
    try require(secondConnection.pending(account: scope.account).isEmpty, "rollback removes outbox write")
    _ = try firstConnection.commitSend(pending, nextState: nextState)
    try rejects(.staleRevision) {
        _ = try secondConnection.commitSend(makeOutput(scope, "stale-parallel-preparation"), nextState: laterState)
    }
    try require(secondConnection.session(scope: scope) == StoreSession(revision: 1, opaqueState: nextState),
        "competing preparation cannot overwrite state")
    try require(secondConnection.pending(account: scope.account) == [pending], "competing preparation creates no output")
    print("PASS injected rollback of both writes and cross-connection revision guard")
}

private func identityAndAccountLifetimes(_ path: String) throws {
    var store: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    let old = try seed(store!)
    let oldOutput = makeOutput(old, "old-identity-output")
    _ = try store!.commitSend(oldOutput, nextState: nextState)
    let changed = try store!.acceptIdentity(account: old.account, recipientID: old.recipientID,
        recipientDeviceID: old.recipientDeviceID, identityKeyID: "synthetic-identity-B")
    try require(changed.identityGeneration > old.identityGeneration, "identity epoch advances")
    store = nil
    let reopened = try AtomicOutboxStore(path: path)
    try rejects(.staleIdentity) { _ = try reopened.commitSend(oldOutput, nextState: nextState) }
    try rejects(.staleIdentity) { _ = try reopened.session(scope: old) }
    try rejects(.missingSession) { _ = try reopened.session(scope: changed) }
    try require(reopened.inspectOutput(account: old.account, clientMessageID: oldOutput.clientMessageID,
        recipientDeviceID: old.recipientDeviceID)?.cancelled == true, "identity change durably cancels output")
    let restoredIdentity = try reopened.acceptIdentity(account: old.account, recipientID: old.recipientID,
        recipientDeviceID: old.recipientDeviceID, identityKeyID: old.identityKeyID)
    try require(restoredIdentity.identityGeneration > changed.identityGeneration, "ABA identity cannot reuse epoch")
    try rejects(.staleIdentity) { _ = try reopened.commitSend(oldOutput, nextState: nextState) }
    try reopened.initializeSession(scope: restoredIdentity, opaqueState: initialState)
    let beforeLogout = makeOutput(restoredIdentity, "before-logout")
    _ = try reopened.commitSend(beforeLogout, nextState: nextState)
    try reopened.logout(account: old.account)
    try rejects(.staleAccount) { _ = try reopened.commitSend(beforeLogout, nextState: nextState) }
    try rejects(.staleAccount) { _ = try reopened.pending(account: old.account) }
    try rejects(.staleAccount) {
        _ = try reopened.acceptIdentity(account: old.account, recipientID: old.recipientID,
            recipientDeviceID: old.recipientDeviceID, identityKeyID: old.identityKeyID)
    }
    let afterRestart = try AtomicOutboxStore(path: path)
    try rejects(.staleAccount) { _ = try afterRestart.pending(account: old.account) }
    let relogged = try afterRestart.activate(ownerID: old.account.ownerID, senderDeviceID: old.account.senderDeviceID)
    try require(relogged.generation > old.account.generation, "logout epoch survives restart")
    try require(afterRestart.pending(account: relogged).isEmpty, "login cannot resume old pending output")
    try require(afterRestart.inspectOutput(account: relogged, clientMessageID: beforeLogout.clientMessageID,
        recipientDeviceID: old.recipientDeviceID)?.cancelled == true, "logout cancellation remains durable")
    let reloggedScope = try afterRestart.acceptIdentity(account: relogged, recipientID: old.recipientID,
        recipientDeviceID: old.recipientDeviceID, identityKeyID: old.identityKeyID)
    try afterRestart.initializeSession(scope: reloggedScope, opaqueState: initialState)
    try rejects(.recordConflict) {
        _ = try afterRestart.commitSend(makeOutput(reloggedScope, "before-logout"), nextState: nextState)
    }
    let current = makeOutput(reloggedScope, "current-login")
    _ = try afterRestart.commitSend(current, nextState: nextState)
    let anotherOwner = try afterRestart.activate(ownerID: "different-owner", senderDeviceID: relogged.senderDeviceID)
    try require(anotherOwner.generation > relogged.generation, "owner switch advances epoch")
    try rejects(.staleAccount) { _ = try reopened.commitSend(current, nextState: nextState) }
    try require(afterRestart.pending(account: anotherOwner).isEmpty, "account isolation")
    try require(afterRestart.inspectOutput(account: anotherOwner, clientMessageID: current.clientMessageID,
        recipientDeviceID: current.scope.recipientDeviceID) == nil, "other owner cannot inspect output")
    let otherDevice = try afterRestart.activate(ownerID: anotherOwner.ownerID, senderDeviceID: "different-sender")
    try require(otherDevice.generation > anotherOwner.generation, "device switch advances epoch")
    try rejects(.staleAccount) { _ = try afterRestart.pending(account: anotherOwner) }
    print("PASS durable identity/account epochs, ABA refusal, logout cancellation, owner/device isolation")
}

private func boundedInputs(_ path: String) throws {
    let store = try AtomicOutboxStore(path: path)
    let scope = try seed(store)
    try rejects(.invalidInput) { _ = try store.activate(ownerID: "bad owner", senderDeviceID: "device") }
    try rejects(.invalidInput) { _ = try store.activate(ownerID: String(repeating: "a", count: 129), senderDeviceID: "device") }
    try rejects(.invalidInput) { _ = try store.pending(account: scope.account, limit: 101) }
    try rejects(.invalidInput) { _ = try store.commitSend(makeOutput(scope, ""), nextState: nextState) }
    try rejects(.invalidInput) { _ = try store.commitSend(makeOutput(scope, "negative", revision: -1), nextState: nextState) }
    try rejects(.invalidInput) { _ = try store.commitSend(makeOutput(scope, "empty", bytes: Data()), nextState: nextState) }
    try rejects(.invalidInput) { _ = try store.commitSend(makeOutput(scope, "empty-state"), nextState: Data()) }
    try rejects(.invalidInput) {
        _ = try store.commitSend(makeOutput(scope, "large", bytes: Data(repeating: 0, count: AtomicOutboxStore.maxCiphertextBytes + 1)),
            nextState: nextState)
    }
    try rejects(.invalidInput) {
        _ = try store.commitSend(makeOutput(scope, "large-state"),
            nextState: Data(repeating: 0, count: AtomicOutboxStore.maxStateBytes + 1))
    }
    try require(store.session(scope: scope) == StoreSession(revision: 0, opaqueState: initialState), "invalid input leaves state")
    try require(store.pending(account: scope.account).isEmpty, "invalid input leaves outbox")
    print("PASS identifier, size, revision and enumeration bounds")
}

private func writeMarker(_ byte: UInt8) throws {
    let marker = [byte]
    guard marker.withUnsafeBytes({ Darwin.write(STDOUT_FILENO, $0.baseAddress, 1) }) == 1 else {
        throw StoreProbeError.assertion("child marker")
    }
}

private func waitMarker(_ pipe: Pipe, _ byte: UInt8) throws {
    var descriptor = pollfd(fd: pipe.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
    let ready = poll(&descriptor, 1, 10_000)
    guard ready == 1, descriptor.revents & Int16(POLLIN) != 0 else {
        throw StoreProbeError.assertion("child failed to reach boundary")
    }
    try require(pipe.fileHandleForReading.read(upToCount: 1) == Data([byte]), "child boundary marker")
}

private func waitForParent() throws {
    var byte: UInt8 = 0
    try require(Darwin.read(STDIN_FILENO, &byte, 1) == 1 && byte == 71, "parent release marker")
}

private func waitToBeKilled() throws -> Never {
    // A single fixed marker tells the parent the exact fault boundary is reached.
    // No database contents, ratchet state or ciphertext are written to logs.
    try writeMarker(82)
    while true { pause() }
}

private func crashChild(_ boundary: String, path: String) throws -> Never {
    let store = try AtomicOutboxStore(path: path)
    let account = try store.activate(ownerID: "synthetic-owner", senderDeviceID: "synthetic-sender")
    let scope = StoreScope(account: account, recipientID: "synthetic-recipient",
        recipientDeviceID: "synthetic-recipient-device", identityKeyID: "synthetic-identity-A", identityGeneration: 1)
    let output = makeOutput(scope, "crash-output", revision: 1, bytes: Data([21, 0, 255]))
    if boundary == "before" {
        _ = try store.commitSend(output, nextState: laterState) { try waitToBeKilled() }
        throw StoreProbeError.assertion("unreachable precommit child")
    }
    guard boundary == "after" else { throw StoreProbeError.assertion("child mode") }
    _ = try store.commitSend(output, nextState: laterState)
    try waitToBeKilled()
}

private func killAtBoundary(_ boundary: String, path: String) throws {
    let child = Process()
    let pipe = Pipe()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    child.arguments = ["--child", boundary, path]
    child.standardOutput = pipe
    try child.run()
    defer {
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        child.waitUntilExit()
        try? pipe.fileHandleForReading.close()
        try? pipe.fileHandleForWriting.close()
    }
    try waitMarker(pipe, 82)
    try require(kill(child.processIdentifier, SIGKILL) == 0, "kill at fault boundary")
    child.waitUntilExit()
    try require(child.terminationReason == .uncaughtSignal && child.terminationStatus == SIGKILL, "confirmed SIGKILL")
}

private func processCrash(_ path: String) throws {
    var original: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    let scope = try seed(original!)
    let baseline = makeOutput(scope, "baseline")
    _ = try original!.commitSend(baseline, nextState: nextState)
    original = nil
    try killAtBoundary("before", path: path)
    var recovered: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    try require(recovered!.session(scope: scope) == StoreSession(revision: 1, opaqueState: nextState),
        "precommit process crash restores baseline ratchet")
    try require(recovered!.pending(account: scope.account) == [baseline], "precommit process crash removes new output")
    recovered = nil
    try killAtBoundary("after", path: path)
    let committed = try AtomicOutboxStore(path: path)
    let expected = makeOutput(scope, "crash-output", revision: 1, bytes: Data([21, 0, 255]))
    try require(committed.session(scope: scope) == StoreSession(revision: 2, opaqueState: laterState),
        "postcommit process crash preserves ratchet")
    try require(committed.pending(account: scope.account) == [baseline, expected],
        "postcommit process crash preserves exact output")
    try require(committed.commitSend(expected, nextState: initialState) == expected, "ambiguous success exact retry")
    try require(committed.session(scope: scope).revision == 2, "ambiguous retry never advances twice")
    print("PASS child SIGKILL before/after COMMIT, restart recovery, ambiguous-success retry")
}

private func contentionChild(_ role: String, path: String) throws {
    let store = try AtomicOutboxStore(path: path)
    let account = StoreAccount(ownerID: "synthetic-owner", senderDeviceID: "synthetic-sender", generation: 1)
    let scope = StoreScope(account: account, recipientID: "synthetic-recipient",
        recipientDeviceID: "synthetic-recipient-device", identityKeyID: "synthetic-identity-A", identityGeneration: 1)
    if role == "holder" {
        _ = try store.commitSend(makeOutput(scope, "holder"), nextState: nextState) {
            try writeMarker(82)
            try waitForParent()
        }
    } else {
        // The holder's transaction is still open. SQLite must exclude this
        // simultaneous writer; its configured busy timeout bounds the wait.
        try rejects(.database(5)) {
            _ = try store.commitSend(makeOutput(scope, "contender"), nextState: laterState)
        }
        try writeMarker(66)
        try waitForParent()
        // Once the holder commits, retrying the obsolete preparation is stale.
        try rejects(.staleRevision) {
            _ = try store.commitSend(makeOutput(scope, "contender"), nextState: laterState)
        }
    }
}

private func simultaneousWriters(_ path: String) throws {
    var initial: AtomicOutboxStore? = try AtomicOutboxStore(path: path)
    let scope = try seed(initial!)
    initial = nil
    let holder = Process()
    let contender = Process()
    let holderOutput = Pipe(), holderInput = Pipe(), contenderOutput = Pipe(), contenderInput = Pipe()
    let pairs = [(holder, "holder", holderOutput, holderInput), (contender, "contender", contenderOutput, contenderInput)]
    defer {
        for (child, _, output, input) in pairs {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            if child.processIdentifier > 0 { child.waitUntilExit() }
            try? output.fileHandleForReading.close()
            try? output.fileHandleForWriting.close()
            try? input.fileHandleForReading.close()
            try? input.fileHandleForWriting.close()
        }
    }
    for (child, role, output, input) in pairs {
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        child.arguments = ["--contention", role, path]
        child.standardOutput = output
        child.standardInput = input
    }
    try holder.run()
    try waitMarker(holderOutput, 82)
    try contender.run()
    try waitMarker(contenderOutput, 66)
    try holderInput.fileHandleForWriting.write(contentsOf: Data([71]))
    holder.waitUntilExit()
    try require(holder.terminationReason == .exit && holder.terminationStatus == 0, "holder committed")
    try contenderInput.fileHandleForWriting.write(contentsOf: Data([71]))
    contender.waitUntilExit()
    try require(contender.terminationReason == .exit && contender.terminationStatus == 0, "contender rejected stale retry")
    let recovered = try AtomicOutboxStore(path: path)
    try require(recovered.session(scope: scope) == StoreSession(revision: 1, opaqueState: nextState), "one writer advances")
    try require(recovered.pending(account: scope.account) == [makeOutput(scope, "holder")], "one writer inserts output")
    print("PASS simultaneous two-process writer exclusion, bounded SQLITE_BUSY, stale retry after commit")
}

@main
private enum AtomicOutboxStoreProbe {
    static func main() {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.count == 3 && args[0] == "--child" { try crashChild(args[1], path: args[2]) }
            if args.count == 3 && args[0] == "--contention" {
                try contentionChild(args[1], path: args[2])
                return
            }
            guard args.count == 1 else { throw StoreProbeError.assertion("expected private scratch directory") }
            let directory = URL(fileURLWithPath: args[0], isDirectory: true)
            try retryAndRestart(directory.appendingPathComponent("retry.sqlite").path)
            try rollbackAndCompareAndSwap(directory.appendingPathComponent("rollback.sqlite").path)
            try identityAndAccountLifetimes(directory.appendingPathComponent("epochs.sqlite").path)
            try boundedInputs(directory.appendingPathComponent("bounds.sqlite").path)
            try processCrash(directory.appendingPathComponent("crash.sqlite").path)
            try simultaneousWriters(directory.appendingPathComponent("contention.sqlite").path)
            print("PASS six isolated macOS SQLite persistence groups (WAL, synchronous FULL verified)")
            print("Synthetic opaque bytes only; no encryption, secure storage, provider integration or iPhone evidence")
            print("SIGKILL proves process-crash recovery, not host power-loss or backup-rollback protection")
        } catch let error as StoreProbeError {
            switch error {
            case let .assertion(check): fputs("FAIL persistence probe: \(check)\n", stderr)
            case .injectedRollback: fputs("FAIL unexpected injected rollback\n", stderr)
            }
            exit(1)
        } catch {
            // Do not interpolate unknown provider/DB errors: they might contain data.
            fputs("FAIL persistence probe (no state or ciphertext logged)\n", stderr)
            exit(1)
        }
    }
}
