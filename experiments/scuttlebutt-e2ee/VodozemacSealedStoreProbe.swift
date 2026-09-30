// ISOLATED SYNTHETIC RESEARCH ONLY. No @main: the separate native proof runner
// invokes this in its own sandbox. Keychain failures are failures, never skips
// or emulated successes. Physical-device lock/reboot tests are still required.
import Foundation
import Security
import SQLite3

enum SealedProbeError: Error { case assertion(String) }

private func sealedRequire(_ condition: Bool, _ label: String) throws {
    guard condition else { throw SealedProbeError.assertion(label) }
}

private func sealedExpect(_ expected: VodozemacSealedStoreError, _ label: String,
                          _ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch let error as VodozemacSealedStoreError {
        try sealedRequire(error == expected, label)
        return
    }
    throw SealedProbeError.assertion(label)
}

private func sealedFixtureDatabase(_ url: URL, _ operation: (OpaquePointer) throws -> Void) throws {
    var database: OpaquePointer?
    let result = sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW, nil)
    guard result == SQLITE_OK, let database else {
        if let database { sqlite3_close(database) }
        throw SealedProbeError.assertion("fixture database open")
    }
    defer { sqlite3_close(database) }
    try operation(database)
}

private func sealedFixtureCiphertext(_ url: URL) throws -> Data {
    var output = Data()
    try sealedFixtureDatabase(url) { database in
        var query: OpaquePointer?
        guard sqlite3_prepare_v2(database, "SELECT ciphertext FROM snapshot WHERE slot=1", -1, &query, nil) == SQLITE_OK,
              let query else { throw SealedProbeError.assertion("fixture select") }
        defer { sqlite3_finalize(query) }
        guard sqlite3_step(query) == SQLITE_ROW, let bytes = sqlite3_column_blob(query, 0) else {
            throw SealedProbeError.assertion("fixture row")
        }
        output = Data(bytes: bytes, count: Int(sqlite3_column_bytes(query, 0)))
    }
    return output
}

private func sealedFixtureReplaceCiphertext(_ url: URL, _ ciphertext: Data) throws {
    try sealedFixtureDatabase(url) { database in
        var query: OpaquePointer?
        guard sqlite3_prepare_v2(database, "UPDATE snapshot SET ciphertext=? WHERE slot=1", -1, &query, nil) == SQLITE_OK,
              let query else { throw SealedProbeError.assertion("fixture update") }
        defer { sqlite3_finalize(query) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        let bound = ciphertext.withUnsafeBytes { sqlite3_bind_blob(query, 1, $0.baseAddress, Int32(ciphertext.count), transient) }
        try sealedRequire(bound == SQLITE_OK && sqlite3_step(query) == SQLITE_DONE, "fixture update complete")
    }
}

private func sealedFixtureSQL(_ url: URL, _ sql: String) throws {
    try sealedFixtureDatabase(url) { database in
        try sealedRequire(sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK, "fixture metadata update")
    }
}

private func sealedFixtureKeyQuery(_ id: UUID) -> [String: Any] {
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.thalassa.research.vodozemac.snapshot." + id.uuidString.lowercased(),
        kSecAttrAccount as String: "master-v1",
        kSecAttrSynchronizable as String: false,
    ]
    #if os(macOS)
    query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
}

