// ISOLATED RESEARCH ONLY. Not part of the Thalassa app or its Capacitor plugin.
// A caller supplies one opaque account/session/outbox/replay snapshot. This file
// does not implement peer authentication, a ratchet, delivery, or a JS bridge.
// It does not prevent restoring an older valid DB, guarantee secure erasure, or
// prove locked-device behaviour. Those require separate real-device review.
import Foundation
import CryptoKit
import Security
import LocalAuthentication
import SQLite3

enum VodozemacSealedStoreError: Error, Equatable {
    case invalidInput, alreadyExists, missingDatabase, missingKey, closed
    case unsupportedDatabase, staleRevision, revisionExhausted
    case authenticationFailed, injectedFailure
    case keychain(OSStatus), database(Int32)
}

final class VodozemacSealedStore {
    struct Snapshot: Equatable {
        let revision: Int64
        let payload: Data
    }

    // Faults are synthetic proof hooks, never application-facing controls.
    enum CommitFault { case none, beforeCommit, beforeCommitAndRollbackFailure }

    static let maxSnapshotBytes = 1_048_576
    private static let format = 1
    private static let applicationID = 1414939460
    private static let servicePrefix = "app.thalassa.research.vodozemac.snapshot."
    private static let filenames = ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]
    private let directory: URL
    let storeID: UUID
    let databaseURL: URL
    private var database: OpaquePointer?
    private let lock = NSLock()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// The directory must be a new UUID-named leaf below an existing parent.
    /// If a previous key exists, creation fails rather than replacing it.
    static func create(directory: URL, storeID: UUID, initialPayload: Data) throws -> VodozemacSealedStore {
        try validateDirectory(directory, storeID: storeID)
        try validatePayload(initialPayload)
        guard !FileManager.default.fileExists(atPath: directory.path) else {
            throw VodozemacSealedStoreError.alreadyExists
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        var createdKey = false
        var store: VodozemacSealedStore?
        do {
            try protect(directory)
            try createMasterKey(storeID: storeID)
            createdKey = true
            let opened = try VodozemacSealedStore(directory: directory, storeID: storeID, create: true)
            store = opened
            let sealed = try opened.seal(initialPayload, revision: 0, key: loadMasterKey(storeID: storeID))
            try opened.execute("BEGIN IMMEDIATE")
            do {
                try opened.execute("""
                    CREATE TABLE snapshot (
                        slot INTEGER PRIMARY KEY CHECK(slot=1),
                        store_id TEXT NOT NULL, format INTEGER NOT NULL CHECK(format=1),
                        revision INTEGER NOT NULL CHECK(revision>=0),
                        ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 28 AND 1048604))
                    """)
                try opened.writeInitial(sealed)
                try opened.execute("PRAGMA application_id=\(applicationID)")
                try opened.execute("PRAGMA user_version=\(format)")
                try opened.protectFiles()
                try opened.execute("COMMIT")
            } catch {
                try? opened.execute("ROLLBACK")
                throw error
            }
            return opened
        } catch {
            store?.close()
            // Cleanup is exact and nonrecursive, and never deletes a key that
            // predated this create call. A crash may leave an orphan: fail closed.
            if createdKey { try? deleteResearchKey(storeID: storeID) }
            try? removeKnownFiles(directory: directory)
            throw error
        }
    }

    /// Does not create a DB, key, schema, or replacement identity on failure.
    static func reopen(directory: URL, storeID: UUID) throws -> VodozemacSealedStore {
        try validateDirectory(directory, storeID: storeID)
        guard FileManager.default.fileExists(atPath: directory.appendingPathComponent("snapshot.sqlite").path) else {
            throw VodozemacSealedStoreError.missingDatabase
        }
        _ = try loadMasterKey(storeID: storeID)
        let store = try VodozemacSealedStore(directory: directory, storeID: storeID, create: false)
        do {
            _ = try store.read()
            return store
        } catch {
            store.close()
            throw error
        }
    }

    private init(directory: URL, storeID: UUID, create: Bool) throws {
        self.directory = directory
        self.storeID = storeID
        self.databaseURL = directory.appendingPathComponent("snapshot.sqlite")
        for name in Self.filenames {
            let url = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path),
               try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
                throw VodozemacSealedStoreError.invalidInput
            }
        }
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW
            | (create ? SQLITE_OPEN_CREATE : 0)
        let result = sqlite3_open_v2(databaseURL.path, &database, flags, nil)
        guard result == SQLITE_OK else {
            if let database { sqlite3_close(database) }
            database = nil
            throw VodozemacSealedStoreError.database(result)
        }
        do {
            try checked(sqlite3_busy_timeout(database, 3000))
            sqlite3_limit(database, SQLITE_LIMIT_LENGTH, Int32(Self.maxSnapshotBytes + 1024))
            if !create {
                guard try integer("PRAGMA application_id") == Self.applicationID,
                      try integer("PRAGMA user_version") == Self.format else {
                    throw VodozemacSealedStoreError.unsupportedDatabase
                }
            }
            let mode = try statement("PRAGMA journal_mode=WAL")
            defer { sqlite3_finalize(mode) }
            guard sqlite3_step(mode) == SQLITE_ROW,
                  let text = sqlite3_column_text(mode, 0), String(cString: text) == "wal" else {
                throw VodozemacSealedStoreError.unsupportedDatabase
            }
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA temp_store=MEMORY")
            guard try integer("PRAGMA synchronous") == 2 else {
                throw VodozemacSealedStoreError.unsupportedDatabase
            }
            try protectFiles()
        } catch {
            sqlite3_close(database)
            database = nil
            throw error
        }
    }

    deinit { if let database { sqlite3_close(database) } }

    func close() {
        lock.lock(); defer { lock.unlock() }
        if let database { sqlite3_close(database) }
        database = nil
    }

    func read() throws -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        try requireOpen()
        return try readUnlocked(key: Self.loadMasterKey(storeID: storeID))
    }

    /// Native authority gate: authenticate this snapshot and keep its SQLite
    /// writer reservation until a synchronous operation on a DIFFERENT store
    /// finishes. An epoch writer on any handle/process must serialize against
    /// this BEGIN IMMEDIATE. No snapshot/revision is changed by the gate itself.
    /// The body must not await, reenter this store, or invoke an index writer.
    /// This is serialization, not an atomic transaction across the two DBs.
    /// Never retry the body after failure: its other-store commit may have won.
    func withAuthoritySnapshotForResearch<T>(_ operation: (Snapshot) throws -> T,
                                             fault: CommitFault = .none) throws -> T {
        lock.lock(); defer { lock.unlock() }
        try requireOpen()
        let key = try Self.loadMasterKey(storeID: storeID)
        try execute("BEGIN IMMEDIATE")
        do {
            let current = try readUnlocked(key: key)
            let result = try operation(current)
            switch fault {
            case .none: break
            case .beforeCommit, .beforeCommitAndRollbackFailure:
                throw VodozemacSealedStoreError.injectedFailure
            }
            try execute("COMMIT")
            return result
        } catch {
            let operationError = error
            do {
                if case .beforeCommitAndRollbackFailure = fault { throw VodozemacSealedStoreError.injectedFailure }
                try execute("ROLLBACK")
            } catch {
                let uncertainDatabase = database
                database = nil
                if let uncertainDatabase { sqlite3_close_v2(uncertainDatabase) }
            }
            throw operationError
        }
    }

    // Exact fixture handle only: lets a competing native commit report actual
    // SQLITE_BUSY instead of waiting, so serialization assertions need no sleep
    // or assumption that a dispatched writer has reached SQLite yet.
    func failImmediatelyOnBusyForResearch() throws {
        lock.lock(); defer { lock.unlock() }
        try requireOpen()
        try checked(sqlite3_busy_timeout(database, 0))
    }

    /// Native-only key derivation for vodozemac's own encrypted pickle API.
    /// This is purpose-separated from the snapshot encryption key; never expose
    /// it to JS, logs, network APIs, or a Capacitor response.
    func providerPickleKey() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        try requireOpen()
        let master = try Self.loadMasterKey(storeID: storeID)
        let derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: master,
            salt: Data("thalassa-research-vodozemac-pickle-v1".utf8),
            info: Data(storeID.uuidString.lowercased().utf8), outputByteCount: 32)
        return derived.withUnsafeBytes { Data($0) }
    }

    /// Decrypt/authenticate the prior snapshot and check its revision while
    /// holding BEGIN IMMEDIATE. Failed crypto, stale CAS, and injected faults
    /// leave the prior payload/revision untouched if rollback succeeds. A failed
    /// rollback poisons this handle; reopening must authenticate durable state.
    /// Persisted ciphertext may only be dispatched by a future coordinator after
    /// this commit has succeeded.
    @discardableResult
    func commit(expectedRevision: Int64, payload: Data, fault: CommitFault = .none,
                checkAuthority: (() throws -> Void)? = nil) throws -> Int64 {
        try Self.validatePayload(payload)
        guard expectedRevision >= 0 else { throw VodozemacSealedStoreError.invalidInput }
        lock.lock(); defer { lock.unlock() }
        try requireOpen()
        let key = try Self.loadMasterKey(storeID: storeID)
        try execute("BEGIN IMMEDIATE")
        do {
            let current = try readUnlocked(key: key)
            guard current.revision == expectedRevision else { throw VodozemacSealedStoreError.staleRevision }
            guard current.revision < Int64.max else { throw VodozemacSealedStoreError.revisionExhausted }
            let next = current.revision + 1
            let ciphertext = try seal(payload, revision: next, key: key)
            let query = try statement("UPDATE snapshot SET revision=?,ciphertext=? WHERE slot=1 AND revision=?")
            defer { sqlite3_finalize(query) }
            try checked(sqlite3_bind_int64(query, 1, next))
            try bind(ciphertext, to: query, column: 2)
            try checked(sqlite3_bind_int64(query, 3, expectedRevision))
            // Native held-scope checker only; must not await or reenter this
            // store/Directory/Auth. Keychain, encoding, encryption and SQLite
            // reservation cannot extend an already expired credential lease.
            try checkAuthority?()
            try done(query)
            guard sqlite3_changes(database) == 1 else { throw VodozemacSealedStoreError.staleRevision }
            try protectFiles()
            switch fault {
            case .none: break
            case .beforeCommit, .beforeCommitAndRollbackFailure:
                throw VodozemacSealedStoreError.injectedFailure
            }
            // If expiry/cancellation occurs after UPDATE/protectFiles, roll the
            // transaction back instead of releasing a durable late mutation.
            try checkAuthority?()
            try execute("COMMIT")
            return next
        } catch {
            let operationError = error
            do {
                if case .beforeCommitAndRollbackFailure = fault {
                    throw VodozemacSealedStoreError.injectedFailure
                }
                try execute("ROLLBACK")
            } catch {
                // NSLock is already held; do not call close() recursively.
                // Never expose uncertain/uncommitted pending output via read().
                // close_v2 also makes any remaining statements zombies until
                // finalized; this object's handle is unavailable immediately.
                let uncertainDatabase = database
                database = nil
                if let uncertainDatabase { sqlite3_close_v2(uncertainDatabase) }
            }
            throw operationError
        }
    }

    /// Test-only exact namespace deletion, used to verify missing-key refusal.
    /// Does not regenerate a key or alter the database.
    static func deleteResearchKey(storeID: UUID) throws {
        let status = SecItemDelete(keyQuery(storeID: storeID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VodozemacSealedStoreError.keychain(status)
        }
    }

    /// Synthetic research cleanup only. Rejects unexpected directory contents;
    /// never recursively removes a path and never accesses production keys.
    func destroyForTesting() throws {
        close()
        try Self.validateDirectory(directory, storeID: storeID)
        try Self.validateKnownFiles(directory: directory)
        try Self.deleteResearchKey(storeID: storeID)
        try Self.removeKnownFiles(directory: directory)
    }

    private static func keyQuery(storeID: UUID) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix + storeID.uuidString.lowercased(),
            kSecAttrAccount as String: "master-v1",
            kSecAttrSynchronizable as String: false,
        ]
        #if os(macOS)
        // Modern data-protection Keychain semantics. An unsigned/unentitled host
        // probe may fail; it must not silently switch to a file or legacy store.
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    private static func createMasterKey(storeID: UUID) throws {
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw VodozemacSealedStoreError.keychain(status) }
        var query = keyQuery(storeID: storeID)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        query[kSecValueData as String] = bytes
        let added = SecItemAdd(query as CFDictionary, nil)
        guard added == errSecSuccess else { throw VodozemacSealedStoreError.keychain(added) }
    }

    private static func loadMasterKey(storeID: UUID) throws -> SymmetricKey {
        var query = keyQuery(storeID: storeID)
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw VodozemacSealedStoreError.missingKey }
        guard status == errSecSuccess else { throw VodozemacSealedStoreError.keychain(status) }
        guard let attributes = result as? [String: Any],
              let bytes = attributes[kSecValueData as String] as? Data, bytes.count == 32,
              let accessibility = attributes[kSecAttrAccessible as String] as? String,
              accessibility == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              (attributes[kSecAttrSynchronizable as String] as? Bool ?? false) == false else {
            throw VodozemacSealedStoreError.authenticationFailed
        }
        return SymmetricKey(data: bytes)
    }

    private func seal(_ payload: Data, revision: Int64, key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(payload, using: key, authenticating: associatedData(revision: revision))
        guard let combined = box.combined else { throw VodozemacSealedStoreError.authenticationFailed }
        return combined
    }

    private func associatedData(revision: Int64) -> Data {
        // Fixed ASCII format and canonical UUID plus eight-byte BE revision.
        var bytes = Data("thalassa-research-sealed-snapshot-v1\0\(storeID.uuidString.lowercased())\0".utf8)
        var bigEndian = revision.bigEndian
        withUnsafeBytes(of: &bigEndian) { bytes.append(contentsOf: $0) }
        return bytes
    }

    private func readUnlocked(key: SymmetricKey) throws -> Snapshot {
        let query = try statement("SELECT slot,store_id,format,revision,length(ciphertext),ciphertext FROM snapshot")
        defer { sqlite3_finalize(query) }
        guard sqlite3_step(query) == SQLITE_ROW,
              sqlite3_column_type(query, 0) == SQLITE_INTEGER, sqlite3_column_int64(query, 0) == 1,
              sqlite3_column_type(query, 1) == SQLITE_TEXT, let uuid = sqlite3_column_text(query, 1),
              String(cString: uuid) == storeID.uuidString.lowercased(),
              sqlite3_column_type(query, 2) == SQLITE_INTEGER, sqlite3_column_int64(query, 2) == Self.format,
              sqlite3_column_type(query, 3) == SQLITE_INTEGER,
              sqlite3_column_type(query, 5) == SQLITE_BLOB else {
            throw VodozemacSealedStoreError.unsupportedDatabase
        }
        let revision = sqlite3_column_int64(query, 3)
        let count = sqlite3_column_int64(query, 4)
        guard revision >= 0, count >= 28, count <= Self.maxSnapshotBytes + 28,
              sqlite3_column_bytes(query, 5) == count, let bytes = sqlite3_column_blob(query, 5) else {
            throw VodozemacSealedStoreError.unsupportedDatabase
        }
        let sealed = Data(bytes: bytes, count: Int(count))
        guard sqlite3_step(query) == SQLITE_DONE else { throw VodozemacSealedStoreError.unsupportedDatabase }
        do {
            let payload = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key,
                authenticating: associatedData(revision: revision))
            try Self.validatePayload(payload)
            return Snapshot(revision: revision, payload: payload)
        } catch { throw VodozemacSealedStoreError.authenticationFailed }
    }

    private func writeInitial(_ ciphertext: Data) throws {
        let query = try statement("INSERT INTO snapshot VALUES(1,?,1,0,?)")
        defer { sqlite3_finalize(query) }
        try checked(sqlite3_bind_text(query, 1, storeID.uuidString.lowercased(), -1, transient))
        try bind(ciphertext, to: query, column: 2)
        try done(query)
    }

    private func requireOpen() throws {
        guard database != nil else { throw VodozemacSealedStoreError.closed }
    }

    private func statement(_ sql: String) throws -> OpaquePointer {
        try requireOpen()
        var query: OpaquePointer?
        let result = sqlite3_prepare_v2(database, sql, -1, &query, nil)
        guard result == SQLITE_OK, let query else { throw VodozemacSealedStoreError.database(result) }
        return query
    }

    private func execute(_ sql: String) throws {
        try checked(sqlite3_exec(database, sql, nil, nil, nil))
    }

    private func integer(_ sql: String) throws -> Int {
        let query = try statement(sql)
        defer { sqlite3_finalize(query) }
        guard sqlite3_step(query) == SQLITE_ROW else { throw VodozemacSealedStoreError.unsupportedDatabase }
        return Int(sqlite3_column_int64(query, 0))
    }

    private func checked(_ result: Int32) throws {
        guard result == SQLITE_OK else { throw VodozemacSealedStoreError.database(result) }
    }

    private func done(_ query: OpaquePointer) throws {
        let result = sqlite3_step(query)
        guard result == SQLITE_DONE else { throw VodozemacSealedStoreError.database(result) }
    }

    private func bind(_ data: Data, to query: OpaquePointer, column: Int32) throws {
        try data.withUnsafeBytes { try checked(sqlite3_bind_blob(query, column, $0.baseAddress, Int32(data.count), transient)) }
    }

    private static func validatePayload(_ payload: Data) throws {
        guard payload.count <= maxSnapshotBytes else { throw VodozemacSealedStoreError.invalidInput }
    }

    private static func validateDirectory(_ directory: URL, storeID: UUID) throws {
        guard directory.isFileURL, directory.path.utf8.count < 4000, !directory.path.utf8.contains(0),
              directory.lastPathComponent.lowercased() == storeID.uuidString.lowercased() else {
            throw VodozemacSealedStoreError.invalidInput
        }
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            guard values.isSymbolicLink != true, values.isDirectory == true else {
                throw VodozemacSealedStoreError.invalidInput
            }
        }
    }

    private static func protect(_ url: URL) throws {
        let isDirectory = try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        try FileManager.default.setAttributes([.posixPermissions: isDirectory ? 0o700 : 0o600], ofItemAtPath: url.path)
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutable.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        #endif
    }

    private func protectFiles() throws {
        try Self.protect(directory)
        for name in Self.filenames {
            let file = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: file.path) { try Self.protect(file) }
        }
    }

    private static func validateKnownFiles(directory: URL) throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard names.allSatisfy({ filenames.contains($0) }) else { throw VodozemacSealedStoreError.invalidInput }
        for name in names {
            let values = try directory.appendingPathComponent(name).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw VodozemacSealedStoreError.invalidInput }
        }
    }

    private static func removeKnownFiles(directory: URL) throws {
        try validateKnownFiles(directory: directory)
        for name in filenames {
            let file = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        // Only remove an already-checked empty directory; never recurse.
        guard try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty else {
            throw VodozemacSealedStoreError.invalidInput
        }
        try FileManager.default.removeItem(at: directory)
    }
}