/// Exercises actual Apple Keychain + CryptoKit + SQLite. This is storage proof,
/// not a vodozemac protocol test or production integration/security review.
func runSealedStoreProbe(root: URL) throws {
    let id = UUID()
    let directory = root.appendingPathComponent(id.uuidString, isDirectory: true)
    let initial = Data("synthetic-account-session-outbox-replay-initial-7B90A".utf8)
    let updated = Data("synthetic-account-session-outbox-replay-next-28DC1".utf8)
    let store = try VodozemacSealedStore.create(directory: directory, storeID: id, initialPayload: initial)
    defer { try? store.destroyForTesting() }
    try sealedRequire(try store.read() == .init(revision: 0, payload: initial), "initial snapshot")
    let firstPickleKey = try store.providerPickleKey()
    try sealedRequire(firstPickleKey.count == 32 && (try store.providerPickleKey()) == firstPickleKey, "stable native pickle key")
    try sealedExpect(.alreadyExists, "create does not replace") {
        _ = try VodozemacSealedStore.create(directory: directory, storeID: id, initialPayload: updated)
    }
    try sealedRequire(try store.read().payload == initial, "duplicate create keeps state")

    try sealedExpect(.injectedFailure, "injected rollback") {
        try store.commit(expectedRevision: 0, payload: updated, fault: .beforeCommit)
    }
    try sealedRequire(try store.read() == .init(revision: 0, payload: initial), "rollback exact state")
    try sealedRequire(try store.commit(expectedRevision: 0, payload: updated) == 1, "successful CAS")
    try sealedExpect(.staleRevision, "stale CAS") { try store.commit(expectedRevision: 0, payload: initial) }
    try sealedExpect(.invalidInput, "negative CAS") { try store.commit(expectedRevision: -1, payload: initial) }
    try sealedExpect(.invalidInput, "oversize rejected") {
        try store.commit(expectedRevision: 1, payload: Data(count: VodozemacSealedStore.maxSnapshotBytes + 1))
    }
    try sealedRequire(try store.read() == .init(revision: 1, payload: updated), "refusal exact state")

    // Simulate a failed ROLLBACK command after writes. This verifies poisoning
    // and recovery through a fresh handle, not an actual disk/power-loss fault.
    do {
        let faultID = UUID()
        let faultDirectory = root.appendingPathComponent(faultID.uuidString, isDirectory: true)
        let poisoned = try VodozemacSealedStore.create(directory: faultDirectory,
            storeID: faultID, initialPayload: initial)
        defer { try? poisoned.destroyForTesting() }
        let committedCiphertext = try sealedFixtureCiphertext(poisoned.databaseURL)
        try sealedExpect(.injectedFailure, "rollback failure injected") {
            try poisoned.commit(expectedRevision: 0, payload: updated, fault: .beforeCommitAndRollbackFailure)
        }
        try sealedExpect(.closed, "uncertain handle cannot read pending output") { _ = try poisoned.read() }
        try sealedExpect(.closed, "uncertain handle cannot expose pickle key") { _ = try poisoned.providerPickleKey() }
        try sealedExpect(.closed, "uncertain handle cannot commit") {
            try poisoned.commit(expectedRevision: 0, payload: updated)
        }
        let recovered = try VodozemacSealedStore.reopen(directory: faultDirectory, storeID: faultID)
        defer { recovered.close() }
        try sealedRequire(try recovered.read() == .init(revision: 0, payload: initial), "reopen authenticates pre-fault snapshot")
        try sealedRequire(try sealedFixtureCiphertext(recovered.databaseURL) == committedCiphertext, "close discarded synthetic uncommitted write")
        recovered.close()
        try poisoned.destroyForTesting()
        try sealedRequire(!FileManager.default.fileExists(atPath: faultDirectory.path), "rollback fixture exact cleanup")
    }

    let second = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    defer { second.close() }
    try sealedRequire(try second.read() == store.read(), "second connection restored")
    try second.commit(expectedRevision: 1, payload: initial)
    try sealedExpect(.staleRevision, "cross connection CAS") { try store.commit(expectedRevision: 1, payload: updated) }
    try sealedRequire(try store.read() == .init(revision: 2, payload: initial), "winning snapshot survives")
    second.close()

    // The DB and WAL must not contain the account/session/outbox plaintext.
    for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
        let bytes = try Data(contentsOf: directory.appendingPathComponent(name))
        try sealedRequire(bytes.range(of: initial) == nil && bytes.range(of: updated) == nil, "no snapshot plaintext in SQLite files")
        try sealedRequire(bytes.range(of: firstPickleKey) == nil, "no native pickle key in SQLite files")
    }
    let backup = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
    try sealedRequire(backup.isExcludedFromBackup == true, "backup excluded")
    #if os(iOS)
    let protection = try FileManager.default.attributesOfItem(atPath: store.databaseURL.path)[.protectionKey]
    // FileManager bridges this attribute as an NSString on iOS, not necessarily
    // the Swift RawRepresentable wrapper. Check the same required policy value.
    let protectionValue = (protection as? FileProtectionType)?.rawValue ?? (protection as? String)
    #if targetEnvironment(simulator)
    // The simulator may omit this hardware-backed file-protection attribute.
    // Missing metadata is explicitly NOT a passed physical protection check.
    // If supplied, an unexpected policy still fails instead of being ignored.
    if let protectionValue {
        try sealedRequire(protectionValue == FileProtectionType.complete.rawValue, "simulator reported file protection policy")
    }
    print("NOT VERIFIED: hardware file protection / locked-device access; physical iPhone required")
    #else
    try sealedRequire(protectionValue == FileProtectionType.complete.rawValue, "iOS file protection requested")
    #endif
    #endif

    let originalCiphertext = try sealedFixtureCiphertext(store.databaseURL)
    var corrupted = originalCiphertext
    corrupted[corrupted.count - 1] ^= 1
    try sealedFixtureReplaceCiphertext(store.databaseURL, corrupted)
    try sealedExpect(.authenticationFailed, "corrupt ciphertext refused") { _ = try store.read() }
    try sealedExpect(.authenticationFailed, "corrupt prior state cannot commit") {
        try store.commit(expectedRevision: 2, payload: updated)
    }
    try sealedRequire(try sealedFixtureCiphertext(store.databaseURL) == corrupted, "failed decrypt did not rewrite state")
    try sealedFixtureReplaceCiphertext(store.databaseURL, originalCiphertext)
    try sealedFixtureSQL(store.databaseURL, "UPDATE snapshot SET revision=3 WHERE slot=1")
    try sealedExpect(.authenticationFailed, "revision authenticated") { _ = try store.read() }
    try sealedFixtureSQL(store.databaseURL, "UPDATE snapshot SET revision=2 WHERE slot=1")
    try sealedFixtureSQL(store.databaseURL, "UPDATE snapshot SET store_id='\(UUID().uuidString.lowercased())' WHERE slot=1")
    try sealedExpect(.unsupportedDatabase, "identity metadata checked") { _ = try store.read() }
    try sealedFixtureSQL(store.databaseURL, "UPDATE snapshot SET store_id='\(id.uuidString.lowercased())' WHERE slot=1")
    try sealedRequire(try store.read() == .init(revision: 2, payload: initial), "fixture restoration exact")

    store.close()
    try sealedExpect(.closed, "closed handle refuses") { _ = try store.read() }
    let reopened = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    defer { reopened.close() }
    try sealedRequire(try reopened.providerPickleKey() == firstPickleKey, "pickle key survives reopen")
    try sealedRequire(try reopened.read() == .init(revision: 2, payload: initial), "snapshot survives reopen")
    reopened.close()

    // The key bytes remain valid, but a weaker accessibility class must not be
    // accepted silently. Only this synthetic UUID-scoped item's policy changes.
    let weakened = SecItemUpdate(sealedFixtureKeyQuery(id) as CFDictionary,
        [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary)
    try sealedRequire(weakened == errSecSuccess, "synthetic weaker key policy fixture")
    try sealedExpect(.authenticationFailed, "weaker key policy refuses reopen") {
        _ = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    }
    try sealedRequire(try sealedFixtureCiphertext(store.databaseURL) == originalCiphertext, "policy refusal preserves ciphertext")
    let restoredPolicy = SecItemUpdate(sealedFixtureKeyQuery(id) as CFDictionary,
        [kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly] as CFDictionary)
    try sealedRequire(restoredPolicy == errSecSuccess, "synthetic required key policy restored")
    let policyRestored = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    defer { policyRestored.close() }
    try sealedRequire(try policyRestored.read() == .init(revision: 2, payload: initial), "required policy restores access without replacing key")
    try sealedRequire(try policyRestored.providerPickleKey() == firstPickleKey, "policy update preserves original key")
    policyRestored.close()

    // A different valid AES key is not mistaken for a fresh identity. This
    // modifies ONLY this synthetic UUID-scoped Keychain item, never a real key.
    let wrongKey = Data(repeating: 0x59, count: 32)
    let status = SecItemUpdate(sealedFixtureKeyQuery(id) as CFDictionary,
        [kSecValueData as String: wrongKey] as CFDictionary)
    try sealedRequire(status == errSecSuccess, "synthetic wrong key fixture")
    try sealedExpect(.authenticationFailed, "wrong key refuses reopen") {
        _ = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    }
    try sealedRequire(try sealedFixtureCiphertext(store.databaseURL) == originalCiphertext, "wrong key did not rewrite state")

    try VodozemacSealedStore.deleteResearchKey(storeID: id)
    try sealedExpect(.missingKey, "missing key refuses reopen") {
        _ = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    }
    try sealedExpect(.missingKey, "missing key stays missing") {
        _ = try VodozemacSealedStore.reopen(directory: directory, storeID: id)
    }
    try sealedRequire(try sealedFixtureCiphertext(store.databaseURL) == originalCiphertext, "missing key preserves ciphertext")
    try store.destroyForTesting()
    try sealedRequire(!FileManager.default.fileExists(atPath: directory.path), "exact synthetic cleanup")
    print("PASS sealed-store native Keychain/CryptoKit/SQLite probe (synthetic, not device-lock proof)")
}
